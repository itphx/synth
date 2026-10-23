/**
 * ADR-106 Ф1/Ф2: guard Authority-слоя — единственная точка решения.
 *
 * Guard считает решение по паре «действие × цель» (ADR-106
 * §«Резолвинг и решение») и пишет его в журнал решений
 * (`{dataDir}/audit/authority.jsonl` через порт `AuthorityDecisionJournal`).
 *
 * Два режима (ADR-106 §«Совместимость и миграция»):
 *
 * | `authority.enabled` | `authority.shadow` | Что происходит |
 * |---|---|---|
 * | `false` | любое | слой выключен — ни решения, ни записей |
 * | `true` | `true` | решение **считается** и пишется в журнал, но **не применяется** (решение прав не меняется) |
 * | `true` | `false` | решение **применяется**: `deny`/`ask` сужают решение permission-слоя (Ф2) |
 *
 * Применение может только **сужать** (ADR-106 §«Инварианты модели», п. 3):
 * `allow` в authority-решении не разрешает ничего сверх permission-слоя —
 * оси жёстких ограничений (защищённые пути, shell-policy, зависимости
 * окружения, потолок режима) живут в permission-слое и в резолвер не попадают.
 *
 * Потолок сессии (ось `session`) строится здесь:
 * - режим `plan` (или strict без утверждённого плана) — **только чтение**
 *   (ADR-025/ADR-028);
 * - обычный режим — «разрешено всё, кроме подтверждённого выхода за рабочий
 *   каталог»: fail-closed дефолт `external_directory` требует подтверждения,
 *   и `yolo` его **не снимает** (ADR-106 §«Многопользовательская сессия»).
 */
import { randomUUID } from 'node:crypto';

import {
  AUTHORITY_CORE_TARGET_KINDS,
  type AuthorityCeiling,
  type AuthorityDecisionEntry,
  type AuthorityGrant,
  type AuthorityPolicy,
  type AuthorityPrincipal,
  type AuthorityTurn,
  type PermissionConfig,
} from '@itphx/synth-shared';

import type { AuthorityDecisionJournal } from '../../storage/ports/authority-decision-journal.js';
import { isPlanRestricted } from '../permission/evaluator.js';
import { AUTHORITY_CORE_ACTIONS, authorityActionForTool } from './actions.js';
import { compileAuthorityGrantsForTool } from './compile.js';
import type {
  AuthorityGateHook,
  AuthorityGateResult,
  AuthorityShadowHook,
  AuthorityShadowInput,
} from './hook.js';
import { AuthorityResolver, type AuthorityDecision } from './resolve.js';
import { deriveAuthorityTarget } from './target.js';

/** Опции guard'а Authority-слоя. */
export interface AuthorityGuardOptions {
  /** Мастер-выключатель слоя (`authority.enabled`). */
  enabled: boolean;
  /** Режим наблюдения (`authority.shadow`): считать, но не применять. */
  shadow: boolean;
  /** Журнал решений (порт хранения, ADR-096). Не задан — решения не пишутся. */
  journal?: AuthorityDecisionJournal;
  /** Снимок политики инстанса (порт `AuthorityPolicyRepository`). */
  policy?: AuthorityPolicy | null;
  /**
   * Приёмник решений для метрик (ADR-094). Вызывается **после** записи в
   * журнал; ошибка приёмника не влияет на ход.
   */
  onDecision?: (entry: AuthorityDecisionEntry) => void;
}

/** Посчитанное решение Authority-слоя. */
interface ComputedAuthorityDecision {
  decision: AuthorityDecision;
  /** Требуется подтверждение, которое `yolo` не снимает (потолок/политика). */
  requiresConfirm: boolean;
  action: string;
  target: string;
}

/**
 * Guard Authority-слоя: считает решения и (в enforced-режиме) применяет их.
 *
 * Экземпляр — **на инстанс**: состояние (использованные подтверждения) живёт
 * в резолвере, а не в глобальных синглтонах (ADR-099 п. 24).
 */
export class AuthorityGuard {
  /** Очередь записей — записи журнала идут последовательно. */
  private _queue: Promise<void> = Promise.resolve();

  constructor(private readonly _options: AuthorityGuardOptions) {}

  /** Слой активен (считает решения). */
  get active(): boolean {
    return this._options.enabled;
  }

  /** Слой применяет решения (`enabled` и **не** `shadow`). */
  get enforced(): boolean {
    return this._options.enabled && !this._options.shadow;
  }

  /**
   * Шов решения для permission-слоя (Ф2).
   *
   * Считает решение, пишет запись в журнал и возвращает результат. Ошибка
   * слоя не ломает ход: возвращается `undefined` — решение permission-слоя
   * остаётся в силе.
   */
  readonly gate: AuthorityGateHook = (input: AuthorityShadowInput): AuthorityGateResult | undefined => {
    if (!this._options.enabled) return undefined;
    let computed: ComputedAuthorityDecision;
    try {
      computed = this._compute(input);
    } catch {
      // Ошибка слоя не влияет на решение прав.
      return undefined;
    }
    this._enqueue(this._entry(computed, input, this.enforced ? 'enforced' : 'shadow'));
    return {
      effect: computed.decision.effect,
      action: computed.action,
      reason: computed.decision.reason,
      source: computed.decision.source,
      enforced: this.enforced,
      requiresConfirm: computed.requiresConfirm,
    };
  };

  /**
   * Шов наблюдения (Ф1) — только считает и пишет, решение не меняет.
   *
   * Совместимость с прежним контрактом `AuthorityShadowRecorder.record`.
   */
  readonly record: AuthorityShadowHook = (input: AuthorityShadowInput): void => {
    if (!this._options.enabled) return;
    let computed: ComputedAuthorityDecision;
    try {
      computed = this._compute(input);
    } catch {
      return;
    }
    this._enqueue(this._entry(computed, input, 'shadow'));
  };

  /** Дождаться завершения очереди записей (тесты/остановка инстанса). */
  async flush(): Promise<void> {
    await this._queue;
  }

  /** Считает решение по паре «действие × цель». */
  private _compute(input: AuthorityShadowInput): ComputedAuthorityDecision {
    const action = authorityActionForTool(input.toolName, input.capabilities) ?? 'unknown';
    const derived = deriveAuthorityTarget({
      toolName: input.toolName,
      params: input.params,
      workingDir: input.workingDir,
      sessionId: input.sessionId ?? '',
      capabilities: input.capabilities,
      toolSource: input.toolSource,
    });
    const target = derived.target ?? { kind: 'unknown', ref: input.toolName };

    const grants: AuthorityGrant[] = compileAuthorityGrantsForTool({
      toolName: input.toolName,
      params: input.params,
      workingDir: input.workingDir,
      capabilities: input.capabilities,
      toolSource: input.toolSource,
      config: input.config,
      sessionMode: input.sessionMode,
    });

    const principal: AuthorityPrincipal = input.principal ?? {
      kind: 'user',
      id: 'local',
      roles: [],
    };

    const turn: AuthorityTurn = {
      id: input.turnId ?? `turn:${input.sessionId ?? 'session'}`,
      sessionId: input.sessionId ?? '',
      principal,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ceiling: this._sessionCeiling(input, action, target.kind),
      startedAt: new Date().toISOString(),
    };

    const resolver = new AuthorityResolver({
      principalGrants: grants,
      policy: this._options.policy ?? null,
    });

    const decision = resolver.decide(turn, action, target, derived.altRefs);

    return {
      decision,
      // `ask` от потолка/политики (ось ≠ «user») `yolo` не снимает.
      requiresConfirm: decision.effect === 'ask' && decision.source !== 'user',
      action,
      target: `${target.kind}:${target.ref}`,
    };
  }

  /**
   * Потолок сессии (ось `session`).
   *
   * - `plan` (или strict без утверждённого плана) — только чтение;
   * - обычный режим — «разрешено всё» + требование подтверждения для цели
   *   вне рабочего каталога (fail-closed дефолт `external_directory`).
   */
  private _sessionCeiling(
    input: AuthorityShadowInput,
    action: string,
    targetKind: string,
  ): AuthorityCeiling[] {
    if (isPlanRestricted(input.sessionMode, input.planMode, input.planApproved)) {
      return [{ source: 'session', grants: readOnlyCeilingGrants() }];
    }

    const grants: AuthorityGrant[] = this._allowAllCeilingGrants();
    if (targetKind === 'outside' && !hasExternalDirectoryRule(input.config)) {
      // Fail-closed дефолт: путь вне рабочего каталога — только после
      // подтверждения. `yolo` это требование **не снимает** (потолок сессии).
      grants.push({ action, targetPattern: 'outside:**', effect: 'ask' });
    }
    return [{ source: 'session', grants }];
  }

  /** «Разрешено всё» — потолок по умолчанию (ядро + объявленный контент). */
  private _allowAllCeilingGrants(): AuthorityGrant[] {
    const actions = [
      ...AUTHORITY_CORE_ACTIONS,
      ...(this._options.policy?.actions ?? []).map((declared) => declared.id),
    ];
    const kinds = [
      ...AUTHORITY_CORE_TARGET_KINDS,
      ...(this._options.policy?.targets ?? []).map((declared) => declared.kind),
    ];
    const grants: AuthorityGrant[] = [];
    for (const action of actions) {
      for (const kind of kinds) {
        grants.push({ action, targetPattern: `${kind}:**`, effect: 'allow' });
      }
    }
    return grants;
  }

  /** Запись в журнал + счётчик метрики. */
  private _enqueue(entry: AuthorityDecisionEntry): void {
    this._queue = this._queue
      .then(() => this._write(entry))
      .catch(() => {
        // Ошибка записи в журнал не влияет на ход.
      });
  }

  /** Строит запись журнала решений. */
  private _entry(
    computed: ComputedAuthorityDecision,
    input: AuthorityShadowInput,
    mode: 'shadow' | 'enforced',
  ): AuthorityDecisionEntry {
    const principal = input.principal ?? { kind: 'user' as const, id: 'local', roles: [] };
    return {
      id: `ad_${randomUUID()}`,
      ts: new Date().toISOString(),
      principal: `${principal.kind}:${principal.id}`,
      action: computed.action,
      target: computed.target,
      effect: computed.decision.effect,
      source: computed.decision.source,
      reason: computed.decision.reason,
      mode,
      // Решение permission-слоя — для разбора расхождений миграции (shadow).
      ...(mode === 'shadow' ? { permissionEffect: input.decision.action } : {}),
    };
  }

  /** Запись в журнал + счётчик метрики. */
  private async _write(entry: AuthorityDecisionEntry): Promise<void> {
    try {
      await this._options.journal?.append(entry);
    } catch {
      // Ошибка записи в журнал не влияет на ход **и не гасит метрику**:
      // решение-то посчитано.
    }
    try {
      this._options.onDecision?.(entry);
    } catch {
      // Ошибка метрик не влияет на ход.
    }
  }
}

/** Потолок режима `plan` — только чтение (ADR-025/ADR-028). */
function readOnlyCeilingGrants(): AuthorityGrant[] {
  const kinds = AUTHORITY_CORE_TARGET_KINDS.filter((kind) => kind !== 'outside');
  return kinds.map((kind) => ({ action: 'read', targetPattern: `${kind}:**`, effect: 'allow' }));
}

/** Задано ли явное правило `external_directory` в правилах сессии. */
function hasExternalDirectoryRule(config: PermissionConfig): boolean {
  return config.rules?.['external_directory'] !== undefined;
}

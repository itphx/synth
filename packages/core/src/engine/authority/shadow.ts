/**
 * PROP-108 Ф1: shadow-интеграция Authority-слоя.
 *
 * Слой в режиме наблюдения: authority-решение **считается** и пишется в
 * журнал решений (`{dataDir}/audit/authority.jsonl` через порт
 * `AuthorityDecisionJournal`), но **не применяется** — решение permission-слоя
 * остаётся в силе (PROP-108 §«Совместимость и миграция»: «Ф0–Ф1: старые
 * правила и `capabilities` читаются как раньше, authority-резолвер работает в
 * режиме shadow»).
 *
 * Что попадает в журнал: `principal`/`action`/`target`/`effect`/`source`/
 * `reason` — **без секретов и без сырых абсолютных путей** (цель строится
 * относительно workspace, инвариант 25/ADR-094).
 *
 * Расхождение shadow-решения с текущим — **дефект миграции**, а не повод
 * «подкрутить» политику; поэтому в журнал пишется и текущее решение
 * permission-слоя (поле `permissionEffect`).
 */
import { randomUUID } from 'node:crypto';

import type {
  AuthorityCeiling,
  AuthorityDecisionEntry,
  AuthorityGrant,
  AuthorityPolicy,
  AuthorityPrincipal,
  AuthorityTurn,
} from '@itphx/synth-shared';

import type { AuthorityDecisionJournal } from '../../storage/ports/authority-decision-journal.js';
import { isPlanRestricted } from '../permission/evaluator.js';
import { authorityActionForTool } from './actions.js';
import { compileAuthorityGrantsForTool } from './compile.js';
import type { AuthorityShadowHook, AuthorityShadowInput } from './hook.js';
import { AuthorityResolver } from './resolve.js';
import { deriveAuthorityTarget } from './target.js';

/** Опции shadow-записи. */
export interface AuthorityShadowRecorderOptions {
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

/**
 * Считает authority-решения и пишет их в журнал.
 *
 * Решение permission-слоя не меняется: этот класс **только наблюдает**.
 */
export class AuthorityShadowRecorder {
  /** Очередь записей — записи журнала идут последовательно. */
  private _queue: Promise<void> = Promise.resolve();

  constructor(private readonly _options: AuthorityShadowRecorderOptions) {}

  /** Слой активен: включён и работает в режиме наблюдения. */
  get active(): boolean {
    return this._options.enabled && this._options.shadow;
  }

  /**
   * Шов для permission-слоя: считает решение и ставит запись в очередь.
   *
   * Синхронный и не бросающий: ошибка shadow **не влияет на ход**.
   */
  readonly record: AuthorityShadowHook = (input: AuthorityShadowInput): void => {
    if (!this.active) return;
    let entry: AuthorityDecisionEntry;
    try {
      entry = this._decide(input);
    } catch {
      // Shadow-ошибка не должна ломать ход.
      return;
    }
    this._queue = this._queue
      .then(() => this._write(entry))
      .catch(() => {
        // Ошибка записи в журнал не влияет на ход.
      });
  };

  /** Дождаться завершения очереди записей (тесты/остановка инстанса). */
  async flush(): Promise<void> {
    await this._queue;
  }

  /** Считает решение и строит запись журнала. */
  private _decide(input: AuthorityShadowInput): AuthorityDecisionEntry {
    const action = this._actionOf(input);
    const derived = deriveAuthorityTarget({
      toolName: input.toolName,
      params: input.params,
      workingDir: input.workingDir,
      sessionId: input.sessionId ?? '',
      capabilities: input.capabilities,
      toolSource: input.toolSource,
    });

    const grants: AuthorityGrant[] = compileAuthorityGrantsForTool({
      toolName: input.toolName,
      params: input.params,
      workingDir: input.workingDir,
      capabilities: input.capabilities,
      toolSource: input.toolSource,
      config: input.config,
    });

    const principal: AuthorityPrincipal = input.principal ?? {
      kind: 'user',
      id: 'local',
      roles: [],
    };

    const turn: AuthorityTurn = {
      id: input.turnId ?? `shadow:${input.sessionId ?? 'session'}`,
      sessionId: input.sessionId ?? '',
      principal,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ceiling: this._sessionCeiling(input),
      startedAt: new Date().toISOString(),
    };

    const resolver = new AuthorityResolver({
      principalGrants: grants,
      policy: this._options.policy ?? null,
    });

    const target = derived.target ?? { kind: 'unknown', ref: input.toolName };
    const decision = resolver.decide(turn, action, target, derived.altRefs);

    return {
      id: `ad_${randomUUID()}`,
      ts: new Date().toISOString(),
      principal: `${principal.kind}:${principal.id}`,
      action,
      target: `${target.kind}:${target.ref}`,
      effect: decision.effect,
      source: decision.source,
      reason: decision.reason,
      mode: 'shadow',
      // Текущее решение permission-слоя — для разбора расхождений миграции.
      permissionEffect: input.decision.action,
    };
  }

  /** Действие инструмента; `unknown` — отображения нет (fail-closed). */
  private _actionOf(input: AuthorityShadowInput): string {
    return authorityActionForTool(input.toolName, input.capabilities) ?? 'unknown';
  }

  /**
   * Потолок сессии: в режиме plan (или strict без утверждённого плана)
   * разрешено только чтение — как и в permission-слое (ADR-025/ADR-028).
   */
  private _sessionCeiling(input: AuthorityShadowInput): AuthorityCeiling[] {
    if (!isPlanRestricted(input.sessionMode, input.planMode, input.planApproved)) return [];
    return [
      {
        source: 'session',
        grants: [
          { action: 'read', targetPattern: 'path:**', effect: 'allow' },
          { action: 'read', targetPattern: 'workspace:**', effect: 'allow' },
          { action: 'read', targetPattern: 'session:**', effect: 'allow' },
          { action: 'read', targetPattern: 'external:**', effect: 'allow' },
          { action: 'read', targetPattern: 'mcp:**', effect: 'allow' },
        ],
      },
    ];
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

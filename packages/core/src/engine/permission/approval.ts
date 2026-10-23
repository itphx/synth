import { createHash } from 'node:crypto';

import {
  authorityPrincipalSchema,
  type AuthorityPrincipal,
  type AuthorityTarget,
} from '@itphx/synth-shared';

import type { EventBus } from '../../events/bus.js';
import { computeAuthorityApprovalDigest } from '../authority/resolve.js';

export interface ApprovalRequest {
  approvalId: string;
  callId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  reason: string;
  /**
   * ADR-106 Ф0: принципал хода, которому адресован запрос (аддитивно).
   * Не задан — поле не публикуется (старые потребители не ломаются).
   */
  principal?: AuthorityPrincipal;
  /**
   * ADR-106 Ф0: идентификатор хода (аддитивно). В проводе события — `turn_id`.
   */
  turnId?: string;
  /**
   * ADR-106 Ф0: отпечаток запроса (аддитивно) — связывает подтверждение с
   * конкретным `(ход, действие, цель)`.
   */
  digest?: string;
  /**
   * ADR-106 Ф3: действие Authority-слоя (`read`/`write`/…). Задано вместе с
   * `target` — тогда запрос **привязан** к паре «действие × цель» и ответ
   * принимается только у носителя покрывающего гранта.
   */
  action?: string;
  /**
   * ADR-106 Ф3: цель Authority-слоя (типизированный ресурс). Вместе с
   * `action` образует привязку подтверждения.
   */
  target?: AuthorityTarget;
}

export interface ApprovalDecision {
  approved: boolean;
  /** true — истекло время ожидания ответа пользователя */
  timeout?: boolean;
  /** true — у сессии не было подписчиков, спрашивать было некому */
  noSubscribers?: boolean;
  /** Решение пользователя в новом формате WS permission_reply: allow | deny. */
  action?: 'allow' | 'deny';
  /** true — разрешить только один раз (не добавлять allow-правило в сессию). */
  once?: boolean;
}

/**
 * Отпечаток запроса подтверждения (ADR-106 Ф0): sha256 от канонического
 * представления `(сессия, ход, тул, аргументы)`.
 *
 * Секретов в отпечатке нет: в аргументы тула попадают уже обфусцированные
 * значения (ADR-036), а сам отпечаток — необратимый хэш.
 */
export function computePermissionDigest(input: {
  sessionId: string;
  turnId?: string;
  toolName: string;
  args: Record<string, unknown>;
}): string {
  const canonical = JSON.stringify({
    sessionId: input.sessionId,
    turnId: input.turnId ?? '',
    tool: input.toolName,
    args: sortKeys(input.args),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/** Рекурсивная сортировка ключей — стабильный JSON для хэша. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    const out: Record<string, unknown> = {};
    for (const [key, item] of entries) out[key] = sortKeys(item);
    return out;
  }
  return value;
}

/**
 * Разбор принципала из недоверенного источника (WS-сообщение).
 *
 * ADR-106 Ф0: принципал в `permission.replied` — **аддитивное** поле; пришло
 * что-то невалидное — поле просто не публикуется (поведение прежнее). Схема
 * строгая: неизвестное поле/вид → `undefined`.
 */
export function parsePermissionPrincipal(value: unknown): AuthorityPrincipal | undefined {
  const parsed = authorityPrincipalSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * ADR-029: минимальный механизм подтверждения для действия `ask`.
 *
 * Публикует событие `permission.asked` в EventBus (UI/пользователь может ответить),
 * затем ожидает `permission.replied` с совпадающим approval_id до таймаута.
 * Если у сессии нет подписчиков EventBus — спрашивать некому, возвращает отказ.
 *
 * ADR-106 Ф0: событие `permission.asked` **аддитивно** получает `principal`,
 * `turn_id` и `digest` (принципал/ход/отпечаток запроса). Поля опциональны —
 * старые потребители (UI, backend) продолжают читать прежний набор.
 *
 * ADR-106 Ф3: если задан `registry` (реестр подтверждений) и запрос привязан к
 * паре «действие × цель», запрос **регистрируется** в реестре: ответ принимает
 * только носитель покрывающего гранта, повторный ответ — отказ. Реестр не
 * задан — поведение прежнее (слой Authority выключен или работает в shadow).
 */
export class PermissionApprovalManager {
  constructor(
    private readonly _eventBus: EventBus,
    private readonly _options: { registry?: ApprovalRegistry } = {},
  ) {}

  async waitForDecision(
    sessionId: string,
    request: ApprovalRequest,
    timeoutMs: number,
  ): Promise<ApprovalDecision> {
    if (this._eventBus.subscriberCount(sessionId) === 0) {
      return { approved: false, noSubscribers: true };
    }

    return new Promise<ApprovalDecision>((resolve) => {
      let done = false;
      let held = false;
      let unsub: () => void = () => {};
      // ADR-029: askTimeoutMs <= 0 (0 = «таймаут выключен») — таймер не ставим,
      // ждём permission.replied бесконечно (без авто-отклонения).
      const timer = typeof timeoutMs === 'number' && timeoutMs > 0
        ? setTimeout(() => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            unsub();
            this._options.registry?.close(request.approvalId);
            resolve({ approved: false, timeout: true });
          }, timeoutMs)
        : undefined;

      const finish = (decision: ApprovalDecision): void => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        unsub();
        this._options.registry?.close(request.approvalId);
        resolve(decision);
      };

      // Подписка ДО публикации: EventBus.publish синхронный, иначе ответ
      // мгновенного подписчика (имитация UI) был бы потерян.
      unsub = this._eventBus.subscribe(sessionId, (event) => {
        if (done) return;
        const data = event.data as Record<string, unknown>;
        if (data.approval_id !== request.approvalId) return;

        // «Остановить таймер» (permission.hold): прекращаем авто-отклонение по
        // таймауту. Запрос остаётся на паузе до тех пор, пока не придёт
        // permission.replied; затем finish(decision) разрешает как обычно.
        if (event.type === 'permission.hold') {
          if (!held) {
            held = true;
            if (timer) clearTimeout(timer);
          }
          return;
        }

        if (event.type !== 'permission.replied') return;
        const action = data.action === 'allow' || data.action === 'deny' ? data.action : undefined;
        const decision: ApprovalDecision = {
          approved: action !== undefined ? action === 'allow' : data.approved === true,
        };
        if (action) decision.action = action;
        if (typeof data.once === 'boolean') decision.once = data.once;
        finish(decision);
      });

      // ADR-106 Ф0/Ф3: отпечаток запроса — из запроса; для привязанного
      // (Authority) запроса — отпечаток привязки «ход + действие + цель».
      // Сужаем типы проверкой (без `!`): привязка задана только когда заданы
      // все три поля.
      const { action: boundAction, target: boundTarget, turnId: boundTurnId } = request;
      const bound =
        boundAction !== undefined && boundTarget !== undefined && boundTurnId !== undefined;
      const digest = bound
        ? computeAuthorityApprovalDigest({
            turnId: boundTurnId,
            action: boundAction,
            target: boundTarget,
          })
        : (request.digest ??
          computePermissionDigest({
            sessionId,
            turnId: request.turnId,
            toolName: request.toolName,
            args: request.arguments,
          }));

      // ADR-106 Ф3: регистрируем привязку — ответ принимает только носитель
      // покрывающего гранта, повторный ответ — отказ.
      if (boundAction !== undefined && boundTarget !== undefined && boundTurnId !== undefined) {
        this._options.registry?.open(request.approvalId, {
          principal: request.principal ?? { kind: 'user', id: 'local', roles: [] },
          turnId: boundTurnId,
          action: boundAction,
          target: boundTarget,
          digest,
        });
      }

      this._eventBus.publish(sessionId, 'permission.asked', {
        approval_id: request.approvalId,
        session_id: sessionId,
        call_id: request.callId,
        tool: request.toolName,
        arguments: request.arguments,
        reason: request.reason,
        ask_timeout_ms: timeoutMs,
        // ADR-106 Ф0: аддитивные поля (принципал/ход/отпечаток).
        ...(request.principal ? { principal: request.principal } : {}),
        ...(request.turnId ? { turn_id: request.turnId } : {}),
        digest,
      });
    });
  }
}

// --- ADR-106 Ф3: реестр подтверждений ---

/**
 * Привязка подтверждения (ADR-106 Ф3): `(принципал, ход, действие, цель,
 * отпечаток)`. Подтверждение выдаётся на конкретное действие конкретного хода
 * и **одноразово**.
 */
export interface ApprovalBinding {
  /** Принципал хода, которому адресован запрос. */
  principal: AuthorityPrincipal;
  /** Ход (`turn_id`), которому принадлежит запрос. */
  turnId: string;
  /** Действие Authority-слоя. */
  action: string;
  /** Цель Authority-слоя. */
  target: AuthorityTarget;
  /** Отпечаток привязки (ход + действие + цель). */
  digest: string;
}

/** Причины отказа в подтверждении (ADR-106 Ф3). */
export type ApprovalClaimReason =
  | 'ok'
  | 'unknown_approval'
  | 'already_consumed'
  | 'turn_mismatch'
  | 'digest_mismatch'
  | 'no_grant';

/** Итог попытки подтвердить запрос. */
export interface ApprovalClaimResult {
  /** true — ответ принят (подтверждение списано). */
  ok: boolean;
  /** Причина (при `ok: false` — почему отказано). */
  reason: ApprovalClaimReason;
  /** Привязка подтверждения (если запрос известен). */
  binding?: ApprovalBinding;
}

/**
 * Проверка права подтверждать: носитель **покрывающего гранта**
 * (ADR-106 §«Резолвинг и решение», п. 2 `approve`).
 *
 * Резолвер не доверяет клиенту: он получает **аутентифицированного** принципала
 * и проверяет его гранты (роли инстанса, роль в проекте, гранты политики).
 */
export type ApprovalCoverageResolver = (
  sessionId: string,
  responder: AuthorityPrincipal,
  binding: ApprovalBinding,
) => boolean | Promise<boolean>;

/** Опции реестра подтверждений. */
export interface ApprovalRegistryOptions {
  /**
   * Резолвер покрытия (носитель покрывающего гранта). Не задан — **fail-closed**:
   * ни одно подтверждение не принимается (защищённый режим).
   */
  coverage?: ApprovalCoverageResolver;
}

/**
 * Реестр подтверждений (ADR-106 Ф3) — **единственное** место, где решается,
 * можно ли принять ответ на запрос подтверждения.
 *
 * Инварианты:
 * 1. **одноразовость**: принятое подтверждение списывается; повторный ответ —
 *    отказ (`already_consumed`);
 * 2. **привязка к ходу**: ответ с чужим `turn_id`/`digest` — отказ;
 * 3. **носитель покрывающего гранта**: ответ без гранта — отказ (`no_grant`).
 *
 * Реестр живёт на инстанс (в процессе), состояние — в памяти (ADR-099 п. 24).
 */
export class ApprovalRegistry {
  private readonly _pending = new Map<string, ApprovalBinding>();
  private readonly _consumed = new Set<string>();

  constructor(private readonly _options: ApprovalRegistryOptions = {}) {}

  /** Зарегистрировать привязку запроса подтверждения. */
  open(approvalId: string, binding: ApprovalBinding): void {
    this._pending.set(approvalId, binding);
    this._consumed.delete(approvalId);
  }

  /** Снять привязку (ответ получен или истёк таймаут). */
  close(approvalId: string): void {
    this._pending.delete(approvalId);
  }

  /** Привязка запроса (без списания). */
  get(approvalId: string): ApprovalBinding | undefined {
    return this._pending.get(approvalId);
  }

  /**
   * Попытка принять ответ на запрос подтверждения.
   *
   * `opts.turnId`/`opts.digest` — то, что прислал клиент (необязательно): при
   * расхождении с привязкой — отказ. Клиенту доверять нельзя, поэтому
   * привязка всегда берётся из реестра.
   */
  async claim(
    approvalId: string,
    sessionId: string,
    responder: AuthorityPrincipal,
    opts: { turnId?: string; digest?: string } = {},
  ): Promise<ApprovalClaimResult> {
    const binding = this._pending.get(approvalId);
    if (!binding) {
      return {
        ok: false,
        reason: this._consumed.has(approvalId) ? 'already_consumed' : 'unknown_approval',
      };
    }
    if (this._consumed.has(approvalId)) {
      return { ok: false, reason: 'already_consumed', binding };
    }
    if (opts.turnId !== undefined && opts.turnId !== binding.turnId) {
      return { ok: false, reason: 'turn_mismatch', binding };
    }
    if (opts.digest !== undefined && opts.digest !== binding.digest) {
      return { ok: false, reason: 'digest_mismatch', binding };
    }

    // Носитель покрывающего гранта. Резолвер не задан — fail-closed.
    const covered = this._options.coverage
      ? await this._options.coverage(sessionId, responder, binding)
      : false;
    if (!covered) {
      return { ok: false, reason: 'no_grant', binding };
    }

    this._consumed.add(approvalId);
    this._pending.delete(approvalId);
    return { ok: true, reason: 'ok', binding };
  }
}

import { createHash } from 'node:crypto';

import { authorityPrincipalSchema, type AuthorityPrincipal } from '@itphx/synth-shared';

import type { EventBus } from '../../events/bus.js';

export interface ApprovalRequest {
  approvalId: string;
  callId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  reason: string;
  /**
   * PROP-108 Ф0: принципал хода, которому адресован запрос (аддитивно).
   * Не задан — поле не публикуется (старые потребители не ломаются).
   */
  principal?: AuthorityPrincipal;
  /**
   * PROP-108 Ф0: идентификатор хода (аддитивно). В проводе события — `turn_id`.
   */
  turnId?: string;
  /**
   * PROP-108 Ф0: отпечаток запроса (аддитивно) — связывает подтверждение с
   * конкретным `(ход, действие, цель)`.
   */
  digest?: string;
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
 * Отпечаток запроса подтверждения (PROP-108 Ф0): sha256 от канонического
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
 * PROP-108 Ф0: принципал в `permission.replied` — **аддитивное** поле; пришло
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
 * PROP-108 Ф0: событие `permission.asked` **аддитивно** получает `principal`,
 * `turn_id` и `digest` (принципал/ход/отпечаток запроса). Поля опциональны —
 * старые потребители (UI, backend) продолжают читать прежний набор.
 */
export class PermissionApprovalManager {
  constructor(private readonly _eventBus: EventBus) {}

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
            resolve({ approved: false, timeout: true });
          }, timeoutMs)
        : undefined;

      const finish = (decision: ApprovalDecision): void => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        unsub();
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

      // PROP-108 Ф0: отпечаток запроса — из запроса, иначе считаем по
      // (сессия, ход, тул, аргументы).
      const digest =
        request.digest ??
        computePermissionDigest({
          sessionId,
          turnId: request.turnId,
          toolName: request.toolName,
          args: request.arguments,
        });

      this._eventBus.publish(sessionId, 'permission.asked', {
        approval_id: request.approvalId,
        session_id: sessionId,
        call_id: request.callId,
        tool: request.toolName,
        arguments: request.arguments,
        reason: request.reason,
        ask_timeout_ms: timeoutMs,
        // PROP-108 Ф0: аддитивные поля (принципал/ход/отпечаток).
        ...(request.principal ? { principal: request.principal } : {}),
        ...(request.turnId ? { turn_id: request.turnId } : {}),
        digest,
      });
    });
  }
}

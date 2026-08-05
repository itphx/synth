import type { EventBus } from '../../events/bus.js';

export interface ApprovalRequest {
  approvalId: string;
  callId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  reason: string;
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
 * AD-029: минимальный механизм подтверждения для действия `ask`.
 *
 * Публикует событие `permission.asked` в EventBus (UI/пользователь может ответить),
 * затем ожидает `permission.replied` с совпадающим approval_id до таймаута.
 * Если у сессии нет подписчиков EventBus — спрашивать некому, возвращает отказ.
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
      let unsub: () => void = () => {};

      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        unsub();
        resolve({ approved: false, timeout: true });
      }, timeoutMs);

      const finish = (decision: ApprovalDecision): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        unsub();
        resolve(decision);
      };

      // Подписка ДО публикации: EventBus.publish синхронный, иначе ответ
      // мгновенного подписчика (имитация UI) был бы потерян.
      unsub = this._eventBus.subscribe(sessionId, (event) => {
        if (event.type !== 'permission.replied') return;
        const data = event.data as Record<string, unknown>;
        if (data.approval_id !== request.approvalId) return;
        const action = data.action === 'allow' || data.action === 'deny' ? data.action : undefined;
        const decision: ApprovalDecision = {
          approved: action !== undefined ? action === 'allow' : data.approved === true,
        };
        if (action) decision.action = action;
        if (typeof data.once === 'boolean') decision.once = data.once;
        finish(decision);
      });

      this._eventBus.publish(sessionId, 'permission.asked', {
        approval_id: request.approvalId,
        session_id: sessionId,
        call_id: request.callId,
        tool: request.toolName,
        arguments: request.arguments,
        reason: request.reason,
        ask_timeout_ms: timeoutMs,
      });
    });
  }
}

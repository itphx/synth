/**
 * Дочерняя сессия саб-агента: публикация сообщений/событий и её жизненный цикл
 * (финализация, запись сообщений, накопление usage, metadata финального ответа).
 *
 * ADR-095 (шаг 5): вынесено из `task.ts` без изменения поведения.
 */
import { nowISO } from '@itphx/synth-shared';
import type { Message, Session, TokenUsage } from '@itphx/synth-shared';
import type { EventBus } from '../../../events/bus.js';
import { serializeMessage, serializeSession } from '../../../server/serialize.js';
import { computeCacheHitRate, computeUsageCost } from '../../../providers/usage.js';
import type { AssistantMessageStatus } from '../../orchestrator.js';
import type { TaskExtra } from './types.js';

export async function publishMessageAdded(
  eventBus: EventBus,
  parentSessionId: string,
  childSessionId: string,
  msg: Message,
  index: number,
  childSession?: Session,
): Promise<void> {
  const serialized = serializeMessage(msg, index);
  const payload = {
    session_id: childSessionId,
    message: serialized,
    index,
  };
  eventBus.publish(childSessionId, 'message.added', payload);
  eventBus.publish(parentSessionId, 'child.message.added', {
    ...payload,
    child_session_id: childSessionId,
  });
  if (childSession) {
    eventBus.publish(parentSessionId, 'child.session.updated', {
      session: serializeSession(childSession),
    });
  }
}

export interface ChildSessionLifecycleOptions {
  /** Дочерняя сессия (если есть) — в неё пишется история саб-агента. */
  childSessionId?: string;
  /** Сессия для child.*-событий (у task — родитель, у resume — родитель resumed-сессии). */
  parentSessionId: string;
  extra: TaskExtra;
  /**
   * Накопленный usage саб-агента — общий mutable-объект с циклом
   * (цикл мутирует его через `accumulateUsage`).
   */
  usage: TokenUsage;
  /** Модель саб-агента — меняется по ходу цикла (последний чанк провайдера). */
  getModel: () => string | undefined;
}

export interface ChildSessionLifecycle {
  /** Финализация дочерней сессии: `updatedAt` + терминальные события для UI. */
  finalize(): Promise<void>;
  /** Добавить сообщение в дочернюю сессию + опубликовать события. */
  addMessage(msg: Message): Promise<void>;
  /** Session-счётчики usage дочерней сессии — ровно один раз на прогон. */
  commitUsage(): Promise<void>;
  /** Metadata финального assistant-сообщения (status/cost_usd/cost_breakdown). */
  buildAssistantMetadata(status: AssistantMessageStatus, extraMeta?: Record<string, unknown>): Record<string, unknown>;
}

/**
 * Жизненный цикл дочерней сессии. Вынесен фабрикой, потому что замыкается на
 * мутабельное состояние цикла саб-агента (`childSessionId`, накопленный
 * `subagentUsage`, текущая модель).
 */
export function createChildSessionLifecycle(opts: ChildSessionLifecycleOptions): ChildSessionLifecycle {
  const { childSessionId, parentSessionId, extra, usage, getModel } = opts;

  // Финализация дочерней сессии: обновление updatedAt + события для UI.
  // Отдельного статусного поля «завершена/прервана» у сессии нет
  // (SessionStatus — только процессная блокировка blocked/blockedAt),
  // поэтому факт прерывания/ошибки фиксируется metadata-маркерами
  // в сообщениях истории дочерней сессии.
  const finalize = async (): Promise<void> => {
    if (!childSessionId || !extra.sessionManager) return;
    try {
      const childSession = await extra.sessionManager.getSession(childSessionId);
      if (childSession) {
        childSession.updatedAt = nowISO();
        await extra.sessionManager.updateSession(childSession);

        if (extra.eventBus) {
          // ADR-070 §2.6: терминальное live-событие дочерней сессии. Дочерний
          // саб-агент не публикует stream.start/stream.done, а его live-статистика
          // идёт только stream.usage. Это событие гарантирует, что открытая
          // дочерняя сессия сбросит live-плейсхолдер после завершения работы
          // (сообщение ребёнка сохраняется отдельно, дубля не возникает).
          extra.eventBus.publish(childSessionId, 'stream.ended', {
            session_id: childSessionId,
            stream_id: extra.streamId,
          });
          extra.eventBus.publish(childSessionId, 'session.updated', {
            session_id: childSessionId,
          });
          extra.eventBus.publish(parentSessionId, 'child.session.updated', {
            session: serializeSession(childSession),
          });
        }
      }
    } catch {
      // не фатально
    }
  };

  /** Добавить сообщение в дочернюю сессию + опубликовать события. */
  const addMessage = async (msg: Message): Promise<void> => {
    if (!childSessionId || !extra.sessionManager) return;
    try {
      const updated = await extra.sessionManager.addMessage(childSessionId, msg);
      if (updated && extra.eventBus) {
        const idx = updated.messages.length - 1;
        await publishMessageAdded(extra.eventBus, parentSessionId, childSessionId, updated.messages[idx]!, idx, updated);
      }
    } catch {
      // не фатально
    }
  };

  /**
   * ADR-070 §2.6: metadata финального assistant-сообщения дочерней сессии.
   * Единая точка простановки `status`/`cost_usd`/`cost_breakdown` — как
   * `_saveAssistantMessage` оркестратора: стоимость считается по ценам модели
   * (`extra.modelPriceLoader` + модель саб-агента), только если они заданы.
   * `usage_estimated` здесь НЕ пишется: `usage` собран из финальных
   * чанков провайдера и потому точен (оценка в live-событиях не персистится).
   */
  const buildAssistantMetadata = (
    status: AssistantMessageStatus,
    extraMeta: Record<string, unknown> = {},
  ): Record<string, unknown> => {
    const metadata: Record<string, unknown> = { ...extraMeta, status };
    const model = getModel();
    const cost = model && extra.modelPriceLoader
      ? computeUsageCost(usage, extra.modelPriceLoader(model))
      : null;
    if (cost) {
      metadata.cost_usd = cost.costUsd;
      metadata.cost_currency = cost.currency;
      metadata.cost_breakdown = cost.breakdown;
    }
    return metadata;
  };

  // ADR-070 §2.6 / project stats: session-счётчики дочерней сессии обновляются
  // вручную (как `_saveAssistantMessage` оркестратора), потому что task.ts
  // пишет сообщения через `addMessage`, а тот не трогает агрегаты сессии.
  // Иначе `GET /projects/:id/stats` (суммирует `session.inputTokens`) не видит
  // токены саб-агентов. Ровно один раз на прогон саб-агента.
  let usageCommitted = false;
  const commitUsage = async (): Promise<void> => {
    if (usageCommitted) return;
    usageCommitted = true;
    const sessionManager = extra.sessionManager;
    if (!childSessionId || !sessionManager) return;
    try {
      await sessionManager.withLock(childSessionId, async (s) => {
        s.inputTokens += usage.inputTokens || 0;
        s.outputTokens += usage.outputTokens || 0;
        s.totalTokens += usage.totalTokens || 0;
        s.cacheReadTokens += usage.cacheReadTokens || 0;
        s.cacheWriteTokens += usage.cacheWriteTokens || 0;
        s.reasoningTokens += usage.reasoningTokens || 0;
        s.cacheHitRate = computeCacheHitRate(s.cacheReadTokens, s.inputTokens);
        s.updatedAt = nowISO();
        await sessionManager.saveSession(s);
      });
    } catch {
      // не фатально
    }
  };

  return { finalize, addMessage, commitUsage, buildAssistantMetadata };
}

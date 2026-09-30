import type { SessionManager, ContextOptimizer, EventBus } from '@itphx/synth-core';

export interface RecalcCanSummarizeDeps {
  sessionManager: SessionManager;
  contextOptimizer: ContextOptimizer | null;
  eventBus: EventBus;
}

/**
 * Backend-специфичный пересчёт `canSummarize` после мутаций над сообщениями
 * (batch/toggle/pin/delete/retry). Дополнительно перепроверяет флаг
 * `summarizationPending` и публикует `session.updated` с токенами/стоимостью.
 *
 * Вынесено из роутов сообщений: сами роуты теперь — core-фабрика, а этот хук
 * передаётся в неё через `onMessagesChanged`.
 */
export function createRecalcCanSummarize({
  sessionManager,
  contextOptimizer,
  eventBus,
}: RecalcCanSummarizeDeps): (sessionId: string) => Promise<void> {
  return async (sessionId: string): Promise<void> => {
    if (!contextOptimizer) return;
    const s = await sessionManager.getSession(sessionId);
    if (!s) return;
    const can = contextOptimizer.canSummarize(s);

    // Перепроверить флаг summarizationPending при toggle/pin/delete
    let shouldClearPending = false;
    if (s.summarizationPending && s.settings.summarizationEnabled) {
      const sumResult = contextOptimizer.shouldSummarize(s);
      if (!sumResult.triggered) {
        shouldClearPending = true;
      }
    }

    await sessionManager.withLock(sessionId, async (locked) => {
      locked.canSummarize = can;
      if (shouldClearPending) locked.summarizationPending = false;
      await sessionManager.saveSession(locked);
    });

    eventBus.publish(sessionId, 'session.updated', {
      session_id: sessionId,
      can_summarize: can,
      summarization_pending: shouldClearPending ? false : undefined,
      input_tokens: s.inputTokens,
      output_tokens: s.outputTokens,
      total_tokens: s.totalTokens,
      cache_read_tokens: s.cacheReadTokens,
      cache_write_tokens: s.cacheWriteTokens,
      reasoning_tokens: s.reasoningTokens,
      input_cost: s.inputCost,
      output_cost: s.outputCost,
      cache_read_cost: s.cacheReadCost,
      cache_write_cost: s.cacheWriteCost,
    });
  };
}

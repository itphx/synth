/**
 * ADR-095 (шаг 6a): суммаризация контекста вручную/по запросу (ADR-070 §2.6).
 *
 * Вынесено из `engine/orchestrator.ts` без изменения поведения. Класс
 * `ChatOrchestrator` сохраняет делегацию `_handleSummarization`.
 */
import type { Message, Session, TokenUsage } from '@itphx/synth-shared';
import { MessageRole } from '@itphx/synth-shared';
import type { BaseProvider, CancellationToken, LLMMessage, SystemPromptPayload } from '../../providers/base.js';
import type { ContextOptimizer } from '../context/optimizer.js';
import type { DebugCollector } from '../../debug.js';
import type { SessionManager } from '../../sessions/manager.js';
import type { EventBus } from '../../events/bus.js';
import type { UsageCost } from '../../providers/usage.js';
import { warning } from '../../logger.js';
import type { SaveAssistantMessageFn } from './persistence.js';
import type { LlmFailureContext } from './errors.js';

/** Зависимости `handleSummarization`. */
export interface SummarizationDeps {
  optimizer: ContextOptimizer | null;
  cancellationTokens: Map<string, CancellationToken>;
  handleLlmFailure: (
    sessionId: string,
    streamId: string,
    error: unknown,
    attempt: number | undefined,
    ctx: LlmFailureContext | undefined,
  ) => Promise<{ error?: string; errorType?: string; canRetry?: boolean }>;
  estimatePromptChars: (
    messages: LLMMessage[],
    systemPrompt: SystemPromptPayload | string | undefined,
    tools?: Record<string, unknown>[],
  ) => number;
  computeMessageCost: (model: string | undefined, usage: TokenUsage | undefined) => UsageCost | null;
  saveAssistantMessage: SaveAssistantMessageFn;
  sessionManager: SessionManager;
  eventBus: EventBus;
}

export async function handleSummarization(
  session: Session,
  message: Message,
  signal: AbortSignal,
  publishChunk: (event: string, data: Record<string, unknown>) => void,
  debugCollector: DebugCollector,
  streamId: string,
  attempt: number | undefined,
  deps: SummarizationDeps,
): Promise<{ error?: string; errorType?: string; canRetry?: boolean }> {
  if (!deps.optimizer) {
    return { error: 'ContextOptimizer not available', errorType: 'internal', canRetry: false };
  }

  // ADR-070 §2.6: длительность этого прогона суммаризации.
  const startedAt = Date.now();
  const lang = session.settings.language || 'ru';

  let prep: {
    provider: BaseProvider;
    llmMessages: LLMMessage[];
    summarizerPrompt: string;
    messagesToSummarize: Message[];
    indices: number[];
  };

  try {
    prep = deps.optimizer.prepareSummarizationForOrchestrator(session, lang);
  } catch (e) {
    return { error: String(e), errorType: 'summarization_prep_failed', canRetry: false };
  }

  const provider = prep.provider;
  const providerName = (message.provider as string) || session.settings.provider || '';

  debugCollector.captureSessionInfo(session.id, provider.model, providerName, {
    provider_type: provider.type,
    debug_enabled: session.settings.debugEnabled,
    context_optimization: 'summarization',
  });

  // Стрим от LLM суммаризатора
  let accumulatedContent = '';
  let accumulatedReasoning = '';
  let finalUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  let finalModel: string | undefined;

  const cancelToken: CancellationToken = {
    cancelled: false,
    cancel: () => { cancelToken.cancelled = true; },
  };
  deps.cancellationTokens.set(streamId, cancelToken);

  signal.addEventListener('abort', () => cancelToken.cancel(), { once: true });

  try {
    for await (const chunk of provider.chatAsync(prep.llmMessages, prep.summarizerPrompt, undefined, debugCollector, cancelToken)) {
      if (cancelToken.cancelled) break;
      if (chunk.isFinal) accumulatedContent = chunk.content;
      else accumulatedContent += chunk.content;
      if (chunk.usage) finalUsage = chunk.usage;
      if (chunk.model) finalModel = chunk.model;
      if (chunk.reasoning) accumulatedReasoning = chunk.reasoning;

      publishChunk('stream.chunk', {
        stream_id: streamId,
        content: chunk.isFinal ? '' : chunk.content,
        reasoning: chunk.reasoning,
        is_final: chunk.isFinal,
        agent_role: 'summary',
        model: finalModel,
        provider: providerName,
      });
    }
  } catch (e) {
    warning('ORCHESTRATOR', `Summarization stream error: ${e}`);
    deps.cancellationTokens.delete(streamId);
    return deps.handleLlmFailure(session.id, streamId, e, attempt, {
      debugCollector,
      durationMs: Date.now() - startedAt,
      usage: finalUsage,
      model: finalModel ?? provider.model ?? session.settings.model,
      providerName,
      agentRole: 'summary',
      content: accumulatedContent,
      promptChars: deps.estimatePromptChars(prep.llmMessages, prep.summarizerPrompt),
    });
  }

  if (cancelToken.cancelled) {
    publishChunk('stream.cancelled', { stream_id: streamId, content: accumulatedContent, status: 'cancelled' });
    deps.cancellationTokens.delete(streamId);
    return {};
  }

  // Сохранить summary-сообщение (без message.added — UI получит его через stream.done)
  const durationMs = Date.now() - startedAt;
  const messageCost = deps.computeMessageCost(finalModel, finalUsage);
  await deps.saveAssistantMessage(
    session.id, accumulatedContent, streamId, 'summary',
    finalUsage, finalModel, accumulatedReasoning, debugCollector, false, providerName,
    MessageRole.SUMMARY, prep.indices, true,
    undefined, undefined, undefined, undefined, { duration_ms: durationMs },
  );

  // Отключить засуммаризированные сообщения
  await deps.sessionManager.withLock(session.id, async (s) => {
    for (const idx of prep.indices) {
      if (idx >= 0 && idx < s.messages.length && !s.messages[idx]!.pinned) {
        s.messages[idx]!.disabled = true;
      }
    }
    await deps.sessionManager.saveSession(s);
  });

  const updatedSession = await deps.sessionManager.getSession(session.id);

  const doneData: Record<string, unknown> = {
    stream_id: streamId,
    content: accumulatedContent,
    message_index: (updatedSession?.messages.length ?? session.messages.length + 1) - 1,
    pending_count: Math.max(0, (updatedSession?.pendingMessages.length ?? 1) - 1),
    model: finalModel,
    provider: providerName,
    usage: finalUsage,
    duration_ms: durationMs,
    status: 'completed',
    ...(messageCost ? { cost_usd: messageCost.costUsd, cost_currency: messageCost.currency } : {}),
    metadata: { type: 'summary', indices: prep.indices },
  };

  publishChunk('stream.done', doneData);

  // Обновить canSummarize
  if (updatedSession) {
    await deps.sessionManager.withLock(session.id, async (s) => {
      s.canSummarize = deps.optimizer!.canSummarize(s);
      await deps.sessionManager.saveSession(s);
    });

    const freshSession = await deps.sessionManager.getSession(session.id);

    deps.eventBus.publish(session.id, 'session.updated', {
      session_id: session.id,
      summarization_pending: false,
      can_summarize: freshSession?.canSummarize ?? false,
      input_tokens: freshSession?.inputTokens ?? 0,
      output_tokens: freshSession?.outputTokens ?? 0,
      total_tokens: freshSession?.totalTokens ?? 0,
      cache_read_tokens: freshSession?.cacheReadTokens ?? 0,
      cache_write_tokens: freshSession?.cacheWriteTokens ?? 0,
      reasoning_tokens: freshSession?.reasoningTokens ?? 0,
      cache_hit_rate: freshSession?.cacheHitRate ?? 0,
      input_cost: freshSession?.inputCost ?? 0,
      output_cost: freshSession?.outputCost ?? 0,
      cache_read_cost: freshSession?.cacheReadCost ?? 0,
      cache_write_cost: freshSession?.cacheWriteCost ?? 0,
    });
  }

  deps.cancellationTokens.delete(streamId);
  return {};
}

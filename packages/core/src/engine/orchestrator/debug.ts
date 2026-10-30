/**
 * ADR-095 (шаг 6a): обработка debug-системного сообщения (ADR-070 §2.6).
 *
 * Вынесено из `engine/orchestrator.ts` без изменения поведения. Класс
 * `ChatOrchestrator` сохраняет делегацию `_handleDebugSystemMessage`.
 */
import type { Message, ReasoningLevel, Session, TokenUsage } from '@itphx/synth-shared';
import { MessageRole, generateId } from '@itphx/synth-shared';
import type { BaseProvider, CancellationToken } from '../../providers/base.js';
import type { DebugCollector } from '../../debug.js';
import type { SessionManager } from '../../sessions/manager.js';
import type { UsageCost } from '../../providers/usage.js';
import { t as sm } from '../system-messages.js';
import { warning } from '../../logger.js';
import type { SaveAssistantMessageFn } from './persistence.js';
import type { LlmFailureContext } from './errors.js';
import { StreamTiming } from './stream-stats.js';
// ADR-118 §4: отладочный прогон — обычный ход из одного шага.
import {
  publishPartDelta,
  publishPartUpdated,
  publishStepFinished,
  publishStepStarted,
  publishTurnFinished,
  publishTurnStarted,
  reasoningPartId,
  textPartId,
} from './turn-events.js';

/** Зависимости `handleDebugSystemMessage`. */
export interface DebugSystemMessageDeps {
  getProvider: (providerName: string, session: Session, reasoningLevel?: ReasoningLevel) => BaseProvider | null;
  cancellationTokens: Map<string, CancellationToken>;
  handleLlmFailure: (
    sessionId: string,
    streamId: string,
    error: unknown,
    attempt: number | undefined,
    ctx: LlmFailureContext | undefined,
  ) => Promise<{ error?: string; errorType?: string; canRetry?: boolean }>;
  estimatePromptChars: (
    messages: import('../../providers/base.js').LLMMessage[],
    systemPrompt: import('../../providers/base.js').SystemPromptPayload | string | undefined,
    tools?: Record<string, unknown>[],
  ) => number;
  computeMessageCost: (model: string | undefined, usage: TokenUsage | undefined) => UsageCost | null;
  saveAssistantMessage: SaveAssistantMessageFn;
  sessionManager: SessionManager;
}

export async function handleDebugSystemMessage(
  session: Session,
  message: Message,
  signal: AbortSignal,
  publishChunk: (event: string, data: Record<string, unknown>) => void,
  debugCollector: DebugCollector,
  streamId: string,
  reasoningLevel: ReasoningLevel | undefined,
  attempt: number | undefined,
  deps: DebugSystemMessageDeps,
): Promise<{ error?: string; errorType?: string; canRetry?: boolean }> {
  // ADR-070 §2.6: длительность этого прогона.
  const startedAt = Date.now();
  // T14: тайминги стрима (`seq`/`t_ms` у чанков, сводка в `stream.done`).
  const streamTiming = new StreamTiming(startedAt);
  const providerName = (message.provider as string) || session.settings.provider || '';
  const provider = deps.getProvider(providerName, session, reasoningLevel);
  if (!provider) {
    return {
      error: sm('router.provider_not_found', { provider: providerName || sm('router.provider_unspecified') }),
      errorType: 'provider_not_found',
      canRetry: false,
    };
  }

  debugCollector.captureSessionInfo(session.id, provider.model, providerName, {
    provider_type: provider.type,
    debug_enabled: session.settings.debugEnabled,
    context_optimization: 'debug_system_message',
  });

  const lang = session.settings.language || 'ru';
  const systemPrompt = lang === 'ru'
    ? 'Ты получил отладочное системное сообщение. Ответь коротко, подтвердив, что ты его получил и обработал. Опиши свою текущую роль и модель.'
    : 'You received a debug system message. Respond briefly, confirming you received and processed it. Describe your current role and model.';

  const llmMessages: import('../../providers/base.js').LLMMessage[] = [
    { id: '', role: 'system', content: systemPrompt, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, disabled: false, pinned: false, branchId: '' },
    { id: '', role: 'user', content: lang === 'ru' ? 'Привет! Это отладочное системное сообщение. Как ты здесь оказался?' : 'Hi! This is a debug system message. How did you get here?', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, disabled: false, pinned: false, branchId: '' },
  ];

  let accumulatedContent = '';
  let accumulatedReasoning = '';
  let finalUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  let finalModel: string | undefined;
  // ADR-118 §1: отладочный прогон — ход из одного шага (вызов LLM).
  const turnId = `turn_${streamId}`;
  const stepMessageId = generateId();
  let publishedReasoning: string | undefined;
  publishTurnStarted(publishChunk, { turnId, messageId: message.id });
  publishStepStarted(publishChunk, { turnId, stepIndex: 0, messageId: stepMessageId });

  const cancelToken: CancellationToken = {
    cancelled: false,
    cancel: () => { cancelToken.cancelled = true; },
  };
  deps.cancellationTokens.set(streamId, cancelToken);

  signal.addEventListener('abort', () => cancelToken.cancel(), { once: true });

  try {
    for await (const chunk of provider.chatAsync(llmMessages, systemPrompt, undefined, debugCollector, cancelToken)) {
      if (cancelToken.cancelled) break;
      if (chunk.isFinal) accumulatedContent = chunk.content;
      else accumulatedContent += chunk.content;
      if (chunk.usage) finalUsage = chunk.usage;
      if (chunk.model) finalModel = chunk.model;
      if (chunk.reasoning) accumulatedReasoning = chunk.reasoning;

      // ADR-118 §4: текст шага — дельтами (`part.delta`), рассуждения — частью
      // (`part.updated`).
      streamTiming.next();
      if (!chunk.isFinal && chunk.content) {
        publishPartDelta(publishChunk, {
          messageId: stepMessageId,
          partId: textPartId(0),
          field: 'text',
          delta: chunk.content,
        });
      }
      if (chunk.reasoning && chunk.reasoning !== publishedReasoning) {
        publishedReasoning = chunk.reasoning;
        publishPartUpdated(publishChunk, {
          messageId: stepMessageId,
          partId: reasoningPartId(0),
          part: { id: reasoningPartId(0), type: 'reasoning', data: chunk.reasoning },
        });
      }
    }
  } catch (e) {
    warning('ORCHESTRATOR', `Debug system message stream error: ${e}`);
    deps.cancellationTokens.delete(streamId);
    return deps.handleLlmFailure(session.id, streamId, e, attempt, {
      debugCollector,
      durationMs: Date.now() - startedAt,
      usage: finalUsage,
      model: finalModel ?? provider.model ?? session.settings.model,
      providerName,
      agentRole: 'debug',
      content: accumulatedContent,
      promptChars: deps.estimatePromptChars(llmMessages, systemPrompt),
    });
  }

  if (cancelToken.cancelled) {
    publishChunk('stream.cancelled', { stream_id: streamId, content: accumulatedContent, status: 'cancelled' });
    // ADR-118 §4: ход закрыт отменой.
    publishStepFinished(publishChunk, {
      turnId,
      stepIndex: 0,
      messageId: stepMessageId,
      status: 'cancelled',
      provider: providerName,
      agentRole: 'debug',
    });
    publishTurnFinished(publishChunk, { turnId, status: 'cancelled' });
    deps.cancellationTokens.delete(streamId);
    return {};
  }

  // Сохранить debug-сообщение (без message.added — UI получит его через stream.done)

  const durationMs = Date.now() - startedAt;
  const messageCost = deps.computeMessageCost(finalModel, finalUsage);
  await deps.saveAssistantMessage(
    session.id, accumulatedContent, streamId, 'debug',
    finalUsage, finalModel, accumulatedReasoning, debugCollector, false, providerName,
    MessageRole.DEBUG, undefined, true,
    undefined, undefined, undefined, undefined, { duration_ms: durationMs },
    undefined, undefined, undefined,
    // ADR-115: медиа-частей ответа в отладочном прогоне нет.
    undefined,
    // Anthropic: подпись thinking-блока и блоки reasoning — не передаются.
    undefined,
    undefined,
    // ADR-118 §1/§5: ход, шаг и статус сообщения.
    { turnId, stepIndex: 0, status: 'completed', messageId: stepMessageId },
  );

  const updatedSession = await deps.sessionManager.getSession(session.id);

  const chunkStats = streamTiming.snapshot();
  // ADR-118 §4: `stream.done` удалён — шаг закрывает `step.finished`, ход —
  // `turn.finished`.
  publishStepFinished(publishChunk, {
    turnId,
    stepIndex: 0,
    messageId: stepMessageId,
    status: 'completed',
    usage: finalUsage,
    provider: providerName,
    ...(finalModel ? { model: finalModel } : {}),
    ...(messageCost ? { costUsd: messageCost.costUsd, costCurrency: messageCost.currency } : {}),
    agentRole: 'debug',
    timings: chunkStats,
  });
  publishTurnFinished(publishChunk, { turnId, status: 'completed' });

  deps.cancellationTokens.delete(streamId);
  return {};
}

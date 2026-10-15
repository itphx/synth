/**
 * ADR-095 (шаг 6a): обработка debug-системного сообщения (ADR-070 §2.6).
 *
 * Вынесено из `engine/orchestrator.ts` без изменения поведения. Класс
 * `ChatOrchestrator` сохраняет делегацию `_handleDebugSystemMessage`.
 */
import type { Message, ReasoningLevel, Session, TokenUsage } from '@itphx/synth-shared';
import { MessageRole } from '@itphx/synth-shared';
import type { BaseProvider, CancellationToken } from '../../providers/base.js';
import type { DebugCollector } from '../../debug.js';
import type { SessionManager } from '../../sessions/manager.js';
import type { UsageCost } from '../../providers/usage.js';
import { t as sm } from '../system-messages.js';
import { warning } from '../../logger.js';
import type { SaveAssistantMessageFn } from './persistence.js';
import type { LlmFailureContext } from './errors.js';

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

      publishChunk('stream.chunk', {
        stream_id: streamId,
        content: chunk.isFinal ? '' : chunk.content,
        reasoning: chunk.reasoning,
        is_final: chunk.isFinal,
        agent_role: 'debug',
        model: finalModel,
        provider: providerName,
      });
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
  );

  const updatedSession = await deps.sessionManager.getSession(session.id);

  publishChunk('stream.done', {
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
    metadata: { type: 'debug_system_message' },
  });

  deps.cancellationTokens.delete(streamId);
  return {};
}

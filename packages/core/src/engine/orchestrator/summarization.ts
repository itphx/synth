/**
 * ADR-095 (шаг 6a): суммаризация контекста вручную/по запросу (ADR-070 §2.6).
 *
 * Вынесено из `engine/orchestrator.ts` без изменения поведения. Класс
 * `ChatOrchestrator` сохраняет делегацию `_handleSummarization`.
 */
import type { Message, Session, TokenUsage } from '@itphx/synth-shared';
import { MessageRole, generateId } from '@itphx/synth-shared';
import type { CancellationToken, LLMMessage, SystemPromptPayload } from '../../providers/base.js';
import type { ContextOptimizer } from '../context/optimizer.js';
import type { CompressionMode, CompressionPlan } from '../context/optimizer.js';
import { compressionFinishReasonError, CompressionValidationError, validateCompressionContent } from '../context/optimizer.js';
import { disableCompressedMessages } from './compression.js';
import type { DebugCollector } from '../../debug.js';
import type { SessionManager } from '../../sessions/manager.js';
import type { EventBus } from '../../events/bus.js';
import type { UsageCost } from '../../providers/usage.js';
import { warning } from '../../logger.js';
import type { SaveAssistantMessageFn } from './persistence.js';
import type { LlmFailureContext } from './errors.js';
import { StreamTiming } from './stream-stats.js';
// ADR-119: занятость контекста «прямо сейчас» — тот же счётчик и то же окно,
// что у триггера сжатия и у индикатора в UI.
import { computeContextUsage } from '../context/context-usage.js';
// ADR-118 §4: суммаризация — ход из одного шага (вызов LLM).
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
  // T14: тайминги стрима (`seq`/`t_ms` у чанков, сводка в `stream.done`).
  const streamTiming = new StreamTiming(startedAt);
  const lang = session.settings.language || 'ru';

  let plan: CompressionPlan;

  try {
    // Новый движок: единый план сжатия (профиль — по `contextOptimization`).
    // Легаси-мок/старая реализация оптимизатора без `prepareCompression` —
    // тонкий адаптер над `prepareSummarizationForOrchestrator`.
    if (typeof deps.optimizer.prepareCompression === 'function') {
      // NIT: `metadata.mode` из system-сообщения очереди — приоритетный профиль
      // (эффективный режим на момент постановки), валидируем значение.
      const requestedMode = message.metadata?.mode;
      const modeOpt: { mode?: CompressionMode } = requestedMode === 'summarization'
        || requestedMode === 'compaction'
        ? { mode: requestedMode }
        : {};
      plan = deps.optimizer.prepareCompression(session, lang, modeOpt);
    } else {
      const legacy = deps.optimizer.prepareSummarizationForOrchestrator(session, lang);
      plan = {
        mode: 'summarization',
        provider: legacy.provider,
        llmMessages: legacy.llmMessages,
        systemPrompt: legacy.summarizerPrompt,
        messagesToCompress: legacy.messagesToSummarize,
        coveredIndices: legacy.indices,
        keepFromIndex: -1,
        keepMessages: [],
      };
    }
  } catch (e) {
    return { error: String(e), errorType: 'summarization_prep_failed', canRetry: false };
  }

  const mode: CompressionMode = plan.mode;
  const provider = plan.provider;
  const providerName = (message.provider as string) || session.settings.provider || '';

  debugCollector.captureSessionInfo(session.id, provider.model, providerName, {
    provider_type: provider.type,
    debug_enabled: session.settings.debugEnabled,
    context_optimization: mode,
  });

  // Стрим от LLM суммаризатора
  let accumulatedContent = '';
  let accumulatedReasoning = '';
  let finalUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  let finalModel: string | undefined;
  let finalFinishReason: import('@itphx/synth-shared').LlmFinishReason | undefined;
  // ADR-118 §1: суммаризация — ход из одного шага.
  const turnId = `turn_${streamId}`;
  const stepMessageId = generateId();
  let publishedReasoning: string | undefined;
  publishTurnStarted(publishChunk, { turnId, messageId: message.id });
  // ADR-119: `kind: 'compression'` — служебный шаг сжатия (не ответ агента:
  // его usage — расход вызова сжатия, а не занятость контекстного окна).
  publishStepStarted(publishChunk, {
    turnId,
    stepIndex: 0,
    messageId: stepMessageId,
    kind: 'compression',
  });

  const cancelToken: CancellationToken = {
    cancelled: false,
    cancel: () => { cancelToken.cancelled = true; },
  };
  deps.cancellationTokens.set(streamId, cancelToken);

  signal.addEventListener('abort', () => cancelToken.cancel(), { once: true });

  try {
    for await (const chunk of provider.chatAsync(plan.llmMessages, plan.systemPrompt, undefined, debugCollector, cancelToken)) {
      if (cancelToken.cancelled) break;
      if (chunk.isFinal) accumulatedContent = chunk.content;
      else accumulatedContent += chunk.content;
      if (chunk.usage) finalUsage = chunk.usage;
      if (chunk.model) finalModel = chunk.model;
      if (chunk.reasoning) accumulatedReasoning = chunk.reasoning;
      if (chunk.finishReason) finalFinishReason = chunk.finishReason;

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
    warning('ORCHESTRATOR', `Summarization stream error: ${e}`);
    deps.cancellationTokens.delete(streamId);
    return deps.handleLlmFailure(session.id, streamId, e, attempt, {
      durationMs: Date.now() - startedAt,
      usage: finalUsage,
      model: finalModel ?? provider.model ?? session.settings.model,
      providerName,
      agentRole: 'summary',
      content: accumulatedContent,
      promptChars: deps.estimatePromptChars(plan.llmMessages, plan.systemPrompt),
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
      kind: 'compression',
      provider: providerName,
      agentRole: 'summary',
    });
    publishTurnFinished(publishChunk, { turnId, status: 'cancelled' });
    deps.cancellationTokens.delete(streamId);
    return {};
  }

  // Валидация ответа сжатия: непустое резюме (≥20 символов) / обязательный
  // шаблон компактизации. При провале — один непотоковый повтор **без**
  // внутреннего nudge (иначе одна попытка = три LLM-вызова).
  const finishError = compressionFinishReasonError(mode, finalFinishReason);
  let validationError = finishError;
  // Объект ошибки повторного вызова: нужен, чтобы отличить провал валидации
  // (`CompressionValidationError`) от сетевой/провайдерской ошибки.
  let retryError: unknown = null;
  if (!validationError) {
    const validation = validateCompressionContent(mode, accumulatedContent);
    if (!validation.ok) {
      try {
        const retry = await deps.optimizer.completeCompression(plan, { nudge: false });
        accumulatedContent = retry.content;
        if (retry.response.usage) finalUsage = retry.response.usage;
        if (retry.response.model) finalModel = retry.response.model;
        // m7: клиент уже получил дельты первого (невалидного) ответа —
        // публикуем полную текстовую часть, чтобы лента совпала с историей.
        publishPartUpdated(publishChunk, {
          messageId: stepMessageId,
          partId: textPartId(0),
          part: { id: textPartId(0), type: 'text', data: retry.content },
        });
      } catch (e) {
        validationError = String(e);
        retryError = e;
      }
    }
  }
  if (validationError) {
    warning('ORCHESTRATOR', `Compression validation failed (${mode}): ${validationError}`);
    publishStepFinished(publishChunk, {
      turnId,
      stepIndex: 0,
      messageId: stepMessageId,
      status: 'error',
      kind: 'compression',
      provider: providerName,
      agentRole: 'summary',
    });
    publishTurnFinished(publishChunk, { turnId, status: 'error' });
    deps.cancellationTokens.delete(streamId);
    // Провал **валидации** (шаблон/длина/finish-reason) — модель ответила не
    // тем: повтор того же ответа не поможет. Cooldown + `errorType:
    // 'validation'` (в UNRECOVERABLE_TYPES → очередь не ретраит служебное
    // сообщение суммаризации).
    const isValidationFailure = finishError !== null
      || retryError instanceof CompressionValidationError;
    if (isValidationFailure) {
      if (typeof deps.optimizer.noteCompressionFailure === 'function') {
        deps.optimizer.noteCompressionFailure(session.id);
      }
      return deps.handleLlmFailure(session.id, streamId, new Error(validationError), attempt, {
        durationMs: Date.now() - startedAt,
        usage: finalUsage,
        model: finalModel ?? provider.model ?? session.settings.model,
        providerName,
        agentRole: 'summary',
        content: accumulatedContent,
        promptChars: deps.estimatePromptChars(plan.llmMessages, plan.systemPrompt),
        errorType: 'validation',
      });
    }
    // Сетевая/провайдерская ошибка повторного вызова — обычная классификация
    // (`canRetry` по errorType), без cooldown: сжатие «не помогло» — не факт.
    return deps.handleLlmFailure(
      session.id,
      streamId,
      retryError instanceof Error ? retryError : new Error(validationError),
      attempt,
      {
        durationMs: Date.now() - startedAt,
        usage: finalUsage,
        model: finalModel ?? provider.model ?? session.settings.model,
        providerName,
        agentRole: 'summary',
        content: accumulatedContent,
        promptChars: deps.estimatePromptChars(plan.llmMessages, plan.systemPrompt),
      },
    );
  }

  // Сохранить summary-сообщение (без message.added — UI получит его через stream.done)
  const durationMs = Date.now() - startedAt;
  const messageCost = deps.computeMessageCost(finalModel, finalUsage);
  await deps.saveAssistantMessage(
    session.id, accumulatedContent, streamId, 'summary',
    finalUsage, finalModel, accumulatedReasoning, debugCollector, false, providerName,
    MessageRole.SUMMARY, plan.coveredIndices, true,
    undefined, undefined, undefined, undefined,
    {
      duration_ms: durationMs,
      type: 'auto_summary',
      mode,
      ...(plan.keepFromId ? { keepFrom: plan.keepFromId } : {}),
    },
    undefined, undefined, undefined,
    // ADR-115: медиа-частей ответа в суммаризации нет.
    undefined,
    // Anthropic: подпись thinking-блока и блоки reasoning — не передаются.
    undefined,
    undefined,
    // ADR-118 §1/§5: ход, шаг и статус сообщения.
    { turnId, stepIndex: 0, status: 'completed', messageId: stepMessageId },
  );

  // Отключить только покрытые сообщения (pinned и хвост не трогаем).
  await disableCompressedMessages(deps, session.id, plan);

  // ADR-119: снимок сессии ПОСЛЕ сжатия — оценка занятости контекста должна
  // учитывать отключённые покрытые сообщения, иначе индикатор «залипнет» на
  // до-сжатом уровне.
  const updatedSession = await deps.sessionManager.getSession(session.id);
  const contextUsage = computeContextUsage(deps.optimizer, updatedSession ?? session);

  // Прогресс-гард: сжатие обязано снять порог триггера. Если порог остался —
  // сжатие не помогло: включаем cooldown (следующий авто-триггер не зовёт
  // LLM) и помечаем это в событии. Cooldown игнорируем: иначе активный
  // cooldown маскировал бы «сжатие не помогло».
  const insufficient = updatedSession !== null
    && typeof deps.optimizer.shouldCompress === 'function'
    && deps.optimizer.shouldCompress(updatedSession, { ignoreCooldown: true }).triggered;
  if (insufficient) {
    if (typeof deps.optimizer.noteCompressionFailure === 'function') {
      deps.optimizer.noteCompressionFailure(session.id);
    }
  } else if (typeof deps.optimizer.clearCompressionFailure === 'function') {
    deps.optimizer.clearCompressionFailure(session.id);
  }

  // UI перечитывает историю: сжатие применено (не только overflow-путь).
  const rawReason = message.metadata?.reason;
  const appliedReason = rawReason === 'manual' ? 'manual' : 'auto';
  deps.eventBus.publish(session.id, 'context.summarization_applied', {
    session_id: session.id,
    reason: appliedReason,
    mode,
    covered_indices: plan.coveredIndices,
    keep_from: plan.keepFromId ?? null,
    ...(finalUsage ? { usage: finalUsage } : {}),
    /**
     * ADR-119: занятость контекста ПОСЛЕ сжатия (аддитивно). `usage` выше —
     * расход вызова сжатия, а не занятость окна: UI обновляет индикатор по
     * `context_tokens`/`context_limit`, не дожидаясь перечитывания истории.
     */
    context_tokens: contextUsage.tokens,
    context_limit: contextUsage.limit,
    /**
     * Аддитивно: сжатие применилось, но порог триггера не снят — контекст
     * по-прежнему переполнен. UI может показать, что сжатие не помогло.
     */
    ...(insufficient ? { insufficient: true } : {}),
  });

  const chunkStats = streamTiming.snapshot();
  // ADR-118 §4: `stream.done` удалён — шаг закрывает `step.finished`, ход —
  // `turn.finished`.
  publishStepFinished(publishChunk, {
    turnId,
    stepIndex: 0,
    messageId: stepMessageId,
    status: 'completed',
    kind: 'compression',
    usage: finalUsage,
    provider: providerName,
    ...(finalModel ? { model: finalModel } : {}),
    ...(messageCost ? { costUsd: messageCost.costUsd, costCurrency: messageCost.currency } : {}),
    agentRole: 'summary',
    timings: chunkStats,
  });
  publishTurnFinished(publishChunk, { turnId, status: 'completed' });

  // Обновить canSummarize
  if (updatedSession) {
    await deps.sessionManager.withLock(session.id, async (s) => {
      s.canSummarize = deps.optimizer!.canSummarize(s);
      await deps.sessionManager.saveSession(s);
    });

    const freshSession = await deps.sessionManager.getSession(session.id);

    deps.eventBus.publish(session.id, 'session.updated', {
      session_id: session.id,
      mode,
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

/**
 * ADR-095 (шаг 6b-1): эпилог `_processMessage` — финализация хода после цикла
 * Tool Use: ветка отмены до финального сохранения, подстановка фоллбек-текстов,
 * quality-check/escalation (ADR-034), персистентность tool-chain, сохранение
 * финального сообщения, `stream.done`, авто-тайтл и триггеры оптимизации
 * контекста.
 *
 * Вынесено из `engine/orchestrator.ts` без изменения поведения: порядок
 * side-effect'ов, условия, тексты и события сохранены дословно. Внутренние
 * `this._X` заменены явными зависимостями (`ProcessFinalizeDeps`); состояние
 * цикла передаётся объектом (`ProcessFinalizeState`). Функция всегда
 * возвращает `{}` — как и прежний код в этой точке.
 */
import type { PromptMeta, ReasoningLevel, Session, TokenUsage } from '@itphx/synth-shared';
import { MessageRole } from '@itphx/synth-shared';
import type { DebugCollector } from '../../../debug.js';
import type { SessionManager } from '../../../sessions/manager.js';
import type { EventBus } from '../../../events/bus.js';
import type { BaseProvider, LLMMessage, SystemPromptPayload } from '../../../providers/base.js';
import type { UsageCost } from '../../../providers/usage.js';
import type { AgentRegistry } from '../../agents/registry.js';
import type { ContextOptimizer } from '../../context/optimizer.js';
import type { ModelRouter, RoutingDecision } from '../../router/router.js';
import type { SaveAssistantMessageFn, AssistantMessageStatus } from '../persistence.js';
import { autoTitleSession } from '../../../sessions/auto-title.js';
import { warning } from '../../../logger.js';
import { t as sm, i18n as i18nMeta } from '../../system-messages.js';

/** Результат эпилога `_processMessage` (структурно = `ProcessMessageResult`). */
export interface ProcessFinalizeResult {
  error?: string;
  errorType?: string;
  canRetry?: boolean;
}

/** Аргументы эпилога, не зависящие от состояния цикла. */
export interface ProcessFinalizeArgs {
  session: Session;
  streamId: string;
  publishChunk: (event: string, data: Record<string, unknown>) => void;
  debugCollector: DebugCollector;
  /** ADR-070 §2.6: старт прогона (для `duration_ms`). */
  streamStartedAt: number;
}

/**
 * Состояние, накопленное циклом Tool Use и необходимое эпилогу. Скалярные
 * значения читаются здесь и больше в вызывающий код не возвращаются —
 * финализация завершает ход.
 */
export interface ProcessFinalizeState {
  cancelledBeforeFinal: boolean;
  lastChunkModel: string | undefined;
  finalModel: string | undefined;
  finalUsage: TokenUsage;
  finalContent: string;
  /** metadata.i18n подставленного финального фоллбека (лимит/deny/пустой ответ). */
  fallbackI18n: ReturnType<typeof i18nMeta> | undefined;
  /** Были ли deny-отказы за цикл (для осмысленного fallback пустого ответа). */
  hadDeny: boolean;
  stopAfterDeny: boolean;
  denyStopReason: string | undefined;
  toolIteration: number;
  maxIterations: number;
  lastIterationPromptChars: number;
  allReasoning: Array<{ text: string; iteration: number }>;
  allIntermediateTexts: Array<{ text: string; iteration: number }>;
  allToolCalls: Array<Record<string, unknown>>;
  allRawToolCalls: Array<{ iteration: number; calls: Record<string, unknown>[] }>;
  currentMessages: LLMMessage[];
  promptMeta: PromptMeta;
  loadedTokenRatio: number | undefined;
  routingDecision: RoutingDecision | undefined;
  provider: BaseProvider;
  finalSystemPrompt: SystemPromptPayload;
  providerName: string;
  effectiveAgentRole: string | undefined;
  effectiveReasoningLevel: ReasoningLevel | undefined;
}

/** Зависимости эпилога `_processMessage`. */
export interface ProcessFinalizeDeps {
  sessionManager: SessionManager;
  eventBus: EventBus;
  router: ModelRouter | null;
  agentRegistry: AgentRegistry | null;
  optimizer: ContextOptimizer | null;
  resolveMessageModel: (
    chunkModel: string | undefined,
    finalModel: string | undefined,
    provider: BaseProvider | undefined,
    session: Session,
  ) => string | undefined;
  persistToolChain: (
    sessionId: string,
    streamId: string,
    providerName: string,
    agentRole: string | undefined,
    finalModel: string | undefined,
    allRawToolCalls: Array<{ iteration: number; calls: Record<string, unknown>[] }>,
    allToolCalls: Array<Record<string, unknown>>,
    allIntermediateTexts: Array<{ text: string; iteration: number }>,
    allReasoning: Array<{ text: string; iteration: number }>,
  ) => Promise<void>;
  joinAccumulatedTexts: (
    intermediateTexts: Array<{ text: string; iteration: number }>,
    current: string,
  ) => string;
  estimateUsage: (
    usage: TokenUsage | undefined,
    promptChars: number,
    outputChars: number,
  ) => { usage: TokenUsage; estimated: boolean };
  computeMessageCost: (model: string | undefined, usage: TokenUsage | undefined) => UsageCost | null;
  saveAssistantMessage: SaveAssistantMessageFn;
  resolveAssistantStatus: (
    isCancelled: boolean,
    metadataExtra?: Record<string, unknown>,
  ) => AssistantMessageStatus;
  getAssistantSecrets: (sessionId: string, content: string) => Promise<Record<string, string>>;
  calibrateTokenRatio: (
    model: string | undefined,
    promptChars: number,
    usage: TokenUsage | undefined,
    currentRatio: number | undefined,
  ) => Promise<void>;
  getProvider: (providerName: string, session: Session, reasoningLevel?: ReasoningLevel) => BaseProvider | null;
  unregister: (streamId: string) => void;
}

/** Финализация хода: завершение как отмена, quality-check, персист, `stream.done`. */
export async function runProcessFinalize(
  args: ProcessFinalizeArgs,
  state: ProcessFinalizeState,
  deps: ProcessFinalizeDeps,
): Promise<ProcessFinalizeResult> {
  const { session, streamId, publishChunk, debugCollector, streamStartedAt } = args;
  const {
    cancelledBeforeFinal, lastChunkModel, provider, providerName, effectiveAgentRole,
    allRawToolCalls, allToolCalls, allIntermediateTexts, allReasoning,
    lastIterationPromptChars, promptMeta, toolIteration, maxIterations,
    stopAfterDeny, denyStopReason, hadDeny, routingDecision, effectiveReasoningLevel,
    currentMessages, loadedTokenRatio, finalSystemPrompt,
  } = state;
  let { finalContent, finalModel, finalUsage, fallbackI18n } = state;

  // Отмена до финального сохранения (во время исполнения тула или до входа
  // в итерацию): завершаем ровно как ветку отмены (persist tool-chain +
  // stream.cancelled), а не как обычное завершение с подставленным
  // «Не удалось выполнить запрос: ответ модели пуст».
  if (cancelledBeforeFinal) {
    // Bug 2: при отмене модель могла не прийти ни в одном финальном чанке —
    // fallback на provider.model/session.settings.model для cost.
    const cancelModel = deps.resolveMessageModel(lastChunkModel, finalModel, provider, session);

    await deps.persistToolChain(
      session.id, streamId, providerName, effectiveAgentRole,
      cancelModel,
      allRawToolCalls, allToolCalls, allIntermediateTexts, allReasoning,
    );

    const partialContent = deps.joinAccumulatedTexts(allIntermediateTexts, '');

    // Bug 3/4: usage/duration/cost в событии отмены + best-effort оценка
    // usage (metadata.usage_estimated) при пустом usage.
    const cancelDurationMs = Date.now() - streamStartedAt;
    const cancelEstimated = deps.estimateUsage(
      finalUsage,
      lastIterationPromptChars,
      partialContent.length,
    );
    const cancelCost = deps.computeMessageCost(cancelModel, cancelEstimated.usage);

    // Промежуточные тексты уже вошли в partialContent — как в ветке отмены
    // выше, НЕ дублируем их в metadata.intermediate_text_blocks.
    // Сообщение сохраняем всегда (в т.ч. при пустом контенте) — статус и
    // статистика отмены не должны теряться.
    await deps.saveAssistantMessage(
      session.id, partialContent, streamId, effectiveAgentRole,
      cancelEstimated.usage, cancelModel, allReasoning.map((r) => r.text).join('\n\n---\n\n'), debugCollector, true, providerName,
      MessageRole.ASSISTANT, undefined, false, allToolCalls, undefined,
      undefined, undefined,
      {
        duration_ms: cancelDurationMs,
        ...(cancelEstimated.estimated ? { usage_estimated: true } : {}),
      },
      promptMeta,
      cancelCost,
    );

    publishChunk('stream.cancelled', {
      stream_id: streamId,
      content: partialContent,
      status: 'cancelled',
      model: cancelModel,
      provider: providerName,
      usage: cancelEstimated.usage,
      duration_ms: cancelDurationMs,
      ...(cancelCost ? { cost_usd: cancelCost.costUsd, cost_currency: cancelCost.currency } : {}),
      ...(cancelEstimated.estimated ? { usage_estimated: true } : {}),
    });

    deps.unregister(streamId);
    return {};
  }

  // 7. Handle max iterations exceeded
  if (toolIteration >= maxIterations && !finalContent) {
    finalContent = sm('session.max_iterations');
    fallbackI18n = i18nMeta('session.max_iterations');
  }

  // ADR-029: пользователь отклонил ask — обработка завершена. Фиксируем
  // причину в финальном сообщении (история tool_result уже собрана).
  if (stopAfterDeny && !finalContent) {
    const reason = denyStopReason ?? sm('session.stopped_reason_denied');
    finalContent = sm('session.stopped', { reason });
    fallbackI18n = i18nMeta('session.stopped', { reason });
  }

  // Защита от пустого финального ответа: если цикл завершился (в т.ч.
  // через doom loop / лимит итераций / модель вернула пустой контент)
  // с пустым finalContent — подставляем осмысленное сообщение, чтобы
  // в истории не оставалось пустого assistant-сообщения.
  if (!finalContent) {
    finalContent = hadDeny
      ? sm('session.denied_blocked')
      : sm('session.empty_response');
    fallbackI18n = i18nMeta(hadDeny ? 'session.denied_blocked' : 'session.empty_response');
  }

  // 7.5. Quality check + escalation (ADR-034)
  let qaPass: boolean | undefined;
  let qaReason: string | undefined;
  const escalation = deps.router?.getEscalationConfig();
  if (deps.router && escalation?.enabled && routingDecision && finalContent) {
    const qaResult = await deps.router.checkQuality(finalContent, routingDecision, session.settings);
    if (!qaResult.pass) {
      qaPass = false;
      qaReason = qaResult.reason;

      // Эскалация на fallback-модель
      const sessionEscalation = session.settings.routingEscalation;
      const fallbackProvider = sessionEscalation?.fallbackProvider || escalation.fallbackProvider;
      const fallbackModel = sessionEscalation?.fallbackModel || escalation.fallbackModel;
      if (fallbackProvider && fallbackModel) {
        const fbDecision: RoutingDecision = {
          providerName: fallbackProvider,
          modelName: fallbackModel,
          reason: 'escalation_fallback',
          strategy: 'default',
        };
        const fbProvider = deps.router.getProvider(fbDecision, undefined, effectiveReasoningLevel);
        if (fbProvider) {
          // Перевызываем LLM с fallback-моделью (без стриминга в UI)
          try {
            const fbMessages = [
              ...currentMessages.filter(
                (m) => m.role !== 'assistant' || m.toolUse === undefined || m.toolUse.length === 0,
              ),
            ];
            const fbResponse = await fbProvider.chat(fbMessages, finalSystemPrompt, undefined, false);
            if (fbResponse.content) {
              finalContent = fbResponse.content;
              qaPass = true;
              qaReason = sm('router.escalation', { provider: fallbackProvider, model: fallbackModel, reason: qaResult.reason });
              if (fbResponse.usage) finalUsage = fbResponse.usage;
              if (fbResponse.model) finalModel = fbResponse.model;
            }
          } catch (fbErr) {
            warning('ORCHESTRATOR', `Fallback LLM call failed: ${fbErr}`);
          }
        } else {
          warning('ORCHESTRATOR', `Fallback provider/model not found: ${fallbackProvider}/${fallbackModel}`);
        }
      }
    } else {
      qaPass = true;
      qaReason = qaResult.reason;
    }

    // Публикуем событие quality check
    if (qaPass !== undefined) {
      const sessionAfterMsg = await deps.sessionManager.getSession(session.id);
      const msgIndex = sessionAfterMsg
        ? sessionAfterMsg.messages.length
        : session.messages.length;
      deps.eventBus.publish(session.id, 'message.quality_check', {
        qa_pass: qaPass,
        qa_reason: qaReason,
        message_index: msgIndex,
      });
    }
  }

  // 7.8. Персистентность tool-chain (Вариант B): настоящие пары
  // «assistant с toolCalls + tool-результаты» в session.messages, чтобы
  // _sessionMessagesToLlm на следующем запросе выдавал OpenAI-совместимый
  // диалог. Промежуточные сообщения помечаются metadata.tool_chain=true —
  // UI их скрывает (визуализация уже есть в финальном сообщении).
  await deps.persistToolChain(
    session.id, streamId, providerName, effectiveAgentRole, finalModel,
    allRawToolCalls, allToolCalls, allIntermediateTexts, allReasoning,
  );

  // 8. Save final assistant message
  // ADR-070 §2.6: полная длительность прогона (включая tool-chain) и
  // стоимость по цене модели — в metadata финального сообщения и stream.done.
  const durationMs = Date.now() - streamStartedAt;
  const messageCost = deps.computeMessageCost(finalModel, finalUsage);
  const reasoningJoined = allReasoning.map((r) => r.text).join('\n\n---\n\n');
  const savedContent = await deps.saveAssistantMessage(
    session.id, finalContent, streamId, effectiveAgentRole,
    finalUsage, finalModel, reasoningJoined, debugCollector, false, providerName,
    MessageRole.ASSISTANT, undefined, false, allToolCalls, allIntermediateTexts,
    qaPass, qaReason,
    { ...(fallbackI18n ? { i18n: fallbackI18n } : {}), duration_ms: durationMs },
    promptMeta,
    messageCost,
  );

  // ADR-071 §2.6: калибровка chars-per-token по факту (promptChars / inputTokens)
  // после успешного хода. promptChars — тот же расчёт, что уходил в провайдер
  // (последняя итерация), ratio — уже загруженный в этом ходе.
  await deps.calibrateTokenRatio(
    finalModel,
    lastIterationPromptChars,
    finalUsage,
    loadedTokenRatio,
  );

  // Получаем актуальную сессию после сохранения
  const updatedSession = await deps.sessionManager.getSession(session.id);

  const doneData: Record<string, unknown> = {
    stream_id: streamId,
    content: savedContent,
    message_index: (updatedSession?.messages.length ?? session.messages.length + 1) - 1,
    pending_count: Math.max(0, (updatedSession?.pendingMessages.length ?? 1) - 1),
    model: finalModel,
    provider: providerName,
    usage: finalUsage,
    duration_ms: durationMs,
    status: deps.resolveAssistantStatus(false, fallbackI18n ? { i18n: fallbackI18n } : undefined),
    ...(messageCost ? { cost_usd: messageCost.costUsd, cost_currency: messageCost.currency } : {}),
    reasoning_blocks: allReasoning.length > 0 ? allReasoning : undefined,
    intermediate_text_blocks: allIntermediateTexts.length > 0 ? allIntermediateTexts : undefined,
  };

  // ADR-036: проброс secrets в real-time событие — UI раскрывает плейсхолдеры
  // без перезагрузки списка сообщений (см. transportStore/chatStore).
  if (finalContent) {
    const secrets = await deps.getAssistantSecrets(session.id, savedContent);
    if (Object.keys(secrets).length > 0) {
      doneData.metadata = { secrets };
    }
  }

  if (stopAfterDeny) {
    doneData.stopped_by_deny = true;
    doneData.deny_reason = denyStopReason;
  }

  const debugInfo = debugCollector.getDebugInfo();
  if (debugInfo) {
    doneData.debug_info = debugInfo;
  }

  publishChunk('stream.done', doneData);

  // 8.5. Auto-rename session on first exchange
  if (updatedSession) {
    const userMsgCount = updatedSession.messages.filter(
      (m) => m.role === MessageRole.USER && !m.metadata?.synthetic && !m.ephemeral,
    ).length;
    if (userMsgCount === 1) {
      const titleAgentDef = deps.agentRegistry?.get('title');
      let titleProvider = provider;
      if (titleAgentDef?.reasoningLevel && providerName) {
        const tp = deps.getProvider(providerName, updatedSession, titleAgentDef.reasoningLevel);
        if (tp) titleProvider = tp;
      }
      autoTitleSession(updatedSession, deps.sessionManager, titleProvider)
        .then((title) => {
          if (title) {
            deps.eventBus.publish(updatedSession.id, 'session.updated', {
              session_id: updatedSession.id,
              name: title,
            });
          }
        })
        .catch(() => {});
    }
  }

  // 9. Check context optimization triggers
  if (deps.optimizer && updatedSession) {
    const optSession = updatedSession;

    // Проверить скользящее окно
    if (optSession.settings.contextOptimization === 'sliding_window') {
      const swResult = deps.optimizer.shouldApplySlidingWindow(optSession);
      if (swResult.triggered) {
        let disabledIndices: number[] = [];
        await deps.sessionManager.withLock(optSession.id, async (s) => {
          const applied = deps.optimizer!.applySlidingWindow(s);
          disabledIndices = applied.disabledIndices;
          await deps.sessionManager.saveSession(s);
        });
        deps.eventBus.publish(optSession.id, 'context.sliding_window_applied', {
          reason: swResult.reason,
          trigger_type: swResult.reason,
          disabled_indices: disabledIndices,
        });
      }
    }

    // Проверить суммаризацию
    if (optSession.settings.contextOptimization === 'summarization') {
      const sumResult = deps.optimizer.shouldSummarize(optSession);
      if (sumResult.triggered) {
        await deps.sessionManager.withLock(optSession.id, async (s) => {
          s.summarizationPending = true;
          await deps.sessionManager.saveSession(s);
        });
        deps.eventBus.publish(optSession.id, 'context.summarization_pending', {
          reason: sumResult.reason,
          current_tokens: sumResult.currentTokens,
          threshold: sumResult.threshold,
          user_count: sumResult.userCount,
        });
      }
    }

    // Обновить canSummarize после всех мутаций
    await deps.sessionManager.withLock(optSession.id, async (s) => {
      s.canSummarize = deps.optimizer!.canSummarize(s);
      await deps.sessionManager.saveSession(s);
    });

    // Уведомить UI об изменении сессии
    const updatedSession2 = await deps.sessionManager.getSession(optSession.id);
    if (updatedSession2) {
      deps.eventBus.publish(optSession.id, 'session.updated', {
        session_id: optSession.id,
        can_summarize: updatedSession2.canSummarize,
        input_tokens: updatedSession2.inputTokens,
        output_tokens: updatedSession2.outputTokens,
        total_tokens: updatedSession2.totalTokens,
        cache_read_tokens: updatedSession2.cacheReadTokens,
        cache_write_tokens: updatedSession2.cacheWriteTokens,
        reasoning_tokens: updatedSession2.reasoningTokens,
        cache_hit_rate: updatedSession2.cacheHitRate ?? 0,
        input_cost: updatedSession2.inputCost,
        output_cost: updatedSession2.outputCost,
        cache_read_cost: updatedSession2.cacheReadCost,
        cache_write_cost: updatedSession2.cacheWriteCost,
      });
    }
  }

  deps.unregister(streamId);
  return {};
}

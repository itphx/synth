/**
 * ADR-095 (шаг 6b-1): эпилог `_processMessage` — финализация хода после цикла
 * Tool Use: ветка отмены до финального сохранения, подстановка фоллбек-текстов,
 * quality-check/escalation (ADR-034), сохранение финального сообщения,
 * `stream.done`, авто-тайтл и триггеры оптимизации контекста. Tool-chain
 * персистится пошагово в цикле (шаг 2а), не здесь.
 *
 * Вынесено из `engine/orchestrator.ts` без изменения поведения: порядок
 * side-effect'ов, условия, тексты и события сохранены дословно. Внутренние
 * `this._X` заменены явными зависимостями (`ProcessFinalizeDeps`); состояние
 * цикла передаётся объектом (`ProcessFinalizeState`). Функция всегда
 * возвращает `{}` — как и прежний код в этой точке.
 */
import type {
  MediaPartData,
  Message,
  Part,
  PromptMeta,
  ReasoningLevel,
  Session,
  TokenUsage,
} from '@itphx/synth-shared';
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
import type { ProviderOverrides } from '../routing.js';
import { autoTitleSession } from '../../../sessions/auto-title.js';
import { warning } from '../../../logger.js';
import { t as sm, i18n as i18nMeta } from '../../system-messages.js';
import { dropSteerInjections, isBackgroundNoticeMessage } from '../../steering/apply.js';
import type { StreamTiming } from '../stream-stats.js';

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
  /**
   * T14: тайминги чанков хода (`seq`/`t_ms` в `stream.chunk`) — в `stream.done`
   * уходят сводкой `chunks`/`first_chunk_ms`/`last_chunk_ms`. Не передан —
   * аддитивных полей нет (локальные ответы/прежние вызовы).
   */
  streamTiming?: StreamTiming;
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
  /**
   * Был ли отказ **ролевой** (`matchedRule: 'role.unavailable'`): тул недоступен
   * текущему агенту (ADR-070 §2.9.1). Приоритетнее `hadDeny` в фоллбек-тексте —
   * это не инцидент ИБ, а подсказка делегировать задачу через `@`.
   * Опционально — обратная совместимость с прежними вызовами.
   */
  roleBlocked?: boolean;
  roleBlockedTool?: string;
  roleBlockedAgent?: string;
  toolIteration: number;
  maxIterations: number;
  /**
   * Шаг-лимит (`AgentDefinition.maxSteps`) действительно исполнялся: в запросе
   * был синтетический assistant-префилл с требованием «только текст». Эпилог
   * подставляет отчёт `session.steps_limit` и `metadata.step_limit_reached`.
   * Не задано (прежние вызовы/лимит не наступил) — прежнее поведение.
   */
  stepLimitExecuted?: boolean;
  lastIterationPromptChars: number;
  allReasoning: Array<{ text: string; iteration: number }>;
  allIntermediateTexts: Array<{ text: string; iteration: number }>;
  allToolCalls: Array<Record<string, unknown>>;
  currentMessages: LLMMessage[];
  promptMeta: PromptMeta;
  loadedTokenRatio: number | undefined;
  routingDecision: RoutingDecision | undefined;
  provider: BaseProvider;
  finalSystemPrompt: SystemPromptPayload;
  providerName: string;
  effectiveAgentRole: string | undefined;
  effectiveReasoningLevel: ReasoningLevel | undefined;
  /**
   * Шаг 2б: черновик последней незавершённой итерации (без toolCalls). Если
   * задан — финальное/отменённое сообщение обновляет его, а не добавляет
   * второй assistant в историю. `null` — чанков не было или итерация
   * завершилась tool_chain-сообщением.
   */
  currentDraft?: { id: string; seq: number } | null;
  /**
   * ADR-115 (outbound): медиа-части ответа, накопленные тулом `send_attachment`
   * за ход. Добавляются к **финальному** сообщению (после текста) — оттуда их
   * читает `collectOutboundAttachments` для `stream.done.attachments`.
   * Ветка отмены их не сохраняет (ход не завершён — ничего не отправляем).
   * Не задано/пусто — прежнее поведение.
   */
  outboundParts?: Part[];
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
  getProvider: (
    providerName: string,
    session: Session,
    reasoningLevel?: ReasoningLevel,
    /** Переопределения агента (температура/topP/topK и явная пара provider/model). */
    overrides?: ProviderOverrides,
  ) => BaseProvider | null;
  unregister: (streamId: string) => void;
  /**
   * ADR-111/ADR-113 × ADR-104: вернуть в очередь уведомления фоновых прогонов,
   * оставшиеся в steer-очереди к концу хода (потерять результат нельзя).
   * `opts.autostart` — поднять ли ход: обычное завершение (`turn_ended`) — да,
   * «Стоп» (`aborted`) — нет.
   * Не задан — остаток снимается как прежде (`steer.dropped`).
   */
  requeueBackgroundNotices?: (
    sessionId: string,
    messages: Message[],
    opts: { autostart: boolean },
  ) => Promise<void>;
}

/**
 * ADR-115 (outbound): вложение ответа для внешних каналов — **метаданные**
 * объекта, без байтов. Шлюз (Telegram/VK) забирает байты по sha256
 * (`GET /api/v2/attachments/:sha256`) и не обращается к сессии.
 */
export interface OutboundAttachmentRef {
  /** SHA-256 содержимого (адрес объекта в контуре вложений). */
  sha256: string;
  /** MIME по содержимому. */
  mime: string;
  /** Размер в байтах. */
  size: number;
  /** Имя файла (санитайз), если известно. */
  name?: string;
}

/** Медиа-типы частей сообщения (ADR-115) — кандидаты на outbound-раздачу. */
const OUTBOUND_PART_TYPES: readonly string[] = ['image', 'audio', 'video', 'file'];

/** SHA-256 в шестнадцатеричном виде — адрес объекта вложения. */
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;

/**
 * `Part.data` → ссылка на вложение при строгом совпадении формы.
 *
 * Части приходят из истории (в т.ч. после импорта/PG), поэтому доверять форме
 * нельзя: без `blobPath`/`sha256`/`mime`/`size` часть не считается вложением и
 * в `stream.done` не попадает.
 */
function toOutboundRef(data: unknown): OutboundAttachmentRef | null {
  if (typeof data !== 'object' || data === null) return null;
  const raw = data as Partial<MediaPartData>;
  if (typeof raw.blobPath !== 'string' || raw.blobPath === '') return null;
  if (typeof raw.sha256 !== 'string' || !SHA256_PATTERN.test(raw.sha256)) return null;
  if (typeof raw.mime !== 'string' || raw.mime === '') return null;
  if (typeof raw.size !== 'number' || !Number.isFinite(raw.size) || raw.size < 0) return null;
  return {
    sha256: raw.sha256.toLowerCase(),
    mime: raw.mime,
    size: raw.size,
    ...(typeof raw.name === 'string' && raw.name ? { name: raw.name } : {}),
  };
}

/**
 * Вложения **финального** assistant-сообщения хода (ADR-115, outbound).
 *
 * Источник — сообщение, сохранённое этим же ходом (`metadata.stream_id`), а не
 * вся история: шлюзу нужны вложения **ответа**, а не присланные пользователем.
 * Порядок — как в сообщении; части без валидной формы игнорируются.
 * Промежуточные tool-chain сообщения хода (`metadata.tool_chain`) не считаются.
 */
export function collectOutboundAttachments(
  messages: readonly Message[],
  streamId: string,
): OutboundAttachmentRef[] {
  let finalMessage: Message | undefined;
  for (const message of messages) {
    if (message.role !== MessageRole.ASSISTANT) continue;
    if (message.metadata?.stream_id !== streamId) continue;
    if (message.metadata?.tool_chain === true) continue;
    finalMessage = message;
  }
  if (!finalMessage || !Array.isArray(finalMessage.parts)) return [];

  const found: OutboundAttachmentRef[] = [];
  for (const part of finalMessage.parts) {
    if (!part || typeof part.type !== 'string') continue;
    if (!OUTBOUND_PART_TYPES.includes(part.type)) continue;
    const ref = toOutboundRef(part.data);
    if (ref) found.push(ref);
  }
  return found;
}

/** Финализация хода: завершение как отмена, quality-check, персист, `stream.done`. */
export async function runProcessFinalize(
  args: ProcessFinalizeArgs,
  state: ProcessFinalizeState,
  deps: ProcessFinalizeDeps,
): Promise<ProcessFinalizeResult> {
  const { session, streamId, publishChunk, debugCollector, streamStartedAt, streamTiming } = args;
  const {
    cancelledBeforeFinal, lastChunkModel, provider, providerName, effectiveAgentRole,
    allToolCalls, allIntermediateTexts, allReasoning,
    lastIterationPromptChars, promptMeta, maxIterations,
    hadDeny, routingDecision, effectiveReasoningLevel,
    roleBlocked, roleBlockedTool, roleBlockedAgent,
    currentMessages, loadedTokenRatio, finalSystemPrompt, currentDraft, outboundParts,
  } = state;
  let { finalContent, finalModel, finalUsage, fallbackI18n } = state;
  /** Шаг-лимит реально исполнялся (синтетический assistant-префилл в запросе). */
  const stepLimitReached = state.stepLimitExecuted === true;

  // ADR-104 (решение 2026-10-28): ход заканчивается — снимаем неприменённые
  // инъекции из очереди. Границы шага больше не будет, поэтому сообщение,
  // пришедшее во время последней генерации/финализации, иначе применилось бы
  // в начале следующего хода и выглядело «внезапным отдельным сообщением».
  // Причина `aborted` — ход остановлен «Стопом» (остаток после снятия в роуте),
  // `turn_ended` — обычное завершение. Best-effort: сбой очереди не роняет ход.
  try {
    await dropSteerInjections({
      sessionManager: deps.sessionManager,
      sessionId: session.id,
      reason: cancelledBeforeFinal ? 'aborted' : 'turn_ended',
      streamId,
      publishDropped: (event) => publishChunk('steer.dropped', event),
      // ADR-111/ADR-113: уведомления фоновых прогонов не дропаем — они
      // возвращаются в обычную очередь (ход закончился/остановлен, границы
      // шага уже не будет). Результат фоновой работы терять нельзя.
      ...(deps.requeueBackgroundNotices
        ? {
          isRequeuable: isBackgroundNoticeMessage,
          requeue: (messages: Message[]) =>
            deps.requeueBackgroundNotices!(session.id, messages, {
              autostart: !cancelledBeforeFinal,
            }),
        }
        : {}),
    });
  } catch (err) {
    warning(
      'ORCHESTRATOR',
      `Снятие неприменённых инъекций не удалось: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Отмена до финального сохранения (во время исполнения тула или до входа
  // в итерацию): завершаем ровно как ветку отмены (stream.cancelled), а не
  // как обычное завершение с подставленным «Не удалось выполнить запрос:
  // ответ модели пуст». Завершённые итерации и их tool-результаты уже записаны
  // пошагово (шаг 2а) — повторной персистенции tool-chain нет.
  if (cancelledBeforeFinal) {
    // Bug 2: при отмене модель могла не прийти ни в одном финальном чанке —
    // fallback на provider.model/session.settings.model для cost.
    const cancelModel = deps.resolveMessageModel(lastChunkModel, finalModel, provider, session);

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
      currentDraft ?? undefined,
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

  // 7. Handle step limit reached (механика opencode): отчёт по лимиту шагов —
  // свой текст (паритет с сабагентом `task.steps_limit_empty`), а не
  // «лимит итераций инструментов». Флаг приходит из цикла: только исполненный
  // шаг-лимит даёт такой отчёт, иначе прежние ветки фоллбеков.
  if (stepLimitReached && !finalContent) {
    const params = { limit: String(maxIterations) };
    finalContent = sm('session.steps_limit', params);
    fallbackI18n = i18nMeta('session.steps_limit', params);
  }

  // Защита от пустого финального ответа: если цикл завершился (в т.ч.
  // через doom loop / лимит итераций / серию deny / модель вернула пустой
  // контент) с пустым finalContent — подставляем осмысленное сообщение,
  // чтобы в истории не оставалось пустого assistant-сообщения.
  if (!finalContent) {
    if (roleBlocked) {
      // Ролевой отказ: тул не для этого агента — говорим об этом прямо, без
      // «заблокировано политикой безопасности» (это не инцидент ИБ).
      const params = { tool: roleBlockedTool ?? '', agent: roleBlockedAgent ?? '' };
      finalContent = sm('session.role_tool_blocked', params);
      fallbackI18n = i18nMeta('session.role_tool_blocked', params);
    } else {
      finalContent = hadDeny
        ? sm('session.denied_blocked')
        : sm('session.empty_response');
      fallbackI18n = i18nMeta(hadDeny ? 'session.denied_blocked' : 'session.empty_response');
    }
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
        // Сэмплинг агента хода: эскалация меняет модель, но агент тот же —
        // top-p/top-k берём из его определения (0/не задано — дефолт модели).
        const agentDef = effectiveAgentRole ? deps.agentRegistry?.get(effectiveAgentRole) : undefined;
        const agentTopP = agentDef?.topP && agentDef.topP > 0 ? agentDef.topP : undefined;
        const agentTopK = agentDef?.topK && agentDef.topK > 0 ? agentDef.topK : undefined;
        const fbProvider = deps.router.getProvider(
          fbDecision, undefined, effectiveReasoningLevel, undefined, undefined, agentTopP, agentTopK,
        );
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

  // 7.8. Tool-chain уже персистится пошагово в цикле (шаг 2а): assistant с
  // toolCalls — сразу после ответа модели, tool-результаты — сразу после
  // каждого тула. Здесь остаётся только финальное сообщение.
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
    { ...(fallbackI18n ? { i18n: fallbackI18n } : {}), ...(stepLimitReached ? { step_limit_reached: true } : {}), duration_ms: durationMs },
    promptMeta,
    messageCost,
    currentDraft ?? undefined,
    // ADR-115 (outbound): медиа-части ответа (`send_attachment`) — в историю
    // финального сообщения и, через него, в `stream.done.attachments`.
    outboundParts,
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

  // T14: сводка таймингов стрима — аддитивные поля `stream.done`; по ним UI
  // сравнивает серверный `last_chunk_ms` с моментом прихода события у клиента.
  const chunkStats = streamTiming?.snapshot();

  const doneData: Record<string, unknown> = {
    stream_id: streamId,
    content: savedContent,
    content_chars: savedContent.length,
    ...(chunkStats
      ? {
          chunks: chunkStats.chunks,
          ...(chunkStats.firstChunkMs !== undefined ? { first_chunk_ms: chunkStats.firstChunkMs } : {}),
          ...(chunkStats.lastChunkMs !== undefined ? { last_chunk_ms: chunkStats.lastChunkMs } : {}),
        }
      : {}),
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
    // Паритет с сабагентом (`metadata.step_limit_reached`): ход завершён
    // исполненным шагом-лимитом (текстового отчёта могло не быть).
    ...(stepLimitReached ? { step_limit_reached: true } : {}),
  };

  // ADR-036: проброс secrets в real-time событие — UI раскрывает плейсхолдеры
  // без перезагрузки списка сообщений (см. transportStore/chatStore).
  if (finalContent) {
    const secrets = await deps.getAssistantSecrets(session.id, savedContent);
    if (Object.keys(secrets).length > 0) {
      doneData.metadata = { secrets };
    }
  }

  // ADR-115 (outbound): вложения финального ответа — аддитивное поле, только
  // метаданные (`sha256`/`mime`/`size`/`name`). Байты шлюз забирает по sha
  // (`GET /api/v2/attachments/:sha256`), доступ к сессии ему не нужен.
  // Нет медиа-частей — поля нет вовсе (прежний контракт события).
  const attachments = updatedSession
    ? collectOutboundAttachments(updatedSession.messages, streamId)
    : [];
  if (attachments.length > 0) {
    doneData.attachments = attachments;
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
      // Температура title-агента применяется и без собственного reasoningLevel.
      if (
        titleAgentDef
        && (titleAgentDef.reasoningLevel || titleAgentDef.temperature !== undefined)
        && providerName
      ) {
        const tp = deps.getProvider(
          providerName, updatedSession, titleAgentDef.reasoningLevel,
          { temperature: titleAgentDef.temperature },
        );
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

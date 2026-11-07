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
  LlmFinishReason,
  MediaPartData,
  Message,
  Part,
  PromptMeta,
  ReasoningBlock,
  ReasoningLevel,
  Session,
  TokenUsage,
} from '@itphx/synth-shared';
import { MessageRole } from '@itphx/synth-shared';
import type { DebugCollector } from '../../../debug.js';
import type { SessionManager } from '../../../sessions/manager.js';
import type { EventBus } from '../../../events/bus.js';
import type { BaseProvider, LLMMessage, SystemPromptPayload } from '../../../providers/base.js';
import type { UsageCost, UsageCostBreakdown } from '../../../providers/usage.js';
import type { AgentRegistry } from '../../agents/registry.js';
import type { ContextOptimizer } from '../../context/optimizer.js';
import type { ModelRouter, RoutingDecision } from '../../router/router.js';
import type { SaveAssistantMessageFn, AssistantMessageStatus, ExistingMessageRef } from '../persistence.js';
import { addTokenUsage } from '../usage.js';
import type { AuxUsageRecorder } from '../../usage-accounting.js';
import type { ProviderOverrides } from '../routing.js';
import { warning } from '../../../logger.js';
import { t as sm, i18n as i18nMeta } from '../../system-messages.js';
import { dropSteerInjections } from '../../steering/apply.js';
import type { SteerRequeueResult } from '../../steering/apply.js';
import { requeueMessages } from '../../../queue/processor.js';
import type { StreamTiming } from '../stream-stats.js';
// ADR-118 §4: единая точка публикации `step.*`/`turn.*` (замена `stream.done`).
import {
  publishStepFinished,
  publishTurnFinished,
  stepStatusFromMessageStatus,
  turnStatusFromMessageStatus,
} from '../turn-events.js';

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
  /**
   * ADR-102: расход **хода** — сумма расходов всех шагов (итераций) хода.
   *
   * `finalUsage` — расход только последнего вызова LLM (последней итерации):
   * с ADR-118 шаг = отдельный вызов LLM, поэтому в историю/счётчики сессии/
   * аналитику шёл только он, а расход промежуточных шагов терялся. В
   * финальное (или отменённое) сообщение пишется именно `turnUsage`.
   */
  turnUsage: TokenUsage;
  /**
   * ADR-102: стоимость хода по шагам (валюта → сумма) и компонентная
   * разбивка для счётчиков — цены считаются моделью каждого шага.
   */
  turnCostByCurrency?: Record<string, number>;
  turnCostBreakdown?: UsageCostBreakdown;
  finalContent: string;
  /** metadata.i18n подставленного финального фоллбека (лимит/deny/пустой ответ). */
  fallbackI18n: ReturnType<typeof i18nMeta> | undefined;
  /**
   * Причина завершения ответа модели (нормализованный `LlmFinishReason`).
   *
   * Отличает «модель ничего не сказала» от «ответ срезан лимитом вывода»: при
   * `max_tokens` пустой `content` — не пустой ответ, а исчерпанный бюджет
   * (adaptive thinking расходует тот же `max_tokens`). Значение попадает в
   * `metadata.finish_reason` финального сообщения.
   */
  finishReason?: LlmFinishReason;
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
  allReasoning: ReasoningBlock[];
  /**
   * Legacy: сводка текстов промежуточных шагов. Для сообщений **хода**
   * (`step.turnId` задан) не пишется — тексты шагов живут в сообщениях своих
   * шагов (ADR-118 §1). Осталось для legacy-путей (сообщения без хода).
   */
  allIntermediateTexts?: Array<{ text: string; iteration: number }>;
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
   * читает `collectOutboundAttachments` для `step.finished.attachments`.
   * Ветка отмены их не сохраняет (ход не завершён — ничего не отправляем).
   * Не задано/пусто — прежнее поведение.
   */
  outboundParts?: Part[];
  /**
   * ADR-118 §1: идентификатор хода (стабилен для всех шагов хода) — в
   * `step.finished`/`turn.finished`.
   */
  turnId: string;
  /**
   * ADR-118 §1: индекс финального шага хода (0-based) — адресация шага в
   * `step.finished`.
   */
  finalStepIndex: number;
  /**
   * ADR-118 §1: идентификатор сообщения финального шага (его адресуют
   * `step.started`/`step.finished` и `part.*`).
   */
  finalStepMessageId?: string;
  /**
   * ADR-102: момент начала последнего вызова LLM — для `metadata.step_duration_ms`
   * (длительность своего шага; `duration_ms` остаётся длительностью хода).
   */
  finalStepStartedAt?: number;
  /** ADR-102: длительность последнего вызова LLM (для `step_duration_ms`). */
  finalStepDurationMs?: number;
  /**
   * ADR-118 §1: запись сообщения шага-лимита уже сохранена (шаг с вызовами
   * инструментов) — финализация **дополняет** её (статус/usage/metadata),
   * а не создаёт вторую запись с тем же текстом (в ленте был дубль «шаг +
   * финал»). Не задано — обычное поведение (создание/обновление записи).
   */
  stepLimitStepRecord?: { id: string; seq: number } | null;
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
  estimateUsage: (
    usage: TokenUsage | undefined,
    promptChars: number,
    outputChars: number,
  ) => { usage: TokenUsage; estimated: boolean };
  computeMessageCost: (model: string | undefined, usage: TokenUsage | undefined) => UsageCost | null;
  saveAssistantMessage: SaveAssistantMessageFn;
  /**
   * ADR-118 §1: точечная запись `metadata.tool_results` в сообщение шага
   * (та же операция, что у цикла Tool Use). Нужна ветке отмены **между
   * шагами**: результаты вызовов обязаны остаться в своём шаге, иначе
   * карточки инструментов (в т.ч. `question`, снятый «Стопом») теряются.
   * Не задана — ветка отмены пишет вызовы только в финальное сообщение
   * (legacy-поведение).
   */
  persistStepToolResults?: (
    sessionId: string,
    messageId: string,
    toolResults: Array<Record<string, unknown>>,
  ) => Promise<void>;
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
   * ADR-104 × ADR-111/ADR-113: вернуть в очередь **все** сообщения, оставшиеся
   * в steer-очереди к концу хода (пользовательский ввод и уведомления фоновых
   * прогонов — терять нельзя). `opts.autostart` — поднять ли ход: обычное
   * завершение (`turn_ended`) — да, «Стоп» (`aborted`) — нет (решение
   * пользователя, сообщение ждёт в очереди).
   * Не задан — используется локальный возврат в `pendingMessages` без
   * автозапуска (сообщение всё равно не теряется).
   */
  requeueSteerMessages?: (
    sessionId: string,
    messages: Message[],
    opts: { autostart: boolean },
  ) => Promise<SteerRequeueResult | void>;
  /** ADR-102: aux-учёт (title/QA self-check) — счётчики сессии + роллап usage. */
  recordAuxUsage?: AuxUsageRecorder;
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

/**
 * ADR-118 §1: свободен ли идентификатор сообщения финального шага.
 *
 * Проверка переехала в `saveAssistantMessage` (`persistence.ts`): там, где
 * сообщение создаётся, — там же решается, можно ли переиспользовать id шага
 * (если запись с таким id уже есть в истории — финальное сообщение получает
 * **свой** id, иначе в истории были бы две записи с одинаковым id). Эпилог
 * получает **фактический** id сохранённого сообщения из результата
 * сохранения и публикует его в `step.finished` — контракт «финал = сообщение
 * шага» не рвётся даже при ошибке чтения сессии.
 */

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
    finishReason,
    // ADR-118 §1: ход и финальный шаг.
    turnId, finalStepIndex, finalStepMessageId, stepLimitStepRecord,
    finalStepStartedAt, finalStepDurationMs,
  } = state;
  let { finalContent, finalModel, finalUsage, turnUsage, fallbackI18n } = state;
  const turnCostByCurrency = state.turnCostByCurrency ?? {};
  const turnCostBreakdown: UsageCostBreakdown = state.turnCostBreakdown ?? {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
  };
  /** Шаг-лимит реально исполнялся (синтетический assistant-префилл в запросе). */
  const stepLimitReached = state.stepLimitExecuted === true;

  /**
   * ADR-118 §1: «финал хода = последний шаг» — финальное сообщение несёт
   * размышления **только финальной итерации**. Размышления прошлых шагов
   * лежат в их сообщениях — в финале они были бы дублем (в ленте UI
   * повторялись одни и те же блоки reasoning).
   */
  const finalReasoningBlocks = allReasoning.filter((r) => r.iteration === finalStepIndex);
  /**
   * Anthropic: подпись thinking-блока (и opaque `redacted_thinking`) — валидна
   * только для своего текста, поэтому берётся у блока **финальной** итерации.
   * Осмысленна при ровно одном блоке (склейка нескольких — подпись в частях).
   */
  const finalReasoningMeta = finalReasoningBlocks.length === 1
    ? {
      signature: finalReasoningBlocks[0]!.signature,
      redacted: finalReasoningBlocks[0]!.redacted ? [finalReasoningBlocks[0]!.redacted] : undefined,
    }
    : undefined;

  // ADR-104 (решение 2026-10-28): ход заканчивается — снимаем неприменённые
  // инъекции из очереди. Границы шага больше не будет, поэтому сообщение,
  // пришедшее во время последней генерации/финализации, иначе применилось бы
  // в начале следующего хода и выглядело «внезапным отдельным сообщением».
  // НО: ничего не теряем (решение 2026-10-30) — остаток возвращается в
  // `pendingMessages`; при обычном завершении ход поднимается заново
  // (`autostart`), при «Стопе» сообщение ждёт пользователя. Причина `aborted` —
  // ход остановлен «Стопом» (остаток после снятия в роуте), `turn_ended` —
  // обычное завершение. Best-effort: сбой очереди не роняет ход.
  try {
    const steerRequeue = deps.requeueSteerMessages
      ? (messages: Message[]): Promise<SteerRequeueResult | void> =>
        deps.requeueSteerMessages!(session.id, messages, { autostart: !cancelledBeforeFinal })
      // Фоллбек без проводки: сообщение всё равно возвращается в обычную
      // очередь (терять ввод нельзя), но ход не поднимаем — процессор очереди
      // вызывающему здесь недоступен.
      : (messages: Message[]): Promise<SteerRequeueResult> =>
        requeueMessages({
          sessionManager: deps.sessionManager,
          eventBus: deps.eventBus,
          sessionId: session.id,
          messages,
        });

    await dropSteerInjections({
      sessionManager: deps.sessionManager,
      sessionId: session.id,
      reason: cancelledBeforeFinal ? 'aborted' : 'turn_ended',
      streamId,
      publishDropped: (event) => publishChunk('steer.dropped', event),
      requeue: steerRequeue,
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

    /**
     * ADR-118 §1: тексты шагов уже сохранены их сообщениями (шаг = сообщение),
     * а `currentDraft` в этой ветке `null` (черновик закрыт финализацией
     * шага) — поэтому в сообщении отмены текста нет: иначе UI показал бы
     * дубль (текст шага + текст финала).
     *
     * Единое правило отмены: текст не теряется ни в одной ветке —
     *  - отмена **внутри** шага (цикл) — текст текущей итерации остаётся в
     *    сообщении отмены (черновик обновляется на месте);
     *  - отмена **между** шагами (эта ветка) — тексты завершённых шагов
     *    лежат в их сообщениях, сообщение отмены несёт только статус и
     *    статистику.
     */
    const partialContent = '';

    // Bug 3/4: usage/duration/cost в событии отмены + best-effort оценка
    // usage (metadata.usage_estimated) при пустом usage.
    //
    // ADR-102/ADR-118: отмена **между шагами** — текущего вызова нет, поэтому
    // сообщение отмены не несёт собственного расхода (usage = 0): расходы
    // завершённых шагов уже лежат в их сообщениях. Счётчики сессии и
    // аналитика получают расход хода (`turnUsage`) — сумма usage сообщений
    // хода остаётся равна счётчикам.
    const cancelDurationMs = Date.now() - streamStartedAt;
    const cancelStepUsage = deps.estimateUsage(
      { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      0,
      0,
    );
    const cancelTurnUsage = turnUsage;
    const cancelCost = deps.computeMessageCost(cancelModel, cancelStepUsage.usage);
    const cancelTurnCost = deps.computeMessageCost(cancelModel, cancelTurnUsage);

    // Промежуточные тексты в сообщении отмены не дублируем: они живут в
    // сообщениях своих шагов (ADR-118 §1), а `metadata.intermediate_text_blocks`
    // для сообщений хода не пишется вовсе.
    // Сообщение сохраняем всегда (в т.ч. при пустом контенте) — статус и
    // статистика отмены не должны теряться.
    //
    // ADR-118 §1: результаты вызовов последнего шага фиксируем в **его**
    // сообщении (как это делает цикл Tool Use). Иначе при отмене между шагами
    // `metadata.tool_results` не пишется никуда (`saveAssistantMessage` не
    // кладёт их в сообщение хода), и карточки инструментов — в т.ч. `question`,
    // снятый «Стопом», — из истории пропадают.
    if (finalStepMessageId && allToolCalls.length > 0 && deps.persistStepToolResults) {
      const stepResults = allToolCalls.filter((tc) => tc.iteration === finalStepIndex);
      if (stepResults.length > 0) {
        await deps.persistStepToolResults(session.id, finalStepMessageId, stepResults);
      }
    }
    // ADR-118 §1: id сообщения шага передаём, только если он ещё не занят
    // записью в истории (см. `isStepMessageIdFree`): если запись шага уже
    // сохранена (отмена пришла во время исполнения тула), новая запись
    // отмены получает свой id — иначе в истории были бы две записи с одним id.
    await deps.saveAssistantMessage(
      session.id, partialContent, streamId, effectiveAgentRole,
      cancelStepUsage.usage, cancelModel, finalReasoningBlocks.map((r) => r.text).join('\n\n---\n\n'), debugCollector, true, providerName,
      MessageRole.ASSISTANT, undefined, false, allToolCalls, undefined,
      undefined, undefined,
      {
        duration_ms: cancelDurationMs,
      },
      promptMeta,
      cancelCost,
      currentDraft ?? undefined,
      // ADR-115: медиа-частей ответа в ветке отмены до финала нет.
      undefined,
      // Anthropic: подпись thinking-блока — только если `reasoning` финального
      // сообщения состоит из одного блока (у склейки подпись принадлежала бы
      // последнему блоку).
      finalReasoningMeta,
      // Блоки reasoning со своими подписями — в `parts` сообщения (мульти-блок).
      // ADR-118 §1: только финальная итерация (как у обычного финала).
      finalReasoningBlocks,
      // ADR-118 §1/§5: ход, шаг и терминальный статус сообщения.
      // `messageId` — идентификатор сообщения шага; передаём его, только
      // если записи с таким id в истории ещё нет (`isStepMessageIdFree`):
      // иначе новая запись получила бы id уже сохранённого сообщения шага
      // (две записи с одним id).
      {
        turnId,
        stepIndex: finalStepIndex,
        status: 'cancelled',
        ...(finalStepMessageId ? { messageId: finalStepMessageId } : {}),
      },
      // ADR-102: счётчики/аналитика — расход хода; сообщение — своего шага.
      cancelTurnUsage,
      cancelTurnCost,
      turnCostByCurrency,
      turnCostBreakdown,
    );

    publishChunk('stream.cancelled', {
      stream_id: streamId,
      content: partialContent,
      status: 'cancelled',
      model: cancelModel,
      provider: providerName,
      usage: cancelTurnUsage,
      duration_ms: cancelDurationMs,
      ...(cancelTurnCost ? { cost_usd: cancelTurnCost.costUsd, cost_currency: cancelTurnCost.currency } : {}),
    });

    // ADR-118 §4: ход закрыт отменой. Шаг, который шёл, закрыт в цикле
    // (`step.finished` со статусом `cancelled`) — здесь шага в полёте нет.
    publishTurnFinished(publishChunk, { turnId, status: 'cancelled' });

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
    if (finishReason === 'max_tokens') {
      // Ответ срезан лимитом вывода, а не «модель промолчала»: у
      // reasoning-моделей adaptive thinking расходует тот же `max_tokens`, и
      // при исчерпанном бюджете видимого текста не остаётся вовсе. Говорим об
      // этом прямо и подсказываем, что делать (раньше такой ход выглядел
      // «пустым ответом» и диагностировался как сбой модели).
      // `limit` — фактический расход вывода (эффективный лимит по факту),
      // `reasoning` — сколько из него ушло на размышления.
      const params = {
        limit: String(finalUsage.outputTokens),
        reasoning: String(finalUsage.reasoningTokens ?? 0),
      };
      finalContent = sm('session.output_limit', params);
      fallbackI18n = i18nMeta('session.output_limit', params);
    } else if (roleBlocked) {
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
  /** ADR-102: длительность fallback-вызова (если была эскалация). */
  let escalatedStepDurationMs: number | undefined;
  const escalation = deps.router?.getEscalationConfig();
  if (deps.router && escalation?.enabled && routingDecision && finalContent) {
    const qaResult = await deps.router.checkQuality(finalContent, routingDecision, session.settings);
    // ADR-102: self-check — отдельный aux-вызов (не сообщение).
    if (qaResult.usage) {
      void deps.recordAuxUsage?.({
        sessionId: session.id,
        usage: qaResult.usage,
        provider: routingDecision.providerName,
        model: routingDecision.modelName,
        agent: effectiveAgentRole,
        source: 'qa-self-check',
      });
    }
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
            const fbStartedAt = Date.now();
            const fbResponse = await fbProvider.chat(fbMessages, finalSystemPrompt, undefined, false);
            escalatedStepDurationMs = Math.max(0, Date.now() - fbStartedAt);
            if (fbResponse.content) {
              finalContent = fbResponse.content;
              qaPass = true;
              qaReason = sm('router.escalation', { provider: fallbackProvider, model: fallbackModel, reason: qaResult.reason });
              if (fbResponse.usage) {
                // ADR-102: эскалация — отдельный вызов LLM, его расход — часть
                // расхода хода (в сумму шагов он не входит).
                finalUsage = fbResponse.usage;
                turnUsage = addTokenUsage(turnUsage, fbResponse.usage);
                const fbCost = deps.computeMessageCost(fbResponse.model ?? finalModel, fbResponse.usage);
                if (fbCost) {
                  turnCostByCurrency[fbCost.currency] =
                    (turnCostByCurrency[fbCost.currency] ?? 0) + fbCost.costUsd;
                  turnCostBreakdown.input += fbCost.breakdown.input;
                  turnCostBreakdown.output += fbCost.breakdown.output;
                  turnCostBreakdown.cacheRead += fbCost.breakdown.cacheRead;
                  turnCostBreakdown.cacheWrite += fbCost.breakdown.cacheWrite;
                }
              }
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
  // ADR-102/ADR-118: стоимость **сообщения** (его собственного usage — расход
  // последнего вызова) и стоимость **хода** (сумма шагов) — разными
  // величинами: первая идёт в `metadata.cost_*` и `step.finished`, вторая —
  // в счётчики сессии и аналитику (`saveAssistantMessage`).
  const messageCost = deps.computeMessageCost(finalModel, finalUsage);
  const turnCost = deps.computeMessageCost(finalModel, turnUsage);
  // ADR-118 §1: reasoning финального сообщения — только финальная итерация
  // (размышления прошлых шагов лежат в их сообщениях).
  const reasoningJoined = finalReasoningBlocks.map((r) => r.text).join('\n\n---\n\n');
  // ADR-118 §1: id сообщения шага передаём всегда — решение «свой id или id
  // шага» принимает `saveAssistantMessage` (по факту наличия записи в
  // истории):
  //  - запись есть (шаг закрыт tool-chain сообщением — серия отказов,
  //    отмена, лимит шагов) → новая запись получает **свой** id, иначе в
  //    истории были бы две записи с одинаковым id;
  //  - записи нет (пустой ответ модели без черновика) → финальное сообщение
  //    создаётся с id шага: контракт «финальное сообщение = сообщение шага»
  //    (`step.started`/`step.finished` адресуют то же сообщение).
  // Обновление существующего черновика идёт через `existing` — его id и так
  // сохраняется.
  //
  // ADR-118 §1: **шаг-лимит** — запись шага (шаг с вызовами инструментов) уже
  // сохранена и несёт текст ответа и вызовы. Финализация её **дополняет**
  // (`keepContent`): статус/usage/metadata обновляются, содержимое — нет.
  // Иначе в ленте было бы два сообщения с одинаковым текстом/reasoning
  // (запись шага + новая финальная запись).
  const finalExisting: ExistingMessageRef | undefined = stepLimitReached && stepLimitStepRecord
    ? { ...stepLimitStepRecord, keepContent: true }
    : currentDraft ?? undefined;
  const savedMessageId = await deps.saveAssistantMessage(
    session.id, finalContent, streamId, effectiveAgentRole,
    finalUsage, finalModel, reasoningJoined, debugCollector, false, providerName,
    MessageRole.ASSISTANT, undefined, false, allToolCalls, allIntermediateTexts,
    qaPass, qaReason,
    {
      ...(fallbackI18n ? { i18n: fallbackI18n } : {}),
      ...(stepLimitReached ? { step_limit_reached: true } : {}),
      ...(finishReason ? { finish_reason: finishReason } : {}),
      duration_ms: durationMs,
      ...(finalStepDurationMs !== undefined || finalStepStartedAt !== undefined || escalatedStepDurationMs !== undefined
        ? {
            step_duration_ms: escalatedStepDurationMs
              ?? finalStepDurationMs
              ?? Math.max(0, Date.now() - finalStepStartedAt!),
          }
        : {}),
    },
    promptMeta,
    messageCost,
    finalExisting,
    // ADR-115 (outbound): медиа-части ответа (`send_attachment`) — в историю
    // финального сообщения и, через него, в `stream.done.attachments`.
    outboundParts,
    // Anthropic: подпись thinking-блока — иначе следующий ход tool-loop
    // отвергается API (thinking не возвращён в историю).
    finalReasoningMeta,
    // Блоки reasoning со своими подписями — в `parts` сообщения (мульти-блок).
    // ADR-118 §1: только финальная итерация.
    finalReasoningBlocks,
    // ADR-118 §1/§5: ход, шаг и терминальный статус сообщения.
    // `messageId` — идентификатор сообщения шага (решение о «своём id»
    // принимает `saveAssistantMessage`).
    {
      turnId,
      stepIndex: finalStepIndex,
      status: 'completed',
      ...(finalStepMessageId ? { messageId: finalStepMessageId } : {}),
    },
    // ADR-102: счётчики/аналитика — расход хода (`turnUsage`), сообщение —
    // расход своего (последнего) вызова. Стоимость — по моделям шагов.
    turnUsage,
    turnCost,
    turnCostByCurrency,
    turnCostBreakdown,
  );

  // ADR-071 §2.6: калибровка chars-per-token по факту (promptChars / inputTokens)
  // после успешного хода. promptChars — тот же расчёт, что уходил в провайдер
  // (последняя итерация), ratio — уже загруженный в этом ходе.
  // Ratio считается по **последней** итерации (`finalUsage`): сумма расходов
  // хода (`turnUsage`) не сопоставима с размером промпта одной итерации.
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

  // ADR-118 §4: `stream.done` удалён без dual-emit — финальный шаг закрывает
  // `step.finished` (статус, расход, вложения ответа, отладочные данные,
  // тайминги), ход — `turn.finished`.
  // ADR-118 §1: шаг-лимит — статус хода `limit` (ход остановлен лимитом
  // шагов), даже если модель успела дать свой текст.
  const messageStatus = deps.resolveAssistantStatus(false, {
    ...(fallbackI18n ? { i18n: fallbackI18n } : {}),
    ...(stepLimitReached ? { step_limit_reached: true } : {}),
  });

  // ADR-115 (outbound): вложения финального ответа — метаданные без байтов.
  // Байты шлюз забирает по sha (`GET /api/v2/attachments/:sha256`), доступ к
  // сессии ему не нужен. Нет медиа-частей — поля нет вовсе.
  const attachments = updatedSession
    ? collectOutboundAttachments(updatedSession.messages, streamId)
    : [];
  const debugInfo = debugCollector.getDebugInfo();

  publishStepFinished(publishChunk, {
    turnId,
    stepIndex: finalStepIndex,
    // ADR-118 §1/§5: «финал = сообщение шага» — адресуем **фактический** id
    // сохранённого сообщения (он же вернулся из `saveAssistantMessage`): если
    // id шага был занят записью в истории, финальное сообщение получило свой
    // id, и `step.finished` должен закрывать именно его (иначе в UI остаётся
    // второй пузырь).
    messageId: savedMessageId,
    status: stepStatusFromMessageStatus(messageStatus),
    // ADR-118 §4: `step.finished` несёт расход **своего шага** (не хода):
    // сумма по шагам = расход хода (метрики Prometheus не меняются).
    usage: finalUsage,
    provider: providerName,
    ...(finalModel ? { model: finalModel } : {}),
    ...(messageCost ? { costUsd: messageCost.costUsd, costCurrency: messageCost.currency } : {}),
    ...(effectiveAgentRole ? { agentRole: effectiveAgentRole } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(debugInfo ? { debugInfo } : {}),
    ...(chunkStats
      ? {
          timings: {
            chunks: chunkStats.chunks,
            ...(chunkStats.firstChunkMs !== undefined ? { firstChunkMs: chunkStats.firstChunkMs } : {}),
            ...(chunkStats.lastChunkMs !== undefined ? { lastChunkMs: chunkStats.lastChunkMs } : {}),
          },
        }
      : {}),
  });

  publishTurnFinished(publishChunk, {
    turnId,
    status: turnStatusFromMessageStatus(messageStatus),
  });

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

    // Проверить сжатие контекста (суммаризация или компактизация)
    const compression: ReturnType<ContextOptimizer['shouldCompress']> = typeof deps.optimizer.shouldCompress === 'function'
      ? deps.optimizer.shouldCompress(optSession)
      : typeof deps.optimizer.shouldSummarize === 'function'
        ? { ...deps.optimizer.shouldSummarize(optSession), mode: 'summarization' as const }
        : { triggered: false, reason: 'none' as const, mode: null };
    if (
      compression.triggered
      && compression.mode
      && (typeof deps.optimizer.canCompress !== 'function' || deps.optimizer.canCompress(optSession))
    ) {
      // Cooldown после неудачного сжатия: не ставим флаг и не публикуем
      // `context.summarization_pending` — иначе очередь снова упирается в
      // сжатие, которое уже провалилось (модель не вернула шаблон).
      const coolingDown = typeof deps.optimizer.isCompressionCoolingDown === 'function'
        && deps.optimizer.isCompressionCoolingDown(optSession.id);
      if (coolingDown) {
        warning(
          'ORCHESTRATOR',
          `Сжатие контекста пропущено (cooldown после неудачного сжатия): сессия ${optSession.id}`,
        );
      } else {
        await deps.sessionManager.withLock(optSession.id, async (s) => {
          s.summarizationPending = true;
          await deps.sessionManager.saveSession(s);
        });
        deps.eventBus.publish(optSession.id, 'context.summarization_pending', {
          reason: compression.reason,
          mode: compression.mode,
          current_tokens: compression.currentTokens,
          threshold: compression.threshold,
          user_count: compression.userCount,
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

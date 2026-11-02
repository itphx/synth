/**
 * Общий цикл выполнения саб-агента (tool-loop со стримом, retry LLM-вызова,
 * permissions дочерней сессии, отмена, quality check/эскалация).
 *
 * Общий для тула `task` и для возобновления прерванной дочерней сессии
 * (`task-resume.ts`). ADR-095 (шаг 5): вынесено из `task.ts` без изменения
 * поведения.
 */
import { MessageRole, nowISO, generateId, makeTextPart, appendReasoningBlock, effortForReasoningLevel } from '@itphx/synth-shared';
import type { Message, ReasoningBlock, SessionMode, PlanMode, TokenUsage, ToolContext, ToolForLLM, ToolResult, LLMReasoningBlock, ReasoningLevel, EffortLevel, MessageDeliveredPayload, StepFinishedPayload, EventType } from '@itphx/synth-shared';
import type { BaseProvider, LLMMessage, CancellationToken } from '../../../providers/base.js';
import { buildChatOptions } from '../../../providers/base.js';
import { EventBus } from '../../../events/bus.js';
import { buildDenyResult, executeToolDef } from '../tool-execution.js';
import { classifyLlmError, isLlmErrorRecoverable, LLM_MAX_ATTEMPTS, LLM_RETRY_DELAYS_MS, MAX_DOOM_LOOP_COUNT } from '../../llm-error.js';
import { computeUsageCost } from '../../../providers/usage.js';
import type { UsageCost } from '../../../providers/usage.js';
import { deriveSubagentPermission } from '../../permission/derive.js';
import { PermissionEvaluator } from '../../permission/evaluator.js';
import { PermissionApprovalManager } from '../../permission/approval.js';
import { buildPermissionPreview } from '../../permission/preview.js';
import { ObfuscationMapStore } from '../../gateway/obfuscation-map-store.js';
import { estimatePromptChars, estimateTokens } from '../../context/token-ratio.js';
import { buildMaxStepsPrompt, maxStepsAssistantMessage } from '../../llm/max-steps.js';
import { t as sm, i18n as i18nMeta } from '../../system-messages.js';
import { debug } from '../../../logger.js';
import { createChildSessionLifecycle, publishMessageAdded } from './child-session.js';
import {
  publishPartDelta,
  publishPartUpdated,
  publishStepFinished,
  publishStepStarted,
  publishTurnStarted,
  reasoningPartId,
  textPartId,
  toolCallPart,
  liveStepParts,
  type PublishEvent,
} from '../../orchestrator/turn-events.js';
import { setLiveStreamSnapshot } from '../../live-stream-snapshot.js';
import { messageToLLMMessage } from './prompt.js';
import { applySteerInjections, dropSteerInjections } from '../../steering/apply.js';
import { makeReasoningParts, toLlmReasoningBlocks } from '../../reasoning-blocks.js';
import { hasVisibleStepContent } from '../../orchestrator/persistence.js';
import type { AssistantMessageStatus } from '../../orchestrator/persistence.js';
import { requeueMessages } from '../../../queue/processor.js';
import type { ContextMode, SubagentRetryConfig, TaskExtra } from './types.js';

/** Retry саб-агента: максимум попыток LLM-вызова (единая политика — LLM_MAX_ATTEMPTS). */
export const SUBAGENT_MAX_ATTEMPTS = LLM_MAX_ATTEMPTS;
/** Backoff между попытками (единая политика — LLM_RETRY_DELAYS_MS). */
export const SUBAGENT_RETRY_DELAYS_MS = LLM_RETRY_DELAYS_MS;

/**
 * runSubagent — цикл выполнения саб-агента, общий для тула `task` и для
 * возобновления прерванной дочерней сессии (task-resume.ts).
 *
 * Включает: связку cancel-токена с родительским сигналом отмены, permissions
 * дочерней сессии (ADR-029), режимную фильтрацию тулов, tool-loop со стримом
 * прогресса родителю, retry-цикл LLM-вызова (recoverable → backoff, аналог
 * QueueProcessor), обработку отмены (finishAborted), quality check/эскалацию
 * (ADR-034) и формирование tool_result.
 */
export interface SubagentRunConfig {
  /** Тип саб-агента (id в реестре агентов). */
  subagentType: string;
  description: string;
  contextMode: ContextMode;
  /** Лимит шагов агента (0/undefined — без ограничений). */
  maxSteps?: number;
  /**
   * Системный промпт саб-агента (role + parent notes/summary + routing).
   * ADR-070 §1.5: единственный путь — второй аргумент `chatAsync`; в `messages`
   * system-сообщения нет.
   */
  llmSystemPrompt: string;
  /** Начальные LLM-сообщения БЕЗ system: история дочерней сессии + user-промпт. */
  initialMessages: LLMMessage[];
  /** Провайдер саб-агента (уже резолвнутый роутером/оркестратором). */
  provider: BaseProvider;
  /**
   * Температура прогона (`agent.temperature` → `session.settings.temperature`).
   *
   * У провайдера она уже выставлена, но QA-эскалация (ADR-034) поднимает
   * **другую** модель из пула — ей температуру надо передать отдельно, иначе
   * fallback-вызов ушёл бы с дефолтом модели/температурой чужого прогона.
   * `undefined` — дефолт модели.
   */
  temperature?: number;
  /**
   * Sampling прогона (`agent.topP`/`topK`, только положительные значения).
   *
   * У провайдера он уже выставлен, но QA-эскалация (ADR-034) поднимает
   * **другую** модель из пула — ей sampling надо передать отдельно, иначе
   * fallback-вызов ушёл бы с дефолтом модели. `undefined` — не задано.
   */
  topP?: number;
  topK?: number;
  /**
   * ADR-117: актуальный уровень размышлений прогона (`agent.reasoningLevel` →
   * настройки дочерней сессии). Считается на **каждый** LLM-вызов цикла:
   * effort едет в `ChatOptions`, провайдер не кэшируется с «зашитым» значением.
   */
  reasoningLevel?: ReasoningLevel;
  /**
   * ADR-117: явный тир усилия прогона (`agent.effort` → настройки дочерней
   * сессии). Приоритетнее `reasoningLevel`; нужен для `xhigh`/`max`.
   * Считается на **каждый** LLM-вызов цикла вместе с `reasoningLevel`.
   */
  effort?: EffortLevel;
  tools?: ToolForLLM[];
  /** Дочерняя сессия (если есть) — в неё пишется история саб-агента. */
  childSessionId?: string;
  /** Сессия для child.*-событий (у task — родитель, у resume — родитель resumed-сессии). */
  parentSessionId: string;
  /** Начальное routing-решение (ADR-034) — для QA/эскалации. */
  routingDecisionInfo?: { providerName: string; modelName: string; strategy: string };
  extra: TaskExtra;
  ctx: ToolContext;
  /** Override retry-параметров (иначе extra.retry или дефолт 3 попытки / 5-15-30с). */
  retry?: SubagentRetryConfig;
}

/** Пауза backoff порциями с проверкой отмены. Возвращает true, если отмена. */
async function sleepAbortable(ms: number, isAborted: () => boolean): Promise<boolean> {
  const SLICE_MS = 200;
  let waited = 0;
  while (waited < ms) {
    if (isAborted()) return true;
    await new Promise((resolve) => setTimeout(resolve, Math.min(SLICE_MS, ms - waited)));
    waited += SLICE_MS;
  }
  return isAborted();
}

/**
 * Карта обфускации **родительской** сессии (ADR-036) — ею маскируются реальные
 * значения секретов в диффе превью. Карта может отсутствовать (gateway выключен)
 * или не читаться — тогда маскировать нечего.
 */
async function loadSubagentSecretsMap(extra: TaskExtra): Promise<Record<string, string>> {
  try {
    if (!extra.sessionManager || !extra.sessionId) return {};
    return await new ObfuscationMapStore(extra.sessionManager).get(extra.sessionId);
  } catch {
    return {};
  }
}

/**
 * Текст «только текст» для шага-лимита — общий модуль механики opencode
 * (`engine/llm/max-steps.ts`): его же использует основной цикл оркестратора.
 */
/**
 * Текст «только текст» для шага-лимита — общий модуль механики opencode
 * (`engine/llm/max-steps.ts`): его же использует основной цикл оркестратора.
 */
export async function runSubagent(config: SubagentRunConfig): Promise<ToolResult> {
  const {
    subagentType, description, contextMode, maxSteps,
    llmSystemPrompt, initialMessages,
    provider: effectiveProvider,
    tools: toolsInput,
    childSessionId, parentSessionId,
    extra, ctx,
  } = config;
  const tools = toolsInput;
  let routingDecisionInfo = config.routingDecisionInfo;
  const publish = extra.publish;

  const effectiveMaxSteps = (!maxSteps || maxSteps === 0)
    ? Number.POSITIVE_INFINITY
    : maxSteps;

  // ─── Retry-параметры (аналог QueueProcessor: 3 попытки, backoff 5/15/30с) ──
  const retryCfg = config.retry ?? extra.retry
    ?? { maxRetries: LLM_MAX_ATTEMPTS, delaysMs: LLM_RETRY_DELAYS_MS };
  const retryMaxAttempts = Math.max(1, retryCfg.maxRetries);
  const retryDelaysMs = retryCfg.delaysMs.length > 0 ? retryCfg.delaysMs : LLM_RETRY_DELAYS_MS;

  // ─── Permissions дочерней сессии (ADR-029): родитель + deny-дополнения ──
  const derivedPermission = deriveSubagentPermission(extra.permissionConfig);

  // ─── LLM-сообщения: только начальные (история/промпт); system — аргумент chatAsync ──
  const messages: LLMMessage[] = [...initialMessages];

  const cancelToken: CancellationToken = { cancelled: false, cancel: () => { cancelToken.cancelled = true; } };

  // ADR-070 §2.6: usage саб-агента для rollup в статистике родителя. Собирается
  // по всем итерациям LLM-стрима и пишется в финальное assistant-сообщение
  // дочерней сессии (промежуточные tool-chain — без usage, чтобы не удваивать).
  const subagentUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  /**
   * ADR-102: был ли usage текущей итерации уже включён в `subagentUsage`
   * (финальный чанк). Нужно ветке отмены: частичный ответ несёт usage своего
   * шага, но накапливается он ровно один раз.
   */
  let iterationUsageCommitted = false;
  /** ADR-102: встретились разные валюты стоимости — стоимость по каталогу. */
  let subagentCostMixed = false;
  /** ADR-102: длительность последнего вызова LLM (для `step_duration_ms`). */
  let lastIterationDurationMs: number | undefined;
  let subagentModel: string | undefined;
  const subagentStartedAt = Date.now();

  /** Накопить usage одного LLM-ответа саб-агента (все итерации суммируются). */
  const accumulateUsage = (usage: TokenUsage | undefined): void => {
    if (!usage) return;
    subagentUsage.inputTokens += usage.inputTokens || 0;
    subagentUsage.outputTokens += usage.outputTokens || 0;
    subagentUsage.totalTokens += usage.totalTokens || 0;
    if (usage.cacheReadTokens) subagentUsage.cacheReadTokens = (subagentUsage.cacheReadTokens || 0) + usage.cacheReadTokens;
    if (usage.cacheWriteTokens) subagentUsage.cacheWriteTokens = (subagentUsage.cacheWriteTokens || 0) + usage.cacheWriteTokens;
    if (usage.reasoningTokens) subagentUsage.reasoningTokens = (subagentUsage.reasoningTokens || 0) + usage.reasoningTokens;
    // ADR-102: провайдерская стоимость — суммируем в одной валюте; разные
    // валюты не складываем (тогда стоимость — по каталогу).
    if (usage.cost) {
      if (subagentCostMixed) {
        // уже смешали валюты — стоимость не частичная
      } else if (!subagentUsage.cost) subagentUsage.cost = { ...usage.cost };
      else if (subagentUsage.cost.currency === usage.cost.currency) {
        subagentUsage.cost.amount += usage.cost.amount;
      } else {
        subagentUsage.cost = undefined;
        subagentCostMixed = true;
      }
    }
  };

  // ─── ADR-070: live-статистика саб-агента (`stream.usage` + `subagent.progress`) ──
  // Троттлинг ~300 мс; публикуем **только приращение** текста/размышлений
  // (`content_delta`/`reasoning_delta`), а не накопленный текст целиком: при
  // нескольких параллельных саб-агентах полный текст каждые 300 мс давал
  // мегабайты кадров и задерживал ack отправки сообщений в том же WS-канале.
  const SUBAGENT_USAGE_THROTTLE_MS = 300;
  /**
   * Предел суммарного объёма дельт прогресса на один прогон (символы ≈ байты
   * для UTF-8-текста). Выше — публикация прогресса прекращается (debug-лог):
   * гигантские кадры не должны блокировать транспорт. Итоговый отчёт и
   * `stream.usage` не зависят от этого предела.
   */
  const SUBAGENT_PROGRESS_MAX_CHARS = 200_000;
  let liveUsageLastPublishedAt = 0;
  let progressCharsPublished = 0;
  let progressPublishingStopped = false;

  /** Сумма двух usage (running total саб-агента + точный/оценочный текущей итерации). */
  const addUsage = (a: TokenUsage, b: TokenUsage): TokenUsage => ({
    inputTokens: (a.inputTokens || 0) + (b.inputTokens || 0),
    outputTokens: (a.outputTokens || 0) + (b.outputTokens || 0),
    totalTokens: (a.totalTokens || 0) + (b.totalTokens || 0),
    ...(a.cacheReadTokens || b.cacheReadTokens
      ? { cacheReadTokens: (a.cacheReadTokens || 0) + (b.cacheReadTokens || 0) }
      : {}),
    ...(a.cacheWriteTokens || b.cacheWriteTokens
      ? { cacheWriteTokens: (a.cacheWriteTokens || 0) + (b.cacheWriteTokens || 0) }
      : {}),
    ...(a.reasoningTokens || b.reasoningTokens
      ? { reasoningTokens: (a.reasoningTokens || 0) + (b.reasoningTokens || 0) }
      : {}),
  });

  /** Оценка размера промпта саб-агента (символы) — best-effort input-токены. */
  const estimateSubagentPromptChars = (): number =>
    estimatePromptChars(messages, llmSystemPrompt || undefined, tools);

  /**
   * Live-usage саб-агента: накопленный `subagentUsage` (завершённые итерации)
   * + точный usage текущего чанка либо best-effort оценка текущей итерации.
   * Финальный чанк уже включён в `subagentUsage` (accumulateUsage вызван до).
   *
   * Точным считаем usage с output>0/reasoning (ADR-070 §2.6, как в оркестраторе).
   * Anthropic отдаёт input/cache в `message_start` (output ещё 0): сохраняем
   * точный input/cache, но output оцениваем из накопленного текста, пока не
   * придёт `message_delta` с output. Полностью нулевой usage — оценка обоих.
   */
  const buildLiveSubagentUsage = (
    chunk: { usage?: TokenUsage; isFinal: boolean },
    accumulatedContent: string,
    reasoning: string,
  ): { usage: TokenUsage; estimated: boolean } => {
    const usage = chunk.usage;
    const hasExactOutput = !!usage
      && (usage.outputTokens > 0 || (usage.reasoningTokens ?? 0) > 0);
    if (hasExactOutput) {
      if (chunk.isFinal) return { usage: { ...subagentUsage }, estimated: false };
      return { usage: addUsage(subagentUsage, usage!), estimated: false };
    }

    const outputChars = accumulatedContent.length + reasoning.length;
    const estOutput = Math.ceil(outputChars / 4);
    if (usage && usage.inputTokens > 0) {
      // Точный input/cache + оценка output текущей итерации.
      const current: TokenUsage = {
        ...usage,
        outputTokens: estOutput,
        totalTokens: (usage.inputTokens || 0) + estOutput,
      };
      return { usage: addUsage(subagentUsage, current), estimated: true };
    }

    const promptChars = estimateSubagentPromptChars();
    const estInput = Math.ceil(promptChars / 4);
    return {
      usage: addUsage(subagentUsage, {
        inputTokens: estInput,
        outputTokens: estOutput,
        totalTokens: estInput + estOutput,
      }),
      estimated: true,
    };
  };

  // Связка локального cancel-токена саб-агента с родительским сигналом отмены:
  // «Стоп» в родительской сессии (POST /sessions/:id/abort → orchestrator.cancel
  // → внутренний toolAbortController.abort → ctx.abortSignal) должен немедленно
  // прерывать LLM-стрим саб-агента и его цикл, а не ждать завершения всех шагов.
  const isAborted = () => cancelToken.cancelled || ctx.abortSignal?.aborted === true;
  if (ctx.abortSignal?.aborted) {
    cancelToken.cancel();
  } else {
    ctx.abortSignal?.addEventListener('abort', () => cancelToken.cancel(), { once: true });
  }

  // ─── Permissions саб-агента (ADR-029): проверка перед каждым tool_call ───
  // Дочерняя сессия наследует permissions родителя (deriveSubagentPermission).
  // ask-запросы публикуются в EventBus РОДИТЕЛЬСКОЙ сессии — подтверждение
  // видит пользователь основной сессии, approval_id связывает ответ.
  const childEvaluator = new PermissionEvaluator(derivedPermission);
  const childApprovalManager = new PermissionApprovalManager(extra.eventBus ?? new EventBus());
  // ADR-070 §2.9.1: ролевые ограничения саб-агента — через unavailable(role),
  // а не скрытием тулов; capabilities нужны permission-слою.
  const subagentDef = extra.agentRegistry?.get(subagentType);
  let childSessionMode: SessionMode = 'act';
  let childPlanApproved = false;
  let childPlanMode: PlanMode = 'auto';
  let childMcpToolSettings: Record<string, import('@itphx/synth-shared').McpServerToolSettings> | undefined;
  /**
   * id первого user-сообщения ребёнка — `messageId` в `turn.started` (это
   * реплика, которой ход ребёнка начат; fallback — id самой сессии).
   */
  let childUserMessageId: string | undefined;
  if (childSessionId && extra.sessionManager) {
    try {
      const child = await extra.sessionManager.getSession(childSessionId);
      if (child) {
        childSessionMode = child.mode ?? 'act';
        childPlanApproved = Boolean(child.planApproved);
        childPlanMode = child.settings.planMode ?? 'auto';
        childMcpToolSettings = child.settings.mcpToolSettings;
        childUserMessageId = child.messages.find((m) => m.role === MessageRole.USER)?.id;
      }
    } catch {
      // не фатально — остаёмся в act/auto
    }
  }

  // ADR-070 §2.9: список тулов саб-агента постоянен (без режимной фильтрации).
  // Ограничения plan/act/yolo и роли обеспечивает permission-слой ниже —
  // `unavailable(mode|role)` с подсказкой, definition остаётся в запросе.

  // Финализация дочерней сессии, запись сообщений/usage и metadata финального
  // ответа — в `createChildSessionLifecycle` (ADR-095, шаг 5).
  const childLifecycle = createChildSessionLifecycle({
    childSessionId,
    parentSessionId,
    extra,
    usage: subagentUsage,
    getModel: () => subagentModel,
  });
  const finalizeChildSession = childLifecycle.finalize;
  const addChildMessage = childLifecycle.addMessage;
  const commitChildUsage = childLifecycle.commitUsage;
  const buildChildAssistantMetadata = childLifecycle.buildAssistantMetadata;

  /**
   * ADR-118 §1/§10: живой ход **дочерней** сессии.
   *
   * События хода ребёнка публикуются в канал **ребёнка** (не родителя): у
   * пользователя может быть открыта дочерняя сессия, и до этих правок её UI
   * «молчал» до готовых `step.finished`/`message.added` — не было ни
   * `turn.started`, ни шага, ни дельт, ни карточек тулов.
   *
   * Best-effort: ошибка публикации не должна ронять прогон.
   */
  const publishChildEvent: PublishEvent = (type, data) => {
    if (!childSessionId || !extra.eventBus) return;
    try {
      extra.eventBus.publish(childSessionId, type as EventType, data);
    } catch {
      // живой ход ребёнка не фатальнее прогона
    }
  };
  /**
   * ADR-118 §10: события **инструментов** саб-агента нужны в двух каналах.
   *
   * - Родительский (`extra.publish` = `publishChunk` оркестратора) — дерево
   *   вложенных вызовов под блоком `task`, привязка по `parent_call_id`.
   * - Дочерний (`publishChildEvent`) — вкладка саб-агента подписана на канал
   *   ребёнка: без события её live-карточки инструментов не создаются и не
   *   закрываются результатом. В дочернем канале это **обычная** карточка:
   *   `parent_call_id` убираем (иначе UI посчитал бы её вложенной), а
   *   `session_id` — id дочерней сессии (не родительской).
   */
  const publishToolEvent = (
    type: 'tool_call.started' | 'tool_call.result',
    data: Record<string, unknown>,
  ): void => {
    publish?.(type, data);
    if (!childSessionId) return;
    const childData = { ...data };
    delete childData.parent_call_id;
    publishChildEvent(type, { ...childData, session_id: childSessionId });
  };
  /**
   * `streamId` прогона: у blocking-прогона — родительский ход, у
   * переведённого в фон — собственный (поле `extra` мутируется при detach).
   * По нему сверяется маркер `currentStream`: чужой не перетираем и не снимаем.
   */
  const runStreamId = (): string => extra.streamId ?? '';


  /**
   * ADR-104: steering дочерней сессии — применение очереди инъекций на
   * границе шага (тот же шов, что у оркестратора основной сессии; общая
   * реализация — `engine/steering/apply.ts`).
   *
   * Инъекция адресована конкретной сессии: очередь ребёнка (`steerInbox`
   * дочерней сессии) изолирована от очереди родителя. Сообщение
   * (`POST /sessions/<child>/prompt` с `mode:'steer'`) персистится в
   * истории ребёнка как `user`-реплика с `metadata.steer=true` и
   * добавляется в LLM-контекст текущего хода — то есть вплетается в тот же
   * ход, без нового хода и без разрыва пар `toolUse`/`toolResult`.
   *
   * `interrupt` для дочерней сессии НЕ прерывает прогон и не абортит токен:
   * на границе шага генерации уже нет (она закончилась на предыдущей
   * итерации), поэтому инъекция применяется как обычное вмешательство —
   * семантика «вмешательство без завершения хода». Прервать генерацию
   * внутри шага саб-агента нечем: шаг — это LLM-вызов целиком.
   *
   * Нет дочерней сессии (чистый `none`-контекст) — no-op.
   */
  const applyChildSteerInjections = async (): Promise<void> => {
    const sessionManager = extra.sessionManager;
    if (!childSessionId || !sessionManager) return;
    // ADR-118 §4: `message.delivered` несёт `ord` (порядок записи) и
    // принципал — они есть только у сохранённого сообщения, поэтому
    // последнее сохранённое сообщение запоминаем в замыкании.
    let lastPersisted: Message | undefined;
    try {
      await applySteerInjections({
        sessionManager,
        sessionId: childSessionId,
        llmMessages: messages,
        toLlmMessages: (message) => [messageToLLMMessage(message)],
        persist: async (message) => {
          // `seq` назначается по месту (`addMessage`): ввод мог быть поставлен
          // в очередь инъекций раньше, и его `seq` (снимок на момент постановки)
          // к этому моменту уже устарел.
          const updated = await sessionManager.addMessage(childSessionId, { ...message, seq: 0 });
          if (!updated) return { index: 0 };
          const index = updated.messages.length - 1;
          const persisted = updated.messages[index]!;
          lastPersisted = persisted;
          // Сообщение дочерней сессии — как любое другое сообщение ребёнка:
          // `message.added` в канал ребёнка (+ `child.message.added` в канал
          // родителя) через общий хелпер.
          if (extra.eventBus) {
            await publishMessageAdded(
              extra.eventBus, parentSessionId, childSessionId, persisted, index, updated,
            );
          }
          return { index };
        },
        // ADR-118 §4: прежний `message.injected` удалён без dual-emit —
        // материализация сообщения в истории ребёнка публикуется как
        // `message.delivered` (`messageId`, `ord`, роль, автор, принципал).
        // Событие идёт в канал **ребёнка**: инъекция принадлежит его ходу.
        publishInjected: () => {
          const persisted = lastPersisted;
          if (!persisted) return;
          const payload: MessageDeliveredPayload = {
            messageId: persisted.id,
            ord: Number.isFinite(persisted.ord) ? (persisted.ord as number) : 0,
            role: persisted.role,
            ...(persisted.author ? { author: persisted.author } : {}),
            ...(persisted.principal ? { principal: persisted.principal } : {}),
            // ADR-118 §4 (аддитивно): ход ребёнка. У цикла сабагента своего
            // `turnId` нет — он равен id дочерней сессии (так же, как в
            // `turn.started`/`step.started`/`step.finished` ребёнка), поэтому
            // клиент привязывает инъекцию к тому же ходу.
            turnId: childSessionId,
          };
          extra.eventBus?.publish(childSessionId, 'message.delivered', payload);
        },
        publishDropped: (event) => {
          extra.eventBus?.publish(childSessionId, 'steer.dropped', event);
        },
        streamId: extra.streamId,
      });
    } catch {
      // Инъекция не должна ронять прогон саб-агента.
    }
  };

  /**
   * ADR-104 (решение 2026-10-28): конец прогона саб-агента — снимаем
   * неприменённые инъекции из очереди ребёнка.
   *
   * Очередь вычитывается только на границе шага; после цикла границы больше
   * не будет, и сообщение, пришедшее во время последней генерации, иначе
   * применилось бы в начале следующего хода и выглядело «внезапным отдельным
   * сообщением». Причина — `turn_ended` (ход/прогон закончился) или
   * `aborted` («Стоп» родителя) — как у основного хода. Best-effort: сбой
   * очереди не роняет прогон.
   *
   * Снимается **во всех** терминальных путях (ошибка провайдера, отмена,
   * жёсткий сбой) — иначе остаток очереди «протекает» в следующий ход
   * ребёнка. Повторный вызов безопасен: очередь снимается один раз.
   */
  let steerQueueDropped = false;
  const dropChildSteerInjections = async (
    reason: 'turn_ended' | 'aborted' = 'turn_ended',
  ): Promise<void> => {
    if (steerQueueDropped) return;
    steerQueueDropped = true;
    const sessionManager = extra.sessionManager;
    if (!childSessionId || !sessionManager) return;
    try {
      await dropSteerInjections({
        sessionManager,
        sessionId: childSessionId,
        reason,
        streamId: extra.streamId,
        publishDropped: (event) => {
          extra.eventBus?.publish(childSessionId, 'steer.dropped', event);
        },
        // ADR-104 × ADR-111/ADR-113: ни ввод пользователя, ни уведомления
        // фоновых прогонов не теряем — весь остаток возвращается в очередь
        // ребёнка. Автостарта нет: процессора очереди у дочерней сессии нет
        // (`createProcessor` здесь недоступен), сообщение ждёт.
        requeue: async (messages) => {
          return requeueMessages({
            sessionManager,
            eventBus: extra.eventBus,
            sessionId: childSessionId,
            messages,
          });
        },
      });
    } catch {
      // Конец прогона не должен падать из-за очереди инъекций.
    }
  };

  // ─── ADR-118 §10: живой ход дочерней сессии — маркер и начало хода ──────
  // Пока прогон идёт, у ребёнка стоит `currentStream`: открытая дочерняя
  // сессия показывает индикатор «идёт» (и восстанавливает ход после reload).
  // Best-effort: маркер не записался — прогон всё равно идёт.
  if (childSessionId && extra.sessionManager) {
    try {
      await extra.sessionManager.withLock(childSessionId, async (s) => {
        // Чужой маркер (например, прогон уже переведён в фон с другим
        // `streamId`, ADR-111 §detach) не перетираем — иначе UI ребёнка
        // потеряет живую часть прогона.
        if (s.currentStream && s.currentStream.streamId !== runStreamId()) return;
        s.currentStream = {
          streamId: runStreamId(),
          turnId: childSessionId,
          message: description,
          agentRole: subagentType,
          startedAt: nowISO(),
          cancelled: false,
        };
        await extra.sessionManager!.saveSession(s);
      });
    } catch {
      // не фатально: прогон важнее маркера активности
    }
  }
  // Начало хода ребёнка: UI открывает живой ход (границы — `turnId`), а его
  // `messageId` — реплика, которой ход начат (fallback — id сессии).
  if (childSessionId) {
    publishTurnStarted(
      publishChildEvent,
      { turnId: childSessionId, messageId: childUserMessageId ?? childSessionId },
    );
  }

  try {
    let finalContent = '';
    let iteration = 0;
    const doomTracker = new Map<string, number>();
    let subagentReasoning = '';
    let subagentDenied = false;
    /**
     * Anthropic: подпись thinking-блока финального сообщения ребёнка. Заполняется,
     * только пока `reasoning` — текст одного блока (см. родительский цикл).
     */
    let subagentReasoningMeta: { signature?: string; redacted?: string[] } | undefined;

    let allSubagentReasoning: ReasoningBlock[] = [];
    const allSubagentIntermediateTexts: Array<{ text: string; iteration: number }> = [];
    const allSubagentToolCalls: Array<{
      name: string; args: Record<string, unknown>; id?: string;
      result?: { content: string; isError?: boolean };
      started_at?: string; completed_at?: string; iteration: number;
    }> = [];

    /**
     * Финальный шаг по лимиту шагов (механика opencode): ещё один обычный шаг
     * того же цикла — `tools` остаются в запросе, вызов запрещён
     * `toolChoice: 'none'`, инструкция «только текст» вставлена
     * assistant-сообщением в транскрипт (в историю оно не пишется).
     */
    let stepLimitReached = false;
    /** Выполнен ли уже шаг-лимит (второй раз в него не заходим). */
    let stepLimitStepDone = false;
    /** Отчёт по лимиту шагов не получен (пустой или пробельный ответ). */
    let reportMissing = false;
    const stepLimitValue = Number.isFinite(effectiveMaxSteps)
      ? String(effectiveMaxSteps)
      : String(maxSteps ?? 0);
    /**
     * Metadata шага-лимита: флаг и сам лимит. Пишется и в `task`-результат
     * родителя, и в финальное сообщение **дочерней** сессии — иначе в её
     * истории факт остановки по лимиту не виден (проверено живьём).
     */
    const stepLimitMeta = (): Record<string, unknown> => ({
      step_limit_reached: true,
      step_limit: Number(stepLimitValue),
    });
    /** ADR-102: `metadata.step_duration_ms` (длительность своего вызова). */
    const stepDurationMeta = (): Record<string, unknown> =>
      lastIterationDurationMs !== undefined ? { step_duration_ms: lastIterationDurationMs } : {};

    /**
     * Предохранитель по объёму промпта (`agents.subagentMaxInputTokens`; `0` —
     * без ограничения). Это **не** окно модели: оценка проверяется перед каждым
     * LLM-вызовом, и при превышении прогон завершается детерминированным
     * отчётом (без LLM), а не уходит в ошибку провайдера.
     */
    const subagentMaxInputTokens = typeof extra.subagentMaxInputTokens === 'function'
      ? extra.subagentMaxInputTokens()
      : extra.subagentMaxInputTokens ?? 0;
    /** Прогон остановлен предохранителем бюджета контекста. */
    let contextBudgetExceeded = false;
    /** Оценка промпта в токенах на момент срабатывания предохранителя. */
    let contextBudgetTokens = 0;

    /** Best-effort оценка промпта саб-агента в токенах (`0` — данных нет). */
    const estimatePromptTokens = async (): Promise<number> => {
      const chars = estimatePromptChars(messages, llmSystemPrompt || undefined, tools);
      return chars > 0 ? estimateTokens(chars, await resolvePromptTokenRatio()) : 0;
    };

    /**
     * ADR-071: калиброванный chars-per-token модели прогона — один раз на
     * прогон. Нет калибровки/ошибка загрузчика → `undefined` (дефолт 4,
     * fail-open).
     */
    let promptTokenRatio: number | undefined;
    let promptTokenRatioResolved = false;
    const resolvePromptTokenRatio = async (): Promise<number | undefined> => {
      if (promptTokenRatioResolved) return promptTokenRatio;
      promptTokenRatioResolved = true;
      try {
        const loaded = await extra.loadTokenRatio?.(
          effectiveProvider.model ?? routingDecisionInfo?.modelName,
        );
        if (typeof loaded === 'number' && Number.isFinite(loaded) && loaded > 0) {
          promptTokenRatio = loaded;
        }
      } catch {
        // fail-open: оценка по дефолту 4
      }
      return promptTokenRatio;
    };

    /**
     * Незавершённые задачи для отчёта: последнее todo-состояние дочерней
     * сессии (если есть), иначе — описание задачи. Результаты инструментов не
     * пересказываются: отчёт детерминированный и не выдумывает фактов.
     */
    const collectUnfinishedTasks = async (): Promise<string> => {
      if (childSessionId && extra.sessionManager) {
        try {
          const child = await extra.sessionManager.getSession(childSessionId);
          const pending = (child?.todos ?? [])
            .filter((t) => t.status !== 'completed' && t.status !== 'cancelled')
            .map((t) => t.content.trim())
            .filter((item) => item.length > 0);
          if (pending.length > 0) return pending.slice(0, 10).join('; ');
        } catch {
          // сессия могла быть удалена — падать из-за отчёта нельзя
        }
      }
      return description || '—';
    };

    /**
     * Сохранить финальный ответ ассистента в дочернюю сессию — общий путь
     * для обычного финала и для финального отчёта по лимиту шагов.
     *
     * `messageId` — id **новой** записи: он задаётся только когда запись
     * является сообщением шага (и тогда id шага свободен). Отчёт, который
     * создаётся **сверх** уже сохранённого assistant(tool_calls) (шаг-лимит с
     * «непослушным» вызовом), получает **свой** id (`generateId()`) — иначе
     * в истории ребёнка окажутся две записи с одним id, а UI пропустит
     * сообщение с уже занятым id (live-отчёт не появится).
     */
    const persistChildAssistantMessage = async (
      content: string,
      extraMeta: Record<string, unknown> = {},
      messageId?: string,
      status: AssistantMessageStatus = 'completed',
      /**
       * ADR-102/ADR-118: расход **своего** шага (одного вызова провайдера).
       * Финальный отчёт шага — его расход; отчёт «сверх» уже сохранённого
       * assistant(tool_calls) — без расхода (он уже в сообщении шага), иначе
       * сумма usage сообщений ребёнка превысит счётчики сессии.
       */
      usage?: TokenUsage,
      /**
       * ADR-118 §1: индекс шага сообщения. По умолчанию — текущая итерация;
       * отчёт «сверх» сохранённого assistant(tool_calls) создаётся после
       * `iteration++` и передаёт индекс **своего** шага явно.
       */
      stepIndex: number = iteration,
    ): Promise<void> => {
      if (!childSessionId || !extra.sessionManager) return;
      try {
        const assistantMsg: Message = {
          id: messageId ?? generateId(),
          role: MessageRole.ASSISTANT,
          seq: 0,
          origin: 'local',
          parts: [makeTextPart(content), ...makeReasoningParts(allSubagentReasoning)],
          content,
          createdAt: nowISO(),
          disabled: false,
          pinned: false,
          hidden: false,
          agentRole: subagentType,
          model: subagentModel,
          // ADR-118 §1/§5: сообщение шага дочерней сессии — ход ребёнка = id
          // дочерней сессии (`step.finished`/`turn.finished` публикуются с этим
          // `turnId`), индекс шага и терминальный статус. Без этих полей после
          // перезагрузки вкладка саб-агента не могла восстановить живой шаг
          // (в истории `turn_id`/`step_index`/`status` были `null`).
          ...(childSessionId ? { turnId: childSessionId } : {}),
          stepIndex,
          status: status === 'cancelled' ? 'cancelled' : status === 'error' ? 'error' : 'completed',
          // ADR-102: сообщение шага несёт расход своего вызова; сумма по
          // сообщениям прогона = счётчики дочерней сессии (`subagentUsage`).
          ...(usage ? { usage } : {}),
          // Все размышления сабагента (по итерациям), склеенные в поле
          // reasoning — UI дочерней сессии показывает их блоками
          // (ReasoningBlock разбивает по «\n\n---\n\n»). Без этого размышления
          // остаются только в скрытых tool_chain-сообщениях и теряются.
          reasoning: allSubagentReasoning.length > 0
            ? allSubagentReasoning.map((r) => r.text).join('\n\n---\n\n')
            : undefined,
          // Anthropic: подпись thinking-блока (только для одиночного блока —
          // у склейки подпись принадлежала бы последнему).
          ...(subagentReasoningMeta?.signature !== undefined
            ? { reasoningSignature: subagentReasoningMeta.signature }
            : {}),
          ...(subagentReasoningMeta?.redacted?.length
            ? { reasoningRedacted: subagentReasoningMeta.redacted }
            : {}),
          // Как в _persistToolChain родителя: финальное сообщение несёт
          // свёрнутую цепочку тулов, чтобы UI дочерней сессии отрисовал её
          // так же аккуратно, как финал родительской.
          metadata: buildChildAssistantMetadata(status, {
            stream_id: extra.streamId,
            duration_ms: Date.now() - subagentStartedAt,
            ...(allSubagentToolCalls.length > 0 ? { tool_results: allSubagentToolCalls } : {}),
            ...(allSubagentIntermediateTexts.length > 0 ? { intermediate_text_blocks: allSubagentIntermediateTexts } : {}),
            ...extraMeta,
          }, usage),
        };
        const updated = await extra.sessionManager.addMessage(childSessionId, assistantMsg);
        if (updated && extra.eventBus) {
          const idx = updated.messages.length - 1;
          await publishMessageAdded(extra.eventBus, parentSessionId, childSessionId, updated.messages[idx]!, idx, updated);
        }
      } catch {
        // не фатально
      }
    };

    // Завершение по отмене (Стоп в родительской сессии): сохранить частичный
    // текст (если есть), поставить маркер прерывания в историю дочерней
    // сессии, финализировать её (без статуса completed) и вернуть родителю
    // tool_result с маркером остановки, частичным ответом и списком шагов.
    const finishAborted = async (
      partialContent: string,
      partialReasoning: string,
      /**
       * ADR-102: usage текущей (оборванной) итерации — если её финальный чанк
       * успел прийти. Частичный ответ несёт расход своего шага; в счётчики он
       * попадает ровно один раз (если ещё не был накоплен по финальному чанку).
       */
      partialUsage?: TokenUsage,
      /** Начало вызова LLM оборванной итерации (для `step_duration_ms`). */
      iterationStartedAt?: number,
    ): Promise<ToolResult> => {
      // 1. Частичный стрим оборванной итерации — в историю дочерней сессии
      if (partialContent || partialUsage) {
        if (partialUsage && !iterationUsageCommitted) {
          accumulateUsage(partialUsage);
          iterationUsageCommitted = true;
        }
        await addChildMessage({
          id: generateId(),
          role: MessageRole.ASSISTANT,
          seq: 0,
          origin: 'local',
          parts: [makeTextPart(partialContent)],
          content: partialContent,
          createdAt: nowISO(),
          disabled: false,
          pinned: false,
          hidden: false,
          agentRole: subagentType,
          model: subagentModel,
          // ADR-102: расход своего шага; сумма по сообщениям прогона =
          // счётчики ребёнка (`commitChildUsage`).
          ...(partialUsage ? { usage: partialUsage } : {}),
          ...(partialReasoning ? { reasoning: partialReasoning } : {}),
          metadata: buildChildAssistantMetadata('cancelled', {
            stream_id: extra.streamId,
            duration_ms: Date.now() - subagentStartedAt,
            ...(iterationStartedAt !== undefined
              ? { step_duration_ms: Math.max(0, Date.now() - iterationStartedAt) }
              : {}),
            partial: true,
            interrupted: true,
          }, partialUsage),
        });
      }

      // 2. Маркер прерывания в историю дочерней сессии
      const stopMarkerText = sm('task.stopped_by_user');
      await addChildMessage({
        id: generateId(),
        role: MessageRole.INFO,
        seq: 0,
        origin: 'local',
        parts: [makeTextPart(stopMarkerText)],
        content: stopMarkerText,
        createdAt: nowISO(),
        disabled: false,
        pinned: false,
        hidden: false,
        agentRole: subagentType,
        metadata: {
          stream_id: extra.streamId,
          stopped_by: 'user',
          interrupted: true,
          i18n: i18nMeta('task.stopped_by_user'),
        },
      });

      // 3. Финализация дочерней сессии
      // ADR-104: очередь инъекций ребёнка снимается и на отмене («Стоп») —
      // остаток не должен «протечь» в следующий ход ребёнка.
      await dropChildSteerInjections('aborted');
      await commitChildUsage();
      // Ход ребёнка прерван «Стопом» — терминальный статус `cancelled`.
      await finalizeChildSession('cancelled');

      // 4. tool_result родителю: маркер отмены + частичный текст + шаги + id сессии
      const stepsCompleted = allSubagentToolCalls.length > 0
        ? allSubagentToolCalls.map((t) => t.name).join(', ')
        : 'none';
      return {
        content: [
          '<task_result>',
          `<summary>${description}</summary>`,
          '<status>stopped_by_user</status>',
          ...(childSessionId ? [`<child_session_id>${childSessionId}</child_session_id>`] : []),
          ...(partialContent ? [`<partial_output>\n${partialContent}\n</partial_output>`] : []),
          `<steps_completed>${stepsCompleted}</steps_completed>`,
          sm('task.stopped_before_completion'),
          '</task_result>',
        ].join('\n'),
        metadata: {
          subagent_type: subagentType,
          description: description,
          context_mode: contextMode,
          steps: iteration,
          child_session_id: childSessionId,
          stopped_by: 'user',
          interrupted: true,
          // ADR-070 §2.6: per-message статистика сабагентов (попап сообщения).
          subagent_usage: subagentUsage,
          subagent_model: subagentModel,
          tool_calls: allSubagentToolCalls.length > 0 ? allSubagentToolCalls : undefined,
          partial_output: partialContent || undefined,
        },
      };
    };

    // Условие цикла: обычные шаги до лимита + ОДИН дополнительный шаг-лимит
    // (после него `stepLimitStepDone` — выходим; при `Infinity` лимита шаг не
    // наступает никогда).
    while (iteration < effectiveMaxSteps || !stepLimitStepDone) {
      if (isAborted()) break;

      // Лимит исчерпан — этот шаг финальный: инструменты остаются в запросе
      // (кэшированный префикс провайдера), но вызов запрещён `toolChoice`.
      const stepLimitStep = Number.isFinite(effectiveMaxSteps) && iteration + 1 >= effectiveMaxSteps;
      if (stepLimitStep) stepLimitStepDone = true;
      // ADR-118 §4: id сообщения шага. Assistant-сообщение шага создаётся
      // уже во время стрима (`step.finished` несёт его `messageId`), поэтому
      // id выдаётся ЗДЕСЬ, до LLM-вызова, и переиспользуется при записи
      // сообщения в историю ребёнка.
      const stepMessageId = generateId();
      // ADR-118 §1/§4: шаг ребёнка начался — его UI создаёт assistant-сообщение
      // шага (`status: 'streaming'`) и держит индикатор до `step.finished`.
      publishStepStarted(
        publishChildEvent,
        { turnId: childSessionId ?? '', stepIndex: iteration, messageId: stepMessageId },
      );
      // Инструкция «только текст» — assistant-сообщением в запрос, не в историю.
      const requestMessages = stepLimitStep
        ? [
          ...messages,
          maxStepsAssistantMessage(
            buildMaxStepsPrompt(
              extra.contextConfig,
              extra.parentSessionSettings?.language ?? 'ru',
              effectiveMaxSteps,
            ),
          ),
        ]
        : messages;

      // ADR-104: инъекции в дочернюю сессию применяются на границе шага —
      // ДО формирования запроса к LLM, поэтому сообщение попадает в текущую
      // итерацию. Результаты инструментов предыдущей итерации уже в
      // `messages`, поэтому пары `toolUse`/`toolResult` не рвутся.
      await applyChildSteerInjections();

      // ─── Предохранитель бюджета контекста (agents.subagentMaxInputTokens) ──
      // Шаг-лимит имеет приоритет: финальный шаг-отчёт механики opencode не
      // считается превышением бюджета (иначе отчёт вообще не был бы получен).
      if (!stepLimitStep && subagentMaxInputTokens > 0) {
        const estimatedTokens = await estimatePromptTokens();
        // Оценка недоступна/пуста — не блокируем (fail-open).
        if (estimatedTokens > 0 && estimatedTokens > subagentMaxInputTokens) {
          contextBudgetExceeded = true;
          contextBudgetTokens = estimatedTokens;
          const unfinished = await collectUnfinishedTasks();
          // Детерминированный отчёт (без LLM): выполняем шаги и незавершённые
          // задачи, без пересказа результатов инструментов.
          finalContent = sm('task.context_budget', {
            tokens: String(estimatedTokens),
            steps: String(iteration),
            tasks: unfinished,
          });
          // Отчёт — обычный assistant-ответ дочерней сессии (статус `completed`:
          // работа частично сделана), с метаданными срабатывания.
          await persistChildAssistantMessage(finalContent, {
            context_budget_exceeded: true,
            context_budget_tokens: estimatedTokens,
            steps: iteration,
          }, stepMessageId);
          // Родителю/UI — сигнал срабатывания предохранителя.
          publish?.('subagent.context_budget', {
            child_session_id: childSessionId,
            tokens: estimatedTokens,
            steps: iteration,
          });
          break;
        }
      }

      let accumulatedContent = '';
      let toolCalls: Record<string, unknown>[] | undefined = [];
      let reasoning = '';
      // Anthropic: подпись thinking-блока и opaque `redacted_thinking` этой
      // итерации — без возврата в историю провайдер отвергает следующий вызов.
      let reasoningSignature: string | undefined;
      let reasoningRedacted: string[] | undefined;
      /** Anthropic: блоки reasoning этой итерации (каждый со своей подписью). */
      let iterationReasoningBlocks: LLMReasoningBlock[] | undefined;
      // Опубликованные префиксы текста/размышлений **этой итерации** — по ним
      // считается приращение для `subagent.progress` (дельта, а не полный текст).
      let lastPublishedReasoning = '';
      let lastPublishedContent = '';
      /**
       * Префиксы, уже опубликованные **ребёнку** (`part.delta`/`part.updated`).
       * Считаются независимо от троттлинга `subagent.progress`: у ребёнка
       * дельты не троттлятся (это его собственный UI — объём ограничен), и
       * общий «опубликованный» префикс дал бы дыры в тексте шага.
       */
      let lastChildContent = '';
      let lastChildReasoning = '';
      /**
       * ADR-118 §4: расход шага ребёнка — в `step.finished` (usage/модель/
       * стоимость). Значения последнего чанка итерации запоминаются здесь и
       * публикуются **после** завершения LLM-вызова: троттлинг дельт не
       * должен решать, публикуется ли закрытие шага (иначе live-сообщение
       * шага ребёнка навсегда оставалось `streaming`, а usage/стоимость
       * терялись).
       */
      let stepUsage: TokenUsage | undefined;
      /**
       * ADR-102/ADR-118: расход **этого** вызова провайдера (последний
       * `chunk.usage` итерации; провайдеры отдают накопительный usage за
       * итерацию — суммировать по чанкам нельзя). В отличие от `subagentUsage`
       * (сумма по всем итерациям) это расход ровно своего шага — он идёт в
       * сообщение шага/`step.finished`, а сумма по шагам = расход прогона.
       */
      let iterationUsage: TokenUsage | undefined;
      iterationUsageCommitted = false;
      // ADR-102: начало вызова LLM итерации — `metadata.step_duration_ms`.
      const iterationStartedAt = Date.now();
      let stepCost: UsageCost | null = null;
      let stepModel: string | undefined;
      let stepProvider: string | undefined;

      // ─── LLM-вызов с retry (B1, аналог QueueProcessor) ──────────────
      // Recoverable-ошибки (network/timeout/rate_limit/server_error) ретраятся
      // до retryMaxAttempts попыток с backoff; unrecoverable (auth/
      // model_not_found/context_length) — сразу финальная ошибка. Backoff-пауза
      // спит порциями с проверкой отмены: «Стоп» прерывает ожидание мгновенно.
      // Событие subagent.retry и паузы НЕ пишут ничего в историю дочерней
      // сессии — мусорные сообщения не создаются (только финальный ERROR).
      let llmFailure: { error: unknown; errorType: string; attempts: number } | null = null;
      for (let attempt = 1; attempt <= retryMaxAttempts; attempt++) {
        if (isAborted()) break;
        try {
          // ADR-117: effort — из явного тира прогона (`agent.effort`/настройки
          // ребёнка), иначе из `reasoningLevel`; считается на каждый вызов
          // (смена настройки между вызовами подхватывается, провайдер кэширован).
          const effort = config.effort ?? effortForReasoningLevel(config.reasoningLevel);
          for await (const chunk of effectiveProvider.chatAsync(
            requestMessages,
            llmSystemPrompt || undefined,
            tools as Record<string, unknown>[] | undefined,
            undefined,
            cancelToken,
            buildChatOptions(effort, stepLimitStep ? 'none' : undefined),
          )) {
            if (isAborted()) break;
            if (chunk.isFinal) {
              accumulatedContent = chunk.content;
              reasoning = chunk.reasoning || reasoning;
            } else {
              accumulatedContent += chunk.content;
              const chunkReasoning = chunk.reasoning;
              if (chunkReasoning) reasoning = chunkReasoning;
            }
            if (chunk.toolCalls && chunk.toolCalls.length > 0) {
              toolCalls = chunk.toolCalls;
            }
            if (chunk.reasoningSignature !== undefined) reasoningSignature = chunk.reasoningSignature;
            if (chunk.reasoningRedacted?.length) reasoningRedacted = chunk.reasoningRedacted;
            if (chunk.reasoningBlocks?.length) iterationReasoningBlocks = chunk.reasoningBlocks;
            // ADR-070 §2.6: usage и модель саб-агента для статистики родителя.
            // Провайдеры отдают в каждом чанке НАКОПИТЕЛЬНЫЙ usage (running total),
            // поэтому суммируем только финальный чанк итерации — иначе usage
            // многократно раздувается. Каждый вызов chatAsync в финальном чанке
            // несёт итог своей итерации.
            if (chunk.isFinal) {
              accumulateUsage(chunk.usage);
              if (chunk.usage) iterationUsageCommitted = true;
            }
            // ADR-102: расход своего вызова — для сообщения шага/`step.finished`.
            if (chunk.usage) iterationUsage = chunk.usage;
            if (chunk.model) subagentModel = chunk.model;

            // ADR-070: live-usage = накопленное + точный/оценка текущей итерации;
            // стоимость — по ценам модели, если загрузчик передан в extra.
            const liveUsage = buildLiveSubagentUsage(chunk, accumulatedContent, reasoning);
            const liveModel = subagentModel || effectiveProvider.model || undefined;
            const liveProvider = effectiveProvider.name || undefined;
            const liveCost = liveModel && extra.modelPriceLoader
              ? computeUsageCost(liveUsage.usage, extra.modelPriceLoader(liveModel))
              : null;
            // Последние значения итерации — для `step.finished` ребёнка (публикуется
            // после завершения LLM-вызова, вне троттлинга дельт). `stepUsage` —
            // расход **своего** шага (`iterationUsage`), не накопленный.
            stepUsage = iterationUsage;
            stepCost = iterationUsage && liveModel && extra.modelPriceLoader
              ? computeUsageCost(iterationUsage, extra.modelPriceLoader(liveModel))
              : null;
            stepModel = liveModel;
            stepProvider = liveProvider;
            const liveReasoning = reasoning || '';
            const liveContent = accumulatedContent || '';

            // Дельты с прошлой публикации. Провайдер отдаёт текст накопительно
            // (в т.ч. `isFinal`-чанк с полным текстом итерации), поэтому дельта —
            // это хвост, которого ещё не было. Префикс не совпал (рестарт/новый
            // текст) — публикуем весь текст: потребитель допишет его к блоку.
            const reasoningDelta = liveReasoning.startsWith(lastPublishedReasoning)
              ? liveReasoning.slice(lastPublishedReasoning.length)
              : liveReasoning;
            const contentDelta = liveContent.startsWith(lastPublishedContent)
              ? liveContent.slice(lastPublishedContent.length)
              : liveContent;

            // ADR-118 §4: живой ход **дочерней** сессии — дельта текста шага и
            // снапшот reasoning (провайдер отдаёт его кумулятивно). Без
            // троттлинга: это UI самого ребёнка, объём ограничен одним шагом.
            if (childSessionId) {
              const childContentDelta = liveContent.startsWith(lastChildContent)
                ? liveContent.slice(lastChildContent.length)
                : liveContent;
              if (childContentDelta) {
                lastChildContent = liveContent;
                publishPartDelta(
                  publishChildEvent,
                  {
                    messageId: stepMessageId,
                    partId: textPartId(0),
                    field: 'text',
                    delta: childContentDelta,
                  },
                );
              }
              if (liveReasoning && liveReasoning !== lastChildReasoning) {
                lastChildReasoning = liveReasoning;
                const partId = reasoningPartId(0);
                publishPartUpdated(
                  publishChildEvent,
                  {
                    messageId: stepMessageId,
                    partId,
                    part: { id: partId, type: 'reasoning', data: liveReasoning },
                  },
                );
              }
              // ADR-118 §5: снимок живого шага ребёнка — открытая вкладка
              // саб-агента видит текущий шаг целиком, не дожидаясь дельт.
              setLiveStreamSnapshot(childSessionId, {
                streamId: runStreamId(),
                turnId: childSessionId,
                messageId: stepMessageId,
                stepIndex: iteration,
                content: liveContent,
                ...(liveReasoning ? { reasoning: liveReasoning } : {}),
                parts: liveStepParts(liveContent, liveReasoning, toolCalls),
                updatedAt: nowISO(),
              });
            }

            // Стримим размышления/промежуточный текст (и usage) саб-агента
            // РОДИТЕЛЮ, чтобы в блоке `task` (по parent_call_id) всё было видно
            // во время работы. Троттлинг ~300 мс. Пустые дельты (например,
            // финальный чанк, где текст не изменился) событие не порождают.
            const nowLive = Date.now();
            if (
              (reasoningDelta.length > 0 || contentDelta.length > 0)
              && nowLive - liveUsageLastPublishedAt >= SUBAGENT_USAGE_THROTTLE_MS
            ) {
              liveUsageLastPublishedAt = nowLive;
              lastPublishedReasoning = liveReasoning;
              lastPublishedContent = liveContent;

              const deltaChars = reasoningDelta.length + contentDelta.length;
              if (progressCharsPublished + deltaChars > SUBAGENT_PROGRESS_MAX_CHARS) {
                if (!progressPublishingStopped) {
                  progressPublishingStopped = true;
                  debug(
                    'ORCHESTRATOR',
                    `SUBAGENT progress publishing stopped: > ${SUBAGENT_PROGRESS_MAX_CHARS} chars `
                    + `(child_session_id=${childSessionId ?? '-'}, call_id=${extra.callId ?? '-'})`,
                  );
                }
              } else {
                progressCharsPublished += deltaChars;

                if (publish) {
                  publish('subagent.progress', {
                    stream_id: extra.streamId,
                    session_id: extra.sessionId,
                    parent_call_id: extra.callId,
                    reasoning_delta: reasoningDelta,
                    content_delta: contentDelta,
                    iteration,
                    usage: liveUsage.usage,
                    ...(liveCost ? { cost_usd: liveCost.costUsd, cost_currency: liveCost.currency, cost_breakdown: liveCost.breakdown } : {}),
                    ...(liveModel ? { model: liveModel } : {}),
                    ...(liveProvider ? { provider: liveProvider } : {}),
                    estimated: liveUsage.estimated,
                  });
                }
                // ADR-118 §4: `step.finished` ребёнка публикуется **после**
                // завершения LLM-вызова итерации (ниже, вне троттлинга) —
                // троттлинг влияет только на `subagent.progress`.
              }
            }
          }
          llmFailure = null;
          break;
        } catch (err) {
          // Прерывание пользователем во время стрима (провайдер бросил
          // AbortError) — не ошибка, обработается через finishAborted ниже.
          if (isAborted()) break;
          const rawError = err instanceof Error ? err.message : String(err);
          const errorType = classifyLlmError(rawError);
          if (!isLlmErrorRecoverable(err, rawError) || attempt >= retryMaxAttempts) {
            // Unrecoverable или попытки исчерпаны — финальная ошибка
            llmFailure = { error: err, errorType, attempts: attempt };
            break;
          }
          const delay = retryDelaysMs[Math.min(attempt - 1, retryDelaysMs.length - 1)] ?? 0;
          publish?.('subagent.retry', {
            stream_id: extra.streamId,
            session_id: extra.sessionId,
            child_session_id: childSessionId,
            parent_call_id: extra.callId,
            attempt,
            max_retries: retryMaxAttempts,
            retry_in: delay,
            error_type: errorType,
            error: rawError,
          });
          if (await sleepAbortable(delay, isAborted)) break;
          // Сброс частичного контекста неудавшейся попытки
          accumulatedContent = '';
          reasoning = '';
          toolCalls = [];
          iterationUsage = undefined;
          iterationUsageCommitted = false;
          stepUsage = undefined;
          stepCost = null;
          lastPublishedReasoning = '';
          lastPublishedContent = '';
          lastChildContent = '';
          lastChildReasoning = '';
        }
      }

      // ADR-102: длительность своего вызова LLM (без исполнения инструментов).
      const iterationDurationMs = Math.max(0, Date.now() - iterationStartedAt);
      lastIterationDurationMs = iterationDurationMs;

      // ADR-118 §4: вызовы шага — карточки `tool_use` в UI дочерней сессии.
      // Публикуются **до** `step.finished` (это «контент шага», а не финал):
      // иначе карточки появлялись бы только вместе с историей.
      if (!llmFailure && !isAborted() && toolCalls && toolCalls.length > 0) {
        for (const tc of toolCalls) {
          const callId = typeof tc.id === 'string' ? tc.id : '';
          if (!callId) continue;
          publishPartUpdated(
            publishChildEvent,
            {
              messageId: stepMessageId,
              partId: callId,
              part: toolCallPart(callId, tc),
            },
          );
        }
      }

      // ADR-118 §4: шаг дочерней сессии закрыт — `step.finished` публикуется
      // **после** завершения LLM-вызова итерации, вне ветки дельт: троттлинг
      // прогресса не должен решать, публикуется ли закрытие шага. Раньше
      // событие уходило только вместе с дельтой — без неё live-сообщение шага
      // ребёнка навсегда оставалось `streaming`, а usage/стоимость терялись.
      // У цикла сабагента своего `turnId`/`stepIndex` нет: `turnId` = id
      // дочерней сессии, `stepIndex` = номер итерации, `messageId` = id
      // assistant-сообщения шага.
      if (!llmFailure && !isAborted() && childSessionId && extra.eventBus) {
        const stepPayload: StepFinishedPayload = {
          turnId: childSessionId,
          stepIndex: iteration,
          messageId: stepMessageId,
          status: 'completed',
          ...(stepUsage ? { usage: stepUsage } : {}),
          agentRole: subagentType,
          ...(stepModel ? { model: stepModel } : {}),
          ...(stepProvider ? { provider: stepProvider } : {}),
          ...(stepCost
            ? {
              costUsd: stepCost.costUsd,
              costCurrency: stepCost.currency,
            }
            : {}),
        };
        publishStepFinished(publishChildEvent, stepPayload);
      }

      if (llmFailure) {
        // Ошибка провайдера внутри саб-агента (после retry-цикла): фиксируем
        // в истории дочерней сессии, финализируем её и возвращаем родителю
        // tool_result с описанием ошибки, счётчиком попыток и child_session_id.
        const attempts = llmFailure.attempts;
        const errParams = { type: subagentType, error: String(llmFailure.error) };
        const errKey = attempts > 1
          ? 'task.subagent_exec_error_after_retries' as const
          : 'task.subagent_exec_error' as const;
        const errText = attempts > 1
          ? sm(errKey, { ...errParams, attempts: String(attempts) })
          : sm(errKey, errParams);
        await addChildMessage({
          id: generateId(),
          role: MessageRole.ERROR,
          seq: 0,
          origin: 'local',
          parts: [makeTextPart(errText)],
          content: errText,
          createdAt: nowISO(),
          disabled: false,
          pinned: false,
          hidden: false,
          agentRole: subagentType,
          model: subagentModel,
          // ADR-102: сообщение об ошибке не несёт накопленный расход —
          // предыдущие шаги уже в своих сообщениях, а неудавшийся вызов
          // провайдером не тарифицирован (`commitChildUsage` = сумма шагов).
          metadata: buildChildAssistantMetadata('error', {
            stream_id: extra.streamId,
            duration_ms: Date.now() - subagentStartedAt,
            ...(lastIterationDurationMs !== undefined
              ? { step_duration_ms: lastIterationDurationMs }
              : {}),
            error: true,
            attempts,
            max_retries: retryMaxAttempts,
            error_type: llmFailure.errorType,
            i18n: i18nMeta(errKey, attempts > 1 ? { ...errParams, attempts: String(attempts) } : errParams),
          }),
        });
        // ADR-104: ошибка провайдера — тоже терминальный путь прогона: очередь
        // инъекций ребёнка снимается, остаток не «протекает» в следующий ход.
        await dropChildSteerInjections('turn_ended');
        await commitChildUsage();
        // Ошибка провайдера — терминальный статус хода ребёнка `error`.
        await finalizeChildSession('error');
        // ADR-030: `agent_failed` — неблокирующий эмит терминальной ошибки
        // саб-агента после исчерпания ретраев.
        if (extra.hooks && childSessionId) {
          extra.hooks.emitAsync('agent_failed', {
            agentId: childSessionId,
            error: errText,
            retries: attempts,
          });
        }
        return {
          content: [
            '<task_result>',
            `<summary>${description}</summary>`,
            '<status>error</status>',
            ...(childSessionId ? [`<child_session_id>${childSessionId}</child_session_id>`] : []),
            `<attempts>${attempts}</attempts>`,
            errText,
            '</task_result>',
          ].join('\n'),
          isError: true,
          metadata: {
            subagent_type: subagentType,
            description: description,
            context_mode: contextMode,
            steps: iteration,
            child_session_id: childSessionId,
            error: true,
            attempts,
            max_retries: retryMaxAttempts,
            error_type: llmFailure.errorType,
            // ADR-070 §2.6: per-message статистика сабагентов (попап сообщения).
            subagent_usage: subagentUsage,
            subagent_model: subagentModel,
            tool_calls: allSubagentToolCalls.length > 0 ? allSubagentToolCalls : undefined,
          },
        };
      }

      // Отмена (Стоп в родительской сессии): сохраняем частичный текст
      // ТЕКУЩЕЙ итерации, ставим маркер прерывания в историю дочерней
      // сессии, финализируем её (без статуса completed) и возвращаем
      // родителю tool_result с маркером остановки, частичным ответом и
      // списком выполненных шагов.
      if (isAborted()) {
        return await finishAborted(accumulatedContent, reasoning, iterationUsage, iterationStartedAt);
      }

      // Единая итерация для размышлений, промежуточного текста и вызовов
      // инструментов этого шага — иначе в UI (и в дочерней сессии) ломается
      // порядок: размышления идут на step N, а вызовы — на N+1.
      const stepIteration = iteration;
      // Блоки reasoning итерации: провайдер отдаёт их со своими подписями
      // (мульти-блочный ответ Anthropic), иначе — legacy fallback на одно поле
      // подписи (паритет с основным циклом).
      const iterationBlocks: Array<{ text: string; signature?: string; redacted?: string }> =
        iterationReasoningBlocks && iterationReasoningBlocks.length > 0
          ? iterationReasoningBlocks.map((block) => ({
            text: block.text,
            ...(block.signature !== undefined ? { signature: block.signature } : {}),
            ...(block.redactedData ? { redacted: block.redactedData } : {}),
          }))
          : [
            ...(reasoningRedacted ?? []).map((data) => ({ text: '', redacted: data })),
            ...(reasoning || reasoningSignature !== undefined
              ? [{
                text: reasoning,
                ...(reasoningSignature !== undefined ? { signature: reasoningSignature } : {}),
              }]
              : []),
          ];
      if (iterationBlocks.length > 0) {
        for (const block of iterationBlocks) {
          // Тот же общий хелпер, что у основного стрима: кумулятивный reasoning
          // не должен давать дубль при повторе в новой итерации.
          allSubagentReasoning = appendReasoningBlock(allSubagentReasoning, block.text, stepIteration, {
            ...(block.signature !== undefined ? { signature: block.signature } : {}),
            ...(block.redacted !== undefined ? { redacted: block.redacted } : {}),
          });
        }
        // Legacy-поля — только для одиночного блока (подпись принадлежит тексту).
        subagentReasoningMeta = allSubagentReasoning.length === 1
          ? {
            signature: allSubagentReasoning[0]!.signature,
            redacted: allSubagentReasoning[0]!.redacted ? [allSubagentReasoning[0]!.redacted] : undefined,
          }
          : undefined;
      }

      // Шаг-лимит: инструменты в запросе остались (кэш провайдера), но вызов
      // запрещён `toolChoice: 'none'`. Ответ мог прийти нестандартным — с
      // `toolCalls`; исполнять их НЕЛЬЗЯ, но пара assistant(tool_calls) → tool
      // сохраняется: ниже на каждый вызов пишется error-результат
      // `tool.disabled_by_step_limit` (паритет с opencode).

      if (!toolCalls || toolCalls.length === 0) {
        // Шаг-лимит — отчёт о проделанной работе. Пустой/пробельный ответ —
        // потерянный отчёт (работа выполнена), а не провал прогона: прогон
        // остаётся `completed` с маркером `task.steps_limit_empty`.
        if (stepLimitStep) {
          const reportText = accumulatedContent.trim();
          stepLimitReached = true;
          if (reportText) {
            finalContent = reportText;
            if (reasoning) subagentReasoning = reasoning;
            // Отчёт — финальный ответ саб-агента: в историю дочерней сессии
            // тем же путём, что и обычный финальный ответ (+ метка лимита шагов).
            // Отчёт — сообщение **этого** шага (tool calls в итерации не было),
            // поэтому id шага свободен и остаётся за ним. Статус — `limit`:
            // прогон остановлен по лимиту шагов (как у родителя).
            await persistChildAssistantMessage(reportText, { ...stepLimitMeta(), ...stepDurationMeta() }, stepMessageId, 'limit', stepUsage);
          } else {
            reportMissing = true;
            finalContent = sm('task.steps_limit_empty', { limit: stepLimitValue });
            // Детерминированный текст — в историю ребёнка: пустой отчёт иначе
            // оставлял дочернюю сессию без финального ответа вовсе.
            await persistChildAssistantMessage(finalContent, { ...stepLimitMeta(), ...stepDurationMeta() }, stepMessageId, 'limit', stepUsage);
          }
          break;
        }

        finalContent = accumulatedContent;
        if (reasoning) subagentReasoning = reasoning;

        // Сохранить финальный ответ ассистента в дочернюю сессию
        await persistChildAssistantMessage(accumulatedContent, stepDurationMeta(), stepMessageId, 'completed', stepUsage);
        break;
      }

      if (accumulatedContent) {
        allSubagentIntermediateTexts.push({ text: accumulatedContent, iteration });
      }

      iteration++;

      // Сохранить ответ ассистента с tool calls в дочернюю сессию
      if (childSessionId && extra.sessionManager) {
        try {
          const stepParts = [makeTextPart(accumulatedContent || ''), ...makeReasoningParts(iterationBlocks)];
          // Маркер `tool_chain` — только для сообщений БЕЗ видимого текста:
          // шаг с текстом — реальный ответ агента, и его нельзя скрывать от
          // транскрипта (после перезагрузки страницы ответ пропадает).
          // ADR-118 §1: отчёт ребёнка «монолитный» (несёт все размышления
          // прогона в финальном сообщении) — поэтому reasoning **не** считается
          // видимым контентом шага: шаг с одним лишь reasoning прячется, иначе
          // размышления дублировались бы (шаг + отчёт).
          const stepVisible = hasVisibleStepContent(accumulatedContent || '', stepParts, {
            includeReasoning: false,
          });
          const assistantMsg: Message = {
            id: stepMessageId,
            role: MessageRole.ASSISTANT,
            seq: 0,
            origin: 'local',
            parts: stepParts,
            content: accumulatedContent || '',
            createdAt: nowISO(),
            disabled: false,
            pinned: false,
            hidden: false,
            agentRole: subagentType,
            // ADR-118 §1/§5: шаг дочерней сессии — ход ребёнка = id дочерней
            // сессии, индекс своего шага, статус «шаг завершён» (результаты
            // инструментов приходят позже и ложатся в metadata.tool_results).
            turnId: childSessionId,
            stepIndex: stepIteration,
            status: 'completed',
            // ADR-102/ADR-118: расход **своего** шага — в сообщение шага;
            // сумма по сообщениям прогона = счётчики дочерней сессии.
            ...(stepUsage ? { usage: stepUsage } : {}),
            reasoning: reasoning || undefined,
            // Anthropic: подпись thinking-блока этой итерации (tool-loop
            // отвергается API, если thinking не возвращён в историю).
            ...(reasoningSignature !== undefined ? { reasoningSignature } : {}),
            ...(reasoningRedacted?.length ? { reasoningRedacted } : {}),
            // OpenAI-совместимая цепочка: assistant(toolCalls) → tool.
            // tool_chain=true — UI дочерней сессии скрывает промежуточные
            // сообщения (визуализация уже в финальном с tool_results).
            toolCalls,
            metadata: {
              stream_id: extra.streamId,
              ...(stepVisible ? {} : { tool_chain: true }),
              step_duration_ms: iterationDurationMs,
              ...(stepCost
                ? {
                    cost_usd: stepCost.costUsd,
                    cost_currency: stepCost.currency,
                    cost_breakdown: stepCost.breakdown,
                  }
                : {}),
            },
          };
          const updated = await extra.sessionManager.addMessage(childSessionId, assistantMsg);
          if (updated && extra.eventBus) {
            const idx = updated.messages.length - 1;
            await publishMessageAdded(extra.eventBus, parentSessionId, childSessionId, updated.messages[idx]!, idx, updated);
          }
        } catch {
          // не фатально
        }
      }

      messages.push({
        id: '',
        role: 'assistant',
        content: accumulatedContent || '',
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        disabled: false,
        pinned: false,
        branchId: '',
        toolUse: toolCalls,
        // Anthropic: thinking tool-loop-сообщения обязан вернуться в историю.
        reasoning: reasoning || undefined,
        reasoningBlocks: toLlmReasoningBlocks(iterationBlocks),
        reasoningSignature,
        reasoningRedacted,
      });

      for (const tc of toolCalls) {
        const tcId = (tc.id as string) || `subcall_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const func = tc.function as { name: string; arguments: string | Record<string, unknown> } | undefined;

        // Шаг-лимит (паритет с opencode): вызов запрещён `toolChoice: 'none'`,
        // но провайдер его вернул. Не исполняем — пишем парный error-результат,
        // чтобы assistant(tool_calls) не остался без `tool`.
        if (stepLimitStep) {
          const toolName = func?.name || 'unknown';
          const limitParams = { tool: toolName, limit: stepLimitValue };
          const limited: ToolResult = {
            content: sm('tool.disabled_by_step_limit', limitParams),
            isError: true,
            metadata: {
              i18n: i18nMeta('tool.disabled_by_step_limit', limitParams),
              isError: true,
            },
          };
          const tcStartedAt = new Date().toISOString();
          publishToolEvent('tool_call.result', {
            stream_id: extra.streamId,
            session_id: extra.sessionId,
            call_id: tcId,
            name: toolName,
            result: limited,
            iteration: stepIteration,
            parent_call_id: extra.callId,
          });
          allSubagentToolCalls.push({
            name: toolName,
            args: {},
            id: tcId,
            result: { content: limited.content, isError: true },
            started_at: tcStartedAt,
            completed_at: new Date().toISOString(),
            iteration: stepIteration,
          });
          messages.push({
            id: '', role: 'tool',
            content: limited.content,
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            disabled: false, pinned: false, branchId: '',
            toolCallId: tcId,
          });
          if (childSessionId && extra.sessionManager) {
            try {
              const toolResultMsg: Message = {
                id: generateId(),
                role: MessageRole.TOOL,
                seq: 0,
                origin: 'local',
                parts: [makeTextPart(limited.content)],
                content: limited.content,
                createdAt: nowISO(),
                disabled: false,
                pinned: false,
                hidden: false,
                toolCallId: tcId,
                metadata: {
                  ...(limited.metadata ?? {}),
                  stream_id: extra.streamId,
                  tool_chain: true,
                  tool_name: toolName,
                  args: {},
                },
              };
              const updated = await extra.sessionManager.addMessage(childSessionId, toolResultMsg);
              if (updated && extra.eventBus) {
                const idx = updated.messages.length - 1;
                await publishMessageAdded(extra.eventBus, parentSessionId, childSessionId, updated.messages[idx]!, idx, updated);
              }
            } catch {
              // не фатально
            }
          }
          continue;
        }

        if (!func?.name) continue;

        const toolName = func.name;
        let toolArgs: Record<string, unknown>;
        if (typeof func.arguments === 'string') {
          try { toolArgs = JSON.parse(func.arguments); } catch { toolArgs = {}; }
        } else {
          toolArgs = func.arguments || {};
        }

        const tcStartedAt = new Date().toISOString();

        const doomKey = `${toolName}:${JSON.stringify(toolArgs)}`;
        const doomCount = (doomTracker.get(doomKey) || 0) + 1;
        doomTracker.set(doomKey, doomCount);

        if (doomCount >= MAX_DOOM_LOOP_COUNT) {
          const doomMsg: LLMMessage = {
            id: '', role: 'tool',
            content: sm('tool.doom_loop', { tool: toolName, count: String(doomCount) }),
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            disabled: false, pinned: false, branchId: '',
            toolCallId: tcId,
          };
          messages.push(doomMsg);

          if (childSessionId && extra.sessionManager) {
            try {
              const toolResultMsg: Message = {
                id: generateId(),
                role: MessageRole.TOOL,
                seq: 0,
                origin: 'local',
                parts: [makeTextPart(doomMsg.content)],
                content: doomMsg.content,
                createdAt: nowISO(),
                disabled: false,
                pinned: false,
                hidden: false,
                toolCallId: tcId,
                metadata: {
                  stream_id: extra.streamId,
                  tool_chain: true,
                  tool_name: toolName,
                  args: toolArgs,
                },
              };
              const updated = await extra.sessionManager.addMessage(childSessionId, toolResultMsg);
              if (updated && extra.eventBus) {
                const idx = updated.messages.length - 1;
                await publishMessageAdded(extra.eventBus, parentSessionId, childSessionId, updated.messages[idx]!, idx, updated);
              }
            } catch {
              // не фатально
            }
          }
          continue;
        }

        publishToolEvent('tool_call.started', {
          stream_id: extra.streamId,
          session_id: extra.sessionId,
          call_id: tcId,
          name: toolName,
          arguments: toolArgs,
          iteration: stepIteration,
          // Вложенность внутренних вызовов саб-агента под блоком `task`
          // в родительском стриме (UI строит дерево по parent_call_id).
          parent_call_id: extra.callId,
        });

        const toolDef = extra.toolRegistry?.get(toolName);
        // Контекст исполнения тула — общий для веток ask(approved) и allow.
        const toolExecContext: ToolContext = {
          ...ctx,
          abortSignal: ctx.abortSignal,
          extra: extra as unknown as Record<string, unknown>,
        };
        let toolResult: ToolResult;
        let subagentUserDenied = false;

        // ADR-029: permission-check саб-агента — permissions дочерней сессии
        // (родитель + deny-дополнения) применяются к каждому tool_call.
        const permissionDecision = childEvaluator.check({
          toolName,
          params: toolArgs,
          workingDir: ctx.workingDir,
          // ADR-114: периметр дочерней сессии тот же, что у родителя (она
          // наследует рабочий каталог worktree) — корень проекта тоже «свой».
          ...(ctx.allowedRoots && ctx.allowedRoots.length > 0 ? { allowedRoots: ctx.allowedRoots } : {}),
          capabilities: toolDef?.capabilities,
          agentCapabilities: subagentDef?.capabilities,
          sessionMode: childSessionMode,
          planMode: childPlanMode,
          planApproved: childPlanApproved,
          mcpToolSettings: childMcpToolSettings,
          shellPolicy: extra.shellPolicy ?? undefined,
          protectedPaths: extra.protectedPaths ?? undefined,
          protectedPathsEnabled: extra.protectedPathsEnabled,
          // ADR-070 §2.9.1: зависимость окружения (git/rg/sh) — как у родителя.
          runtimeDeps: extra.runtimeDeps,
          // ADR-075: гейт рабочего каталога проекта — как у родителя.
          workspaceReady: extra.workspaceReady,
        });

        if (permissionDecision.action === 'deny') {
          toolResult = buildDenyResult({
            reason: permissionDecision.reason,
            matchedRule: permissionDecision.matchedRule,
            messageId: permissionDecision.messageId,
            params: permissionDecision.params as Record<string, string> | undefined,
            contextConfig: extra.contextConfig,
          });
        } else if (permissionDecision.action === 'ask') {
          // ask публикуется в родительскую сессию (extra.sessionId) —
          // пользователь основной сессии видит запрос и отвечает.
          const approvalAskReason = extra.contextConfig && permissionDecision.messageId
            ? (extra.contextConfig.getSecurityMessage(permissionDecision.messageId, 'en', permissionDecision.params)
              ?? permissionDecision.reason)
            : permissionDecision.reason;
          // ADR-029 (аддитивно): превью изменений — как в основном ходе:
          // пользователь видит, ЧТО именно саб-агент собирается изменить.
          const preview = await buildPermissionPreview({
            toolName,
            args: toolArgs,
            workingDir: ctx.workingDir,
            secretsMap: await loadSubagentSecretsMap(extra),
          });
          const approval = await childApprovalManager.waitForDecision(
            extra.sessionId!,
            {
              approvalId: `approval_${tcId}`,
              callId: tcId,
              toolName,
              arguments: toolArgs,
              reason: approvalAskReason,
              ...(preview ? { preview } : {}),
            },
            derivedPermission.askTimeoutMs,
          );
          if (approval.approved) {
            if (approval.once === false) {
              // «Разрешить в сессии» — allow-правило в permissions дочерней сессии
              derivedPermission.rules[toolName] = 'allow';
              if (childSessionId && extra.sessionManager) {
                try {
                  const child = await extra.sessionManager.getSession(childSessionId);
                  if (child) {
                    child.settings.permission = { ...derivedPermission };
                    await extra.sessionManager.updateSession(child);
                  }
                } catch {
                  // не фатально
                }
              }
            }
            if (toolDef) {
              toolResult = await executeToolDef(toolDef, toolArgs, toolExecContext, toolName);
            } else {
              toolResult = {
                content: sm('tool.not_found', { tool: toolName }),
                isError: true,
                metadata: { i18n: i18nMeta('tool.not_found', { tool: toolName }) },
              };
            }
          } else {
            const why = approval.timeout
              ? sm('permission.ask_timeout')
              : approval.noSubscribers
                ? sm('permission.ask_no_subscribers')
                : sm('permission.ask_denied');
            toolResult = buildDenyResult({
              reason: permissionDecision.reason,
              matchedRule: permissionDecision.matchedRule,
              messageId: permissionDecision.messageId,
              params: permissionDecision.params as Record<string, string> | undefined,
              contextConfig: extra.contextConfig,
              contentSuffix: ` (${why})`,
              defaultI18n: false,
            });
            subagentUserDenied = !approval.timeout && !approval.noSubscribers;
          }
        } else {
          // allow — обычное выполнение
          if (toolDef) {
            toolResult = await executeToolDef(toolDef, toolArgs, toolExecContext, toolName);
          } else {
            toolResult = {
              content: sm('tool.not_found', { tool: toolName }),
              isError: true,
              metadata: { i18n: i18nMeta('tool.not_found', { tool: toolName }) },
            };
          }
        }

        publishToolEvent('tool_call.result', {
          stream_id: extra.streamId,
          session_id: extra.sessionId,
          call_id: tcId,
          name: toolName,
          result: toolResult,
          iteration: stepIteration,
          parent_call_id: extra.callId,
        });

        allSubagentToolCalls.push({
          name: toolName,
          args: toolArgs,
          id: tcId,
          result: { content: toolResult.content, isError: toolResult.isError },
          started_at: tcStartedAt,
          completed_at: new Date().toISOString(),
          iteration: stepIteration,
        });

        const toolResultLLMMsg: LLMMessage = {
          id: '', role: 'tool',
          content: toolResult.content,
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          disabled: false, pinned: false, branchId: '',
          toolCallId: tcId,
        };
        messages.push(toolResultLLMMsg);

        // Сохранить tool_result в дочернюю сессию
        if (childSessionId && extra.sessionManager) {
          try {
            const toolResultMsg: Message = {
              id: generateId(),
              role: MessageRole.TOOL,
              seq: 0,
              origin: 'local',
              parts: [makeTextPart(toolResult.content)],
              content: toolResult.content,
              createdAt: nowISO(),
              disabled: false,
              pinned: false,
              hidden: false,
              toolCallId: tcId,
              metadata: {
                stream_id: extra.streamId,
                tool_chain: true,
                tool_name: toolName,
                args: toolArgs,
              },
            };
            const updated = await extra.sessionManager.addMessage(childSessionId, toolResultMsg);
            if (updated && extra.eventBus) {
              const idx = updated.messages.length - 1;
              await publishMessageAdded(extra.eventBus, parentSessionId, childSessionId, updated.messages[idx]!, idx, updated);
            }
          } catch {
            // не фатально
          }
        }

        // ADR-029 (обновлено 2026-10-29): отказ (в т.ч. ask→deny) больше не
        // обрывает цикл — модель получает `tool_result` и может выбрать другой
        // инструмент. Флаг нужен только для фоллбек-текста `task.stopped_by_deny`,
        // если содержательного ответа не будет.
        if (subagentUserDenied) {
          subagentDenied = true;
        }
      }

      // Шаг-лимит: вызовы не исполнялись — цикл завершаем отчётом (механика
      // opencode). Парные tool-результаты выше уже в истории дочерней сессии.
      if (stepLimitStep) {
        const reportText = accumulatedContent.trim();
        stepLimitReached = true;
        if (reportText) {
          finalContent = reportText;
          if (reasoning) subagentReasoning = reasoning;
          // Отчёт — **новая** запись: assistant(tool_calls) этого шага уже
          // сохранён с id `stepMessageId`, поэтому отчёт получает свой id
          // (иначе в истории ребёнка были бы две записи с одним id, а UI
          // пропустил бы сообщение с уже занятым id — live-отчёт не появился бы).
          await persistChildAssistantMessage(reportText, { ...stepLimitMeta(), ...stepDurationMeta() }, undefined, 'limit', undefined, Math.max(0, iteration - 1));
        } else {
          reportMissing = true;
          finalContent = sm('task.steps_limit_empty', { limit: stepLimitValue });
          await persistChildAssistantMessage(finalContent, { ...stepLimitMeta(), ...stepDurationMeta() }, undefined, 'limit', undefined, Math.max(0, iteration - 1));
        }
        break;
      }

      publish?.('tool_call.loop', {
        stream_id: extra.streamId,
        session_id: extra.sessionId,
        iteration: stepIteration,
        total_tool_calls: toolCalls.length,
      });
    }

    // Отмена до/после цикла (например сигнал уже абортирован на входе или
    // пришёл во время исполнения тулов саб-агента) — тот же протокол
    // прерывания, что и при отмене во время стрима.
    if (isAborted()) {
      return await finishAborted('', '');
    }

    if (subagentDenied && !finalContent) {
      finalContent = sm('task.stopped_by_deny');
    }

    const output = finalContent || sm('task.empty_response');
    // `[steps_limit]` — страховка (модель могла проигнорировать требование):
    // короткая причина + лимит, идёт ПОСЛЕ отчёта и не дублирует его.
    const stepsLimitBlock = stepLimitReached
      ? `\n\n${sm('task.steps_limit', { limit: stepLimitValue })}`
      : '';

    // ─── Quality check результата саб-агента (ADR-034 Фаза 4) ─────
    let qaPass: boolean | undefined;
    let qaReason: string | undefined;
    let qualityOutput = output;
    const escalationCfg = extra.routerConfig?.escalation;
    const sessionEscalation = extra.parentSessionSettings?.routingEscalation;
    const escalationEnabled = sessionEscalation?.enabled ?? escalationCfg?.enabled ?? false;

    if (extra.modelRouter && escalationEnabled && finalContent && routingDecisionInfo && !contextBudgetExceeded) {
      try {
        const qaResult = await extra.modelRouter.checkQuality(finalContent, {
          providerName: routingDecisionInfo.providerName,
          modelName: routingDecisionInfo.modelName,
          reason: routingDecisionInfo.strategy,
          strategy: routingDecisionInfo.strategy,
        }, extra.parentSessionSettings);
        qaPass = qaResult.pass;
        qaReason = qaResult.reason;
        // ADR-102: self-check — aux-вызов саб-агента; включаем в его суммарный
        // usage (счётчики ребёнка и `subagent_usage` родителя), без отдельной
        // записи аналитики — иначе двойной счёт через `subagent_usage`.
        if (qaResult.usage) accumulateUsage(qaResult.usage);

        // Пометить QA-информацию в дочерней сессии
        if (childSessionId && extra.sessionManager) {
          try {
            const childSession = await extra.sessionManager.getSession(childSessionId);
            if (childSession) {
              const lastAssistantMsg = [...childSession.messages].reverse()
                .find(m => m.role === MessageRole.ASSISTANT);
              if (lastAssistantMsg) {
                lastAssistantMsg.qa_pass = qaResult.pass;
                lastAssistantMsg.qa_reason = qaResult.reason;
                await extra.sessionManager.updateSession(childSession);
              }
            }
          } catch {
            // не фатально
          }
        }

        // Эскалация на fallback-модель при FAIL
        if (!qaResult.pass) {
          const fallbackProvider = sessionEscalation?.fallbackProvider || escalationCfg?.fallbackProvider;
          const fallbackModel = sessionEscalation?.fallbackModel || escalationCfg?.fallbackModel;
          if (fallbackProvider && fallbackModel && extra.modelRouter) {
            const fbDecision = {
              providerName: fallbackProvider,
              modelName: fallbackModel,
              reason: 'escalation_fallback',
              strategy: 'default',
            };
            // Без sampling — прежняя арность вызова пула.
            const fbEffectiveProvider = (config.topP !== undefined || config.topK !== undefined)
              ? extra.modelRouter.getProvider(
                fbDecision, config.temperature, undefined, undefined, undefined, config.topP, config.topK,
              )
              : extra.modelRouter.getProvider(fbDecision, config.temperature);
            if (fbEffectiveProvider) {
              try {
                // Перевызываем с fallback-моделью (только последний user-запрос);
                // system — вторым аргументом chat, в messages его нет (ADR-070 §1.5).
                const fbMessages: LLMMessage[] = [];
                const userMsg = messages.find(m => m.role === 'user');
                if (userMsg) fbMessages.push(userMsg);
                const fbResponse = await fbEffectiveProvider.chat(
                  fbMessages,
                  llmSystemPrompt || undefined,
                  undefined,
                  false,
                );
                if (fbResponse.content) {
                  finalContent = fbResponse.content;
                  qualityOutput = fbResponse.content;
                  qaPass = true;
                  qaReason = sm('router.escalation', { provider: fallbackProvider, model: fallbackModel, reason: qaResult.reason });
                  // ADR-102: эскалация — ещё один aux-вызов саб-агента в его
                  // суммарный usage (раньше терялся).
                  if (fbResponse.usage) accumulateUsage(fbResponse.usage);
                  routingDecisionInfo = {
                    providerName: fallbackProvider,
                    modelName: fallbackModel,
                    strategy: 'escalation_fallback',
                  };
                }
              } catch {
                // fallback не удался, оставляем оригинальный ответ
              }
            }
          }
        }
      } catch {
        // QA не удался, не блокируем
      }
    }

    // ADR-104 (решение 2026-10-28): границы шага больше не будет — остаток
    // очереди инъекций ребёнка снимаем до финализации (общая точка для
    // обычного завершения, шаг-лимита и бюджета контекста).
    await dropChildSteerInjections();

    // Финализировать дочернюю сессию
    await commitChildUsage();
    await finalizeChildSession('completed');

    // ─── Формирование результата tool_result ──────────────────────
    const qualityBlock = qaPass !== undefined
      ? `<quality pass="${qaPass}" reason="${qaReason || ''}"/>\n`
      : '';
    const routedByBlock = routingDecisionInfo && routingDecisionInfo.strategy !== 'default'
      ? `<routed_by strategy="${routingDecisionInfo.strategy}" provider="${routingDecisionInfo.providerName}" model="${routingDecisionInfo.modelName}"/>\n`
      : '';
    const qaWarningText = qaPass === false
      ? `\n\n⚠️ Response failed the quality check: ${qaReason || 'unknown reason'}`
      : '';
    // ID дочерней сессии в content — родительская модель может прочитать
    // историю саб-агента тулом read_session_reference.
    const childSessionBlock = childSessionId
      ? `<child_session_id>${childSessionId}</child_session_id>\n`
      : '';

    // ADR-030: `agent_completed` — неблокирующий эмит успешного завершения
    // саб-агента (result — итоговый ответ).
    if (extra.hooks && childSessionId) {
      extra.hooks.emitAsync('agent_completed', {
        agentId: childSessionId,
        result: qualityOutput,
      });
    }

    return {
      content: `<task_result>\n<summary>${description}</summary>\n${qualityBlock}${routedByBlock}${childSessionBlock}\n${qualityOutput}${qaWarningText}${stepsLimitBlock}\n</task_result>`,
      metadata: {
        subagent_type: subagentType,
        description: description,
        context_mode: contextMode,
        steps: iteration,
        child_session_id: childSessionId,
        // Этап 1 roadmap 0.13 (блок 4): саб-агент остановлен по лимиту шагов.
        ...(stepLimitReached ? { step_limit_reached: true, step_limit: Number(stepLimitValue) } : {}),
        // Отчёт по лимиту шагов не получен (пустой/пробельный ответ) — прогон
        // успешен, но текстового отчёта нет: для диагностики и родительской модели.
        ...(reportMissing ? { report_missing: true } : {}),
        // Предохранитель бюджета контекста: прогон завершён детерминированным
        // отчётом (статус `completed`), работа частично сделана.
        ...(contextBudgetExceeded
          ? { context_budget_exceeded: true, context_budget_tokens: contextBudgetTokens }
          : {}),
        reasoning: subagentReasoning || undefined,
        reasoning_blocks: allSubagentReasoning.length > 0 ? allSubagentReasoning : undefined,
        intermediate_text_blocks: allSubagentIntermediateTexts.length > 0 ? allSubagentIntermediateTexts : undefined,
        tool_calls: allSubagentToolCalls.length > 0 ? allSubagentToolCalls : undefined,
        final_content: finalContent || undefined,
        qa_pass: qaPass,
        qa_reason: qaReason || undefined,
        routing_strategy: routingDecisionInfo?.strategy,
        routing_provider: routingDecisionInfo?.providerName,
        routing_model: routingDecisionInfo?.modelName,
        // ADR-070 §2.6: per-message статистика сабагентов (попап сообщения).
        subagent_usage: subagentUsage,
        subagent_model: subagentModel,
      },
    };
  } catch (err: unknown) {
    // Жёсткий сбой вне штатных веток: дочерняя сессия не финализировалась, но
    // live-ход в UI нужно закрыть и маркер активности снять — иначе открытая
    // дочерняя сессия навсегда осталась бы «идёт» (ADR-118 §10).
    publishChildEvent('turn.finished', { turnId: childSessionId ?? '', status: 'error' });
    if (childSessionId && extra.sessionManager) {
      try {
        await extra.sessionManager.withLock(childSessionId, async (s) => {
          if (s.currentStream?.streamId !== runStreamId()) return;
          s.currentStream = undefined;
          await extra.sessionManager!.saveSession(s);
        });
      } catch {
        // маркер не снялся — терминальное событие уже опубликовано
      }
    }
    if (childSessionId && extra.eventBus) {
      extra.eventBus.publish(childSessionId, 'stream.ended', {
        session_id: childSessionId,
        stream_id: extra.streamId,
      });
    }
    // ADR-030: `agent_failed` — неблокирующий эмит жёсткого сбоя саб-агента.
    if (extra.hooks && childSessionId) {
      extra.hooks.emitAsync('agent_failed', {
        agentId: childSessionId,
        error: String(err),
      });
    }
    return {
      content: sm('task.subagent_exec_error', { type: subagentType, error: String(err) }),
      isError: true,
      metadata: { subagent_type: subagentType },
    };
  } finally {
    // ADR-104: очередь инъекций ребёнка снимается в **любом** терминальном
    // пути прогона (нормальный выход, ошибка провайдера, отмена, жёсткий
    // сбой) — иначе остаток «протекает» в следующий ход ребёнка. Повторный
    // вызов безопасен (очередь снимается один раз).
    await dropChildSteerInjections('turn_ended');
  }
}

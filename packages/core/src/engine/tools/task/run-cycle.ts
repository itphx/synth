/**
 * Общий цикл выполнения саб-агента (tool-loop со стримом, retry LLM-вызова,
 * permissions дочерней сессии, отмена, quality check/эскалация).
 *
 * Общий для тула `task` и для возобновления прерванной дочерней сессии
 * (`task-resume.ts`). ADR-095 (шаг 5): вынесено из `task.ts` без изменения
 * поведения.
 */
import { MessageRole, nowISO, generateId, generateStreamId, makeTextPart, appendReasoningBlock, effortForReasoningLevel } from '@itphx/synth-shared';
import type { Message, ReasoningBlock, SessionMode, PlanMode, TokenUsage, ToolContext, ToolForLLM, ToolResult, ToolDefinition, LLMReasoningBlock, ReasoningLevel, EffortLevel, MessageDeliveredPayload, StepFinishedPayload, EventType, PermissionDecision, TodoItem, LlmFinishReason, PermissionConfig } from '@itphx/synth-shared';
import type { BaseProvider, LLMMessage, CancellationToken } from '../../../providers/base.js';
import { buildChatOptions } from '../../../providers/base.js';
import { EventBus } from '../../../events/bus.js';
import { buildDenyResult, executeToolDef } from '../tool-execution.js';
import { errorText } from '../error-text.js';
import { runToolBatch, type ToolBatchOutcome } from '../tool-batch.js';
import { classifyLlmErrorFor, isLlmErrorRecoverable, LLM_MAX_ATTEMPTS, LLM_RETRY_DELAYS_MS, MAX_DOOM_LOOP_COUNT } from '../../llm-error.js';
import { computeUsageCost } from '../../../providers/usage.js';
import type { UsageCost } from '../../../providers/usage.js';
import { applySubagentRoleDenies } from '../../permission/derive.js';
import { resolveEffectivePermission } from '../../permission/effective.js';
import type { PermissionChainSession } from '../../permission/effective.js';
import { PermissionEvaluator, isPlanRestricted, type PermissionCheckInput } from '../../permission/evaluator.js';
import {
  PermissionApprovalManager,
  type ApprovalRequest,
  type ApprovalWaiter,
} from '../../permission/approval.js';
import { buildPermissionPreview } from '../../permission/preview.js';
import type { PermissionDecisionAuditEvent } from '../../permission/permission-audit.js';
import { ObfuscationMapStore } from '../../gateway/obfuscation-map-store.js';
import { estimatePromptChars, estimateTokens } from '../../context/token-ratio.js';
import { buildMaxStepsPrompt, maxStepsAssistantMessage } from '../../llm/max-steps.js';
import { t as sm, i18n as i18nMeta } from '../../system-messages.js';
import { debug, info, warning } from '../../../logger.js';
import { createChildSessionLifecycle, publishMessageAdded } from './child-session.js';
import { resumeInitialMessages } from './resume-target.js';
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
import {
  tryCompactChildSession,
  MAX_SUBAGENT_MID_TURN_COMPRESSIONS,
} from './child-compaction.js';
import { applySteerInjections, dropSteerInjections } from '../../steering/apply.js';
import { makeReasoningParts, toLlmReasoningBlocks, type ReasoningBlockLike } from '../../reasoning-blocks.js';
import { hasVisibleStepContent } from '../../orchestrator/persistence.js';
import type { AssistantMessageStatus } from '../../orchestrator/persistence.js';
import { appendStopRecord } from '../../stop-record.js';
import type { StopRecordInput } from '../../stop-reason.js';
import {
  buildOutputLimitNotice,
  isOutputLimitFinish,
  MAX_OUTPUT_LIMIT_CONTINUATIONS,
  MAX_OUTPUT_LIMIT_STREAK,
  OUTPUT_LIMIT_NOTICE_TYPE,
} from '../../output-limit-notice.js';
import { requeueMessages } from '../../../queue/processor.js';
import { resetRecoveryState } from '../../../sessions/recovery.js';
import { renderTodosSection } from '../todo.js';
// ADR-041 × opencode `tool.input-incomplete`: аргументы tool-call'а, оборванные
// лимитом вывода, не исполняются — модели возвращается причина с подсказкой.
import { inputIncompleteResult, isIncompleteToolCall } from '../incomplete-call.js';
import { applyToolContentFilter } from '../../security/tool-content.js';
import { resolveBrowserProfile } from '../../../execution/profile-binding.js';
import type { ContextMode, SubagentRetryConfig, TaskExtra } from './types.js';

/** Retry саб-агента: максимум попыток LLM-вызова (единая политика — LLM_MAX_ATTEMPTS). */
export const SUBAGENT_MAX_ATTEMPTS = LLM_MAX_ATTEMPTS;
/** Backoff между попытками (единая политика — LLM_RETRY_DELAYS_MS). */
export const SUBAGENT_RETRY_DELAYS_MS = LLM_RETRY_DELAYS_MS;
/**
 * Максимум попыток на **пустой финальный ответ** модели (ADR-041 × PROP-143).
 *
 * Отдельный счётчик (не `LLM_MAX_ATTEMPTS` провайдерного пути): пустой ответ —
 * не ошибка транспорта, а результат, который надо диагностировать и попросить
 * модель исправить. Повтор считается **циклом**, провайдерный retry-путь для
 * класса `empty_completion` не тратит попытки (иначе получилось бы 3×3 вызовов).
 */
export const SUBAGENT_EMPTY_RESPONSE_MAX_ATTEMPTS = LLM_MAX_ATTEMPTS;

/**
 * ADR-118 §1: запись вызова инструмента — одна и та же форма у
 * `allSubagentToolCalls` (сводка вызовов прогона в `task`-результате) и у
 * `metadata.tool_results` сообщения **своего** шага ребёнка (карточки
 * инструментов в ленте дочерней сессии).
 */
type SubagentToolCallRecord = {
  name: string;
  args: Record<string, unknown>;
  id?: string;
  result?: { content: string; isError?: boolean };
  started_at?: string;
  completed_at?: string;
  iteration: number;
};

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

/**
 * Список задач дочерней сессии (ADR-039) — источник секции `<todos>` в
 * результате прогона. Ошибка/отсутствие сессии не фатальны: пустой список
 * (секция просто не добавляется).
 */
async function readChildTodos(
  sessionManager: TaskExtra['sessionManager'],
  childSessionId: string | undefined,
): Promise<TodoItem[]> {
  if (!sessionManager || !childSessionId) return [];
  try {
    const child = await sessionManager.getSession(childSessionId);
    return child?.todos ?? [];
  } catch {
    return [];
  }
}

/**
 * IPI: слой фильтрации контента инструмента в цикле саб-агента.
 *
 * Гейт — `securityConfig.promptInjection.enabled` **и** заданный словарь;
 * без зависимости поведение прежнее (fail-open — прогон идёт как раньше).
 * Слой общий с основным ходом и шагом пайплайна
 * (`engine/security/tool-content.ts`), своей копии логики здесь нет.
 */
function applySubagentContentFilter(
  extra: TaskExtra,
  toolName: string,
  args: Record<string, unknown>,
  result: ToolResult,
  ctx: ToolContext,
): ToolResult {
  const config = extra.securityConfig?.promptInjection;
  if (!config?.enabled || !extra.dictionaryStore) return result;
  const filtered = applyToolContentFilter({
    toolName,
    toolDef: extra.toolRegistry?.get(toolName),
    args,
    content: result.content,
    isError: result.isError === true,
    metadata: result.metadata,
    workingDir: ctx.workingDir,
    allowedRoots: ctx.allowedRoots,
    config,
    dictionaryStore: extra.dictionaryStore,
    language: extra.language ?? 'ru',
  });
  return {
    ...result,
    content: filtered.content,
    isError: filtered.isError,
    ...(filtered.metadata !== undefined ? { metadata: filtered.metadata } : {}),
  };
}

/**
 * `metadata` результата по списку todo: полный массив (без капа — данные для
 * UI/аналитики) и числа пунктов. Пустой список → пустой объект (поля не
 * появляются, поведение прежнее).
 */
function todoMetadata(todos: TodoItem[]): Record<string, unknown> {
  if (todos.length === 0) return {};
  return {
    todos,
    todos_total: todos.length,
    todos_unfinished: todos.filter(
      (todo) => todo.status === 'pending' || todo.status === 'in_progress',
    ).length,
  };
}

/**
 * Сброс бюджета автовосстановления дочерней сессии (PROP-142 §3): успешный
 * финал прогона закрывает ход ребёнка — «попытки на ход» не должны копиться
 * между прогонами (иначе после нескольких нормальных прогонов автовосстановление
 * ребёнка упёрлось бы в бюджет).
 *
 * Счётчик живёт в `status.recovery` метаданных сессии; сброс — точечная
 * мутация (`resetRecoveryState`, ADR-144). Поля нет — записи не происходит
 * (сброс идемпотентен), ошибка — предупреждение в лог: успешный прогон
 * ребёнка не должен из-за этого падать.
 */
async function resetChildRecoveryBudget(
  sessionManager: TaskExtra['sessionManager'],
  childSessionId: string | undefined,
): Promise<void> {
  if (!sessionManager || !childSessionId) return;
  try {
    await resetRecoveryState(sessionManager, childSessionId);
  } catch (err) {
    warning(
      'TASK',
      `сброс бюджета восстановления ребёнка ${childSessionId} не выполнен: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * PROP-127 (этап T3): план одного вызова инструмента в цикле саб-агента.
 *
 * - `step-limit` — вызов, запрещённый лимитом шагов: результат публикуется и
 *   пишется в историю, но `tool_call.started` **не** публикуется (вызов не
 *   исполнялся) — поведение прежнее.
 * - `doom` — вызов, остановленный защитой от зацикливания: в историю пишется
 *   парный tool-результат, но события не публикуются и в `tool_calls` вызов
 *   не попадает — поведение прежнее.
 * - `resolved` — вызов, решённый без исполнения (отказ прав, отсутствующий
 *   тул): результат известен, общий хвост фазы фиксации выполняется.
 * - `ask` — вызов, ждущий подтверждения пользователя (PROP-127 T5): решение
 *   принимается в параллельной фазе, затем вызов становится `execute`
 *   (одобрен) или `resolved` (отказ/таймаут/каскад).
 * - `execute` — вызов, исполняемый в фазе исполнения батча; у него свой
 *   `ToolContext` и свой исполнитель.
 */
interface SubagentToolPlanBase {
  /** id вызова — привязка результата, пары assistant→tool и событий. */
  tcId: string;
  /** Имя тула в событии и истории. */
  name: string;
  /** Аргументы вызова (в истории/метаданных). */
  args: Record<string, unknown>;
  /** Момент публикации `tool_call.started` — в `tool_calls.started_at`. */
  startedAt: string;
  /**
   * Вызов изменил правила прав ребёнка («Разрешить в сессии») — **барьер**:
   * следующий вызов обязан видеть новое правило, поэтому он готовится уже
   * после фиксации этого вызова.
   */
  grantsSession: boolean;
}

type SubagentToolPlan =
  | (SubagentToolPlanBase & { kind: 'step-limit'; result: ToolResult })
  // Результат известен без исполнения и без аргументов: аргументы вызова
  // оборваны лимитом вывода (`tool.input_incomplete`, ADR-041).
  | (SubagentToolPlanBase & { kind: 'short-circuit'; result: ToolResult })
  | (SubagentToolPlanBase & { kind: 'doom'; content: string })
  | (SubagentToolPlanBase & { kind: 'resolved'; result: ToolResult; userDenied: boolean })
  | (SubagentToolPlanBase & {
      kind: 'ask';
      /** Ожидание подтверждения (публикуется и ждётся в параллельной фазе). */
      waiter: ApprovalWaiter;
      /** Запрос подтверждения — публикуется как `permission.asked`. */
      approval: ApprovalRequest;
      /** Вход проверки прав — переоценка после гранта «в сессии». */
      checkInput: PermissionCheckInput;
      /** Решение permission-слоя — для текста отказа. */
      permissionDecision: PermissionDecision;
      /** Исполнитель вызова (тот же, что у `execute`). */
      run: () => Promise<ToolResult>;
    })
  | (SubagentToolPlanBase & { kind: 'execute'; run: () => Promise<ToolResult> });

/**
 * ADR-029 (chain-no-copy): эффективные правила прав дочернего прогона.
 *
 * Живой резолв по цепочке `parentId` — от сессии ребёнка (если дочерней сессии
 * нет — от родительской) к корню; `fallback` — конфиг инстанса
 * (`extra.permissionConfig`). Копии правил родителя в сессии ребёнка больше
 * нет: поэтому грант/отзыв у родителя виден ребёнку со следующего прогона, а
 * `deny`-дополнения роли добавляет `deriveSubagentPermission` **после**
 * резолва.
 *
 * Отсутствие менеджера/сессии и ошибка загрузки не фатальны: резолвер работает
 * с тем, что удалось собрать (fail-open, как и в основной сессии).
 */
async function resolveChildEffectivePermission(
  extra: TaskExtra,
  childSessionId?: string,
): Promise<PermissionConfig> {
  const manager = extra.sessionManager;
  const startId = childSessionId ?? extra.sessionId;
  const getSession = (id: string): Promise<PermissionChainSession | null> => (
    manager ? manager.getSession(id) : Promise.resolve(null)
  );
  let session: PermissionChainSession | null = null;
  if (startId) {
    try {
      session = await getSession(startId);
    } catch {
      // не фатально — считаем от fallback'а инстанса
    }
  }
  return resolveEffectivePermission({
    session: session ?? { id: startId ?? 'subagent-inline', settings: {} },
    getSession,
    ...(extra.permissionConfig ? { fallback: extra.permissionConfig } : {}),
  });
}

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

  // ─── Permissions дочерней сессии (ADR-029): живое наследование по цепочке `parentId` ──
  // Правила родителя не копируются в ребёнка: они читаются сейчас по цепочке,
  // а `applySubagentRoleDenies` добавляет только `deny`-дополнения роли.
  const derivedPermission = applySubagentRoleDenies(
    await resolveChildEffectivePermission(extra, childSessionId),
  );

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

  /**
   * PROP-143: ключ идемпотентности durable-записи причины остановки.
   *
   * Обычно — `streamId` прогона (`extra.streamId`): повторный терминальный
   * статус того же прогона второй записи не добавляет. `streamId` не задан
   * (вызов без хода родителя) — ключ прогон-специфичный: следующий прогон
   * (resume) получает свою запись, а повтор внутри прогона — нет.
   */
  const stopDedupeKey = extra.streamId ?? `subagent-run:${generateId()}`;

  /**
   * PROP-143: durable-запись причины остановки прогона саб-агента.
   *
   * Запись живёт в истории **дочерней** сессии — там, где остановка и
   * случилась: без неё факт остановки виден только в tool_result родителя и
   * пропадает после reload. Формат записи — общий нормализатор
   * (`engine/stop-reason.ts`), писатель — общий (`engine/stop-record.ts`).
   *
   * Нет дочерней сессии (чистый `none`-контекст) — записи нет: писать некуда.
   * Ошибка записи **не ломает прогон** (остановка уже состоялась — её фиксация
   * best-effort).
   */
  const writeStopRecord = async (input: StopRecordInput): Promise<void> => {
    const sessionManager = extra.sessionManager;
    if (!childSessionId || !sessionManager) return;
    try {
      await appendStopRecord({
        sessionManager,
        ...(extra.eventBus ? { eventBus: extra.eventBus } : {}),
        sessionId: childSessionId,
        input: {
          ...input,
          provider: input.provider ?? effectiveProvider?.name,
          model: input.model ?? subagentModel,
          agentRole: input.agentRole ?? subagentType,
          // Ход ребёнка = id дочерней сессии (так же, как в `turn.started`/
          // `step.started` ребёнка).
          turnId: childSessionId,
          streamId: extra.streamId,
        },
        dedupeKey: stopDedupeKey,
      });
    } catch (err) {
      warning(
        'SUBAGENT',
        `Не удалось записать причину остановки: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

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
  // Права ребёнка — эффективные правила прогона: живой резолв по цепочке
  // `parentId` (`resolveChildEffectivePermission`) + `deny`-дополнения роли
  // (`deriveSubagentPermission`).
  // ask-запросы публикуются в EventBus РОДИТЕЛЬСКОЙ сессии — подтверждение
  // видит пользователь основной сессии, approval_id связывает ответ.
  const childEvaluator = new PermissionEvaluator(derivedPermission);
  const childApprovalManager = new PermissionApprovalManager(extra.eventBus ?? new EventBus(), {
    // Журнал решений по подтверждениям (`scope:'permission'`): тот же шов, что
    // у оркестратора, — все исходы ожидания ребёнка (ответ/таймаут/каскад/
    // отмена/переоценка грантом) уезжают в журнал инстанса. Запись идёт в
    // **родительскую** сессию: ask'и ребёнка публикуются именно туда.
    ...(extra.permissionAudit && extra.sessionId
      ? { onDecision: (event: PermissionDecisionAuditEvent) => extra.permissionAudit!.decision(event) }
      : {}),
  });
  // ADR-070 §2.9.1: ролевые ограничения саб-агента — через unavailable(role),
  // а не скрытием тулов; capabilities нужны permission-слою.
  const subagentDef = extra.agentRegistry?.get(subagentType);
  let childSessionMode: SessionMode = 'act';
  let childPlanApproved = false;
  let childPlanMode: PlanMode = 'auto';
  let childMcpToolSettings: Record<string, import('@itphx/synth-shared').McpServerToolSettings> | undefined;
  /** Настройки дочерней сессии (нужны браузерному контуру профилей). */
  let childSessionSettings: import('@itphx/synth-shared').SessionSettings | undefined;
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
        childSessionSettings = child.settings;
        childUserMessageId = child.messages.find((m) => m.role === MessageRole.USER)?.id;
      }
    } catch {
      // не фатально — остаёмся в act/auto
    }
  }

  // PROP-135 (браузерный контур): браузерный профиль прогона ребёнка —
  // отдельный контур (сессия ребёнка → его агент → проект → дефолт инстанса).
  // Каталог известен — считаем по роли ребёнка; неизвестен (inline/instance) —
  // наследуем вычисленное родителем значение (прежнее поведение).
  let childBrowserProfile = extra.executionBrowserProfile;
  const browserCatalog = extra.executionBrowserProfileCatalog;
  if (browserCatalog) {
    let browserProject: Awaited<ReturnType<NonNullable<TaskExtra['projectStore']>['load']>> | undefined;
    if (ctx.projectId && extra.projectStore) {
      try {
        browserProject = (await extra.projectStore.load(ctx.projectId)) ?? undefined;
      } catch {
        // не фатально: без проекта работает потолок агента и дефолт инстанса
      }
    }
    const resolution = resolveBrowserProfile({
      sessionProfile: childSessionSettings?.browserProfile,
      agentProfile: subagentDef?.browserProfile,
      agentAllowed: subagentDef?.allowedBrowserProfiles,
      projectProfile: browserProject?.executor?.browserProfile,
      projectAllowed: browserProject?.executor?.allowedBrowserProfiles,
      defaultProfile: browserCatalog.defaultProfile,
      knownProfiles: browserCatalog.profiles,
    });
    if (resolution.warning) warning('SUBAGENT', resolution.warning);
    childBrowserProfile = resolution.profile || undefined;
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
      // Точечная метка активности: `withLock`+`saveSession` писал снимок и мог
      // затереть параллельные точечные записи истории. Чужой маркер (например,
      // прогон уже переведён в фон с другим `streamId`, ADR-111 §detach) не
      // перетираем — иначе UI ребёнка потеряет живую часть прогона; на чужом
      // маркере строка не пишется (`shouldWrite`). `touchUpdatedAt:false` —
      // маркер служебный (паритет с прежним `saveSession`).
      await extra.sessionManager.mutateMeta(childSessionId, (meta) => {
        if (meta.currentStream && meta.currentStream.streamId !== runStreamId()) return false;
        meta.currentStream = {
          streamId: runStreamId(),
          turnId: childSessionId,
          message: description,
          agentRole: subagentType,
          startedAt: nowISO(),
          cancelled: false,
          // Владелец маркера — процесс инстанса (recovery после рестарта).
          owner: extra.sessionManager!.instanceId,
        };
        return true;
      }, { touchUpdatedAt: false, shouldWrite: (written) => written });
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
    /**
     * ADR-119: сколько раз за прогон уже сжали контекст ребёнка (граница
     * шага). Потолок — `MAX_SUBAGENT_MID_TURN_COMPRESSIONS`; сжатие не шаг,
     * лимит шагов агента оно не расходует.
     */
    let childCompactions = 0;
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
    const allSubagentToolCalls: SubagentToolCallRecord[] = [];

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
    /**
     * Сколько раз за прогон модель вернула **пустой финальный ответ** (нет ни
     * текста, ни вызовов инструментов) — ADR-041 × PROP-143.
     *
     * Счётчик свой (не провайдерный `LLM_MAX_ATTEMPTS`): пустой ответ — не
     * ошибка транспорта, его лечит повтор с диагностикой в диалоге ребёнка.
     * Общий на прогон, а не на шаг: пустой финал завершает прогон, поэтому
     * сбрасывать его нечему.
     */
    let emptyResponseAttempts = 0;
    /** Причина завершения последнего LLM-вызова (для диагностики пустого финала). */
    let emptyFinishReason: LlmFinishReason | undefined;
    /** Расход последнего LLM-вызова (для `task.output_limit` и метаданных). */
    let emptyUsage: TokenUsage | undefined;
    /**
     * ADR-041 × continuation: сколько финальных ответов ребёнка за прогон
     * осталось **срезанным лимитом вывода** (`finish: 'max_tokens'|'length'`).
     *
     * Счётчик **свой**, с `emptyResponseAttempts` не смешивается: обрезанный
     * ответ — не «молчание модели», у него другая причина и другое лечение
     * (инструкция продолжить, а не «дай хоть какой-то отчёт»). Растёт только
     * на шаге, который завершился финальным ответом **без** tool-call'ов и с
     * признаком обрезки; обрезанный tool-call ведёт обычный путь шага.
     *
     * Предел серии — `MAX_OUTPUT_LIMIT_STREAK` (`продолжений + 1`): на нём
     * прогон завершается исходом `output_limit`, а не выдаёт третий обрезок
     * за готовый ответ. Общий на прогон: продолжение не расходует шаг агента
     * (`iteration` не растёт), сбрасывать счётчик нечему.
     */
    let outputLimitStreak = 0;
    /**
     * Текст, уже написанный в предыдущих (срезанных) попытках того же ответа.
     *
     * Продолжение продолжает **тот же** ответ: фрагменты лежат в истории
     * ребёнка отдельными сообщениями (каждый шаг — своё сообщение), а родителю
     * уходит собранный текст — иначе от отчёта саб-агента остался бы только
     * хвост. Склейка прямая: модель продолжает с места обрыва, разделитель не
     * нужен.
     */
    let outputLimitPrefix = '';
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
      /**
       * ADR-118 §1: размышления **своего** шага (итерации). Агрегат
       * `allSubagentReasoning` в сообщение не пишется: размышления прошлых
       * шагов уже лежат в их собственных сообщениях, иначе в финале был бы
       * дубль (`parts`/`reasoning` финала — только этого шага).
       */
      stepReasoning?: string,
    ): Promise<void> => {
      if (!childSessionId || !extra.sessionManager) return;
      try {
        // Размышления сообщения — только своего шага. Anthropic-подпись имеет
        // смысл лишь для одиночного блока (`subagentReasoningMeta`), поэтому
        // legacy-поля прикладываются лишь когда есть текст этого шага.
        const reasoningBlocks: ReasoningBlockLike[] = [];
        for (const data of stepReasoning ? subagentReasoningMeta?.redacted ?? [] : []) {
          if (data) reasoningBlocks.push({ text: '', redacted: data });
        }
        if (stepReasoning) {
          reasoningBlocks.push({
            text: stepReasoning,
            ...(subagentReasoningMeta?.signature !== undefined
              ? { signature: subagentReasoningMeta.signature }
              : {}),
          });
        }
        const assistantMsg: Message = {
          id: messageId ?? generateId(),
          role: MessageRole.ASSISTANT,
          seq: 0,
          origin: 'local',
          parts: [makeTextPart(content), ...makeReasoningParts(reasoningBlocks)],
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
          // ADR-118 §1: reasoning — только этого шага (тексты прошлых шагов
          // живут в своих сообщениях, дублей в финале нет).
          reasoning: stepReasoning || undefined,
          // Anthropic: подпись thinking-блока (только для одиночного блока —
          // принадлежит тексту этого же шага).
          ...(stepReasoning && subagentReasoningMeta?.signature !== undefined
            ? { reasoningSignature: subagentReasoningMeta.signature }
            : {}),
          ...(stepReasoning && subagentReasoningMeta?.redacted?.length
            ? { reasoningRedacted: subagentReasoningMeta.redacted }
            : {}),
          // ADR-118 §1: финальное сообщение больше **не** агрегат — карточки
          // инструментов (`metadata.tool_results`) пишутся точечно в сообщение
          // своего шага (`persistChildStepToolResults`), тексты прошлых шагов
          // (`intermediate_text_blocks`) — в их собственных сообщениях.
          metadata: buildChildAssistantMetadata(status, {
            stream_id: extra.streamId,
            duration_ms: Date.now() - subagentStartedAt,
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

    /**
     * ADR-118 §1 / ADR-144: `metadata.tool_results` сообщения **своего** шага
     * дочерней сессии — вызовы этой итерации (та же форма, что у
     * `allSubagentToolCalls`: `name`/`args`/`id`/`result`/`started_at`/
     * `completed_at`/`iteration`). Карточки инструментов живут на своём шаге,
     * а не в финальном агрегате: UI скрывает assistant-шаг без видимого текста
     * (`tool_chain`), пока у него нет `tool_results` — без этой записи в ленте
     * ребёнка был виден только последний шаг.
     *
     * Запись — **точечная** и **под локом сессии** (`withLock`, как
     * `_persistStepToolResults` оркестратора): история целиком не
     * переписывается, параллельные append/update не теряются. Идемпотентно
     * (тот же массив — без записи), best-effort: ошибка хранилища прогон не
     * роняет; сообщения нет — no-op.
     */
    const persistChildStepToolResults = async (
      messageId: string,
      toolResults: SubagentToolCallRecord[],
    ): Promise<void> => {
      if (toolResults.length === 0) return;
      if (!childSessionId || !extra.sessionManager) return;
      const sessionId = childSessionId;
      const manager = extra.sessionManager;
      try {
        await manager.withLock(sessionId, async (s) => {
          const target = s.messages.find((m) => m.id === messageId);
          if (!target) return;
          const current = target.metadata?.tool_results;
          // Идемпотентно: тот же набор — перезаписи нет.
          if (
            Array.isArray(current)
            && current.length === toolResults.length
            && current.every((item, index) => item === toolResults[index])
          ) {
            return;
          }
          await manager.updateMessage(sessionId, {
            ...target,
            metadata: { ...(target.metadata ?? {}), tool_results: toolResults },
          });
        });
      } catch (err) {
        warning(
          'SUBAGENT',
          `Не удалось записать результаты вызовов в сообщение шага ${messageId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    };

    /**
     * Служебное сообщение повтора пустого ответа (ADR-041 × PROP-143).
     *
     * Молчаливый повтор того же запроса бесполезен: модель повторит и тот же
     * результат. Поэтому перед повтором в диалог ребёнка кладётся
     * диагностическое сообщение — причина (`max_tokens` или просто пустой
     * ответ), фактический расход и что именно изменить (сократить вывод,
     * разбить работу на части, читать файлы частями, не пересказывать
     * результаты инструментов).
     *
     * Сообщение — служебное (`role: 'user'`, `author: 'System'`,
     * `metadata.type: 'empty_response_notice'`), как запись причины остановки
     * (PROP-143): оно видно модели и в ленте ребёнка, но не считается репликой
     * человека (`sessions/user-messages.ts`). В текст результата для родителя
     * оно **не** попадает — там только причина/диагностика в метаданных.
     *
     * Best-effort: ошибка записи не роняет прогон (повтор модели важнее).
     */
    const appendEmptyResponseNotice = async (opts: {
      attempt: number;
      max: number;
      truncated: boolean;
      usage?: TokenUsage;
      finishReason?: LlmFinishReason;
    }): Promise<void> => {
      const params = {
        attempt: String(opts.attempt),
        max: String(opts.max),
        limit: String(opts.usage?.outputTokens ?? 0),
        reasoning: String(opts.usage?.reasoningTokens ?? 0),
      };
      const key = opts.truncated ? 'task.empty_retry_truncated' as const : 'task.empty_retry_empty' as const;
      const content = sm(key, params);

      // LLM-контекст: следующий вызов увидит диагностику (без неё повтор —
      // тот же самый запрос, что дал пустой ответ).
      messages.push({
        id: '',
        role: 'user',
        content,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        disabled: false,
        pinned: false,
        branchId: '',
      });

      if (!childSessionId || !extra.sessionManager) return;
      try {
        await addChildMessage({
          id: generateId(),
          role: MessageRole.USER,
          seq: 0,
          origin: 'local',
          parts: [makeTextPart(content)],
          content,
          author: 'System',
          createdAt: nowISO(),
          disabled: false,
          pinned: false,
          hidden: false,
          ephemeral: false,
          metadata: {
            type: 'empty_response_notice',
            attempt: opts.attempt,
            max_attempts: opts.max,
            ...(opts.finishReason ? { finish_reason: opts.finishReason } : {}),
            ...(opts.usage ? { usage: opts.usage } : {}),
            stream_id: extra.streamId,
          },
          // Ход ребёнка — его же id (как у шагов/stop-record).
          turnId: childSessionId,
        });
      } catch (err) {
        warning(
          'SUBAGENT',
          `Не удалось записать диагностику пустого ответа: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    };

    /**
     * ADR-041 × continuation: инструкция продолжить ответ, срезанный лимитом
     * вывода (`output-limit-notice.ts`, шаблон
     * `prompts/system/OUTPUT_LIMIT.{lang}.md`).
     *
     * Кладётся **и** в LLM-контекст ребёнка (`messages`), **и** в его историю:
     * без первой копии следующий вызов уйдёт с тем же промптом и упрётся в тот
     * же лимит, без второй — факт обрезки и просьба продолжить не видны в ленте
     * после reload. Сообщение служебное (`role: 'user'`, `author: 'System'`,
     * `metadata.type = 'output_limit_notice'`): репликой человека не считается
     * (`sessions/user-messages.ts`), свой ход не открывает и в текст результата
     * для родителя **не** попадает — там причина живёт в метаданных.
     *
     * Best-effort: ошибка записи не роняет прогон (продолжение важнее).
     */
    const appendOutputLimitNotice = async (opts: {
      attempt: number;
      max: number;
      usage?: TokenUsage;
      finishReason?: LlmFinishReason;
    }): Promise<void> => {
      const content = buildOutputLimitNotice(
        extra.contextConfig,
        extra.parentSessionSettings?.language ?? 'ru',
        {
          attempt: opts.attempt,
          max: opts.max,
          ...(opts.usage?.outputTokens !== undefined ? { limit: opts.usage.outputTokens } : {}),
          ...(opts.usage?.reasoningTokens !== undefined
            ? { reasoning: opts.usage.reasoningTokens }
            : {}),
        },
      );

      // LLM-контекст: следующий вызов должен увидеть инструкцию.
      messages.push({
        id: '',
        role: 'user',
        content,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        disabled: false,
        pinned: false,
        branchId: '',
      });

      if (!childSessionId || !extra.sessionManager) return;
      try {
        await addChildMessage({
          id: generateId(),
          role: MessageRole.USER,
          seq: 0,
          origin: 'local',
          parts: [makeTextPart(content)],
          content,
          author: 'System',
          createdAt: nowISO(),
          disabled: false,
          pinned: false,
          hidden: false,
          ephemeral: false,
          metadata: {
            type: OUTPUT_LIMIT_NOTICE_TYPE,
            attempt: opts.attempt,
            max_attempts: opts.max,
            ...(opts.finishReason ? { finish_reason: opts.finishReason } : {}),
            ...(opts.usage ? { usage: opts.usage } : {}),
            stream_id: extra.streamId,
          },
          // Ход ребёнка — его же id (как у шагов/stop-record).
          turnId: childSessionId,
        });
      } catch (err) {
        warning(
          'SUBAGENT',
          `Не удалось записать инструкцию продолжения: ${err instanceof Error ? err.message : String(err)}`,
        );
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

      // 2. PROP-143: durable-запись причины остановки (`stopped_by_user`) —
      // вместо прежнего INFO-сообщения «Task stopped by the user»: причина
      // остаётся в истории ребёнка после reload и доходит до модели в виде
      // машиночитаемого конверта. Запись идёт **после** частичного ответа
      // (PROP-143 §«Остаточные технические вопросы»): лента и контекст
      // читаются сверху вниз — сначала «что успело», потом «почему оборвалось».
      // Ключ дедупликации — прогон: повторный вызов `finishAborted` второй
      // записи не добавляет.
      await writeStopRecord({ reason: 'stopped_by_user' });

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
      // ADR-039: актуальный список задач ребёнка — тоже часть результата
      // (частичный вывод при отмене): заголовок + капнутый рендер.
      const childTodos = await readChildTodos(extra.sessionManager, childSessionId);
      const todosSection = renderTodosSection(childTodos);
      return {
        content: [
          '<task_result>',
          `<summary>${description}</summary>`,
          '<status>stopped_by_user</status>',
          ...(childSessionId ? [`<child_session_id>${childSessionId}</child_session_id>`] : []),
          ...(partialContent ? [`<partial_output>\n${partialContent}\n</partial_output>`] : []),
          `<steps_completed>${stepsCompleted}</steps_completed>`,
          ...(todosSection ? [todosSection] : []),
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
          ...todoMetadata(childTodos),
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
      /**
       * ADR-118 §1: результаты вызовов **этого** шага — аккумулятор итерации
       * (создаётся свежим на каждом шаге рядом со `stepMessageId`).
       * `commitSubagentToolCall` кладёт запись и в сводку прогона
       * (`allSubagentToolCalls` — `task`-результат), и сюда; после батча они
       * точечно пишутся в сообщение шага
       * (`persistChildStepToolResults`).
       */
      const stepToolResults: SubagentToolCallRecord[] = [];
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

      // ─── ADR-119: авто-компактификация дочерней сессии (граница шага) ──
      // Длинный прогон ребёнка без сжатия упирается в окно модели (или в
      // предохранитель `agents.subagentMaxInputTokens`, который завершает
      // прогон детерминированным отчётом). Сжатие подставляет в запрос
      // пересобранный контекст (`[CONTEXT CHECKPOINT]` + живой хвост);
      // предохранитель бюджета ниже работает уже по сокращённому `messages`.
      //
      // Шаг-лимит имеет приоритет: финальный шаг-отчёт opencode не сжимаем.
      // Сжатие — не шаг: `iteration`/`toolIteration` не растут.
      if (!stepLimitStep && childCompactions < MAX_SUBAGENT_MID_TURN_COMPRESSIONS) {
        const rebuilt = await tryCompactChildSession({
          extra,
          childSessionId,
          subagentType,
          provider: effectiveProvider,
          cancelToken,
          attempts: childCompactions,
          isAborted,
        });
        if (rebuilt) {
          messages.length = 0;
          messages.push(...rebuilt);
          childCompactions += 1;
          info(
            'CONTEXT',
            `Subagent compression applied: ${rebuilt.length} messages in request, `
              + `session ${childSessionId ?? '-'}`,
          );
          // Отмена во время сжатия — прогон закрывается как отменённый
          // (обычный break-путь цикла).
          if (isAborted()) break;
        }
      }

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
          // PROP-143: durable-запись причины остановки (`context_budget`) —
          // предохранитель сработал, прогон завершён без LLM. Запись идёт
          // после отчёта: лента читается сверху вниз.
          await writeStopRecord({
            reason: 'context_budget',
            tokens: estimatedTokens,
            steps: iteration,
          });
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
      /**
       * Нормализованная причина завершения ответа этой итерации
       * (`LLMChunk.finishReason` финального чанка). Нужна, чтобы отличить
       * «модель промолчала» от «бюджет вывода исчерпан» на пустом финале —
       * паритет с основной сессией (`orchestrator/phases/process-finalize.ts`).
       */
      let stepFinishReason: LlmFinishReason | undefined;
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
            // ADR-041: причина завершения — финальный чанк ответа.
            if (chunk.finishReason) stepFinishReason = chunk.finishReason;
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
          const errorType = classifyLlmErrorFor(err);
          // ADR-041 × решение владельца: пустой completion — **не** провайдерная
          // ошибка, а «пустой ответ модели»: повторы считает цикл (счётчик
          // `SUBAGENT_EMPTY_RESPONSE_MAX_ATTEMPTS` и служебное сообщение с
          // диагностикой). Провайдерный retry-путь его не тратит — иначе один
          // и тот же класс повторился бы 3×3 раза, накапливая бесконечное время
          // ожидания. Выходим из retry-цикла без `llmFailure`: обычная ветка
          // пустого финала ниже сама сделает попытку и, если надо, диагностику.
          if (errorType === 'empty_completion') {
            debug(
              'SUBAGENT',
              `Пустой completion провайдера — повтор считает цикл `
              + `(attempt=${attempt}/${retryMaxAttempts}, child=${childSessionId ?? '-'})`,
            );
            break;
          }
          // `errorType` обязателен: у `RemoteAuthExpiredError`/`RemoteError('AUTH')`
          // текст может быть русским («Сессия на сервере истекла…») — текстовые
          // паттерны его не распознают, и без типа саб-агент делал бы бесполезные
          // ретраи (единая политика с `orchestrator/errors.ts` и agent-step).
          if (!isLlmErrorRecoverable(err, rawError, errorType) || attempt >= retryMaxAttempts) {
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
          stepFinishReason = undefined;
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
        // PROP-143: durable-запись причины остановки (`provider_error`) —
        // вместо прежнего сообщения `role: 'error'`: причина остановки после
        // reload остаётся в истории ребёнка и доходит до модели в виде
        // машиночитаемого конверта (`engine/stop-reason.ts`). Запись идёт
        // **до** финализации сессии — в ленте она встаёт сразу после упавшего
        // шага. Ошибка записи прогон не роняет (best-effort).
        await writeStopRecord({
          reason: 'provider_error',
          errorType: llmFailure.errorType,
          retryable: isLlmErrorRecoverable(
            llmFailure.error,
            String(llmFailure.error),
            llmFailure.errorType,
          ),
          attempts,
          maxRetries: retryMaxAttempts,
          error: String(llmFailure.error),
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
        // ADR-039: список задач ребёнка на момент сбоя — часть результата.
        const failureTodos = await readChildTodos(extra.sessionManager, childSessionId);
        const failureTodosSection = renderTodosSection(failureTodos);
        return {
          content: [
            '<task_result>',
            `<summary>${description}</summary>`,
            '<status>error</status>',
            ...(childSessionId ? [`<child_session_id>${childSessionId}</child_session_id>`] : []),
            `<attempts>${attempts}</attempts>`,
            ...(failureTodosSection ? [failureTodosSection] : []),
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
            ...todoMetadata(failureTodos),
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
            await persistChildAssistantMessage(reportText, { ...stepLimitMeta(), ...stepDurationMeta() }, stepMessageId, 'limit', stepUsage, iteration, reasoning);
          } else {
            reportMissing = true;
            finalContent = sm('task.steps_limit_empty', { limit: stepLimitValue });
            // Детерминированный текст — в историю ребёнка: пустой отчёт иначе
            // оставлял дочернюю сессию без финального ответа вовсе.
            await persistChildAssistantMessage(finalContent, { ...stepLimitMeta(), ...stepDurationMeta() }, stepMessageId, 'limit', stepUsage, iteration, reasoning);
          }
          // PROP-143: durable-запись причины остановки (`steps_limit`) —
          // прогон остановлен по лимиту шагов. Запись идёт после отчёта:
          // лента читается сверху вниз (сначала отчёт, потом причина).
          await writeStopRecord({ reason: 'steps_limit', limit: Number(stepLimitValue) });
          break;
        }

        // ─── ADR-041 × continuation: финал, срезанный лимитом вывода ────────
        // Ответ без tool-call'ов, но с `finish: 'max_tokens'|'length'` — **не**
        // финал: провайдер обрезал его по бюджету вывода, и модели отдаётся
        // инструкция продолжить с места остановки (`output-limit-notice.ts`,
        // паритет с opencode `CONTINUE_AFTER_OUTPUT_LIMIT`). Продолжение — не
        // шаг агента: `iteration` не растёт (как у повтора пустого ответа).
        //
        // Порядок веток важен: обрезанный ответ приоритетнее пустого. У
        // reasoning-моделей весь бюджет уходит на размышления и видимого текста
        // не остаётся вовсе — это обрезка, а не «модель промолчала», поэтому
        // счётчик `emptyResponseAttempts` такие ответы не трогает (иначе один
        // и тот же класс диагностировался бы дважды).
        //
        // `!subagentDenied` — как у пустого финала: при отказе прав причину
        // точнее ставит ветка `denied` (фоллбек `task.stopped_by_deny`), и
        // продолжение обрезанного ответа её не заменяет.
        if (!subagentDenied && isOutputLimitFinish(stepFinishReason)) {
          outputLimitStreak += 1;
          if (reasoning) subagentReasoning = reasoning;

          // Срезанная часть ответа — отдельным сообщением в историю ребёнка: она
          // уже ушла в ленту дельтами и после reload не должна исчезнуть. Она же
          // нужна в LLM-контексте: модель продолжает с места остановки, а не
          // пишет ответ заново (иначе обрезка гарантированно повторится).
          const partialSaved = accumulatedContent.trim() !== '';
          if (partialSaved) {
            await persistChildAssistantMessage(accumulatedContent, {
              ...stepDurationMeta(),
              output_limit: true,
              output_limit_attempt: outputLimitStreak,
              ...(stepFinishReason ? { finish_reason: stepFinishReason } : {}),
              ...(stepUsage ? { usage: stepUsage } : {}),
            }, stepMessageId, 'limit', stepUsage, iteration, reasoning);
            messages.push({
              id: '',
              role: 'assistant',
              content: accumulatedContent,
              usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
              disabled: false,
              pinned: false,
              branchId: '',
              // Anthropic: thinking-блоки ответа обязан вернуться в историю.
              reasoning: reasoning || undefined,
              reasoningBlocks: toLlmReasoningBlocks(iterationBlocks),
              reasoningSignature,
              reasoningRedacted,
            });
            // Собранный текст предыдущих фрагментов — для результата родителя
            // (продолжение дописывает тот же ответ, а не начинает новый).
            outputLimitPrefix += accumulatedContent;
          }

          // Ещё есть продолжения: инструкция — в диалог и в следующий вызов,
          // прогон не завершаем (шаг агента не потрачен).
          if (outputLimitStreak < MAX_OUTPUT_LIMIT_STREAK) {
            await appendOutputLimitNotice({
              attempt: outputLimitStreak,
              max: MAX_OUTPUT_LIMIT_CONTINUATIONS,
              ...(stepUsage ? { usage: stepUsage } : {}),
              ...(stepFinishReason ? { finishReason: stepFinishReason } : {}),
            });
            continue;
          }

          // Продолжения исчерпаны — прогон **провален** исходом `output_limit`
          // (третий обрезок, выданный за готовый ответ, скрывал бы, что работа
          // не дописана). Текст причины нейтрален к типу сессии и уже
          // локализован в UI (`session.output_limit_exhausted`); цифры расхода —
          // в метаданных и в самой инструкции продолжения выше.
          finalContent = sm('session.output_limit_exhausted');
          // Диагностика — отдельной записью: срезанный хвост последней попытки
          // (если он есть) уже сохранён выше своим сообщением, а `usage` и
          // размышления принадлежат ему — здесь они дали бы дубль в счётчиках
          // сессии и в ленте.
          await persistChildAssistantMessage(finalContent, {
            ...stepDurationMeta(),
            output_limit: true,
            output_limit_attempts: outputLimitStreak,
            attempts: outputLimitStreak,
            max_attempts: MAX_OUTPUT_LIMIT_CONTINUATIONS,
            ...(stepFinishReason ? { finish_reason: stepFinishReason } : {}),
            // Видимого текста не было вовсе — отчёта нет (тот же маркер, что у
            // пустого финала: машиночитаемо для аналитики/UI).
            ...(partialSaved ? {} : { report_missing: true }),
            i18n: i18nMeta('session.output_limit_exhausted'),
          }, partialSaved ? undefined : stepMessageId, 'error',
          partialSaved ? undefined : stepUsage,
          iteration,
          partialSaved ? undefined : reasoning);

          // PROP-143: durable-запись причины остановки (`output_limit`) — серия
          // обрезанных ответов не должна выглядеть успехом после reload.
          await writeStopRecord({
            reason: 'output_limit',
            ...(stepFinishReason ? { finishReason: stepFinishReason } : {}),
            attempts: outputLimitStreak,
            maxRetries: MAX_OUTPUT_LIMIT_CONTINUATIONS,
          });

          // Терминальный путь провала — как у ошибки провайдера и пустого
          // финала: очередь инъекций снимается, расход фиксируется, ход ребёнка
          // закрывается статусом `error`, родитель получает `<status>error</status>`.
          await dropChildSteerInjections('turn_ended');
          await commitChildUsage();
          await finalizeChildSession('error');
          if (extra.hooks && childSessionId) {
            extra.hooks.emitAsync('agent_failed', {
              agentId: childSessionId,
              error: finalContent,
              retries: outputLimitStreak,
            });
          }
          const limitTodos = await readChildTodos(extra.sessionManager, childSessionId);
          const limitTodosSection = renderTodosSection(limitTodos);
          // Собранный текст серии — все фрагменты, включая последний (он уже
          // добавлен в `outputLimitPrefix` выше).
          return {
            content: [
              '<task_result>',
              `<summary>${description}</summary>`,
              '<status>error</status>',
              ...(childSessionId ? [`<child_session_id>${childSessionId}</child_session_id>`] : []),
              `<attempts>${outputLimitStreak}</attempts>`,
              ...(limitTodosSection ? [limitTodosSection] : []),
              // Собранный текст всех попыток — родитель видит, что успело
              // написать (в истории ребёнка фрагменты лежат своими сообщениями).
              ...(partialSaved ? [`<partial_output>\n${outputLimitPrefix}\n</partial_output>`] : []),
              finalContent,
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
              output_limit: true,
              output_limit_attempts: outputLimitStreak,
              attempts: outputLimitStreak,
              max_attempts: MAX_OUTPUT_LIMIT_CONTINUATIONS,
              // Видимого текста в последней попытке не было — отчёта нет (тот
              // же маркер, что у пустого финала/лимита шагов).
              ...(partialSaved ? {} : { report_missing: true }),
              ...(stepFinishReason ? { finish_reason: stepFinishReason } : {}),
              ...(stepUsage ? { usage: stepUsage } : {}),
              final_content: finalContent,
              i18n: i18nMeta('session.output_limit_exhausted'),
              // ADR-070 §2.6: per-message статистика сабагентов (попап сообщения).
              subagent_usage: subagentUsage,
              subagent_model: subagentModel,
              ...todoMetadata(limitTodos),
            },
          };
        }

        // Финальный ответ без вызовов инструментов. Пустой (пробельный) ответ —
        // **не** успех (ADR-041 × PROP-143): раньше он молча превращался в
        // плейсхолдер `task.empty_response` со статусом `completed`, и сбой
        // модели/исчерпанный бюджет вывода диагностировался как нормальное
        // завершение. Теперь в историю ребёнка пишется ответ со статусом
        // `error` и маркером `empty_response`, а причина остановки фиксируется
        // durable-записью (`empty`).
        // `!subagentDenied` — при отказе прав пустой финал не «молчание модели»,
        // а следствие отказа: причину ставит ветка `denied` ниже (`task.stopped_by_deny`
        // + durable-запись `denied`) — она точнее и не должна перебиваться.
        //
        // `finish: 'max_tokens'|'length'` сюда больше не доходит: обрезанные
        // ответы ведёт ветка продолжения выше (приоритет у обрезки). Разбор
        // причины в `truncated` оставлен защитой на случай обхода той ветки
        // (например, при отказе прав).
        if (accumulatedContent.trim() === '' && !subagentDenied) {
          emptyResponseAttempts += 1;
          emptyFinishReason = stepFinishReason;
          emptyUsage = stepUsage;
          if (reasoning) subagentReasoning = reasoning;

          // `max_tokens`/`length` — ответ срезан лимитом вывода: у
          // reasoning-моделей тот же бюджет расходуется на размышления, и
          // видимого текста не остаётся вовсе. Говорим об этом прямо и
          // подсказываем, что делать; иначе — модель действительно промолчала.
          const truncated = stepFinishReason === 'max_tokens' || stepFinishReason === 'length';
          const limitParams = {
            limit: String(stepUsage?.outputTokens ?? 0),
            reasoning: String(stepUsage?.reasoningTokens ?? 0),
          };
          finalContent = truncated
            ? sm('task.output_limit', limitParams)
            : sm('task.empty_response');
          const emptyI18nKey = truncated ? 'task.output_limit' as const : 'task.empty_response' as const;

          // Повтор пустого ответа — **цикл**, а не провайдер (решение владельца):
          // молчаливое повторение того же запроса бесполезно, поэтому перед
          // повтором в диалог ребёнка кладётся служебное сообщение с причиной,
          // расходом и указанием, что именно изменить. Повтор не расходует шаг
          // агента (`iteration` не растёт) — это тот же финальный шаг.
          if (emptyResponseAttempts < SUBAGENT_EMPTY_RESPONSE_MAX_ATTEMPTS) {
            await appendEmptyResponseNotice({
              attempt: emptyResponseAttempts,
              max: SUBAGENT_EMPTY_RESPONSE_MAX_ATTEMPTS,
              truncated,
              usage: stepUsage,
              finishReason: stepFinishReason,
            });
            continue;
          }

          // Попытки исчерпаны — прогон **провален** (а не «успешен с плейсхолдером»).
          await persistChildAssistantMessage(finalContent, {
            ...stepDurationMeta(),
            empty_response: true,
            ...(stepFinishReason ? { finish_reason: stepFinishReason } : {}),
            ...(stepUsage ? { usage: stepUsage } : {}),
            attempts: emptyResponseAttempts,
            max_attempts: SUBAGENT_EMPTY_RESPONSE_MAX_ATTEMPTS,
            // `report_missing` — «текстового отчёта нет»: тот же маркер, что у
            // пустого отчёта шага-лимита (машиночитаемо для аналитики/UI).
            report_missing: true,
            i18n: i18nMeta(emptyI18nKey, truncated ? limitParams : {}),
          }, stepMessageId, 'error', stepUsage, iteration, reasoning);

          // PROP-143: durable-запись причины остановки (`empty`) — пустой финал
          // не должен выглядеть успехом после reload. Запись идёт после
          // ответа: лента читается сверху вниз.
          await writeStopRecord({
            reason: 'empty',
            ...(stepFinishReason ? { finishReason: stepFinishReason } : {}),
            attempts: emptyResponseAttempts,
            maxRetries: SUBAGENT_EMPTY_RESPONSE_MAX_ATTEMPTS,
          });

          // Терминальный путь провала — как у ошибки провайдера: снимаем
          // очередь инъекций, фиксируем расход, закрываем ход ребёнка
          // статусом `error` и отдаём родителю `<status>error</status>`.
          await dropChildSteerInjections('turn_ended');
          await commitChildUsage();
          await finalizeChildSession('error');
          if (extra.hooks && childSessionId) {
            extra.hooks.emitAsync('agent_failed', {
              agentId: childSessionId,
              error: finalContent,
              retries: emptyResponseAttempts,
            });
          }
          const emptyTodos = await readChildTodos(extra.sessionManager, childSessionId);
          const emptyTodosSection = renderTodosSection(emptyTodos);
          return {
            content: [
              '<task_result>',
              `<summary>${description}</summary>`,
              '<status>error</status>',
              ...(childSessionId ? [`<child_session_id>${childSessionId}</child_session_id>`] : []),
              `<attempts>${emptyResponseAttempts}</attempts>`,
              ...(emptyTodosSection ? [emptyTodosSection] : []),
              finalContent,
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
              empty_response: true,
              report_missing: true,
              attempts: emptyResponseAttempts,
              max_attempts: SUBAGENT_EMPTY_RESPONSE_MAX_ATTEMPTS,
              ...(stepFinishReason ? { finish_reason: stepFinishReason } : {}),
              ...(stepUsage ? { usage: stepUsage } : {}),
              final_content: finalContent,
              i18n: i18nMeta(emptyI18nKey, truncated ? limitParams : {}),
              // ADR-070 §2.6: per-message статистика сабагентов (попап сообщения).
              subagent_usage: subagentUsage,
              subagent_model: subagentModel,
              ...todoMetadata(emptyTodos),
            },
          };
        }

        finalContent = `${outputLimitPrefix}${accumulatedContent}`;
        if (reasoning) subagentReasoning = reasoning;

        // Сохранить финальный ответ ассистента в дочернюю сессию
        await persistChildAssistantMessage(accumulatedContent, stepDurationMeta(), stepMessageId, 'completed', stepUsage, iteration, reasoning);
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
          // ADR-118 §1: шаговая модель есть и у дочерней сессии — видимость
          // шага с карточками даёт не текст, а `metadata.tool_results` своего
          // шага (пишется точечно после батча, `persistChildStepToolResults`).
          // Шаг с одним лишь reasoning прячется, чтобы размышления не
          // дублировались.
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
            // tool_chain=true — маркер «видимого текста нет»; карточки вызовов
            // рисуются по `metadata.tool_results` **своего** шага (пишется
            // точечно после исполнения батча, `persistChildStepToolResults`).
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

      /**
       * PROP-127 (этап T3): вызовы инструментов одного assistant-сообщения
       * ребёнка исполняются **параллельно**, а порядок вызовов модели
       * остаётся значимым.
       *
       * Тело цикла разбито на три фазы (как в основной сессии, этап T2):
       *  1. **Подготовка** (последовательно, порядок вызовов модели): разбор
       *     аргументов, учёт doom-loop, публикация `tool_call.started`,
       *     проверка прав, ожидание подтверждения (`ask`) и сборка
       *     `ToolContext` каждого вызова. Здесь живут все счётчики и флаги
       *     прогона — они по определению последовательны («N одинаковых
       *     вызовов подряд», «вызов N+1 видит грант из вызова N»).
       *  2. **Исполнение** (параллельно): вызовы сегмента стартуют
       *     одновременно (`runToolBatch`), каждый со своим контекстом;
       *     исключение тула — результат тула (`tool.exec_error`), а не
       *     падение прогона.
       *  3. **Фиксация** (последовательно, порядок вызовов модели):
       *     публикация `tool_call.result`, `allSubagentToolCalls`,
       *     tool-сообщение в LLM-контексте ребёнка и запись результата в
       *     историю дочерней сессии.
       *
       * **Барьер.** Состояние, которое читают следующие вызовы этого цикла, —
       * только правила прав ребёнка (`derivedPermission.rules` и запись
       * `child.settings.permission`): их меняет ответ пользователя «Разрешить
       * в сессии» (`approval.once === false`) в ветке `ask`. Вызов, получивший
       * такой грант, завершает сегмент: следующий вызов готовится уже после
       * его фиксации — ровно как в последовательном цикле.
       *
       * Остальные «меняющие состояние» тулы здесь **не** барьер (вывод из
       * кода, а не по аналогии с основной сессией):
       *  - `plan_enter`/`plan_exit`/`task`/`question` саб-агенту запрещены
       *    правилом `deny` (`deriveSubagentPermission`,
       *    `engine/permission/derive.ts`) — они не исполняются вовсе, а
       *    `childSessionMode`/`childPlanMode`/`childPlanApproved` читаются
       *    циклом из снимка, снятого **до** цикла;
       *  - `project_*` меняют состояние **родительской** сессии/проекта
       *    (`extra.sessionId` — родитель; тулы читают его первым), а
       *    `todo_*` — список ребёнка (`extra.todoSessionId`); цикл читает
       *    снимок `ctx.workingDir`/`ctx.allowedRoots`, снятый до цикла, —
       *    их эффект следующим вызовам этого цикла не виден (как и в
       *    последовательном цикле).
       */

      /**
       * Запись tool-результата в историю дочерней сессии (best-effort):
       * ошибка записи не роняет прогон — результат всё равно уходит модели.
       */
      const persistSubagentToolMessage = async (
        tcId: string,
        toolName: string,
        content: string,
        args: Record<string, unknown>,
        extraMetadata?: Record<string, unknown>,
      ): Promise<void> => {
        if (!childSessionId || !extra.sessionManager) return;
        try {
          const toolResultMsg: Message = {
            id: generateId(),
            role: MessageRole.TOOL,
            seq: 0,
            origin: 'local',
            parts: [makeTextPart(content)],
            content,
            createdAt: nowISO(),
            disabled: false,
            pinned: false,
            hidden: false,
            toolCallId: tcId,
            metadata: {
              ...(extraMetadata ?? {}),
              stream_id: extra.streamId,
              tool_chain: true,
              tool_name: toolName,
              args,
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
      };

      /**
       * Исполнение вызова в фазе исполнения батча.
       *
       * Исключение тула — результат тула (`tool.exec_error`), а не падение
       * прогона: ровно так же, как `executeToolDef` отдаёт ошибку исполнения
       * сама (пара assistant(tool_calls) → tool не рвётся), и так же, как в
       * основном цикле сессии (PROP-127, этап T2).
       */
      const runSubagentTool = async (
        toolDef: ToolDefinition | undefined,
        toolName: string,
        toolArgs: Record<string, unknown>,
        toolExecContext: ToolContext,
      ): Promise<ToolResult> => {
        if (!toolDef) {
          return {
            content: sm('tool.not_found', { tool: toolName }),
            isError: true,
            metadata: { i18n: i18nMeta('tool.not_found', { tool: toolName }) },
          };
        }
        try {
          return await executeToolDef(toolDef, toolArgs, toolExecContext, toolName);
        } catch (execError) {
          const errText = errorText(execError);
          return {
            content: sm('tool.exec_error', { tool: toolName, error: errText }),
            isError: true,
            metadata: { i18n: i18nMeta('tool.exec_error', { tool: toolName, error: errText }) },
          };
        }
      };

      /**
       * PROP-127 (этап T3): подготовка вызова — последовательно, в порядке
       * вызовов модели. Возвращает `null` для «кривого» вызова (без имени
       * тула) — такой вызов пропускается целиком (поведение прежнее).
       */
      const prepareSubagentToolCall = async (
        tc: Record<string, unknown>,
      ): Promise<SubagentToolPlan | null> => {
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
          return {
            kind: 'step-limit',
            tcId,
            name: toolName,
            args: {},
            startedAt: new Date().toISOString(),
            result: limited,
            grantsSession: false,
          };
        }

        // «Кривой» вызов модели (без имени инструмента) — пропускаем целиком:
        // ни `tool_call.started`, ни парного tool-результата (в отличие от
        // цикла основной сессии — здесь поведение прежнее).
        if (!func?.name) return null;

        const toolName = func.name;
        let toolArgs: Record<string, unknown>;
        if (typeof func.arguments === 'string') {
          // ADR-041 × opencode `tool.input-incomplete`: ответ оборван лимитом
          // вывода (`finish_reason: length`) — JSON аргументов может быть
          // недописан. Такой вызов НЕ исполняем (пустые args дали бы модели
          // «malformed JSON»/ошибку схемы), а пишем парный error-результат
          // с причиной и подсказкой.
          if (isIncompleteToolCall(stepFinishReason, func.arguments)) {
            return {
              kind: 'short-circuit',
              tcId,
              name: toolName,
              args: {},
              startedAt: new Date().toISOString(),
              result: inputIncompleteResult(toolName),
              grantsSession: false,
            };
          }
          try { toolArgs = JSON.parse(func.arguments); } catch { toolArgs = {}; }
        } else {
          toolArgs = func.arguments || {};
        }

        const tcStartedAt = new Date().toISOString();

        // Защита от зацикливания: одинаковый вызов с одинаковыми аргументами.
        // Счётчик общий на весь прогон, поэтому считается последовательно, в
        // порядке вызовов модели (фаза подготовки).
        const doomKey = `${toolName}:${JSON.stringify(toolArgs)}`;
        const doomCount = (doomTracker.get(doomKey) || 0) + 1;
        doomTracker.set(doomKey, doomCount);

        if (doomCount >= MAX_DOOM_LOOP_COUNT) {
          return {
            kind: 'doom',
            tcId,
            name: toolName,
            args: toolArgs,
            startedAt: tcStartedAt,
            content: sm('tool.doom_loop', { tool: toolName, count: String(doomCount) }),
            grantsSession: false,
          };
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
        // Контекст исполнения тула — свой на каждый вызов (PROP-127): собирается
        // на фазе подготовки (последовательно) и используется только этим
        // вызовом.
        const toolExecContext: ToolContext = {
          ...ctx,
          abortSignal: ctx.abortSignal,
          // Сессия тула ребёнка — **его собственная** (реестр блокирующих и
          // фоновых прогонов, лог процесса, audit исполнений, терминалы,
          // egress-журнал): `execute_shell`/`ssh_exec`/`script_run` внутри
          // сабагента принадлежат ребёнку (`POST /sessions/<child>/background`
          // отвязывает их, `detachAll(parent)` — нет). `extra.sessionId`
          // остаётся родительским (события/permission/проектный и
          // automation-скоуп, обфускация Gateway) — см. аудит в
          // `packages/core/AGENTS.md`. Без дочерней сессии — как было.
          ...(childSessionId ? { sessionId: childSessionId } : {}),
          // PROP-124 §2: ключи SSH — по роли **ребёнка**, а не родителя:
          // `agentIds` — ACL ключа, и ключ родителя (другой роли) сабагенту
          // не принадлежит. Сборка — копия extra (объект родителя не меняем);
          // без сборщика — fail-closed (ключи не выдаются вовсе).
          extra: {
            ...(extra as unknown as Record<string, unknown>),
            // ADR-029/ADR-126 §5: правила прав **ребёнка** — эффективные правила
            // прогона (резолв по цепочке `parentId` + `deny`-дополнения роли):
            // собственные правила сессии ребёнка больше не содержат копии
            // правил родителя (chain-no-copy). Это нужно тулу `script_list`
            // (скрытие deny-скриптов) и не дублирует enforcement
            // permission-слоя (`childEvaluator`).
            permissionConfig: derivedPermission,
            // ADR-039: todo-тулы ребёнка меняют **его** список, а не список
            // родителя. `sessionId` в extra остаётся родительским (события,
            // permission.ask/replied, проектный/automation-скоуп).
            todoSessionId: childSessionId,
            // PROP-135 (браузерный контур): профиль ребёнка — его роль/проект.
            executionBrowserProfile: childBrowserProfile,
            sshSecrets: extra.sshSecretsFor
              ? extra.sshSecretsFor({
                  agentRole: subagentDef?.id ?? subagentType,
                  isPlan: isPlanRestricted(childSessionMode, childPlanMode, childPlanApproved),
                })
              : async () => [],
          },
        };

        // ADR-029: permission-check саб-агента — permissions дочерней сессии
        // (родитель + deny-дополнения) применяются к каждому tool_call.
        //
        // PROP-127 (этап T5): вход проверки сохраняем — после гранта
        // «Разрешить в сессии» его можно переоценить (соседний запрос,
        // покрытый новым правилом, одобряется без нового вопроса).
        const checkInput: PermissionCheckInput = {
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
        };
        const permissionDecision = childEvaluator.check(checkInput);

        // Журнал решений по правам (`scope:'permission'`): в режиме
        // `audit.permission.mode='all'` пишется и **автоматическое** решение по
        // правилу (`outcome:'rule'`); `ask` решением не является (его исход
        // пишет шов ожидания подтверждения), в `decisions` записи нет —
        // фильтр режима внутри шва. Сессия записи — родительская
        // (`extra.sessionId`): туда же публикуются ask'и ребёнка.
        if (permissionDecision.action !== 'ask' && extra.sessionId) {
          extra.permissionAudit?.rule({
            sessionId: extra.sessionId,
            toolName,
            action: permissionDecision.action,
            ...(permissionDecision.matchedRule
              ? { matchedRule: permissionDecision.matchedRule }
              : {}),
            callId: tcId,
            ...(extra.streamId ? { turnId: extra.streamId } : {}),
            ...(toolName === 'execute_shell' && typeof toolArgs.command === 'string'
              ? { command: toolArgs.command }
              : {}),
          });
        }

        if (permissionDecision.action === 'deny') {
          return {
            kind: 'resolved',
            tcId,
            name: toolName,
            args: toolArgs,
            startedAt: tcStartedAt,
            result: buildDenyResult({
              reason: permissionDecision.reason,
              matchedRule: permissionDecision.matchedRule,
              messageId: permissionDecision.messageId,
              params: permissionDecision.params as Record<string, string> | undefined,
              contextConfig: extra.contextConfig,
            }),
            userDenied: false,
            grantsSession: false,
          };
        }

        if (permissionDecision.action === 'ask') {
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
          const approval: ApprovalRequest = {
            approvalId: `approval_${tcId}`,
            callId: tcId,
            toolName,
            arguments: toolArgs,
            reason: approvalAskReason,
            ...(preview ? { preview } : {}),
            // Структурная причина ask'а («виновник») — как в основном ходе.
            trigger: {
              ...(permissionDecision.messageId ? { messageId: permissionDecision.messageId } : {}),
              ...(permissionDecision.params ? { params: permissionDecision.params } : {}),
              ...(permissionDecision.matchedRule ? { matchedRule: permissionDecision.matchedRule } : {}),
              ...(permissionDecision.askKind ? { askKind: permissionDecision.askKind } : {}),
            },
          };
          // PROP-127 (этап T5): ожидание готовится здесь, публикуется и
          // ждётся в параллельной фазе — несколько `ask` одного шага висят
          // одновременно.
          const waiter = childApprovalManager.prepareWaiter(
            extra.sessionId!,
            approval,
            derivedPermission.askTimeoutMs,
            // «Стоп» родителя снимает ожидание подтверждения (иначе тул
            // висел бы до ask-таймаута).
            ctx.abortSignal,
          );
          return {
            kind: 'ask',
            tcId,
            name: toolName,
            args: toolArgs,
            startedAt: tcStartedAt,
            waiter,
            approval,
            checkInput,
            permissionDecision,
            run: () => runSubagentTool(toolDef, toolName, toolArgs, toolExecContext),
            grantsSession: false,
          };
        }

        // allow — обычное выполнение
        return {
          kind: 'execute',
          tcId,
          name: toolName,
          args: toolArgs,
          startedAt: tcStartedAt,
          run: () => runSubagentTool(toolDef, toolName, toolArgs, toolExecContext),
          grantsSession: false,
        };
      };

      /**
       * PROP-127 (этап T3): фиксация вызова — последовательно, в порядке
       * вызовов модели. Здесь `messages` (LLM-контекст ребёнка), история
       * дочерней сессии и `allSubagentToolCalls` получают результаты в том же
       * порядке, что и вызовы модели: провайдерский контракт требует одного
       * tool-результата на каждый `tool_call` (ADR-117).
       */
      const commitSubagentToolCall = async (
        plan: SubagentToolPlan,
        execResult?: ToolResult,
      ): Promise<void> => {
        // Защита от зацикливания: события не публикуются и в `tool_calls`
        // вызов не попадает — в историю пишется только парный tool-результат
        // (поведение прежнее).
        if (plan.kind === 'doom') {
          messages.push({
            id: '', role: 'tool',
            content: plan.content,
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            disabled: false, pinned: false, branchId: '',
            toolCallId: plan.tcId,
          });
          await persistSubagentToolMessage(plan.tcId, plan.name, plan.content, plan.args);
          return;
        }

        // Ожидание подтверждения решено в параллельной фазе — сюда попасть
        // не должно (план `ask` превращается в `execute`/`resolved`).
        if (plan.kind === 'ask') return;

        // Шаг-лимит и обрезанный вызов: аргументы в истории пустые
        // (результат известен без исполнения), а признак ошибки —
        // принудительный (поведение прежнее).
        const isStepLimit = plan.kind === 'step-limit';
        /** Аргументы недоступны: вызов не исполнялся (`step-limit`/`short-circuit`). */
        const argsUnavailable = isStepLimit || plan.kind === 'short-circuit';
        let toolResult: ToolResult;
        if (plan.kind === 'execute') {
          // Результат приходит из батча; запасной вариант — тот же
          // error-результат тула (исполнитель не отдал результат).
          toolResult = execResult ?? {
            content: sm('tool.exec_error', { tool: plan.name, error: 'unknown error' }),
            isError: true,
            metadata: { i18n: i18nMeta('tool.exec_error', { tool: plan.name, error: 'unknown error' }) },
          };
        } else {
          toolResult = plan.result;
        }

        // IPI-защита: единый слой фильтрации контента инструментов (та же
        // логика, что в основном ходе и шаге пайплайна) — обёртка по матрице
        // доверия, экранирование маркеров блока, словарная детекция и политика
        // flag/sanitize/block. Применяется ДО публикации события и персиста,
        // чтобы UI и история видели одинаковый контент.
        toolResult = applySubagentContentFilter(
          extra,
          plan.name,
          argsUnavailable ? {} : plan.args,
          toolResult,
          ctx,
        );

        publishToolEvent('tool_call.result', {
          stream_id: extra.streamId,
          session_id: extra.sessionId,
          call_id: plan.tcId,
          name: plan.name,
          result: toolResult,
          iteration: stepIteration,
          parent_call_id: extra.callId,
        });

        // ADR-118 §1: одна запись — в сводку прогона (`task`-результат) и в
        // аккумулятор **своего** шага (`metadata.tool_results` сообщения шага).
        const toolCallRecord: SubagentToolCallRecord = {
          name: plan.name,
          args: argsUnavailable ? {} : plan.args,
          id: plan.tcId,
          result: { content: toolResult.content, isError: argsUnavailable ? true : toolResult.isError },
          started_at: plan.startedAt,
          completed_at: new Date().toISOString(),
          iteration: stepIteration,
        };
        allSubagentToolCalls.push(toolCallRecord);
        stepToolResults.push(toolCallRecord);

        messages.push({
          id: '', role: 'tool',
          content: toolResult.content,
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          disabled: false, pinned: false, branchId: '',
          toolCallId: plan.tcId,
        });

        await persistSubagentToolMessage(
          plan.tcId,
          plan.name,
          toolResult.content,
          argsUnavailable ? {} : plan.args,
          plan.kind === 'step-limit' || plan.kind === 'short-circuit' ? plan.result.metadata : undefined,
        );

        // ADR-029 (обновлено 2026-10-29): отказ (в т.ч. ask→deny) больше не
        // обрывает цикл — модель получает `tool_result` и может выбрать другой
        // инструмент. Флаг нужен только для фоллбек-текста `task.stopped_by_deny`,
        // если содержательного ответа не будет.
        if (plan.kind === 'resolved' && plan.userDenied) {
          subagentDenied = true;
        }
      };

      /**
       * PROP-127 (этап T3): один сегмент батча — исполнение (параллельно)
       * и фиксация (последовательно). Подготовка сегмента уже выполнена.
       */
      const runSubagentToolSegment = async (segment: SubagentToolPlan[]): Promise<void> => {
        // Фаза 2a — подтверждения (PROP-127 T5): все `ask` сегмента
        // публикуются **разом** — несколько подтверждений висят одновременно,
        // а отказ по любому гасит остальные (каскад). Решения обрабатываются
        // по порядку вызовов модели.
        const askPlans = segment.filter(
          (plan): plan is Extract<SubagentToolPlan, { kind: 'ask' }> => plan.kind === 'ask',
        );
        childApprovalManager.publishWaiters(askPlans.map((plan) => plan.waiter));

        const resolved: SubagentToolPlan[] = [];
        let grantIndex = -1;
        for (const plan of segment) {
          if (plan.kind !== 'ask') {
            resolved.push(plan);
            continue;
          }
          const approval = await plan.waiter.decision;
          if (approval.approved) {
            let grantsSession = false;
            if (approval.once === false) {
              // «Разрешить в сессии» — allow-правило в permissions дочерней
              // сессии. Правило меняется **до** исполнения вызова, и следующие
              // вызовы батча обязаны его видеть — поэтому такой вызов
              // заканчивает сегмент (барьер).
              derivedPermission.rules[plan.name] = 'allow';
              grantsSession = true;
              if (childSessionId && extra.sessionManager) {
                try {
                  // Грант «в сессии» — точечно: полная запись снимка затирала
                  // параллельные точечные записи истории. `updatedAt` двигается
                  // (паритет с прежним `updateSession`); правило ставится по
                  // свежему документу внутри мутатора.
                  await extra.sessionManager.mutateMeta(childSessionId, (meta) => {
                    meta.settings = {
                      ...meta.settings,
                      permission: { ...derivedPermission },
                    };
                  });
                } catch {
                  // не фатально
                }
              }
              if (grantIndex < 0) grantIndex = resolved.length;
              // Переоценка ожидающих подтверждений (паритет с opencode, ветка
              // `always`): новое правило может разрешить соседний запрос — он
              // одобряется без нового вопроса пользователю.
              for (const other of askPlans) {
                if (other.waiter.settled) continue;
                // Переоценка идёт с ТЕМ ЖЕ входом, что и исходная проверка в
                // фазе подготовки. Для цикла саб-агента это не меняет ничего:
                // слой Authority к проверке прав ребёнка не подключён вовсе
                // (`childEvaluator` — без `authorityGate`), контекста хода в
                // проверке нет. Правило едино для обоих циклов: переоценка не
                // должна видеть прав БОЛЬШЕ, чем видела исходная проверка.
                const recheck = childEvaluator.check({ ...other.checkInput });
                if (recheck.action === 'allow') {
                  other.waiter.resolve({ approved: true, action: 'allow' });
                  // Событие — UI убирает карточку подтверждения (пользователь
                  // её не отвечал: решение принято грантом по соседнему
                  // запросу).
                  extra.eventBus?.publish(extra.sessionId!, 'permission.replied', {
                    approval_id: other.approval.approvalId,
                    session_id: extra.sessionId!,
                    approved: true,
                    action: 'allow',
                    auto_approved: true,
                  });
                }
              }
            }
            resolved.push({
              kind: 'execute',
              tcId: plan.tcId,
              name: plan.name,
              args: plan.args,
              startedAt: plan.startedAt,
              run: plan.run,
              grantsSession,
            });
            continue;
          }
          const why = approval.timeout
            ? sm('permission.ask_timeout')
            : approval.cancelled
              ? sm('permission.ask_cancelled')
              : approval.noSubscribers
                ? sm('permission.ask_no_subscribers')
                : sm('permission.ask_denied');
          resolved.push({
            kind: 'resolved',
            tcId: plan.tcId,
            name: plan.name,
            args: plan.args,
            startedAt: plan.startedAt,
            result: buildDenyResult({
              reason: plan.permissionDecision.reason,
              matchedRule: plan.permissionDecision.matchedRule,
              messageId: plan.permissionDecision.messageId,
              params: plan.permissionDecision.params as Record<string, string> | undefined,
              contextConfig: extra.contextConfig,
              contentSuffix: ` (${why})`,
              defaultI18n: false,
            }),
            // Отказ пользователя (не таймаут и не «нет подписчиков»).
            userDenied: !approval.timeout && !approval.noSubscribers && !approval.cancelled,
            grantsSession: false,
          });
        }

        // Фаза 2b — исполнение (параллельно): вызовы сегмента стартуют до
        // завершения первого; ошибка одного вызова не роняет остальные.
        // Грант «Разрешить в сессии» — барьер: вызовы после него исполняются
        // отдельным батчем (как в последовательном цикле, где грант завершал
        // сегмент).
        const execEntries: Array<{
          plan: Extract<SubagentToolPlan, { kind: 'execute' }>;
          index: number;
        }> = [];
        resolved.forEach((plan, index) => {
          if (plan.kind === 'execute') execEntries.push({ plan, index });
        });
        const groups: Array<typeof execEntries> = [];
        let group: typeof execEntries = [];
        for (const entry of execEntries) {
          group.push(entry);
          if (grantIndex >= 0 && entry.index === grantIndex) {
            groups.push(group);
            group = [];
          }
        }
        if (group.length > 0) groups.push(group);

        const outcomes = new Map<string, ToolBatchOutcome<ToolResult>>();
        for (const batchGroup of groups) {
          const batch = await runToolBatch(
            batchGroup.map((entry) => ({ id: entry.plan.tcId, run: entry.plan.run })),
          );
          batch.outcomes.forEach((outcome, index) => {
            const entry = batchGroup[index];
            if (entry) outcomes.set(entry.plan.tcId, outcome);
          });
        }

        // Фаза 3 — фиксация (последовательно, порядок вызовов модели).
        for (const plan of resolved) {
          if (plan.kind !== 'execute') {
            await commitSubagentToolCall(plan);
            continue;
          }
          const outcome = outcomes.get(plan.tcId);
          if (outcome?.ok) {
            await commitSubagentToolCall(plan, outcome.value);
            continue;
          }
          // Батч не падает целиком: упавший вызов — его слот. Результат —
          // обычный error-результат тула, прогон продолжается, а пара
          // assistant(tool_calls) → tool не рвётся.
          const errText = outcome && !outcome.ok ? errorText(outcome.error) : 'unknown error';
          await commitSubagentToolCall(plan, {
            content: sm('tool.exec_error', { tool: plan.name, error: errText }),
            isError: true,
            metadata: { i18n: i18nMeta('tool.exec_error', { tool: plan.name, error: errText }) },
          });
        }
      };

      // Фаза 1 — подготовка (последовательно, порядок вызовов модели).
      // Подтверждения (`ask`) не ждут здесь — они публикуются и ждутся в
      // параллельной фазе (PROP-127 T5): несколько подтверждений одного шага
      // висят одновременно.
      const toolSegment: SubagentToolPlan[] = [];
      for (const tc of toolCalls) {
        const plan = await prepareSubagentToolCall(tc);
        // «Кривой» вызов (без имени тула) — пропускаем целиком (поведение
        // прежнее): ни событий, ни парного результата.
        if (!plan) continue;
        toolSegment.push(plan);
      }
      if (toolSegment.length > 0) {
        await runSubagentToolSegment(toolSegment);
      }
      // ADR-118 §1/ADR-144: результаты вызовов шага — точечно в сообщение
      // **своего** шага (под локом, без перезаписи истории). Именно эта запись
      // делает шаг видимым в ленте ребёнка (`tool_chain` без `tool_results`
      // UI скрывает). Шаг без вызовов (и ветки без батча — отчёт по лимиту,
      // отмена, ошибка провайдера) записи не делает: массив пуст.
      if (stepToolResults.length > 0) {
        await persistChildStepToolResults(stepMessageId, stepToolResults);
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
          await persistChildAssistantMessage(reportText, { ...stepLimitMeta(), ...stepDurationMeta() }, undefined, 'limit', undefined, Math.max(0, iteration - 1), reasoning);
        } else {
          reportMissing = true;
          finalContent = sm('task.steps_limit_empty', { limit: stepLimitValue });
          await persistChildAssistantMessage(finalContent, { ...stepLimitMeta(), ...stepDurationMeta() }, undefined, 'limit', undefined, Math.max(0, iteration - 1), reasoning);
        }
        // PROP-143: durable-запись причины остановки (`steps_limit`) —
        // прогон остановлен по лимиту шагов (шаг-отчёт получен, вызовы
        // инструментов не исполнялись). Запись идёт после отчёта.
        await writeStopRecord({ reason: 'steps_limit', limit: Number(stepLimitValue) });
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
      // PROP-143: durable-запись причины остановки (`denied`) — отказ прав
      // остановил прогон (содержательного ответа модели нет). Запись идёт
      // после фоллбек-текста: лента читается сверху вниз.
      await writeStopRecord({ reason: 'denied' });
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
            // Снимок нужен только чтобы найти id последнего assistant-сообщения;
            // запись — точечная по `id` (`mutateMessage`), `updatedAt` двигается
            // (паритет с прежним `updateSession`). История не перезаписывается.
            const childSession = await extra.sessionManager.getSession(childSessionId);
            const lastAssistantMsg = childSession
              ? [...childSession.messages].reverse().find(m => m.role === MessageRole.ASSISTANT)
              : undefined;
            if (lastAssistantMsg) {
              await extra.sessionManager.mutateMessage(childSessionId, lastAssistantMsg.id, (target) => {
                target.qa_pass = qaResult.pass;
                target.qa_reason = qaResult.reason;
              });
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

    // Финализировать дочернюю сессию.
    await commitChildUsage();
    await finalizeChildSession('completed');

    // PROP-142 §3: успешный финал закрывает ход ребёнка — бюджет
    // автовосстановления («попытки на ход») сбрасывается. Для провала/отмены
    // счётчик остаётся: ход не завершён, автовосстановление ещё имеет смысл.
    await resetChildRecoveryBudget(extra.sessionManager, childSessionId);

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

    // ADR-039: актуальный список задач ребёнка — часть результата для
    // вызывающего агента. В content — markdown с капом (30 пунктов), в
    // metadata — полный массив (данные UI/аналитики).
    const resultTodos = await readChildTodos(extra.sessionManager, childSessionId);
    const resultTodosSection = renderTodosSection(resultTodos);

    // ADR-030: `agent_completed` — неблокирующий эмит успешного завершения
    // саб-агента (result — итоговый ответ).
    if (extra.hooks && childSessionId) {
      extra.hooks.emitAsync('agent_completed', {
        agentId: childSessionId,
        result: qualityOutput,
      });
    }

    return {
      content: `<task_result>\n<summary>${description}</summary>\n${qualityBlock}${routedByBlock}${childSessionBlock}\n${qualityOutput}${qaWarningText}${stepsLimitBlock}${resultTodosSection ? `\n\n${resultTodosSection}` : ''}\n</task_result>`,
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
        // Пустой финальный ответ модели (ADR-041 × PROP-143). Если повтор
        // помог — прогон успешен, но диагностика остаётся в метаданных:
        // `empty_retries` и причина последней пустой попытки. Служебные
        // сообщения повтора в результат родителя не входят (они — история ребёнка).
        ...(emptyResponseAttempts > 0
          ? {
            empty_retries: emptyResponseAttempts,
            ...(emptyFinishReason ? { finish_reason: emptyFinishReason } : {}),
            ...(emptyUsage ? { usage: emptyUsage } : {}),
          }
          : {}),
        // ADR-041 × continuation: прогон всё-таки дописал ответ после N
        // продолжений по лимиту вывода — прогон успешен, но факт обрезки
        // остаётся в метаданных (паритет с `empty_retries`).
        ...(outputLimitStreak > 0 ? { output_limit_retries: outputLimitStreak } : {}),
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
        ...todoMetadata(resultTodos),
      },
    };
  } catch (err: unknown) {
    // Жёсткий сбой вне штатных веток: дочерняя сессия не финализировалась, но
    // live-ход в UI нужно закрыть и маркер активности снять — иначе открытая
    // дочерняя сессия навсегда осталась бы «идёт» (ADR-118 §10).
    publishChildEvent('turn.finished', { turnId: childSessionId ?? '', status: 'error' });
    if (childSessionId && extra.sessionManager) {
      try {
        // Снимаем только свой маркер (ADR-118 §10). Условие — внутри мутатора,
        // запись — только при реальном изменении; `touchUpdatedAt:false` —
        // маркер служебный (паритет с прежним `saveSession`).
        await extra.sessionManager.mutateMeta(childSessionId, (meta) => {
          if (meta.currentStream?.streamId !== runStreamId()) return false;
          meta.currentStream = undefined;
          return true;
        }, { touchUpdatedAt: false, shouldWrite: (changed) => changed });
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
    // ADR-039: список задач ребёнка на момент жёсткого сбоя — часть результата
    // (ошибка не должна скрывать, что осталось недоделанным).
    const crashTodos = await readChildTodos(extra.sessionManager, childSessionId);
    const crashTodosSection = renderTodosSection(crashTodos);
    return {
      content: `${sm('task.subagent_exec_error', { type: subagentType, error: String(err) })}${crashTodosSection ? `\n\n${crashTodosSection}` : ''}`,
      isError: true,
      metadata: { subagent_type: subagentType, ...todoMetadata(crashTodos) },
    };
  } finally {
    // ADR-104: очередь инъекций ребёнка снимается в **любом** терминальном
    // пути прогона (нормальный выход, ошибка провайдера, отмена, жёсткий
    // сбой) — иначе остаток «протекает» в следующий ход ребёнка. Повторный
    // вызов безопасен (очередь снимается один раз).
    await dropChildSteerInjections('turn_ended');
  }
}

/**
 * Потолок дренажа очереди ребёнка за один проход (PROP-142 §3): «один проход
 * на пачку, без накопления» — забираем не больше этого числа сообщений,
 * остаток ждёт следующей доставки.
 */
export const MAX_CHILD_QUEUE_DRAIN = 5;

/**
 * Прогон саб-агента **с дренажем очереди** дочерней сессии (PROP-142 §3).
 *
 * У дочерней сессии нет `QueueProcessor`: сообщение, доставленное занятому
 * ребёнку с `delivery: 'queue'` (PROP-142 §1), лежит в `pendingMessages` и
 * ждёт. После текущего прогона ребёнок сам делает **ровно один** проход
 * продолжения: сообщения переносятся в историю, история уходит в LLM — и цикл
 * идёт снова. Больше одного прохода не делаем (остаток очереди ждёт следующей
 * доставки) — иначе ребёнок «накапливал» бы ввод.
 *
 * Дренаж — только после **успешного** завершения прогона: после провала
 * провайдера или «Стопа» очередь не продолжаем (пользователь/ошибка важнее
 * доставленного уточнения).
 */
export async function runSubagentWithQueueDrain(config: SubagentRunConfig): Promise<ToolResult> {
  const result = await runSubagent(config);
  // Провал или «Стоп» — очередь ребёнка не продолжаем.
  if (result.isError || result.metadata?.stopped_by === 'user') return result;

  const sessionManager = config.extra.sessionManager;
  const childSessionId = config.childSessionId;
  // Чистый `none`-контекст (без дочерней сессии) — очереди нет.
  if (!sessionManager || !childSessionId) return result;

  // Пачка сообщений очереди → история ребёнка (атомарно, порт).
  const pending = await sessionManager.takePendingMessages(childSessionId, MAX_CHILD_QUEUE_DRAIN);
  // Очередь пуста — продолжать нечем.
  if (pending.length === 0) return result;

  // Сессия могла быть удалена — второй проход не делаем.
  const fresh = await sessionManager.getSession(childSessionId);
  if (!fresh) return result;

  // Новый `streamId` второго прохода: иначе запись причины остановки
  // (`dedupeKey`) и маркер `currentStream` совпали бы с первым прогоном.
  const extra: TaskExtra = { ...config.extra, streamId: generateStreamId() };
  // Ровно один повторный проход — остаток очереди ждёт следующей доставки.
  return runSubagent({ ...config, initialMessages: resumeInitialMessages(fresh), extra });
}

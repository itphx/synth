/**
 * Общий цикл выполнения саб-агента (tool-loop со стримом, retry LLM-вызова,
 * permissions дочерней сессии, отмена, quality check/эскалация).
 *
 * Общий для тула `task` и для возобновления прерванной дочерней сессии
 * (`task-resume.ts`). ADR-095 (шаг 5): вынесено из `task.ts` без изменения
 * поведения.
 */
import { MessageRole, nowISO, generateId, makeTextPart, appendReasoningBlock } from '@itphx/synth-shared';
import type { Message, SessionMode, PlanMode, TokenUsage, ToolContext, ToolForLLM, ToolResult } from '@itphx/synth-shared';
import type { BaseProvider, LLMMessage, CancellationToken } from '../../../providers/base.js';
import { EventBus } from '../../../events/bus.js';
import { buildDenyResult, executeToolDef } from '../tool-execution.js';
import { classifyLlmError, isLlmErrorRecoverable, LLM_MAX_ATTEMPTS, LLM_RETRY_DELAYS_MS, MAX_DOOM_LOOP_COUNT } from '../../llm-error.js';
import { computeUsageCost } from '../../../providers/usage.js';
import { deriveSubagentPermission } from '../../permission/derive.js';
import { PermissionEvaluator } from '../../permission/evaluator.js';
import { PermissionApprovalManager } from '../../permission/approval.js';
import { estimatePromptChars, estimateTokens } from '../../context/token-ratio.js';
import { buildMaxStepsPrompt, maxStepsAssistantMessage } from '../../llm/max-steps.js';
import { t as sm, i18n as i18nMeta } from '../../system-messages.js';
import { createChildSessionLifecycle, publishMessageAdded } from './child-session.js';
import { messageToLLMMessage } from './prompt.js';
import { applySteerInjections, dropSteerInjections, isBackgroundNoticeMessage } from '../../steering/apply.js';
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
  };

  // ─── ADR-070: live-статистика саб-агента (`stream.usage` + `subagent.progress`) ──
  // Троттлинг ~300 мс; публикуем при изменении контента/размышлений или usage.
  const SUBAGENT_USAGE_THROTTLE_MS = 300;
  let liveUsageLastPublishedAt = 0;
  let liveUsageLastSignature = '';

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
  if (childSessionId && extra.sessionManager) {
    try {
      const child = await extra.sessionManager.getSession(childSessionId);
      if (child) {
        childSessionMode = child.mode ?? 'act';
        childPlanApproved = Boolean(child.planApproved);
        childPlanMode = child.settings.planMode ?? 'auto';
        childMcpToolSettings = child.settings.mcpToolSettings;
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
        // `message.injected` публикуется в канал **ребёнка**: инъекция
        // принадлежит его ходу, а позиция сообщения — индекс его истории
        // (в канале родителя такой индекс попал бы в чужое сообщение).
        publishInjected: (event) => {
          extra.eventBus?.publish(childSessionId, 'message.injected', event);
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
   * сообщением». Причина — `turn_ended`, событие публикуется в канал ребёнка
   * (как `message.injected` его же хода). Best-effort: сбой очереди не роняет
   * прогон.
   */
  const dropChildSteerInjections = async (): Promise<void> => {
    const sessionManager = extra.sessionManager;
    if (!childSessionId || !sessionManager) return;
    try {
      await dropSteerInjections({
        sessionManager,
        sessionId: childSessionId,
        reason: 'turn_ended',
        streamId: extra.streamId,
        publishDropped: (event) => {
          extra.eventBus?.publish(childSessionId, 'steer.dropped', event);
        },
        // ADR-111/ADR-113: уведомления фоновых прогонов не теряем — возвращаем
        // в очередь ребёнка. Автостарта нет: процессора очереди у дочерней
        // сессии нет (`createProcessor` здесь недоступен), сообщение ждёт.
        isRequeuable: isBackgroundNoticeMessage,
        requeue: async (messages) => {
          await requeueMessages({
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

  try {
    let finalContent = '';
    let iteration = 0;
    const doomTracker = new Map<string, number>();
    let subagentReasoning = '';
    let subagentDenied = false;

    let allSubagentReasoning: Array<{ text: string; iteration: number }> = [];
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
     * Предохранитель по объёму промпта (`agents.subagentMaxInputTokens`; `0` —
     * без ограничения). Это **не** окно модели: оценка проверяется перед каждым
     * LLM-вызовом, и при превышении прогон завершается детерминированным
     * отчётом (без LLM), а не уходит в ошибку провайдера.
     */
    const subagentMaxInputTokens = extra.subagentMaxInputTokens ?? 0;
    /** Прогон остановлен предохранителем бюджета контекста. */
    let contextBudgetExceeded = false;
    /** Оценка промпта в токенах на момент срабатывания предохранителя. */
    let contextBudgetTokens = 0;

    /** Best-effort оценка промпта саб-агента в токенах (`0` — данных нет). */
    const estimatePromptTokens = (): number => {
      const chars = estimatePromptChars(messages, llmSystemPrompt || undefined, tools);
      return chars > 0 ? estimateTokens(chars) : 0;
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
     */
    const persistChildAssistantMessage = async (
      content: string,
      extraMeta: Record<string, unknown> = {},
    ): Promise<void> => {
      if (!childSessionId || !extra.sessionManager) return;
      try {
        const assistantMsg: Message = {
          id: generateId(),
          role: MessageRole.ASSISTANT,
          seq: 0,
          origin: 'local',
          parts: [makeTextPart(content)],
          content,
          createdAt: nowISO(),
          disabled: false,
          pinned: false,
          hidden: false,
          agentRole: subagentType,
          model: subagentModel,
          // ADR-070 §2.6: суммарный usage саб-агента — основа rollup в
          // статистике родителя (subagent_tokens) и сессионной статистики.
          usage: subagentUsage,
          // Все размышления сабагента (по итерациям), склеенные в поле
          // reasoning — UI дочерней сессии показывает их блоками
          // (ReasoningBlock разбивает по «\n\n---\n\n»). Без этого размышления
          // остаются только в скрытых tool_chain-сообщениях и теряются.
          reasoning: allSubagentReasoning.length > 0
            ? allSubagentReasoning.map((r) => r.text).join('\n\n---\n\n')
            : undefined,
          // Как в _persistToolChain родителя: финальное сообщение несёт
          // свёрнутую цепочку тулов, чтобы UI дочерней сессии отрисовал её
          // так же аккуратно, как финал родительской.
          metadata: buildChildAssistantMetadata('completed', {
            stream_id: extra.streamId,
            duration_ms: Date.now() - subagentStartedAt,
            ...(allSubagentToolCalls.length > 0 ? { tool_results: allSubagentToolCalls } : {}),
            ...(allSubagentIntermediateTexts.length > 0 ? { intermediate_text_blocks: allSubagentIntermediateTexts } : {}),
            ...extraMeta,
          }),
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
    ): Promise<ToolResult> => {
      // 1. Частичный стрим оборванной итерации — в историю дочерней сессии
      if (partialContent) {
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
          // ADR-070 §2.6: usage, накопленный до отмены, — чтобы rollup не терял токены.
          usage: subagentUsage,
          ...(partialReasoning ? { reasoning: partialReasoning } : {}),
          metadata: buildChildAssistantMetadata('cancelled', {
            stream_id: extra.streamId,
            duration_ms: Date.now() - subagentStartedAt,
            partial: true,
            interrupted: true,
          }),
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
      await commitChildUsage();
      await finalizeChildSession();

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
      const stepLimitStep = Number.isFinite(effectiveMaxSteps) && iteration >= effectiveMaxSteps;
      if (stepLimitStep) stepLimitStepDone = true;
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
        const estimatedTokens = estimatePromptTokens();
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
      let lastPublishedReasoning = '';
      let lastPublishedContentLen = 0;

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
          for await (const chunk of effectiveProvider.chatAsync(
            requestMessages,
            llmSystemPrompt || undefined,
            tools as Record<string, unknown>[] | undefined,
            undefined,
            cancelToken,
            stepLimitStep ? { toolChoice: 'none' } : undefined,
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
            // ADR-070 §2.6: usage и модель саб-агента для статистики родителя.
            // Провайдеры отдают в каждом чанке НАКОПИТЕЛЬНЫЙ usage (running total),
            // поэтому суммируем только финальный чанк итерации — иначе usage
            // многократно раздувается. Каждый вызов chatAsync в финальном чанке
            // несёт итог своей итерации.
            if (chunk.isFinal) accumulateUsage(chunk.usage);
            if (chunk.model) subagentModel = chunk.model;

            // ADR-070: live-usage = накопленное + точный/оценка текущей итерации;
            // стоимость — по ценам модели, если загрузчик передан в extra.
            const liveUsage = buildLiveSubagentUsage(chunk, accumulatedContent, reasoning);
            const liveModel = subagentModel || effectiveProvider.model || undefined;
            const liveProvider = effectiveProvider.name || undefined;
            const liveCost = liveModel && extra.modelPriceLoader
              ? computeUsageCost(liveUsage.usage, extra.modelPriceLoader(liveModel))
              : null;
            const liveReasoning = reasoning || '';
            const liveContent = accumulatedContent || '';
            const usageSignature = [
              liveUsage.estimated ? 'e' : 'x',
              liveUsage.usage.inputTokens,
              liveUsage.usage.outputTokens,
              liveUsage.usage.totalTokens,
            ].join(':');

            // Стримим размышления/промежуточный текст (и usage) саб-агента
            // РОДИТЕЛЮ, чтобы в блоке `task` (по parent_call_id) всё было видно
            // во время работы. Троттлинг ~300 мс, дедуп по подписи.
            const changed = liveReasoning !== lastPublishedReasoning
              || liveContent.length !== lastPublishedContentLen
              || usageSignature !== liveUsageLastSignature;
            const nowLive = Date.now();
            if (changed && nowLive - liveUsageLastPublishedAt >= SUBAGENT_USAGE_THROTTLE_MS) {
              liveUsageLastPublishedAt = nowLive;
              liveUsageLastSignature = usageSignature;
              lastPublishedReasoning = liveReasoning;
              lastPublishedContentLen = liveContent.length;

              if (publish) {
                publish('subagent.progress', {
                  stream_id: extra.streamId,
                  session_id: extra.sessionId,
                  parent_call_id: extra.callId,
                  reasoning: liveReasoning,
                  content: liveContent,
                  iteration,
                  usage: liveUsage.usage,
                  ...(liveCost ? { cost_usd: liveCost.costUsd, cost_currency: liveCost.currency, cost_breakdown: liveCost.breakdown } : {}),
                  ...(liveModel ? { model: liveModel } : {}),
                  ...(liveProvider ? { provider: liveProvider } : {}),
                  estimated: liveUsage.estimated,
                });
              }

              // Live-статистика в дочернюю сессию (если она есть) — открытая
              // дочерняя сессия показывает токены/стоимость по ходу работы.
              if (childSessionId && extra.eventBus) {
                extra.eventBus.publish(childSessionId, 'stream.usage', {
                  session_id: childSessionId,
                  stream_id: extra.streamId,
                  iteration,
                  agent_role: subagentType,
                  ...(liveModel ? { model: liveModel } : {}),
                  ...(liveProvider ? { provider: liveProvider } : {}),
                  usage: liveUsage.usage,
                  ...(liveCost ? { cost_usd: liveCost.costUsd, cost_currency: liveCost.currency, cost_breakdown: liveCost.breakdown } : {}),
                  estimated: liveUsage.estimated,
                });
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
          lastPublishedReasoning = '';
          lastPublishedContentLen = 0;
        }
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
          // ADR-070 §2.6: usage, потраченный до ошибки, — чтобы rollup его учёл.
          usage: subagentUsage,
          metadata: buildChildAssistantMetadata('error', {
            stream_id: extra.streamId,
            duration_ms: Date.now() - subagentStartedAt,
            error: true,
            attempts,
            max_retries: retryMaxAttempts,
            error_type: llmFailure.errorType,
            i18n: i18nMeta(errKey, attempts > 1 ? { ...errParams, attempts: String(attempts) } : errParams),
          }),
        });
        await commitChildUsage();
        await finalizeChildSession();
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
        return await finishAborted(accumulatedContent, reasoning);
      }

      // Единая итерация для размышлений, промежуточного текста и вызовов
      // инструментов этого шага — иначе в UI (и в дочерней сессии) ломается
      // порядок: размышления идут на step N, а вызовы — на N+1.
      const stepIteration = iteration;
      if (reasoning) {
        // Тот же общий хелпер, что у основного стрима: кумулятивный reasoning
        // не должен давать дубль при повторе в новой итерации.
        allSubagentReasoning = appendReasoningBlock(allSubagentReasoning, reasoning, stepIteration);
      }

      // Шаг-лимит: инструменты в запросе остались (кэш провайдера), но вызов
      // запрещён `toolChoice: 'none'`. Ответ мог прийти нестандартным — с
      // `toolCalls`; исполнять их НЕЛЬЗЯ, ответ считается текстовым.
      if (stepLimitStep && toolCalls && toolCalls.length > 0) {
        toolCalls = [];
      }

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
            // тем же путём, что и обычный финальный ответ.
            await persistChildAssistantMessage(reportText);
          } else {
            reportMissing = true;
            finalContent = sm('task.steps_limit_empty', { limit: stepLimitValue });
          }
          break;
        }

        finalContent = accumulatedContent;
        if (reasoning) subagentReasoning = reasoning;

        // Сохранить финальный ответ ассистента в дочернюю сессию
        await persistChildAssistantMessage(accumulatedContent);
        break;
      }

      if (accumulatedContent) {
        allSubagentIntermediateTexts.push({ text: accumulatedContent, iteration });
      }

      iteration++;

      // Сохранить ответ ассистента с tool calls в дочернюю сессию
      if (childSessionId && extra.sessionManager) {
        try {
          const assistantMsg: Message = {
            id: generateId(),
            role: MessageRole.ASSISTANT,
            seq: 0,
            origin: 'local',
            parts: [makeTextPart(accumulatedContent || '')],
            content: accumulatedContent || '',
            createdAt: nowISO(),
            disabled: false,
            pinned: false,
            hidden: false,
            agentRole: subagentType,
            reasoning: reasoning || undefined,
            // OpenAI-совместимая цепочка: assistant(toolCalls) → tool.
            // tool_chain=true — UI дочерней сессии скрывает промежуточные
            // сообщения (визуализация уже в финальном с tool_results).
            toolCalls,
            metadata: { stream_id: extra.streamId, tool_chain: true },
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
      });

      for (const tc of toolCalls) {
        const tcId = (tc.id as string) || `subcall_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const func = tc.function as { name: string; arguments: string | Record<string, unknown> } | undefined;
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

        publish?.('tool_call.started', {
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
          const approval = await childApprovalManager.waitForDecision(
            extra.sessionId!,
            {
              approvalId: `approval_${tcId}`,
              callId: tcId,
              toolName,
              arguments: toolArgs,
              reason: approvalAskReason,
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

        publish?.('tool_call.result', {
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
    await finalizeChildSession();

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
    // live-плейсхолдер в UI нужно сбросить тем же терминальным событием.
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
  }
}

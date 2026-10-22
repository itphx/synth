/**
 * ADR-101 (Pipeline Engine): исполнитель шага вида `agent`.
 *
 * Шаг `agent` — **свой Tool-Use-цикл внутри движка** (ADR-101 §1, §4): шаг не
 * сессия, у него своя локальная история, а в запрос к LLM уходит только то,
 * что отображено **маппингом входа** шага (`ctx.input`), а не «вся история».
 *
 * ## Что делает этот этап (Э4.3a)
 *
 * - **системный промпт** — тем же `SystemPromptComposer`, что и сессия
 *   (ADR-070), по суженному «session-like» контракту (`ComposerSessionLike`):
 *   роль агента, язык, привязка к проекту; проект/инструкции/скиллы/тулы —
 *   из контекста шага (`ctx.step`);
 * - **пользовательское сообщение шага** — `node.prompt` (задание) + вход шага
 *   (`ctx.input`) в компактной сериализации (формат — ниже);
 * - **провайдер/модель** — через инъекцию (`ctx.llm.resolveProvider`,
 *   `ctx.llm.resolveLlmDefaults`): шаг не читает конфиг и не создаёт
 *   глобальных синглтонов;
 * - **LLM-вызов** — ровно один, через `GatewayProvider.chat` (ADR-036 —
 *   единственная разрешённая точка LLM-вызова);
 * - **локальная история шага** — массив `LLMMessage[]` **внутри
 *   исполнителя** (ни сессия, ни хранилище);
 * - **ошибки** — классификация `classifyLlmError`/`isLlmErrorRecoverable`
 *   (ADR-041): восполнимая ошибка → `pipeline.llm_failed` (движок может
 *   повторить по `node.retry`), невосполнимая → `pipeline.llm_unrecoverable`
 *   (повтор не поможет).
 *
 * ## Формат сообщения шага
 *
 * ```text
 * [TASK]
 * <node.prompt>
 *
 * [INPUT]
 * - <путь>: <значение>
 * - <другой путь>: <значение>
 * ```
 *
 * - блок `[TASK]` — текст `node.prompt` как есть; без промпта блока нет;
 * - блок `[INPUT]` — вход шага (`ctx.input`) **по алфавиту путей**
 *   (детерминированно: одинаковый вход → одинаковое сообщение);
 * - значение — однострочная строка как есть; остальное — JSON; длинные
 *   значения обрезаются до `MAX_INPUT_VALUE_CHARS`;
 * - `undefined` пропускается, `null` — как `null`.
 *
 * ## Точки расширения для Э4.3b (цикл вызовов тулов)
 *
 * Цикл добавляется **в одном месте** — `executeAgentStep`:
 *
 * 1. ответ модели уже содержит `toolCalls` (`LLMResponse`);
 * 2. локальная история шага (`AgentStepState.messages`) уже содержит и
 *    user-сообщение, и ответ модели — цикл дописывает результаты вызовов
 *    тулов и повторяет вызов;
 * 3. право на вызов тула — тот же `checkPipelineToolPermission`
 *    (`../permissions.ts`), что у tool/script-шага: `deny` → шаг падает с
 *    `permission.denied`, `ask` → пауза-гейт (`StepGateOutcome`,
 *    `kind: 'tool_approval'`) — механизм движка уже готов (ADR-101 §6);
 * 4. опции исполнителя уже принимают `permissions` и `toolRegistry` — циклу
 *    не нужно менять публичную поверхность.
 *
 * ## Цикл Tool Use (Э4.3b)
 *
 * ```text
 * LLM-вызов → ответ с toolCalls?
 *   ├─ нет  → финальный ответ шага (output.text + usage + сводка вызовов)
 *   └─ да   → для каждого вызова:
 *              право (checkStepToolPermission) → allow | deny | ask
 *                allow → вызов тула (executeToolDef) → результат в историю
 *                deny  → результат-отказ в историю (модель видит отказ)
 *                ask   → пауза-гейт (tool_approval) — выполнение не начато
 *              → повторный LLM-вызов с обновлённой историей
 * ```
 *
 * - **результаты тулов** — только в локальной историю шага (`state.messages`):
 *   ни сессия, ни хранилище (ADR-101 §1);
 * - **лимит итераций** (`maxIterations`, по умолчанию
 *   `DEFAULT_MAX_AGENT_ITERATIONS`) — при исчерпании шаг падает с
 *   `pipeline.agent_iterations`;
 * - **сводка вызовов** в выходе шага — только имя тула и признак ошибки:
 *   полные выводы тулов (объём/секреты) наружу не попадают;
 * - **гейт `ask`** — пауза **до** исполнения партии вызовов: если хоть один
 *   вызов требует подтверждения, ни один вызов партии не исполняется (иначе
 *   после `resume` они исполнились бы повторно).
 *
 * ### `ask` → гейт → `resume`
 *
 * Узел при возобновлении исполняется **заново** (ADR-101 §2.13), поэтому
 * решение оператора (`ctx.gateDecision`) применяется к тому же вызову:
 *
 * - **одобрение** — вызов исполняется с выданным правом: permission-чек по
 *   `ask`-политике не повторяется (решение человека — это и есть разрешение);
 * - **отклонение** — вызов не исполняется, в историю уходит результат-отказ,
 *   цикл продолжается (модель может ответить иначе).
 *
 * Какой именно вызов одобрен — определяется данными гейта (`ctx.gate`,
 * восстановленными движком из журнала прогона): имя тула и аргументы. Если
 * данные гейта недоступны, решение применяется к первой эскалации `ask`
 * (правило «одно решение — одна эскалация»).
 *
 * > ⚠️ Граница повторного исполнения: узел после `resume` исполняется заново,
 * > поэтому уже исполненные **в прошлых** итерациях тулы могут быть вызваны
 * > повторно (локальная история шага не переживает паузу — она живёт только
 * > внутри одного вызова исполнителя). Это свойство движка (ADR-101 §2.13),
 * > а не агентского шага.
 *
 * ## Отмена
 *
 * У `GatewayProvider.chat` нет параметра отмены (ADR-036), поэтому отмена
 * шага реализована **гонкой**: при `ctx.signal.aborted` шаг завершается с
 * `pipeline.cancelled`, не дожидаясь ответа провайдера (промис вызова
 * игнорируется). Провайдер обрывает собственный запрос по своему таймауту.
 */
import type { LLMResponse, StepResult, TokenUsage, ToolDefinition, ToolForLLM } from '@itphx/synth-shared';

import { error as logError, info as logInfo, warning as logWarning } from '../../../logger.js';
import type { BaseProvider, LLMMessage, SystemPromptPayload } from '../../../providers/base.js';
import type { ComposerMcpServer, ComposerSessionLike } from '../../context/composer.js';
import { classifyLlmError, isLlmErrorRecoverable } from '../../llm-error.js';
import { t } from '../../system-messages.js';
import { GatewayProvider } from '../../gateway/index.js';
import { buildDenyResult } from '../../tools/tool-execution.js';
import { zodToJsonSchema } from '../../tools/json-schema.js';
import type { PipelineStepContext } from '../step-context.js';
import { sanitizeValue } from '../payload.js';
import type { PipelinePermissionDeps } from '../permissions.js';
import type {
  PipelineEngineLogger,
  PipelineGate,
  StepExecutionContext,
  StepExecutor,
  StepOutcome,
} from '../types.js';
import {
  checkStepToolPermission,
  executeStepTool,
  findTool,
  stepWorkingDir,
  type PipelineToolLookup,
} from './common.js';

/** Лог-группа исполнителя agent-шага. */
const LOG_GROUP = 'PIPELINE';

/**
 * Предел длины одного значения во входе шага (символов) — вход уже
 * санитизирован движком, но его размер не ограничен: длинное значение
 * обрезается, чтобы не раздувать запрос к модели.
 */
const MAX_INPUT_VALUE_CHARS = 4000;

/**
 * Предел итераций Tool-Use-цикла агентского шага по умолчанию (Э4.3b).
 *
 * Итерация — один LLM-вызов шага (раунд «ответ модели → вызовы тулов →
 * повторный ответ»). Предел защищает шаг от бесконечного цикла вызовов
 * (модель снова и снова просит один и тот же тул).
 */
export const DEFAULT_MAX_AGENT_ITERATIONS = 25;

/** Предел длины описания вызова тула в данных гейта (символов). */
const MAX_GATE_ARGS_CHARS = 500;

/**
 * Опции исполнителя agent-шага.
 *
 * LLM-контур (промпт/провайдер/дефолты модели) приходит **контекстом шага**
 * (`ctx.llm`) — его задаёт движок из `PipelineEngineDeps`. Здесь — то, что
 * нужно самому исполнителю.
 */
export interface AgentStepExecutorOptions {
  /**
   * Права инструментов (ADR-029) — permission-обёртка пайплайна.
   * Используется циклом вызовов тулов (Э4.3b).
   */
  permissions?: PipelinePermissionDeps;
  /**
   * Реестр инструментов (ADR-071) — источник определений тулов для
   * цикла вызовов (Э4.3b); без него тул берётся из контекста шага.
   */
  toolRegistry?: PipelineToolLookup;
  /** Логгер (по умолчанию — логгер ядра). */
  logger?: PipelineEngineLogger;
  /**
   * Предел итераций Tool-Use-цикла (Э4.3b). По умолчанию —
   * `DEFAULT_MAX_AGENT_ITERATIONS` (25).
   */
  maxIterations?: number;
}

/**
 * Локальное состояние шага (Э4.3a).
 *
 * Живёт только внутри вызова исполнителя: это «память» шага между
 * LLM-вызовами (Э4.3b) — ни сессия, ни хранилище (ADR-101 §1).
 */
export interface AgentStepState {
  /** Провайдер шага (обёрнут в `GatewayProvider`, ADR-036). */
  provider: BaseProvider;
  /** Системный промпт шага (собран один раз — идемпотентно, ADR-070). */
  system: SystemPromptPayload;
  /** Локальная история шага: сообщения, уходящие в LLM. */
  messages: LLMMessage[];
  /** Инструменты шага в LLM-формате (только доступные). */
  tools: ToolForLLM[];
}

/** Исполнитель шага вида `agent`. */
export function createAgentStepExecutor(opts: AgentStepExecutorOptions = {}): StepExecutor {
  return {
    kind: 'agent',
    execute: (ctx: StepExecutionContext) => executeAgentStep(ctx, opts),
  };
}

/**
 * Исполнение agent-шага: провайдер → подготовка (промпт/вход/тулы) →
 * Tool-Use-цикл (Э4.3b) → результат шага.
 */
export async function executeAgentStep(
  ctx: StepExecutionContext,
  opts: AgentStepExecutorOptions = {},
): Promise<StepOutcome> {
  const logger = opts.logger ?? defaultLogger;

  // 1. Отмена до старта: шаг не начинается.
  if (ctx.signal.aborted) {
    return failed(ctx, 'pipeline.cancelled', t('pipeline.cancelled'));
  }

  // 2. LLM-контур шага (ADR-101 §4): без композитора промпта шаг не
  //    исполним — это не ошибка пайплайна, а ненастроенный инстанс.
  const llm = ctx.llm;
  if (!llm) {
    return failed(ctx, 'pipeline.agent_unavailable', t('pipeline.agent_unavailable', {
      node: ctx.node.id,
    }));
  }

  // 3. Провайдер шага (ADR-036) и дефолты модели инстанса (ADR-089).
  const defaults = await resolveLlmDefaults(llm);
  const provider = await resolveProvider(ctx, llm, logger);
  if (!provider) {
    return failed(ctx, 'pipeline.provider_not_found', t('pipeline.provider_not_found', {
      node: ctx.node.id,
      provider: defaults?.provider ?? '',
    }));
  }

  // 4. Подготовка шага: системный промпт, сообщение шага, тулы, локальная
  //    история. Собирается один раз на попытку — цикл Э4.3b переиспользует
  //    то же состояние.
  const state = await prepareAgentStep(ctx, provider, llm);

  // 5. Tool-Use-цикл (Э4.3b): LLM-вызов → вызовы тулов → повторный вызов.
  return runToolUseLoop(ctx, state, opts, logger, defaults);
}

/**
 * Tool-Use-цикл агентского шага (Э4.3b).
 *
 * Раунд цикла: один LLM-вызов → разбор вызовов тулов → права на каждый
 * вызов → исполнение разрешённых → результаты в локальную историю → повтор
 * LLM-вызова. Цикл заканчивается ответом без вызовов тулов (финальный ответ
 * шага) или превышением лимита итераций.
 *
 * Пауза-гейт (`ask`) возвращается **немедленно** и до исполнения партии:
 * иначе уже исполненные вызовы повторились бы после `resume`.
 */
async function runToolUseLoop(
  ctx: StepExecutionContext,
  state: AgentStepState,
  opts: AgentStepExecutorOptions,
  logger: PipelineEngineLogger,
  defaults?: { provider?: string; model?: string },
): Promise<StepOutcome> {
  const maxIterations = resolveMaxIterations(opts.maxIterations);
  const pending = resolvePendingGateDecision(ctx);
  const calls: AgentToolCallSummary[] = [];
  let usage: TokenUsage | undefined;

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    if (ctx.signal.aborted) {
      return failed(ctx, 'pipeline.cancelled', t('pipeline.cancelled'));
    }

    // 5.1. LLM-вызов через GatewayProvider (ADR-036).
    let response: LLMResponse;
    try {
      response = await callProvider(ctx, state.provider, state);
    } catch (err) {
      if (isCancelled(err, ctx)) {
        return failed(ctx, 'pipeline.cancelled', t('pipeline.cancelled'));
      }
      const detail = errorMessage(err);
      const type = classifyLlmError(detail);
      const recoverable = isLlmErrorRecoverable(err, detail, type);
      logger.warning(
        LOG_GROUP,
        `шаг «${ctx.node.id}»: ошибка LLM (${type}, ${defaults?.provider ?? '—'}/${defaults?.model ?? '—'}): ${detail}`,
      );
      return failed(
        ctx,
        recoverable ? 'pipeline.llm_failed' : 'pipeline.llm_unrecoverable',
        t(recoverable ? 'pipeline.llm_failed' : 'pipeline.llm_unrecoverable', {
          node: ctx.node.id,
          type,
        }),
      );
    }

    usage = accumulateUsage(usage, response.usage);

    // 5.2. Ответ модели — в локальную историю шага; вызовы тулов — разбор.
    const toolCalls = parseToolCalls(response.toolCalls);
    state.messages.push(assistantMessage(response, ctx, toolCalls));

    // 5.3. Ответ без вызовов тулов — финальный ответ шага.
    if (toolCalls.length === 0) {
      return {
        status: 'ok',
        attempt: ctx.attempt,
        output: {
          text: response.content,
          ...(usage ? { usage: { ...usage } } : {}),
          // Сводка вызовов — только имя и признак ошибки: полные выводы
          // тулов (объём/секреты) в выход шага не попадают.
          ...(calls.length ? { toolCalls: calls.map((call) => ({ ...call })) } : {}),
        },
      };
    }

    // 5.4. Права на вызовы тулов партии: пауза-гейт возвращается до
    //      исполнения (иначе вызовы повторились бы после `resume`).
    const planning = planToolCalls(ctx, opts, toolCalls, pending, logger);
    if (planning.kind === 'unavailable') {
      // Инфраструктуры инструментов нет вовсе — исполнять вызовы нечем.
      return failed(ctx, 'pipeline.agent_unavailable', t('pipeline.agent_unavailable', {
        node: ctx.node.id,
      }));
    }
    if (planning.kind === 'gate') {
      logger.info(
        LOG_GROUP,
        `шаг «${ctx.node.id}»: эскалация в human-гейт по инструменту «${planning.gate.toolName ?? '—'}»`,
      );
      return { kind: 'gate', gate: planning.gate };
    }

    // 5.5. Исполнение разрешённых вызовов и результаты в локальную историю.
    //      Порядок результатов — как порядок вызовов в ответе модели (провайдеры
    //      ждут парные `tool_result` в том же порядке).
    for (const plan of planning.plans) {
      if (plan.kind === 'execute') {
        const result = await executeStepTool(ctx, plan.toolDef, plan.call.name, plan.call.args);
        calls.push({ name: plan.call.name, isError: result.isError === true });
        state.messages.push(toolResultMessage(plan.call, result.content));
        continue;
      }
      calls.push({ name: plan.call.name, isError: true });
      state.messages.push(toolResultMessage(plan.call, plan.content));
    }
  }

  // 5.6. Лимит итераций исчерпан — шаг падает (модель не привела к ответу).
  logger.warning(
    LOG_GROUP,
    `шаг «${ctx.node.id}»: исчерпан лимит итераций Tool-Use-цикла (${maxIterations})`,
  );
  return failed(
    ctx,
    'pipeline.agent_iterations',
    t('pipeline.step_failed', {
      node: ctx.node.id,
      error: t('session.max_iterations'),
    }),
  );
}

/**
 * План обработки партии вызовов тулов: что исполняем, что отказываем и где
 * встаём на паузу-гейт.
 */
type ToolCallPlan =
  | { kind: 'execute'; call: ParsedToolCall; toolDef: ToolDefinition }
  | { kind: 'deny'; call: ParsedToolCall; content: string };

/** Итог планирования партии вызовов тулов. */
type ToolCallPlanning =
  /** Вызовы разобраны: исполняем/отказываем по плану. */
  | { kind: 'plans'; plans: ToolCallPlan[] }
  /** Пауза-гейт: нужен оператор (ADR-101 §6). */
  | { kind: 'gate'; gate: PipelineGate }
  /** Инфраструктуры инструментов нет — исполнять нечем. */
  | { kind: 'unavailable' };

/**
 * Права на вызовы тулов партии (ADR-101 §2.7).
 *
 * - `allow` — вызов исполняется;
 * - `deny` — вызов **не** исполняется, в историю уходит результат-отказ
 *   (модель видит отказ и продолжает работу);
 * - `ask` — пауза-гейт `tool_approval` (наблюдателя-сессии у пайплайна нет).
 *
 * Решение оператора по уже висящему гейту (`ctx.gateDecision`) заменяет
 * эскалацию `ask`: одобрение — вызов исполняется с выданным правом, отказ —
 * вызов не исполняется (результат-отказ в историю).
 */
function planToolCalls(
  ctx: StepExecutionContext,
  opts: AgentStepExecutorOptions,
  toolCalls: ParsedToolCall[],
  pending: PendingGateDecision | undefined,
  logger: PipelineEngineLogger,
): ToolCallPlanning {
  const plans: ToolCallPlan[] = [];

  for (const call of toolCalls) {
    const toolDef = findTool(ctx, opts.toolRegistry, call.name);
    if (!toolDef) {
      // Инструмента нет. Если инфраструктуры инструментов нет вовсе (ни
      // реестра, ни состава тулов в контексте шага) — исполнять нечем:
      // шаг недоступен (понятный код, а не падение процесса).
      if (!opts.toolRegistry && !ctx.step) {
        logger.warning(
          LOG_GROUP,
          `шаг «${ctx.node.id}»: нет инфраструктуры инструментов для вызова «${call.name}»`,
        );
        return { kind: 'unavailable' };
      }
      // Инструмент есть в реестре/контексте, но не найден: модель вызвала
      // неизвестный тул — отказ в историю, цикл продолжается.
      plans.push({
        kind: 'deny',
        call,
        content: t('pipeline.tool_not_found', { tool: call.name, node: ctx.node.id }),
      });
      continue;
    }

    // Решение оператора (после `resume`) — к тому же вызову: право выдано,
    // поэтому permission-чек не повторяется (ADR-101 §2.13). Данные гейта
    // должны быть известны (имя тула): иначе решение закрывает только
    // эскалацию `ask` (см. ниже) — обход `deny` недопустим.
    if (pending && pending.used === false && pending.toolName && matchesPending(pending, call)) {
      pending.used = true;
      if (pending.approved) {
        plans.push({ kind: 'execute', call, toolDef });
        continue;
      }
      logger.info(
        LOG_GROUP,
        `шаг «${ctx.node.id}»: вызов «${call.name}» отклонён оператором`,
      );
      plans.push({
        kind: 'deny',
        call,
        content: t('pipeline.gate_rejected', { node: ctx.node.id }),
      });
      continue;
    }

    const permission = checkStepToolPermission(
      ctx,
      opts.permissions,
      call.name,
      call.args,
      toolDef.capabilities,
    );

    if (permission.action === 'deny') {
      logger.warning(
        LOG_GROUP,
        `шаг «${ctx.node.id}»: вызов «${call.name}» отклонён политикой прав (${permission.reason ?? '—'})`,
      );
      const deny = buildDenyResult({
        reason: permission.reason ?? 'denied by permission policy',
        ...(permission.matchedRule ? { matchedRule: permission.matchedRule } : {}),
        ...(permission.messageId ? { messageId: permission.messageId } : {}),
        ...(permission.params ? { params: permission.params } : {}),
      });
      plans.push({ kind: 'deny', call, content: deny.content });
      continue;
    }

    if (permission.action === 'ask') {
      // Решение оператора (если оно ещё не применено) закрывает эскалацию.
      if (pending && pending.used === false && matchesPending(pending, call)) {
        pending.used = true;
        if (pending.approved) {
          plans.push({ kind: 'execute', call, toolDef });
          continue;
        }
        plans.push({
          kind: 'deny',
          call,
          content: t('pipeline.gate_rejected', { node: ctx.node.id }),
        });
        continue;
      }
      return {
        kind: 'gate',
        gate: {
          kind: 'tool_approval',
          nodeId: ctx.node.id,
          toolName: call.name,
          args: call.args,
          question: describeToolCall(call),
          ...(permission.reason ? { reason: permission.reason } : {}),
          ...(ctx.node.timeoutSec !== undefined ? { timeoutSec: ctx.node.timeoutSec } : {}),
        },
      };
    }

    plans.push({ kind: 'execute', call, toolDef });
  }

  return { kind: 'plans', plans };
}

/**
 * Подготовка шага: системный промпт (ADR-070), сообщение шага, тулы и
 * локальная история.
 */
async function prepareAgentStep(
  ctx: StepExecutionContext,
  provider: BaseProvider,
  llm: NonNullable<StepExecutionContext['llm']>,
): Promise<AgentStepState> {
  const step = ctx.step;
  const tools = toLlmTools(step?.availableTools ?? []);
  const mcpServers = composerMcpServers(step);
  const agentRole = step?.agent?.id ?? ctx.node.agent;

  const composed = await llm.composer.compose({
    session: buildStepSessionLike(ctx),
    ...(step?.agent ? { agentDef: step.agent } : {}),
    ...(agentRole ? { agentRole } : {}),
    workingDir: stepWorkingDir(ctx),
    language: step?.language ?? 'ru',
    // Роутинг (ADR-034) и микро-слой (ADR-035) — механизмы сессии; у шага
    // пайплайна своя (одна) модель.
    routingEnabled: false,
    // Инструкция по обфусцированным секретам нужна ровно тогда, когда вызов
    // идёт через gateway (ADR-036).
    gatewayEnabled: provider instanceof GatewayProvider,
    // Проект уже загружен в контексте шага — composer не читает хранилище.
    project: step?.project ?? null,
    // Описания тулов для манифеста промпта (ADR-070 §2.5) — тот же LLM-формат,
    // что уходит в запрос (приведение типов — как в оркестраторе).
    ...(tools.length ? { tools: tools as unknown as Array<Record<string, unknown>> } : {}),
    toolsPolicy: 'consistency',
    mcpPolicy: 'consistency',
    ...(mcpServers ? { mcpServers } : {}),
    ...(step?.skillsCatalog ? { skillsCatalog: step.skillsCatalog } : {}),
    ...(step?.instructions ? { instructions: step.instructions } : {}),
    // Онбординг-интервью — механизм сессии (ADR-089); шагу не нужен.
    showInterview: false,
    interviewEligible: false,
  });

  const system: SystemPromptPayload = {
    text: composed.system,
    ...(composed.stablePrefix ? { stablePrefix: composed.stablePrefix } : {}),
    // Ключ кэша промпта — стабильный id шага в прогоне (ADR-070 §2.2).
    cacheKey: `pipeline:${ctx.runId}:${ctx.node.id}`,
    cachePolicy: 'auto',
  };

  return {
    provider,
    system,
    messages: [userMessage(buildStepUserMessage(ctx))],
    tools,
  };
}

/**
 * LLM-вызов шага: `GatewayProvider.chat` (ADR-036) — без стрима, с списком
 * доступных тулов.
 *
 * Отмена шага (`ctx.signal`) реализована гонкой: у `chat` нет параметра
 * отмены, поэтому при `abort` шаг завершается, не дожидаясь ответа.
 */
async function callProvider(
  ctx: StepExecutionContext,
  provider: BaseProvider,
  state: AgentStepState,
): Promise<LLMResponse> {
  const call = provider.chat(
    // Снимок локальной истории: провайдер не должен видеть её последующие
    // изменения (цикл Э4.3b дописывает в `state.messages`).
    state.messages.slice(),
    state.system,
    state.tools.length ? (state.tools as unknown as Record<string, unknown>[]) : undefined,
    false,
  );
  // Промис может отвергнуться уже после отмены — «висящий» отказ не должен
  // стать необработанным.
  call.catch(() => undefined);
  return await raceWithAbort(call, ctx.signal);
}

/**
 * Разобранный вызов инструмента из ответа модели (OpenAI-формат:
 * `{id, function: {name, arguments}}`; `arguments` — JSON-строка или объект).
 */
interface ParsedToolCall {
  /** id вызова — для пары «вызов → результат» в истории шага. */
  id: string;
  /** Имя инструмента. */
  name: string;
  /** Аргументы вызова. */
  args: Record<string, unknown>;
  /** Исходная запись ответа модели (в историю идёт как есть + id). */
  raw: Record<string, unknown>;
}

/** Сводка вызовов тулов в выходе шага: имя + признак ошибки (без выводов). */
interface AgentToolCallSummary {
  /** Имя инструмента. */
  name: string;
  /** Инструмент отработал с ошибкой. */
  isError: boolean;
}

/**
 * Разбор вызовов тулов из ответа модели.
 *
 * Вызовы без имени игнорируются (модель ответила мусором — это не ошибка
 * шага). Вызов без `id` получает сгенерированный id: результат тула в
 * истории должен быть парным к вызову (`tool_call_id`).
 */
function parseToolCalls(raw: Record<string, unknown>[] | undefined): ParsedToolCall[] {
  if (!raw || raw.length === 0) return [];
  const calls: ParsedToolCall[] = [];
  for (const entry of raw) {
    const fn = entry.function as
      | { name?: string; arguments?: string | Record<string, unknown> }
      | undefined;
    const name = fn?.name?.trim();
    if (!name) continue;
    const id = typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim() : `call_${calls.length + 1}`;
    calls.push({ id, name, args: parseToolArguments(fn?.arguments), raw: entry });
  }
  return calls;
}

/** Аргументы вызова тула: JSON-строка (обычно) или объект; битый JSON — `{}`. */
function parseToolArguments(raw: string | Record<string, unknown> | undefined): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw === 'object') return { ...raw };
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Краткое описание ожидающего вызова для оператора (вопрос гейта): имя
 * инструмента и аргументы. Технические данные, а не фраза — переводить нечего.
 */
function describeToolCall(call: ParsedToolCall): string {
  let args = '{}';
  try {
    args = JSON.stringify(call.args) ?? '{}';
  } catch {
    args = '{}';
  }
  if (args.length > MAX_GATE_ARGS_CHARS) args = `${args.slice(0, MAX_GATE_ARGS_CHARS)}…`;
  return `${call.name} ${args}`.trim();
}

/**
 * Решение оператора по висящему гейту (ADR-101 §6) — что именно одобрено.
 *
 * Данные гейта (`ctx.gate`) восстанавливает движок из журнала прогона при
 * `resume`; если их нет, решение применяется к первой эскалации `ask`
 * (правило «одно решение — одна эскалация»).
 */
interface PendingGateDecision {
  /** Одобрено ли решение оператора. */
  approved: boolean;
  /** Инструмент, к которому относится решение (если известен). */
  toolName?: string;
  /** Аргументы одобренного вызова (если известны). */
  args?: Record<string, unknown>;
  /** Решение уже применено (одно решение — одна эскалация). */
  used: boolean;
}

/** Решение оператора по гейту из контекста шага (если оно есть). */
function resolvePendingGateDecision(ctx: StepExecutionContext): PendingGateDecision | undefined {
  const decision = ctx.gateDecision;
  if (!decision) return undefined;
  const gate = ctx.gate;
  const output = decision.output ?? {};
  const toolName =
    gate?.toolName ?? (typeof output.toolName === 'string' ? output.toolName : undefined);
  const args = gate?.args ?? (isPlainRecord(output.args) ? output.args : undefined);
  return {
    approved: decision.approved,
    used: false,
    ...(toolName ? { toolName } : {}),
    ...(args ? { args } : {}),
  };
}

/**
 * Относится ли решение оператора к этому вызову.
 *
 * Имя инструмента и аргументы известны — сверяем и их (одобрение одного
 * вызова не должно разрешать другой). Данные гейта неизвестны — решение
 * относится к первой эскалации `ask` (см. `planToolCalls`).
 */
function matchesPending(pending: PendingGateDecision, call: ParsedToolCall): boolean {
  if (pending.used) return false;
  if (!pending.toolName) return true;
  if (pending.toolName !== call.name) return false;
  if (pending.args && !sameArgs(pending.args, call.args)) return false;
  return true;
}

/**
 * Глубокое сравнение аргументов вызова (ключи — в любом порядке).
 *
 * Обе стороны сравниваются **в том же виде, в каком оператор видел их в
 * гейте**: данные гейта приходят из журнала прогона и уже санитизированы
 * (ADR-101 §2.9), поэтому аргументы текущего вызова санитизируются так же —
 * иначе одобренный вызов не совпал бы с повторным (секреты вырезаны,
 * длинные строки обрезаны).
 */
function sameArgs(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  try {
    return (
      JSON.stringify(sortRecord(sanitizeValue(left, 0) as Record<string, unknown>)) ===
      JSON.stringify(sortRecord(sanitizeValue(right, 0) as Record<string, unknown>))
    );
  } catch {
    return false;
  }
}

/** Запись с отсортированными ключами (рекурсивно) — для стабильного сравнения. */
function sortRecord(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const item = value[key];
    out[key] = isPlainRecord(item) ? sortRecord(item) : item;
  }
  return out;
}

/** Обычный объект (не массив и не `null`). */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Предел итераций цикла: не задан или невалиден — дефолт. */
function resolveMaxIterations(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_AGENT_ITERATIONS;
  return Math.max(1, Math.floor(value));
}

/**
 * Сумма расхода токенов по итерациям цикла: usage каждого LLM-вызова
 * складывается (иначе в выходе шага — расход только последнего вызова).
 */
function accumulateUsage(total: TokenUsage | undefined, usage: TokenUsage | undefined): TokenUsage | undefined {
  if (!usage) return total;
  if (!total) return { ...usage };
  const next: TokenUsage = { ...total };
  const keys = [
    'inputTokens',
    'outputTokens',
    'totalTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'reasoningTokens',
  ] as const;
  for (const key of keys) {
    const value = usage[key];
    if (typeof value !== 'number') continue;
    next[key] = (next[key] ?? 0) + value;
  }
  return next;
}

/**
 * «Session-like» объект шага для Composer'а (ADR-101 §10).
 *
 * Composer читает из сессии только роль агента, язык и override системного
 * промпта — остальные настройки сессии (оптимизация контекста, план, микро-слой)
 * шагу не нужны. Полный `SessionSettings` шаг не фабрикует.
 */
function buildStepSessionLike(ctx: StepExecutionContext): ComposerSessionLike {
  const projectId = ctx.projectId ?? ctx.spec.projectId;
  return {
    // Идентификатор шага — тот же, что и ключ кэша промпта (`pipeline:<runId>:<nodeId>`):
    // в контексте провайдера блока промпта (PROP-090) это «sessionId» шага.
    id: `pipeline:${ctx.runId}:${ctx.node.id}`,
    settings: {
      agentRole: ctx.node.agent,
      language: ctx.step?.language ?? 'ru',
    },
    promptStates: {},
    ...(projectId ? { projectId } : {}),
  } as unknown as ComposerSessionLike;
}

/**
 * Пользовательское сообщение шага: задание узла (`node.prompt`) + вход шага
 * (`ctx.input`) в компактной сериализации.
 *
 * Формат — в шапке модуля. Вход отсортирован по путям (детерминированно).
 */
export function buildStepUserMessage(ctx: StepExecutionContext): string {
  const parts: string[] = [];
  const prompt = ctx.node.prompt?.trim();
  if (prompt) parts.push(`[TASK]\n${prompt}`);
  const input = formatStepInput(ctx.input);
  if (input) parts.push(`[INPUT]\n${input}`);
  return parts.join('\n\n');
}

/** Сериализация входа шага: по одному пути на строку, по алфавиту. */
function formatStepInput(input: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const key of Object.keys(input).sort()) {
    const value = input[key];
    if (value === undefined) continue;
    lines.push(`- ${key}: ${formatInputValue(value)}`);
  }
  return lines.join('\n');
}

/** Значение входа шага: однострочная строка как есть, остальное — JSON. */
function formatInputValue(value: unknown): string {
  if (typeof value === 'string') {
    return truncate(value.includes('\n') ? JSON.stringify(value) : value);
  }
  try {
    const json = JSON.stringify(value);
    return truncate(json ?? String(value));
  } catch {
    return truncate(String(value));
  }
}

/** Обрезка длинного значения входа шага. */
function truncate(value: string): string {
  return value.length > MAX_INPUT_VALUE_CHARS
    ? `${value.slice(0, MAX_INPUT_VALUE_CHARS)}…`
    : value;
}

/** Инструменты шага в LLM-формате — только доступные (недоступные не идут). */
function toLlmTools(tools: ToolDefinition[]): ToolForLLM[] {
  return tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: toolParameters(tool),
    },
  }));
}

/** JSON-схема параметров тула (из дефинишена или из Zod-схемы). */
function toolParameters(tool: ToolDefinition): Record<string, unknown> {
  if (tool.jsonSchema) return tool.jsonSchema;
  try {
    return zodToJsonSchema(tool.parameters);
  } catch {
    return { type: 'object', properties: {} };
  }
}

/**
 * MCP-серверы шага для блоков промпта (ADR-071 §2.2): состав — по решениям
 * скоупа контекста шага, тулы — из состава инструментов шага.
 */
function composerMcpServers(step: PipelineStepContext | undefined): ComposerMcpServer[] | undefined {
  if (!step || step.mcpDecisions.length === 0) return undefined;
  return step.mcpDecisions.map((decision) => ({
    name: decision.name,
    level: decision.level,
    status: decision.enabled ? 'connected' : 'disabled',
    ...(decision.reason ? { disabledReason: decision.reason } : {}),
    tools: step.tools
      .filter((tool) => tool.mcpServer === decision.name)
      .map((tool) => ({ name: tool.name, description: tool.description })),
  }));
}

/** Резолвер провайдера шага: ошибка резолвера — «провайдер не найден». */
async function resolveProvider(
  ctx: StepExecutionContext,
  llm: NonNullable<StepExecutionContext['llm']>,
  logger: PipelineEngineLogger,
): Promise<BaseProvider | null> {
  try {
    return await llm.resolveProvider(ctx);
  } catch (err) {
    logger.warning(
      LOG_GROUP,
      `шаг «${ctx.node.id}»: не удалось получить провайдера: ${errorMessage(err)}`,
    );
    return null;
  }
}

/** Дефолты `provider`/`model` инстанса (ADR-089) — диагностика шага. */
async function resolveLlmDefaults(
  llm: NonNullable<StepExecutionContext['llm']>,
): Promise<{ provider?: string; model?: string } | undefined> {
  if (!llm.resolveLlmDefaults) return undefined;
  try {
    return await llm.resolveLlmDefaults();
  } catch {
    return undefined;
  }
}

/** Сообщение пользователя шага в LLM-формате. */
function userMessage(content: string): LLMMessage {
  return {
    id: '',
    role: 'user',
    content,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    disabled: false,
    pinned: false,
    branchId: '',
  };
}

/**
 * Ответ модели в LLM-формате (дописывается в локальную историю шага).
 *
 * Вызовы тулов сохраняются как `toolUse` — так провайдер видит парные
 * `tool_calls`/`tool_result` (как у сессий). id вызовов нормализуются: у
 * вызова без id он генерируется, чтобы результат тула был парным.
 */
function assistantMessage(
  response: LLMResponse,
  ctx: StepExecutionContext,
  toolCalls: ParsedToolCall[],
): LLMMessage {
  return {
    id: '',
    role: 'assistant',
    content: response.content,
    usage: response.usage,
    disabled: false,
    pinned: false,
    branchId: '',
    ...(toolCalls.length
      ? { toolUse: toolCalls.map((call) => ({ ...call.raw, id: call.id })) }
      : {}),
    ...(ctx.step?.agent?.id ? { agentRole: ctx.step.agent.id } : {}),
  };
}

/**
 * Результат вызова тула в LLM-формате (`role: 'tool'`) — дописывается в
 * локальную историю шага. Пара к вызову — по `toolCallId`.
 */
function toolResultMessage(call: ParsedToolCall, content: string): LLMMessage {
  return {
    id: '',
    role: 'tool',
    content: typeof content === 'string' ? content : String(content ?? ''),
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    disabled: false,
    pinned: false,
    branchId: '',
    toolCallId: call.id,
  };
}

/** Ошибка отмены шага (внутренняя — наружу не выходит). */
class StepCancelledError extends Error {
  constructor() {
    super('pipeline step cancelled');
    this.name = 'StepCancelledError';
  }
}

/**
 * Гонка LLM-вызова с сигналом отмены шага: при `abort` вызов прерывается на
 * стороне шага (промис провайдера игнорируется).
 */
function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new StepCancelledError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new StepCancelledError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

/** Отменён ли шаг (по сигналу или по внутренней ошибке отмены). */
function isCancelled(err: unknown, ctx: StepExecutionContext): boolean {
  return err instanceof StepCancelledError || ctx.signal.aborted;
}

/** Текст ошибки провайдера. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Провал шага с кодом ошибки. */
function failed(ctx: StepExecutionContext, code: string, message: string): StepResult {
  return {
    status: 'failed',
    attempt: ctx.attempt,
    error: { code, message },
  };
}

/** Логгер по умолчанию — логгер ядра. */
const defaultLogger: PipelineEngineLogger = {
  info: (group, message) => logInfo(group, message),
  warning: (group, message) => logWarning(group, message),
  error: (group, message) => logError(group, message),
};

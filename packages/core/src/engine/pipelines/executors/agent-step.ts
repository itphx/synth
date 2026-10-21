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
 * ## Отмена
 *
 * У `GatewayProvider.chat` нет параметра отмены (ADR-036), поэтому отмена
 * шага реализована **гонкой**: при `ctx.signal.aborted` шаг завершается с
 * `pipeline.cancelled`, не дожидаясь ответа провайдера (промис вызова
 * игнорируется). Провайдер обрывает собственный запрос по своему таймауту.
 */
import type { LLMResponse, StepResult, ToolDefinition, ToolForLLM } from '@itphx/synth-shared';

import { error as logError, info as logInfo, warning as logWarning } from '../../../logger.js';
import type { BaseProvider, LLMMessage, SystemPromptPayload } from '../../../providers/base.js';
import type { ComposerMcpServer, ComposerSessionLike } from '../../context/composer.js';
import { classifyLlmError, isLlmErrorRecoverable } from '../../llm-error.js';
import { t } from '../../system-messages.js';
import { GatewayProvider } from '../../gateway/index.js';
import { zodToJsonSchema } from '../../tools/json-schema.js';
import type { PipelineStepContext } from '../step-context.js';
import type { PipelinePermissionDeps } from '../permissions.js';
import type {
  PipelineEngineLogger,
  StepExecutionContext,
  StepExecutor,
  StepOutcome,
} from '../types.js';
import { stepWorkingDir, type PipelineToolLookup } from './common.js';

/** Лог-группа исполнителя agent-шага. */
const LOG_GROUP = 'PIPELINE';

/**
 * Предел длины одного значения во входе шага (символов) — вход уже
 * санитизирован движком, но его размер не ограничен: длинное значение
 * обрезается, чтобы не раздувать запрос к модели.
 */
const MAX_INPUT_VALUE_CHARS = 4000;

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
   * Задел для цикла вызовов тулов (Э4.3b).
   */
  permissions?: PipelinePermissionDeps;
  /**
   * Реестр инструментов (ADR-071) — задел для цикла вызовов тулов (Э4.3b).
   */
  toolRegistry?: PipelineToolLookup;
  /** Логгер (по умолчанию — логгер ядра). */
  logger?: PipelineEngineLogger;
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
 * Исполнение agent-шага: провайдер → подготовка (промпт/вход/тулы) → один
 * LLM-вызов → результат шага.
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

  // 5. Один LLM-вызов через GatewayProvider (ADR-036).
  let response: LLMResponse;
  try {
    response = await callProvider(ctx, provider, state);
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

  // 6. Локальная история шага: ответ модели дописывается в неё — с этого
  //    места продолжится цикл вызовов тулов (Э4.3b).
  state.messages.push(assistantMessage(response, ctx));

  // 7. Итог шага: текст ответа и расход токенов. Ничего лишнего (секретов,
  //    внутренних полей провайдера) в выход шага не попадает.
  return {
    status: 'ok',
    attempt: ctx.attempt,
    output: {
      text: response.content,
      ...(response.usage ? { usage: { ...response.usage } } : {}),
    },
  };
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
 * «Session-like» объект шага для Composer'а (ADR-101 §10).
 *
 * Composer читает из сессии только роль агента, язык и override системного
 * промпта — остальные настройки сессии (оптимизация контекста, план, микро-слой)
 * шагу не нужны. Полный `SessionSettings` шаг не фабрикует.
 */
function buildStepSessionLike(ctx: StepExecutionContext): ComposerSessionLike {
  const projectId = ctx.projectId ?? ctx.spec.projectId;
  return {
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

/** Ответ модели в LLM-формате (дописывается в локальную историю шага). */
function assistantMessage(response: LLMResponse, ctx: StepExecutionContext): LLMMessage {
  return {
    id: '',
    role: 'assistant',
    content: response.content,
    usage: response.usage,
    disabled: false,
    pinned: false,
    branchId: '',
    ...(response.toolCalls ? { toolUse: response.toolCalls } : {}),
    ...(ctx.step?.agent?.id ? { agentRole: ctx.step.agent.id } : {}),
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

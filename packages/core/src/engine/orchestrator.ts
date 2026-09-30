import type { Message, Project, Session, ProviderConfig as SharedProviderConfig, TokenUsage, AgentDefinition, PromptMeta, PromptManifest, PromptState, PromptHistoryInfo, PromptHistoryStateMessage, PromptToolDetail, ToolsPolicy, ToolsDisabledConfig, McpServerEffective, McpToolDetail, SkillsDisabledRequest } from '@itphx/synth-shared';
import { MessageRole, nowISO, generateId, makeTextPart, lookupContextWindow, generateStreamId } from '@itphx/synth-shared';
import type { RouterConfig, PermissionConfig, PermissionRule, PlanMode, SessionMode, SecurityConfig, LLMGatewayConfig, ReasoningLevel, PermissionDecision, Currency, InstructionsConfig, WorkspaceOutsideRootPolicy } from '@itphx/synth-shared';
import { join, isAbsolute, normalize, resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import type { SessionManager } from '../sessions/manager.js';
import type { EventBus } from '../events/bus.js';
import { DebugCollector } from '../debug.js';
import { ProviderFactory } from '../providers/base.js';
import { computeCacheHitRate, computeUsageCost } from '../providers/usage.js';
import { ContextLengthExceededError } from '../providers/exceptions.js';
import type { LLMMessage, CancellationToken, ProviderConfig as CoreProviderConfig, BaseProvider, SystemPromptPayload, CachePolicy } from '../providers/base.js';
import { ContextBuilder } from './context/builder.js';
import { ContextOptimizer } from './context/optimizer.js';
import { ContextConfig } from './context/config.js';
import { SystemPromptComposer, type ComposerContext, type ComposerInstructions, type ComposerMcpServer, type ComposerMcpServerStatus } from './context/composer.js';
import { ProjectInstructionsResolver, type InstructionsFileInfo } from './context/instructions.js';
import { LazyInstructionsLoader } from './context/lazy-instructions.js';
import type { ComposerSkillsCatalog } from './skills/catalog.js';
import type { SkillRuntime, SkillScopeOptions } from './skills/types.js';
import type { CommandRuntime } from '@itphx/synth-shared';
import { calibrateCharsPerToken, estimateTokens, estimatePromptChars, DEFAULT_CHARS_PER_TOKEN } from './context/token-ratio.js';
import {
  agentKeyOf,
  buildPromptState,
  computeExpected,
  isBlockChanged,
  isPrefixUnchanged,
  validateExpected,
  type PromptStateReason,
} from './context/prompt-state.js';
import {
  syncStateMessages,
  createStateMessage,
  findLastStateMessage,
  buildModeChangeContent,
  wrapStateContent,
  type UnavailableTool,
} from './context/state-messages.js';
import type { ToolRegistry } from './tools/registry.js';
import type { AgentRegistry } from './agents/registry.js';
import type { McpManager } from './mcp/manager.js';
import { resolveMcpScope, type McpScopeDecision } from './mcp/scope.js';
import { info, warning } from '../logger.js';
import { autoTitleSession } from '../sessions/auto-title.js';
import { ModelRouter } from './router/router.js';
import { ContentClassifier } from './router/content-classifier.js';
import { ProviderPool } from './router/provider-pool.js';
import { QualityChecker } from './router/quality-checker.js';
import { DictionaryStore } from './router/dictionary-store.js';
import { MicroPipeline } from './router/micro/index.js';
import { TaskClassifier } from './router/micro/task-classifier.js';
import { RulesModel, EmbeddingModel, MicroLlmModel } from './router/micro/models/index.js';
import type { MicroModel } from './router/micro/models/base.js';
import type { RoutingDecision } from './router/router.js';
import { PermissionEvaluator, extractPaths } from './permission/evaluator.js';
import { computeToolAvailability } from './permission/availability.js';
import { PermissionApprovalManager } from './permission/approval.js';
import { emptyPermissionConfig } from './permission/derive.js';
import { SSHKeyStore } from '../storage/ssh-key-store.js';
import type { ProjectStoreLike } from '../storage/project-store.js';
import { GitService } from '../git/git-service.js';
import { classifyLlmError, isLlmErrorRecoverable, LLM_MAX_ATTEMPTS, MAX_DOOM_LOOP_COUNT } from './llm-error.js';
import { runSubagentResume, validateSubagentResume, SubagentResumeError, type SubagentResumeDeps } from './tools/task-resume.js';
import { buildDenyResult, executeToolDef } from './tools/tool-execution.js';
import {
  ALL_RUNTIME_DEPS_AVAILABLE,
  RUNTIME_DEP_BINARY,
  TOOL_RUNTIME_DEP,
  type RuntimeDeps,
} from './tools/runtime-deps.js';
import { getToolTrust } from './security/trust.js';
import { detectPromptInjection, applyPolicy, wrapContent, buildWarnLine, type InjectionPolicy } from './security/prompt-injection.js';
import { loadProtectedPaths } from './security/protected-paths.js';
import type { ProtectedPathsPolicy } from './security/protected-paths.js';
import { GatewayProvider, AuditLogger, RateLimiter, ObfuscationMapStore, obfuscateSecrets, maskSecret, PLACEHOLDER_PATTERN, type SecretPatternStore } from './gateway/index.js';
import { t as sm, i18n as i18nMeta } from './system-messages.js';
import { runInlineShell } from './commands/inline-shell.js';
import { TEMPLATE_SHELL_MAX_BYTES } from './commands/template.js';

const DEFAULT_MAX_ITERATIONS = Number.POSITIVE_INFINITY;
/** AD-070: окно троттлинга live-события `stream.usage` (~300 мс). */
const STREAM_USAGE_THROTTLE_MS = 300;
/** Порог заполненности контекстного окна (%), после которого публикуем context.limit_warning. */
const CONTEXT_LIMIT_WARNING_PERCENT = 90;

/**
 * AD-070 §2.6: статус ответа ассистента для строки статистики в UI.
 * - `completed` — нормальный ответ (без префикса);
 * - `cancelled` — отменён пользователем;
 * - `stopped` — остановлен (отказ в туле / блокировка);
 * - `error` — ошибка/пустой ответ LLM;
 * - `limit` — достигнут лимит итераций.
 */
export type AssistantMessageStatus = 'completed' | 'cancelled' | 'stopped' | 'error' | 'limit';

const ASSISTANT_MESSAGE_STATUSES: readonly AssistantMessageStatus[] = [
  'completed', 'cancelled', 'stopped', 'error', 'limit',
];

/** Валидный ли статус (защита от произвольного значения в metadata.status). */
function isAssistantMessageStatus(value: unknown): value is AssistantMessageStatus {
  return typeof value === 'string' && (ASSISTANT_MESSAGE_STATUSES as readonly string[]).includes(value);
}

/**
 * AD-070 §2.6: контекст для сохранения assistant-сообщения об ошибке LLM.
 * Заполняется на месте сбоя (там доступны накопленные usage/контент/debug).
 */
interface LlmFailureContext {
  debugCollector: DebugCollector;
  /** Длительность прогона до сбоя (metadata.duration_ms). */
  durationMs: number;
  /** Фактический usage, если провайдер успел его отдать (иначе — оценка). */
  usage?: TokenUsage;
  model?: string;
  providerName?: string;
  agentRole?: string;
  /** Частичный ответ до сбоя — база для оценки output-токенов. */
  content?: string;
  /** Размер отправленного промпта в символах — база для оценки input-токенов. */
  promptChars?: number;
  toolResults?: Array<Record<string, unknown>>;
  promptMeta?: PromptMeta;
}

export interface ModelPricing {
  inputPrice?: number;
  outputPrice?: number;
  cacheReadPrice?: number;
  cacheWritePrice?: number;
  /** Валюта цен модели; отсутствует → USD (обратная совместимость). */
  currency?: Currency;
}

export interface OrchestratorOptions {
  sessionManager: SessionManager;
  eventBus: EventBus;
  contextBuilder: ContextBuilder;
  providerLoader: (name: string) => SharedProviderConfig | null;
  contextOptimizer?: ContextOptimizer;
  contextConfig?: ContextConfig;
  modelPriceLoader?: (modelName: string) => ModelPricing | null;
  dataDir?: string;
  toolRegistry?: ToolRegistry;
  agentRegistry?: AgentRegistry;
  mcpManager?: McpManager;
  routerConfig?: RouterConfig;
  projectStore?: ProjectStoreLike;
  /**
   * AD-076 §T6: хранилище SSH-ключей для сетевых git-тулов (`git_push`/`git_pull`).
   * Не задано — создаётся лениво из `dataDir` (+ env); без `dataDir` — git
   * использует ambient ssh (реестр/ключи недоступны).
   */
  sshKeyStore?: SSHKeyStore;
  defaultWorkingDir?: string;
  /**
   * Корень каталога workspaces: `join(dataDir, 'workspaces')` по умолчанию
   * (аналог resolveWorkspacesRoot). Относительные `project.workspace` резолвятся
   * относительно этого корня (AD-014).
   */
  workspacesRoot?: string;
  /**
   * AD-075/AD-076: git-сервис для тулов управления репозиториями проекта.
   * Не задан — создаётся лениво из `workspacesRoot`.
   */
  gitService?: GitService;
  /**
   * AD-075: managed-режим проекта (backend): включает строгую проверку явного
   * workspace (deny вне root) в тулах проекта.
   */
  workspaceManaged?: boolean;
  /**
   * AD-075: политика абсолютного workspace вне `workspacesRoot` для тулов проекта.
   * Не задана — `confirm`.
   */
  getWorkspaceOutsideRootPolicy?: () => WorkspaceOutsideRootPolicy | Promise<WorkspaceOutsideRootPolicy>;
  /** Глобальная секция permission из config.yaml (AD-029). */
  permissionConfig?: PermissionConfig;
  /** Строгость цикла Plan→Build по умолчанию из config.yaml session.planMode (AD-028). */
  defaultPlanMode?: PlanMode;
  /** Секция безопасности (защита от Indirect Prompt Injection). */
  securityConfig?: SecurityConfig;
  /** LLM Gateway (AD-036): глобальный тумблер и конфиг. Выключен по умолчанию. */
  gatewayConfig?: LLMGatewayConfig;
  /** Путь к JSONL полного лога запросов/ответов LLM ({dataDir}/audit/llm-payloads.jsonl). */
  gatewayPayloadLogPath?: string;
  /** Аудит LLM Gateway — если создаётся снаружи (backend/runner). Иначе создаётся внутри. */
  gatewayAuditLogger?: AuditLogger;
  /** Хранилище кастомных regex-паттернов детекции секретов (override ?? дефолт). */
  gatewayPatternStore?: SecretPatternStore;
  /** AD-070 §2.2: политика prompt-cache (config llm.cache). Дефолт — auto. */
  cachePolicy?: CachePolicy;
  /**
   * AD-071 §2.3: глобальная админская политика включения **встроенных**
   * инструментов (config.yaml tools.policy). Дефолт — `auto`. Per-session
   * override — `session.settings.toolsPolicy`.
   */
  toolsPolicy?: ToolsPolicy;
  /**
   * AD-071 §2.3: глобальная админская политика включения **MCP**-инструментов
   * (config.yaml mcp.policy). Дефолт — `auto`. Независима от `toolsPolicy`;
   * per-session override — `session.settings.mcpPolicy`.
   */
  mcpPolicy?: ToolsPolicy;
  /**
   * AD-071 §2.6: instance-wide жёсткое отключение инструментов (config.yaml
   * `tools.disabled`). Runtime-значение приходит через `setToolsDisabled`.
   */
  toolsDisabled?: ToolsDisabledConfig;
  /**
   * AD-046 §4.5: системный hard-gate скиллов (категории/группы/имена) из
   * runtime-настроек. Runtime-обновление — `setSkillsDisabled`.
   */
  skillsDisabled?: SkillsDisabledRequest;
  /**
   * AD-070 §2.9.1: доступность внешних программ окружения (git/rg/sh) —
   * детекция `detectRuntimeDeps()`. Не задана — fail-open (все доступны).
   * Runtime-обновление — `setRuntimeDeps`.
   */
  runtimeDeps?: RuntimeDeps;
  /**
   * AD-071 §2.6: chars-per-token модели из runtime-настроек (калибровка).
   * Не задан/нет значения — дефолт `DEFAULT_CHARS_PER_TOKEN`.
   */
  tokenRatioLoader?: (model: string) => Promise<number | undefined>;
  /** AD-071 §2.6: сохранение откалиброванного chars-per-token после ответа. */
  onTokenRatioCalibrated?: (model: string, ratio: number) => void | Promise<void>;
  /**
   * AD-046 §5: рантайм скиллов (SkillService) — каталог в промпт и тул `skill`.
   * Не задан — скиллы не участвуют в промпте/тулах.
   */
  skillRuntime?: SkillRuntime;
  /**
   * AD-046 §7: рантайм `/`-команд (CommandService). Не задан — `/`-команды не
   * резолвятся (сообщение уходит в LLM как есть).
   */
  commandRuntime?: CommandRuntime;
  /**
   * AD-069 Фаза 1: конфигурация проектных инструкций (`AGENTS.md`). Не задана/
   * `enabled:false` — проектные инструкции не грузятся.
   */
  instructionsConfig?: InstructionsConfig;
  /**
   * AD-069 Фаза 2a: `config.skills.trustedProjectDirs` — project-trust гейт
   * инструкций (недоверенный проект виден в диагностике, но не грузится).
   */
  instructionsTrustedProjectDirs?: readonly string[];
}

export interface ProcessMessageResult {
  error?: string;
  errorType?: string;
  canRetry?: boolean;
}

/**
 * AD-069 §2.1/§7: результат резолва проектных инструкций для текущего хода —
 * composer-блок, «сырой» контент (для саб-агентов) и провенанс файлов (для
 * события `context.instructions_loaded` и seed lazy-реестра).
 */
interface ResolvedProjectInstructions {
  instructions: ComposerInstructions;
  content: string;
  files: InstructionsFileInfo[];
}

/** AD-070 §2.5: read-only диагностика промпта для `GET /sessions/:id/prompt`. */
export interface PromptDiagnostics {  manifest: PromptManifest;
  /** AD-070 §2.5: состав слоя истории (`messages`), зеркалит реальную отправку. */
  history: PromptHistoryInfo;
  /** Состояние промпта активного агента (null, если ещё не собирался). */
  promptState: PromptState | null;
  /** `promptMeta` последнего ответа активного агента (null, если нет). */
  lastPromptMeta: PromptMeta | null;
  /** AD-071 §2.6: строки таблицы «Встроенные инструменты» (имя/capability/доступность). */
  toolsDetail: PromptToolDetail[];
}

function toCoreProviderConfig(shared: SharedProviderConfig, model: string, reasoningLevel?: ReasoningLevel): CoreProviderConfig {
  return {
    name: shared.name,
    type: shared.type,
    url: shared.baseUrl || '',
    apiKey: shared.apiKey || '',
    model,
    timeout: shared.timeout,
    reasoningLevel,
  };
}

/**
 * ChatOrchestrator — единый оркестратор обработки чат-сообщений.
 * Предоставляет processMessage callback для QueueProcessor.
 */
export class ChatOrchestrator {
  private readonly _sessionManager: SessionManager;
  private readonly _eventBus: EventBus;
  private readonly _contextBuilder: ContextBuilder;
  private readonly _providerLoader: (name: string) => SharedProviderConfig | null;
  private readonly _optimizer: ContextOptimizer | null;
  private readonly _modelPriceLoader: ((modelName: string) => ModelPricing | null) | null;
  private readonly _toolRegistry: ToolRegistry | null;
  private readonly _agentRegistry: AgentRegistry | null;
  private readonly _mcpManager: McpManager | null;
  private readonly _cancellationTokens = new Map<string, CancellationToken>();
  private readonly _router: ModelRouter | null;
  private readonly _routerConfig: RouterConfig | null;
  private readonly _microPipeline: MicroPipeline | null;
  private readonly _contextConfig: ContextConfig | null;
  private readonly _projectStore: ProjectStoreLike | null;
  /** AD-076 §T6: хранилище SSH-ключей (сетевые git-тулы); null — без dataDir. */
  private readonly _sshKeyStore: SSHKeyStore | null;
  private readonly _gitService: GitService;
  private readonly _workspaceManaged: boolean;
  private readonly _getWorkspaceOutsideRootPolicy:
    | (() => WorkspaceOutsideRootPolicy | Promise<WorkspaceOutsideRootPolicy>)
    | null;
  private readonly _composer: SystemPromptComposer;
  private readonly _defaultWorkingDir: string;
  private readonly _workspacesRoot: string;
  private _permissionConfig: PermissionConfig;
  private readonly _approvalManager: PermissionApprovalManager;
  private readonly _defaultPlanMode: PlanMode;
  private _securityConfig: SecurityConfig;
  private readonly _dictionaryStore: DictionaryStore;
  private _gatewayConfig: LLMGatewayConfig | null;
  private _obfMapStore: ObfuscationMapStore | null;
  private _gatewayAudit: AuditLogger | null;
  private _gatewayRateLimiter: RateLimiter | null;
  private readonly _gatewayPatternStore: SecretPatternStore | null;
  private readonly _dataDir: string;
  /** Путь к JSONL полного лога запросов/ответов LLM (передаётся в GatewayProvider). */
  private readonly _gatewayPayloadLogPath: string | undefined;
  /** Внешний audit-logger (backend/runner) — переиспользуется при live-включении gateway. */
  private readonly _gatewayAuditExternal: AuditLogger | null;
  /** AD-070 §2.2: политика prompt-cache (auto | none) из config llm.cache. */
  private readonly _cachePolicy: CachePolicy;
  /** AD-071 §2.3: глобальная политика включения встроенных инструментов (runtime-изменяемая). */
  private _toolsPolicy: ToolsPolicy;
  /** AD-071 §2.3: глобальная политика включения MCP-инструментов (runtime-изменяемая). */
  private _mcpPolicy: ToolsPolicy;
  /** AD-071 §2.6: instance-wide отключение инструментов (runtime-изменяемая, admin). */
  private _toolsDisabled: ToolsDisabledConfig;
  /** AD-046 §4.5: системный hard-gate скиллов (runtime-изменяемая, admin). */
  private _skillsDisabled: SkillsDisabledRequest;
  /** AD-070 §2.9.1: доступность внешних программ окружения (runtime-изменяемая). */
  private _runtimeDeps: RuntimeDeps;
  /** AD-071 §2.6: загрузчик chars-per-token модели (калибровка). */
  private readonly _tokenRatioLoader: ((model: string) => Promise<number | undefined>) | undefined;
  /** AD-071 §2.6: сохранение калибровки chars-per-token после ответа. */
  private readonly _onTokenRatioCalibrated: ((model: string, ratio: number) => void | Promise<void>) | undefined;
  /** AD-046 §5: рантайм скиллов (каталог промпта + тул `skill`). */
  private readonly _skillRuntime: SkillRuntime | null;
  /** AD-046 §7: рантайм `/`-команд (резолвинг до LLM). */
  private readonly _commandRuntime: CommandRuntime | null;
  /** AD-069 Фаза 1: конфиг проектных инструкций (null — выключено/не задано). */
  private readonly _instructionsConfig: InstructionsConfig | null;
  /** AD-069 Фаза 1: резолвер merged chain `AGENTS.md` (null — выключено). */
  private readonly _instructionsResolver: ProjectInstructionsResolver | null;
  /** AD-069 Фаза 2b: lazy-догрузка вложенных инструкций в tool result. */
  private readonly _lazyInstructions: LazyInstructionsLoader | null;
  private _providerPool: ProviderPool | null;
  /** Политика защищённых путей (СКВОЗНАЯ проверка файловых тулов + shell) — ленивая загрузка с кэшем. */
  private _protectedPaths: ProtectedPathsPolicy | null = null;
  private _protectedPathsLoaded = false;

  /** Публичный доступ к реестру агентов (для сериализации modeApplicable). */
  get agentRegistry(): AgentRegistry | null {
    return this._agentRegistry;
  }

  /**
   * AD-070 §2.6: цены модели для расчёта стоимости сообщений/статистики.
   * Публичный доступ, чтобы роут `/sessions/:id/stats` переиспользовал тот же
   * загрузчик, что и оркестратор (backend не конструирует его повторно).
   */
  getModelPricing(modelName: string): ModelPricing | null {
    return this._modelPriceLoader?.(modelName) ?? null;
  }

  /**
   * Стоимость usage сообщения по цене модели (в валюте pricing). `null` — цен
   * нет (в этом случае `metadata.cost_usd`/`cost_currency` не пишутся).
   */
  private _computeMessageCost(
    model: string | undefined,
    usage: TokenUsage | undefined,
  ): ReturnType<typeof computeUsageCost> {
    if (!model || !usage) return null;
    return computeUsageCost(usage, this._modelPriceLoader?.(model) ?? null);
  }

  /**
   * AD-070 §2.6: fallback-цепочка модели сообщения. Провайдеры выставляют
   * `model` только в финальном чанке (`isFinal`), поэтому при отмене/сбое
   * `chunkModel`/`finalModel` пусты — берём модель провайдера или настройку
   * сессии, иначе `_computeMessageCost` вернёт null и `cost_usd` потеряется.
   */
  private _resolveMessageModel(
    chunkModel: string | undefined,
    finalModel: string | undefined,
    provider: BaseProvider | undefined,
    session: Session,
  ): string | undefined {
    return chunkModel || finalModel || provider?.model || session.settings.model || undefined;
  }

  /**
   * AD-070 §2.6 (Bug 4): best-effort оценка usage, когда провайдер не успел
   * отдать финальный чанк (отмена/сбой). Эвристика `chars / 4` (как в
   * `estTokens`): input — из размера промпта, output — из накопленного
   * контента. Реальные значения не перетираются; при любой дозаполненной
   * части `estimated = true` (вызывающий пишет `metadata.usage_estimated`).
   */
  private _estimateUsage(
    usage: TokenUsage | undefined,
    promptChars: number,
    outputChars: number,
  ): { usage: TokenUsage; estimated: boolean } {
    const base: TokenUsage = usage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    let inputTokens = base.inputTokens || 0;
    let outputTokens = base.outputTokens || 0;
    let estimated = false;

    if (inputTokens <= 0 && promptChars > 0) {
      inputTokens = Math.ceil(promptChars / 4);
      estimated = true;
    }
    if (outputTokens <= 0 && outputChars > 0) {
      outputTokens = Math.ceil(outputChars / 4);
      estimated = true;
    }

    const totalTokens = base.totalTokens && base.totalTokens > 0
      ? base.totalTokens
      : inputTokens + outputTokens;

    return {
      usage: {
        ...base,
        inputTokens,
        outputTokens,
        totalTokens,
      },
      estimated,
    };
  }

  /**
   * Оценка размера промпта (символы) для best-effort input-токенов: сообщения
   * (content + toolUse + reasoning) + system prompt + JSON тулов. Зеркалит
   * отправку в провайдер, не мутирует данные.
   */
  private _estimatePromptChars(
    messages: LLMMessage[],
    systemPrompt: SystemPromptPayload | string | undefined,
    tools?: Record<string, unknown>[],
  ): number {
    const systemText = typeof systemPrompt === 'string' ? systemPrompt : (systemPrompt?.text ?? '');
    return estimatePromptChars(messages, systemText, tools);
  }

  /**
   * AD-070 §2.6: публикация live-статистики стрима (`stream.usage`) через
   * существующий транспорт (publishChunk → EventBus, AD-024).
   *
   * Троттлинг ~300 мс + дедуп по подписи usage (не спамим одинаковыми
   * значениями). Точный usage (`estimated: false`) приоритетнее оценки и
   * публикуется принудительно при первой же возможности, чтобы панель быстро
   * получила реальные токены. `cost_usd`/`cost_breakdown` добавляются только
   * если у модели заданы цены (иначе `computeUsageCost` возвращает null).
   *
   * Live-значения эфемерны: в сессию/агрегаты НЕ пишутся (персистится только
   * финальное сообщение/`stream.done`).
   */
  private _publishLiveUsage(params: {
    publishChunk: (event: string, data: Record<string, unknown>) => void;
    state: {
      lastPublishedAt: number;
      lastSignature: string;
      /** Опубликован точный output (output>0/reasoning) — форсируем один раз. */
      exactPublished: boolean;
      /** Опубликован точный input (Anthropic message_start) — форсируем один раз. */
      inputExactPublished: boolean;
    };
    sessionId: string;
    streamId: string;
    iteration: number;
    agentRole?: string;
    model?: string;
    provider?: string;
    usage: TokenUsage;
    estimated: boolean;
    force?: boolean;
  }): void {
    const signature = [
      params.estimated ? 'e' : 'x',
      params.usage.inputTokens,
      params.usage.outputTokens,
      params.usage.totalTokens,
      params.usage.cacheReadTokens ?? 0,
      params.usage.cacheWriteTokens ?? 0,
      params.usage.reasoningTokens ?? 0,
    ].join(':');
    const now = Date.now();
    if (!params.force && signature === params.state.lastSignature) return;
    if (!params.force && now - params.state.lastPublishedAt < STREAM_USAGE_THROTTLE_MS) return;
    params.state.lastPublishedAt = now;
    params.state.lastSignature = signature;

    const cost = params.model ? this._computeMessageCost(params.model, params.usage) : null;

    params.publishChunk('stream.usage', {
      session_id: params.sessionId,
      stream_id: params.streamId,
      iteration: params.iteration,
      ...(params.agentRole ? { agent_role: params.agentRole } : {}),
      ...(params.model ? { model: params.model } : {}),
      ...(params.provider ? { provider: params.provider } : {}),
      // Копия: провайдеры мутируют объект running total in place — событие
      // должно нести снимок значений на момент публикации.
      usage: { ...params.usage },
      ...(cost ? { cost_usd: cost.costUsd, cost_currency: cost.currency, cost_breakdown: cost.breakdown } : {}),
      estimated: params.estimated,
    });
  }

  /**
   * AD-070 §2.6: агрегация per-message статистики сабагентов из tool-результатов
   * `task` (`result.metadata.subagent_usage`/`subagent_model`). Возвращает
   * breakdown для `metadata.subagents` финального assistant-сообщения; `cost_usd`
   * — номинальная сумма, `cost_by_currency` — разбивка по валютам. `undefined`,
   * если в сообщении нет ни одного task-результата с usage/child_session_id.
   */
  private _aggregateSubagentStats(
    toolResults: Array<Record<string, unknown>>,
  ): {
    sessions: number;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    reasoning_tokens: number;
    cost_usd: number;
    cost_by_currency: Record<string, number>;
  } | undefined {
    let sessions = 0;
    let input = 0;
    let output = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let reasoning = 0;
    let cost = 0;
    const costByCurrency: Record<string, number> = {};
    let found = false;

    for (const raw of toolResults) {
      if (!raw || typeof raw !== 'object') continue;
      const entry = raw as Record<string, unknown>;
      if (entry.name !== 'task') continue;
      const resultMeta = (entry.result as { metadata?: Record<string, unknown> } | undefined)?.metadata;
      if (!resultMeta) continue;
      const childId = resultMeta.child_session_id;
      const usage = resultMeta.subagent_usage as TokenUsage | undefined;
      if (!childId && !usage) continue;

      found = true;
      sessions += 1;
      if (usage) {
        input += usage.inputTokens || 0;
        output += usage.outputTokens || 0;
        cacheRead += usage.cacheReadTokens || 0;
        cacheWrite += usage.cacheWriteTokens || 0;
        reasoning += usage.reasoningTokens || 0;
        const model = (resultMeta.subagent_model as string | undefined)
          || (resultMeta.routing_model as string | undefined);
        const c = this._computeMessageCost(model, usage);
        if (c) {
          cost += c.costUsd;
          costByCurrency[c.currency] = (costByCurrency[c.currency] || 0) + c.costUsd;
        }
      }
    }

    if (!found) return undefined;
    return {
      sessions,
      input_tokens: input,
      output_tokens: output,
      cache_read_tokens: cacheRead,
      cache_write_tokens: cacheWrite,
      reasoning_tokens: reasoning,
      cost_usd: cost,
      cost_by_currency: costByCurrency,
    };
  }

  /**
   * Политика защищённых путей: системный дефолт definitions/protected-paths.json
   * + override {dataDir}/security/protected-paths.json (каскад add/remove).
   * Ленивая загрузка с кэшем; при недоступности dataDir/файлов — системный дефолт.
   */
  private _getProtectedPaths(): ProtectedPathsPolicy | null {
    if (this._protectedPathsLoaded) return this._protectedPaths;
    this._protectedPathsLoaded = true;
    try {
      this._protectedPaths = loadProtectedPaths({ overridePath: join(this._dataDir, 'security', 'protected-paths.json') });
    } catch {
      this._protectedPaths = null;
    }
    return this._protectedPaths;
  }

  /** Включена ли защита защищённых путей (тумблер полного отключения). */
  private _getProtectedPathsEnabled(): boolean {
    return this._securityConfig.protectedPaths?.enabled ?? true;
  }

  /**
   * Локализованный текст сообщения безопасности для model/UI. Для решений с
   * messageId (защищённые пути, запрещённые команды) берётся из промпт-файла;
   * иначе — обычный reason. Текст включает префикс "Permission denied/required".
   */
  private _securityMessage(decision: PermissionDecision, lang: string): string | undefined {
    if (!decision.messageId) return undefined;
    return this._contextConfig?.getSecurityMessage(decision.messageId, lang, decision.params) ?? undefined;
  }

  constructor(options: OrchestratorOptions) {
    this._sessionManager = options.sessionManager;
    this._eventBus = options.eventBus;
    this._contextBuilder = options.contextBuilder;
    this._providerLoader = options.providerLoader;
    this._optimizer = options.contextOptimizer ?? null;
    this._modelPriceLoader = options.modelPriceLoader ?? null;
    this._toolRegistry = options.toolRegistry ?? null;
    this._agentRegistry = options.agentRegistry ?? null;
    this._mcpManager = options.mcpManager ?? null;
    this._routerConfig = options.routerConfig ?? null;
    this._contextConfig = options.contextConfig ?? null;
    this._projectStore = options.projectStore ?? null;
    // AD-076 §T6: хранилище SSH-ключей для git-тулов. Явный store (app/backend)
    // приоритетнее; иначе — ленивое создание из dataDir (мастер-ключ — env
    // SYNTH_SECRET_KEY / файл {dataDir}/secrets/master.key, см. SSHKeyStore).
    this._sshKeyStore = options.sshKeyStore
      ?? (options.dataDir ? new SSHKeyStore({ dataDir: options.dataDir, env: process.env }) : null);
    // AD-070 §2.1: единая точка сборки системного промпта (идемпотентно).
    this._composer = new SystemPromptComposer({
      contextBuilder: this._contextBuilder,
      contextConfig: this._contextConfig,
      projectStore: this._projectStore,
    });
    this._defaultWorkingDir = options.defaultWorkingDir ?? join(options.dataDir || '/var/synth/data', 'workspaces', 'default');
    this._workspacesRoot = options.workspacesRoot ?? join(options.dataDir || '/var/synth/data', 'workspaces');
    // AD-075/AD-076: git-сервис и режим/политика workspace для тулов управления
    // проектом. gitService по умолчанию — над тем же workspacesRoot.
    this._gitService = options.gitService ?? new GitService(this._workspacesRoot);
    this._workspaceManaged = options.workspaceManaged === true;
    this._getWorkspaceOutsideRootPolicy = options.getWorkspaceOutsideRootPolicy ?? null;
    this._permissionConfig = options.permissionConfig ?? emptyPermissionConfig();
    this._approvalManager = new PermissionApprovalManager(this._eventBus);
    this._defaultPlanMode = options.defaultPlanMode ?? 'auto';
    this._securityConfig = options.securityConfig
      ?? { promptInjection: { enabled: true, wrapContent: true, mode: 'flag' }, protectedPaths: { enabled: true }, secretKey: '' };
    this._dataDir = options.dataDir || '/var/synth/data';
    this._gatewayPayloadLogPath = options.gatewayPayloadLogPath
      ?? join(options.dataDir || '/var/synth/data', 'audit', 'llm-payloads.jsonl');
    this._cachePolicy = options.cachePolicy ?? 'auto';
    // AD-071 §2.3: глобальные политики встроенных/MCP-инструментов (независимы);
    // per-session override — в сессии.
    this._toolsPolicy = options.toolsPolicy ?? 'auto';
    this._mcpPolicy = options.mcpPolicy ?? 'auto';
    // AD-071 §2.6: instance-wide отключение инструментов (admin) + калибровка ratio.
    this._toolsDisabled = options.toolsDisabled ?? { capabilities: [], tools: [] };
    this._skillsDisabled = options.skillsDisabled ?? { categories: [], groups: [], skills: [] };
    // AD-070 §2.9.1: зависимости окружения (git/rg/sh) — fail-open по умолчанию.
    this._runtimeDeps = options.runtimeDeps ?? { ...ALL_RUNTIME_DEPS_AVAILABLE };
    this._tokenRatioLoader = options.tokenRatioLoader;
    this._onTokenRatioCalibrated = options.onTokenRatioCalibrated;
    this._skillRuntime = options.skillRuntime ?? null;
    this._commandRuntime = options.commandRuntime ?? null;

    // AD-036: LLM Gateway — включается только при gatewayConfig.enabled=true.
    // ObfuscationMapStore живёт в сессии, RateLimiter и AuditLogger — общие.
    this._gatewayAuditExternal = options.gatewayAuditLogger ?? null;
    const gatewayConfig = options.gatewayConfig?.enabled ? options.gatewayConfig : null;
    this._gatewayConfig = gatewayConfig;
    if (gatewayConfig) {
      this._obfMapStore = new ObfuscationMapStore(this._sessionManager);
      this._gatewayAudit = options.gatewayAuditLogger ?? new AuditLogger(
        gatewayConfig.audit.logPath || join(options.dataDir || '/var/synth/data', 'audit', 'llm-gateway.jsonl'),
      );
      this._gatewayRateLimiter = new RateLimiter(
        gatewayConfig.rateLimit.userPerMinute,
        gatewayConfig.rateLimit.providerPerMinute,
      );
    } else {
      this._obfMapStore = null;
      this._gatewayAudit = options.gatewayAuditLogger ?? null;
      this._gatewayRateLimiter = null;
    }
    this._gatewayPatternStore = options.gatewayPatternStore ?? null;

    // AD-036: суммаризация (ContextOptimizer) создаёт провайдера напрямую —
    // передаём ему общую gateway-обвязку, чтобы эта точка тоже была защищена.
    this._optimizer?.setGatewayHooks(
      gatewayConfig && this._obfMapStore && this._gatewayAudit && this._gatewayRateLimiter
        ? {
            config: gatewayConfig,
            audit: this._gatewayAudit,
            rateLimiter: this._gatewayRateLimiter,
            obfMapStore: this._obfMapStore,
          }
        : null,
    );

    // DictionaryStore и ProviderPool создаём всегда (нужны микро-слою и роутеру)
    const dictionaryStore = new DictionaryStore(options.dataDir || '/var/synth/data');
    this._dictionaryStore = dictionaryStore;
    // AD-069 Фаза 1: резолвер проектных инструкций (merged chain AGENTS.md).
    // Threat-scan использует тот же DictionaryStore, что и tool-контент (AD-036).
    this._instructionsConfig = options.instructionsConfig ?? null;
    this._instructionsResolver =
      this._instructionsConfig?.enabled
        ? new ProjectInstructionsResolver({
            config: this._instructionsConfig,
            dictionaryStore: this._dictionaryStore,
            dataDir: options.dataDir,
            trustedProjectDirs: options.instructionsTrustedProjectDirs,
          })
        : null;
    // AD-069 Фаза 2b: lazy-загрузчик подкаталогов (те же словарь/политики, что
    // у резолвера; состояние `loaded`/`claims` — per-session).
    this._lazyInstructions =
      this._instructionsConfig?.enabled
        ? new LazyInstructionsLoader({
            config: this._instructionsConfig.lazy,
            claudeCompat: this._instructionsConfig.claudeCompat,
            contextCompat: this._instructionsConfig.contextCompat,
            headRatio: this._instructionsConfig.headRatio,
            tailRatio: this._instructionsConfig.tailRatio,
            dictionaryStore: this._dictionaryStore,
          })
        : null;
    // Фабрика обёртки для пула: у пула нет сессии, поэтому оборачиваем с пустой
    // картой обфускации (защита от утечки секретов работает, карта не персистится).
    const pool = new ProviderPool(
      options.providerLoader,
      gatewayConfig ?? undefined,
      gatewayConfig ? this._poolGatewayFactory(gatewayConfig) : undefined,
    );
    this._providerPool = pool;

    // AD-035: Micro-first pipeline — создаём всегда, не зависит от роутера
    const microClassifier = new TaskClassifier(dictionaryStore);
    const microModels: MicroModel[] = [
      new RulesModel(microClassifier),
      new EmbeddingModel(pool),
      new MicroLlmModel(pool),
    ];
    this._microPipeline = new MicroPipeline(microClassifier, microModels);

    // AD-034: Router — только если включён в конфиге
    if (options.routerConfig && options.routerConfig.enabled) {
      const classifier = new ContentClassifier(dictionaryStore);
      const qualityChecker = new QualityChecker();
      this._router = new ModelRouter(classifier, pool, qualityChecker, options.routerConfig);
    } else {
      this._router = null;
    }
  }

  /**
   * AD-036: фабрика gateway-обёртки для ProviderPool — единая точка (конструктор
   * и live-переключение). У пула нет сессии, поэтому карта обфускации пустая:
   * защита от утечки секретов работает, карта не персистится.
   */
  private _poolGatewayFactory(gatewayConfig: LLMGatewayConfig): (inner: BaseProvider) => BaseProvider {
    return (inner) => new GatewayProvider(inner, gatewayConfig, {
      getMap: async () => ({}),
      saveMap: async () => {},
      getAudit: () => this._gatewayAudit!,
      getRateLimiter: () => this._gatewayRateLimiter!,
      payloadLogPath: this._gatewayPayloadLogPath,
      sessionId: '',
      userId: '',
    });
  }

  /**
   * AD-036: live-переключение LLM Gateway (runtime-настройка из UI).
   * config === null/undefined или enabled:false → выключить (убрать обвязку).
   * enabled:true → создать ObfuscationMapStore/AuditLogger/RateLimiter, обновить
   * фабрику ProviderPool, обновить hooks суммаризации.
   */
  setGatewayConfig(config: LLMGatewayConfig | null | undefined): void {
    const gatewayConfig = config?.enabled ? config : null;
    this._gatewayConfig = gatewayConfig;
    if (gatewayConfig) {
      // Карта обфускации живёт в сессиях (Session.obfuscationMap) — не теряется,
      // поэтому store не пересоздаём, если он уже есть.
      this._obfMapStore = this._obfMapStore ?? new ObfuscationMapStore(this._sessionManager);
      // Внешний audit-logger (backend/runner) переиспользуем; иначе создаём по пути runtime-конфига.
      this._gatewayAudit = this._gatewayAuditExternal
        ?? new AuditLogger(gatewayConfig.audit.logPath || join(this._dataDir, 'audit', 'llm-gateway.jsonl'));
      // Лимиты могли поменяться — RateLimiter пересоздаём всегда.
      this._gatewayRateLimiter = new RateLimiter(
        gatewayConfig.rateLimit.userPerMinute,
        gatewayConfig.rateLimit.providerPerMinute,
      );
    } else {
      this._obfMapStore = null;
      this._gatewayAudit = null;
      this._gatewayRateLimiter = null;
    }

    // AD-036: суммаризация (ContextOptimizer) — обновляем gateway-обвязку.
    this._optimizer?.setGatewayHooks(
      gatewayConfig && this._obfMapStore && this._gatewayAudit && this._gatewayRateLimiter
        ? {
            config: gatewayConfig,
            audit: this._gatewayAudit,
            rateLimiter: this._gatewayRateLimiter,
            obfMapStore: this._obfMapStore,
          }
        : null,
    );

    // AD-036: пул кешировал провайдеров без новой обёртки — сбрасываем кеш
    // и обновляем фабрику (по образцу конструктора, с пустой картой обфускации).
    this._providerPool?.setGateway(
      gatewayConfig,
      gatewayConfig ? this._poolGatewayFactory(gatewayConfig) : null,
    );
  }

  /** AD-036: включён ли LLM Gateway (runtime-тумблер / конфиг). */
  isGatewayEnabled(): boolean {
    return !!this._gatewayConfig;
  }

  /**
   * Live-переключение секции «Безопасность» (runtime-настройка из UI).
   * Обновляет тумблер защищённых путей без рестарта сервера.
   */
  setSecurityConfig(config: SecurityConfig | null | undefined): void {
    this._securityConfig = config
      ?? { promptInjection: { enabled: true, wrapContent: true, mode: 'flag' }, protectedPaths: { enabled: true }, secretKey: '' };
  }

  /**
   * AD-029: live-применение глобального таймаута подтверждения (runtime-настройка
   * из UI, раздел «Безопасность»). Обновляет дефолтный permission-конфиг, который
   * наследуют сессии без собственного пер-сессионного permission-конфига.
   */
  setDefaultPermissionTimeout(askTimeoutMs: number): void {
    this._permissionConfig = { ...this._permissionConfig, askTimeoutMs };
  }

  /**
   * AD-071 §2.3: live-применение глобальной политики включения **встроенных**
   * инструментов (runtime-настройка из админки). Per-session override в сессии
   * приоритетнее.
   */
  setToolsPolicy(policy: ToolsPolicy): void {
    this._toolsPolicy = policy;
  }

  /**
   * AD-071 §2.3: live-применение глобальной политики включения **MCP**-инструментов
   * (runtime-настройка из админки). Независима от `setToolsPolicy`; per-session
   * override в сессии приоритетнее.
   */
  setMcpPolicy(policy: ToolsPolicy): void {
    this._mcpPolicy = policy;
  }

  /**
   * AD-071 §2.6: live-применение instance-wide отключения инструментов
   * (runtime-настройка из админки). Жёсткое исключение из запроса независимо от
   * `tools.policy`; `runtime`-capability неотключаема (валидируется на API).
   */
  setToolsDisabled(config: ToolsDisabledConfig): void {
    this._toolsDisabled = {
      capabilities: [...(config.capabilities ?? [])],
      tools: [...(config.tools ?? [])],
    };
  }

  /**
   * AD-046 §4.5: live-применение системного hard-gate скиллов (runtime-настройка).
   * Отключённые скиллы не попадают в каталог промпта и не грузятся тулом `skill`.
   */
  setSkillsDisabled(config: SkillsDisabledRequest): void {
    this._skillsDisabled = {
      categories: [...(config.categories ?? [])],
      groups: [...(config.groups ?? [])],
      skills: [...(config.skills ?? [])],
    };
  }

  /**
   * AD-070 §2.9.1: live-применение доступности внешних программ окружения
   * (git/rg/sh). Вызывается один раз при старте (детекция) или при обновлении;
   * не задано — fail-open (`ALL_RUNTIME_DEPS_AVAILABLE`).
   */
  setRuntimeDeps(deps: RuntimeDeps): void {
    this._runtimeDeps = { ...deps };
  }

  /**
   * AD-071 §2.6: тул жёстко отключён администратором (`tools.disabled`) — по
   * capability или по имени. `runtime` неотключаем (защита на API + здесь).
   */
  private _isAdminDisabled(tool: { name: string; capabilities: readonly string[] }): boolean {
    const disabled = this._toolsDisabled;
    if (disabled.capabilities.length === 0 && disabled.tools.length === 0) return false;
    // Ядро сессии (plan/todo/project/reference/classify) неотключаемо.
    if (tool.capabilities.includes('runtime')) return false;
    if (disabled.tools.includes(tool.name)) return true;
    return tool.capabilities.some((cap) => disabled.capabilities.includes(cap));
  }

  /**
   * AD-071 §2.6: сохранённый chars-per-token модели (без дефолта).
   * `undefined` — калибровки нет (первый семпл EWMA берётся как есть).
   */
  private async _loadTokenRatio(model: string | undefined): Promise<number | undefined> {
    if (!model || !this._tokenRatioLoader) return undefined;
    try {
      const ratio = await this._tokenRatioLoader(model);
      if (typeof ratio === 'number' && Number.isFinite(ratio) && ratio > 0) return ratio;
    } catch {
      // ошибка чтения runtime-настроек не должна ломать сборку промпта
    }
    return undefined;
  }

  /**
   * AD-071 §2.6: chars-per-token модели. Нет калибровки — дефолт 4.
   */
  private async _resolveTokenRatio(model: string | undefined): Promise<number> {
    return (await this._loadTokenRatio(model)) ?? DEFAULT_CHARS_PER_TOKEN;
  }

  /**
   * AD-071 §2.6: калибровка chars-per-token после успешного ответа
   * (`promptChars / usage.inputTokens`). EWMA + границы/порог — в
   * `calibrateCharsPerToken`. Ошибка сохранения не влияет на ход.
   *
   * `currentRatio` — уже загруженное в этом ходе значение (без дефолта):
   * повторно `_tokenRatioLoader` не читаем, а пустое значение корректно даёт
   * первый семпл EWMA «как есть».
   */
  private async _calibrateTokenRatio(
    model: string | undefined,
    promptChars: number,
    usage: TokenUsage | undefined,
    currentRatio: number | undefined,
  ): Promise<void> {
    if (!model || !usage || !this._onTokenRatioCalibrated) return;
    const next = calibrateCharsPerToken(promptChars, usage.inputTokens, currentRatio);
    if (next == null) return;
    try {
      await this._onTokenRatioCalibrated(model, next);
    } catch (e) {
      warning('ORCHESTRATOR', `Не удалось сохранить калибровку chars-per-token: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * AD-071 §2.3/§2.6: единый предикат тулов для `selectForSession`.
   * Всегда исключает admin-disabled; в режиме `available` дополнительно
   * фильтрует по доступности (mode/role/mcpToolSettings).
   */
  private _toolPredicate(
    availability?: (tool: { name: string; capabilities: readonly string[] }) => boolean,
  ): (tool: { name: string; capabilities: readonly string[] }) => boolean {
    return (tool) => {
      if (this._isAdminDisabled(tool)) return false;
      if (availability && !availability(tool)) return false;
      return true;
    };
  }

  /**
   * AD-071 §2.3/§2.6: единый резолвинг политик и выборки инструментов сессии.
   * Используется и при сборке запроса (`_processMessage`), и в диагностике
   * (`getPromptInfo`) — состав tools/mcp.tools не должен расходиться.
   */
  private _buildToolSelection(args: {
    session: Session;
    agentDef: AgentDefinition | undefined;
    effectiveAgentRole: string | undefined;
    activeMcpServers: Iterable<string>;
    providerType?: string;
    sessionMode: SessionMode;
    planMode: PlanMode;
    planApproved: boolean;
  }): {
    toolsPolicy: Exclude<ToolsPolicy, 'auto'>;
    mcpPolicy: Exclude<ToolsPolicy, 'auto'>;
    /** Ленивая выборка — вызывается, когда реестр уже содержит MCP-тулы сессии. */
    select: () => ReturnType<ToolRegistry['selectForSession']>;
  } {
    const {
      session, agentDef, effectiveAgentRole, activeMcpServers,
      providerType, sessionMode, planMode, planApproved,
    } = args;
    const toolsPolicy = this._resolveToolsPolicy(session, providerType);
    const mcpPolicy = this._resolveMcpPolicy(session, providerType);
    // AD-071 §2.3: встроенные и MCP фильтруются независимо — своя политика на слой.
    const availabilityPredicate = (toolsPolicy === 'available' || mcpPolicy === 'available')
      ? this._availabilityPredicate(session, sessionMode, planMode, planApproved, agentDef)
      : undefined;
    // AD-071 §2.6: admin-disabled исключаются всегда, независимо от политики.
    const toolPredicates = {
      builtin: this._toolPredicate(toolsPolicy === 'available' ? availabilityPredicate : undefined),
      mcp: this._toolPredicate(mcpPolicy === 'available' ? availabilityPredicate : undefined),
    };
    const select = (): ReturnType<ToolRegistry['selectForSession']> =>
      (this._toolRegistry && agentDef && effectiveAgentRole
        ? this._toolRegistry.selectForSession(activeMcpServers, toolPredicates)
        : { builtin: [], mcp: [] });
    return { toolsPolicy, mcpPolicy, select };
  }

  /**
   * AD-070 §2.1/§2.5: единая сборка `ComposerContext` для `compose`/`manifest`.
   * `toolSelection` (для манифеста `tools`/`mcp.tools`) передаётся только
   * диагностикой; `project` — уже загруженный проект (AD-071 §2.4).
   */
  private _buildComposerContext(args: {
    session: Session;
    agentDef: AgentDefinition | undefined;
    effectiveAgentRole: string | undefined;
    workingDir: string;
    language: string;
    summaryContent?: string;
    toolsPolicy: Exclude<ToolsPolicy, 'auto'>;
    mcpPolicy: Exclude<ToolsPolicy, 'auto'>;
    tokenRatio: number;
    mcpServers?: ComposerMcpServer[];
    project?: Project | null;
    toolSelection?: ReturnType<ToolRegistry['selectForSession']>;
    debugCollector?: DebugCollector;
    /** AD-046 §5: каталог скиллов (stable/volatile-блоки). */
    skillsCatalog?: ComposerSkillsCatalog;
    /** AD-069 §2.1/§3: проектные инструкции (merged chain AGENTS.md). */
    instructions?: ComposerInstructions;
  }): ComposerContext {
    const {
      session, agentDef, effectiveAgentRole, workingDir, language, summaryContent,
      toolsPolicy, mcpPolicy, tokenRatio, mcpServers, project, toolSelection, debugCollector,
      skillsCatalog, instructions,
    } = args;
    return {
      session,
      agentDef,
      agentRole: effectiveAgentRole,
      agentContextFile: agentDef?.contextFile,
      workingDir,
      language,
      routingEnabled: !!this._router && session.settings.routingEnabled !== false,
      gatewayEnabled: !!this._gatewayConfig,
      historyMessages: session.messages,
      userId: session.userId,
      showInterview: session.settings.showInterview,
      stickyNotes: session.stickyNotes,
      summaryContent: summaryContent || undefined,
      tools: toolSelection
        ? toolSelection.builtin as unknown as Array<Record<string, unknown>>
        : undefined,
      mcpTools: toolSelection
        ? toolSelection.mcp as unknown as Array<Record<string, unknown>>
        : undefined,
      toolsPolicy,
      mcpPolicy,
      adminDisabled: this._toolsDisabled,
      envDeps: this._runtimeDeps,
      tokenRatio,
      mcpServers,
      project,
      debugCollector,
      skillsCatalog,
      instructions,
    };
  }

  /**
   * AD-069 §5.2: политика threat-scan проектных инструкций — та же, что у
   * tool-контента (AD-036), с учётом runtime-тумблера безопасности.
   */
  private _instructionsInjectionPolicy(): { enabled: boolean; mode: InjectionPolicy } {
    const injection = this._securityConfig.promptInjection;
    return {
      enabled: injection?.enabled ?? true,
      mode: (injection?.mode ?? 'flag') as InjectionPolicy,
    };
  }

  /**
   * AD-069 §2.1/§7: резолвит проектные инструкции для сессии.
   *
   * - только при `project.workspace` (AD-040: сессия без проекта инструкции не грузит);
   * - `session.settings.systemPrompt` override → инструкции не добавляются (как
   *   каталог скиллов AD-046);
   * - кап — от окна модели (AD-069 §5.1), окно резолвится как в провайдере.
   */
  private async _resolveProjectInstructions(args: {
    session: Session;
    project: Project | null;
    workingDir: string;
    model?: string;
    language: string;
    signal?: AbortSignal;
  }): Promise<ResolvedProjectInstructions | undefined> {
    const resolver = this._instructionsResolver;
    if (!resolver) return undefined;
    // AD-040: без project.workspace проектный контекст недоступен.
    if (!args.project?.workspace) return undefined;
    // AD-046 §5/AD-069 §9.2: override заменяет system prompt целиком.
    if (args.session.settings.systemPrompt?.trim()) return undefined;

    const contextWindow = this._resolveModelContextWindow(
      args.model || args.session.settings.model || '',
    );

    let result;
    try {
      result = await resolver.resolve({
        workspace: args.workingDir,
        contextWindow,
        language: args.language,
        projectId: args.session.projectId ?? args.project.id,
        signal: args.signal,
        injection: this._instructionsInjectionPolicy(),
      });
    } catch (e) {
      warning('ORCHESTRATOR', `Не удалось загрузить проектные инструкции: ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    }
    if (!result.content) return undefined;

    const loaded = result.files.filter((file) => !file.blocked);
    const provenance = loaded.map((file) => file.path).join(', ') || undefined;
    const status = loaded.some((file) => file.truncated) ? 'truncated' : 'loaded';
    return {
      instructions: { content: result.content, provenance, status },
      content: result.content,
      files: result.files,
    };
  }

  /**
   * AD-046 §7: раннее разрешение `/`-команды до micro-first/LLM.
   *
   * - builtin/unknown/denied/unavailable — локальный ответ (user+assistant
   *   помечаются `ephemeral`, исключаются из LLM-контекста), ранний возврат;
   * - template/skill/bundle — рендер подставляется в пользовательское сообщение
   *   как явный контекст, управление возвращается обычному пути (LLM);
   * - `/summary` — прямая ручная суммаризация; `null` — не команда.
   */
  private async _handleCommand(args: {
    session: Session;
    message: Message;
    signal: AbortSignal;
    publishChunk: (event: string, data: Record<string, unknown>) => void;
    debugCollector: DebugCollector;
    streamId: string;
    effectiveAgentRole: string | undefined;
    workingDir: string;
    /** AD-046 §7.4: evaluator для inline shell — тот же, что в tool-loop. */
    permissionEvaluator: PermissionEvaluator;
    sessionMode: SessionMode;
    planMode: PlanMode;
    planApproved: boolean;
    attempt?: number;
  }): Promise<ProcessMessageResult | null> {
    if (!this._commandRuntime) return null;
    const { session, message, signal, publishChunk, debugCollector, streamId, effectiveAgentRole, workingDir, permissionEvaluator, sessionMode, planMode, planApproved, attempt } = args;
    const input = (message.content ?? '').trim();
    if (!input.startsWith('/')) return null;

    const agentDef = effectiveAgentRole ? this._agentRegistry?.get(effectiveAgentRole) : undefined;
    const permissionConfig = session.settings.permission ?? this._permissionConfig;

    // AD-046 §7.4: inline shell `` !`cmd` `` исполняется только через
    // PermissionEvaluator (AD-029) — как обычный `execute_shell`. allow —
    // исполняем; deny/ask — отказ БЕЗ интерактива: inline shell не поднимает
    // диалог одобрения, а молчаливый auto-approve `ask` был бы обходом прав.
    // Аудит — событие `command.inline_shell` (рядом с `command.invoked`).
    const runShell = async (command: string): Promise<{ output: string; isError: boolean }> => {
      const decision = permissionEvaluator.check({
        toolName: 'execute_shell',
        params: { command },
        workingDir,
        sessionMode,
        planMode,
        planApproved,
        shellPolicy: this._getProtectedPaths() ?? undefined,
        protectedPaths: this._getProtectedPaths() ?? undefined,
        protectedPathsEnabled: this._getProtectedPathsEnabled(),
        runtimeDeps: this._runtimeDeps,
      });
      if (decision.action !== 'allow') {
        this._eventBus.publish(session.id, 'command.inline_shell', {
          session_id: session.id,
          command,
          denied: true,
          reason: decision.reason,
        });
        return {
          output: sm('command.inline_shell_denied', { command, reason: decision.reason }),
          isError: true,
        };
      }
      const exec = await runInlineShell({ command, workingDir, abortSignal: signal });
      this._eventBus.publish(session.id, 'command.inline_shell', {
        session_id: session.id,
        command,
        exitCode: exec.exitCode,
        truncated: Buffer.byteLength(exec.output, 'utf-8') > TEMPLATE_SHELL_MAX_BYTES,
        ...(exec.isError ? { failed: true } : {}),
      });
      return { output: exec.output, isError: exec.isError };
    };

    let result;
    try {
      result = await this._commandRuntime.resolve(input, {
        projectWorkspace: workingDir,
        capabilities: agentDef?.capabilities,
        agent: { id: effectiveAgentRole, groups: agentDef?.groups },
        sessionEnabled: session.settings.skills,
        sessionDisabled: session.settings.skillsDisabled,
        permissionConfig,
        runShell,
      });
    } catch {
      return null;
    }
    if (!result) return null;

    this._eventBus.publish(session.id, 'command.invoked', {
      session_id: session.id,
      command: result.name,
      args: result.args,
      actor: message.source === 'cli' ? 'cli' : 'user',
    });

    // `/summary` — ручная суммаризация (как routes/sessions.ts).
    if (result.status === 'summarization') {
      if (!this._optimizer || !this._optimizer.canSummarize(session)) {
        return this._finishLocalCommand(
          session,
          message,
          publishChunk,
          sm('command.summary_unavailable'),
          streamId,
          { name: result.name, args: result.args, i18nKey: 'command.summary_unavailable' },
        );
      }
      const sysMsg: Message = {
        id: generateId(),
        role: MessageRole.SYSTEM,
        seq: 0,
        origin: 'local',
        parts: [{ id: generateId(), type: 'text', data: '' }],
        content: '',
        createdAt: nowISO(),
        disabled: false,
        pinned: false,
        hidden: false,
        metadata: { type: 'summarization_request', reason: 'manual', stream_id: streamId },
      };
      return this._handleSummarization(session, sysMsg, signal, publishChunk, debugCollector, streamId, attempt);
    }

    // template/skill/bundle: инжектируем рендер в пользовательское сообщение.
    if (result.prompt !== undefined) {
      message.content = result.prompt;
      message.parts = [makeTextPart(result.prompt)];
      message.metadata = {
        ...(message.metadata ?? {}),
        command: { name: result.name, kind: result.kind, args: result.args },
      };
      const idx = session.messages.findIndex((m) => m.id === message.id);
      if (idx >= 0) session.messages[idx] = { ...session.messages[idx]!, ...message };
      await this._sessionManager.updateSession(session).catch(() => {});
      for (const skillName of result.skills ?? []) {
        this._eventBus.publish(session.id, 'skill.invoked', {
          session_id: session.id,
          name: skillName,
          source: 'user',
          ...(effectiveAgentRole ? { agent: effectiveAgentRole } : {}),
          ...(result.kind === 'bundle' ? { bundle: result.name } : {}),
        });
      }
      return null;
    }

    return this._finishLocalCommand(session, message, publishChunk, result.output ?? '', streamId, {
      name: result.name,
      args: result.args,
    });
  }

  /**
   * AD-046 §7.1: завершение локального ответа (builtin/команда/micro-first) теми
   * же событиями, что обычный стрим — `stream.chunk` + `stream.done`, иначе
   * SSE-цикл `POST /sessions/:id/prompt` не закрывается (ждёт `stream.done`).
   */
  private _publishLocalCompletion(
    publishChunk: (event: string, data: Record<string, unknown>) => void,
    streamId: string,
    content: string,
    opts?: {
      model?: string;
      provider?: string;
      usage?: TokenUsage;
      durationMs?: number;
      metadata?: Record<string, unknown>;
      /** AD-046 §7.1: index/id сохранённого assistant-сообщения — UI не плодит копии. */
      messageIndex?: number;
      messageId?: string;
    },
  ): void {
    publishChunk('stream.chunk', {
      stream_id: streamId,
      content,
      is_final: true,
      ...(opts?.model ? { model: opts.model } : {}),
      ...(opts?.provider ? { provider: opts.provider } : {}),
    });
    publishChunk('stream.done', {
      stream_id: streamId,
      content,
      pending_count: 0,
      model: opts?.model ?? 'command',
      provider: opts?.provider ?? 'command',
      ...(opts?.messageIndex !== undefined ? { message_index: opts.messageIndex } : {}),
      ...(opts?.messageId ? { message_id: opts.messageId } : {}),
      ...(opts?.usage ? { usage: opts.usage } : {}),
      ...(opts?.durationMs !== undefined ? { duration_ms: opts.durationMs } : {}),
      ...(opts?.metadata ? { metadata: opts.metadata } : {}),
    });
  }

  /**
   * Локальный ответ команды: user сообщение — `ephemeral`, ассистент — `ephemeral`.
   *
   * `command` (AD-046 §7.1) — имя/аргументы системной (builtin) команды: уходят в
   * `metadata` ассистента, чтобы UI отрисовал нейтральный system-блок, а не ответ
   * агента (бейдж/статистику). `model`/`provider` = `command` — тот же признак для
   * live-стрима. Для `/summary`-нотиса (недоступна суммаризация) передаётся
   * `{ name: 'summary' }`.
   */
  private async _finishLocalCommand(
    session: Session,
    userMessage: Message,
    publishChunk: (event: string, data: Record<string, unknown>) => void,
    output: string,
    streamId: string,
    command?: { name: string; args?: string; i18nKey?: string },
  ): Promise<ProcessMessageResult> {
    // Признак команды для UI — и в сохранённом assistant-сообщении, и в
    // `stream.done.metadata`: локальный ответ приходит в UI через stream.done
    // (без `message.added`), поэтому без metadata оптимистичное сообщение
    // отрисовалось бы как ответ агента.
    const commandMetadata: Record<string, unknown> = {
      command: true,
      ...(command ? { commandName: command.name, commandArgs: command.args ?? '' } : {}),
      // AD-041: строки движка локализуются в UI по `metadata.i18n`.
      ...(command?.i18nKey ? { i18n: i18nMeta(command.i18nKey) } : {}),
    };

    const assistant: Message = {
      id: generateId(),
      role: MessageRole.ASSISTANT,
      seq: 0,
      origin: 'local',
      parts: [makeTextPart(output)],
      content: output,
      createdAt: nowISO(),
      disabled: false,
      pinned: false,
      hidden: false,
      ephemeral: true,
      model: 'command',
      provider: 'command',
      agentRole: userMessage.agentRole || session.settings.agentRole,
      metadata: commandMetadata,
    };

    // Помечаем пользовательское сообщение эфемерным и командным (`commandPrompt` —
    // UI не рисует отдельный user-пузырь: команда объединена с выводом) и сохраняем
    // ДО addMessage, иначе updateSession(session) перезапишет сессию без только что
    // добавленного ответа. Существующие metadata не затираем.
    userMessage.ephemeral = true;
    userMessage.metadata = { ...(userMessage.metadata ?? {}), commandPrompt: true };
    const idx = session.messages.findIndex((m) => m.id === userMessage.id);
    if (idx >= 0) {
      session.messages[idx] = {
        ...session.messages[idx]!,
        ephemeral: true,
        metadata: userMessage.metadata,
      };
    }
    await this._sessionManager.updateSession(session).catch(() => {});

    // Сохраняем ответ и только потом публикуем завершение: нужны реальные
    // `message_index`/`message_id`, иначе UI в `finishStream` вычислит index
    // fallback'ом и столкнётся с user-командой (дубли ключей в списке).
    const updated = await this._sessionManager.addMessage(session.id, assistant);
    const messageIndex = updated ? updated.messages.length - 1 : undefined;
    const userIndex = updated
      ? updated.messages.findIndex((m) => m.id === userMessage.id)
      : -1;

    // Обновляем user-команду в UI (upsert по index в `chatStore.addMessage`):
    // live `message.added` из процессора нёс metadata без `commandPrompt`,
    // поэтому без повторной публикации пузырь команды оставался видимым.
    if (userIndex >= 0) {
      this._eventBus.publish(session.id, 'message.added', {
        message_index: userIndex,
        role: userMessage.role,
        content: userMessage.content ?? '',
        author: userMessage.author,
        agent_role: userMessage.agentRole,
        metadata: userMessage.metadata,
      });
    }

    this._publishLocalCompletion(publishChunk, streamId, output, {
      model: 'command',
      provider: 'command',
      metadata: commandMetadata,
      messageIndex,
      messageId: assistant.id,
    });
    return {};
  }

  /**
   * AD-046 §5: каталог скиллов для промпта (аналог `_collectComposerMcpServers`).
   * Учитывает project-trust, binding агента, capability-aware и permission-deny
   * (`deny` скрывает). Ошибка discovery не должна ломать ход — возвращаем
   * `undefined` (блоки не добавляются).
   */
  private async _collectSkillsCatalog(args: {
    session: Session;
    agentDef: AgentDefinition | undefined;
    effectiveAgentRole: string | undefined;
    workingDir: string;
    permissionConfig: PermissionConfig;
    project?: Project | null;
  }): Promise<ComposerSkillsCatalog | undefined> {
    if (!this._skillRuntime) return undefined;
    const { session, agentDef, effectiveAgentRole, workingDir, permissionConfig, project } = args;
    try {
      return await this._skillRuntime.buildCatalog({
        projectWorkspace: workingDir,
        agent: { id: effectiveAgentRole, groups: agentDef?.groups },
        capabilities: agentDef?.capabilities,
        permissionConfig,
        ...this._skillScopeFor(session, project ?? null),
      });
    } catch {
      return undefined;
    }
  }

  /**
   * AD-046 §4.5: scope-гейты скиллов сессии (система/проект/сессия) — единый
   * объект для каталога промпта и тула `skill` (в т.ч. у саб-агентов).
   */
  private _skillScopeFor(session: Session, project: Project | null): SkillScopeOptions {
    return {
      // Проект без `skills` — гейт не задан (legacy, доступно всё).
      projectEnabled: project?.skills ? project.skills.enabled : undefined,
      defaultOn: session.settings.skillsDefaultOn,
      systemDisabled: this._skillsDisabled,
      sessionEnabled: session.settings.skills,
      sessionDisabled: session.settings.skillsDisabled,
    };
  }

  /**
   * AD-071 §2.3: резолвит эффективную политику **встроенных** инструментов для
   * сессии. Приоритет: `session.settings.toolsPolicy` → глобальная
   * (`tools.policy`). `auto` разрешается по провайдеру запроса: локальные
   * (`ollama`) → `available`, облачные → `consistency`. Флага локальности у
   * провайдера/модели нет, поэтому признак — тип провайдера `ollama`
   * (см. AD-071 §2.3, решение зафиксировано).
   */
  private _resolveToolsPolicy(
    session: Session,
    providerType?: string,
  ): Exclude<ToolsPolicy, 'auto'> {
    return this._resolvePolicy(session.settings.toolsPolicy ?? this._toolsPolicy, providerType);
  }

  /**
   * AD-071 §2.3: резолвит эффективную политику **MCP**-инструментов для сессии.
   * Приоритет: `session.settings.mcpPolicy` → глобальная (`mcp.policy`).
   * Независима от `_resolveToolsPolicy`; `auto` разрешается так же — по
   * провайдеру запроса (`ollama` → `available`, иначе `consistency`).
   */
  private _resolveMcpPolicy(
    session: Session,
    providerType?: string,
  ): Exclude<ToolsPolicy, 'auto'> {
    return this._resolvePolicy(session.settings.mcpPolicy ?? this._mcpPolicy, providerType);
  }

  /** AD-071 §2.3: общий резолв `auto` по типу провайдера для обеих политик. */
  private _resolvePolicy(
    requested: ToolsPolicy,
    providerType?: string,
  ): Exclude<ToolsPolicy, 'auto'> {
    if (requested === 'auto') {
      return providerType === 'ollama' ? 'available' : 'consistency';
    }
    return requested;
  }

  /**
   * AD-071 §2.3: тип провайдера сессии для резолва `auto` в read-only
   * диагностике (`getPromptInfo`), где нет объекта провайдера запроса.
   */
  private _sessionProviderType(session: Session): string | undefined {
    const name = session.settings.provider;
    if (!name) return undefined;
    return this._providerLoader(name)?.type;
  }

  /**
   * AD-071 §2.3: предикат доступности тула для режима `available` — тот же
   * `computeToolAvailability`, что использует permission-слой (AD-070 §2.9.1).
   * В запрос попадают только тулы с `available: true`.
   */
  private _availabilityPredicate(
    session: Session,
    sessionMode: SessionMode,
    planMode: PlanMode,
    planApproved: boolean,
    agentDef: AgentDefinition | undefined,
  ): (tool: { name: string; capabilities: readonly string[] }) => boolean {
    const opts = {
      sessionMode,
      planMode,
      planApproved,
      mcpToolSettings: session.settings.mcpToolSettings,
      agentCapabilities: agentDef?.capabilities,
      runtimeDeps: this._runtimeDeps,
    };
    return (tool) => computeToolAvailability(tool.name, tool.capabilities, opts).available;
  }

  /**
   * AD-036: обфусцирует user-сообщение при сохранении в историю (до отправки в LLM).
   * Карта обфускации сессии обновляется и сохраняется; в message.metadata.secrets
   * встраиваются реальные значения для раскрытия в UI. Если gateway выключен или
   * секретов не найдено — возвращает сообщение без изменений (обратная совместимость).
   */
  async obfuscateUserMessageForHistory(sessionId: string, message: Message): Promise<Message> {
    if (!this._gatewayConfig || !this._obfMapStore) return message;
    try {
      const map = await this._obfMapStore.get(sessionId);
      const { text, map: newMap, found } = obfuscateSecrets(message.content, map);
      if (found.length === 0) return message;
      await this._obfMapStore.set(sessionId, newMap);
      // AD-036: аудит обфускации user-сообщения (секреты — только маской,
      // плейсхолдеры — без значений). Не должен ронять обфускацию.
      try {
        await this._gatewayAudit?.append({
          ts: nowISO(),
          type: 'obfuscated',
          sessionId,
          userId: message.author || undefined,
          provider: message.provider,
          model: message.model,
          secretsFound: found.map((s) => maskSecret(s)),
          placeholders: Object.keys(newMap),
        });
      } catch (e) {
        warning('ORCHESTRATOR', `Ошибка аудита обфускации: ${e instanceof Error ? e.message : String(e)}`);
      }
      const metadata = { ...(message.metadata || {}) };
      const secrets: Record<string, string> = { ...(metadata.secrets as Record<string, string> | undefined) };
      for (const ph of Object.keys(newMap)) {
        if (text.includes(ph)) secrets[ph] = newMap[ph]!;
      }
      if (Object.keys(secrets).length > 0) metadata.secrets = secrets;
      return { ...message, content: text, parts: [makeTextPart(text)], metadata };
    } catch (e) {
      warning('ORCHESTRATOR', `Ошибка обфускации user-сообщения: ${e instanceof Error ? e.message : String(e)}`);
      return message;
    }
  }

  /**
   * Рабочий каталог сессии: `project.workspace` → `defaultWorkingDir`.
   * `project` можно передать уже загруженным (AD-071 §2.4) — тогда повторного
   * чтения `projectStore` не происходит; `undefined` — загрузить, `null` — проекта нет.
   */
  private async _resolveWorkingDir(session: Session, project?: Project | null): Promise<string> {
    let resolved: Project | null;
    if (project !== undefined) {
      resolved = project;
    } else {
      resolved = null;
      if (session.projectId && this._projectStore) {
        try {
          resolved = await this._projectStore.load(session.projectId);
        } catch {
          // проект не загрузился — используем fallback
        }
      }
    }
    if (resolved?.workspace) {
      // Абсолютный workspace — как есть (normalize); относительный —
      // резолвим относительно workspacesRoot (AD-014).
      const dir = isAbsolute(resolved.workspace)
        ? normalize(resolved.workspace)
        : resolve(this._workspacesRoot, resolved.workspace);
      // AD-075: каталог проектного workspace гарантированно создаётся к моменту
      // работы инструмента (как и для дефолтного ниже).
      await mkdir(dir, { recursive: true }).catch(() => {});
      return dir;
    }
    const dir = this._defaultWorkingDir;
    await mkdir(dir, { recursive: true }).catch(() => {});
    return dir;
  }

  /**
   * AD-070 §2.9.1: собирает недоступные сейчас тулы реестра с причиной
   * (`mode`/`role`) для chronological-сообщений `mode_change`/`agent_switch`.
   * Список tool-дефинишенов постоянен — фильтрация по режиму/роли здесь только
   * для информирования модели, а не для скрытия тулов.
   */
  private _collectUnavailableTools(
    session: Session,
    sessionMode: SessionMode,
    planMode: PlanMode,
    planApproved: boolean,
    agentDef: AgentDefinition | undefined,
    mcpServers: Iterable<string> = [],
    /**
     * AD-071 §2.3: какие слои включать в подсказки. Слой с политикой
     * `available` в запросе уже сужен до доступных — подсказки о его
     * недоступных тулах не нужны.
     */
    include: { builtin: boolean; mcp: boolean } = { builtin: true, mcp: true },
  ): UnavailableTool[] {
    if (!this._toolRegistry) return [];
    const unavailable: UnavailableTool[] = [];
    // AD-071 §2.1: MCP-тулы вне активных серверов сессии не подсказываем —
    // глобальный реестр держит их постоянно, но скоуп сессии фильтруется.
    const activeMcp = new Set(mcpServers);
    for (const tool of this._toolRegistry.list()) {
      const source = tool.source ?? 'builtin';
      if (source === 'mcp') {
        if (!include.mcp) continue;
        if (tool.mcpServer == null || !activeMcp.has(tool.mcpServer)) continue;
      } else if (!include.builtin) {
        continue;
      }
      // AD-071 §2.6: admin-disabled — не подсказываем (ограничение администратора,
      // а не режим/роль).
      if (this._isAdminDisabled(tool)) continue;
      const availability = computeToolAvailability(tool.name, tool.capabilities, {
        sessionMode,
        planMode,
        planApproved,
        mcpToolSettings: session.settings.mcpToolSettings,
        agentCapabilities: agentDef?.capabilities,
        runtimeDeps: this._runtimeDeps,
      });
      if (!availability.available && availability.reason) {
        const dep = availability.reason === 'dependency' ? TOOL_RUNTIME_DEP[tool.name] : undefined;
        unavailable.push({
          name: tool.name,
          reason: availability.reason,
          ...(dep ? { binary: RUNTIME_DEP_BINARY[dep] } : {}),
        });
      }
    }
    return unavailable;
  }

  /** AD-071 §2.4: загрузка проекта сессии (для проектного MCP-скоупа). */
  private async _loadProject(session: Session): Promise<Project | null> {
    if (!session.projectId || !this._projectStore) return null;
    try {
      return await this._projectStore.load(session.projectId);
    } catch {
      return null;
    }
  }

  /**
   * AD-071 §2.4: решения по эффективному набору MCP. Модель per-item:
   * системный мастер (`systemEnabled`) → проектный hard-gate (`project.enabled`)
   * → сессионный opt-out → снапшот/явное включение. Системный мастер — только
   * реестровое `enabled` (`config.enabled` — сид, не гейт). Уровень по приоритету
   * `system > project > session`. Чистый резолвинг — I/O только загрузка проекта
   * (передаётся снаружи, чтобы не читать дважды).
   */
  private _resolveMcpDecisions(session: Session, project: Project | null): McpScopeDecision[] {
    const manager = this._mcpManager;
    if (!manager) return [];
    const config = manager.getConfig();
    const servers = Object.keys(config).map((name) => ({
      name,
      origin: manager.getServerOrigin(name),
      systemEnabled: manager.isServerSystemEnabled(name),
    }));
    return resolveMcpScope(servers, project?.mcp, {
      enabled: session.settings.mcpServers,
      disabled: session.settings.mcpDisabledServers,
      defaultOn: session.settings.mcpDefaultOn,
    });
  }

  /**
   * AD-071 §2.2: статус MCP-сервера для API/промпта. Отключённый сервер —
   * `disabled`; иначе — состояние менеджера (`circuit-open`/`connected`/`error`).
   */
  private _resolveMcpServerStatus(name: string, enabled: boolean): ComposerMcpServerStatus {
    if (!enabled) return 'disabled';
    const raw = this._mcpManager?.getServerStatus(name);
    return raw === 'circuit-open' ? 'circuit-open' : raw === 'connected' ? 'connected' : 'error';
  }

  /**
   * AD-071 §2.1: имена активных MCP-серверов сессии (эффективный скоуп).
   * Используется для наследования MCP-скоупа resumed-саб-агентом от родителя.
   */
  private async _resolveActiveMcpServers(session: Session): Promise<string[]> {
    if (!this._mcpManager) return [];
    const project = await this._loadProject(session);
    return this._resolveMcpDecisions(session, project).filter((d) => d.enabled).map((d) => d.name);
  }

  /**
   * AD-071 §2.4: эффективный список MCP-серверов сессии (включая отключённые с
   * причиной) — единый источник для API `GET /sessions/:id/mcp` и промпта.
   */
  async resolveMcpServers(session: Session): Promise<McpServerEffective[]> {
    const manager = this._mcpManager;
    if (!manager) return [];
    const project = await this._loadProject(session);
    const decisions = this._resolveMcpDecisions(session, project);
    // AD-071 §2.6: единый ratio для оценок токенов (калибровка модели сессии).
    const tokenRatio = await this._resolveTokenRatio(session.settings.model);
    return decisions.map((d) => {
      const status = this._resolveMcpServerStatus(d.name, d.enabled);
      const rawTools = manager.getServerTools(d.name) ?? [];
      // AD-071 §2.6: пер-тульные chars/estTokens — по тому же JSON-определению,
      // что уходит в слой `mcp.tools` (имя с префиксом сервера + [MCP:...]).
      const toolDetails: McpToolDetail[] = rawTools.map((tool) => {
        const fullName = `${d.name}_${tool.name}`;
        const chars = JSON.stringify({
          type: 'function',
          function: {
            name: fullName,
            description: `[MCP:${d.name}] ${tool.description}`,
            parameters: tool.inputSchema,
          },
        }).length;
        const adminDisabled = this._isAdminDisabled({ name: fullName, capabilities: ['mcp'] });
        return {
          name: tool.name,
          chars,
          estTokens: estimateTokens(chars, tokenRatio),
          ratio: tokenRatio,
          ...(adminDisabled ? { adminDisabled: true } : {}),
        };
      });
      const chars = toolDetails.reduce((sum, t) => sum + t.chars, 0);
      return {
        name: d.name,
        level: d.level,
        enabled: d.enabled,
        ...(d.reason ? { reason: d.reason } : {}),
        connected: status === 'connected',
        status,
        origin: d.origin,
        trust: manager.getServerTrust(d.name),
        author: manager.getServerAuthor(d.name),
        tools: rawTools.map((tool) => tool.name),
        chars,
        estTokens: estimateTokens(chars, tokenRatio),
        ratio: tokenRatio,
        toolDetails,
      };
    });
  }

  /**
   * AD-071 §2.2: данные MCP-серверов для промпта (`mcp.servers` — stable,
   * `mcp.status` — volatile). Возвращает **все** настроенные серверы, включая
   * отключённые (с уровнем и причиной), чтобы состав был наблюдаем.
   * `undefined`, если менеджера нет или список серверов пуст (тогда блоков нет).
   */
  private _collectComposerMcpServers(decisions: McpScopeDecision[]): ComposerMcpServer[] | undefined {
    const manager = this._mcpManager;
    if (!manager) return undefined;
    if (decisions.length === 0) return undefined;

    return decisions.map((decision) => {
      const name = decision.name;
      const status = this._resolveMcpServerStatus(name, decision.enabled);

      const description = manager.getServerDescription(name);
      const instructions = manager.getServerInstructions(name);
      const tools = manager.getServerTools(name) ?? [];

      return {
        name,
        level: decision.level,
        ...(description ? { description } : {}),
        ...(instructions ? { instructions } : {}),
        tools: tools.map((tool) => ({
          name: tool.name,
          ...(tool.description ? { description: tool.description } : {}),
        })),
        status,
        ...(decision.reason ? { disabledReason: decision.reason } : {}),
      };
    });
  }

  /**
   * AD-070 §2.8: смена режима в середине хода — добавляет durable
   * `mode_change` state-сообщение в историю и синтетическое user-сообщение с
   * обёрткой `<system-state>` в текущий LLM-диалог (для последующих итераций).
   * System prompt не пересобирается — смена режима его не меняет.
   */
  private async _appendModeChangeState(
    session: Session,
    sessionMode: SessionMode,
    planMode: PlanMode,
    planApproved: boolean,
    language: string,
    currentMessages: LLMMessage[],
    unavailableTools: UnavailableTool[] = [],
  ): Promise<void> {
    const content = buildModeChangeContent(
      sessionMode, planMode, planApproved, language, this._contextConfig, unavailableTools,
    );
    if (!content) return;
    // Идемпотентно: не дублируем mode_change, если состояние не изменилось
    // (например, plan_enter при уже активном plan-режиме).
    const last = findLastStateMessage(session.messages, 'mode_change');
    if (last && last.content === content) return;
    const stateMsg = createStateMessage('mode_change', content);
    await this._sessionManager.addMessage(session.id, stateMsg);
    session.messages.push(stateMsg);
    currentMessages.push({
      id: '',
      role: 'user',
      content: wrapStateContent('mode_change', content),
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      disabled: false,
      pinned: false,
      branchId: '',
    });
  }

  /**
   * AD-070 §2.5: read-only диагностика состава системного промпта для API/UI.
   * Возвращает манифест (тот же обход, что и `compose`), состояние промпта
   * активного агента и `promptMeta` последнего ответа. Побочных эффектов нет:
   * `promptStates` не пишется, `captureSystemPromptParts` не вызывается.
   */
  async getPromptInfo(session: Session): Promise<PromptDiagnostics> {
    const effectiveAgentRole = session.settings.agentRole;
    const agentDef = effectiveAgentRole ? this._agentRegistry?.get(effectiveAgentRole) : undefined;
    // AD-071 §2.4: проект загружаем один раз — для рабочего каталога и Composer.
    const project = await this._loadProject(session);
    const workingDir = await this._resolveWorkingDir(session, project);
    const language = session.settings.language || 'ru';

    const optimizedMessages = this._optimizer
      ? this._optimizer.getMessagesForLlm(session)
      : session.messages;
    const summaryContent = optimizedMessages
      .filter((m) => m.role === MessageRole.SUMMARY)
      .map((m) => m.content)
      .join('\n\n');

    // AD-071 §2.1/§2.3/§2.4: тот же per-session список инструментов, что уходит в
    // запрос (`_processMessage`) — встроенные + MCP эффективного набора сессии
    // (instance defaultOn ∪ project defaultOn ∪ session enabled − opt-out);
    // в режиме `available` — только доступные (mode/role/mcpToolSettings).
    const mcpDecisions = this._resolveMcpDecisions(session, project);
    const activeMcpServers = mcpDecisions.filter((d) => d.enabled).map((d) => d.name);
    const planMode: PlanMode = session.settings.planMode ?? this._defaultPlanMode ?? 'auto';
    const sessionMode: SessionMode = session.mode ?? 'act';
    const planApproved = Boolean(session.planApproved);
    const providerType = this._sessionProviderType(session);
    const { toolsPolicy, mcpPolicy, select } = this._buildToolSelection({
      session, agentDef, effectiveAgentRole, activeMcpServers, providerType,
      sessionMode, planMode, planApproved,
    });
    const toolSelection = select();
    // AD-071 §2.6: chars-per-token модели (калибровка) для оценок токенов.
    const tokenRatio = await this._resolveTokenRatio(session.settings.model);

    // AD-070 §2.5 + AD-071 §2.1/§2.3: манифест отражает реальные слои запроса —
    // `tools` (встроенные) и `mcp.tools` (MCP сессии); тир `tools` зависит от
    // `tools.policy`, MCP-блоки всегда volatile.
    // AD-046 §5: каталог скиллов — тем же путём, что и в запросе.
    const skillsCatalog = await this._collectSkillsCatalog({
      session,
      agentDef,
      effectiveAgentRole,
      workingDir,
      permissionConfig: session.settings.permission ?? this._permissionConfig,
      project,
    });
    // AD-069 Фаза 1: те же проектные инструкции, что и в запросе (манифест).
    const projectInstructions = await this._resolveProjectInstructions({
      session,
      project,
      workingDir,
      model: session.settings.model,
      language,
    });
    const ctx: ComposerContext = this._buildComposerContext({
      session, agentDef, effectiveAgentRole, workingDir, language, summaryContent,
      toolsPolicy, mcpPolicy, tokenRatio,
      // AD-071 §2.2: блоки `mcp.servers`/`mcp.status` — все серверы эффективного набора.
      mcpServers: this._collectComposerMcpServers(mcpDecisions),
      project,
      toolSelection,
      skillsCatalog,
      instructions: projectInstructions?.instructions,
    });

    const manifest = await this._composer.manifest(ctx);
    const promptState = session.promptStates?.[agentKeyOf(effectiveAgentRole)] ?? null;
    const lastPromptMeta = this._lastPromptMeta(session, effectiveAgentRole);
    const history = this._buildPromptHistoryInfo(session, effectiveAgentRole, tokenRatio);
    // AD-071 §2.6: per-tool данные встроенных инструментов для таблицы статистики.
    // Доступность считается тем же `computeToolAvailability`, что и в запросе;
    // admin-disabled помечается отдельной причиной и имеет приоритет.
    const toolsDetail: PromptToolDetail[] = (this._toolRegistry?.listBuiltin() ?? []).map((tool) => {
      const availability = computeToolAvailability(tool.name, tool.capabilities, {
        sessionMode,
        planMode,
        planApproved,
        mcpToolSettings: session.settings.mcpToolSettings,
        agentCapabilities: agentDef?.capabilities,
        runtimeDeps: this._runtimeDeps,
      });
      const adminDisabled = this._isAdminDisabled(tool);
      // chars = JSON.stringify LLM-определения (тот же расчёт, что слой `tools`).
      const chars = JSON.stringify(this._toolRegistry!.toLLM(tool)).length;
      const reason: PromptToolDetail['reason'] = adminDisabled
        ? 'admin_disabled'
        : availability.reason;
      return {
        name: tool.name,
        capabilities: [...tool.capabilities],
        available: !adminDisabled && availability.available,
        ...(reason ? { reason } : {}),
        source: 'built-in' as const,
        chars,
        estTokens: estimateTokens(chars, tokenRatio),
        ratio: tokenRatio,
        ...(adminDisabled ? { adminDisabled: true } : {}),
      };
    });
    return { manifest, history, promptState, lastPromptMeta, toolsDetail };
  }

  /**
   * AD-070 §2.5: состав слоя истории (`messages`) — read-only. Зеркалит
   * реальную отправку через тот же `_sessionMessagesToLlm`, что и
   * `_processMessage`, чтобы статистика не расходилась с запросом.
   */
  private _buildPromptHistoryInfo(
    session: Session,
    agentRole?: string,
    tokenRatio: number = DEFAULT_CHARS_PER_TOKEN,
  ): PromptHistoryInfo {
    const sent = ChatOrchestrator._sessionMessagesToLlm(session.messages, agentRole, session.userId);

    // Сообщения: chars = content + JSON(toolUse) + reasoning, estTokens — по
    // калиброванному chars-per-token (как в манифесте промпта).
    let chars = 0;
    let secretPlaceholders = 0;
    const placeholderRe = new RegExp(PLACEHOLDER_PATTERN.source, 'g');
    for (const msg of sent) {
      let msgChars = msg.content.length;
      if (msg.toolUse) msgChars += JSON.stringify(msg.toolUse).length;
      if (msg.reasoning) msgChars += msg.reasoning.length;
      chars += msgChars;
      const matches = msg.content.match(placeholderRe);
      if (matches) secretPlaceholders += matches.length;
    }

    // State-сообщения: role system (не disabled/hidden), текст — как уходит в LLM.
    const stateMap = new Map<string, { count: number; chars: number }>();
    for (const msg of session.messages) {
      if (msg.role !== MessageRole.SYSTEM || msg.disabled || msg.hidden) continue;
      const type = typeof msg.metadata?.type === 'string' ? msg.metadata.type : 'state';
      const entry = stateMap.get(type) ?? { count: 0, chars: 0 };
      entry.count += 1;
      entry.chars += wrapStateContent(type, msg.content).length;
      stateMap.set(type, entry);
    }
    const stateMessages: PromptHistoryStateMessage[] = [...stateMap.entries()]
      .map(([type, v]) => ({
        type,
        count: v.count,
        chars: v.chars,
        estTokens: estimateTokens(v.chars, tokenRatio),
      }))
      .sort((a, b) => b.chars - a.chars || a.type.localeCompare(b.type));

    // Исключённые: ровно то, что отфильтровывает `_sessionMessagesToLlm`.
    const excluded = { disabled: 0, hidden: 0, info: 0 };
    for (const msg of session.messages) {
      if (msg.disabled) excluded.disabled += 1;
      if (msg.hidden) excluded.hidden += 1;
      if (msg.role === MessageRole.INFO) excluded.info += 1;
    }

    // Вложения: нетекстовые части отправляемых сообщений.
    let attachmentCount = 0;
    let attachmentChars = 0;
    for (const msg of session.messages) {
      if (msg.disabled || msg.hidden || msg.role === MessageRole.INFO) continue;
      for (const part of msg.parts) {
        if (part.type === 'text') continue;
        attachmentCount += 1;
        const data = part.data === undefined ? '' : JSON.stringify(part.data) ?? '';
        const meta = (part as { metadata?: unknown }).metadata;
        const metaStr = meta === undefined ? '' : JSON.stringify(meta) ?? '';
        attachmentChars += data.length + metaStr.length;
      }
    }

    return {
      messages: { count: sent.length, chars, estTokens: estimateTokens(chars, tokenRatio) },
      stateMessages,
      excluded,
      attachments: { count: attachmentCount, chars: attachmentChars },
      secretPlaceholders,
    };
  }

  /** `promptMeta` последнего assistant-сообщения активного агента. */
  private _lastPromptMeta(session: Session, agentRole?: string): PromptMeta | null {
    for (let i = session.messages.length - 1; i >= 0; i--) {
      const msg = session.messages[i]!;
      if (msg.role !== MessageRole.ASSISTANT || !msg.promptMeta) continue;
      if (agentRole && msg.promptMeta.agentRole && msg.promptMeta.agentRole !== agentRole) continue;
      return msg.promptMeta;
    }
    return null;
  }

  /**
   * processMessage callback для QueueProcessor.
   */
  createProcessMessage(): (
    session: Session,
    message: Message,
    signal: AbortSignal,
    publishChunk: (event: string, data: Record<string, unknown>) => void,
    /** Номер попытки (1-based) для решения о терминальности сбоя (AD-070 §2.6). */
    attempt?: number,
  ) => Promise<ProcessMessageResult> {
    return async (session, message, signal, publishChunk, attempt) => {
      return this._processMessage(session, message, signal, publishChunk, attempt);
    };
  }

  async _processMessage(
    session: Session,
    message: Message,
    signal: AbortSignal,
    publishChunk: (event: string, data: Record<string, unknown>) => void,
    attempt?: number,
  ): Promise<ProcessMessageResult> {
    const streamId = (message.metadata?.stream_id as string) || 'unknown';
    const effectiveAgentRole = message.agentRole || session.settings.agentRole;
    const author = message.author || 'unknown';
    // AD-071 §2.4: проект сессии — носитель project-скоупа MCP; загружаем один
    // раз: нужен рабочему каталогу, state-сообщениям, резолвингу MCP и Composer.
    let projectForState: Project | null = null;
    if (session.projectId && this._projectStore) {
      try {
        projectForState = await this._projectStore.load(session.projectId);
      } catch {
        projectForState = null;
      }
    }
    const workingDir = await this._resolveWorkingDir(session, projectForState);
    // AD-070 §2.6: старт прогона — для per-message duration_ms (полная
    // длительность у финального сообщения потока, включая tool-chain).
    const streamStartedAt = Date.now();

    // AD-025: режим Plan/Act — runtime-состояние сессии + строгость из настроек
    const planMode: PlanMode = session.settings.planMode ?? this._defaultPlanMode ?? 'auto';
    let sessionMode: SessionMode = session.mode ?? 'act';
    let planApproved = Boolean(session.planApproved);

    // AD-029: permissions — сессионный override приоритетнее глобального конфига.
    // Конфиг может быть расширен «разрешить в сессии» (once:false) в процессе
    // обработки, поэтому ссылка и эвалуатор пересоздаются.
    let effectivePermissionConfig = session.settings.permission ?? this._permissionConfig;
    let permissionEvaluator = new PermissionEvaluator(effectivePermissionConfig);

    const agentDef = effectiveAgentRole ? this._agentRegistry?.get(effectiveAgentRole) : undefined;
    const agentMaxSteps = agentDef?.maxSteps;
    const maxIterations = (agentMaxSteps !== undefined && agentMaxSteps > 0)
      ? agentMaxSteps
      : DEFAULT_MAX_ITERATIONS;

    // Уровень размышлений агента: если агент не задал — берём настройку сессии
    const effectiveReasoningLevel = agentDef?.reasoningLevel ?? session.settings.reasoningLevel;

    const debugCollector = new DebugCollector(session.settings.debugEnabled);

    // --- Обработка системных сообщений (суммаризация, шедулер, etc.) ---
    if (message.role === MessageRole.SYSTEM && message.metadata?.type === 'summarization_request') {
      return this._handleSummarization(session, message, signal, publishChunk, debugCollector, streamId, attempt);
    }
    if (message.role === MessageRole.SYSTEM && message.metadata?.type === 'debug_system_message') {
      return this._handleDebugSystemMessage(session, message, signal, publishChunk, debugCollector, streamId, effectiveReasoningLevel, attempt);
    }

    // --- AD-046 §7: резолвинг `/`-команд в core, до LLM ---
    if (message.role === MessageRole.USER && (message.content ?? '').trimStart().startsWith('/')) {
      const commandResult = await this._handleCommand({
        session, message, signal, publishChunk, debugCollector, streamId,
        effectiveAgentRole, workingDir, attempt,
        permissionEvaluator, sessionMode, planMode, planApproved,
      });
      if (commandResult) return commandResult;
      // prompt-команда (template/skill/bundle): сообщение заменено, идём в LLM.
    }

    // --- AD-035: Micro-first — пробуем ответить без LLM ---
    if (this._microPipeline && session.settings.microFirst) {
      const microResult = await this._microPipeline.handle({
        userMessage: message.content,
        language: session.settings.language,
        sessionSettings: session.settings,
        embedProvider: session.settings.embedProvider,
        embedModel: session.settings.embedModel,
      });
      if (microResult.handled && microResult.microResult?.answer) {
        // Микрослой уверен — возвращаем ответ без вызова LLM
        const finalContent = microResult.microResult.answer;
        const finalModel = `micro:${microResult.microResult.taskClass}`;
        const finalUsage = {
          inputTokens: microResult.microResult.usage?.inputTokens ?? 0,
          outputTokens: microResult.microResult.usage?.outputTokens ?? 0,
          totalTokens: (microResult.microResult.usage?.inputTokens ?? 0) + (microResult.microResult.usage?.outputTokens ?? 0),
        };

        this._publishLocalCompletion(publishChunk, streamId, finalContent, {
          model: finalModel,
          provider: 'micro',
          usage: finalUsage,
          durationMs: Date.now() - streamStartedAt,
        });

        // Сохраняем сообщение ассистента
        const microMetadata: Record<string, unknown> = {
          stream_id: streamId,
          duration_ms: Date.now() - streamStartedAt,
          ...(microResult.microResult.i18nKey
            ? { i18n: i18nMeta(microResult.microResult.i18nKey) }
            : {}),
          micro_first: {
            label: microResult.microResult.label,
            confidence: microResult.microResult.confidence,
            latencyMs: microResult.microResult.latencyMs,
            signals: microResult.microResult.signals,
            taskClass: microResult.microResult.taskClass,
          },
        };

        const assistantMsg: Message = {
          id: generateId(),
          role: MessageRole.ASSISTANT,
          seq: 0,
          origin: 'local',
          parts: [makeTextPart(finalContent)],
          content: finalContent,
          createdAt: nowISO(),
          disabled: false,
          pinned: false,
          hidden: false,
          model: finalModel,
          provider: 'micro',
          usage: finalUsage,
          agentRole: effectiveAgentRole,
          metadata: microMetadata,
        };

        await this._sessionManager.addMessage(session.id, assistantMsg);

        // Обновляем токены сессии
        session.inputTokens += finalUsage.inputTokens;
        session.outputTokens += finalUsage.outputTokens;
        session.totalTokens += finalUsage.totalTokens;

        // Авто-тайтл если это первое сообщение
        if (session.messages.filter((m) => m.role === MessageRole.USER && !m.ephemeral).length <= 1) {
          try {
            session.title = sm('session.dialog_title', { id: session.id.slice(0, 8) });
            await this._sessionManager.saveSession(session);
          } catch {
            // ok
          }
        }

        info('MICRO', `Ответ через микро-слой: ${microResult.microResult.taskClass} (${microResult.microResult.latencyMs}ms, confidence=${microResult.microResult.confidence.toFixed(2)})`);
        return {};
      }

      // Если handled=false — продолжаем обычный путь (router → LLM)
      if (microResult.fallbackSignals?.length) {
        debugCollector.addContext('micro_first', {
          status: 'fallback',
          signals: microResult.fallbackSignals,
          taskClass: microResult.microResult?.taskClass ?? 'llm_task',
        });
      }
    }

    try {
      // 1. Get provider (через роутер если доступен, иначе напрямую)
      const routeResult = this._routeProvider(session, message, effectiveReasoningLevel);
      if (!routeResult) {
        const providerName = (message.provider as string) || session.settings.provider || '';
        return {
          error: sm('router.provider_not_found', { provider: providerName || sm('router.provider_unspecified') }),
          errorType: 'provider_not_found',
          canRetry: false,
        };
      }
      const { provider, providerName, decision: routingDecision } = routeResult;

      debugCollector.captureSessionInfo(session.id, provider.model, provider.name, {
        provider_type: provider.type,
        debug_enabled: session.settings.debugEnabled,
        stream_enabled: session.settings.streamEnabled,
        context_optimization: session.settings.contextOptimization,
      });

      // AD-070 §2.8: синхронизируем режим/план/todo durable state-сообщениями
      // истории (до сборки LLM-сообщений). Идемпотентно — при неизменном
      // состоянии ничего не добавляется; system prompt при этом не меняется.
      const language = session.settings.language || 'ru';
      // AD-071 §2.4: проект сессии уже загружен выше (projectForState) —
      // повторно хранилище не читаем.
      // AD-071 §2.1/§2.4: эффективный набор MCP сессии — per-session скоуп:
      // (instance defaultOn ∪ project defaultOn ∪ session enabled) − opt-out.
      // Определяем до state-сообщений (unavailable-подсказки) и до сборки tools.
      const mcpDecisions = this._resolveMcpDecisions(session, projectForState);
      const activeMcpServers = mcpDecisions.filter((d) => d.enabled).map((d) => d.name);
      const activeMcpSet = new Set(activeMcpServers);
      // AD-071 §2.3: эффективные политики инструментов для этого хода (per-session
      // override → глобальная; `auto` → по типу провайдера). Встроенные и MCP —
      // независимо; в `available` слой фильтруется по доступности, а подсказки
      // `unavailable` для него не нужны. `select()` вызывается позже — после
      // ленивой регистрации MCP-тулов сессии.
      const { toolsPolicy, mcpPolicy, select } = this._buildToolSelection({
        session, agentDef, effectiveAgentRole, activeMcpServers, providerType: provider.type,
        sessionMode, planMode, planApproved,
      });
      const stateSync = syncStateMessages(session, {
        contextConfig: this._contextConfig,
        language,
        plan: projectForState?.plan ?? null,
        agentRole: effectiveAgentRole,
        // AD-071 §2.3: слой с политикой `available` уже сужен до доступных —
        // подсказки `unavailable(mode|role)` для него не добавляем (слои
        // независимы: built-in-подсказки сохраняются при mcp=available и наоборот).
        unavailableTools: this._collectUnavailableTools(
          session, sessionMode, planMode, planApproved, agentDef, activeMcpServers,
          { builtin: toolsPolicy !== 'available', mcp: mcpPolicy !== 'available' },
        ),
      });
      if (stateSync.changed) {
        for (const stateMsg of stateSync.added) {
          await this._sessionManager.addMessage(session.id, stateMsg);
        }
        // Локальная сессия должна увидеть новые state-сообщения при сборке
        // messagesForLlm в этом же ходе.
        session.messages.push(...stateSync.added);
      }

      // 2. Build context (сначала получить summary из сообщений)
      const optimizedMessages = this._optimizer
        ? this._optimizer.getMessagesForLlm(session)
        : session.messages;

      const summaryContent = optimizedMessages
        .filter((m) => m.role === MessageRole.SUMMARY)
        .map((m) => m.content)
        .join('\n\n');

      // AD-071 §2.1: MCP-тулы активных серверов сессии. Регистрация ленивая и
      // аддитивная (без deregister при смене набора): глобальный реестр держит
      // MCP-тулы для executor'а, а per-session скоуп обеспечивает выборка ниже
      // (`selectForSession`) — кросс-сессионной утечки нет. Загружаем до сборки
      // промпта, чтобы блок `mcp.servers` видел тулы подключённых серверов.
      if (this._mcpManager && this._toolRegistry && activeMcpServers.length > 0) {
        await this._mcpManager.ensureToolsLoaded(activeMcpServers, this._toolRegistry);
      }

      // AD-071 §2.6: chars-per-token модели хода (калибровка) для оценок токенов.
      // `loadedTokenRatio` (без дефолта) переиспользуется при калибровке после
      // ответа — повторного чтения runtime-настроек нет.
      const loadedTokenRatio = await this._loadTokenRatio(provider.model || session.settings.model);
      const tokenRatio = loadedTokenRatio ?? DEFAULT_CHARS_PER_TOKEN;

      // AD-070 §2.1/§2.8: единая идемпотентная сборка системного промпта
      // Composer'ом. `session.settings.systemPrompt` override, classification/
      // gateway/plan-guide/mode-policy/session-context — внутри compose.
      // Режим/план/todo — уже в state-сообщениях истории (выше), не в system.
      // AD-046 §5: каталог скиллов — stable/volatile-блоки (deny скрывает).
      const skillsCatalog = await this._collectSkillsCatalog({
        session,
        agentDef,
        effectiveAgentRole,
        workingDir,
        permissionConfig: session.settings.permission ?? this._permissionConfig,
        project: projectForState,
      });
      // AD-069 Фаза 1: проектные инструкции (merged chain AGENTS.md) —
      // только при project.workspace и без systemPrompt-override.
      const projectInstructions = await this._resolveProjectInstructions({
        session,
        project: projectForState,
        workingDir,
        model: provider.model,
        language,
        signal,
      });
      // AD-069 §9.3: прозрачность — событие о загруженных проектных инструкциях.
      // Публикуется только в реальном ходе (manifest/getPromptInfo — read-only).
      if (projectInstructions && projectInstructions.files.length > 0) {
        this._eventBus.publish(session.id, 'context.instructions_loaded', {
          session_id: session.id,
          source: 'initial',
          agent: effectiveAgentRole,
          files: projectInstructions.files.map((file) => ({
            path: file.path,
            chars: file.chars,
            truncated: file.truncated,
            scanned: file.scanned,
            blocked: file.blocked,
          })),
        });
        // AD-069 §4.3.5: merged-chain уже в system prompt — seed lazy-реестра,
        // чтобы lazy не дублировал эти файлы в tool result.
        this._lazyInstructions?.seed(
          session.id,
          projectInstructions.files.filter((file) => file.kind === 'chain').map((file) => file.path),
        );
      }
      const composerCtx: ComposerContext = this._buildComposerContext({
        session, agentDef, effectiveAgentRole, workingDir, language, summaryContent,
        // AD-071 §2.3: `toolsPolicy` влияет на тир `tools`, `mcpPolicy` — на
        // инструкцию `tools.guide`; MCP-блоки всегда volatile.
        toolsPolicy, mcpPolicy, tokenRatio,
        // AD-071 §2.2: блоки `mcp.servers`/`mcp.status` — все серверы эффективного набора.
        mcpServers: this._collectComposerMcpServers(mcpDecisions),
        // AD-071 §2.4: уже загруженный проект — Composer не читает хранилище.
        project: projectForState,
        // AD-070 §2.5: per-message collector доходит до Composer через контекст.
        debugCollector,
        skillsCatalog,
        instructions: projectInstructions?.instructions,
      });
      const composed = await this._composer.compose(composerCtx);
      // AD-070 §2.2: в провайдер уходит payload с границей stable-префикса и
      // ключом кэша (стабильный id сессии). При override
      // `session.settings.systemPrompt` stablePrefix не задаём (безопаснее).
      const hasSystemPromptOverride = !!session.settings.systemPrompt?.trim();
      const finalSystemPrompt: SystemPromptPayload = {
        text: composed.system,
        stablePrefix: hasSystemPromptOverride ? undefined : (composed.stablePrefix || undefined),
        cacheKey: session.id,
        cachePolicy: this._cachePolicy,
      };

      // AD-070 §2.4/§2.7 (Ф2-часть 2): состояние промпта per-agent. При
      // `systemPrompt`-override закреплённый префикс пустой (не кэшируем
      // пользовательский оверрайд). Запись в сессию — только при смене
      // generation (init / смена префикса / override); на обычном сообщении
      // состояние только сравнивается.
      const agentKey = agentKeyOf(effectiveAgentRole);
      const prevPromptState = session.promptStates?.[agentKey] ?? null;
      const promptStateInput = {
        system: composed.system,
        stablePrefix: hasSystemPromptOverride ? '' : composed.stablePrefix,
        blocks: composed.blocks,
      };
      const expectedCache = computeExpected(prevPromptState, promptStateInput);
      let activePromptState = prevPromptState;
      // AD-069 §11/AD-070 §2.4: блок `instructions` лежит в тире `context`, а
      // `isPrefixUnchanged` сравнивает только stable-префикс. Поэтому смену
      // контента инструкций отслеживаем отдельно — иначе promptStates/generation
      // не инвалидируются при изменении `AGENTS.md`.
      const instructionsChanged = isBlockChanged(prevPromptState, composed.blocks, 'instructions');
      if (!prevPromptState || !isPrefixUnchanged(prevPromptState, promptStateInput) || instructionsChanged) {
        const reason: PromptStateReason = hasSystemPromptOverride
          ? 'override'
          : prevPromptState
            ? 'generation-change'
            : 'init';
        activePromptState = buildPromptState(promptStateInput, prevPromptState, reason);
        session.promptStates = {
          ...(session.promptStates ?? {}),
          [agentKey]: activePromptState,
        };
        await this._sessionManager.saveSession(session);
      }
      const promptMeta: PromptMeta = {
        agentRole: effectiveAgentRole,
        generation: activePromptState?.generation ?? 0,
        expected: expectedCache,
        cachedTokens: 0,
        validated: false,
      };

      // 3. Convert messages for LLM (без summary — они уже в system prompt)
      const messagesForLlm = optimizedMessages.filter((m) => m.role !== MessageRole.SUMMARY);
      const baseLlmMessages = ChatOrchestrator._sessionMessagesToLlm(messagesForLlm, effectiveAgentRole, author);

      // 4. Get tools from registry. AD-070 §2.9 + AD-071 §2.1/§2.3: встроенные —
      // постоянно, MCP — только активных серверов сессии; каждый слой в своём
      // `available` — только доступные (mode/role/mcpToolSettings). Порядок:
      // builtin → MCP. Если агент НЕ найден в реестре или role undefined —
      // модель получает НИКАКИХ инструментов (safety-fallback).
      // `select()` — после ensureToolsLoaded (реестр уже содержит MCP-тулы).
      const toolSelection = select();
      const tools = this._toolRegistry
        ? [...toolSelection.builtin, ...toolSelection.mcp]
        : undefined;
      // AD-071 §2.1: граница stable-слоя инструментов для кэш-брейкпоинта
      // (Anthropic) — после встроенных, до MCP. MCP после границы не кэшируется.
      finalSystemPrompt.stableToolCount = toolSelection.builtin.length;

      // 5. Create cancellation token
      // Внутренний AbortController: абортится и по cancelToken.cancel()
      // (POST /sessions/:id/abort → orchestrator.cancel), и по внешнему signal
      // (cancelRetry в QueueProcessor). Его signal передаётся в тулы
      // (ctx.abortSignal) — долгие тулы (например task/сабагент) подписываются
      // на него и прерываются сразу, не дожидаясь завершения.
      const toolAbortController = new AbortController();
      const cancelToken: CancellationToken = {
        cancelled: false,
        cancel: () => {
          cancelToken.cancelled = true;
          toolAbortController.abort();
        },
      };
      this._cancellationTokens.set(streamId, cancelToken);

      signal.addEventListener('abort', () => {
        cancelToken.cancel();
      }, { once: true });
      // signal мог быть уже абортирован до входа (гонка с отменой из очереди)
      if (signal.aborted) cancelToken.cancel();

      // 6. Tool loop — stream LLM, execute tools, continue until no tool calls
      let toolIteration = 0;
      const currentMessages: LLMMessage[] = [...baseLlmMessages];
      const doomLoopTracker: Map<string, number> = new Map();
      let finalContent = '';
      const allReasoning: Array<{ text: string; iteration: number }> = [];
      const allIntermediateTexts: Array<{ text: string; iteration: number }> = [];
      let finalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
      let finalModel: string | undefined;
      // Модель последнего завершённого стрима итерации: нужна ветке отмены
      // во время тула, где `chunkModel` уже вне области видимости, а
      // `finalModel` ещё не обновлён (AD-070 §2.6, Bug 2).
      let lastChunkModel: string | undefined;
      const allToolCalls: Array<Record<string, unknown>> = [];
      const allRawToolCalls: Array<{ iteration: number; calls: Record<string, unknown>[] }> = [];
      let stopAfterDeny = false;
      let denyStopReason: string | undefined;
      /** metadata.i18n подставленного финального фоллбека (лимит итераций / deny / пустой ответ). */
      let fallbackI18n: ReturnType<typeof i18nMeta> | undefined;
      /** Были ли deny-отказы за цикл (для осмысленного fallback пустого ответа). */
      let hadDeny = false;
      /** Отмена до финального сохранения (до входа в итерацию, во время тула) —
       *  завершать обработку как отмену, а не как пустой ответ. */
      let cancelledBeforeFinal = false;

      // AD-070 §2.6: live-статистика стрима (`stream.usage`). Состояние
      // троттлинга — на поток; публикуется через publishChunk (EventBus).
      const liveUsageState = {
        lastPublishedAt: 0,
        lastSignature: '',
        exactPublished: false,
        inputExactPublished: false,
      };

      // Стартовая оценка input сразу после сборки сообщений — чтобы панель
      // статистики не пустовала до первого чанка провайдера.
      // AD-071 §2.6: размер промпта считаем один раз при старте и на входе
      // каждой итерации; переиспользуем в live-оценке и путях отмены.
      let lastIterationPromptChars = this._estimatePromptChars(
        currentMessages, finalSystemPrompt, tools as Record<string, unknown>[] | undefined,
      );
      this._publishLiveUsage({
        publishChunk,
        state: liveUsageState,
        sessionId: session.id,
        streamId,
        iteration: 0,
        agentRole: effectiveAgentRole,
        model: this._resolveMessageModel(undefined, undefined, provider, session),
        provider: providerName,
        usage: this._estimateUsage(
          undefined,
          lastIterationPromptChars,
          0,
        ).usage,
        estimated: true,
        force: true,
      });

      // Предупреждение о заполненности контекстного окна (fire-and-forget, не блокирует вызов)
      this._publishContextLimitWarning(session.id, routeResult.modelName, messagesForLlm);

      while (toolIteration < maxIterations) {
        // Отмена до входа в итерацию (уже абортированный signal, «Стоп» на
        // стартовом stream.usage) — обрабатываем общей веткой отмены ниже.
        // Иначе пустой ход превращался бы в «ответ модели пуст» (error).
        if (cancelToken.cancelled) {
          cancelledBeforeFinal = true;
          break;
        }

        let accumulatedContent = '';
        let accumulatedReasoning = '';
        let toolCalls: Record<string, unknown>[] | undefined = [];
        let chunkModel: string | undefined;
        // AD-070: usage текущей итерации (running total от провайдера) для live.
        let iterationUsage: TokenUsage | undefined;

        // Размер промпта этой итерации (символы) — считаем один раз и
        // переиспользуем для best-effort оценки input, пока нет точных токенов.
        // Для первой итерации берём стартовое значение (сообщения не менялись).
        const iterationPromptChars = toolIteration === 0
          ? lastIterationPromptChars
          : this._estimatePromptChars(
            currentMessages, finalSystemPrompt, tools as Record<string, unknown>[] | undefined,
          );
        lastIterationPromptChars = iterationPromptChars;

        try {
          for await (const chunk of provider.chatAsync(
            currentMessages,
            finalSystemPrompt,
            tools as Record<string, unknown>[] | undefined,
            debugCollector,
            cancelToken,
          )) {
            if (cancelToken.cancelled) break;

            if (chunk.isFinal) {
              accumulatedContent = chunk.content || accumulatedContent;
            } else {
              accumulatedContent += chunk.content;
            }
            if (chunk.reasoning) accumulatedReasoning = chunk.reasoning;
            if (chunk.usage) {
              finalUsage = chunk.usage;
              iterationUsage = chunk.usage;
            }
            if (chunk.model) chunkModel = chunk.model;

            // AD-070 §2.6: live-статистика. Anthropic отдаёт input/cache в
            // `message_start` (output ещё 0), а output — только в `message_delta`
            // в конце. Поэтому «точным» считаем usage с output>0/reasoning:
            // при output===0 и input>0 сохраняем точные input/cache, но output
            // оцениваем из накопленного текста (estimated: true). Полностью
            // нулевой usage (типично для OpenAI до финала) — оценка обоих, как
            // раньше. Точный output оценкой не понижаем. Первые точные input и
            // output публикуем принудительно (сквозь троттлинг), чтобы панель
            // быстро получила реальные значения.
            const chunkUsage = iterationUsage;
            const hasExactOutput = !!chunkUsage
              && (chunkUsage.outputTokens > 0 || (chunkUsage.reasoningTokens ?? 0) > 0);
            const hasExactInput = !!chunkUsage && chunkUsage.inputTokens > 0;

            let liveUsage: TokenUsage;
            let liveEstimated: boolean;
            let forceLive = false;
            if (hasExactOutput) {
              liveUsage = chunkUsage!;
              liveEstimated = false;
              forceLive = !liveUsageState.exactPublished;
              liveUsageState.exactPublished = true;
            } else {
              liveUsage = this._estimateUsage(
                chunkUsage,
                iterationPromptChars,
                accumulatedContent.length + accumulatedReasoning.length,
              ).usage;
              liveEstimated = true;
              if (hasExactInput) {
                // Anthropic: input/cache уже точные — форсируем первый такой снимок.
                forceLive = !liveUsageState.inputExactPublished;
                liveUsageState.inputExactPublished = true;
              }
            }
            this._publishLiveUsage({
              publishChunk,
              state: liveUsageState,
              sessionId: session.id,
              streamId,
              iteration: toolIteration,
              agentRole: effectiveAgentRole,
              model: this._resolveMessageModel(chunkModel, finalModel, provider, session),
              provider: providerName,
              usage: liveUsage,
              estimated: liveEstimated,
              force: forceLive,
            });

            if (chunk.toolCalls && chunk.toolCalls.length > 0) {
              toolCalls = chunk.toolCalls;
            }

            // Stream UI chunks (content from all iterations; reasoning always)
            publishChunk('stream.chunk', {
              stream_id: streamId,
              content: chunk.isFinal ? '' : chunk.content,
              reasoning: chunk.reasoning,
              iteration: toolIteration,
              is_final: chunk.isFinal,
              agent_role: effectiveAgentRole,
              model: chunkModel,
              provider: providerName,
            });
          }
        } catch (e) {
          const errMsg = String(e);
          warning('ORCHESTRATOR', `LLM stream error: ${errMsg}`);

          this._cancellationTokens.delete(streamId);
          return this._handleLlmFailure(session.id, streamId, e, attempt, {
            debugCollector,
            durationMs: Date.now() - streamStartedAt,
            usage: finalUsage,
            model: this._resolveMessageModel(chunkModel, finalModel, provider, session),
            providerName,
            agentRole: effectiveAgentRole,
            content: accumulatedContent,
            promptChars: iterationPromptChars,
            toolResults: allToolCalls.length > 0 ? allToolCalls : undefined,
            promptMeta,
          });
        }

        // Стрим итерации завершён — фиксируем модель до возможной отмены
        // (в т.ч. во время исполнения тулов ниже).
        lastChunkModel = chunkModel;

        if (cancelToken.cancelled) {
          // Bug 2: модель для cost — провайдеры отдают `model` только в финале,
          // поэтому fallback на provider.model/session.settings.model.
          const cancelModel = this._resolveMessageModel(chunkModel, finalModel, provider, session);

          // Отмена: сохраняем уже выполненные tool-вызовы (персистентность
          // tool-chain) — иначе timeline вызовов пропадает из истории.
          await this._persistToolChain(
            session.id, streamId, providerName, effectiveAgentRole,
            cancelModel,
            allRawToolCalls, allToolCalls, allIntermediateTexts, allReasoning,
          );

          // Баг: накопленный текст ВСЕХ итераций (завершённые + текущая
          // незавершённая), а не только последней. Иначе при стопе в истории
          // остаётся обрывок на случайном месте, хотя пользователь видел весь
          // текст в UI до стопа (тексты завершённых итераций лежат в
          // allIntermediateTexts и раньше не попадали в content).
          const partialContent = this._joinAccumulatedTexts(allIntermediateTexts, accumulatedContent);

          // Bug 3/4: usage/duration/cost в событии отмены; при пустом usage —
          // best-effort оценка (metadata.usage_estimated) из размера промпта и
          // накопленного текста.
          const cancelDurationMs = Date.now() - streamStartedAt;
          const cancelEstimated = this._estimateUsage(
            finalUsage,
            iterationPromptChars,
            partialContent.length,
          );
          const cancelCost = this._computeMessageCost(cancelModel, cancelEstimated.usage);

          // При отмене НЕ кладём allIntermediateTexts в metadata
          // (intermediate_text_blocks): они уже вошли в partialContent, иначе
          // UI (режим 'bottom') склеит их с content повторно — дубль.
          // Сообщение сохраняем ВСЕГДА, даже если контент пуст: иначе теряются
          // статус «Остановлено», usage/duration/cost и сам ход в истории.
          await this._saveAssistantMessage(
            session.id, partialContent, streamId, effectiveAgentRole,
            cancelEstimated.usage, cancelModel, accumulatedReasoning, debugCollector, true, providerName,
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

          this._cancellationTokens.delete(streamId);
          return {};
        }

        finalModel = chunkModel ?? finalModel;

        if (accumulatedReasoning) {
          allReasoning.push({ text: accumulatedReasoning, iteration: toolIteration });
        }

        // No tool calls — final response
        if (!toolCalls || toolCalls.length === 0) {
          finalContent = accumulatedContent;
          break;
        }

        if (accumulatedContent) {
          allIntermediateTexts.push({ text: accumulatedContent, iteration: toolIteration });
        }
        allRawToolCalls.push({ iteration: toolIteration, calls: toolCalls });

        // Tool calls detected — execute them
        debugCollector.captureRawModelResponse(
          `[tool_calls iteration ${toolIteration}]: ${JSON.stringify(toolCalls)}`,
        );

        // Add assistant message with tool calls to currentMessages
        currentMessages.push({
          id: '',
          role: 'assistant',
          content: accumulatedContent || '',
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          disabled: false,
          pinned: false,
          branchId: '',
          toolUse: toolCalls,
          agentRole: effectiveAgentRole,
        });

        // Execute each tool call
        for (const tc of toolCalls) {
          const tcId = (tc.id as string) || `call_${Date.now()}`;
          const func = tc.function as { name: string; arguments: string | Record<string, unknown> } | undefined;

          if (!func?.name) continue;

          const toolName = func.name;
          let toolArgs: Record<string, unknown>;

          if (typeof func.arguments === 'string') {
            try {
              toolArgs = JSON.parse(func.arguments);
            } catch {
              toolArgs = {};
            }
          } else {
            toolArgs = func.arguments || {};
          }

          const resolvedToolDef = this._toolRegistry?.get(toolName);
          // AD-071 §2.1: MCP-тул вне активных серверов сессии недоступен —
          // глобальный реестр держит тулы постоянно, но executor подчиняется
          // per-session скоупу (иначе модель могла бы вызвать чужой MCP-тул).
          const toolDef = resolvedToolDef?.source === 'mcp'
            && (resolvedToolDef.mcpServer == null || !activeMcpSet.has(resolvedToolDef.mcpServer))
            ? undefined
            : resolvedToolDef;
          let toolResult: { content: string; isError?: boolean; metadata?: Record<string, unknown> };

          // AD-029: гранулярные permissions — проверяем ДО doom loop, чтобы
          // deny-повторы не блокировались безликим «Цикл прерван», а получали
          // полноценный feedback (tool_call.result) с объяснением политики.
          // AD-025: учитываем текущий режим Plan/Act и строгость плана.
          const permissionDecision = permissionEvaluator.check({
            toolName,
            params: toolArgs,
            workingDir,
            capabilities: toolDef?.capabilities,
            agentCapabilities: agentDef?.capabilities,
            sessionMode,
            planMode,
            planApproved,
            mcpToolSettings: session.settings.mcpToolSettings,
            shellPolicy: this._getProtectedPaths() ?? undefined,
            protectedPaths: this._getProtectedPaths() ?? undefined,
            protectedPathsEnabled: this._getProtectedPathsEnabled(),
            runtimeDeps: this._runtimeDeps,
          });

          // Doom loop detection — только для вызовов, НЕ заблокированных
          // политикой. Deny-вызовы исключены: каждая попытка должна получать
          // понятный feedback с объяснением причины запрета, а не «Цикл
          // прерван». Механика для повторяющихся легальных вызовов сохраняется.
          if (permissionDecision.action !== 'deny') {
            const doomKey = `${toolName}:${JSON.stringify(toolArgs)}`;
            const doomCount = (doomLoopTracker.get(doomKey) || 0) + 1;
            doomLoopTracker.set(doomKey, doomCount);

            if (doomCount >= MAX_DOOM_LOOP_COUNT) {
              warning('ORCHESTRATOR', `Doom loop detected: ${toolName} called ${doomCount} times with same args`);
              currentMessages.push({
                id: '',
                role: 'tool',
                content: sm('tool.doom_loop', { tool: toolName, count: String(doomCount) }),
                usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
                disabled: false,
                pinned: false,
                branchId: '',
                toolCallId: tcId,
              });
              continue;
            }
          }

          const tcStartedAt = new Date().toISOString();

          publishChunk('tool_call.started', {
            stream_id: streamId,
            session_id: session.id,
            call_id: tcId,
            name: toolName,
            arguments: toolArgs,
            iteration: toolIteration,
          });

          // AD-046 §8.2: `skill.invoked` — рядом с `tool_call.started`
          // (аудит/метрики/UI-подсветка).
          if (toolName === 'skill' && typeof toolArgs.name === 'string') {
            const skillName = toolArgs.name;
            const skillEntry = skillsCatalog?.stable.find((e) => e.name === skillName)
              ?? skillsCatalog?.session.find((e) => e.name === skillName);
            this._eventBus.publish(session.id, 'skill.invoked', {
              session_id: session.id,
              name: skillName,
              source: 'model',
              ...(skillEntry?.scope ? { scope: skillEntry.scope } : {}),
              ...(effectiveAgentRole ? { agent: effectiveAgentRole } : {}),
              ...(typeof toolArgs.file_path === 'string' ? { file_path: toolArgs.file_path } : {}),
            });
          }

          let executeTool = permissionDecision.action === 'allow';
          let deniedReason: string | undefined;
          let userDenied = false;

          if (permissionDecision.action === 'deny') {
            deniedReason = this._securityMessage(permissionDecision, 'en')
              ?? `Permission denied: ${permissionDecision.reason}`;
          } else if (permissionDecision.action === 'ask') {
            const approval = await this._approvalManager.waitForDecision(
              session.id,
              {
                approvalId: `approval_${tcId}`,
                callId: tcId,
                toolName,
                arguments: toolArgs,
                reason: this._securityMessage(permissionDecision, 'en')
                  ?? permissionDecision.reason,
              },
              effectivePermissionConfig.askTimeoutMs,
            );
            if (approval.approved) {
              executeTool = true;
              // «Разрешить в сессии» (once:false) — добавляем allow-правило для
              // тула в permission-конфиг сессии, чтобы не спрашивать повторно.
              if (approval.once === false) {
                effectivePermissionConfig = await this._grantSessionToolAllow(session, toolName, toolArgs, workingDir);
                permissionEvaluator = new PermissionEvaluator(effectivePermissionConfig);
              }
            } else {
              const why = approval.timeout
                ? sm('permission.ask_timeout')
                : approval.noSubscribers
                  ? sm('permission.ask_no_subscribers')
                  : sm('permission.ask_denied');
              const baseDeny = this._securityMessage(permissionDecision, 'en')
                ?? `Permission denied: ${permissionDecision.reason}`;
              deniedReason = `${baseDeny} (${why})`;
              userDenied = !approval.timeout && !approval.noSubscribers;
            }
          }

          if (!executeTool) {
            this._eventBus.publish(session.id, 'permission.denied', {
              session_id: session.id,
              call_id: tcId,
              tool: toolName,
              arguments: toolArgs,
              reason: deniedReason,
              matched_rule: permissionDecision.matchedRule,
            });
            toolResult = buildDenyResult({
              reason: deniedReason ?? '',
              content: deniedReason ?? sm('tool.permission_denied_default'),
              matchedRule: permissionDecision.matchedRule,
              messageId: permissionDecision.messageId,
              params: permissionDecision.params as Record<string, string> | undefined,
            });
            hadDeny = true;
          } else {
            if (toolDef) {
              toolResult = await executeToolDef(toolDef, toolArgs, {
                sessionId: session.id,
                messageId: (message.metadata?.stream_id as string) || streamId,
                // Живой сигнал отмены: абортится как по /abort (cancel()),
                // так и по cancelRetry (внешний signal). Без этого тулы
                // (task/сабагент) не узнают о «Стоп» до своего завершения.
                abortSignal: toolAbortController.signal,
                agentRole: effectiveAgentRole,
                workingDir,
                extra: {
                  provider,
                  agentRegistry: this._agentRegistry,
                  sessionManager: this._sessionManager,
                  projectStore: this._projectStore ?? undefined,
                  workspacesRoot: this._workspacesRoot,
                  // AD-075/AD-076: тулы управления проектом (workspace, репозитории).
                  gitService: this._gitService,
                  workspaceManaged: this._workspaceManaged,
                  getWorkspaceOutsideRootPolicy: this._getWorkspaceOutsideRootPolicy ?? undefined,
                  // AD-076 §T6: сетевые git-тулы резолвят SSH-ключ по реестру проекта.
                  sshKeyStore: this._sshKeyStore ?? undefined,
                  eventBus: this._eventBus,
                  contextOptimizer: this._optimizer ?? undefined,
                  // AD-046 §5: тул `skill` получает рантайм через ToolContext.extra
                  // (в ToolContext нет dataDir); саб-агенты — тот же объект.
                  skillRuntime: this._skillRuntime ?? undefined,
                  // AD-046 §4.5: scope-гейты скиллов (система/проект/сессия).
                  skillScope: this._skillScopeFor(session, projectForState),
                  // AD-069 §7: уже резолвленные проектные инструкции — в extra,
                  // чтобы `task`/`task-resume` не резолвили их повторно в ребёнке.
                  projectInstructions: projectInstructions?.content,
                  callerAgentRole: effectiveAgentRole,
                  parentSessionSettings: session.settings,
                  // AD-071 §2.1: саб-агент наследует MCP-скоуп родителя.
                  mcpServers: activeMcpServers,
                  modelRouter: this._router ?? undefined,
                  routerConfig: this._routerConfig ?? undefined,
                  contextConfig: this._contextConfig ?? undefined,
                  securityConfig: this._securityConfig,
                  language: session.settings.language || 'ru',
                  publish: (type: string, data: Record<string, unknown>) =>
                    publishChunk(type as never, data),
                  streamId,
                  sessionId: session.id,
                  // ID собственного tool-вызова — для вложенности вызовов
                  // саб-агента под блоком `task` в родительском стриме.
                  callId: tcId,
                  toolRegistry: this._toolRegistry,
                  permissionConfig: effectivePermissionConfig,
                  // AD-070 §2.9.1: доступность внешних программ (git/rg/sh) —
                  // в permission-слой саб-агента (enforce `dependency`) и его
                  // `[НЕДОСТУПНЫЕ ТУЛЫ]`.
                  runtimeDeps: this._runtimeDeps,
                  shellPolicy: this._getProtectedPaths() ?? undefined,
                  protectedPaths: this._getProtectedPaths() ?? undefined,
                  protectedPathsEnabled: this._getProtectedPathsEnabled(),
                  // AD-070: live-стоимость саб-агента тем же загрузчиком цен.
                  modelPriceLoader: this._modelPriceLoader ?? undefined,
                },
              }, toolName);
            } else {
              toolResult = {
                content: sm('tool.not_found', { tool: toolName }),
                isError: true,
                metadata: { i18n: i18nMeta('tool.not_found', { tool: toolName }) },
              };
            }
          }

          // Отмена пришла ВО ВРЕМЯ исполнения тула (например task/сабагент).
          // Фиксируем результат (цепочка тулов сохранится в истории), публикуем
          // tool_call.result (UI видит, чем тул завершился) и прекращаем
          // дальнейшие тулы/итерации — обработка завершится как отмена (ниже),
          // а не как обычное завершение с «ответ модели пуст».
          if (cancelToken.cancelled || toolAbortController.signal.aborted) {
            allToolCalls.push({
              name: toolName,
              args: toolArgs,
              id: tcId,
              result: toolResult,
              started_at: tcStartedAt,
              completed_at: new Date().toISOString(),
              iteration: toolIteration,
            });
            publishChunk('tool_call.result', {
              stream_id: streamId,
              session_id: session.id,
              call_id: tcId,
              name: toolName,
              result: toolResult,
              iteration: toolIteration,
            });
            cancelledBeforeFinal = true;
            break;
          }

          // IPI-защита: оборачиваем tool-контент по матрице доверия + детектируем
          // подозрительные паттерны (флаг/sanitize/block по конфигу).
          if (this._securityConfig.promptInjection.enabled && !toolResult.isError) {
            const trustInfo = getToolTrust(
              toolName,
              toolArgs,
              workingDir,
              toolDef?.capabilities,
            );
            if (trustInfo) {
              const piConfig = this._securityConfig.promptInjection;
              const lang = session.settings.language || 'ru';
              // Детекция по обоим словарям (ru+en) — веб-контент может быть на любом языке
              const langs = lang === 'en' ? ['en', 'ru'] : ['ru', 'en'];
              let detection = { suspicious: false, matches: [] as string[] };
              for (const l of langs) {
                const d = detectPromptInjection(toolResult.content, this._dictionaryStore, l);
                if (d.suspicious) {
                  detection = { suspicious: true, matches: [...detection.matches, ...d.matches] };
                }
              }

              const applied = applyPolicy(toolResult.content, piConfig.mode, detection);

              if (applied.blocked) {
                toolResult = {
                  content: sm('security.injection_blocked', { tool: toolName, matches: detection.matches.slice(0, 5).join(', ') }),
                  isError: true,
                  metadata: {
                    ...toolResult.metadata,
                    i18n: i18nMeta('security.injection_blocked', { tool: toolName }),
                    injection_suspicious: true,
                    injection_matches: detection.matches,
                  },
                };
              } else {
                const wrapped = piConfig.wrapContent
                  ? wrapContent(applied.content, trustInfo.source, trustInfo.attrs, trustInfo.trust)
                  : applied.content;
                // IPI: предупреждение [WARN] ставится ПЕРЕД блоком [CONTENT | ...]
                const content = detection.suspicious && piConfig.mode === 'flag'
                  ? `${buildWarnLine(detection.matches)}\n${wrapped}`
                  : wrapped;
                toolResult = {
                  ...toolResult,
                  content,
                  metadata: {
                    ...toolResult.metadata,
                    ...(detection.suspicious
                      ? { injection_suspicious: true, injection_matches: detection.matches }
                      : {}),
                  },
                };
              }
            }
          }

          // AD-069 §4: lazy-догрузка вложенных проектных инструкций в результат
          // file/shell-тула. Контент инструкций сканируется внутри загрузчика
          // (AD-036) и вставляется ПОСЛЕ IPI-обёртки базового tool-контента —
          // сам базовый контент под обёрткой, скан не обходится.
          if (!toolResult.isError && this._lazyInstructions) {
            try {
              const lazy = await this._lazyInstructions.resolve({
                sessionId: session.id,
                messageId: streamId,
                toolName,
                toolArgs,
                toolResultMetadata: toolResult.metadata,
                workspace: workingDir,
                language,
                injection: this._instructionsInjectionPolicy(),
              });
              if (lazy.block) {
                toolResult = {
                  ...toolResult,
                  content: `${toolResult.content}\n\n${lazy.block}`,
                  metadata: {
                    ...toolResult.metadata,
                    instructions_loaded: lazy.files.filter((f) => !f.blocked).map((f) => f.path),
                  },
                };
                this._eventBus.publish(session.id, 'context.instructions_loaded', {
                  session_id: session.id,
                  source: 'lazy',
                  tool: toolName,
                  agent: effectiveAgentRole,
                  files: lazy.files,
                });
              }
            } catch (e) {
              warning('ORCHESTRATOR', `Lazy-инструкции не загружены: ${e instanceof Error ? e.message : String(e)}`);
            }
          }

          // Публикуем результат ПОСЛЕ IPI-обёртки: живой UI (tool_call.result)
          // должен получать тот же контент, что сохраняется в историю
          // (metadata.tool_results и tool-chain tool-сообщения), иначе при
          // перезагрузке вид результата меняется.
          publishChunk('tool_call.result', {
            stream_id: streamId,
            session_id: session.id,
            call_id: tcId,
            name: toolName,
            result: toolResult,
            iteration: toolIteration,
          });

          // classify_conversation: сохраняем категорию в настройках сессии (AD-034)
          if (toolName === 'classify_conversation' && !toolResult.isError) {
            const cat = (toolResult.metadata?.routingCategory as string) || undefined;
            if (cat && (cat === 'coding' || cat === 'chat' || cat === 'research')) {
              await this._sessionManager.withLock(session.id, async (s) => {
                s.settings.routingCategory = cat as 'coding' | 'chat' | 'research';
                await this._sessionManager.saveSession(s);
              });
              this._eventBus.publish(session.id, 'session.routing_category', {
                category: cat,
                source: 'model',
              });
            }
          }

          // AD-025/AD-070 §2.8: после plan_enter/plan_exit обновляем локальный
          // режим и добавляем durable mode_change state-сообщение в историю +
          // синтетическое user-сообщение в текущий диалог. System prompt
          // mid-turn больше не пересобирается (смена режима его не меняет).
          if (!toolResult.isError && toolName === 'plan_enter') {
            sessionMode = 'plan';
            await this._appendModeChangeState(
              session, sessionMode, planMode, planApproved, language, currentMessages,
              this._collectUnavailableTools(
                session, sessionMode, planMode, planApproved, agentDef, activeMcpServers,
                { builtin: toolsPolicy !== 'available', mcp: mcpPolicy !== 'available' },
              ),
            );
          } else if (!toolResult.isError && toolName === 'plan_exit') {
            planApproved = true;
            sessionMode = 'act';
            await this._appendModeChangeState(
              session, sessionMode, planMode, planApproved, language, currentMessages,
              this._collectUnavailableTools(
                session, sessionMode, planMode, planApproved, agentDef, activeMcpServers,
                { builtin: toolsPolicy !== 'available', mcp: mcpPolicy !== 'available' },
              ),
            );
          }

          allToolCalls.push({
            name: toolName,
            args: toolArgs,
            id: tcId,
            result: toolResult,
            started_at: tcStartedAt,
            completed_at: new Date().toISOString(),
            iteration: toolIteration,
          });

          debugCollector.captureToolCall(toolName, toolArgs, toolResult as Record<string, unknown>);

          currentMessages.push({
            id: '',
            role: 'tool',
            content: toolResult.content,
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            disabled: false,
            pinned: false,
            branchId: '',
            toolCallId: tcId,
          });

          // AD-029: пользователь отклонил запрос (ask→deny) — прекращаем
          // обработку: не продолжаем цикл LLM, но уже выполненные tool_result
          // и промежуточные ответы остаются в истории (сохраняются ниже).
          if (userDenied) {
            stopAfterDeny = true;
            denyStopReason = deniedReason;
            break;
          }
        }

        // Отмена между тулами итерации (например во время IPI-обработки) —
        // тоже завершаем как отмену, а не идём на следующую LLM-итерацию.
        if (!stopAfterDeny && (cancelToken.cancelled || toolAbortController.signal.aborted)) {
          cancelledBeforeFinal = true;
          break;
        }

        publishChunk('tool_call.loop', {
          stream_id: streamId,
          session_id: session.id,
          iteration: toolIteration,
          total_tool_calls: toolCalls.length,
        });

        toolIteration++;
        if (stopAfterDeny) break;
      }

      // Отмена до финального сохранения (во время исполнения тула или до входа
      // в итерацию): завершаем ровно как ветку отмены (persist tool-chain +
      // stream.cancelled), а не как обычное завершение с подставленным
      // «Не удалось выполнить запрос: ответ модели пуст».
      if (cancelledBeforeFinal) {
        // Bug 2: при отмене модель могла не прийти ни в одном финальном чанке —
        // fallback на provider.model/session.settings.model для cost.
        const cancelModel = this._resolveMessageModel(lastChunkModel, finalModel, provider, session);

        await this._persistToolChain(
          session.id, streamId, providerName, effectiveAgentRole,
          cancelModel,
          allRawToolCalls, allToolCalls, allIntermediateTexts, allReasoning,
        );

        const partialContent = this._joinAccumulatedTexts(allIntermediateTexts, '');

        // Bug 3/4: usage/duration/cost в событии отмены + best-effort оценка
        // usage (metadata.usage_estimated) при пустом usage.
        const cancelDurationMs = Date.now() - streamStartedAt;
        const cancelEstimated = this._estimateUsage(
          finalUsage,
          lastIterationPromptChars,
          partialContent.length,
        );
        const cancelCost = this._computeMessageCost(cancelModel, cancelEstimated.usage);

        // Промежуточные тексты уже вошли в partialContent — как в ветке отмены
        // выше, НЕ дублируем их в metadata.intermediate_text_blocks.
        // Сообщение сохраняем всегда (в т.ч. при пустом контенте) — статус и
        // статистика отмены не должны теряться.
        await this._saveAssistantMessage(
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

        this._cancellationTokens.delete(streamId);
        return {};
      }

      // 7. Handle max iterations exceeded
      if (toolIteration >= maxIterations && !finalContent) {
        finalContent = sm('session.max_iterations');
        fallbackI18n = i18nMeta('session.max_iterations');
      }

      // AD-029: пользователь отклонил ask — обработка завершена. Фиксируем
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

      // 7.5. Quality check + escalation (AD-034)
      let qaPass: boolean | undefined;
      let qaReason: string | undefined;
      const escalation = this._router?.getEscalationConfig();
      if (this._router && escalation?.enabled && routingDecision && finalContent) {
        const qaResult = await this._router.checkQuality(finalContent, routingDecision, session.settings);
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
            const fbProvider = this._router.getProvider(fbDecision, undefined, effectiveReasoningLevel);
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
          const sessionAfterMsg = await this._sessionManager.getSession(session.id);
          const msgIndex = sessionAfterMsg
            ? sessionAfterMsg.messages.length
            : session.messages.length;
          this._eventBus.publish(session.id, 'message.quality_check', {
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
      await this._persistToolChain(
        session.id, streamId, providerName, effectiveAgentRole, finalModel,
        allRawToolCalls, allToolCalls, allIntermediateTexts, allReasoning,
      );

      // 8. Save final assistant message
      // AD-070 §2.6: полная длительность прогона (включая tool-chain) и
      // стоимость по цене модели — в metadata финального сообщения и stream.done.
      const durationMs = Date.now() - streamStartedAt;
      const messageCost = this._computeMessageCost(finalModel, finalUsage);
      const reasoningJoined = allReasoning.map((r) => r.text).join('\n\n---\n\n');
      const savedContent = await this._saveAssistantMessage(
        session.id, finalContent, streamId, effectiveAgentRole,
        finalUsage, finalModel, reasoningJoined, debugCollector, false, providerName,
        MessageRole.ASSISTANT, undefined, false, allToolCalls, allIntermediateTexts,
        qaPass, qaReason,
        { ...(fallbackI18n ? { i18n: fallbackI18n } : {}), duration_ms: durationMs },
        promptMeta,
        messageCost,
      );

      // AD-071 §2.6: калибровка chars-per-token по факту (promptChars / inputTokens)
      // после успешного хода. promptChars — тот же расчёт, что уходил в провайдер
      // (последняя итерация), ratio — уже загруженный в этом ходе.
      await this._calibrateTokenRatio(
        finalModel,
        lastIterationPromptChars,
        finalUsage,
        loadedTokenRatio,
      );

      // Получаем актуальную сессию после сохранения
      const updatedSession = await this._sessionManager.getSession(session.id);

      const doneData: Record<string, unknown> = {
        stream_id: streamId,
        content: savedContent,
        message_index: (updatedSession?.messages.length ?? session.messages.length + 1) - 1,
        pending_count: Math.max(0, (updatedSession?.pendingMessages.length ?? 1) - 1),
        model: finalModel,
        provider: providerName,
        usage: finalUsage,
        duration_ms: durationMs,
        status: this._resolveAssistantStatus(false, fallbackI18n ? { i18n: fallbackI18n } : undefined),
        ...(messageCost ? { cost_usd: messageCost.costUsd, cost_currency: messageCost.currency } : {}),
        reasoning_blocks: allReasoning.length > 0 ? allReasoning : undefined,
        intermediate_text_blocks: allIntermediateTexts.length > 0 ? allIntermediateTexts : undefined,
      };

      // AD-036: проброс secrets в real-time событие — UI раскрывает плейсхолдеры
      // без перезагрузки списка сообщений (см. transportStore/chatStore).
      if (finalContent) {
        const secrets = await this._getAssistantSecrets(session.id, savedContent);
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
          const titleAgentDef = this._agentRegistry?.get('title');
          let titleProvider = provider;
          if (titleAgentDef?.reasoningLevel && providerName) {
            const tp = this._getProvider(providerName, updatedSession, titleAgentDef.reasoningLevel);
            if (tp) titleProvider = tp;
          }
          autoTitleSession(updatedSession, this._sessionManager, titleProvider)
            .then((title) => {
              if (title) {
                this._eventBus.publish(updatedSession.id, 'session.updated', {
                  session_id: updatedSession.id,
                  name: title,
                });
              }
            })
            .catch(() => {});
        }
      }

      // 9. Check context optimization triggers
      if (this._optimizer && updatedSession) {
        const optSession = updatedSession;

        // Проверить скользящее окно
        if (optSession.settings.contextOptimization === 'sliding_window') {
          const swResult = this._optimizer.shouldApplySlidingWindow(optSession);
          if (swResult.triggered) {
            let disabledIndices: number[] = [];
            await this._sessionManager.withLock(optSession.id, async (s) => {
              const applied = this._optimizer!.applySlidingWindow(s);
              disabledIndices = applied.disabledIndices;
              await this._sessionManager.saveSession(s);
            });
            this._eventBus.publish(optSession.id, 'context.sliding_window_applied', {
              reason: swResult.reason,
              trigger_type: swResult.reason,
              disabled_indices: disabledIndices,
            });
          }
        }

        // Проверить суммаризацию
        if (optSession.settings.contextOptimization === 'summarization') {
          const sumResult = this._optimizer.shouldSummarize(optSession);
          if (sumResult.triggered) {
            await this._sessionManager.withLock(optSession.id, async (s) => {
              s.summarizationPending = true;
              await this._sessionManager.saveSession(s);
            });
            this._eventBus.publish(optSession.id, 'context.summarization_pending', {
              reason: sumResult.reason,
              current_tokens: sumResult.currentTokens,
              threshold: sumResult.threshold,
              user_count: sumResult.userCount,
            });
          }
        }

        // Обновить canSummarize после всех мутаций
        await this._sessionManager.withLock(optSession.id, async (s) => {
          s.canSummarize = this._optimizer!.canSummarize(s);
          await this._sessionManager.saveSession(s);
        });

        // Уведомить UI об изменении сессии
        const updatedSession2 = await this._sessionManager.getSession(optSession.id);
        if (updatedSession2) {
          this._eventBus.publish(optSession.id, 'session.updated', {
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

      this._cancellationTokens.delete(streamId);
      return {};
    } catch (e) {
      const errMsg = String(e);
      warning('ORCHESTRATOR', `Unexpected error: ${errMsg}`);
      this._cancellationTokens.delete(streamId);
      // Внешний catch может сработать до инициализации локальных переменных
      // (usage/model/prompt) — сохраняем ошибку с безопасным минимумом.
      return this._handleLlmFailure(session.id, streamId, e, attempt, {
        debugCollector,
        durationMs: Date.now() - streamStartedAt,
        model: session.settings.model,
        providerName: session.settings.provider,
        agentRole: effectiveAgentRole,
      });
    }
  }

  cancel(streamId: string): void {
    const token = this._cancellationTokens.get(streamId);
    if (token) token.cancel();
  }

  /**
   * Регистрация внешнего cancel-токена (resume саб-агента): позволяет отменить
   * фоновый прогон обычным путём — orchestrator.cancel(streamId) из
   * POST /sessions/:id/abort (токен ищется в общей карте по streamId).
   */
  registerCancelToken(streamId: string, token: CancellationToken): void {
    this._cancellationTokens.set(streamId, token);
  }

  unregisterCancelToken(streamId: string): void {
    this._cancellationTokens.delete(streamId);
  }

  /**
   * B2: возобновление прерванной/ошибочной дочерней сессии саб-агента.
   * Валидация и захват блокировки — синхронно (ошибки маппятся route-ом в
   * 400/404/409), выполнение — фоновое (mimo очереди: у дочерней сессии нет
   * своего QueueProcessor). Защита от двойного resume — acquireLock +
   * currentStream (последний также делает сессию abort-совместимой).
   */
  async startSubagentResume(childSessionId: string): Promise<{
    status: 'started';
    child_session_id: string;
    parent_session_id: string;
    stream_id: string;
  }> {
    const deps = this._subagentResumeDeps();
    const { child, parent } = await validateSubagentResume(deps, childSessionId);
    // AD-071 §2.1: resumed-саб-агент наследует MCP-скоуп родительской сессии.
    deps.mcpServers = await this._resolveActiveMcpServers(parent);

    const streamId = generateStreamId();
    const processId = `resume:${streamId}`;

    // Атомарный захват — защита от гонки параллельных resume-запросов
    const acquired = await this._sessionManager.acquireLock(childSessionId, processId);
    if (!acquired) {
      throw new SubagentResumeError('LOCKED', sm('task.resume_locked', { id: childSessionId }));
    }

    // currentStream — маркер активности для UI и abort-механики
    await this._sessionManager.withLock(childSessionId, async (s) => {
      s.currentStream = {
        streamId,
        message: sm('task.resume_marker'),
        agentRole: s.settings.agentRole,
        startedAt: nowISO(),
        cancelled: false,
      };
      await this._sessionManager.saveSession(s);
    });

    // Отмена: orchestrator.cancel(streamId) → resumeAbort.abort() →
    // runSubagent видит отмену (стрим + backoff-пауза) → finishAborted.
    const resumeAbort = new AbortController();
    const cancelToken: CancellationToken = {
      cancelled: false,
      cancel: () => {
        cancelToken.cancelled = true;
        resumeAbort.abort();
      },
    };
    this.registerCancelToken(streamId, cancelToken);

    const freshChild = (await this._sessionManager.getSession(childSessionId)) ?? child;

    void runSubagentResume(deps, {
      child: freshChild,
      parent,
      streamId,
      abortSignal: resumeAbort.signal,
    })
      .catch((err) => {
        warning('ORCHESTRATOR', `subagent resume failed: ${err instanceof Error ? err.message : String(err)}`);
        this._eventBus.publish(childSessionId, 'stream.error', {
          stream_id: streamId,
          error: String(err),
          error_type: 'resume_failed',
          can_retry: false,
        });
      })
      .finally(async () => {
        this.unregisterCancelToken(streamId);
        try {
          await this._sessionManager.withLock(childSessionId, async (s) => {
            s.currentStream = undefined;
            await this._sessionManager.saveSession(s);
          });
        } catch { /* сессия могла быть удалена */ }
        try {
          await this._sessionManager.releaseLock(childSessionId, processId);
        } catch { /* ignore */ }
      });

    return {
      status: 'started',
      child_session_id: childSessionId,
      parent_session_id: parent.id,
      stream_id: streamId,
    };
  }

  /** Зависимости resume из приватных резолверов оркестратора. */
  private _subagentResumeDeps(): SubagentResumeDeps {
    return {
      sessionManager: this._sessionManager,
      eventBus: this._eventBus,
      agentRegistry: this._agentRegistry ?? ({ get: () => undefined } as unknown as AgentRegistry),
      toolRegistry: this._toolRegistry ?? undefined,
      contextConfig: this._contextConfig ?? undefined,
      contextOptimizer: this._optimizer ?? undefined,
      routerConfig: this._routerConfig ?? undefined,
      securityConfig: this._securityConfig,
      permissionConfig: this._permissionConfig,
      // AD-070 §2.9.1: dependency-гейт и `[НЕДОСТУПНЫЕ ТУЛЫ]` resumed-саб-агента.
      runtimeDeps: this._runtimeDeps,
      shellPolicy: this._getProtectedPaths() ?? undefined,
      protectedPaths: this._getProtectedPaths() ?? undefined,
      protectedPathsEnabled: this._getProtectedPathsEnabled(),
      // AD-070: live-стоимость resumed-саб-агента тем же загрузчиком цен.
      modelPriceLoader: this._modelPriceLoader ?? undefined,
      // AD-046 §5: каталог скиллов resumed-саб-агенту + тул `skill`.
      skillRuntime: this._skillRuntime ?? undefined,
      // AD-075/AD-076: проектные зависимости resumed-саб-агента — те же, что у
      // обычного пути `task` (проектные тулы, workspace-политика, SSH-окружение).
      projectStore: this._projectStore ?? undefined,
      workspacesRoot: this._workspacesRoot,
      sshKeyStore: this._sshKeyStore ?? undefined,
      gitService: this._gitService,
      workspaceManaged: this._workspaceManaged,
      getWorkspaceOutsideRootPolicy: this._getWorkspaceOutsideRootPolicy ?? undefined,
      // AD-069 §7: резолвим проектные инструкции для ребёнка в оркестраторе
      // (в самом resume повторного резолва нет).
      getProjectInstructions: async (child, parent, workingDir) => {
        if (!parent.projectId) return undefined;
        let project: Project | null = null;
        if (this._projectStore) {
          try {
            project = await this._projectStore.load(parent.projectId);
          } catch {
            project = null;
          }
        }
        const resolved = await this._resolveProjectInstructions({
          session: child,
          project,
          workingDir,
          model: child.settings.model,
          language: child.settings.language || 'ru',
        });
        return resolved?.content;
      },
      getProvider: (child) => this._getProvider(child.settings.provider || '', child, child.settings.reasoningLevel),
      getWorkingDir: (child) => this._resolveWorkingDir(child),
    };
  }

  private async _handleDebugSystemMessage(
    session: Session,
    message: Message,
    signal: AbortSignal,
    publishChunk: (event: string, data: Record<string, unknown>) => void,
    debugCollector: DebugCollector,
    streamId: string,
    reasoningLevel?: ReasoningLevel,
    attempt?: number,
  ): Promise<ProcessMessageResult> {
    // AD-070 §2.6: длительность этого прогона.
    const startedAt = Date.now();
    const providerName = (message.provider as string) || session.settings.provider || '';
    const provider = this._getProvider(providerName, session, reasoningLevel);
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

    const llmMessages: LLMMessage[] = [
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
    this._cancellationTokens.set(streamId, cancelToken);

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
      this._cancellationTokens.delete(streamId);
      return this._handleLlmFailure(session.id, streamId, e, attempt, {
        debugCollector,
        durationMs: Date.now() - startedAt,
        usage: finalUsage,
        model: finalModel ?? provider.model ?? session.settings.model,
        providerName,
        agentRole: 'debug',
        content: accumulatedContent,
        promptChars: this._estimatePromptChars(llmMessages, systemPrompt),
      });
    }

    if (cancelToken.cancelled) {
      publishChunk('stream.cancelled', { stream_id: streamId, content: accumulatedContent, status: 'cancelled' });
      this._cancellationTokens.delete(streamId);
      return {};
    }

    // Сохранить debug-сообщение (без message.added — UI получит его через stream.done)

    const durationMs = Date.now() - startedAt;
    const messageCost = this._computeMessageCost(finalModel, finalUsage);
    await this._saveAssistantMessage(
      session.id, accumulatedContent, streamId, 'debug',
      finalUsage, finalModel, accumulatedReasoning, debugCollector, false, providerName,
      MessageRole.DEBUG, undefined, true,
      undefined, undefined, undefined, undefined, { duration_ms: durationMs },
    );

    const updatedSession = await this._sessionManager.getSession(session.id);

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

    this._cancellationTokens.delete(streamId);
    return {};
  }

  private async _handleSummarization(
    session: Session,
    message: Message,
    signal: AbortSignal,
    publishChunk: (event: string, data: Record<string, unknown>) => void,
    debugCollector: DebugCollector,
    streamId: string,
    attempt?: number,
  ): Promise<ProcessMessageResult> {
    if (!this._optimizer) {
      return { error: 'ContextOptimizer not available', errorType: 'internal', canRetry: false };
    }

    // AD-070 §2.6: длительность этого прогона суммаризации.
    const startedAt = Date.now();
    const lang = session.settings.language || 'ru';

    let prep: {
      provider: import('../providers/base.js').BaseProvider;
      llmMessages: import('../providers/base.js').LLMMessage[];
      summarizerPrompt: string;
      messagesToSummarize: Message[];
      indices: number[];
    };

    try {
      prep = this._optimizer.prepareSummarizationForOrchestrator(session, lang);
    } catch (e) {
      return { error: String(e), errorType: 'summarization_prep_failed', canRetry: false };
    }

    const provider = prep.provider;
    const providerName = (message.provider as string) || session.settings.provider || '';

    debugCollector.captureSessionInfo(session.id, provider.model, providerName, {
      provider_type: provider.type,
      debug_enabled: session.settings.debugEnabled,
      context_optimization: 'summarization',
    });

    // Стрим от LLM суммаризатора
    let accumulatedContent = '';
    let accumulatedReasoning = '';
    let finalUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    let finalModel: string | undefined;

    const cancelToken: import('../providers/base.js').CancellationToken = {
      cancelled: false,
      cancel: () => { cancelToken.cancelled = true; },
    };
    this._cancellationTokens.set(streamId, cancelToken);

    signal.addEventListener('abort', () => cancelToken.cancel(), { once: true });

    try {
      for await (const chunk of provider.chatAsync(prep.llmMessages, prep.summarizerPrompt, undefined, debugCollector, cancelToken)) {
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
          agent_role: 'summary',
          model: finalModel,
          provider: providerName,
        });
      }
    } catch (e) {
      warning('ORCHESTRATOR', `Summarization stream error: ${e}`);
      this._cancellationTokens.delete(streamId);
      return this._handleLlmFailure(session.id, streamId, e, attempt, {
        debugCollector,
        durationMs: Date.now() - startedAt,
        usage: finalUsage,
        model: finalModel ?? provider.model ?? session.settings.model,
        providerName,
        agentRole: 'summary',
        content: accumulatedContent,
        promptChars: this._estimatePromptChars(prep.llmMessages, prep.summarizerPrompt),
      });
    }

    if (cancelToken.cancelled) {
      publishChunk('stream.cancelled', { stream_id: streamId, content: accumulatedContent, status: 'cancelled' });
      this._cancellationTokens.delete(streamId);
      return {};
    }

    // Сохранить summary-сообщение (без message.added — UI получит его через stream.done)
    const durationMs = Date.now() - startedAt;
    const messageCost = this._computeMessageCost(finalModel, finalUsage);
    await this._saveAssistantMessage(
      session.id, accumulatedContent, streamId, 'summary',
      finalUsage, finalModel, accumulatedReasoning, debugCollector, false, providerName,
      MessageRole.SUMMARY, prep.indices, true,
      undefined, undefined, undefined, undefined, { duration_ms: durationMs },
    );

    // Отключить засуммаризированные сообщения
    await this._sessionManager.withLock(session.id, async (s) => {
      for (const idx of prep.indices) {
        if (idx >= 0 && idx < s.messages.length && !s.messages[idx]!.pinned) {
          s.messages[idx]!.disabled = true;
        }
      }
      await this._sessionManager.saveSession(s);
    });

    const updatedSession = await this._sessionManager.getSession(session.id);

    const doneData: Record<string, unknown> = {
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
      metadata: { type: 'summary', indices: prep.indices },
    };

    publishChunk('stream.done', doneData);

    // Обновить canSummarize
    if (updatedSession) {
      await this._sessionManager.withLock(session.id, async (s) => {
        s.canSummarize = this._optimizer!.canSummarize(s);
        await this._sessionManager.saveSession(s);
      });

      const freshSession = await this._sessionManager.getSession(session.id);

      this._eventBus.publish(session.id, 'session.updated', {
        session_id: session.id,
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

    this._cancellationTokens.delete(streamId);
    return {};
  }

  private _getProvider(providerName: string, session: Session, reasoningLevel?: ReasoningLevel) {
    const modelName = session.settings.model || '';
    const sharedConfig = this._providerLoader(providerName);
    if (!sharedConfig) return null;

    try {
      const effectiveModel = modelName || sharedConfig.defaultModel || '';
      const contextWindow = this._resolveModelContextWindow(effectiveModel);
      const provider = ProviderFactory.create(
        providerName,
        {
          ...toCoreProviderConfig(sharedConfig, effectiveModel, reasoningLevel ?? session.settings.reasoningLevel),
          maxTokens: session.settings.maxTokens,
          numCtx: contextWindow > 0 ? contextWindow : undefined,
        },
        session.settings.temperature,
      );
      return this._wrapWithGateway(provider, session);
    } catch (e) {
      warning('ORCHESTRATOR', `Failed to create provider ${providerName}: ${e}`);
      return null;
    }
  }

  /**
   * Размер контекстного окна модели: приоритет у сохранённого значения
   * (ModelConfig.contextWindow через оптимизатор), иначе справочник.
   */
  private _resolveModelContextWindow(modelName: string): number {
    const window = this._optimizer?.getContextWindow(modelName);
    if (window && window > 0) return window;
    return lookupContextWindow(modelName).window;
  }

  /**
   * Публикует context.limit_warning, когда оценка токенов контекста достигла
   * порога (CONTEXT_LIMIT_WARNING_PERCENT) от окна модели. Уведомление не
   * блокирует вызов LLM — это fire-and-forget сигнал для UI.
   */
  private _publishContextLimitWarning(sessionId: string, modelName: string, messages: Message[]): void {
    if (!this._optimizer) return;
    const contextWindow = this._resolveModelContextWindow(modelName);
    if (!(contextWindow > 0)) return;

    const estimatedTokens = this._optimizer.estimateTokens(messages);
    if (estimatedTokens <= 0) return;

    const percent = Math.round((estimatedTokens / contextWindow) * 100);
    if (percent >= CONTEXT_LIMIT_WARNING_PERCENT) {
      this._eventBus.publish(sessionId, 'context.limit_warning', {
        percent,
        context_window: contextWindow,
        estimated_tokens: estimatedTokens,
      });
    }
  }

  /**
   * AD-036: оборачивает провайдер в GatewayProvider с привязкой к сессии.
   * Если gateway выключен — возвращает провайдер как есть (обратная совместимость).
   */
  private _wrapWithGateway(provider: BaseProvider, session: Session): BaseProvider {
    if (!this._gatewayConfig) return provider;
    const patternStore = this._gatewayPatternStore;
    return new GatewayProvider(provider, this._gatewayConfig, {
      getMap: () => this._obfMapStore!.get(session.id),
      saveMap: (map) => this._obfMapStore!.set(session.id, map),
      getAudit: () => this._gatewayAudit!,
      getRateLimiter: () => this._gatewayRateLimiter!,
      getPatterns: patternStore ? () => patternStore.getPatterns() : undefined,
      payloadLogPath: this._gatewayPayloadLogPath,
      sessionId: session.id,
      userId: session.userId ?? '',
    });
  }

  private _getEffectiveModel(session: Session, providerName: string): string {
    return session.settings.model || this._providerLoader(providerName)?.defaultModel || '';
  }

  /**
   * Выбор провайдера и модели через роутер (AD-034).
   * Если роутер недоступен — fallback на _getProvider().
   */
  private _routeProvider(
    session: Session,
    message: Message,
    reasoningLevel?: ReasoningLevel,
  ): { provider: BaseProvider; providerName: string; modelName: string; decision?: RoutingDecision } | null {
    if (this._router && session.settings.routingEnabled !== false) {
      const toolCallNames = message.toolCalls?.map((tc) => {
        const func = tc.function as { name: string } | undefined;
        return func?.name || '';
      }).filter(Boolean);

      const decision = this._router.route({
        sessionSettings: session.settings,
        userMessage: message.content,
        toolCalls: toolCallNames,
      });

      const routedWindow = this._resolveModelContextWindow(decision.modelName);
      let provider = this._router.getProvider(
        decision,
        undefined,
        reasoningLevel ?? session.settings.reasoningLevel,
        session.settings.maxTokens,
        routedWindow > 0 ? routedWindow : undefined,
      );
      if (provider) {
        // AD-036: ProviderPool уже оборачивает провайдера через gatewayFactory.
        // Повторная обёртка дублировала бы guard/аудит/rate-limit — пропускаем.
        if (!(provider instanceof GatewayProvider)) {
          provider = this._wrapWithGateway(provider, session);
        }
        return {
          provider,
          providerName: decision.providerName,
          modelName: decision.modelName,
          decision,
        };
      }

      // Fallback: если decision не содержит валидного провайдера/модели
      // (например, категория не имеет маппинга в routingContent),
      // используем стандартный _getProvider() для провайдера сессии
      const fallbackName = session.settings.provider || '';
      provider = this._getProvider(fallbackName, session, reasoningLevel);
      if (provider) {
        return {
          provider,
          providerName: fallbackName,
          modelName: this._getEffectiveModel(session, fallbackName),
          decision,
        };
      }
    }

    // Fallback: старый метод (если роутер недоступен или все пути выше не сработали)
    const providerName = (message.provider as string) || session.settings.provider || '';
    const provider = this._getProvider(providerName, session, reasoningLevel);
    if (!provider) return null;

    return {
      provider,
      providerName,
      modelName: provider.model,
    };
  }

  static _sessionMessagesToLlm(
    messages: Message[],
    currentAgentRole?: string,
    currentAuthor?: string,
  ): LLMMessage[] {
    const result: LLMMessage[] = [];

    for (const msg of messages) {
      if (msg.disabled || msg.hidden) continue;

      const role = msg.role;
      if (role === MessageRole.INFO) continue;

      // AD-070 §2.8: durable state-сообщения хранятся с role system (скрыты в
      // UI), но в LLM-запрос уходят как синтетическое user-сообщение с
      // обёрткой `<system-state>` — Anthropic не принимает role system в
      // messages. Без префикса `[anonymous]`.
      if (role === MessageRole.SYSTEM) {
        const stateType = typeof msg.metadata?.type === 'string' ? msg.metadata.type : 'state';
        result.push({
          id: '',
          role: 'user',
          content: wrapStateContent(stateType, msg.content),
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          disabled: false,
          pinned: false,
          branchId: '',
        });
        continue;
      }

      const isOwnMessage =
        role === MessageRole.TOOL ||
        (role === MessageRole.ASSISTANT && msg.agentRole === currentAgentRole) ||
        (role === MessageRole.USER && msg.author === currentAuthor);

      let content: string;
      let llmRole: string;

      if (isOwnMessage) {
        content = msg.content;
        llmRole = role;
      } else {
        llmRole = 'user';
        if (msg.agentRole) {
          content = `[${msg.agentRole}]: ${msg.content}`;
        } else if (msg.author) {
          content = `{${msg.author}}: ${msg.content}`;
        } else {
          content = `[anonymous]: ${msg.content}`;
        }
      }

      result.push({
        id: '',
        role: llmRole,
        content,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        disabled: false,
        pinned: false,
        branchId: '',
        toolUse: isOwnMessage ? msg.toolCalls : undefined,
        toolCallId: isOwnMessage ? msg.toolCallId : undefined,
        reasoning: isOwnMessage && llmRole === MessageRole.ASSISTANT ? msg.reasoning : undefined,
        agentRole: msg.agentRole,
      });
    }

    return result;
  }

  /**
   * AD-036: возвращает реальные значения секретов для плейсхолдеров
   * ⟦SYNTH_SECRET_N⟧ в тексте сообщения (из карты обфускации сессии).
   * Пустой объект если карты нет, плейсхолдеров нет или gateway выключен.
   */
  private async _getAssistantSecrets(sessionId: string, content: string): Promise<Record<string, string>> {
    if (!content || !this._obfMapStore) return {};
    try {
      const obfMap = await this._obfMapStore.get(sessionId);
      if (Object.keys(obfMap).length === 0) return {};
      const found = new Set<string>();
      let match: RegExpExecArray | null;
      const placeholderRe = new RegExp(PLACEHOLDER_PATTERN.source, 'g');
      while ((match = placeholderRe.exec(content)) !== null) {
        found.add(match[0]);
      }
      const secrets: Record<string, string> = {};
      for (const ph of found) {
        if (ph in obfMap) secrets[ph] = obfMap[ph]!;
      }
      return secrets;
    } catch (e) {
      warning('ORCHESTRATOR', `Ошибка раскрытия секретов в metadata: ${e instanceof Error ? e.message : String(e)}`);
      return {};
    }
  }

  /**
   * Персистентность tool-chain (Вариант B): настоящие пары
   * «assistant с toolCalls + tool-результаты» в session.messages, чтобы
   * _sessionMessagesToLlm на следующем запросе выдавал OpenAI-совместимый
   * диалог. Промежуточные сообщения помечаются metadata.tool_chain=true —
   * UI их скрывает (визуализация уже есть в финальном сообщении).
   * Вызывается и в успешном пути, и при отмене (уже выполненные итерации).
   */
  private async _persistToolChain(
    sessionId: string,
    streamId: string,
    providerName: string,
    agentRole: string | undefined,
    finalModel: string | undefined,
    allRawToolCalls: Array<{ iteration: number; calls: Record<string, unknown>[] }>,
    allToolCalls: Array<Record<string, unknown>>,
    allIntermediateTexts: Array<{ text: string; iteration: number }>,
    allReasoning: Array<{ text: string; iteration: number }>,
  ): Promise<void> {
    for (const raw of allRawToolCalls) {
      const iteration = raw.iteration;
      const iterText = allIntermediateTexts.find((t) => t.iteration === iteration)?.text ?? '';
      const iterReasoning = allReasoning.find((r) => r.iteration === iteration)?.text;

      const assistantMsg: Message = {
        id: generateId(),
        role: MessageRole.ASSISTANT,
        seq: 0,
        origin: 'local',
        parts: [makeTextPart(iterText)],
        content: iterText,
        toolCalls: raw.calls,
        createdAt: nowISO(),
        disabled: false,
        pinned: false,
        hidden: false,
        model: finalModel,
        provider: providerName,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        agentRole,
        metadata: { stream_id: streamId, tool_chain: true },
        ...(iterReasoning ? { reasoning: iterReasoning } : {}),
      };
      await this._sessionManager.addMessage(sessionId, assistantMsg);

      for (const tc of allToolCalls.filter((t) => t.iteration === iteration)) {
        const toolContent = String((tc.result as { content?: string } | undefined)?.content ?? '');
        // metadata ToolResult (в т.ч. i18n) пробрасывается в metadata сообщения —
        // иначе локализационные ключи не доходят до истории и UI.
        const toolResultMeta = (tc.result as { metadata?: Record<string, unknown> } | undefined)?.metadata;
        const toolMsg: Message = {
          id: generateId(),
          role: MessageRole.TOOL,
          seq: 0,
          origin: 'local',
          parts: [makeTextPart(toolContent)],
          content: toolContent,
          toolCallId: tc.id as string,
          createdAt: nowISO(),
          disabled: false,
          pinned: false,
          hidden: false,
          model: finalModel,
          provider: providerName,
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          agentRole,
          metadata: {
            ...(toolResultMeta ?? {}),
            stream_id: streamId,
            tool_chain: true,
            tool_name: tc.name,
            args: tc.args,
          },
        };
        await this._sessionManager.addMessage(sessionId, toolMsg);
      }
    }
  }

  /**
   * Склейка накопленного текста: все завершённые итерации (allIntermediateTexts)
   * + текст текущей (незавершённой) итерации. Пустые фрагменты пропускаются.
   * Используется при отмене (abort), чтобы в истории сохранялся полный
   * частичный ответ, а не только обрывок последней итерации.
   */
  private _joinAccumulatedTexts(
    intermediateTexts: Array<{ text: string; iteration: number }>,
    current: string,
  ): string {
    const parts = [...intermediateTexts.map((t) => t.text), current]
      .filter((t) => t && t.trim().length > 0);
    return parts.join('\n\n');
  }

  /**
   * AD-070 §2.6: статус ответа по данным сохранения. Централизованно, чтобы
   * ни один путь (`_saveAssistantMessage`) не пропустил поле `metadata.status`.
   */
  private _resolveAssistantStatus(
    isCancelled: boolean,
    metadataExtra?: Record<string, unknown>,
  ): AssistantMessageStatus {
    if (isCancelled) return 'cancelled';
    const key = (metadataExtra?.i18n as { key?: string } | undefined)?.key;
    switch (key) {
      case 'session.stopped':
      case 'session.denied_blocked':
        return 'stopped';
      case 'session.max_iterations':
        return 'limit';
      case 'session.empty_response':
      case 'router.timeout':
      case 'router.network_error':
      case 'router.rate_limit_exceeded':
      case 'router.context_length_exceeded':
        return 'error';
      default:
        return 'completed';
    }
  }

  private async _saveAssistantMessage(
    sessionId: string,
    content: string,
    streamId: string,
    agentRole: string | undefined,
    usage: TokenUsage,
    model: string | undefined,
    reasoning: string | undefined,
    debugCollector: DebugCollector,
    isCancelled: boolean,
    provider?: string,
    role: MessageRole = MessageRole.ASSISTANT,
    summaryOf?: number[],
    skipEvent = false,
    toolResults?: Array<Record<string, unknown>>,
    intermediateTextBlocks?: Array<{ text: string; iteration: number }>,
    qaPass?: boolean,
    qaReason?: string,
    /** Дополнительные поля metadata (например metadata.i18n фоллбек-статусов). */
    metadataExtra?: Record<string, unknown>,
    /** AD-070 §2.4: предсказание prompt-cache; cachedTokens/validated — из usage. */
    promptMeta?: PromptMeta,
    /**
     * AD-070 §2.6: уже посчитанная стоимость сообщения (если вызывающая сторона
     * считала её для события) — избегаем повторного `_computeMessageCost`.
     */
    precomputedCost?: ReturnType<typeof computeUsageCost>,
  ): Promise<string> {
    const finalContent = content;

    if (!isCancelled && content) {
      debugCollector.captureRawModelResponse(content);
    }

    if (debugCollector.enabled) {
      debugCollector.captureReasoning(reasoning);
    }

    const debugInfo = debugCollector.getDebugInfo();

    // AD-070 §2.4: usage доступен в момент сохранения — заполняем фактические
    // cachedTokens и подтверждаем/опровергаем предсказание.
    const resolvedPromptMeta: PromptMeta | undefined = promptMeta
      ? {
          ...promptMeta,
          cachedTokens: usage?.cacheReadTokens ?? 0,
          validated: validateExpected(promptMeta.expected, usage?.cacheReadTokens ?? 0),
        }
      : undefined;

    const metadata: Record<string, unknown> = { stream_id: streamId, ...metadataExtra };
    // AD-070 §2.6: единая точка простановки статуса ответа — ни один путь
    // сохранения (обычный, cancel, tool-chain, summary, debug, micro) не
    // пропускает его. UI показывает префикс по этому полю.
    // Явный status (например 'error' для assistant-сообщения о сбое LLM)
    // приоритетнее вывода из i18n — иначе rate_limit/context_length без
    // маппинга получили бы 'completed'.
    metadata.status = isAssistantMessageStatus(metadataExtra?.status)
      ? metadataExtra.status
      : this._resolveAssistantStatus(isCancelled, metadataExtra);
    if (toolResults && toolResults.length > 0) {
      metadata.tool_results = toolResults;
      // AD-070 §2.6: per-message статистика сабагентов (попап сообщения и
      // «Последний ответ») — агрегируется из task-результатов этого хода.
      const subagents = this._aggregateSubagentStats(toolResults);
      if (subagents) metadata.subagents = subagents;
    }
    if (intermediateTextBlocks && intermediateTextBlocks.length > 0) {
      metadata.intermediate_text_blocks = intermediateTextBlocks;
    }

    // AD-070 §2.6: стоимость хода по цене модели (только если цены известны).
    const messageCost = precomputedCost !== undefined
      ? precomputedCost
      : this._computeMessageCost(model, usage);
    if (messageCost) {
      metadata.cost_usd = messageCost.costUsd;
      metadata.cost_currency = messageCost.currency;
      metadata.cost_breakdown = messageCost.breakdown;
    }

    // AD-036: раскрытие секретов в UI. Реальные значения плейсхолдеров из
    // карты обфускации сессии встраиваются в metadata.secrets (клик раскрывает
    // локально). Только существующие плейсхолдеры; карта — секрет, в логи не пишется.
    if (role === MessageRole.ASSISTANT && finalContent && this._obfMapStore) {
      const secrets = await this._getAssistantSecrets(sessionId, finalContent);
      if (Object.keys(secrets).length > 0) {
        metadata.secrets = { ...(metadata.secrets as Record<string, string> | undefined), ...secrets };
      }
    }

    const msg: Message = {
      id: generateId(),
      role,
      seq: 0, // filled by addMessage
      origin: 'local',
      parts: [makeTextPart(finalContent)],
      content: finalContent,
      createdAt: nowISO(),
      disabled: false,
      pinned: false,
      hidden: false,
      model,
      provider: provider || '',
      usage,
      reasoning,
      agentRole,
      debugData: debugInfo ?? undefined,
      metadata,
      ...(resolvedPromptMeta ? { promptMeta: resolvedPromptMeta } : {}),
      ...(summaryOf ? { summaryOf } : {}),
      ...(qaPass !== undefined ? { qa_pass: qaPass } : {}),
      ...(qaReason !== undefined ? { qa_reason: qaReason } : {}),
    };

    await this._sessionManager.addMessage(sessionId, msg);

    // Accumulate session token counters and costs
    if (usage) {
      await this._sessionManager.withLock(sessionId, async (s) => {
        s.inputTokens += usage.inputTokens || 0;
        s.outputTokens += usage.outputTokens || 0;
        s.totalTokens += usage.totalTokens || 0;
        s.cacheReadTokens += usage.cacheReadTokens || 0;
        s.cacheWriteTokens += usage.cacheWriteTokens || 0;
        s.reasoningTokens += usage.reasoningTokens || 0;
        // AD-070 §2.3: hit rate по накопленным токенам сессии.
        s.cacheHitRate = computeCacheHitRate(s.cacheReadTokens, s.inputTokens);

        // AD-070 §2.6: единый helper стоимости — тот же, что для per-message.
        const effectiveModel = model || msg.model;
        const cost = effectiveModel
          ? computeUsageCost(usage, this._modelPriceLoader?.(effectiveModel) ?? null)
          : null;
        if (cost) {
          s.inputCost += cost.breakdown.input;
          s.outputCost += cost.breakdown.output;
          s.cacheReadCost += cost.breakdown.cacheRead;
          s.cacheWriteCost += cost.breakdown.cacheWrite;
        }
        s.updatedAt = nowISO();
        await this._sessionManager.saveSession(s);
      });
    }

    // Publish message.added for UI
    if (!skipEvent) {
      const session = await this._sessionManager.getSession(sessionId);
      if (session) {
        this._eventBus.publish(sessionId, 'message.added', {
          message_index: session.messages.length - 1,
          role: msg.role,
          content: finalContent.slice(0, 500),
          model,
          provider: provider || '',
          agent_role: agentRole,
          reasoning: reasoning || null,
          tool_calls: toolResults && toolResults.length > 0 ? toolResults : null,
          intermediate_text_blocks: intermediateTextBlocks && intermediateTextBlocks.length > 0 ? intermediateTextBlocks : null,
          metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
        });
      }
    }

    return finalContent;
  }

  /**
   * Человекочитаемое описание ошибки LLM (таймаут/обрыв соединения, сетевая
   * ошибка). Для остальных ошибок — исходный текст. `i18n` — ключ AD-041 для
   * metadata (UI локализует сам).
   */
  private _formatLlmError(error: unknown): { text: string; i18n?: ReturnType<typeof i18nMeta> } {
    const raw = error instanceof Error ? error.message : String(error);
    const lower = raw.toLowerCase();
    if (lower.includes('abort') || lower.includes('operation was aborted') || lower.includes('timed out') || lower.includes('timeout')) {
      return { text: sm('router.timeout'), i18n: i18nMeta('router.timeout') };
    }
    if (lower.includes('fetch failed') || lower.includes('network') || lower.includes('econnrefused') || lower.includes('enotfound') || lower.includes('eai_again')) {
      return { text: sm('router.network_error'), i18n: i18nMeta('router.network_error') };
    }
    return { text: raw };
  }

  /** i18n-ключ по типу ошибки (AD-041) для metadata assistant-сообщения об ошибке. */
  private _errorTypeI18n(errorType: string): ReturnType<typeof i18nMeta> | undefined {
    switch (errorType) {
      case 'timeout': return i18nMeta('router.timeout');
      case 'network_error': return i18nMeta('router.network_error');
      case 'rate_limit': return i18nMeta('router.rate_limit_exceeded');
      case 'context_length': return i18nMeta('router.context_length_exceeded');
      default: return undefined;
    }
  }

  /**
   * Единая обработка ошибки LLM-стрима: пишет last_error в user-сообщение
   * сессии (по stream_id), сохраняет assistant-сообщение об ошибке (только
   * когда повтор невозможен/исчерпан — см. `attempt`) и возвращает
   * ProcessMessageResult. Публикация финального исхода (stream.retry для
   * recoverable / stream.error для non-recoverable) — зона ответственности
   * QueueProcessor, чтобы не было двойной публикации stream.error. Если ошибка
   * recoverable — session разблокируется на уровне QueueProcessor после
   * исчерпания попыток; сессия не остаётся заблокированной навсегда.
   */
  private async _handleLlmFailure(
    sessionId: string,
    streamId: string,
    error: unknown,
    attempt?: number,
    ctx?: LlmFailureContext,
  ): Promise<ProcessMessageResult> {
    const rawError = error instanceof Error ? error.message : String(error);
    const formatted = this._formatLlmError(error);
    const humanError = formatted.text;
    // ContextLengthExceededError несёт русское сообщение («Контекстное окно
    // превышено») — текстовый классификатор его не распознаёт, поэтому тип
    // определяем по классу ошибки, чтобы UI показал дружелюбное сообщение.
    const errorType = error instanceof ContextLengthExceededError
      ? 'context_length'
      : classifyLlmError(rawError);
    const canRetry = isLlmErrorRecoverable(error, rawError, errorType);

    // AD-070 §2.6 (Bug 1): assistant-сообщение об ошибке пишем только тогда,
    // когда повтора уже не будет (unrecoverable / последняя попытка / прямой
    // вызов без QueueProcessor). Иначе на каждый recoverable-ретрай в истории
    // появлялся бы дубль, а `message.added` мигал бы в UI.
    const isTerminal = !canRetry || attempt === undefined || attempt > LLM_MAX_ATTEMPTS;

    if (isTerminal && ctx) {
      try {
        const estimated = this._estimateUsage(
          ctx.usage,
          ctx.promptChars ?? 0,
          (ctx.content ?? '').length,
        );
        const i18n = formatted.i18n ?? this._errorTypeI18n(errorType);
        await this._saveAssistantMessage(
          sessionId, humanError, streamId, ctx.agentRole,
          estimated.usage, ctx.model, undefined, ctx.debugCollector, false, ctx.providerName,
          MessageRole.ASSISTANT, undefined, false, ctx.toolResults, undefined,
          undefined, undefined,
          {
            duration_ms: ctx.durationMs,
            status: 'error',
            ...(i18n ? { i18n } : {}),
            ...(estimated.estimated ? { usage_estimated: true } : {}),
          },
          ctx.promptMeta,
        );
      } catch (err) {
        warning('ORCHESTRATOR', `Не удалось сохранить assistant-сообщение об ошибке: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    try {
      await this._sessionManager.withLock(sessionId, async (s) => {
        const userMsg = s.messages.find(
          (m) => m.role === MessageRole.USER && m.metadata?.stream_id === streamId,
        );
        if (userMsg) {
          userMsg.metadata = { ...userMsg.metadata, last_error: humanError };
          await this._sessionManager.saveSession(s);
        }
      });
    } catch (err) {
      warning('ORCHESTRATOR', `Не удалось записать last_error: ${err instanceof Error ? err.message : String(err)}`);
    }

    return { error: humanError, errorType, canRetry };
  }

  /** Строит permission-конфиг с добавленным грантом для заданной базы правил. */
  private _applyToolAllow(
    cfg: PermissionConfig | undefined,
    toolName: string,
    paths: string[],
  ): PermissionConfig {
    const base = cfg ?? {
      rules: { ...this._permissionConfig.rules },
      askTimeoutMs: this._permissionConfig.askTimeoutMs,
    };
    const rules = { ...base.rules };
    if (paths.length > 0) {
      if (rules[toolName] !== 'allow') {
        const existing = (typeof rules[toolName] === 'object' && rules[toolName])
          ? { ...(rules[toolName] as Record<string, string>) }
          : {};
        for (const p of paths) existing[p] = 'allow';
        rules[toolName] = existing as PermissionRule;
      }
    } else {
      rules[toolName] = 'allow';
    }
    return { ...base, rules };
  }

  /**
   * AD-029: «Разрешить в сессии» (once:false). Если у вызова есть файловые
   * параметры — одобряет КОНКРЕТНЫЕ абсолютные пути (правило-объект
   * `rules[tool] = { path: 'allow' }`), иначе (shell/task/mcp) — весь тул.
   * Если тул уже разрешён полностью ('allow') — не понижает до пути.
   */
  private async _grantSessionToolAllow(
    session: Session,
    toolName: string,
    toolArgs: Record<string, unknown>,
    workingDir: string,
  ): Promise<PermissionConfig> {
    const paths = extractPaths(toolName, toolArgs, workingDir);
    const next = this._applyToolAllow(session.settings.permission, toolName, paths);

    await this._sessionManager.withLock(session.id, async (s) => {
      s.settings.permission = next;
      await this._sessionManager.saveSession(s);
      this._eventBus.publish(session.id, 'session.updated', {
        session_id: session.id,
        settings: s.settings,
      });
    });

    // AD-029: «Разрешить в сессии» для сабагентской (дочерней) сессии
    // распространяется и на родителя (parentId): путь в правиле — абсолютный
    // канонический, поэтому грант совпадёт при чтении того же файла и родителем,
    // и ребёнком. Родительский грант обновляет и effectivePermissionConfig, и
    // PermissionEvaluator при следующей обработке (сессия сохраняется в store).
    if (session.parentId) {
      await this._sessionManager.withLock(session.parentId, async (parent) => {
        parent.settings.permission = this._applyToolAllow(parent.settings.permission, toolName, paths);
        await this._sessionManager.saveSession(parent);
        this._eventBus.publish(parent.id, 'session.updated', {
          session_id: parent.id,
          settings: parent.settings,
        });
      });
    }

    return next;
  }
}

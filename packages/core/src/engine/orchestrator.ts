import type { Message, Project, Session, ProviderConfig as SharedProviderConfig, TokenUsage, AgentDefinition, PromptMeta, PromptManifest, PromptState, PromptHistoryInfo, PromptToolDetail, ToolsPolicy, ToolsDisabledConfig, McpServerEffective, McpToolDetail, SkillsDisabledRequest, ProfileStore, MessageReceivedKind, SessionWorktree, AttachmentModality, AttachmentsConfig, ModelConfig } from '@itphx/synth-shared';
import { MessageRole, nowISO, generateId, makeTextPart, generateStreamId, stripNullBytes, stripNullBytesDeep, STEER_INTERRUPTED_METADATA_KEY, appendReasoningBlock, attachmentsConfigSchema } from '@itphx/synth-shared';
import type { RouterConfig, PermissionConfig, PermissionRule, PlanMode, SessionMode, SecurityConfig, LLMGatewayConfig, ReasoningLevel, PermissionDecision, Currency, InstructionsConfig, WorkspaceOutsideRootPolicy, DecisionConfig } from '@itphx/synth-shared';
import { join, isAbsolute, normalize, resolve } from 'node:path';
import { mkdir, stat } from 'node:fs/promises';
import type { SessionManager } from '../sessions/manager.js';
import type { EventBus } from '../events/bus.js';
import { DebugCollector } from '../debug.js';

import { computeUsageCost } from '../providers/usage.js';

import type { LLMMessage, CancellationToken, BaseProvider, SystemPromptPayload, CachePolicy } from '../providers/base.js';
import { ContextBuilder } from './context/builder.js';
import { ContextOptimizer } from './context/optimizer.js';
import type { ContextOptimizerGatewayHooks } from './context/optimizer.js';
import type { ContextFileRepository } from '../storage/ports/context-file-repository.js';
import { SystemPromptComposer, type ComposerContext, type ComposerInstructions, type ComposerMcpServer, type ComposerMcpServerStatus } from './context/composer.js';
import type { PromptBlockRegistry } from './context/prompt-block-registry.js';
import { ProjectInstructionsResolver, type InstructionsFileInfo } from './context/instructions.js';
import { LazyInstructionsLoader } from './context/lazy-instructions.js';
import { isMemoryPromptAvailable } from './context/memory-availability.js';
import { MEMORY_PLUGIN_NAME } from './plugins/memory-namespace.js';
import type { ComposerSkillsCatalog } from './skills/catalog.js';
import type { SkillRuntime, SkillScopeOptions } from './skills/types.js';
import type { CommandRuntime } from '@itphx/synth-shared';
import { calibrateCharsPerToken, estimateTokens, DEFAULT_CHARS_PER_TOKEN } from './context/token-ratio.js';
import { agentKeyOf } from './context/prompt-state.js';
import { createStateMessage, findLastStateMessage, buildModeChangeContent, buildPlanUpdatedContent, wrapStateContent, type UnavailableTool } from './context/state-messages.js';
import type { ToolRegistry } from './tools/registry.js';
import type { AutomationRuntime } from './tools/automation-runtime.js';
import type { AgentRegistry } from './agents/registry.js';
import type { McpManager } from './mcp/manager.js';
import { attachExecutorMcpFromDescriptor } from './mcp/executor-mcp-source.js';
import { resolveMcpScope, type McpScopeDecision } from './mcp/scope.js';
import { warning } from '../logger.js';
import { ModelRouter } from './router/router.js';
import { ContentClassifier } from './router/content-classifier.js';
import { DecisionContentClassifier } from './router/decision-content-classifier.js';
import { ProviderPool } from './router/provider-pool.js';
import { QualityChecker } from './router/quality-checker.js';
import type { DictionaryRepository } from '../storage/ports/dictionary-repository.js';
import type { BlobStore } from '../storage/ports/blob-store.js';
import { MicroPipeline } from './router/micro/index.js';
import { TaskClassifier } from './router/micro/task-classifier.js';
import { RulesModel, EmbeddingModel, MicroLlmModel, DecisionModel } from './router/micro/models/index.js';
import type { MicroModel } from './router/micro/models/base.js';
import type { RoutingDecision } from './router/router.js';
import { PermissionEvaluator, extractPaths } from './permission/evaluator.js';
import { computeToolAvailability } from './permission/availability.js';
import { PermissionApprovalManager, type ApprovalRegistry } from './permission/approval.js';
import { emptyPermissionConfig } from './permission/derive.js';
import { createFileStorage } from '../storage/storage-context.js';
import type { SSHKeyRepository } from '../storage/ports/ssh-key-repository.js';
import type { ProjectStoreLike } from '../storage/project-store.js';
import { GitService } from '../git/git-service.js';
import { MAX_DOOM_LOOP_COUNT } from './llm-error.js';
import { WorktreeDirectoryMissingError } from './worktree/errors.js';
import type { WorktreeService } from './worktree/service.js';
// ADR-115: гидратация вложений сообщений (blob → base64) перед LLM-вызовом.
import { createHydrateDeps, hydrateMessageAttachments, type DroppedAttachmentRef, type HydrateDeps } from './attachments/hydrate.js';
import { materializeAttachment } from './attachments/materialize.js';
import { AttachmentService } from './attachments/service.js';
import { runSubagentResume, validateSubagentResume, SubagentResumeError, type SubagentResumeDeps } from './tools/task-resume.js';
import { buildDenyResult, executeToolDef } from './tools/tool-execution.js';
import type { HookBus } from './hooks/hook-bus.js';
import type { RequestSessionService } from './events/request-session.js';
// Этап 1 roadmap 0.13 (блок 3): сервис «вопрос пользователю».
import type { QuestionService } from './question/service.js';
// Этап 1 roadmap 0.13 (блок 4): единый реестр фоновых прогонов (PROP-096).
import type { BackgroundRunService } from './background/service.js';
// ADR-111 §detach: реестр активных (блокирующих) прогонов сессии.
import { ActiveRunRegistry } from './background/active-runs.js';
import type { ProcessService } from './processes/service.js';
import type { BlobRefRepository } from '../storage/ports/blob-ref-repository.js';

import { ALL_RUNTIME_DEPS_AVAILABLE, RUNTIME_DEP_BINARY, TOOL_RUNTIME_DEP, refreshRuntimeDeps, type RuntimeDeps } from './tools/runtime-deps.js';
import { InlineExecutionPort } from '../execution/inline-execution-port.js';
import type { ExecutionPort } from '../execution/ports/index.js';
import { getToolTrust } from './security/trust.js';
import { detectPromptInjection, applyPolicy, wrapContent, buildWarnLine, type InjectionPolicy } from './security/prompt-injection.js';
import { loadProtectedPaths } from './security/protected-paths.js';
import type { ProtectedPathsPolicy } from './security/protected-paths.js';
import { GatewayProvider, AuditLogger, RateLimiter, ObfuscationMapStore, obfuscateSecrets, maskSecret, DISABLED_GATEWAY_CONFIG, LlmFilterRegistry } from './gateway/index.js';
import type { SecretPatternRepository } from '../storage/ports/secret-pattern-repository.js';
import type { MetricsRegistry } from '../metrics/registry.js';
import type { AuthorityGateHook, AuthorityShadowHook } from './authority/hook.js';
import { authorityActionForTool } from './authority/actions.js';
import { deriveAuthorityTarget } from './authority/target.js';
import { resolveTurnPrincipal } from './authority/principal.js';
import { deriveSessionParticipants } from './authority/participants.js';
import { resolveTurnMode } from './authority/mode.js';
import { createAuthorityTurnContext, type AuthorityTurnContext } from './authority/turn.js';
import { t as sm, i18n as i18nMeta } from './system-messages.js';
import { runInlineShell } from './commands/inline-shell.js';
import { TEMPLATE_SHELL_MAX_BYTES } from './commands/template.js';
// ADR-095 (шаг 6a): вынесенные модули оркестратора (тонкие делегации).
import { computeMessageCost, resolveMessageModel, estimateUsage, estimatePromptChars as estimatePromptCharsFn, publishLiveUsage, aggregateSubagentStats, type PublishLiveUsageParams } from './orchestrator/usage.js';
import { publishFsChange } from './orchestrator/fs-change.js';
import { applySteerInjections } from './steering/apply.js';
import { saveAssistantMessage, getAssistantSecrets, resolveAssistantStatus, joinAccumulatedTexts, type SaveAssistantMessageDeps, type AssistantMessageStatus } from './orchestrator/persistence.js';
import { StreamMessageDraft, type StreamMessageRef } from './orchestrator/stream-persistence.js';
import { formatLlmError, errorTypeI18n, handleLlmFailure, type LlmFailureContext } from './orchestrator/errors.js';
import { resolveModelContextWindow, getEffectiveModel, wrapWithGateway, getProvider, routeProvider, type RouteProviderDeps } from './orchestrator/routing.js';
import { sessionMessagesToLlm as sessionMessagesToLlmFn, buildPromptHistoryInfo as buildPromptHistoryInfoFn, lastPromptMeta as lastPromptMetaFn, instructionsMemoKey as instructionsMemoKeyFn, resolveTurnQuery as resolveTurnQueryFn } from './orchestrator/prompt-info.js';
import { publishLocalCompletion as publishLocalCompletionFn, finishLocalCommand as finishLocalCommandFn, type FinishLocalCommandDeps } from './orchestrator/commands.js';
import { handleDebugSystemMessage as handleDebugSystemMessageFn, type DebugSystemMessageDeps } from './orchestrator/debug.js';
import { handleSummarization as handleSummarizationFn, type SummarizationDeps } from './orchestrator/summarization.js';
import { runProcessEarly, type ProcessEarlyDeps } from './orchestrator/phases/process-early.js';
import { runProcessFinalize, type ProcessFinalizeDeps } from './orchestrator/phases/process-finalize.js';
import { runProcessSetup, withoutMemoryPluginTools, type ProcessSetupDeps, type MemoryContextEntry } from './orchestrator/phases/process-setup.js';
import type { AnalyticsRecorder } from '../analytics/recorder.js';

const DEFAULT_MAX_ITERATIONS = Number.POSITIVE_INFINITY;
/** Порог заполненности контекстного окна (%), после которого публикуем context.limit_warning. */
const CONTEXT_LIMIT_WARNING_PERCENT = 90;

/**
 * ADR-070 §2.6: статус ответа ассистента для строки статистики в UI.
 * - `completed` — нормальный ответ (без префикса);
 * - `cancelled` — отменён пользователем;
 * - `stopped` — остановлен (отказ в туле / блокировка);
 * - `error` — ошибка/пустой ответ LLM;
 * - `limit` — достигнут лимит итераций.
 *
 * ADR-095 (шаг 6a): тип и валидация вынесены в `orchestrator/persistence.ts`;
 * реэкспорт сохраняет прежний публичный контракт (`orchestrator.js`).
 */
export type { AssistantMessageStatus } from './orchestrator/persistence.js';

/**
 * ADR-107: блок памяти, ушедший в промпт хода (для телеметрии памяти).
 *
 * Публикуется из оркестратора: composition root подключает сюда запись
 * метрик (`synth_memory_context_*`), плагин памяти — через фасад.
 */
export type { MemoryContextEntry } from './orchestrator/phases/process-setup.js';

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
  /**
   * ADR-030: ядровая шина хуков — эмиты жизненного цикла агента
   * (`pre/post_tool_use`, `permission_denied`, `plan_approved`, ...). Не задана —
   * хуки не выполняются, поведение оркестратора не меняется.
   */
  hooks?: HookBus;
  /**
   * ADR-102: сборщик суточных роллапов аналитики (`usage`/`decision`). Не задан —
   * запись не выполняется, поведение оркестратора не меняется.
   */
  analytics?: AnalyticsRecorder;
  contextBuilder: ContextBuilder;
  providerLoader: (name: string) => SharedProviderConfig | null;
  contextOptimizer?: ContextOptimizer;
  contextConfig?: ContextFileRepository;
  modelPriceLoader?: (modelName: string) => ModelPricing | null;
  dataDir?: string;
  toolRegistry?: ToolRegistry;
  agentRegistry?: AgentRegistry;
  mcpManager?: McpManager;
  routerConfig?: RouterConfig;
  /**
   * ADR-084: конфигурация decision-слоя (config.yaml `decision`). Не задана/
   * `enabled:false` — decision-уровень микро-каскада выключен.
   * Runtime-обновление — `setDecisionConfig` (Ф5).
   */
  decisionConfig?: DecisionConfig;
  projectStore?: ProjectStoreLike;
  /**
   * Онбординг: хранилище профилей для тула `profile_update` (сохранение ответов
   * интервью, завершение онбординга). Не задано — тул вернёт
   * `profile.deps_unavailable`.
   */
  profilesStore?: ProfileStore;
  /**
   * ADR-076 §T6: хранилище SSH-ключей для сетевых git-тулов (`git_push`/`git_pull`).
   * Не задано — создаётся лениво из `dataDir` (+ env); без `dataDir` — git
   * использует ambient ssh (реестр/ключи недоступны).
   */
  sshKeyStore?: SSHKeyRepository;
  /**
   * ADR-115/ADR-116: blob-порт для гидратации вложений сообщений (blob → base64
   * перед LLM-вызовом). Продакшн передаёт `StorageContext.blobs`; не задан —
   * фоллбэк по `dataDir` (тесты/прямое конструирование, см.
   * `_getAttachmentHydrateDeps`).
   */
  blobs?: BlobStore;
  /**
   * ADR-115: модальности модели из её конфига (`ModelConfig.modalities`).
   *
   * Резолвер задаётся точкой сборки (по `modelCache`): конфиг модели —
   * единственный источник истины (каталог провайдера при синхронизации либо
   * ручной override); справочника модальностей в ядре нет.
   * Не задан или вернул `undefined` — модальности неизвестны, гидратация
   * вложений их **не** фильтрует (решение 2026-10-27).
   */
  resolveModelModalities?: (providerName: string, modelId: string) => AttachmentModality[] | undefined;
  /**
   * ADR-115: live-конфиг вложений (`attachments.*`, runtime-настройки поверх
   * config). Читается **на каждый ход** — изменение `workspaceFallback`
   * применяется без рестарта.
   *
   * `workspaceFallback: false` — отброшенное вложение **не** сохраняется в
   * `<workspace>/attachments/`: в блоке `[ATTACHMENTS NOT DELIVERED]` остаётся
   * только причина, без `path`. Не задан (или `true`) — материализация включена
   * (поведение по умолчанию).
   */
  attachmentsConfig?: () => AttachmentsConfig;
  /**
   * ADR-115: каталог моделей инстанса для агента (тул `list_models`).
   *
   * Отдаёт все модели инстанса (`ModelConfig` из каталога провайдеров/ручных
   * override) — тул фильтрует их по модальности/провайдеру и показывает
   * назначения `attachments.modalityModels`. Не задан — тул недоступен
   * (`models.list.deps_unavailable`): дампа каталога «из ниоткуда» нет.
   */
  listModels?: () => Promise<ModelConfig[]>;
  /**
   * ADR-034/ADR-035: порт словарей классификации (микро-слой, threat-scan,
   * проектные инструкции). Продакшн передаёт `StorageContext.dictionaries`;
   * не задан — собирается из `dataDir` для прямого конструирования (тесты),
   * TODO(ADR-096): убрать фоллбэк, брать обязательным портом.
   */
  dictionaryStore?: DictionaryRepository;
  defaultWorkingDir?: string;
  /**
   * Корень каталога workspaces: `join(dataDir, 'workspaces')` по умолчанию
   * (аналог resolveWorkspacesRoot). Относительные `project.workspace` резолвятся
   * относительно этого корня (ADR-014).
   */
  workspacesRoot?: string;
  /**
   * ADR-075/ADR-076: git-сервис для тулов управления репозиториями проекта.
   * Не задан — создаётся лениво из `workspacesRoot`.
   */
  gitService?: GitService;
  /**
   * ADR-075: managed-режим проекта (backend): включает строгую проверку явного
   * workspace (deny вне root) в тулах проекта.
   */
  workspaceManaged?: boolean;
  /**
   * ADR-075: политика абсолютного workspace вне `workspacesRoot` для тулов проекта.
   * Не задана — `confirm`.
   */
  getWorkspaceOutsideRootPolicy?: () => WorkspaceOutsideRootPolicy | Promise<WorkspaceOutsideRootPolicy>;
  /** Глобальная секция permission из config.yaml (ADR-029). */
  permissionConfig?: PermissionConfig;
  /** Строгость цикла Plan→Build по умолчанию из config.yaml session.planMode (ADR-028). */
  defaultPlanMode?: PlanMode;
  /** Секция безопасности (защита от Indirect Prompt Injection). */
  securityConfig?: SecurityConfig;
  /** LLM Gateway (ADR-036): глобальный тумблер и конфиг. Выключен по умолчанию. */
  gatewayConfig?: LLMGatewayConfig;
  /** Путь к JSONL полного лога запросов/ответов LLM ({dataDir}/audit/llm-payloads.jsonl). */
  gatewayPayloadLogPath?: string;
  /** Аудит LLM Gateway — если создаётся снаружи (backend/runner). Иначе создаётся внутри. */
  gatewayAuditLogger?: AuditLogger;
  /** Хранилище кастомных regex-паттернов детекции секретов (override ?? дефолт). */
  gatewayPatternStore?: SecretPatternRepository;
  /**
   * ADR-090: **мутабельный** реестр фильтров LLM-вызовов.
   * Единый экземпляр на инстанс: через него `GatewayProvider` (все точки:
   * ход сессии, пул, decision, суммаризация) видит фильтры, а фасад плагинов
   * (`PluginHost`, часть 2) регистрирует/снимает их при активации/деактивации.
   *
   * Не задан — реестр создаётся здесь пустым (`getLlmFilters()`); пустой реестр
   * поведения не меняет (ADR-090: без фильтров — прежний ход вызова).
   */
  llmFilters?: LlmFilterRegistry;
  /**
   * ADR-090: бюджет времени на один вызов фильтра по
   * умолчанию, мс (`plugins.llmFilterTimeoutMs`). Действует, если фильтр не
   * задал свой `timeoutMs`. Применяется только к реестру, созданному здесь.
   */
  llmFilterTimeoutMs?: number;
  /**
   * ADR-090: бюджет символов **на блок** системного
   * промпта от плагина (`plugins.promptBlockMaxChars`, дефолт 4 000).
   *
   * Ранее ключ конфигурации не доходил до композера — бюджет всегда оставался
   * дефолтным (долги Д3). Живое изменение — `setPromptBlockMaxChars`.
   */
  promptBlockMaxChars?: number;
  /**
   * ADR-090: реестр провайдеров блоков системного
   * промпта — **тот же** экземпляр, в который регистрирует вклады фасад
   * плагинов (`PluginRuntime`/`PluginHost`).
   *
   * Не задан — композер создаёт собственный пустой реестр: блоки плагинов в
   * промпт сессии не попадут (прежнее поведение), вклады плагинов уйдут в
   * другой экземпляр. Поэтому composition root обязан передать сюда общий
   * реестр (`server/app/deps.ts`, `backend/app/deps.ts`).
   */
  promptBlocks?: PromptBlockRegistry;
  /**
   * ADR-094: реестр метрик — LLM-вызовы учитываются и при выключенном gateway
   * (`synth_llm_requests_total`/`..._duration_seconds`/`..._tokens_total`).
   */
  metrics?: MetricsRegistry;
  /**
   * ADR-107: телеметрия блоков памяти, ушедших в промпт хода (метрики
   * `synth_memory_context_injected_total`/`synth_memory_context_chars`).
   *
   * Не задана — телеметрия не ведётся; ошибка колбэка не влияет на ход.
   */
  onMemoryContext?: (entries: readonly MemoryContextEntry[]) => void;
  /**
   * ADR-106 Ф1: шов shadow-наблюдения Authority-слоя. Задан — решения
   * permission-слоя дополнительно считаются моделью «действие × цель» и
   * пишутся в журнал решений; **решение прав не меняется**.
   *
   * @deprecated ADR-106 Ф2: используйте `authorityGate` — он же считает
   *   решение, ведёт журнал и (в enforced-режиме) **применяет** решение.
   */
  authorityShadow?: AuthorityShadowHook;
  /**
   * ADR-106 Ф2: шов решения Authority-слоя (guard).
   *
   * Задан — решения permission-слоя считаются моделью «действие × цель» и
   * пишутся в журнал решений. При `authority.enabled` **без**
   * `authority.shadow` решение **применяется**: `deny`/`ask` сужают решение
   * permission-слоя, а потолок сессии не снимается режимом `yolo`.
   */
  authorityGate?: AuthorityGateHook;
  /**
   * ADR-106 Ф3: реестр подтверждений. Задан — запросы подтверждения
   * **привязываются** к `(принципал, ход, действие, цель, отпечаток)`: ответ
   * принимает только носитель покрывающего гранта, повторный ответ — отказ.
   *
   * Не задан — поведение прежнее (слой Authority выключен или shadow).
   */
  approvalRegistry?: ApprovalRegistry;
  /** ADR-070 §2.2: политика prompt-cache (config llm.cache). Дефолт — auto. */
  cachePolicy?: CachePolicy;
  /**
   * ADR-071 §2.3: глобальная админская политика включения **встроенных**
   * инструментов (config.yaml tools.policy). Дефолт — `auto`. Per-session
   * override — `session.settings.toolsPolicy`.
   */
  toolsPolicy?: ToolsPolicy;
  /**
   * ADR-071 §2.3: глобальная админская политика включения **MCP**-инструментов
   * (config.yaml mcp.policy). Дефолт — `auto`. Независима от `toolsPolicy`;
   * per-session override — `session.settings.mcpPolicy`.
   */
  mcpPolicy?: ToolsPolicy;
  /**
   * ADR-071 §2.6: instance-wide жёсткое отключение инструментов (config.yaml
   * `tools.disabled`). Runtime-значение приходит через `setToolsDisabled`.
   */
  toolsDisabled?: ToolsDisabledConfig;
  /**
   * ADR-046 §4.5: системный hard-gate скиллов (категории/группы/имена) из
   * runtime-настроек. Runtime-обновление — `setSkillsDisabled`.
   */
  skillsDisabled?: SkillsDisabledRequest;
  /**
   * ADR-070 §2.9.1: доступность внешних программ окружения (git/rg/sh) —
   * детекция `detectRuntimeDeps()`. Не задана — fail-open (все доступны).
   *
   * Это **живой** снимок: перед каждым ходом он перечитывается
   * (`refreshRuntimeDeps`, запись по месту), поэтому объект разделяется с
   * другими потребителями снимка из точки сборки (permission-слой шагов
   * пайплайнов) — не заменять ссылку. Ручная подстановка — `setRuntimeDeps`
   * (живёт до ближайшего перечитывания снимка).
   */
  runtimeDeps?: RuntimeDeps;
  /**
   * ADR-077: порт исполнения команд. Не задан — inline-реализация (исполнение
   * в процессе, прежнее поведение). Задаётся при сборке приложения: режим
   * исполнения — параметр запуска, а не runtime-настройка (инвариант 24).
   */
  executionPort?: ExecutionPort;
  /**
   * ADR-071 §2.6: chars-per-token модели из runtime-настроек (калибровка).
   * Не задан/нет значения — дефолт `DEFAULT_CHARS_PER_TOKEN`.
   */
  tokenRatioLoader?: (model: string) => Promise<number | undefined>;
  /** ADR-071 §2.6: сохранение откалиброванного chars-per-token после ответа. */
  onTokenRatioCalibrated?: (model: string, ratio: number) => void | Promise<void>;
  /**
   * ADR-046 §5: рантайм скиллов (SkillService) — каталог в промпт и тул `skill`.
   * Не задан — скиллы не участвуют в промпте/тулах.
   */
  skillRuntime?: SkillRuntime;
  /**
   * ADR-046 §7: рантайм `/`-команд (CommandService). Не задан — `/`-команды не
   * резолвятся (сообщение уходит в LLM как есть).
   */
  commandRuntime?: CommandRuntime;
  /**
   * ADR-069 Фаза 1: конфигурация проектных инструкций (`AGENTS.md`). Не задана/
   * `enabled:false` — проектные инструкции не грузятся.
   */
  instructionsConfig?: InstructionsConfig;
  /**
   * ADR-069 Фаза 2a: `config.skills.trustedProjectDirs` — project-trust гейт
   * инструкций (недоверенный проект виден в диагностике, но не грузится).
   */
  instructionsTrustedProjectDirs?: readonly string[];
  /**
   * ADR-089: late-bound доступ к funnel создания сессий (`RequestSessionService`).
   * Прокидывается в `TaskExtra` — тул `task` создаёт дочернюю сессию через
   * `request` (единые правила/аудит), с fallback на прямой `createSession`.
   * Геттер нужен, т.к. сервис создаётся в приложении после оркестратора.
   */
  getRequestSessionService?: () => RequestSessionService | undefined;
  /**
   * ADR-101/ADR-051: late-bound рантайм автоматизации (пайплайны, расписания)
   * для встроенных тулов (`pipeline_*`/`schedule_*`).
   *
   * Геттер нужен, т.к. движок пайплайнов и шедулер создаются в приложении
   * **после** оркестратора; в момент хода отдаётся актуальный снимок
   * зависимостей (`engine/tools/automation-runtime.ts`).
   */
  getAutomationRuntime?: () => AutomationRuntime | undefined;
  /**
   * ADR-051: late-bound резолвер «активно ли расписание для сессии» (в сессии есть
   * включённое расписание с целью-сессией). Прокидывается в Composer-контекст:
   * при `true` в системный промпт добавляется статическое описание `Scheduler`.
   * Геттер late-bound, т.к. `ScheduleStore` создаётся в приложении после
   * оркестратора.
   */
  isSchedulerActive?: (sessionId: string) => Promise<boolean>;
  /**
   * «Стоп»: late-bound проверка персистентного флага отмены сессии
   * (`session.status.cancelRequested`). Не задана — проверка не выполняется
   * (поведение прежнее). На границе итерации Tool Use позволяет остановить
   * длинный прогон, когда живой cancelToken недоступен (backoff/гонка).
   */
  isCancelRequested?: (sessionId: string) => Promise<boolean>;
  /**
   * Этап 1 roadmap 0.13 (блок 3): сервис «вопрос пользователю» (`ask_user`).
   *
   * Не задан — тул `question` возвращает `question.deps_unavailable`
   * (вопросы в этой сборке не работают).
   */
  questionService?: QuestionService;
  /**
   * Этап 1 roadmap 0.13 (блок 4): единый реестр фоновых прогонов (PROP-096).
   *
   * Не задан — фоновый запуск саб-агента (`task` с `background: true`)
   * недоступен (`task.background_disabled`).
   */
  backgroundService?: BackgroundRunService;
  /**
   * Этап 1 roadmap 0.13 (блок 4): фоновые прогоны разрешены инстансом
   * (`background.enabled`). `false` — тул `task` с `background: true`
   * отказывает (`task.background_disabled`). По умолчанию — разрешены.
   */
  backgroundEnabled?: boolean;
  /**
   * PROP-097 (блок 5b): сервис фоновых шелл-процессов.
   *
   * Не задан — тул `execute_shell` с `background: true` отказывает
   * (`process.deps_unavailable`).
   */
  processService?: ProcessService;
  /**
   * ADR-115: доставка user-сообщения в сессию — очередь + автоход.
   *
   * Точка сборки передаёт тот же нотификатор, что и `background.onNotifyParent`
   * (`notifyBackgroundParent` в `server/app/deps.ts` / `backend/app/deps.ts`):
   * сообщение попадает в `pendingMessages`, процессор добавляет его в историю и
   * запускает ход. Нужна тулу `attach_workspace_file`: приложенный файл —
   * обычное user-сообщение с медиа-частью, а не результат тула.
   * Не задана — привязка файла отказывает (`attach.tool.delivery_unavailable`).
   */
  deliverUserMessage?: (sessionId: string, message: Message) => Promise<void>;
  /**
   * ADR-115: порт учёта ссылок на объекты blob-хранилища (`StorageContext.blobRefs`).
   *
   * Нужен тулу `attach_workspace_file`: созданное им сообщение ссылается на
   * объект вложения, и без записи ссылки GC счёл бы объект сиротой по TTL.
   * Не задан — ссылка не пишется (best-effort, привязка работает).
   */
  blobRefs?: BlobRefRepository;
  /**
   * ADR-114: сервис worktree'ов — тулы `git_worktree_*`.
   *
   * Не задан — тулы worktree недоступны (`worktree.tool.deps_unavailable`).
   */
  worktreeService?: WorktreeService;
  /**
   * Шаг 2б: интервал (мс) персистентности частичного стрима. Черновик
   * assistant-сообщения создаётся сразу при первом непустом чанке, далее
   * обновляется не чаще интервала (или при приросте ≥4096 символов).
   * По умолчанию 1000; в тестах — 1–5 мс.
   */
  streamPersistIntervalMs?: number;
}

export interface ProcessMessageResult {
  error?: string;
  errorType?: string;
  canRetry?: boolean;
}

/**
 * ADR-069 §2.1/§7: результат резолва проектных инструкций для текущего хода —
 * composer-блок, «сырой» контент (для саб-агентов) и провенанс файлов (для
 * события `context.instructions_loaded` и seed lazy-реестра).
 */
interface ResolvedProjectInstructions {
  instructions: ComposerInstructions;
  content: string;
  files: InstructionsFileInfo[];
}

/**
 * ADR-069 §3.5/R5: запись мемоизации проектных инструкций на время хода —
 * хранится только последний ход на сессию, `key` — входы, влияющие на результат.
 */
interface InstructionsTurnMemoEntry {
  turnId: string;
  key: string;
  result: ResolvedProjectInstructions | undefined;
}

/** Верхняя граница числа сессий в мемо инструкций (простая FIFO-эвикция). */
const MAX_INSTRUCTIONS_TURN_MEMO = 256;

/** ADR-084: безопасный дефолт gateway-конфига для decision-провайдеров (см. `DISABLED_GATEWAY_CONFIG`). */
const DEFAULT_DECISION_GATEWAY_CONFIG: LLMGatewayConfig = DISABLED_GATEWAY_CONFIG;

/** ADR-070 §2.5: read-only диагностика промпта для `GET /sessions/:id/prompt`. */
export interface PromptDiagnostics {  manifest: PromptManifest;
  /** ADR-070 §2.5: состав слоя истории (`messages`), зеркалит реальную отправку. */
  history: PromptHistoryInfo;
  /** Состояние промпта активного агента (null, если ещё не собирался). */
  promptState: PromptState | null;
  /** `promptMeta` последнего ответа активного агента (null, если нет). */
  lastPromptMeta: PromptMeta | null;
  /** ADR-071 §2.6: строки таблицы «Встроенные инструменты» (имя/capability/доступность). */
  toolsDetail: PromptToolDetail[];
}

/**
 * ChatOrchestrator — единый оркестратор обработки чат-сообщений.
 * Предоставляет processMessage callback для QueueProcessor.
 */
export class ChatOrchestrator {
  private readonly _sessionManager: SessionManager;
  private readonly _eventBus: EventBus;
  /** ADR-030: шина хуков жизненного цикла (null — эмиты не выполняются). */
  private readonly _hooks: HookBus | null;
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
  /** ADR-084: конфиг decision-слоя (runtime-изменяемая, гейт микро-каскада). */
  private _decisionConfig: DecisionConfig | null;
  private readonly _microPipeline: MicroPipeline | null;
  private readonly _contextConfig: ContextFileRepository | null;
  private readonly _projectStore: ProjectStoreLike | null;
  /** Онбординг: хранилище профилей (тул `profile_update`, сохранение интервью). */
  private readonly _profilesStore: ProfileStore | null;
  /** ADR-076 §T6: хранилище SSH-ключей (сетевые git-тулы); null — без dataDir. */
  private readonly _sshKeyStore: SSHKeyRepository | null;
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
  private readonly _dictionaryStore: DictionaryRepository;
  private _gatewayConfig: LLMGatewayConfig | null;
  private _obfMapStore: ObfuscationMapStore | null;
  private _gatewayAudit: AuditLogger | null;
  private _gatewayRateLimiter: RateLimiter | null;
  private readonly _gatewayPatternStore: SecretPatternRepository | null;
  /** ADR-094: реестр метрик (LLM-вызовы; временные метрики подключаются приложением). */
  private readonly _metrics: MetricsRegistry | null;
  /** ADR-107: телеметрия блоков памяти в промпте хода (метрики `synth_memory_context_*`). */
  private readonly _onMemoryContext: ((entries: readonly MemoryContextEntry[]) => void) | undefined;
  /** ADR-106 Ф1: шов shadow-наблюдения Authority-слоя (не меняет решения прав). */
  private readonly _authorityShadow: AuthorityShadowHook | undefined;
  /** ADR-106 Ф2: шов решения Authority-слоя (считает, журналит и применяет). */
  private readonly _authorityGate: AuthorityGateHook | undefined;
  /**
   * ADR-090: реестр фильтров LLM-вызовов (мутабельный;
   * общий для всех gateway-точек — см. `getLlmFilters()`).
   */
  private readonly _llmFilters: LlmFilterRegistry;
  /** Бюджет символов на блок плагина; мутабелен (runtime-настройка). */
  private _promptBlockMaxChars: number | undefined;
  private readonly _dataDir: string;
  /**
   * ADR-115/ADR-116: blob-порт для гидратации вложений (инъекция из контекста
   * хранения). `null` — порт не передан: фоллбэк по `dataDir` собирается
   * лениво в `_getAttachmentHydrateDeps` (не создаём каталог данных в
   * конструкторе).
   */
  private readonly _blobs: BlobStore | null;
  /**
   * ADR-115: модальности модели из её конфига (`ModelConfig.modalities` —
   * каталог провайдера или ручной override). `undefined` — у модели значение
   * не задано (модальности неизвестны): вложения не фильтруются.
   */
  private readonly _resolveModalities: ((providerName: string, modelId: string) => AttachmentModality[] | undefined) | null;
  /**
   * ADR-115: live-конфиг вложений (runtime-настройки поверх config).
   * `undefined` — резолвер не задан: `workspaceFallback` считается включённым
   * (поведение по умолчанию), материализация отброшенных вложений выполняется.
   */
  private readonly _attachmentsConfig?: () => AttachmentsConfig;
  /**
   * ADR-115: каталог моделей инстанса для агента (`list_models`).
   * `undefined` — резолвер не задан: тул отвечает
   * `models.list.deps_unavailable` (дампа каталога «из ниоткуда» нет).
   */
  private readonly _listModels?: () => Promise<ModelConfig[]>;
  /**
   * ADR-115: порты чтения вложений для гидратации (лениво — поверх blob-порта
   * по `dataDir`, как ssh-ключи/словари ниже). `null` — ещё не созданы.
   */
  private _attachmentHydrateDeps: HydrateDeps | null = null;
  /** Путь к JSONL полного лога запросов/ответов LLM (передаётся в GatewayProvider). */
  private readonly _gatewayPayloadLogPath: string | undefined;
  /** Внешний audit-logger (backend/runner) — переиспользуется при live-включении gateway. */
  private readonly _gatewayAuditExternal: AuditLogger | null;
  /** ADR-070 §2.2: политика prompt-cache (auto | none) из config llm.cache. */
  private readonly _cachePolicy: CachePolicy;
  /** ADR-071 §2.3: глобальная политика включения встроенных инструментов (runtime-изменяемая). */
  private _toolsPolicy: ToolsPolicy;
  /** ADR-071 §2.3: глобальная политика включения MCP-инструментов (runtime-изменяемая). */
  private _mcpPolicy: ToolsPolicy;
  /** ADR-071 §2.6: instance-wide отключение инструментов (runtime-изменяемая, admin). */
  private _toolsDisabled: ToolsDisabledConfig;
  /** ADR-046 §4.5: системный hard-gate скиллов (runtime-изменяемая, admin). */
  private _skillsDisabled: SkillsDisabledRequest;
  /** ADR-070 §2.9.1: доступность внешних программ окружения (runtime-изменяемая). */
  private _runtimeDeps: RuntimeDeps;
  /**
   * ADR-077: порт исполнения команд (inline по умолчанию; в split-режиме —
   * удалённый исполнитель). Режим — параметр запуска процесса, поэтому порт
   * задаётся при сборке приложения и не переинициализируется на лету.
   */
  private readonly _executionPort: ExecutionPort;
  /** ADR-071 §2.6: загрузчик chars-per-token модели (калибровка). */
  private readonly _tokenRatioLoader: ((model: string) => Promise<number | undefined>) | undefined;
  /** ADR-071 §2.6: сохранение калибровки chars-per-token после ответа. */
  private readonly _onTokenRatioCalibrated: ((model: string, ratio: number) => void | Promise<void>) | undefined;
  /** ADR-046 §5: рантайм скиллов (каталог промпта + тул `skill`). */
  private readonly _skillRuntime: SkillRuntime | null;
  /** ADR-046 §7: рантайм `/`-команд (резолвинг до LLM). */
  private readonly _commandRuntime: CommandRuntime | null;
  /** ADR-089: late-bound funnel создания сессий для тула `task` (null — не задан). */
  private readonly _getRequestSessionService: (() => RequestSessionService | undefined) | null;
  /** ADR-101/ADR-051: late-bound рантайм автоматизации (null — не задан). */
  private readonly _getAutomationRuntime: (() => AutomationRuntime | undefined) | null;
  /** ADR-051: late-bound резолвер активности расписания в сессии (null — не задан). */
  private readonly _isSchedulerActive: ((sessionId: string) => Promise<boolean>) | null;
  /**
   * «Стоп»: late-bound проверка персистентного флага `status.cancelRequested`
   * (null — не задан). Позволяет прервать длинный многоитерационный прогон на
   * границе цикла Tool Use даже без живого cancelToken (backoff/гонка).
   */
  private readonly _isCancelRequested: ((sessionId: string) => Promise<boolean>) | null;
  /**
   * Этап 1 roadmap 0.13 (блок 3): сервис «вопрос пользователю» (null — не задан).
   */
  private readonly _questionService: QuestionService | null;
  /**
   * Этап 1 roadmap 0.13 (блок 4): реестр фоновых прогонов (null — не задан:
   * фоновый запуск саб-агента недоступен).
   */
  private readonly _backgroundService: BackgroundRunService | null;
  /**
   * ADR-111 §detach: реестр активных (блокирующих) прогонов сессии —
   * `POST /api/v2/sessions/:id/background` переводит их в фон.
   *
   * Живёт в памяти процесса control plane (хэндл detach непереносим; PROP-105 —
   * будущее). Один экземпляр на оркестратор: `task` регистрирует хэндл, роут
   * зовёт `detachAll`.
   */
  readonly activeRuns = new ActiveRunRegistry();
  /** Этап 1 roadmap 0.13 (блок 4): фоновые прогоны разрешены инстансом. */
  private readonly _backgroundEnabled: boolean;
  /**
   * PROP-097 (блок 5b): сервис фоновых шелл-процессов (null — не задан:
   * режим `background: true` у `execute_shell` недоступен).
   */
  private readonly _processService: ProcessService | null;
  /**
   * ADR-115: доставка user-сообщения в сессию (очередь + автоход) — хук
   * `attach_workspace_file` (null — не задан: привязка файла отказывает).
   */
  private readonly _deliverUserMessage: ((sessionId: string, message: Message) => Promise<void>) | null;
  /**
   * ADR-115: порт учёта ссылок на blob-объекты (`StorageContext.blobRefs`);
   * `null` — не задан (ссылка сообщения не пишется — best-effort).
   */
  private readonly _blobRefs: BlobRefRepository | null;
  /**
   * ADR-115: сервис вложений для тула `attach_workspace_file` (лениво — поверх
   * blob-порта, как гидратация: отдельный экземпляр не создаёт состояния).
   */
  private _attachmentService: AttachmentService | null = null;
  /**
   * ADR-114: сервис worktree'ов (null — не задан: тулы `git_worktree_*`
   * недоступны).
   */
  private readonly _worktreeService: WorktreeService | null;
  /**
   * Этап 1 roadmap 0.13 (блок 3): соответствие «ход (`streamId`) → сессия».
   *
   * Нужно для «Стопа»: `cancel(streamId)` знает только ход, а снимать открытые
   * вопросы нужно у сессии.
   */
  private readonly _streamSessions = new Map<string, string>();
  /** Шаг 2б: интервал персистентности частичного стрима (мс). */
  private readonly _streamPersistIntervalMs: number;
  /** ADR-069 Фаза 1: конфиг проектных инструкций (null — выключено/не задано). */
  private readonly _instructionsConfig: InstructionsConfig | null;
  /** ADR-069 Фаза 1: резолвер merged chain `AGENTS.md` (null — выключено). */
  private readonly _instructionsResolver: ProjectInstructionsResolver | null;
  /** ADR-069 §3.5/R5: мемоизация инструкций на время хода (последний ход на сессию). */
  private readonly _instructionsTurnMemo = new Map<string, InstructionsTurnMemoEntry>();
  /** ADR-069 Фаза 2b: lazy-догрузка вложенных инструкций в tool result. */
  private readonly _lazyInstructions: LazyInstructionsLoader | null;
  private _providerPool: ProviderPool | null;
  /** Политика защищённых путей (СКВОЗНАЯ проверка файловых тулов + shell) — ленивая загрузка с кэшем. */
  private _protectedPaths: ProtectedPathsPolicy | null = null;
  private _protectedPathsLoaded = false;
  /** ADR-102: сборщик роллапов аналитики (`null` — запись выключена). */
  private readonly _analytics: AnalyticsRecorder | null;

  /** Публичный доступ к реестру агентов (для сериализации modeApplicable). */
  get agentRegistry(): AgentRegistry | null {
    return this._agentRegistry;
  }

  /**
   * ADR-070 §2.6: цены модели для расчёта стоимости сообщений/статистики.
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
    return computeMessageCost(model, usage, this._modelPriceLoader);
  }

  /**
   * ADR-070 §2.6: fallback-цепочка модели сообщения. Провайдеры выставляют
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
    return resolveMessageModel(chunkModel, finalModel, provider, session);
  }

  /**
   * ADR-070 §2.6 (Bug 4): best-effort оценка usage, когда провайдер не успел
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
    return estimateUsage(usage, promptChars, outputChars);
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
    return estimatePromptCharsFn(messages, systemPrompt, tools);
  }

  /**
   * ADR-070 §2.6: публикация live-статистики стрима (`stream.usage`) через
   * существующий транспорт (publishChunk → EventBus, ADR-024).
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
  private _publishLiveUsage(params: PublishLiveUsageParams): void {
    publishLiveUsage(params, (model, usage) => this._computeMessageCost(model, usage));
  }

  /**
   * ADR-070 §2.6: агрегация per-message статистики сабагентов из tool-результатов
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
    return aggregateSubagentStats(toolResults, (model, usage) => this._computeMessageCost(model, usage));
  }

  /**
   * Политика защищённых путей: системный дефолт definitions/protected-paths.json
   * + override {dataDir}/security/protected-paths.json (каскад add/remove)
   * + динамические префиксы инстанса `{dataDir}/secrets` и `{dataDir}/security`.
   * Ленивая загрузка с кэшем; при недоступности dataDir/файлов — системный дефолт.
   */
  private _getProtectedPaths(): ProtectedPathsPolicy | null {
    if (this._protectedPathsLoaded) return this._protectedPaths;
    this._protectedPathsLoaded = true;
    try {
      this._protectedPaths = loadProtectedPaths({
        overridePath: join(this._dataDir, 'security', 'protected-paths.json'),
        dataDir: this._dataDir,
      });
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
    this._hooks = options.hooks ?? null;
    this._contextBuilder = options.contextBuilder;
    this._providerLoader = options.providerLoader;
    this._optimizer = options.contextOptimizer ?? null;
    this._modelPriceLoader = options.modelPriceLoader ?? null;
    this._analytics = options.analytics ?? null;
    this._toolRegistry = options.toolRegistry ?? null;
    this._agentRegistry = options.agentRegistry ?? null;
    this._mcpManager = options.mcpManager ?? null;
    this._routerConfig = options.routerConfig ?? null;
    this._decisionConfig = options.decisionConfig ?? null;
    this._contextConfig = options.contextConfig ?? null;
    this._projectStore = options.projectStore ?? null;
    this._profilesStore = options.profilesStore ?? null;
    // ADR-076 §T6: хранилище SSH-ключей для git-тулов. Явный порт (продакшн)
    // приоритетнее; иначе — из файлового контекста хранения по `dataDir`
    // (прямое конструирование/тесты).
    // TODO(ADR-096): убрать фоллбэк, сделать порт обязательным.
    this._sshKeyStore = options.sshKeyStore
      ?? (options.dataDir
        ? createFileStorage({ dataDir: options.dataDir, env: process.env }).sshKeys
        : null);
    // ADR-070 §2.1: единая точка сборки системного промпта (идемпотентно).
    // ADR-090: реестр блоков промпта — **один** экземпляр
    // на инстанс (его же получает фасад плагинов); второй не создаём.
    this._composer = new SystemPromptComposer({
      contextBuilder: this._contextBuilder,
      contextConfig: this._contextConfig,
      projectStore: this._projectStore,
      ...(options.promptBlocks ? { promptBlocks: options.promptBlocks } : {}),
    });
    this._defaultWorkingDir = options.defaultWorkingDir ?? join(options.dataDir || '/var/synth/data', 'workspaces', 'default');
    this._workspacesRoot = options.workspacesRoot ?? join(options.dataDir || '/var/synth/data', 'workspaces');
    // ADR-077: порт исполнения — inline по умолчанию (прежнее поведение).
    // Собирается до git-сервиса: GitService исполняет git через тот же порт
    // (в remote-режиме — на исполнителе, ADR-077).
    this._executionPort = options.executionPort ?? new InlineExecutionPort();
    // ADR-075/ADR-076: git-сервис и режим/политика workspace для тулов управления
    // проектом. gitService по умолчанию — над тем же workspacesRoot и портом.
    this._gitService =
      options.gitService ?? new GitService(this._workspacesRoot, { execution: this._executionPort });
    this._workspaceManaged = options.workspaceManaged === true;
    this._getWorkspaceOutsideRootPolicy = options.getWorkspaceOutsideRootPolicy ?? null;
    this._permissionConfig = options.permissionConfig ?? emptyPermissionConfig();
    this._approvalManager = new PermissionApprovalManager(this._eventBus, {
      ...(options.approvalRegistry ? { registry: options.approvalRegistry } : {}),
    });
    this._defaultPlanMode = options.defaultPlanMode ?? 'auto';
    this._securityConfig = options.securityConfig
      ?? { promptInjection: { enabled: true, wrapContent: true, mode: 'flag' }, protectedPaths: { enabled: true }, secretKey: '' };
    this._dataDir = options.dataDir || '/var/synth/data';
    // ADR-115/ADR-116: в проде blob-порт приходит инъекцией
    // (`StorageContext.blobs`); фоллбэк для тестов — в `_getAttachmentHydrateDeps`.
    this._blobs = options.blobs ?? null;
    // ADR-115: модальности из конфига модели приоритетнее справочника.
    this._resolveModalities = options.resolveModelModalities ?? null;
    // ADR-115: live-конфиг вложений — проверяется на каждый ход в
    // `_processSetupDeps().hydrateAttachments` (без рестарта).
    if (options.attachmentsConfig) this._attachmentsConfig = options.attachmentsConfig;
    // ADR-115: каталог моделей для тула `list_models` (live — читается на вызов).
    if (options.listModels) this._listModels = options.listModels;
    this._gatewayPayloadLogPath = options.gatewayPayloadLogPath
      ?? join(options.dataDir || '/var/synth/data', 'audit', 'llm-payloads.jsonl');
    this._cachePolicy = options.cachePolicy ?? 'auto';
    // ADR-071 §2.3: глобальные политики встроенных/MCP-инструментов (независимы);
    // per-session override — в сессии.
    this._toolsPolicy = options.toolsPolicy ?? 'auto';
    this._mcpPolicy = options.mcpPolicy ?? 'auto';
    // ADR-071 §2.6: instance-wide отключение инструментов (admin) + калибровка ratio.
    this._toolsDisabled = options.toolsDisabled ?? { capabilities: [], tools: [] };
    this._skillsDisabled = options.skillsDisabled ?? { categories: [], groups: [], skills: [] };
    // ADR-070 §2.9.1: зависимости окружения (git/rg/sh) — fail-open по умолчанию.
    this._runtimeDeps = options.runtimeDeps ?? { ...ALL_RUNTIME_DEPS_AVAILABLE };
    // ADR-077 (шаг B2): в split-режиме MCP-серверы живут в исполнителе, а
    // удалённый порт несёт дескриптор пула. Оркестратор поднимает источник —
    // так managed-backend получает это без отдельной проводки в своей сборке
    // `McpManager` (идемпотентно: если источник уже подключён — no-op).
    if (this._mcpManager) {
      attachExecutorMcpFromDescriptor(this._mcpManager, this._executionPort.executorMcp);
    }
    this._tokenRatioLoader = options.tokenRatioLoader;
    this._onTokenRatioCalibrated = options.onTokenRatioCalibrated;
    this._skillRuntime = options.skillRuntime ?? null;
    this._commandRuntime = options.commandRuntime ?? null;
    this._getRequestSessionService = options.getRequestSessionService ?? null;
    this._getAutomationRuntime = options.getAutomationRuntime ?? null;
    this._isSchedulerActive = options.isSchedulerActive ?? null;
    this._isCancelRequested = options.isCancelRequested ?? null;
    // Этап 1 roadmap 0.13 (блок 3): сервис вопросов пользователю.
    this._questionService = options.questionService ?? null;
    // Этап 1 roadmap 0.13 (блок 4): реестр фоновых прогонов + тумблер инстанса.
    this._backgroundService = options.backgroundService ?? null;
    this._backgroundEnabled = options.backgroundEnabled ?? true;
    // PROP-097 (блок 5b): сервис фоновых шелл-процессов.
    this._processService = options.processService ?? null;
    // ADR-114: сервис worktree'ов (тулы `git_worktree_*`).
    this._worktreeService = options.worktreeService ?? null;
    // ADR-115: доставка user-сообщения (тул `attach_workspace_file`) — тот же
    // нотификатор, что у фоновых прогонов; порт ссылок на blob-объекты.
    this._deliverUserMessage = options.deliverUserMessage ?? null;
    this._blobRefs = options.blobRefs ?? null;
    this._streamPersistIntervalMs = options.streamPersistIntervalMs ?? 1000;

    // ADR-036: LLM Gateway — включается только при gatewayConfig.enabled=true.
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
    this._metrics = options.metrics ?? null;
    this._onMemoryContext = options.onMemoryContext;
    // ADR-106 Ф1: shadow-наблюдение Authority-слоя (решение прав не меняется).
    this._authorityShadow = options.authorityShadow;
    // ADR-106 Ф2: шов решения Authority-слоя (guard) — считает, журналит и
    // применяет решение (в enforced-режиме).
    this._authorityGate = options.authorityGate;
    // ADR-090: реестр фильтров LLM-вызовов. Экземпляр
    // может прийти извне (общий с фасадом плагинов); иначе создаём пустой —
    // бюджет времени из `plugins.llmFilterTimeoutMs`.
    this._llmFilters = options.llmFilters
      ?? new LlmFilterRegistry(
        options.llmFilterTimeoutMs !== undefined
          ? { defaultTimeoutMs: options.llmFilterTimeoutMs }
          : {},
      );
    // Долги Д3: бюджет символов блока плагина (`plugins.promptBlockMaxChars`)
    // обязан доходить до композера — иначе плагинный блок молча обрезался бы
    // по дефолту (4 000) при любом конфиге.
    this._promptBlockMaxChars = options.promptBlockMaxChars;

    // ADR-036: суммаризация (ContextOptimizer) создаёт провайдера напрямую —
    // передаём ему общую gateway-обвязку, чтобы эта точка тоже была защищена.
    // ADR-094: при включённых метриках обвязка ставится и при выключенном gateway
    // (учёт вызовов; guard в этом режиме no-op).
    this._optimizer?.setGatewayHooks(this._optimizerGatewayHooks());

    // DictionaryStore и ProviderPool создаём всегда (нужны микро-слою и роутеру).
    // Продакшн передаёт порт; фоллбэк — файловый контекст по `dataDir`.
    // TODO(ADR-096): убрать фоллбэк, сделать порт обязательным.
    const dictionaryStore = options.dictionaryStore
      ?? createFileStorage({ dataDir: options.dataDir || '/var/synth/data' }).dictionaries;
    this._dictionaryStore = dictionaryStore;
    // ADR-069 Фаза 1: резолвер проектных инструкций (merged chain AGENTS.md).
    // Threat-scan использует тот же DictionaryStore, что и tool-контент (ADR-036).
    this._instructionsConfig = options.instructionsConfig ?? null;
    this._instructionsResolver =
      this._instructionsConfig?.enabled
        ? new ProjectInstructionsResolver({
            config: this._instructionsConfig,
            dictionaryStore: this._dictionaryStore,
            dataDir: options.dataDir,
            trustedProjectDirs: options.instructionsTrustedProjectDirs,
            // ADR-069 R3: workspace внутри workspacesRoot доверяется автоматически.
            workspacesRoot: this._workspacesRoot,
            // ADR-077: `git rev-parse` (корень merged chain) — через тот же
            // порт исполнения, что и тулы; иначе в split-режиме поиск корня
            // репозитория шёл бы в control plane, а не в исполнителя.
            execution: this._executionPort,
          })
        : null;
    // ADR-069 Фаза 2b: lazy-загрузчик подкаталогов (те же словарь/политики, что
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
            // ADR-069 R1: общий trust-гейт с system-chain (project-trust + workspacesRoot).
            trustedProjectDirs: options.instructionsTrustedProjectDirs,
            workspacesRoot: this._workspacesRoot,
          })
        : null;
    // Фабрика обёртки для пула: у пула нет сессии, поэтому оборачиваем с пустой
    // картой обфускации (защита от утечки секретов работает, карта не персистится).
    const pool = new ProviderPool(
      options.providerLoader,
      gatewayConfig ?? undefined,
      gatewayConfig || this._metrics ? this._poolGatewayFactory(gatewayConfig ?? DISABLED_GATEWAY_CONFIG) : undefined,
      this._decisionGatewayFactory(),
    );
    this._providerPool = pool;

    // ADR-035: Micro-first pipeline — создаём всегда, не зависит от роутера
    const microClassifier = new TaskClassifier(dictionaryStore);
    const microModels: MicroModel[] = [
      new RulesModel(microClassifier),
      new EmbeddingModel(pool),
      // ADR-084: decision-модель пытается перед локальной LLM; `micro_llm`
      // остаётся фоллбеком. Конфиг читается геттером — runtime-обновление
      // возможно без пересоздания модели (setDecisionConfig).
      new DecisionModel(pool, () => this._decisionConfig ?? undefined, this._analytics ?? undefined),
      new MicroLlmModel(pool),
    ];
    this._microPipeline = new MicroPipeline(microClassifier, microModels);

    // ADR-034: Router — только если включён в конфиге
    if (options.routerConfig && options.routerConfig.enabled) {
      const classifier = new ContentClassifier(dictionaryStore);
      const qualityChecker = new QualityChecker();
      // ADR-084 × ADR-034: decision-классификатор категории — срабатывает только
      // когда keyword-классификатор неуверен и нет `routingCategory`. Конфиг
      // читается геттером — gated по `enabled` самим классификатором.
      const decisionClassifier = new DecisionContentClassifier(
        pool,
        () => this._decisionConfig ?? undefined,
        this._analytics ?? undefined,
      );
      this._router = new ModelRouter(classifier, pool, qualityChecker, options.routerConfig, decisionClassifier);
    } else {
      this._router = null;
    }
  }

  /**
   * ADR-036/ADR-094: gateway-обвязка суммаризации. Задаётся при включённом
   * gateway или при наличии реестра метрик (тогда — disabled-конфиг: guard
   * no-op, но вызов учитывается).
   */
  private _optimizerGatewayHooks(): ContextOptimizerGatewayHooks | null {
    if (!this._gatewayConfig && !this._metrics) return null;
    const config = this._gatewayConfig ?? DISABLED_GATEWAY_CONFIG;
    const audit = this._gatewayAudit
      ?? new AuditLogger(join(this._dataDir, 'audit', 'llm-gateway.jsonl'));
    const rateLimiter = this._gatewayRateLimiter
      ?? new RateLimiter(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    const obfMapStore = this._obfMapStore ?? new ObfuscationMapStore(this._sessionManager);
    return {
      config,
      audit,
      rateLimiter,
      obfMapStore,
      // ADR-090: суммаризация — тоже LLM-вызов, фильтры
      // фазы `pre_request` видят и её (порядок — тот же gateway-контур).
      filters: this._llmFilters,
      ...(this._metrics ? { metrics: this._metrics } : {}),
    };
  }

  /**
   * ADR-036: фабрика gateway-обёртки для ProviderPool — единая точка (конструктор
   * и live-переключение). У пула нет сессии, поэтому карта обфускации пустая:
   * защита от утечки секретов работает, карта не персистится.
   *
   * ADR-090: тот же реестр фильтров — так embedding-фаза
   * видит эмбеддинги микро-слоя (`router/micro/models/embedding-model.ts` берёт
   * провайдера из пула, а пул оборачивает его в `GatewayProvider`).
   */
  private _poolGatewayFactory(gatewayConfig: LLMGatewayConfig = this._gatewayConfig ?? DISABLED_GATEWAY_CONFIG): (inner: BaseProvider) => BaseProvider {
    return (inner) => new GatewayProvider(inner, gatewayConfig, {
      getMap: async () => ({}),
      saveMap: async () => {},
      getAudit: () => this._gatewayAudit!,
      getRateLimiter: () => this._gatewayRateLimiter!,
      payloadLogPath: this._gatewayPayloadLogPath,
      sessionId: '',
      userId: '',
      metrics: this._metrics ?? undefined,
      filters: this._llmFilters,
    });
  }

  /**
   * ADR-084: фабрика обвязки decision-провайдеров — оборачиваем **всегда**
   * (инвариант №3), в отличие от chat. Если LLM Gateway выключен, берём
   * безопасный дефолт: guard no-op, безлимитный rate limiter и audit-логгер
   * по стандартному пути (обёртка не падает и не требует `gateway.enabled`).
   */
  private _decisionGatewayFactory(): (inner: BaseProvider) => BaseProvider {
    const config = this._gatewayConfig ?? DEFAULT_DECISION_GATEWAY_CONFIG;
    const audit = this._gatewayAudit
      ?? new AuditLogger(join(this._dataDir, 'audit', 'llm-gateway.jsonl'));
    const rateLimiter = this._gatewayRateLimiter
      ?? new RateLimiter(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    const patternStore = this._gatewayPatternStore;
    return (inner) => new GatewayProvider(inner, config, {
      getMap: async () => ({}),
      saveMap: async () => {},
      getAudit: () => audit,
      getRateLimiter: () => rateLimiter,
      getPatterns: patternStore ? () => patternStore.getPatterns() : undefined,
      payloadLogPath: this._gatewayPayloadLogPath,
      sessionId: '',
      userId: '',
      metrics: this._metrics ?? undefined,
      filters: this._llmFilters,
    });
  }

  /**
   * ADR-036: live-переключение LLM Gateway (runtime-настройка из UI).
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

    // ADR-036: суммаризация (ContextOptimizer) — обновляем gateway-обвязку.
    this._optimizer?.setGatewayHooks(this._optimizerGatewayHooks());

    // ADR-036: пул кешировал провайдеров без новой обёртки — сбрасываем кеш
    // и обновляем фабрику (по образцу конструктора, с пустой картой обфускации).
    this._providerPool?.setGateway(
      gatewayConfig,
      gatewayConfig || this._metrics
        ? this._poolGatewayFactory(gatewayConfig ?? DISABLED_GATEWAY_CONFIG)
        : null,
    );
    // ADR-084: decision-обвязка обновляется всегда (guard активен и при выключенном gateway).
    this._providerPool?.setDecisionGatewayFactory(this._decisionGatewayFactory());
  }

  /** ADR-036: включён ли LLM Gateway (runtime-тумблер / конфиг). */
  isGatewayEnabled(): boolean {
    return !!this._gatewayConfig;
  }

  /**
   * ADR-090: реестр фильтров LLM-вызовов инстанса.
   *
   * Тот же экземпляр, что видят все gateway-точки (ход сессии, пул провайдеров,
   * decision, суммаризация). Фасад плагинов регистрирует в нём фильтры при
   * активации и снимает при деактивации — реестр **мутабельный**, поэтому
   * пересборка провайдеров не нужна.
   */
  getLlmFilters(): LlmFilterRegistry {
    return this._llmFilters;
  }

  /**
   * ADR-090 (долги Д3): живое применение `plugins.promptBlockMaxChars`.
   *
   * `undefined` — вернуться к дефолту композера (`DEFAULT_PROMPT_BLOCK_MAX_CHARS`).
   * Действует со следующего хода: бюджет читается при сборке промпта.
   */
  setPromptBlockMaxChars(maxChars: number | undefined): void {
    this._promptBlockMaxChars = maxChars;
  }

  /**
   * ADR-090 (долги Д3): живое применение бюджета фильтров
   * (`plugins.llmFilterTimeoutMs`). Действует на **последующие** регистрации
   * фильтров: у уже зарегистрированных бюджет зафиксирован при регистрации
   * (политика плагина не переписывается на лету).
   */
  setLlmFilterTimeoutMs(timeoutMs: number): void {
    this._llmFilters.setDefaultTimeoutMs(timeoutMs);
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
   * ADR-029: live-применение глобального таймаута подтверждения (runtime-настройка
   * из UI, раздел «Безопасность»). Обновляет дефолтный permission-конфиг, который
   * наследуют сессии без собственного пер-сессионного permission-конфига.
   */
  setDefaultPermissionTimeout(askTimeoutMs: number): void {
    this._permissionConfig = { ...this._permissionConfig, askTimeoutMs };
  }

  /**
   * ADR-071 §2.3: live-применение глобальной политики включения **встроенных**
   * инструментов (runtime-настройка из админки). Per-session override в сессии
   * приоритетнее.
   */
  setToolsPolicy(policy: ToolsPolicy): void {
    this._toolsPolicy = policy;
  }

  /**
   * ADR-071 §2.3: live-применение глобальной политики включения **MCP**-инструментов
   * (runtime-настройка из админки). Независима от `setToolsPolicy`; per-session
   * override в сессии приоритетнее.
   */
  setMcpPolicy(policy: ToolsPolicy): void {
    this._mcpPolicy = policy;
  }

  /**
   * ADR-071 §2.6: live-применение instance-wide отключения инструментов
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
   * ADR-046 §4.5: live-применение системного hard-gate скиллов (runtime-настройка).
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
   * ADR-070 §2.9.1: live-применение доступности внешних программ окружения
   * (git/rg/sh). Вызывается один раз при старте (детекция) или при обновлении;
   * не задано — fail-open (`ALL_RUNTIME_DEPS_AVAILABLE`).
   */
  setRuntimeDeps(deps: RuntimeDeps): void {
    this._runtimeDeps = { ...deps };
  }

  /**
   * ADR-084: live-применение конфига decision-слоя (микро-каскад). Модель читает
   * конфиг геттером, поэтому достаточно обновить поле — пересоздание не нужно.
   */
  setDecisionConfig(config: DecisionConfig | null): void {
    this._decisionConfig = config;
  }

  /**
   * ADR-084: decision-провайдер по имени из пула (`ProviderPool.getDecisionProvider`
   * — всегда обёрнут в `GatewayProvider`). Нужен decision-маршрутизации внешних
   * событий (ADR-089): провайдеры не дёргаются напрямую, инвариант №3 сохранён.
   */
  getDecisionProvider(providerName: string, modelName: string): BaseProvider | null {
    return this._providerPool?.getDecisionProvider(providerName, modelName) ?? null;
  }

  /**
   * ADR-101: сборщик системного промпта (ADR-070) — **тот же инстанс**, что у
   * сессий. Движок пайплайнов использует его для agent-шага: шаг ≠ сессия
   * (ADR-101 §1), но промпт собирается той же подсистемой (иначе разойдутся
   * блоки, политики и кэш-маркеры).
   */
  getComposer(): SystemPromptComposer {
    return this._composer;
  }

  /**
   * ADR-101/ADR-069: резолвер проектных инструкций — тот же инстанс, что у
   * сессий (политика trust/dedup/лимиты — общие). `null` — инструкции
   * инстанса выключены.
   */
  getInstructionsResolver(): ProjectInstructionsResolver | null {
    return this._instructionsResolver;
  }

  /**
   * ADR-036/ADR-101: обернуть провайдера в `GatewayProvider` — общая точка
   * обвязки для движков вне сессии (шаг пайплайна — не сессия, поэтому карта
   * обфускации пустая, как у пула провайдеров). Инвариант «любой LLM-вызов
   * через gateway» сохраняется.
   */
  wrapProviderWithGateway(provider: BaseProvider): BaseProvider {
    return this._poolGatewayFactory()(provider);
  }

  /**
   * ADR-071 §2.6: тул жёстко отключён администратором (`tools.disabled`) — по
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
   * ADR-071 §2.6: сохранённый chars-per-token модели (без дефолта).
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
   * ADR-071 §2.6: chars-per-token модели. Нет калибровки — дефолт 4.
   */
  private async _resolveTokenRatio(model: string | undefined): Promise<number> {
    return (await this._loadTokenRatio(model)) ?? DEFAULT_CHARS_PER_TOKEN;
  }

  /**
   * ADR-071 §2.6: калибровка chars-per-token после успешного ответа
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
   * ADR-071 §2.3/§2.6: единый предикат тулов для `selectForSession`.
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
   * ADR-071 §2.3/§2.6: единый резолвинг политик и выборки инструментов сессии.
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
    /** ADR-075: задан ли рабочий каталог проекта (гейт `workspace` для file/shell/git). */
    workspaceReady: boolean;
  }): {
    toolsPolicy: Exclude<ToolsPolicy, 'auto'>;
    mcpPolicy: Exclude<ToolsPolicy, 'auto'>;
    /** Ленивая выборка — вызывается, когда реестр уже содержит MCP-тулы сессии. */
    select: () => ReturnType<ToolRegistry['selectForSession']>;
  } {
    const {
      session, agentDef, effectiveAgentRole, activeMcpServers,
      providerType, sessionMode, planMode, planApproved, workspaceReady,
    } = args;
    const toolsPolicy = this._resolveToolsPolicy(session, providerType);
    const mcpPolicy = this._resolveMcpPolicy(session, providerType);
    // ADR-071 §2.3: встроенные и MCP фильтруются независимо — своя политика на слой.
    const availabilityPredicate = (toolsPolicy === 'available' || mcpPolicy === 'available')
      ? this._availabilityPredicate(session, sessionMode, planMode, planApproved, agentDef, workspaceReady)
      : undefined;
    // ADR-071 §2.6: admin-disabled исключаются всегда, независимо от политики.
    // ADR-090: плагинные инструменты — инстанс-локальный слой;
    // политика у них та же, что у встроенных (`tools.policy`), отдельного
    // `plugins.policy` нет. Admin-отключение (`tools.disabled`) действует всегда.
    const toolPredicates = {
      builtin: this._toolPredicate(toolsPolicy === 'available' ? availabilityPredicate : undefined),
      plugin: this._toolPredicate(toolsPolicy === 'available' ? availabilityPredicate : undefined),
      mcp: this._toolPredicate(mcpPolicy === 'available' ? availabilityPredicate : undefined),
    };
    const select = (): ReturnType<ToolRegistry['selectForSession']> =>
      (this._toolRegistry && agentDef && effectiveAgentRole
        ? this._toolRegistry.selectForSession(activeMcpServers, toolPredicates)
        : { builtin: [], plugin: [], mcp: [] });
    return { toolsPolicy, mcpPolicy, select };
  }

  /**
   * ADR-107: нужна ли агенту инструкция по памяти в системном промпте.
   *
   * Доступность — не «вообще плагин установлен», а **в этой сессии**:
   * - память проекта не выключена (`project.memory.enabled !== false`);
   * - у агента есть capability `memory` (иначе тулы ему не предназначены);
   * - в реестре есть хотя бы один не отключённый админом тул плагина памяти.
   */
  private _memoryPromptAvailable(
    project: Project | null | undefined,
    agentDef: AgentDefinition | undefined,
  ): boolean {
    return isMemoryPromptAvailable({
      project,
      agentCapabilities: agentDef?.capabilities,
      tools: this._toolRegistry?.listPlugin(MEMORY_PLUGIN_NAME) ?? [],
      isAdminDisabled: (tool) => this._isAdminDisabled(tool),
    });
  }

  /**
   * ADR-070 §2.1/§2.5: единая сборка `ComposerContext` для `compose`/`manifest`.
   * `toolSelection` (для манифеста `tools`/`plugin.tools`/`mcp.tools`)
   * передаётся только диагностикой; `project` — уже загруженный проект
   * (ADR-071 §2.4).
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
    /** ADR-046 §5: каталог скиллов (stable/volatile-блоки). */
    skillsCatalog?: ComposerSkillsCatalog;
    /** ADR-069 §2.1/§3: проектные инструкции (merged chain AGENTS.md). */
    instructions?: ComposerInstructions;
    /** ADR-051: в сессии активно расписание — добавляет статическое описание Scheduler. */
    schedulerActive?: boolean;
    /** Интервью уместно в этом ходе (первое сообщение сессии от пользователя). */
    interviewEligible?: boolean;
    /** ADR-051: текущий ход инициирован планировщиком. */
    schedulerCurrentTurn?: boolean;
    /** ADR-090: «вопрос хода» (текст сообщения пользователя). */
    query?: string;
    /** ADR-090: идентификатор хода (`streamId`). */
    turnId?: string;
  }): ComposerContext {
    const {
      session, agentDef, effectiveAgentRole, workingDir, language, summaryContent,
      toolsPolicy, mcpPolicy, tokenRatio, mcpServers, project, toolSelection, debugCollector,
      skillsCatalog, instructions, schedulerActive, interviewEligible, schedulerCurrentTurn,
      query, turnId,
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
      interviewEligible,
      memoryAvailable: this._memoryPromptAvailable(project, agentDef),
      stickyNotes: session.stickyNotes,
      summaryContent: summaryContent || undefined,
      tools: toolSelection
        ? toolSelection.builtin as unknown as Array<Record<string, unknown>>
        : undefined,
      // ADR-090: слой плагинных тулов (volatile, вне stable-префикса) — та же
      // выборка, что уходит в запрос (`process-setup`: builtin → plugin → mcp).
      // Мок/внешняя реализация реестра может не отдавать слой `plugin`.
      pluginTools: toolSelection && toolSelection.plugin && toolSelection.plugin.length > 0
        ? toolSelection.plugin as unknown as Array<Record<string, unknown>>
        : undefined,
      mcpTools: toolSelection
        ? toolSelection.mcp as unknown as Array<Record<string, unknown>>
        : undefined,
      toolsPolicy,
      mcpPolicy,
      // Долги Д3: бюджет символов плагинного блока (иначе — дефолт композера).
      ...(this._promptBlockMaxChars !== undefined
        ? { promptBlockMaxChars: this._promptBlockMaxChars }
        : {}),
      adminDisabled: this._toolsDisabled,
      envDeps: this._runtimeDeps,
      tokenRatio,
      mcpServers,
      project,
      debugCollector,
      skillsCatalog,
      instructions,
      schedulerActive,
      schedulerCurrentTurn,
      ...(query ? { query } : {}),
      ...(turnId ? { turnId } : {}),
    };
  }

  /**
   * ADR-051: текущий ход инициирован планировщиком. При явном `message` — по его
   * метаданным (`metadata.scheduler === true`); без него (диагностика
   * `getPromptInfo`) — по последнему «разговорному» сообщению (user|assistant).
   */
  private _schedulerCurrentTurn(session: Session, message?: Message): boolean {
    if (message) return message.metadata?.scheduler === true;
    const last = this._lastConversationalMessage(session);
    return last?.metadata?.scheduler === true;
  }

  /**
   * PROP-083: доступность онбординг-тула `profile_update` текущему агенту — гейт
   * инжекта блока `[INTERVIEW]`. Источник доступности единый: реестр (`get`) +
   * admin-отключение (`_isAdminDisabled`) + `_availabilityPredicate`
   * (`computeToolAvailability`: роль/mode/dependency/workspace), без дублирования
   * логики. Нет реестра/тула — fail-closed (интервью не инжектим).
   */
  private _profileUpdateAvailable(
    session: Session,
    agentDef: AgentDefinition | undefined,
    sessionMode: SessionMode,
    planMode: PlanMode,
    planApproved: boolean,
    workspaceReady: boolean,
  ): boolean {
    const tool = this._toolRegistry?.get('profile_update');
    if (!tool) return false;
    if (this._isAdminDisabled(tool)) return false;
    return this._availabilityPredicate(
      session, sessionMode, planMode, planApproved, agentDef, workspaceReady,
    )(tool);
  }

  /**
   * Интервью уместно, только если это первое сообщение сессии И от пользователя
   * (не Scheduler и не системное) И текущий агент реально может сохранить ответы
   * (`profile_update` доступен — capability `user`, тул не admin-disabled).
   * При явном `message` (реальный ход) — оно само и есть проверяемое: среди
   * «разговорных» (user|assistant) не должно быть других, кроме него. Без
   * `message` (диагностика `getPromptInfo`) — «разговорных» ровно одно и это
   * user-сообщение от пользователя.
   */
  private _interviewEligible(
    session: Session,
    message: Message | undefined,
    toolAccess: {
      agentDef: AgentDefinition | undefined;
      sessionMode: SessionMode;
      planMode: PlanMode;
      planApproved: boolean;
      workspaceReady: boolean;
    },
  ): boolean {
    if (
      !this._profileUpdateAvailable(
        session,
        toolAccess.agentDef,
        toolAccess.sessionMode,
        toolAccess.planMode,
        toolAccess.planApproved,
        toolAccess.workspaceReady,
      )
    ) {
      return false;
    }
    const conversational = session.messages.filter(
      (m) => m.role === MessageRole.USER || m.role === MessageRole.ASSISTANT,
    );
    if (message) {
      if (!this._isUserMessage(message)) return false;
      return conversational.every((m) => m.id === message.id);
    }
    return conversational.length === 1 && this._isUserMessage(conversational[0]!);
  }

  /** Сообщение «от пользователя»: role user, не Scheduler и без метки планировщика. */
  private _isUserMessage(message: Message): boolean {
    return message.role === MessageRole.USER
      && message.metadata?.scheduler !== true
      && message.author !== 'Scheduler';
  }

  /** Последнее «разговорное» сообщение (user|assistant) в истории сессии. */
  private _lastConversationalMessage(session: Session): Message | undefined {
    for (let i = session.messages.length - 1; i >= 0; i--) {
      const msg = session.messages[i]!;
      if (msg.role === MessageRole.USER || msg.role === MessageRole.ASSISTANT) return msg;
    }
    return undefined;
  }

  /**
   * ADR-051: активность расписания в сессии — есть ли в истории сообщение
   * планировщика (`metadata.scheduler === true`) или (если задан резолвер)
   * включённое расписание с целью-сессией. Первое — дешёвая проверка по уже
   * загруженной истории; второе — late-bound `ScheduleStore.hasEnabledTargetFor`.
   * Ошибка резолвера не роняет ход — трактуется как «неактивно».
   */
  private async _resolveSchedulerActive(session: Session): Promise<boolean> {
    if (session.messages.some((message) => message.metadata?.scheduler === true)) {
      return true;
    }
    if (this._isSchedulerActive) {
      try {
        return await this._isSchedulerActive(session.id);
      } catch {
        return false;
      }
    }
    return false;
  }

  /**
   * ADR-069 §5.2: политика threat-scan проектных инструкций — та же, что у
   * tool-контента (ADR-036), с учётом runtime-тумблера безопасности.
   */
  private _instructionsInjectionPolicy(): { enabled: boolean; mode: InjectionPolicy } {
    const injection = this._securityConfig.promptInjection;
    return {
      enabled: injection?.enabled ?? true,
      mode: (injection?.mode ?? 'flag') as InjectionPolicy,
    };
  }

  /**
   * ADR-069 §2.1/§7: резолвит проектные инструкции для сессии.
   *
   * - только при `project.workspace` (ADR-040: сессия без проекта инструкции не грузит);
   * - `session.settings.systemPrompt` override → инструкции не добавляются (как
   *   каталог скиллов ADR-046);
   * - кап — от окна модели (ADR-069 §5.1), окно резолвится как в провайдере;
   * - ADR-069 §3.5/R5: при заданном `turnId` результат мемоизируется на время
   *   хода (последний ход на сессию; ключ включает workspace/модель/язык/
   *   injection/projectId) — повторные вызовы внутри хода не дёргают резолвер.
   */
  private async _resolveProjectInstructions(args: {
    session: Session;
    project: Project | null;
    workingDir: string;
    model?: string;
    language: string;
    signal?: AbortSignal;
    /** ADR-069 §3.5/R5: id хода для мемоизации внутри хода. */
    turnId?: string;
  }): Promise<ResolvedProjectInstructions | undefined> {
    const resolver = this._instructionsResolver;
    if (!resolver) return undefined;
    // ADR-040: без project.workspace проектный контекст недоступен.
    if (!args.project?.workspace) return undefined;
    // ADR-046 §5/ADR-069 §9.2: override заменяет system prompt целиком.
    if (args.session.settings.systemPrompt?.trim()) return undefined;

    const model = args.model || args.session.settings.model || '';
    const input = {
      workingDir: args.workingDir,
      contextWindow: this._resolveModelContextWindow(model),
      model,
      language: args.language,
      projectId: args.session.projectId ?? args.project.id,
      injection: this._instructionsInjectionPolicy(),
      signal: args.signal,
    };

    if (!args.turnId) return this._resolveProjectInstructionsUncached(resolver, input);

    const memoKey = this._instructionsMemoKey(input);
    const memo = this._instructionsTurnMemo.get(args.session.id);
    if (memo && memo.turnId === args.turnId && memo.key === memoKey) return memo.result;

    const result = await this._resolveProjectInstructionsUncached(resolver, input);
    if (
      this._instructionsTurnMemo.size >= MAX_INSTRUCTIONS_TURN_MEMO &&
      !this._instructionsTurnMemo.has(args.session.id)
    ) {
      const oldest = this._instructionsTurnMemo.keys().next().value;
      if (oldest !== undefined) this._instructionsTurnMemo.delete(oldest);
    }
    this._instructionsTurnMemo.set(args.session.id, { turnId: args.turnId, key: memoKey, result });
    return result;
  }

  /** Ключ мемоизации хода — все входы, влияющие на результат. */
  private _instructionsMemoKey(input: {
    workingDir: string;
    contextWindow: number;
    model: string;
    language: string;
    projectId?: string;
    injection: { enabled: boolean; mode: InjectionPolicy };
  }): string {
    return instructionsMemoKeyFn(input);
  }

  /** Резолв без per-turn мемоизации (кэш уровня резолвера при этом работает). */
  private async _resolveProjectInstructionsUncached(
    resolver: ProjectInstructionsResolver,
    input: {
      workingDir: string;
      contextWindow: number;
      language: string;
      projectId?: string;
      injection: { enabled: boolean; mode: InjectionPolicy };
      signal?: AbortSignal;
    },
  ): Promise<ResolvedProjectInstructions | undefined> {
    let result;
    try {
      result = await resolver.resolve({
        workspace: input.workingDir,
        contextWindow: input.contextWindow,
        language: input.language,
        projectId: input.projectId,
        signal: input.signal,
        injection: input.injection,
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
   * ADR-046 §7: раннее разрешение `/`-команды до micro-first/LLM.
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
    /** ADR-046 §7.4: evaluator для inline shell — тот же, что в tool-loop. */
    permissionEvaluator: PermissionEvaluator;
    sessionMode: SessionMode;
    planMode: PlanMode;
    planApproved: boolean;
    attempt?: number;
    /**
     * ADR-106 Ф4 (шаг B2): контекст хода (потолок + оси, посчитанные один раз
     * на ход) — для inline shell (тот же permission-слой, тот же потолок).
     */
    authorityTurn?: AuthorityTurnContext;
  }): Promise<ProcessMessageResult | null> {
    if (!this._commandRuntime) return null;
    const { session, message, signal, publishChunk, debugCollector, streamId, effectiveAgentRole, workingDir, permissionEvaluator, sessionMode, planMode, planApproved, attempt, authorityTurn } = args;
    const input = (message.content ?? '').trim();
    if (!input.startsWith('/')) return null;

    const agentDef = effectiveAgentRole ? this._agentRegistry?.get(effectiveAgentRole) : undefined;
    const permissionConfig = session.settings.permission ?? this._permissionConfig;

    // ADR-046 §7.4: inline shell `` !`cmd` `` исполняется только через
    // PermissionEvaluator (ADR-029) — как обычный `execute_shell`. allow —
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
        // ADR-106 Ф1: контекст хода для shadow-наблюдения (на решение не влияет).
        authorityContext: {
          sessionId: session.id,
          // ADR-106 Ф4: принципал хода — зафиксирован при приёме ввода
          // (на сообщении); для старых сообщений — владелец сессии.
          principal: resolveTurnPrincipal(session, args.message),
          ...(effectiveAgentRole ? { agentId: effectiveAgentRole } : {}),
          turnId: streamId,
          // ADR-106 Ф4 (шаг B2): потолок хода — один раз на ход.
          ...(authorityTurn ? { turnContext: authorityTurn } : {}),
        },
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
      const exec = await runInlineShell({ command, workingDir, abortSignal: signal, execution: this._executionPort });
      this._eventBus.publish(session.id, 'command.inline_shell', {
        session_id: session.id,
        command,
        exitCode: exec.exitCode,
        truncated: Buffer.byteLength(exec.output, 'utf-8') > TEMPLATE_SHELL_MAX_BYTES,
        ...(exec.isError ? { failed: true } : {}),
      });
      // fs.changed: inline shell мог изменить файлы workspace — обновляем UI.
      if (!exec.isError) {
        this._publishFsChange(session, 'execute_shell', { isError: false }, workingDir, { command });
      }
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
   * ADR-046 §7.1: завершение локального ответа (builtin/команда/micro-first) теми
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
      /** ADR-046 §7.1: index/id сохранённого assistant-сообщения — UI не плодит копии. */
      messageIndex?: number;
      messageId?: string;
    },
  ): void {
    publishLocalCompletionFn(publishChunk, streamId, content, opts);
  }

  /** Зависимости локального ответа команды (ADR-095 шаг 6a). */
  private _finishLocalCommandDeps(): FinishLocalCommandDeps {
    return {
      sessionManager: this._sessionManager,
      eventBus: this._eventBus,
      publishLocalCompletion: publishLocalCompletionFn,
    };
  }

  /** ADR-095 (шаг 6b-1): зависимости вынесенного раннего пролога `_processMessage`. */
  private _processEarlyDeps(): ProcessEarlyDeps {
    return {
      handleSummarization: (session, message, signal, publishChunk, debugCollector, streamId, attempt) =>
        this._handleSummarization(session, message, signal, publishChunk, debugCollector, streamId, attempt),
      handleDebugSystemMessage: (session, message, signal, publishChunk, debugCollector, streamId, reasoningLevel, attempt) =>
        this._handleDebugSystemMessage(session, message, signal, publishChunk, debugCollector, streamId, reasoningLevel, attempt),
      handleCommand: (args) => this._handleCommand(args),
      microPipeline: this._microPipeline,
      decisionConfig: this._decisionConfig,
      publishLocalCompletion: (publishChunk, streamId, content, opts) =>
        this._publishLocalCompletion(publishChunk, streamId, content, opts),
      sessionManager: this._sessionManager,
    };
  }

  /**
   * ADR-115: порты чтения вложений. Порт приходит инъекцией из контекста
   * хранения (`StorageContext.blobs`, ADR-096/ADR-116); фоллбэк по `dataDir` —
   * только для тестов и прямого конструирования без порта.
   */
  private _getAttachmentHydrateDeps(): HydrateDeps {
    if (!this._attachmentHydrateDeps) {
      this._attachmentHydrateDeps = createHydrateDeps(
        this._blobs
          ?? createFileStorage({ dataDir: this._dataDir, env: process.env }).blobs,
      );
    }
    return this._attachmentHydrateDeps;
  }

  /**
   * ADR-115: сервис вложений для тула `attach_workspace_file`.
   *
   * Тот же blob-порт, что у гидратации (`StorageContext.blobs`, ADR-096/ADR-116);
   * конфиг — live-резолвер `attachments.*` (runtime-настройки применяются без
   * рестарта). Фоллбэк по `dataDir` — только для тестов/прямого конструирования.
   */
  private _getAttachmentService(): AttachmentService {
    if (!this._attachmentService) {
      this._attachmentService = new AttachmentService({
        blobs: this._blobs
          ?? createFileStorage({ dataDir: this._dataDir, env: process.env }).blobs,
        config: () => this._attachmentsConfig?.() ?? attachmentsConfigSchema.parse({}),
      });
    }
    return this._attachmentService;
  }

  /**
   * ADR-115: шаблон блока «вложения не доставлены» для LLM-сообщения
   * (`prompts/system/ATTACHMENTS_DROPPED.{lang}.md`). Файла нет / порт его не
   * отдаёт — пустая строка: гидратация возьмёт техническую строку (en).
   */
  private _attachmentsDroppedTemplate(language: string): string {
    return this._contextConfig?.getAttachmentsDroppedTemplate(language) ?? '';
  }

  /** ADR-095 (шаг 6b-1): зависимости вынесенной подготовки запроса `_processMessage`. */
  private _processSetupDeps(): ProcessSetupDeps {
    return {
      routeProvider: (session, message, reasoningLevel, debugCollector) =>
        this._routeProvider(session, message, reasoningLevel, debugCollector),
      handleLlmFailure: (sessionId, streamId, error, attempt, ctx) =>
        this._handleLlmFailure(sessionId, streamId, error, attempt, ctx),
      contextConfig: this._contextConfig,
      permissionConfig: this._permissionConfig,
      cachePolicy: this._cachePolicy,
      resolveMcpDecisions: (session, project) => this._resolveMcpDecisions(session, project),
      buildToolSelection: (args) => this._buildToolSelection(args),
      collectUnavailableTools: (
        session, sessionMode, planMode, planApproved, agentDef, mcpServers, include, workspaceReady,
      ) => this._collectUnavailableTools(
        session, sessionMode, planMode, planApproved, agentDef, mcpServers, include, workspaceReady,
      ),
      collectSkillsCatalog: (args) => this._collectSkillsCatalog(args),
      resolveProjectInstructions: (args) => this._resolveProjectInstructions(args),
      resolveSchedulerActive: (session) => this._resolveSchedulerActive(session),
      buildComposerContext: (args) => this._buildComposerContext(args),
      collectComposerMcpServers: (decisions) => this._collectComposerMcpServers(decisions),
      interviewEligible: (session, message, toolAccess) =>
        this._interviewEligible(session, message, toolAccess),
      schedulerCurrentTurn: (session, message) => this._schedulerCurrentTurn(session, message),
      composer: this._composer,
      optimizer: this._optimizer,
      mcpManager: this._mcpManager,
      toolRegistry: this._toolRegistry,
      lazyInstructions: this._lazyInstructions,
      eventBus: this._eventBus,
      sessionManager: this._sessionManager,
      loadTokenRatio: (model) => this._loadTokenRatio(model),
      registerCancelToken: (streamId, token) => {
        this._cancellationTokens.set(streamId, token);
      },
      // ADR-115: вложения — blob → base64 с фильтром модальностей модели хода.
      // Источник модальностей — только конфиг модели (каталог провайдера /
      // ручной override); справочника нет. Модальности неизвестны — фильтра
      // нет, вложение уходит провайдеру как есть (его ошибку увидит
      // пользователь — тихая потеря вложения недопустима).
      // Отброшенное вложение не теряется: копия кладётся в
      // `<workspace>/attachments/`, путь сообщается модели блоком
      // `[ATTACHMENTS NOT DELIVERED]` (шаблон — prompts/system, язык сессии).
      // Резервный путь в workspace — под runtime-настройкой
      // `attachments.workspaceFallback` (читается на каждый ход, live):
      // `false` — файл не сохраняем, в блоке остаётся только причина.
      hydrateAttachments: (messages, source, target) => {
        const workspaceFallback = this._attachmentsConfig?.().workspaceFallback !== false;
        return hydrateMessageAttachments(messages, source, this._getAttachmentHydrateDeps(), {
          modalities: this._resolveModalities?.(target.providerName, target.modelId),
          noticeTemplate: this._attachmentsDroppedTemplate(target.language),
          // Пустой `workingDir` (workspace не готов) — материализация вернёт null:
          // путь модели не сообщается.
          ...(workspaceFallback
            ? {
                materialize: (ref: DroppedAttachmentRef) => materializeAttachment({
                  read: (blobPath) => this._getAttachmentHydrateDeps().read(blobPath),
                  blobPath: ref.blobPath,
                  name: ref.name,
                  mime: ref.mime,
                  workingDir: target.workingDir,
                }),
              }
            : {}),
          log: (message) => warning('ATTACHMENTS', message),
        });
      },
      // ADR-107: телеметрия блоков памяти в промпте хода.
      ...(this._onMemoryContext ? { onMemoryContext: this._onMemoryContext } : {}),
    };
  }

  /** ADR-095 (шаг 6b-1): зависимости вынесенного эпилога `_processMessage`. */
  private _processFinalizeDeps(): ProcessFinalizeDeps {
    return {
      sessionManager: this._sessionManager,
      eventBus: this._eventBus,
      router: this._router,
      agentRegistry: this._agentRegistry,
      optimizer: this._optimizer,
      resolveMessageModel: (chunkModel, finalModel, provider, session) =>
        this._resolveMessageModel(chunkModel, finalModel, provider, session),
      joinAccumulatedTexts: (intermediateTexts, current) =>
        this._joinAccumulatedTexts(intermediateTexts, current),
      estimateUsage: (usage, promptChars, outputChars) =>
        this._estimateUsage(usage, promptChars, outputChars),
      computeMessageCost: (model, usage) => this._computeMessageCost(model, usage),
      saveAssistantMessage: this._saveAssistantMessage.bind(this),
      resolveAssistantStatus: (isCancelled, metadataExtra) =>
        this._resolveAssistantStatus(isCancelled, metadataExtra),
      getAssistantSecrets: (sessionId, content) => this._getAssistantSecrets(sessionId, content),
      calibrateTokenRatio: (model, promptChars, usage, currentRatio) =>
        this._calibrateTokenRatio(model, promptChars, usage, currentRatio),
      getProvider: (providerName, session, reasoningLevel) =>
        this._getProvider(providerName, session, reasoningLevel),
      unregister: (streamId) => {
        this._cancellationTokens.delete(streamId);
      },
    };
  }

  /**
   * Локальный ответ команды: user сообщение — `ephemeral`, ассистент — `ephemeral`.
   *
   * `command` (ADR-046 §7.1) — имя/аргументы системной (builtin) команды: уходят в
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
    return finishLocalCommandFn(
      session,
      userMessage,
      publishChunk,
      output,
      streamId,
      command,
      this._finishLocalCommandDeps(),
    );
  }

  /**
   * ADR-046 §5: каталог скиллов для промпта (аналог `_collectComposerMcpServers`).
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
   * ADR-046 §4.5: scope-гейты скиллов сессии (система/проект/сессия) — единый
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
   * ADR-071 §2.3: резолвит эффективную политику **встроенных** инструментов для
   * сессии. Приоритет: `session.settings.toolsPolicy` → глобальная
   * (`tools.policy`). `auto` разрешается по провайдеру запроса: локальные
   * (`ollama`) → `available`, облачные → `consistency`. Флага локальности у
   * провайдера/модели нет, поэтому признак — тип провайдера `ollama`
   * (см. ADR-071 §2.3, решение зафиксировано).
   */
  private _resolveToolsPolicy(
    session: Session,
    providerType?: string,
  ): Exclude<ToolsPolicy, 'auto'> {
    return this._resolvePolicy(session.settings.toolsPolicy ?? this._toolsPolicy, providerType);
  }

  /**
   * ADR-071 §2.3: резолвит эффективную политику **MCP**-инструментов для сессии.
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

  /** ADR-071 §2.3: общий резолв `auto` по типу провайдера для обеих политик. */
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
   * ADR-071 §2.3: тип провайдера сессии для резолва `auto` в read-only
   * диагностике (`getPromptInfo`), где нет объекта провайдера запроса.
   */
  private _sessionProviderType(session: Session): string | undefined {
    const name = session.settings.provider;
    if (!name) return undefined;
    return this._providerLoader(name)?.type;
  }

  /**
   * ADR-071 §2.3: предикат доступности тула для режима `available` — тот же
   * `computeToolAvailability`, что использует permission-слой (ADR-070 §2.9.1).
   * В запрос попадают только тулы с `available: true`.
   */
  private _availabilityPredicate(
    session: Session,
    sessionMode: SessionMode,
    planMode: PlanMode,
    planApproved: boolean,
    agentDef: AgentDefinition | undefined,
    workspaceReady: boolean,
  ): (tool: { name: string; capabilities: readonly string[] }) => boolean {
    const opts = {
      sessionMode,
      planMode,
      planApproved,
      mcpToolSettings: session.settings.mcpToolSettings,
      agentCapabilities: agentDef?.capabilities,
      runtimeDeps: this._runtimeDeps,
      workspaceReady,
    };
    return (tool) => computeToolAvailability(tool.name, tool.capabilities, opts).available;
  }

  /**
   * ADR-036: обфусцирует user-сообщение при сохранении в историю (до отправки в LLM).
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
      // ADR-036: аудит обфускации user-сообщения (секреты — только маской,
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
   * Рабочий каталог проекта (ADR-075): абсолютный путь `project.workspace`
   * (абсолютный — как есть; относительный — от `workspacesRoot`) с гарантированным
   * созданием каталога, либо `null`, если проекта/workspace нет. Отдельно от
   * `_resolveWorkingDir`, чтобы permission-слой мог отличить «workspace задан»
   * от fallback-каталога.
   */
  private async _resolveProjectWorkspace(session: Session, project?: Project | null): Promise<string | null> {
    let resolved: Project | null;
    if (project !== undefined) {
      resolved = project;
    } else {
      resolved = null;
      if (session.projectId && this._projectStore) {
        try {
          resolved = await this._projectStore.load(session.projectId);
        } catch {
          // проект не загрузился — workspace отсутствует
        }
      }
    }
    if (!resolved?.workspace) return null;
    // Абсолютный workspace — как есть (normalize); относительный —
    // резолвим относительно workspacesRoot (ADR-014).
    const dir = isAbsolute(resolved.workspace)
      ? normalize(resolved.workspace)
      : resolve(this._workspacesRoot, resolved.workspace);
    // ADR-075: каталог проектного workspace гарантированно создаётся к моменту
    // работы инструмента.
    await mkdir(dir, { recursive: true }).catch(() => {});
    return dir;
  }

  /**
   * ADR-114 §3.3: привязка сессии к worktree.
   *
   * Приоритет: собственная привязка сессии → привязка **родителя** (саб-агент
   * наследует рабочий каталог родителя). Наследование — **одноуровневое**:
   * читается ровно одна сессия родителя (`sessionStore`), без рекурсии глубже.
   *
   * Привязка **наследуется, а не копируется**: в дочерней сессии своё поле
   * `worktree` не появляется — ребёнок может получить собственную привязку
   * позже (тогда она и станет приоритетной).
   */
  private async _resolveSessionWorktree(session: Session): Promise<SessionWorktree | undefined> {
    if (session.worktree) return session.worktree;
    const parentId = session.parentId;
    if (!parentId) return undefined;
    try {
      const parent = await this._sessionManager.getSession(parentId);
      return parent?.worktree;
    } catch {
      // Родитель не прочитан — привязки нет (обычный путь резолва).
      return undefined;
    }
  }

  /**
   * ADR-114 §3.1–§3.2: рабочий каталог сессии.
   *
   * Приоритет: `session.worktree.directory` (привязка к worktree) →
   * `project.workspace` (ADR-075) → `defaultWorkingDir`.
   *
   * Каталог привязки отсутствует или не является каталогом — **fail-closed**:
   * бросается {@link WorktreeDirectoryMissingError} (i18n-ключ
   * `worktree.directory_missing`). Тихий фоллбек в `project.workspace`
   * запрещён (ADR-114 §3.2): он перенёс бы правки сессии в чужое дерево.
   *
   * `project` можно передать уже загруженным (ADR-071 §2.4) — тогда повторного
   * чтения `projectStore` не происходит; `undefined` — загрузить, `null` — проекта нет.
   */
  private async _resolveWorkingDir(session: Session, project?: Project | null): Promise<string> {
    const resolved = await this._resolveSessionWorkingDir(session, project);
    return resolved.workingDir;
  }

  /**
   * ADR-114 §3: рабочий каталог сессии **и** её привязка (одним чтением).
   *
   * Вызывающий, которому нужны оба значения (сборка `ToolContext`), берёт их
   * отсюда — иначе привязка родителя читалась бы дважды за ход.
   */
  private async _resolveSessionWorkingDir(
    session: Session,
    project?: Project | null,
  ): Promise<{ workingDir: string; worktree?: SessionWorktree }> {
    const binding = await this._resolveSessionWorktree(session);
    if (binding) {
      const directory = normalize(binding.directory);
      // Каталог привязки создаёт сервис worktrees — резолв только проверяет.
      const stats = await stat(directory).catch(() => null);
      if (!stats?.isDirectory()) {
        throw new WorktreeDirectoryMissingError(directory, binding.worktreeId);
      }
      return { workingDir: directory, worktree: binding };
    }
    const projectWorkspace = await this._resolveProjectWorkspace(session, project);
    if (projectWorkspace) return { workingDir: projectWorkspace };
    const dir = this._defaultWorkingDir;
    await mkdir(dir, { recursive: true }).catch(() => {});
    return { workingDir: dir };
  }

  /**
   * ADR-070 §2.9.1: собирает недоступные сейчас тулы реестра с причиной
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
     * ADR-071 §2.3: какие слои включать в подсказки. Слой с политикой
     * `available` в запросе уже сужен до доступных — подсказки о его
     * недоступных тулах не нужны.
     */
    include: { builtin: boolean; mcp: boolean } = { builtin: true, mcp: true },
    /**
     * ADR-075: задан ли рабочий каталог проекта. `false` — file/shell/git-тулы
     * помечаются причиной `workspace` в подсказках модели.
     */
    workspaceReady = true,
  ): UnavailableTool[] {
    if (!this._toolRegistry) return [];
    const unavailable: UnavailableTool[] = [];
    // ADR-071 §2.1: MCP-тулы вне активных серверов сессии не подсказываем —
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
      // ADR-071 §2.6: admin-disabled — не подсказываем (ограничение администратора,
      // а не режим/роль).
      if (this._isAdminDisabled(tool)) continue;
      const availability = computeToolAvailability(tool.name, tool.capabilities, {
        sessionMode,
        planMode,
        planApproved,
        mcpToolSettings: session.settings.mcpToolSettings,
        agentCapabilities: agentDef?.capabilities,
        runtimeDeps: this._runtimeDeps,
        workspaceReady,
      });
      if (!availability.available && availability.reason) {
        const dep = availability.reason === 'dependency' ? TOOL_RUNTIME_DEP[tool.name] : undefined;
        unavailable.push({
          name: tool.name,
          reason: availability.reason,
          ...(dep ? { binary: RUNTIME_DEP_BINARY[dep] } : {}),
          // ADR-077: деталь недоступности (состав пула исполнителей).
          ...(availability.detail ? { detail: availability.detail } : {}),
        });
      }
    }
    return unavailable;
  }

  /** ADR-071 §2.4: загрузка проекта сессии (для проектного MCP-скоупа). */
  private async _loadProject(session: Session): Promise<Project | null> {
    if (!session.projectId || !this._projectStore) return null;
    try {
      return await this._projectStore.load(session.projectId);
    } catch {
      return null;
    }
  }

  /**
   * fs.changed: после успешного мутирующего тула публикуем событие для UI
   * (дерево Files, открытые редакторы, Git-вкладка). Read-only тулы и
   * неуспешные операции событий не дают (`resolveFsChange` → null).
   */
  private _publishFsChange(
    session: Session,
    toolName: string,
    toolResult: { isError?: boolean; metadata?: Record<string, unknown> },
    workingDir: string,
    args?: Record<string, unknown>,
  ): void {
    publishFsChange(session, toolName, toolResult, workingDir, this._eventBus, args);
  }

  /**
   * ADR-071 §2.4: решения по эффективному набору MCP. Модель per-item:
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
      // ADR-077 (шаг B2): серверы пула исполнителей — system-level runtime-записи.
      ...(manager.isExecutorServer?.(name) === true ? { executor: true } : {}),
    }));
    // ADR-077 (шаг B2): серверы исполнителя включены по умолчанию (их состав
    // задаёт оператор топологии в конфигурации исполнителя); сессионный
    // opt-out (`mcpDisabledServers`) по-прежнему работает.
    const executorNames = manager.getExecutorServerNames?.() ?? [];
    return resolveMcpScope(servers, project?.mcp, {
      enabled: [...(session.settings.mcpServers ?? []), ...executorNames],
      disabled: session.settings.mcpDisabledServers,
      defaultOn: session.settings.mcpDefaultOn,
    });
  }

  /**
   * ADR-071 §2.2: статус MCP-сервера для API/промпта. Отключённый сервер —
   * `disabled`; иначе — состояние менеджера (`circuit-open`/`connected`/`error`).
   */
  private _resolveMcpServerStatus(name: string, enabled: boolean): ComposerMcpServerStatus {
    if (!enabled) return 'disabled';
    const raw = this._mcpManager?.getServerStatus(name);
    return raw === 'circuit-open' ? 'circuit-open' : raw === 'connected' ? 'connected' : 'error';
  }

  /**
   * ADR-071 §2.1: имена активных MCP-серверов сессии (эффективный скоуп).
   * Используется для наследования MCP-скоупа resumed-саб-агентом от родителя.
   */
  private async _resolveActiveMcpServers(session: Session): Promise<string[]> {
    if (!this._mcpManager) return [];
    const project = await this._loadProject(session);
    return this._resolveMcpDecisions(session, project).filter((d) => d.enabled).map((d) => d.name);
  }

  /**
   * ADR-071 §2.4: эффективный список MCP-серверов сессии (включая отключённые с
   * причиной) — единый источник для API `GET /sessions/:id/mcp` и промпта.
   */
  async resolveMcpServers(session: Session): Promise<McpServerEffective[]> {
    const manager = this._mcpManager;
    if (!manager) return [];
    const project = await this._loadProject(session);
    const decisions = this._resolveMcpDecisions(session, project);
    // ADR-071 §2.6: единый ratio для оценок токенов (калибровка модели сессии).
    const tokenRatio = await this._resolveTokenRatio(session.settings.model);
    return decisions.map((d) => {
      const status = this._resolveMcpServerStatus(d.name, d.enabled);
      const rawTools = manager.getServerTools(d.name) ?? [];
      // ADR-071 §2.6: пер-тульные chars/estTokens — по тому же JSON-определению,
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
   * ADR-071 §2.2: данные MCP-серверов для промпта (`mcp.servers` — stable,
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
   * ADR-070 §2.8: смена режима в середине хода — добавляет durable
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
   * ADR-070 §2.5: read-only диагностика состава системного промпта для API/UI.
   * Возвращает манифест (тот же обход, что и `compose`), состояние промпта
   * активного агента и `promptMeta` последнего ответа. Побочных эффектов нет:
   * `promptStates` не пишется, `captureSystemPromptParts` не вызывается.
   */
  async getPromptInfo(session: Session): Promise<PromptDiagnostics> {
    const effectiveAgentRole = session.settings.agentRole;
    const agentDef = effectiveAgentRole ? this._agentRegistry?.get(effectiveAgentRole) : undefined;
    // ADR-071 §2.4: проект загружаем один раз — для рабочего каталога и Composer.
    const project = await this._loadProject(session);
    // ADR-114 §3.2: диагностика **не** должна падать из-за исчезнувшего
    // каталога worktree (ход — fail-closed, здесь только read-only отчёт):
    // показываем fallback-каталог, а каталог привязки — в подсказке.
    let workingDir: string;
    try {
      workingDir = await this._resolveWorkingDir(session, project);
    } catch (e) {
      if (!(e instanceof WorktreeDirectoryMissingError)) throw e;
      workingDir = this._defaultWorkingDir;
    }
    const workspaceReady = (await this._resolveProjectWorkspace(session, project)) !== null;
    const language = session.settings.language || 'ru';

    const optimizedMessages = this._optimizer
      ? this._optimizer.getMessagesForLlm(session)
      : session.messages;
    const summaryContent = optimizedMessages
      .filter((m) => m.role === MessageRole.SUMMARY)
      .map((m) => m.content)
      .join('\n\n');

    // ADR-071 §2.1/§2.3/§2.4: тот же per-session список инструментов, что уходит в
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
      sessionMode, planMode, planApproved, workspaceReady,
    });
    const toolSelection = select();
    // ADR-071 §2.6: chars-per-token модели (калибровка) для оценок токенов.
    const tokenRatio = await this._resolveTokenRatio(session.settings.model);

    // ADR-070 §2.5 + ADR-071 §2.1/§2.3 + ADR-090: манифест отражает реальные
    // слои запроса — `tools` (встроенные), `plugin.tools` (плагинные тулы) и
    // `mcp.tools` (MCP сессии); тир `tools` зависит от `tools.policy`, слои
    // `plugin.tools`/MCP всегда volatile.
    // ADR-046 §5: каталог скиллов — тем же путём, что и в запросе.
    const skillsCatalog = await this._collectSkillsCatalog({
      session,
      agentDef,
      effectiveAgentRole,
      workingDir,
      permissionConfig: session.settings.permission ?? this._permissionConfig,
      project,
    });
    // ADR-069 Фаза 1: те же проектные инструкции, что и в запросе (манифест).
    const projectInstructions = await this._resolveProjectInstructions({
      session,
      project,
      workingDir,
      model: session.settings.model,
      language,
    });
    const schedulerActive = await this._resolveSchedulerActive(session);
    const ctx: ComposerContext = this._buildComposerContext({
      session, agentDef, effectiveAgentRole, workingDir, language, summaryContent,
      toolsPolicy, mcpPolicy, tokenRatio,
      // ADR-071 §2.2: блоки `mcp.servers`/`mcp.status` — все серверы эффективного набора.
      mcpServers: this._collectComposerMcpServers(mcpDecisions),
      project,
      toolSelection,
      skillsCatalog,
      instructions: projectInstructions?.instructions,
      schedulerActive,
      // Интервью-блок в диагностике — по истории сессии (нет явного хода).
      interviewEligible: this._interviewEligible(session, undefined, {
        agentDef, sessionMode, planMode, planApproved, workspaceReady,
      }),
      schedulerCurrentTurn: this._schedulerCurrentTurn(session),
      // ADR-090: в диагностике «вопрос хода» — последнее
      // пользовательское сообщение истории (явного хода нет).
      query: resolveTurnQueryFn(session),
    });

    const manifest = await this._composer.manifest(ctx);
    const promptState = session.promptStates?.[agentKeyOf(effectiveAgentRole)] ?? null;
    const lastPromptMeta = this._lastPromptMeta(session, effectiveAgentRole);
    const history = this._buildPromptHistoryInfo(session, effectiveAgentRole, tokenRatio);
    // ADR-071 §2.6: per-tool данные встроенных инструментов для таблицы статистики.
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
        workspaceReady,
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
   * ADR-070 §2.5: состав слоя истории (`messages`) — read-only. Зеркалит
   * реальную отправку через тот же `_sessionMessagesToLlm`, что и
   * `_processMessage`, чтобы статистика не расходилась с запросом.
   */
  private _buildPromptHistoryInfo(
    session: Session,
    agentRole?: string,
    tokenRatio: number = DEFAULT_CHARS_PER_TOKEN,
  ): PromptHistoryInfo {
    return buildPromptHistoryInfoFn(session, agentRole, tokenRatio);
  }

  /** `promptMeta` последнего assistant-сообщения активного агента. */
  private _lastPromptMeta(session: Session, agentRole?: string): PromptMeta | null {
    return lastPromptMetaFn(session, agentRole);
  }

  /**
   * processMessage callback для QueueProcessor.
   */
  createProcessMessage(): (
    session: Session,
    message: Message,
    signal: AbortSignal,
    publishChunk: (event: string, data: Record<string, unknown>) => void,
    /** Номер попытки (1-based) для решения о терминальности сбоя (ADR-070 §2.6). */
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
    // ADR-106 Ф4: принципал хода — зафиксирован **при приёме ввода**
    // (постановка сообщения в очередь). При исполнении из `pendingMessages`
    // он не пересчитывается «от текущего» владельца сессии; для старых
    // сообщений без принципала — совместимый fallback (владелец сессии).
    const turnPrincipal = resolveTurnPrincipal(session, message);
    // ADR-071 §2.4: проект сессии — носитель project-скоупа MCP; загружаем один
    // раз: нужен рабочему каталогу, state-сообщениям, резолвингу MCP и Composer.
    let projectForState: Project | null = null;
    if (session.projectId && this._projectStore) {
      try {
        projectForState = await this._projectStore.load(session.projectId);
      } catch {
        projectForState = null;
      }
    }
    // ADR-106 Ф4 (шаг B2): контекст хода — **один раз на ход**. Вместе с
    // принципалом (шаг A) он несёт участников сессии и роль принципала среди
    // них: потолок сессии зависит от роли, а считается один раз на ход —
    // сообщение другого участника потолок начатого хода не меняет.
    const authorityTurn: AuthorityTurnContext = createAuthorityTurnContext({
      sessionId: session.id,
      principal: turnPrincipal,
      turnId: streamId,
      ...(effectiveAgentRole ? { agentId: effectiveAgentRole } : {}),
      participants: deriveSessionParticipants(session, projectForState),
    });
    // ADR-070 §2.6: старт прогона — для per-message duration_ms (полная
    // длительность у финального сообщения потока, включая tool-chain).
    const streamStartedAt = Date.now();
    const debugCollector = new DebugCollector(session.settings.debugEnabled);
    // ADR-114 §3: рабочий каталог сессии и её привязка к worktree (одним
    // чтением). Привязка нужна тулам (containment от каталога worktree,
    // поиск записи реестра git), каталог — permission-слою и file/shell-тулам.
    let workingDir: string;
    let sessionWorktree: SessionWorktree | undefined;
    try {
      ({ workingDir, worktree: sessionWorktree } = await this._resolveSessionWorkingDir(session, projectForState));
    } catch (e) {
      // ADR-114 §3.2: каталог привязанного worktree исчез — ход **не стартует**
      // (тихий фоллбек в `project.workspace` запрещён), и повтор не поможет:
      // ошибка уходит через общий обработчик сбоя хода (`canRetry: false`).
      if (!(e instanceof WorktreeDirectoryMissingError)) throw e;
      return this._handleLlmFailure(session.id, streamId, e, attempt, {
        debugCollector,
        durationMs: Date.now() - streamStartedAt,
        model: session.settings.model,
        providerName: session.settings.provider,
        agentRole: effectiveAgentRole,
      });
    }
    // ADR-075: permission-гейт `workspace` — file/shell/git-тулы блокируются,
    // пока у проекта не задан рабочий каталог. `workingDir` при этом всё равно
    // резолвится (fallback default) — он нужен промпту/контексту, но путь
    // инструментов остаётся невалидным до появления workspace.
    let workspaceReady = (await this._resolveProjectWorkspace(session, projectForState)) !== null;

    // ADR-025: режим Plan/Act — runtime-состояние сессии + строгость из настроек
    const planMode: PlanMode = session.settings.planMode ?? this._defaultPlanMode ?? 'auto';
    // ADR-106 Ф4 (шаг C): режим — свойство **принципала хода**: переопределение
    // участника (`modeByPrincipal`) → базовый режим сессии. `yolo`, выставленный
    // одним участником, действует только на его ходы и не снимает подтверждения
    // у других (прежнее поведение — базовый режим сессии).
    let sessionMode: SessionMode = resolveTurnMode(session, turnPrincipal);
    let planApproved = Boolean(session.planApproved);

    // ADR-030 (Ф0 ADR-090): `message_received` — входящее сообщение в сессии.
    // Один эмит на сообщение: только первая попытка (`attempt` 1-based; ретраи
    // в `QueueProcessor` переиспользуют то же сообщение) и только `role: user`.
    // Внутренние системные сообщения хода (суммаризация/отладка) и
    // state-сообщения имеют `role: system` — «входящими» не считаются и хука
    // не эмитят. Текст сообщения не передаётся (утечка содержимого диалога).
    if (
      (!attempt || attempt <= 1)
      && message.role === MessageRole.USER
      && this._hooks?.count('message_received')
    ) {
      const messageSource = typeof message.metadata?.source === 'string'
        ? message.metadata.source
        : undefined;
      const messageType = typeof message.metadata?.type === 'string'
        ? message.metadata.type
        : undefined;
      const kind: MessageReceivedKind = message.metadata?.scheduler === true || author === 'Scheduler'
        ? 'scheduler'
        : messageSource !== undefined
          ? 'external'
          : 'user';
      this._hooks.emitAsync('message_received', {
        sessionId: session.id,
        ...(effectiveAgentRole ? { agent: effectiveAgentRole } : {}),
        mode: sessionMode,
        kind,
        ...(messageSource ? { source: messageSource } : {}),
        ...(messageType ? { type: messageType } : {}),
      });
    }

    // ADR-029: permissions — сессионный override приоритетнее глобального конфига.
    // Конфиг может быть расширен «разрешить в сессии» (once:false) в процессе
    // обработки, поэтому ссылка и эвалуатор пересоздаются.
    let effectivePermissionConfig = session.settings.permission ?? this._permissionConfig;
    let permissionEvaluator = new PermissionEvaluator(effectivePermissionConfig, {
      authorityShadow: this._authorityShadow,
      authorityGate: this._authorityGate,
    });

    const agentDef = effectiveAgentRole ? this._agentRegistry?.get(effectiveAgentRole) : undefined;
    const agentMaxSteps = agentDef?.maxSteps;
    const maxIterations = (agentMaxSteps !== undefined && agentMaxSteps > 0)
      ? agentMaxSteps
      : DEFAULT_MAX_ITERATIONS;

    // Уровень размышлений агента: если агент не задал — берём настройку сессии
    const effectiveReasoningLevel = agentDef?.reasoningLevel ?? session.settings.reasoningLevel;

    // ADR-070 §2.9.1/ADR-077: перечитать доступность внешних программ (git/rg/sh)
    // перед ходом. Снимок на старте устаревает: в split-режиме состав пула
    // появляется не мгновенно (раскатка поднимает control plane раньше
    // исполнителя), и ложный negative («sh отсутствует») иначе залипал бы до
    // перезапуска процесса. Перечитывание дешево: `detectRuntimeDeps` кэширует
    // результат на `RUNTIME_DEPS_CACHE_TTL_MS`.
    await refreshRuntimeDeps(this._runtimeDeps, this._executionPort);

    // --- ADR-095 (шаг 6b-1): ранние выходы (системные сообщения, `/`-команды,
    // micro-first) вынесены в `orchestrator/phases/process-early.ts`; порядок
    // проверок и side-effect'ов прежний. `null` — идём обычным путём (LLM).
    const earlyResult = await runProcessEarly({
      session, message, signal, publishChunk, debugCollector, streamId,
      effectiveAgentRole, effectiveReasoningLevel, workingDir, attempt,
      permissionEvaluator, sessionMode, planMode, planApproved, streamStartedAt,
      authorityTurn,
    }, this._processEarlyDeps());
    if (earlyResult) return earlyResult;

    try {
      // Этап 1 roadmap 0.13 (блок 3): «ход → сессия» — нужно для «Стопа»:
      // `cancel(streamId)` знает только ход, а снимать открытые вопросы нужно
      // у сессии. Запись снимается в `finally` ниже.
      this._streamSessions.set(streamId, session.id);
      // ADR-095 (шаг 6b-1): подготовка запроса (провайдер → MCP-скоуп →
      // state-сообщения → промпт Composer'ом → инструменты → cancel-токен)
      // вынесена в `orchestrator/phases/process-setup.ts`; порядок прежний.
      const setup = await runProcessSetup({
        session, message, signal, streamStartedAt, debugCollector, streamId,
        projectForState, workingDir, workspaceReady, agentDef, effectiveAgentRole,
        effectiveReasoningLevel, sessionMode, planMode, planApproved, author, attempt,
      }, this._processSetupDeps());
      if (setup.failed) return setup.result;
      const {
        provider, providerName, modelName, routingDecision, language,
        activeMcpServers, activeMcpSet, toolsPolicy, mcpPolicy,
        baseLlmMessages, finalSystemPrompt, promptMeta,
        skillsCatalog, projectInstructions, loadedTokenRatio, messagesForLlm,
        cancelToken, toolAbortController,
      } = setup.state;
      let tools = setup.state.tools;

      // 6. Tool loop — stream LLM, execute tools, continue until no tool calls
      let toolIteration = 0;
      const currentMessages: LLMMessage[] = [...baseLlmMessages];
      const doomLoopTracker: Map<string, number> = new Map();
      let finalContent = '';
      let allReasoning: Array<{ text: string; iteration: number }> = [];
      const allIntermediateTexts: Array<{ text: string; iteration: number }> = [];
      let finalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
      let finalModel: string | undefined;
      // Модель последнего завершённого стрима итерации: нужна ветке отмены
      // во время тула, где `chunkModel` уже вне области видимости, а
      // `finalModel` ещё не обновлён (ADR-070 §2.6, Bug 2).
      let lastChunkModel: string | undefined;
      const allToolCalls: Array<Record<string, unknown>> = [];
      let stopAfterDeny = false;
      let denyStopReason: string | undefined;
      /** metadata.i18n подставленного финального фоллбека (лимит итераций / deny / пустой ответ). */
      let fallbackI18n: ReturnType<typeof i18nMeta> | undefined;
      /** Были ли deny-отказы за цикл (для осмысленного fallback пустого ответа). */
      let hadDeny = false;
      /** Отмена до финального сохранения (до входа в итерацию, во время тула) —
       *  завершать обработку как отмену, а не как пустой ответ. */
      let cancelledBeforeFinal = false;
      /**
       * Шаг 2б: ссылка на черновик последней **незавершённой** итерации. Если
       * итерация закончилась без toolCalls — финальное сообщение обновляет
       * черновик (без дубля); если с toolCalls (зафиксирован как tool_chain) или
       * чанков не было (`ref() === null`) — финал добавляется как раньше.
       */
      let currentDraft: StreamMessageRef | null = null;

      // ADR-070 §2.6: live-статистика стрима (`stream.usage`). Состояние
      // троттлинга — на поток; публикуется через publishChunk (EventBus).
      const liveUsageState = {
        lastPublishedAt: 0,
        lastSignature: '',
        exactPublished: false,
        inputExactPublished: false,
      };

      // Стартовая оценка input сразу после сборки сообщений — чтобы панель
      // статистики не пустовала до первого чанка провайдера.
      // ADR-071 §2.6: размер промпта считаем один раз при старте и на входе
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
      this._publishContextLimitWarning(session.id, modelName, messagesForLlm);

      while (toolIteration < maxIterations) {
        // Отмена до входа в итерацию (уже абортированный signal, «Стоп» на
        // стартовом stream.usage) — обрабатываем общей веткой отмены ниже.
        // Иначе пустой ход превращался бы в «ответ модели пуст» (error).
        // Дополнительно — персистентный флаг сессии (`isCancelRequested`):
        // останавливает многоитерационный Tool Use, когда живой cancelToken
        // недоступен (backoff/гонка); сбрасывает флаг процессор очереди.
        if (
          cancelToken.cancelled
          || (this._isCancelRequested ? await this._isCancelRequested(session.id) : false)
        ) {
          // Этап 1 roadmap 0.13 (блок 3): отмена хода снимает открытые
          // вопросы сессии — иначе вопрос остался бы ждать ответа.
          if (this._questionService) {
            void this._questionService.cancelSession(session.id, 'aborted').catch(() => {
              // Снятие вопросов не должно ронять отмену хода.
            });
          }
          cancelledBeforeFinal = true;
          break;
        }

        // ADR-104 (этап 2): прерывание, запрошенное ВО ВРЕМЯ шага (инструмент
        // выполнялся / ждали подтверждения прав) — применяем на ближайшей
        // границе: публикуем `stream.interrupted` и продолжаем ТОТ ЖЕ ход.
        // Генерацию прерывать нечего (её уже нет) — сообщение вплетается
        // инъекцией ниже, как при `steer`.
        if (cancelToken.interrupted) {
          cancelToken.interrupted = false;
          publishChunk('stream.interrupted', {
            stream_id: streamId,
            status: 'interrupted',
            // `boundary` — прерывание применено на границе шага (генерации в
            // этот момент не было); `generation` — оборвана текущая генерация.
            reason: 'boundary',
            model: finalModel,
            provider: providerName,
            iteration: toolIteration,
          });
        }

        // ADR-104: вычитка очереди инъекций — на границе шага (здесь же, где
        // проверяется отмена). Инъекция НИКОГДА не попадает внутрь шага:
        // результаты инструментов предыдущей итерации уже в `currentMessages`,
        // поэтому пары toolUse/toolResult не рвутся.
        await this._applySteerInjections(
          session, currentMessages, publishChunk, effectiveAgentRole, author, streamId,
        );

        let accumulatedContent = '';
        let accumulatedReasoning = '';
        let toolCalls: Record<string, unknown>[] | undefined = [];
        let chunkModel: string | undefined;
        // ADR-070: usage текущей итерации (running total от провайдера) для live.
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

        // Шаг 2б: черновик частичного стрима этой итерации. Запись создаётся
        // при первом непустом контенте/рассуждении и далее обновляется с
        // троттлингом — стрим не блокируется.
        const draft = new StreamMessageDraft({
          sessionManager: this._sessionManager,
          sessionId: session.id,
          base: {
            role: MessageRole.ASSISTANT,
            origin: 'local',
            disabled: false,
            pinned: false,
            hidden: false,
            provider: providerName,
            agentRole: effectiveAgentRole,
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            model: this._resolveMessageModel(undefined, finalModel, provider, session),
            metadata: { stream_id: streamId },
          },
          intervalMs: this._streamPersistIntervalMs,
        });

        try {
          for await (const chunk of provider.chatAsync(
            currentMessages,
            finalSystemPrompt,
            tools as Record<string, unknown>[] | undefined,
            debugCollector,
            cancelToken,
          )) {
            if (cancelToken.cancelled) break;
            // ADR-104 (этап 2): прерывание генерации (`interrupt`) — стрим
            // обрывается, ход НЕ завершается: выходим из цикла чанков,
            // частичный текст сохраняется, сообщение вплетается на границе.
            if (cancelToken.interrupted) break;

            // U+0000 в ответе модели/стрима ломает запись в PostgreSQL
            // (`text`/`jsonb`), поэтому чистим чанк до накопления и публикации.
            if (typeof chunk.content === 'string') chunk.content = stripNullBytes(chunk.content);
            if (typeof chunk.reasoning === 'string') chunk.reasoning = stripNullBytes(chunk.reasoning);
            if (chunk.toolCalls) chunk.toolCalls = stripNullBytesDeep(chunk.toolCalls);

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

            // Шаг 2б: частичный стрим в историю (не блокирует цикл чанков).
            draft.push(accumulatedContent, accumulatedReasoning, chunkModel);

            // ADR-070 §2.6: live-статистика. Anthropic отдаёт input/cache в
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

          // Шаг 2б: частичный текст сохраняется с interrupted/status='error',
          // таймер останавливается; семантика handleLlmFailure не меняется.
          await draft.abort(errMsg);

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

          // Завершённые итерации и их tool-результаты уже записаны пошагово
          // (шаг 2а) — повторная персистенция tool-chain не нужна.

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

          // Шаг 2б: останавливаем таймер/дожидаемся записи; черновик этой
          // итерации станет финальным сообщением отмены (без дубля). Если
          // чанков не было (`ref() === null`) — append как раньше.
          await draft.dispose();
          const cancelledDraft = draft.ref();

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
            cancelledDraft ?? undefined,
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

        // ADR-104 (этап 2): прерывание генерации (`interrupt`) — ход НЕ
        // завершается и НЕ отменяется («Стоп» — отдельный механизм, ADR-005):
        // частичный ответ сохраняется отдельным сообщением с маркером
        // `interrupted`, публикуется `stream.interrupted`, цикл продолжается —
        // на ближайшей границе шага вплетается сообщение пользователя.
        if (cancelToken.interrupted) {
          cancelToken.interrupted = false;
          // Модель текущей итерации: до прерывания `finalModel` ещё от
          // прошлой итерации — иначе финальное сообщение хода (ход НЕ
          // завершается) увидит не ту модель.
          finalModel = chunkModel ?? finalModel;
          await this._handleInterruptedGeneration({
            session,
            streamId,
            draft,
            content: accumulatedContent,
            reasoning: accumulatedReasoning,
            model: finalModel,
            providerName,
            agentRole: effectiveAgentRole,
            usage: finalUsage,
            iteration: toolIteration,
            startedAt: streamStartedAt,
            promptChars: iterationPromptChars,
            debugCollector,
            promptMeta,
            publishChunk,
          });
          continue;
        }

        finalModel = chunkModel ?? finalModel;

        if (accumulatedReasoning) {
          // Накопление через общий с UI хелпер: провайдер шлёт reasoning
          // кумулятивно, повтор в новой итерации не должен дать дубль.
          allReasoning = appendReasoningBlock(allReasoning, accumulatedReasoning, toolIteration);
        }

        // No tool calls — final response
        if (!toolCalls || toolCalls.length === 0) {
          finalContent = accumulatedContent;
          // Шаг 2б: дожидаемся последней записи, запоминаем черновик — финальное
          // сообщение обновит его (не добавит второй assistant в историю).
          await draft.flush();
          currentDraft = draft.ref();
          await draft.dispose();
          break;
        }

        if (accumulatedContent) {
          allIntermediateTexts.push({ text: accumulatedContent, iteration: toolIteration });
        }

        // Шаг 2а/2б: сразу фиксируем assistant-сообщение итерации с toolCalls (до
        // исполнения тулов) — падение/отмена в середине хода не должны терять
        // уже полученный ответ модели. Черновик частичного стрима превращается
        // в промежуточное tool_chain-сообщение (metadata заменяется целиком,
        // streaming убирается); пара tool-сообщений пишется ниже
        // (`_persistToolResult`) по мере готовности результатов.
        await draft.finalize({
          content: accumulatedContent,
          reasoning: accumulatedReasoning || undefined,
          toolCalls,
          model: chunkModel ?? finalModel,
          metadata: { stream_id: streamId, tool_chain: true },
        });

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
          // Аргументы могли прийти из JSON-escape `\u0000` — после парсинга это
          // уже реальный NUL в строках (ломает запись `tool_calls`/`metadata.args`).
          toolArgs = stripNullBytesDeep(toolArgs);

          const resolvedToolDef = this._toolRegistry?.get(toolName);
          // ADR-071 §2.1: MCP-тул вне активных серверов сессии недоступен —
          // глобальный реестр держит тулы постоянно, но executor подчиняется
          // per-session скоупу (иначе модель могла бы вызвать чужой MCP-тул).
          const toolDef = resolvedToolDef?.source === 'mcp'
            && (resolvedToolDef.mcpServer == null || !activeMcpSet.has(resolvedToolDef.mcpServer))
            ? undefined
            : resolvedToolDef;
          let toolResult: { content: string; isError?: boolean; metadata?: Record<string, unknown> };

          // ADR-030: `pre_tool_use` — синхронный хук ДО проверки permission и
          // исполнения тула. Блокировка (`{block:true}`) отменяет исполнение,
          // модель получает ошибку-результат `hook.blocked`. Без зарегистрированных
          // обработчиков `emit` не блокирует — поведение не меняется.
          const preHook = this._hooks
            ? await this._hooks.emit('pre_tool_use', {
              tool: toolName,
              input: toolArgs,
              ...(effectiveAgentRole ? { agent: effectiveAgentRole } : {}),
            })
            : null;
          const hookBlocked = preHook?.blocked === true;

          // ADR-029: гранулярные permissions — проверяем ДО doom loop, чтобы
          // deny-повторы не блокировались безликим «Цикл прерван», а получали
          // полноценный feedback (tool_call.result) с объяснением политики.
          // ADR-025: учитываем текущий режим Plan/Act и строгость плана.
          const permissionDecision = permissionEvaluator.check({
            toolName,
            params: toolArgs,
            workingDir,
            capabilities: toolDef?.capabilities,
            // ADR-106 Ф1: контекст хода для shadow-наблюдения (на решение не влияет).
            authorityContext: {
              sessionId: session.id,
              // ADR-106 Ф4: принципал хода — зафиксирован при приёме ввода
              // (на сообщении); для старых сообщений — владелец сессии.
              principal: turnPrincipal,
              ...(effectiveAgentRole ? { agentId: effectiveAgentRole } : {}),
              turnId: streamId,
              // ADR-106 Ф4 (шаг B2): потолок хода — один раз на ход.
              turnContext: authorityTurn,
            },
            // ADR-090: источник тула — плагинные инструменты
            // адресуются группой `plugin` в permission-правилах.
            toolSource: toolDef?.source,
            agentCapabilities: agentDef?.capabilities,
            sessionMode,
            planMode,
            planApproved,
            mcpToolSettings: session.settings.mcpToolSettings,
            shellPolicy: this._getProtectedPaths() ?? undefined,
            protectedPaths: this._getProtectedPaths() ?? undefined,
            protectedPathsEnabled: this._getProtectedPathsEnabled(),
            runtimeDeps: this._runtimeDeps,
            workspaceReady,
          });

          // Doom loop detection — только для вызовов, НЕ заблокированных
          // политикой. Deny-вызовы исключены: каждая попытка должна получать
          // понятный feedback с объяснением причины запрета, а не «Цикл
          // прерван». Механика для повторяющихся легальных вызовов сохраняется.
          if (!hookBlocked && permissionDecision.action !== 'deny') {
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
          // ADR-030: `Date.now()`-замер длительности тула для `post_tool_use`.
          const tcStartedMs = Date.now();

          publishChunk('tool_call.started', {
            stream_id: streamId,
            session_id: session.id,
            call_id: tcId,
            name: toolName,
            arguments: toolArgs,
            iteration: toolIteration,
          });

          // ADR-046 §8.2: `skill.invoked` — рядом с `tool_call.started`
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

          let executeTool = !hookBlocked && permissionDecision.action === 'allow';
          let deniedReason: string | undefined;
          let userDenied = false;

          if (!hookBlocked && permissionDecision.action === 'deny') {
            deniedReason = this._securityMessage(permissionDecision, 'en')
              ?? `Permission denied: ${permissionDecision.reason}`;
          } else if (!hookBlocked && permissionDecision.action === 'ask') {
            // ADR-106 Ф3: пара «действие × цель» для привязки подтверждения.
            // Задана — запрос привязан к ходу, и ответ принимает только
            // носитель покрывающего гранта (реестр подтверждений).
            const bindingTarget = deriveAuthorityTarget({
              toolName,
              params: toolArgs,
              workingDir,
              sessionId: session.id,
              ...(toolDef?.capabilities ? { capabilities: toolDef.capabilities } : {}),
              ...(toolDef?.source ? { toolSource: toolDef.source } : {}),
            }).target;
            const bindingAction = authorityActionForTool(toolName, toolDef?.capabilities);
            const approval = await this._approvalManager.waitForDecision(
              session.id,
              {
                approvalId: `approval_${tcId}`,
                callId: tcId,
                toolName,
                arguments: toolArgs,
                reason: this._securityMessage(permissionDecision, 'en')
                  ?? permissionDecision.reason,
                // ADR-106 Ф0: принципал и ход запроса (аддитивные поля
                // события `permission.asked`). ADR-106 Ф4: принципал хода —
                // зафиксированный при приёме ввода (на сообщении), а не
                // «текущий владелец сессии».
                principal: turnPrincipal,
                turnId: streamId,
                // ADR-106 Ф3: привязка к действию и цели.
                ...(bindingAction ? { action: bindingAction } : {}),
                ...(bindingTarget ? { target: bindingTarget } : {}),
              },
              effectivePermissionConfig.askTimeoutMs,
            );
            if (approval.approved) {
              executeTool = true;
              // «Разрешить в сессии» (once:false) — добавляем allow-правило для
              // тула в permission-конфиг сессии, чтобы не спрашивать повторно.
              if (approval.once === false) {
                effectivePermissionConfig = await this._grantSessionToolAllow(session, toolName, toolArgs, workingDir);
                permissionEvaluator = new PermissionEvaluator(effectivePermissionConfig, {
                  authorityShadow: this._authorityShadow,
                  authorityGate: this._authorityGate,
                });
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

          if (hookBlocked) {
            // ADR-030: pre_tool_use заблокировал тул — исполнение не выполняется,
            // модель получает ошибку-результат `hook.blocked` (как прочие ошибки
            // тулов), цикл продолжается.
            const hookReason = preHook?.reason ?? '';
            toolResult = {
              content: sm('hook.blocked', { hook: 'pre_tool_use', reason: hookReason }),
              isError: true,
              metadata: {
                i18n: i18nMeta('hook.blocked', { hook: 'pre_tool_use', reason: hookReason }),
              },
            };
          } else if (!executeTool) {
            this._eventBus.publish(session.id, 'permission.denied', {
              session_id: session.id,
              call_id: tcId,
              tool: toolName,
              arguments: toolArgs,
              reason: deniedReason,
              matched_rule: permissionDecision.matchedRule,
            });
            // ADR-030: `permission_denied` — неблокирующий эмит рядом с событием
            // сессии (аудит безопасности/уведомления ИБ).
            this._hooks?.emitAsync('permission_denied', {
              tool: toolName,
              input: toolArgs,
              ...(deniedReason ? { reason: deniedReason } : {}),
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
                // Проект сессии — метаданные хода: плагинный тул (память)
                // ограничивает себя данными проекта (ADR-107).
                ...(session.projectId ? { projectId: session.projectId } : {}),
                // Живой сигнал отмены: абортится как по /abort (cancel()),
                // так и по cancelRetry (внешний signal). Без этого тулы
                // (task/сабагент) не узнают о «Стоп» до своего завершения.
                abortSignal: toolAbortController.signal,
                agentRole: effectiveAgentRole,
                workingDir,
                // ADR-114: привязка к worktree — containment от каталога
                // worktree (git-тулы: `repo_path` только `.`) и поиск записи
                // реестра `project.repos` по `worktreeRepoPath` (каталог
                // worktree лежит вне `project.workspace`).
                ...(sessionWorktree
                  ? {
                    worktreeId: sessionWorktree.worktreeId,
                    // Репозиторий worktree относительно `project.workspace`;
                    // `.` — репозиторий в корне workspace.
                    worktreeRepoPath: sessionWorktree.repoPath ?? '.',
                  }
                  : {}),
                extra: {
                  provider,
                  agentRegistry: this._agentRegistry,
                  sessionManager: this._sessionManager,
                  // ADR-089: funnel создания дочерней сессии (late-bound, если подключён).
                  getRequestSessionService: this._getRequestSessionService ?? undefined,
                  // ADR-101/ADR-051: рантайм пайплайнов/расписаний (late-bound).
                  automation: this._getAutomationRuntime?.() ?? undefined,
                  projectStore: this._projectStore ?? undefined,
                  // Онбординг: тул `profile_update` сохраняет ответы интервью.
                  profilesStore: this._profilesStore ?? undefined,
                  workspacesRoot: this._workspacesRoot,
                  // ADR-075/ADR-076: тулы управления проектом (workspace, репозитории).
                  gitService: this._gitService,
                  workspaceManaged: this._workspaceManaged,
                  getWorkspaceOutsideRootPolicy: this._getWorkspaceOutsideRootPolicy ?? undefined,
                  // ADR-076 §T6: сетевые git-тулы резолвят SSH-ключ по реестру проекта.
                  sshKeyStore: this._sshKeyStore ?? undefined,
                  eventBus: this._eventBus,
                  // ADR-030: шина хуков — `task`/`task-resume` эмитят
                  // agent_spawned/agent_completed/agent_failed в саб-агенте.
                  hooks: this._hooks ?? undefined,
                  contextOptimizer: this._optimizer ?? undefined,
                  // ADR-046 §5: тул `skill` получает рантайм через ToolContext.extra
                  // (в ToolContext нет dataDir); саб-агенты — тот же объект.
                  skillRuntime: this._skillRuntime ?? undefined,
                  // Этап 1 roadmap 0.13 (блок 3): сервис вопросов пользователю —
                  // тул `question` задаёт вопрос и ждёт ответа.
                  questionService: this._questionService ?? undefined,
                  // Этап 1 roadmap 0.13 (блок 4): реестр фоновых прогонов —
                  // тул `task` с `background: true` регистрирует фонового
                  // саб-агента и возвращает управление сразу.
                  backgroundService: this._backgroundService ?? undefined,
                  backgroundEnabled: this._backgroundEnabled,
                  // ADR-111 §detach: реестр активных (блокирующих) прогонов —
                  // `task` регистрирует в нём хэндл, `POST /sessions/:id/background`
                  // переводит прогон в фон.
                  activeRuns: this.activeRuns,
                  // PROP-097 (блок 5b): сервис фоновых шелл-процессов —
                  // тул `execute_shell` с `background: true` запускает команду
                  // в фоне и возвращает управление сразу.
                  processService: this._processService ?? undefined,
                  // ADR-115: привязка файла из workspace к диалогу — сервис
                  // вложений, live-конфиг (ранние проверки), доставка
                  // user-сообщения (очередь + автоход) и учёт ссылок на blob.
                  attachmentService: this._getAttachmentService(),
                  attachmentsConfig: this._attachmentsConfig ?? undefined,
                  // ADR-115: каталог моделей инстанса — тул `list_models`
                  // (модальности, текущая пара, назначения aux-моделей).
                  listModels: this._listModels ?? undefined,
                  deliverUserMessage: this._deliverUserMessage ?? undefined,
                  blobRefs: this._blobRefs ?? undefined,
                  // ADR-114: сервис worktree'ов — тулы `git_worktree_*`.
                  worktreeService: this._worktreeService ?? undefined,
                  // Регистрация cancel-токена фонового прогона: `POST
                  // /sessions/<child>/abort` останавливает фонового ребёнка
                  // через общую карту токенов оркестратора (по streamId).
                  registerCancelToken: (id: string, token: CancellationToken) => {
                    this.registerCancelToken(id, token);
                  },
                  unregisterCancelToken: (id: string) => {
                    this.unregisterCancelToken(id);
                  },
                  // ADR-046 §4.5: scope-гейты скиллов (система/проект/сессия).
                  skillScope: this._skillScopeFor(session, projectForState),
                  // ADR-069 §7: уже резолвленные проектные инструкции — в extra,
                  // чтобы `task`/`task-resume` не резолвили их повторно в ребёнке.
                  projectInstructions: projectInstructions?.content,
                  callerAgentRole: effectiveAgentRole,
                  parentSessionSettings: session.settings,
                  // ADR-071 §2.1: саб-агент наследует MCP-скоуп родителя.
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
                  // ADR-070 §2.9.1: доступность внешних программ (git/rg/sh) —
                  // в permission-слой саб-агента (enforce `dependency`) и его
                  // `[НЕДОСТУПНЫЕ ТУЛЫ]`.
                  runtimeDeps: this._runtimeDeps,
                  // ADR-077: порт исполнения команд — тулы (shell/rg/git)
                  // ходят в него вместо прямого `execFile`.
                  executionPort: this._executionPort,
                  // ADR-075: гейт `workspace` наследуется саб-агентом —
                  // его permission-слой не даёт обойти отсутствие рабочего каталога.
                  workspaceReady,
                  shellPolicy: this._getProtectedPaths() ?? undefined,
                  protectedPaths: this._getProtectedPaths() ?? undefined,
                  protectedPathsEnabled: this._getProtectedPathsEnabled(),
                  // ADR-070: live-стоимость саб-агента тем же загрузчиком цен.
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
            // Шаг 2а: результат тула сразу в истории (пара к уже записанному
            // assistant(tool_calls)) — отмена ниже не должна его потерять.
            await this._persistToolResult(
              session.id, streamId, providerName, effectiveAgentRole,
              chunkModel ?? finalModel, toolName, toolArgs, tcId, toolResult,
            );
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

          // ADR-069 §4: lazy-догрузка вложенных проектных инструкций в результат
          // file/shell-тула. Контент инструкций сканируется внутри загрузчика
          // (ADR-036) и вставляется ПОСЛЕ IPI-обёртки базового tool-контента —
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

          // Шаг 2а: сразу сохраняем tool-результат (пара к assistant(tool_calls)).
          // До `allToolCalls.push` и state-сообщений (plan_enter/plan_exit и др.),
          // чтобы порядок в истории был assistant(tool_calls) → tool → state.
          await this._persistToolResult(
            session.id, streamId, providerName, effectiveAgentRole,
            chunkModel ?? finalModel, toolName, toolArgs, tcId, toolResult,
          );

          // classify_conversation: сохраняем категорию в настройках сессии (ADR-034)
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

          // ADR-025/ADR-070 §2.8: после plan_enter/plan_exit обновляем локальный
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
                workspaceReady,
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
                workspaceReady,
              ),
            );
            // ADR-030: `plan_approved` — неблокирующий эмит после утверждения
            // плана. planContent читаем из свежего проекта только при наличии
            // обработчиков (иначе лишний диск-IO и поведение не меняется).
            if (this._hooks?.count('plan_approved')) {
              const approvedProject = await this._loadProject(session);
              this._hooks.emitAsync('plan_approved', {
                sessionId: session.id,
                planContent: buildPlanUpdatedContent(approvedProject?.plan ?? null),
              });
            }
          } else if (toolResult.isError && toolName === 'plan_exit') {
            // ADR-030 (Ф0 ADR-090): `plan_rejected` — утверждение плана не
            // удалось (`plan_exit` вернул ошибку): план не утверждён, сессия
            // остаётся в plan-режиме. Отдельного «отклонить план» в коде нет,
            // поэтому точка — неудачное утверждение (ближайшая по смыслу).
            if (this._hooks?.count('plan_rejected')) {
              this._hooks.emitAsync('plan_rejected', {
                sessionId: session.id,
                reason: 'plan_exit_failed',
              });
            }
          }

          // ADR-075: смена рабочего каталога проекта в ходе (project_create/
          // project_attach/project_workspace_set) разблокирует file/shell/git-тулы
          // без прерывания хода: перечитываем проект, пересчитываем `workspaceReady`
          // и пересобираем выборку инструментов для следующих итераций. System
          // prompt mid-turn не пересобирается (как у plan_enter/plan_exit).
          if (
            !toolResult.isError
            && (toolName === 'project_create' || toolName === 'project_attach' || toolName === 'project_workspace_set')
          ) {
            // FileStore.load возвращает новый объект, а `attachSessionToProject`
            // через sessionManager.withLock меняет projectId (и сбрасывает
            // planApproved) в свежей копии — локальный `session` остаётся старым.
            // Синхронизируем только поля, которые меняют эти тулы, не трогая
            // локальные накопления (messages и т.п.).
            const refreshed = await this._sessionManager.getSession(session.id);
            if (refreshed) {
              session.projectId = refreshed.projectId;
              session.planApproved = refreshed.planApproved;
              // ADR-114: привязка к worktree принадлежит проекту — при смене
              // проекта она снимается (attachSessionToProject сбрасывает поле).
              session.worktree = refreshed.worktree;
              planApproved = Boolean(refreshed.planApproved);
            }
            projectForState = await this._loadProject(session);
            // ADR-114: привязка могла смениться — резолвим каталог и привязку
            // вместе (одним чтением).
            ({
              workingDir,
              worktree: sessionWorktree,
            } = await this._resolveSessionWorkingDir(session, projectForState));
            workspaceReady = (await this._resolveProjectWorkspace(session, projectForState)) !== null;
            const rebuilt = this._buildToolSelection({
              session, agentDef, effectiveAgentRole, activeMcpServers, providerType: provider.type,
              sessionMode, planMode, planApproved, workspaceReady,
            });
            const rebuiltSelection = rebuilt.select();
            // ADR-107: политика памяти проекта действует и после смены
            // проекта/workspace в ходе — тулы плагина памяти не возвращаются.
            const rebuiltPlugin = projectForState?.memory?.enabled === false
              ? withoutMemoryPluginTools(rebuiltSelection.plugin ?? [])
              : (rebuiltSelection.plugin ?? []);
            tools = this._toolRegistry
              ? [
                ...rebuiltSelection.builtin,
                ...rebuiltPlugin,
                ...rebuiltSelection.mcp,
              ]
              : undefined;
            finalSystemPrompt.stableToolCount = rebuiltSelection.builtin.length;
          }

          // ADR-030: `post_tool_use` — событие «После выполнения тула». Эмитим
          // только при реальном исполнении (deny и hook-блокировка не эмитят:
          // для отказа есть `permission_denied`, блокировку фиксирует
          // `pre_tool_use`), до `fs.changed`.
          if (executeTool && toolDef) {
            this._hooks?.emitAsync('post_tool_use', {
              tool: toolName,
              input: toolArgs,
              output: toolResult,
              duration: Date.now() - tcStartedMs,
              // ADR-102: оси атрибуции активности (`tool_calls`) — значения
              // сессии уже под рукой, подписчику не нужно её читать.
              sessionId: session.id,
              ...(session.userId ? { userId: session.userId } : {}),
              ...(session.projectId ? { projectId: session.projectId } : {}),
            });
          }

          // fs.changed: уведомляем UI об успешной мутации (после мид-ходового
          // refresh workspace — projectId/workingDir актуальны).
          this._publishFsChange(session, toolName, toolResult, workingDir, toolArgs);

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

          // ADR-029: пользователь отклонил запрос (ask→deny) — прекращаем
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

      // Этап 1 roadmap 0.13 (блок 3): конец хода — снимаем вопросы **этого**
      // хода (оставшиеся `pending`). Вопросы других ходов/сессий не трогаем.
      await this._cancelTurnQuestions(session.id, streamId);

      // ADR-095 (шаг 6b-1): эпилог (ветка отмены до финального сохранения,
      // фоллбек-тексты, quality-check/escalation, персист tool-chain, финальное
      // сообщение, `stream.done`, авто-тайтл, триггеры оптимизации контекста)
      // вынесен в `orchestrator/phases/process-finalize.ts`.
      return runProcessFinalize(
        { session, streamId, publishChunk, debugCollector, streamStartedAt },
        {
          cancelledBeforeFinal, lastChunkModel, finalModel, finalUsage, finalContent, fallbackI18n,
          hadDeny, stopAfterDeny, denyStopReason, toolIteration, maxIterations,
          lastIterationPromptChars, allReasoning, allIntermediateTexts, allToolCalls,
          currentMessages, promptMeta, loadedTokenRatio, routingDecision,
          provider, providerName, effectiveAgentRole, effectiveReasoningLevel, finalSystemPrompt,
          currentDraft,
        },
        this._processFinalizeDeps(),
      );
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
    } finally {
      this._streamSessions.delete(streamId);
    }
  }

  /**
   * Этап 1 roadmap 0.13 (блок 3): снять открытые вопросы **этого хода**.
   *
   * Вопросы других ходов не трогаем (фильтр по `turnId`): снятие вопроса
   * соседнего хода сломало бы его ожидание ответа. Ошибки не роняют ход.
   */
  private async _cancelTurnQuestions(sessionId: string, turnId: string): Promise<void> {
    const service = this._questionService;
    if (!service) return;
    try {
      const pending = await service.listPending(sessionId);
      for (const record of pending) {
        if (record.turnId !== turnId) continue;
        try {
          await service.cancel(record.id, 'turn_ended');
        } catch {
          // Уже закрыт (ответ пришёл гонкой) — не мешает.
        }
      }
    } catch (err) {
      warning('ORCHESTRATOR', `Не удалось снять вопросы хода: ${String(err)}`);
    }
  }

  cancel(streamId: string): void {
    const token = this._cancellationTokens.get(streamId);
    if (token) token.cancel();
    // Этап 1 roadmap 0.13 (блок 3): «Стоп» снимает открытые вопросы сессии —
    // иначе вопрос остался бы ждать ответа уже после отмены хода. Сигнал
    // отмены тула (`toolAbortController`) снимает вопрос сам, но сигнал может
    // не дойти (вопрос задан вне выполняющегося тула) — снимаем явно.
    const sessionId = this._streamSessions.get(streamId);
    if (sessionId && this._questionService) {
      void this._questionService.cancelSession(sessionId, 'aborted').catch(() => {
        // Отмена вопросов не должна ронять «Стоп».
      });
    }
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
    // ADR-071 §2.1: resumed-саб-агент наследует MCP-скоуп родительской сессии.
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
        // Resume-саб-агент писал файлы/git/shell — сообщаем UI об изменениях
        // workspace родительской сессии (как свежий `task`). Публикуем всегда,
        // даже при частичном/ошибочном прогоне: файлы могли измениться, а
        // лишний refresh безопасен (UI игнорирует `project_id: null`).
        this._eventBus.publish(parent.id, 'fs.changed', {
          session_id: parent.id,
          project_id: parent.projectId ?? null,
          scope: 'all',
          tool: 'task_resume',
        });
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
      // ADR-070 §2.9.1: dependency-гейт и `[НЕДОСТУПНЫЕ ТУЛЫ]` resumed-саб-агента.
      runtimeDeps: this._runtimeDeps,
      shellPolicy: this._getProtectedPaths() ?? undefined,
      protectedPaths: this._getProtectedPaths() ?? undefined,
      protectedPathsEnabled: this._getProtectedPathsEnabled(),
      // ADR-070: live-стоимость resumed-саб-агента тем же загрузчиком цен.
      modelPriceLoader: this._modelPriceLoader ?? undefined,
      // ADR-046 §5: каталог скиллов resumed-саб-агенту + тул `skill`.
      skillRuntime: this._skillRuntime ?? undefined,
      // ADR-075/ADR-076: проектные зависимости resumed-саб-агента — те же, что у
      // обычного пути `task` (проектные тулы, workspace-политика, SSH-окружение).
      projectStore: this._projectStore ?? undefined,
      // Онбординг: resumed-саб-агент получает тот же profilesStore для `profile_update`.
      profilesStore: this._profilesStore ?? undefined,
      workspacesRoot: this._workspacesRoot,
      sshKeyStore: this._sshKeyStore ?? undefined,
      gitService: this._gitService,
      workspaceManaged: this._workspaceManaged,
      getWorkspaceOutsideRootPolicy: this._getWorkspaceOutsideRootPolicy ?? undefined,
      // ADR-069 §7: резолвим проектные инструкции для ребёнка в оркестраторе
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
      // ADR-075: workspace-гейт resumed-саб-агента — по проекту дочерней сессии.
      getWorkspaceReady: async (child) => (await this._resolveProjectWorkspace(child)) !== null,
    };
  }

  private _debugSystemMessageDeps(): DebugSystemMessageDeps {
    return {
      getProvider: (providerName, session, reasoningLevel) =>
        this._getProvider(providerName, session, reasoningLevel),
      cancellationTokens: this._cancellationTokens,
      handleLlmFailure: (sessionId, streamId, error, attempt, ctx) =>
        this._handleLlmFailure(sessionId, streamId, error, attempt, ctx),
      estimatePromptChars: (messages, systemPrompt, tools) =>
        this._estimatePromptChars(messages, systemPrompt, tools),
      computeMessageCost: (model, usage) => this._computeMessageCost(model, usage),
      saveAssistantMessage: this._saveAssistantMessage.bind(this),
      sessionManager: this._sessionManager,
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
    return handleDebugSystemMessageFn(
      session, message, signal, publishChunk, debugCollector, streamId,
      reasoningLevel, attempt, this._debugSystemMessageDeps(),
    );
  }

  private _summarizationDeps(): SummarizationDeps {
    return {
      optimizer: this._optimizer,
      cancellationTokens: this._cancellationTokens,
      handleLlmFailure: (sessionId, streamId, error, attempt, ctx) =>
        this._handleLlmFailure(sessionId, streamId, error, attempt, ctx),
      estimatePromptChars: (messages, systemPrompt, tools) =>
        this._estimatePromptChars(messages, systemPrompt, tools),
      computeMessageCost: (model, usage) => this._computeMessageCost(model, usage),
      saveAssistantMessage: this._saveAssistantMessage.bind(this),
      sessionManager: this._sessionManager,
      eventBus: this._eventBus,
    };
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
    return handleSummarizationFn(
      session, message, signal, publishChunk, debugCollector, streamId,
      attempt, this._summarizationDeps(),
    );
  }

  /** Зависимости routing/gateway (ADR-095 шаг 6a: заглушка для делегаций). */
  private _routingDeps(): RouteProviderDeps {
    return {
      providerLoader: this._providerLoader,
      optimizer: this._optimizer,
      router: this._router,
      gateway: {
        gatewayConfig: this._gatewayConfig,
        gatewayPatternStore: this._gatewayPatternStore,
        obfMapStore: this._obfMapStore,
        gatewayAudit: this._gatewayAudit,
        gatewayRateLimiter: this._gatewayRateLimiter,
        gatewayPayloadLogPath: this._gatewayPayloadLogPath,
        metrics: this._metrics ?? undefined,
        filters: this._llmFilters,
      },
    };
  }

  private _getProvider(providerName: string, session: Session, reasoningLevel?: ReasoningLevel) {
    return getProvider(providerName, session, reasoningLevel, this._routingDeps());
  }

  /**
   * Размер контекстного окна модели: приоритет у сохранённого значения
   * (ModelConfig.contextWindow через оптимизатор), иначе справочник.
   */
  private _resolveModelContextWindow(modelName: string): number {
    return resolveModelContextWindow(modelName, this._optimizer);
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
   * ADR-036: оборачивает провайдер в GatewayProvider с привязкой к сессии.
   * Если gateway выключен — возвращает провайдер как есть (обратная совместимость).
   */
  private _wrapWithGateway(provider: BaseProvider, session: Session): BaseProvider {
    return wrapWithGateway(provider, session, this._routingDeps().gateway);
  }

  private _getEffectiveModel(session: Session, providerName: string): string {
    return getEffectiveModel(session, providerName, this._providerLoader);
  }

  /**
   * Выбор провайдера и модели через роутер (ADR-034).
   * Если роутер недоступен — fallback на _getProvider().
   */
  private async _routeProvider(
    session: Session,
    message: Message,
    reasoningLevel?: ReasoningLevel,
    debugCollector?: DebugCollector,
  ): Promise<{ provider: BaseProvider; providerName: string; modelName: string; decision?: RoutingDecision } | null> {
    return routeProvider(session, message, reasoningLevel, debugCollector, this._routingDeps());
  }

  static _sessionMessagesToLlm(
    messages: Message[],
    currentAgentRole?: string,
    currentAuthor?: string,
  ): LLMMessage[] {
    return sessionMessagesToLlmFn(messages, currentAgentRole, currentAuthor);
  }

  /**
   * ADR-036: возвращает реальные значения секретов для плейсхолдеров
   * ⟦SYNTH_SECRET_N⟧ в тексте сообщения (из карты обфускации сессии).
   * Пустой объект если карты нет, плейсхолдеров нет или gateway выключен.
   */
  private async _getAssistantSecrets(sessionId: string, content: string): Promise<Record<string, string>> {
    return getAssistantSecrets(sessionId, content, this._obfMapStore);
  }

  /** Зависимости персистентности сообщений (ADR-095 шаг 6a: заглушка делегаций). */
  private _persistenceDeps(): SaveAssistantMessageDeps {
    return {
      sessionManager: this._sessionManager,
      eventBus: this._eventBus,
      obfMapStore: this._obfMapStore,
      modelPriceLoader: this._modelPriceLoader,
      analytics: this._analytics ?? undefined,
    };
  }

  /**
   * ADR-104 (этап 2): обрыв генерации по запросу `interrupt`.
   *
   * Отличие от «Стоп» (`cancel`, ADR-005): ход НЕ завершается и НЕ
   * отменяется — обрывается только текущая генерация. Частичный ответ
   * сохраняется отдельным сообщением со статусом `interrupted`
   * (`metadata.interrupted`), публикуется `stream.interrupted` (а НЕ
   * `stream.cancelled`), а цикл Tool Use продолжает работу: на ближайшей
   * границе шага вплетается сообщение пользователя.
   *
   * Пары `toolUse`/`toolResult` не рвутся: прерванная генерация не дала
   * результата (вызов инструмента не выполнялся), поэтому assistant с
   * `toolCalls` в историю не пишется — «висячей» пары не возникает.
   * Результаты уже выполненных инструментов в usage/аналитику прерванного
   * сообщения НЕ включаются: ход продолжается, их usage посчитает итоговое
   * сообщение хода (иначе — двойной счёт).
   */
  private async _handleInterruptedGeneration(args: {
    session: Session;
    streamId: string;
    draft: StreamMessageDraft;
    content: string;
    reasoning: string;
    model: string | undefined;
    providerName: string;
    agentRole: string | undefined;
    usage: TokenUsage;
    iteration: number;
    startedAt: number;
    /** Размер промпта итерации (символы) — для оценки usage. */
    promptChars: number;
    debugCollector: DebugCollector;
    promptMeta: PromptMeta | undefined;
    publishChunk: (event: string, data: Record<string, unknown>) => void;
  }): Promise<void> {
    const {
      session, streamId, draft, content, reasoning, model, providerName, agentRole,
      usage, iteration, startedAt, promptChars, debugCollector, promptMeta, publishChunk,
    } = args;

    // Частичный текст уже лежит в черновике — дожидаемся записи и заменяем её
    // финальным сообщением (без дубля в истории).
    await draft.dispose();
    const interruptedDraft = draft.ref();

    const durationMs = Date.now() - startedAt;
    // Провайдер при обрыве не отдаёт usage — оцениваем best-effort (как при
    // отмене): input — из размера промпта, output — из накопленного текста.
    const estimated = this._estimateUsage(usage, promptChars, content.length);
    const cost = this._computeMessageCost(model, estimated.usage);

    // Пустой ответ без черновика — сообщение не создаём (иначе в истории
    // появится пустой assistant). Событие `stream.interrupted` всё равно
    // публикуется — ход продолжается.
    if (content || interruptedDraft) {
      await this._saveAssistantMessage(
        session.id, content, streamId, agentRole,
        estimated.usage, model, reasoning, debugCollector,
        // `isCancelled = false`: прерывание — не отмена хода (ADR-005 «Стоп»).
        false, providerName,
        MessageRole.ASSISTANT, undefined, false,
        // `toolResults` не передаём — итоговое сообщение хода посчитает их usage.
        undefined, undefined, undefined, undefined,
        {
          // Маркер прерванной генерации (ADR-104): UI рисует его отдельным
          // бейджем, а `resolveAssistantStatus` даёт статус `interrupted`.
          [STEER_INTERRUPTED_METADATA_KEY]: true,
          duration_ms: durationMs,
          ...(estimated.estimated ? { usage_estimated: true } : {}),
        },
        promptMeta,
        cost,
        interruptedDraft ?? undefined,
      );
    }

    publishChunk('stream.interrupted', {
      stream_id: streamId,
      content,
      status: 'interrupted',
      // `generation` — оборвана текущая генерация; `boundary` — прерывание
      // применено на границе шага (генерации в этот момент не было).
      reason: 'generation',
      model,
      provider: providerName,
      iteration,
      usage: estimated.usage,
      duration_ms: durationMs,
      ...(cost ? { cost_usd: cost.costUsd, cost_currency: cost.currency } : {}),
      ...(estimated.estimated ? { usage_estimated: true } : {}),
    });
  }

  /**
   * ADR-104 (этап 2): прервать текущую генерацию, НЕ завершая ход.
   *
   * В отличие от `cancel` («Стоп», ADR-005): ход продолжается — обрывается
   * только генерация, а сообщение пользователя вплетается на ближайшей
   * границе шага. Выполняющийся инструмент НЕ прерывается
   * (`toolAbortController` не трогаем) — необратимые операции не бросаются
   * на полпути.
   *
   * @param streamId — id живого стрима (`session.currentStream.streamId`).
   * @returns `true`, если стрим найден и прерывание запрошено.
   */
  interrupt(streamId: string): boolean {
    const token = this._cancellationTokens.get(streamId);
    if (!token) return false;
    // `interrupt()` провайдера дополнительно обрывает сетевой запрос
    // генерации; без него (провайдер без обёртки) — только флаг.
    if (token.interrupt) token.interrupt();
    else token.interrupted = true;
    return true;
  }

  /**
   * ADR-104: применить очередь инъекций (steering) на границе шага.
   *
   * Вызывается в начале итерации цикла Tool Use — МЕЖДУ шагами: результаты
   * инструментов предыдущей итерации к этому моменту уже дописаны в
   * `currentMessages`, поэтому пары `toolUse`/`toolResult` не рвутся и модель
   * получает цепочку инструментов без «висячих» вызовов.
   *
   * Инъекция персистится как обычное user-сообщение с `metadata.steer=true`
   * (автор, время) — значит, она видна в истории и попадает в LLM-контекст
   * следующих ходов штатно. Текущий ход получает её через `currentMessages`.
   */
  private async _applySteerInjections(
    session: Session,
    currentMessages: LLMMessage[],
    publishChunk: (event: string, data: Record<string, unknown>) => void,
    agentRole: string | undefined,
    author: string,
    streamId: string,
  ): Promise<void> {
    // Общая точка применения инъекций (ADR-104) — её же использует цикл
    // саб-агента (`engine/tools/task/run-cycle.ts`): семантика инъекции
    // (лимит, порядок, маркеры, payload событий) не должна расходиться
    // между основной сессией и дочерней.
    await applySteerInjections({
      sessionManager: this._sessionManager,
      sessionId: session.id,
      llmMessages: currentMessages,
      toLlmMessages: (message) => sessionMessagesToLlmFn([message], agentRole, author),
      persist: async (message) => {
        const stored = await this._sessionManager.appendMessage(session.id, message);
        // Позиция сообщения в истории (0-based) — как в `GET /:id/messages`,
        // чтобы UI мог добавить его в ленту без полной перезагрузки.
        return { index: (stored?.seq ?? message.seq) - 1 };
      },
      publishInjected: (event) => publishChunk('message.injected', event),
      publishDropped: (event) => publishChunk('steer.dropped', event),
      streamId,
    });
  }

  /**
   * Пошаговая персистентность tool-результата (шаг 2а): пишется сразу после
   * готового результата (IPI-обёртка/ленивые инструкции уже применены),
   * до `allToolCalls.push` и state-сообщений (`plan_enter`/`plan_exit` и др.),
   * чтобы порядок в истории был assistant(tool_calls) → tool → state.
   */
  private async _persistToolResult(
    sessionId: string,
    streamId: string,
    providerName: string,
    agentRole: string | undefined,
    model: string | undefined,
    toolName: string,
    toolArgs: Record<string, unknown>,
    toolCallId: string,
    toolResult: { content: string; isError?: boolean; metadata?: Record<string, unknown> },
  ): Promise<void> {
    await this._sessionManager.appendMessage(sessionId, {
      id: generateId(),
      role: MessageRole.TOOL,
      seq: 0,
      origin: 'local',
      parts: [makeTextPart(toolResult.content)],
      content: toolResult.content,
      toolCallId,
      createdAt: nowISO(),
      disabled: false,
      pinned: false,
      hidden: false,
      model,
      provider: providerName,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      agentRole,
      metadata: {
        ...(toolResult.metadata ?? {}),
        stream_id: streamId,
        tool_chain: true,
        tool_name: toolName,
        args: toolArgs,
      },
    });
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
    return joinAccumulatedTexts(intermediateTexts, current);
  }

  /**
   * ADR-070 §2.6: статус ответа по данным сохранения. Централизованно, чтобы
   * ни один путь (`_saveAssistantMessage`) не пропустил поле `metadata.status`.
   */
  private _resolveAssistantStatus(
    isCancelled: boolean,
    metadataExtra?: Record<string, unknown>,
  ): AssistantMessageStatus {
    return resolveAssistantStatus(isCancelled, metadataExtra);
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
    /** ADR-070 §2.4: предсказание prompt-cache; cachedTokens/validated — из usage. */
    promptMeta?: PromptMeta,
    /**
     * ADR-070 §2.6: уже посчитанная стоимость сообщения (если вызывающая сторона
     * считала её для события) — избегаем повторного `_computeMessageCost`.
     */
    precomputedCost?: ReturnType<typeof computeUsageCost>,
    /** Шаг 2б: обновить существующий черновик частичного стрима вместо append. */
    existing?: { id: string; seq: number },
  ): Promise<string> {
    return saveAssistantMessage(
      this._persistenceDeps(),
      sessionId,
      content,
      streamId,
      agentRole,
      usage,
      model,
      reasoning,
      debugCollector,
      isCancelled,
      provider,
      role,
      summaryOf,
      skipEvent,
      toolResults,
      intermediateTextBlocks,
      qaPass,
      qaReason,
      metadataExtra,
      promptMeta,
      precomputedCost,
      existing,
    );
  }

  /**
   * Человекочитаемое описание ошибки LLM (таймаут/обрыв соединения, сетевая
   * ошибка). Для остальных ошибок — исходный текст. `i18n` — ключ ADR-041 для
   * metadata (UI локализует сам).
   */
  private _formatLlmError(error: unknown): { text: string; i18n?: ReturnType<typeof i18nMeta> } {
    return formatLlmError(error);
  }

  /** i18n-ключ по типу ошибки (ADR-041) для metadata assistant-сообщения об ошибке. */
  private _errorTypeI18n(errorType: string): ReturnType<typeof i18nMeta> | undefined {
    return errorTypeI18n(errorType);
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
    return handleLlmFailure(sessionId, streamId, error, attempt, ctx, {
      sessionManager: this._sessionManager,
      saveAssistantMessage: this._saveAssistantMessage.bind(this),
    });
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
   * ADR-029: «Разрешить в сессии» (once:false). Если у вызова есть файловые
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

    // ADR-029: «Разрешить в сессии» для сабагентской (дочерней) сессии
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

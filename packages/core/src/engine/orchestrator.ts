import type { Message, Project, Session, ProviderConfig as SharedProviderConfig, TokenUsage, AgentDefinition, PromptMeta, PromptManifest, PromptState, PromptHistoryInfo, PromptToolDetail, ToolsPolicy, ToolsDisabledConfig, McpServerEffective, McpToolDetail, SkillsDisabledRequest, ProfileStore, MessageReceivedKind, SessionWorktree, AttachmentModality, AttachmentFamily, AttachmentsConfig, ModelConfig, MediaPartData, Part, ToolAttachmentRef, ModelCompatibility, LLMReasoningBlock, LlmFinishReason, ReasoningBlock, ContextWindowPolicy } from '@itphx/synth-shared';
import { MessageRole, nowISO, generateId, makeMediaPart, makeTextPart, generateStreamId, stripNullBytes, stripNullBytesDeep, STEER_INTERRUPTED_METADATA_KEY, appendReasoningBlock, attachmentsConfigSchema, appendMediaPlaceholders, mediaTypeOfMime, effortForReasoningLevel, nativeAudioFormatForMime } from '@itphx/synth-shared';
import type { RouterConfig, PermissionConfig, PermissionRule, PlanMode, SessionMode, SecurityConfig, LLMGatewayConfig, ReasoningLevel, PermissionDecision, PermissionPreview, Currency, InstructionsConfig, WorkspaceOutsideRootPolicy, DecisionConfig } from '@itphx/synth-shared';
import type { AutoTitleConfig } from '@itphx/synth-shared/config';
import { autoTitleConfigSchema } from '@itphx/synth-shared/config';
import { autoTitleSession } from '../sessions/auto-title.js';
import { join, isAbsolute, normalize, resolve } from 'node:path';
import { mkdir, stat } from 'node:fs/promises';
import type { SessionManager } from '../sessions/manager.js';
import type { EventBus } from '../events/bus.js';
import { DebugCollector } from '../debug.js';

import { computeUsageCost } from '../providers/usage.js';
import type { UsageCostBreakdown } from '../providers/usage.js';

import type { LLMMessage, LLMAttachment, CancellationToken, BaseProvider, SystemPromptPayload, CachePolicy } from '../providers/base.js';
import { ProviderFactory, resolveProviderCompatibility, buildChatOptions } from '../providers/base.js';
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
import { checkContextWindowWindow } from './context/window-guard.js';
import { DEFAULT_SUBAGENT_MAX_INPUT_TOKENS, DEFAULT_SUBAGENT_DEPTH } from '@itphx/synth-shared/config';
import { agentKeyOf } from './context/prompt-state.js';
import { createStateMessage, findLastStateMessage, buildModeChangeContent, buildPlanUpdatedContent, wrapStateContent, type UnavailableTool } from './context/state-messages.js';
import { toLlmReasoningBlocks, makeReasoningParts, type ReasoningBlockLike } from './reasoning-blocks.js';
import type { ToolRegistry } from './tools/registry.js';
import type { AutomationRuntime } from './tools/automation-runtime.js';
import type { AgentRegistry } from './agents/registry.js';
import { DEFAULT_AGENT_ID, resolveAgentRoleAlias } from './agents/index.js';
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
import { buildPermissionPreview } from './permission/preview.js';
import { emptyPermissionConfig } from './permission/derive.js';
import { createFileStorage } from '../storage/storage-context.js';
import type { SSHKeyRepository } from '../storage/ports/ssh-key-repository.js';
import type { ProjectStoreLike } from '../storage/project-store.js';
import { GitService } from '../git/git-service.js';
import { MAX_DOOM_LOOP_COUNT } from './llm-error.js';
// Финальный шаг по лимиту шагов (общая механика opencode с циклом саб-агента):
// инструкция «только текст» — assistant-сообщением в запрос.
import { buildMaxStepsPrompt, maxStepsAssistantMessage } from './llm/max-steps.js';
import { WorktreeDirectoryMissingError } from './worktree/errors.js';
import type { WorktreeService } from './worktree/service.js';
// ADR-115: гидратация вложений сообщений (blob → base64) перед LLM-вызовом.
import { createHydrateDeps, hydrateMessageAttachments, type DroppedAttachmentRef, type HydrateDeps, type HydrateOptions } from './attachments/hydrate.js';
import { deriveModalityText, deriveVideoAudioText, type DeriveDeps } from './attachments/derive.js';
import { AttachmentCompressor, resolveCompressTarget, type AttachmentCompressTarget } from './attachments/compress.js';
import { createMediaRunner } from './media/runner.js';
import { materializeAttachment } from './attachments/materialize.js';
import { AttachmentService, isAttachmentPath } from './attachments/service.js';
import { serializeMessage, serializeSession } from '../server/serialize.js';
import { stripMetadata } from './attachments/strip-metadata.js';
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

import { ALL_RUNTIME_DEPS_AVAILABLE, RUNTIME_DEP_BINARY, TOOL_RUNTIME_DEP, isFfmpegAvailable, refreshRuntimeDeps, type RuntimeDeps } from './tools/runtime-deps.js';
import { InlineExecutionPort } from '../execution/inline-execution-port.js';
import type { ExecutionPort } from '../execution/ports/index.js';
import { getToolTrust } from './security/trust.js';
import { detectPromptInjection, applyPolicy, wrapContent, buildWarnLine, type InjectionPolicy } from './security/prompt-injection.js';
import { loadProtectedPaths } from './security/protected-paths.js';
import type { ProtectedPathsPolicy } from './security/protected-paths.js';
import { shellSavePatterns } from './security/shell-guard.js';
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
import { computeMessageCost, resolveMessageModel, estimateUsage, estimatePromptChars as estimatePromptCharsFn, aggregateSubagentStats, addTokenUsage } from './orchestrator/usage.js';
import { recordAuxUsage, type AuxUsageInput } from './usage-accounting.js';
import { publishFsChange } from './orchestrator/fs-change.js';
import { applySteerInjections } from './steering/apply.js';
import type { SteerRequeueResult } from './steering/apply.js';
import { saveAssistantMessage, getAssistantSecrets, resolveAssistantStatus, hasVisibleStepContent, type SaveAssistantMessageDeps, type AssistantMessageStatus, type AssistantMessageStep, type ExistingMessageRef } from './orchestrator/persistence.js';
import { StreamMessageDraft, type StreamMessageRef } from './orchestrator/stream-persistence.js';
import { StreamTiming } from './orchestrator/stream-stats.js';
// ADR-118 §1/§4: единая точка публикации `turn.*`/`step.*`/`part.*` и
// детерминированных идентификаторов частей (`msg:text:N`, `callId`).
import {
  publishPartDelta,
  publishPartUpdated,
  publishStepFinished,
  publishStepStarted,
  publishStepToolsFinished,
  publishStepToolsStarted,
  publishTurnFinished,
  publishTurnStarted,
  reasoningPartId,
  textPartId,
  toolCallPart,
  toolCallPartId,
  liveStepParts,
} from './orchestrator/turn-events.js';
import { setLiveStreamSnapshot } from './live-stream-snapshot.js';
import { formatLlmError, errorTypeI18n, handleLlmFailure, type LlmFailureContext } from './orchestrator/errors.js';
import {
  createCompressionSummarySaver,
  forceCompression,
  type ForceCompressionResult,
} from './orchestrator/compression.js';
import { buildOverflowRetryMessages } from './orchestrator/overflow.js';
import { classifyLlmError } from './llm-error.js';
import { resolveModelContextWindow, getEffectiveModel, wrapWithGateway, getProvider, routeProvider, type ProviderOverrides, type RouteProviderDeps } from './orchestrator/routing.js';
import { DEFAULT_MAX_OUTPUT_TOKENS, resolveMaxOutputTokens } from './orchestrator/max-output.js';
import { ContextLengthExceededError } from '../providers/exceptions.js';
import { sessionMessagesToLlm as sessionMessagesToLlmFn, buildPromptHistoryInfo as buildPromptHistoryInfoFn, lastPromptMeta as lastPromptMetaFn, instructionsMemoKey as instructionsMemoKeyFn, resolveTurnQuery as resolveTurnQueryFn, type CurrentModelPair } from './orchestrator/prompt-info.js';
import { publishLocalCompletion as publishLocalCompletionFn, finishLocalCommand as finishLocalCommandFn, type FinishLocalCommandDeps } from './orchestrator/commands.js';
import { handleDebugSystemMessage as handleDebugSystemMessageFn, type DebugSystemMessageDeps } from './orchestrator/debug.js';
import { handleSummarization as handleSummarizationFn, type SummarizationDeps } from './orchestrator/summarization.js';
import { runProcessEarly, type ProcessEarlyDeps } from './orchestrator/phases/process-early.js';
import { runProcessFinalize, type ProcessFinalizeDeps } from './orchestrator/phases/process-finalize.js';
import { runProcessSetup, withoutMemoryPluginTools, type ProcessSetupDeps, type MemoryContextEntry } from './orchestrator/phases/process-setup.js';
import type { AnalyticsRecorder } from '../analytics/recorder.js';
import { toCoreProviderConfig } from './router/index.js';

const DEFAULT_MAX_ITERATIONS = Number.POSITIVE_INFINITY;
/**
 * Порог одинаковых deny-вызовов подряд, после которого ход завершается
 * (deny не обрывает ход, но и бесконечно повторяться не должен).
 */
const MAX_REPEATED_DENY_COUNT = 5;
/** Порог заполненности контекстного окна (%), после которого публикуем context.limit_warning. */
const CONTEXT_LIMIT_WARNING_PERCENT = 90;

/**
 * ADR-115 §«Медиа из инструментов»: сколько вложений тулов вставляется в ход.
 *
 * Предел защищает контекст: один `web_fetch` по пяти URL или MCP-сервер с
 * десятком скриншотов не должен раздувать промпт. Лишние ссылки отбрасываются
 * с логом — модель всё равно видит текст результата тула.
 */
const MAX_TOOL_ATTACHMENTS_PER_TURN = 4;
/**
 * ADR-115 §«Медиа из инструментов»: бюджет инъекции, если
 * `attachments.maxBytesPerMessage` не задан (20 МиБ — как общий предел
 * base64-вложений запроса, `MAX_ATTACHMENT_BASE64_BYTES`).
 */
const DEFAULT_TOOL_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;
/** `sha256` ссылки на объект: ровно 64 hex-символа (content-addressed адрес). */
const TOOL_ATTACHMENT_SHA256_RE = /^[0-9a-f]{64}$/;

/**
 * ADR-115 §«Медиа из инструментов»: проверка ссылки, которую вернул тул.
 *
 * Недоверенный ввод (MCP-сервер/плагин/веб-контент): `blobPath` обязан быть
 * объектом вложений (`attachments/`, без `..`), `sha256` — 64 hex, `mime`
 * непустой, `size` > 0. Иначе ссылка отбрасывается — иначе тул мог бы подсунуть
 * модели произвольный blob (лог процесса, артефакт, чужой объект).
 */
function isToolAttachmentRefValid(ref: ToolAttachmentRef): boolean {
  if (!ref || typeof ref !== 'object') return false;
  if (typeof ref.blobPath !== 'string' || !isAttachmentPath(ref.blobPath)) return false;
  if (typeof ref.sha256 !== 'string' || !TOOL_ATTACHMENT_SHA256_RE.test(ref.sha256)) return false;
  if (typeof ref.mime !== 'string' || ref.mime.trim() === '') return false;
  if (typeof ref.size !== 'number' || !Number.isFinite(ref.size) || ref.size <= 0) return false;
  if (ref.name !== undefined && typeof ref.name !== 'string') return false;
  return true;
}

/**
 * Периметр файловых/shell/git-тулов сессии: рабочий каталог **или** корень
 * проекта.
 *
 * Зачем: сессия, привязанная к git-worktree (ADR-114), работает в каталоге
 * worktree, а основной checkout проекта (`project.workspace`) лежит вне его —
 * но остаётся «своим» (как в opencode: `FileAccess.resolve` считает internal
 * и `location.directory`, и project worktree). Иначе агент в worktree не мог бы
 * прочитать файл основной копии без подтверждения на каждый путь.
 *
 * Возвращает `undefined`, когда дополнительный корень не нужен или дублирует
 * `workingDir` (обычная сессия без worktree — поведение не меняется).
 */
function resolveAllowedRoots(workingDir: string, projectRoot: string | null): string[] | undefined {
  if (!projectRoot) return undefined;
  const root = normalize(projectRoot);
  if (root === normalize(workingDir)) return undefined;
  return [root];
}

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
  /**
   * Аудит выдачи сессионных shell-грантов (паттерны команд). Вызывается
   * fire-and-forget; ошибка не влияет на ход.
   */
  onPermissionGrant?: (entry: {
    sessionId: string;
    actor: string;
    patterns: string[];
    command: string;
  }) => void | Promise<void>;
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
   * Совместимость протокола по каталогу: слияние `provider.compatibility` и
   * `model.compatibility` (включая shorthand `requiresReasoning`).
   * `undefined` — явных значений нет, работают эвристики провайдера
   * (deepseek/mistral/Ollama). Резолвер задаёт точка сборки по кешам.
   */
  resolveModelCompatibility?: (providerName: string, modelId: string) => ModelCompatibility | undefined;
  /**
   * Лимит вывода модели из каталога (`ModelConfig.maxOutputTokens`).
   * `undefined`/`0` — неизвестен: резолв идёт по сессии/конфигу/дефолту.
   */
  resolveModelMaxOutputTokens?: (providerName: string, modelId: string) => number | undefined;
  /**
   * Доступность провайдера по каталогу (`disabled` — отключён администратором).
   * Используется подготовкой хода, чтобы вернуть понятную ошибку
   * `provider_disabled` вместо `provider_not_found`.
   */
  providerAvailability?: (name: string) => 'ok' | 'missing' | 'disabled';
  /**
   * Включена ли модель по каталогу (`false` — отключена). `undefined` —
   * записи нет/неизвестно, не блокируем.
   */
  resolveModelEnabled?: (providerName: string, modelId: string) => boolean | undefined;
  /**
   * `llm.maxTokens` — лимит вывода по умолчанию для новых сессий и моделей
   * без `maxOutputTokens`. Не задан — `DEFAULT_MAX_OUTPUT_TOKENS`.
   */
  defaultMaxOutputTokens?: number;
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
   * Политика ограничения контекстного окна (`context.windowPolicy`,
   * `off` | `warn` | `enforce`). Live-getter: читается **перед каждым**
   * LLM-вызовом основного цикла (изменение в админке применяется без
   * рестарта). Не задан — `warn` (сервер только предупреждает).
   *
   * `enforce` блокирует вызов, если оценка промпта не влезает в окно модели
   * за вычетом резерва на вывод; окно неизвестно (`0`) — блокировки нет.
   */
  contextWindowPolicy?: () => ContextWindowPolicy;
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
   * ADR-076: таймауты сетевых git-операций (`git.cloneTimeoutMs`/
   * `git.fetchTimeoutMs`) для git-сервиса по умолчанию. Не заданы — дефолт
   * сервиса (5 минут); `0` — без таймаута. `gitService` приоритетнее.
   */
  gitCloneTimeoutMs?: number;
  gitFetchTimeoutMs?: number;
  /**
   * Предел локальных изменяющих git-операций тулов (`git_commit`/`git_checkout`/
   * `git_stash`), мс. Не задан — дефолт тула (2 минуты); `0` — без таймаута.
   */
  gitLocalTimeoutMs?: number;
  /**
   * Предел сетевых git-операций тулов (`git_push`/`git_pull`), мс. Не задан —
   * дефолт тула (5 минут); `0` — без таймаута.
   */
  gitNetworkTimeoutMs?: number;
  /**
   * Общий предел вывода инструментов (`tools.outputMaxLines`/
   * `tools.outputMaxBytes`): результат тула длиннее лимита усекается с
   * пояснением «показано N из M строк». Не задан — дефолт секции `tools`
   * (2000 строк / 51200 байт).
   */
  toolOutputLimits?: { maxLines: number; maxBytes: number };
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
  /**
   * Секция `session.autoTitle` из config.yaml — авто-именование сессии
   * (генерация заголовка по первому сообщению/диалогу). Не задана — дефолты
   * схемы (включено, отсрочка на приветствии, 2 попытки).
   */
  autoTitle?: AutoTitleConfig;
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
   * ADR-104 × ADR-111/ADR-113: вернуть в очередь **все** сообщения, оставшиеся
   * в steer-очереди к концу хода (ни пользовательский ввод, ни уведомления
   * фоновых прогонов теряться не должны). `opts.autostart` — поднять ли ход:
   * обычное завершение — да, «Стоп» — нет.
   * Не задан — возврат в `pendingMessages` без автозапуска.
   */
  requeueSteerMessages?: (
    sessionId: string,
    messages: Message[],
    opts: { autostart: boolean },
  ) => Promise<SteerRequeueResult | void>;
  /**
   * Этап 1 roadmap 0.13 (блок 4): фоновые прогоны разрешены инстансом
   * (`background.enabled`). `false` — тул `task` с `background: true`
   * отказывает (`task.background_disabled`). По умолчанию — разрешены.
   */
  backgroundEnabled?: boolean;
  /**
   * Предохранитель по объёму промпта саб-агента (`agents.subagentMaxInputTokens`):
   * оценка промпта проверяется перед каждым LLM-вызовом, при превышении прогон
   * завершается детерминированным отчётом. `0` — без ограничения; не задано —
   * дефолт секции `agents` (`DEFAULT_SUBAGENT_MAX_INPUT_TOKENS`).
   */
  subagentMaxInputTokens?: number;
  /**
   * Live-геттер предохранителя `agents.subagentMaxInputTokens` (runtime-настройка
   * инстанса). Приоритетнее `subagentMaxInputTokens`; читается при сборке
   * `task` extra — изменения из UI применяются к следующим прогонам без рестарта.
   */
  getSubagentMaxInputTokens?: () => number;
  /**
   * Лимит глубины вложенности саб-агентов (`agents.subagentDepth`): глубина
   * считается по цепочке `parentId` сессий (текущая — 0, родитель — 1, …).
   * При превышении тул `task` отказывает до создания дочерней сессии.
   * `0` — без ограничения; не задано — дефолт секции `agents`
   * (`DEFAULT_SUBAGENT_DEPTH`).
   */
  subagentDepth?: number;
  /**
   * PROP-097 (блок 5b): сервис фоновых шелл-процессов.
   *
   * Не задан — тул `execute_shell` с `background: true` отказывает
   * (`process.deps_unavailable`).
   */
  processService?: ProcessService;
  /**
   * ADR-115: порт учёта ссылок на объекты blob-хранилища (`StorageContext.blobRefs`).
   *
   * Нужен инъекции вложений из `ToolResult.attachments`: сообщение хода
   * ссылается на объект, и без записи ссылки GC счёл бы объект сиротой по TTL.
   * Не задан — ссылка не пишется (best-effort, вложение работает).
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
  /**
   * Роли, для которых уже предупреждали о фоллбеке на агента по умолчанию
   * (`_resolveAgentDefinition`): у старых сессий `settings.agentRole` может
   * ссылаться на удалённую роль (алиасы прежнего набора — `pm` → `leader` —
   * сюда не попадают: они резолвятся штатно), и предупреждение не должно
   * литься в лог на каждом ходе.
   */
  private readonly _warnedUnknownAgentRoles = new Set<string>();
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
  /** Таймауты git-тулов по классу операции (ADR-076; `undefined` — дефолт тула). */
  private readonly _gitLocalTimeoutMs: number | undefined;
  private readonly _gitNetworkTimeoutMs: number | undefined;
  /** Общий предел вывода тулов (`tools.outputMaxLines`/`tools.outputMaxBytes`). */
  private readonly _toolOutputLimits: { maxLines: number; maxBytes: number } | undefined;
  private readonly _workspaceManaged: boolean;
  private readonly _getWorkspaceOutsideRootPolicy:
    | (() => WorkspaceOutsideRootPolicy | Promise<WorkspaceOutsideRootPolicy>)
    | null;
  private readonly _composer: SystemPromptComposer;
  private readonly _defaultWorkingDir: string;
  private readonly _workspacesRoot: string;
  private _permissionConfig: PermissionConfig;
  /** Аудит выдачи shell-грантов (опция оркестратора). */
  private readonly _onPermissionGrant: OrchestratorOptions['onPermissionGrant'] | null;
  private readonly _approvalManager: PermissionApprovalManager;
  private readonly _defaultPlanMode: PlanMode;
  /**
   * Секция `session.autoTitle` — авто-именование сессии (ранний триггер:
   * сразу после подготовки запроса, до `turn.started`).
   */
  private readonly _autoTitle: AutoTitleConfig;
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
   * Совместимость протокола по каталогу (provider+model); `undefined` —
   * автоопределение в провайдере эвристиками.
   */
  private readonly _resolveModelCompatibility: ((providerName: string, modelId: string) => ModelCompatibility | undefined) | null;
  /** Лимит вывода модели из каталога (`ModelConfig.maxOutputTokens`). */
  private readonly _resolveModelMaxOutputTokens: ((providerName: string, modelId: string) => number | undefined) | null;
  /** Доступность провайдера по каталогу (`disabled` — отключён). */
  private readonly _providerAvailability: ((name: string) => 'ok' | 'missing' | 'disabled') | null;
  /** Включённость модели по каталогу (`false` — отключена). */
  private readonly _resolveModelEnabled: ((providerName: string, modelId: string) => boolean | undefined) | null;
  /** `llm.maxTokens` — дефолт лимита вывода (`0`/не задан — константа ядра). */
  private readonly _defaultMaxOutputTokens: number;
  /**
   * ADR-115: live-конфиг вложений (runtime-настройки поверх config).
   * `undefined` — резолвер не задан: `workspaceFallback` считается включённым
   * (поведение по умолчанию), материализация отброшенных вложений выполняется.
   */
  private readonly _attachmentsConfig?: () => AttachmentsConfig;
  /**
   * Политика ограничения контекстного окна (live). `undefined` — `warn`
   * (сервер только предупреждает, блокировки нет).
   */
  private readonly _contextWindowPolicy?: () => ContextWindowPolicy;
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
   * ADR-104 × ADR-111/ADR-113: возврат остатка steer-очереди в обычную очередь
   * (ни ввод пользователя, ни уведомления фоновых прогонов не теряются).
   * `null` — не задан (локальный возврат без автозапуска).
   */
  private readonly _requeueSteerMessages:
    ((sessionId: string, messages: Message[], opts: { autostart: boolean }) => Promise<SteerRequeueResult | void>) | null;
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
  /** Предохранитель по объёму промпта саб-агента (0 — без ограничения). */
  private readonly _subagentMaxInputTokens: number;
  private readonly _getSubagentMaxInputTokens?: () => number;
  /** Лимит глубины вложенности саб-агентов (0 — без ограничения). */
  private readonly _subagentDepth: number;
  /**
   * PROP-097 (блок 5b): сервис фоновых шелл-процессов (null — не задан:
   * режим `background: true` у `execute_shell` недоступен).
   */
  private readonly _processService: ProcessService | null;
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
   * ADR-115: blob-порт для обработки вложения aux-моделью (кэш результата и
   * производные объекты). Тот же порт, что у гидратации; фоллбэк по `dataDir`
   * создаётся один раз.
   */
  private _attachmentBlobs: BlobStore | null = null;
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
   * Эффективная роль агента с учётом алиасов прежнего набора ролей.
   *
   * У старых сессий `settings.agentRole` может хранить id роли, которой в
   * текущем наборе нет (`pm`, `developer`, `qa`, `analyst`, `auditor`): набор
   * заменён на `leader`/`fixer`/`tester`/`researcher`/`security-auditor`, но
   * метка в сессии историческая и не переписывается. Правило:
   *  - роль не задана — как есть;
   *  - реестр знает роль — как есть;
   *  - иначе алиас (`pm` → `leader`) существует и целевой агент есть в
   *    реестре — возвращается алиас (промпт, capabilities, лимиты — целевого
   *    агента);
   *  - иначе исходная роль: дальше сработает прежний фоллбек `assistant`
   *    (`_resolveAgentDefinition` с предупреждением).
   */
  private _resolveEffectiveAgentRole(agentRole: string | undefined): string | undefined {
    if (!agentRole || !this._agentRegistry) return agentRole;
    if (this._agentRegistry.get(agentRole)) return agentRole;
    const alias = resolveAgentRoleAlias(agentRole);
    if (alias && this._agentRegistry.get(alias)) return alias;
    return agentRole;
  }

  /**
   * Определение агента по роли с фоллбеком на агента по умолчанию.
   *
   * В инстансах с историей `settings.agentRole` может ссылаться на роль,
   * которой больше нет в наборе (например, удалённая роль из прежнего набора
   * `pm`/`developer`/`qa`/…). Сначала пробуется алиас прежней роли
   * (`resolveAgentRoleAlias`: `pm` → `leader`), и только если его нет в
   * реестре — **определение агента по умолчанию** (`DEFAULT_AGENT_ID` —
   * `assistant`) с предупреждением в лог. Ход не должен ни падать, ни
   * оставаться без ограничений роли (иначе неизвестная роль = «агент без
   * ограничений», fail-open). Строка `effectiveAgentRole` при фоллбеке остаётся
   * прежней (attribution, аналитика, `promptStates` — историческая метка).
   *
   * Предупреждение печатается один раз на роль за жизнь процесса (см.
   * `_warnedUnknownAgentRoles`), иначе старые сессии писали бы его на каждом ходе.
   * Без реестра агентов фоллбека нет — поведение прежнее (`undefined`).
   */
  private _resolveAgentDefinition(agentRole: string | undefined): AgentDefinition | undefined {
    if (!agentRole || !this._agentRegistry) return undefined;
    const found = this._agentRegistry.get(agentRole);
    if (found) return found;
    // Алиас прежней роли: не ошибка и не повод для предупреждения.
    const alias = resolveAgentRoleAlias(agentRole);
    if (alias) {
      const aliased = this._agentRegistry.get(alias);
      if (aliased) return aliased;
    }
    if (!this._warnedUnknownAgentRoles.has(agentRole)) {
      this._warnedUnknownAgentRoles.add(agentRole);
      warning(
        'AGENTS',
        `Неизвестная роль агента «${agentRole}» — используется роль по умолчанию «${DEFAULT_AGENT_ID}»`,
      );
    }
    return this._agentRegistry.get(DEFAULT_AGENT_ID);
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
   * ADR-118 §4: live-публикация расхода шага удалена вместе с `stream.usage` —
   * расход несёт `step.finished` (usage/модель/стоимость шага), а метрики
   * (`synth_llm_cost_total`) читают его оттуда.
   */

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

  /**
   * ADR-029 (аддитивно): превью изменений для запроса подтверждения —
   * unified diff по файлам, которые тул собирается изменить
   * (`write_file`/`edit_file`/`patch`).
   *
   * Считается «по возможности»: бинарный/огромный файл, неоднозначная правка
   * или сбой расчёта → превью просто отсутствует, запрос подтверждения от
   * этого не ломается. Секреты в диффе маскируются плейсхолдерами карты
   * обфускации сессии (ADR-036).
   */
  private async _buildPermissionPreview(
    toolName: string,
    args: Record<string, unknown>,
    workingDir: string,
    sessionId: string,
  ): Promise<PermissionPreview | undefined> {
    try {
      const secretsMap = await this._getObfuscationMap(sessionId);
      return await buildPermissionPreview({ toolName, args, workingDir, secretsMap });
    } catch {
      return undefined;
    }
  }

  /** Карта обфускации сессии (ADR-036): плейсхолдер → реальное значение. */
  private async _getObfuscationMap(sessionId: string): Promise<Record<string, string>> {
    try {
      const store = this._obfMapStore ?? new ObfuscationMapStore(this._sessionManager);
      return await store.get(sessionId);
    } catch {
      return {};
    }
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
      options.gitService
      ?? new GitService(this._workspacesRoot, {
        execution: this._executionPort,
        ...(options.gitCloneTimeoutMs !== undefined ? { cloneTimeoutMs: options.gitCloneTimeoutMs } : {}),
        ...(options.gitFetchTimeoutMs !== undefined ? { fetchTimeoutMs: options.gitFetchTimeoutMs } : {}),
      });
    // ADR-076: таймауты git-тулов по классу операции (локальные/сетевые) —
    // в `extra` тулов; не заданы — дефолт тула.
    this._gitLocalTimeoutMs = options.gitLocalTimeoutMs;
    this._gitNetworkTimeoutMs = options.gitNetworkTimeoutMs;
    // Общий предел вывода тулов (`tools.outputMaxLines`/`tools.outputMaxBytes`) —
    // в `extra` тулов; не задан — дефолт секции `tools`.
    this._toolOutputLimits = options.toolOutputLimits;
    this._workspaceManaged = options.workspaceManaged === true;
    this._getWorkspaceOutsideRootPolicy = options.getWorkspaceOutsideRootPolicy ?? null;
    this._permissionConfig = options.permissionConfig ?? emptyPermissionConfig();
    this._onPermissionGrant = options.onPermissionGrant ?? null;
    this._approvalManager = new PermissionApprovalManager(this._eventBus, {
      ...(options.approvalRegistry ? { registry: options.approvalRegistry } : {}),
    });
    this._defaultPlanMode = options.defaultPlanMode ?? 'auto';
    // Авто-именование сессии: конфиг секции `session.autoTitle` (дефолты схемы).
    this._autoTitle = options.autoTitle ?? autoTitleConfigSchema.parse({});
    this._securityConfig = options.securityConfig
      ?? { promptInjection: { enabled: true, wrapContent: true, mode: 'flag' }, protectedPaths: { enabled: true }, secretKey: '' };
    this._dataDir = options.dataDir || '/var/synth/data';
    // ADR-115/ADR-116: в проде blob-порт приходит инъекцией
    // (`StorageContext.blobs`); фоллбэк для тестов — в `_getAttachmentHydrateDeps`.
    this._blobs = options.blobs ?? null;
    // ADR-115: модальности из конфига модели приоритетнее справочника.
    this._resolveModalities = options.resolveModelModalities ?? null;
    // Совместимость протокола (provider+model) из каталога.
    this._resolveModelCompatibility = options.resolveModelCompatibility ?? null;
    // Лимит вывода: каталог модели (он же кап) и конфиг `llm.maxTokens`.
    this._resolveModelMaxOutputTokens = options.resolveModelMaxOutputTokens ?? null;
    this._providerAvailability = options.providerAvailability ?? null;
    this._resolveModelEnabled = options.resolveModelEnabled ?? null;
    this._defaultMaxOutputTokens = options.defaultMaxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    // ADR-115: live-конфиг вложений — проверяется на каждый ход в
    // `_processSetupDeps().hydrateAttachments` (без рестарта).
    if (options.attachmentsConfig) this._attachmentsConfig = options.attachmentsConfig;
    // Политика контекстного окна — live-геттер (читается перед каждым LLM-вызовом).
    if (options.contextWindowPolicy) this._contextWindowPolicy = options.contextWindowPolicy;
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
    this._requeueSteerMessages = options.requeueSteerMessages ?? null;
    this._backgroundEnabled = options.backgroundEnabled ?? true;
    this._subagentMaxInputTokens = options.subagentMaxInputTokens ?? DEFAULT_SUBAGENT_MAX_INPUT_TOKENS;
    this._getSubagentMaxInputTokens = options.getSubagentMaxInputTokens;
    this._subagentDepth = options.subagentDepth ?? DEFAULT_SUBAGENT_DEPTH;
    // PROP-097 (блок 5b): сервис фоновых шелл-процессов.
    this._processService = options.processService ?? null;
    // ADR-114: сервис worktree'ов (тулы `git_worktree_*`).
    this._worktreeService = options.worktreeService ?? null;
    // ADR-115: порт ссылок на blob-объекты (инъекция вложений тулов).
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
    // ADR-094/ADR-119: обвязка ставится **всегда**; при выключенном gateway —
    // disabled-конфиг (passthrough, но учёт вызовов и общий контур фильтров).
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
      options.resolveModelCompatibility,
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
   * ADR-036/ADR-119: gateway-обвязка суммаризации. Задаётся **всегда**
   * (инвариант 3: любой LLM-вызов — через `GatewayProvider`): при выключенном
   * gateway берётся `DISABLED_GATEWAY_CONFIG` — вызов идёт passthrough
   * (guard/обфускация no-op), но учитывается метриками и виден фильтрам при
   * включении gateway. `AuditLogger` ленив: файл создаётся только при записи,
   * а при `enabled:false` записей нет.
   */
  private _optimizerGatewayHooks(): ContextOptimizerGatewayHooks {
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
    /** Корень проекта (`project.workspace`, абсолютный) — блок `session.info` (ADR-114). */
    projectRoot?: string | null;
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
      session, agentDef, effectiveAgentRole, workingDir, projectRoot, language, summaryContent,
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
      // ADR-114: корень проекта — в `session.info` рядом с рабочим каталогом
      // сессии, если сессия работает в worktree.
      ...(projectRoot ? { projectRoot } : {}),
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
    /** ADR-114: периметр сессии (рабочий каталог + корень проекта). */
    allowedRoots?: readonly string[];
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
    const { session, message, signal, publishChunk, debugCollector, streamId, effectiveAgentRole, workingDir, allowedRoots, permissionEvaluator, sessionMode, planMode, planApproved, attempt, authorityTurn } = args;
    const input = (message.content ?? '').trim();
    if (!input.startsWith('/')) return null;

    const agentDef = this._resolveAgentDefinition(effectiveAgentRole);
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
        // ADR-114: тот же периметр, что у обычных тулов (worktree + корень проекта).
        ...(allowedRoots ? { allowedRoots } : {}),
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
      recordAuxUsage: (input) => this._recordAuxUsage(input),
      computeMessageCost: (model, usage) => this._computeMessageCost(model, usage),
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
   * ADR-115 §«Медиа из инструментов»: вставить медиа-результаты тулов итерации
   * в **текущий** ход.
   *
   * Тул возвращает ссылки (`ToolResult.attachments`), а не байты. Каждая
   * ссылка становится отдельной user-репликой (`author: 'Tool'`,
   * `metadata.source: 'tool-attachment'`, при известной роли —
   * `metadata.agent_role`), которая:
   *  - персистится в историю (`addMessage`) и публикуется (`message.added`,
   *    `session.updated`) — чат UI видит вложение сразу;
   *  - учитывается в `blob_refs` (`ownerKind: 'message'`) — иначе GC счёл бы
   *    объект сиротой (best-effort);
   *  - маппится в LLM-сообщение и **точечно** гидратируется теми же
   *    настройками, что и история (`modalities`/`derive`/`materialize`/язык),
   *    затем дописывается в `currentMessages` **после** tool-результатов.
   *
   * Порядок обязателен: assistant(tool_use) → tool(tool_result) → user(media).
   * Anthropic собирает все tool_result итерации в одно user-сообщение, поэтому
   * media-реплика идёт отдельным сообщением строго после буфера — пары
   * `tool_use`/`tool_result` не рвутся.
   *
   * Сообщение — **служебное** (`isServiceUserMessage`): не реплика человека для
   * авто-заголовка, не граница автора в статистике и не граница хода в
   * `suppressDisabledTurns`. В UI оно рисуется системным блоком с подписью
   * «Агент · <имя> · вложение» (ADR-115), а не user-пузырём: `author: 'Tool'` —
   * системный актор, имя агента передаётся в `metadata.agent_role`.
   */
  private async _injectToolAttachments(args: {
    session: Session;
    /** Все tool-вызовы хода (фильтруются по `iteration`). */
    toolCalls: Array<Record<string, unknown>>;
    iteration: number;
    currentMessages: LLMMessage[];
    providerName: string;
    modelId: string;
    language: string;
    workingDir: string;
    workspaceReady: boolean;
    agentRole?: string;
    author?: string;
    publishChunk: (event: string, data: Record<string, unknown>) => void;
  }): Promise<void> {
    const config = this._attachmentsConfig?.() ?? attachmentsConfigSchema.parse({});
    const maxBytes = config.maxBytesPerMessage ?? DEFAULT_TOOL_ATTACHMENT_MAX_BYTES;
    const picked: Array<{ ref: ToolAttachmentRef; tool: string; callId: string }> = [];
    const seen = new Set<string>();
    let totalBytes = 0;

    // Сбор — в порядке tool-результатов итерации; дубли по `blobPath` схлопываются
    // (один и тот же объект из двух тулов — одно вложение), бюджет хода общий.
    for (const call of args.toolCalls) {
      if (call.iteration !== args.iteration) continue;
      const result = call.result as { attachments?: unknown; isError?: boolean } | undefined;
      // Ошибка тула — вложений не берём: результат не считается доставленным.
      if (!result || result.isError === true) continue;
      if (!Array.isArray(result.attachments)) continue;
      for (const ref of result.attachments as ToolAttachmentRef[]) {
        if (!isToolAttachmentRefValid(ref)) {
          warning(
            'ATTACHMENTS',
            `вложение тула ${String(call.name ?? '?')} отброшено: невалидная ссылка `
            + `(${JSON.stringify({ blobPath: ref?.blobPath, mime: ref?.mime, size: ref?.size })})`,
          );
          continue;
        }
        if (seen.has(ref.blobPath)) continue;
        if (picked.length >= MAX_TOOL_ATTACHMENTS_PER_TURN) {
          warning(
            'ATTACHMENTS',
            `вложение ${ref.blobPath} отброшено: предел ${MAX_TOOL_ATTACHMENTS_PER_TURN} вложений тулов за ход`,
          );
          continue;
        }
        if (totalBytes + ref.size > maxBytes) {
          warning(
            'ATTACHMENTS',
            `вложение ${ref.blobPath} отброшено: бюджет хода ${maxBytes} Б превышен `
            + `(уже ${totalBytes} Б + ${ref.size} Б)`,
          );
          continue;
        }
        seen.add(ref.blobPath);
        totalBytes += ref.size;
        picked.push({ ref, tool: String(call.name ?? ''), callId: String(call.id ?? '') });
      }
    }
    if (picked.length === 0) return;

    // Гидратация — тот же шов, что у истории (`_processSetupDeps`): модальности
    // модели хода, aux-модели семейств, материализация в workspace, язык.
    const hydrate = this._processSetupDeps(args.session).hydrateAttachments;

    for (const item of picked) {
      const { ref } = item;
      try {
        const data: MediaPartData = {
          blobPath: ref.blobPath,
          sha256: ref.sha256,
          mime: ref.mime,
          size: ref.size,
          ...(ref.name ? { name: ref.name } : {}),
        };
        const parts = [makeMediaPart(mediaTypeOfMime(ref.mime), data)];
        const message: Message = {
          id: generateId(),
          role: MessageRole.USER,
          seq: 0,
          origin: 'local',
          parts,
          content: appendMediaPlaceholders('', parts),
          createdAt: nowISO(),
          disabled: false,
          pinned: false,
          hidden: false,
          author: 'Tool',
          metadata: {
            source: 'tool-attachment',
            tool: item.tool,
            call_id: item.callId,
            ...(args.agentRole ? { agent_role: args.agentRole } : {}),
          },
        };

        const updated = await this._sessionManager.addMessage(args.session.id, message);
        if (updated) {
          const index = updated.messages.length - 1;
          args.publishChunk('message.added', {
            message: serializeMessage(updated.messages[index]!, index),
            index,
          });
          args.publishChunk('session.updated', serializeSession(updated));
        }
        // Учёт ссылки: без него GC удалил бы объект по TTL, хотя сообщение на
        // него ссылается. Best-effort — вложение уже в истории.
        if (this._blobRefs) {
          try {
            await this._blobRefs.add({
              blobPath: ref.blobPath,
              ownerKind: 'message',
              ownerId: message.id,
            });
          } catch {
            // учёт ссылок — производная: не отменяет вложение и не роняет ход
          }
        }

        const llm = sessionMessagesToLlmFn([message], args.agentRole, args.author, {
          provider: args.providerName,
          model: args.modelId,
        });
        let hydrated = llm;
        if (hydrate) {
          try {
            hydrated = await hydrate(llm, [message], {
              providerName: args.providerName,
              modelId: args.modelId,
              language: args.language,
              workingDir: args.workspaceReady ? args.workingDir : '',
            });
          } catch (err) {
            // Без гидратации модель увидит хотя бы плейсхолдер — ход не падает.
            warning(
              'ATTACHMENTS',
              `не удалось подготовить вложение тула ${ref.blobPath}: `
              + `${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
        args.currentMessages.push(...hydrated);
      } catch (err) {
        // Инъекция вложения — вспомогательный шаг: текст результата тула у
        // модели уже есть, поэтому ошибка не отменяет ход.
        warning(
          'ATTACHMENTS',
          `вложение тула ${ref.blobPath} не вставлено: `
          + `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /**
   * ADR-115: шаблон блока «вложения не доставлены» для LLM-сообщения
   * (`prompts/system/ATTACHMENTS_DROPPED.{lang}.md`). Файла нет / порт его не
   * отдаёт — пустая строка: гидратация возьмёт техническую строку (en).
   */
  private _attachmentsDroppedTemplate(language: string): string {
    return this._contextConfig?.getAttachmentsDroppedTemplate(language) ?? '';
  }

  /**
   * ADR-115: blob-порт обработки вложения (кэш результата aux-модели и
   * производные объекты). Тот же порт, что у гидратации; фоллбэк по `dataDir`
   * — только для тестов/прямого конструирования без порта.
   */
  private _resolveAttachmentBlobs(): BlobStore {
    if (!this._attachmentBlobs) {
      this._attachmentBlobs = this._blobs
        ?? createFileStorage({ dataDir: this._dataDir, env: process.env }).blobs;
    }
    return this._attachmentBlobs;
  }

  /**
   * ADR-115 §«Модели обработки по модальностям»: колбэк обработки вложения
   * aux-моделью для гидратации (native → aux-текст → отброс).
   *
   * Модель сессии **не меняется**: aux — отдельный вызов через
   * `GatewayProvider` (ADR-036), а в диалог попадает текст результата. Модель
   * обработки резолвится по семейству из live-настроек
   * (`attachments.modalityModels`), поэтому включение/смена модели в админке
   * действует без рестарта. Настройки нет — `undefined` (прежний путь
   * «отброшено + материализация»).
   *
   * Ошибки не пробрасываются: `null` + предупреждение в лог — гидратация тогда
   * идёт обычным путём отброса (ход не падает).
   */
  private _buildAttachmentDerive(
    session: Session | undefined,
    language: string,
  ): ((input: {
    blobPath: string;
    mime: string;
    name?: string;
    family: AttachmentFamily;
  }) => Promise<string | null>) | undefined {
    const configured = this._attachmentsConfig?.().modalityModels;
    if (!configured || Object.keys(configured).length === 0) return undefined;

    return async (input) => {
      // Резолвим на каждом вызове: семейство могло быть снято/переназначено
      // после включения настройки (live-резолвер, без рестарта).
      const target = this._attachmentsConfig?.().modalityModels?.[input.family];
      if (!target) return null;

      try {
        // Часть собирает тот же сервис, что и загрузку: blobPath/mime/имя +
        // sidecar-метаданные (для видео — длительность кадров).
        const built = await this._getAttachmentService().buildMediaPart(input.blobPath);
        if (!built) {
          warning('ATTACHMENTS', `Вложение ${input.blobPath} не разрешено для обработки`);
          return null;
        }
        // `hasFfmpeg` в derive синхронный: пробу через порт (ADR-077) делаем
        // заранее — она кэшируется по инстансу порта на TTL.
        const hasFfmpeg = await isFfmpegAvailable(this._executionPort).catch(() => false);
        const deps = this._buildAuxDeriveDeps(session, target, hasFfmpeg);
        if (!deps) return null;
        const result = await deriveModalityText(
          {
            family: input.family,
            mime: input.mime,
            ...(input.name ? { name: input.name } : {}),
            blobPath: input.blobPath,
            part: makeMediaPart(built.type, built.data),
            provider: target.provider,
            model: target.model,
            language: language === 'en' ? 'en' : 'ru',
          },
          deps,
        );
        return result.ok ? result.text : null;
      } catch (err) {
        warning(
          'ATTACHMENTS',
          `Обработка вложения ${input.blobPath} (${input.family}) не удалась: ${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
      }
    };
  }

  /**
   * ADR-115: сжатие вложения **перед отправкой** провайдеру.
   *
   * Оригинал в blob не меняется (content-addressed байты), сжатая копия живёт
   * в `attachments/.derived/compress/`; `save_attachment` и раздача через API
   * по-прежнему отдают оригинал. Применяется только на нативном пути:
   * `image` — всегда, `video` — если транспорт принимает видеофайл
   * (`supportsNativeVideo`), `audio` — если транспорт принимает целевой
   * контейнер (`audioFormat`). Иначе работают существующие derive/отброс.
   *
   * Мастер-выключатель `attachments.compression.enabled` (live-резолвер) —
   * `undefined` (сжатие не создаётся вовсе).
   */
  private _buildAttachmentCompress(
    _session: Session | undefined,
    target: AttachmentCompressTarget,
  ): HydrateOptions['compress'] | undefined {
    if (!this._attachmentsConfig?.().compression?.enabled) return undefined;
    const blobs = this._resolveAttachmentBlobs();
    const compressor = new AttachmentCompressor({
      blobs,
      // ADR-115 × ADR-077: ffmpeg — только через медиа-раннер; в split-режиме
      // команда уходит исполнителю (общий workspace, requires: ['ffmpeg']).
      runner: createMediaRunner({
        blobs,
        executionPort: this._executionPort,
        workspacesRoot: this._workspacesRoot,
      }),
      config: () => this._attachmentsConfig?.().compression
        ?? attachmentsConfigSchema.parse({}).compression,
      log: (message) => warning('ATTACHMENTS', message),
    });
    return (input) => compressor.compress(
      {
        blobPath: input.blobPath,
        mime: input.mime,
        family: input.family,
        size: input.size,
        ...(input.width !== undefined ? { width: input.width } : {}),
        ...(input.height !== undefined ? { height: input.height } : {}),
        // Длительность (из sidecar) — адаптивный битрейт видео: длинный
        // ролик иначе не влезает в лимит base64 и отбрасывается по `limit`.
        ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
      },
      target,
    );
  }

  /**
   * ADR-115: транскрипт аудиодорожки видео для гидратации.
   *
   * `video`-модальность доставляет **только кадры**, поэтому для модели с
   * `video`, но без `audio`, дорожка извлекается `ffmpeg` и уходит aux-модели
   * аудио (`attachments.modalityModels.audio`); текст дописывается в `content`
   * рядом с видео. Модель сессии не меняется; aux не назначена — `undefined`
   * (прежнее поведение: видео нативно, без транскрипта).
   */
  private _buildVideoAudioDerive(
    session: Session | undefined,
    language: string,
  ): ((input: {
    blobPath: string;
    mime: string;
    name?: string;
  }) => Promise<string | null>) | undefined {
    if (!this._attachmentsConfig?.().modalityModels?.audio) return undefined;

    return async (input) => {
      // Резолвим на каждом вызове: aux-модель аудио могли снять/сменить.
      const target = this._attachmentsConfig?.().modalityModels?.audio;
      if (!target) return null;
      try {
        const hasFfmpeg = await isFfmpegAvailable(this._executionPort).catch(() => false);
        const deps = this._buildAuxDeriveDeps(session, target, hasFfmpeg);
        if (!deps) return null;
        const result = await deriveVideoAudioText(
          {
            mime: input.mime,
            ...(input.name ? { name: input.name } : {}),
            blobPath: input.blobPath,
            provider: target.provider,
            model: target.model,
            language: language === 'en' ? 'en' : 'ru',
          },
          deps,
        );
        return result.ok ? result.text : null;
      } catch (err) {
        warning(
          'ATTACHMENTS',
          `Транскрипт аудиодорожки ${input.blobPath} не удался: ${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
      }
    };
  }

  /**
   * ADR-115: зависимости aux-вызова модели обработки — общий шов `derive` и
   * транскрипта дорожки видео: провайдер через `GatewayProvider` (инвариант 3),
   * чтение blob, промпт-шаблон и учёт расхода отдельным бакетом аналитики.
   * `null` — модель обработки не найдена в каталоге провайдеров.
   */
  private _buildAuxDeriveDeps(
    session: Session | undefined,
    target: { provider: string; model: string },
    hasFfmpeg: boolean,
  ): DeriveDeps | null {
    const sharedConfig = this._providerLoader(target.provider);
    if (!sharedConfig) {
      warning(
        'ATTACHMENTS',
        `Модель обработки "${target.provider}/${target.model}" не найдена`,
      );
      return null;
    }
    const rawProvider = ProviderFactory.create(
      target.provider,
      toCoreProviderConfig(
        sharedConfig,
        target.model,
        undefined,
        this._resolveModelCompatibility?.(target.provider, target.model),
      ),
    );
    // Инвариант 3: LLM-вызов только через GatewayProvider. Обёртка с
    // привязкой к сессии (карта обфускации/аудит), без сессии — пул-вариант.
    const provider = session
      ? this._wrapWithGateway(rawProvider, session)
      : this.wrapProviderWithGateway(rawProvider);
    const blobs = this._resolveAttachmentBlobs();
    return {
      blobs,
      hasFfmpeg: () => hasFfmpeg,
      // ADR-115 × ADR-077: запуск ffmpeg — через медиа-раннер; в split-режиме
      // команда уходит исполнителю, у которого есть ffmpeg (общий workspace).
      executionPort: this._executionPort,
      workspacesRoot: this._workspacesRoot,
      promptTemplate: (lang) => this._contextConfig?.getMediaDeriveTemplate(lang) ?? '',
      log: (message) => warning('ATTACHMENTS', message),
      chat: async (parts, prompt) => {
        const attachments: LLMAttachment[] = [];
        for (const part of parts) {
          const data = part.data as Partial<MediaPartData> | undefined;
          if (!data || typeof data.blobPath !== 'string' || data.blobPath === '') continue;
          const bytes = await blobs.read(data.blobPath);
          if (!bytes) continue;
          const mime = typeof data.mime === 'string' ? data.mime : 'application/octet-stream';
          attachments.push({
            mime,
            ...(typeof data.name === 'string' && data.name ? { name: data.name } : {}),
            // ADR-115 §«Приватность»: aux-модель получает байты без
            // EXIF/метаданных (в blob лежит оригинал).
            base64: stripMetadata(bytes, mime).toString('base64'),
          });
        }
        if (attachments.length === 0) {
          throw new Error('aux-вызов: нет читаемых частей вложения');
        }
        const response = await provider.chat([{
          id: 'attachment-derive',
          role: 'user',
          content: prompt,
          attachments,
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          disabled: false,
          pinned: false,
          branchId: '',
        }]);
        // Учёт расхода aux-вызова (ADR-102): отдельный бакет по осям
        // aux-модели — не смешивается с моделью сессии.
        this._recordDeriveUsage(session, target, response.usage);
        return { text: response.content };
      },
    };
  }

  /** Единая запись aux-расхода (счётчики сессии + роллап `usage`). */
  private _recordAuxUsage(input: AuxUsageInput): Promise<void> {
    return recordAuxUsage(
      {
        sessionManager: this._sessionManager,
        analytics: this._analytics,
        modelPriceLoader: this._modelPriceLoader,
      },
      input,
    );
  }

  /**
   * ADR-102: расход aux-вызова обработки вложения (best-effort).
   *
   * Учитывается общим швом `recordAuxUsage`: счётчики сессии **и** роллап
   * `usage` (оси aux-модели, `requests=1`, без `messages`) — один раз.
   * Стоимость — провайдерская (`usage.cost`) либо каталожная.
   */
  private _recordDeriveUsage(
    session: Session | undefined,
    ref: { provider: string; model: string },
    usage: TokenUsage | undefined,
  ): void {
    if (!session || !usage) return;
    void recordAuxUsage(
      {
        sessionManager: this._sessionManager,
        analytics: this._analytics,
        modelPriceLoader: this._modelPriceLoader,
      },
      {
        sessionId: session.id,
        provider: ref.provider,
        model: ref.model,
        usage,
        source: 'attachment-derive',
      },
    );
  }

  /**
   * Принудительное сжатие для overflow — только в цикле LLM-вызова (после
   * `context_length`). Ошибки сжатия не валят ход: возвращается `null`
   * (вызывающий деградирует к штатной обработке ошибки LLM).
   */
  private async _forceCompressForOverflow(
    session: Session,
    opts: { reason: 'overflow'; minKeepFromIndex?: number },
  ): Promise<Session | null> {
    if (!this._optimizer) return null;
    try {
      const result: ForceCompressionResult = await forceCompression(
        session,
        {
          optimizer: this._optimizer,
          sessionManager: this._sessionManager,
          eventBus: this._eventBus,
          saveSummary: createCompressionSummarySaver(this._saveAssistantMessage.bind(this)),
        },
        opts,
      );
      return result.session;
    } catch (e) {
      warning(
        'CONTEXT',
        `Forced compression failed: ${e instanceof Error ? e.message : String(e)}`,
      );
      return null;
    }
  }

  /**
   * Собрать `currentMessages` для повтора после overflow: сжать сессию,
   * перечитать её, взять живой хвост и чекпоинт. `false` — повтор невозможен
   * (нечего сжимать / разорваны tool-пары) — вызывающий отдаёт исходную ошибку.
   */
  private async _tryOverflowRecovery(args: {
    session: Session;
    author: string;
    effectiveAgentRole: string | undefined;
    providerName: string;
    model: string;
    currentMessages: LLMMessage[];
    baseLlmMessages: LLMMessage[];
  }): Promise<boolean> {
    if (!this._optimizer) return false;

    const updated = await this._forceCompressForOverflow(args.session, { reason: 'overflow' });
    if (!updated) return false;

    const summary = [...updated.messages]
      .reverse()
      .find((m) => m.role === MessageRole.SUMMARY && !m.disabled)
      ?.content ?? '';
    if (!summary.trim()) return false;

    const live = this._optimizer
      .getMessagesForLlm(updated)
      .filter((m) => m.role !== MessageRole.SUMMARY);
    const tail = sessionMessagesToLlmFn(live, args.effectiveAgentRole, args.author, {
      provider: args.providerName,
      model: args.model,
    });

    // Текущий ход: с его user-реплики (последняя в baseLlmMessages) и до
    // текущего момента. Пересечение с хвостом схлопывает helper.
    const turnStart = Math.max(0, args.baseLlmMessages.length - 1);
    const currentTurn = args.currentMessages.slice(turnStart);

    const rebuilt = buildOverflowRetryMessages({ summary, tail, currentTurn });
    if (!rebuilt) return false;

    args.currentMessages.length = 0;
    args.currentMessages.push(...rebuilt);
    return true;
  }

  /** ADR-095 (шаг 6b-1): зависимости вынесенной подготовки запроса `_processMessage`. */
  private _processSetupDeps(session?: Session): ProcessSetupDeps {
    return {
      routeProvider: (session, message, reasoningLevel, debugCollector, overrides) =>
        this._routeProvider(session, message, reasoningLevel, debugCollector, overrides),
      handleLlmFailure: (sessionId, streamId, error, attempt, ctx) =>
        this._handleLlmFailure(sessionId, streamId, error, attempt, ctx),
      ...(this._providerAvailability ? { providerAvailability: this._providerAvailability } : {}),
      ...(this._resolveModelEnabled ? { resolveModelEnabled: this._resolveModelEnabled } : {}),
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
        const modalities = this._resolveModalities?.(target.providerName, target.modelId);
        // ADR-115: модальность не принята — сначала aux-модель семейства, и
        // только затем прежний путь (отброс + материализация). Не настроено —
        // `undefined` (derive не вызывается).
        const derive = this._buildAttachmentDerive(session, target.language);
        // ADR-115 × ADR-117: транспортные возможности провайдера (контейнеры
        // аудио/видео) — **данные** слоя совместимости, а не host-проверка.
        // Модальность в каталоге может включать `audio`/`video`, но протокол не
        // умеет конкретный контейнер (ogg у Anthropic, видео у официального
        // OpenAI) — тогда вложение идёт через aux или помечается недоставленным,
        // а не теряется молча.
        //
        // Резолв — тот же, что у провайдера хода: явное значение модели →
        // явное значение провайдера → эвристика (тип протокола/хост) → дефолт.
        const providerConfig = this._providerLoader(target.providerName);
        const compatibility = providerConfig
          ? resolveProviderCompatibility({
              type: providerConfig.type,
              name: providerConfig.name,
              url: providerConfig.baseUrl,
              model: target.modelId,
              compatibility: this._resolveModelCompatibility?.(
                target.providerName,
                target.modelId,
              ) ?? providerConfig.compatibility,
            })
          : undefined;
        const nativeAudioFormats = new Set(compatibility?.nativeAudioFormats ?? []);
        const canDeliverNative = providerConfig && compatibility
          ? (mime: string) => {
              const format = nativeAudioFormatForMime(mime);
              if (format) return nativeAudioFormats.has(format);
              return mime.toLowerCase().startsWith('video/')
                && compatibility.supportsNativeVideo;
            }
          : undefined;
        // ADR-115: транскрипт аудиодорожки видео — `video`-модальность
        // доставляет только кадры, звук модели не доходит. Для модели с
        // `video`, но без `audio`, дорожка уходит aux-модели аудио, текст
        // дописывается рядом с видео. Нет aux — прежнее поведение.
        const deriveVideoAudio = this._buildVideoAudioDerive(session, target.language);
        // ADR-115: сжатие вложения перед отправкой — только нативный путь
        // (image всегда; video — если транспорт принимает видеофайл; audio —
        // если принимает целевой контейнер). Выключено — не создаём.
        const compress = this._buildAttachmentCompress(
          session,
          resolveCompressTarget(
            compatibility ?? { nativeAudioFormats: [], supportsNativeVideo: false },
          ),
        );
        return hydrateMessageAttachments(messages, source, this._getAttachmentHydrateDeps(), {
          modalities,
          ...(canDeliverNative ? { canDeliverNative } : {}),
          noticeTemplate: this._attachmentsDroppedTemplate(target.language),
          // Модель сессии и её модальности — для блока «не доставлено»: модель
          // видит, чего не хватает, и может предложить другую (тул `list_models`).
          modelLabel: `${target.providerName}/${target.modelId}`,
          ...(modalities && modalities.length > 0 ? { modelModalities: modalities } : {}),
          ...(derive ? { derive } : {}),
          ...(deriveVideoAudio ? { deriveVideoAudio } : {}),
          ...(compress ? { compress } : {}),
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
      estimateUsage: (usage, promptChars, outputChars) =>
        this._estimateUsage(usage, promptChars, outputChars),
      computeMessageCost: (model, usage) => this._computeMessageCost(model, usage),
      saveAssistantMessage: this._saveAssistantMessage.bind(this),
      resolveAssistantStatus: (isCancelled, metadataExtra) =>
        this._resolveAssistantStatus(isCancelled, metadataExtra),
      getAssistantSecrets: (sessionId, content) => this._getAssistantSecrets(sessionId, content),
      calibrateTokenRatio: (model, promptChars, usage, currentRatio) =>
        this._calibrateTokenRatio(model, promptChars, usage, currentRatio),
      getProvider: (providerName, session, reasoningLevel, overrides) =>
        this._getProvider(providerName, session, reasoningLevel, overrides),
      unregister: (streamId) => {
        this._cancellationTokens.delete(streamId);
      },
      recordAuxUsage: (input) => this._recordAuxUsage(input),
      ...(this._requeueSteerMessages
        ? { requeueSteerMessages: this._requeueSteerMessages }
        : {}),
    };
  }

  /**
   * Авто-именование сессии (ранний триггер): вызывается сразу после
   * подготовки запроса (провайдер уже выбран роутером) — до `turn.started`.
   *
   * Fire-and-forget: LLM-вызов заголовка не блокирует ход. План (первое
   * сообщение / диалог / пропуск) считает `shouldAutoTitle`; приветствие
   * первого сообщения LLM не зовёт вовсе.
   */
  private _maybeAutoTitle(session: Session, provider: BaseProvider, providerName: string): void {
    const cfg = this._autoTitle;
    if (!cfg.enabled) return;
    const titleAgentDef = this._agentRegistry?.get('title');
    let titleProvider = provider;
    // Температура/размышления title-агента применяются и без своего
    // reasoningLevel. Gateway-обёртка уже есть в обоих случаях (инвариант 3).
    if (
      titleAgentDef
      && (titleAgentDef.reasoningLevel || titleAgentDef.temperature !== undefined)
      && providerName
    ) {
      const tp = this._getProvider(
        providerName, session, titleAgentDef.reasoningLevel,
        { temperature: titleAgentDef.temperature },
      );
      if (tp) titleProvider = tp;
    }
    void autoTitleSession(session, this._sessionManager, titleProvider, {
      config: cfg,
      onUsage: (usage, meta) => this._recordAuxUsage({
        sessionId: session.id,
        usage,
        ...(meta?.provider ? { provider: meta.provider } : {}),
        ...(meta?.model ? { model: meta.model } : {}),
        agent: 'title',
        source: 'title',
      }),
    })
      .then((title) => {
        if (title) {
          this._eventBus.publish(session.id, 'session.updated', {
            session_id: session.id,
            name: title,
          });
        }
      })
      .catch(() => {});
  }

  /**
   * Ручная регенерация заголовка сессии (`PATCH /api/v2/sessions/:id {title:""}`).
   *
   * Заголовок строится по диалогу (force) и **перетирает** текущий — в том
   * числе заданный пользователем. Возвращает обновлённую сессию; `null` —
   * сессии нет либо заголовок сформировать не удалось.
   */
  async regenerateTitle(sessionId: string): Promise<Session | null> {
    const session = await this._sessionManager.getSession(sessionId);
    if (!session) return null;
    const providerName = session.settings.provider ?? '';
    const titleAgentDef = this._agentRegistry?.get('title');
    const provider = this._getProvider(
      providerName, session, titleAgentDef?.reasoningLevel,
      { temperature: titleAgentDef?.temperature },
    );
    if (!provider) return null;
    const title = await autoTitleSession(session, this._sessionManager, provider, {
      config: this._autoTitle,
      force: true,
      onUsage: (usage, meta) => this._recordAuxUsage({
        sessionId: session.id,
        usage,
        ...(meta?.provider ? { provider: meta.provider } : {}),
        ...(meta?.model ? { model: meta.model } : {}),
        agent: 'title',
        source: 'title',
      }),
    });
    if (!title) return null;
    return this._sessionManager.getSession(sessionId);
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
    const effectiveAgentRole = this._resolveEffectiveAgentRole(session.settings.agentRole);
    const agentDef = this._resolveAgentDefinition(effectiveAgentRole);
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
    const projectRoot = await this._resolveProjectWorkspace(session, project);
    const workspaceReady = projectRoot !== null;
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
      session, agentDef, effectiveAgentRole, workingDir, projectRoot, language, summaryContent,
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
    const effectiveAgentRole = this._resolveEffectiveAgentRole(
      message.agentRole || session.settings.agentRole,
    );
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
    // ADR-118 §4: тайминги шага (число чанков, моменты первого/последнего) —
    // в `step.finished.timings`. Счётчик заводится на каждый шаг хода.
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
    let projectRoot = await this._resolveProjectWorkspace(session, projectForState);
    let workspaceReady = projectRoot !== null;
    // Периметр сессии (ADR-114): сессия в worktree считает «своими» и рабочий
    // каталог worktree, и корень проекта (`project.workspace`) — как в opencode
    // (`FileAccess.resolve`: internal = location.directory ИЛИ project worktree).
    let allowedRoots = resolveAllowedRoots(workingDir, projectRoot);

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
      // Восстановленное после рестарта сообщение — не новое входящее: хук не
      // эмитим (иначе плагины/интеграции сработали бы повторно).
      && message.metadata?.resumed !== true
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

    const agentDef = this._resolveAgentDefinition(effectiveAgentRole);
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
      ...(allowedRoots ? { allowedRoots } : {}),
      permissionEvaluator, sessionMode, planMode, planApproved, streamStartedAt,
      authorityTurn,
    }, this._processEarlyDeps());
    if (earlyResult) {
      // Ранний ответ (микро-слой/локальная команда): провайдера хода ещё нет —
      // резолвим его из сессии для авто-имени. Гарды `shouldAutoTitle`
      // отсекают приветствие, служебные сообщения и `/`-команды.
      const earlyTitleAgentDef = this._agentRegistry?.get('title');
      const earlyProviderName = session.settings.provider ?? '';
      const earlyProvider = this._getProvider(
        earlyProviderName, session, earlyTitleAgentDef?.reasoningLevel,
        { temperature: earlyTitleAgentDef?.temperature },
      );
      if (earlyProvider) this._maybeAutoTitle(session, earlyProvider, earlyProviderName);
      return earlyResult;
    }

    // ADR-118 §1: ход = последовательность шагов. Идентификатор хода стабилен
    // для всех шагов хода; `turn.started`/`turn.finished` открывают и закрывают
    // ход в канале сессии.
    const turnId = `turn_${generateId()}`;
    /** `turn.started` опубликован (значит, ход нужно закрыть `turn.finished`). */
    let turnStarted = false;

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
        projectForState, workingDir, projectRoot, workspaceReady, agentDef, effectiveAgentRole,
        effectiveReasoningLevel, sessionMode, planMode, planApproved, author, attempt,
      }, this._processSetupDeps(session));
      if (setup.failed) return setup.result;
      // Авто-именование сессии — сразу после подготовки запроса (провайдер уже
      // выбран роутером), до `turn.started`. Fire-and-forget: ход не ждёт LLM.
      this._maybeAutoTitle(session, setup.state.provider, setup.state.providerName);
      // ADR-118 §1/§10: реплика, с которой ход начался, получает `turnId` — по
      // нему UI группирует сегменты хода, а `disabled-turns` гасит ход.
      // Обновление одно на ход (до `turn.started`), уже размеченное не трогаем.
      await this._markTurnUserMessage(session.id, message, turnId);
      // ADR-118 §4: ход начался (реплика пользователя — id её сообщения).
      publishTurnStarted(publishChunk, { turnId, messageId: message.id });
      turnStarted = true;
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
      /**
       * Один принудительный повтор после переполнения контекста за ход.
       * Второй `context_length` (или неудачное сжатие) — штатная ошибка.
       */
      let overflowRecoveryAttempted = false;
      const currentMessages: LLMMessage[] = [...baseLlmMessages];
      // ADR-115 (outbound): медиа-части ответа хода — их складывает тул
      // `send_attachment`, а к финальному сообщению добавляет финализация
      // (оттуда — в `stream.done.attachments`). Живёт ровно один ход.
      const outboundParts: Part[] = [];
      const doomLoopTracker: Map<string, number> = new Map();
      let finalContent = '';
      let allReasoning: ReasoningBlock[] = [];
      /**
       * Legacy: сводка текстов промежуточных шагов. Для сообщений **хода**
       * (`step.turnId` задан) она не пишется — тексты шагов живут в сообщениях
       * своих шагов (ADR-118 §1). Основной ход её не собирает (мёртвый
       * сбор); осталась для legacy-путей (сообщения без хода).
       */
      const allIntermediateTexts: Array<{ text: string; iteration: number }> = [];
      let finalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
      /**
       * ADR-102: расход **хода** — сумма расходов всех шагов (итераций) хода.
       *
       * С ADR-118 шаг = отдельный вызов LLM, поэтому `finalUsage` (последний
       * usage от провайдера) — это расход только последней итерации: в
       * финальное сообщение, счётчики сессии и аналитику попадала лишь его
       * часть, а расход промежуточных шагов терялся.
       *
       * Накопление — ровно один раз за итерацию (`iterationUsage` — последний
       * usage, присланный провайдером в этой итерации): провайдеры шлют usage
       * в разных чанках, суммировать по чанкам нельзя (двойной счёт).
       */
      let turnUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
      /**
       * ADR-102: стоимость хода по **каждому шагу его моделью** (валюта → сумма)
       * и компонентная разбивка для счётчиков сессии. `turnUsage` считает
       * токены; цена шага зависит от модели этого шага (смена модели/эскалация).
       */
      const turnCostByCurrency: Record<string, number> = {};
      const turnCostBreakdown: UsageCostBreakdown = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      let finalModel: string | undefined;
      /**
       * Причина завершения финального ответа (нормализованный словарь
       * `LlmFinishReason`). Нужна эпилогу, чтобы отличить «модель ничего не
       * ответила» от «ответ срезан лимитом вывода» (`max_tokens`): у
       * reasoning-моделей весь бюджет `max_tokens` может уйти в thinking, и
       * `content` приходит пустым.
       */
      let finalFinishReason: LlmFinishReason | undefined;
      // Модель последнего завершённого стрима итерации: нужна ветке отмены
      // во время тула, где `chunkModel` уже вне области видимости, а
      // `finalModel` ещё не обновлён (ADR-070 §2.6, Bug 2).
      let lastChunkModel: string | undefined;
      const allToolCalls: Array<Record<string, unknown>> = [];
      /** metadata.i18n подставленного финального фоллбека (лимит итераций / deny / пустой ответ). */
      let fallbackI18n: ReturnType<typeof i18nMeta> | undefined;
      /** Были ли deny-отказы за цикл (для осмысленного fallback пустого ответа). */
      let hadDeny = false;
      /**
       * Был ли отказ именно **ролевой** (`matchedRule: 'role.unavailable'`):
       * тул не для этого агента, а не нарушение политики. Ход **не**
       * останавливается — модель получает `tool_result` с причиной и может
       * выбрать другой инструмент. Флаг нужен только для фоллбек-текста
       * (`session.role_tool_blocked`), если содержательного ответа так и не
       * последовало.
       */
      let roleBlocked = false;
      /**
       * Защита от бесконечного повтора одинаковых deny-вызовов. Doom-loop
       * намеренно не трогает deny (каждая попытка получает объяснение), а
       * у агента может не быть лимита шагов (`DEFAULT_MAX_ITERATIONS` —
       * `Infinity`). После {@link MAX_REPEATED_DENY_COUNT} одинаковых отказов
       * подряд ход завершается фоллбек-текстом (`session.denied_blocked`).
       */
      let denyRepeatKey: string | undefined;
      let denyRepeatCount = 0;
      let denyLoopExceeded = false;
      let roleBlockedTool: string | undefined;
      let roleBlockedAgent: string | undefined;
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
      /**
       * ADR-118 §1: запись сообщения **шага-лимита** (шаг с вызовами
       * инструментов) — уже сохранена; финализация хода её дополняет
       * (статус/usage/metadata), а не создаёт вторую запись с тем же текстом.
       */
      let stepLimitStepRecord: StreamMessageRef | null = null;
      // ADR-118 §4: тайминги последнего шага хода — в `step.finished` финального
      // шага (эпилог `process-finalize`).
      let lastStepTiming: StreamTiming | undefined;
      // ADR-118 §1: идентификатор сообщения последнего шага хода.
      let lastStepMessageId: string | undefined;
      /** ADR-102: начало последнего вызова LLM (для ветки отмены). */
      let lastStepStartedAt: number | undefined;
      /** ADR-102: длительность последнего вызова LLM (для `step_duration_ms`). */
      let lastStepDurationMs: number | undefined;

      // ADR-118 §4: live-статистика расхода удалена вместе с `stream.usage` —
      // расход шага публикуется в `step.finished` (usage/модель/стоимость).

      // Стартовая оценка input сразу после сборки сообщений — чтобы панель
      // статистики не пустовала до первого чанка провайдера.
      // ADR-071 §2.6: размер промпта считаем один раз при старте и на входе
      // каждой итерации; переиспользуем в live-оценке и путях отмены.
      let lastIterationPromptChars = this._estimatePromptChars(
        currentMessages, finalSystemPrompt, tools as Record<string, unknown>[] | undefined,
      );

      // Предупреждение о заполненности контекстного окна (fire-and-forget, не блокирует вызов)
      this._publishContextLimitWarning(session.id, modelName, messagesForLlm);

      // Условие цикла: обычные шаги до лимита агента + ОДИН дополнительный
      // шаг-лимит (механика opencode). `DEFAULT_MAX_ITERATIONS` — Infinity,
      // лимит наступает только при явном `maxSteps` агента.
      let stepLimitStepDone = false;
      /**
       * Шаг-лимит действительно исполнялся (в запросе был синтетический
       * assistant-префилл). Эпилог по этому флагу подставляет отчёт
       * `session.steps_limit` и помечает `step_limit_reached` — иначе пустой
       * ответ отдавался бы как «лимит итераций» без связи с реальным шагом.
       */
      let stepLimitExecuted = false;
      while (toolIteration < maxIterations || !stepLimitStepDone) {
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
          // ADR-118 §4: отдельного события прерывания больше нет — шаг, который
          // шёл, уже закрыт (`step.finished` со статусом `cancelled`), а
          // вмешательство пользователя приходит как `message.delivered`.
          // Граница шага: генерации в этот момент не было.
        }

        // ADR-104: вычитка очереди инъекций — на границе шага (здесь же, где
        // проверяется отмена). Инъекция НИКОГДА не попадает внутрь шага:
        // результаты инструментов предыдущей итерации уже в `currentMessages`,
        // поэтому пары toolUse/toolResult не рвутся.
        await this._applySteerInjections(
          session, currentMessages, publishChunk, effectiveAgentRole, author, streamId, turnId,
        );

        // Лимит шагов агента исчерпан — этот шаг финальный (механика opencode):
        // инструменты остаются в запросе (кэшированный префикс провайдера),
        // вызов запрещается `toolChoice: 'none'`, инструкция «только текст»
        // вставляется assistant-сообщением в запрос (не в историю).
        const stepLimitStep = Number.isFinite(maxIterations) && toolIteration + 1 >= maxIterations;
        if (stepLimitStep) {
          stepLimitStepDone = true;
          stepLimitExecuted = true;
        }
        const stepMessages: LLMMessage[] = stepLimitStep
          ? [
            ...currentMessages,
            maxStepsAssistantMessage(buildMaxStepsPrompt(this._contextConfig ?? undefined, language, maxIterations)),
          ]
          : currentMessages;

        let accumulatedContent = '';
        let accumulatedReasoning = '';
        // Anthropic: подпись thinking-блока и opaque `redacted_thinking` этой
        // итерации. Подпись валидна ровно для своего текста, поэтому копится
        // вместе с `accumulatedReasoning` и персистится тем же сообщением.
        let accumulatedReasoningSignature: string | undefined;
        let accumulatedReasoningRedacted: string[] | undefined;
        /** Anthropic: блоки reasoning этой итерации (каждый со своей подписью). */
        let iterationReasoningBlocks: LLMReasoningBlock[] | undefined;
        let toolCalls: Record<string, unknown>[] | undefined = [];
        let chunkModel: string | undefined;
        // ADR-118 §4: последний опубликованный текст рассуждений шага —
        // чтобы не публиковать `part.updated` на каждый кумулятивный чанк.
        let publishedReasoning: string | undefined;
        // ADR-070: usage текущей итерации (running total от провайдера) для live.
        let iterationUsage: TokenUsage | undefined;

        // Размер промпта этой итерации (символы) — считаем один раз и
        // переиспользуем для best-effort оценки input, пока нет точных токенов.
        // Для первой итерации берём стартовое значение (сообщения не менялись).
        const iterationPromptChars = toolIteration === 0
          ? lastIterationPromptChars
          : this._estimatePromptChars(
            stepMessages, finalSystemPrompt, tools as Record<string, unknown>[] | undefined,
          );
        lastIterationPromptChars = iterationPromptChars;

        // ADR-118 §1: шаг = один вызов LLM = одно assistant-сообщение.
        // Идентификатор сообщения шага известен ДО первого чанка — по нему
        // публикуются `step.started`, `part.delta` и `part.updated`.
        const stepIndex = toolIteration;
        const stepMessageId = generateId();
        // Тайминги шага (число чанков, моменты первого/последнего) — в
        // `step.finished.timings` (ADR-118 §4).
        const stepTiming = new StreamTiming(streamStartedAt);
        lastStepTiming = stepTiming;
        lastStepMessageId = stepMessageId;
        // ADR-102: начало вызова LLM — для `metadata.step_duration_ms`
        // (длительность **своего** шага; `duration_ms` остаётся длительностью хода).
        const stepStartedAt = Date.now();
        lastStepStartedAt = stepStartedAt;
        // Шаг 2б: черновик частичного стрима этой итерации. Запись создаётся
        // при первом непустом контенте/рассуждении и далее обновляется с
        // троттлингом — стрим не блокируется.
        const draft = new StreamMessageDraft({
          sessionManager: this._sessionManager,
          sessionId: session.id,
          id: stepMessageId,
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
            // ADR-118 §1/§5: сообщение шага несёт ход и индекс шага; статус
            // `streaming` меняется на терминальный в финале шага.
            turnId,
            stepIndex,
            status: 'streaming',
            metadata: { stream_id: streamId },
          },
          intervalMs: this._streamPersistIntervalMs,
        });
        publishStepStarted(publishChunk, { turnId, stepIndex, messageId: stepMessageId });
        // ADR-118 §5: серверный снимок живого шага. По нему открытая посреди
        // хода сессия рисует содержимое до текущего момента, не дожидаясь
        // следующего чанка (`current_stream.live` в DTO).
        setLiveStreamSnapshot(session.id, {
          streamId,
          turnId,
          messageId: stepMessageId,
          stepIndex,
          content: '',
          parts: [],
          updatedAt: nowISO(),
        });

        // ADR-117: effort считается на каждый LLM-вызов из **актуальных**
        // настроек: `agent.effort` → `session.settings.effort` → тир уровня
        // размышлений (`agent.reasoningLevel` → `session.settings.reasoningLevel`).
        // Смена настройки между шагами/ходами подхватывается без пересоздания
        // провайдера (effort едет в опциях).
        const llmEffort = agentDef?.effort
          ?? session.settings.effort
          ?? effortForReasoningLevel(
            agentDef?.reasoningLevel ?? session.settings.reasoningLevel,
          );

        /**
         * Блокировка по политике контекстного окна: оценка/окно/резерв
         * кладутся в metadata сообщения об ошибке (`context_window_*`).
         */
        let contextWindowBlock: { tokens: number; window: number; reserve: number } | undefined;

        try {
          // Политика `enforce`: не отправляем LLM-вызов, если оценка промпта не
          // влезает в окно модели за вычетом резерва на вывод. `warn`/`off` не
          // блокируют, неизвестное окно (`0`) — тоже (оценка без окна
          // бессмысленна). Ошибка уходит общим путём (`_handleLlmFailure` →
          // `error_type: 'context_length'`, ключ `router.context_length_exceeded`).
          const windowPolicy = this._contextWindowPolicy?.() ?? 'warn';
          if (windowPolicy !== 'off') {
            const windowTokens = this._resolveModelContextWindow(modelName);
            const reserveTokens = resolveMaxOutputTokens({
              sessionMax: session.settings.maxTokens,
              modelMax: this._resolveModelMaxOutputTokens?.(providerName, modelName),
              configMax: this._defaultMaxOutputTokens,
            });
            const estimatedTokens = estimateTokens(iterationPromptChars, loadedTokenRatio);
            const decision = checkContextWindowWindow({
              policy: windowPolicy,
              estimatedTokens,
              windowTokens,
              reserveTokens,
            });
            if (decision.action === 'block') {
              contextWindowBlock = {
                tokens: estimatedTokens,
                window: windowTokens,
                reserve: reserveTokens,
              };
              warning(
                'ORCHESTRATOR',
                `Контекстное окно превышено (policy=enforce): оценка ${estimatedTokens} > лимит ${decision.allowLimit} ` +
                  `(окно ${windowTokens}, резерв ${reserveTokens}) — LLM-вызов не отправлен`,
              );
              throw new ContextLengthExceededError();
            }
          }
          for await (const chunk of provider.chatAsync(
            stepMessages,
            finalSystemPrompt,
            tools as Record<string, unknown>[] | undefined,
            debugCollector,
            cancelToken,
            buildChatOptions(llmEffort, stepLimitStep ? 'none' : undefined),
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
            if (chunk.reasoningSignature !== undefined) {
              accumulatedReasoningSignature = chunk.reasoningSignature;
            }
            if (chunk.reasoningRedacted?.length) {
              accumulatedReasoningRedacted = chunk.reasoningRedacted;
            }
            if (chunk.reasoningBlocks?.length) {
              iterationReasoningBlocks = chunk.reasoningBlocks;
            }
            if (chunk.usage) {
              finalUsage = chunk.usage;
              iterationUsage = chunk.usage;
            }
            if (chunk.model) chunkModel = chunk.model;
            // Причина завершения (финальный чанк): `max_tokens` — ответ срезан
            // лимитом вывода, даже если текст пуст.
            if (chunk.finishReason) finalFinishReason = chunk.finishReason;

            // Шаг 2б: частичный стрим в историю (не блокирует цикл чанков).
            draft.push(accumulatedContent, accumulatedReasoning, chunkModel, {
              signature: accumulatedReasoningSignature,
              redacted: accumulatedReasoningRedacted,
            });

            // ADR-118 §4: live-статистика расхода удалена вместе с
            // `stream.usage` — расход шага публикуется в `step.finished`
            // (usage/модель/стоимость шага).

            if (chunk.toolCalls && chunk.toolCalls.length > 0) {
              toolCalls = chunk.toolCalls;
            }

            // ADR-118 §1/§4: текст шага — дельтами (`part.delta`) с
            // детерминированным `partId` (`msg:text:N`); полный текст шага не
            // публикуется (его несёт финальное сообщение).
            stepTiming.next();
            if (!chunk.isFinal && chunk.content) {
              publishPartDelta(publishChunk, {
                messageId: stepMessageId,
                partId: textPartId(0),
                field: 'text',
                delta: chunk.content,
              });
            }
            // Рассуждения — целой частью (`part.updated`): провайдер шлёт их
            // кумулятивно, дельта здесь бессмысленна.
            if (chunk.reasoning && chunk.reasoning !== publishedReasoning) {
              publishedReasoning = chunk.reasoning;
              publishPartUpdated(publishChunk, {
                messageId: stepMessageId,
                partId: reasoningPartId(0),
                part: { id: reasoningPartId(0), type: 'reasoning', data: chunk.reasoning },
              });
            }

            // ADR-118 §5: обновляем серверный снимок шага (in-memory). Снимок
            // читает `GET /sessions/:id` — открытие сессии не зависит от того,
            // успел ли клиент получить дельты.
            setLiveStreamSnapshot(session.id, {
              streamId,
              turnId,
              messageId: stepMessageId,
              stepIndex,
              content: accumulatedContent,
              ...(accumulatedReasoning ? { reasoning: accumulatedReasoning } : {}),
              parts: liveStepParts(accumulatedContent, accumulatedReasoning, toolCalls),
              updatedAt: nowISO(),
            });
          }
        } catch (e) {
          const rawErrorText = e instanceof Error ? e.message : String(e);
          // Переполнение контекста: один принудительный повтор после сжатия.
          // System prompt не пересобираем — чекпоинт и хвост идут в `stepMessages`.
          const isOverflow = e instanceof ContextLengthExceededError
            || classifyLlmError(rawErrorText) === 'context_length';
          if (isOverflow && !overflowRecoveryAttempted) {
            overflowRecoveryAttempted = true;
            // Частичный текст уже записан — порядок не восстановить безопасно.
            if (draft.ref() === null) {
              const recovered = await this._tryOverflowRecovery({
                session,
                author,
                effectiveAgentRole,
                providerName,
                model: provider.model || modelName || session.settings.model || '',
                currentMessages,
                baseLlmMessages,
              });
              if (recovered) {
                await draft.dispose();
                // ADR-118 §4: на каждый `step.started` — `step.finished`.
                // Неудавшийся шаг закрываем ошибкой, повтор идёт с новым
                // индексом (без двух шагов с одинаковым `stepIndex`).
                publishStepFinished(publishChunk, {
                  turnId,
                  stepIndex,
                  messageId: stepMessageId,
                  status: 'error',
                  ...(iterationUsage ? { usage: iterationUsage } : {}),
                  provider: providerName,
                  ...(chunkModel ? { model: chunkModel } : {}),
                  ...(effectiveAgentRole ? { agentRole: effectiveAgentRole } : {}),
                });
                toolIteration += 1;
                // Следующая итерация должна оценивать уже сжатый промпт.
                lastIterationPromptChars = this._estimatePromptChars(
                  currentMessages,
                  finalSystemPrompt,
                  tools as Record<string, unknown>[] | undefined,
                );
                warning('ORCHESTRATOR', 'Контекст сжатия применён после context_length — повтор шага');
                continue;
              }
            }
          }

          const errMsg = String(e);
          warning('ORCHESTRATOR', `LLM stream error: ${errMsg}`);

          // Шаг 2б: частичный текст сохраняется с interrupted/status='error',
          // таймер останавливается; семантика handleLlmFailure не меняется.
          await draft.abort(errMsg, 'error');

          // ADR-118 §4: шаг закрыт ошибкой, ход — тоже.
          publishStepFinished(publishChunk, {
            turnId,
            stepIndex,
            messageId: stepMessageId,
            status: 'error',
            ...(iterationUsage ? { usage: iterationUsage } : {}),
            provider: providerName,
            ...(chunkModel ? { model: chunkModel } : {}),
            ...(effectiveAgentRole ? { agentRole: effectiveAgentRole } : {}),
          });
          publishTurnFinished(publishChunk, { turnId, status: 'error' });
          turnStarted = false;

          this._cancellationTokens.delete(streamId);
          return this._handleLlmFailure(session.id, streamId, e, attempt, {
            debugCollector,
            durationMs: Date.now() - streamStartedAt,
            // ADR-102: сообщение об ошибке несёт расход своего шага; счётчики —
            // предыдущие шаги (`turnUsage`) + этот (оценка в обработчике).
            usage: iterationUsage,
            turnUsage,
            model: this._resolveMessageModel(chunkModel, finalModel, provider, session),
            providerName,
            agentRole: effectiveAgentRole,
            content: accumulatedContent,
            promptChars: iterationPromptChars,
            toolResults: allToolCalls.length > 0 ? allToolCalls : undefined,
            promptMeta,
            // Политика контекстного окна заблокировала вызов — в metadata
            // сообщения об ошибке фиксируются оценка и окно (диагностика).
            ...(contextWindowBlock
              ? {
                  contextWindowExceeded: true,
                  contextWindowTokens: contextWindowBlock.tokens,
                }
              : {}),
            // ADR-118 §1/§5: сообщение об ошибке адресует тот же шаг, что
            // `step.finished` выше (тот же `messageId`).
            step: { turnId, stepIndex, status: 'error', messageId: stepMessageId },
          });
        }

        // Стрим итерации завершён — фиксируем модель до возможной отмены
        // (в т.ч. во время исполнения тулов ниже).
        lastChunkModel = chunkModel;
        // ADR-102: длительность **своего** вызова (без инструментов/QA/эскалации).
        lastStepDurationMs = Math.max(0, Date.now() - stepStartedAt);
        // ADR-102: `finalUsage` — расход **текущей** итерации. Если провайдер
        // не прислал usage, не оставляем значение прошлого шага (иначе
        // сообщение шага получило бы чужой расход).
        finalUsage = iterationUsage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

        if (cancelToken.cancelled) {
          // Bug 2: модель для cost — провайдеры отдают `model` только в финале,
          // поэтому fallback на provider.model/session.settings.model.
          const cancelModel = this._resolveMessageModel(chunkModel, finalModel, provider, session);

          // Завершённые итерации и их tool-результаты уже записаны пошагово
          // (шаг 2а) — повторная персистенция tool-chain не нужна.

          // ADR-118 §1: в сообщении отмены — только текст **текущей**
          // итерации. Тексты завершённых шагов уже сохранены их сообщениями
          // (шаг = сообщение), поэтому склейка всех итераций дублировала бы
          // их в ленте (текст шага + текст финала).
          const partialContent = accumulatedContent;

          // Bug 3/4: usage/duration/cost в событии отмены; при пустом usage —
          // best-effort оценка (metadata.usage_estimated) из размера промпта и
          // накопленного текста.
          //
          // ADR-102/ADR-118: два расхода — расход **шага** (`step.finished` и
          // сообщение отмены: метрики Prometheus считают по шагам, сумма их
          // равна расходу хода) и расход **хода** (счётчики сессии и
          // аналитика: сумма завершённых шагов + этот шаг). Расход текущей
          // итерации в `turnUsage` ещё не накоплен (накопление — после
          // стрима), поэтому шаг оценивается отдельно, а ход — как
          // `turnUsage + cancelStepUsage` (без потерь и без двойного счёта).
          const cancelDurationMs = Date.now() - streamStartedAt;
          const cancelStepUsage = this._estimateUsage(
            iterationUsage,
            iterationPromptChars,
            partialContent.length,
          );
          const cancelTurnUsage = addTokenUsage(turnUsage, cancelStepUsage.usage);
          const cancelCost = this._computeMessageCost(cancelModel, cancelStepUsage.usage);
          const cancelTurnCost = this._computeMessageCost(cancelModel, cancelTurnUsage);
          // ADR-102: стоимость отменённого шага — в общую стоимость хода.
          if (cancelCost) {
            turnCostByCurrency[cancelCost.currency] =
              (turnCostByCurrency[cancelCost.currency] ?? 0) + cancelCost.costUsd;
            turnCostBreakdown.input += cancelCost.breakdown.input;
            turnCostBreakdown.output += cancelCost.breakdown.output;
            turnCostBreakdown.cacheRead += cancelCost.breakdown.cacheRead;
            turnCostBreakdown.cacheWrite += cancelCost.breakdown.cacheWrite;
          }

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
            cancelStepUsage.usage, cancelModel, accumulatedReasoning, debugCollector, true, providerName,
            MessageRole.ASSISTANT, undefined, false, allToolCalls, undefined,
            undefined, undefined,
            {
              duration_ms: cancelDurationMs,
              step_duration_ms: lastStepDurationMs ?? Math.max(0, Date.now() - stepStartedAt),
              ...(cancelStepUsage.estimated ? { usage_estimated: true } : {}),
            },
            promptMeta,
            // Стоимость **сообщения** (своего шага) — не хода: usage сообщения
            // теперь расход своего вызова (`cancelStepUsage`).
            cancelCost,
            cancelledDraft ?? undefined,
            // ADR-115: медиа-частей ответа в ветке отмены нет.
            undefined,
            // Anthropic: подпись thinking-блока текущей итерации — сообщение
            // отмены персистится тем же путём, что и обычный ответ.
            { signature: accumulatedReasoningSignature, redacted: accumulatedReasoningRedacted },
            // Блоки с подписями: при мульти-блочном ответе подпись у каждого своя.
            toLlmReasoningBlocks([
              ...(accumulatedReasoningRedacted ?? []).map((data) => ({ text: '', redacted: data })),
              ...(accumulatedReasoning || accumulatedReasoningSignature !== undefined
                ? [{
                  text: accumulatedReasoning,
                  ...(accumulatedReasoningSignature !== undefined
                    ? { signature: accumulatedReasoningSignature }
                    : {}),
                }]
                : []),
            ]),
            // ADR-118 §1/§5: сообщение остаётся сообщением шага — тот же
            // `messageId`, что у `step.started`/`step.finished`, и ход на нём.
            { turnId, stepIndex, status: 'cancelled', messageId: stepMessageId },
            // ADR-102: счётчики/аналитика — расход хода.
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
            ...(cancelStepUsage.estimated ? { usage_estimated: true } : {}),
          });

          // ADR-118 §4: шаг закрыт отменой, ход — тоже.
          publishStepFinished(publishChunk, {
            turnId,
            stepIndex,
            messageId: stepMessageId,
            status: 'cancelled',
            // ADR-118 §4/ADR-102: `step.finished` несёт расход **своего
            // шага** (не хода) — сумма по шагам = расход хода (метрики
            // Prometheus не меняются).
            usage: cancelStepUsage.usage,
            provider: providerName,
            model: cancelModel,
            ...(cancelCost ? { costUsd: cancelCost.costUsd, costCurrency: cancelCost.currency } : {}),
            ...(effectiveAgentRole ? { agentRole: effectiveAgentRole } : {}),
          });
          publishTurnFinished(publishChunk, { turnId, status: 'cancelled' });
          turnStarted = false;

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
            turnId,
            draft,
            content: accumulatedContent,
            reasoning: accumulatedReasoning,
            reasoningMeta: {
              signature: accumulatedReasoningSignature,
              redacted: accumulatedReasoningRedacted,
            },
            reasoningBlocks: iterationReasoningBlocks
              ?? toLlmReasoningBlocks([
                ...(accumulatedReasoningRedacted ?? []).map((data) => ({ text: '', redacted: data })),
                ...(accumulatedReasoning || accumulatedReasoningSignature !== undefined
                  ? [{
                    text: accumulatedReasoning,
                    ...(accumulatedReasoningSignature !== undefined
                      ? { signature: accumulatedReasoningSignature }
                      : {}),
                  }]
                  : []),
              ]),
            model: finalModel,
            providerName,
            agentRole: effectiveAgentRole,
            usage: iterationUsage,
            iteration: toolIteration,
            startedAt: streamStartedAt,
            promptChars: iterationPromptChars,
            debugCollector,
            promptMeta,
            publishChunk,
          });
          continue;
        }

        // ADR-102: расход текущей итерации (шага) — в расход хода. Ровно один
        // раз за итерацию: `iterationUsage` — последний usage, присланный
        // провайдером в этой итерации (суммировать по чанкам нельзя —
        // провайдеры шлют usage в разных чанках).
        //
        // Прерванная генерация (`cancelToken.interrupted` выше) сюда не
        // доходит: её расход уже записан в сообщение прерванного шага —
        // иначе двойной счёт (и в счётчиках сессии, и в аналитике).
        if (iterationUsage) {
          turnUsage = addTokenUsage(turnUsage, iterationUsage);
          // ADR-102: стоимость шага — по модели **этого** вызова (не финальной).
          const stepCost = this._computeMessageCost(chunkModel ?? finalModel, iterationUsage);
          if (stepCost) {
            turnCostByCurrency[stepCost.currency] =
              (turnCostByCurrency[stepCost.currency] ?? 0) + stepCost.costUsd;
            turnCostBreakdown.input += stepCost.breakdown.input;
            turnCostBreakdown.output += stepCost.breakdown.output;
            turnCostBreakdown.cacheRead += stepCost.breakdown.cacheRead;
            turnCostBreakdown.cacheWrite += stepCost.breakdown.cacheWrite;
          }
        }

        finalModel = chunkModel ?? finalModel;

        // Блоки reasoning итерации: провайдер отдаёт их со своими подписями
        // (мульти-блочный ответ Anthropic), иначе — legacy fallback на одно поле
        // подписи (OpenAI-совместимые провайдеры, старые чанки).
        const iterationBlocks: Array<{ text: string; signature?: string; redacted?: string }> =
          iterationReasoningBlocks && iterationReasoningBlocks.length > 0
            ? iterationReasoningBlocks.map((block) => ({
              text: block.text,
              ...(block.signature !== undefined ? { signature: block.signature } : {}),
              ...(block.redactedData ? { redacted: block.redactedData } : {}),
            }))
            : [
              ...(accumulatedReasoningRedacted ?? []).map((data) => ({ text: '', redacted: data })),
              ...(accumulatedReasoning || accumulatedReasoningSignature !== undefined
                ? [{
                  text: accumulatedReasoning,
                  ...(accumulatedReasoningSignature !== undefined
                    ? { signature: accumulatedReasoningSignature }
                    : {}),
                }]
                : []),
            ];
        if (iterationBlocks.length > 0) {
          for (const block of iterationBlocks) {
            // Накопление через общий с UI хелпер: провайдер шлёт reasoning
            // кумулятивно, повтор в новой итерации не должен дать дубль.
            allReasoning = appendReasoningBlock(allReasoning, block.text, toolIteration, {
              ...(block.signature !== undefined ? { signature: block.signature } : {}),
              ...(block.redacted !== undefined ? { redacted: block.redacted } : {}),
            });
          }
        }

        // Шаг-лимит: ответ мог прийти нестандартным — с `toolCalls`, хотя
        // `toolChoice: 'none'` вызов запрещает. Вызовы НЕ исполняются, но и не
        // выбрасываются: ниже на каждый пишется парный `tool`-результат с
        // ошибкой `tool.disabled_by_step_limit` (паритет с opencode) — иначе
        // assistant(tool_calls) остался бы без пары.

        // No tool calls — final response
        if (!toolCalls || toolCalls.length === 0) {
          finalContent = accumulatedContent;
          // ADR-102: расход финальной итерации уже в `turnUsage` (накопление
          // выше) — в финальное сообщение уйдёт сумма расходов всех шагов.
          // Шаг 2б: дожидаемся последней записи, запоминаем черновик — финальное
          // сообщение обновит его (не добавит второй assistant в историю).
          await draft.flush();
          currentDraft = draft.ref();
          await draft.dispose();
          // ADR-118 §4: `step.finished` финального шага публикует эпилог
          // (`process-finalize`) — там уже известны вложения ответа, отладочные
          // данные и тайминги.
          break;
        }

        // ADR-118 §1: текст шага с вызовами уже сохранён его сообщением
        // (черновик → `draft.finalize` ниже) — сводка промежуточных текстов для
        // сообщений хода не нужна (и не собирается).

        // Шаг 2а/2б: сразу фиксируем assistant-сообщение итерации с toolCalls (до
        // исполнения тулов) — падение/отмена в середине хода не должны терять
        // уже полученный ответ модели. Черновик частичного стрима превращается
        // в промежуточное сообщение шага (metadata заменяется целиком,
        // streaming убирается); пара tool-сообщений пишется ниже
        // (`_persistToolResult`) по мере готовности результатов.
        //
        // `tool_chain` — маркер «служебное сообщение, скрыть в транскрипте».
        // Ставим его ТОЛЬКО когда у шага нет видимого текста: шаг с текстом —
        // реальный ответ агента, и после перезагрузки страницы он обязан
        // остаться в истории (иначе ответ «исчезает»).
        // ADR-118 §1: шаг с вызовами инструментов **виден** (даже без текста):
        // на нём рисуются карточки инструментов (`metadata.tool_results`),
        // которые иначе дублировались бы в финале хода.
        const stepParts = [makeTextPart(accumulatedContent), ...makeReasoningParts(iterationBlocks)];
        const stepVisible = hasVisibleStepContent(accumulatedContent, stepParts)
          || toolCalls.length > 0;
        // ADR-102/ADR-118: расход **своего** шага — в сообщение шага и
        // `step.finished`; стоимость сообщения — от этого же usage.
        const toolStepModel = chunkModel ?? finalModel;
        const toolStepUsage = iterationUsage ?? finalUsage;
        const toolStepCost = this._computeMessageCost(toolStepModel, toolStepUsage);
        const finalizedStepRef = await draft.finalize({
          content: accumulatedContent,
          parts: stepParts,
          reasoning: accumulatedReasoning || undefined,
          toolCalls,
          model: toolStepModel,
          usage: toolStepUsage,
          metadata: {
            stream_id: streamId,
            ...(stepVisible ? {} : { tool_chain: true }),
            // ADR-102: длительность **своего** вызова (TPS последнего шага).
            step_duration_ms: Date.now() - stepStartedAt,
            ...(toolStepCost
              ? {
                  cost_usd: toolStepCost.costUsd,
                  cost_currency: toolStepCost.currency,
                  cost_breakdown: toolStepCost.breakdown,
                }
              : {}),
          },
          // ADR-118 §5: шаг завершён — статус сообщения терминальный.
          status: 'completed',
        });
        /**
         * ADR-118 §1: **шаг-лимит** — запись шага с вызовами уже сохранена и
         * несёт текст ответа. Финализация хода её **дополняет** (статус/usage/
         * metadata), а не создаёт вторую запись с тем же текстом (в ленте был
         * дубль «шаг + финал»). Для обычных шагов запись не переиспользуется:
         * ход продолжается следующим шагом.
         */
        if (stepLimitStep) stepLimitStepRecord = finalizedStepRef;

        // ADR-118 §1/§4: вызовы инструментов — части сообщения шага
        // (`part.updated`, `partId` = `callId` провайдера).
        for (const tc of toolCalls) {
          const callId = typeof tc.id === 'string' ? tc.id : '';
          if (!callId) continue;
          publishPartUpdated(publishChunk, {
            messageId: stepMessageId,
            partId: toolCallPartId(callId),
            part: toolCallPart(callId, tc),
          });
        }
        // ADR-118 §4: шаг закрыт (ответ с вызовами инструментов).
        publishStepFinished(publishChunk, {
          turnId,
          stepIndex,
          messageId: stepMessageId,
          status: 'completed',
          usage: toolStepUsage,
          provider: providerName,
          ...(toolStepModel ? { model: toolStepModel } : {}),
          ...(toolStepCost
            ? { costUsd: toolStepCost.costUsd, costCurrency: toolStepCost.currency }
            : {}),
          ...(effectiveAgentRole ? { agentRole: effectiveAgentRole } : {}),
          timings: stepTiming.snapshot(),
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
          // Anthropic: в tool-loop thinking обязан вернуться в историю вместе
          // с подписью — иначе следующий запрос отвергается API. Блоки — со
          // своими подписями (`reasoningBlocks`), legacy-поля — fallback.
          reasoning: accumulatedReasoning || undefined,
          reasoningBlocks: toLlmReasoningBlocks(iterationBlocks),
          reasoningSignature: accumulatedReasoningSignature,
          reasoningRedacted: accumulatedReasoningRedacted,
          agentRole: effectiveAgentRole,
        });

        if (stepLimitStep && toolCalls.length > 0) {
          warning('ORCHESTRATOR', `Шаг-лимит: провайдер вернул ${toolCalls.length} tool call(s) при toolChoice='none' — вызовы не исполняются`);
        }

        // Execute each tool call
        // ADR-070 §2.8: durable state-сообщение о смене режима (plan_enter/
        // plan_exit) вставляется **после всего батча** tool-вызовов итерации —
        // иначе оно встало бы между tool-результатами батча и разорвало
        // цепочку assistant(tool_calls) → tool.
        //
        // ADR-118 §4 (аддитивно): `step.finished` выше — «вызов LLM завершён»,
        // а здесь начинается исполнение инструментов шага. `step.tools.started`
        // снимает смысловой разрыв «шаг completed, а тулы ещё работают»;
        // `callIds` — в порядке модели.
        const stepToolCallIds = toolCalls
          .map((tc) => (typeof tc.id === 'string' ? tc.id : ''))
          .filter((id) => id !== '');
        publishStepToolsStarted(publishChunk, {
          turnId,
          stepIndex,
          messageId: stepMessageId,
          callIds: stepToolCallIds,
        });
        let modeChangePending = false;
        for (const tc of toolCalls) {
          const tcId = (tc.id as string) || `call_${Date.now()}`;
          const func = tc.function as { name: string; arguments: string | Record<string, unknown> } | undefined;

          // Шаг-лимит (паритет с opencode): вызов запрещён `toolChoice: 'none'`,
          // но провайдер его вернул. Не исполняем, а отвечаем модели парным
          // error-результатом — assistant(tool_calls) не должен осиротеть.
          if (stepLimitStep) {
            const limitParams = { tool: func?.name || 'unknown', limit: String(maxIterations) };
            const limited = {
              content: sm('tool.disabled_by_step_limit', limitParams),
              isError: true,
              metadata: {
                i18n: i18nMeta('tool.disabled_by_step_limit', limitParams),
                isError: true,
              },
            };
            currentMessages.push({
              id: '',
              role: 'tool',
              content: limited.content,
              usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
              disabled: false,
              pinned: false,
              branchId: '',
              toolCallId: tcId,
            });
            publishChunk('tool_call.result', {
              stream_id: streamId,
              session_id: session.id,
              call_id: tcId,
              name: limitParams.tool,
              result: limited,
              iteration: toolIteration,
            });
            await this._persistToolResult(
              session.id, streamId, providerName, effectiveAgentRole,
              chunkModel ?? finalModel, limitParams.tool, {}, tcId, limited,
            );
            continue;
          }

          if (!func?.name) {
            // «Кривой» вызов модели (нет имени инструмента): пропустить его
            // нельзя — assistant(tool_calls) остался бы без парного tool, и
            // следующий LLM-вызов упал бы у провайдера («tool_calls must be
            // followed by tool messages»). Пишем error-результат и продолжаем.
            const malformed = {
              content: sm('tool.malformed_call', { tool: 'unknown', id: tcId }),
              isError: true,
              metadata: {
                i18n: i18nMeta('tool.malformed_call', { tool: 'unknown', id: tcId }),
              },
            };
            currentMessages.push({
              id: '',
              role: 'tool',
              content: malformed.content,
              usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
              disabled: false,
              pinned: false,
              branchId: '',
              toolCallId: tcId,
            });
            publishChunk('tool_call.result', {
              stream_id: streamId,
              session_id: session.id,
              call_id: tcId,
              name: 'unknown',
              result: malformed,
              iteration: toolIteration,
            });
            await this._persistToolResult(
              session.id, streamId, providerName, effectiveAgentRole,
              chunkModel ?? finalModel, 'unknown', {}, tcId, malformed,
            );
            continue;
          }

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
            // ADR-114: периметр сессии — рабочий каталог + корень проекта
            // (сессия в worktree). Внутри него путь не считается внешним.
            ...(allowedRoots ? { allowedRoots } : {}),
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
              const doomParams = { tool: toolName, count: String(doomCount) };
              const doomResult = {
                content: sm('tool.doom_loop', doomParams),
                isError: true,
                metadata: { i18n: i18nMeta('tool.doom_loop', doomParams) },
              };
              currentMessages.push({
                id: '',
                role: 'tool',
                content: doomResult.content,
                usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
                disabled: false,
                pinned: false,
                branchId: '',
                toolCallId: tcId,
              });
              publishChunk('tool_call.result', {
                stream_id: streamId,
                session_id: session.id,
                call_id: tcId,
                name: toolName,
                result: doomResult,
                iteration: toolIteration,
              });
              // Пара assistant(tool_calls) → tool обязана попасть в историю:
              // иначе первый же LLM-вызов следующего хода падает у провайдера
              // («tool_calls must be followed by tool messages»).
              await this._persistToolResult(
                session.id, streamId, providerName, effectiveAgentRole,
                chunkModel ?? finalModel, toolName, toolArgs, tcId, doomResult,
              );
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
            // ADR-029 (аддитивно): превью изменений — пользователь подтверждает
            // запись и должен видеть, ЧТО именно изменится. Не посчиталось →
            // превью нет, запрос подтверждения работает как прежде.
            const preview = await this._buildPermissionPreview(toolName, toolArgs, workingDir, session.id);
            // Shell-паттерны, которые будут разрешены кнопкой «Разрешить в сессии».
            // Для `execute_shell` поле `save` передаётся всегда: пустой массив —
            // сигнал «в сессии сохранить нельзя» (паттерн не выводится, кнопка
            // «Разрешить в сессии» не показывается).
            const isShellTool = toolName === 'execute_shell';
            const shellSave = isShellTool && typeof toolArgs.command === 'string'
              ? shellSavePatterns(toolArgs.command)
              : null;
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
                // ADR-029: превью изменений (дифф по файлам).
                ...(preview ? { preview } : {}),
                // Паттерны shell-гранта для полосы подтверждения.
                ...(isShellTool ? { save: shellSave ?? [] } : {}),
              },
              effectivePermissionConfig.askTimeoutMs,
              // «Стоп» снимает ожидание подтверждения (иначе инструмент висел
              // бы до ask-таймаута): отмена хода резолвит `cancelled:true`.
              toolAbortController.signal,
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
              // `cancelled` — снято отменой хода, а не ответом пользователя:
              // это не отказ пользователя, ход завершит штатная отмена.
              const why = approval.cancelled
                ? sm('permission.ask_cancelled')
                : approval.timeout
                  ? sm('permission.ask_timeout')
                  : approval.noSubscribers
                    ? sm('permission.ask_no_subscribers')
                    : sm('permission.ask_denied');
              const baseDeny = this._securityMessage(permissionDecision, 'en')
                ?? `Permission denied: ${permissionDecision.reason}`;
              deniedReason = `${baseDeny} (${why})`;
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
            // ADR-070 §2.9.1 (обновлено 2026-10-29): отказ — ролевой,
            // пользовательский или политики — возвращается модели как обычный
            // `tool_result`; следующая LLM-итерация запускается штатно, модель
            // может выбрать другой инструмент. Ролевой отказ запоминаем только
            // для фоллбек-текста, если содержательного ответа не будет.
            if (permissionDecision.matchedRule === 'role.unavailable') {
              roleBlocked = true;
              roleBlockedTool = toolName;
              roleBlockedAgent = effectiveAgentRole;
            }
            // Предохранитель от бесконечного повтора одного и того же
            // deny-вызова (doom-loop такие вызовы намеренно не считает).
            const denyKey = `${toolName}:${JSON.stringify(toolArgs)}`;
            denyRepeatCount = denyRepeatKey === denyKey ? denyRepeatCount + 1 : 1;
            denyRepeatKey = denyKey;
            if (denyRepeatCount >= MAX_REPEATED_DENY_COUNT) {
              denyLoopExceeded = true;
            }
          } else {
            // Вызов разрешён и исполняется — прогресс есть, счётчик
            // повторяющихся отказов сбрасываем.
            denyRepeatKey = undefined;
            denyRepeatCount = 0;
            // Исключение тула — это результат тула, а не падение хода:
            // модель получает error-результат и продолжает (как у deny).
            // Пара assistant(tool_calls) → tool при этом не рвётся.
            const runTool = async (
              exec: () => Promise<{ content: string; isError?: boolean; metadata?: Record<string, unknown> }>,
            ): Promise<{ content: string; isError?: boolean; metadata?: Record<string, unknown> }> => {
              try {
                return await exec();
              } catch (execErr) {
                const errorText = execErr instanceof Error ? execErr.message : String(execErr);
                warning('ORCHESTRATOR', `Tool "${toolName}" execution failed: ${errorText}`);
                const params = { tool: toolName, error: errorText };
                return {
                  content: sm('tool.exec_error', params),
                  isError: true,
                  metadata: { i18n: i18nMeta('tool.exec_error', params) },
                };
              }
            };
            if (toolDef) {
              toolResult = await runTool(() => executeToolDef(toolDef, toolArgs, {
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
                // ADR-114: perimeter сессии — containment по рабочему каталогу
                // worktree **и** корню проекта; относительные пути — от worktree.
                ...(allowedRoots ? { allowedRoots } : {}),
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
                  // ADR-076: таймауты git-тулов по классу операции (локальные
                  // изменяющие / сетевые). Не заданы — дефолт тула.
                  ...(this._gitLocalTimeoutMs !== undefined
                    ? { gitLocalTimeoutMs: this._gitLocalTimeoutMs }
                    : {}),
                  ...(this._gitNetworkTimeoutMs !== undefined
                    ? { gitNetworkTimeoutMs: this._gitNetworkTimeoutMs }
                    : {}),
                  // Общий предел вывода тулов (`tools.outputMaxLines`/
                  // `tools.outputMaxBytes`) — применяется в `executeToolDef`.
                  ...(this._toolOutputLimits !== undefined
                    ? { toolOutputLimits: this._toolOutputLimits }
                    : {}),
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
                  // Предохранитель по объёму промпта саб-агента (не окно модели).
                  subagentMaxInputTokens: this._getSubagentMaxInputTokens?.() ?? this._subagentMaxInputTokens,
                  // Лимит глубины вложенности саб-агентов (`agents.subagentDepth`).
                  subagentDepth: this._subagentDepth,
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
                  // ADR-115: модальности **текущей** модели хода — тул
                  // `attach_workspace_file` не доставляет заведомо отбрасываемое
                  // вложение (иначе модель повторяла привязку и уходила в цикл).
                  // Источник тот же, что у гидратации; `undefined` — модальности
                  // неизвестны (фильтра нет).
                  modelModalities: this._resolveModalities?.(
                    providerName,
                    provider.model || modelName || session.settings.model || '',
                  ),
                  // ADR-115 (outbound): коллектор медиа-частей ответа хода —
                  // тул `send_attachment` кладёт часть, финализация добавляет её
                  // к финальному сообщению. Не отправка сразу: при отмене/ошибке
                  // хода ничего не уходит (объект остаётся в blob до GC).
                  outboundAttachments: {
                    add: (part: Part) => {
                      outboundParts.push(part);
                    },
                  },
                  // ADR-115: каталог моделей инстанса — тул `list_models`
                  // (модальности, текущая пара, назначения aux-моделей) и
                  // валидация явной пары `task({provider, model})` (TaskExtra).
                  listModels: this._listModels ?? undefined,
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
                  // ADR-071: калиброванный chars-per-token модели — бюджет
                  // промпта саб-агента оценивается тем же ratio, что у родителя.
                  loadTokenRatio: (model: string | undefined) => this._loadTokenRatio(model),
                  // ADR-102: aux-расход fork-summary — в аналитику дочерней сессии.
                  analytics: this._analytics ?? undefined,
                },
              }, toolName));
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
              // ADR-114: периметр доверия — рабочий каталог + корень проекта.
              allowedRoots,
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
                const matches = detection.matches.slice(0, 5).join(', ');
                toolResult = {
                  content: sm('security.injection_blocked', { tool: toolName, matches }),
                  isError: true,
                  metadata: {
                    ...toolResult.metadata,
                    i18n: i18nMeta('security.injection_blocked', { tool: toolName, matches }),
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
          // режим; durable mode_change state-сообщение вставляется **после всего
          // батча** tool-вызовов итерации (ниже) — иначе оно разрывало бы пары
          // assistant(tool_calls) → tool. System prompt mid-turn больше не
          // пересобирается (смена режима его не меняет).
          if (!toolResult.isError && toolName === 'plan_enter') {
            sessionMode = 'plan';
            modeChangePending = true;
          } else if (!toolResult.isError && toolName === 'plan_exit') {
            planApproved = true;
            sessionMode = 'act';
            modeChangePending = true;
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
            projectRoot = await this._resolveProjectWorkspace(session, projectForState);
            workspaceReady = projectRoot !== null;
            // Периметр мог измениться вместе с каталогом/проектом (ADR-114).
            allowedRoots = resolveAllowedRoots(workingDir, projectRoot);
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
        }

        // ADR-118 §1: результаты вызовов шага — в сообщении шага
        // (`metadata.tool_results`), вызовы **этой** итерации: карточки
        // инструментов рисуются на своём шаге и не дублируются в финале
        // хода. Запись — после исполнения всех вызовов итерации (в т.ч. при
        // шаг-лимите/отмене/deny) и до следующего LLM-вызова.
        //
        // ADR-118 §4: `step.tools.finished` — исполнение инструментов шага
        // завершено (результаты записаны). Все терминальные ветки шага
        // (обычное завершение, отмена, deny-цикл, шаг-лимит) сходятся здесь,
        // поэтому событие публикуется ровно один раз; `finally` — гарантия и
        // при сбое записи результатов.
        try {
          await this._persistStepToolResults(
            session.id,
            stepMessageId,
            allToolCalls.filter((tc) => tc.iteration === toolIteration),
          );
        } finally {
          publishStepToolsFinished(publishChunk, {
            turnId,
            stepIndex,
            messageId: stepMessageId,
            callIds: stepToolCallIds,
          });
        }

        // Шаг-лимит: вызовы не исполнялись — ход завершается сразу после
        // парных tool-результатов. Текст ответа модели (если был) становится
        // отчётом; пустой — `session.steps_limit` (см. process-finalize).
        if (stepLimitStep) {
          finalContent = accumulatedContent;
          break;
        }

        // ADR-070 §2.8: durable `mode_change` — после ВСЕХ tool-результатов
        // итерации (пары assistant(tool_calls) → tool не разорваны) и до
        // следующего LLM-вызова. Синтетическое user-сообщение с
        // `<system-state>` тоже дописывается здесь — в текущий диалог.
        if (modeChangePending) {
          await this._appendModeChangeState(
            session, sessionMode, planMode, planApproved, language, currentMessages,
            this._collectUnavailableTools(
              session, sessionMode, planMode, planApproved, agentDef, activeMcpServers,
              { builtin: toolsPolicy !== 'available', mcp: mcpPolicy !== 'available' },
              workspaceReady,
            ),
          );
        }

        // Отмена между тулами итерации (например во время IPI-обработки) —
        // тоже завершаем как отмену, а не идём на следующую LLM-итерацию.
        // «Стоп» приоритетнее любого deny: ход завершается как отмена.
        if (cancelToken.cancelled || toolAbortController.signal.aborted) {
          cancelledBeforeFinal = true;
          break;
        }

        // Защита от бесконечного повтора одинаковых deny-вызовов: tool_result
        // итерации уже в истории (пары assistant(tool_use) → tool не рвутся),
        // следующую LLM-итерацию не запускаем. Финальный текст — фоллбек
        // `session.denied_blocked` (hadDeny), см. process-finalize.
        if (denyLoopExceeded) {
          warning(
            'ORCHESTRATOR',
            `Повторяющиеся deny-вызовы (${denyRepeatCount} подряд) — ход завершается`,
          );
          break;
        }

        // ADR-115 §«Медиа из инструментов»: вложения результатов тулов этой
        // итерации — отдельной user-репликой в текущий ход (после tool-сообщений,
        // до следующего LLM-вызова). Отменённый ход следующую итерацию не
        // запускает — инъекция не нужна; deny-результаты вложений не несут.
        await this._injectToolAttachments({
          session,
          // Накопленные результаты хода (`allToolCalls`), а не сырые
          // `toolCalls` ответа модели: у последних нет ни `result`, ни
          // `iteration` — инъекция не увидела бы ни одного вложения.
          toolCalls: allToolCalls,
          iteration: toolIteration,
          currentMessages,
          providerName,
          modelId: provider.model || modelName || session.settings.model || '',
          language,
          workingDir,
          workspaceReady,
          agentRole: effectiveAgentRole,
          author,
          publishChunk,
        });

        publishChunk('tool_call.loop', {
          stream_id: streamId,
          session_id: session.id,
          iteration: toolIteration,
          total_tool_calls: toolCalls.length,
        });

        toolIteration++;
      }

      // Этап 1 roadmap 0.13 (блок 3): конец хода — снимаем вопросы **этого**
      // хода (оставшиеся `pending`). Вопросы других ходов/сессий не трогаем.
      await this._cancelTurnQuestions(session.id, streamId);

      // ADR-095 (шаг 6b-1): эпилог (ветка отмены до финального сохранения,
      // фоллбек-тексты, quality-check/escalation, персист tool-chain, финальное
      // сообщение, `stream.done`, авто-тайтл, триггеры оптимизации контекста)
      // вынесен в `orchestrator/phases/process-finalize.ts`.
      return runProcessFinalize(
        { session, streamId, publishChunk, debugCollector, streamStartedAt, streamTiming: lastStepTiming },
        {
          cancelledBeforeFinal, lastChunkModel, finalModel, finalUsage, finalContent, fallbackI18n,
          // Причина завершения финального ответа: `max_tokens` при пустом
          // `content` — исчерпанный лимит вывода, а не пустой ответ модели.
          finishReason: finalFinishReason,
          // ADR-102: расход хода (сумма шагов) — в счётчики сессии и аналитику;
          // `finalUsage` — расход последнего вызова.
          turnUsage,
          turnCostByCurrency,
          turnCostBreakdown,
          hadDeny, toolIteration, maxIterations, stepLimitExecuted,
          roleBlocked, roleBlockedTool, roleBlockedAgent,
          lastIterationPromptChars, allReasoning, allIntermediateTexts, allToolCalls,
          currentMessages, promptMeta, loadedTokenRatio, routingDecision,
          provider, providerName, effectiveAgentRole, effectiveReasoningLevel, finalSystemPrompt,
          currentDraft,
          // ADR-118 §1/§4: ход и финальный шаг (сообщение/индекс).
          turnId,
          finalStepIndex: toolIteration,
          finalStepMessageId: lastStepMessageId,
          finalStepStartedAt: lastStepStartedAt,
          finalStepDurationMs: lastStepDurationMs,
          // ADR-118 §1: запись шага-лимита (если шаг закрыт вызовами) —
          // финализация дополняет её, а не создаёт дубль с тем же текстом.
          stepLimitStepRecord,
          // ADR-115 (outbound): медиа-части ответа (`send_attachment`).
          outboundParts,
        },
        this._processFinalizeDeps(),
      );
    } catch (e) {
      const errMsg = String(e);
      warning('ORCHESTRATOR', `Unexpected error: ${errMsg}`);
      this._cancellationTokens.delete(streamId);
      // ADR-118 §4: ход, начатый публикацией `turn.started`, закрывается
      // терминальным статусом (иначе клиент ждёт конца хода бесконечно).
      if (turnStarted) {
        publishTurnFinished(publishChunk, { turnId, status: 'error' });
        turnStarted = false;
      }
      // Внешний catch может сработать до инициализации локальных переменных
      // (usage/model/prompt) — сохраняем ошибку с безопасным минимумом.
      return this._handleLlmFailure(session.id, streamId, e, attempt, {
        debugCollector,
        durationMs: Date.now() - streamStartedAt,
        model: session.settings.model,
        providerName: session.settings.provider,
        agentRole: effectiveAgentRole,
        // ADR-118 §1/§5: ход известен всегда; шаг — только если сбой случился
        // внутри цикла (там передаётся точный `stepIndex`/`messageId`).
        step: { turnId, status: 'error' },
      });
    } finally {
      this._streamSessions.delete(streamId);
    }
  }

  /**
   * ADR-118 §1/§10: метка хода на реплике пользователя, с которого ход начался.
   *
   * UI группирует сегменты хода по `turn_id`, а подавление отключённых реплик
   * (`engine/context/disabled-turns.ts`) гасит ход именно по `turnId` — без
   * метки на user-сообщении работает только legacy-фоллбек «по соседству».
   * Обновление одно на ход, под локом сессии и по `id`; реплику с уже
   * проставленным `turnId` не перезаписываем. Best-effort: сбой записи ход не
   * роняет (метка нужна UI и подавлению, а не самому ответу).
   */
  private async _markTurnUserMessage(
    sessionId: string,
    message: Message,
    turnId: string,
  ): Promise<void> {
    if (message.role !== MessageRole.USER) return;
    try {
      await this._sessionManager.withLock(sessionId, async (s) => {
        let changed = false;
        // ADR-118 §10: метка хода в `currentStream` — UI восстанавливает ход
        // после перезагрузки страницы (`current_stream.turn_id` в DTO).
        if (s.currentStream && s.currentStream.turnId !== turnId) {
          s.currentStream.turnId = turnId;
          changed = true;
        }
        // Реплику с уже проставленным turnId не перезаписываем (повторный
        // вход в тот же ход) — метка `currentStream` при этом обновляется.
        if (!message.turnId) {
          const target = s.messages.find((m) => m.id === message.id);
          if (target && !target.turnId) {
            target.turnId = turnId;
            message.turnId = turnId;
            changed = true;
          }
        }
        if (changed) await this._sessionManager.saveSession(s);
      });
    } catch (err) {
      warning(
        'ORCHESTRATOR',
        `Не удалось проставить turnId реплике пользователя: ${err instanceof Error ? err.message : String(err)}`,
      );
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
        // ADR-118 §10: id хода в UI ребёнка (совпадает с `turn.started` цикла).
        turnId: childSessionId,
        message: sm('task.resume_marker'),
        agentRole: s.settings.agentRole,
        startedAt: nowISO(),
        cancelled: false,
        // Владелец маркера — процесс инстанса (recovery после рестарта).
        owner: this._sessionManager.instanceId,
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
            // Снимаем только свой маркер (ADR-118 §10): в сессии мог уже
            // начаться новый ход с другим `streamId`.
            if (s.currentStream && s.currentStream.streamId !== streamId) return;
            s.currentStream = undefined;
            // Прогон завершён — состояние ретрая (если было) неактуально.
            s.retry = undefined;
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
      // Предохранитель по объёму промпта resumed-саб-агента (как у `task`).
      subagentMaxInputTokens: this._getSubagentMaxInputTokens?.() ?? this._subagentMaxInputTokens,
      // ADR-070 §2.9.1: dependency-гейт и `[НЕДОСТУПНЫЕ ТУЛЫ]` resumed-саб-агента.
      runtimeDeps: this._runtimeDeps,
      shellPolicy: this._getProtectedPaths() ?? undefined,
      protectedPaths: this._getProtectedPaths() ?? undefined,
      protectedPathsEnabled: this._getProtectedPathsEnabled(),
      // ADR-070: live-стоимость resumed-саб-агента тем же загрузчиком цен.
      modelPriceLoader: this._modelPriceLoader ?? undefined,
      // ADR-102: aux-расход (fork summary) — в аналитику дочерней сессии.
      analytics: this._analytics ?? undefined,
      // ADR-071: калиброванный chars-per-token resumed-саб-агента.
      loadTokenRatio: (model) => this._loadTokenRatio(model),
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
      // ADR-076: таймауты git-тулов по классу операции (локальные/сетевые).
      ...(this._gitLocalTimeoutMs !== undefined
        ? { gitLocalTimeoutMs: this._gitLocalTimeoutMs }
        : {}),
      ...(this._gitNetworkTimeoutMs !== undefined
        ? { gitNetworkTimeoutMs: this._gitNetworkTimeoutMs }
        : {}),
      // Общий предел вывода тулов (`tools.outputMaxLines`/`tools.outputMaxBytes`).
      ...(this._toolOutputLimits !== undefined
        ? { toolOutputLimits: this._toolOutputLimits }
        : {}),
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
      // Пара прогона — из клона настроек ребёнка; sampling агента — overrides.
      getProvider: (child, overrides) => this._getProvider(
        child.settings.provider || '',
        child,
        child.settings.reasoningLevel,
        { topP: overrides?.topP, topK: overrides?.topK },
      ),
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
      // Thinking-модели DeepSeek: явный override из каталога моделей.
      ...(this._resolveModelCompatibility
        ? { resolveModelCompatibility: this._resolveModelCompatibility }
        : {}),
      ...(this._resolveModelMaxOutputTokens
        ? { resolveModelMaxOutputTokens: this._resolveModelMaxOutputTokens }
        : {}),
      defaultMaxOutputTokens: this._defaultMaxOutputTokens,
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

  private _getProvider(
    providerName: string,
    session: Session,
    reasoningLevel?: ReasoningLevel,
    overrides: ProviderOverrides = {},
  ) {
    return getProvider(providerName, session, reasoningLevel, this._routingDeps(), overrides);
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
   * `overrides` — явный выбор/сэмплинг агента (см. `ProviderOverrides`).
   */
  private async _routeProvider(
    session: Session,
    message: Message,
    reasoningLevel?: ReasoningLevel,
    debugCollector?: DebugCollector,
    overrides: ProviderOverrides = {},
  ): Promise<{ provider: BaseProvider; providerName: string; modelName: string; decision?: RoutingDecision } | null> {
    return routeProvider(session, message, reasoningLevel, debugCollector, this._routingDeps(), overrides);
  }

  static _sessionMessagesToLlm(
    messages: Message[],
    currentAgentRole?: string,
    currentAuthor?: string,
    currentPair?: CurrentModelPair,
  ): LLMMessage[] {
    return sessionMessagesToLlmFn(messages, currentAgentRole, currentAuthor, currentPair);
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
      // ADR-115 (outbound): ссылки на объекты вложений ответа — иначе GC
      // удалит их по TTL, хотя сообщение на них ссылается.
      blobRefs: this._blobRefs ?? undefined,
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
    /** ADR-118 §1: ход, в котором прервана генерация. */
    turnId: string;
    draft: StreamMessageDraft;
    content: string;
    reasoning: string;
    /**
     * Anthropic: подпись thinking-блока и opaque `redacted_thinking` прерванной
     * генерации — без них следующая итерация tool-loop отвергается API (ход
     * продолжается, thinking обязан вернуться в историю).
     */
    reasoningMeta?: { signature?: string; redacted?: string[] };
    /**
     * Anthropic: блоки reasoning прерванной генерации (каждый со своей
     * подписью) — пишутся в `parts` сообщения.
     */
    reasoningBlocks?: ReasoningBlockLike[];
    model: string | undefined;
    providerName: string;
    agentRole: string | undefined;
    /** Расход текущей итерации (если провайдер успел прислать) — шага. */
    usage: TokenUsage | undefined;
    iteration: number;
    startedAt: number;
    /** Размер промпта итерации (символы) — для оценки usage. */
    promptChars: number;
    debugCollector: DebugCollector;
    promptMeta: PromptMeta | undefined;
    publishChunk: (event: string, data: Record<string, unknown>) => void;
  }): Promise<void> {
    const {
      session, streamId, turnId, draft, content, reasoning, model, providerName, agentRole,
      usage, iteration, startedAt, promptChars, debugCollector, promptMeta, publishChunk,
      reasoningMeta, reasoningBlocks,
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
        // ADR-115: медиа-частей ответа в ветке прерывания нет.
        undefined,
        // Anthropic: подпись thinking-блока прерванной генерации — ход
        // продолжается, следующий запрос обязан вернуть thinking в историю.
        reasoningMeta,
        reasoningBlocks,
        // ADR-118 §1/§5: прерванная генерация — сообщение шага (`step.finished`
        // публикуется со статусом `cancelled` ниже) и часть того же хода.
        { turnId, stepIndex: iteration, status: 'cancelled', messageId: draft.messageId() },
      );
    }

    // ADR-118 §4: прерывание генерации = шаг закрыт статусом `cancelled`
    // (замена удалённого `stream.interrupted`); ход продолжается.
    publishStepFinished(publishChunk, {
      turnId,
      stepIndex: iteration,
      messageId: draft.messageId(),
      status: 'cancelled',
      usage: estimated.usage,
      provider: providerName,
      ...(model ? { model } : {}),
      ...(cost ? { costUsd: cost.costUsd, costCurrency: cost.currency } : {}),
      ...(agentRole ? { agentRole } : {}),
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
    turnId?: string,
  ): Promise<void> {
    // Общая точка применения инъекций (ADR-104) — её же использует цикл
    // саб-агента (`engine/tools/task/run-cycle.ts`): семантика инъекции
    // (лимит, порядок, маркеры, payload событий) не должна расходиться
    // между основной сессией и дочерней.
    //
    // ADR-118 §4: `message.injected` удалён без dual-emit — материализация
    // сообщения в истории публикуется как `message.delivered` (id, `ord`,
    // роль, автор; без текста — текст в канал сессии не уходит).
    let deliveredOrd: number | undefined;
    await applySteerInjections({
      sessionManager: this._sessionManager,
      sessionId: session.id,
      llmMessages: currentMessages,
      toLlmMessages: (message) => sessionMessagesToLlmFn([message], agentRole, author),
      persist: async (message) => {
        const stored = await this._sessionManager.appendMessage(session.id, message);
        // ADR-118 §2: `ord` — монотонный порядок записи в истории.
        deliveredOrd = stored?.ord ?? message.ord;
        // Позиция сообщения в истории (0-based) — как в `GET /:id/messages`,
        // чтобы UI мог добавить его в ленту без полной перезагрузки.
        return { index: (stored?.seq ?? message.seq) - 1 };
      },
      publishInjected: (event) => {
        publishChunk('message.delivered', {
          messageId: event.message_id,
          ord: deliveredOrd ?? 0,
          role: MessageRole.USER,
          ...(event.author ? { author: event.author } : {}),
          // ADR-118 §4 (аддитивно): ход, в который вмешались, — клиент
          // привязывает инъекцию к нему (группировка по `turn_id`).
          ...(turnId ? { turnId } : {}),
        });
      },
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
  ): Promise<boolean> {
    const saved = await this._sessionManager.appendMessage(sessionId, {
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
    if (!saved) {
      // Диагностика: цепочка tool-пар могла остаться разорванной — следующий
      // ход вылечит её `recoverStreamingMessages`, но факт нужно видеть в логе.
      warning(
        'ORCHESTRATOR',
        `tool_result для вызова ${toolCallId} (${toolName}) не сохранён в истории сессии ${sessionId}`,
      );
      return false;
    }
    return true;
  }

  /**
   * ADR-118 §1: `metadata.tool_results` сообщения **шага** — вызовы этой
   * итерации (`name`/`args`/`id`/`result`/`started_at`/`completed_at`/
   * `iteration`, как в `allToolCalls`). Карточки инструментов рисуются на
   * своём шаге; в финале хода их нет (финал = последний шаг).
   *
   * Запись — **точечная** и **под локом сессии** (`withLock`, как
   * `_markTurnUserMessage`): история целиком не переписывается, поэтому
   * параллельные append/update других сообщений не теряются. Меняется
   * только `metadata.tool_results` сообщения с нужным `id`; если ничего не
   * изменилось — записи нет. Best-effort: ошибка хранилища ход не роняет.
   * Идемпотентно — повторная запись пишет тот же массив.
   *
   * Полная перезапись сессии (`saveSession`) здесь не годится: она писала бы
   * всю историю на каждом шаге (лишняя загрузка/запись) и затирала бы
   * параллельные точечные записи других сообщений.
   *
   * ⚠️ Окно между `step.finished` шага и этой записью: `step.finished` для
   * шага с вызовами публикуется **до** запуска тулов (контракт UI: карточка
   * инструмента остаётся видимой, результат приходит позже через
   * `tool_call.result` — `packages/ui/AGENTS.md`, «Чат: рендер хода»).
   * Поэтому после перезагрузки страницы в этом окне карточка тула ещё не
   * подтянута из истории — live-часть (`tool_call.result`) её показывает.
   */
  private async _persistStepToolResults(
    sessionId: string,
    messageId: string,
    toolResults: Array<Record<string, unknown>>,
  ): Promise<void> {
    if (toolResults.length === 0) return;
    try {
      await this._sessionManager.withLock(sessionId, async (s) => {
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
        // Точечная запись одного сообщения (порт): историю целиком не
        // переписываем — параллельные append/update не теряются.
        await this._sessionManager.updateMessage(sessionId, {
          ...target,
          metadata: { ...(target.metadata ?? {}), tool_results: toolResults },
        });
      });
    } catch (err) {
      warning(
        'ORCHESTRATOR',
        `Не удалось записать результаты вызовов в сообщение шага ${messageId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
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
    /**
     * Шаг 2б: обновить существующий черновик частичного стрима вместо append.
     * ADR-118 §1: `keepContent` — «дополнить существующее сообщение» (шаг-лимит:
     * содержимое записи шага не перезаписывается).
     */
    existing?: ExistingMessageRef,
    /** ADR-115 (outbound): медиа-части ответа хода (после текста). */
    extraParts?: Part[],
    /** Anthropic: подпись thinking-блока и opaque `redacted_thinking`. */
    reasoningMeta?: { signature?: string; redacted?: string[] },
    /** Anthropic: все блоки reasoning ответа (пишутся в `parts`). */
    reasoningBlocks?: ReasoningBlockLike[],
    /**
     * ADR-118 §1/§5: ход, шаг и статус сообщения шага. Передаётся **последним**
     * аргументом — в той же позиции, что и у `persistence.saveAssistantMessage`;
     * без этого поля `Message.turnId`/`stepIndex`/`status` оставались `null`.
     */
    step?: AssistantMessageStep,
    /** ADR-102: расход хода (счётчики/аналитика) — отдельно от usage сообщения. */
    turnUsage?: TokenUsage,
    /** ADR-102: стоимость расхода хода (если уже посчитана). */
    precomputedTurnCost?: ReturnType<typeof computeUsageCost> | null,
    /** ADR-102: стоимость хода по шагам (валюта → сумма). */
    turnCostByCurrency?: Record<string, number>,
    /** ADR-102: компонентная разбивка стоимости хода для счётчиков. */
    turnCostBreakdown?: UsageCostBreakdown,
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
      extraParts,
      reasoningMeta,
      reasoningBlocks,
      step,
      turnUsage,
      precomputedTurnCost,
      turnCostByCurrency,
      turnCostBreakdown,
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
  /**
   * Shell-грант паттернами (`execute_shell: { "git status *": "allow" }`).
   * Строка `allow` (весь инструмент) не понижается.
   */
  private _applyShellAllow(
    cfg: PermissionConfig | undefined,
    patterns: string[],
  ): PermissionConfig {
    const base = cfg ?? {
      rules: { ...this._permissionConfig.rules },
      askTimeoutMs: this._permissionConfig.askTimeoutMs,
    };
    const rules = { ...base.rules };
    if (rules.execute_shell !== 'allow') {
      const existing = (typeof rules.execute_shell === 'object' && rules.execute_shell)
        ? { ...(rules.execute_shell as Record<string, string>) }
        : {};
      for (const pattern of patterns) existing[pattern] = 'allow';
      rules.execute_shell = existing as PermissionRule;
    }
    return { ...base, rules };
  }

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
    const shellCommand = toolName === 'execute_shell' && typeof toolArgs.command === 'string'
      ? toolArgs.command
      : null;
    const shellPatterns = shellCommand !== null ? shellSavePatterns(shellCommand) : null;
    // Shell-грант выдаётся ТОЛЬКО паттернами: если команда нерезолвима (`null`,
    // например `C='cat /etc/shadow'; $C`) или паттернов нет, `execute_shell: 'allow'`
    // выдавать нельзя — это шире одобренного. Текущий вызов уже одобрен один раз,
    // будущие спросят снова; конфиг не меняем и зря не сохраняем/паблишим.
    if (shellCommand !== null && (shellPatterns === null || shellPatterns.length === 0)) {
      return session.settings.permission ?? this._permissionConfig;
    }
    const apply = (cfg: PermissionConfig | undefined): PermissionConfig => (
      shellPatterns !== null
        ? this._applyShellAllow(cfg, shellPatterns)
        : this._applyToolAllow(cfg, toolName, paths)
    );
    const next = apply(session.settings.permission);

    await this._sessionManager.withLock(session.id, async (s) => {
      s.settings.permission = next;
      await this._sessionManager.saveSession(s);
      this._eventBus.publish(session.id, 'session.updated', {
        session_id: session.id,
        settings: s.settings,
      });
    });

    // Аудит выдачи shell-гранта — fire-and-forget, ход не блокирует.
    if (shellPatterns !== null && shellPatterns.length > 0 && this._onPermissionGrant && shellCommand !== null) {
      void Promise.resolve(this._onPermissionGrant({
        sessionId: session.id,
        actor: session.ownerId ?? 'local',
        patterns: shellPatterns,
        command: shellCommand,
      })).catch(() => {});
    }

    // ADR-029: «Разрешить в сессии» для сабагентской (дочерней) сессии
    // распространяется и на родителя (parentId): путь в правиле — абсолютный
    // канонический, поэтому грант совпадёт при чтении того же файла и родителем,
    // и ребёнком. Родительский грант обновляет и effectivePermissionConfig, и
    // PermissionEvaluator при следующей обработке (сессия сохраняется в store).
    if (session.parentId) {
      await this._sessionManager.withLock(session.parentId, async (parent) => {
        parent.settings.permission = apply(parent.settings.permission);
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

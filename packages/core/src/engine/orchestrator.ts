import type { Message, Project, Session, ProviderConfig as SharedProviderConfig, TokenUsage } from '@synth/shared';
import { MessageRole, nowISO, ToolCapability, generateId, makeTextPart } from '@synth/shared';
import type { RouterConfig, PermissionConfig, PlanMode, SessionMode, SecurityConfig, LLMGatewayConfig } from '@synth/shared';
import { join, isAbsolute, normalize, resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import type { SessionManager } from '../sessions/manager.js';
import type { EventBus } from '../events/bus.js';
import { DebugCollector } from '../debug.js';
import { ProviderFactory } from '../providers/base.js';
import type { LLMMessage, CancellationToken, ProviderConfig as CoreProviderConfig, BaseProvider } from '../providers/base.js';
import { ContextBuilder } from './context/builder.js';
import { ContextOptimizer } from './context/optimizer.js';
import { ContextConfig } from './context/config.js';
import type { ToolRegistry } from './tools/registry.js';
import type { ToolForLLM } from '@synth/shared';
import type { AgentRegistry } from './agents/registry.js';
import type { McpManager } from './mcp/manager.js';
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
import { PermissionEvaluator } from './permission/evaluator.js';
import { PermissionApprovalManager } from './permission/approval.js';
import { emptyPermissionConfig } from './permission/derive.js';
import { getToolTrust } from './security/trust.js';
import { detectPromptInjection, applyPolicy, wrapContent, buildWarnLine } from './security/prompt-injection.js';
import { GatewayProvider, AuditLogger, RateLimiter, ObfuscationMapStore, obfuscateSecrets, maskSecret, PLACEHOLDER_PATTERN, type SecretPatternStore } from './gateway/index.js';

const MAX_DOOM_LOOP_COUNT = 3;
const DEFAULT_MAX_ITERATIONS = Number.POSITIVE_INFINITY;

export interface ModelPricing {
  inputPrice?: number;
  outputPrice?: number;
  cacheReadPrice?: number;
  cacheWritePrice?: number;
}

/**
 * Минимальный контракт project store, который использует оркестратор (AD-014):
 * только загрузка проекта для резолва project.workspace. Позволяет передавать
 * реализации из разных пакетов (backend/core ProjectStore) без структурной
 * зависимости от конкретного класса.
 */
export interface ProjectStoreLike {
  load(id: string): Promise<Project | null>;
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
  defaultWorkingDir?: string;
  /**
   * Корень каталога workspaces: `join(dataDir, 'workspaces')` по умолчанию
   * (аналог resolveWorkspacesRoot). Относительные `project.workspace` резолвятся
   * относительно этого корня (AD-014).
   */
  workspacesRoot?: string;
  /** Глобальная секция permission из config.yaml (AD-029). */
  permissionConfig?: PermissionConfig;
  /** Строгость цикла Plan→Build по умолчанию из config.yaml session.planMode (AD-028). */
  defaultPlanMode?: PlanMode;
  /** Секция безопасности (защита от Indirect Prompt Injection). */
  securityConfig?: SecurityConfig;
  /** LLM Gateway (AD-036): глобальный тумблер и конфиг. Выключен по умолчанию. */
  gatewayConfig?: LLMGatewayConfig;
  /** Аудит LLM Gateway — если создаётся снаружи (backend/runner). Иначе создаётся внутри. */
  gatewayAuditLogger?: AuditLogger;
  /** Хранилище кастомных regex-паттернов детекции секретов (override ?? дефолт). */
  gatewayPatternStore?: SecretPatternStore;
}

export interface ProcessMessageResult {
  error?: string;
  errorType?: string;
  canRetry?: boolean;
}

function toCoreProviderConfig(shared: SharedProviderConfig, model: string): CoreProviderConfig {
  return {
    name: shared.name,
    type: shared.type,
    url: shared.baseUrl || '',
    apiKey: shared.apiKey || '',
    model,
    timeout: shared.timeout,
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
  private readonly _loadedMcpServers = new Set<string>();
  private readonly _cancellationTokens = new Map<string, CancellationToken>();
  private readonly _router: ModelRouter | null;
  private readonly _routerConfig: RouterConfig | null;
  private readonly _microPipeline: MicroPipeline | null;
  private readonly _contextConfig: ContextConfig | null;
  private readonly _projectStore: ProjectStoreLike | null;
  private readonly _defaultWorkingDir: string;
  private readonly _workspacesRoot: string;
  private readonly _permissionConfig: PermissionConfig;
  private readonly _approvalManager: PermissionApprovalManager;
  private readonly _defaultPlanMode: PlanMode;
  private readonly _securityConfig: SecurityConfig;
  private readonly _dictionaryStore: DictionaryStore;
  private _gatewayConfig: LLMGatewayConfig | null;
  private _obfMapStore: ObfuscationMapStore | null;
  private _gatewayAudit: AuditLogger | null;
  private _gatewayRateLimiter: RateLimiter | null;
  private readonly _gatewayPatternStore: SecretPatternStore | null;
  private readonly _dataDir: string;
  /** Внешний audit-logger (backend/runner) — переиспользуется при live-включении gateway. */
  private readonly _gatewayAuditExternal: AuditLogger | null;
  private _providerPool: ProviderPool | null;

  /** Публичный доступ к реестру агентов (для сериализации modeApplicable). */
  get agentRegistry(): AgentRegistry | null {
    return this._agentRegistry;
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
    this._defaultWorkingDir = options.defaultWorkingDir ?? join(options.dataDir || '/var/synth/data', 'workspaces', 'default');
    this._workspacesRoot = options.workspacesRoot ?? join(options.dataDir || '/var/synth/data', 'workspaces');
    this._permissionConfig = options.permissionConfig ?? emptyPermissionConfig();
    this._approvalManager = new PermissionApprovalManager(this._eventBus);
    this._defaultPlanMode = options.defaultPlanMode ?? 'auto';
    this._securityConfig = options.securityConfig
      ?? { promptInjection: { enabled: true, wrapContent: true, mode: 'flag' } };
    this._dataDir = options.dataDir || '/var/synth/data';

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
    // Фабрика обёртки для пула: у пула нет сессии, поэтому оборачиваем с пустой
    // картой обфускации (защита от утечки секретов работает, карта не персистится).
    // Для вызовов с сессией оркестратор дополнительно оборачивает через _wrapWithGateway.
    const pool = new ProviderPool(
      options.providerLoader,
      gatewayConfig ?? undefined,
      gatewayConfig
        ? (inner) => new GatewayProvider(inner, gatewayConfig, {
            getMap: async () => ({}),
            saveMap: async () => {},
            getAudit: () => this._gatewayAudit!,
            getRateLimiter: () => this._gatewayRateLimiter!,
            sessionId: '',
            userId: '',
          })
        : undefined,
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
      gatewayConfig
        ? (inner) => new GatewayProvider(inner, gatewayConfig, {
            getMap: async () => ({}),
            saveMap: async () => {},
            getAudit: () => this._gatewayAudit!,
            getRateLimiter: () => this._gatewayRateLimiter!,
            sessionId: '',
            userId: '',
          })
        : null,
    );
  }

  /** AD-036: включён ли LLM Gateway (runtime-тумблер / конфиг). */
  isGatewayEnabled(): boolean {
    return !!this._gatewayConfig;
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

  private async _resolveWorkingDir(session: Session): Promise<string> {
    if (session.projectId && this._projectStore) {
      try {
        const project = await this._projectStore.load(session.projectId);
        if (project?.workspace) {
          // Абсолютный workspace — как есть (normalize); относительный —
          // резолвим относительно workspacesRoot (AD-014).
          return isAbsolute(project.workspace)
            ? normalize(project.workspace)
            : resolve(this._workspacesRoot, project.workspace);
        }
      } catch {
        // проект не загрузился — используем fallback
      }
    }
    const dir = this._defaultWorkingDir;
    await mkdir(dir, { recursive: true }).catch(() => {});
    return dir;
  }

  /**
   * AD-025/AD-027: добавляет в system prompt блоки режима Plan/Act и
   * утверждённого плана. Вызывается при старте обработки и пересобирается
   * после plan_enter/plan_exit в текущей итерации.
   */
  private _buildPlanSystemPrompt(
    base: string,
    session: Session,
    planMode: PlanMode,
    sessionMode: SessionMode,
    planApproved: boolean,
    planContent?: string,
  ): string {
    const parts: string[] = [];

    // AD-025: промпт текущего режима загружается из контекстных файлов
    // (prompts/modes/{mode}.md, переопределяемые через dataDir/context/modes).
    // Если файл не найден — fallback на встроенный текст ниже.
    const language = session.settings.language || 'ru';
    const modePrompt = this._contextConfig?.getModePrompt(sessionMode, language) ?? null;
    if (modePrompt) {
      parts.push(modePrompt);
    } else if (sessionMode === 'plan') {
      parts.push(
        '[MODE: PLAN]\n'
        + 'Ты в режиме планирования: чтение и исследование разрешены, но запись/изменение файлов '
        + 'заблокированы (единственное исключение — .synth/plans/*.md). Изучи задачу, составь план '
        + 'и утверди его через plan_exit(plan="..."), чтобы перейти в режим act.',
      );
    }

    if (planMode === 'auto') {
      parts.push(
        '[PLAN MODE: AUTO]\n'
        + 'Если задача сложная, затрагивает несколько файлов или требует архитектурных решений — '
        + 'вызови plan_enter перед изменениями. Для простых фиксов — делай сразу.',
      );
    } else if (planMode === 'strict') {
      if (planApproved) {
        parts.push(
          '[PLAN MODE: STRICT]\n'
          + 'План утверждён — ты можешь вносить изменения в соответствии с ним.',
        );
      } else {
        parts.push(
          '[PLAN MODE: STRICT]\n'
          + 'Перед любым изменением файлов план обязателен: вызови plan_enter, составь план и утверди '
          + 'его через plan_exit. До утверждения плана запись файлов заблокирована (чтение разрешено).',
        );
      }
    }

    const approvedPlan = planContent ?? session.planContent;
    if (approvedPlan) {
      parts.push(`[APPROVED PLAN]\n${approvedPlan}`);
    }

    if (parts.length === 0) return base;
    return `${base}\n\n${parts.join('\n\n')}`;
  }

  /**
   * processMessage callback для QueueProcessor.
   */
  createProcessMessage(): (
    session: Session,
    message: Message,
    signal: AbortSignal,
    publishChunk: (event: string, data: Record<string, unknown>) => void,
  ) => Promise<ProcessMessageResult> {
    return async (session, message, signal, publishChunk) => {
      return this._processMessage(session, message, signal, publishChunk);
    };
  }

  async _processMessage(
    session: Session,
    message: Message,
    signal: AbortSignal,
    publishChunk: (event: string, data: Record<string, unknown>) => void,
  ): Promise<ProcessMessageResult> {
    const streamId = (message.metadata?.stream_id as string) || 'unknown';
    const effectiveAgentRole = message.agentRole || session.settings.agentRole || 'assistant';
    const author = message.author || 'unknown';
    const workingDir = await this._resolveWorkingDir(session);

    // AD-025: режим Plan/Act — runtime-состояние сессии + строгость из настроек
    const planMode: PlanMode = session.settings.planMode ?? this._defaultPlanMode ?? 'auto';
    let sessionMode: SessionMode = session.mode ?? 'act';
    let planApproved = Boolean(session.planContent);

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

    const debugCollector = new DebugCollector(session.settings.debugEnabled);

    // --- Обработка системных сообщений (суммаризация, шедулер, etc.) ---
    if (message.role === MessageRole.SYSTEM && message.metadata?.type === 'summarization_request') {
      return this._handleSummarization(session, message, signal, publishChunk, debugCollector, streamId);
    }
    if (message.role === MessageRole.SYSTEM && message.metadata?.type === 'debug_system_message') {
      return this._handleDebugSystemMessage(session, message, signal, publishChunk, debugCollector, streamId);
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

        publishChunk('text', { content: finalContent });
        publishChunk('done', { stopped: true });

        // Сохраняем сообщение ассистента
        const microMetadata: Record<string, unknown> = {
          stream_id: streamId,
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
        if (session.messages.filter((m) => m.role === MessageRole.USER).length <= 1) {
          try {
            session.title = `Диалог — ${session.id.slice(0, 8)}`;
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
      const routeResult = this._routeProvider(session, message);
      if (!routeResult) {
        const providerName = (message.provider as string) || session.settings.provider || '';
        return {
          error: `Провайдер ${providerName || 'не указан'} не найден или не настроен`,
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

      // 2. Build context (сначала получить summary из сообщений)
      const optimizedMessages = this._optimizer
        ? this._optimizer.getMessagesForLlm(session)
        : session.messages;

      const summaryContent = optimizedMessages
        .filter((m) => m.role === MessageRole.SUMMARY)
        .map((m) => m.content)
        .join('\n\n');

      const systemPrompt = session.settings.systemPrompt
        || await this._contextBuilder.buildSystemPrompt({
          agentRole: effectiveAgentRole,
          agentContextFile: agentDef?.contextFile,
          historyMessages: session.messages,
          userId: session.userId,
          projectName: session.projectId,
          language: session.settings.language,
          showInterview: session.settings.showInterview,
          stickyNotes: session.stickyNotes,
          summaryContent: summaryContent || undefined,
        });

      // Добавляем инструкцию classify_conversation если routing включен (AD-034)
      let finalSystemPrompt = systemPrompt;
      if (this._router && session.settings.routingEnabled !== false) {
        const lang = session.settings.language || 'ru';
        const classifyInstruction = lang === 'ru'
          ? '\n\n[CLASSIFICATION]\n\nКогда определишь характер задачи, вызови инструмент `classify_conversation` с категорией: coding (написание/изменение кода), research (анализ/исследование), или chat (общий разговор). Это поможет выбрать оптимальную модель для последующих запросов.'
          : '\n\n[CLASSIFICATION]\n\nWhen you determine the nature of the task, call the `classify_conversation` tool with the category: coding (writing/modifying code), research (analysis/investigation), or chat (general conversation). This helps select the optimal model for subsequent requests.';
        finalSystemPrompt = systemPrompt + classifyInstruction;
      }

      // AD-025/AD-027: блоки режима Plan/Act + утверждённый план
      finalSystemPrompt = this._buildPlanSystemPrompt(
        finalSystemPrompt, session, planMode, sessionMode, planApproved,
      );

      // 3. Convert messages for LLM (без summary — они уже в system prompt)
      const messagesForLlm = optimizedMessages.filter((m) => m.role !== MessageRole.SUMMARY);
      const baseLlmMessages = ChatOrchestrator._sessionMessagesToLlm(messagesForLlm, effectiveAgentRole, author);

      // 3.5. Load MCP tools for the session (дифференциально — только изменившиеся серверы)
      const activeMcpServers = session.settings.mcpServers || [];
      const active = new Set(activeMcpServers);

      if (this._mcpManager && this._toolRegistry) {
        const toRemove = [...this._loadedMcpServers].filter((s) => !active.has(s));
        const toAdd = activeMcpServers.filter((s) => !this._loadedMcpServers.has(s));

        for (const name of toRemove) {
          try {
            await this._mcpManager.deregisterTools(name, this._toolRegistry);
            this._loadedMcpServers.delete(name);
          } catch (err) {
            warning(`ORCHESTRATOR`, `Ошибка отключения MCP-сервера "${name}": ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        for (const name of toAdd) {
          try {
            await this._mcpManager.connectServer(name);
            await this._mcpManager.registerTools(name, this._toolRegistry);
            this._loadedMcpServers.add(name);
          } catch (err) {
            warning(`ORCHESTRATOR`, `Ошибка загрузки MCP-сервера "${name}": ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }

      // 4. Get tools from registry, filtered by agent capabilities
      let tools: ToolForLLM[] | undefined;
      if (this._toolRegistry) {
        if (this._agentRegistry && effectiveAgentRole) {
          tools = this._agentRegistry.getToolsForAgent(effectiveAgentRole);
        }
        if (tools === undefined) {
          // Агент не найден в реестре — отдаём только встроенные инструменты (без MCP)
          const allNonMcp = Object.values(ToolCapability).filter(
            (c) => c !== ToolCapability.MCP,
          );
          tools = this._toolRegistry.filterByCapabilities(allNonMcp);
        } else if (tools.length === 0) {
          tools = [];
        }
      }

      // 5. Create cancellation token
      const cancelToken: CancellationToken = {
        cancelled: false,
        cancel: () => {
          cancelToken.cancelled = true;
        },
      };
      this._cancellationTokens.set(streamId, cancelToken);

      signal.addEventListener('abort', () => {
        cancelToken.cancel();
      }, { once: true });

      // 6. Tool loop — stream LLM, execute tools, continue until no tool calls
      let toolIteration = 0;
      const currentMessages: LLMMessage[] = [...baseLlmMessages];
      const doomLoopTracker: Map<string, number> = new Map();
      let finalContent = '';
      const allReasoning: Array<{ text: string; iteration: number }> = [];
      const allIntermediateTexts: Array<{ text: string; iteration: number }> = [];
      let finalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
      let finalModel: string | undefined;
      const allToolCalls: Array<Record<string, unknown>> = [];
      let stopAfterDeny = false;
      let denyStopReason: string | undefined;

      while (toolIteration < maxIterations) {
        if (cancelToken.cancelled) break;

        let accumulatedContent = '';
        let accumulatedReasoning = '';
        let toolCalls: Record<string, unknown>[] | undefined = [];
        let chunkModel: string | undefined;

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
            if (chunk.usage) finalUsage = chunk.usage;
            if (chunk.model) chunkModel = chunk.model;

            if (chunk.toolCalls && chunk.toolCalls.length > 0) {
              toolCalls = chunk.toolCalls;
            }

            // Stream UI chunks (content from all iterations; reasoning always)
            if (toolIteration === 0) {
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
              } else {
                publishChunk('stream.chunk', {
                  stream_id: streamId,
                  content: chunk.isFinal ? '' : chunk.content,
                reasoning: chunk.reasoning,
                iteration: toolIteration,
                agent_role: effectiveAgentRole,
                model: chunkModel,
                provider: providerName,
              });
            }
          }
        } catch (e) {
          const errMsg = String(e);
          warning('ORCHESTRATOR', `LLM stream error: ${errMsg}`);

          if (accumulatedContent || accumulatedReasoning) {
            await this._saveAssistantMessage(
              session.id, accumulatedContent, streamId, effectiveAgentRole,
              finalUsage, chunkModel, accumulatedReasoning, debugCollector, true, providerName,
            );
          }

          this._cancellationTokens.delete(streamId);
          return {
            error: errMsg,
            errorType: this._classifyError(errMsg),
            canRetry: this._isRecoverable(errMsg),
          };
        }

        if (cancelToken.cancelled) {
          if (accumulatedContent || accumulatedReasoning) {
            await this._saveAssistantMessage(
              session.id, accumulatedContent, streamId, effectiveAgentRole,
              finalUsage, chunkModel, accumulatedReasoning, debugCollector, true, providerName,
            );
          }

          publishChunk('stream.cancelled', {
            stream_id: streamId,
            content: accumulatedContent,
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

          // Doom loop detection
          const doomKey = `${toolName}:${JSON.stringify(toolArgs)}`;
          const doomCount = (doomLoopTracker.get(doomKey) || 0) + 1;
          doomLoopTracker.set(doomKey, doomCount);

          if (doomCount >= MAX_DOOM_LOOP_COUNT) {
            warning('ORCHESTRATOR', `Doom loop detected: ${toolName} called ${doomCount} times with same args`);
            currentMessages.push({
              id: '',
              role: 'tool',
              content: `Ошибка: инструмент "${toolName}" вызван ${doomCount} раз(а) с одинаковыми аргументами. Цикл прерван.`,
              usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
              disabled: false,
              pinned: false,
              branchId: '',
              toolCallId: tcId,
            });
            continue;
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

          const toolDef = this._toolRegistry?.get(toolName);
          let toolResult: { content: string; isError?: boolean; metadata?: Record<string, unknown> };

          // AD-029: гранулярные permissions — проверяем перед выполнением тула.
          // AD-025: учитываем текущий режим Plan/Act и строгость плана.
          const permissionDecision = permissionEvaluator.check({
            toolName,
            params: toolArgs,
            workingDir,
            capabilities: toolDef?.capabilities,
            sessionMode,
            planMode,
            planApproved,
            mcpToolSettings: session.settings.mcpToolSettings,
          });

          let executeTool = permissionDecision.action === 'allow';
          let deniedReason: string | undefined;
          let userDenied = false;

          if (permissionDecision.action === 'deny') {
            deniedReason = permissionDecision.reason;
          } else if (permissionDecision.action === 'ask') {
            const approval = await this._approvalManager.waitForDecision(
              session.id,
              {
                approvalId: `approval_${tcId}`,
                callId: tcId,
                toolName,
                arguments: toolArgs,
                reason: permissionDecision.reason,
              },
              effectivePermissionConfig.askTimeoutMs,
            );
            if (approval.approved) {
              executeTool = true;
              // «Разрешить в сессии» (once:false) — добавляем allow-правило для
              // тула в permission-конфиг сессии, чтобы не спрашивать повторно.
              if (approval.once === false) {
                effectivePermissionConfig = await this._grantSessionToolAllow(session, toolName);
                permissionEvaluator = new PermissionEvaluator(effectivePermissionConfig);
              }
            } else {
              const why = approval.timeout
                ? 'истекло время ожидания подтверждения'
                : approval.noSubscribers
                  ? 'нет подключённого пользователя для подтверждения'
                  : 'отклонено пользователем';
              deniedReason = `${permissionDecision.reason} (${why})`;
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
            toolResult = {
              content: `Permission denied: ${deniedReason}`,
              isError: true,
              metadata: {
                permission: {
                  action: 'deny',
                  reason: deniedReason,
                  matched_rule: permissionDecision.matchedRule,
                },
              },
            };
          } else {
            if (toolDef) {
              const parsed = toolDef.parameters.safeParse(toolArgs);
              if (!parsed.success) {
                toolResult = {
                  content: `Ошибка аргументов инструмента "${toolName}": ${parsed.error.issues.map(i => `${i.path.join('.') || 'root'}: ${i.message}`).join('; ')}`,
                  isError: true,
                };
              } else {
                try {
                  toolResult = await toolDef.execute(parsed.data, {
                    sessionId: session.id,
                    messageId: (message.metadata?.stream_id as string) || streamId,
                    abortSignal: signal,
                    agentRole: effectiveAgentRole,
                    workingDir,
                    dataDir: this._modelPriceLoader ? undefined : undefined,
                    extra: {
                      provider,
                      agentRegistry: this._agentRegistry,
                      sessionManager: this._sessionManager,
                      projectStore: this._projectStore ?? undefined,
                      workspacesRoot: this._workspacesRoot,
                      eventBus: this._eventBus,
                      contextOptimizer: this._optimizer ?? undefined,
                      callerAgentRole: effectiveAgentRole,
                      sessionSettings: {
                        temperature: session.settings.temperature,
                        maxTokens: session.settings.maxTokens,
                      },
                      parentSessionSettings: session.settings,
                      modelRouter: this._router ?? undefined,
                      routerConfig: this._routerConfig ?? undefined,
                      contextConfig: this._contextConfig ?? undefined,
                      securityConfig: this._securityConfig,
                      publish: (type: string, data: Record<string, unknown>) =>
                        publishChunk(type as never, data),
                      streamId,
                      sessionId: session.id,
                      toolRegistry: this._toolRegistry,
                      permissionConfig: effectivePermissionConfig,
                    },
                  });
                } catch (execError) {
                  toolResult = {
                    content: `Ошибка исполнения инструмента "${toolName}": ${String(execError)}`,
                    isError: true,
                  };
                }
              }
            } else {
              toolResult = {
                content: `Инструмент "${toolName}" не найден`,
                isError: true,
              };
            }
          }

          publishChunk('tool_call.result', {
            stream_id: streamId,
            session_id: session.id,
            call_id: tcId,
            name: toolName,
            result: toolResult,
            iteration: toolIteration,
          });

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
                  content: `[BLOCKED] Результат инструмента "${toolName}" заблокирован: обнаружены признаки prompt injection (${detection.matches.slice(0, 5).join(', ')})`,
                  isError: true,
                  metadata: {
                    ...toolResult.metadata,
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

          // AD-025/AD-027: обновляем локальный режим после plan_enter/plan_exit,
          // чтобы ограничения и system prompt применились к следующим тулам/итерациям.
          if (!toolResult.isError && toolName === 'plan_enter') {
            sessionMode = 'plan';
            finalSystemPrompt = this._buildPlanSystemPrompt(
              finalSystemPrompt, session, planMode, sessionMode, planApproved,
            );
          } else if (!toolResult.isError && toolName === 'plan_exit') {
            const meta = (toolResult.metadata ?? {}) as Record<string, unknown>;
            const planContent = typeof meta.plan_content === 'string' ? meta.plan_content : undefined;
            if (planContent) {
              planApproved = true;
              sessionMode = 'act';
            }
            finalSystemPrompt = this._buildPlanSystemPrompt(
              finalSystemPrompt, session, planMode, sessionMode, planApproved, planContent,
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

        publishChunk('tool_call.loop', {
          stream_id: streamId,
          session_id: session.id,
          iteration: toolIteration,
          total_tool_calls: toolCalls.length,
        });

        toolIteration++;
        if (stopAfterDeny) break;
      }

      // 7. Handle max iterations exceeded
      if (toolIteration >= maxIterations && !finalContent) {
        finalContent = '(достигнут лимит итераций инструментов)';
      }

      // AD-029: пользователь отклонил ask — обработка завершена. Фиксируем
      // причину в финальном сообщении (история tool_result уже собрана).
      if (stopAfterDeny && !finalContent) {
        finalContent = `Обработка остановлена: ${denyStopReason ?? 'пользователь отклонил запрос'}`;
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
            const fbProvider = this._router.getProvider(fbDecision);
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
                  qaReason = `Эскалация на ${fallbackProvider}/${fallbackModel}: ${qaResult.reason}`;
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

      // 8. Save final assistant message
      const reasoningJoined = allReasoning.map((r) => r.text).join('\n\n---\n\n');
      const savedContent = await this._saveAssistantMessage(
        session.id, finalContent, streamId, effectiveAgentRole,
        finalUsage, finalModel, reasoningJoined, debugCollector, false, providerName,
        MessageRole.ASSISTANT, undefined, false, allToolCalls, allIntermediateTexts,
        qaPass, qaReason,
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
        reasoning_blocks: allReasoning.length > 0 ? allReasoning : undefined,
        intermediate_text_blocks: allIntermediateTexts.length > 0 ? allIntermediateTexts : undefined,
      };

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
          (m) => m.role === MessageRole.USER && !m.metadata?.synthetic,
        ).length;
        if (userMsgCount === 1) {
          autoTitleSession(updatedSession, this._sessionManager, provider).catch(() => {});
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
      return {
        error: errMsg,
        errorType: 'internal',
        canRetry: false,
      };
    }
  }

  cancel(streamId: string): void {
    const token = this._cancellationTokens.get(streamId);
    if (token) token.cancel();
  }

  private async _handleDebugSystemMessage(
    session: Session,
    message: Message,
    signal: AbortSignal,
    publishChunk: (event: string, data: Record<string, unknown>) => void,
    debugCollector: DebugCollector,
    streamId: string,
  ): Promise<ProcessMessageResult> {
    const providerName = (message.provider as string) || session.settings.provider || '';
    const provider = this._getProvider(providerName, session);
    if (!provider) {
      return {
        error: `Провайдер ${providerName || 'не указан'} не найден или не настроен`,
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
      return { error: String(e), errorType: this._classifyError(String(e)), canRetry: this._isRecoverable(String(e)) };
    }

    if (cancelToken.cancelled) {
      publishChunk('stream.cancelled', { stream_id: streamId, content: accumulatedContent });
      this._cancellationTokens.delete(streamId);
      return {};
    }

    // Сохранить debug-сообщение (без message.added — UI получит его через stream.done)

    await this._saveAssistantMessage(
      session.id, accumulatedContent, streamId, 'debug',
      finalUsage, finalModel, accumulatedReasoning, debugCollector, false, providerName,
      MessageRole.DEBUG, undefined, true,
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
  ): Promise<ProcessMessageResult> {
    if (!this._optimizer) {
      return { error: 'ContextOptimizer not available', errorType: 'internal', canRetry: false };
    }

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
      return { error: String(e), errorType: this._classifyError(String(e)), canRetry: this._isRecoverable(String(e)) };
    }

    if (cancelToken.cancelled) {
      publishChunk('stream.cancelled', { stream_id: streamId, content: accumulatedContent });
      this._cancellationTokens.delete(streamId);
      return {};
    }

    // Сохранить summary-сообщение (без message.added — UI получит его через stream.done)
    await this._saveAssistantMessage(
      session.id, accumulatedContent, streamId, 'summary',
      finalUsage, finalModel, accumulatedReasoning, debugCollector, false, providerName,
      MessageRole.SUMMARY, prep.indices, true,
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
        input_cost: freshSession?.inputCost ?? 0,
        output_cost: freshSession?.outputCost ?? 0,
        cache_read_cost: freshSession?.cacheReadCost ?? 0,
        cache_write_cost: freshSession?.cacheWriteCost ?? 0,
      });
    }

    this._cancellationTokens.delete(streamId);
    return {};
  }

  private _getProvider(providerName: string, session: Session) {
    const modelName = session.settings.model || '';
    const sharedConfig = this._providerLoader(providerName);
    if (!sharedConfig) return null;

    try {
      const provider = ProviderFactory.create(
        providerName,
        toCoreProviderConfig(sharedConfig, modelName || sharedConfig.defaultModel || ''),
        session.settings.temperature,
      );
      return this._wrapWithGateway(provider, session);
    } catch (e) {
      warning('ORCHESTRATOR', `Failed to create provider ${providerName}: ${e}`);
      return null;
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

      let provider = this._router.getProvider(decision);
      if (provider) {
        provider = this._wrapWithGateway(provider, session);
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
      provider = this._getProvider(fallbackName, session);
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
    const provider = this._getProvider(providerName, session);
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
        agentRole: msg.agentRole,
      });
    }

    return result;
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
  ): Promise<string> {
    const finalContent = content;

    if (!isCancelled && content) {
      debugCollector.captureRawModelResponse(content);
    }

    if (debugCollector.enabled) {
      debugCollector.captureReasoning(reasoning);
    }

    const debugInfo = debugCollector.getDebugInfo();

    const metadata: Record<string, unknown> = { stream_id: streamId };
    if (toolResults && toolResults.length > 0) {
      metadata.tool_results = toolResults;
    }
    if (intermediateTextBlocks && intermediateTextBlocks.length > 0) {
      metadata.intermediate_text_blocks = intermediateTextBlocks;
    }

    // AD-036: раскрытие секретов в UI. Реальные значения плейсхолдеров из
    // карты обфускации сессии встраиваются в metadata.secrets (клик раскрывает
    // локально). Только существующие плейсхолдеры; карта — секрет, в логи не пишется.
    if (role === MessageRole.ASSISTANT && finalContent && this._obfMapStore) {
      try {
        const obfMap = await this._obfMapStore.get(sessionId);
        if (Object.keys(obfMap).length > 0) {
          const found = new Set<string>();
          let match: RegExpExecArray | null;
          const placeholderRe = new RegExp(PLACEHOLDER_PATTERN.source, 'g');
          while ((match = placeholderRe.exec(finalContent)) !== null) {
            found.add(match[0]);
          }
          const secrets: Record<string, string> = {};
          for (const ph of found) {
            if (ph in obfMap) secrets[ph] = obfMap[ph]!;
          }
          if (Object.keys(secrets).length > 0) {
            metadata.secrets = { ...(metadata.secrets as Record<string, string> | undefined), ...secrets };
          }
        }
      } catch (e) {
        warning('ORCHESTRATOR', `Ошибка раскрытия секретов в metadata: ${e instanceof Error ? e.message : String(e)}`);
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

        const effectiveModel = model || msg.model;
        if (effectiveModel && this._modelPriceLoader) {
          const pricing = this._modelPriceLoader(effectiveModel);
          if (pricing) {
            const div = 1_000_000;
            s.inputCost += ((usage.inputTokens || 0) * (pricing.inputPrice ?? 0)) / div;
            s.outputCost += ((usage.outputTokens || 0) * (pricing.outputPrice ?? 0)) / div;
            if (usage.cacheReadTokens && pricing.cacheReadPrice) {
              s.cacheReadCost += (usage.cacheReadTokens * pricing.cacheReadPrice) / div;
            }
            if (usage.cacheWriteTokens && pricing.cacheWritePrice) {
              s.cacheWriteCost += (usage.cacheWriteTokens * pricing.cacheWritePrice) / div;
            }
          }
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
        });
      }
    }

    return finalContent;
  }

  private _classifyError(errMsg: string): string {
    const lower = errMsg.toLowerCase();
    if (lower.includes('rate') || lower.includes('limit') || lower.includes('429')) return 'rate_limit';
    if (lower.includes('timeout') || lower.includes('timed out')) return 'timeout';
    if (lower.includes('502') || lower.includes('503') || lower.includes('bad gateway')) return 'server_error';
    if (lower.includes('context length') || lower.includes('too long')) return 'context_length';
    if (lower.includes('401') || lower.includes('403') || lower.includes('auth')) return 'auth_error';
    if (lower.includes('model') && (lower.includes('not found') || lower.includes('invalid'))) return 'model_not_found';
    return 'unknown';
  }

  private _isRecoverable(errMsg: string): boolean {
    const lower = errMsg.toLowerCase();
    const unrecoverable = [
      'model not found', 'model_not_found', 'does not exist',
      'invalid model', 'unknown model', 'invalid api key',
      'incorrect api key', '401', 'authentication', 'unauthorized',
    ];
    return !unrecoverable.some((p) => lower.includes(p));
  }

  /**
   * AD-029: «Разрешить в сессии» (once:false). Добавляет allow-правило для тула
   * в permission-конфиг сессии и сохраняет его. Если у сессии не было своего
   * конфига — наследует глобальные правила, чтобы не потерять их при оверрайде.
   */
  private async _grantSessionToolAllow(
    session: Session,
    toolName: string,
  ): Promise<PermissionConfig> {
    let cfg: PermissionConfig | undefined = session.settings.permission;
    if (!cfg) {
      cfg = {
        rules: { ...this._permissionConfig.rules },
        askTimeoutMs: this._permissionConfig.askTimeoutMs,
      };
    }
    const next: PermissionConfig = {
      ...cfg,
      rules: { ...cfg.rules, [toolName]: 'allow' },
    };
    await this._sessionManager.withLock(session.id, async (s) => {
      s.settings.permission = next;
      await this._sessionManager.saveSession(s);
    });
    return next;
  }
}

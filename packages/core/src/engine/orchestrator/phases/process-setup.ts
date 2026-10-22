/**
 * ADR-095 (шаг 6b-1): подготовка запроса `_processMessage` — выбор провайдера
 * через роутер, MCP-скоуп сессии, синхронизация durable state-сообщений,
 * сборка системного промпта Composer'ом (ADR-070), выборка инструментов и
 * регистрация cancel-токена хода.
 *
 * Вынесено из `engine/orchestrator.ts` без изменения поведения: порядок
 * side-effect'ов, условия, тексты и события сохранены дословно. Внутренние
 * `this._X` заменены явными зависимостями (`ProcessSetupDeps`); наружу
 * возвращается состояние (`ProcessSetupState`) либо ранний результат хода
 * (провайдер не найден — тот же путь `_handleLlmFailure`).
 */
import type {
  AgentDefinition,
  Message,
  PermissionConfig,
  PlanMode,
  Project,
  PromptMeta,
  ReasoningLevel,
  Session,
  SessionMode,
  ToolForLLM,
  ToolsPolicy,
} from '@itphx/synth-shared';
import { MessageRole } from '@itphx/synth-shared';
import type { BaseProvider, CachePolicy, CancellationToken, LLMMessage, SystemPromptPayload } from '../../../providers/base.js';
import type { DebugCollector } from '../../../debug.js';
import type { SessionManager } from '../../../sessions/manager.js';
import type { EventBus } from '../../../events/bus.js';
import type { McpManager } from '../../mcp/manager.js';
import type { McpScopeDecision } from '../../mcp/scope.js';
import type { ToolRegistry } from '../../tools/registry.js';
import type { ContextOptimizer } from '../../context/optimizer.js';
import type { ContextFileRepository } from '../../../storage/ports/context-file-repository.js';
import type { ComposerContext, ComposerInstructions, ComposerMcpServer, SystemPromptComposer } from '../../context/composer.js';
import type { InstructionsFileInfo } from '../../context/instructions.js';
import type { UnavailableTool } from '../../context/state-messages.js';
import type { ComposerSkillsCatalog } from '../../skills/catalog.js';
import type { LazyInstructionsLoader } from '../../context/lazy-instructions.js';
import type { RoutingDecision } from '../../router/router.js';
import type { LlmFailureContext } from '../errors.js';
import { syncStateMessages } from '../../context/state-messages.js';
import { agentKeyOf, buildPromptState, computeExpected, isBlockChanged, isPrefixUnchanged, type PromptStateReason } from '../../context/prompt-state.js';
import { sessionMessagesToLlm, resolveTurnQuery } from '../prompt-info.js';
import { DEFAULT_CHARS_PER_TOKEN } from '../../context/token-ratio.js';
import { t as sm } from '../../system-messages.js';
import { warning } from '../../../logger.js';

/** Результат фаз `_processMessage` (структурно = `ProcessMessageResult`). */
export interface ProcessSetupResult {
  error?: string;
  errorType?: string;
  canRetry?: boolean;
}

/** ADR-069 §2.1/§7: результат резолва проектных инструкций для текущего хода. */
export interface SetupResolvedProjectInstructions {
  instructions: ComposerInstructions;
  content: string;
  files: InstructionsFileInfo[];
}

/** Аргументы подготовки запроса. */
export interface ProcessSetupArgs {
  session: Session;
  message: Message;
  signal: AbortSignal;
  streamStartedAt: number;
  debugCollector: DebugCollector;
  streamId: string;
  projectForState: Project | null;
  workingDir: string;
  workspaceReady: boolean;
  agentDef: AgentDefinition | undefined;
  effectiveAgentRole: string | undefined;
  effectiveReasoningLevel: ReasoningLevel | undefined;
  sessionMode: SessionMode;
  planMode: PlanMode;
  planApproved: boolean;
  author: string;
  attempt: number | undefined;
}

/** Состояние хода, собранное подготовкой и необходимое далее (цикл/эпилог). */
export interface ProcessSetupState {
  provider: BaseProvider;
  providerName: string;
  /** `routeResult.modelName` — для оценки заполненности контекстного окна. */
  modelName: string;
  routingDecision: RoutingDecision | undefined;
  language: string;
  activeMcpServers: string[];
  activeMcpSet: Set<string>;
  toolsPolicy: Exclude<ToolsPolicy, 'auto'>;
  mcpPolicy: Exclude<ToolsPolicy, 'auto'>;
  baseLlmMessages: LLMMessage[];
  finalSystemPrompt: SystemPromptPayload;
  tools: ToolForLLM[] | undefined;
  promptMeta: PromptMeta;
  skillsCatalog: ComposerSkillsCatalog | undefined;
  projectInstructions: SetupResolvedProjectInstructions | undefined;
  loadedTokenRatio: number | undefined;
  messagesForLlm: Message[];
  cancelToken: CancellationToken;
  toolAbortController: AbortController;
}

/** Исход подготовки: ранний результат хода либо собранное состояние. */
export type ProcessSetupOutcome =
  | { failed: true; result: ProcessSetupResult }
  | { failed: false; state: ProcessSetupState };

/** Зависимости подготовки запроса `_processMessage`. */
export interface ProcessSetupDeps {
  routeProvider: (
    session: Session,
    message: Message,
    reasoningLevel: ReasoningLevel | undefined,
    debugCollector: DebugCollector,
  ) => Promise<{ provider: BaseProvider; providerName: string; modelName: string; decision?: RoutingDecision } | null>;
  handleLlmFailure: (
    sessionId: string,
    streamId: string,
    error: unknown,
    attempt: number | undefined,
    ctx: LlmFailureContext,
  ) => Promise<ProcessSetupResult>;
  contextConfig: ContextFileRepository | null;
  permissionConfig: PermissionConfig;
  cachePolicy: CachePolicy;
  resolveMcpDecisions: (session: Session, project: Project | null) => McpScopeDecision[];
  buildToolSelection: (args: {
    session: Session;
    agentDef: AgentDefinition | undefined;
    effectiveAgentRole: string | undefined;
    activeMcpServers: Iterable<string>;
    providerType?: string;
    sessionMode: SessionMode;
    planMode: PlanMode;
    planApproved: boolean;
    workspaceReady: boolean;
  }) => {
    toolsPolicy: Exclude<ToolsPolicy, 'auto'>;
    mcpPolicy: Exclude<ToolsPolicy, 'auto'>;
    select: () => ReturnType<ToolRegistry['selectForSession']>;
  };
  collectUnavailableTools: (
    session: Session,
    sessionMode: SessionMode,
    planMode: PlanMode,
    planApproved: boolean,
    agentDef: AgentDefinition | undefined,
    mcpServers?: Iterable<string>,
    include?: { builtin: boolean; mcp: boolean },
    workspaceReady?: boolean,
  ) => UnavailableTool[];
  collectSkillsCatalog: (args: {
    session: Session;
    agentDef: AgentDefinition | undefined;
    effectiveAgentRole: string | undefined;
    workingDir: string;
    permissionConfig: PermissionConfig;
    project?: Project | null;
  }) => Promise<ComposerSkillsCatalog | undefined>;
  resolveProjectInstructions: (args: {
    session: Session;
    project: Project | null;
    workingDir: string;
    model?: string;
    language: string;
    signal?: AbortSignal;
    turnId?: string;
  }) => Promise<SetupResolvedProjectInstructions | undefined>;
  resolveSchedulerActive: (session: Session) => Promise<boolean>;
  buildComposerContext: (args: {
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
    debugCollector?: DebugCollector;
    skillsCatalog?: ComposerSkillsCatalog;
    instructions?: ComposerInstructions;
    schedulerActive?: boolean;
    interviewEligible?: boolean;
    schedulerCurrentTurn?: boolean;
    /** PROP-090 §«Точка promptBlocks»: текст последнего сообщения пользователя. */
    query?: string;
    /** PROP-090 §«Точка promptBlocks»: идентификатор хода (`streamId`). */
    turnId?: string;
  }) => ComposerContext;
  collectComposerMcpServers: (decisions: McpScopeDecision[]) => ComposerMcpServer[] | undefined;
  interviewEligible: (
    session: Session,
    message: Message | undefined,
    toolAccess: {
      agentDef: AgentDefinition | undefined;
      sessionMode: SessionMode;
      planMode: PlanMode;
      planApproved: boolean;
      workspaceReady: boolean;
    },
  ) => boolean;
  schedulerCurrentTurn: (session: Session, message?: Message) => boolean;
  composer: SystemPromptComposer;
  optimizer: ContextOptimizer | null;
  mcpManager: McpManager | null;
  toolRegistry: ToolRegistry | null;
  lazyInstructions: LazyInstructionsLoader | null;
  eventBus: EventBus;
  sessionManager: SessionManager;
  loadTokenRatio: (model: string | undefined) => Promise<number | undefined>;
  registerCancelToken: (streamId: string, token: CancellationToken) => void;
}

/**
 * Подготовка запроса: провайдер → MCP-скоуп → state-сообщения → промпт →
 * инструменты → cancel-токен. Возвращает `{ failed: true, result }` (ранний
 * исход, вызывающий обязан вернуть его) либо `{ failed: false, state }`.
 */
export async function runProcessSetup(
  args: ProcessSetupArgs,
  deps: ProcessSetupDeps,
): Promise<ProcessSetupOutcome> {
  const {
    session, message, signal, streamStartedAt, debugCollector, streamId,
    projectForState, workingDir, workspaceReady, agentDef, effectiveAgentRole,
    effectiveReasoningLevel, sessionMode, planMode, planApproved, author, attempt,
  } = args;

  // 1. Get provider (через роутер если доступен, иначе напрямую)
  const routeResult = await deps.routeProvider(session, message, effectiveReasoningLevel, debugCollector);
  if (!routeResult) {
    const providerName = (message.provider as string) || session.settings.provider || '';
    // Терминальная ошибка конфигурации провайдера: раньше возвращалась без
    // персистентности — после перезагрузки сессия выглядела как «агент
    // думает». Теперь проходит общий путь `_handleLlmFailure` (assistant-
    // сообщение с metadata.status='error'/i18n + last_error в user-сообщении).
    return {
      failed: true,
      result: await deps.handleLlmFailure(
        session.id,
        streamId,
        new Error(sm('router.provider_not_found', { provider: providerName || sm('router.provider_unspecified') })),
        attempt,
        {
          debugCollector,
          durationMs: Date.now() - streamStartedAt,
          model: session.settings.model,
          providerName,
          agentRole: effectiveAgentRole,
          errorType: 'provider_not_found',
        },
      ),
    };
  }
  const { provider, providerName, decision: routingDecision } = routeResult;

  debugCollector.captureSessionInfo(session.id, provider.model, provider.name, {
    provider_type: provider.type,
    debug_enabled: session.settings.debugEnabled,
    stream_enabled: session.settings.streamEnabled,
    context_optimization: session.settings.contextOptimization,
  });

  // ADR-070 §2.8: синхронизируем режим/план/todo durable state-сообщениями
  // истории (до сборки LLM-сообщений). Идемпотентно — при неизменном
  // состоянии ничего не добавляется; system prompt при этом не меняется.
  const language = session.settings.language || 'ru';
  // ADR-071 §2.4: проект сессии уже загружен выше (projectForState) —
  // повторно хранилище не читаем.
  // ADR-071 §2.1/§2.4: эффективный набор MCP сессии — per-session скоуп:
  // (instance defaultOn ∪ project defaultOn ∪ session enabled) − opt-out.
  // Определяем до state-сообщений (unavailable-подсказки) и до сборки tools.
  // ADR-077 (шаг B2): состав серверов исполнителя обновляется ДО расчёта
  // скоупа. Иначе сервер, найденный в этом ходе, не попадает в список
  // подключаемых (`ensureToolsLoaded` ниже) — и первый ход агента после
  // раскатки исполнителя уходит без браузерных инструментов (тулы появляются
  // только в следующем ходе, по TTL источника).
  await refreshExecutorServers(deps);
  const mcpDecisions = deps.resolveMcpDecisions(session, projectForState);
  const activeMcpServers = mcpDecisions.filter((d) => d.enabled).map((d) => d.name);
  const activeMcpSet = new Set(activeMcpServers);
  // ADR-071 §2.3: эффективные политики инструментов для этого хода (per-session
  // override → глобальная; `auto` → по типу провайдера). Встроенные и MCP —
  // независимо; в `available` слой фильтруется по доступности, а подсказки
  // `unavailable` для него не нужны. `select()` вызывается позже — после
  // ленивой регистрации MCP-тулов сессии.
  // ADR-075: гейт `workspace` — если агент в ходе задаст workspace проекта,
  // выборку пересобираем тем же набором аргументов (см. ниже).
  const selectionArgs = {
    session, agentDef, effectiveAgentRole, activeMcpServers, providerType: provider.type,
    sessionMode, planMode, planApproved, workspaceReady,
  };
  const { toolsPolicy, mcpPolicy, select } = deps.buildToolSelection(selectionArgs);
  const stateSync = syncStateMessages(session, {
    contextConfig: deps.contextConfig,
    language,
    plan: projectForState?.plan ?? null,
    agentRole: effectiveAgentRole,
    // ADR-071 §2.3: слой с политикой `available` уже сужен до доступных —
    // подсказки `unavailable(mode|role)` для него не добавляем (слои
    // независимы: built-in-подсказки сохраняются при mcp=available и наоборот).
    unavailableTools: deps.collectUnavailableTools(
      session, sessionMode, planMode, planApproved, agentDef, activeMcpServers,
      { builtin: toolsPolicy !== 'available', mcp: mcpPolicy !== 'available' },
      workspaceReady,
    ),
  });
  if (stateSync.changed) {
    for (const stateMsg of stateSync.added) {
      await deps.sessionManager.addMessage(session.id, stateMsg);
    }
    // Локальная сессия должна увидеть новые state-сообщения при сборке
    // messagesForLlm в этом же ходе.
    session.messages.push(...stateSync.added);
  }

  // 2. Build context (сначала получить summary из сообщений)
  const optimizedMessages = deps.optimizer
    ? deps.optimizer.getMessagesForLlm(session)
    : session.messages;

  const summaryContent = optimizedMessages
    .filter((m) => m.role === MessageRole.SUMMARY)
    .map((m) => m.content)
    .join('\n\n');

  // ADR-071 §2.1: MCP-тулы активных серверов сессии. Регистрация ленивая и
  // аддитивная (без deregister при смене набора): глобальный реестр держит
  // MCP-тулы для executor'а, а per-session скоуп обеспечивает выборка ниже
  // (`selectForSession`) — кросс-сессионной утечки нет. Загружаем до сборки
  // промпта, чтобы блок `mcp.servers` видел тулы подключённых серверов.
  if (deps.mcpManager && deps.toolRegistry && activeMcpServers.length > 0) {
    await deps.mcpManager.ensureToolsLoaded(activeMcpServers, deps.toolRegistry);
  }

  // ADR-071 §2.6: chars-per-token модели хода (калибровка) для оценок токенов.
  // `loadedTokenRatio` (без дефолта) переиспользуется при калибровке после
  // ответа — повторного чтения runtime-настроек нет.
  const loadedTokenRatio = await deps.loadTokenRatio(provider.model || session.settings.model);
  const tokenRatio = loadedTokenRatio ?? DEFAULT_CHARS_PER_TOKEN;

  // ADR-070 §2.1/§2.8: единая идемпотентная сборка системного промпта
  // Composer'ом. `session.settings.systemPrompt` override, classification/
  // gateway/plan-guide/mode-policy/session-context — внутри compose.
  // Режим/план/todo — уже в state-сообщениях истории (выше), не в system.
  // ADR-046 §5: каталог скиллов — stable/volatile-блоки (deny скрывает).
  const skillsCatalog = await deps.collectSkillsCatalog({
    session,
    agentDef,
    effectiveAgentRole,
    workingDir,
    permissionConfig: session.settings.permission ?? deps.permissionConfig,
    project: projectForState,
  });
  // ADR-069 Фаза 1: проектные инструкции (merged chain AGENTS.md) —
  // только при project.workspace и без systemPrompt-override.
  const projectInstructions = await deps.resolveProjectInstructions({
    session,
    project: projectForState,
    workingDir,
    model: provider.model,
    language,
    signal,
    // ADR-069 §3.5/R5: мемоизация в пределах хода (streamId).
    turnId: streamId,
  });
  // ADR-069 §9.3: прозрачность — событие о загруженных проектных инструкциях.
  // Публикуется только в реальном ходе (manifest/getPromptInfo — read-only).
  if (projectInstructions && projectInstructions.files.length > 0) {
    deps.eventBus.publish(session.id, 'context.instructions_loaded', {
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
    // ADR-069 §4.3.5: merged-chain уже в system prompt — seed lazy-реестра,
    // чтобы lazy не дублировал эти файлы в tool result.
    deps.lazyInstructions?.seed(
      session.id,
      projectInstructions.files.filter((file) => file.kind === 'chain').map((file) => file.path),
    );
  }
  const schedulerActive = await deps.resolveSchedulerActive(session);
  const composerCtx: ComposerContext = deps.buildComposerContext({
    session, agentDef, effectiveAgentRole, workingDir, language, summaryContent,
    // ADR-071 §2.3: `toolsPolicy` влияет на тир `tools`, `mcpPolicy` — на
    // инструкцию `tools.guide`; MCP-блоки всегда volatile.
    toolsPolicy, mcpPolicy, tokenRatio,
    // ADR-071 §2.2: блоки `mcp.servers`/`mcp.status` — все серверы эффективного набора.
    mcpServers: deps.collectComposerMcpServers(mcpDecisions),
    // ADR-071 §2.4: уже загруженный проект — Composer не читает хранилище.
    project: projectForState,
    // ADR-070 §2.5: per-message collector доходит до Composer через контекст.
    debugCollector,
    skillsCatalog,
    instructions: projectInstructions?.instructions,
    schedulerActive,
    // Интервью уместно только в первом ходе сессии от пользователя и если
    // текущий агент может сохранить ответы (`profile_update` доступен).
    interviewEligible: deps.interviewEligible(session, message, {
      agentDef, sessionMode, planMode, planApproved, workspaceReady,
    }),
    // Текущий ход инициирован планировщиком — volatile-пояснение модели.
    schedulerCurrentTurn: deps.schedulerCurrentTurn(session, message),
    // PROP-090 §«Точка promptBlocks»: контекст текущего хода для провайдеров
    // блоков промпта — «вопрос хода» (текст последнего сообщения пользователя)
    // и метка хода. Системные/state-сообщения в вопрос не попадают.
    query: resolveTurnQuery(session, message),
    turnId: streamId,
  });
  const composed = await deps.composer.compose(composerCtx);
  // ADR-070 §2.2: в провайдер уходит payload с границей stable-префикса и
  // ключом кэша (стабильный id сессии). При override
  // `session.settings.systemPrompt` stablePrefix не задаём (безопаснее).
  const hasSystemPromptOverride = !!session.settings.systemPrompt?.trim();
  const finalSystemPrompt: SystemPromptPayload = {
    text: composed.system,
    stablePrefix: hasSystemPromptOverride ? undefined : (composed.stablePrefix || undefined),
    cacheKey: session.id,
    cachePolicy: deps.cachePolicy,
  };

  // ADR-070 §2.4/§2.7 (Ф2-часть 2): состояние промпта per-agent. При
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
  // ADR-069 §11/ADR-070 §2.4: блок `instructions` лежит в тире `context`, а
  // `isPrefixUnchanged` сравнивает только stable-префикс. Поэтому смену
  // контента инструкций отслеживаем отдельно — иначе promptStates/generation
  // не инвалидируются при изменении `AGENTS.md`.
  const instructionsChanged = isBlockChanged(prevPromptState, composed.blocks, 'instructions');
  // PROP-090 §«Точка promptBlocks»: блоки провайдеров лежат вне тира `stable`,
  // поэтому `isPrefixUnchanged` их не видит — трек ведётся отдельно, по
  // образцу `instructions`. Учитываем и текущие блоки провайдеров, и те, что
  // были в прошлом состоянии (плагин мог быть деактивирован — блок исчез, а
  // состояние промпта должно это увидеть).
  const providerKeys = new Set<string>();
  for (const block of composed.blocks) {
    if (block.source === 'provider') providerKeys.add(block.key);
  }
  for (const block of prevPromptState?.blocks ?? []) {
    if (block.provider) providerKeys.add(block.key);
  }
  const providerBlocksChanged = [...providerKeys].some((key) =>
    isBlockChanged(prevPromptState, composed.blocks, key),
  );
  if (
    !prevPromptState
    || !isPrefixUnchanged(prevPromptState, promptStateInput)
    || instructionsChanged
    || providerBlocksChanged
  ) {
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
    await deps.sessionManager.saveSession(session);
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
  const baseLlmMessages = sessionMessagesToLlm(messagesForLlm, effectiveAgentRole, author);

  // 4. Get tools from registry. ADR-070 §2.9 + ADR-071 §2.1/§2.3: встроенные —
  // постоянно, MCP — только активных серверов сессии; каждый слой в своём
  // `available` — только доступные (mode/role/mcpToolSettings). Порядок:
  // builtin → MCP. Если агент НЕ найден в реестре или role undefined —
  // модель получает НИКАКИХ инструментов (safety-fallback).
  // `select()` — после ensureToolsLoaded (реестр уже содержит MCP-тулы).
  const toolSelection = select();
  // PROP-090 §«Точка `tools`»: порядок слоёв — встроенные → плагинные → MCP.
  // `stableToolCount` считает только встроенные: плагинные и MCP-тулы меняются
  // в runtime (активация/деактивация, серверы сессии) и вне stable-префикса.
  const tools = deps.toolRegistry
    ? [
      ...toolSelection.builtin,
      // Мок/внешняя реализация реестра может не отдавать слой `plugin`.
      ...(toolSelection.plugin ?? []),
      ...toolSelection.mcp,
    ]
    : undefined;
  // ADR-071 §2.1: граница stable-слоя инструментов для кэш-брейкпоинта
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
  deps.registerCancelToken(streamId, cancelToken);

  signal.addEventListener('abort', () => {
    cancelToken.cancel();
  }, { once: true });
  // signal мог быть уже абортирован до входа (гонка с отменой из очереди)
  if (signal.aborted) cancelToken.cancel();

  return {
    failed: false,
    state: {
      provider, providerName, modelName: routeResult.modelName, routingDecision, language,
      activeMcpServers, activeMcpSet, toolsPolicy, mcpPolicy,
      baseLlmMessages, finalSystemPrompt, tools, promptMeta,
      skillsCatalog, projectInstructions, loadedTokenRatio, messagesForLlm,
      cancelToken, toolAbortController,
    },
  };
}

/**
 * Обновить состав MCP-серверов исполнителя (ADR-077, шаг B2) — до расчёта
 * скоупа сессии.
 *
 * Источник ленивый (TTL 120 с, короткая пауза 15 с после неудачи), поэтому
 * обновление внутри хода — обычное дело; в `inline` источника нет, и вызов
 * ничего не делает (поведение прежнее).
 *
 * Ошибка не ломает ход: недоступный исполнитель не должен ронять сессию
 * (сам режим проверяется fail-closed при старте порта исполнения).
 */
async function refreshExecutorServers(deps: ProcessSetupDeps): Promise<void> {
  const manager = deps.mcpManager;
  if (!manager) return;
  try {
    await manager.refreshExecutorServers(deps.toolRegistry ?? undefined);
  } catch (err) {
    warning(
      'MCP',
      `Не удалось обновить состав серверов исполнителя: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

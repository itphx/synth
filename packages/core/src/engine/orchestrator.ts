import type { Message, Session, ProviderConfig as SharedProviderConfig, TokenUsage } from '@synth/shared';
import { MessageRole, nowISO, ToolCapability, generateId, makeTextPart } from '@synth/shared';
import type { RouterConfig } from '@synth/shared';
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

const MAX_DOOM_LOOP_COUNT = 3;
const DEFAULT_MAX_ITERATIONS = Number.POSITIVE_INFINITY;

export interface ModelPricing {
  inputPrice?: number;
  outputPrice?: number;
  cacheReadPrice?: number;
  cacheWritePrice?: number;
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

    // DictionaryStore и ProviderPool создаём всегда (нужны микро-слою и роутеру)
    const dictionaryStore = new DictionaryStore(options.dataDir || '/var/synth/data');
    const pool = new ProviderPool(options.providerLoader);

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
          ? '\n\n## Классификация разговора\n\nКогда определишь характер задачи, вызови инструмент `classify_conversation` с категорией: coding (написание/изменение кода), research (анализ/исследование), или chat (общий разговор). Это поможет выбрать оптимальную модель для последующих запросов.'
          : '\n\n## Conversation Classification\n\nWhen you determine the nature of the task, call the `classify_conversation` tool with the category: coding (writing/modifying code), research (analysis/investigation), or chat (general conversation). This helps select the optimal model for subsequent requests.';
        finalSystemPrompt = systemPrompt + classifyInstruction;
      }

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
                  workingDir: '/home/eof/dev/Synth',
                  dataDir: this._modelPriceLoader ? undefined : undefined,
                  extra: {
                    provider,
                    agentRegistry: this._agentRegistry,
                    sessionManager: this._sessionManager,
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
                    publish: (type: string, data: Record<string, unknown>) =>
                      publishChunk(type as never, data),
                    streamId,
                    sessionId: session.id,
                    toolRegistry: this._toolRegistry,
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

        publishChunk('tool_call.loop', {
          stream_id: streamId,
          session_id: session.id,
          iteration: toolIteration,
          total_tool_calls: toolCalls.length,
        });

        toolIteration++;
      }

      // 7. Handle max iterations exceeded
      if (toolIteration >= maxIterations && !finalContent) {
        finalContent = '(достигнут лимит итераций инструментов)';
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
      return ProviderFactory.create(
        providerName,
        toCoreProviderConfig(sharedConfig, modelName || sharedConfig.defaultModel || ''),
        session.settings.temperature,
      );
    } catch (e) {
      warning('ORCHESTRATOR', `Failed to create provider ${providerName}: ${e}`);
      return null;
    }
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
}

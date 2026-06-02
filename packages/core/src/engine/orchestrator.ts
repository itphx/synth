import type { Message, Session, ProviderConfig as SharedProviderConfig, TokenUsage } from '@synth/shared';
import { MessageRole, nowISO } from '@synth/shared';
import type { SessionManager } from '../sessions/manager.js';
import type { EventBus } from '../events/bus.js';
import { DebugCollector } from '../debug.js';
import { ProviderFactory } from '../providers/base.js';
import type { LLMMessage, CancellationToken, ProviderConfig as CoreProviderConfig } from '../providers/base.js';
import { ContextBuilder } from './context/builder.js';
import { ContextOptimizer } from './context/optimizer.js';
import { warning } from '../logger.js';

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
  modelPriceLoader?: (modelName: string) => ModelPricing | null;
  dataDir?: string;
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
  private readonly _cancellationTokens = new Map<string, CancellationToken>();

  constructor(options: OrchestratorOptions) {
    this._sessionManager = options.sessionManager;
    this._eventBus = options.eventBus;
    this._contextBuilder = options.contextBuilder;
    this._providerLoader = options.providerLoader;
    this._optimizer = options.contextOptimizer ?? null;
    this._modelPriceLoader = options.modelPriceLoader ?? null;
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
    const effectiveAgentRole = message.agentRole || session.settings.agentRole;
    const author = message.author || 'unknown';

    const debugCollector = new DebugCollector(session.settings.debugEnabled);

    // --- Обработка системных сообщений (суммаризация, шедулер, etc.) ---
    if (message.role === MessageRole.SYSTEM && message.metadata?.type === 'summarization_request') {
      return this._handleSummarization(session, message, signal, publishChunk, debugCollector, streamId);
    }
    if (message.role === MessageRole.SYSTEM && message.metadata?.type === 'debug_system_message') {
      return this._handleDebugSystemMessage(session, message, signal, publishChunk, debugCollector, streamId);
    }

    try {
      // 1. Get provider
      const providerName = message.provider || session.settings.provider || '';
      const provider = this._getProvider(providerName, session);
      if (!provider) {
        return {
          error: `Провайдер ${providerName || 'не указан'} не найден или не настроен`,
          errorType: 'provider_not_found',
          canRetry: false,
        };
      }

      debugCollector.captureSessionInfo(session.id, provider.model, provider.name, {
        provider_type: provider.type,
        debug_enabled: session.settings.debugEnabled,
        stream_enabled: session.settings.streamEnabled,
        tsm_mode: session.settings.tsmMode,
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
          tsmMode: session.settings.tsmMode,
          language: session.settings.language,
          showInterview: session.settings.showInterview,
          stickyNotes: session.stickyNotes,
          summaryContent: summaryContent || undefined,
        });

      // 3. Convert messages for LLM (без summary — они уже в system prompt)
      const messagesForLlm = optimizedMessages.filter((m) => m.role !== MessageRole.SUMMARY);
      const llmMessages = ChatOrchestrator._sessionMessagesToLlm(messagesForLlm, effectiveAgentRole, author);

      // 4. Create cancellation token
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

      // 5. Stream from provider
      let accumulatedContent = '';
      let accumulatedReasoning = '';
      let finalUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
      let finalModel: string | undefined;

      try {
        for await (const chunk of provider.chatAsync(llmMessages, systemPrompt, undefined, debugCollector, cancelToken)) {
          if (cancelToken.cancelled) break;

          if (chunk.isFinal) {
            accumulatedContent = chunk.content;
          } else {
            accumulatedContent += chunk.content;
          }
          if (chunk.reasoning) accumulatedReasoning = chunk.reasoning;
          if (chunk.usage) finalUsage = chunk.usage;
          if (chunk.model) finalModel = chunk.model;

          publishChunk('stream.chunk', {
            stream_id: streamId,
            content: chunk.content,
            reasoning: chunk.reasoning,
            is_final: chunk.isFinal,
            agent_role: effectiveAgentRole,
            model: finalModel,
            provider: providerName,
          });
        }
      } catch (e) {
        const errMsg = String(e);
        warning('ORCHESTRATOR', `LLM stream error: ${errMsg}`);

        // Save partial response
        if (accumulatedContent || accumulatedReasoning) {
          await this._saveAssistantMessage(session.id, accumulatedContent, streamId, effectiveAgentRole, finalUsage, finalModel, accumulatedReasoning, debugCollector, true, providerName);
        }

        return {
          error: errMsg,
          errorType: this._classifyError(errMsg),
          canRetry: this._isRecoverable(errMsg),
        };
      }

      // 6. Handle cancellation
      if (cancelToken.cancelled) {
        if (accumulatedContent || accumulatedReasoning) {
          await this._saveAssistantMessage(session.id, accumulatedContent, streamId, effectiveAgentRole, finalUsage, finalModel, accumulatedReasoning, debugCollector, true, providerName);
        }

        publishChunk('stream.cancelled', {
          stream_id: streamId,
          content: accumulatedContent,
        });

        this._cancellationTokens.delete(streamId);
        return {};
      }

      // 7. Save assistant message
      const savedContent = await this._saveAssistantMessage(
        session.id, accumulatedContent, streamId, effectiveAgentRole,
        finalUsage, finalModel, accumulatedReasoning, debugCollector, false, providerName,
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
      };

      const debugInfo = debugCollector.getDebugInfo();
      if (debugInfo) {
        doneData.debug_info = debugInfo;
      }

      publishChunk('stream.done', doneData);

      // 8. Check context optimization triggers
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
          content: chunk.content,
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
          content: chunk.content,
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
        toolUse: msg.toolCalls,
        toolCallId: msg.toolCallId,
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
  ): Promise<string> {
    const finalContent = content;

    if (!isCancelled && content) {
      debugCollector.captureRawModelResponse(content);
    }

    if (debugCollector.enabled) {
      debugCollector.captureReasoning(reasoning);
    }

    const debugInfo = debugCollector.getDebugInfo();

    const msg: Message = {
      role,
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
      metadata: { stream_id: streamId },
      ...(summaryOf ? { summaryOf } : {}),
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

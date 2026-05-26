import type { Message, Session, ProviderConfig as SharedProviderConfig } from '@synth/shared';
import { MessageRole, nowISO } from '@synth/shared';
import type { SessionManager } from '../sessions/manager.js';
import type { EventBus } from '../events/bus.js';
import { DebugCollector } from '../debug.js';
import { ProviderFactory } from '../providers/base.js';
import type { LLMMessage, CancellationToken, ProviderConfig as CoreProviderConfig } from '../providers/base.js';
import { ContextBuilder } from './context/builder.js';
import type { ContextConfig } from './context/config.js';
import { info, warning } from '../logger.js';

export interface OrchestratorOptions {
  sessionManager: SessionManager;
  eventBus: EventBus;
  contextBuilder: ContextBuilder;
  providerLoader: (name: string) => SharedProviderConfig | null;
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
  private readonly _cancellationTokens = new Map<string, CancellationToken>();

  constructor(options: OrchestratorOptions) {
    this._sessionManager = options.sessionManager;
    this._eventBus = options.eventBus;
    this._contextBuilder = options.contextBuilder;
    this._providerLoader = options.providerLoader;
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

      // 2. Build context
      const systemPrompt = session.settings.systemPrompt
        || await this._contextBuilder.buildSystemPrompt({
          agentRole: effectiveAgentRole,
          historyMessages: session.messages,
          userId: session.userId,
          projectName: session.projectId,
          tsmMode: session.settings.tsmMode,
          language: session.settings.language,
          showInterview: session.settings.showInterview,
        });

      // 3. Convert messages for LLM
      const llmMessages = ChatOrchestrator._sessionMessagesToLlm(session.messages, effectiveAgentRole, author);

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
        if (accumulatedContent) {
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
        if (accumulatedContent) {
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
      if (role === MessageRole.INFO || role === MessageRole.SUMMARY) continue;

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
    usage: { inputTokens: number; outputTokens: number; totalTokens: number },
    model: string | undefined,
    reasoning: string | undefined,
    debugCollector: DebugCollector,
    isCancelled: boolean,
    provider?: string,
  ): Promise<string> {
    const finalContent = content;

    if (!isCancelled && content) {
      debugCollector.captureRawModelResponse(content);
    }

    if (debugCollector.enabled) {
      debugCollector.captureReasoning(reasoning);
    }

    const debugInfo = debugCollector.getDebugInfo();

    const assistantMsg: Message = {
      role: MessageRole.ASSISTANT,
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
    };

    await this._sessionManager.addMessage(sessionId, assistantMsg);

    // Publish message.added for UI
    const session = await this._sessionManager.getSession(sessionId);
    if (session) {
      this._eventBus.publish(sessionId, 'message.added', {
        message_index: session.messages.length - 1,
        role: 'assistant',
        content: finalContent.slice(0, 500),
        model,
        provider: provider || '',
        agent_role: agentRole,
      });
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

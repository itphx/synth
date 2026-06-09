import type { Message, Session } from '@synth/shared';
import { nowISO, generateStreamId, MessageRole } from '@synth/shared';
import type { SessionManager } from '../sessions/manager.js';
import type { EventBus } from '../events/bus.js';
import type { ContextOptimizer } from '../engine/context/optimizer.js';

const MAX_RETRIES = 3;
const MAX_PENDING = 5;

interface RetryDelays {
  [streamId: string]: number;
}

export type ProcessMessageFn = (
  session: Session,
  message: Message,
  signal: AbortSignal,
  publishChunk: (event: string, data: Record<string, unknown>) => void,
) => Promise<{ error?: string; errorType?: string; canRetry?: boolean }>;

/**
 * QueueProcessor — фоновый обработчик очереди сообщений для одной сессии.
 * Портирован из synth-legacy core/chat/queue_processor.py
 */
export class QueueProcessor {
  private _running = false;
  private _cancelled = false;
  private _retryDelays: RetryDelays = {};
  private _ringBuffer: Map<string, Record<string, unknown>[]> = new Map();

  constructor(
    private sessionId: string,
    private sessionManager: SessionManager,
    private eventBus: EventBus,
    private processMessage: ProcessMessageFn,
    private contextOptimizer?: ContextOptimizer,
  ) {}

  get isRunning(): boolean {
    return this._running;
  }

  async start(): Promise<void> {
    if (this._running) return;

    this._running = true;
    this._cancelled = false;

    try {
      await this._run();
    } finally {
      this._running = false;
    }
  }

  stop(): void {
    this._cancelled = true;
  }

  private async _run(): Promise<void> {
    while (!this._cancelled) {
      let session: Session | null;

      try {
        session = await this.sessionManager.getSession(this.sessionId);
      } catch {
        break;
      }

      if (!session || session.pendingMessages.length === 0) break;

      // Проверка: ожидается ли суммаризация перед следующим сообщением?
      if (this.contextOptimizer && session.summarizationPending) {
        try {
          session = await this.sessionManager.withLock(this.sessionId, async (s) => {
            // Вставить системное сообщение в начало очереди вместо блокирующего вызова
            const sysMsg: Message = {
              role: MessageRole.SYSTEM,
              content: '',
              createdAt: nowISO(),
              disabled: false,
              pinned: false,
              hidden: false,
              metadata: { type: 'summarization_request', reason: 'auto', stream_id: generateStreamId() },
            };
            s.pendingMessages.unshift(sysMsg);
            s.summarizationPending = false;
            await this.sessionManager.saveSession(s);
            return s;
          });

          // Продолжить цикл — системное сообщение обработается следующим
          continue;
        } catch (err) {
          this.eventBus.publish(this.sessionId, 'stream.error', {
            stream_id: '',
            error: String(err),
            error_type: 'context.summarization_failed',
            can_retry: false,
          });

          await this.sessionManager.withLock(this.sessionId, async (s) => {
            s.summarizationPending = false;
            await this.sessionManager.saveSession(s);
          });
        }
      }

      const message = session.pendingMessages[0]!;
      const streamId = message.metadata?.stream_id as string || generateStreamId();

      // Проверяем, не повторная ли это попытка
      const isRetry = streamId in this._retryDelays;

      if (!isRetry) {
        // Phase 1 — блокировка и сохранение сообщения (только при первом запуске)
        const isSystemMessage = message.role === MessageRole.SYSTEM;
        session = await this.sessionManager.withLock(this.sessionId, async (s) => {
          s.status.blocked = this.sessionId;
          s.status.blockedAt = nowISO();
          s.currentStream = {
            streamId,
            message: message.content,
            agentRole: message.agentRole,
            startedAt: nowISO(),
            cancelled: false,
          };
          // Системные сообщения НЕ пушить в историю (не user-сообщения)
          if (!isSystemMessage) {
            s.messages.push(message);
          }
          s.updatedAt = nowISO();
          await this.sessionManager.saveSession(s);
          return s;
        });

        if (!session) break;

        // Для пользовательских сообщений — уведомить UI о появлении сообщения
        if (!isSystemMessage) {
          const userMsgIndex = session.messages.length - 1;
          this.eventBus.publish(this.sessionId, 'message.added', {
            message_index: userMsgIndex,
            role: message.role,
            content: message.content.slice(0, 500),
            author: message.author,
            agent_role: message.agentRole,
          });
        }

        this.eventBus.publish(this.sessionId, 'stream.start', {
          stream_id: streamId,
          agent_role: isSystemMessage
            ? (message.metadata?.type === 'debug_system_message' ? 'debug' : 'summary')
            : message.agentRole,
          provider: message.provider,
          model: message.model,
          ...(isSystemMessage && message.metadata?.type
            ? { metadata: { type: message.metadata.type } }
            : {}),
        });
      } else {
        // Повторная попытка: обновляем startedAt у currentStream
        session = await this.sessionManager.withLock(this.sessionId, async (s) => {
          if (s.currentStream) {
            s.currentStream.startedAt = nowISO();
          }
          await this.sessionManager.saveSession(s);
          return s;
        });
        if (!session) break;
      }

      try {
        // Phase 2 — вызов LLM через processMessage
        const abortController = new AbortController();

        const result = await this.processMessage(
          session!,
          message,
          abortController.signal,
          (event, data) => {
            this.eventBus.publish(this.sessionId, event as never, data);
            if (event === 'stream.chunk') {
              this._appendToRingBuffer(streamId, data);
            }
          },
        );

        // Обработка результата
        if (result.error) {
          const retryCount = (this._retryDelays[streamId] || 0) + 1;
          this._retryDelays[streamId] = retryCount;

          const isRecoverable = this._isRecoverable(result.error);

          if (!isRecoverable || retryCount > MAX_RETRIES) {
            // Unrecoverable или исчерпаны попытки — удалить из очереди
            await this.sessionManager.withLock(this.sessionId, async (s) => {
              s.pendingMessages = s.pendingMessages.filter((_, i) => i !== 0);
              const msg = s.messages.find(
                (m) => m.metadata?.stream_id === streamId && m.role === 'user',
              );
              if (msg) {
                msg.metadata = { ...msg.metadata, last_error: result.error };
              }
              s.status.blocked = undefined;
              s.status.blockedAt = undefined;
              s.currentStream = undefined;
              await this.sessionManager.saveSession(s);
            });

            this.eventBus.publish(this.sessionId, 'stream.error', {
              stream_id: streamId,
              error: result.error,
              error_type: result.errorType || 'unknown',
              retry_count: retryCount,
              can_retry: false,
            });

            delete this._retryDelays[streamId];
            continue;
          } else {
            // Recoverable — повторить через backoff
            const delay = this._calcBackoff(retryCount);
            await new Promise((r) => setTimeout(r, delay));
            continue; // не удаляем из очереди, пробуем снова
          }
        }

        // Успех — удалить сообщение из очереди
        await this.sessionManager.withLock(this.sessionId, async (s) => {
          s.pendingMessages = s.pendingMessages.filter((_, i) => i !== 0);
          s.status.blocked = undefined;
          s.status.blockedAt = undefined;
          s.currentStream = undefined;
          s.updatedAt = nowISO();
          await this.sessionManager.saveSession(s);
        });

        delete this._retryDelays[streamId];
      } catch (err) {
        // Непредвиденная ошибка — чистим и выходим
        await this.sessionManager.forceReleaseLock(this.sessionId).catch((err) => {
          console.warn(`[QueueProcessor] Не удалось снять блокировку ${this.sessionId}: ${String(err)}`);
        });
        this.eventBus.publish(this.sessionId, 'stream.error', {
          stream_id: streamId,
          error: String(err),
          error_type: 'internal',
          can_retry: false,
        });
        delete this._retryDelays[streamId];
        break;
      }
    }

    // Проверка: остались ли pending сообщения
    try {
      const session = await this.sessionManager.getSession(this.sessionId);
      if (session && session.pendingMessages.length > 0) {
        this.eventBus.publish(this.sessionId, 'queue.stalled', {
          pending_count: session.pendingMessages.length,
        });

        const nextMsg = session.pendingMessages[0];
        if (nextMsg) {
          const content = nextMsg.content;
          const isQuestion = content?.includes('?') || content?.includes('？');
          if (isQuestion || nextMsg.role === 'assistant') {
            this.eventBus.publish(this.sessionId, 'question.asked', {
              message: content?.slice(0, 200),
              agent_role: nextMsg.agentRole,
              pending_count: session.pendingMessages.length,
            });
          }
        }
      }
    } catch {
      // ignore
    }
  }

  private _isRecoverable(errorStr: string): boolean {
    const lower = errorStr.toLowerCase();
    const unrecoverable = [
      'model not found', 'model_not_found', 'does not exist',
      'invalid model', 'unknown model', 'invalid api key',
      'incorrect api key', '401', 'authentication', 'unauthorized',
      'missing field', 'failed to deserialize', 'invalid type',
      'unknown field', 'bad request', 'validation',
      'err_invalid_arg_type', 'cannot read properties',
      'is not a function', 'is not defined',
    ];
    return !unrecoverable.some((p) => lower.includes(p));
  }

  private _calcBackoff(attempt: number): number {
    const delays = [5000, 15000, 30000, 60000];
    return delays[Math.min(attempt - 1, delays.length - 1)]!;
  }

  private _appendToRingBuffer(streamId: string, data: Record<string, unknown>): void {
    if (!this._ringBuffer.has(streamId)) {
      this._ringBuffer.set(streamId, []);
    }
    const buffer = this._ringBuffer.get(streamId)!;
    buffer.push(data);
    if (buffer.length > 100) buffer.shift();
  }

  getRingBuffer(streamId: string): Record<string, unknown>[] {
    return this._ringBuffer.get(streamId) || [];
  }
}

/**
 * QueueProcessorManager — singleton для управления процессорами.
 */
export class QueueProcessorManager {
  private _processors = new Map<string, QueueProcessor>();
  private _contextOptimizer?: ContextOptimizer;

  setContextOptimizer(optimizer: ContextOptimizer): void {
    this._contextOptimizer = optimizer;
  }

  createProcessor(
    sessionId: string,
    sessionManager: SessionManager,
    eventBus: EventBus,
    processMessage: ProcessMessageFn,
  ): QueueProcessor {
    const existing = this._processors.get(sessionId);
    if (existing && existing.isRunning) return existing;

    const processor = new QueueProcessor(sessionId, sessionManager, eventBus, processMessage, this._contextOptimizer);
    this._processors.set(sessionId, processor);

    processor.start().catch((err) => {
      console.error(`[QueueProcessorManager] Ошибка старта процессора ${sessionId}: ${String(err)}`);
    });

    return processor;
  }

  isRunning(sessionId: string): boolean {
    return this._processors.get(sessionId)?.isRunning ?? false;
  }

  stop(sessionId: string): void {
    this._processors.get(sessionId)?.stop();
    this._processors.delete(sessionId);
  }

  stopAll(): void {
    for (const sessionId of this._processors.keys()) {
      this.stop(sessionId);
    }
  }

  getRingBuffer(streamId: string): Record<string, unknown>[] | null {
    for (const proc of this._processors.values()) {
      const buffer = proc.getRingBuffer(streamId);
      if (buffer.length > 0) return buffer;
    }
    return null;
  }
}

/**
 * Постановка сообщения в очередь (AD-011).
 */
export async function enqueueUserMessage(
  sessionManager: SessionManager,
  eventBus: EventBus,
  sessionId: string,
  message: Message,
  processorManager: QueueProcessorManager,
  processMessage: ProcessMessageFn,
): Promise<Session | null> {
  if (!message.metadata) message.metadata = {};
  if (!message.metadata.stream_id) message.metadata.stream_id = generateStreamId();

  const session = await sessionManager.addPendingMessage(sessionId, message, MAX_PENDING);
  if (!session) return null;

  // Синхронизируем настройки провайдера/модели с последним сообщением
  const newProvider = message.provider;
  const newModel = message.model;
  if (newProvider && newModel) {
    if (session.settings.provider !== newProvider || session.settings.model !== newModel) {
      await sessionManager.withLock(sessionId, async (s) => {
        s.settings.provider = newProvider;
        s.settings.model = newModel;
        await sessionManager.saveSession(s);
      });
    }
  }

  eventBus.publish(sessionId, 'message.queued', {
    stream_id: message.metadata.stream_id,
    pending_count: session.pendingMessages.length,
    message: message.content,
    agent_role: message.agentRole,
    author: message.author,
  });

  processorManager.createProcessor(sessionId, sessionManager, eventBus, processMessage);

  return session;
}

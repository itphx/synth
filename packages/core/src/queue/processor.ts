import type { Message, Session } from '@itphx/synth-shared';
import { nowISO, generateStreamId, generateId, MessageRole, MAX_STEER_INJECTIONS_PER_TURN, STEER_METADATA_KEY, STEERING_ERROR_CODES } from '@itphx/synth-shared';
import type { SessionManager } from '../sessions/manager.js';
import { t as sm, i18n as i18nMeta } from '../engine/system-messages.js';
import type { EventBus } from '../events/bus.js';
import type { ContextOptimizer } from '../engine/context/optimizer.js';
import { isLlmErrorRecoverable, LLM_MAX_ATTEMPTS, LLM_RETRY_DELAYS_MS } from '../engine/llm-error.js';
import type { AnalyticsRecorder } from '../analytics/recorder.js';
import { sessionAxes } from '../analytics/recorder.js';

const MAX_PENDING = 5;

interface RetryDelays {
  [streamId: string]: number;
}

export type ProcessMessageFn = (
  session: Session,
  message: Message,
  signal: AbortSignal,
  publishChunk: (event: string, data: Record<string, unknown>) => void,
  /** Номер попытки (1-based) — для решения о терминальности сбоя (ADR-070 §2.6). */
  attempt?: number,
) => Promise<{ error?: string; errorType?: string; canRetry?: boolean }>;

/**
 * QueueProcessor — фоновый обработчик очереди сообщений для одной сессии.
 * Портирован из synth-legacy core/chat/queue_processor.py
 */
export class QueueProcessor {
  private _running = false;
  private _cancelled = false;
  /** Запрос «Стоп» от абонента (abort-роут/`requestStop`): останавливаем цикл. */
  private _stopRequested = false;
  private _retryDelays: RetryDelays = {};
  private _ringBuffer: Map<string, Record<string, unknown>[]> = new Map();
  private _activeController: AbortController | null = null;
  private _backoffTimer: ReturnType<typeof setTimeout> | null = null;
  private _backoffResolver: (() => void) | null = null;
  /**
   * Шаг 2б: восстановление «зависших» после падения/рестарта сообщений
   * выполняется один раз на инстанс процессора (до первой установки
   * `currentStream`), best-effort.
   */
  private _streamRecoveryDone = false;

  constructor(
    private sessionId: string,
    private sessionManager: SessionManager,
    private eventBus: EventBus,
    private processMessage: ProcessMessageFn,
    private contextOptimizer?: ContextOptimizer,
    /** ADR-102: сборщик аналитики — точка персиста пользовательского сообщения. */
    private analytics?: AnalyticsRecorder,
  ) {}

  get isRunning(): boolean {
    return this._running;
  }

  async start(): Promise<void> {
    if (this._running) return;

    this._running = true;
    this._cancelled = false;
    this._stopRequested = false;

    try {
      await this._run();
    } finally {
      this._running = false;
    }
  }

  stop(): void {
    this._cancelled = true;
  }

  /**
   * Прерывание backoff-паузы: «Повторить сейчас» (немедленный повтор) и
   * «Отменить» (остановка ретраев) используют общий механизм пробуждения.
   * Если процессор не спит в backoff — no-op.
   */
  retryNow(): void {
    this.wakeBackoff();
  }

  /**
   * «Стоп» (abort-роут, `/stop`): останавливаем процессор целиком — цикл
   * прерывается на ближайшей границе, backoff будится, активный LLM-вызов
   * абортится. Очистку pending/blocked/currentStream/флага выполняет `_run`
   * (`_handleStopRequest`) — так гарантируется, что состояние сессии снимается
   * под локом и только один раз.
   *
   * Запрос не теряется: если «Стоп» пришёл в окне между границей цикла и
   * стартом LLM-вызова (Phase 1 пишет сессию — окно реальное), `_run`
   * перепроверяет `_shouldStop` перед вызовом и LLM-вызов не запускает вовсе.
   */
  requestStop(): void {
    this._stopRequested = true;
    this.wakeBackoff();
    this._activeController?.abort();
  }

  /**
   * Нужно ли остановиться: in-memory запрос (`requestStop`) или персистентный
   * флаг `status.cancelRequested` в сессии (переживает рестарт процесса,
   * работает для событий из другого инстанса/шлюза).
   */
  private _shouldStop(session: Session | null | undefined): boolean {
    return this._stopRequested || session?.status?.cancelRequested === true;
  }

  /**
   * Обработка остановки: под локом чистим очередь (Стоп = очередь не
   * продолжаем), снимаем blocked/cancelRequested и — если стрим ещё «висит»
   * (graceful-отмена оркестратора его не сняла, напр. backoff/очередь) —
   * публикуем `stream.cancelled` ровно один раз.
   */
  private async _handleStopRequest(): Promise<void> {
    this._cancelled = true;

    const streamId = await this.sessionManager.withLock(this.sessionId, async (s) => {
      const id = s.currentStream?.streamId;
      s.pendingMessages = [];
      s.status.blocked = undefined;
      s.status.blockedAt = undefined;
      s.status.cancelRequested = undefined;
      s.status.cancelRequestedAt = undefined;
      s.currentStream = undefined;
      s.updatedAt = nowISO();
      await this.sessionManager.saveSession(s);
      return id;
    });

    // Дублирующей публикации нет: если отмену уже отработал оркестратор
    // (graceful → `stream.cancelled` + успешная ветка сняла currentStream),
    // здесь streamId === undefined.
    if (streamId) {
      this.eventBus.publish(this.sessionId, 'stream.cancelled', {
        stream_id: streamId,
        content: '',
        status: 'cancelled',
      });
    }

    this.wakeBackoff();
  }

  /**
   * Остановка ретраев: прерываем backoff и активный LLM-вызов, удаляем текущее
   * сообщение из очереди, разблокируем сессию и публикуем финальный stream.error
   * (can_retry: false) — UI завершает стрим и показывает стандартное уведомление.
   */
  async cancelRetry(): Promise<void> {
    const session = await this.sessionManager.getSession(this.sessionId);
    const streamId = session?.currentStream?.streamId;

    this._cancelled = true;

    // Порядок важен (фикс гонки): сначала снимаем pending/blocked/currentStream
    // под локом, и только ПОТОМ будим backoff и абортим активный вызов. Иначе
    // _run(), проснувшись, доходил до финальной проверки pending раньше, чем
    // withLock успевал удалить сообщение, и публиковал ложный queue.stalled.
    await this.sessionManager.withLock(this.sessionId, async (s) => {
      s.pendingMessages = s.pendingMessages.filter((_, i) => i !== 0);
      s.status.blocked = undefined;
      s.status.blockedAt = undefined;
      s.currentStream = undefined;
      await this.sessionManager.saveSession(s);
    });

    this.wakeBackoff();
    this._activeController?.abort();

    if (streamId) {
      this.eventBus.publish(this.sessionId, 'stream.error', {
        stream_id: streamId,
        error: sm('session.retry_cancelled'),
        error_type: 'retry_cancelled',
        can_retry: false,
        retry_count: this._retryDelays[streamId] || 0,
      });
      delete this._retryDelays[streamId];
    }
  }

  private wakeBackoff(): void {
    if (this._backoffTimer) {
      clearTimeout(this._backoffTimer);
      this._backoffTimer = null;
    }
    if (this._backoffResolver) {
      const resolve = this._backoffResolver;
      this._backoffResolver = null;
      resolve();
    }
  }

  private _sleepBackoff(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this._backoffResolver = resolve;
      this._backoffTimer = setTimeout(() => {
        this._backoffTimer = null;
        this._backoffResolver = null;
        resolve();
      }, ms);
    });
  }

  private async _run(): Promise<void> {
    // Шаг 2б: после падения/рестарта в истории могли остаться черновики
    // частичного стрима (`metadata.streaming`) и assistant(tool_calls) без пары.
    // Чиним один раз на инстанс процессора, до установки нового `currentStream`;
    // сбой recovery не должен ломать очередь.
    if (!this._streamRecoveryDone) {
      this._streamRecoveryDone = true;
      try {
        await this.sessionManager.recoverStreamingMessages(this.sessionId);
      } catch {
        // best-effort
      }
    }

    while (!this._cancelled) {
      let session: Session | null;

      try {
        session = await this.sessionManager.getSession(this.sessionId);
      } catch {
        break;
      }

      if (!session) break;

      // «Стоп» на любой границе цикла (в т.ч. после processMessage/_sleepBackoff —
      // все ветки возвращаются сюда): персистентный флаг сессии либо in-memory
      // запрос. Останавливаемся общей веткой — очередь не продолжаем.
      if (this._shouldStop(session)) {
        await this._handleStopRequest();
        break;
      }

      if (session.pendingMessages.length === 0) break;

      // Проверка: ожидается ли суммаризация перед следующим сообщением?
      if (this.contextOptimizer && session.summarizationPending) {
        try {
          session = await this.sessionManager.withLock(this.sessionId, async (s) => {
            // Вставить системное сообщение в начало очереди вместо блокирующего вызова
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
        let alreadyInHistory = false;
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
            // Дедупликация: если сообщение с тем же stream_id уже в истории
            // (например, после resume зависшей сессии) — не пушим его повторно,
            // иначе получим дубль в s.messages.
            const already = s.messages.some(
              (m) => m.role === MessageRole.USER && m.metadata?.stream_id === streamId,
            );
            alreadyInHistory = already;
            if (!already) {
              s.messages.push(message);
            }
          }
          s.updatedAt = nowISO();
          await this.sessionManager.saveSession(s);
          return s;
        });

        if (!session) break;

        // Для пользовательских сообщений — уведомить UI о появлении сообщения
        if (!isSystemMessage && !alreadyInHistory) {
          const userMsgIndex = session.messages.length - 1;
          this.eventBus.publish(this.sessionId, 'message.added', {
            message_index: userMsgIndex,
            role: message.role,
            content: message.content.slice(0, 500),
            author: message.author,
            agent_role: message.agentRole,
            metadata: message.metadata || undefined,
          });
          // ADR-102: точка персиста пользовательского сообщения (ось `user`).
          void this.analytics?.recordActivity('messages_user', sessionAxes(session));
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

        // «Стоп» мог прийти в окне между границей цикла (проверка выше) и
        // стартом LLM-вызова: Phase 1 пишет сессию (файл) и публикует
        // `message.added`/`stream.start` — окно реальное и достаточное, чтобы
        // попасть под нагрузкой. Раньше запрос «Стоп» здесь ТЕРЯЛСЯ: флаг
        // `_stopRequested` выставлялся, но `abort()` уходил в пустоту
        // (`_activeController` ещё не создан), и LLM-вызов уходил до конца,
        // хотя пользователь уже нажал «Стоп». Теперь запрос не теряем:
        // контроллер абортим, сам вызов НЕ запускаем — остановку разберёт цикл
        // на своей границе (`_handleStopRequest`: чистит очередь/blocked/
        // currentStream/флаг и публикует `stream.cancelled` ровно один раз).
        if (this._shouldStop(session)) {
          abortController.abort();
          continue;
        }

        this._activeController = abortController;

        // Микро-окно между проверкой выше и вызовом: если «Стоп» успел прийти
        // в этот момент — сигнал, который получит processMessage, уже aborted
        // (поздний подписчик не увидит событие 'abort' — потребитель обязан
        // проверять `signal.aborted`).
        if (this._shouldStop(session)) {
          abortController.abort();
        }

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
          // ADR-070 §2.6: текущая попытка (1-based). _retryDelays хранит число
          // уже совершённых неудачных попыток.
          (this._retryDelays[streamId] ?? 0) + 1,
        );
        this._activeController = null;

        // Обработка результата
        if (result.error) {
          const retryCount = (this._retryDelays[streamId] || 0) + 1;
          this._retryDelays[streamId] = retryCount;

          const isRecoverable = result.canRetry !== undefined
            ? result.canRetry
            : this._isRecoverable(result.error, result.errorType);

          if (!isRecoverable || retryCount > LLM_MAX_ATTEMPTS) {
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
            // Recoverable — повторить через backoff. Перед паузой публикуем
            // stream.retry, чтобы UI показал «Повторная попытка N/MAX через X сек»
            // вместо вечной крутилки (раньше ретраи были полностью скрыты).
            const delay = this._calcBackoff(retryCount);
            this.eventBus.publish(this.sessionId, 'stream.retry', {
              stream_id: streamId,
              attempt: retryCount,
              max_retries: LLM_MAX_ATTEMPTS,
              retry_in: delay,
              error: result.error,
            });
            await this._sleepBackoff(delay);
            continue; // не удаляем из очереди, пробуем снова
          }
        }

        // Успех — удалить сообщение из очереди и очистить устаревший last_error
        await this.sessionManager.withLock(this.sessionId, async (s) => {
          s.pendingMessages = s.pendingMessages.filter((_, i) => i !== 0);
          const userMsg = s.messages.find(
            (m) => m.metadata?.stream_id === streamId && m.role === MessageRole.USER,
          );
          if (userMsg?.metadata?.last_error) {
            delete userMsg.metadata.last_error;
          }
          s.status.blocked = undefined;
          s.status.blockedAt = undefined;
          s.currentStream = undefined;
          s.updatedAt = nowISO();
          await this.sessionManager.saveSession(s);
        });

        delete this._retryDelays[streamId];
      } catch (err) {
        // Непредвиденная ошибка — полная очистка состояния сессии, иначе
        // currentStream и зависшее pending-сообщение блокируют сессию навсегда:
        // снимаем blocked, чистим currentStream, удаляем сообщение из очереди
        // и фиксируем ошибку в last_error.
        try {
          await this.sessionManager.withLock(this.sessionId, async (s) => {
            s.pendingMessages = s.pendingMessages.filter((_, i) => i !== 0);
            const msg = s.messages.find(
              (m) => m.metadata?.stream_id === streamId && m.role === 'user',
            );
            if (msg) {
              msg.metadata = { ...msg.metadata, last_error: String(err) };
            }
            s.status.blocked = undefined;
            s.status.blockedAt = undefined;
            s.currentStream = undefined;
            await this.sessionManager.saveSession(s);
          });
        } catch (lockErr) {
          console.warn(`[QueueProcessor] Не удалось очистить сессию ${this.sessionId}: ${String(lockErr)}`);
        }
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

    // Гонка с cancelRetry(): если процессор отменён, не публикуем queue.stalled /
    // question.asked — отмена уже сняла pending и разблокировала сессию, иначе
    // UI кратковременно мигает панелью «Обработка остановлена».
    if (this._cancelled) return;

    // Проверка: остались ли pending сообщения
    try {
      const session = await this.sessionManager.getSession(this.sessionId);
      // Финальная проверка останова: запрос «Стоп» мог прийти на последней
      // итерации перед выходом из цикла — не оставляем персистентный флаг.
      if (this._shouldStop(session)) {
        await this._handleStopRequest();
        return;
      }
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

  private _isRecoverable(errorStr: string, errorType?: string): boolean {
    // Единая точка истины — таксономия в llm-error.ts (та же, что в
    // саб-агенте task.ts и оркестраторе). Здесь только делегирование.
    return isLlmErrorRecoverable(undefined, errorStr, errorType);
  }

  private _calcBackoff(attempt: number): number {
    // Политика задержек — из общего списка LLM_RETRY_DELAYS_MS (первые 3).
    // Для 4-й попытки и позже сохраняем прежнее поведение (60с).
    const delays = [...LLM_RETRY_DELAYS_MS, 60000];
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
  /** ADR-102: сборщик аналитики — прокидывается в создаваемые процессоры. */
  private _analytics?: AnalyticsRecorder;

  setContextOptimizer(optimizer: ContextOptimizer): void {
    this._contextOptimizer = optimizer;
  }

  /** ADR-102: включить запись `activity` из точек персиста сообщений. */
  setAnalytics(analytics: AnalyticsRecorder | undefined): void {
    this._analytics = analytics;
  }

  createProcessor(
    sessionId: string,
    sessionManager: SessionManager,
    eventBus: EventBus,
    processMessage: ProcessMessageFn,
  ): QueueProcessor {
    const existing = this._processors.get(sessionId);
    if (existing && existing.isRunning) return existing;

    const processor = new QueueProcessor(
      sessionId,
      sessionManager,
      eventBus,
      processMessage,
      this._contextOptimizer,
      this._analytics,
    );
    this._processors.set(sessionId, processor);

    processor.start().catch((err) => {
      console.error(`[QueueProcessorManager] Ошибка старта процессора ${sessionId}: ${String(err)}`);
    });

    return processor;
  }

  isRunning(sessionId: string): boolean {
    return this._processors.get(sessionId)?.isRunning ?? false;
  }

  getProcessor(sessionId: string): QueueProcessor | undefined {
    return this._processors.get(sessionId);
  }

  /** Немедленный повтор: прервать backoff-паузу, если процессор в ретрае. */
  retryNow(sessionId: string): boolean {
    const processor = this._processors.get(sessionId);
    if (!processor) return false;
    processor.retryNow();
    return true;
  }

  /**
   * «Стоп»: остановить активный процессор сессии. Возвращает `false`, если
   * процессора нет или он уже не выполняется (нечего останавливать).
   */
  requestStop(sessionId: string): boolean {
    const processor = this._processors.get(sessionId);
    if (!processor || !processor.isRunning) return false;
    processor.requestStop();
    return true;
  }

  /** Остановить ретраи: прервать backoff, очистить очередь и разблокировать сессию. */
  async cancelRetry(sessionId: string): Promise<boolean> {
    const processor = this._processors.get(sessionId);
    if (!processor) return false;
    await processor.cancelRetry();
    return true;
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
 * Результат постановки сообщения в очередь инъекций (PROP-098).
 */
export interface SteerEnqueueResult {
  /** Сообщение принято в очередь инъекций. */
  accepted: boolean;
  /** Причина отказа: превышен лимит инъекций на ход. */
  reason?: 'limit';
  /** Сколько сообщений ждёт в очереди инъекций. */
  pending: number;
}

/**
 * PROP-098: поставить сообщение в очередь инъекций (`steerInbox`) — отправка
 * во время активного хода (`mode: 'steer'`).
 *
 * Очередь отдельна от `pendingMessages`: её вычитывает оркестратор на границе
 * шага и вплетает сообщения в текущий ход (генерация не прерывается).
 *
 * Превышение лимита инъекций на ход — не 500: публикуется `steer.dropped`,
 * вызывающий отвечает понятной ошибкой API (`STEER_LIMIT_EXCEEDED`).
 */
export async function enqueueSteerMessage(
  sessionManager: SessionManager,
  eventBus: EventBus,
  sessionId: string,
  message: Message,
  maxInjections: number = MAX_STEER_INJECTIONS_PER_TURN,
  obfuscate?: (sessionId: string, message: Message) => Promise<Message>,
): Promise<SteerEnqueueResult> {
  // ADR-036: обфускация user-сообщения ДО постановки в очередь — в историю
  // попадёт плейсхолдер, а не реальный секрет.
  if (obfuscate && message.role === MessageRole.USER) {
    message = await obfuscate(sessionId, message);
  }
  // Признак инъекции — на самом сообщении (PROP-098): UI рисует маркер
  // «вмешательство в ход», а оркестратор персистит его как есть.
  message.metadata = { ...(message.metadata ?? {}), [STEER_METADATA_KEY]: true };

  const result = await sessionManager.enqueueSteerMessage(sessionId, message, maxInjections);
  if (!result.accepted) {
    eventBus.publish(sessionId, 'steer.dropped', {
      reason: 'limit',
      // Машинный код — тот же, что отдаёт API (429 STEER_LIMIT_EXCEEDED).
      code: STEERING_ERROR_CODES.limitExceeded,
      limit: maxInjections,
      pending_count: result.pending,
      error: sm('steer.limit_exceeded', { limit: String(maxInjections) }),
      i18n: i18nMeta('steer.limit_exceeded', { limit: String(maxInjections) }),
    });
    return { accepted: false, reason: 'limit', pending: result.pending };
  }

  return { accepted: true, pending: result.pending };
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
  obfuscate?: (sessionId: string, message: Message) => Promise<Message>,
): Promise<Session | null> {
  if (!message.metadata) message.metadata = {};
  if (!message.metadata.stream_id) message.metadata.stream_id = generateStreamId();
  const enqueueStreamId = message.metadata.stream_id;

  // ADR-036: обфусцируем user-сообщение ДО сохранения в историю, чтобы в
  // session.messages и message.added попадал плейсхолдер, а не реальный секрет.
  // Если gateway выключен — колбэк возвращает сообщение без изменений
  // (обратная совместимость).
  if (obfuscate && message.role === MessageRole.USER) {
    message = await obfuscate(sessionId, message);
  }

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
    stream_id: enqueueStreamId,
    pending_count: session.pendingMessages.length,
    message: message.content,
    agent_role: message.agentRole,
    author: message.author,
  });

  processorManager.createProcessor(sessionId, sessionManager, eventBus, processMessage);

  return session;
}

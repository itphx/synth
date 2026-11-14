/**
 * Терминальный сервис (план терминалов — Ф3а; дизайн §3).
 *
 * ## Что делает сервис
 *
 * - **реестр** живых терминалов (in-memory: терминал не переживает рестарт
 *   инстанса — свойство, а не дефект, дизайн §1);
 * - **поток вывода**: кольцевой буфер 512 КиБ (сегменты 8 КиБ) + доставка
 *   подписчикам батчами по 10–15 мс; несколько подписчиков одновременно,
 *   `since` отдаёт replay из буфера до live;
 * - **ввод**: кап 16 КиБ на кадр, token bucket 20 кадров/с на терминал;
 * - **лимиты**: 8 терминалов на проект, 32 на инстанс (`TerminalLimitError`);
 * - **выключатель инстанса**: `setEnabled(false)` закрывает все терминалы и
 *   запрещает создание (`TerminalDisabledError`);
 * - **idle-reaper**: терминал без подписчиков и без привязки к активной
 *   сессии дольше `idleMs` (по умолчанию 2 дня) закрывается; таймер `unref`;
 * - **события**: `terminal.created|updated|exited|deleted` в канал сессии
 *   (только у терминалов с привязкой — в шине нет канала проекта, дизайн §4);
 * - **аудит**: `terminal.open`/`terminal.input`/`terminal.close` — только
 *   метаданные (ADR-136);
 * - **метрики**: `synth_terminal_sessions{status}`/`synth_terminal_bytes_total{op}`
 *   (ADR-094).
 *
 * ## Границы (инварианты)
 *
 * - **Права — на границе** (инвариант 16): сервис не решает, кто может писать
 *   в терминал; роут (Ф3б) проверяет права до вызова. `actorId` передаётся
 *   только для аудита;
 * - **Транспорт — HTTP-стрим** (дизайн §4): поток вывода **не** идёт через
 *   шину (волатильный класс событий — отдельное архитектурное решение);
 *   через шину идут только метаданные терминала;
 * - **Никакого содержимого** в аудите и метриках.
 */
import { randomUUID } from 'node:crypto';
import { isExecutionError, type ExecutionPort, type PtyHandle } from '../../execution/ports/index.js';
import type { EventBus } from '../../events/bus.js';
import type { TerminalAuditSink, TerminalCloseReason } from './audit.js';
import type { TerminalMetricsHooks } from './metrics.js';
import { TerminalRingBuffer } from './ring-buffer.js';
import {
  DEFAULT_TERMINAL_LIMITS,
  TerminalDisabledError,
  TerminalInvalidRequestError,
  TerminalLimitError,
  TerminalNotFoundError,
  TerminalUnavailableError,
  type TerminalCreateInput,
  type TerminalEventType,
  type TerminalListFilter,
  type TerminalLogger,
  type TerminalOutputChunk,
  type TerminalOutputSnapshot,
  type TerminalRecord,
  type TerminalServiceOptions,
  type TerminalSubscribeOptions,
  type TerminalSubscription,
  type TerminalSubscriptionHandlers,
  type TerminalTimerHandle,
  type TerminalTimers,
} from './types.js';

/** Живой терминал: запись реестра + хэндл PTY + буфер и подписчики. */
interface TerminalRuntime {
  /** Запись реестра (единственный источник правды по метаданным). */
  record: TerminalRecord;
  /** Хэндл PTY-сессии. */
  handle: PtyHandle;
  /** Кольцевой буфер вывода. */
  buffer: TerminalRingBuffer;
  /** Подписчики на вывод. */
  subscribers: Map<string, TerminalSubscriber>;
  /** Очередь неотданных фрагментов (батчинг). */
  pending: TerminalOutputChunk[];
  /** Объём очереди неотданных фрагментов, байт. */
  pendingBytes: number;
  /** Таймер батчинга (null — таймер не запланирован). */
  flushTimer: TerminalTimerHandle | null;
  /** Остаток token bucket'а ввода. */
  tokens: number;
  /** Момент последнего пересчёта token bucket'а. */
  tokensUpdatedAt: number;
  /** Терминал завершён (выход обработан). */
  finished: boolean;
  /** Причина закрытия (задаётся до `handle.close()`). */
  closeReason?: TerminalCloseReason;
  /** Актор закрытия (для аудита). */
  closeActor?: string;
}

/** Подписчик на вывод терминала. */
interface TerminalSubscriber {
  /** Идентификатор подписки (внутри сервиса). */
  id: string;
  /** Обработчики клиента. */
  handlers: TerminalSubscriptionHandlers;
  /** Номер последнего доставленного фрагмента. */
  lastSeq: number;
}

/**
 * Таймеры по умолчанию.
 *
 * `globalThis` читается **в момент вызова** — иначе fake timers Vitest не
 * подхватили бы (тесты подменяют глобальные функции до создания сервиса).
 */
const DEFAULT_TIMERS: TerminalTimers = {
  setTimeout(handler: () => void, ms: number): TerminalTimerHandle {
    return globalThis.setTimeout(handler, ms) as unknown as TerminalTimerHandle;
  },
  clearTimeout(handle: TerminalTimerHandle): void {
    globalThis.clearTimeout(handle as unknown as ReturnType<typeof globalThis.setTimeout>);
  },
  setInterval(handler: () => void, ms: number): TerminalTimerHandle {
    return globalThis.setInterval(handler, ms) as unknown as TerminalTimerHandle;
  },
  clearInterval(handle: TerminalTimerHandle): void {
    globalThis.clearInterval(handle as unknown as ReturnType<typeof globalThis.setInterval>);
  },
};

/** Границы размера терминала (защита от абсурдных значений из клиента). */
const MIN_TERMINAL_DIMENSION = 1;
const MAX_TERMINAL_DIMENSION = 1000;

/** Ограничить размер терминала. */
function clampDimension(value: number): number {
  if (!Number.isFinite(value)) return 80;
  return Math.min(MAX_TERMINAL_DIMENSION, Math.max(MIN_TERMINAL_DIMENSION, Math.floor(value)));
}

/** Оболочка по умолчанию (та же цепочка, что у inline-порта). */
function defaultShell(): string {
  return process.env.SHELL?.trim() || '/bin/bash';
}

/** Нормализовать клиентский id терминала (`term_<uuid>`). */
function normalizeTerminalId(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '') throw new TerminalInvalidRequestError('id терминала не может быть пустым');
  const withPrefix = trimmed.startsWith('term_') ? trimmed : `term_${trimmed}`;
  if (!/^term_[A-Za-z0-9._-]{1,120}$/.test(withPrefix)) {
    throw new TerminalInvalidRequestError(`Некорректный id терминала: ${trimmed}`);
  }
  return withPrefix;
}

/** Обязательное непустое поле запроса. */
function requireText(value: string, field: string): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (trimmed === '') throw new TerminalInvalidRequestError(`Поле ${field} обязательно`);
  return trimmed;
}

/**
 * Сервис терминалов.
 *
 * Экземпляр — на инстанс (собирается в `server/app/deps.ts`/backend при
 * старте); глобальных синглтонов нет.
 */
export class TerminalService {
  private readonly _port: ExecutionPort;
  private readonly _eventBus?: EventBus;
  private readonly _audit?: TerminalAuditSink;
  private readonly _metrics?: TerminalMetricsHooks;
  private readonly _limits: typeof DEFAULT_TERMINAL_LIMITS;
  private readonly _generateId: () => string;
  private readonly _now: () => number;
  private readonly _timers: TerminalTimers;
  private readonly _logger: TerminalLogger;
  private readonly _target: TerminalRecord['target'];
  private readonly _executorId?: string;
  private readonly _isSessionActive?: (sessionId: string) => boolean | Promise<boolean>;

  /** Живые и завершённые терминалы (id → состояние). */
  private readonly _terminals = new Map<string, TerminalRuntime>();
  /** Single-flight открытия: ключ → промис открытия. */
  private readonly _opening = new Map<string, Promise<TerminalRecord>>();
  /** Счётчик незавершённых открытий по проектам (учёт в лимитах). */
  private readonly _openingByProject = new Map<string, number>();
  private _subscriberCounter = 0;
  private _enabled = true;
  private _reaperTimer: TerminalTimerHandle | null = null;
  private _disposed = false;

  constructor(options: TerminalServiceOptions) {
    this._port = options.port;
    this._eventBus = options.eventBus;
    this._audit = options.audit;
    this._metrics = options.metrics;
    this._limits = { ...DEFAULT_TERMINAL_LIMITS, ...(options.limits ?? {}) };
    this._generateId = options.generateId ?? (() => randomUUID());
    this._now = options.now ?? (() => Date.now());
    this._timers = options.timers ?? DEFAULT_TIMERS;
    this._logger = options.logger ?? {
      warn: (message: string) => console.warn(message),
      error: (message: string) => console.error(message),
    };
    this._target = options.target ?? (options.port.isRemote ? 'executor' : 'inline');
    if (options.executorId !== undefined) this._executorId = options.executorId;
    this._isSessionActive = options.isSessionActive;
    this._startReaper();
  }

  /** Включён ли терминальный контур на инстансе. */
  isEnabled(): boolean {
    return this._enabled;
  }

  /**
   * Мастер-выключатель инстанса (`terminal.enabled`).
   *
   * `false` — все живые терминалы закрываются (события `terminal.exited` +
   * `terminal.deleted` с причиной `disabled`), создание запрещено
   * (`TerminalDisabledError`). Переключение — **live** (дизайн §4.1).
   */
  setEnabled(enabled: boolean): void {
    if (this._enabled === enabled) return;
    this._enabled = enabled;
    if (!enabled) {
      for (const runtime of [...this._terminals.values()]) {
        if (runtime.finished) {
          this._terminals.delete(runtime.record.id);
          this._publish(runtime, 'terminal.deleted', { reason: 'disabled' });
          continue;
        }
        void this._closeRuntime(runtime, { reason: 'disabled', remove: true });
      }
      this._syncMetrics();
    }
  }

  /**
   * Создать терминал.
   *
   * - **idempotency по клиентскому id**: создание с уже существующим id
   *   возвращает существующий терминал (переподключение после reload);
   * - **single-flight по `(cwd, shell, backend)`**: параллельные открытия с
   *   одинаковым ключом получают **один** терминал (дизайн §10);
   * - **лимиты**: `maxPerProject`/`maxPerInstance` → `TerminalLimitError`.
   */
  async create(input: TerminalCreateInput): Promise<TerminalRecord> {
    this._assertUsable();

    const projectId = requireText(input.projectId, 'projectId');
    const ownerId = requireText(input.ownerId, 'ownerId');
    const cwd = requireText(input.cwd, 'cwd');
    const shell = input.shell?.trim() || defaultShell();
    const cols = clampDimension(input.cols);
    const rows = clampDimension(input.rows);

    const base = {
      projectId,
      ownerId,
      cwd,
      shell,
      cols,
      rows,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.title ? { title: input.title } : {}),
      ...(input.env ? { env: input.env } : {}),
    };

    if (input.id !== undefined) {
      const id = normalizeTerminalId(input.id);
      const existing = this._terminals.get(id);
      if (existing) return { ...existing.record };
      const key = `id:${id}`;
      const inflight = this._opening.get(key);
      if (inflight) return inflight;
      const promise = this._openTerminal({ ...base, id });
      this._opening.set(key, promise);
      try {
        return await promise;
      } finally {
        this._opening.delete(key);
      }
    }

    const key = `key:${this._target}\u0000${cwd}\u0000${shell}`;
    const inflight = this._opening.get(key);
    if (inflight) return inflight;
    const promise = this._openTerminal(base);
    this._opening.set(key, promise);
    try {
      return await promise;
    } finally {
      this._opening.delete(key);
    }
  }

  /**
   * Записать ввод в терминал.
   *
   * Кап кадра — `maxInputBytes` (16 КиБ), скорость — `inputRatePerSecond`
   * (20 кадров/с, token bucket). Нарушение → `TerminalLimitError`
   * (`scope: 'input'`/`'rate'`).
   */
  write(id: string, data: string, options: { actorId?: string } = {}): void {
    const runtime = this._requireLiveRuntime(id);
    const bytes = Buffer.byteLength(data, 'utf8');
    if (bytes > this._limits.maxInputBytes) {
      throw new TerminalLimitError({
        scope: 'input',
        limit: this._limits.maxInputBytes,
        message: `Кадр ввода больше ${this._limits.maxInputBytes} байт`,
      });
    }
    this._consumeToken(runtime);
    runtime.handle.write(data);
    runtime.record.lastActivityAt = this._now();
    this._metrics?.addBytes('input', bytes);
    this._auditRuntime(runtime, 'terminal.input', {
      ...(options.actorId !== undefined ? { actorId: options.actorId } : {}),
      bytes,
      enter: data.includes('\n') || data.includes('\r'),
    });
  }

  /** Изменить размер терминала (колонки/строки). */
  resize(id: string, cols: number, rows: number): TerminalRecord {
    const runtime = this._requireLiveRuntime(id);
    const nextCols = clampDimension(cols);
    const nextRows = clampDimension(rows);
    runtime.handle.resize(nextCols, nextRows);
    runtime.record.cols = nextCols;
    runtime.record.rows = nextRows;
    runtime.record.lastActivityAt = this._now();
    this._publish(runtime, 'terminal.updated', { cols: nextCols, rows: nextRows });
    return { ...runtime.record };
  }

  /**
   * Точечная правка метаданных терминала (заголовок, привязка к сессии).
   *
   * Правляется запись реестра; событие `terminal.updated` уходит в канал
   * сессии терминала. Смена привязки допустима только внутри того же проекта —
   * это проверяет роут (права и целостность привязки — на границе, инвариант 16).
   *
   * `null` — сброс поля (заголовок/привязка снимаются).
   */
  update(id: string, patch: { title?: string | null; sessionId?: string | null }): TerminalRecord {
    const runtime = this._terminals.get(id);
    if (!runtime) throw new TerminalNotFoundError(id);
    if (patch.title !== undefined) {
      if (patch.title === null) delete runtime.record.title;
      else runtime.record.title = patch.title;
    }
    if (patch.sessionId !== undefined) {
      if (patch.sessionId === null) delete runtime.record.sessionId;
      else runtime.record.sessionId = patch.sessionId;
    }
    runtime.record.lastActivityAt = this._now();
    this._publish(runtime, 'terminal.updated');
    return { ...runtime.record };
  }

  /**
   * Закрыть терминал (пользователь нажал «Закрыть»).
   *
   * PTY закрывается (`SIGTERM` → `SIGKILL` — это делает хэндл), подписчики
   * получают `onExit`, публикуются `terminal.exited` + `terminal.deleted`.
   */
  async close(id: string, options: { actorId?: string } = {}): Promise<void> {
    const runtime = this._terminals.get(id);
    if (!runtime) throw new TerminalNotFoundError(id);
    await this._closeRuntime(runtime, {
      reason: 'user',
      remove: true,
      ...(options.actorId !== undefined ? { actorId: options.actorId } : {}),
    });
  }

  /** Запись терминала (копия — реестр не отдаётся наружу). */
  get(id: string): TerminalRecord | null {
    const runtime = this._terminals.get(id);
    return runtime ? { ...runtime.record } : null;
  }

  /** Список терминалов (по умолчанию — только живые). */
  list(filter: TerminalListFilter = {}): TerminalRecord[] {
    const result: TerminalRecord[] = [];
    for (const runtime of this._terminals.values()) {
      const record = runtime.record;
      if (!filter.includeExited && record.status === 'exited') continue;
      if (filter.projectId !== undefined && record.projectId !== filter.projectId) continue;
      if (filter.sessionId !== undefined && record.sessionId !== filter.sessionId) continue;
      result.push({ ...record });
    }
    return result;
  }

  /** Сколько клиентов сейчас подписано на вывод терминала. */
  attachedClients(id: string): number {
    return this._terminals.get(id)?.subscribers.size ?? 0;
  }

  /**
   * Снимок вывода терминала (для `GET /terminals/:id/output`).
   *
   * Отдаёт и завершённый терминал: после выхода оболочки вкладка остаётся с
   * последним выводом (дизайн §10), и клиент должен иметь возможность его
   * перечитать.
   */
  output(id: string): TerminalOutputSnapshot | null {
    const runtime = this._terminals.get(id);
    return runtime ? runtime.buffer.snapshot() : null;
  }

  /**
   * Подписаться на вывод терминала.
   *
   * `since` — с какого фрагмента отдать replay (фрагменты с `seq > since`),
   * затем — живой поток. `onReset` сообщает клиенту, что часть вывода
   * вытеснена из буфера и её нужно перечитать (`GET /terminals/:id/output`).
   */
  subscribe(
    id: string,
    options: TerminalSubscribeOptions,
    handlers: TerminalSubscriptionHandlers,
  ): TerminalSubscription {
    const runtime = this._terminals.get(id);
    if (!runtime) throw new TerminalNotFoundError(id);
    if (typeof handlers?.onData !== 'function') {
      throw new TerminalInvalidRequestError('Обработчик onData обязателен');
    }
    const subscriber: TerminalSubscriber = {
      id: `sub_${++this._subscriberCounter}`,
      handlers,
      lastSeq: 0,
    };

    const since = options?.since;
    if (typeof since === 'number' && Number.isFinite(since)) {
      const firstSeq = runtime.buffer.firstSeq;
      if (firstSeq > 0 && since + 1 < firstSeq) {
        this._safeReset(subscriber, {
          droppedBytes: runtime.buffer.droppedBytes,
          firstSeq,
        });
      }
      for (const piece of runtime.buffer.since(since)) {
        subscriber.lastSeq = piece.seq;
        this._safeData(subscriber, piece);
      }
    }

    runtime.subscribers.set(subscriber.id, subscriber);
    runtime.record.lastActivityAt = this._now();

    // Терминал уже завершён: выход отдаём сразу (событие одно — как у порта).
    if (runtime.finished) {
      try {
        handlers.onExit({
          ...(runtime.record.exitCode !== undefined ? { exitCode: runtime.record.exitCode } : {}),
          ...(runtime.record.signal !== undefined ? { signal: runtime.record.signal } : {}),
        });
      } catch (err) {
        this._logger.warn(
          `[TerminalService] обработчик выхода подписчика ${subscriber.id} бросил: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    return {
      snapshot: runtime.buffer.snapshot(),
      unsubscribe: (): void => {
        runtime.subscribers.delete(subscriber.id);
        runtime.record.lastActivityAt = this._now();
      },
    };
  }

  /** Остановить сервис: закрыть терминалы, снять таймеры. */
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this._stopReaper();
    for (const runtime of [...this._terminals.values()]) {
      try {
        const closing = runtime.handle.close({ signal: 'SIGTERM' });
        // Закрытие не удалось — процесс убьёт supervisor; ошибку глушим.
        if (closing && typeof closing.catch === 'function') closing.catch(() => undefined);
      } catch {
        // ignore
      }
    }
    this._terminals.clear();
  }

  // -------------------------------------------------------------------------
  // Внутреннее
  // -------------------------------------------------------------------------

  /** Сервис жив и терминалы разрешены. */
  private _assertUsable(): void {
    if (this._disposed) {
      throw new TerminalUnavailableError('disposed', 'Сервис терминалов остановлен');
    }
    if (!this._enabled) throw new TerminalDisabledError();
  }

  /** Живой терминал (иначе — `TerminalNotFoundError`). */
  private _requireLiveRuntime(id: string): TerminalRuntime {
    const runtime = this._terminals.get(id);
    if (!runtime) throw new TerminalNotFoundError(id);
    if (runtime.finished) throw new TerminalNotFoundError(id, `Терминал ${id} завершён`);
    return runtime;
  }

  /** Проверить лимиты (живые терминалы + незавершённые открытия). */
  private _assertLimits(projectId: string): void {
    const live = this._listLive();
    const perProject = live.filter((record) => record.projectId === projectId).length;
    const opening = this._openingByProject.get(projectId) ?? 0;
    if (perProject + opening >= this._limits.maxPerProject) {
      throw new TerminalLimitError({
        scope: 'project',
        limit: this._limits.maxPerProject,
        projectId,
        message: `Достигнут лимит терминалов проекта (${this._limits.maxPerProject})`,
      });
    }
    if (live.length + this._openingByProjectTotal() >= this._limits.maxPerInstance) {
      throw new TerminalLimitError({
        scope: 'instance',
        limit: this._limits.maxPerInstance,
        message: `Достигнут лимит терминалов инстанса (${this._limits.maxPerInstance})`,
      });
    }
  }

  /** Суммарное число незавершённых открытий по всем проектам. */
  private _openingByProjectTotal(): number {
    let total = 0;
    for (const count of this._openingByProject.values()) total += count;
    return total;
  }

  /** Живые записи реестра. */
  private _listLive(): TerminalRecord[] {
    const result: TerminalRecord[] = [];
    for (const runtime of this._terminals.values()) {
      if (runtime.record.status !== 'exited') result.push(runtime.record);
    }
    return result;
  }

  /** Открыть PTY и зарегистрировать терминал. */
  private async _openTerminal(params: {
    id?: string;
    projectId: string;
    sessionId?: string;
    ownerId: string;
    cwd: string;
    shell: string;
    cols: number;
    rows: number;
    title?: string;
    env?: Record<string, string>;
  }): Promise<TerminalRecord> {
    this._assertLimits(params.projectId);
    const openPty = this._port.openPty;
    if (!openPty || this._port.pty === false) {
      throw new TerminalUnavailableError(
        'pty_unsupported',
        'Исполнение в этой среде не поддерживает PTY',
      );
    }

    const id = params.id ?? `term_${this._generateId()}`;
    const now = this._now();
    const record: TerminalRecord = {
      id,
      projectId: params.projectId,
      ownerId: params.ownerId,
      cwd: params.cwd,
      shell: params.shell,
      status: 'starting',
      cols: params.cols,
      rows: params.rows,
      createdAt: now,
      lastActivityAt: now,
      target: this._target,
      ...(params.sessionId !== undefined ? { sessionId: params.sessionId } : {}),
      ...(params.title !== undefined ? { title: params.title } : {}),
      ...(this._executorId !== undefined ? { executorId: this._executorId } : {}),
    };

    this._openingByProject.set(
      params.projectId,
      (this._openingByProject.get(params.projectId) ?? 0) + 1,
    );
    let handle: PtyHandle;
    try {
      handle = await openPty.call(this._port, {
        cwd: params.cwd,
        shell: params.shell,
        cols: params.cols,
        rows: params.rows,
        ...(params.env !== undefined ? { env: params.env } : {}),
      });
    } catch (err) {
      // Ошибка порта уже объяснила причину (`EPTY`/`spawn_failed`) — не прячем её.
      if (isExecutionError(err)) throw err;
      throw new TerminalUnavailableError(
        'spawn_failed',
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      const remaining = (this._openingByProject.get(params.projectId) ?? 1) - 1;
      if (remaining <= 0) this._openingByProject.delete(params.projectId);
      else this._openingByProject.set(params.projectId, remaining);
    }

    const runtime: TerminalRuntime = {
      record,
      handle,
      buffer: new TerminalRingBuffer({
        maxBytes: this._limits.ringBufferBytes,
        segmentBytes: this._limits.ringSegmentBytes,
      }),
      subscribers: new Map(),
      pending: [],
      pendingBytes: 0,
      flushTimer: null,
      tokens: this._limits.inputRatePerSecond,
      tokensUpdatedAt: now,
      finished: false,
    };
    this._terminals.set(id, runtime);
    record.status = 'running';

    handle.onData((chunk: string) => this._onData(runtime, chunk));
    handle.onExit((info: { exitCode?: number; signal?: string }) => {
      this._finish(runtime, info, runtime.closeReason ?? 'exited', runtime.closeActor);
    });

    this._auditRuntime(runtime, 'terminal.open', {
      ...(params.ownerId !== undefined ? { actorId: params.ownerId } : {}),
    });
    this._publish(runtime, 'terminal.created', { status: record.status });
    this._syncMetrics();
    return { ...record };
  }

  /** Вывод от PTY: в буфер + очередь на доставку. */
  private _onData(runtime: TerminalRuntime, chunk: string): void {
    if (runtime.finished || chunk === '') return;
    const pieces = runtime.buffer.append(chunk);
    if (pieces.length === 0) return;
    runtime.record.lastActivityAt = this._now();
    this._metrics?.addBytes('output', Buffer.byteLength(chunk, 'utf8'));
    for (const piece of pieces) {
      runtime.pending.push(piece);
      runtime.pendingBytes += piece.bytes;
    }
    this._trimPending(runtime);
    this._scheduleFlush(runtime);
  }

  /**
   * Ограничить очередь неотданных фрагментов.
   *
   * Кап — ёмкость кольцевого буфера (512 КиБ): клиент, который не читает
   * вывод, не должен раздувать память процесса. При переполнении **старейшие**
   * фрагменты вытесняются (дизайн §3: «при переполнении — `dropped`, клиент
   * догоняет через `GET /terminals/:id/output?since=`»); подписчик узнаёт об
   * этом из `onReset` (разрыв виден по номеру первого удерживаемого фрагмента).
   */
  private _trimPending(runtime: TerminalRuntime): void {
    const cap = this._limits.ringBufferBytes;
    while (runtime.pendingBytes > cap && runtime.pending.length > 0) {
      const dropped = runtime.pending.shift();
      if (!dropped) break;
      runtime.pendingBytes -= dropped.bytes;
    }
    if (runtime.pendingBytes < 0) runtime.pendingBytes = 0;
  }

  /** Запланировать батч доставки подписчикам. */
  private _scheduleFlush(runtime: TerminalRuntime): void {
    if (runtime.flushTimer !== null) return;
    runtime.flushTimer = this._timers.setTimeout(() => {
      runtime.flushTimer = null;
      this._flush(runtime);
    }, this._limits.flushIntervalMs);
    runtime.flushTimer.unref?.();
  }

  /** Отдать накопленные фрагменты подписчикам. */
  private _flush(runtime: TerminalRuntime): void {
    if (runtime.pending.length === 0) return;
    const pieces = runtime.pending.splice(0, runtime.pending.length);
    runtime.pendingBytes = 0;
    const firstSeq = runtime.buffer.firstSeq;
    const droppedBytes = runtime.buffer.droppedBytes;
    for (const subscriber of runtime.subscribers.values()) {
      // Разрыв проверяем **до** доставки: часть вывода могла быть вытеснена
      // из буфера/очереди, пока подписчик ждал батч.
      if (firstSeq > 0 && subscriber.lastSeq + 1 < firstSeq) {
        this._safeReset(subscriber, { droppedBytes, firstSeq });
      }
      for (const piece of pieces) {
        if (piece.seq <= subscriber.lastSeq) continue;
        subscriber.lastSeq = piece.seq;
        this._safeData(subscriber, piece);
      }
    }
  }

  /** Завершение терминала (выход процесса или явное закрытие). */
  private _finish(
    runtime: TerminalRuntime,
    info: { exitCode?: number; signal?: string },
    reason: TerminalCloseReason,
    actorId?: string,
  ): void {
    if (runtime.finished) return;
    runtime.finished = true;
    runtime.record.status = 'exited';
    if (info.exitCode !== undefined) runtime.record.exitCode = info.exitCode;
    if (info.signal !== undefined) runtime.record.signal = info.signal;
    runtime.record.lastActivityAt = this._now();
    if (runtime.flushTimer !== null) {
      this._timers.clearTimeout(runtime.flushTimer);
      runtime.flushTimer = null;
    }
    this._flush(runtime);
    for (const subscriber of runtime.subscribers.values()) {
      try {
        subscriber.handlers.onExit({
          ...(runtime.record.exitCode !== undefined ? { exitCode: runtime.record.exitCode } : {}),
          ...(runtime.record.signal !== undefined ? { signal: runtime.record.signal } : {}),
        });
      } catch (err) {
        this._logger.warn(
          `[TerminalService] обработчик выхода подписчика ${subscriber.id} бросил: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    this._publish(runtime, 'terminal.exited', {
      ...(runtime.record.exitCode !== undefined ? { exit_code: runtime.record.exitCode } : {}),
      ...(runtime.record.signal !== undefined ? { signal: runtime.record.signal } : {}),
      reason,
    });
    this._auditRuntime(runtime, 'terminal.close', {
      ...(actorId !== undefined ? { actorId } : {}),
      reason,
      ...(runtime.record.exitCode !== undefined ? { exitCode: runtime.record.exitCode } : {}),
      ...(runtime.record.signal !== undefined ? { signal: runtime.record.signal } : {}),
    });
    this._syncMetrics();
  }

  /** Закрыть терминал (хэндл + уведомления + события). */
  private async _closeRuntime(
    runtime: TerminalRuntime,
    options: { reason: TerminalCloseReason; remove: boolean; actorId?: string },
  ): Promise<void> {
    if (!runtime.finished) {
      runtime.closeReason = options.reason;
      if (options.actorId !== undefined) runtime.closeActor = options.actorId;
      try {
        await runtime.handle.close({ signal: 'SIGTERM' });
      } catch (err) {
        this._logger.warn(
          `[TerminalService] закрытие ${runtime.record.id} не удалось: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      this._finish(
        runtime,
        {
          ...(runtime.record.exitCode !== undefined ? { exitCode: runtime.record.exitCode } : {}),
          ...(runtime.record.signal !== undefined ? { signal: runtime.record.signal } : {}),
        },
        options.reason,
        options.actorId,
      );
    }
    if (options.remove && this._terminals.get(runtime.record.id) === runtime) {
      this._terminals.delete(runtime.record.id);
      this._publish(runtime, 'terminal.deleted', { reason: options.reason });
      this._syncMetrics();
    }
  }

  /** Token bucket ввода (20 кадров/с по умолчанию). */
  private _consumeToken(runtime: TerminalRuntime): void {
    const rate = this._limits.inputRatePerSecond;
    if (rate <= 0) return;
    const now = this._now();
    const elapsed = Math.max(0, now - runtime.tokensUpdatedAt);
    runtime.tokensUpdatedAt = now;
    runtime.tokens = Math.min(rate, runtime.tokens + (elapsed / 1000) * rate);
    if (runtime.tokens < 1) {
      throw new TerminalLimitError({
        scope: 'rate',
        limit: rate,
        message: `Слишком часто: не больше ${rate} кадров в секунду на терминал`,
      });
    }
    runtime.tokens -= 1;
  }

  /** Доставка фрагмента подписчику (ошибка подписчика не ломает поток). */
  private _safeData(subscriber: TerminalSubscriber, piece: TerminalOutputChunk): void {
    try {
      subscriber.handlers.onData(piece);
    } catch (err) {
      this._logger.warn(
        `[TerminalService] обработчик данных подписчика ${subscriber.id} бросил: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** Уведомление подписчика о разрыве (вытесненный вывод). */
  private _safeReset(
    subscriber: TerminalSubscriber,
    info: { droppedBytes: number; firstSeq: number },
  ): void {
    if (typeof subscriber.handlers.onReset !== 'function') return;
    try {
      subscriber.handlers.onReset(info);
    } catch (err) {
      this._logger.warn(
        `[TerminalService] обработчик сброса подписчика ${subscriber.id} бросил: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** Запись аудита (best-effort: ошибка журнала не ломает терминал). */
  private _auditRuntime(
    runtime: TerminalRuntime,
    action: 'terminal.open' | 'terminal.input' | 'terminal.close',
    extra: {
      actorId?: string;
      bytes?: number;
      enter?: boolean;
      reason?: TerminalCloseReason;
      exitCode?: number;
      signal?: string;
    },
  ): void {
    if (!this._audit) return;
    try {
      this._audit.record({
        action,
        terminalId: runtime.record.id,
        projectId: runtime.record.projectId,
        ...(runtime.record.sessionId !== undefined ? { sessionId: runtime.record.sessionId } : {}),
        ...(extra.actorId !== undefined ? { actorId: extra.actorId } : {}),
        cwd: runtime.record.cwd,
        shell: runtime.record.shell,
        ts: new Date(this._now()).toISOString(),
        ...(extra.bytes !== undefined ? { bytes: extra.bytes } : {}),
        ...(extra.enter !== undefined ? { enter: extra.enter } : {}),
        ...(extra.reason !== undefined ? { reason: extra.reason } : {}),
        ...(extra.exitCode !== undefined ? { exitCode: extra.exitCode } : {}),
        ...(extra.signal !== undefined ? { signal: extra.signal } : {}),
      });
    } catch (err) {
      this._logger.warn(
        `[TerminalService] запись аудита не удалась: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Публикация события терминала в канал сессии.
   *
   * Событие уходит **только** у терминалов с привязкой к сессии: в шине нет
   * канала проекта, а инстансный канал — broadcast всем (дизайн §4).
   */
  private _publish(
    runtime: TerminalRuntime,
    type: TerminalEventType,
    extra: Record<string, unknown> = {},
  ): void {
    const bus = this._eventBus;
    const sessionId = runtime.record.sessionId;
    if (!bus || !sessionId) return;
    const data: Record<string, unknown> = {
      terminal_id: runtime.record.id,
      project_id: runtime.record.projectId,
      status: runtime.record.status,
      cols: runtime.record.cols,
      rows: runtime.record.rows,
      ...(runtime.record.title !== undefined ? { title: runtime.record.title } : {}),
      ...extra,
    };
    // Типы событий терминала объявлены в `EventType`
    // (`packages/shared/src/types/bus-events.ts`) — каст не нужен.
    bus.publish(sessionId, type, data);
  }

  /** Синхронизировать gauge живых терминалов. */
  private _syncMetrics(): void {
    if (!this._metrics) return;
    let starting = 0;
    let running = 0;
    for (const runtime of this._terminals.values()) {
      if (runtime.record.status === 'starting') starting += 1;
      else if (runtime.record.status === 'running') running += 1;
    }
    this._metrics.syncSessions({ starting, running });
  }

  /** Запустить reaper простоявых терминалов. */
  private _startReaper(): void {
    if (this._reaperTimer !== null) return;
    this._reaperTimer = this._timers.setInterval(() => {
      void this._reap();
    }, this._limits.reaperIntervalMs);
    this._reaperTimer.unref?.();
  }

  /** Остановить reaper. */
  private _stopReaper(): void {
    if (this._reaperTimer === null) return;
    this._timers.clearInterval(this._reaperTimer);
    this._reaperTimer = null;
  }

  /**
   * Уборка простоявших терминалов.
   *
   * Терминал простаивает, если: подписчиков нет **и** он не привязан к
   * активной сессии (дизайн §10). Простой считается от `lastActivityAt`
   * (вывод/ввод/подписка). Если ход в сессии идёт — терминал не трогаем.
   *
   * Завершённые терминалы тоже убираются — иначе реестр растёт бесконечно;
   * их вывод хранится столько же, сколько живёт простаивающий терминал.
   */
  private async _reap(): Promise<void> {
    if (this._disposed) return;
    const now = this._now();
    for (const [id, runtime] of [...this._terminals.entries()]) {
      if (runtime.record.status === 'exited') {
        if (now - runtime.record.lastActivityAt >= this._limits.idleMs) {
          this._terminals.delete(id);
          this._publish(runtime, 'terminal.deleted', { reason: 'idle' });
        }
        continue;
      }
      if (runtime.subscribers.size > 0) continue;
      if (runtime.record.sessionId && this._isSessionActive) {
        let active = false;
        try {
          active = await this._isSessionActive(runtime.record.sessionId);
        } catch {
          // Не смогли проверить — считаем сессию активной (не убиваем терминал).
          active = true;
        }
        if (active) continue;
      }
      if (now - runtime.record.lastActivityAt >= this._limits.idleMs) {
        await this._closeRuntime(runtime, { reason: 'idle', remove: true });
      }
    }
  }
}

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
 *   параметры выполнения (`idleMs`/`maxPerProject`/`maxPerInstance`) меняются
 *   **live** — `setLimits` (рестарт не нужен: reaper и TTL снимков читают
 *   значение на каждом тике, создание — на каждой попытке);
 * - **выключатель инстанса**: `setEnabled(false)` закрывает все терминалы и
 *   запрещает создание (`TerminalDisabledError`);
 * - **idle-reaper**: терминал без подписчиков и без привязки к активной
 *   сессии дольше `idleMs` (по умолчанию 2 дня) закрывается; таймер `unref`;
 * - **события**: `terminal.created|updated|exited|deleted` в канал сессии
 *   (только у терминалов с привязкой — в шине нет канала проекта, дизайн §4);
 * - **аудит**: `terminal.open`/`terminal.input`/`terminal.close` — только
 *   метаданные (ADR-136); `terminal.input` пишется лишь для кадров с `Enter`
 *   и только при `setAuditInput(true)` (метрика `op="input"` считается всегда);
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
import type { BlobStore } from '../../storage/ports/blob-store.js';
import type { TerminalAuditSink, TerminalCloseReason } from './audit.js';
import type { TerminalMetricsHooks } from './metrics.js';
import { TerminalRingBuffer } from './ring-buffer.js';
import {
  buildRunMarkerCommand,
  scanRunMarkers,
  TerminalRunRegistry,
  type TerminalRunFinishedHandler,
  type TerminalRunRecord,
} from './runs.js';
import {
  deleteTerminalSnapshot,
  listTerminalSnapshotIds,
  readTerminalSnapshot,
  readTerminalSnapshotOutput,
  writeTerminalSnapshot,
} from './snapshot.js';
import {
  DEFAULT_TERMINAL_LIMITS,
  TerminalAlreadyRunningError,
  TerminalDisabledError,
  TerminalExitedError,
  TerminalInvalidRequestError,
  TerminalLimitError,
  TerminalNotFoundError,
  TerminalUnavailableError,
  type TerminalCreateInput,
  type TerminalEventType,
  type TerminalLimits,
  type TerminalListFilter,
  type TerminalLogger,
  type TerminalOutputChunk,
  type TerminalOutputSnapshot,
  type TerminalPortContext,
  type TerminalPortResolver,
  type TerminalRecord,
  type TerminalServiceOptions,
  type TerminalSubscribeOptions,
  type TerminalSubscription,
  type TerminalSubscriptionHandlers,
  type TerminalTimerHandle,
  type TerminalTimers,
} from './types.js';

/**
 * Период записи снимка живого терминала, мс (60 с).
 *
 * Снимок нужен, чтобы терминал, **переживший рестарт ядра** (процесс PTY не
 * переживает), вернулся с последним выводом. Период — компромисс между
 * свежестью снимка и объёмом записи: вывод меняется часто, а снимок пишется
 * только когда он действительно изменился.
 */
const TERMINAL_SNAPSHOT_INTERVAL_MS = 60_000;

/**
 * `ETX` (Ctrl+C) — прерывание текущей строки/команды в интерактивной оболочке.
 *
 * Кадр ввода с этим байтом означает «пользователь прервал команду»: маркер
 * завершения запуска (отдельная строка после команды) уже не выполнится,
 * поэтому активный запуск завершается сервисом (`interrupt`).
 */
const ETX = '\u0003';

/** Живой терминал: запись реестра + хэндл PTY + буфер и подписчики. */
interface TerminalRuntime {
  /** Запись реестра (единственный источник правды по метаданным). */
  record: TerminalRecord;
  /**
   * Хэндл PTY-сессии.
   *
   * **Нет** у терминала, восстановленного из снимка: процесс не запущен —
   * запись живёт только как история вывода (перезапуск поднимет новый PTY).
   */
  handle?: PtyHandle;
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
  /**
   * Хвост потока, удерживаемый между чанками: маркер завершения запуска
   * может прийти несколькими чанками (граница внутри ESC-последовательности).
   */
  markerPending: string;
  /** Счётчик изменений вывода (для снимка «вывод менялся»). */
  outputVersion: number;
  /** Значение `outputVersion` на момент последнего снимка. */
  snapshotVersion: number;
  /**
   * Незавершённая запись снимка (best-effort, fire-and-forget).
   *
   * Нужна, чтобы `delete()` дождался её: иначе запись, стартовавшая до
   * удаления, дописала бы файл **после** удаления — и удалённый терминал
   * воскрес бы после рестарта ядра.
   */
  pendingSnapshot: Promise<void> | null;
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
  private readonly _resolvePort?: TerminalPortResolver;
  private readonly _blobs?: BlobStore;
  private readonly _eventBus?: EventBus;
  private readonly _audit?: TerminalAuditSink;
  private readonly _metrics?: TerminalMetricsHooks;
  /**
   * Лимиты и тайминги сервиса.
   *
   * **Мутабельны** (`setLimits`): параметры выполнения приходят из runtime-
   * настроек инстанса (`/api/v2/settings/terminal`) и применяются live — те же
   * `idleMs` читают reaper и TTL снимков на каждом тике, `maxPerProject`/
   * `maxPerInstance` — каждая попытка создания. Неизменяемыми остаются
   * «протокольные» лимиты (`maxInputBytes`/`inputRatePerSecond`/буфер/батчинг/
   * период reaper): они не выводятся в настройки и меняются только конфигом
   * при сборке сервиса.
   */
  private _limits: TerminalLimits;
  /**
   * Оболочка по умолчанию для **новых** терминалов (`terminal.shell`).
   *
   * `null` — платформенный дефолт (`$SHELL` → `/bin/bash`). Существующие
   * терминалы не перезапускаются: у них `shell` зафиксирован в записи реестра.
   */
  private _defaultShell: string | null = null;
  /** Писать ли `terminal.input` в журнал исполнений (`terminal.auditInput`). */
  private _auditInput = true;
  private readonly _generateId: () => string;
  private readonly _now: () => number;
  private readonly _timers: TerminalTimers;
  private readonly _logger: TerminalLogger;
  private readonly _targetOverride?: TerminalRecord['target'];
  private readonly _executorId?: string;
  private readonly _isSessionActive?: (sessionId: string) => boolean | Promise<boolean>;
  private readonly _onRunFinished?: TerminalRunFinishedHandler;

  /** Живые и завершённые терминалы (id → состояние). */
  private readonly _terminals = new Map<string, TerminalRuntime>();
  /** Single-flight открытия: ключ → промис открытия. */
  private readonly _opening = new Map<string, Promise<TerminalRecord>>();
  /** Реестр запусков команд в терминалах (PROP-132, Ф5). */
  private readonly _runs: TerminalRunRegistry;
  /** Счётчик незавершённых открытий по проектам (учёт в лимитах). */
  private readonly _openingByProject = new Map<string, number>();
  /** Идентификаторы портов (для ключа single-flight: разные порты — разные терминалы). */
  private readonly _portIds = new WeakMap<object, number>();
  private _portCounter = 0;
  private _subscriberCounter = 0;
  private _enabled = true;
  private _autoRestore = true;
  private _reaperTimer: TerminalTimerHandle | null = null;
  private _snapshotTimer: TerminalTimerHandle | null = null;
  private _disposed = false;

  constructor(options: TerminalServiceOptions) {
    this._port = options.port;
    if (options.resolvePort) this._resolvePort = options.resolvePort;
    if (options.blobs) this._blobs = options.blobs;
    this._eventBus = options.eventBus;
    this._audit = options.audit;
    this._metrics = options.metrics;
    this._limits = { ...DEFAULT_TERMINAL_LIMITS, ...(options.limits ?? {}) };
    const optionShell = options.defaultShell?.trim();
    if (optionShell) this._defaultShell = optionShell;
    this._auditInput = options.auditInput ?? true;
    this._generateId = options.generateId ?? (() => randomUUID());
    this._now = options.now ?? (() => Date.now());
    this._timers = options.timers ?? DEFAULT_TIMERS;
    this._logger = options.logger ?? {
      warn: (message: string) => console.warn(message),
      error: (message: string) => console.error(message),
    };
    this._targetOverride = options.target;
    if (options.executorId !== undefined) this._executorId = options.executorId;
    this._isSessionActive = options.isSessionActive;
    if (options.onRunFinished) this._onRunFinished = options.onRunFinished;
    this._autoRestore = options.autoRestore ?? true;
    this._runs = new TerminalRunRegistry({
      now: this._now,
      generateId: this._generateId,
      timers: this._timers,
      logger: this._logger,
      onSettled: (run) => this._handleRunSettled(run),
      onKillTimeout: (terminalId) => this._killRunOnTimeout(terminalId),
    });
    this._startReaper();
    this._startSnapshotTimer();
  }

  /** Включён ли терминальный контур на инстансе. */
  isEnabled(): boolean {
    return this._enabled;
  }

  /**
   * Восстанавливаются ли терминалы из снимков (`terminal.autoRestore`).
   *
   * `false` — снимки не поднимаются при старте процесса; их убирает reaper.
   */
  isAutoRestore(): boolean {
    return this._autoRestore;
  }

  /**
   * Флаг восстановления терминалов из снимков (`terminal.autoRestore`).
   *
   * Применяется **сразу**: `false` — снимки не поднимаются при следующем
   * старте процесса (текущие файлы уберёт reaper), `true` — поднимаются.
   */
  setAutoRestore(enabled: boolean): void {
    this._autoRestore = enabled;
  }

  /**
   * Оболочка по умолчанию для **новых** терминалов (`terminal.shell`).
   *
   * `null`/пустая строка — платформенный дефолт (`$SHELL` → `/bin/bash`).
   * Применяется при следующем `create()`; **существующие терминалы не
   * перезапускаются** — их оболочка зафиксирована в записи реестра (и в снимке),
   * перезапуск поднял бы процесс с прежней оболочкой. Чтобы применить новую
   * оболочку к уже открытому терминалу, его нужно закрыть и открыть заново.
   */
  setDefaultShell(shell: string | null): void {
    const trimmed = typeof shell === 'string' ? shell.trim() : '';
    this._defaultShell = trimmed === '' ? null : trimmed;
  }

  /** Оболочка по умолчанию для новых терминалов (`null` — платформенный дефолт). */
  getDefaultShell(): string | null {
    return this._defaultShell;
  }

  /**
   * Журналировать ли ввод в терминал (`terminal.auditInput`).
   *
   * `false` — записи `terminal.input` в журнал исполнений не пишутся; аудит
   * `terminal.open`/`terminal.close` не меняется, а метрика
   * `synth_terminal_bytes_total{op="input"}` считается по-прежнему на **каждый**
   * кадр (объём ввода виден, содержимое — нет). Применяется **live**.
   */
  setAuditInput(enabled: boolean): void {
    this._auditInput = enabled;
  }

  /** Пишется ли `terminal.input` в журнал исполнений. */
  isAuditInput(): boolean {
    return this._auditInput;
  }

  /**
   * Обновить лимиты **на лету** (`/api/v2/settings/terminal`).
   *
   * Меняются только параметры выполнения: `idleMs` (простой терминала и TTL
   * снимков), `maxPerProject`, `maxPerInstance`. Значение принимается, только
   * если это **положительное целое**; иначе поле игнорируется с предупреждением
   * в лог (исключение не бросается — резолвер настроек уже нормализовал вход,
   * а падение live-применения сломало бы весь `PUT`).
   *
   * Применяется сразу: reaper и уборка снимков читают `idleMs` на каждом тике,
   * создание терминала — на каждой попытке. Уже открытые терминалы не
   * трогаются (новый, меньший лимит не закрывает существующие — он ограничивает
   * только создание).
   */
  setLimits(patch: { idleMs?: number; maxPerProject?: number; maxPerInstance?: number }): void {
    const fields = ['idleMs', 'maxPerProject', 'maxPerInstance'] as const;
    for (const field of fields) {
      const value = patch[field];
      if (value === undefined) continue;
      if (!Number.isInteger(value) || value <= 0) {
        this._logger.warn(
          `[TerminalService] лимит ${field}=${String(value)} не применён: ожидается положительное целое`,
        );
        continue;
      }
      this._limits[field] = value;
    }
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
   * - **single-flight по `(порт, cwd, shell)`**: параллельные открытия с
   *   одинаковым ключом получают **один** терминал (дизайн §10). Порт входит
   *   в ключ: терминалы разных профилей исполнения (PROP-135) — разные
   *   терминалы, даже если каталог и оболочка совпадают;
   * - **лимиты**: `maxPerProject`/`maxPerInstance` → `TerminalLimitError`.
   */
  async create(input: TerminalCreateInput): Promise<TerminalRecord> {
    this._assertUsable();

    const projectId = requireText(input.projectId, 'projectId');
    const ownerId = requireText(input.ownerId, 'ownerId');
    const cwd = requireText(input.cwd, 'cwd');
    const shell = input.shell?.trim() || this._defaultShell || defaultShell();
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

    // Порт выбирается **до** single-flight: терминал живёт на той же точке
    // исполнения, что и тулы сессии (профиль/пул по binding'у, PROP-135).
    const port = await this._resolvePortFor(base);

    if (input.id !== undefined) {
      const id = normalizeTerminalId(input.id);
      const existing = this._terminals.get(id);
      if (existing) return { ...existing.record };
      const key = `id:${id}`;
      const inflight = this._opening.get(key);
      if (inflight) return inflight;
      const promise = this._openTerminal({ ...base, id }, port);
      this._opening.set(key, promise);
      try {
        return await promise;
      } finally {
        this._opening.delete(key);
      }
    }

    const key = `key:${this._portKey(port)}\u0000${cwd}\u0000${shell}`;
    const inflight = this._opening.get(key);
    if (inflight) return inflight;
    const promise = this._openTerminal(base, port);
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
   *
   * **Аудит — только выполненные команды** (кадр с `Enter`) **и только при
   * включённом `terminal.auditInput`**: обычные кадры ввода (набор текста,
   * стрелки, Ctrl-C) — не команды, и плодить записи в журнале исполнений на
   * каждый кадр нельзя (ADR-136). Их объём считает метрика
   * `synth_terminal_bytes_total{op="input"}` — она и остаётся на **каждый**
   * кадр (в том числе при выключенном аудите ввода: объём виден, содержимого
   * нет).
   *
   * **Ctrl+C (`ETX`, `0x03`) — «пользователь прервал команду».** В
   * интерактивной оболочке Ctrl+C прерывает **строку**: строка-маркер,
   * которую сервис отправил после команды отдельной строкой, уже не
   * выполняется, её `printf` в поток не придёт. Поэтому сразу после записи
   * ETX активный запуск терминала завершается через
   * `TerminalRunRegistry.interrupt()` — статус `done`, `exitCode: 130`,
   * `stillRunning: false`: терминал свободен, уведомление уходит как обычно
   * (для фонового запуска). Иначе запуск остался бы активным навсегда и
   * любой следующий `startRun` получал бы `run_busy`.
   *
   * @throws TerminalNotFoundError — терминала нет.
   * @throws TerminalExitedError — терминал завершён (ввод невозможен).
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
    const handle = runtime.handle;
    if (!handle) {
      throw new TerminalExitedError(id);
    }
    handle.write(data);
    runtime.record.lastActivityAt = this._now();
    this._metrics?.addBytes('input', bytes);
    // Ctrl+C: команда прервана пользователем — маркер не придёт, запуск
    // завершаем сами (`done`/130), иначе терминал «залипнет» занятым.
    if (data.includes(ETX)) this._runs.interrupt(runtime.record.id);
    // Команда — кадр с `Enter`; только он попадает в журнал исполнений,
    // и только если аудит ввода включён на инстансе.
    const enter = data.includes('\n') || data.includes('\r');
    if (enter && this._auditInput) {
      this._auditRuntime(runtime, 'terminal.input', {
        ...(options.actorId !== undefined ? { actorId: options.actorId } : {}),
        bytes,
        enter: true,
      });
    }
  }

  /** Изменить размер терминала (колонки/строки). */
  resize(id: string, cols: number, rows: number): TerminalRecord {
    const runtime = this._requireLiveRuntime(id);
    const handle = runtime.handle;
    if (!handle) throw new TerminalExitedError(id);
    const nextCols = clampDimension(cols);
    const nextRows = clampDimension(rows);
    handle.resize(nextCols, nextRows);
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
   *
   * Завершённый терминал тоже переименовывается: запись есть, её видно в
   * списке с `include_exited`.
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
    // Снимок обновляется: после рестарта ядра терминал должен вернуться с
    // тем же заголовком.
    void this._writeSnapshot(runtime);
    return { ...runtime.record };
  }

  /**
   * Закрыть терминал (пользователь нажал «Закрыть»).
   *
   * PTY закрывается (`SIGTERM` → `SIGKILL` — это делает хэндл), подписчики
   * получают `onExit`, публикуются `terminal.exited` + `terminal.deleted`.
   *
   * Снимок терминала **сохраняется**, но терминал **не восстанавливается**:
   * закрытый терминал завершён (`runningAtSave: false`) — воскресают только
   * те, что были живы на момент остановки ядра. Явное удаление —
   * `delete()` — снимок убирает.
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

  /**
   * Удалить терминал **явно** (пользователь удалил вкладку).
   *
   * Отличие от `close()`: удалённый терминал не должен воскреснуть после
   * рестарта ядра — его снимок **удаляется** из blob-хранилища (PROP-132).
   */
  async delete(id: string, options: { actorId?: string } = {}): Promise<void> {
    const runtime = this._terminals.get(id);
    if (!runtime) throw new TerminalNotFoundError(id);
    await this._closeRuntime(runtime, {
      reason: 'user',
      remove: true,
      ...(options.actorId !== undefined ? { actorId: options.actorId } : {}),
    });
    // Ждём незавершённую запись снимка: иначе она дописала бы файл **после**
    // удаления — и удалённый терминал воскрес бы после рестарта ядра.
    if (runtime.pendingSnapshot) await runtime.pendingSnapshot;
    await this._deleteSnapshot(id);
  }

  /**
   * Перезапустить завершённый терминал (PROP-132).
   *
   * Поднимается **новый** PTY с теми же `cwd`/`shell`/`cols`/`rows`; id
   * терминала сохраняется, статус — `running`, признак `restored` снимается.
   * Публикуется событие `terminal.updated`.
   *
   * **История вывода сохраняется:** буфер не очищается — старый вывод
   * остаётся в нём (его можно промотать вверх), а новый вывод дописывается в
   * конец. Снимок после перезапуска содержит историю + новый вывод.
   *
   * @throws TerminalNotFoundError — терминала нет.
   * @throws TerminalAlreadyRunningError — терминал жив (перезапуск невозможен).
   */
  async restart(id: string): Promise<TerminalRecord> {
    this._assertUsable();
    const runtime = this._terminals.get(id);
    if (!runtime) throw new TerminalNotFoundError(id);
    if (!runtime.finished) throw new TerminalAlreadyRunningError(id);

    const record = runtime.record;
    const port = await this._resolvePortFor({
      projectId: record.projectId,
      ...(record.sessionId !== undefined ? { sessionId: record.sessionId } : {}),
      cwd: record.cwd,
      shell: record.shell,
    });

    const handle = await this._spawnPty(port, record);

    // Буфер **не** очищается: старый вывод остаётся историей (прокрутка
    // вверх работает), новый вывод дописывается в конец.
    runtime.finished = false;
    runtime.closeReason = undefined;
    runtime.closeActor = undefined;
    runtime.markerPending = '';
    runtime.tokens = this._limits.inputRatePerSecond;
    runtime.tokensUpdatedAt = this._now();
    runtime.handle = handle;
    runtime.outputVersion += 1;

    record.status = 'running';
    record.restored = false;
    record.exitCode = undefined;
    record.signal = undefined;
    record.lastActivityAt = this._now();

    handle.onData((chunk: string) => this._onData(runtime, chunk));
    handle.onExit((info: { exitCode?: number; signal?: string }) => {
      this._finish(runtime, info, runtime.closeReason ?? 'exited', runtime.closeActor);
    });

    this._publish(runtime, 'terminal.updated', { status: 'running', restored: false });
    this._syncMetrics();
    // Снимок перезаписан: в нём — история вывода + новый вывод.
    void this._writeSnapshot(runtime);
    return { ...record };
  }

  /**
   * Восстановить терминалы из снимков после рестарта ядра (PROP-132).
   *
   * Поднимаются **только те записи, которые были живы на момент остановки**
   * (`runningAtSave === true`) и моложе `idleMs` (2 дня от `lastActivityAt`):
   * для них реально поднимается **новый PTY** (те же `cwd`/`shell`/`cols`/
   * `rows`), статус — `running`, признак `restored: true`, а в буфер
   * предварительно заливается сохранённый хвост вывода (история остаётся
   * доступной: `output()`, `GET /:id/output`, `terminal_read`).
   *
   * Записи, завершившиеся до остановки (`runningAtSave !== true`), не
   * восстанавливаются — их снимок удаляется. Старый снимок без поля
   * `runningAtSave` = `false` (не воскресаем).
   *
   * Если PTY подняться не удалось (точка исполнения недоступна, каталог
   * пропал) — терминал остаётся `exited` + `restored: true` с сохранённым
   * выводом (в лог — предупреждение): его можно перезапустить вручную.
   *
   * Снимки старше срока удаляются. При `terminal.autoRestore === false`
   * снимки не поднимаются вовсе — их убирает reaper.
   *
   * @returns число восстановленных терминалов.
   */
  async restoreFromSnapshots(): Promise<number> {
    const blobs = this._blobs;
    if (!blobs) return 0;
    if (!this._autoRestore) return 0;

    let ids: string[];
    try {
      ids = await listTerminalSnapshotIds(blobs);
    } catch (err) {
      this._logger.warn(
        `[TerminalService] список снимков терминалов не прочитан: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return 0;
    }

    const now = this._now();
    let restored = 0;
    for (const id of ids) {
      try {
        const meta = await readTerminalSnapshot(blobs, id);
        if (!meta) {
          // Битый снимок — как отсутствующий: файл уберёт reaper.
          await deleteTerminalSnapshot(blobs, id);
          continue;
        }
        if (now - meta.record.lastActivityAt >= this._limits.idleMs) {
          await deleteTerminalSnapshot(blobs, id);
          continue;
        }
        if (this._terminals.has(id)) continue;
        // Воскресают только терминалы, **живые на момент остановки**:
        // завершившийся до остановки терминал не поднимается, его снимок
        // убирается (старый снимок без поля = `false` — тоже).
        if (meta.runningAtSave !== true) {
          await deleteTerminalSnapshot(blobs, id);
          continue;
        }

        const output = await readTerminalSnapshotOutput(blobs, id);
        const buffer = this._newBuffer();
        if (output !== '') buffer.append(output);

        const record: TerminalRecord = {
          ...meta.record,
          status: 'starting',
          restored: true,
        };
        const runtime: TerminalRuntime = {
          record,
          buffer,
          subscribers: new Map(),
          pending: [],
          pendingBytes: 0,
          flushTimer: null,
          tokens: this._limits.inputRatePerSecond,
          tokensUpdatedAt: now,
          finished: false,
          markerPending: '',
          outputVersion: 0,
          snapshotVersion: 0,
          pendingSnapshot: null,
        };
        this._terminals.set(id, runtime);
        restored += 1;

        // «Восстановление» = **запуск процесса**: поднимаем новый PTY.
        const opened = await this._restorePty(runtime);
        if (!opened) {
          // Процесс не поднялся — терминал остаётся завершённым, но с
          // сохранённым выводом: его можно перезапустить вручную.
          runtime.finished = true;
          record.status = 'exited';
          continue;
        }
        record.status = 'running';
      } catch (err) {
        this._logger.warn(
          `[TerminalService] восстановление терминала ${id} не удалось: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    this._syncMetrics();
    return restored;
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

  // ---------------------------------------------------------------------------
  // Запуски команд (PROP-132, Ф5)
  // ---------------------------------------------------------------------------

  /**
   * Запустить команду в терминале и зарегистрировать запуск.
   *
   * Команда уходит в оболочку терминала, после неё — **невидимый** маркер
   * завершения (OSC 7770): по нему сервис узнаёт, что команда закончилась, и
   * забирает код возврата. Маркер вырезается из потока (и из буфера), в
   * вывод модели не попадает.
   *
   * **Строки уходят с `\r`, а не с `\n`:** терминал работает в raw-режиме, и
   * `Enter` там — это CR (`tmux`/`less`/REPL ждут именно `\r`; LF не
   * подтверждает ввод).
   *
   * Ожидания завершения здесь нет — вызывающий ждёт сам (`waitRun`) или
   * забирает результат позже (`getRun`).
   *
   * @throws TerminalNotFoundError — терминала нет.
   * @throws TerminalExitedError — терминал завершён (ввод/запуск невозможны).
   * @throws TerminalRunBusyError — в терминале уже идёт запуск.
   */
  startRun(input: {
    terminalId: string;
    command: string;
    timeoutMs: number;
    /** Фоновый запуск: завершение доставляется уведомлением в сессию. */
    background?: boolean;
    /** По истечении watchdog'а убить команду (Ctrl+C) и освободить терминал. */
    killOnTimeout?: boolean;
    actorId?: string;
  }): TerminalRunRecord {
    this._assertUsable();
    const runtime = this._requireLiveRuntime(input.terminalId);
    const command = input.command.replace(/[\r\n]+$/, '');
    const run = this._runs.start({
      terminalId: runtime.record.id,
      ...(runtime.record.sessionId !== undefined ? { sessionId: runtime.record.sessionId } : {}),
      command,
      timeoutMs: input.timeoutMs,
      ...(input.background !== undefined ? { background: input.background } : {}),
      ...(input.killOnTimeout !== undefined ? { killOnTimeout: input.killOnTimeout } : {}),
    });
    // Строка-обёртка: реестр строит её из своего nonce и хранит в записи
    // запуска — по ней из вывода снимается эхо служебной строки.
    const markerCommand = run.wrapperCommand ?? buildRunMarkerCommand(run.nonce);
    try {
      // Enter в raw-режиме терминала — это CR, а не LF.
      this.write(runtime.record.id, `${command}\r`, {
        ...(input.actorId !== undefined ? { actorId: input.actorId } : {}),
      });
      this.write(runtime.record.id, `${markerCommand}\r`, {
        ...(input.actorId !== undefined ? { actorId: input.actorId } : {}),
      });
    } catch (err) {
      // Команда не ушла — запуск отменяем (иначе терминал остался бы «занятым»).
      this._runs.cancel(run.runId);
      throw err;
    }
    return run;
  }

  /** Снимок запуска (копия) или `null`, если запуска нет. */
  getRun(runId: string): TerminalRunRecord | null {
    return this._runs.get(runId);
  }

  /**
   * Дождаться завершения запуска.
   *
   * Возвращает актуальный снимок: если срок ожидания истёк, а запуск ещё
   * идёт — снимок со статусом `running` (не `null`).
   */
  async waitRun(runId: string, timeoutMs: number): Promise<TerminalRunRecord | null> {
    return this._runs.wait(runId, timeoutMs);
  }

  /**
   * Отменить запуск (статус `exited` — запуск больше не отслеживается).
   *
   * @returns `true`, если запуск был активен.
   */
  cancelRun(runId: string): boolean {
    return this._runs.cancel(runId);
  }

  /**
   * Прервать активный запуск терминала сигналом из `terminal_signal`.
   *
   * Байт сигнала пишет вызывающий (`write`), а запуск завершается здесь:
   * после `^C`/`^\`/`^Z` строка-маркер запуска уже не выполняется, и без
   * этого метода терминал остался бы занятым навсегда (`run_busy`).
   * Запуск получает статус `done` и код `exitCode` (по умолчанию `130` —
   * `128+SIGINT`), `stillRunning: false`: терминал свободен.
   *
   * @returns `true`, если активный запуск был и завершён.
   */
  interruptRun(terminalId: string, exitCode = 130): boolean {
    return this._runs.interrupt(terminalId, exitCode);
  }

  /**
   * Запуск завершён — зовём колбэк точки сборки (уведомление сессии).
   *
   * **Только для фоновых запусков** (`run.background === true`): у режима с
   * ожиданием ответ модели уже ушёл инлайн (`terminal_run`), и уведомление
   * было бы дублем одного и того же результата в контексте.
   *
   * Ошибка колбэка не ломает терминал: результат уже в реестре, а уведомление
   * — best-effort (как уведомление о фоновом процессе).
   */
  private _handleRunSettled(run: TerminalRunRecord): void {
    if (run.background !== true) return;
    const handler = this._onRunFinished;
    if (!handler) return;
    const runtime = this._terminals.get(run.terminalId);
    const terminal = runtime ? { ...runtime.record } : null;
    try {
      const result = handler(run, terminal);
      if (result && typeof (result as Promise<void>).then === 'function') {
        void (result as Promise<void>).catch((err: unknown) => {
          this._logger.warn(
            `[TerminalService] уведомление о завершении запуска ${run.runId} не удалось: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        });
      }
    } catch (err) {
      this._logger.warn(
        `[TerminalService] уведомление о завершении запуска ${run.runId} не удалось: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Watchdog запуска с убийством команды (`killOnTimeout`): пишем `ETX` (Ctrl+C).
   *
   * Пишем **напрямую в хэндл**, без повторного прохода через `write()`:
   * служебный байт не должен зависеть от политики ввода (кап кадра, token
   * bucket), а аудит `terminal.input` не должен фиксировать не-пользовательский
   * кадр. Запуск завершит реестр (`timeout` + `stillRunning: false`).
   */
  private _killRunOnTimeout(terminalId: string): void {
    const runtime = this._terminals.get(terminalId);
    const handle = runtime?.handle;
    if (!runtime || !handle) {
      this._logger.warn(
        `[TerminalService] таймаут запуска: PTY терминала ${terminalId} уже закрыт — прерывать нечего`,
      );
      return;
    }
    try {
      handle.write(ETX);
      runtime.record.lastActivityAt = this._now();
      this._metrics?.addBytes('input', Buffer.byteLength(ETX, 'utf8'));
      this._logger.warn(
        `[TerminalService] таймаут запуска в терминале ${terminalId}: команда прервана (Ctrl+C)`,
      );
    } catch (err) {
      this._logger.warn(
        `[TerminalService] не удалось прервать команду в терминале ${terminalId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
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

  /**
   * Остановить сервис: закрыть терминалы, снять таймеры.
   *
   * Перед остановкой пишутся снимки **живых** терминалов: после рестарта
   * ядра они вернутся — с новым PTY и последним выводом (PROP-132). Запись —
   * best-effort (fire-and-forget): периодический снимок (60 с) обычно уже
   * свежий.
   *
   * **Порядок важен:** снимок пишется **до** закрытия PTY — иначе все
   * терминалы оказались бы `exited` (`runningAtSave: false`) и не
   * восстановились бы. Поэтому выход PTY (который зовёт `_finish`) не
   * перезаписывает снимок остановки.
   */
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this._stopReaper();
    this._stopSnapshotTimer();
    this._runs.dispose();
    for (const runtime of [...this._terminals.values()]) {
      // Снимок — состояние **до** закрытия PTY (`runningAtSave: true`).
      // Завершённые терминалы снимок уже получили при выходе.
      if (!runtime.finished) void this._writeSnapshot(runtime);
      try {
        const closing = runtime.handle?.close({ signal: 'SIGTERM' });
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

  /**
   * Живой терминал (иначе — `TerminalNotFoundError`/`TerminalExitedError`).
   *
   * Завершённый терминал — **не «не найден»**: запись есть, её видно и можно
   * перезапустить. Поэтому ввод/размер/запуск в него дают
   * `TerminalExitedError` (роут мапит его в `409 TERMINAL_EXITED`).
   */
  private _requireLiveRuntime(id: string): TerminalRuntime {
    const runtime = this._terminals.get(id);
    if (!runtime) throw new TerminalNotFoundError(id);
    if (runtime.finished) throw new TerminalExitedError(id);
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

  /** Новый кольцевой буфер вывода (ёмкость/сегмент — из лимитов сервиса). */
  private _newBuffer(): TerminalRingBuffer {
    return new TerminalRingBuffer({
      maxBytes: this._limits.ringBufferBytes,
      segmentBytes: this._limits.ringSegmentBytes,
    });
  }

  /**
   * Порт исполнения для терминала (PROP-135).
   *
   * Задан `resolvePort` — порт выбирает **тот же** роутер, что и тулы сессии
   * (профиль по binding'у + область пула + `workspaceSubPath`). Ошибка
   * выбора — fail-closed (`TerminalUnavailableError` → 503): молча уйти на
   * инстансный порт означало бы выполнить терминал не там, куда его направили.
   */
  private async _resolvePortFor(ctx: TerminalPortContext): Promise<ExecutionPort> {
    const resolver = this._resolvePort;
    if (!resolver) return this._port;
    try {
      return await resolver(ctx);
    } catch (err) {
      throw new TerminalUnavailableError(
        'port_unavailable',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /**
   * Ключ порта для single-flight (разные порты — разные терминалы).
   *
   * Порт — объект; идентификатор выдаётся по **экземпляру** (`WeakMap`):
   * роутер отдаёт один и тот же экземпляр порта для одной области/профиля,
   * поэтому терминалы одного пула делятся, а разных — нет.
   */
  private _portKey(port: ExecutionPort): string {
    const key = port as unknown as object;
    let id = this._portIds.get(key);
    if (id === undefined) {
      id = ++this._portCounter;
      this._portIds.set(key, id);
    }
    return String(id);
  }

  /**
   * Точка исполнения терминала: явный override — иначе по порту
   * (`isRemote` → исполнитель, иначе — процесс control plane).
   */
  private _targetFor(port: ExecutionPort): TerminalRecord['target'] {
    return this._targetOverride ?? (port.isRemote ? 'executor' : 'inline');
  }

  /**
   * Открыть PTY для записи реестра (перезапуск/восстановление).
   *
   * Те же параметры, что и при создании: `cwd`/`shell`/`cols`/`rows`.
   */
  private async _spawnPty(port: ExecutionPort, record: TerminalRecord): Promise<PtyHandle> {
    const openPty = port.openPty;
    if (!openPty || port.pty === false) {
      throw new TerminalUnavailableError(
        'pty_unsupported',
        'Исполнение в этой среде не поддерживает PTY',
      );
    }
    try {
      return await openPty.call(port, {
        cwd: record.cwd,
        shell: record.shell,
        cols: record.cols,
        rows: record.rows,
      });
    } catch (err) {
      if (isExecutionError(err)) throw err;
      throw new TerminalUnavailableError(
        'spawn_failed',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /**
   * Поднять PTY восстановленного терминала (PROP-132).
   *
   * `false` — процесс не запустился (точка исполнения недоступна, каталог
   * пропал, PTY не поддерживается): терминал остаётся `exited` с
   * сохранённым выводом, в лог — предупреждение (восстановление не должно
   * ронять старт процесса).
   */
  private async _restorePty(runtime: TerminalRuntime): Promise<boolean> {
    const record = runtime.record;
    try {
      const port = await this._resolvePortFor({
        projectId: record.projectId,
        ...(record.sessionId !== undefined ? { sessionId: record.sessionId } : {}),
        cwd: record.cwd,
        shell: record.shell,
      });
      const handle = await this._spawnPty(port, record);
      runtime.handle = handle;
      handle.onData((chunk: string) => this._onData(runtime, chunk));
      handle.onExit((info: { exitCode?: number; signal?: string }) => {
        this._finish(runtime, info, runtime.closeReason ?? 'exited', runtime.closeActor);
      });
      return true;
    } catch (err) {
      this._logger.warn(
        `[TerminalService] терминал ${record.id} не восстановлен: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return false;
    }
  }

  /**
   * Записать снимок терминала (метаданные + хвост вывода).
   *
   * Ошибка записи — предупреждение в лог: снимок best-effort, его отсутствие
   * не ломает работу терминала (как лог фонового процесса, ADR-113).
   */
  private async _writeSnapshot(runtime: TerminalRuntime): Promise<void> {
    const blobs = this._blobs;
    if (!blobs) return;
    const output = runtime.buffer.snapshot().chunks.map((chunk) => chunk.data).join('');
    const promise = (async (): Promise<void> => {
      try {
        // `runningAtSave` — терминал был жив в момент записи: только такие
        // терминалы восстанавливаются после рестарта ядра.
        await writeTerminalSnapshot(
          blobs,
          runtime.record,
          output,
          this._now(),
          !runtime.finished,
        );
        runtime.snapshotVersion = runtime.outputVersion;
      } catch (err) {
        this._logger.warn(
          `[TerminalService] снимок терминала ${runtime.record.id} не записан: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    })();
    // Промис запоминается **синхронно** (тело до первого `await` выполняется
    // сразу) — `delete()` дождётся его перед удалением файла.
    runtime.pendingSnapshot = promise;
    await promise;
  }

  /** Удалить снимок терминала (явное удаление терминала). */
  private async _deleteSnapshot(id: string): Promise<void> {
    const blobs = this._blobs;
    if (!blobs) return;
    try {
      await deleteTerminalSnapshot(blobs, id);
    } catch (err) {
      this._logger.warn(
        `[TerminalService] снимок терминала ${id} не удалён: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** Открыть PTY и зарегистрировать терминал. */
  private async _openTerminal(
    params: {
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
    },
    port: ExecutionPort,
  ): Promise<TerminalRecord> {
    this._assertLimits(params.projectId);
    const openPty = port.openPty;
    if (!openPty || port.pty === false) {
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
      target: this._targetFor(port),
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
      handle = await openPty.call(port, {
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
      buffer: this._newBuffer(),
      subscribers: new Map(),
      pending: [],
      pendingBytes: 0,
      flushTimer: null,
      tokens: this._limits.inputRatePerSecond,
      tokensUpdatedAt: now,
      finished: false,
      markerPending: '',
      outputVersion: 0,
      snapshotVersion: 0,
      pendingSnapshot: null,
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

  /** Вывод от PTY: маркеры запусков вырезаются, остальное — в буфер + очередь. */
  private _onData(runtime: TerminalRuntime, chunk: string): void {
    if (runtime.finished || chunk === '') return;
    // Невидимые маркеры завершения запуска (OSC 7770) в буфер и в вывод
    // модели не попадают: вырезаем их до записи в кольцевой буфер.
    const scan = scanRunMarkers(chunk, runtime.markerPending);
    runtime.markerPending = scan.pending;
    const text = scan.parts
      .filter((part): part is { kind: 'text'; text: string } => part.kind === 'text')
      .map((part) => part.text)
      .join('');
    // Запуски: текст до маркера — в вывод запуска, маркер — его завершение.
    this._runs.handleData(runtime.record.id, scan.parts);
    if (text === '') return;
    const pieces = runtime.buffer.append(text);
    if (pieces.length === 0) return;
    runtime.record.lastActivityAt = this._now();
    // Вывод изменился — следующий периодический снимок это увидит.
    runtime.outputVersion += 1;
    this._metrics?.addBytes('output', Buffer.byteLength(text, 'utf8'));
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
    // Активный запуск команды в этом терминале завершается статусом
    // `closed`: команда не доиграла — терминала больше нет.
    this._runs.closeTerminal(runtime.record.id);
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
    // Снимок терминала: терминал завершился — после рестарта ядра он не
    // воскресает (`runningAtSave: false`), но его вывод остаётся доступен.
    //
    // Во время остановки сервиса снимок уже записан (состояние **до** закрытия
    // PTY) — перезаписывать его состоянием «exited» нельзя: живой терминал
    // должен восстановиться после рестарта ядра.
    if (!this._disposed) void this._writeSnapshot(runtime);
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
      // Статус — **синхронно**, до `await`: закрытие PTY занимает время
      // (`SIGTERM` → `SIGKILL`), и до выхода оболочки запись иначе отдавалась
      // бы как `running` (гонка «disable → list → enable»). `_finish` поставит
      // терминальный `exited`.
      runtime.record.status = 'closing';
      runtime.record.lastActivityAt = this._now();
      this._publish(runtime, 'terminal.updated', { status: 'closing' });
      this._syncMetrics();
      try {
        await runtime.handle?.close({ signal: 'SIGTERM' });
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

  /** Запустить таймер периодического снимка живых терминалов (60 с). */
  private _startSnapshotTimer(): void {
    if (this._snapshotTimer !== null) return;
    if (!this._blobs) return;
    this._snapshotTimer = this._timers.setInterval(() => {
      void this._snapshotChanged();
    }, TERMINAL_SNAPSHOT_INTERVAL_MS);
    this._snapshotTimer.unref?.();
  }

  /** Остановить таймер периодического снимка. */
  private _stopSnapshotTimer(): void {
    if (this._snapshotTimer === null) return;
    this._timers.clearInterval(this._snapshotTimer);
    this._snapshotTimer = null;
  }

  /**
   * Периодический снимок: пишутся терминалы, у которых **изменился вывод**
   * (завершённые уже записаны в `_finish`).
   */
  private async _snapshotChanged(): Promise<void> {
    if (this._disposed) return;
    for (const runtime of [...this._terminals.values()]) {
      if (runtime.finished) continue;
      if (runtime.outputVersion === runtime.snapshotVersion) continue;
      await this._writeSnapshot(runtime);
    }
  }

  /**
   * Уборка снимков терминалов.
   *
   * - `terminal.autoRestore === false` — снимки не поднимаются, файлы не нужны:
   *   удаляются все;
   * - снимок старше `idleMs` (2 дня от `lastActivityAt`) — терминал не
   *   восстановится: файл удаляется;
   * - битый снимок (нечитаемый `meta.json`) — удаляется.
   */
  private async _purgeSnapshots(): Promise<void> {
    const blobs = this._blobs;
    if (!blobs) return;
    let ids: string[];
    try {
      ids = await listTerminalSnapshotIds(blobs);
    } catch (err) {
      this._logger.warn(
        `[TerminalService] список снимков терминалов не прочитан: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }
    const now = this._now();
    for (const id of ids) {
      try {
        if (!this._autoRestore) {
          await deleteTerminalSnapshot(blobs, id);
          continue;
        }
        const meta = await readTerminalSnapshot(blobs, id);
        if (!meta || now - meta.record.lastActivityAt >= this._limits.idleMs) {
          await deleteTerminalSnapshot(blobs, id);
        }
      } catch (err) {
        this._logger.warn(
          `[TerminalService] уборка снимка терминала ${id} не удалась: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
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
   *
   * Заодно убираются снимки терминалов: старые (старше `idleMs`) и те, что
   * не нужны при `terminal.autoRestore === false`.
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
    await this._purgeSnapshots();
  }
}

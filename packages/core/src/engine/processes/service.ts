/**
 * Сервис фоновых шелл-процессов (PROP-097, блок 5b).
 *
 * Назначение — дать тулу `execute_shell` режим `background: true`: команда
 * стартует и **не блокирует ход**, её вывод пишется в лог (blob-хранилище),
 * а по завершении приходит событие и уведомление в сессию-владельца.
 *
 * Слои:
 * - **запуск** — только через порт исполнения (`ExecutionPort.spawnBackground`,
 *   ADR-077): сервис не знает, где именно живёт процесс (в процессе control
 *   plane или у исполнителя);
 * - **учёт** — единый реестр фоновых прогонов (`BackgroundRunService`,
 *   `kind: 'process'`): тот же реестр, что и у фоновых саб-агентов (PROP-096);
 * - **лог** — blob-хранилище (ADR-096), путь `processes/<runId>.log`.
 *
 * Инварианты:
 * 1. **Лог не роняет процесс**: ошибка записи — предупреждение в лог, процесс
 *    продолжает работать;
 * 2. **Лог ограничен** (`background.logMaxBytes`): по превышении запись
 *    прекращается, в записи реестра ставится `metadata.truncated`;
 * 3. **Один переход состояния** — терминальный статус процесса ставит
 *    `BackgroundRunService.finish` (идемпотентно);
 * 4. **Уведомление родителя** — сообщение роли USER с автором `Process`
 *    (тот же колбэк `onNotifyParent`, что у фоновых саб-агентов).
 * 5. **Остановка видна сразу**: успешный `stop` публикует `process.stopped`
 *    (один раз на прогон); терминальный статус приходит позже — `process.exited`.
 */
import type { BackgroundRunRecord, BackgroundRunStatus } from '@itphx/synth-shared';
import {
  EXECUTION_BACKGROUND_UNSUPPORTED_CODE,
  isExecutionError,
  type ExecBackgroundChunk,
  type ExecBackgroundProcess,
  type ExecutionPort,
} from '../../execution/ports/index.js';
import type { EventBus } from '../../events/bus.js';
import type { BlobStore } from '../../storage/ports/blob-store.js';
import { processStreamLogPath } from '../background/service.js';
import type { BackgroundRunService } from '../background/service.js';
import { toolRuntimeRequires } from '../tools/runtime-deps.js';
import {
  BackgroundUnsupportedError,
  PROCESS_LOG_FLUSH_BYTES,
  PROCESS_LOG_FLUSH_INTERVAL_MS,
  PROCESS_LOG_TAIL_LIMIT,
  type ProcessAdoptInput,
  type ProcessLogsOptions,
  type ProcessLogsResult,
  type ProcessLogger,
  type ProcessServiceOptions,
  type ProcessSpawnInput,
  type ProcessSpawnResult,
} from './types.js';

/** Пауза между «мягким» и «жёстким» убийством процесса (SIGTERM → SIGKILL). */
const KILL_GRACE_MS = 5_000;

/**
 * Предел ожидания закрытия потока вывода после завершения процесса, мс.
 *
 * Поток закрывается вместе с процессом (контракт порта), но порт, который этого
 * не сделал, не должен подвесить запись реестра в `running` навсегда.
 */
const OUTPUT_DRAIN_TIMEOUT_MS = 2_000;

/** Живой фоновый процесс (в памяти процесса — хэндлы отмены). */
interface LiveProcess {
  /** Хэндл порта исполнения. */
  proc: ExecBackgroundProcess;
  /** Писатель лога. */
  writer: ProcessLogWriter;
  /** Таймер эскалации до SIGKILL. */
  killTimer?: NodeJS.Timeout;
  /** Сессия-владелец (канал события `process.stopped`). */
  sessionId: string;
  /** Идентификатор процесса (в событии — `process_id`). */
  processId: string;
  /** Событие `process.stopped` уже опубликовано (один раз на прогон). */
  stopPublished?: boolean;
}

/**
 * Одна запись лога: путь в blob-хранилище, **свой** предел размера и свой
 * признак усечения.
 *
 * Предел (`background.logMaxBytes`) применяется к каждому файлу отдельно:
 * переполнение одного файла не мешает писать остальные.
 */
class ProcessLogFile {
  private readonly _blobs: BlobStore;
  private readonly _path: string;
  private readonly _maxBytes: number;
  /** Сколько байт уже записано в файл. */
  private _bytes = 0;
  /** Файл усечён по пределу размера. */
  private _truncated = false;

  constructor(blobs: BlobStore, path: string, maxBytes: number) {
    this._blobs = blobs;
    this._path = path;
    this._maxBytes = maxBytes;
  }

  /** Файл усечён по пределу размера. */
  get truncated(): boolean {
    return this._truncated;
  }

  /** Сколько байт записано в файл. */
  get bytesWritten(): number {
    return this._bytes;
  }

  /**
   * Дописать текст в файл (с учётом предела).
   *
   * Возвращает фактически записанные байты (пусто — писать уже нечего:
   * файл усечён). Ошибка записи **не роняет процесс** — вызывающий
   * превращает её в предупреждение в лог.
   */
  async append(text: string): Promise<Buffer> {
    if (!text || this._truncated) return Buffer.alloc(0);
    const buf = Buffer.from(text, 'utf-8');
    let payload = buf;
    if (this._maxBytes > 0) {
      const room = this._maxBytes - this._bytes;
      if (room <= 0) {
        this._truncated = true;
        return Buffer.alloc(0);
      }
      if (payload.length > room) {
        payload = payload.subarray(0, room);
        this._truncated = true;
      }
    }
    await this._blobs.append(this._path, payload);
    this._bytes += payload.length;
    return payload;
  }
}

/**
 * Буфер записи лога фонового процесса.
 *
 * Куски вывода копятся в буфере и пишутся в blob **пачками**: при 64 КиБ
 * (быстрый вывод не копится в памяти) либо раз в 200 мс (редкий вывод не
 * ждёт накопления). Записи сериализованы цепочкой промисов — порядок вывода
 * сохраняется.
 *
 * Пишутся **три** файла: общий лог (`combined`) — в порядке прихода чанков,
 * и файлы потоков (`stdout`/`stderr`) — только свой поток. У каждого файла
 * свой предел размера и свой признак усечения.
 *
 * Ошибка записи **не роняет процесс**: она — предупреждение в лог.
 */
class ProcessLogWriter {
  private readonly _combined: ProcessLogFile;
  private readonly _stdout: ProcessLogFile;
  private readonly _stderr: ProcessLogFile;
  private readonly _logger: ProcessLogger;
  /** Накопленный, ещё не записанный текст (общий лог). */
  private _pending = '';
  /** Накопленный, ещё не записанный текст потоков. */
  private _pendingStreams: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' };
  /** Хвост записанного текста (для уведомления родителя). */
  private _tail = '';
  /** Таймер интервального флаша. */
  private _timer: NodeJS.Timeout | null = null;
  /** Цепочка записей (порядок вывода сохраняется). */
  private _chain: Promise<void> = Promise.resolve();

  constructor(
    blobs: BlobStore,
    combinedPath: string,
    stdoutPath: string,
    stderrPath: string,
    maxBytes: number,
    logger: ProcessLogger,
  ) {
    this._combined = new ProcessLogFile(blobs, combinedPath, maxBytes);
    this._stdout = new ProcessLogFile(blobs, stdoutPath, maxBytes);
    this._stderr = new ProcessLogFile(blobs, stderrPath, maxBytes);
    this._logger = logger;
  }

  /** Общий лог усечён по пределу размера. */
  get truncated(): boolean {
    return this._combined.truncated;
  }

  /** Сколько байт записано в общий лог. */
  get bytesWritten(): number {
    return this._combined.bytesWritten;
  }

  /** Лог потока усечён по пределу размера. */
  streamTruncated(stream: 'stdout' | 'stderr'): boolean {
    return this._file(stream).truncated;
  }

  /** Хвост записанного текста (≤ `PROCESS_LOG_TAIL_LIMIT` символов). */
  tail(): string {
    return this._tail;
  }

  /**
   * Принять кусок вывода процесса.
   *
   * `stream` — поток куска: текст пишется и в общий лог (в порядке прихода),
   * и в файл своего потока. Переполнение предела одного файла не мешает
   * писать остальные.
   */
  push(stream: 'stdout' | 'stderr', data: string): void {
    if (!data) return;
    if (!this._combined.truncated) this._pending += data;
    const file = this._file(stream);
    if (!file.truncated) this._pendingStreams[stream] += data;
    if (this._pendingBytes() >= PROCESS_LOG_FLUSH_BYTES) {
      void this.flush();
      return;
    }
    this._scheduleFlush();
  }

  /** Записать накопленное в blob (ошибка записи — только предупреждение). */
  flush(): Promise<void> {
    const combinedText = this._pending;
    this._pending = '';
    const stdoutText = this._pendingStreams.stdout;
    const stderrText = this._pendingStreams.stderr;
    this._pendingStreams.stdout = '';
    this._pendingStreams.stderr = '';
    if (!combinedText && !stdoutText && !stderrText) return this._chain;
    this._chain = this._chain.then(async () => {
      const written = await this._append(this._combined, combinedText);
      if (written.length > 0) {
        this._tail = (this._tail + written.toString('utf-8')).slice(-PROCESS_LOG_TAIL_LIMIT);
      }
      await this._append(this._stdout, stdoutText);
      await this._append(this._stderr, stderrText);
    });
    return this._chain;
  }

  /** Запланировать интервальный флаш (таймер `unref`). */
  private _scheduleFlush(): void {
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      void this.flush();
    }, PROCESS_LOG_FLUSH_INTERVAL_MS);
    this._timer.unref?.();
  }

  /** Файл потока по имени. */
  private _file(stream: 'stdout' | 'stderr'): ProcessLogFile {
    return stream === 'stdout' ? this._stdout : this._stderr;
  }

  /** Сколько байт ждёт записи (общий лог + потоки). */
  private _pendingBytes(): number {
    return (
      Buffer.byteLength(this._pending, 'utf-8') +
      Buffer.byteLength(this._pendingStreams.stdout, 'utf-8') +
      Buffer.byteLength(this._pendingStreams.stderr, 'utf-8')
    );
  }

  /** Запись в файл: ошибка — предупреждение, процесс продолжает работать. */
  private async _append(file: ProcessLogFile, text: string): Promise<Buffer> {
    if (!text) return Buffer.alloc(0);
    try {
      return await file.append(text);
    } catch (err) {
      this._logger.warn?.(
        `[ProcessService] запись лога процесса не удалась: ${err instanceof Error ? err.message : String(err)}`,
      );
      return Buffer.alloc(0);
    }
  }
}

export class ProcessService {
  private readonly _port: ExecutionPort;
  private readonly _background: BackgroundRunService;
  private readonly _blobs: BlobStore;
  private readonly _eventBus: EventBus;
  private readonly _limits: { maxLogBytes: number };
  private readonly _logger: ProcessLogger;
  /** Хук терминального перехода (ADR-136/ADR-126 §5) — парная запись аудита. */
  private readonly _onFinished?: ProcessServiceOptions['onFinished'];
  /** Живые процессы: `runId` → хэндл. */
  private readonly _live = new Map<string, LiveProcess>();

  constructor(options: ProcessServiceOptions) {
    this._port = options.executionPort;
    this._background = options.background;
    this._blobs = options.blobs;
    this._eventBus = options.eventBus;
    this._limits = { maxLogBytes: options.limits.maxLogBytes };
    this._logger = options.logger ?? {
      warn: (message: string) => console.warn(message),
      error: (message: string) => console.error(message),
    };
    this._onFinished = options.onFinished;
  }

  /**
   * Запустить шелл-команду в фоне.
   *
   * Порядок: проверка поддержки фонового режима портом → запуск у порта →
   * регистрация в реестре фоновых прогонов (лимиты) → запись лога → хэндл
   * отмены.
   *
   * @throws BackgroundUnsupportedError — порт не умеет фоновый запуск
   *   (в `remote`-режиме — исполнитель старой версии, протокол < 3).
   * @throws BackgroundLimitExceededError — лимит процессов сессии исчерпан
   *   (запущенный процесс при этом останавливается).
   */
  async spawn(input: ProcessSpawnInput): Promise<ProcessSpawnResult> {
    const spawnBackground = this._port.spawnBackground?.bind(this._port);
    if (!spawnBackground) {
      throw new BackgroundUnsupportedError(
        'Фоновое исполнение недоступно в текущем режиме исполнения (порт не поддерживает фоновый запуск)',
      );
    }

    let proc: ExecBackgroundProcess;
    try {
      proc = await spawnBackground({
        // PROP-124 Ф4a: argv-команда — прямой запуск бинарника **без**
        // локальной оболочки (значения аргументов не проходят через shell).
        // Shell-форма — прежнее поведение `execute_shell`.
        command: input.argv
          ? { kind: 'argv', file: input.argv.file, args: [...input.argv.args] }
          : { kind: 'shell', command: input.command ?? '', shell: 'bash' },
        cwd: input.cwd,
        ...(input.env ? { env: input.env } : {}),
        // Фоновый процесс по умолчанию **без таймаута**: он переживает ход агента.
        timeoutMs: input.timeoutMs ?? 0,
        // Бинарное требование тула (`bash`) — как у синхронного запуска (ADR-077).
        // Для argv-команды — свой бинарник (`ssh` у адресного ssh-тула).
        requires: input.requires ?? toolRuntimeRequires('execute_shell'),
        // Секреты вызова (PROP-124 §7) — материал на время жизни процесса;
        // в запись реестра и в лог они не попадают.
        ...(input.secrets && input.secrets.length > 0 ? { secrets: input.secrets } : {}),
      });
    } catch (err) {
      // Удалённый исполнитель старой версии (протокол < 3) фоновых процессов
      // не знает — для модели это то же «фон недоступен», а не «сбой запуска».
      // Проверка типа — структурная (`isExecutionError`): ошибка приходит из
      // другой копии модуля core (`dist`), где `instanceof` не срабатывает.
      if (
        isExecutionError(err) &&
        err.code === EXECUTION_BACKGROUND_UNSUPPORTED_CODE
      ) {
        throw new BackgroundUnsupportedError(err.message);
      }
      throw err;
    }

    let record: BackgroundRunRecord;
    try {
      // ADR-126 §5: `origin`/`metadata` — в запись реестра (аддитивно).
      // `origin` идёт последним: он важнее пользовательских метаданных.
      const metadata = {
        ...(input.metadata ?? {}),
        ...(input.origin ? { origin: input.origin } : {}),
      };
      record = await this._background.startProcess({
        sessionId: input.sessionId,
        ...(input.projectId ? { projectId: input.projectId } : {}),
        // В реестр идёт **одна строка** команды: для argv — склейка
        // «бинарник + аргументы» (только для показа в UI; перезапуска по
        // этой строке не происходит — процесс уже запущен).
        command: input.argv ? formatArgvCommand(input.argv) : (input.command ?? ''),
        cwd: input.cwd,
        ...(proc.pid !== undefined ? { pid: proc.pid } : {}),
        processId: proc.processId,
        ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
      });
    } catch (err) {
      // Реестр отказал (лимит) — уже запущенный процесс останавливаем.
      try {
        proc.stop('SIGTERM');
      } catch {
        // процесс уже завершён — не страшно
      }
      void this._drain(proc.output);
      throw err;
    }

    const logPath = record.logPath ?? '';
    const writer = new ProcessLogWriter(
      this._blobs,
      logPath,
      processStreamLogPath(record.id, 'stdout'),
      processStreamLogPath(record.id, 'stderr'),
      this._limits.maxLogBytes,
      this._logger,
    );
    this._track(record, proc, proc.output, writer);

    return {
      runId: record.id,
      processId: proc.processId,
      logPath,
      ...(proc.pid !== undefined ? { pid: proc.pid } : {}),
    };
  }

  /**
   * Принять **уже идущий** процесс в фон (ADR-113 §«Detach идущего шелла»).
   *
   * Процесс не перезапускается и порт не вызывается: хэндл
   * (`ExecutionPort.spawnBackground` → `ExecBackgroundProcess`) и итератор его
   * вывода передаёт вызывающий (тул `execute_shell`). Дальше — та же механика,
   * что у `spawn`: запись реестра (`kind: 'process'`, лимиты проверяет
   * `startProcess`), лог в `BlobStore`, `stop` через реестр прогонов,
   * терминальный переход и уведомление родителя.
   *
   * Префикс лога — вывод, который команда успела выдать в foreground
   * (`bufferedStdout` + `bufferedStderr`): в журнал он пишется первым, в том же
   * виде, в каком его накапливал тул (без разделителей — как и чанки
   * `_consume`), иначе журнал начинался бы «с середины».
   *
   * Завершение уже случившегося процесса обрабатывается штатно: `exited`
   * резолвлен → запись сразу уходит в терминальный статус, `runId` всё равно
   * возвращается (переводить уже нечего, но вызывающему нужен результат).
   *
   * @throws BackgroundLimitExceededError — лимит прогонов сессии исчерпан.
   *   Процесс при этом **не** останавливается: тул продолжает читать его вывод
   *   в foreground.
   */
  async adopt(input: ProcessAdoptInput): Promise<ProcessSpawnResult> {
    const record = await this._background.startProcess({
      sessionId: input.sessionId,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      command: input.command,
      cwd: input.cwd,
      ...(input.pid !== undefined ? { pid: input.pid } : {}),
      processId: input.processId,
    });

    const logPath = record.logPath ?? '';

    // Событие перевода в фон: `process.started` уже опубликован `startProcess`
    // (UI создаёт по нему запись в реестре), `process.detached` — семантика
    // «этот прогон был блокирующим и отвязан посреди хода» (ADR-111 §detach).
    this._eventBus.publish(record.sessionId, 'process.detached', {
      session_id: record.sessionId,
      kind: 'process',
      id: record.id,
      process_id: record.processId ?? record.id,
      background_run_id: record.id,
      ...(input.title ? { title: input.title } : {}),
    });

    const writer = new ProcessLogWriter(
      this._blobs,
      logPath,
      processStreamLogPath(record.id, 'stdout'),
      processStreamLogPath(record.id, 'stderr'),
      this._limits.maxLogBytes,
      this._logger,
    );
    // Префикс лога — вывод, накопленный до перевода в фон. Потоки не
    // склеиваются: stdout и stderr попадают в **свои** файлы, а в общий
    // лог — stdout, затем stderr (как было до разделения потоков).
    if (input.bufferedStdout) writer.push('stdout', input.bufferedStdout);
    if (input.bufferedStderr) writer.push('stderr', input.bufferedStderr);

    this._track(
      record,
      input.handle,
      // Итератор переданного хэндла читается как поток: сервис — единственный
      // читатель с этого момента (тул снял подписку на «Стоп» и не читает).
      { [Symbol.asyncIterator]: () => input.iterator },
      writer,
    );

    return {
      runId: record.id,
      processId: record.processId ?? input.processId,
      logPath,
      ...(input.pid !== undefined ? { pid: input.pid } : {}),
    };
  }

  /**
   * Остановить фоновый процесс: `SIGTERM`, через 5 с — `SIGKILL`.
   *
   * Успешный запрос остановки публикует `process.stopped` в канал
   * владельца (один раз на прогон; повторный `stop` не дублирует).
   * Терминальный статус прогона приходит позже — событием `process.exited`.
   *
   * `false` — процесса нет в этом процессе (уже завершён или пережил
   * рестарт сервиса).
   */
  async stop(runId: string, reason = 'stopped'): Promise<boolean> {
    const live = this._live.get(runId);
    if (!live) return false;
    try {
      live.proc.stop('SIGTERM');
    } catch {
      // процесс уже завершён — не страшно
    }
    // Остановка запрошена — сообщаем каналу владельца (один раз на прогон).
    if (!live.stopPublished) {
      live.stopPublished = true;
      this._eventBus.publish(live.sessionId, 'process.stopped', {
        process_id: live.processId,
        session_id: live.sessionId,
        background_run_id: runId,
        reason,
      });
    }
    if (!live.killTimer) {
      const timer = setTimeout(() => {
        live.killTimer = undefined;
        // Процесс ещё жив (не вышел) — усиливаем сигнал.
        if (this._live.get(runId) === live) {
          try {
            live.proc.stop('SIGKILL');
          } catch {
            // процесс уже завершён
          }
        }
      }, KILL_GRACE_MS);
      timer.unref?.();
      live.killTimer = timer;
    }
    return true;
  }

  /** Список фоновых процессов реестра (свежие первыми). */
  async list(filter?: {
    sessionId?: string;
    projectId?: string;
    status?: BackgroundRunStatus;
    limit?: number;
  }): Promise<BackgroundRunRecord[]> {
    return this._background.list({ kind: 'process', ...(filter ?? {}) });
  }

  /** Запись реестра фонового процесса по id. */
  async get(id: string): Promise<BackgroundRunRecord | null> {
    const record = await this._background.get(id);
    if (!record || record.kind !== 'process') return null;
    return record;
  }

  /**
   * Отрезок лога фонового процесса.
   *
   * Чтение — из blob-хранилища по пути записи реестра. `offset`/`limit` —
   * в байтах; усечение по границе UTF-8 допускается (простой срез по байтам).
   *
   * `stream` — поток вывода: `combined` (по умолчанию) — общий лог прогона
   * (`record.logPath`), `stdout`/`stderr` — файл потока
   * (`processes/<id>.<stream>.log`). Файла потока нет у прогонов, запущенных
   * до разделения потоков, — тогда ответ `null` (как и для отсутствующего
   * общего лога).
   *
   * `null` — записи (или лога) нет: файла лога не существует (запись без
   * пути, либо лог удалён retention-очисткой). Пустой, но существующий лог —
   * не `null`, а отрезок с `totalBytes: 0`.
   */
  async logs(id: string, opts: ProcessLogsOptions = {}): Promise<ProcessLogsResult | null> {
    const record = await this.get(id);
    if (!record) return null;
    const stream = opts.stream ?? 'combined';
    const path = stream === 'combined'
      ? record.logPath
      : processStreamLogPath(record.id, stream);
    if (!path) return null;
    const truncated = stream === 'combined'
      ? record.metadata?.truncated === true
      : record.metadata?.[`${stream}_truncated`] === true;
    const buf = await this._blobs.read(path);
    if (!buf) return null;
    const totalBytes = buf.length;
    const rawOffset = Number.isFinite(opts.offset) ? Number(opts.offset) : 0;
    const offset = Math.min(Math.max(rawOffset, 0), totalBytes);
    const limit = Number.isFinite(opts.limit) ? Number(opts.limit) : undefined;
    const end = limit !== undefined && limit > 0 ? Math.min(totalBytes, offset + limit) : totalBytes;
    return {
      content: buf.subarray(offset, end).toString('utf-8'),
      offset,
      nextOffset: end,
      totalBytes,
      truncated,
    };
  }

  /**
   * Взять процесс под наблюдение: живой хэндл, чтение вывода, терминальный
   * переход.
   *
   * Общая часть `spawn` (процесс только что запущен) и `adopt` (процесс идёт с
   * момента запуска в foreground): разница только в том, откуда взят хэндл и
   * итератор вывода.
   */
  private _track(
    record: BackgroundRunRecord,
    proc: ExecBackgroundProcess,
    output: AsyncIterable<ExecBackgroundChunk>,
    writer: ProcessLogWriter,
  ): void {
    this._live.set(record.id, {
      proc,
      writer,
      sessionId: record.sessionId,
      processId: record.processId ?? record.id,
    });

    // Остановка по записи реестра (`BackgroundRunService.stop` → хэндл отмены).
    this._background.registerAbort(record.id, () => {
      void this.stop(record.id);
    });

    // Вывод процесса → лог.
    const consumed = this._consume(output, writer);

    // Завершение процесса → терминальный статус, уведомление, fs.changed.
    void proc.exited
      .then(async (exit) => {
        // Контракт порта: поток вывода закрывается вместе с процессом. Ждём его,
        // чтобы последний кусок не потерялся в логе и в summary уведомления.
        // Ожидание ограничено — несоответствующий порт не подвесит запись.
        await Promise.race([consumed, delay(OUTPUT_DRAIN_TIMEOUT_MS)]);
        await writer.flush();
        const live = this._live.get(record.id);
        if (live?.killTimer) {
          clearTimeout(live.killTimer);
          live.killTimer = undefined;
        }
        this._live.delete(record.id);
        await this._finish(record, writer, exit.exitCode, exit.signal);
      })
      .catch((err: unknown) => {
        this._logger.warn?.(
          `[ProcessService] завершение фонового процесса ${record.id} не удалось: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }

  /**
   * Терминальный статус процесса: `SIGTERM`/сигнал → `cancelled`, нулевой код
   * → `completed`, иначе `failed`.
   */
  private async _finish(
    record: BackgroundRunRecord,
    writer: ProcessLogWriter,
    exitCode: number | null,
    signal: string | null,
  ): Promise<void> {
    const status = signal ? 'cancelled' : exitCode === 0 ? 'completed' : 'failed';
    // Признаки усечения логов: общий (`truncated`, как было) и — отдельно —
    // по каждому потоку (у каждого файла свой предел размера).
    const metadata: Record<string, unknown> = { truncated: writer.truncated };
    if (writer.streamTruncated('stdout')) metadata['stdout_truncated'] = true;
    if (writer.streamTruncated('stderr')) metadata['stderr_truncated'] = true;
    // Финальная запись реестра: терминальный статус уже зафиксирован — именно
    // её получает хук (исходная запись ещё `running`).
    let finalRecord: BackgroundRunRecord | null = null;
    try {
      finalRecord = await this._background.finish(record.id, {
        status,
        ...(exitCode !== null ? { exitCode } : {}),
        ...(signal ? { signal } : {}),
        // Хвост лога — он же попадает в уведомление родителя.
        summary: writer.tail(),
        metadata,
      });
    } catch (err) {
      this._logger.warn?.(
        `[ProcessService] фиксация завершения процесса ${record.id} не удалась: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // Процесс мог изменить файлы workspace — сообщаем UI (как после resume
    // саб-агента): широкий scope, путь процесса заранее неизвестен.
    this._eventBus.publish(record.sessionId, 'fs.changed', {
      session_id: record.sessionId,
      project_id: record.projectId ?? null,
      scope: 'all',
      tool: 'execute_shell',
    });
    // ADR-136/ADR-126 §5: хук терминального перехода (парная запись журнала
    // исполнений). Вызывается только при успешной фиксации статуса: ошибка
    // хука не влияет на процесс — переход уже зафиксирован.
    if (this._onFinished && finalRecord) {
      try {
        await this._onFinished(finalRecord);
      } catch (err) {
        this._logger.warn?.(
          `[ProcessService] хук завершения фонового процесса ${record.id} не удался: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /** Перекачка вывода процесса в писатель лога. */
  private async _consume(
    output: AsyncIterable<ExecBackgroundChunk>,
    writer: ProcessLogWriter,
  ): Promise<void> {
    try {
      for await (const chunk of output) {
        // Поток куска сохраняется: текст попадает и в общий лог, и в файл
        // своего потока.
        writer.push(chunk.stream, chunk.data);
      }
    } catch (err) {
      this._logger.warn?.(
        `[ProcessService] чтение вывода фонового процесса прервано: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Слив вывода без записи (процесс отклонён реестром — лог не нужен). */
  private async _drain(output: AsyncIterable<ExecBackgroundChunk>): Promise<void> {
    try {
      for await (const chunk of output) {
        // вывод не нужен — только освобождаем поток
        void chunk;
      }
    } catch {
      // поток уже закрыт — не страшно
    }
  }
}

/** Пауза-предохранитель (таймер `unref` — процесс не держим). */
function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * Отображение argv-команды одной строкой — для реестра прогонов и UI.
 *
 * Только показа: команда из реестра **не перезапускается** (процесс уже
 * запущен), поэтому склейка без кавычек достаточна — секретов в аргументах
 * нет (ключ доставляется секретом вызова, а не аргументом).
 */
function formatArgvCommand(argv: { file: string; args: string[] }): string {
  return [argv.file, ...argv.args].join(' ');
}

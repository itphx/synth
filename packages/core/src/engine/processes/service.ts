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
 */
import type { BackgroundRunRecord, BackgroundRunStatus } from '@itphx/synth-shared';
import type { ExecBackgroundProcess, ExecutionPort } from '../../execution/ports/index.js';
import type { EventBus } from '../../events/bus.js';
import type { BlobStore } from '../../storage/ports/blob-store.js';
import type { BackgroundRunService } from '../background/service.js';
import { toolRuntimeRequires } from '../tools/runtime-deps.js';
import {
  BackgroundUnsupportedError,
  PROCESS_LOG_FLUSH_BYTES,
  PROCESS_LOG_FLUSH_INTERVAL_MS,
  PROCESS_LOG_TAIL_LIMIT,
  type ProcessLogsOptions,
  type ProcessLogsResult,
  type ProcessLogger,
  type ProcessServiceOptions,
  type ProcessSpawnInput,
  type ProcessSpawnResult,
} from './types.js';

/** Пауза между «мягким» и «жёстким» убийством процесса (SIGTERM → SIGKILL). */
const KILL_GRACE_MS = 5_000;

/** Живой фоновый процесс (в памяти процесса — хэндлы отмены). */
interface LiveProcess {
  /** Хэндл порта исполнения. */
  proc: ExecBackgroundProcess;
  /** Писатель лога. */
  writer: ProcessLogWriter;
  /** Таймер эскалации до SIGKILL. */
  killTimer?: NodeJS.Timeout;
}

/**
 * Буфер записи лога фонового процесса.
 *
 * Куски вывода копятся в буфере и пишутся в blob **пачками**: при 64 КиБ
 * (быстрый вывод не копится в памяти) либо раз в 200 мс (редкий вывод не
 * ждёт накопления). Записи сериализованы цепочкой промисов — порядок вывода
 * сохраняется.
 *
 * Ошибка записи **не роняет процесс**: она — предупреждение в лог.
 */
class ProcessLogWriter {
  private readonly _blobs: BlobStore;
  private readonly _path: string;
  private readonly _maxBytes: number;
  private readonly _logger: ProcessLogger;
  /** Накопленный, ещё не записанный текст. */
  private _pending = '';
  /** Сколько байт уже записано в blob. */
  private _bytes = 0;
  /** Лог усечён по пределу размера. */
  private _truncated = false;
  /** Хвост записанного текста (для уведомления родителя). */
  private _tail = '';
  /** Таймер интервального флаша. */
  private _timer: NodeJS.Timeout | null = null;
  /** Цепочка записей (порядок вывода сохраняется). */
  private _chain: Promise<void> = Promise.resolve();

  constructor(blobs: BlobStore, path: string, maxBytes: number, logger: ProcessLogger) {
    this._blobs = blobs;
    this._path = path;
    this._maxBytes = maxBytes;
    this._logger = logger;
  }

  /** Лог усечён по пределу размера. */
  get truncated(): boolean {
    return this._truncated;
  }

  /** Сколько байт записано в blob. */
  get bytesWritten(): number {
    return this._bytes;
  }

  /** Хвост записанного текста (≤ `PROCESS_LOG_TAIL_LIMIT` символов). */
  tail(): string {
    return this._tail;
  }

  /** Принять кусок вывода процесса. */
  push(chunk: string): void {
    if (!chunk || this._truncated) return;
    this._pending += chunk;
    if (Buffer.byteLength(this._pending, 'utf-8') >= PROCESS_LOG_FLUSH_BYTES) {
      void this.flush();
      return;
    }
    this._scheduleFlush();
  }

  /** Записать накопленное в blob (ошибка записи — только предупреждение). */
  flush(): Promise<void> {
    const text = this._pending;
    this._pending = '';
    if (!text) return this._chain;
    this._chain = this._chain.then(async () => {
      try {
        const buf = Buffer.from(text, 'utf-8');
        let payload = buf;
        if (this._maxBytes > 0) {
          const room = this._maxBytes - this._bytes;
          if (room <= 0) {
            this._truncated = true;
            return;
          }
          if (payload.length > room) {
            payload = payload.subarray(0, room);
            this._truncated = true;
          }
        }
        await this._blobs.append(this._path, payload);
        this._bytes += payload.length;
        this._tail = (this._tail + payload.toString('utf-8')).slice(-PROCESS_LOG_TAIL_LIMIT);
      } catch (err) {
        this._logger.warn?.(
          `[ProcessService] запись лога процесса не удалась: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
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
}

export class ProcessService {
  private readonly _port: ExecutionPort;
  private readonly _background: BackgroundRunService;
  private readonly _blobs: BlobStore;
  private readonly _eventBus: EventBus;
  private readonly _limits: { maxLogBytes: number };
  private readonly _logger: ProcessLogger;
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
  }

  /**
   * Запустить шелл-команду в фоне.
   *
   * Порядок: проверка поддержки фонового режима портом → запуск у порта →
   * регистрация в реестре фоновых прогонов (лимиты) → запись лога → хэндл
   * отмены.
   *
   * @throws BackgroundUnsupportedError — порт не умеет фоновый запуск.
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

    const proc = await spawnBackground({
      command: { kind: 'shell', command: input.command, shell: 'sh' },
      cwd: input.cwd,
      ...(input.env ? { env: input.env } : {}),
      // Фоновый процесс по умолчанию **без таймаута**: он переживает ход агента.
      timeoutMs: input.timeoutMs ?? 0,
      // Бинарное требование тула (`sh`) — как у синхронного запуска (ADR-077).
      requires: toolRuntimeRequires('execute_shell'),
    });

    let record: BackgroundRunRecord;
    try {
      record = await this._background.startProcess({
        sessionId: input.sessionId,
        ...(input.projectId ? { projectId: input.projectId } : {}),
        command: input.command,
        cwd: input.cwd,
        ...(proc.pid !== undefined ? { pid: proc.pid } : {}),
        processId: proc.processId,
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
    const writer = new ProcessLogWriter(this._blobs, logPath, this._limits.maxLogBytes, this._logger);
    this._live.set(record.id, { proc, writer });

    // Остановка по записи реестра (`BackgroundRunService.stop` → хэндл отмены).
    this._background.registerAbort(record.id, () => {
      void this.stop(record.id);
    });

    // Вывод процесса → лог.
    void this._consume(proc.output, writer);

    // Завершение процесса → терминальный статус, уведомление, fs.changed.
    void proc.exited
      .then(async (exit) => {
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

    return {
      runId: record.id,
      processId: proc.processId,
      logPath,
      ...(proc.pid !== undefined ? { pid: proc.pid } : {}),
    };
  }

  /**
   * Остановить фоновый процесс: `SIGTERM`, через 5 с — `SIGKILL`.
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
    void reason;
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
   * Чтение — из blob-хранилища по пути из записи реестра. `offset`/`limit` —
   * в байтах; усечение по границе UTF-8 допускается (простой срез по байтам).
   *
   * `null` — записи (или лога) нет: файла лога не существует (запись без
   * пути, либо лог удалён retention-очисткой). Пустой, но существующий лог —
   * не `null`, а отрезок с `totalBytes: 0`.
   */
  async logs(id: string, opts: ProcessLogsOptions = {}): Promise<ProcessLogsResult | null> {
    const record = await this.get(id);
    if (!record) return null;
    const truncated = record.metadata?.truncated === true;
    if (!record.logPath) return null;
    const buf = await this._blobs.read(record.logPath);
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
    try {
      await this._background.finish(record.id, {
        status,
        ...(exitCode !== null ? { exitCode } : {}),
        ...(signal ? { signal } : {}),
        // Хвост лога — он же попадает в уведомление родителя.
        summary: writer.tail(),
        metadata: { truncated: writer.truncated },
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
  }

  /** Перекачка вывода процесса в писатель лога. */
  private async _consume(
    output: AsyncIterable<{ stream: 'stdout' | 'stderr'; data: string }>,
    writer: ProcessLogWriter,
  ): Promise<void> {
    try {
      for await (const chunk of output) {
        writer.push(chunk.data);
      }
    } catch (err) {
      this._logger.warn?.(
        `[ProcessService] чтение вывода фонового процесса прервано: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Слив вывода без записи (процесс отклонён реестром — лог не нужен). */
  private async _drain(output: AsyncIterable<{ stream: 'stdout' | 'stderr'; data: string }>): Promise<void> {
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

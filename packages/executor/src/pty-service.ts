/**
 * PTY-сервис исполнителя (протокол 8, план терминалов, Ф2a; проба переднего
 * плана — протокол 9).
 *
 * Псевдотерминал живёт **на исполнителе**: там, где есть toolchain и рабочий
 * каталог проекта. Control plane (тонкий backend в split-топологии) общается
 * с терминалом по проводу — открывает сессию, пишет ввод, читает вывод.
 *
 * ## Что сервис НЕ делает
 *
 * - **не дублирует spawn**: запуск PTY — общий код core
 *   (`InlineExecutionPort.openPty` → `getPtyProvider()` → нативный модуль
 *   node-pty). Исполнитель подключается к core точечным динамическим
 *   `import()` (как `exec-service.ts` подключает inline-порт) и не знает ни
 *   про node-pty, ни про его prebuild'ы;
 * - **не дублирует закрытие**: сигнал группе процессов терминала
 *   (`SIGTERM` → 1 с → `SIGKILL`) — тоже core (`createPtyHandle`);
 * - **не дублирует окружение**: `TERM`/`COLORTERM` и очистка ambient-переменных
 *   — тоже core.
 *
 * ## Что сервис делает
 *
 * - **реестр сессий** в памяти процесса исполнителя (у исполнителя нет
 *   доступа к каталогу данных инстанса);
 * - **containment `cwd`** — тот же `resolveContainedCwd`, что у команд: терминал
 *   не должен стартовать вне workspace;
 * - **нумерация кадров вывода** (`seq`) и **буфер повтора** (256 КиБ): клиент,
 *   переподключившийся к потоку, дочитывает вывод с места обрыва;
 * - **батчинг вывода**: кадры склеиваются окном 10–15 мс — иначе поток
 *   терминала упирается в тысячи мелких HTTP-кадров в секунду;
 * - **idle-reaper**: сессия, которая давно не использовалась, закрывается
 *   (таймер `unref`, процесс исполнителя не держит);
 * - **лимит живых сессий**: превышение → `pty_limit` (429).
 */

import { randomUUID } from 'node:crypto';
import type { ExecutionPort, PtyForeground, PtyHandle, PtyProvider } from '@itphx/synth-core';
import {
  type PtyOpenBody,
  type PtyOpenResponse,
  type PtyStatusBody,
  type PtyStreamFrame,
} from './protocol.js';
import { resolveContainedCwd } from './workspace.js';

/** Размер replay-буфера вывода по умолчанию, байт (256 КиБ). */
export const DEFAULT_PTY_REPLAY_BUFFER_BYTES = 256 * 1024;

/** Окно батчинга вывода по умолчанию, мс (в диапазоне 10–15). */
export const DEFAULT_PTY_BATCH_MS = 12;

/**
 * Пауза между «мягким» и «жёстким» закрытием PTY-сессии, мс.
 *
 * Значение core (`PTY_CLOSE_GRACE_MS`) продублировано как дефолт сервиса:
 * исполнитель не импортирует внутренний модуль core, а значение нужно для
 * документирования поведения закрытия.
 */
export const DEFAULT_PTY_CLOSE_GRACE_MS = 1_000;

/** Причина отказа сервиса PTY. */
export type PtyServiceFailureReason =
  /** PTY недоступен (контур выключен или нативный модуль не загрузился). */
  | 'pty_unsupported'
  /** Сессия не найдена. */
  | 'pty_not_found'
  /** Превышен лимит живых сессий. */
  | 'pty_limit'
  /** `cwd` вне workspace исполнителя. */
  | 'cwd_outside_workspace'
  /** Не удалось запустить терминал. */
  | 'spawn_failed'
  /** Ввод превышает потолок. */
  | 'payload_too_large';

/** Отказ сервиса PTY (без исключения — вызывающий сам решает код ответа). */
export interface PtyServiceFailure {
  ok: false;
  reason: PtyServiceFailureReason;
  message: string;
}

/** Успешный результат сервиса PTY. */
export interface PtyServiceSuccess<T> {
  ok: true;
  value: T;
}

/** Итог открытия PTY-сессии. */
export type PtyOpenOutcome =
  | {
      ok: true;
      /** Ответ для клиента. */
      response: PtyOpenResponse;
      /** `false` — сессия уже была открыта (идемпотентный повтор). */
      created: boolean;
    }
  | PtyServiceFailure;

/** Итог записи во вход терминала. */
export type PtyWriteOutcome =
  | { ok: true; bytes: number }
  | PtyServiceFailure;

/** Параметры PTY-сервиса. */
export interface PtyServiceOptions {
  /** Корень workspace — граница containment'а для `cwd`. */
  workspaceRoot: string;
  /** Лимит **живых** PTY-сессий. */
  maxSessions: number;
  /** Таймаут простоя сессии, мс (idle-reaper). */
  idleTimeoutMs: number;
  /** Потолок тела ввода терминала, байт. */
  inputMaxBytes: number;
  /**
   * Фабрика провайдера PTY.
   *
   * Не задана — штатная ленивая загрузка нативного модуля в core
   * (`getPtyProvider()`). Тесты подставляют подделку — нативный модуль в
   * тестах не нужен.
   */
  providerFactory?: () => Promise<PtyProvider>;
  /** Окно батчинга вывода, мс (по умолчанию — 12). */
  batchMs?: number;
  /** Размер replay-буфера вывода, байт (по умолчанию — 256 КиБ). */
  replayBufferBytes?: number;
}

/** Запись реестра PTY-сессий. */
interface PtyRecord {
  /** Идентификатор сессии (клиентский или сгенерированный). */
  id: string;
  /** Хэндл core (`PtyHandle`): запись, resize, подписки, закрытие. */
  handle: PtyHandle;
  /** Текущий размер терминала. */
  cols: number;
  rows: number;
  /** Номер последнего выданного кадра (монотонный). */
  seq: number;
  /** Буфер повтора: последние кадры вывода. */
  frames: PtyStreamFrame[];
  /** Размер буфера повтора в байтах. */
  replayBytes: number;
  /** Неза-flushed данные вывода. */
  pending: string;
  /** Таймер батчинга. */
  flushTimer: NodeJS.Timeout | undefined;
  /** Терминал завершился. */
  exited: boolean;
  /** Код завершения. */
  exitCode: number | undefined;
  /** Сигнал завершения. */
  signal: string | undefined;
  /** Момент последней активности, мс (для idle-reaper). */
  lastActivityAt: number;
  /** Промис закрытия (идемпотентность). */
  closePromise: Promise<void> | undefined;
  /** Подписчики на кадры вывода. */
  subscribers: Set<(frame: PtyStreamFrame) => void>;
  /** Подписчики на выход терминала. */
  exitSubscribers: Set<() => void>;
}

/**
 * Сервис PTY-сессий исполнителя.
 *
 * Состояние — **в памяти процесса** (у исполнителя нет каталога данных
 * инстанса): после рестарта исполнителя терминалы не переживают (это
 * ожидаемо — терминал привязан к живому агенту).
 */
export class PtyService {
  private readonly _workspaceRoot: string;
  private readonly _maxSessions: number;
  private readonly _idleTimeoutMs: number;
  private readonly _inputMaxBytes: number;
  private readonly _providerFactory: (() => Promise<PtyProvider>) | undefined;
  private readonly _batchMs: number;
  private readonly _replayBufferBytes: number;
  private readonly _sessions = new Map<string, PtyRecord>();
  private _portPromise: Promise<ExecutionPort> | undefined;
  private readonly _reaper: NodeJS.Timeout | undefined;
  private _disposed = false;

  constructor(opts: PtyServiceOptions) {
    this._workspaceRoot = opts.workspaceRoot;
    this._maxSessions = Math.max(1, opts.maxSessions);
    this._idleTimeoutMs = Math.max(1, opts.idleTimeoutMs);
    this._inputMaxBytes = Math.max(1, opts.inputMaxBytes);
    this._providerFactory = opts.providerFactory;
    this._batchMs = Math.max(1, opts.batchMs ?? DEFAULT_PTY_BATCH_MS);
    this._replayBufferBytes = Math.max(1, opts.replayBufferBytes ?? DEFAULT_PTY_REPLAY_BUFFER_BYTES);

    // Ленивая загрузка порта core: нативный модуль терминала не поднимается,
    // пока PTY-сессию не открыли (и не поднимается вовсе, если PTY выключен).
    this._portPromise = undefined;

    // Idle-reaper: закрывает терминалы, которые забыли закрыть. Интервал —
    // не чаще раза в минуту (при дефолтном простое в 2 дня — раз в минуту
    // достаточно), таймер `unref` — процесс исполнителя он не держит.
    const interval = Math.max(1_000, Math.min(this._idleTimeoutMs, 60_000));
    this._reaper = setInterval(() => {
      this._reapIdle();
    }, interval);
    this._reaper.unref?.();
  }

  /** Лимит живых PTY-сессий. */
  get maxSessions(): number {
    return this._maxSessions;
  }

  /** Потолок тела ввода терминала, байт. */
  get inputMaxBytes(): number {
    return this._inputMaxBytes;
  }

  /** Число живых PTY-сессий. */
  get liveCount(): number {
    let count = 0;
    for (const record of this._sessions.values()) {
      if (!record.exited) count += 1;
    }
    return count;
  }

  /**
   * Открыть PTY-сессию.
   *
   * **Идемпотентность по `id`**: повторный `open` с тем же `id` возвращает
   * уже открытую сессию (`created: false`) — терминал второй раз не
   * заводится. Если сессия с таким `id` уже завершилась — заводится новая
   * (умерший терминал не «воскресает»).
   */
  async open(body: PtyOpenBody): Promise<PtyOpenOutcome> {
    if (this._disposed) {
      return { ok: false, reason: 'pty_unsupported', message: 'PTY-сервис исполнителя остановлен' };
    }

    const id = body.id ?? `pty_${randomUUID()}`;
    const existing = this._sessions.get(id);
    if (existing && !existing.exited) {
      return {
        ok: true,
        created: false,
        response: {
          id,
          ...(existing.handle.pid !== undefined ? { pid: existing.handle.pid } : {}),
          cols: existing.cols,
          rows: existing.rows,
        },
      };
    }

    // Containment — до всего остального: терминал вне workspace не
    // заводится вовсе (тот же fail-closed, что у команд).
    const cwd = resolveContainedCwd(this._workspaceRoot, body.cwd);
    if (!cwd.ok) {
      return { ok: false, reason: 'cwd_outside_workspace', message: cwd.message };
    }

    if (this.liveCount >= this._maxSessions) {
      return {
        ok: false,
        reason: 'pty_limit',
        message: `превышен лимит живых PTY-сессий исполнителя (${this._maxSessions})`,
      };
    }

    let handle: PtyHandle;
    try {
      const port = await this._resolvePort();
      if (typeof port.openPty !== 'function') {
        return {
          ok: false,
          reason: 'pty_unsupported',
          message: 'порт исполнения не умеет открывать PTY-сессии',
        };
      }
      handle = await port.openPty({
        cwd: cwd.path,
        ...(body.shell !== undefined ? { shell: body.shell } : {}),
        ...(body.args !== undefined ? { args: body.args } : {}),
        cols: body.cols,
        rows: body.rows,
        ...(body.env !== undefined ? { env: body.env } : {}),
      });
    } catch (err) {
      const e = err as { reason?: string; code?: string | number | null; message?: string };
      // Недоступность нативного модуля — core отдаёт `EPTY`/`dependency_missing`:
      // PTY здесь не будет (адрес выбирать нельзя), а не «сломалось».
      if (e.code === 'EPTY' || e.reason === 'dependency_missing') {
        return {
          ok: false,
          reason: 'pty_unsupported',
          message: e.message ?? 'PTY недоступен на исполнителе',
        };
      }
      return {
        ok: false,
        reason: 'spawn_failed',
        message: e.message ?? 'не удалось запустить PTY-сессию',
      };
    }

    // Запись с тем же `id`, но уже завершённая — заменяется новой.
    if (existing) this._sessions.delete(id);

    const record: PtyRecord = {
      id,
      handle,
      cols: body.cols,
      rows: body.rows,
      seq: 0,
      frames: [],
      replayBytes: 0,
      pending: '',
      flushTimer: undefined,
      exited: false,
      exitCode: undefined,
      signal: undefined,
      lastActivityAt: Date.now(),
      closePromise: undefined,
      subscribers: new Set(),
      exitSubscribers: new Set(),
    };

    handle.onData((chunk) => {
      record.pending += chunk;
      record.lastActivityAt = Date.now();
      this._scheduleFlush(record);
    });

    handle.onExit((info) => {
      this._flush(record);
      record.exited = true;
      if (info.exitCode !== undefined) record.exitCode = info.exitCode;
      if (info.signal !== undefined) record.signal = info.signal;
      for (const cb of [...record.exitSubscribers]) {
        try {
          cb();
        } catch {
          // Подписчик не должен ломать обработку выхода.
        }
      }
      record.exitSubscribers.clear();
    });

    this._sessions.set(id, record);

    return {
      ok: true,
      created: true,
      response: {
        id,
        ...(handle.pid !== undefined ? { pid: handle.pid } : {}),
        cols: body.cols,
        rows: body.rows,
      },
    };
  }

  /** Записать данные во вход терминала. */
  write(id: string, data: string): PtyWriteOutcome {
    const record = this._sessions.get(id);
    if (!record) {
      return { ok: false, reason: 'pty_not_found', message: 'PTY-сессия не найдена' };
    }
    const bytes = Buffer.byteLength(data, 'utf-8');
    if (bytes > this._inputMaxBytes) {
      return {
        ok: false,
        reason: 'payload_too_large',
        message: `ввод терминала больше ${this._inputMaxBytes} байт`,
      };
    }
    record.lastActivityAt = Date.now();
    if (record.exited) {
      return { ok: false, reason: 'pty_not_found', message: 'PTY-сессия завершена' };
    }
    try {
      record.handle.write(data);
    } catch (err) {
      return {
        ok: false,
        reason: 'spawn_failed',
        message: err instanceof Error ? err.message : String(err),
      };
    }
    return { ok: true, bytes };
  }

  /** Изменить размер терминала. */
  resize(id: string, cols: number, rows: number): { ok: true } | PtyServiceFailure {
    const record = this._sessions.get(id);
    if (!record) {
      return { ok: false, reason: 'pty_not_found', message: 'PTY-сессия не найдена' };
    }
    record.lastActivityAt = Date.now();
    record.cols = cols;
    record.rows = rows;
    if (!record.exited) {
      try {
        record.handle.resize(cols, rows);
      } catch {
        // Гонка с выходом терминала — не ошибка вызова.
      }
    }
    return { ok: true };
  }

  /** Закрыть сессию (`SIGTERM` группе → 1 с → `SIGKILL`). */
  close(id: string): { ok: true } | PtyServiceFailure {
    const record = this._sessions.get(id);
    if (!record) {
      return { ok: false, reason: 'pty_not_found', message: 'PTY-сессия не найдена' };
    }
    void this._closeRecord(record);
    return { ok: true };
  }

  /** Состояние сессии (или `undefined`, если её нет). */
  status(id: string): PtyStatusBody | undefined {
    const record = this._sessions.get(id);
    if (!record) return undefined;
    return {
      id: record.id,
      ...(record.handle.pid !== undefined ? { pid: record.handle.pid } : {}),
      cols: record.cols,
      rows: record.rows,
      exited: record.exited,
      ...(record.exitCode !== undefined ? { exitCode: record.exitCode } : {}),
      ...(record.signal !== undefined ? { signal: record.signal } : {}),
      seq: record.seq,
    };
  }

  /**
   * Что сейчас на переднем плане терминала (протокол 9).
   *
   * Делегирует `PtyHandle.inspect?()` из core (проба `/proc` → `ps`, кэш
   * 250 мс — в хэндле): сервис не повторяет ни парсинг, ни кэш. `null` —
   * сессии нет, хэндл не умеет пробу или факт неизвестен. Различить «сессии
   * нет» и «неизвестно» вызывающему не нужно: маршрут сессии проверяет
   * `status()` до вызова (404 на отсутствующую сессию).
   */
  async inspect(id: string): Promise<PtyForeground | null> {
    const record = this._sessions.get(id);
    if (!record) return null;
    const inspect = record.handle.inspect;
    if (!inspect) return null;
    try {
      return await inspect.call(record.handle);
    } catch {
      // Проба не должна ронять HTTP-ответ: неизвестно — значит `null`.
      return null;
    }
  }

  /** Кадры вывода с номером больше `since` (буфер повтора). */
  framesSince(id: string, since: number): PtyStreamFrame[] | undefined {
    const record = this._sessions.get(id);
    if (!record) return undefined;
    return record.frames.filter((frame) => frame.seq > since);
  }

  /** Подписаться на живые кадры вывода (возвращает функцию отписки). */
  subscribe(id: string, cb: (frame: PtyStreamFrame) => void): (() => void) | undefined {
    const record = this._sessions.get(id);
    if (!record) return undefined;
    record.subscribers.add(cb);
    return () => {
      record.subscribers.delete(cb);
    };
  }

  /** Подписаться на выход терминала (возвращает функцию отписки). */
  onExit(id: string, cb: () => void): (() => void) | undefined {
    const record = this._sessions.get(id);
    if (!record) return undefined;
    if (record.exited) {
      // Выход уже был — отдаём результат немедленно (событие одно).
      cb();
      return () => {};
    }
    record.exitSubscribers.add(cb);
    return () => {
      record.exitSubscribers.delete(cb);
    };
  }

  /** Закрыть все сессии и остановить idle-reaper (остановка исполнителя). */
  async dispose(): Promise<void> {
    this._disposed = true;
    if (this._reaper) clearInterval(this._reaper);
    const records = [...this._sessions.values()];
    this._sessions.clear();
    await Promise.all(records.map((record) => this._closeRecord(record)));
  }

  /**
   * Порт core для открытия PTY-сессий (ленивая загрузка).
   *
   * Собственный инстанс `InlineExecutionPort` — с подставленной фабрикой
   * провайдера, если она задана (тесты). Штатный путь — нативный модуль
   * core (`getPtyProvider()`), поднимаемый лениво.
   */
  private async _resolvePort(): Promise<ExecutionPort> {
    if (!this._portPromise) {
      const providerFactory = this._providerFactory;
      this._portPromise = (async () => {
        const core = await import('@itphx/synth-core');
        return providerFactory
          ? new core.InlineExecutionPort({ ptyProvider: providerFactory })
          : new core.InlineExecutionPort();
      })();
    }
    return this._portPromise;
  }

  /** Запланировать flush накопленного вывода (окно батчинга). */
  private _scheduleFlush(record: PtyRecord): void {
    if (record.flushTimer !== undefined) return;
    const timer = setTimeout(() => {
      record.flushTimer = undefined;
      this._flush(record);
    }, this._batchMs);
    timer.unref?.();
    record.flushTimer = timer;
  }

  /** Выдать накопленный вывод одним кадром (с номером `seq`). */
  private _flush(record: PtyRecord): void {
    if (record.pending.length === 0) return;
    const data = record.pending;
    record.pending = '';
    const frame: PtyStreamFrame = { seq: record.seq + 1, data };
    record.seq = frame.seq;
    record.frames.push(frame);
    record.replayBytes += Buffer.byteLength(data, 'utf-8');
    // Буфер повтора ограничен: старые кадры вытесняются (клиент, который
    // отстал, получит разрыв — но не бесконечный поток).
    while (record.replayBytes > this._replayBufferBytes && record.frames.length > 1) {
      const dropped = record.frames.shift();
      if (!dropped) break;
      record.replayBytes -= Buffer.byteLength(dropped.data, 'utf-8');
    }
    for (const subscriber of [...record.subscribers]) {
      try {
        subscriber(frame);
      } catch {
        // Подписчик не должен ломать поток вывода терминала.
      }
    }
  }

  /** Закрыть запись (идемпотентно). */
  private _closeRecord(record: PtyRecord): Promise<void> {
    record.closePromise ??= (async () => {
      if (record.exited) return;
      try {
        await record.handle.close();
      } catch {
        // Гонка с естественным выходом — закрытие не должно бросать.
      }
    })();
    return record.closePromise;
  }

  /** Закрыть сессии, которые давно не использовались (idle-reaper). */
  private _reapIdle(): void {
    const now = Date.now();
    for (const record of [...this._sessions.values()]) {
      if (record.exited) continue;
      if (now - record.lastActivityAt < this._idleTimeoutMs) continue;
      void this._closeRecord(record);
    }
  }
}

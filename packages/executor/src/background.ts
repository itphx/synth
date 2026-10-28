/**
 * Фоновые процессы исполнителя (ADR-077, шаг 7c; PROP-097).
 *
 * Фоновый процесс **переживает ход агента**: команда стартует и работает в
 * фоне, а control plane следит за ней через реестр (список, статус, логи,
 * остановка). В split-топологии эти процессы живут **на исполнителе** — там,
 * где есть toolchain и рабочий каталог (ADR-077), — а не в тонком control
 * plane.
 *
 * ## Отличия от синхронного `/exec`
 *
 * - запуск через `child_process.spawn` (не `execFile`): процесс живёт после
 *   ответа HTTP;
 * - вывод **не буферизуется в памяти**: он пишется в файлы журнала
 *   (`<logDir>/<processId>.out.log` и `.err.log`), а наружу отдаётся
 *   отрезками (offset/limit) — как в порте `ExecutionPort.spawnBackground`
 *   (core), где вывод стримится кусками;
 * - `cwd` проходит **тот же** containment, что и у `ExecService`
 *   (`resolveContainedCwd`) — логика не дублируется;
 * - `requires` **не проверяется**: проверка бинарных требований остаётся на
 *   слое тула (так же, как в портовом контракте `spawnBackground`).
 *
 * ## Логи и лимиты
 *
 * - журналы — **раздельные** по потокам (stdout/stderr), каталог `0700`,
 *   файлы `0600` (PROP-097: «лог-файл — `0600`, каталог `0700`»);
 * - лимит `maxLogBytes` — **на поток**: при его достижении запись в поток
 *   прекращается, выставляется `truncated`, но **процесс не убивается**
 *   (он может писать в другой поток или просто долго работать);
 * - лимит `maxProcesses` — на число **живых** процессов: превышение →
 *   отказ `too_many_requests` (429).
 *
 * ## Таймауты и остановка
 *
 * - `timeoutMs > 0` — `SIGTERM` по истечении таймаута, через 5 с — `SIGKILL`
 *   (те же пауза и сигналы, что у inline-порта в core);
 * - `stop()` — идемпотентно: повторный вызов не дублирует эскалацию.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFile, chmod, mkdir, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecCommand } from '@itphx/synth-core';
import type { BackgroundProcessStatus, ExecutorErrorReason } from './protocol.js';
import { resolveContainedCwd } from './workspace.js';

/** Базовая оболочка shell-формы (совпадает с `DEFAULT_SHELL_BINARY` в core). */
const DEFAULT_SHELL_BINARY = 'sh';

/** Лимит живых фоновых процессов по умолчанию. */
export const DEFAULT_MAX_BACKGROUND_PROCESSES = 8;

/** Лимит журнала на поток по умолчанию (10 МиБ). */
export const DEFAULT_BACKGROUND_MAX_LOG_BYTES = 10 * 1024 * 1024;

/** Каталог журналов по умолчанию. */
export const DEFAULT_BACKGROUND_LOG_DIR = join(tmpdir(), 'synth-exec-bg');

/** Пауза между «мягким» и «жёстким» убийством процесса, мс. */
export const BACKGROUND_KILL_GRACE_MS = 5_000;

/** Интервал авто-очистки реестра, мс (10 мин). */
export const BACKGROUND_PRUNE_INTERVAL_MS = 10 * 60 * 1000;

/** Время жизни терминальной записи в реестре до очистки, мс (1 ч). */
export const BACKGROUND_PRUNE_TTL_MS = 60 * 60 * 1000;

/** Размер отрезка журнала по умолчанию при чтении (64 КиБ). */
export const DEFAULT_LOG_READ_LIMIT = 64 * 1024;

/** Потолок отрезка журнала при чтении (256 КиБ). */
export const MAX_LOG_READ_LIMIT = 256 * 1024;

/** Пауза при остановке исполнителя: `SIGTERM` → (через 2 с) `SIGKILL`. */
const DISPOSE_GRACE_MS = 2_000;

/** Статус фонового процесса (тип — из wire-протокола). */
export type { BackgroundProcessStatus } from './protocol.js';

/** Запись реестра фоновых процессов (снимок состояния). */
export interface BackgroundProcessRecord {
  /** Идентификатор процесса (`proc_<uuid>`). */
  id: string;
  /** pid процесса ОС (не задан, если запуск не удался). */
  pid?: number;
  /** Команда запуска. */
  command: ExecCommand;
  /** Рабочий каталог (внутри workspace исполнителя). */
  cwd: string;
  /** Текущий статус. */
  status: BackgroundProcessStatus;
  /** Код завершения; `null` — процесс убит сигналом или ещё жив. */
  exitCode: number | null;
  /** Сигнал завершения; `null` — процесс вышел сам. */
  signal: string | null;
  /** Момент старта, мс. */
  startedAt: number;
  /** Момент завершения, мс (не задан, пока процесс жив). */
  finishedAt?: number;
  /** Длительность жизни процесса, мс (не задана, пока процесс жив). */
  durationMs?: number;
  /** Записано байт в stdout. */
  stdoutBytes: number;
  /** Записано байт в stderr. */
  stderrBytes: number;
  /** Хотя бы один поток упёрся в лимит журнала. */
  truncated: boolean;
}

/** Запрос фонового запуска. */
export interface BackgroundSpawnInput {
  /** Команда: shell-строка или argv (без shell). */
  command: ExecCommand;
  /** Рабочий каталог (внутри workspace исполнителя). */
  cwd?: string;
  /** Дополнительное окружение — мержится поверх окружения исполнителя. */
  env?: Record<string, string>;
  /** Таймаут процесса, мс (`0`/не задан — без таймаута). */
  timeoutMs?: number;
  /**
   * Требуемые бинари — принимаются, но **не проверяются**: проверка
   * бинарных требований остаётся на слое тула (как в портовом контракте
   * `ExecutionPort.spawnBackground`).
   */
  requires?: string[];
}

/** Итог фонового запуска: успех либо отказ с протокольной причиной. */
export type BackgroundSpawnOutcome =
  | { ok: true; processId: string; pid: number | undefined }
  | {
      ok: false;
      /** Протокольная причина отказа (`cwd_outside_workspace`, `too_many_requests`, …). */
      reason: ExecutorErrorReason;
      /** Текст отказа (тот же, что увидит модель). */
      message: string;
      /** Машинный код отказа (`EWORKSPACE`, `ELIMIT`, …). */
      code: string | null;
    };

/** Отрезок журнала. */
export interface BackgroundLogChunk {
  /** Текст отрезка (UTF-8). */
  content: string;
  /** Смещение, с которого прочитан отрезок. */
  offset: number;
  /** Смещение следующего чтения. */
  nextOffset: number;
}

/** Параметры чтения журнала. */
export interface BackgroundLogsOptions {
  /** Смещение в stdout (байты). */
  stdoutOffset?: number;
  /** Смещение в stderr (байты). */
  stderrOffset?: number;
  /** Размер отрезка на поток (байты); по умолчанию — 64 КиБ, потолок — 256 КиБ. */
  limit?: number;
}

/** Снимок журнала фонового процесса. */
export interface BackgroundLogsResult {
  /** Статус процесса. */
  status: BackgroundProcessStatus;
  /** Код завершения. */
  exitCode: number | null;
  /** Сигнал завершения. */
  signal: string | null;
  /** Отрезок stdout. */
  stdout: BackgroundLogChunk;
  /** Отрезок stderr. */
  stderr: BackgroundLogChunk;
  /** Всего записано байт (stdout + stderr). */
  totalBytes: number;
  /** Хотя бы один поток упёрся в лимит журнала. */
  truncated: boolean;
}

/** Параметры сервиса фоновых процессов. */
export interface BackgroundExecServiceOptions {
  /** Корень workspace — граница containment'а для `cwd`. */
  workspaceRoot: string;
  /** Лимит живых фоновых процессов (по умолчанию — 8). */
  maxProcesses?: number;
  /** Лимит журнала на поток, байт (по умолчанию — 10 МиБ). */
  maxLogBytes?: number;
  /** Каталог журналов (по умолчанию — `<tmp>/synth-exec-bg`). */
  logDir?: string;
  /** Источник времени (для тестов). */
  now?: () => number;
}

/** Внутренняя запись реестра (со служебными полями). */
interface BackgroundEntry extends BackgroundProcessRecord {
  child?: ChildProcess;
  outPath: string;
  errPath: string;
  stdoutStopped: boolean;
  stderrStopped: boolean;
  stdoutChain: Promise<void>;
  stderrChain: Promise<void>;
  timeoutTimer?: NodeJS.Timeout;
  killTimer?: NodeJS.Timeout;
  stopRequested: boolean;
}

/** Файл и аргументы запуска для обеих форм команды (как в core). */
function resolveInvocation(command: ExecCommand): { file: string; args: string[] } {
  if (command.kind === 'shell') {
    return { file: command.shell ?? DEFAULT_SHELL_BINARY, args: ['-c', command.command] };
  }
  return { file: command.file, args: command.args ?? [] };
}

/** Смещение: неотрицательное целое (иначе — 0). */
function clampOffset(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

/** Размер отрезка: по умолчанию 64 КиБ, потолок — 256 КиБ. */
function clampLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return DEFAULT_LOG_READ_LIMIT;
  return Math.min(Math.floor(value), MAX_LOG_READ_LIMIT);
}

/**
 * Сервис фоновых процессов исполнителя.
 *
 * Реестр — **в памяти** процесса исполнителя (in-memory): записи не
 * переживают перезапуск исполнителя, а журналы остаются на диске до
 * очистки (`prune`). Это осознанное отличие от реестра control plane
 * (ADR-111): у исполнителя нет доступа к каталогу данных инстанса.
 */
export class BackgroundExecService {
  private readonly _workspaceRoot: string;
  private readonly _maxProcesses: number;
  private readonly _maxLogBytes: number;
  private readonly _logDir: string;
  private readonly _now: () => number;
  private readonly _entries = new Map<string, BackgroundEntry>();
  /** Зарезервированные, но ещё не зарегистрированные слоты (гонка spawn). */
  private _reserved = 0;
  private _pruneTimer?: NodeJS.Timeout;
  private _disposed = false;

  constructor(opts: BackgroundExecServiceOptions) {
    this._workspaceRoot = opts.workspaceRoot;
    this._maxProcesses = Math.max(1, opts.maxProcesses ?? DEFAULT_MAX_BACKGROUND_PROCESSES);
    this._maxLogBytes = Math.max(1, opts.maxLogBytes ?? DEFAULT_BACKGROUND_MAX_LOG_BYTES);
    this._logDir = opts.logDir ?? DEFAULT_BACKGROUND_LOG_DIR;
    this._now = opts.now ?? ((): number => Date.now());
    this._pruneTimer = setInterval(() => {
      void this.prune().catch(() => undefined);
    }, BACKGROUND_PRUNE_INTERVAL_MS);
    // Таймер очистки не должен держать event loop: процесс исполнителя живёт
    // не из-за него.
    this._pruneTimer.unref?.();
  }

  /** Лимит живых фоновых процессов. */
  get maxProcesses(): number {
    return this._maxProcesses;
  }

  /** Каталог журналов. */
  get logDir(): string {
    return this._logDir;
  }

  /** Число живых фоновых процессов. */
  get runningCount(): number {
    return this._runningCount();
  }

  /**
   * Запустить фоновый процесс.
   *
   * Порядок: containment `cwd` → лимит живых процессов → очистка реестра →
   * запуск. Отказ возвращается **результатом**, а не исключением: причины
   * штатные (`cwd` вне workspace, лимит процессов) и HTTP-слой отдаёт их
   * соответствующим кодом.
   */
  async spawn(input: BackgroundSpawnInput): Promise<BackgroundSpawnOutcome> {
    if (this._disposed) {
      return {
        ok: false,
        reason: 'internal_error',
        message: 'исполнитель остановлен — фоновый запуск недоступен',
        code: null,
      };
    }

    // Containment — до всего остального: процесс вне workspace не запускается.
    const cwd = resolveContainedCwd(this._workspaceRoot, input.cwd);
    if (!cwd.ok) {
      return {
        ok: false,
        reason: 'cwd_outside_workspace',
        message: cwd.message,
        code: 'EWORKSPACE',
      };
    }

    if (this._runningCount() + this._reserved >= this._maxProcesses) {
      return {
        ok: false,
        reason: 'too_many_requests',
        message: `превышен лимит фоновых процессов исполнителя (${this._maxProcesses})`,
        code: 'ELIMIT',
      };
    }

    // Слот резервируем **синхронно**: между проверкой и регистрацией есть
    // await, иначе параллельные запросы проскочили бы лимит.
    this._reserved += 1;
    try {
      // Очистка старых записей — при каждом запуске (дешёвая операция).
      await this.prune();

      const id = `proc_${randomUUID()}`;
      let paths: { out: string; err: string };
      try {
        paths = await this._prepareLogFiles(id);
      } catch (err) {
        return {
          ok: false,
          reason: 'internal_error',
          message: `не удалось подготовить журнал фонового процесса: ${
            err instanceof Error ? err.message : String(err)
          }`,
          code: null,
        };
      }

      const startedAt = this._now();
      const { file, args } = resolveInvocation(input.command);
      const child = spawn(file, args, {
        cwd: cwd.path,
        // Базовое окружение — всё `process.env`; `env` запроса мержится поверх.
        env: { ...process.env, ...(input.env ?? {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
        // Своя группа процессов (POSIX): `stop`/таймаут должны гасить всё дерево,
        // а не только прямого ребёнка — иначе shell-форма, где оболочка форкает
        // команду (`sh -c 'sleep 30'` в busybox/на части раннеров), оставляет
        // потомка живым: он держит унаследованные пайпы, `close` не приходит, и
        // запись висит в `running` до естественного выхода команды. Гарантию
        // «не переживает исполнителя» это не отменяет: `dispose()` гасит группу
        // сам, а при SIGKILL исполнителя осиротевший ребёнок и раньше оставался
        // живым (PR_SET_PDEATHSIG в Node недоступен).
        // На Windows групп процессов в таком виде нет (`process.kill(-pid)`
        // не поддерживается) — там остаётся прямое убийство ребёнка.
        detached: process.platform !== 'win32',
      });

      const entry: BackgroundEntry = {
        id,
        ...(child.pid !== undefined ? { pid: child.pid } : {}),
        command: input.command,
        cwd: cwd.path,
        status: 'running',
        exitCode: null,
        signal: null,
        startedAt,
        stdoutBytes: 0,
        stderrBytes: 0,
        truncated: false,
        child,
        outPath: paths.out,
        errPath: paths.err,
        stdoutStopped: false,
        stderrStopped: false,
        stdoutChain: Promise.resolve(),
        stderrChain: Promise.resolve(),
        stopRequested: false,
      };
      this._entries.set(id, entry);

      // Неудача запуска (нет бинарника, неверный `cwd`) приходит событием
      // 'error'; статус виден в записи реестра (`exitCode` — отрицательный код
      // libuv, например `-2` для ENOENT).
      child.on('error', (err: Error) => {
        console.warn(`[executor] фоновый процесс ${id} не запущен: ${err.message}`);
      });

      child.stdout?.on('data', (chunk: Buffer) => {
        this._onData(entry, 'stdout', chunk);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        this._onData(entry, 'stderr', chunk);
      });
      child.on('close', (code, signal) => {
        this._onClose(entry, code, signal);
      });

      // Таймаут процесса: `SIGTERM`, через 5 с — `SIGKILL`.
      const timeoutMs = input.timeoutMs ?? 0;
      if (timeoutMs > 0) {
        entry.timeoutTimer = setTimeout(() => {
          this._terminate(entry, 'SIGTERM');
        }, timeoutMs);
        entry.timeoutTimer.unref?.();
      }

      return { ok: true, processId: id, pid: child.pid ?? undefined };
    } finally {
      this._reserved -= 1;
    }
  }

  /** Снимок записи реестра; `null` — процесс не найден. */
  status(id: string): BackgroundProcessRecord | null {
    const entry = this._entries.get(id);
    if (!entry) return null;
    return this._snapshot(entry);
  }

  /**
   * Отрезки журнала фонового процесса.
   *
   * `null` — процесс не найден. Для живого процесса отдаётся то, что уже
   * записано; для завершённого — то, что осталось в файлах журнала.
   */
  async logs(id: string, opts: BackgroundLogsOptions = {}): Promise<BackgroundLogsResult | null> {
    const entry = this._entries.get(id);
    if (!entry) return null;
    const limit = clampLimit(opts.limit);
    const stdoutOffset = clampOffset(opts.stdoutOffset);
    const stderrOffset = clampOffset(opts.stderrOffset);
    // Дождаться записи уже принятых кусков: иначе чтение сразу после
    // завершения процесса могло бы не увидеть хвост вывода.
    await Promise.all([entry.stdoutChain, entry.stderrChain]);
    let [stdout, stderr] = await Promise.all([
      this._readLog(entry.outPath, stdoutOffset, limit),
      this._readLog(entry.errPath, stderrOffset, limit),
    ]);
    // Гонка «чтение ↔ последняя дописка»: `close` мог прийти между снимком
    // цепочки записи и чтением файла, тогда терминальный статус уже виден, а
    // байты ещё не на диске. Процесс короткий (например `printf hi`) — поток
    // вывода закрывался бы пустым. Если по счётчикам вывод был, а прочитали
    // пусто — ждём цепочки ещё раз и перечитываем.
    if (entry.stdoutBytes + entry.stderrBytes > 0 && stdout.content === '' && stderr.content === '') {
      await Promise.all([entry.stdoutChain, entry.stderrChain]);
      [stdout, stderr] = await Promise.all([
        this._readLog(entry.outPath, stdoutOffset, limit),
        this._readLog(entry.errPath, stderrOffset, limit),
      ]);
    }
    return {
      status: entry.status,
      exitCode: entry.exitCode,
      signal: entry.signal,
      stdout,
      stderr,
      totalBytes: entry.stdoutBytes + entry.stderrBytes,
      truncated: entry.truncated,
    };
  }

  /**
   * Остановить фоновый процесс.
   *
   * Идемпотентно: повторный вызов не дублирует эскалацию `SIGKILL`.
   * `false` — процесса нет в реестре; для уже завершённого — `true`
   * (операция — no-op, статус процесса не меняется).
   */
  stop(id: string, signal: NodeJS.Signals = 'SIGTERM'): boolean {
    const entry = this._entries.get(id);
    if (!entry) return false;
    if (entry.status === 'running') this._terminate(entry, signal);
    return true;
  }

  /**
   * Очистить реестр: удалить терминальные записи старше часа вместе с
   * файлами журнала. Живые процессы не трогаются.
   */
  async prune(): Promise<void> {
    const now = this._now();
    const stale: BackgroundEntry[] = [];
    for (const entry of this._entries.values()) {
      if (entry.status === 'running') continue;
      const finishedAt = entry.finishedAt ?? entry.startedAt;
      if (now - finishedAt < BACKGROUND_PRUNE_TTL_MS) continue;
      stale.push(entry);
    }
    for (const entry of stale) {
      this._entries.delete(entry.id);
      await Promise.all([
        rm(entry.outPath, { force: true }).catch(() => undefined),
        rm(entry.errPath, { force: true }).catch(() => undefined),
      ]);
    }
  }

  /**
   * Остановить сервис: убить живые процессы и снять таймер очистки.
   *
   * `SIGTERM` всем живым процессам, через 2 с — `SIGKILL` тем, кто не
   * завершился. Зомби-процессов не остаётся.
   */
  async dispose(): Promise<void> {
    this._disposed = true;
    if (this._pruneTimer) {
      clearInterval(this._pruneTimer);
      this._pruneTimer = undefined;
    }
    const running = [...this._entries.values()].filter((entry) => entry.status === 'running');
    for (const entry of running) {
      this._terminate(entry, 'SIGTERM');
    }
    if (running.length === 0) return;
    await this._waitExit(running, DISPOSE_GRACE_MS);
    for (const entry of running) {
      if (entry.status !== 'running') continue;
      this._signal(entry, 'SIGKILL');
    }
    await this._waitExit(running, DISPOSE_GRACE_MS);
  }

  // --- внутреннее ---------------------------------------------------------

  /** Снимок записи реестра (без служебных полей). */
  private _snapshot(entry: BackgroundEntry): BackgroundProcessRecord {
    return {
      id: entry.id,
      ...(entry.pid !== undefined ? { pid: entry.pid } : {}),
      command: entry.command,
      cwd: entry.cwd,
      status: entry.status,
      exitCode: entry.exitCode,
      signal: entry.signal,
      startedAt: entry.startedAt,
      ...(entry.finishedAt !== undefined ? { finishedAt: entry.finishedAt } : {}),
      ...(entry.durationMs !== undefined ? { durationMs: entry.durationMs } : {}),
      stdoutBytes: entry.stdoutBytes,
      stderrBytes: entry.stderrBytes,
      truncated: entry.truncated,
    };
  }

  /** Число живых процессов. */
  private _runningCount(): number {
    let count = 0;
    for (const entry of this._entries.values()) {
      if (entry.status === 'running') count += 1;
    }
    return count;
  }

  /** Подготовить каталог и файлы журнала (`0700` / `0600`). */
  private async _prepareLogFiles(id: string): Promise<{ out: string; err: string }> {
    await mkdir(this._logDir, { recursive: true, mode: 0o700 });
    await chmod(this._logDir, 0o700).catch(() => undefined);
    const out = join(this._logDir, `${id}.out.log`);
    const err = join(this._logDir, `${id}.err.log`);
    await Promise.all([ensureLogFile(out), ensureLogFile(err)]);
    return { out, err };
  }

  /** Порция данных потока → журнал (с учётом лимита на поток). */
  private _onData(entry: BackgroundEntry, stream: 'stdout' | 'stderr', chunk: Buffer): void {
    const stopped = stream === 'stdout' ? entry.stdoutStopped : entry.stderrStopped;
    if (stopped) return;
    const written = stream === 'stdout' ? entry.stdoutBytes : entry.stderrBytes;
    const allowed = this._maxLogBytes - written;
    if (allowed <= 0) {
      this._markStreamTruncated(entry, stream);
      return;
    }
    const data = chunk.length > allowed ? chunk.subarray(0, allowed) : chunk;
    if (stream === 'stdout') entry.stdoutBytes += data.length;
    else entry.stderrBytes += data.length;
    if (data.length < chunk.length) this._markStreamTruncated(entry, stream);
    const path = stream === 'stdout' ? entry.outPath : entry.errPath;
    // Записи в один файл — строго по очереди: куски не перемешиваются.
    const chain = stream === 'stdout' ? entry.stdoutChain : entry.stderrChain;
    const next = chain
      .then(() => appendFile(path, data, { mode: 0o600 }))
      .catch(() => undefined);
    if (stream === 'stdout') entry.stdoutChain = next;
    else entry.stderrChain = next;
  }

  /** Поток упёрся в лимит журнала — дальше в него не пишем. */
  private _markStreamTruncated(entry: BackgroundEntry, stream: 'stdout' | 'stderr'): void {
    if (stream === 'stdout') entry.stdoutStopped = true;
    else entry.stderrStopped = true;
    entry.truncated = true;
  }

  /** Процесс завершился: терминальный статус и время жизни. */
  private _onClose(
    entry: BackgroundEntry,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (entry.timeoutTimer) {
      clearTimeout(entry.timeoutTimer);
      entry.timeoutTimer = undefined;
    }
    if (entry.killTimer) {
      clearTimeout(entry.killTimer);
      entry.killTimer = undefined;
    }
    const finishedAt = this._now();
    entry.finishedAt = finishedAt;
    entry.durationMs = Math.max(0, finishedAt - entry.startedAt);
    entry.exitCode = code ?? null;
    entry.signal = signal ?? null;
    entry.status = signal ? 'killed' : code === 0 ? 'exited' : 'failed';
    entry.child = undefined;
  }

  /**
   * Отправить сигнал процессу и его потомкам.
   *
   * POSIX: ребёнок запускается лидером собственной группы (`detached: true`),
   * поэтому `kill(-pid)` достаёт всё дерево. Иначе сигнал получает только
   * оболочка, а форкнутая ею команда остаётся жить: `close` не приходит, пока
   * потомок не закроет пайпы. Если группы уже нет — падаем на прямое убийство.
   */
  private _signal(entry: BackgroundEntry, signal: NodeJS.Signals): void {
    const child = entry.child;
    if (!child) return;
    const pid = child.pid;
    if (process.platform !== 'win32' && pid !== undefined) {
      try {
        process.kill(-pid, signal);
        return;
      } catch {
        // Группы нет (или pid не лидер) — ниже пробуем прямое убийство.
      }
    }
    try {
      child.kill(signal);
    } catch {
      // Процесс уже завершён (или сигнал недопустим) — не страшно.
    }
  }

  /**
   * Остановить процесс сигналом и запланировать эскалацию.
   *
   * Повторный вызов ничего не делает: эскалация `SIGKILL` не дублируется.
   */
  private _terminate(entry: BackgroundEntry, signal: NodeJS.Signals): void {
    if (entry.status !== 'running') return;
    if (entry.stopRequested) return;
    entry.stopRequested = true;
    this._signal(entry, signal);
    entry.killTimer = setTimeout(() => {
      this._signal(entry, 'SIGKILL');
    }, BACKGROUND_KILL_GRACE_MS);
    entry.killTimer.unref?.();
  }

  /** Прочитать отрезок файла журнала. */
  private async _readLog(
    path: string,
    offset: number,
    limit: number,
  ): Promise<BackgroundLogChunk> {
    let handle;
    try {
      handle = await open(path, 'r');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { content: '', offset: 0, nextOffset: 0 };
      }
      throw err;
    }
    try {
      const stat = await handle.stat();
      const size = stat.size;
      const start = Math.min(Math.max(0, offset), size);
      const length = Math.min(limit, size - start);
      if (length <= 0) return { content: '', offset: start, nextOffset: start };
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, start);
      return {
        content: buffer.toString('utf8'),
        offset: start,
        nextOffset: start + length,
      };
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  /** Дождаться завершения процессов (до указанного предела). */
  private async _waitExit(entries: BackgroundEntry[], timeoutMs: number): Promise<void> {
    // Реальное время: инъекция `now` в тестах не обязана идти вперёд, а
    // ожидание завершения процесса — всегда по часам.
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (entries.every((entry) => entry.status !== 'running')) return;
      if (Date.now() >= deadline) return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 50);
        timer.unref?.();
      });
    }
  }
}

/** Создать файл журнала с правами `0600` (если его ещё нет). */
async function ensureLogFile(path: string): Promise<void> {
  await appendFile(path, '', { mode: 0o600 });
  await chmod(path, 0o600).catch(() => undefined);
}

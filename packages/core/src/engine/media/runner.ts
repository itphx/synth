/**
 * Медиа-раннер (ADR-115 × ADR-077): единая точка запуска `ffmpeg`.
 *
 * ## Зачем отдельный слой
 *
 * Обработка медиа (транскод аудио, кадры видео, миниатюры) раньше запускала
 * `spawn('ffmpeg', …)` **локально в control plane**. В split-режиме slim-образ
 * backend не содержит `ffmpeg`, а исполнитель — содержит, поэтому derive
 * деградировал: проба через порт говорила «программа есть», а локальный запуск
 * падал. Здесь две реализации одной операции:
 *
 *  - **inline** (`ExecutionPort.isRemote !== true`) — локальный `spawn('ffmpeg',
 *    argv)` без shell во временном каталоге `tmpdir()`;
 *  - **remote** — временный каталог под `{workspacesRoot}/.synth-media/<uuid>`
 *    (общий том, смонтированный в control plane и в исполнителе), файлы туда
 *    копируются/читаются потоком, а команда уходит `ExecutionPort.execute` с
 *    `requires: ['ffmpeg']`. Маршрутизацией занимается remote-порт: если нужного
 *    бинаря нет ни у одного адреса пула — ошибка причины `dependency_missing`
 *    (вызывающий деградирует штатно).
 *
 * ## Контракт ошибок
 *
 * Раннер ничего не бросает наружу: любой сбой (нет бинаря, ненулевой код,
 * таймаут, отмена, ошибка ФС) — типизированный `MediaRunResult`
 * (`ok: false` + `reason`). Временный каталог удаляется в `finally` при любом
 * исходе (best-effort).
 *
 * ## Память
 *
 * Входной объект **не читается целиком**: blob → файл через
 * `BlobStore.readStream` + `pipeline`. Выход читается из файлов (в remote
 * stdout транспорта — текст JSON, бинарные данные через него не ходят), поэтому
 * размер результата ограничен вызывающим (`MAX_DERIVED_BYTES`/миниатюра).
 *
 * Все внешние эффекты (spawn, порт, ФС, uuid) инъектируются — тесты не требуют
 * настоящего `ffmpeg`.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { isExecutionError, type ExecutionPort } from '../../execution/ports/index.js';
import type { BlobStore } from '../../storage/ports/blob-store.js';

/** Таймаут одного вызова `ffmpeg` по умолчанию, мс (зависший процесс не держит ход). */
export const MEDIA_FFMPEG_TIMEOUT_MS = 60_000;

/** Каталог временных файлов медиа-раннера внутри `workspacesRoot` (общий том). */
export const MEDIA_TMP_DIR_NAME = '.synth-media';

/** Имя входного файла во временном каталоге. */
export const MEDIA_INPUT_NAME = 'input.bin';

/** Предел буфера stdout (inline): больше — процесс гасится, результат `max_output`. */
export const MEDIA_MAX_STDOUT_BYTES = 32 * 1024 * 1024;

/** Предел размера одного выходного файла по умолчанию, байт (64 МиБ). */
export const MEDIA_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/** Причина, по которой медиа-операция не дала результата. */
export type MediaRunFailure =
  /** `ffmpeg` не найден в окружении исполнения. */
  | 'no_ffmpeg'
  /** Бинарь не покрыт инвентарём пула исполнителей (remote, ADR-077). */
  | 'dependency_missing'
  /** Таймаут вызова. */
  | 'timeout'
  /** Отмена по `AbortSignal`. */
  | 'aborted'
  /** Вывод превысил лимит буфера. */
  | 'max_output'
  /** Прочие сбои (ненулевой код, ФС, пустой результат). */
  | 'failed';

/** Результат запуска `ffmpeg` (исключений наружу нет). */
export interface MediaRunResult {
  ok: boolean;
  /** Содержимое выходных файлов по порядку (при `ok`). */
  outputs: Buffer[];
  /** Причина отказа. */
  reason?: MediaRunFailure;
  /** stderr процесса (хвост) — для лога. */
  stderr?: string;
  /** Текст ошибки — для лога. */
  error?: string;
}

/** Запрос на запуск `ffmpeg`. */
export interface MediaRunRequest {
  /** argv без имени бинаря; `pipe:0`/`{input}` и `pipe:1`/`{output}` — подстановки путей. */
  args: string[];
  /** Blob-объект входа: копируется во временный каталог потоком. */
  inputBlobPath?: string;
  /** Готовые байты входа (инъекция/совместимость): пишутся во временный файл. */
  inputBytes?: Buffer;
  /**
   * Куда собирать результат: `stdout` (inline, прежнее поведение derive) или
   * файл. В remote-режиме stdout недоступен (бинарные данные через JSON-транспорт
   * не ходят) — режим принудительно файловый.
   */
  capture?: 'stdout' | 'file';
  /** Имя выходного файла относительно временного каталога (по умолчанию `output.bin`). */
  outputName?: string;
  /** Результат — несколько файлов по шаблону (`frame-%03d.jpg`): читаются по порядку. */
  outputPattern?: boolean;
  /** Таймаут вызова, мс (по умолчанию `MEDIA_FFMPEG_TIMEOUT_MS`). */
  timeoutMs?: number;
  /**
   * Предел размера **каждого** выходного файла, байт (по умолчанию
   * `MEDIA_MAX_OUTPUT_BYTES`). Проверяется через `stat` **до** чтения: большой
   * транскод не попадает в память (иначе — OOM на крупных видео/аудио).
   */
  maxOutputBytes?: number;
  /** Отмена («Стоп» сессии). */
  signal?: AbortSignal;
  /** Рабочий каталог (inline; remote всегда работает внутри своего temp-каталога). */
  cwd?: string;
}

/** Вход локального запуска `ffmpeg`. */
export interface MediaSpawnInput {
  args: string[];
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

/** Результат локального запуска `ffmpeg`. */
export interface MediaSpawnResult {
  ok: boolean;
  stdout: Buffer;
  stderr: string;
  reason?: 'no_ffmpeg' | 'timeout' | 'aborted' | 'max_output' | 'failed';
  /** Код ошибки запуска (`ENOENT`, …). */
  code?: string | number | null;
  error?: string;
}

/** Запуск `ffmpeg` локально (инъекция тестов). */
export type MediaSpawner = (input: MediaSpawnInput) => Promise<MediaSpawnResult>;

/** ФС-операции раннера (инъекция тестов). */
export interface MediaRunnerFs {
  mkdtemp(prefix: string): Promise<string>;
  mkdir(path: string): Promise<void>;
  createWriteStream(path: string): Writable;
  writeFile(path: string, data: Buffer): Promise<void>;
  readFile(path: string): Promise<Buffer>;
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<{ size: number } | null>;
  rm(path: string): Promise<void>;
}

export interface MediaRunnerDeps {
  /** Blob-хранилище: входной объект входа (потоком). */
  blobs: Pick<BlobStore, 'readStream'> & Partial<Pick<BlobStore, 'read'>>;
  /** Порт исполнения: задан и `isRemote` — команда уходит исполнителю. */
  executionPort?: ExecutionPort;
  /** Корень workspace (общий том с исполнителем; обязателен в remote). */
  workspacesRoot?: string;
  /** Локальный запуск (по умолчанию — реальный `spawn('ffmpeg')`). */
  spawn?: MediaSpawner;
  /** ФС-операции (по умолчанию — `node:fs/promises`). */
  fs?: Partial<MediaRunnerFs>;
  /** Генератор имени временного каталога (тесты). */
  uuid?: () => string;
  /** Лог предупреждений. */
  log?: (message: string) => void;
}

/** Минимальный контракт раннера (инъекция в derive/миниатюры без класса). */
export interface MediaRunnerLike {
  readonly isRemote: boolean;
  run(request: MediaRunRequest): Promise<MediaRunResult>;
}

/** ФС по умолчанию (ошибка `stat` → «файла нет»). */
const DEFAULT_FS: MediaRunnerFs = {
  mkdtemp: (prefix) => mkdtemp(prefix),
  mkdir: async (path) => {
    await mkdir(path, { recursive: true });
  },
  createWriteStream: (path) => createWriteStream(path),
  writeFile: async (path, data) => {
    await writeFile(path, data);
  },
  readFile: (path) => readFile(path),
  readdir: (path) => readdir(path),
  stat: (path) => stat(path).then((info) => ({ size: info.size })).catch(() => null),
  rm: async (path) => {
    await rm(path, { recursive: true, force: true });
  },
};

/**
 * Реальный запуск `ffmpeg`: argv без shell, сбор stdout/stderr, таймаут и отмена.
 *
 * Ничего не бросает: `ENOENT` → `no_ffmpeg`, таймаут/отмена → соответствующие
 * причины, ненулевой код → `failed` с хвостом stderr.
 */
function defaultSpawner(input: MediaSpawnInput): Promise<MediaSpawnResult> {
  return new Promise<MediaSpawnResult>((done) => {
    let settled = false;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;

    const finish = (result: MediaSpawnResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', onAbort);
      done(result);
    };

    const stderrText = (): string => Buffer.concat(stderr).toString('utf-8').trim();

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('ffmpeg', input.args, {
        cwd: input.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(input.signal ? { signal: input.signal } : {}),
      });
    } catch (err) {
      done({
        ok: false,
        stdout: Buffer.alloc(0),
        stderr: '',
        reason: (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'no_ffmpeg' : 'failed',
        code: (err as NodeJS.ErrnoException).code ?? null,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({
        ok: false,
        stdout: Buffer.alloc(0),
        stderr: stderrText(),
        reason: 'timeout',
        error: `ffmpeg не завершился за ${input.timeoutMs} мс`,
      });
    }, input.timeoutMs);
    timer.unref?.();

    const onAbort = (): void => {
      child.kill('SIGKILL');
      finish({
        ok: false,
        stdout: Buffer.alloc(0),
        stderr: stderrText(),
        reason: 'aborted',
        error: 'ffmpeg отменён',
      });
    };
    input.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MEDIA_MAX_STDOUT_BYTES) {
        child.kill('SIGKILL');
        finish({
          ok: false,
          stdout: Buffer.alloc(0),
          stderr: stderrText(),
          reason: 'max_output',
          error: `вывод ffmpeg превысил ${MEDIA_MAX_STDOUT_BYTES} байт`,
        });
        return;
      }
      stdout.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (err) => {
      finish({
        ok: false,
        stdout: Buffer.alloc(0),
        stderr: stderrText(),
        reason: (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'no_ffmpeg' : 'failed',
        code: (err as NodeJS.ErrnoException).code ?? null,
        error: err.message,
      });
    });
    child.on('close', (code) => {
      const stderrValue = stderrText();
      if (code === 0) {
        finish({ ok: true, stdout: Buffer.concat(stdout), stderr: stderrValue });
        return;
      }
      const tail = stderrValue.slice(-400);
      finish({
        ok: false,
        stdout: Buffer.alloc(0),
        stderr: stderrValue,
        reason: 'failed',
        code,
        error: `ffmpeg вышел с кодом ${code}${tail ? `: ${tail}` : ''}`,
      });
    });
  });
}

/**
 * Запуск `ffmpeg` с argv, входным и выходным файлами.
 *
 * Inline — временный каталог в `tmpdir()` и локальный `spawn`; remote —
 * временный каталог под `{workspacesRoot}/.synth-media/<uuid>` и
 * `ExecutionPort.execute` с `requires: ['ffmpeg']`. Временные файлы удаляются
 * всегда (успех, ошибка, отмена).
 */
export class MediaRunner implements MediaRunnerLike {
  private readonly _deps: MediaRunnerDeps;
  private readonly _fs: MediaRunnerFs;
  private readonly _spawn: MediaSpawner;

  constructor(deps: MediaRunnerDeps) {
    this._deps = deps;
    this._fs = { ...DEFAULT_FS, ...(deps.fs ?? {}) };
    this._spawn = deps.spawn ?? defaultSpawner;
  }

  /** Команды исполняются вне процесса control plane (ADR-077). */
  get isRemote(): boolean {
    return this._deps.executionPort?.isRemote === true;
  }

  async run(request: MediaRunRequest): Promise<MediaRunResult> {
    if (this.isRemote) return this._runRemote(request);
    return this._runInline(request);
  }

  /** Inline: локальный `spawn` во временном каталоге `tmpdir()`. */
  private async _runInline(request: MediaRunRequest): Promise<MediaRunResult> {
    let dir: string | undefined;
    try {
      dir = await this._fs.mkdtemp(join(tmpdir(), 'synth-media-'));
      return await this._runInDir(dir, request);
    } catch (err) {
      return failed(err);
    } finally {
      await this._cleanup(dir);
    }
  }

  /** Remote: временный каталог на общем томе + `ExecutionPort.execute`. */
  private async _runRemote(request: MediaRunRequest): Promise<MediaRunResult> {
    const port = this._deps.executionPort;
    const root = this._deps.workspacesRoot ? resolve(this._deps.workspacesRoot) : '';
    if (!port || !root) {
      return {
        ok: false,
        outputs: [],
        reason: 'failed',
        error: 'remote-медиа: не задан workspacesRoot (общий том с исполнителем)',
      };
    }
    let dir: string | undefined;
    try {
      const base = join(root, MEDIA_TMP_DIR_NAME);
      await this._fs.mkdir(base);
      dir = join(base, this._deps.uuid?.() ?? randomUUID());
      await this._fs.mkdir(dir);

      const paths = await this._materializeInput(dir, request);
      if (!paths) return { ok: false, outputs: [], reason: 'failed', error: 'входной объект не прочитан' };

      // В remote stdout транспорта — строка JSON: бинарные данные собираем только
      // из файлов, поэтому `pipe:1`/`{output}` всегда указывают на файл.
      const args = resolveArgs(request.args, paths.inputPath, paths.outputPath, false);
      let result;
      try {
        result = await port.execute({
          command: { kind: 'argv', file: 'ffmpeg', args },
          cwd: dir,
          requires: ['ffmpeg'],
          timeoutMs: request.timeoutMs ?? MEDIA_FFMPEG_TIMEOUT_MS,
          ...(request.signal ? { signal: request.signal } : {}),
        });
      } catch (err) {
        return executionFailed(err);
      }
      return await this._collectFiles(dir, request, result.stderr);
    } catch (err) {
      return failed(err);
    } finally {
      await this._cleanup(dir);
    }
  }

  /** Общий шаг: входной файл + запуск + сбор результата (inline). */
  private async _runInDir(dir: string, request: MediaRunRequest): Promise<MediaRunResult> {
    const paths = await this._materializeInput(dir, request);
    if (!paths) return { ok: false, outputs: [], reason: 'failed', error: 'входной объект не прочитан' };

    const captureStdout = (request.capture ?? 'stdout') === 'stdout';
    const args = resolveArgs(request.args, paths.inputPath, paths.outputPath, captureStdout);
    const result = await this._spawn({
      args,
      cwd: request.cwd ?? dir,
      timeoutMs: request.timeoutMs ?? MEDIA_FFMPEG_TIMEOUT_MS,
      ...(request.signal ? { signal: request.signal } : {}),
    });
    if (!result.ok) {
      return {
        ok: false,
        outputs: [],
        ...(result.reason ? { reason: result.reason } : {}),
        ...(result.stderr ? { stderr: result.stderr } : {}),
        ...(result.error ? { error: result.error } : {}),
      };
    }
    if (captureStdout) {
      return {
        ok: true,
        outputs: result.stdout.length > 0 ? [result.stdout] : [],
        ...(result.stderr ? { stderr: result.stderr } : {}),
      };
    }
    return await this._collectFiles(dir, request, result.stderr);
  }

  /**
   * Материализация входа: blob — потоком через `readStream`, готовые байты —
   * обычной записью. `null` — объекта нет/он пуст (ffmpeg не запускается).
   */
  private async _materializeInput(
    dir: string,
    request: MediaRunRequest,
  ): Promise<{ inputPath: string; outputPath: string } | null> {
    const inputPath = join(dir, MEDIA_INPUT_NAME);
    const outputPath = join(dir, request.outputName ?? 'output.bin');

    if (request.inputBytes) {
      if (request.inputBytes.length === 0) return null;
      await this._fs.writeFile(inputPath, request.inputBytes);
    } else if (request.inputBlobPath) {
      const stream = await this._deps.blobs.readStream(request.inputBlobPath).catch(() => null);
      if (!stream) return null;
      try {
        await pipeline(stream, this._fs.createWriteStream(inputPath));
      } catch {
        return null;
      }
      const info = await this._fs.stat(inputPath);
      if (!info || info.size === 0) return null;
    } else {
      return null;
    }
    return { inputPath, outputPath };
  }

  /** Чтение результата из файлов: один файл либо набор по шаблону (по порядку). */
  private async _collectFiles(
    dir: string,
    request: MediaRunRequest,
    stderr?: string,
  ): Promise<MediaRunResult> {
    const outputName = request.outputName ?? 'output.bin';
    const outputPath = join(dir, outputName);
    const files: string[] = [];
    if (request.outputPattern) {
      const prefix = outputName.slice(0, outputName.indexOf('%') >= 0 ? outputName.indexOf('%') : outputName.length);
      const entries = await this._fs.readdir(dir).catch(() => [] as string[]);
      files.push(
        ...entries
          .filter((name) => name.startsWith(prefix) && name !== MEDIA_INPUT_NAME)
          .sort()
          .map((name) => join(dir, name)),
      );
    } else {
      files.push(outputPath);
    }

    const outputs: Buffer[] = [];
    const maxBytes = request.maxOutputBytes ?? MEDIA_MAX_OUTPUT_BYTES;
    for (const file of files) {
      // Размер проверяется до чтения: крупный транскод не должен попасть в память.
      const info = await this._fs.stat(file).catch(() => null);
      if (info && info.size > maxBytes) {
        return {
          ok: false,
          outputs: [],
          reason: 'max_output',
          ...(stderr ? { stderr } : {}),
          error: `выходной файл ffmpeg превысил ${maxBytes} байт`,
        };
      }
      const bytes = await this._fs.readFile(file).catch(() => null);
      if (bytes) outputs.push(bytes);
    }
    if (outputs.length === 0) {
      return {
        ok: false,
        outputs: [],
        reason: 'failed',
        ...(stderr ? { stderr } : {}),
        error: 'ffmpeg не создал выходной файл',
      };
    }
    return { ok: true, outputs, ...(stderr ? { stderr } : {}) };
  }

  /** Уборка временного каталога (best-effort, никогда не бросает). */
  private async _cleanup(dir: string | undefined): Promise<void> {
    if (!dir) return;
    await this._fs.rm(dir).catch((err: unknown) => {
      this._deps.log?.(
        `[media-runner] не удалось удалить временный каталог ${dir}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  }
}

/** Создать медиа-раннер (фабрика по образцу портов). */
export function createMediaRunner(deps: MediaRunnerDeps): MediaRunner {
  return new MediaRunner(deps);
}

/**
 * Подстановка путей в argv.
 *
 * `pipe:0`/`{input}` → входной файл, `pipe:1`/`{output}` → выходной. В
 * stdout-режиме `pipe:1` остаётся stdout (inline), в файловом — заменяется путём.
 */
export function resolveArgs(
  args: string[],
  inputPath: string,
  outputPath: string,
  captureStdout: boolean,
): string[] {
  return args.map((arg) => {
    if (arg === 'pipe:0' || arg === '{input}') return inputPath;
    if (arg === '{output}') return outputPath;
    if (arg === 'pipe:1') return captureStdout ? arg : outputPath;
    return arg;
  });
}

/** Ошибка ФС/прочего шага раннера → типизированный результат. */
function failed(err: unknown): MediaRunResult {
  return {
    ok: false,
    outputs: [],
    reason: 'failed',
    error: err instanceof Error ? err.message : String(err),
  };
}

/** Ошибка порта исполнения → причина раннера (деградация вызывающего штатная). */
function executionFailed(err: unknown): MediaRunResult {
  if (isExecutionError(err)) {
    const reason: MediaRunFailure =
      err.reason === 'dependency_missing'
        ? 'dependency_missing'
        : err.reason === 'aborted'
          ? 'aborted'
          : err.reason === 'timeout'
            ? 'timeout'
            : err.reason === 'max_output'
              ? 'max_output'
              : 'failed';
    return {
      ok: false,
      outputs: [],
      reason,
      ...(err.stderr ? { stderr: err.stderr } : {}),
      error: err.message,
    };
  }
  return failed(err);
}

/**
 * PROP-138 (Ф1, слайс 138a): узкий runtime для **inline**-плагинных тулов.
 *
 * ## Зачем
 *
 * Плагинный тул с capability `file_read`/`file_write`/`shell`/`search`/
 * `git_read`/`git_write` должен работать в контуре исполнителя сессии, а не
 * в control plane: в split-топологии рабочий каталог живёт на исполнителе
 * (PROP-135), а прямой доступ к ФС control plane — неподдерживаемый путь
 * (прямой `node:fs`/`child_process` в inline-плагине — мимо разрешений и
 * аудита).
 *
 * ## Как
 *
 * Runtime — тонкая обёртка над **портом исполнения сессии**
 * (`ExecutionPort`): тот же порт, что у встроенных шелл/git/файловых тулов
 * (`ctx.extra.executionPort`), поэтому физический исполнитель (inline в
 * процессе или удалённый) остаётся взаимозаменяемым, а capability-тул
 * получает ровно ту же среду, что и встроенный.
 *
 * ## Чего runtime НЕ делает
 *
 * - не даёт доступа к internals ядра (`extra`/`dataDir` плагину не
 *   передаются — ADR-090);
 * - не обходит permission-слой: runtime — транспорт, право на операцию
 *   решает хост по capability тула;
 * - не расширяет контракт порта: используются только `execute` и
 *   `ExecutionFs` (`download`/`upload`/`stat`/`readdir`/`realpath`).
 *
 * ## Границы слайса
 *
 * Это **inline**-контур: объект живёт в процессе ядра и работает с тем же
 * портом. Out-of-process (плагин в отдельном процессе) получает runtime по
 * wire-протоколу v2 — следующий слайс (138b), здесь его нет.
 */

import type {
  PluginRuntime,
  PluginRuntimeExecOptions,
  PluginRuntimeExecResult,
} from '@itphx/synth-shared';
import { ExecutionFsUnavailableError, type ExecutionFs, type ExecutionPort } from './ports/index.js';

/**
 * Потолок чтения файла runtime'ом по умолчанию (16 МиБ).
 *
 * Явный `maxBytes` у вызова важнее дефолта; дефолт — защита от «прочитал
 * весь репозиторий в память» (у встроенных тулов читается текст постранично).
 */
export const PLUGIN_RUNTIME_DEFAULT_MAX_READ_BYTES = 16 * 1024 * 1024;

/**
 * Машинный код ошибки runtime плагина.
 *
 * - `invalid_argv` — команда задана неверно (пустой argv).
 */
export type PluginRuntimeErrorCode = 'invalid_argv';

/**
 * Типизированная ошибка runtime плагина.
 *
 * Имя класса фиксировано (`PluginRuntimeError`) — по нему ошибка опознаётся
 * структурно: `instanceof` ненадёжен (копии класса src/dist), как у
 * `ExecutionError`/`FsPathError`.
 */
export class PluginRuntimeError extends Error {
  readonly code: PluginRuntimeErrorCode;

  constructor(code: PluginRuntimeErrorCode, message: string) {
    super(message);
    this.name = 'PluginRuntimeError';
    this.code = code;
  }
}

/**
 * Структурная проверка `PluginRuntimeError` (устойчива к копиям класса).
 */
export function isPluginRuntimeError(value: unknown): value is PluginRuntimeError {
  if (value instanceof PluginRuntimeError) return true;
  if (typeof value !== 'object' || value === null) return false;
  const e = value as { name?: unknown; code?: unknown; message?: unknown };
  return e.name === 'PluginRuntimeError' && typeof e.code === 'string' && typeof e.message === 'string';
}

/**
 * Runtime плагинного тула поверх порта исполнения сессии.
 *
 * @param port — порт сессии (`ctx.extra.executionPort`): inline или удалённый.
 * @returns узкий runtime для `ctx.runtime` плагинного тула.
 */
export function createPluginRuntime(port: ExecutionPort): PluginRuntime {
  /** FS-часть порта; нет её — исполняющий не умеет файловые операции. */
  const requireFs = (): ExecutionFs => {
    const fs = port.fs;
    if (!fs) throw new ExecutionFsUnavailableError();
    return fs;
  };

  return {
    async exec(argv: string[], opts?: PluginRuntimeExecOptions): Promise<PluginRuntimeExecResult> {
      if (!Array.isArray(argv) || argv.length === 0) {
        throw new PluginRuntimeError(
          'invalid_argv',
          'plugin runtime: exec requires a non-empty argv array ([file, ...args])',
        );
      }
      const [file, ...args] = argv;
      if (!file) {
        throw new PluginRuntimeError(
          'invalid_argv',
          'plugin runtime: exec requires a non-empty argv array ([file, ...args])',
        );
      }
      // Ошибки порта (`ExecutionError`) пробрасываются как есть: плагин видит
      // текст ошибки и различает причины по коду.
      const result = await port.execute({
        command: { kind: 'argv', file, args },
        ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
        ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      });
      return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
    },
    fs: {
      async readFile(path: string, maxBytes?: number): Promise<Buffer> {
        return await requireFs().download(path, maxBytes ?? PLUGIN_RUNTIME_DEFAULT_MAX_READ_BYTES);
      },
      async writeFile(path: string, data: Buffer | string): Promise<void> {
        const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf-8');
        await requireFs().upload(path, bytes, { ifExists: 'overwrite' });
      },
      async stat(path: string) {
        return await requireFs().stat(path);
      },
      async readdir(path: string) {
        return await requireFs().readdir(path);
      },
      async realpath(path: string) {
        return await requireFs().realpath(path);
      },
    },
  };
}

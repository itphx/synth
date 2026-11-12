/**
 * Вызовы FS-операций порта из тулов — общий слой (PROP-135, Ф2).
 *
 * ## Зачем
 *
 * Файловые тулы (`write_file`/`edit_file`/`patch`/…) ходят в ФС **через
 * порт** (`ExecutionFs`), и у них две общие потребности:
 *
 * - **понятный отказ вместо исключения.** `ExecutionFsUnavailableError`
 *   (удалённый исполнитель без `features.fs`) — это не «путь не найден» и не
 *   сбой ФС: контура нет вовсе. Модель должна увидеть текст про `features.fs`
 *   (тот же, что у читающих тулов), а не стек ошибки;
 * - **«пути нет» — обычное состояние,** а не сбой: `stat` отсутствующего
 *   пути возвращает `null`, и вызывающий решает сам (новый файл / отказ).
 *
 * Обе механики живут здесь, а не в каждом туле: тексты и коды не должны
 * разъезжаться между тулами.
 */

import type { ToolResult } from '@itphx/synth-shared';
import {
  isExecutionFsUnavailableError,
  isFsPathError,
  type ExecutionFs,
  type FsStat,
} from './ports/index.js';
import { FS_UNAVAILABLE_TEXT } from './fs-perimeter.js';

/** Результат вызова FS-операции порта (значение или отказ тула). */
export type FsCallResult<T> = { ok: true; value: T } | { ok: false; result: ToolResult };

/**
 * Вызов FS-операции порта.
 *
 * `ExecutionFsUnavailableError` (удалённый исполнитель без `features.fs`) —
 * понятный отказ про `features.fs`, а не падение с текстом исключения: тот
 * же текст отдают читающие тулы (`fs-read.ts`). Прочие ошибки пробрасываются
 * (их видно по типу/тексту — как раньше).
 */
export async function fsCall<T>(run: () => Promise<T>): Promise<FsCallResult<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (err) {
    if (isExecutionFsUnavailableError(err)) {
      return { ok: false, result: { content: FS_UNAVAILABLE_TEXT, isError: true } };
    }
    throw err;
  }
}

/**
 * Сведения о существующем пути; `null` — **пути нет** (обычное состояние:
 * файл создаётся заново).
 *
 * Прочие ошибки ФС (нет доступа, путь не разрешается) — не молчание: они
 * пробрасываются дальше (тул вернёт отказ, а не запишет «куда попало»).
 */
export async function statOrNull(fs: ExecutionFs, path: string): Promise<FsStat | null> {
  try {
    return await fs.stat(path);
  } catch (err) {
    if (isFsPathError(err) && err.code === 'not_found') return null;
    throw err;
  }
}

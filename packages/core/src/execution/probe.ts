/**
 * Проба бинарника через порт исполнения (ADR-078, ADR-077).
 *
 * Единственная реализация пробы «есть ли программа»:
 *
 *   - `ENOENT` (бинарника нет) → `false` — программа отсутствует;
 *   - любая прочая ошибка (таймаут, ненулевой код выхода, `EACCES`) → `true`:
 *     **fail-open** — неоднозначная ошибка не должна блокировать инструмент
 *     (ADR-078).
 *
 * Проба выполняется **через порт**, а не напрямую через `execFile`: в
 * split-режиме программа нужна там, где команда будет выполнена — на
 * исполнителе (ADR-077).
 */

import type { ExecutionPort } from './ports/index.js';

/** Таймаут пробы, мс. */
export const PROBE_TIMEOUT_MS = 3_000;

/**
 * Лимит буфера вывода пробы — прежний дефолт `execFile` (1 МБ). Сохраняем
 * дословно: смена лимита изменила бы fail-open-семантику пробы.
 */
export const PROBE_MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * Проба бинарника через порт: `bin --version` → признак наличия.
 *
 * @param port порт исполнения (команда уходит туда, где будет выполнена)
 * @param bin имя программы
 * @param args аргументы пробы (по умолчанию — `--version`)
 */
export async function probeBinaryThroughPort(
  port: ExecutionPort,
  bin: string,
  args: string[] = ['--version'],
): Promise<boolean> {
  try {
    await port.execute({
      command: { kind: 'argv', file: bin, args },
      timeoutMs: PROBE_TIMEOUT_MS,
      maxOutputBytes: PROBE_MAX_OUTPUT_BYTES,
    });
    return true;
  } catch (err) {
    return (err as { code?: unknown } | null)?.code !== 'ENOENT';
  }
}

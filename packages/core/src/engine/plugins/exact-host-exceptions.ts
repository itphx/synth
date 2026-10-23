/**
 * ADR-090, шаг 3: файл **точных исключений** семвер-гейта.
 *
 * Назначение: версия host, для которой плагин объявил несовместимый диапазон
 * `host`, но совместимость подтверждена вручную (аналог peer-gate-исключений).
 * Путь к файлу — конфиг `plugins.exactHostExceptions`; сам список — «список
 * версий host, совместимых вопреки диапазону `host`» (ADR-090).
 *
 * **Формат файла (решение Ф1):** текстовый, одна версия host в строке:
 *
 * ```text
 * # Точные исключения семвер-гейта плагинов (ADR-090).
 * # Одна версия Synth в строке; строки с `#` — комментарии.
 * 0.11.0
 * 0.11.1
 * ```
 *
 * Правила разбора (fail-closed):
 * - пустые строки и строки с `#` (в т.ч. с ведущими пробелами) — пропускаются;
 * - строка должна быть полной semver-версией (`MAJOR.MINOR.PATCH`), иначе
 *   она пропускается с предупреждением (исключение не выдаётся);
 * - файл не читается (нет/нет прав) — список пуст, предупреждение в лог:
 *   исключение **не выдаётся** (fail-closed — гейт остаётся строгим).
 */
import { readFile } from 'node:fs/promises';

import { parseSemver } from '@itphx/synth-shared';

/**
 * Прочитать список точных исключений семвер-гейта из файла.
 *
 * @param path путь к файлу (конфиг `plugins.exactHostExceptions`); пустая
 *   строка — исключений нет.
 * @returns список версий host (в порядке файла, без дублей).
 */
export async function readExactHostExceptions(path: string): Promise<string[]> {
  if (!path || path.trim() === '') return [];

  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    console.warn(
      `[plugin-host] файл точных исключений семвер-гейта не прочитан (${path}): ${err instanceof Error ? err.message : String(err)} — исключения не применяются (fail-closed).`,
    );
    return [];
  }

  const versions: string[] = [];
  const seen = new Set<string>();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (parseSemver(trimmed) === null) {
      console.warn(
        `[plugin-host] строка «${trimmed}» в файле точных исключений семвер-гейта (${path}) — не semver-версия, пропущена.`,
      );
      continue;
    }
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    versions.push(trimmed);
  }
  return versions;
}

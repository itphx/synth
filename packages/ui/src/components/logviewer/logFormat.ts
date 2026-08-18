/**
 * Helpers для панели логов: детекция уровня логирования в строке,
 * цветовые классы и очистка ANSI-escape последовательностей.
 * Вынесены в отдельный модуль для unit-тестов (logFormat.test.ts).
 */

export const LOG_LEVEL_COLORS: Record<string, string> = {
  DEBUG: 'bg-sky-100 text-sky-700 dark:bg-sky-900 dark:text-sky-300',
  INFO: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300',
  WARNING: 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300',
  ERROR: 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300',
  OK: 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300',
  DONE: 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300',
}

export const LOG_LEVELS = ['DEBUG', 'INFO', 'WARNING', 'ERROR', 'OK', 'DONE'] as const

const LEVEL_REGEX = /\b(DEBUG|INFO|WARNING|ERROR|OK|DONE)\b/i
/** ESC-последовательности ANSI-цветов: \u001b[...m (собираем через RegExp, чтобы не триггерить no-control-regex). */
const ANSI_REGEX = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')

/** Ищет уровень логирования в строке (case-insensitive), возвращает UPPERCASE или null. */
export function detectLogLevel(line: string): string | null {
  // сначала снимаем ANSI-коды: \u001b[31mERROR → "ERROR" (иначе граница слова ломается)
  const clean = stripAnsi(line)
  const match = clean.match(LEVEL_REGEX)
  if (!match) return null
  return match[1].toUpperCase()
}

/** Цветовой класс бейджа уровня (fallback — нейтральный). */
export function colorForLevel(level: string | null): string {
  if (!level) return 'bg-muted text-muted-foreground'
  return LOG_LEVEL_COLORS[level] ?? 'bg-muted text-muted-foreground'
}

/** Удаляет ANSI-escape коды (цвета терминала) из строки лога. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, '')
}

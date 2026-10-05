/**
 * Helpers для панели логов: детекция уровня логирования в строке,
 * цветовые классы и очистка ANSI-escape последовательностей.
 * Вынесены в отдельный модуль для unit-тестов (logFormat.test.ts).
 */

// Семантика уровней — только `status-*` токены: они тематические (light/dark
// обеспечивает сама тема), поэтому парность `-100/-900`/`dark:` больше не нужна.
export const LOG_LEVEL_COLORS: Record<string, string> = {
  DEBUG: 'bg-status-info/15 text-status-info',
  INFO: 'bg-status-success/15 text-status-success',
  WARNING: 'bg-status-warning/15 text-status-warning',
  ERROR: 'bg-status-error/15 text-status-error',
  OK: 'bg-status-success/15 text-status-success',
  DONE: 'bg-status-success/15 text-status-success',
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

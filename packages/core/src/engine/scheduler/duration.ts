/**
 * AD-051 (минимальный срез): парсер интервальных расписаний (`every`).
 *
 * Формат строгий: целое число + единица `s|m|h|d` (регистр значим), например
 * `30s`, `15m`, `1h`, `24h`. Переиспользует собственные константы: `parseTtl`
 * из `sessions/ephemeral.ts` возвращает ISO-момент и здесь не подходит.
 */

const DURATION_UNITS_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

const DURATION_PATTERN = /^(\d+)([smhd])$/;

/**
 * Парсит длительность вида `30s` / `15m` / `1h` / `24h` в миллисекунды.
 * Невалидный вход → `Error` (ошибка конфигурации должна быть видна).
 */
export function parseDurationMs(input: string): number {
  const match = DURATION_PATTERN.exec(input.trim());
  if (!match) {
    throw new Error(
      `parseDurationMs: невалидный интервал "${input}" (ожидается <число><s|m|h|d>, например "15m")`,
    );
  }
  return Number(match[1]) * DURATION_UNITS_MS[match[2]!]!;
}

/** Проверяет валидность интервала `every` без вычисления. */
export function isValidDuration(input: string): boolean {
  return DURATION_PATTERN.test(input.trim());
}

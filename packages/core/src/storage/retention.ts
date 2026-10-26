/**
 * Общая семантика retention-очистки портов слоя хранения (ADR-096).
 *
 * Очистка идёт по метке времени записи: запись удаляется, только если её
 * метка **строго старше** отсечки (`before`). Метку, которую не удалось
 * разобрать, запись не удаляет — консервативно (лучше оставить лишнее, чем
 * потерять данные). Неразбираемая отсечка — не удаляется ничего.
 *
 * PostgreSQL-драйвер повторяет ту же семантику в SQL (`updated_at < $1`).
 */

/** Метка отсечки в миллисекундах; `null` — отсечка не разобрана. */
export function parseCutoffMs(before: string): number | null {
  const parsed = Date.parse(before);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Строго ли метка записи старше отсечки.
 *
 * Метка, которую не удалось разобрать, считается **не** старше (запись
 * сохраняется) — обратная совместимость с `JobStore.prune`.
 */
export function isOlderThan(iso: string, cutoffMs: number): boolean {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return false;
  return at < cutoffMs;
}

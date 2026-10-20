/**
 * Служебная семантика timestamps для портов слоя хранения (ADR-096).
 *
 * Общая для файловых и in-memory реализаций: «upsert» не должен терять
 * `createdAt` и должен монотонно обновлять `updatedAt` (ADR-005: запись
 * идёт через атомарный tmp→rename, время — служебное поле хранилища).
 *
 * Правила:
 * - `createdAt` — иммутабельно: при перезаписи сохраняется значение уже
 *   записанной записи, для новой — значение из аргумента, иначе «сейчас»;
 * - `updatedAt` — монотонно не убывает: берётся максимум из «сейчас»,
 *   входящего значения и сохранённого; если максимум совпал с сохранённым
 *   (та же миллисекунда) — метка сдвигается на 1 мс, чтобы «обновление»
 *   всегда было наблюдаемым.
 */

/** Текущее время в ISO-формате. */
function now(): string {
  return new Date().toISOString();
}

/** Время в миллисекундах (`NaN` — значение не разобрано). */
function ms(value: string | undefined): number {
  if (!value) return Number.NaN;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.NaN : parsed;
}

/**
 * `createdAt` для upsert: сохранённое значение приоритетно (создание
 * иммутабельно), затем — входящее, иначе «сейчас».
 */
export function resolveCreatedAt(stored: string | undefined, incoming: string | undefined): string {
  if (stored) return stored;
  if (incoming) return incoming;
  return now();
}

/**
 * `updatedAt` для upsert: максимум из «сейчас», входящего и сохранённого
 * значений; при совпадении с сохранённым — сдвиг на 1 мс (монотонность).
 */
export function resolveUpdatedAt(stored: string | undefined, incoming: string | undefined): string {
  const current = now();
  const nowMs = ms(current);
  const candidates: Array<{ value: string; at: number }> = [];
  for (const value of [incoming, stored]) {
    const at = ms(value);
    if (!Number.isNaN(at)) candidates.push({ value: value as string, at });
  }

  let best: { value: string; at: number } = { value: current, at: nowMs };
  for (const candidate of candidates) {
    if (candidate.at > best.at) best = candidate;
  }

  // Метка не должна «откатываться» и должна отличаться от прежней записи.
  if (stored && best.at <= ms(stored)) {
    const bumped = (Number.isNaN(ms(stored)) ? nowMs : ms(stored)) + 1;
    return new Date(bumped).toISOString();
  }
  return best.value;
}

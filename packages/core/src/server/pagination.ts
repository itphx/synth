/**
 * Общие помощники **постраничной выдачи** HTTP-контрактов (ADR-017).
 *
 * Один контракт на все списки с пагинацией (списки проектов, пайплайнов
 * проекта, журнал прогона): `limit` (дефолт/потолок), `offset` и курсор
 * следующей страницы `next_offset`.
 *
 * Правила (совпадают с пагинацией списка сессий, ADR-118 §4):
 * - `limit`/`offset` — **целые** числа; нечисловое/дробное/отрицательное →
 *   `400 VALIDATION_ERROR` (молча править параметр нельзя — клиент не узнает,
 *   что его просьба искажена); значение выше потолка **обрезается** до потолка
 *   (мягкая граница);
 * - `offset` — смещение от начала выборки (с 0);
 * - `next_offset` — курсор следующей страницы (`offset + page.length`) или
 *   `null`, если страница последняя.
 */

/**
 * Разбор целочисленного query-параметра с верхней границей.
 *
 * `null` — значение невалидно (не число, дробное, отрицательное) → вызывающий
 * отвечает 400. Пустая строка — параметр не задан → `fallback`. Значение выше
 * `max` обрезается до `max` (мягкая граница).
 */
export function parseBoundedInt(
  raw: string | undefined,
  fallback: number,
  max: number,
): number | null {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) return null;
  return Math.min(value, max);
}

/** Страница выборки: сами элементы страницы, их число и курсор следующей. */
export interface Page<T> {
  /** Элементы текущей страницы. */
  page: T[];
  /** Всего элементов в выборке (без учёта пагинации). */
  total: number;
  /** Курсор следующей страницы; `null` — страница последняя. */
  next_offset: number | null;
}

/**
 * Вырезать страницу из выборки по `offset`/`limit`.
 *
 * Пустая страница (`limit = 0` или смещение за конец) → `next_offset = null`:
 * иначе клиент «залип» бы на нулевом смещении (курсор не двигается).
 */
export function paginate<T>(items: T[], offset: number, limit: number): Page<T> {
  const page = items.slice(offset, offset + limit);
  const consumed = offset + page.length;
  const next_offset = page.length > 0 && consumed < items.length ? consumed : null;
  return { page, total: items.length, next_offset };
}

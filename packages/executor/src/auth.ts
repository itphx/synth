/**
 * Аутентификация исполнителя (ADR-077, шаг 7a).
 *
 * Исполнитель — отдельный процесс с доступом к рабочему каталогу агента,
 * поэтому доступ к API закрыт **bearer-токеном**:
 *
 * - сравнение — **timing-safe** (`timingSafeEqual` по SHA-256 от обоих
 *   значений: сравнение всегда одной длины, утечки по длине токена нет);
 * - токен **никогда** не пишется в логи и не возвращается в ответах;
 * - без корректного токена — `401` (fail-closed): анонимный доступ к
 *   исполнителю недопустим даже при пустом токене в конфигурации.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

/** Заголовок авторизации. */
export const AUTH_HEADER = 'Authorization';

/** Схема bearer-токена. */
export const BEARER_PREFIX = 'Bearer ';

/**
 * Извлечь bearer-токен из заголовка `Authorization`.
 *
 * @returns токен или `null`, если заголовка нет/схема не bearer.
 */
export function extractBearerToken(header: string | undefined | null): string | null {
  if (typeof header !== 'string') return null;
  const trimmed = header.trim();
  if (!trimmed.toLowerCase().startsWith(BEARER_PREFIX.toLowerCase())) return null;
  const token = trimmed.slice(BEARER_PREFIX.length).trim();
  return token.length > 0 ? token : null;
}

/** Timing-safe сравнение двух строк (по SHA-256 — длина всегда одинакова). */
export function timingSafeEqualStrings(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Проверка авторизации запроса.
 *
 * @param header значение заголовка `Authorization`
 * @param token ожидаемый токен
 * @returns `true` — запрос авторизован
 */
export function isAuthorized(header: string | undefined | null, token: string): boolean {
  if (typeof token !== 'string' || token.length === 0) return false;
  const provided = extractBearerToken(header);
  if (provided === null) return false;
  return timingSafeEqualStrings(provided, token);
}

/**
 * Единый API-ключ backend (`auth.apiKey` / `SYNTH_API_KEY`).
 *
 * Два независимых правила (аудит F5):
 * 1. Сравнение ключа — **постоянное по времени**: равные по длине sha256-дайджесты
 *    (`timingSafeEqual`), поэтому ни содержимое, ни длина представленного ключа
 *    не утекают через тайминг. Пустой конфиг/пустой заголовок → не совпадает.
 * 2. Роли пользователя ключа — **только явная настройка** (`auth.apiKeyRoles`):
 *    дефолт `USER`; права ADMIN не выдаются по факту наличия ключа.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { GlobalRole } from '@itphx/synth-shared';

/** Допустимые роли для `auth.apiKeyRoles` (порядок — для текста ошибки). */
export const ALLOWED_API_KEY_ROLES: readonly GlobalRole[] = [
  GlobalRole.ADMIN,
  GlobalRole.USER,
  GlobalRole.LEAD,
  GlobalRole.AUDITOR,
];

/** Роль по умолчанию для API-ключа: базовый пользователь, не ADMIN. */
export const DEFAULT_API_KEY_ROLE: GlobalRole = GlobalRole.USER;

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * Сравнить представленный ключ с ожидаемым за постоянное время.
 *
 * Дайджесты sha256 всегда одной длины (32 байта), поэтому `timingSafeEqual`
 * не бросает на разной длине входных строк и не раскрывает её. Пустая строка
 * с любой стороны → `false` (незаданный ключ не аутентифицирует никого).
 */
export function apiKeyEquals(
  presented: string | null | undefined,
  expected: string | null | undefined,
): boolean {
  if (!presented || !expected) return false;
  return timingSafeEqual(digest(presented), digest(expected));
}

/**
 * Роли пользователя API-ключа из конфигурации: явный список либо `['USER']`.
 * Неизвестная роль — ошибка конфигурации (fail-closed): молча выдать меньше
 * прав нельзя (это скрытая поломка доступа), выдать больше — тем более.
 */
export function resolveApiKeyRoles(configured: readonly string[] | undefined): GlobalRole[] {
  if (!configured || configured.length === 0) return [DEFAULT_API_KEY_ROLE];

  const roles: GlobalRole[] = [];
  for (const value of configured) {
    if (!(ALLOWED_API_KEY_ROLES as readonly string[]).includes(value)) {
      throw new Error(
        `[config] auth.apiKeyRoles: неизвестная роль "${value}"; ` +
          `допустимо: ${ALLOWED_API_KEY_ROLES.join(', ')}`,
      );
    }
    const role = value as GlobalRole;
    if (!roles.includes(role)) roles.push(role);
  }

  return roles.length > 0 ? roles : [DEFAULT_API_KEY_ROLE];
}

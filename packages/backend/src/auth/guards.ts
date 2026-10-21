import { createMiddleware } from 'hono/factory';
import type { Context } from 'hono';
import { getServiceCredential } from '@itphx/synth-core';
import { hasAnyServiceScope, hasServiceScope } from '@itphx/synth-shared';
import { GlobalRole } from '@itphx/synth-shared/types';
import { t } from '../lib/i18n.js';

/**
 * ADR-052/O1: комбинированные guard'ы «ADMIN **или** scope» для эндпоинтов,
 * которые должны быть доступны и человеку-ADMIN, и installer-service-key'ю.
 *
 * `requireScope` (core) — no-op для интерактивных кред, поэтому одиночного
 * scope-гейта недостаточно: нужно «если service-key → требуем scope; иначе —
 * прежнее поведение (ADMIN)». Здесь и живёт эта развилка; enforcement scopes —
 * `hasServiceScope` (shared), чтение контекста — `getServiceCredential` (core).
 */

/** 403 SCOPE_REQUIRED (i18n backend) — service-key без нужного scope. */
function scopeDenied(c: Context): Response {
  return c.json(
    { error: { code: 'SCOPE_REQUIRED', message: t('errors.forbidden.scopeRequired', undefined, c) } },
    403,
  );
}

/** `true`, если пользователь аутентифицирован (в контексте есть `user`). */
function isAuthenticated(c: { get(key: 'user'): unknown }): boolean {
  return !!c.get('user');
}

/** `true`, если в контексте ADMIN (роли synthetic service-пользователя или человека). */
function isAdmin(c: { get(key: 'user'): unknown }): boolean {
  const user = c.get('user') as { roles?: string[] } | undefined;
  return !!user && Array.isArray(user.roles) && user.roles.includes('ADMIN');
}

/**
 * Guard «ADMIN **или** scope»:
 * - запрос с service-key → требуется хотя бы один из `scopes`
 *   (`403 SCOPE_REQUIRED` иначе);
 * - интерактивные креды (cookie/debug/OIDC/API-key/локальный ключ) → требуем
 *   роль ADMIN: нет аутентификации → `401 UNAUTHORIZED`, аутентифицирован без
 *   роли → `403 FORBIDDEN` (семантика HTTP; раньше оба случая склеивались в 403).
 *
 * Требует уже отработавшего `attachUser`/`requireAuth` (пользователь/ключ в
 * контексте). Используется на мутациях реестра MCP (`/servers*`), записи
 * скиллов и чтении пользователей.
 */
export function requireAdminOrScope(...scopes: string[]) {
  return createMiddleware(async (c, next) => {
    const cred = getServiceCredential(c as unknown as Context);
    if (cred) {
      if (!scopes.some((scope) => hasServiceScope(cred.scopes, scope))) {
        return scopeDenied(c as unknown as Context);
      }
      await next();
      return;
    }
    if (!isAuthenticated(c)) {
      return c.json(
        { error: { code: 'UNAUTHORIZED', message: t('auth.unauthorized', undefined, c) } },
        401,
      );
    }
    if (!isAdmin(c)) {
      return c.json(
        { error: { code: 'FORBIDDEN', message: t('auth.forbidden', undefined, c) } },
        403,
      );
    }
    await next();
  });
}

/**
 * Guard «scope **или** роль ADMIN»:
 * - service-key → проходит, если у него есть хотя бы один из `scopes`
 *   (`403 SCOPE_REQUIRED` иначе) **или** среди выданных ролей есть `ADMIN`
 *   (роль ключа — явное решение администратора, и до введения зонтичных
 *   scope'ов именно она давала доступ к таким операциям);
 * - интерактивные креды (cookie/debug/OIDC/API-key/локальный ключ) → требуем
 *   роль ADMIN: нет аутентификации → `401 UNAUTHORIZED`, аутентифицирован без
 *   роли → `403 FORBIDDEN` (семантика HTTP; раньше оба случая склеивались в 403).
 *
 * Отличие от `requireAdminOrScope`: там для service-key проверяются **только**
 * scope'ы (роль ADMIN ключа не учитывается) — здесь учитывается, чтобы
 * зонтичный scope не отбирал права у ключей с ролью ADMIN.
 */
export function requireAdminRoleOrScope(...scopes: string[]) {
  return createMiddleware(async (c, next) => {
    const cred = getServiceCredential(c as unknown as Context);
    if (cred) {
      const hasScope = hasAnyServiceScope(cred.scopes, scopes);
      const adminKey = Array.isArray(cred.roles) && cred.roles.includes(GlobalRole.ADMIN);
      if (!hasScope && !adminKey) {
        return scopeDenied(c as unknown as Context);
      }
      await next();
      return;
    }
    if (!isAuthenticated(c)) {
      return c.json(
        { error: { code: 'UNAUTHORIZED', message: t('auth.unauthorized', undefined, c) } },
        401,
      );
    }
    if (!isAdmin(c)) {
      return c.json(
        { error: { code: 'FORBIDDEN', message: t('auth.forbidden', undefined, c) } },
        403,
      );
    }
    await next();
  });
}

/**
 * Guard «service-key → scope»: для service-key требует хотя бы один из `scopes`;
 * интерактивные креды пропускает без изменений (их гейтит `requireAuth`/логика
 * роута). Нужен там, где интерактивный доступ **не** ограничен ADMIN — например,
 * `POST /api/v2/mcp/registry` (любой пользователь добавляет свой HTTP-сервер,
 * stdio — только ADMIN в теле роута).
 */
export function requireScopeForServiceKey(...scopes: string[]) {
  return createMiddleware(async (c, next) => {
    const cred = getServiceCredential(c as unknown as Context);
    if (cred && !scopes.some((scope) => hasServiceScope(cred.scopes, scope))) {
      return scopeDenied(c as unknown as Context);
    }
    await next();
  });
}

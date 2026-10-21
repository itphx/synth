import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { hasAnyServiceScope, hasServiceScope, GlobalRole } from '@itphx/synth-shared';
import type { ServiceKeyCredential } from '../storage/service-api-key-store.js';

/**
 * ADR-052 (этап I): enforcement service-key — scopes и проектная проекция.
 *
 * `requireScope` — middleware **рядом** с `requirePermission` (не перегрузка
 * permission-слоя тулов: роль-оси тот by design не имеет). Интерактивные креды
 * (OIDC/API-key/cookie) scopes не ограничиваются: если `serviceKey` в контексте
 * нет — middleware пропускает запрос.
 *
 * `requireScopeOrAdminRole` — тот же гейт, но service-key проходит и по роли
 * ADMIN среди выданных ролей (см. docstring функции).
 */

/** Тип middleware, совпадающий с core/backend AuthKit (оба на `createMiddleware`). */
type Middleware = ReturnType<typeof createMiddleware>;

/** Фабрика scope-guard'а (совместима с `requireScope`). */
export type ScopeGuardFactory = (...required: string[]) => Middleware;

/**
 * Гейт **проектной проекции service-key** (`allowedProjects`): `undefined` —
 * доступ разрешён, иначе — готовый 403-ответ. Это НЕ проверка прав пользователя
 * (RBAC) и для интерактивных кред — no-op: имя отражает суть.
 */
export type ServiceProjectProjectionGuard = (c: Context, projectId?: string) => Response | undefined;

/** @deprecated Переименовано в `ServiceProjectProjectionGuard` (честное имя). */
export type ProjectGuard = ServiceProjectProjectionGuard;

/** Контекст service-key из запроса (`undefined` — не service-key). */
export function getServiceCredential(c: Context): ServiceKeyCredential | undefined {
  const cred = c.get('serviceKey' as never) as ServiceKeyCredential | undefined;
  return cred && typeof cred === 'object' ? cred : undefined;
}

/**
 * Разрешает запрос, только если у service-key есть хотя бы один из `required`
 * (точное совпадение или wildcard-семейство, `hasServiceScope`). Нет
 * service-key в контексте — запрос пропускается (интерактивные креды).
 */
export function requireScope(...required: string[]): Middleware {
  return createMiddleware(async (c, next) => {
    const cred = getServiceCredential(c as unknown as Context);
    if (cred && !required.some((scope) => hasServiceScope(cred.scopes, scope))) {
      return scopeRequired(c, required);
    }
    await next();
  });
}

/**
 * ADR-052: гейт «scope **или** роль ADMIN» — для service-key.
 *
 * Отличие от `requireScope`: service-key проходит не только по scope'у, но и
 * по **роли ADMIN** среди выданных ролей (`roles` ключа — решение
 * администратора). Это сохраняет права, которые до введения зонтичных
 * scope'ов давала роль ADMIN (напр. создание агентов в managed-режиме), и не
 * ослабляет ничего сверх перечисленного.
 *
 * Интерактивные креды — no-op (как `requireScope`): в core ролевых проверок
 * на этих роутах нет, доступ определяет `writeGuard` (`requireAuth`).
 */
export function requireScopeOrAdminRole(...required: string[]): Middleware {
  return createMiddleware(async (c, next) => {
    const cred = getServiceCredential(c as unknown as Context);
    if (cred && !hasAnyServiceScope(cred.scopes, required) && !hasAdminRole(cred)) {
      return scopeRequired(c, required);
    }
    await next();
  });
}

/** `true`, если у ключа среди выданных ролей есть ADMIN. */
function hasAdminRole(cred: Pick<ServiceKeyCredential, 'roles'>): boolean {
  return Array.isArray(cred.roles) && cred.roles.includes(GlobalRole.ADMIN);
}

/** 403 SCOPE_REQUIRED с перечислением требуемых scope'ов. */
function scopeRequired(c: Context, required: readonly string[]): Response {
  return c.json(
    {
      error: {
        code: 'SCOPE_REQUIRED',
        message: `Недостаточно прав: требуется scope ${required.join(' | ')}`,
      },
    },
    403,
  );
}

/**
 * ADR-052 (проектная проекция, `docs/API_V2.md` §1): пусто/отсутствует `allowedProjects` — ключ
 * действует по политике инстанса (доступ разрешён). Задан непустой список —
 * доступен только проект из списка (fail-closed: без projectId — запрещено).
 */
export function isProjectAllowed(
  cred: Pick<ServiceKeyCredential, 'allowedProjects'> | undefined,
  projectId?: string,
): boolean {
  const allowed = cred?.allowedProjects;
  if (!allowed || allowed.length === 0) return true;
  return typeof projectId === 'string' && projectId.length > 0 && allowed.includes(projectId);
}

/**
 * Гейт **проектной проекции service-key** для роутов, адресующих проект/сессию.
 * Возвращает готовый 403-ответ, если service-key ограничен проектами и target не
 * входит в `allowedProjects`; иначе `undefined` (запрос можно продолжать).
 * Интерактивные креды (нет service-key) не ограничиваются — это не RBAC.
 */
export function checkServiceProjectProjection(c: Context, projectId?: string): Response | undefined {
  const cred = getServiceCredential(c);
  if (isProjectAllowed(cred, projectId)) return undefined;
  return c.json(
    { error: { code: 'PROJECT_FORBIDDEN', message: 'Проект недоступен для этого service-key' } },
    403,
  );
}

/** @deprecated Переименовано в `checkServiceProjectProjection` (честное имя). */
export const checkProjectAccess = checkServiceProjectProjection;

import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { hasServiceScope } from '@itphx/synth-shared';
import type { ServiceKeyCredential } from '../storage/service-api-key-store.js';

/**
 * ADR-052 (этап I): enforcement service-key — scopes и проектная проекция.
 *
 * `requireScope` — middleware **рядом** с `requirePermission` (не перегрузка
 * permission-слоя тулов: роль-оси тот by design не имеет). Интерактивные креды
 * (OIDC/API-key/cookie) scopes не ограничиваются: если `serviceKey` в контексте
 * нет — middleware пропускает запрос.
 */

/** Тип middleware, совпадающий с core/backend AuthKit (оба на `createMiddleware`). */
type Middleware = ReturnType<typeof createMiddleware>;

/** Фабрика scope-guard'а (совместима с `requireScope`). */
export type ScopeGuardFactory = (...required: string[]) => Middleware;

/** Гейт проектной проекции: `undefined` — доступ разрешён, иначе — готовый 403-ответ. */
export type ProjectGuard = (c: Context, projectId?: string) => Response | undefined;

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
    await next();
  });
}

/**
 * ADR-052 §«Проектная проекция»: пусто/отсутствует `allowedProjects` — ключ
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
 * Гейт проектной проекции для роутов, адресующих проект/сессию. Возвращает
 * готовый 403-ответ, если service-key ограничен проектами и target не входит в
 * `allowedProjects`; иначе `undefined` (запрос можно продолжать).
 */
export function checkProjectAccess(c: Context, projectId?: string): Response | undefined {
  const cred = getServiceCredential(c);
  if (isProjectAllowed(cred, projectId)) return undefined;
  return c.json(
    { error: { code: 'PROJECT_FORBIDDEN', message: 'Проект недоступен для этого service-key' } },
    403,
  );
}

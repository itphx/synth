import { createMiddleware } from 'hono/factory';
import { requireScope, checkProjectAccess } from '@itphx/synth-core';
import type { ProjectGuard, ScopeGuardFactory } from '@itphx/synth-core';
import { t } from '../lib/i18n.js';

/**
 * ADR-052 (этап I): backend-обёртки scope-гейтов service-key.
 *
 * Enforcement (`hasServiceScope`/`isProjectAllowed`) остаётся в core —
 * здесь только локализация отказов (`SCOPE_REQUIRED`/`PROJECT_FORBIDDEN`)
 * через backend-i18n. Для интерактивных кред (нет `serviceKey` в контексте)
 * оба гейта пропускают запрос, поэтому managed-поведение без service-key
 * не меняется.
 */

/** Scope-гейт: делегирует проверку core-`requireScope`, переводит 403 на i18n. */
export const scopeGuard: ScopeGuardFactory = (...required: string[]) => {
  const guard = requireScope(...required);
  return createMiddleware(async (c, next) => {
    const denied = await guard(c, async () => {});
    if (denied) {
      return c.json(
        {
          error: {
            code: 'SCOPE_REQUIRED',
            message: t('errors.forbidden.scopeRequired', undefined, c),
          },
        },
        403,
      );
    }
    await next();
  });
};

/** Гейт проектной проекции: делегирует core-`checkProjectAccess`, переводит 403. */
export const projectGuard: ProjectGuard = (c, projectId) => {
  const denied = checkProjectAccess(c, projectId);
  if (!denied) return undefined;
  return c.json(
    {
      error: {
        code: 'PROJECT_FORBIDDEN',
        message: t('errors.forbidden.projectForbidden', undefined, c),
      },
    },
    403,
  );
};

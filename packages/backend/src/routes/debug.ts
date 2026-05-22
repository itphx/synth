import { Hono } from 'hono';
import type { AuthKit } from '../auth/middleware.js';
import { getAllGroups, setAllGroups, LOG_LEVEL_NAMES } from '@synth/core';
import { t } from '../lib/i18n.js';

export function createDebugRoutes(kit: AuthKit): Hono {
  const app = new Hono();

  // GET /api/v2/admin/debug/config — получить конфигурацию групп логирования
  app.get('/config', kit.requireAdmin, async (c) => {
    return c.json({
      groups: getAllGroups(),
      available_levels: LOG_LEVEL_NAMES,
    });
  });

  // POST /api/v2/admin/debug/config — сохранить конфигурацию групп логирования
  app.post('/config', kit.requireAdmin, async (c) => {
    const body = await c.req.json<{ groups?: Record<string, string> }>().catch(() => ({ groups: undefined }));
    if (!body.groups) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: t('errors.validation.groupsRequired', undefined, c) } }, 400);
    }

    try {
      setAllGroups(body.groups);
      return c.json({ status: 'saved' });
    } catch (err) {
      return c.json({
        error: { code: 'VALIDATION_ERROR', message: err instanceof Error ? err.message : t('errors.generic', undefined, c) },
      }, 400);
    }
  });

  return app;
}

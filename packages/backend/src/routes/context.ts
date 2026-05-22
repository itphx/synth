import { Hono } from 'hono';
import type { AuthKit } from '../auth/middleware.js';
import type { ContextConfig } from '@synth/core';
import type { ContextCategory } from '@synth/shared';

const VALID_CATEGORIES = new Set<string>(['user', 'role', 'system', 'tsm']);

function parseCategory(s: string | undefined): ContextCategory {
  if (s && VALID_CATEGORIES.has(s)) return s as ContextCategory;
  return 'user';
}

export function createContextRoutes(kit: AuthKit, config: ContextConfig): Hono {
  const app = new Hono();

  // GET /api/v2/context/files — список контекстных файлов
  app.get('/files', kit.requireAdmin, (c) => {
    const category = c.req.query('category');
    const allFiles = config.listAllFiles();
    const filtered = category
      ? allFiles.filter((f) => f.category === category)
      : allFiles;
    return c.json({
      files: filtered.map((f) => ({
        name: f.filename,
        category: f.category,
        is_system: f.isSystem,
        is_overridden: f.isOverridden,
        enabled: f.enabled ?? true,
        size: f.size,
      })),
    });
  });

  // GET /api/v2/context/files/:name — содержимое файла
  app.get('/files/:name', kit.requireAdmin, (c) => {
    const name = c.req.param('name');
    const category = parseCategory(c.req.query('category'));
    const file = config.getFile(name, category);
    if (!file) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Файл не найден' } }, 404);
    }
    return c.json({
      name: file.filename,
      content: file.content,
      category: file.category,
      is_system: file.isSystem,
      is_overridden: file.isOverridden,
    });
  });

  // POST /api/v2/context/files/:name — сохранить / переключить enabled
  app.post('/files/:name', kit.requireAdmin, async (c) => {
    const name = c.req.param('name');
    const body = await c.req.json().catch(() => ({}));

    if (body.action === 'toggle') {
      const enabled = config.getEnabledFiles();
      const idx = enabled.indexOf(name);
      if (idx >= 0) {
        enabled.splice(idx, 1);
      } else {
        enabled.push(name);
      }
      config.setEnabledFiles(enabled);
      return c.json({ name, enabled: idx < 0 });
    }

    const category = parseCategory(body.category);
    await config.saveFile(name, body.content || '', category);
    return c.json({ name, category, saved: true });
  });

  // DELETE /api/v2/context/files/:name — удалить
  app.delete('/files/:name', kit.requireAdmin, async (c) => {
    const name = c.req.param('name');
    const category = parseCategory(c.req.query('category'));
    await config.deleteFile(name, category);
    return c.body(null, 204);
  });

  // POST /api/v2/context/files/:name/restore_to_default — восстановить
  app.post('/files/:name/restore_to_default', kit.requireAdmin, async (c) => {
    const name = c.req.param('name');
    const category = parseCategory(c.req.query('category'));
    await config.restoreFile(name, category);
    return c.json({ status: 'restored' });
  });

  // GET /api/v2/context/enabled — список включённых
  app.get('/enabled', kit.requireAdmin, (c) => {
    return c.json({ enabled: config.getEnabledFiles() });
  });

  // POST /api/v2/context/enabled — установить включённые
  app.post('/enabled', kit.requireAdmin, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (Array.isArray(body.files)) {
      config.setEnabledFiles(body.files);
      return c.json({ enabled: config.getEnabledFiles() });
    }
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'expected { files: string[] }' } }, 400);
  });

  return app;
}

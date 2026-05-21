import { Hono } from 'hono';
import type { AuthKit } from '../auth/middleware.js';
import { JsonStore } from '../storage/json-store.js';

interface ContextFile {
  name: string;
  content: string;
  category: string; // 'user' | 'role' | 'system' | 'tsm'
  enabled: boolean;
}

export function createContextRoutes(kit: AuthKit, store: JsonStore<ContextFile>): Hono {
  const app = new Hono();

  // GET /api/v2/context/files — список контекстных файлов
  app.get('/files', kit.requireAdmin, async (c) => {
    const category = c.req.query('category');
    const files = await store.list();
    const filtered = category ? files.filter((f) => f.category === category) : files;
    return c.json({
      files: filtered.map((f) => ({
        name: f.name,
        category: f.category,
        enabled: f.enabled,
        size: Buffer.byteLength(f.content, 'utf-8'),
      })),
    });
  });

  // GET /api/v2/context/files/:name — содержимое файла
  app.get('/files/:name', kit.requireAdmin, async (c) => {
    const name = c.req.param('name');
    const file = await store.load(name);
    if (!file) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Файл не найден' } }, 404);
    }
    return c.json(file);
  });

  // POST /api/v2/context/files/:name — сохранить или переключить
  app.post('/files/:name', kit.requireAdmin, async (c) => {
    const name = c.req.param('name');
    const body = await c.req.json().catch(() => ({}));

    if (body.action === 'toggle') {
      const file = await store.load(name);
      if (!file) {
        return c.json({ error: { code: 'NOT_FOUND', message: 'Файл не найден' } }, 404);
      }
      file.enabled = !file.enabled;
      await store.save(name, file);
      return c.json({ name, enabled: file.enabled });
    }

    const file: ContextFile = {
      name,
      content: body.content || '',
      category: body.category || 'user',
      enabled: body.enabled ?? true,
    };
    await store.save(name, file);
    return c.json(file);
  });

  // DELETE /api/v2/context/files/:name — удалить
  app.delete('/files/:name', kit.requireAdmin, async (c) => {
    const name = c.req.param('name');
    await store.delete(name);
    return c.body(null, 204);
  });

  // POST /api/v2/context/files/:name/restore_to_default — восстановить
  app.post('/files/:name/restore_to_default', kit.requireAdmin, async (c) => {
    await store.delete(c.req.param('name'));
    return c.json({ status: 'restored' });
  });

  // GET /api/v2/context/enabled — список включённых
  app.get('/enabled', kit.requireAdmin, async (c) => {
    const files = await store.list();
    return c.json({
      enabled: files.filter((f) => f.enabled).map((f) => f.name),
    });
  });

  return app;
}

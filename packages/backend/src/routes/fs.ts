import { Hono } from 'hono';
import type { AuthKit } from '../auth/middleware.js';

export function createFsRoutes(kit: AuthKit): Hono {
  const app = new Hono();

  // GET /api/v2/fs — список файлов в директории
  app.get('/', kit.requireAuth, async (c) => {
    return c.json({
      path: c.req.query('path') || '/',
      entries: [],
    });
  });

  // GET /api/v2/fs/read — содержимое файла
  app.get('/read', kit.requireAuth, async (c) => {
    return c.json({
      path: c.req.query('path') || '',
      content: '',
      size: 0,
    });
  });

  return app;
}

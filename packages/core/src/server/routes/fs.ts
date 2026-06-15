import { Hono } from 'hono';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { AuthKit } from '../../auth/local.js';

export function createFsRoutes(auth: AuthKit, workspacesRoot?: string): Hono {
  const app = new Hono();
  const root = workspacesRoot || process.cwd();

  app.get('/', auth.requireAuth, async (c) => {
    const path = c.req.query('path') || '';
    const fullPath = resolve(root, path);

    if (!fullPath.startsWith(root)) {
      return c.json({ error: { code: 'FORBIDDEN', message: 'Доступ запрещён' } }, 403);
    }

    try {
      const entries = await readdir(fullPath, { withFileTypes: true });
      const result = [];
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const entryPath = join(path, entry.name);
        let size = 0;
        let modifiedAt = 0;
        try {
          const s = await stat(join(fullPath, entry.name));
          size = s.size;
          modifiedAt = s.mtimeMs;
        } catch { /* ignore */ }
        result.push({
          name: entry.name,
          path: entryPath,
          isDirectory: entry.isDirectory(),
          size,
          modifiedAt,
        });
      }
      result.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      return c.json({ path: path || '/', entries: result });
    } catch {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Директория не найдена' } }, 404);
    }
  });

  app.get('/read', auth.requireAuth, async (c) => {
    const filePath = c.req.query('path') || '';
    const fullPath = resolve(root, filePath);

    if (!fullPath.startsWith(root)) {
      return c.json({ error: { code: 'FORBIDDEN', message: 'Доступ запрещён' } }, 403);
    }

    try {
      const s = await stat(fullPath);
      if (s.isDirectory()) {
        return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Это директория' } }, 400);
      }
      const content = await readFile(fullPath, 'utf-8');
      return c.json({ path: filePath, content, size: s.size, encoding: 'utf-8' });
    } catch {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Файл не найден' } }, 404);
    }
  });

  return app;
}

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { createMiddleware } from 'hono/factory';
import type { ContextCategory } from '@itphx/synth-shared';
import type { ContextFileRepository } from '../../storage/ports/context-file-repository.js';

/** Тип middleware, совпадающий с core/backend AuthKit (оба на createMiddleware). */
type Middleware = ReturnType<typeof createMiddleware>;

/** Минимальный auth-контракт фабрики: в core и backend общий (структурно). */
export interface ContextFileRoutesAuth {
  requireAuth: Middleware;
}

export interface ContextFileRouteMessages {
  /** Файл контекста не найден. */
  fileNotFound: (c: Context) => string;
  /** Ожидалось тело `{ files: string[] }`. */
  expectedFilesArray: (c: Context) => string;
}

export interface ContextFileRoutesOptions {
  /**
   * Guard на все методы. Managed — `requireAdmin`, core — `requireAuth`
   * (локальный пользователь standalone всегда ADMIN).
   */
  adminGuard?: Middleware;
  /** Локализуемые сообщения (backend — i18n, core — русские литералы). */
  messages?: Partial<ContextFileRouteMessages>;
}

const DEFAULT_MESSAGES: ContextFileRouteMessages = {
  fileNotFound: () => 'Файл не найден',
  expectedFilesArray: () => 'expected { files: string[] }',
};

const VALID_CATEGORIES = new Set<string>(['user', 'role', 'system']);

function parseCategory(s: string | undefined): ContextCategory {
  if (s && VALID_CATEGORIES.has(s)) return s as ContextCategory;
  return 'user';
}

/**
 * Файлы контекста/промптов инстанса (ADR-069/ADR-070) — HTTP-контур.
 *
 * Общая реализация для core (standalone) и backend (managed): отличается
 * только guard'ом (managed — ADMIN, core — requireAuth) и текстами.
 */
export function createContextFileRoutes(
  auth: ContextFileRoutesAuth,
  repo: ContextFileRepository,
  opts: ContextFileRoutesOptions = {},
): Hono {
  const app = new Hono();
  const adminGuard = opts.adminGuard ?? auth.requireAuth;
  const messages: ContextFileRouteMessages = { ...DEFAULT_MESSAGES, ...opts.messages };

  // GET /files — список контекстных файлов
  app.get('/files', adminGuard, (c) => {
    const category = c.req.query('category');
    const allFiles = repo.listAllFiles();
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

  // GET /files/:name — содержимое файла
  app.get('/files/:name', adminGuard, (c) => {
    const name = c.req.param('name');
    const category = parseCategory(c.req.query('category'));
    const file = repo.getFile(name, category);
    if (!file) {
      return c.json({ error: { code: 'NOT_FOUND', message: messages.fileNotFound(c) } }, 404);
    }
    return c.json({
      name: file.filename,
      content: file.content,
      category: file.category,
      is_system: file.isSystem,
      is_overridden: file.isOverridden,
    });
  });

  // POST /files/:name — сохранить / переключить enabled
  app.post('/files/:name', adminGuard, async (c) => {
    const name = c.req.param('name');
    const body = await c.req.json().catch(() => ({}));

    if (body.action === 'toggle') {
      const enabled = repo.getEnabledFiles();
      const idx = enabled.indexOf(name);
      if (idx >= 0) {
        enabled.splice(idx, 1);
      } else {
        enabled.push(name);
      }
      repo.setEnabledFiles(enabled);
      return c.json({ name, enabled: idx < 0 });
    }

    const category = parseCategory(body.category);
    await repo.saveFile(name, body.content || '', category);
    return c.json({ name, category, saved: true });
  });

  // DELETE /files/:name — удалить
  app.delete('/files/:name', adminGuard, async (c) => {
    const name = c.req.param('name');
    const category = parseCategory(c.req.query('category'));
    await repo.deleteFile(name, category);
    return c.body(null, 204);
  });

  // POST /files/:name/restore_to_default — восстановить системный
  app.post('/files/:name/restore_to_default', adminGuard, async (c) => {
    const name = c.req.param('name');
    const category = parseCategory(c.req.query('category'));
    await repo.restoreFile(name, category);
    return c.json({ status: 'restored' });
  });

  // GET /enabled — список включённых
  app.get('/enabled', adminGuard, (c) => {
    return c.json({ enabled: repo.getEnabledFiles() });
  });

  // POST /enabled — установить включённые
  app.post('/enabled', adminGuard, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (Array.isArray(body.files)) {
      repo.setEnabledFiles(body.files);
      return c.json({ enabled: repo.getEnabledFiles() });
    }
    return c.json({
      error: { code: 'VALIDATION_ERROR', message: messages.expectedFilesArray(c) },
    }, 400);
  });

  return app;
}

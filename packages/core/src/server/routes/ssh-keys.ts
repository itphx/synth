import { Hono } from 'hono';
import type { Context } from 'hono';
import type { createMiddleware } from 'hono/factory';
import { ZodError } from 'zod';
import type { SSHKeyMeta } from '@itphx/synth-shared';
import { sshKeyCreateSchema, sshKeyUpdateSchema } from '@itphx/synth-shared';
import { SSHKeyStoreError, type SSHKeyStore } from '../../storage/ssh-key-store.js';

/**
 * ADR-076 §T5: SSH-ключи агентов (`/api/v2/ssh-keys` и
 * `/api/v2/agents/:agentId/ssh-keys`). Единая реализация для core (standalone)
 * и backend (managed, запись — `writeGuard: requireAdmin`).
 *
 * Контракт ответов — `SSHKeyMeta` (без `privateKey`/`passphrase`); `reveal` в API
 * не вызывается ни при каких опциях.
 */

/** Тип middleware, совпадающий с core/backend AuthKit (оба на `createMiddleware`). */
type Middleware = ReturnType<typeof createMiddleware>;

/** Минимальный контракт auth-фабрики (структурно совместим с core/backend AuthKit). */
export interface SshKeyRoutesAuth {
  requireAuth: Middleware;
}

export interface SshKeyRoutesOptions {
  /** Guard на read-эндпоинты; core по умолчанию — нет (backend — `requireAuth` глобально). */
  readGuard?: Middleware;
  /** Guard на write-эндпоинты; core по умолчанию — нет (backend — `requireAdmin`). */
  writeGuard?: Middleware;
  /**
   * Маскировать ответы (ADR-036): `true` (дефолт) — гарантированно отдаёт
   * `SSHKeyMeta`. `false` — только для внутреннего использования, в API не включать.
   */
  mask?: boolean;
}

interface RouteError {
  error: string;
  code: string;
}

type RouteStatus = 400 | 404 | 409 | 500;

function codeToStatus(code: string): number {
  switch (code) {
    case 'sshkey.not_found':
      return 404;
    case 'sshkey.name_exists':
      return 409;
    case 'VALIDATION_ERROR':
      return 400;
    default:
      return 500;
  }
}

/** `SSHKeyStoreError`/Zod → единый формат `{ error: { error, code } }`. */
function toRouteError(err: unknown): RouteError {
  if (err instanceof ZodError) {
    return {
      error: err.errors.map((e) => e.message).join('; ') || 'Некорректное тело запроса',
      code: 'VALIDATION_ERROR',
    };
  }
  if (err instanceof SSHKeyStoreError) {
    switch (err.code) {
      case 'not_found':
        return { error: err.message, code: 'sshkey.not_found' };
      case 'name_exists':
        return { error: err.message, code: 'sshkey.name_exists' };
      case 'decrypt_failed':
        return { error: err.message, code: 'sshkey.decrypt_failed' };
      case 'encryption_unavailable':
        return { error: err.message, code: 'sshkey.encryption_unavailable' };
      case 'invalid':
        return { error: err.message, code: 'VALIDATION_ERROR' };
    }
  }
  return { error: err instanceof Error ? err.message : String(err), code: 'INTERNAL_ERROR' };
}

function errorResponse(c: Context, err: unknown): Response {
  const e = toRouteError(err);
  return c.json({ error: e }, codeToStatus(e.code) as RouteStatus);
}

/** Явная сборка публичной формы — страховка от случайной утечки секретов. */
function toSafeMeta(meta: SSHKeyMeta): SSHKeyMeta {
  return {
    id: meta.id,
    name: meta.name,
    type: meta.type,
    agentIds: [...meta.agentIds],
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
  };
}

function notFound(id: string): SSHKeyStoreError {
  return new SSHKeyStoreError('not_found', `SSH-ключ ${id} не найден`);
}

/**
 * flat CRUD: `/api/v2/ssh-keys`.
 * Секреты (`privateKey`/`passphrase`) не возвращаются никогда — только `SSHKeyMeta`.
 */
export function createSshKeyRoutes(
  auth: SshKeyRoutesAuth,
  sshKeyStore: SSHKeyStore,
  opts: SshKeyRoutesOptions = {},
): Hono {
  const app = new Hono();
  const readGuard: Middleware = opts.readGuard ?? (async (_c, next) => { await next(); });
  const writeGuard: Middleware = opts.writeGuard ?? (async (_c, next) => { await next(); });
  const mask = opts.mask ?? true;
  const present = (meta: SSHKeyMeta): SSHKeyMeta => (mask ? toSafeMeta(meta) : meta);

  // GET /api/v2/ssh-keys?agentId= — все ключи либо ключи агента.
  app.get('/', auth.requireAuth, readGuard, async (c) => {
    try {
      const agentId = c.req.query('agentId');
      const keys = agentId
        ? await sshKeyStore.listForAgent(agentId)
        : await sshKeyStore.list();
      return c.json(keys.map(present));
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // POST /api/v2/ssh-keys — создание.
  app.post('/', auth.requireAuth, writeGuard, async (c) => {
    try {
      const body = sshKeyCreateSchema.parse(await c.req.json());
      const created = await sshKeyStore.create(body);
      return c.json(present(created), 201);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // GET /api/v2/ssh-keys/:id
  app.get('/:id', auth.requireAuth, readGuard, async (c) => {
    try {
      const id = c.req.param('id');
      const meta = await sshKeyStore.get(id);
      if (!meta) throw notFound(id);
      return c.json(present(meta));
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // PATCH /api/v2/ssh-keys/:id — частичное обновление (в т.ч. смена privateKey).
  app.patch('/:id', auth.requireAuth, writeGuard, async (c) => {
    try {
      const id = c.req.param('id');
      const body = sshKeyUpdateSchema.parse(await c.req.json());
      const updated = await sshKeyStore.update(id, body);
      if (!updated) throw notFound(id);
      return c.json(present(updated));
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // DELETE /api/v2/ssh-keys/:id — удаление ключа целиком.
  app.delete('/:id', auth.requireAuth, writeGuard, async (c) => {
    try {
      const id = c.req.param('id');
      const ok = await sshKeyStore.delete(id);
      if (!ok) throw notFound(id);
      return c.body(null, 204);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  return app;
}

/**
 * nested-роуты агента: `/api/v2/agents/:agentId/ssh-keys`.
 *
 * Важно: `DELETE /:keyId` — **unlink** (отвязка ключа от агента), ключ при этом
 * НЕ удаляется и остаётся доступен в flat-списке `/api/v2/ssh-keys`.
 * Полное удаление ключа — только flat `DELETE /api/v2/ssh-keys/:id`.
 */
export function createAgentSshKeyRoutes(
  auth: SshKeyRoutesAuth,
  sshKeyStore: SSHKeyStore,
  opts: SshKeyRoutesOptions = {},
): Hono {
  const app = new Hono();
  const readGuard: Middleware = opts.readGuard ?? (async (_c, next) => { await next(); });
  const writeGuard: Middleware = opts.writeGuard ?? (async (_c, next) => { await next(); });
  const mask = opts.mask ?? true;
  const present = (meta: SSHKeyMeta): SSHKeyMeta => (mask ? toSafeMeta(meta) : meta);

  function agentParam(c: Context): string {
    const agentId = c.req.param('agentId');
    if (!agentId) throw new SSHKeyStoreError('invalid', 'Не указан идентификатор агента');
    return agentId;
  }

  // GET /api/v2/agents/:agentId/ssh-keys — ключи агента.
  app.get('/', auth.requireAuth, readGuard, async (c) => {
    try {
      const keys = await sshKeyStore.listForAgent(agentParam(c));
      return c.json(keys.map(present));
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // POST /api/v2/agents/:agentId/ssh-keys — создание с привязкой к агенту.
  app.post('/', auth.requireAuth, writeGuard, async (c) => {
    try {
      const agentId = agentParam(c);
      const body = sshKeyCreateSchema.parse(await c.req.json());
      const agentIds = Array.from(new Set([...(body.agentIds ?? []), agentId]));
      const created = await sshKeyStore.create({ ...body, agentIds });
      return c.json(present(created), 201);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // DELETE /api/v2/agents/:agentId/ssh-keys/:keyId — отвязка (не удаление ключа).
  app.delete('/:keyId', auth.requireAuth, writeGuard, async (c) => {
    try {
      const keyId = c.req.param('keyId');
      const updated = await sshKeyStore.unlinkAgent(keyId, agentParam(c));
      if (!updated) throw notFound(keyId);
      return c.json(present(updated));
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  return app;
}

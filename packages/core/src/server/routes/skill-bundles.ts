import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import { skillBundleSchema, SKILL_NAME_MAX, SKILL_NAME_REGEX } from '@itphx/synth-shared';
import type { AuthKit } from '../../auth/local.js';
import type { SkillBundleStore } from '../../storage/skill-bundle-store.js';

export interface SkillBundleRoutesDeps {
  bundleStore: SkillBundleStore;
  /** Проверка существования скиллов из bundle (обычно `SkillService`). */
  validateSkills?: (names: readonly string[]) => Promise<string[]>;
}

export interface SkillBundleRoutesMessages {
  notFound: string;
  validation: string;
  conflict: string;
  missingSkills: string;
}

const DEFAULT_MESSAGES: SkillBundleRoutesMessages = {
  notFound: 'Bundle не найден',
  validation: 'Некорректные данные bundle',
  conflict: 'Bundle с таким именем уже существует',
  missingSkills: 'Bundle ссылается на несуществующие скиллы',
};

export interface SkillBundleRoutesOptions {
  writeGuard?: MiddlewareHandler;
  messages?: (c: Context) => SkillBundleRoutesMessages;
}

/**
 * ADR-046 §9.1/§7.3: CRUD `/api/v2/skill-bundles[/:name]` (instance-хранилище).
 */
export function createSkillBundleRoutes(
  auth: AuthKit,
  deps: SkillBundleRoutesDeps,
  opts?: SkillBundleRoutesOptions,
): Hono {
  const app = new Hono();
  const writeGuard: MiddlewareHandler = opts?.writeGuard ?? (async (_c, next) => { await next(); });
  const messages = (c: Context): SkillBundleRoutesMessages => opts?.messages?.(c) ?? DEFAULT_MESSAGES;

  const notFound = (c: Context) => c.json(
    { error: { code: 'NOT_FOUND', message: messages(c).notFound } },
    404,
  );

  const isValidName = (name: string): boolean =>
    name.length > 0 && name.length <= SKILL_NAME_MAX && SKILL_NAME_REGEX.test(name);

  app.get('/', auth.requireAuth, async (c) => {
    const bundles = await deps.bundleStore.list();
    return c.json({ bundles });
  });

  app.post('/', auth.requireAuth, writeGuard, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = skillBundleSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({
        error: {
          code: 'VALIDATION_ERROR',
          message: `${messages(c).validation}: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
        },
      }, 400);
    }
    if (await deps.bundleStore.exists(parsed.data.name)) {
      return c.json({ error: { code: 'CONFLICT', message: messages(c).conflict } }, 409);
    }
    if (deps.validateSkills) {
      const missing = await deps.validateSkills(parsed.data.skills);
      if (missing.length > 0) {
        return c.json({
          error: { code: 'VALIDATION_ERROR', message: `${messages(c).missingSkills}: ${missing.join(', ')}` },
        }, 400);
      }
    }
    await deps.bundleStore.set(parsed.data);
    return c.json(parsed.data, 201);
  });

  app.get('/:name', auth.requireAuth, async (c) => {
    const name = c.req.param('name');
    if (!isValidName(name)) return notFound(c);
    const bundle = await deps.bundleStore.get(name);
    if (!bundle) return notFound(c);
    return c.json(bundle);
  });

  app.patch('/:name', auth.requireAuth, writeGuard, async (c) => {
    const name = c.req.param('name');
    if (!isValidName(name)) return notFound(c);
    if (!(await deps.bundleStore.exists(name))) return notFound(c);
    const body = await c.req.json().catch(() => ({}));
    const parsed = skillBundleSchema.safeParse({ ...body, name });
    if (!parsed.success) {
      return c.json({
        error: {
          code: 'VALIDATION_ERROR',
          message: `${messages(c).validation}: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
        },
      }, 400);
    }
    if (deps.validateSkills) {
      const missing = await deps.validateSkills(parsed.data.skills);
      if (missing.length > 0) {
        return c.json({
          error: { code: 'VALIDATION_ERROR', message: `${messages(c).missingSkills}: ${missing.join(', ')}` },
        }, 400);
      }
    }
    await deps.bundleStore.set(parsed.data);
    return c.json(parsed.data);
  });

  app.delete('/:name', auth.requireAuth, writeGuard, async (c) => {
    const name = c.req.param('name');
    if (!isValidName(name)) return notFound(c);
    const removed = await deps.bundleStore.remove(name);
    if (!removed) return notFound(c);
    return c.json({ status: 'deleted' });
  });

  return app;
}

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next, MiddlewareHandler } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSkillBundleRoutes } from './skill-bundles.js';
import { SkillBundleStore } from '../../storage/skill-bundle-store.js';
import type { AuthKit } from '../../auth/local.js';

function createMockAuth(): AuthKit {
  return {
    getCurrentUser: () => null,
    requireAuth: async (_c: Context, next: Next) => { await next(); },
  } as unknown as AuthKit;
}

let tmpDir: string;

function makeApp(opts?: { writeGuard?: MiddlewareHandler; validateSkills?: (names: readonly string[]) => Promise<string[]> }) {
  const app = new Hono();
  const bundleStore = new SkillBundleStore({ dataDir: tmpDir });
  app.route('/api/v2/skill-bundles', createSkillBundleRoutes(createMockAuth(), {
    bundleStore,
    ...(opts?.validateSkills ? { validateSkills: opts.validateSkills } : {}),
  }, opts));
  return { app, bundleStore };
}

async function json(app: Hono, url: string, body?: unknown, method = 'GET') {
  return app.request(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'synth-bundles-routes-'));
});
afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('/api/v2/skill-bundles (ADR-046 §9.1)', () => {
  it('CRUD: create → list → get → patch → delete', async () => {
    const { app } = makeApp();
    const created = await json(app, '/api/v2/skill-bundles', {
      name: 'backend', description: 'Backend', skills: ['a', 'b'],
    }, 'POST');
    expect(created.status).toBe(201);

    const list: any = await (await app.request('/api/v2/skill-bundles')).json();
    expect(list.bundles).toHaveLength(1);
    expect(list.bundles[0].name).toBe('backend');

    const got: any = await (await app.request('/api/v2/skill-bundles/backend')).json();
    expect(got.skills).toEqual(['a', 'b']);

    const patched = await json(app, '/api/v2/skill-bundles/backend', {
      description: 'Backend v2', skills: ['a'],
    }, 'PATCH');
    expect(patched.status).toBe(200);
    const after: any = await (await app.request('/api/v2/skill-bundles/backend')).json();
    expect(after.description).toBe('Backend v2');
    expect(after.skills).toEqual(['a']);

    const del = await json(app, '/api/v2/skill-bundles/backend', undefined, 'DELETE');
    expect(del.status).toBe(200);
    expect((await app.request('/api/v2/skill-bundles/backend')).status).toBe(404);
  });

  it('валидация ссылок на скиллы (validateSkills)', async () => {
    const { app } = makeApp({ validateSkills: async (names) => names.filter((n) => n !== 'known') });
    const res = await json(app, '/api/v2/skill-bundles', {
      name: 'x', description: 'X', skills: ['known', 'missing'],
    }, 'POST');
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error.message).toContain('missing');
  });

  it('конфликт имён → 409', async () => {
    const { app } = makeApp();
    await json(app, '/api/v2/skill-bundles', { name: 'x', description: 'X', skills: ['a'] }, 'POST');
    const dup = await json(app, '/api/v2/skill-bundles', { name: 'x', description: 'X', skills: ['a'] }, 'POST');
    expect(dup.status).toBe(409);
  });

  it('невалидное тело → 400', async () => {
    const { app } = makeApp();
    const res = await json(app, '/api/v2/skill-bundles', { name: 'x', description: 'X', skills: [] }, 'POST');
    expect(res.status).toBe(400);
  });
});

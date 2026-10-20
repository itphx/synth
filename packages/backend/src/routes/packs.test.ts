import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { Context, Next } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createPacksRoutes,
  FilePackStore,
  FilePipelineStore,
  McpRegistryStore,
  RouteRuleStore,
  JsonStore,
  SkillService,
  ContextConfig,
} from '@itphx/synth-core';
import type { AgentDefinition } from '@itphx/synth-shared';
import { requireAdminRoleOrScope } from '../auth/guards.js';

/**
 * Мок AuthKit: пользователь кладётся в контекст глобальным middleware
 * (как в реальном backend — `app.use('*', auth.attachUser)`), а guard'ы только
 * читают `c.get('user')`/`c.get('serviceKey')`.
 *
 * `requirePermission` повторяет семантику реального (`src/auth/middleware.ts`):
 * нет пользователя → 401, нет роли → 403.
 */
function createMockKit(user: { id: string; roles: string[] } | null, scopes?: string[]) {
  const attachUser = createMiddleware(async (c: Context, next: Next) => {
    if (user) c.set('user', user);
    if (scopes) {
      c.set('user', user ?? { id: 'service:svc1', username: 'installer', roles: ['USER'] });
      c.set('serviceKey', { keyId: 'service:svc1', label: 'installer', roles: ['USER'], scopes });
    }
    await next();
  });
  const requirePermission = (...roles: string[]) =>
    createMiddleware(async (c: Context, next: Next) => {
      const current = c.get('user') as { roles?: string[] } | undefined;
      if (!current) {
        return c.json({ error: { code: 'UNAUTHORIZED', message: 'unauthorized' } }, 401);
      }
      if (!roles.some((role) => current.roles?.includes(role))) {
        return c.json({ error: { code: 'FORBIDDEN', message: 'forbidden' } }, 403);
      }
      await next();
    });
  return {
    attachUser,
    requireAuth: createMiddleware(async (_c: Context, next: Next) => { await next(); }),
    requireAdmin: requirePermission('ADMIN'),
    requirePermission,
  };
}

/** Минимальный пакет (без capability-грантов) — ставится сразу. */
const MANIFEST = {
  name: 'synth-media',
  version: '1.0.0',
  kind: 'pack',
  packType: 'automation',
  description: 'Медиа-пак',
  provides: {
    skills: [{ name: 'media-draft', path: 'skills/media-draft' }],
    mcp: [],
    agents: [],
    pipelines: [],
  },
};

const FILES: Record<string, string> = {
  'skills/media-draft/SKILL.md': '---\nname: media-draft\ndescription: Черновик\n---\n\nТело\n',
};

describe('Packs API Routes (backend) — RBAC (ADR-052/ADR-086 §5)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-backend-packs-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function createTestApp(kit: ReturnType<typeof createMockKit>) {
    const app = new Hono();
    const packStore = new FilePackStore({ dataDir: tmpDir });
    const pipelineStore = new FilePipelineStore({ dataDir: tmpDir });
    const mcpRegistry = new McpRegistryStore({ dataDir: tmpDir });
    const routeRules = new RouteRuleStore({ dataDir: tmpDir });
    const agentStore = new JsonStore<AgentDefinition>({ dataDir: tmpDir, subdir: 'agents' });
    const skillService = new SkillService({ dataDir: tmpDir });
    const contextConfig = new ContextConfig({ userDataDir: join(tmpDir, 'context') });

    app.use('*', kit.attachUser);
    app.route(
      '/api/v2/packs',
      createPacksRoutes(
        { requireAuth: kit.requireAuth },
        {
          packs: packStore,
          pipelines: pipelineStore,
          skills: skillService,
          mcpRegistry,
          agents: agentStore,
          roleFiles: contextConfig,
          routes: routeRules,
        },
        {
          readGuard: kit.requirePermission('ADMIN'),
          writeGuard: requireAdminRoleOrScope('automation:install'),
          approveGuard: kit.requirePermission('ADMIN'),
          uninstallGuard: kit.requirePermission('ADMIN'),
        },
      ),
    );
    return app;
  }

  it('установка пакета: не-ADMIN → 403; ADMIN → 201', async () => {
    const userApp = createTestApp(createMockKit({ id: 'u1', roles: ['USER'] }));
    const denied = await userApp.request('/api/v2/packs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ manifest: MANIFEST, files: FILES }),
    });
    expect(denied.status).toBe(403);

    const adminApp = createTestApp(createMockKit({ id: 'admin', roles: ['ADMIN'] }));
    const allowed = await adminApp.request('/api/v2/packs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ manifest: MANIFEST, files: FILES }),
    });
    expect(allowed.status).toBe(201);
  });

  it('установка пакета: service-key со scope automation:install → 201; без scope → 403', async () => {
    const withScope = createTestApp(createMockKit(null, ['automation:install']));
    const ok = await withScope.request('/api/v2/packs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ manifest: MANIFEST, files: FILES }),
    });
    expect(ok.status).toBe(201);

    const withoutScope = createTestApp(createMockKit(null, ['events:ingest']));
    const denied = await withoutScope.request('/api/v2/packs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ manifest: MANIFEST, files: FILES }),
    });
    expect(denied.status).toBe(403);
    const body: any = await denied.json();
    expect(body.error.code).toBe('SCOPE_REQUIRED');
  });

  it('снятие и одобрение пакета: не-ADMIN → 403 (только ADMIN)', async () => {
    const adminApp = createTestApp(createMockKit({ id: 'admin', roles: ['ADMIN'] }));
    await adminApp.request('/api/v2/packs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ manifest: MANIFEST, files: FILES }),
    });

    const userApp = createTestApp(createMockKit({ id: 'u1', roles: ['USER'] }));
    const uninstall = await userApp.request('/api/v2/packs/synth-media', { method: 'DELETE' });
    expect(uninstall.status).toBe(403);

    const approve = await userApp.request('/api/v2/packs/synth-media/approve', { method: 'POST' });
    expect(approve.status).toBe(403);
  });
});

/**
 * AD-069 Фаза 2c: тесты read-only эндпоинта прозрачности проектных инструкций
 * (`GET /api/v2/context/instructions`) — scope по сессии/проекту, `no-project`,
 * install-tree/trust/disabled, RBAC.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { InstructionsConfig, InstructionsLazyConfig, Project, Session } from '@itphx/synth-shared';
import { createContextRoutes, type ContextRoutesOptions } from './context.js';
import { SessionManager } from '../../sessions/manager.js';
import { FileStore } from '../../storage/file-store.js';
import { ProjectStore } from '../../storage/project-store.js';
import {
  ProjectInstructionsResolver,
  createInstructionsInfoResolver,
  type ProjectInstructionsDeps,
} from '../../engine/context/instructions.js';
import type { AuthKit } from '../../auth/local.js';

function createMockAuth(): AuthKit {
  return {
    getCurrentUser: () => null,
    requireAuth: async (_c: Context, next: Next) => { await next(); },
  } as unknown as AuthKit;
}

function makeLazy(overrides: Partial<InstructionsLazyConfig> = {}): InstructionsLazyConfig {
  return {
    enabled: true,
    maxAncestors: 5,
    maxChars: 8_000,
    excludeDirs: ['node_modules', '.git', 'vendor', 'dist', 'build', '.next', 'coverage', 'tmp', '.cache'],
    ...overrides,
  };
}

function makeConfig(overrides: Partial<InstructionsConfig> = {}): InstructionsConfig {
  return {
    enabled: true,
    claudeCompat: true,
    contextCompat: false,
    headRatio: 0.7,
    tailRatio: 0.2,
    windowRatio: 0.06,
    minChars: 20_000,
    maxCharsCeiling: 500_000,
    lazy: makeLazy(),
    fetch: { timeoutMs: 5_000, cacheTtlSec: 3_600, maxBytes: 262_144 },
    sources: [],
    excludeProjects: [],
    allowInstallTreeFallback: false,
    ...overrides,
  };
}

/** Стаб git-раннера: `rev-parse --show-toplevel` → root, остальное — ошибка. */
function gitAt(root: string) {
  return async (args: string[]) => {
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
      return { stdout: `${root}\n`, stderr: '' };
    }
    throw new Error(`unexpected git: ${args.join(' ')}`);
  };
}

let tmpDir: string;
let sessionManager: SessionManager;
let projectStore: ProjectStore;

async function write(rel: string, content: string): Promise<void> {
  const abs = join(tmpDir, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf-8');
}

interface MakeAppOpts {
  workspace: string;
  config?: InstructionsConfig;
  deps?: Partial<ProjectInstructionsDeps>;
  routes?: Partial<ContextRoutesOptions>;
}

/** Приложение с реальным резолвером (как в app.ts) + опциональные RBAC-пропсы. */
function makeApp(opts: MakeAppOpts) {
  const config = opts.config ?? makeConfig();
  const resolver = new ProjectInstructionsResolver({
    config,
    runGitFn: gitAt(opts.workspace),
    // По умолчанию доверяем workspace; тесты trust/install-tree переопределяют.
    trustedProjectDirs: [opts.workspace],
    dataDir: tmpDir,
    home: tmpDir,
    ...opts.deps,
  });
  const app = new Hono();
  app.route('/api/v2/context', createContextRoutes(createMockAuth(), {
    resolveInstructions: createInstructionsInfoResolver(resolver, config),
    sessionManager,
    projectStore,
    ...opts.routes,
  }));
  return app;
}

async function saveProject(id: string, workspace: string, ownerId = 'alice'): Promise<Project> {
  const project: Project = {
    id, name: id, ownerId, members: {}, description: '', currentTask: '',
    invariants: '', statusMessages: [], workspace,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  await projectStore.save(project);
  return project;
}

/** Опции доступа как в backend: владелец|ADMIN — сессия, owner/LEAD/ADMIN — проект. */
function accessOpts(getUser: () => string): Partial<ContextRoutesOptions> {
  return {
    resolveUserId: () => getUser(),
    canAccess: (s: Session, _c: Context, uid: string) => (s.ownerId ?? s.userId) === uid || uid === 'admin',
    canAccessProject: (p: Project, _c: Context, uid: string) =>
      p.ownerId === uid || uid === 'admin' || uid === 'lead',
  };
}

const projectWs = () => join(tmpDir, 'repo');

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'synth-context-routes-'));
  sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
  projectStore = new ProjectStore({ dataDir: tmpDir });
  await write('repo/AGENTS.md', 'REPO-INSTRUCTIONS');
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('GET /api/v2/context/instructions (AD-069 §9.3)', () => {
  it('session scope: резолвит инструкции проекта сессии', async () => {
    const ws = projectWs();
    await saveProject('p1', ws);
    const session = await sessionManager.createSession({ engine: 'synth', projectId: 'p1' });
    const app = makeApp({
      workspace: ws,
      routes: { resolveProjectWorkspace: async (id) => (id === 'p1' ? ws : undefined) },
    });

    const res = await app.request(`/api/v2/context/instructions?session_id=${session.id}`);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.session_id).toBe(session.id);
    expect(body.enabled).toBe(true);
    // windowRatio 0.06 * 128_000 = 7 680, но floor minChars 20 000.
    expect(body.cap.chars).toBe(20_000);
    expect(body.cap.source).toBe('dynamic');
    expect(body.files.map((f: any) => f.path)).toContain('./AGENTS.md');
    expect(body.files[0]).toMatchObject({ kind: 'chain', chars: 17, truncated: false, status: 'loaded' });
    expect(body.diagnostics.some((d: any) => d.code === 'loaded')).toBe(true);
  });

  it('session scope: cap.source=override при instructions.maxChars', async () => {
    const ws = projectWs();
    await saveProject('p1', ws);
    const session = await sessionManager.createSession({ engine: 'synth', projectId: 'p1' });
    const app = makeApp({
      workspace: ws,
      config: makeConfig({ maxChars: 1_000 }),
      routes: { resolveProjectWorkspace: async () => ws },
    });
    const body: any = await (await app.request(`/api/v2/context/instructions?session_id=${session.id}`)).json();
    expect(body.cap).toMatchObject({ chars: 1_000, source: 'override' });
  });

  it('session без проекта → пустой результат с причиной no-project', async () => {
    const session = await sessionManager.createSession({ engine: 'synth' });
    const app = makeApp({ workspace: projectWs() });
    const res = await app.request(`/api/v2/context/instructions?session_id=${session.id}`);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.files).toEqual([]);
    expect(body.diagnostics).toEqual([
      expect.objectContaining({ level: 'info', code: 'no-project' }),
    ]);
  });

  it('project scope: резолвит инструкции проекта', async () => {
    const ws = projectWs();
    await saveProject('p1', ws);
    const app = makeApp({
      workspace: ws,
      routes: { resolveProjectWorkspace: async (id) => (id === 'p1' ? ws : undefined) },
    });
    const res = await app.request('/api/v2/context/instructions?project_id=p1');
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.project_id).toBe('p1');
    expect(body.files.map((f: any) => f.path)).toContain('./AGENTS.md');
  });

  it('project scope без workspace → no-project', async () => {
    await projectStore.save({
      id: 'p-nws', name: 'P', ownerId: 'alice', members: {}, description: '', currentTask: '',
      invariants: '', statusMessages: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    const app = makeApp({ workspace: projectWs() });
    const body: any = await (await app.request('/api/v2/context/instructions?project_id=p-nws')).json();
    expect(body.files).toEqual([]);
    expect(body.diagnostics.some((d: any) => d.code === 'no-project')).toBe(true);
  });

  it('недоверенный проект → файлы не грузятся, причина в diagnostics', async () => {
    const ws = projectWs();
    await saveProject('p1', ws);
    const app = makeApp({
      workspace: ws,
      deps: { trustedProjectDirs: [] },
      routes: { resolveProjectWorkspace: async () => ws },
    });
    const body: any = await (await app.request('/api/v2/context/instructions?project_id=p1')).json();
    expect(body.files).toEqual([]);
    const diag = body.diagnostics.find((d: any) => d.code === 'untrusted');
    expect(diag).toMatchObject({ level: 'warning' });
    expect(diag.message).toContain('trustedProjectDirs');
    expect(body.diagnostics.some((d: any) => d.code === 'skipped-install-tree')).toBe(false);
  });

  it('install-tree guard → инструкции не грузятся', async () => {
    const root = join(tmpDir, 'synth-src');
    await write('synth-src/package.json', JSON.stringify({ name: 'x', dependencies: { '@itphx/synth-core': '1' } }));
    await write('synth-src/repo/AGENTS.md', 'CONTRIBUTOR-INSTRUCTIONS');
    const ws = join(root, 'repo');
    await saveProject('p1', ws);
    const app = makeApp({
      workspace: ws,
      deps: { trustedProjectDirs: [ws] },
      routes: { resolveProjectWorkspace: async () => ws },
    });
    const body: any = await (await app.request('/api/v2/context/instructions?project_id=p1')).json();
    expect(body.files).toEqual([]);
    const diag = body.diagnostics.find((d: any) => d.code === 'skipped-install-tree');
    expect(diag).toMatchObject({ level: 'warning' });
    expect(diag.message).toContain('install-tree');
  });

  it('install-tree + allowInstallTreeFallback → инструкции грузятся', async () => {
    const root = join(tmpDir, 'synth-src2');
    await write('synth-src2/package.json', JSON.stringify({ name: 'x', dependencies: { '@itphx/synth-core': '1' } }));
    await write('synth-src2/repo/AGENTS.md', 'CONTRIBUTOR-INSTRUCTIONS');
    const ws = join(root, 'repo');
    await saveProject('p1', ws);
    const app = makeApp({
      workspace: ws,
      config: makeConfig({ allowInstallTreeFallback: true }),
      deps: { trustedProjectDirs: [ws] },
      routes: { resolveProjectWorkspace: async () => ws },
    });
    const body: any = await (await app.request('/api/v2/context/instructions?project_id=p1')).json();
    expect(body.files.map((f: any) => f.path)).toContain('./AGENTS.md');
  });

  it('instructions.enabled=false → enabled:false, источник пропущен', async () => {
    const ws = projectWs();
    await saveProject('p1', ws);
    const app = makeApp({
      workspace: ws,
      config: makeConfig({ enabled: false }),
      routes: { resolveProjectWorkspace: async () => ws },
    });
    const body: any = await (await app.request('/api/v2/context/instructions?project_id=p1')).json();
    expect(body.enabled).toBe(false);
    expect(body.files).toEqual([]);
    expect(body.diagnostics.some((d: any) => d.code === 'skipped')).toBe(true);
  });

  it('truncated файл → status=truncated, level=warning', async () => {
    const ws = projectWs();
    await write('repo/AGENTS.md', 'P'.repeat(50_000));
    await saveProject('p1', ws);
    const app = makeApp({
      workspace: ws,
      config: makeConfig({ maxChars: 1_000 }),
      routes: { resolveProjectWorkspace: async () => ws },
    });
    const body: any = await (await app.request('/api/v2/context/instructions?project_id=p1')).json();
    const file = body.files.find((f: any) => f.path === './AGENTS.md');
    expect(file?.truncated).toBe(true);
    expect(file?.status).toBe('truncated');
    expect(body.diagnostics.some((d: any) => d.code === 'truncated' && d.level === 'warning')).toBe(true);
  });

  it('без scope → 400; неизвестные id → 404', async () => {
    const app = makeApp({ workspace: projectWs() });
    expect((await app.request('/api/v2/context/instructions')).status).toBe(400);
    expect((await app.request('/api/v2/context/instructions?project_id=nope')).status).toBe(404);
    expect((await app.request('/api/v2/context/instructions?session_id=nope')).status).toBe(404);
  });
});

describe('GET /api/v2/context/instructions — контроль доступа (RBAC)', () => {
  it('session: чужой USER → 403; владелец и ADMIN → 200', async () => {
    const ws = projectWs();
    await saveProject('p1', ws);
    let user = 'bob';
    const app = makeApp({
      workspace: ws,
      routes: {
        ...accessOpts(() => user),
        resolveProjectWorkspace: async () => ws,
      },
    });
    const session = await sessionManager.createSession({
      engine: 'synth', projectId: 'p1', ownerId: 'alice', userId: 'alice',
    });

    expect((await app.request(`/api/v2/context/instructions?session_id=${session.id}`)).status).toBe(403);

    user = 'alice';
    expect((await app.request(`/api/v2/context/instructions?session_id=${session.id}`)).status).toBe(200);

    user = 'admin';
    expect((await app.request(`/api/v2/context/instructions?session_id=${session.id}`)).status).toBe(200);
  });

  it('project: чужой USER → 403; owner/LEAD/ADMIN → 200', async () => {
    const ws = projectWs();
    await saveProject('p1', ws, 'alice');
    let user = 'outsider';
    const app = makeApp({
      workspace: ws,
      routes: {
        ...accessOpts(() => user),
        resolveProjectWorkspace: async () => ws,
      },
    });

    expect((await app.request('/api/v2/context/instructions?project_id=p1')).status).toBe(403);

    user = 'alice';
    expect((await app.request('/api/v2/context/instructions?project_id=p1')).status).toBe(200);

    user = 'lead';
    expect((await app.request('/api/v2/context/instructions?project_id=p1')).status).toBe(200);

    user = 'admin';
    expect((await app.request('/api/v2/context/instructions?project_id=p1')).status).toBe(200);
  });
});

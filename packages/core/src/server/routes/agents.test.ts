import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentRoutes } from './agents.js';
import { JsonStore } from '../../storage/json-store.js';
import { ContextConfig } from '../../engine/context/config.js';
import { DEFAULT_AGENT_ID } from '../../engine/agents/index.js';
import type { AgentDefinition } from '@itphx/synth-shared';
import type { AuthKit } from '../../auth/local.js';

function createMockAuth(): AuthKit {
  return {
    getCurrentUser: () => null,
    requireAuth: async (_c: Context, next: Next) => { await next(); },
  } as unknown as AuthKit;
}

describe('Agent API Routes — default_agent', () => {
  let tmpDir: string;
  let store: JsonStore<AgentDefinition>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-core-agents-test-'));
    store = new JsonStore<AgentDefinition>({ dataDir: tmpDir, subdir: 'agents' });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function createTestApp(getDefaultAgentId?: () => string | Promise<string>) {
    const app = new Hono();
    app.route('/api/v2/agents', createAgentRoutes(createMockAuth(), store, undefined, getDefaultAgentId));
    return app;
  }

  it('GET /agents без геттера отдаёт DEFAULT_AGENT_ID', async () => {
    const app = createTestApp();
    const res = await app.request('/api/v2/agents');
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.default_agent).toBe(DEFAULT_AGENT_ID);
  });

  it('GET /agents отдаёт значение геттера', async () => {
    const app = createTestApp(() => 'analyst');
    const res = await app.request('/api/v2/agents');
    const body: any = await res.json();
    expect(body.default_agent).toBe('analyst');
  });

  it('GET /agents/all отдаёт значение геттера', async () => {
    const app = createTestApp(async () => 'developer');
    const res = await app.request('/api/v2/agents/all');
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.default_agent).toBe('developer');
  });
});

describe('Agent API Routes — CRUD (core superset)', () => {
  let tmpDir: string;
  let store: JsonStore<AgentDefinition>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-core-agents-crud-'));
    store = new JsonStore<AgentDefinition>({ dataDir: tmpDir, subdir: 'agents' });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function createTestApp() {
    const app = new Hono();
    app.route('/api/v2/agents', createAgentRoutes(createMockAuth(), store));
    return app;
  }

  it('GET /agents/all: is_builtin отражает реальную принадлежность', async () => {
    const app = createTestApp();
    await app.request('/api/v2/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'custom1', display_name: 'Custom' }),
    });

    const res = await app.request('/api/v2/agents/all');
    const body: any = await res.json();
    const builtin = body.agents.find((a: any) => a.id === 'assistant');
    const custom = body.agents.find((a: any) => a.id === 'custom1');
    expect(builtin.is_builtin).toBe(true);
    expect(custom.is_builtin).toBe(false);
  });

  it('POST /agents сохраняет topK и берёт fallback из builtin', async () => {
    const app = createTestApp();
    const res = await app.request('/api/v2/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'assistant', top_k: 50 }),
    });
    expect(res.status).toBe(201);
    const stored = await store.load('assistant');
    expect(stored?.topK).toBe(50);
    expect(stored?.displayName).toBe('Ассистент');
    expect(Array.isArray(stored?.capabilities)).toBe(true);
    expect((stored?.capabilities ?? []).length).toBeGreaterThan(0);
  });

  it('GET /agents/:id отдаёт builtin и 404 для неизвестного', async () => {
    const app = createTestApp();
    const ok = await app.request('/api/v2/agents/assistant');
    expect(ok.status).toBe(200);
    const agent: any = await ok.json();
    expect(agent.id).toBe('assistant');

    const missing = await app.request('/api/v2/agents/nope');
    expect(missing.status).toBe(404);
    const body: any = await missing.json();
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('PATCH /agents/:id/enabled переключает builtin (override)', async () => {
    const app = createTestApp();
    const res = await app.request('/api/v2/agents/assistant/enabled', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body).toEqual({ id: 'assistant', enabled: false });
    expect((await store.load('assistant'))?.enabled).toBe(false);

    const missing = await app.request('/api/v2/agents/nope/enabled', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    expect(missing.status).toBe(404);
  });

  it('DELETE /agents/:id: builtin без override → 404, custom → deleted, override → reset', async () => {
    const app = createTestApp();

    const builtinNoOverride = await app.request('/api/v2/agents/assistant', { method: 'DELETE' });
    expect(builtinNoOverride.status).toBe(404);

    await app.request('/api/v2/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'custom2', display_name: 'Custom 2' }),
    });
    const customDelete = await app.request('/api/v2/agents/custom2', { method: 'DELETE' });
    expect(customDelete.status).toBe(200);
    expect((await customDelete.json() as any).status).toBe('deleted');

    await app.request('/api/v2/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'assistant', display_name: 'Override' }),
    });
    const reset = await app.request('/api/v2/agents/assistant', { method: 'DELETE' });
    expect(reset.status).toBe(200);
    expect((await reset.json() as any).status).toBe('reset');
    expect(await store.load('assistant')).toBeNull();
  });
});

/**
 * ADR-046/ADR-089: приём ролевого промпта агента вместе с агентом
 * (`role_prompt` в теле POST) и групп агента (`groups`).
 *
 * Роль пишется портом файлов контекста в `{dataDir}/context/roles/<contextFile>`
 * и имеет приоритет над системным `prompts/roles/` (резолв — `getRolePrompt`).
 */
describe('Agent API Routes — ролевой промпт и группы', () => {
  let tmpDir: string;
  let store: JsonStore<AgentDefinition>;
  let contextConfig: ContextConfig;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-core-agents-role-'));
    store = new JsonStore<AgentDefinition>({ dataDir: tmpDir, subdir: 'agents' });
    contextConfig = new ContextConfig({ userDataDir: join(tmpDir, 'context') });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function createTestApp(withRoleFiles = true) {
    const app = new Hono();
    app.route('/api/v2/agents', createAgentRoutes(createMockAuth(), store, undefined, undefined, {
      ...(withRoleFiles ? { roleFiles: contextConfig } : {}),
    }));
    return app;
  }

  async function postAgent(app: Hono, body: Record<string, unknown>) {
    return app.request('/api/v2/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('POST /agents с role_prompt создаёт агента и пишет файл роли', async () => {
    const app = createTestApp();
    const res = await postAgent(app, {
      id: 'analyst2',
      display_name: 'Аналитик 2',
      role_prompt: 'РОЛЬ АНАЛИТИКА 2',
    });
    expect(res.status).toBe(201);

    const body: any = await res.json();
    expect(body.id).toBe('analyst2');
    expect(body.role).toEqual({ file: 'ANALYST2.md', written: true, replaced: false });

    // Файл роли лежит в userRolesDir под дефолтным именем (<ID_UPPER>.md).
    const rolePath = join(contextConfig.userRolesDir, 'ANALYST2.md');
    expect(await readFile(rolePath, 'utf-8')).toBe('РОЛЬ АНАЛИТИКА 2');

    // Агент сохранён; контент роли в определение агента не попадает.
    const stored = await store.load('analyst2');
    expect(stored?.id).toBe('analyst2');
    expect((stored as any).rolePrompt).toBeUndefined();
  });

  it('POST /agents без role_prompt не создаёт файл роли (поведение прежнее)', async () => {
    const app = createTestApp();
    const res = await postAgent(app, { id: 'plain', display_name: 'Без роли' });
    expect(res.status).toBe(201);

    const body: any = await res.json();
    expect(body.role).toBeUndefined();

    // Каталог ролей не создан вовсе — ничего не «протекает» наружу.
    await expect(readdir(contextConfig.userRolesDir)).rejects.toThrow();
  });

  it('POST /agents с пустым role_prompt не создаёт файл роли', async () => {
    const app = createTestApp();
    const res = await postAgent(app, { id: 'empty_role', role_prompt: '   ' });
    expect(res.status).toBe(201);
    await expect(readdir(contextConfig.userRolesDir)).rejects.toThrow();
  });

  it('POST /agents принимает groups и возвращает их в ответе и в реестре', async () => {
    const app = createTestApp();
    const res = await postAgent(app, {
      id: 'grouped',
      display_name: 'Групповой',
      groups: ['writers', 'reviewers'],
    });
    expect(res.status).toBe(201);

    const body: any = await res.json();
    expect(body.groups).toEqual(['writers', 'reviewers']);

    const stored = await store.load('grouped');
    expect(stored?.groups).toEqual(['writers', 'reviewers']);

    const list: any = await (await app.request('/api/v2/agents/all')).json();
    expect(list.agents.find((a: any) => a.id === 'grouped').groups).toEqual(['writers', 'reviewers']);
  });

  it('POST /agents: groups нормализуются (пустые/дубли/не-строки отбрасываются)', async () => {
    const app = createTestApp();
    const res = await postAgent(app, {
      id: 'grouped2',
      groups: ['a', '  ', 'a', 42, ' b '],
    });
    expect(res.status).toBe(201);
    const body: any = await res.json();
    expect(body.groups).toEqual(['a', 'b']);
  });

  it('POST /agents без groups сохраняет ранее заданные группы', async () => {
    const app = createTestApp();
    await postAgent(app, { id: 'grouped3', groups: ['keep'] });
    const res = await postAgent(app, { id: 'grouped3', display_name: 'Обновлён' });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.groups).toEqual(['keep']);
  });

  it('POST /agents перезаписывает существующий файл роли (явная установка)', async () => {
    const app = createTestApp();
    await postAgent(app, { id: 'rewritable', role_prompt: 'РОЛЬ ВЕРСИЯ 1' });
    const res = await postAgent(app, { id: 'rewritable', role_prompt: 'РОЛЬ ВЕРСИЯ 2' });
    expect(res.status).toBe(200);

    const body: any = await res.json();
    expect(body.role).toEqual({ file: 'REWRITABLE.md', written: true, replaced: true });

    const rolePath = join(contextConfig.userRolesDir, 'REWRITABLE.md');
    expect(await readFile(rolePath, 'utf-8')).toBe('РОЛЬ ВЕРСИЯ 2');

    // Атомарность: временных файлов в каталоге ролей не осталось.
    const files = await readdir(contextConfig.userRolesDir);
    expect(files).toEqual(['REWRITABLE.md']);
  });

  it('POST /agents с собственным context_file пишет роль под этим именем', async () => {
    const app = createTestApp();
    const res = await postAgent(app, {
      id: 'customfile',
      context_file: 'CUSTOM_ROLE.md',
      role_prompt: 'РОЛЬ ПО ИМЕНИ',
    });
    expect(res.status).toBe(201);

    const body: any = await res.json();
    expect(body.role).toEqual({ file: 'CUSTOM_ROLE.md', written: true, replaced: false });
    expect(await readFile(join(contextConfig.userRolesDir, 'CUSTOM_ROLE.md'), 'utf-8')).toBe('РОЛЬ ПО ИМЕНИ');
  });

  it('доставленный файл роли перекрывает системный prompts/roles/', async () => {
    const app = createTestApp();

    // Системная роль без override — из prompts/roles/ASSISTANT.ru.md.
    const systemRole = contextConfig.getRolePrompt('assistant', undefined, 'ru');
    expect(systemRole).toContain('[ROLE: ASSISTANT]');

    await postAgent(app, { id: 'assistant', role_prompt: 'ПОЛЬЗОВАТЕЛЬСКАЯ РОЛЬ АССИСТЕНТА' });

    // После доставки роли резолв берёт пользовательский файл.
    expect(contextConfig.getRolePrompt('assistant', undefined, 'ru')).toBe('ПОЛЬЗОВАТЕЛЬСКАЯ РОЛЬ АССИСТЕНТА');
    expect(contextConfig.getRolePrompt('assistant', 'ASSISTANT.md', 'ru')).toBe('ПОЛЬЗОВАТЕЛЬСКАЯ РОЛЬ АССИСТЕНТА');
  });

  it('без порта файлов контекста role_prompt даёт 500 и агент не создаётся', async () => {
    const app = createTestApp(false);
    const res = await postAgent(app, { id: 'no_store', role_prompt: 'РОЛЬ' });
    expect(res.status).toBe(500);
    const body: any = await res.json();
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(await store.load('no_store')).toBeNull();
  });

  it('context_file с путём отклоняется (роль пишется только внутрь каталога ролей)', async () => {
    const app = createTestApp();
    const res = await postAgent(app, {
      id: 'evil',
      context_file: '../../secrets/evil.md',
      role_prompt: 'РОЛЬ',
    });
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(await store.load('evil')).toBeNull();
  });
});

/**
 * ADR-052: запись агентов (создание + ролевой промпт) — гейт
 * «scope `automation:install` (установщик пакетов расширений) **или** роль
 * ADMIN»; для интерактивных кред — no-op (доступ определяет `writeGuard`).
 *
 * Регресс-инвариант: `addons:install` (зонтичный скоуп MCP/скиллов) **не**
 * открывает создание агентов.
 */
describe('Agent API Routes — scope-гейт записи (ADR-052)', () => {
  let tmpDir: string;
  let store: JsonStore<AgentDefinition>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-core-agents-scope-'));
    store = new JsonStore<AgentDefinition>({ dataDir: tmpDir, subdir: 'agents' });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  /** Приложение с service-key в контексте (scope-гейт срабатывает по нему). */
  function createScopedApp(cred?: { roles: string[]; scopes: string[] }) {
    const app = new Hono();
    app.use('*', async (c, next) => {
      if (cred) {
        c.set('serviceKey' as never, {
          keyId: 'svk_1',
          label: 'installer',
          roles: cred.roles,
          scopes: cred.scopes,
        } as never);
      }
      await next();
    });
    app.route('/api/v2/agents', createAgentRoutes(createMockAuth(), store));
    return app;
  }

  const postAgent = (app: Hono, body: Record<string, unknown>) =>
    app.request('/api/v2/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('service-key со scope automation:install → агент создан', async () => {
    const app = createScopedApp({ roles: ['USER'], scopes: ['automation:install'] });
    const res = await postAgent(app, { id: 'installed', display_name: 'Установленный' });
    expect(res.status).toBe(201);
    expect((await store.load('installed'))?.id).toBe('installed');
  });

  it('service-key с ролью ADMIN (без scope) → агент создан (прежние права)', async () => {
    const app = createScopedApp({ roles: ['ADMIN'], scopes: [] });
    const res = await postAgent(app, { id: 'byadmin', display_name: 'От админа' });
    expect(res.status).toBe(201);
    expect((await store.load('byadmin'))?.id).toBe('byadmin');
  });

  it('service-key со scope addons:install → 403 SCOPE_REQUIRED (права не расширились)', async () => {
    const app = createScopedApp({ roles: ['USER'], scopes: ['addons:install'] });
    const res = await postAgent(app, { id: 'nope', display_name: 'Не установленный' });
    expect(res.status).toBe(403);
    const body: any = await res.json();
    expect(body.error.code).toBe('SCOPE_REQUIRED');
    expect(await store.load('nope')).toBeNull();
  });

  it('интерактивные креды (без service-key) — no-op: агент создан', async () => {
    const app = createScopedApp();
    const res = await postAgent(app, { id: 'interactive', display_name: 'Интерактив' });
    expect(res.status).toBe(201);
    expect((await store.load('interactive'))?.id).toBe('interactive');
  });
});

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
    const app = createTestApp(() => 'researcher');
    const res = await app.request('/api/v2/agents');
    const body: any = await res.json();
    expect(body.default_agent).toBe('researcher');
  });

  it('GET /agents/all отдаёт значение геттера', async () => {
    const app = createTestApp(async () => 'fixer');
    const res = await app.request('/api/v2/agents/all');
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.default_agent).toBe('fixer');
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

  it('POST /agents: temperature задаётся, наследуется и сбрасывается null-ом (Auto)', async () => {
    const app = createTestApp();

    // 1. Явное значение сохраняется
    const created = await app.request('/api/v2/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'temp-agent', display_name: 'Temp', temperature: 0.25 }),
    });
    expect(created.status).toBe(201);
    expect((await store.load('temp-agent'))?.temperature).toBe(0.25);

    // 2. Поле не передано — значение прежней записи сохраняется
    await app.request('/api/v2/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'temp-agent', display_name: 'Temp' }),
    });
    expect((await store.load('temp-agent'))?.temperature).toBe(0.25);

    // 3. `null` — явный сброс в Auto (поле не задано, а не унаследовано)
    const reset = await app.request('/api/v2/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'temp-agent', display_name: 'Temp', temperature: null }),
    });
    expect(reset.status).toBe(200);
    expect((await store.load('temp-agent'))?.temperature).toBeUndefined();
  });

  it('POST /agents: effort принимается, отдаётся, сбрасывается null-ом, невалидный — 400', async () => {
    const app = createTestApp();

    // 1. Явный тир (`xhigh` из уровня размышлений не выводится) — сохраняется.
    const created = await app.request('/api/v2/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'effort-agent', display_name: 'Effort', effort: 'xhigh' }),
    });
    expect(created.status).toBe(201);
    const createdBody: any = await created.json();
    expect(createdBody.effort).toBe('xhigh');
    expect((await store.load('effort-agent'))?.effort).toBe('xhigh');

    // 2. Поле отдаётся в списке (`GET /agents/all`).
    const all = await app.request('/api/v2/agents/all');
    const list: any = await all.json();
    expect(list.agents.find((a: any) => a.id === 'effort-agent').effort).toBe('xhigh');

    // 3. Поле не передано — прежнее значение сохраняется.
    await app.request('/api/v2/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'effort-agent', display_name: 'Effort' }),
    });
    expect((await store.load('effort-agent'))?.effort).toBe('xhigh');

    // 4. `null` — сброс в «Авто» (тир из уровня размышлений).
    const reset = await app.request('/api/v2/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'effort-agent', display_name: 'Effort', effort: null }),
    });
    expect(reset.status).toBe(200);
    expect((await store.load('effort-agent'))?.effort).toBeUndefined();

    // 5. Невалидное значение — 400, запись не меняется.
    const invalid = await app.request('/api/v2/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'effort-agent', display_name: 'Effort', effort: 'ultra' }),
    });
    expect(invalid.status).toBe(400);
    const invalidBody: any = await invalid.json();
    expect(invalidBody.error.code).toBe('VALIDATION_ERROR');
    expect((await store.load('effort-agent'))?.effort).toBeUndefined();
  });

  it('GET /agents/:id отдаёт builtin и 404 для неизвестного', async () => {    const app = createTestApp();
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
 * ADR-126/ADR-089: приём ролевого промпта агента вместе с агентом
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

/**
 * PROP-135 Ф6a: профиль исполнения агента (`executor_profile`) и потолок
 * разрешённых профилей (`allowed_profiles`) в admin-API агентов.
 *
 * Каталог профилей передаётся опцией (`executionProfileCatalog`): при его
 * наличии профиль обязан существовать, список — быть подмножеством каталога;
 * без каталога (inline/instance-пул) проверка пропускается.
 */
describe('Agent API Routes — профиль исполнения агента (PROP-135 Ф6a)', () => {
  let tmpDir: string;
  let store: JsonStore<AgentDefinition>;

  const CATALOG = {
    profiles: ['default', 'devops', 'sandbox'],
    defaultProfile: 'default',
  };

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-core-agents-executor-'));
    store = new JsonStore<AgentDefinition>({ dataDir: tmpDir, subdir: 'agents' });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function createTestApp(catalog: typeof CATALOG | null = CATALOG) {
    const app = new Hono();
    app.route('/api/v2/agents', createAgentRoutes(createMockAuth(), store, undefined, undefined, {
      ...(catalog ? { executionProfileCatalog: catalog } : {}),
    }));
    return app;
  }

  const postAgent = (app: Hono, body: Record<string, unknown>) =>
    app.request('/api/v2/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('DTO: встроенные профили агентов и null у системного агента без профилей', async () => {
    const app = createTestApp();
    const list: any = await (await app.request('/api/v2/agents/all')).json();
    // PROP-135 Ф6a: у встроенного ассистента есть профиль по умолчанию и потолок.
    const assistant = list.agents.find((a: any) => a.id === 'assistant');
    expect(assistant.executor_profile).toBe('default');
    expect(assistant.allowed_profiles).toEqual(['default', 'light']);
    // У системного генератора заголовков профилей нет — DTO отдаёт null.
    const title = list.agents.find((a: any) => a.id === 'title');
    expect(title.executor_profile).toBeNull();
    expect(title.allowed_profiles).toBeNull();
  });

  it('POST сохраняет профиль и потолок (snake_case) и отдаёт их в DTO', async () => {
    const app = createTestApp();
    const res = await postAgent(app, {
      id: 'exec-agent',
      display_name: 'Exec',
      executor_profile: 'devops',
      allowed_profiles: ['devops', 'default'],
    });
    expect(res.status).toBe(201);
    // POST отдаёт определение агента (camelCase), DTO списка — snake_case.
    const body: any = await res.json();
    expect(body.executorProfile).toBe('devops');
    expect(body.allowedProfiles).toEqual(['devops', 'default']);

    const stored = await store.load('exec-agent');
    expect(stored?.executorProfile).toBe('devops');
    expect(stored?.allowedProfiles).toEqual(['devops', 'default']);

    const list: any = await (await app.request('/api/v2/agents/all')).json();
    const item = list.agents.find((a: any) => a.id === 'exec-agent');
    expect(item.executor_profile).toBe('devops');
    expect(item.allowed_profiles).toEqual(['devops', 'default']);
  });

  it('POST принимает camelCase (executorProfile/allowedProfiles)', async () => {
    const app = createTestApp();
    const res = await postAgent(app, {
      id: 'exec-camel',
      executorProfile: 'sandbox',
      allowedProfiles: ['sandbox'],
    });
    expect(res.status).toBe(201);
    expect((await store.load('exec-camel'))?.executorProfile).toBe('sandbox');
    expect((await store.load('exec-camel'))?.allowedProfiles).toEqual(['sandbox']);
  });

  it('POST сбрасывает профиль (null/пустая строка); [] — «профилей нет»', async () => {
    const app = createTestApp();
    await postAgent(app, {
      id: 'exec-reset',
      executor_profile: 'devops',
      allowed_profiles: ['devops'],
    });

    // `null` — сброс профиля; `[]` — «профилей нет» (ADR-135, аддендум).
    const reset = await postAgent(app, {
      id: 'exec-reset',
      executor_profile: null,
      allowed_profiles: [],
    });
    expect(reset.status).toBe(200);
    const resetBody: any = await reset.json();
    expect(resetBody.executorProfile).toBeUndefined();
    expect(resetBody.allowedProfiles).toEqual([]);
    expect((await store.load('exec-reset'))?.executorProfile).toBeUndefined();
    expect((await store.load('exec-reset'))?.allowedProfiles).toEqual([]);

    // `null` у списка — сброс (потолок не задан).
    const cleared = await postAgent(app, { id: 'exec-reset', allowed_profiles: null });
    expect(cleared.status).toBe(200);
    expect((await store.load('exec-reset'))?.allowedProfiles).toBeUndefined();

    // Пустая строка — тот же сброс (UI шлёт `''` при выборе «наследовать»).
    await postAgent(app, { id: 'exec-reset', executor_profile: 'devops' });
    const empty = await postAgent(app, { id: 'exec-reset', executor_profile: '' });
    expect(empty.status).toBe(200);
    expect((await store.load('exec-reset'))?.executorProfile).toBeUndefined();
  });

  it('POST без полей сохраняет прежние значения', async () => {
    const app = createTestApp();
    await postAgent(app, {
      id: 'exec-keep',
      executor_profile: 'devops',
      allowed_profiles: ['devops'],
    });
    const res = await postAgent(app, { id: 'exec-keep', display_name: 'Обновлён' });
    expect(res.status).toBe(200);
    expect((await store.load('exec-keep'))?.executorProfile).toBe('devops');
    expect((await store.load('exec-keep'))?.allowedProfiles).toEqual(['devops']);
  });

  it('профиль вне списка разрешённых → 400 (ADR-135: пустой список = ничего)', async () => {
    const app = createTestApp();
    const res = await postAgent(app, {
      id: 'exec-outside',
      executor_profile: 'devops',
      allowed_profiles: ['sandbox'],
    });
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toContain('должен входить в список разрешённых');
    expect(await store.load('exec-outside')).toBeNull();
  });

  it('профиль при пустом списке разрешённых → 400 (профилей нет)', async () => {
    const app = createTestApp();
    const res = await postAgent(app, {
      id: 'exec-emptylist',
      executor_profile: 'devops',
      allowed_profiles: [],
    });
    expect(res.status).toBe(400);
    expect((await res.json() as any).error.code).toBe('VALIDATION_ERROR');
    expect(await store.load('exec-emptylist')).toBeNull();
  });

  it('инстанс-дефолт обязан входить в список (наследование профиля)', async () => {
    const app = createTestApp();
    // Профиль не задан → агент наследует профиль инстанса ('default'):
    // он обязан быть в списке разрешённых.
    const res = await postAgent(app, {
      id: 'exec-nodefault',
      allowed_profiles: ['devops'],
    });
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toContain('Профиль по умолчанию');

    // Список с дефолтом — принимается.
    const ok = await postAgent(app, {
      id: 'exec-withdefault',
      allowed_profiles: ['devops', 'default'],
    });
    expect(ok.status).toBe(201);
    expect((await store.load('exec-withdefault'))?.allowedProfiles).toEqual(['devops', 'default']);
  });

  it('неизвестный профиль при каталоге → 400 VALIDATION_ERROR, запись не меняется', async () => {
    const app = createTestApp();
    const res = await postAgent(app, { id: 'exec-bad', executor_profile: 'ghost' });
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toContain('не найден');
    expect(await store.load('exec-bad')).toBeNull();
  });

  it('allowed_profiles — только подмножество каталога', async () => {
    const app = createTestApp();
    const res = await postAgent(app, {
      id: 'exec-bad-list',
      allowed_profiles: ['devops', 'ghost'],
    });
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toContain('ghost');
    expect(await store.load('exec-bad-list')).toBeNull();
  });

  it('невалидный тип полей → 400 VALIDATION_ERROR', async () => {
    const app = createTestApp();
    const wrongProfile = await postAgent(app, { id: 'exec-type', executor_profile: 42 });
    expect(wrongProfile.status).toBe(400);
    expect((await wrongProfile.json() as any).error.code).toBe('VALIDATION_ERROR');

    const wrongList = await postAgent(app, { id: 'exec-type', allowed_profiles: 'devops' });
    expect(wrongList.status).toBe(400);
    expect((await wrongList.json() as any).error.code).toBe('VALIDATION_ERROR');
  });

  it('без каталога профилей проверка пропускается', async () => {
    const app = createTestApp(null);
    const res = await postAgent(app, {
      id: 'exec-nocatalog',
      executor_profile: 'anything',
      allowed_profiles: ['anything', 'else'],
    });
    expect(res.status).toBe(201);
    expect((await store.load('exec-nocatalog'))?.executorProfile).toBe('anything');
    expect((await store.load('exec-nocatalog'))?.allowedProfiles).toEqual(['anything', 'else']);
  });
});

/**
 * PROP-135 (браузерный контур): профиль браузерного пула агента
 * (`browser_profile`) и его потолок (`allowed_browser_profiles`).
 *
 * Каталог — отдельный (`browserProfileCatalog`): exec-имена не принимаются.
 */
describe('Agent API Routes — браузерный профиль агента (PROP-135)', () => {
  let tmpDir: string;
  let store: JsonStore<AgentDefinition>;

  const BROWSER_CATALOG = {
    profiles: ['browser', 'browser-full'],
    defaultProfile: 'browser',
  };

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-core-agents-browser-'));
    store = new JsonStore<AgentDefinition>({ dataDir: tmpDir, subdir: 'agents' });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function createBrowserApp(catalog: typeof BROWSER_CATALOG | null = BROWSER_CATALOG) {
    const app = new Hono();
    app.route('/api/v2/agents', createAgentRoutes(createMockAuth(), store, undefined, undefined, {
      ...(catalog ? { browserProfileCatalog: catalog } : {}),
    }));
    return app;
  }

  const postAgent = (app: Hono, body: Record<string, unknown>) =>
    app.request('/api/v2/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('DTO: browser_profile/allowed_browser_profiles есть у агента, null без профиля', async () => {
    const app = createBrowserApp();
    await postAgent(app, {
      id: 'browser-agent',
      browser_profile: 'browser-full',
      allowed_browser_profiles: ['browser-full'],
    });

    const list = (await (await app.request('/api/v2/agents/all')).json()) as {
      agents: Array<{ id: string; browser_profile: string | null; allowed_browser_profiles: string[] | null }>;
    };
    const item = list.agents.find((a) => a.id === 'browser-agent')!;
    expect(item.browser_profile).toBe('browser-full');
    expect(item.allowed_browser_profiles).toEqual(['browser-full']);

    // У системного агента браузерного профиля нет — DTO отдаёт null.
    const title = list.agents.find((a) => a.id === 'title')!;
    expect(title.browser_profile).toBeNull();
    expect(title.allowed_browser_profiles).toBeNull();
  });

  it('POST сохраняет browser_profile (snake_case и camelCase)', async () => {
    const app = createBrowserApp();
    const snake = await postAgent(app, {
      id: 'browser-snake',
      browser_profile: 'browser-full',
      allowed_browser_profiles: ['browser', 'browser-full'],
    });
    expect(snake.status).toBe(201);
    const body = (await snake.json()) as { browserProfile: string; allowedBrowserProfiles: string[] };
    expect(body.browserProfile).toBe('browser-full');
    expect(body.allowedBrowserProfiles).toEqual(['browser', 'browser-full']);

    const camel = await postAgent(app, {
      id: 'browser-camel',
      browserProfile: 'browser',
      allowedBrowserProfiles: ['browser'],
    });
    expect(camel.status).toBe(201);
    expect((await store.load('browser-camel'))?.browserProfile).toBe('browser');
    expect((await store.load('browser-camel'))?.allowedBrowserProfiles).toEqual(['browser']);
  });

  it('POST сбрасывает browser_profile (null/пустая строка); [] — «профилей нет»', async () => {
    const app = createBrowserApp();
    await postAgent(app, {
      id: 'browser-reset',
      browser_profile: 'browser-full',
      allowed_browser_profiles: ['browser-full'],
    });

    const reset = await postAgent(app, {
      id: 'browser-reset',
      browser_profile: null,
      allowed_browser_profiles: [],
    });
    expect(reset.status).toBe(200);
    expect((await store.load('browser-reset'))?.browserProfile).toBeUndefined();
    // ADR-135 (аддендум): пустой список — «профилей нет» (fail-closed), а не
    // сброс ограничения: список сохраняется как есть.
    expect((await store.load('browser-reset'))?.allowedBrowserProfiles).toEqual([]);

    // `null` у списка — сброс (потолок не задан).
    const cleared = await postAgent(app, {
      id: 'browser-reset',
      allowed_browser_profiles: null,
    });
    expect(cleared.status).toBe(200);
    expect((await store.load('browser-reset'))?.allowedBrowserProfiles).toBeUndefined();

    await postAgent(app, { id: 'browser-reset', browser_profile: 'browser' });
    const empty = await postAgent(app, { id: 'browser-reset', browser_profile: '' });
    expect(empty.status).toBe(200);
    expect((await store.load('browser-reset'))?.browserProfile).toBeUndefined();
  });

  it('неизвестный браузерный профиль → 400 «Профиль браузера не найден»', async () => {
    const app = createBrowserApp();
    const res = await postAgent(app, { id: 'browser-bad', browser_profile: 'ghost' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toContain('Профиль браузера не найден');
    expect(await store.load('browser-bad')).toBeNull();

    const list = await postAgent(app, {
      id: 'browser-bad-list',
      allowed_browser_profiles: ['browser', 'ghost'],
    });
    expect(list.status).toBe(400);
    expect((await list.json() as { error: { message: string } }).error.message).toContain('ghost');
  });

  it('exec-имя в браузерном контуре не принимается (каталоги раздельные)', async () => {
    const app = createBrowserApp();
    const res = await postAgent(app, { id: 'browser-mixed', browser_profile: 'devops' });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: { message: string } }).error.message).toContain('Профиль браузера не найден');
  });

  it('без каталога проверка пропускается', async () => {
    const app = createBrowserApp(null);
    const res = await postAgent(app, {
      id: 'browser-nocatalog',
      browser_profile: 'anything',
      allowed_browser_profiles: ['anything'],
    });
    expect(res.status).toBe(201);
    expect((await store.load('browser-nocatalog'))?.browserProfile).toBe('anything');
  });

  it('профиль вне списка разрешённых → 400; дефолт обязан входить в список', async () => {
    const app = createBrowserApp();
    const outside = await postAgent(app, {
      id: 'browser-outside',
      browser_profile: 'browser-full',
      allowed_browser_profiles: ['browser'],
    });
    expect(outside.status).toBe(400);
    expect((await outside.json() as { error: { message: string } }).error.message)
      .toContain('должен входить в список разрешённых');

    // Наследование: браузерный дефолт ('browser') обязан быть в списке.
    const noDefault = await postAgent(app, {
      id: 'browser-nodefault',
      allowed_browser_profiles: ['browser-full'],
    });
    expect(noDefault.status).toBe(400);
    expect((await noDefault.json() as { error: { message: string } }).error.message)
      .toContain('по умолчанию');
  });
});

/**
 * Событие шины `mcp.updated` на HTTP-путях реестра MCP.
 *
 * Баг: «панель MCP показывает старый состав серверов, пока не перезагрузишь
 * страницу». Причина — сервер молчал о мутации реестра: панелям MCP и
 * селекторам серверов нечего было перечитывать, если правка пришла из чата
 * (тулы `synth_mcp_*`) или из другой вкладки.
 *
 * Контракт проверяется здесь целиком:
 * - публикуется на `POST/PUT/DELETE /servers` и `POST/PUT/DELETE /registry`;
 * - **не** публикуется при ошибке валидации (400), конфликте (409) и 404;
 * - `PUT /session/:sessionId` публикует `session.updated` в канал этой сессии
 *   (тот же путь, что у тула `synth_mcp_enable`) плюс `mcp.updated` со
 *   `scope: 'session'`;
 * - `PUT /projects/:id/mcp` публикует `project.updated` (канал каждой сессии
 *   проекта) плюс `mcp.updated` со `scope: 'project'`;
 * - payload — только имя/вид мутации/область: конфиг сервера (а с ним `env`,
 *   `headers`, `auth`) в событие не попадает ни при каких условиях — в нём
 *   бывают секреты (инвариант 13 `AGENTS.md`).
 *
 * Шина подменена фейком (`onMcpChanged` — тот же хук, что у
 * `mcpChangedPublisher`): тест про контракт фабрики, а не про EventBus.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { nowISO, type McpRegistryEntry, type Project, type Session, type SessionMeta } from '@itphx/synth-shared';
import { createMcpRegistryRoutes } from './mcp-registry.js';
import type { McpRegistryRoutesOptions } from './mcp-registry.js';
import { createProjectRoutes } from './projects.js';
import type { McpRegistryRepository } from '../../storage/ports/mcp-registry-repository.js';
import type { ProjectRepository } from '../../storage/ports/project-repository.js';
import type { SessionManager } from '../../sessions/manager.js';
import type { McpChangedInfo } from '../../events/mcp-events.js';
import { publishMcpUpdated } from '../../events/mcp-events.js';

/** Записанное событие (канал + тип + payload). */
interface PublishedEvent {
  channel: string;
  type: string;
  data: Record<string, unknown>;
}

/** Фейковая шина: пишет и инстансные события, и события канала сессии. */
function makeBus(published: PublishedEvent[]) {
  return {
    publishInstance: (type: string, data: Record<string, unknown> = {}) => {
      published.push({ channel: 'instance', type, data });
    },
    publish: (channel: string, type: string, data: Record<string, unknown> = {}) => {
      published.push({ channel, type, data });
    },
  };
}

/**
 * Auth-заглушка: кладёт в контекст ADMIN-пользователя и пропускает дальше.
 *
 * Так проверяются и `requireAuth`, и guard'ы `requireAdmin`/`requireAdminOrScope`/
 * `requireScopeForServiceKey` (в тесте они все — passthrough) и проверка
 * владельца сессии (`sessionOwnerGuard` читает `c.get('user')`).
 */
const requireAuth = createMiddleware(async (c, next) => {
  c.set('user' as never, { id: 'u1', username: 'u1', roles: ['ADMIN'] } as never);
  await next();
});

/** Запись реестра MCP для теста (конфиг — с безобидным заголовком). */
function makeEntry(partial: Partial<McpRegistryEntry> & Pick<McpRegistryEntry, 'name'>): McpRegistryEntry {
  const { name, ...rest } = partial;
  return {
    schemaVersion: 1,
    id: `mcp_${name}`,
    name,
    config: {
      type: 'http',
      url: 'https://93.184.216.34/mcp',
      // Заголовок не секретный (иначе запись отвергнет guard) — но в событие
      // он всё равно попасть не должен: payload — только имя и вид мутации.
      headers: { 'x-trace': '1' },
    },
    origin: 'instance',
    author: { userId: 'u1', username: 'u1' },
    trust: 'builtin',
    enabled: true,
    enabledByDefault: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...rest,
  };
}

/** Минимальный in-memory порт реестра MCP (без менеджера MCP в тесте). */
function makeRegistry(entries: McpRegistryEntry[] = []): McpRegistryRepository {
  const state = { entries };
  return {
    list: async () => [...state.entries],
    get: async (id: string) => state.entries.find((entry) => entry.id === id) ?? null,
    getByName: async (name: string) => state.entries.find((entry) => entry.name === name) ?? null,
    add: async (input: { name: string; config: McpRegistryEntry['config'] }) => {
      const entry = makeEntry({ name: input.name, config: input.config });
      state.entries.push(entry);
      return entry;
    },
    update: async (id: string, patch: Partial<McpRegistryEntry>) => {
      const index = state.entries.findIndex((entry) => entry.id === id);
      if (index === -1) return null;
      const updated = { ...state.entries[index]!, ...patch } as McpRegistryEntry;
      state.entries[index] = updated;
      return updated;
    },
    remove: async (id: string) => {
      const index = state.entries.findIndex((entry) => entry.id === id);
      if (index === -1) return false;
      state.entries.splice(index, 1);
      return true;
    },
  } as unknown as McpRegistryRepository;
}

/** Сессия + порт `mutateMeta` поверх in-memory объекта (как в файловой реализации). */
function makeSessionManager(meta: SessionMeta & { messages?: unknown[] }) {
  return {
    getSession: async () => meta as unknown as Session,
    mutateMeta: async (
      _id: string,
      mutator: (m: SessionMeta) => unknown,
      opts?: { shouldWrite?: (value: unknown) => boolean },
    ) => {
      const value = mutator(meta);
      if (opts?.shouldWrite && !opts.shouldWrite(value)) {
        return { found: true as const, value, session: meta };
      }
      return { found: true as const, value, session: meta };
    },
  } as unknown as SessionManager;
}

function makeSessionMeta(): SessionMeta & { messages?: unknown[] } {
  return {
    id: 's1',
    userId: 'u1',
    ownerId: 'u1',
    projectId: 'p1',
    settings: { mcpServers: [], mcpDisabledServers: [] },
    updatedAt: '2026-01-01T00:00:00.000Z',
  } as unknown as SessionMeta;
}

describe('POST/PUT/DELETE /mcp — событие mcp.updated', () => {
  let published: PublishedEvent[];
  let bus: ReturnType<typeof makeBus>;
  let registry: McpRegistryRepository;

  beforeEach(() => {
    published = [];
    bus = makeBus(published);
    registry = makeRegistry([makeEntry({ name: 'srv' })]);
  });

  function createTestApp() {
    const app = new Hono();
    // Хуки — те же, что ставит точка сборки: `mcpChangedPublisher(bus)` + шина
    // для `session.updated`.
    const options: McpRegistryRoutesOptions = {
      registry,
      onMcpChanged: (info: McpChangedInfo) => publishMcpUpdated(bus, info),
      eventBus: bus,
      // Guard'ы — passthrough: тест про события, а не про RBAC (матрицы прав —
      // `session-idor-matrix.test.ts`/`route-access-census.test.ts`).
      requireAdmin: requireAuth,
      requireAdminOrScope: requireAuth,
      requireScopeForServiceKey: requireAuth,
    };
    app.route('/api/v2/mcp', createMcpRegistryRoutes(
      { requireAuth },
      null,
      makeSessionManager(makeSessionMeta()),
      options,
    ));
    return app;
  }

  // --- legacy `/servers*` -------------------------------------------------

  it('POST /servers публикует { name, action: add } в инстансный канал', async () => {
    const app = createTestApp();
    const res = await app.request('/api/v2/mcp/servers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'srv2', config: { type: 'http', url: 'https://93.184.216.34/mcp' } }),
    });
    expect(res.status).toBe(201);
    expect(published).toEqual([
      { channel: 'instance', type: 'mcp.updated', data: { action: 'add', name: 'srv2' } },
    ]);
  });

  it('POST /servers с невалидным телом (400) событие не публикует', async () => {
    const app = createTestApp();
    const res = await app.request('/api/v2/mcp/servers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '', config: { type: 'http' } }),
    });
    expect(res.status).toBe(400);
    expect(published).toEqual([]);
  });

  it('POST /servers с занятым именем (409) событие не публикует', async () => {
    const app = createTestApp();
    const res = await app.request('/api/v2/mcp/servers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'srv', config: { type: 'http', url: 'https://93.184.216.34/mcp' } }),
    });
    expect(res.status).toBe(409);
    expect(published).toEqual([]);
  });

  it('PUT /servers/:name публикует action: update', async () => {
    const app = createTestApp();
    const res = await app.request('/api/v2/mcp/servers/srv', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'http', url: 'https://93.184.216.34/other' }),
    });
    expect(res.status).toBe(200);
    expect(published).toEqual([
      { channel: 'instance', type: 'mcp.updated', data: { action: 'update', name: 'srv' } },
    ]);
  });

  it('PUT /servers/:name неизвестного сервера (404) событие не публикует', async () => {
    const app = createTestApp();
    const res = await app.request('/api/v2/mcp/servers/nosuch', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'http', url: 'https://93.184.216.34/other' }),
    });
    expect(res.status).toBe(404);
    expect(published).toEqual([]);
  });

  it('DELETE /servers/:name публикует action: remove', async () => {
    const app = createTestApp();
    const res = await app.request('/api/v2/mcp/servers/srv', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(published).toEqual([
      { channel: 'instance', type: 'mcp.updated', data: { action: 'remove', name: 'srv' } },
    ]);
  });

  it('DELETE /servers/:name неизвестного сервера (404) событие не публикует', async () => {
    const app = createTestApp();
    const res = await app.request('/api/v2/mcp/servers/nosuch', { method: 'DELETE' });
    expect(res.status).toBe(404);
    expect(published).toEqual([]);
  });

  // --- единый реестр `/registry*` -----------------------------------------

  it('POST /registry публикует action: add', async () => {
    const app = createTestApp();
    const res = await app.request('/api/v2/mcp/registry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'srv3', config: { type: 'http', url: 'https://93.184.216.34/mcp' } }),
    });
    expect(res.status).toBe(201);
    expect(published).toEqual([
      { channel: 'instance', type: 'mcp.updated', data: { action: 'add', name: 'srv3' } },
    ]);
  });

  it('POST /registry с занятым именем (409) событие не публикует', async () => {
    const app = createTestApp();
    const res = await app.request('/api/v2/mcp/registry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'srv', config: { type: 'http', url: 'https://93.184.216.34/mcp' } }),
    });
    expect(res.status).toBe(409);
    expect(published).toEqual([]);
  });

  it('PUT /registry/:id публикует action: update', async () => {
    const app = createTestApp();
    const res = await app.request('/api/v2/mcp/registry/mcp_srv', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(200);
    expect(published).toEqual([
      { channel: 'instance', type: 'mcp.updated', data: { action: 'update', name: 'srv' } },
    ]);
  });

  it('PUT /registry/:id неизвестной записи (404) событие не публикует', async () => {
    const app = createTestApp();
    const res = await app.request('/api/v2/mcp/registry/mcp_nosuch', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(404);
    expect(published).toEqual([]);
  });

  it('DELETE /registry/:id публикует action: remove', async () => {
    const app = createTestApp();
    const res = await app.request('/api/v2/mcp/registry/mcp_srv', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(published).toEqual([
      { channel: 'instance', type: 'mcp.updated', data: { action: 'remove', name: 'srv' } },
    ]);
  });

  it('DELETE /registry/:id неизвестной записи (404) событие не публикует', async () => {
    const app = createTestApp();
    const res = await app.request('/api/v2/mcp/registry/mcp_nosuch', { method: 'DELETE' });
    expect(res.status).toBe(404);
    expect(published).toEqual([]);
  });

  // --- уровень сессии ------------------------------------------------------

  it('PUT /session/:sessionId публикует session.updated в канал сессии и mcp.updated', async () => {
    const app = createTestApp();
    const res = await app.request('/api/v2/mcp/session/s1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mcpServers: ['srv'] }),
    });
    expect(res.status).toBe(200);
    // Событие сессии — тот же путь публикации, что у тула `synth_mcp_enable`:
    // `session.updated` в канал этой сессии (иначе вкладка показывала бы старый скоуп).
    expect(published).toEqual([
      {
        channel: 's1',
        type: 'session.updated',
        data: expect.objectContaining({ session_id: 's1', settings: expect.objectContaining({ mcpServers: ['srv'] }) }),
      },
      {
        channel: 'instance',
        type: 'mcp.updated',
        data: { action: 'update', scope: 'session', sessionId: 's1' },
      },
    ]);
  });

  it('PUT /session/:sessionId с неизвестным сервером (400) событие не публикует', async () => {
    const app = createTestApp();
    const res = await app.request('/api/v2/mcp/session/s1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mcpServers: ['nosuch'] }),
    });
    expect(res.status).toBe(400);
    expect(published).toEqual([]);
  });

  // --- секреты в событие не попадают --------------------------------------

  it('в payload нет конфига/env/headers (секреты MCP не уходят в шину)', async () => {
    const app = createTestApp();
    await app.request('/api/v2/mcp/registry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'srv4',
        config: {
          type: 'http',
          url: 'https://93.184.216.34/mcp',
          headers: { 'x-trace': '1' },
          description: 'секретный сервер',
        },
      }),
    });
    await app.request('/api/v2/mcp/registry/mcp_srv4', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    await app.request('/api/v2/mcp/registry/mcp_srv4', { method: 'DELETE' });

    expect(published).toHaveLength(3);
    for (const event of published) {
      // Разрешённые ключи payload — только метаданные мутации.
      expect(Object.keys(event.data).sort()).toEqual(['action', 'name']);
      const serialized = JSON.stringify(event);
      expect(serialized).not.toContain('x-trace');
      expect(serialized).not.toContain('секретный сервер');
      expect(event.data).not.toHaveProperty('config');
      expect(event.data).not.toHaveProperty('headers');
      expect(event.data).not.toHaveProperty('env');
    }
  });

  it('без хуков фабрика работает как раньше (мутации проходят, событий нет)', async () => {
    const app = new Hono();
    app.route('/api/v2/mcp', createMcpRegistryRoutes(
      { requireAuth },
      null,
      makeSessionManager(makeSessionMeta()),
      { registry, requireAdmin: requireAuth, requireAdminOrScope: requireAuth, requireScopeForServiceKey: requireAuth },
    ));
    const res = await app.request('/api/v2/mcp/registry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'srv5', config: { type: 'http', url: 'https://93.184.216.34/mcp' } }),
    });
    expect(res.status).toBe(201);
    expect(published).toEqual([]);
  });
});

describe('PUT /projects/:id/mcp — project.updated и mcp.updated', () => {
  it('публикует project.updated (сессии проекта) и mcp.updated со scope: project', async () => {
    const published: PublishedEvent[] = [];
    const bus = makeBus(published);
    const project = {
      id: 'p1',
      name: 'Проект',
      ownerId: 'u1',
      mcp: { enabled: [], defaultOn: [] },
      updatedAt: '2026-01-01T00:00:00.000Z',
    } as unknown as Project;
    const store = {
      load: async (id: string) => (id === project.id ? project : null),
      save: async () => {},
    } as unknown as ProjectRepository;

    const app = new Hono();
    app.route('/api/v2/projects', createProjectRoutes(
      { requireAuth },
      store,
      undefined,
      {
        // Источник известных серверов — иначе маршрут `PUT /:id/mcp` не регистрируется.
        getMcpServers: () => ['srv'],
        // Тот же путь, что у `PUT /:id`: `project.updated` в канал каждой сессии проекта.
        onProjectChanged: async (projectId, kind) => {
          published.push({ channel: 's1', type: kind === 'deleted' ? 'project.deleted' : 'project.updated', data: { project_id: projectId, kind } });
        },
        onMcpChanged: (info: McpChangedInfo) => publishMcpUpdated(bus, info),
      },
    ));

    const res = await app.request('/api/v2/projects/p1/mcp', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: ['srv'], defaultOn: ['srv'] }),
    });
    expect(res.status).toBe(200);
    expect(published).toEqual([
      { channel: 's1', type: 'project.updated', data: { project_id: 'p1', kind: 'updated' } },
      {
        channel: 'instance',
        type: 'mcp.updated',
        data: { action: 'update', scope: 'project', projectId: 'p1' },
      },
    ]);
    // Состояние проекта действительно записано (мутация была).
    expect(project.mcp).toEqual({ enabled: ['srv'], defaultOn: ['srv'] });
    expect(project.updatedAt).not.toBe('2026-01-01T00:00:00.000Z');
  });

  it('неизвестный сервер (400) — мутации нет, событий нет', async () => {
    const published: PublishedEvent[] = [];
    const bus = makeBus(published);
    const project = {
      id: 'p1',
      name: 'Проект',
      ownerId: 'u1',
      mcp: { enabled: [], defaultOn: [] },
      updatedAt: nowISO(),
    } as unknown as Project;
    const store = {
      load: async () => project,
      save: async () => {},
    } as unknown as ProjectRepository;

    const app = new Hono();
    app.route('/api/v2/projects', createProjectRoutes(
      { requireAuth },
      store,
      undefined,
      {
        getMcpServers: () => ['srv'],
        onProjectChanged: async (projectId, kind) => {
          published.push({ channel: 's1', type: 'project.updated', data: { project_id: projectId, kind } });
        },
        onMcpChanged: (info: McpChangedInfo) => publishMcpUpdated(bus, info),
      },
    ));

    const res = await app.request('/api/v2/projects/p1/mcp', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: ['nosuch'] }),
    });
    expect(res.status).toBe(400);
    expect(published).toEqual([]);
    expect(project.mcp).toEqual({ enabled: [], defaultOn: [] });
  });
});


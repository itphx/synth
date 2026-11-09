/**
 * ADR-071 §2.5: единый реестр MCP-серверов — **в standalone реестр является
 * источником истины** (паритет с managed).
 *
 * Регресс: при «наивном» переносе backend-роутера в core (без сида реестра из
 * `config.mcpServers` и без заполнения менеджера картами реестра) любой
 * POST/PUT/DELETE реестра вызывал бы `syncMcpManagerFromRegistry` →
 * `manager.setConfig({})` — и **молча стирал** серверы, заданные в
 * `config.mcpServers`. Тогда ломались:
 *
 * - `GET /api/v2/mcp/registry` — пустой (в реестр ничего не сидировалось);
 * - `GET /api/v2/projects/:id/mcp` — `knownServers` пустой (читается
 *   `Object.keys(mcpManager.getConfig() ?? {})`).
 *
 * Тест фиксирует правильное поведение: серверы из конфига сидируются в реестр
 * при старте, переживают мутации реестра, остаются в менеджере и не
 * дублируются при повторном старте на том же `dataDir`.
 */
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createStandaloneApp } from '../app.js';
import { closeTestServer } from '../../test-helpers/close-server.js';

const AUTH = { Authorization: 'Bearer test-key' };
const JSON_HEADERS = { ...AUTH, 'Content-Type': 'application/json' };

/** Публичный IP — сетевая политика по умолчанию (deny приватных диапазонов) его разрешает. */
const PUBLIC_URL = 'http://93.184.216.34/mcp';

type StandaloneHandle = Awaited<ReturnType<typeof createStandaloneApp>>;

/** Standalone с двумя серверами из «конфига» (`config.mcpServers`). */
function startStandalone(dataDir: string): Promise<StandaloneHandle> {
  return createStandaloneApp({
    port: 0,
    dataDir,
    apiKey: 'test-key',
    mcpServers: {
      'cfg-http': { type: 'sse', url: PUBLIC_URL },
      'cfg-stdio': { type: 'stdio', command: 'true' },
    },
  });
}

describe('createStandaloneApp: реестр MCP — источник истины (ADR-071 §2.5)', () => {
  it('серверы из config.mcpServers сидируются в реестр и переживают мутации реестра', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'synth-app-mcp-registry-'));
    try {
      const handle = await createStandaloneApp({
        port: 0,
        dataDir: dir,
        apiKey: 'test-key',
        // Два сервера из «конфига» — как `config.mcp.servers` в config.yaml.
        mcpServers: {
          'cfg-http': { type: 'sse', url: PUBLIC_URL, enabledByDefault: true },
          'cfg-stdio': { type: 'stdio', command: 'true' },
        },
      });
      try {
        // 1. Реестр сидирован из конфига — список непустой.
        const list0 = await handle.app.request('/api/v2/mcp/registry', { headers: AUTH });
        expect(list0.status).toBe(200);
        const body0 = await list0.json() as { entries: Array<{ id: string; name: string; origin: string; trust: string }> };
        expect(body0.entries.map((e) => e.name).sort()).toEqual(['cfg-http', 'cfg-stdio']);
        expect(body0.entries.find((e) => e.name === 'cfg-http')?.origin).toBe('instance');
        // Сид из конфига — инстансные записи с доверием `builtin`.
        expect(body0.entries.every((e) => e.origin === 'instance' && e.trust === 'builtin')).toBe(true);

        // 2. Мутация реестра (добавление записи) — 201.
        const created = await handle.app.request('/api/v2/mcp/registry', {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({ name: 'added-http', config: { type: 'sse', url: PUBLIC_URL } }),
        });
        expect(created.status).toBe(201);

        // 3. После мутации в реестре три записи, оба сервера из конфига на месте.
        const list1 = await handle.app.request('/api/v2/mcp/registry', { headers: AUTH });
        expect(list1.status).toBe(200);
        const body1 = await list1.json() as { entries: Array<{ id: string; name: string }> };
        expect(body1.entries).toHaveLength(3);
        expect(body1.entries.map((e) => e.name).sort()).toEqual(['added-http', 'cfg-http', 'cfg-stdio']);

        // 4. Главная проверка: серверы из конфига остались в `mcpManager.getConfig()`
        //    (`knownServers` проекта читается именно оттуда).
        const projectRes = await handle.app.request('/api/v2/projects', {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({ name: 'proj-mcp-registry' }),
        });
        expect(projectRes.status).toBe(201);
        const project = (await projectRes.json()) as { id: string };

        const mcpScope = await handle.app.request(`/api/v2/projects/${project.id}/mcp`, { headers: AUTH });
        expect(mcpScope.status).toBe(200);
        const scope = (await mcpScope.json()) as { knownServers: string[] };
        expect(scope.knownServers).toContain('cfg-http');
        expect(scope.knownServers).toContain('cfg-stdio');
        expect(scope.knownServers).toContain('added-http');

        // 5. Удаление записи реестра — серверы из конфига не исчезают.
        const added = body1.entries.find((e) => e.name === 'added-http')!;
        expect(added.id).toBeTruthy();

        const deleted = await handle.app.request(`/api/v2/mcp/registry/${added.id}`, {
          method: 'DELETE',
          headers: AUTH,
        });
        expect(deleted.status).toBe(200);

        // В реестре остались ровно два сервера из конфига.
        const listAfter = await handle.app.request('/api/v2/mcp/registry', { headers: AUTH });
        expect(listAfter.status).toBe(200);
        const bodyAfter = (await listAfter.json()) as { entries: Array<{ name: string }> };
        expect(bodyAfter.entries.map((e) => e.name).sort()).toEqual(['cfg-http', 'cfg-stdio']);

        const scopeAfter = await handle.app.request(`/api/v2/projects/${project.id}/mcp`, { headers: AUTH });
        const scopeAfterBody = (await scopeAfter.json()) as { knownServers: string[] };
        expect(scopeAfterBody.knownServers).toContain('cfg-http');
        expect(scopeAfterBody.knownServers).toContain('cfg-stdio');
        expect(scopeAfterBody.knownServers).not.toContain('added-http');
      } finally {
        await closeTestServer(handle.server);
      }
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('правка записи реестра не стирает остальные серверы из config.mcpServers', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'synth-app-mcp-registry-put-'));
    try {
      const handle = await createStandaloneApp({
        port: 0,
        dataDir: dir,
        apiKey: 'test-key',
        mcpServers: {
          'cfg-http': { type: 'sse', url: PUBLIC_URL },
          'cfg-stdio': { type: 'stdio', command: 'true' },
        },
      });
      try {
        const list = await handle.app.request('/api/v2/mcp/registry', { headers: AUTH });
        const entries = ((await list.json()) as { entries: Array<{ id: string; name: string }> }).entries;
        const target = entries.find((e) => e.name === 'cfg-stdio')!;

        const put = await handle.app.request(`/api/v2/mcp/registry/${target.id}`, {
          method: 'PUT',
          headers: JSON_HEADERS,
          body: JSON.stringify({ enabledByDefault: true }),
        });
        expect(put.status).toBe(200);

        const after = await handle.app.request('/api/v2/mcp/registry', { headers: AUTH });
        const afterEntries = ((await after.json()) as { entries: Array<{ name: string }> }).entries;
        expect(afterEntries.map((e) => e.name).sort()).toEqual(['cfg-http', 'cfg-stdio']);

        // Менеджер по-прежнему знает оба сервера из конфига.
        const servers = await handle.app.request('/api/v2/mcp/servers', { headers: AUTH });
        expect(servers.status).toBe(200);
        const serversBody = (await servers.json()) as Record<string, unknown>;
        expect(Object.keys(serversBody).sort()).toEqual(['cfg-http', 'cfg-stdio']);
      } finally {
        await closeTestServer(handle.server);
      }
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('повторный старт на том же dataDir не дублирует записи реестра', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'synth-app-mcp-registry-seed-'));
    try {
      // Первый старт: сид из конфига — две записи.
      const first = await startStandalone(dir);
      try {
        const list0 = await first.app.request('/api/v2/mcp/registry', { headers: AUTH });
        expect(list0.status).toBe(200);
        const body0 = (await list0.json()) as { entries: Array<{ id: string; name: string }> };
        expect(body0.entries.map((e) => e.name).sort()).toEqual(['cfg-http', 'cfg-stdio']);

        // Мутация реестра до перезапуска — её следы не должны удваивать записи.
        const created = await first.app.request('/api/v2/mcp/registry', {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({ name: 'added-http', config: { type: 'sse', url: PUBLIC_URL } }),
        });
        expect(created.status).toBe(201);
        const list1 = await first.app.request('/api/v2/mcp/registry', { headers: AUTH });
        const added = ((await list1.json()) as { entries: Array<{ id: string; name: string }> }).entries
          .find((e) => e.name === 'added-http');
        expect(added).toBeTruthy();

        const deleted = await first.app.request(`/api/v2/mcp/registry/${added!.id}`, {
          method: 'DELETE',
          headers: AUTH,
        });
        expect(deleted.status).toBe(200);
      } finally {
        await closeTestServer(first.server);
      }

      // Второй старт на том же `dataDir` — сид идемпотентен (по имени записи).
      const second = await startStandalone(dir);
      try {
        const list = await second.app.request('/api/v2/mcp/registry', { headers: AUTH });
        expect(list.status).toBe(200);
        const body = (await list.json()) as { entries: Array<{ name: string }> };
        expect(body.entries).toHaveLength(2);
        expect(body.entries.map((e) => e.name).sort()).toEqual(['cfg-http', 'cfg-stdio']);
      } finally {
        await closeTestServer(second.server);
      }
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
});

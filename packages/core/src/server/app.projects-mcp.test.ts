import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createStandaloneApp } from './app.js';
import { closeTestServer } from '../test-helpers/close-server.js';

const AUTH = { Authorization: 'Bearer test-key' };

/**
 * ADR-071 §2.4: проектный MCP-скоуп в standalone — паритет с managed backend.
 *
 * Регресс: фабрика `createProjectRoutes` регистрирует `GET/PUT /:id/mcp` только
 * при переданном `getMcpServers`. Managed его передаёт, а локальный core — нет,
 * из-за чего правая панель («Проект» → «MCP-серверы») получала 404 и показывала
 * «Не удалось загрузить MCP-серверы проекта» (в т.ч. для `remote:`-проектов —
 * маршрут отсутствовал до гибридной ветки проксирования).
 */
describe('createStandaloneApp: MCP-скоуп проекта', () => {
  it('GET/PUT /api/v2/projects/:id/mcp зарегистрированы для локального проекта', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'synth-app-projects-mcp-'));
    try {
      const handle = await createStandaloneApp({
        port: 0,
        dataDir: dir,
        apiKey: 'test-key',
        mcpServers: {
          'srv-a': { type: 'stdio', command: 'true', enabledByDefault: true },
        },
      });
      try {
        const created = await handle.app.request('/api/v2/projects', {
          method: 'POST',
          headers: { ...AUTH, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'proj' }),
        });
        expect(created.status).toBe(201);
        const project = (await created.json()) as { id: string };

        // knownServers — из реестра MCP инстанса; enabled/defaultOn — сид
        // `enabledByDefault` при создании проекта.
        const get = await handle.app.request(`/api/v2/projects/${project.id}/mcp`, { headers: AUTH });
        expect(get.status).toBe(200);
        const body = (await get.json()) as {
          enabled: string[];
          defaultOn: string[];
          knownServers: string[];
        };
        expect(body.knownServers).toContain('srv-a');
        expect(body.enabled).toContain('srv-a');
        expect(body.defaultOn).toContain('srv-a');

        // PUT реально обновляет скоуп (маршрут работает, а не только GET).
        const put = await handle.app.request(`/api/v2/projects/${project.id}/mcp`, {
          method: 'PUT',
          headers: { ...AUTH, 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: [], defaultOn: [] }),
        });
        expect(put.status).toBe(200);
        const putBody = (await put.json()) as { enabled: string[]; defaultOn: string[] };
        expect(putBody.enabled).toEqual([]);
        expect(putBody.defaultOn).toEqual([]);

        // Гибридная ветка достижима: для `remote:`-проекта без подключения —
        // 502 REMOTE_UNAVAILABLE, а не 404 (маршрут существует и проксирует).
        const remoteGet = await handle.app.request(
          '/api/v2/projects/remote:00000000-0000-0000-0000-000000000000/mcp',
          { headers: AUTH },
        );
        expect(remoteGet.status).toBe(502);
      } finally {
        await closeTestServer(handle.server);
      }
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
});

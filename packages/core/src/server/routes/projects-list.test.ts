import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { createProjectRoutes } from './projects.js';
import type { ProjectRoutesOptions } from './projects.js';
import { ProjectStore } from '../../storage/project-store.js';
import type { RemoteBackendClient } from '../../remote/client.js';

/**
 * Контракт списка проектов (решение владельца): **страница** + сводка-DTO.
 *
 * - список — объект `{projects, total, offset, limit, next_offset}`;
 * - DTO проекта в списке — сводка: тяжёлые поля `log` и `plan` не отдаются
 *   (деталь `GET /projects/:id` отдаёт полный DTO).
 */

/** Мок auth: requireAuth — no-op (single-user режим core). */
function createMockAuth() {
  return {
    getCurrentUser: () => null,
    requireAuth: async (_c: Context, next: Next) => { await next(); },
  };
}

describe('GET /api/v2/projects — страница и сводка-DTO', () => {
  let tmpDir: string;
  let store: ProjectStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-projects-list-'));
    store = new ProjectStore({ dataDir: tmpDir });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeApp(opts: ProjectRoutesOptions = {}, remote?: RemoteBackendClient): Hono {
    const app = new Hono();
    app.route(
      '/api/v2/projects',
      createProjectRoutes(createMockAuth(), store, remote ? () => remote : undefined, opts),
    );
    return app;
  }

  /** Проект с журналом и планом — тяжёлые поля детали. */
  async function seedHeavyProject(name: string): Promise<string> {
    const project = store.create(name, 'local');
    project.log = [{ id: 'log-1', text: 'запись журнала', createdAt: '2026-01-01T00:00:00.000Z' }];
    project.plan = {
      version: 1,
      updatedAt: '2026-01-01T00:00:00.000Z',
      columns: [{ id: 'c1', name: 'Колонка', order: 0 }],
      items: [],
    };
    await store.save(project);
    return project.id;
  }

  it('список — объект-страница; DTO без log/plan, деталь — с ними', async () => {
    const app = makeApp();
    const id = await seedHeavyProject('Тяжёлый');

    const list = await app.request('/api/v2/projects');
    expect(list.status).toBe(200);
    const body = (await list.json()) as {
      projects: Array<Record<string, unknown>>;
      total: number;
      offset: number;
      limit: number;
      next_offset: number | null;
    };
    expect(Array.isArray(body.projects)).toBe(true);
    expect(body.total).toBe(1);
    expect(body.offset).toBe(0);
    expect(body.limit).toBe(100);
    expect(body.next_offset).toBeNull();

    const item = body.projects[0]!;
    expect(item.id).toBe(id);
    // Тяжёлые поля в списке не отдаются.
    expect('log' in item).toBe(false);
    expect('plan' in item).toBe(false);
    // Остальное, что нужно списку, — на месте.
    expect(item.name).toBe('Тяжёлый');
    expect(item.owner_id).toBe('local');
    expect(item.origin).toBe('local');
    expect(item.created_at).toBeTruthy();
    expect(item.updated_at).toBeTruthy();

    // Деталь — полный DTO.
    const detail = await app.request(`/api/v2/projects/${id}`);
    const detailBody = (await detail.json()) as Record<string, unknown>;
    expect(Array.isArray(detailBody.log)).toBe(true);
    expect(detailBody.plan).toBeTruthy();
  });

  it('пагинация: limit/offset, total и next_offset', async () => {
    const app = makeApp();
    for (let i = 0; i < 5; i += 1) {
      const project = store.create(`P${i}`, 'local');
      await store.save(project);
    }

    const first = (await (await app.request('/api/v2/projects?limit=2')).json()) as {
      projects: Array<{ name: string }>;
      total: number;
      offset: number;
      limit: number;
      next_offset: number | null;
    };
    expect(first.projects).toHaveLength(2);
    expect(first.total).toBe(5);
    expect(first.offset).toBe(0);
    expect(first.limit).toBe(2);
    expect(first.next_offset).toBe(2);

    const second = (await (await app.request('/api/v2/projects?limit=2&offset=2')).json()) as {
      projects: Array<{ name: string }>;
      offset: number;
      next_offset: number | null;
    };
    expect(second.projects).toHaveLength(2);
    expect(second.offset).toBe(2);
    expect(second.next_offset).toBe(4);

    const last = (await (await app.request('/api/v2/projects?limit=2&offset=4')).json()) as {
      projects: unknown[];
      next_offset: number | null;
    };
    expect(last.projects).toHaveLength(1);
    expect(last.next_offset).toBeNull();

    // Смещение за концом — пустая страница без курсора.
    const beyond = (await (await app.request('/api/v2/projects?offset=99')).json()) as {
      projects: unknown[];
      total: number;
      next_offset: number | null;
    };
    expect(beyond.projects).toEqual([]);
    expect(beyond.total).toBe(5);
    expect(beyond.next_offset).toBeNull();
  });

  it('невалидный limit/offset → 400 VALIDATION_ERROR', async () => {
    const app = makeApp();
    const badLimit = await app.request('/api/v2/projects?limit=abc');
    expect(badLimit.status).toBe(400);
    expect(((await badLimit.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');

    const negativeOffset = await app.request('/api/v2/projects?offset=-1');
    expect(negativeOffset.status).toBe(400);

    const fractional = await app.request('/api/v2/projects?limit=1.5');
    expect(fractional.status).toBe(400);
  });

  it('гибрид: удалённые проекты в merged, сквозная пагинация работает', async () => {
    const local = store.create('Локальный', 'local');
    await store.save(local);
    const remote = {
      listAllProjects: async () => ({
        items: [{ id: 'rp-1', name: 'Удалённый' }],
        total: 1,
        truncated: false,
      }),
    } as unknown as RemoteBackendClient;

    const app = makeApp({}, remote);
    const res = await app.request('/api/v2/projects');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      projects: Array<{ id: string; origin: string; name: string }>;
      total: number;
      next_offset: number | null;
    };
    expect(body.projects).toHaveLength(2);
    expect(body.projects.find((p) => p.origin === 'local')!.name).toBe('Локальный');
    expect(body.projects.find((p) => p.origin === 'remote')!.id).toBe('remote:rp-1');
    // Обе записи помещаются в страницу — курсор не выдаётся.
    expect(body.next_offset).toBeNull();
    expect(body.total).toBe(2);
  });

  it('гибрид: merged-список длиннее страницы → next_offset указывает следующую', async () => {
    const local = store.create('Локальный', 'local');
    await store.save(local);
    const remote = {
      listAllProjects: async () => ({
        items: [{ id: 'rp-1', name: 'Удалённый' }],
        total: 1,
        truncated: false,
      }),
    } as unknown as RemoteBackendClient;

    const app = makeApp({}, remote);
    const body = (await (await app.request('/api/v2/projects?limit=1')).json()) as {
      projects: Array<{ id: string }>;
      total: number;
      next_offset: number | null;
    };
    expect(body.projects).toHaveLength(1);
    expect(body.total).toBe(2);
    expect(body.next_offset).toBe(1);
  });
});

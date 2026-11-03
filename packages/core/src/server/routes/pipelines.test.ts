import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPipelinesRoutes } from './pipelines.js';
import { FilePipelineStore } from '../../storage/file-pipeline-store.js';
import type { PipelineDefinitionRecord } from '../../storage/ports/pipeline-repository.js';

/** Мок auth: requireAuth — no-op (single-user режим core). */
function createMockAuth() {
  return {
    getCurrentUser: () => null,
    requireAuth: async (_c: Context, next: Next) => { await next(); },
  };
}

/** Определение пайплайна для тестов. */
function definition(id: string, overrides: Partial<PipelineDefinitionRecord> = {}): PipelineDefinitionRecord {
  return {
    id,
    name: id,
    version: '1.0.0',
    steps: [
      { id: 'step-1', kind: 'agent', agent: 'publisher', prompt: 'сделай' },
      { id: 'step-2', kind: 'agent', agent: 'publisher', prompt: 'опубликуй' },
    ],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('Pipelines API Routes (ADR-051/ADR-100)', () => {
  let tmpDir: string;
  let store: FilePipelineStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-pipelines-test-'));
    store = new FilePipelineStore({ dataDir: tmpDir });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function createTestApp() {
    const app = new Hono();
    app.route('/api/v2/pipelines', createPipelinesRoutes(createMockAuth(), { pipelines: store }));
    return app;
  }

  it('GET / — список определений', async () => {
    const app = createTestApp();
    await store.saveDefinition(definition('publication'));

    const res = await app.request('/api/v2/pipelines');
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.pipelines).toHaveLength(1);
    expect(body.pipelines[0].id).toBe('publication');
    expect(body.pipelines[0].installedBy).toBeUndefined();
  });

  it('GET /:id — определение; 404 для неизвестного', async () => {
    const app = createTestApp();
    await store.saveDefinition(definition('publication', {
      installedBy: { pack: 'synth-media', version: '1.0.0' },
    }));

    const ok = await app.request('/api/v2/pipelines/publication');
    expect(ok.status).toBe(200);
    const body: any = await ok.json();
    expect(body.id).toBe('publication');
    expect(body.installedBy).toEqual({ pack: 'synth-media', version: '1.0.0' });

    const missing = await app.request('/api/v2/pipelines/nope');
    expect(missing.status).toBe(404);
    const err: any = await missing.json();
    expect(err.error.code).toBe('NOT_FOUND');
  });

  it('GET /instances — список с фильтрами pipelineId/status/limit', async () => {
    const app = createTestApp();
    await store.saveInstance({
      id: 'run-1',
      pipelineId: 'publication',
      status: 'pending',
      steps: [{ id: 'step-1', status: 'pending' }],
      attempts: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    await store.saveInstance({
      id: 'run-2',
      pipelineId: 'publication',
      status: 'done',
      steps: [{ id: 'step-1', status: 'done' }],
      attempts: 0,
      createdAt: '2026-02-01T00:00:00.000Z',
      updatedAt: '2026-02-01T00:00:00.000Z',
    });
    await store.saveInstance({
      id: 'run-3',
      pipelineId: 'other',
      status: 'done',
      steps: [{ id: 'step-1', status: 'done' }],
      attempts: 0,
      createdAt: '2026-03-01T00:00:00.000Z',
      updatedAt: '2026-03-01T00:00:00.000Z',
    });

    const all = await app.request('/api/v2/pipelines/instances');
    expect(all.status).toBe(200);
    const allBody: any = await all.json();
    expect(allBody.instances).toHaveLength(3);

    const byPipeline = await app.request('/api/v2/pipelines/instances?pipelineId=publication');
    const byPipelineBody: any = await byPipeline.json();
    expect(byPipelineBody.instances.map((i: any) => i.id).sort()).toEqual(['run-1', 'run-2']);

    const byStatus = await app.request('/api/v2/pipelines/instances?status=done');
    const byStatusBody: any = await byStatus.json();
    expect(byStatusBody.instances.map((i: any) => i.id).sort()).toEqual(['run-2', 'run-3']);

    const byBoth = await app.request('/api/v2/pipelines/instances?pipelineId=publication&status=done');
    const byBothBody: any = await byBoth.json();
    expect(byBothBody.instances.map((i: any) => i.id)).toEqual(['run-2']);

    const limited = await app.request('/api/v2/pipelines/instances?limit=1');
    const limitedBody: any = await limited.json();
    expect(limitedBody.instances).toHaveLength(1);
    expect(limitedBody.offset).toBe(0);
    expect(limitedBody.limit).toBe(1);
    expect(limitedBody.next_offset).toBe(1);

    // Неизвестный статус → 400 (fail-closed, а не молчаливый фильтр).
    const bad = await app.request('/api/v2/pipelines/instances?status=nope');
    expect(bad.status).toBe(400);
  });

  it('GET /instances — offset/next_offset (постраничная выдача)', async () => {
    const app = createTestApp();
    // Свежие первыми: run-3 (03.01) → run-2 (02.01) → run-1 (01.01).
    for (const [id, createdAt] of [
      ['run-1', '2026-01-01T00:00:00.000Z'],
      ['run-2', '2026-02-01T00:00:00.000Z'],
      ['run-3', '2026-03-01T00:00:00.000Z'],
    ] as const) {
      await store.saveInstance({
        id,
        pipelineId: 'publication',
        status: 'pending',
        steps: [{ id: 'step-1', status: 'pending' }],
        attempts: 0,
        createdAt,
        updatedAt: createdAt,
      });
    }

    const first = await app.request('/api/v2/pipelines/instances?limit=2');
    const firstBody: any = await first.json();
    expect(firstBody.instances.map((i: any) => i.id)).toEqual(['run-3', 'run-2']);
    expect(firstBody.offset).toBe(0);
    expect(firstBody.limit).toBe(2);
    expect(firstBody.next_offset).toBe(2);

    const second = await app.request('/api/v2/pipelines/instances?limit=2&offset=2');
    const secondBody: any = await second.json();
    expect(secondBody.instances.map((i: any) => i.id)).toEqual(['run-1']);
    expect(secondBody.offset).toBe(2);
    expect(secondBody.next_offset).toBeNull();
  });

  it('GET /instances/:instanceId — экземпляр; 404 для неизвестного', async () => {
    const app = createTestApp();
    await store.saveInstance({
      id: 'run-1',
      pipelineId: 'publication',
      status: 'pending',
      steps: [{ id: 'step-1', status: 'pending' }],
      attempts: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    const ok = await app.request('/api/v2/pipelines/instances/run-1');
    expect(ok.status).toBe(200);
    const body: any = await ok.json();
    expect(body.id).toBe('run-1');

    const missing = await app.request('/api/v2/pipelines/instances/nope');
    expect(missing.status).toBe(404);
  });

  it('POST /:id/instances — ручной запуск экземпляра', async () => {
    const app = createTestApp();
    await store.saveDefinition(definition('publication'));

    const res = await app.request('/api/v2/pipelines/publication/instances', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        trigger: { source: 'ci', type: 'release.created', dedupKey: 'rel-1' },
        payload: { version: '1.2.3' },
      }),
    });

    expect(res.status).toBe(201);
    const body: any = await res.json();
    expect(body.pipelineId).toBe('publication');
    expect(body.pipelineVersion).toBe('1.0.0');
    expect(body.status).toBe('running');
    expect(body.currentStep).toBe('step-1');
    expect(body.steps).toHaveLength(2);
    expect(body.steps[0]).toEqual({ id: 'step-1', status: 'pending' });
    expect(body.steps[1]).toEqual({ id: 'step-2', status: 'pending' });
    expect(body.attempts).toBe(0);
    expect(body.trigger).toEqual({ source: 'ci', type: 'release.created', dedupKey: 'rel-1' });
    expect(body.payload).toEqual({ version: '1.2.3' });

    // Экземпляр сохранён в порте.
    const saved = await store.getInstance(body.id);
    expect(saved?.status).toBe('running');
  });

  it('POST /:id/instances — 404 для неизвестного пайплайна', async () => {
    const app = createTestApp();
    const res = await app.request('/api/v2/pipelines/nope/instances', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
    expect(await store.listInstances()).toHaveLength(0);
  });
});

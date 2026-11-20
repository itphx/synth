/**
 * Тесты публикации события `pipeline.updated` — **сущность пайплайна проекта
 * изменилась** (ADR-101 авторство × ADR-118, инвариант 27).
 *
 * Событие идёт в **каналы всех сессий проекта** (пайплайн — ресурс проекта,
 * ADR-014), а не в инстансный канал: в managed инстансный канал не доходит до
 * обычного `USER`. Payload — `{ pipelineId, projectId, action }`: спецификация
 * (черновик/vars/граф) в событие не попадает.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session } from '@itphx/synth-shared';
import { publishPipelineUpdated, PIPELINE_EVENT_MAX_SESSIONS } from './events.js';
import type { PipelineEventDeps, PipelineEventSessionSource } from './events.js';
import { SessionManager } from '../../sessions/manager.js';
import { FileStore } from '../../storage/file-store.js';

/** Мок шины: видно, что и в какой канал опубликовано. */
function makeBus() {
  const published: Array<{ sessionId: string; type: string; data: Record<string, unknown> }> = [];
  const eventBus = {
    publish(sessionId: string, type: string, data: Record<string, unknown> = {}) {
      published.push({ sessionId, type, data });
    },
  } as unknown as PipelineEventDeps['eventBus'];
  return { eventBus, published };
}

/** Фейковая сессия (нужны только id). */
function fakeSession(id: string): Session {
  return { id } as unknown as Session;
}

/** Источник сессий: отдаёт заранее заданный список. */
function makeSource(sessions: Session[]): PipelineEventSessionSource {
  return {
    listSessions: vi.fn().mockResolvedValue(sessions),
  };
}

describe('publishPipelineUpdated (ADR-101 авторство × ADR-118)', () => {
  it('публикует pipeline.updated {pipelineId, projectId, action} в каналы сессий проекта', async () => {
    const { eventBus, published } = makeBus();
    const deps: PipelineEventDeps = {
      eventBus,
      sessionStore: makeSource([fakeSession('s1'), fakeSession('s2')]),
    };

    await publishPipelineUpdated(deps, {
      projectId: 'prj-1',
      pipelineId: 'pl_1',
      action: 'save',
    });

    // Две сессии проекта — две доставки, ровно по одному событию на канал.
    expect(published).toHaveLength(2);
    expect(published.every((p) => p.type === 'pipeline.updated')).toBe(true);
    expect(published.map((p) => p.sessionId)).toEqual(['s1', 's2']);
    expect(published[0]?.data).toEqual({
      pipelineId: 'pl_1',
      projectId: 'prj-1',
      action: 'save',
    });
  });

  it('payload не несёт спецификации: только id и вид мутации', async () => {
    const { eventBus, published } = makeBus();
    await publishPipelineUpdated(
      { eventBus, sessionStore: makeSource([fakeSession('s1')]) },
      { projectId: 'prj-1', pipelineId: 'pl_1', action: 'publish' },
    );

    expect(Object.keys(published[0]?.data ?? {}).sort()).toEqual([
      'action',
      'pipelineId',
      'projectId',
    ]);
  });

  it('источник сессий запрашивается по id проекта', async () => {
    const { eventBus } = makeBus();
    const sessionStore = makeSource([]);
    await publishPipelineUpdated(
      { eventBus, sessionStore },
      { projectId: 'prj-42', pipelineId: 'pl_1', action: 'delete' },
    );
    expect(sessionStore.listSessions).toHaveBeenCalledWith({ projectId: 'prj-42' });
  });

  it('проект без сессий — ни одного вызова, без ошибок', async () => {
    const { eventBus, published } = makeBus();

    await expect(
      publishPipelineUpdated(
        { eventBus, sessionStore: makeSource([]) },
        { projectId: 'prj-1', pipelineId: 'pl_1', action: 'delete' },
      ),
    ).resolves.toBeUndefined();
    expect(published).toHaveLength(0);
  });

  it('без шины или без источника сессий — no-op (хук необязателен)', async () => {
    const { eventBus, published } = makeBus();

    await expect(
      publishPipelineUpdated(
        { sessionStore: makeSource([fakeSession('s1')]) },
        { projectId: 'prj-1', pipelineId: 'pl_1', action: 'save' },
      ),
    ).resolves.toBeUndefined();
    await expect(
      publishPipelineUpdated(
        { eventBus },
        { projectId: 'prj-1', pipelineId: 'pl_1', action: 'save' },
      ),
    ).resolves.toBeUndefined();
    expect(published).toHaveLength(0);
  });

  it('ошибка чтения сессий не ломает операцию авторства (событие — побочный сигнал)', async () => {
    const { eventBus, published } = makeBus();
    const sessionStore: PipelineEventSessionSource = {
      listSessions: vi.fn().mockRejectedValue(new Error('store unavailable')),
    };

    await expect(
      publishPipelineUpdated(
        { eventBus, sessionStore },
        { projectId: 'prj-1', pipelineId: 'pl_1', action: 'save' },
      ),
    ).resolves.toBeUndefined();
    expect(published).toHaveLength(0);
  });

  it('лимит сессий: не больше PIPELINE_EVENT_MAX_SESSIONS (200)', async () => {
    const { eventBus, published } = makeBus();
    const sessions = Array.from({ length: PIPELINE_EVENT_MAX_SESSIONS + 50 }, (_, i) =>
      fakeSession(`s${i}`),
    );

    await publishPipelineUpdated(
      { eventBus, sessionStore: makeSource(sessions) },
      { projectId: 'prj-1', pipelineId: 'pl_1', action: 'instantiate' },
    );

    expect(new Set(published.map((p) => p.sessionId)).size).toBe(PIPELINE_EVENT_MAX_SESSIONS);
    expect(published).toHaveLength(PIPELINE_EVENT_MAX_SESSIONS);
  });
});

/**
 * Проверка на настоящем `SessionManager`: доставка считается по сессиям
 * **проекта**, а не по всем сессиям инстанса — событие чужого проекта в мой
 * канал не попадает.
 */
describe('publishPipelineUpdated × SessionManager (fan-out по сессиям проекта)', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-pipeline-events-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('две сессии проекта — две доставки; сессия чужого проекта событие не получает', async () => {
    const own1 = await sessionManager.createSession({ title: 'Проект: первая', projectId: 'prj-1' });
    const own2 = await sessionManager.createSession({ title: 'Проект: вторая', projectId: 'prj-1' });
    const foreign = await sessionManager.createSession({ title: 'Другой проект', projectId: 'prj-2' });

    const { eventBus, published } = makeBus();
    await publishPipelineUpdated(
      { eventBus, sessionStore: sessionManager },
      { projectId: 'prj-1', pipelineId: 'pl_1', action: 'publish' },
    );

    expect(published).toHaveLength(2);
    expect(published.map((p) => p.sessionId).sort()).toEqual([own1.id, own2.id].sort());
    expect(published.some((p) => p.sessionId === foreign.id)).toBe(false);
    expect(published[0]?.data).toEqual({
      pipelineId: 'pl_1',
      projectId: 'prj-1',
      action: 'publish',
    });
  });

  it('сессия без проекта событие не получает', async () => {
    await sessionManager.createSession({ title: 'Без проекта' });
    const { eventBus, published } = makeBus();

    await publishPipelineUpdated(
      { eventBus, sessionStore: sessionManager },
      { projectId: 'prj-1', pipelineId: 'pl_1', action: 'save' },
    );

    expect(published).toHaveLength(0);
  });
});

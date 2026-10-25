/**
 * ADR-107: `GET /api/v2/sessions/:id/memory` — агрегаты памяти для вкладки
 * «Память» правой панели: что ушло в контекст последнего хода, факты и индексы
 * в скоупе сессии. Текстов фактов/чанков эндпоинт не отдаёт.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MessageRole, generateId, makeTextPart, nowISO } from '@itphx/synth-shared';
import type { AuthKit } from '../../auth/local.js';
import { EventBus, FileStore, SessionManager } from '../../index.js';
import { MEMORY_NAMESPACE } from '../../engine/plugins/memory-namespace.js';
import type { MemoryFactRepository } from '../../storage/ports/memory-fact-repository.js';
import type { MemoryIndexRepository } from '../../storage/ports/memory-index-repository.js';
import { createSessionRoutes } from './sessions.js';

function createMockAuth(): AuthKit {
  return {
    getCurrentUser: () => null,
    requireAuth: async (_c: Context, next: Next) => {
      await next();
    },
  } as unknown as AuthKit;
}

function createMockQueueManager() {
  return {
    isRunning: vi.fn().mockReturnValue(false),
    stop: vi.fn(),
    createProcessor: vi.fn(),
    stopAll: vi.fn(),
    getRingBuffer: vi.fn(),
    setContextOptimizer: vi.fn(),
    requestStop: vi.fn().mockReturnValue(false),
  };
}

function createMockOrchestrator() {
  const processMessage = vi.fn().mockResolvedValue({});
  return {
    createProcessMessage: () => processMessage,
    cancel: vi.fn(),
    getPromptInfo: vi.fn(),
    getModelPricing: vi.fn().mockReturnValue(null),
  };
}

/** Минимальные записи: эндпоинт читает только эти поля. */
function fact(projectId?: string) {
  return { id: generateId(), namespace: MEMORY_NAMESPACE, projectId };
}

function index(
  scope: 'project' | 'instance',
  state: string,
  projectId?: string,
  enabled?: boolean,
) {
  return {
    id: generateId(),
    name: `${scope}-${state}`,
    namespace: MEMORY_NAMESPACE,
    scope,
    state,
    projectId,
    ...(enabled !== undefined ? { enabled } : {}),
  };
}

interface Stand {
  app: Hono;
  sessionManager: SessionManager;
}

function createApp(
  memory?: {
    facts: MemoryFactRepository;
    indexes: MemoryIndexRepository;
    isPluginActive: () => boolean;
  },
  projectStore?: { load: (id: string) => Promise<{ memory?: { enabled?: boolean } } | null> },
): Stand {
  const app = new Hono();
  const sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
  const orchestrator = createMockOrchestrator();
  app.route(
    '/api/v2/sessions',
    createSessionRoutes(
      createMockAuth(),
      {
        sessionManager,
        eventBus: new EventBus(),
        queueManager: createMockQueueManager() as never,
        processMessage: orchestrator.createProcessMessage() as never,
        orchestrator: orchestrator as never,
        ...(memory ? { memory } : {}),
        ...(projectStore ? { projectStore: projectStore as never } : {}),
      },
      {},
    ),
  );
  return { app, sessionManager };
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'synth-session-memory-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('GET /api/v2/sessions/:id/memory', () => {
  it('возвращает блоки последнего хода и агрегаты скоупа', async () => {
    const facts = {
      list: vi.fn(async () => [fact('p1'), fact(undefined), fact('p2')]),
      count: vi.fn(),
    } as unknown as MemoryFactRepository;
    const indexes = {
      listIndexes: vi.fn(async () => [
        index('project', 'ready', 'p1'),
        index('project', 'failed', 'p1', false),
        index('instance', 'ready'),
        index('project', 'ready', 'p2'),
      ]),
    } as unknown as MemoryIndexRepository;

    const { app, sessionManager } = createApp({
      facts,
      indexes,
      isPluginActive: () => true,
    });
    const session = await sessionManager.createSession({ title: 'S', projectId: 'p1' });
    await sessionManager.addMessage(session.id, {
      id: generateId(),
      role: MessageRole.ASSISTANT,
      seq: 1,
      origin: 'local',
      parts: [makeTextPart('ответ')],
      content: 'ответ',
      createdAt: nowISO(),
      disabled: false,
      pinned: false,
      hidden: false,
      promptMeta: {
        agentRole: 'assistant',
        generation: 1,
        expected: 'hit',
        cachedTokens: 0,
        validated: true,
        memory: {
          facts: { chars: 100, estTokens: 25, status: 'loaded' },
          recall: { chars: 0, estTokens: 0, status: 'empty' },
        },
      },
    });

    const res = await app.request(`/api/v2/sessions/${session.id}/memory`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      indexes: { items: Array<{ scope: string; state: string; enabled: boolean }> };
    } & Record<string, unknown>;

    expect(body).toMatchObject({
      provider: { active: true },
      scope: { projectId: 'p1' },
      projectMemory: { enabled: true },
      lastContext: {
        facts: { chars: 100, estTokens: 25, status: 'loaded' },
        recall: { chars: 0, estTokens: 0, status: 'empty' },
      },
      facts: { active: 2 },
      indexes: { total: 3, project: 2, instance: 1, ready: 2, building: 0, failed: 1 },
      readiness: 'degraded',
    });
    expect(body.indexes.items).toHaveLength(3);
    expect(body.indexes.items.map((item: { scope: string }) => item.scope).sort()).toEqual([
      'instance', 'project', 'project',
    ]);
    expect(body.indexes.items.find((item: { state: string }) => item.state === 'failed')?.enabled).toBe(false);
    expect(body.indexes.items.find((item: { scope: string }) => item.scope === 'instance')?.enabled).toBe(true);
  });

  it('project.memory.enabled=false → projectMemory.enabled=false', async () => {
    const facts = { list: vi.fn(async () => []) } as unknown as MemoryFactRepository;
    const indexes = { listIndexes: vi.fn(async () => []) } as unknown as MemoryIndexRepository;
    const { app, sessionManager } = createApp(
      { facts, indexes, isPluginActive: () => true },
      { load: async () => ({ memory: { enabled: false } }) },
    );
    const session = await sessionManager.createSession({ title: 'S', projectId: 'p1' });

    const res = await app.request(`/api/v2/sessions/${session.id}/memory`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { projectMemory: unknown }).projectMemory).toEqual({ enabled: false });
  });

  it('без ходов — lastContext: null', async () => {
    const facts = { list: vi.fn(async () => []) } as unknown as MemoryFactRepository;
    const indexes = { listIndexes: vi.fn(async () => []) } as unknown as MemoryIndexRepository;
    const { app, sessionManager } = createApp({ facts, indexes, isPluginActive: () => true });
    const session = await sessionManager.createSession({ title: 'S' });

    const res = await app.request(`/api/v2/sessions/${session.id}/memory`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { lastContext: unknown }).lastContext).toBeNull();
  });

  it('плагин не активен → 200, readiness unavailable', async () => {
    const { app, sessionManager } = createApp();
    const session = await sessionManager.createSession({ title: 'S' });

    const res = await app.request(`/api/v2/sessions/${session.id}/memory`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      provider: { active: boolean };
      readiness: string;
      indexes: { total: number };
    };
    expect(body.provider.active).toBe(false);
    expect(body.readiness).toBe('unavailable');
    expect(body.indexes.total).toBe(0);
  });

  it('несуществующая сессия → 404', async () => {
    const { app } = createApp();
    const res = await app.request('/api/v2/sessions/нет-такой/memory');
    expect(res.status).toBe(404);
  });
});

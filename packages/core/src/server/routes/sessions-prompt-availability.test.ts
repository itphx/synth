/**
 * `POST /api/v2/sessions/:id/prompt` — проверка доступности пары провайдер/модель.
 *
 * Отключённые администратором провайдер/модель отклоняются **до** вложений и
 * постановки в очередь: `400 PROVIDER_DISABLED` / `MODEL_DISABLED` с
 * `details`. Нет записи в каталоге (`undefined`) — не блокируем. Тело запроса
 * (`provider`/`model`) перекрывает настройки сессии.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionRoutes, type SessionRoutesDeps } from './sessions.js';
import { SessionManager, EventBus, FileStore } from '../../index.js';
import type { QueueProcessorManager, ChatOrchestrator } from '../../index.js';
import { ProjectStore } from '../../storage/project-store.js';
import type { AuthKit } from '../../auth/local.js';

function createMockAuth(): AuthKit {
  return {
    getCurrentUser: () => null,
    requireAuth: async (_c: Context, next: Next) => { await next(); },
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
    interrupt: vi.fn().mockReturnValue(true),
    obfuscateUserMessageForHistory: vi.fn(async (_sid: string, message: unknown) => message),
    getModelPricing: vi.fn().mockReturnValue(null),
  };
}

type Availability = NonNullable<SessionRoutesDeps['llmAvailability']>;

function createTestApp(
  tmpDir: string,
  opts?: { llmAvailability?: Availability; remoteClient?: unknown },
) {
  const app = new Hono();
  const fileStore = new FileStore({ dataDir: tmpDir });
  const sessionManager = new SessionManager(fileStore);
  const projectStore = new ProjectStore({ dataDir: tmpDir });
  const eventBus = new EventBus();
  const queueManager = createMockQueueManager();
  const orchestrator = createMockOrchestrator();

  const sessionRoutes = createSessionRoutes(
    createMockAuth(),
    {
      sessionManager,
      eventBus,
      queueManager: queueManager as unknown as QueueProcessorManager,
      processMessage: orchestrator.createProcessMessage(),
      orchestrator: orchestrator as unknown as ChatOrchestrator,
      projectStore,
      ...(opts?.llmAvailability ? { llmAvailability: opts.llmAvailability } : {}),
      ...(opts?.remoteClient ? { getRemoteClient: () => opts.remoteClient as never } : {}),
    },
  );

  app.route('/api/v2/sessions', sessionRoutes);
  return { app, sessionManager };
}

interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

describe('POST /api/v2/sessions/:id/prompt — доступность провайдера/модели', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-session-availability-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('провайдер отключён → 400 PROVIDER_DISABLED + details.provider, очередь пуста', async () => {
    const { app, sessionManager } = createTestApp(tmpDir, {
      llmAvailability: {
        isProviderEnabled: (name) => (name === 'disabled-provider' ? false : true),
        isModelEnabled: () => true,
      },
    });
    const session = await sessionManager.createSession({
      title: 'A',
      userId: 'local',
      settings: { provider: 'disabled-provider', model: 'model-1' } as never,
    });

    const res = await app.request(`/api/v2/sessions/${session.id}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'привет' }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe('PROVIDER_DISABLED');
    expect(body.error.details).toEqual({ provider: 'disabled-provider' });
    expect(body.error.message).toContain('disabled-provider');

    const fresh = (await sessionManager.getSession(session.id))!;
    expect(fresh.pendingMessages).toHaveLength(0);
    expect(fresh.messages).toHaveLength(0);
  });

  it('модель отключена → 400 MODEL_DISABLED + details {provider, model}, очередь пуста', async () => {
    const { app, sessionManager } = createTestApp(tmpDir, {
      llmAvailability: {
        isProviderEnabled: () => true,
        isModelEnabled: (provider, model) => !(provider === 'p1' && model === 'off-model'),
      },
    });
    const session = await sessionManager.createSession({
      title: 'B',
      userId: 'local',
      settings: { provider: 'p1', model: 'off-model' } as never,
    });

    const res = await app.request(`/api/v2/sessions/${session.id}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'привет' }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe('MODEL_DISABLED');
    expect(body.error.details).toEqual({ provider: 'p1', model: 'off-model' });

    const fresh = (await sessionManager.getSession(session.id))!;
    expect(fresh.pendingMessages).toHaveLength(0);
    expect(fresh.messages).toHaveLength(0);
  });

  it('провайдер проверяется раньше модели', async () => {
    const { app, sessionManager } = createTestApp(tmpDir, {
      llmAvailability: {
        isProviderEnabled: () => false,
        isModelEnabled: () => false,
      },
    });
    const session = await sessionManager.createSession({ title: 'C', userId: 'local' });

    const res = await app.request(`/api/v2/sessions/${session.id}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'привет', provider: 'p1', model: 'm1' }),
    });

    expect(res.status).toBe(400);
    expect(((await res.json()) as ErrorBody).error.code).toBe('PROVIDER_DISABLED');
  });

  it('нет записи в каталоге (undefined) → 202 и сообщение в очереди', async () => {
    const { app, sessionManager } = createTestApp(tmpDir, {
      llmAvailability: {
        isProviderEnabled: () => undefined,
        isModelEnabled: () => undefined,
      },
    });
    const session = await sessionManager.createSession({
      title: 'D',
      userId: 'local',
      settings: { provider: 'unknown-provider', model: 'unknown-model' } as never,
    });

    const res = await app.request(`/api/v2/sessions/${session.id}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'привет' }),
    });

    expect(res.status).toBe(202);
    const fresh = (await sessionManager.getSession(session.id))!;
    expect(fresh.pendingMessages).toHaveLength(1);
  });

  it('body.provider/model перекрывают настройки сессии (включённые в сессии, отключённые в теле)', async () => {
    const { app, sessionManager } = createTestApp(tmpDir, {
      llmAvailability: {
        isProviderEnabled: (name) => name !== 'off-provider',
        isModelEnabled: (provider, model) => !(provider === 'on-provider' && model === 'off-model'),
      },
    });
    const session = await sessionManager.createSession({
      title: 'E',
      userId: 'local',
      settings: { provider: 'on-provider', model: 'good-model' } as never,
    });

    const providerRes = await app.request(`/api/v2/sessions/${session.id}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'раз', provider: 'off-provider' }),
    });
    expect(providerRes.status).toBe(400);
    expect(((await providerRes.json()) as ErrorBody).error.code).toBe('PROVIDER_DISABLED');

    const modelRes = await app.request(`/api/v2/sessions/${session.id}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'два', model: 'off-model' }),
    });
    expect(modelRes.status).toBe(400);
    const body = (await modelRes.json()) as ErrorBody;
    expect(body.error.code).toBe('MODEL_DISABLED');
    expect(body.error.details).toEqual({ provider: 'on-provider', model: 'off-model' });

    // Ни один из отклонённых запросов не попал в очередь.
    const fresh = (await sessionManager.getSession(session.id))!;
    expect(fresh.pendingMessages).toHaveLength(0);
    expect(fresh.messages).toHaveLength(0);
  });
});

describe('POST /api/v2/sessions/:id/prompt — гибрид (remote-сессия)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-session-availability-remote-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('4xx удалённой стороны пробрасывается как есть (статус + code + details), не 202', async () => {
    const remoteBody = {
      error: {
        code: 'MODEL_DISABLED',
        message: 'Модель p/m отключена — выберите другую модель',
        details: { provider: 'p', model: 'm' },
      },
    };
    const remoteClient = {
      promptSession: vi.fn(async () => new Response(JSON.stringify(remoteBody), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })),
    };
    const { app } = createTestApp(tmpDir, { remoteClient });

    const res = await app.request('/api/v2/sessions/remote:abc/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'привет' }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()) as unknown).toEqual(remoteBody);
    expect(remoteClient.promptSession).toHaveBeenCalledWith(
      'abc',
      expect.objectContaining({ content: 'привет' }),
      expect.objectContaining({ allowHttpError: true }),
    );
  });

  it('старый сервер (не-202 не-4xx) — мягкая деградация 202', async () => {
    const remoteClient = {
      promptSession: vi.fn(async () => new Response('{}', { status: 200 })),
    };
    const { app } = createTestApp(tmpDir, { remoteClient });

    const res = await app.request('/api/v2/sessions/remote:abc/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'привет' }),
    });

    expect(res.status).toBe(202);
    const body = (await res.json()) as { mode: string; position: number | null };
    expect(body.mode).toBe('queue');
    expect(body.position).toBeNull();
  });
});

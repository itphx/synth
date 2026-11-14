/**
 * PROP-126 §2: `@file` — чтение файла внутри workspace сессии.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionRoutes } from './sessions.js';
import { SessionManager, EventBus, FileStore } from '../../index.js';
import type { QueueProcessorManager, ChatOrchestrator } from '../../index.js';
import type { AuthKit } from '../../auth/local.js';

function auth(): AuthKit {
  return {
    getCurrentUser: () => null,
    requireAuth: async (_c: Context, next: Next) => { await next(); },
  } as unknown as AuthKit;
}

function queue() {
  return {
    isRunning: vi.fn().mockReturnValue(false),
    stop: vi.fn(), createProcessor: vi.fn(), stopAll: vi.fn(),
    getRingBuffer: vi.fn(), setContextOptimizer: vi.fn(),
    requestStop: vi.fn().mockReturnValue(false),
  };
}

function orchestrator() {
  const processMessage = vi.fn().mockResolvedValue({});
  return {
    createProcessMessage: () => processMessage,
    cancel: vi.fn(), interrupt: vi.fn().mockReturnValue(true),
    obfuscateUserMessageForHistory: vi.fn(async (_sid: string, message: unknown) => message),
    getPromptInfo: vi.fn().mockResolvedValue({}),
    getModelPricing: vi.fn().mockReturnValue(null),
  };
}

describe('POST /prompt — @file (PROP-126 §2)', () => {
  let tmpDir: string;

  beforeEach(async () => { tmpDir = await mkdtemp(join(tmpdir(), 'synth-file-mention-')); });
  afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

  async function setup(content: string) {
    const app = new Hono();
    const sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    const eventBus = new EventBus();
    const orch = orchestrator();
    const routes = createSessionRoutes(auth(), {
      sessionManager,
      eventBus,
      queueManager: queue() as unknown as QueueProcessorManager,
      processMessage: orch.createProcessMessage(),
      orchestrator: orch as unknown as ChatOrchestrator,
    }, {
      resolveUserId: () => 'local',
      canAccess: (session: { ownerId?: string; userId?: string }, _c: Context, userId: string) =>
        (session.ownerId ?? session.userId) === userId,
    });
    app.route('/api/v2/sessions', routes);
    const session = await sessionManager.createSession({ title: 'P', userId: 'local', ownerId: 'local' });
    session.worktree = { worktreeId: 'w1', projectId: 'p1', branch: 'main', directory: tmpDir };
    await sessionManager.saveSession(session);
    const res = await app.request(`/api/v2/sessions/${session.id}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    const fresh = (await sessionManager.getSession(session.id))!;
    return { res, fresh };
  }

  it('читает текстовый файл и добавляет блок <file>', async () => {
    await writeFile(join(tmpDir, 'note.txt'), 'ТЕЛО ФАЙЛА', 'utf-8');
    const { res, fresh } = await setup('посмотри @note.txt');
    expect(res.status).toBe(202);
    expect(fresh.pendingMessages[0]?.content).toContain('посмотри @note.txt');
    expect(fresh.pendingMessages[0]?.content).toContain('<file path="note.txt">');
    expect(fresh.pendingMessages[0]?.content).toContain('ТЕЛО ФАЙЛА');
    expect(fresh.pendingMessages[0]?.metadata?.fileMentions).toEqual(['note.txt']);
  });

  it('файл вне workspace / отсутствует → 400', async () => {
    const { res, fresh } = await setup('посмотри @../secret.txt');
    expect(res.status).toBe(400);
    expect(fresh.pendingMessages).toHaveLength(0);
  });
});

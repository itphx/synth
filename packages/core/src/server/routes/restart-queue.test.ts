/**
 * Осознанная остановка обработки (`queueStopped`) и её снятие:
 * - `POST /sessions/:id/abort` без живого процессора при непустой очереди
 *   ставит флаг и публикует `queue.stalled` (UI — баннер «Обработка остановлена»);
 * - `POST /queue/:sessionId/resume` снимает флаг и поднимает процессор.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionRoutes } from './sessions.js';
import { createQueueRoutes } from './queue.js';
import { SessionManager } from '../../sessions/manager.js';
import { FileStore } from '../../storage/file-store.js';
import { EventBus } from '../../events/bus.js';
import { ProjectStore } from '../../storage/project-store.js';
import type { QueueProcessorManager, ChatOrchestrator } from '../../index.js';
import type { AuthKit } from '../../auth/local.js';
import { generateId, makeTextPart, MessageRole, nowISO } from '@itphx/synth-shared';
import type { BusEvent, Message } from '@itphx/synth-shared';

function createMockAuth(): AuthKit {
  return {
    getCurrentUser: () => null,
    requireAuth: async (_c: Context, next: Next) => { await next(); },
  } as unknown as AuthKit;
}

function createMockQueueManager(opts?: { running?: boolean }) {
  return {
    isRunning: vi.fn().mockReturnValue(opts?.running ?? false),
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
    obfuscateUserMessageForHistory: vi.fn(async (_sid: string, message: unknown) => message),
  };
}

function makeUserMessage(content: string): Message {
  return {
    id: generateId(),
    role: MessageRole.USER,
    seq: 0,
    origin: 'local',
    parts: [makeTextPart(content)],
    content,
    createdAt: nowISO(),
    disabled: false,
    pinned: false,
    hidden: false,
    author: 'local',
    metadata: { stream_id: generateId() },
  };
}

describe('queueStopped: Stop без процессора и resume', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;
  let eventBus: EventBus;
  let queueManager: ReturnType<typeof createMockQueueManager>;
  let orchestrator: ReturnType<typeof createMockOrchestrator>;
  let sessionApp: Hono;
  let queueApp: Hono;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-restart-queue-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    const projectStore = new ProjectStore({ dataDir: tmpDir });
    eventBus = new EventBus();
    queueManager = createMockQueueManager();
    orchestrator = createMockOrchestrator();

    sessionApp = new Hono();
    sessionApp.route('/api/v2/sessions', createSessionRoutes(
      createMockAuth(),
      {
        sessionManager,
        eventBus,
        queueManager: queueManager as unknown as QueueProcessorManager,
        processMessage: orchestrator.createProcessMessage() as never,
        orchestrator: orchestrator as unknown as ChatOrchestrator,
        projectStore,
      },
    ));

    queueApp = new Hono();
    queueApp.route('/api/v2/queue', createQueueRoutes(
      createMockAuth(),
      sessionManager,
      queueManager as unknown as QueueProcessorManager,
      eventBus,
      (async () => ({})) as unknown as ReturnType<ChatOrchestrator['createProcessMessage']>,
    ));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('abort без процессора при pending ставит queueStopped и публикует queue.stalled', async () => {
    const session = await sessionManager.createSession({ title: 'Stop' });
    await sessionManager.addPendingMessage(session.id, makeUserMessage('в очереди'));
    const events: BusEvent[] = [];
    eventBus.subscribe(session.id, (event) => events.push(event));

    const res = await sessionApp.request(`/api/v2/sessions/${session.id}/abort`, { method: 'POST' });

    expect(res.status).toBe(200);
    const stored = (await sessionManager.getSession(session.id))!;
    expect(stored.pendingMessages).toHaveLength(1);
    expect(stored.status.queueStopped).toBe(true);
    expect(stored.status.queueStoppedAt).toBeTruthy();
    expect(events.some((e) => e.type === 'queue.stalled')).toBe(true);
  });

  it('resume снимает queueStopped и поднимает процессор', async () => {
    const session = await sessionManager.createSession({ title: 'Resume' });
    await sessionManager.addPendingMessage(session.id, makeUserMessage('продолжить'));
    await sessionManager.withLock(session.id, async (s) => {
      s.status.queueStopped = true;
      s.status.queueStoppedAt = nowISO();
      await sessionManager.saveSession(s);
    });

    const res = await queueApp.request(`/api/v2/queue/${session.id}/resume`, { method: 'POST' });

    expect(res.status).toBe(200);
    const stored = (await sessionManager.getSession(session.id))!;
    expect(stored.status.queueStopped).toBeUndefined();
    expect(stored.status.queueStoppedAt).toBeUndefined();
    expect(queueManager.createProcessor).toHaveBeenCalled();
  });
});

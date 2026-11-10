/**
 * ADR-029: восстановление полосы подтверждения после перезагрузки страницы.
 *
 * `GET /api/v2/sessions/:id/permissions` отдаёт ожидающие ответа запросы
 * подтверждения сессии — тот же снимок, что уходил в live-событии
 * `permission.asked`. Без него клиент после reload (или после протухшей
 * аутентификации) не знает о висящем запросе: карточка пропадает, а инструмент
 * висит до ask-таймаута.
 *
 * Проверяем: форму DTO (snake_case — как в payload события), исчезновение
 * записи после ответа/таймера, метку `held` («Остановить таймер») и форвард
 * для `remote:`-сессии (гибрид).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionRoutes } from './sessions.js';
import { SessionManager, EventBus, FileStore, PermissionApprovalManager } from '../../index.js';
import type { QueueProcessorManager, ChatOrchestrator } from '../../index.js';
import type { ApprovalRequest } from '../../engine/permission/approval.js';
import type { AuthKit } from '../../auth/local.js';
import type { RemoteBackendClient } from '../../remote/client.js';

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

interface TestWorld {
  app: Hono;
  sessionManager: SessionManager;
  eventBus: EventBus;
  approvals: PermissionApprovalManager;
  remote: { listSessionPermissions: ReturnType<typeof vi.fn> };
}

/**
 * Песочница: реальный менеджер подтверждений (он и ведёт реестр ожиданий) +
 * seam оркестратора `listPendingApprovals`.
 */
function createApp(tmpDir: string): TestWorld {
  const app = new Hono();
  const sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
  const eventBus = new EventBus();
  const queueManager = createMockQueueManager();
  const approvals = new PermissionApprovalManager(eventBus);
  const processMessage = vi.fn().mockResolvedValue({});
  const orchestrator = {
    createProcessMessage: () => processMessage,
    cancel: vi.fn(),
    agentRegistry: { get: () => undefined },
    listPendingApprovals: (sessionId: string) => approvals.listPending(sessionId),
  };
  const remote = {
    listSessionPermissions: vi.fn().mockResolvedValue({ permissions: [] }),
  };

  app.route('/api/v2/sessions', createSessionRoutes(
    createMockAuth(),
    {
      sessionManager,
      eventBus,
      queueManager: queueManager as unknown as QueueProcessorManager,
      processMessage: orchestrator.createProcessMessage(),
      orchestrator: orchestrator as unknown as ChatOrchestrator,
      getRemoteClient: () => remote as unknown as RemoteBackendClient,
    },
  ));

  return { app, sessionManager, eventBus, approvals, remote };
}

/** Опубликовать запрос подтверждения (живой `permission.asked`). */
function ask(
  world: TestWorld,
  sessionId: string,
  request: Partial<ApprovalRequest> & { approvalId: string },
  timeoutMs = 300_000,
): void {
  // Подписчик нужен: без пользовательских подписчиков спрашивать некому —
  // менеджер закрывает ожидание без публикации.
  world.eventBus.subscribe(sessionId, () => {});
  const waiter = world.approvals.prepareWaiter(
    sessionId,
    {
      callId: `call-${request.approvalId}`,
      toolName: 'execute_shell',
      arguments: { command: 'ls -la' },
      reason: 'нужна проверка',
      ...request,
    },
    timeoutMs,
  );
  world.approvals.publishWaiters([waiter]);
}

describe('HTTP: восстановление ожиданий подтверждения (ADR-029)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-session-perms-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('GET /:id/permissions — DTO в snake_case (как payload события permission.asked)', async () => {
    const world = createApp(tmpDir);
    const session = await world.sessionManager.createSession({ title: 'S', userId: 'local' });
    ask(world, session.id, {
      approvalId: 'ap-1',
      preview: { files: [{ path: 'a.txt', diff: '+x', additions: 1, deletions: 0 }] },
      save: ['ls *'],
    });

    const res = await world.app.request(`/api/v2/sessions/${session.id}/permissions`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      permissions: Array<Record<string, unknown>>;
    };
    expect(body.permissions).toHaveLength(1);
    const dto = body.permissions[0]!;
    expect(dto.approval_id).toBe('ap-1');
    expect(dto.tool).toBe('execute_shell');
    expect(dto.arguments).toEqual({ command: 'ls -la' });
    expect(dto.reason).toBe('нужна проверка');
    expect(typeof dto.asked_at).toBe('string');
    expect(new Date(dto.asked_at as string).toISOString()).toBe(dto.asked_at);
    expect(dto.ask_timeout_ms).toBe(300_000);
    expect(dto.held).toBe(false);
    expect(dto.preview).toEqual({ files: [{ path: 'a.txt', diff: '+x', additions: 1, deletions: 0 }] });
    expect(dto.save).toEqual(['ls *']);
  });

  it('preview/save отсутствуют, если их нет в запросе (аддитивно)', async () => {
    const world = createApp(tmpDir);
    const session = await world.sessionManager.createSession({ title: 'S', userId: 'local' });
    ask(world, session.id, { approvalId: 'ap-2' });

    const res = await world.app.request(`/api/v2/sessions/${session.id}/permissions`);
    const body = (await res.json()) as { permissions: Array<Record<string, unknown>> };
    expect(body.permissions).toHaveLength(1);
    expect('preview' in body.permissions[0]!).toBe(false);
    expect('save' in body.permissions[0]!).toBe(false);
  });

  it('после ответа запрос исчезает из списка', async () => {
    const world = createApp(tmpDir);
    const session = await world.sessionManager.createSession({ title: 'S', userId: 'local' });
    ask(world, session.id, { approvalId: 'ap-3' });

    const reply = await world.app.request(`/api/v2/sessions/${session.id}/permissions/ap-3`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'allow' }),
    });
    expect(reply.status).toBe(200);

    const res = await world.app.request(`/api/v2/sessions/${session.id}/permissions`);
    const body = (await res.json()) as { permissions: unknown[] };
    expect(body.permissions).toHaveLength(0);
  });

  it('«Остановить таймер» (hold) — запрос живёт, held=true', async () => {
    const world = createApp(tmpDir);
    const session = await world.sessionManager.createSession({ title: 'S', userId: 'local' });
    ask(world, session.id, { approvalId: 'ap-4' });

    const hold = await world.app.request(`/api/v2/sessions/${session.id}/permissions/ap-4`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'hold' }),
    });
    expect(hold.status).toBe(200);

    const res = await world.app.request(`/api/v2/sessions/${session.id}/permissions`);
    const body = (await res.json()) as { permissions: Array<Record<string, unknown>> };
    expect(body.permissions).toHaveLength(1);
    expect(body.permissions[0]!.held).toBe(true);
  });

  it('истёкший таймер — ожидание снято, в списке его нет', async () => {
    const world = createApp(tmpDir);
    const session = await world.sessionManager.createSession({ title: 'S', userId: 'local' });
    ask(world, session.id, { approvalId: 'ap-5' }, 20);

    await new Promise((r) => setTimeout(r, 60));
    const res = await world.app.request(`/api/v2/sessions/${session.id}/permissions`);
    const body = (await res.json()) as { permissions: unknown[] };
    expect(body.permissions).toHaveLength(0);
  });

  it('ожидания другой сессии не видны', async () => {
    const world = createApp(tmpDir);
    const first = await world.sessionManager.createSession({ title: 'A', userId: 'local' });
    const second = await world.sessionManager.createSession({ title: 'B', userId: 'local' });
    ask(world, first.id, { approvalId: 'ap-6' });

    const res = await world.app.request(`/api/v2/sessions/${second.id}/permissions`);
    const body = (await res.json()) as { permissions: unknown[] };
    expect(body.permissions).toHaveLength(0);
  });

  it('гибрид: remote-сессия — форвард на удалённый backend', async () => {
    const world = createApp(tmpDir);
    world.remote.listSessionPermissions.mockResolvedValue({
      permissions: [{ approval_id: 'ap-remote', tool: 'execute_shell', arguments: { command: 'ls' } }],
    });

    const res = await world.app.request('/api/v2/sessions/remote:rs-1/permissions');
    expect(res.status).toBe(200);
    expect(world.remote.listSessionPermissions).toHaveBeenCalledWith('rs-1');
    const body = (await res.json()) as { permissions: Array<Record<string, unknown>> };
    expect(body.permissions).toHaveLength(1);
    expect(body.permissions[0]!.approval_id).toBe('ap-remote');
  });
});

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
import { SessionManager, EventBus, FileStore, PermissionApprovalManager, ChatOrchestrator } from '../../index.js';
import { ContextConfig } from '../../engine/context/config.js';
import type { QueueProcessorManager } from '../../index.js';
import type { ApprovalRequest } from '../../engine/permission/approval.js';
import type { AuthKit } from '../../auth/local.js';
import type { RemoteBackendClient } from '../../remote/client.js';
import type { ContextBuilder } from '../../engine/context/builder.js';
import type { PermissionConfig } from '@itphx/synth-shared';
import { MemoryPendingApprovalRepository } from '../../storage/memory/pending-approvals.js';
import type { PendingApprovalRecord } from '../../storage/ports/pending-approval-repository.js';

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
  repository: MemoryPendingApprovalRepository;
  remote: { listSessionPermissions: ReturnType<typeof vi.fn> };
}

/**
 * Песочница: реальный менеджер подтверждений (он и ведёт реестр ожиданий) +
 * seam оркестратора `listPendingApprovals`.
 *
 * ADR-029: у менеджера — **отдельное хранилище ожиданий** (не документ
 * сессии): запись в документ — полная замена истории, а результаты
 * параллельных тулов пишутся точечно (`appendMessage`, ADR-118 §4).
 */
function createApp(tmpDir: string): TestWorld {
  const app = new Hono();
  const sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
  const eventBus = new EventBus();
  const queueManager = createMockQueueManager();
  const repository = new MemoryPendingApprovalRepository();
  const approvals = new PermissionApprovalManager(eventBus, { repository });
  const processMessage = vi.fn().mockResolvedValue({});
  const orchestrator = {
    createProcessMessage: () => processMessage,
    cancel: vi.fn(),
    agentRegistry: { get: () => undefined },
    listPendingApprovals: (sessionId: string) => approvals.listPending(sessionId),
    listPendingApprovalCounts: () => approvals.listPendingCounts(),
  };
  const remote = {
    listSessionPermissions: vi.fn().mockResolvedValue({ permissions: [] }),
    // Гибридная ветка списка сессий (`GET /api/v2/sessions`) обходит удалённый
    // мир целиком; в этом тесте удалённых сессий нет.
    listAllSessions: vi.fn().mockResolvedValue({ items: [], total: 0, truncated: false }),
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

  return { app, sessionManager, eventBus, approvals, repository, remote };
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

  it('trigger (структурная причина ask\'а) переживает перезагрузку страницы', async () => {
    const world = createApp(tmpDir);
    const session = await world.sessionManager.createSession({ title: 'S', userId: 'local' });
    ask(world, session.id, {
      approvalId: 'ap-trigger',
      trigger: {
        messageId: 'ask-protected-path',
        params: { path: '/etc/secret' },
        matchedRule: 'protected-paths.ask',
        askKind: 'protected',
      },
    });

    const res = await world.app.request(`/api/v2/sessions/${session.id}/permissions`);
    const body = (await res.json()) as { permissions: Array<Record<string, unknown>> };
    expect(body.permissions[0]!.trigger).toEqual({
      messageId: 'ask-protected-path',
      params: { path: '/etc/secret' },
      matchedRule: 'protected-paths.ask',
      askKind: 'protected',
    });
  });

  it('trigger отсутствует, если его нет в запросе (аддитивно)', async () => {
    const world = createApp(tmpDir);
    const session = await world.sessionManager.createSession({ title: 'S', userId: 'local' });
    ask(world, session.id, { approvalId: 'ap-no-trigger' });

    const res = await world.app.request(`/api/v2/sessions/${session.id}/permissions`);
    const body = (await res.json()) as { permissions: Array<Record<string, unknown>> };
    expect('trigger' in body.permissions[0]!).toBe(false);
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

/**
 * DTO сессии — счётчик висящих подтверждений (`pending_approvals`).
 *
 * Индикатор «ждёт подтверждения прав» в дереве сессий после перезагрузки
 * страницы берётся из DTO: живой стор клиента (`usePermissionStore`) пуст, а
 * сервер знает о висящих ожиданиях (реестр в памяти процесса).
 */
describe('HTTP: счётчик подтверждений в DTO сессии (ADR-029)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-session-pending-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('GET /api/v2/sessions — pending_approvals: 0, когда ожиданий нет', async () => {
    const world = createApp(tmpDir);
    await world.sessionManager.createSession({ title: 'A', userId: 'local' });

    const res = await world.app.request('/api/v2/sessions');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sessions: Array<{ id: string; pending_approvals?: number }>;
    };
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]!.pending_approvals).toBe(0);
  });

  it('GET /api/v2/sessions — pending_approvals > 0 у сессии с висящим подтверждением', async () => {
    const world = createApp(tmpDir);
    const withApproval = await world.sessionManager.createSession({ title: 'A', userId: 'local' });
    const plain = await world.sessionManager.createSession({ title: 'B', userId: 'local' });
    ask(world, withApproval.id, { approvalId: 'ap-list-1' });

    const res = await world.app.request('/api/v2/sessions');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sessions: Array<{ id: string; pending_approvals?: number }>;
    };
    const byId = new Map(body.sessions.map((s) => [s.id, s.pending_approvals]));
    expect(byId.get(withApproval.id)).toBe(1);
    expect(byId.get(plain.id)).toBe(0);
  });

  it('GET /api/v2/sessions/:id — счётчик согласован со списком', async () => {
    const world = createApp(tmpDir);
    const session = await world.sessionManager.createSession({ title: 'A', userId: 'local' });
    ask(world, session.id, { approvalId: 'ap-detail-1' });

    const res = await world.app.request(`/api/v2/sessions/${session.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pending_approvals?: number };
    expect(body.pending_approvals).toBe(1);
  });

  it('точечные ответы без счётчика поле не добавляют (аддитивно)', async () => {
    // DTO сессии не должен засоряться полем у всех вызовов: там, где счётчик
    // не считается (POST /, PATCH /:id), ключа `pending_approvals` нет.
    const world = createApp(tmpDir);
    const created = await world.app.request('/api/v2/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'A' }),
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as Record<string, unknown>;
    expect('pending_approvals' in createdBody).toBe(false);

    const sessionId = createdBody.id as string;
    const patched = await world.app.request(`/api/v2/sessions/${sessionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'B' }),
    });
    expect(patched.status).toBe(200);
    const patchedBody = (await patched.json()) as Record<string, unknown>;
    expect('pending_approvals' in patchedBody).toBe(false);
  });
});

/**
 * ADR-029: **восстановленное** ожидание подтверждения (после рестарта
 * инстанса).
 *
 * Живой реестр ожиданий живёт в памяти процесса: после рестарта он пуст, а
 * ожидание остаётся в документе сессии (`Session.pendingApprovals`). Снимок
 * `GET /:id/permissions` отдаёт его с признаком `restored: true`, а ответ
 * применяется как **грант в сессии** (живого waiter'а нет — разбудить
 * прежний вызов нечем).
 *
 * Здесь — **настоящий** оркестратор (не мок): проверяем связку
 * `resolvePendingApproval` → `grantSessionToolAllow` → `clearPendingApproval`
 * и HTTP-контракт ответа.
 */
describe('HTTP: восстановленное ожидание подтверждения (после рестарта, ADR-029)', () => {
  let tmpDir: string;

  function makeCtxBuilder(): ContextBuilder {
    return {
      buildSystemPrompt: async () => 'system prompt',
      buildBaseBlocks: async () => [
        { key: 'role', tier: 'stable', order: 10, content: 'system prompt' },
      ],
    } as unknown as ContextBuilder;
  }

  /** Приложение с настоящим оркестратором над хранилищем сессий. */
  function createRealApp(dir: string) {
    const app = new Hono();
    const sessionManager = new SessionManager(new FileStore({ dataDir: dir }));
    const eventBus = new EventBus();
    const queueManager = createMockQueueManager();
    // ADR-029: отдельное хранилище ожиданий (не документ сессии).
    const repository = new MemoryPendingApprovalRepository();
    const orchestrator = new ChatOrchestrator({
      sessionManager,
      eventBus,
      contextBuilder: makeCtxBuilder(),
      providerLoader: () => null,
      permissionConfig: { rules: {}, askTimeoutMs: 0 } as unknown as PermissionConfig,
      defaultWorkingDir: dir,
      contextConfig: new ContextConfig({ userDataDir: join(tmpdir(), 'context') }),
      pendingApprovalRepository: repository,
    });
    app.route('/api/v2/sessions', createSessionRoutes(
      createMockAuth(),
      {
        sessionManager,
        eventBus,
        queueManager: queueManager as unknown as QueueProcessorManager,
        processMessage: orchestrator.createProcessMessage(),
        orchestrator,
      },
    ));
    return { app, sessionManager, eventBus, orchestrator, repository };
  }

  /** Снимок ожидания, который оставил умерший процесс. */
  function restoredRecord(approvalId: string, sessionId: string): PendingApprovalRecord {
    return {
      approvalId,
      sessionId,
      toolName: 'gated_tool',
      arguments: {},
      reason: 'правило gated_tool → ask',
      askedAt: new Date().toISOString(),
      timeoutMs: 0,
    };
  }

  /**
   * «Умерший процесс» оставил ожидание в **хранилище ожиданий**; новый
   * процесс восстанавливает его при старте (`restorePendingApprovals`).
   */
  async function seedRestored(
    world: { repository: MemoryPendingApprovalRepository; orchestrator: ChatOrchestrator },
    sessionId: string,
    approvalId: string,
  ): Promise<void> {
    await world.repository.save(restoredRecord(approvalId, sessionId));
    await world.orchestrator.restorePendingApprovals();
  }

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-session-restored-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('GET /:id/permissions — восстановленное ожидание помечено restored: true', async () => {
    const world = createRealApp(tmpDir);
    const session = await world.sessionManager.createSession({ title: 'S', userId: 'local' });
    await seedRestored(world, session.id, 'ap-restored');

    const res = await world.app.request(`/api/v2/sessions/${session.id}/permissions`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { permissions: Array<Record<string, unknown>> };
    expect(body.permissions).toHaveLength(1);
    expect(body.permissions[0]!.approval_id).toBe('ap-restored');
    expect(body.permissions[0]!.restored).toBe(true);
    // Таймера после рестарта нет (процесс, который его ставил, умер) —
    // карточка живёт до ответа.
    expect(body.permissions[0]!.held).toBe(true);
  });

  it('счётчик pending_approvals учитывает восстановленное ожидание', async () => {
    const world = createRealApp(tmpDir);
    const session = await world.sessionManager.createSession({ title: 'S', userId: 'local' });
    await seedRestored(world, session.id, 'ap-restored');

    const list = await world.app.request('/api/v2/sessions');
    const listBody = (await list.json()) as { sessions: Array<{ id: string; pending_approvals?: number }> };
    expect(listBody.sessions.find((s) => s.id === session.id)!.pending_approvals).toBe(1);

    const detail = await world.app.request(`/api/v2/sessions/${session.id}`);
    const detailBody = (await detail.json()) as { pending_approvals?: number };
    expect(detailBody.pending_approvals).toBe(1);
  });

  it('ответ allow применяет allow-правило в сессии и снимает ожидание', async () => {
    const world = createRealApp(tmpDir);
    const session = await world.sessionManager.createSession({ title: 'S', userId: 'local' });
    await seedRestored(world, session.id, 'ap-restored');

    const replied: Array<Record<string, unknown>> = [];
    world.eventBus.subscribe(session.id, (event) => {
      if (event.type === 'permission.replied') replied.push(event.data);
    });

    const res = await world.app.request(`/api/v2/sessions/${session.id}/permissions/ap-restored`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'allow' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', action: 'allow' });

    const after = (await world.sessionManager.getSession(session.id))!;
    // Allow-правило в правилах сессии — тот же механизм, что «Разрешить в сессии».
    expect(after.settings.permission?.rules?.gated_tool).toBe('allow');
    // Ожидание снято из хранилища — счётчик DTO снова 0.
    expect(await world.repository.list()).toEqual([]);
    expect(world.orchestrator.listPendingApprovals(session.id)).toHaveLength(0);

    expect(replied).toHaveLength(1);
    expect(replied[0]!.restored).toBe(true);
    expect(replied[0]!.approved).toBe(true);
  });

  it('ответ deny снимает ожидание, но правило не добавляет', async () => {
    const world = createRealApp(tmpDir);
    const session = await world.sessionManager.createSession({ title: 'S', userId: 'local' });
    await seedRestored(world, session.id, 'ap-restored');

    const res = await world.app.request(`/api/v2/sessions/${session.id}/permissions/ap-restored`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'deny' }),
    });
    expect(res.status).toBe(200);

    const after = (await world.sessionManager.getSession(session.id))!;
    expect(await world.repository.list()).toEqual([]);
    expect(after.settings.permission?.rules?.gated_tool).toBeUndefined();
  });

  it('«Остановить таймер» (hold) на восстановленном ожидании — 400', async () => {
    const world = createRealApp(tmpDir);
    const session = await world.sessionManager.createSession({ title: 'S', userId: 'local' });
    await seedRestored(world, session.id, 'ap-restored');

    const res = await world.app.request(`/api/v2/sessions/${session.id}/permissions/ap-restored`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'hold' }),
    });
    expect(res.status).toBe(400);

    // Ожидание осталось на месте — отказ не снимает вопрос.
    expect(await world.repository.list('s1')).toEqual([]);
    expect((await world.repository.list()).length).toBe(1);
  });

  it('неизвестный approval_id — обычный путь (реестр не задан — ответ принимается)', async () => {
    // Регресс: восстановленная ветка не должна перехватывать обычные ответы.
    const world = createRealApp(tmpDir);
    const session = await world.sessionManager.createSession({ title: 'S', userId: 'local' });

    const res = await world.app.request(`/api/v2/sessions/${session.id}/permissions/ap-unknown`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'allow' }),
    });
    expect(res.status).toBe(200);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionRoutes } from './sessions.js';
import { SessionManager, EventBus, FileStore, FileProfileStore, DEFAULT_AGENT_ID } from '../../index.js';
import { ProjectStore } from '../../storage/project-store.js';
import type { AuthKit } from '../../auth/local.js';
import { MessageRole, generateId, makeTextPart, nowISO, ProjectRole } from '@itphx/synth-shared';
import type { ProfileStore } from '@itphx/synth-shared';

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
    getPromptInfo: vi.fn().mockResolvedValue({
      manifest: { totalChars: 10, estTokens: 3, staticPrefixChars: 5, entries: [] },
      history: {
        messages: { count: 2, chars: 20, estTokens: 5 },
        stateMessages: [{ type: 'mode_change', count: 1, chars: 40, estTokens: 10 }],
        excluded: { disabled: 0, hidden: 0, info: 1 },
        attachments: { count: 0, chars: 0 },
        secretPlaceholders: 0,
      },
      promptState: null,
      lastPromptMeta: null,
    }),
    getModelPricing: vi.fn().mockReturnValue(null),
  };
}

function createTestApp(
  tmpDir: string,
  profilesStore?: ProfileStore,
  opts?: { resolveDefaultAgent?: () => string | Promise<string> },
  requestSessionService?: unknown,
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
      queueManager: queueManager as any,
      processMessage: orchestrator.createProcessMessage(),
      orchestrator: orchestrator as any,
      projectStore,
      profilesStore,
      ...(requestSessionService ? { requestSessionService: requestSessionService as any } : {}),
    },
    opts ?? {},
  );

  app.route('/api/v2/sessions', sessionRoutes);
  return { app, sessionManager, projectStore, eventBus };
}

describe('Session API Routes (PATCH mode)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-session-mode-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe('PATCH /api/v2/sessions/:id с полем mode', () => {
    it('переключает режим сессии в plan', async () => {
      const { app, sessionManager } = createTestApp(tmpDir);
      const session = await sessionManager.createSession({ title: 'S', userId: 'local' });
      const res = await app.request(`/api/v2/sessions/${session.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'plan' }),
      });
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.mode).toBe('plan');
    });

    it('переключает режим сессии в act', async () => {
      const { app, sessionManager } = createTestApp(tmpDir);
      const session = await sessionManager.createSession({ title: 'S', userId: 'local' });
      const res = await app.request(`/api/v2/sessions/${session.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'act' }),
      });
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.mode).toBe('act');
    });

    it('переключает режим сессии в yolo', async () => {
      const { app, sessionManager } = createTestApp(tmpDir);
      const session = await sessionManager.createSession({ title: 'S', userId: 'local' });
      const res = await app.request(`/api/v2/sessions/${session.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'yolo' }),
      });
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.mode).toBe('yolo');
      const reloaded = await sessionManager.getSession(session.id);
      expect(reloaded?.mode).toBe('yolo');
    });

    it('сериализованная сессия содержит mode_applicable', async () => {
      const { app, sessionManager } = createTestApp(tmpDir);
      const session = await sessionManager.createSession({ title: 'S', userId: 'local' });
      const res = await app.request(`/api/v2/sessions/${session.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'plan' }),
      });
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(typeof body.mode_applicable).toBe('boolean');
    });

    it('сохраняет mode в хранилище (переживает чтение сессии)', async () => {
      const { app, sessionManager } = createTestApp(tmpDir);
      const session = await sessionManager.createSession({ title: 'S', userId: 'local' });
      await app.request(`/api/v2/sessions/${session.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'plan' }),
      });
      const reloaded = await sessionManager.getSession(session.id);
      expect(reloaded?.mode).toBe('plan');
    });

    it('отклоняет невалидный mode', async () => {
      const { app, sessionManager } = createTestApp(tmpDir);
      const session = await sessionManager.createSession({ title: 'S', userId: 'local' });
      const res = await app.request(`/api/v2/sessions/${session.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'auto' }),
      });
      expect(res.status).toBe(400);
      const body: any = await res.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
      const reloaded = await sessionManager.getSession(session.id);
      expect(reloaded?.mode).toBeUndefined();
    });

    it('отклоняет mode не-строку', async () => {
      const { app, sessionManager } = createTestApp(tmpDir);
      const session = await sessionManager.createSession({ title: 'S', userId: 'local' });
      const res = await app.request(`/api/v2/sessions/${session.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 42 }),
      });
      expect(res.status).toBe(400);
    });

    it('отклоняет невалидный settings.reasoningLevel', async () => {
      const { app, sessionManager } = createTestApp(tmpDir);
      const session = await sessionManager.createSession({ title: 'S', userId: 'local' });
      const res = await app.request(`/api/v2/sessions/${session.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: { reasoningLevel: 'bogus' } }),
      });
      expect(res.status).toBe(400);
      const body: any = await res.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
      const reloaded = await sessionManager.getSession(session.id);
      expect(reloaded?.settings.reasoningLevel).toBeUndefined();
    });

    it('обновляет валидные settings и сохраняет их', async () => {
      const { app, sessionManager } = createTestApp(tmpDir);
      const session = await sessionManager.createSession({ title: 'S', userId: 'local' });
      const res = await app.request(`/api/v2/sessions/${session.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: { reasoningLevel: 'medium' } }),
      });
      expect(res.status).toBe(200);
      const reloaded = await sessionManager.getSession(session.id);
      expect(reloaded?.settings.reasoningLevel).toBe('medium');
    });

    it('mode обновляется вместе с другими полями в одном PATCH', async () => {
      const { app, sessionManager } = createTestApp(tmpDir);
      const session = await sessionManager.createSession({ title: 'Old', userId: 'local' });
      const res = await app.request(`/api/v2/sessions/${session.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'New Title', mode: 'plan' }),
      });
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.name).toBe('New Title');
      expect(body.mode).toBe('plan');
    });

    it('возвращает 404 для отсутствующей сессии', async () => {
      const { app } = createTestApp(tmpDir);
      const res = await app.request('/api/v2/sessions/non-existent', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'plan' }),
      });
      expect(res.status).toBe(404);
      const body: any = await res.json();
      expect(body.error.code).toBe('NOT_FOUND');
    });
  });

  describe('PATCH /api/v2/sessions/:id с полем project_id', () => {
    it('привязывает сессию к существующему проекту', async () => {
      const { app, sessionManager, projectStore } = createTestApp(tmpDir);
      const project = projectStore.create('Proj', 'u1');
      await projectStore.save(project);
      const session = await sessionManager.createSession({ title: 'S', userId: 'local' });

      const res = await app.request(`/api/v2/sessions/${session.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: project.id }),
      });
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.project_id).toBe(project.id);
      const persisted = await sessionManager.getSession(session.id);
      expect(persisted?.projectId).toBe(project.id);
    });

    it('валидирует несуществующий проект и возвращает 400 PROJECT_NOT_FOUND', async () => {
      const { app, sessionManager } = createTestApp(tmpDir);
      const session = await sessionManager.createSession({ title: 'S', userId: 'local' });

      const res = await app.request(`/api/v2/sessions/${session.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: 'missing' }),
      });
      expect(res.status).toBe(400);
      const body: any = await res.json();
      expect(body.error.code).toBe('PROJECT_NOT_FOUND');
      const persisted = await sessionManager.getSession(session.id);
      expect(persisted?.projectId).toBeUndefined();
    });

    it('смена проекта сбрасывает planApproved', async () => {
      const { app, sessionManager, projectStore } = createTestApp(tmpDir);
      const p1 = projectStore.create('P1', 'u1');
      const p2 = projectStore.create('P2', 'u1');
      await projectStore.save(p1);
      await projectStore.save(p2);

      const session = await sessionManager.createSession({ title: 'S', userId: 'local', projectId: p1.id });
      await sessionManager.updateSession({ ...session, planApproved: true });

      const res = await app.request(`/api/v2/sessions/${session.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: p2.id }),
      });
      expect(res.status).toBe(200);
      const persisted = await sessionManager.getSession(session.id);
      expect(persisted?.projectId).toBe(p2.id);
      expect(persisted?.planApproved).toBe(false);
    });

    it('публикует session.moved при смене проекта', async () => {
      const { app, sessionManager, projectStore, eventBus } = createTestApp(tmpDir);
      const p1 = projectStore.create('P1', 'u1');
      const p2 = projectStore.create('P2', 'u1');
      await projectStore.save(p1);
      await projectStore.save(p2);

      const session = await sessionManager.createSession({ title: 'S', userId: 'local', projectId: p1.id });

      let moved: Record<string, unknown> | undefined;
      eventBus.subscribe(session.id, (e) => {
        if (e.type === 'session.moved') moved = e.data as Record<string, unknown>;
      });

      const res = await app.request(`/api/v2/sessions/${session.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: p2.id }),
      });
      expect(res.status).toBe(200);
      expect(moved).toBeTruthy();
      expect(moved?.project_id).toBe(p2.id);
      expect(moved?.prev_project_id).toBe(p1.id);
    });

    /**
     * ADR-114 §3.4: привязка к worktree принадлежит проекту — при переносе
     * сессии в другой проект она снимается, и факт снятия виден в событии
     * `session.moved` (`worktree_detached`).
     */
    it('смена проекта снимает привязку к worktree (session.moved: worktree_detached)', async () => {
      const { app, sessionManager, projectStore, eventBus } = createTestApp(tmpDir);
      const p1 = projectStore.create('P1', 'u1');
      const p2 = projectStore.create('P2', 'u1');
      await projectStore.save(p1);
      await projectStore.save(p2);

      const session = await sessionManager.createSession({ title: 'S', userId: 'local', projectId: p1.id });
      await sessionManager.withLock(session.id, async (s) => {
        s.worktree = {
          worktreeId: 'wkt_test',
          projectId: p1.id,
          directory: join(tmpDir, 'worktrees', 'feature-x'),
          branch: 'feature/x',
        };
        await sessionManager.saveSession(s);
      });

      let moved: Record<string, unknown> | undefined;
      eventBus.subscribe(session.id, (e) => {
        if (e.type === 'session.moved') moved = e.data as Record<string, unknown>;
      });

      const res = await app.request(`/api/v2/sessions/${session.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: p2.id }),
      });
      expect(res.status).toBe(200);
      expect(moved).toBeTruthy();
      expect(moved?.project_id).toBe(p2.id);
      expect(moved?.worktree_detached).toBe(true);

      // Привязка снята и сохранена в хранилище.
      const persisted = await sessionManager.getSession(session.id);
      expect(persisted?.projectId).toBe(p2.id);
      expect(persisted?.worktree).toBeUndefined();
    });

    it('смена проекта без привязки к worktree: worktree_detached не публикуется', async () => {
      const { app, sessionManager, projectStore, eventBus } = createTestApp(tmpDir);
      const p1 = projectStore.create('P1', 'u1');
      const p2 = projectStore.create('P2', 'u1');
      await projectStore.save(p1);
      await projectStore.save(p2);

      const session = await sessionManager.createSession({ title: 'S', userId: 'local', projectId: p1.id });

      let moved: Record<string, unknown> | undefined;
      eventBus.subscribe(session.id, (e) => {
        if (e.type === 'session.moved') moved = e.data as Record<string, unknown>;
      });

      const res = await app.request(`/api/v2/sessions/${session.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: p2.id }),
      });
      expect(res.status).toBe(200);
      expect(moved).toBeTruthy();
      expect(moved?.worktree_detached).toBeUndefined();
    });
  });

  describe('GET /api/v2/sessions/:id/prompt (ADR-070 §2.5)', () => {
    it('возвращает манифест и promptMeta для существующей сессии', async () => {
      const { app, sessionManager } = createTestApp(tmpDir);
      const session = await sessionManager.createSession({ title: 'S', userId: 'local' });

      const res = await app.request(`/api/v2/sessions/${session.id}/prompt`);

      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.manifest).toBeTruthy();
      expect(body.manifest.totalChars).toBe(10);
      expect(body.history).toBeTruthy();
      expect(body.history.messages.count).toBe(2);
      expect(body.history.stateMessages[0].type).toBe('mode_change');
      expect(body.history.excluded.info).toBe(1);
      expect(body.promptState).toBeNull();
      expect(body.lastPromptMeta).toBeNull();
    });

    it('возвращает 404 для отсутствующей сессии', async () => {
      const { app } = createTestApp(tmpDir);
      const res = await app.request('/api/v2/sessions/non-existent/prompt');
      expect(res.status).toBe(404);
      const body: any = await res.json();
      expect(body.error.code).toBe('NOT_FOUND');
    });
  });

  describe('GET /api/v2/sessions/:id/messages — QC-поля (ADR-034)', () => {
    it('отдаёт персистентные qa_pass/qa_reason сообщения', async () => {
      const { app, sessionManager } = createTestApp(tmpDir);
      const session = await sessionManager.createSession({ title: 'S', userId: 'local' });
      await sessionManager.addMessage(session.id, {
        id: generateId(), role: MessageRole.ASSISTANT, seq: 0, origin: 'local',
        parts: [makeTextPart('answer')], content: 'answer', createdAt: nowISO(),
        disabled: false, pinned: false, hidden: false,
        qa_pass: true, qa_reason: 'qc.all_passed',
      });

      const res = await app.request(`/api/v2/sessions/${session.id}/messages`);

      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.session_id).toBe(session.id);
      expect(body.messages[0].qa_pass).toBe(true);
      expect(body.messages[0].qa_reason).toBe('qc.all_passed');
    });

    it('legacy-сообщение без QC-полей не содержит ключей (бейдж не появляется)', async () => {
      const { app, sessionManager } = createTestApp(tmpDir);
      const session = await sessionManager.createSession({ title: 'S', userId: 'local' });
      await sessionManager.addMessage(session.id, {
        id: generateId(), role: MessageRole.ASSISTANT, seq: 0, origin: 'local',
        parts: [makeTextPart('legacy')], content: 'legacy', createdAt: nowISO(),
        disabled: false, pinned: false, hidden: false,
      });

      const res = await app.request(`/api/v2/sessions/${session.id}/messages`);

      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect('qa_pass' in body.messages[0]).toBe(false);
      expect('qa_reason' in body.messages[0]).toBe(false);
    });
  });

  describe('POST /api/v2/sessions — агент по умолчанию', () => {
    it('без settings.agentRole берёт значение из resolveDefaultAgent', async () => {
      const { app, sessionManager } = createTestApp(tmpDir, undefined, { resolveDefaultAgent: () => 'analyst' });
      const res = await app.request('/api/v2/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'S' }),
      });
      expect(res.status).toBe(201);
      const body: any = await res.json();
      const stored = await sessionManager.getSession(body.id);
      expect(stored?.settings.agentRole).toBe('analyst');
    });

    it('явный settings.agentRole приоритетнее resolveDefaultAgent', async () => {
      const { app, sessionManager } = createTestApp(tmpDir, undefined, { resolveDefaultAgent: () => 'analyst' });
      const res = await app.request('/api/v2/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'S', settings: { agentRole: 'developer' } }),
      });
      expect(res.status).toBe(201);
      const body: any = await res.json();
      const stored = await sessionManager.getSession(body.id);
      expect(stored?.settings.agentRole).toBe('developer');
    });

    it('без resolveDefaultAgent использует DEFAULT_AGENT_ID', async () => {
      const { app, sessionManager } = createTestApp(tmpDir);
      const res = await app.request('/api/v2/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'S' }),
      });
      expect(res.status).toBe(201);
      const body: any = await res.json();
      const stored = await sessionManager.getSession(body.id);
      expect(stored?.settings.agentRole).toBe(DEFAULT_AGENT_ID);
    });
  });

  describe('GET /api/v2/sessions/:id/stats (ADR-070 §2.6)', () => {
    it('возвращает агрегацию по агентам и пользователям', async () => {
      const profilesStore = new FileProfileStore({ dataDir: tmpDir });
      await profilesStore.getOrCreateProfile({ username: 'local' });
      const profile = (await profilesStore.getProfileByUsername('local'))!;
      await profilesStore.saveProfile({ ...profile, displayName: 'Local Dev' });

      const { app, sessionManager } = createTestApp(tmpDir, profilesStore);
      const session = await sessionManager.createSession({ title: 'S', userId: 'local' });
      await sessionManager.addMessage(session.id, {
        id: generateId(), role: MessageRole.USER, seq: 0, origin: 'local',
        parts: [makeTextPart('hi')], content: 'hi', createdAt: nowISO(),
        disabled: false, pinned: false, hidden: false, author: 'local',
      });
      await sessionManager.addMessage(session.id, {
        id: generateId(), role: MessageRole.ASSISTANT, seq: 0, origin: 'local',
        parts: [makeTextPart('ok')], content: 'ok', createdAt: nowISO(),
        disabled: false, pinned: false, hidden: false, agentRole: 'developer',
        model: 'm', usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
        metadata: { duration_ms: 1000 },
      });

      const res = await app.request(`/api/v2/sessions/${session.id}/stats`);

      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.session_id).toBe(session.id);
      expect(Array.isArray(body.agents)).toBe(true);
      expect(Array.isArray(body.users)).toBe(true);
      const dev = body.agents.find((a: any) => a.agent_role === 'developer');
      expect(dev).toBeTruthy();
      expect(dev.messages).toBe(1);
      expect(dev.input_tokens).toBe(100);
      expect(dev.output_tps).toBe(10);
      const local = body.users.find((u: any) => u.author === 'local');
      expect(local).toBeTruthy();
      expect(local.messages).toBe(1);
      expect(local.display_name).toBe('Local Dev');
    });

    it('возвращает 404 для отсутствующей сессии', async () => {
      const { app } = createTestApp(tmpDir);
      const res = await app.request('/api/v2/sessions/non-existent/stats');
      expect(res.status).toBe(404);
      const body: any = await res.json();
      expect(body.error.code).toBe('NOT_FOUND');
    });

    it('fallback на username при пустом displayName', async () => {
      const profilesStore = new FileProfileStore({ dataDir: tmpDir });
      await profilesStore.getOrCreateProfile({ username: 'local' });
      const profile = (await profilesStore.getProfileByUsername('local'))!;
      await profilesStore.saveProfile({ ...profile, displayName: '' });

      const { app, sessionManager } = createTestApp(tmpDir, profilesStore);
      const session = await sessionManager.createSession({ title: 'S', userId: 'local' });
      await sessionManager.addMessage(session.id, {
        id: generateId(), role: MessageRole.USER, seq: 0, origin: 'local',
        parts: [makeTextPart('hi')], content: 'hi', createdAt: nowISO(),
        disabled: false, pinned: false, hidden: false, author: 'local',
      });

      const res = await app.request(`/api/v2/sessions/${session.id}/stats`);
      const body: any = await res.json();
      expect(body.users.find((u: any) => u.author === 'local').display_name).toBe('local');
    });
  });
});

describe('Session API Routes (icon/color)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-session-meta-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('POST сохраняет валидные icon/color и отдаёт их в DTO', async () => {
    const { app, sessionManager } = createTestApp(tmpDir);
    const res = await app.request('/api/v2/sessions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'S', icon: 'rocket', color: 'a11' }),
    });
    expect(res.status).toBe(201);
    const body: any = await res.json();
    expect(body.icon).toBe('rocket');
    expect(body.color).toBe('a11');
    const stored = await sessionManager.getSession(body.id);
    expect(stored?.icon).toBe('rocket');
    expect(stored?.color).toBe('a11');
  });

  it('POST невалидный icon → 400 VALIDATION_ERROR с перечнем ключей', async () => {
    const { app } = createTestApp(tmpDir);
    const res = await app.request('/api/v2/sessions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'S', icon: '🚀' }),
    });
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toContain('code');
  });

  it('PATCH обновляет icon/color', async () => {
    const { app, sessionManager } = createTestApp(tmpDir);
    const session = await sessionManager.createSession({ title: 'S', userId: 'local' });
    const res = await app.request(`/api/v2/sessions/${session.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ icon: 'heart', color: 'a1' }),
    });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.icon).toBe('heart');
    expect(body.color).toBe('a1');
    const reloaded = await sessionManager.getSession(session.id);
    expect(reloaded?.icon).toBe('heart');
    expect(reloaded?.color).toBe('a1');
  });

  it('PATCH невалидный color (алиас red при записи не принимается) → 400, значение не меняется', async () => {
    const { app, sessionManager } = createTestApp(tmpDir);
    const session = await sessionManager.createSession({ title: 'S', userId: 'local', color: 'a11' });
    const res = await app.request(`/api/v2/sessions/${session.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ color: 'red' }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
    expect((await sessionManager.getSession(session.id))?.color).toBe('a11');
  });

  it('PATCH null сбрасывает icon/color', async () => {
    const { app, sessionManager } = createTestApp(tmpDir);
    const session = await sessionManager.createSession({
      title: 'S', userId: 'local', icon: 'rocket', color: 'a7',
    });
    const res = await app.request(`/api/v2/sessions/${session.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ icon: null, color: null }),
    });
    expect(res.status).toBe(200);
    const reloaded = await sessionManager.getSession(session.id);
    expect(reloaded?.icon).toBeUndefined();
    expect(reloaded?.color).toBeUndefined();
    const body: any = await res.json();
    expect(body.icon).toBeNull();
    expect(body.color).toBeNull();
  });

  it('GET отдаёт null для сессии без icon/color', async () => {
    const { app, sessionManager } = createTestApp(tmpDir);
    const session = await sessionManager.createSession({ title: 'S', userId: 'local' });
    const res = await app.request(`/api/v2/sessions/${session.id}`);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.icon).toBeNull();
    expect(body.color).toBeNull();
  });
});

describe('POST /api/v2/sessions — ADR-089 funnel', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-session-funnel-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('при заданном funnel вызывает request с ожидаемым SessionRequest', async () => {
    const created = await new SessionManager(new FileStore({ dataDir: tmpDir }))
      .createSession({ title: 'Funnel session', userId: 'local' });
    const request = vi.fn().mockResolvedValue(created);
    const { app } = createTestApp(tmpDir, undefined, undefined, { request });

    const res = await app.request('/api/v2/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Funnel session',
        project_id: 'proj-x',
        icon: 'rocket',
        color: 'a1',
        session_origin: 'subagent',
        parent_id: 'parent-1',
      }),
    });

    expect(res.status).toBe(201);
    const body: any = await res.json();
    expect(body.id).toBe(created.id);
    expect(request).toHaveBeenCalledOnce();
    const [reqArg, optsArg] = request.mock.calls[0]!;
    expect(reqArg).toMatchObject({
      initiator: 'user',
      intent: 'explicit',
      title: 'Funnel session',
      projectId: 'proj-x',
      icon: 'rocket',
      color: 'a1',
      sessionOrigin: 'subagent',
      parentId: 'parent-1',
    });
    expect(optsArg).toEqual({ userId: 'local' });
  });

  it('без funnel создаёт сессию напрямую и сохраняет sessionOrigin (fallback)', async () => {
    const { app, sessionManager } = createTestApp(tmpDir);
    const res = await app.request('/api/v2/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Fallback', session_origin: 'subagent' }),
    });
    expect(res.status).toBe(201);
    const body: any = await res.json();
    const stored = await sessionManager.getSession(body.id);
    expect(stored?.title).toBe('Fallback');
    expect(stored?.sessionOrigin).toBe('subagent');
  });
});

describe('GET /api/v2/sessions — фильтр project_id', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-session-project-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('?project_id=<local> возвращает только сессии этого проекта', async () => {
    const { app, sessionManager } = createTestApp(tmpDir);
    await sessionManager.createSession({ title: 'A', userId: 'local', projectId: 'proj-1' });
    await sessionManager.createSession({ title: 'B', userId: 'local', projectId: 'proj-2' });
    await sessionManager.createSession({ title: 'C', userId: 'local' });

    const res = await app.request('/api/v2/sessions?project_id=proj-1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as any[];
    expect(body).toHaveLength(1);
    expect(body[0].project_id).toBe('proj-1');
  });

  it('без project_id возвращает все сессии', async () => {
    const { app, sessionManager } = createTestApp(tmpDir);
    await sessionManager.createSession({ title: 'A', userId: 'local', projectId: 'proj-1' });
    await sessionManager.createSession({ title: 'B', userId: 'local', projectId: 'proj-2' });
    await sessionManager.createSession({ title: 'C', userId: 'local' });

    const res = await app.request('/api/v2/sessions');
    expect(res.status).toBe(200);
    const body = (await res.json()) as any[];
    expect(body).toHaveLength(3);
  });

  it('?project_id=<несуществующий> возвращает пустой список', async () => {
    const { app, sessionManager } = createTestApp(tmpDir);
    await sessionManager.createSession({ title: 'A', userId: 'local', projectId: 'proj-1' });

    const res = await app.request('/api/v2/sessions?project_id=missing');
    expect(res.status).toBe(200);
    const body = (await res.json()) as any[];
    expect(body).toHaveLength(0);
  });

  it('remote:-ref не фильтруется локально (без remote-клиента)', async () => {
    const { app, sessionManager } = createTestApp(tmpDir);
    await sessionManager.createSession({ title: 'A', userId: 'local', projectId: 'proj-1' });
    await sessionManager.createSession({ title: 'B', userId: 'local' });

    const res = await app.request('/api/v2/sessions?project_id=remote:abc');
    expect(res.status).toBe(200);
    const body = (await res.json()) as any[];
    expect(body).toHaveLength(2);
  });
});

describe('GET /api/v2/sessions — видимость по ролям/проектам (ADR-089)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-session-visibility-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  /** Приложение с RBAC-хуками: роль из заголовка, проекты-участия — из store. */
  function makeApp(opts: {
    userId: string;
    elevated?: boolean;
  }) {
    const app = new Hono();
    const fileStore = new FileStore({ dataDir: tmpDir });
    const sessionManager = new SessionManager(fileStore);
    const projectStore = new ProjectStore({ dataDir: tmpDir });
    const orchestrator = createMockOrchestrator();
    const routes = createSessionRoutes(
      createMockAuth(),
      {
        sessionManager,
        eventBus: new EventBus(),
        queueManager: createMockQueueManager() as any,
        processMessage: orchestrator.createProcessMessage(),
        orchestrator: orchestrator as any,
        projectStore,
      },
      {
        resolveUserId: () => opts.userId,
        resolveElevated: () => opts.elevated ?? false,
        resolveMemberProjectIds: async () => (await projectStore.list(opts.userId)).map((p) => p.id),
        resolveCanAccessExtra: async (session) => {
          if (!session.projectId) return false;
          const project = await projectStore.load(session.projectId);
          if (!project) return false;
          return project.ownerId === opts.userId || opts.userId in (project.members ?? {});
        },
      },
    );
    app.route('/api/v2/sessions', routes);
    return { app, sessionManager, projectStore };
  }

  it('член проекта видит проектные сессии, но не чужие личные', async () => {
    const { app, sessionManager, projectStore } = makeApp({ userId: 'member' });
    const project = projectStore.create('P1', 'owner');
    project.members['member'] = ProjectRole.VIEWER;
    await projectStore.save(project);

    await sessionManager.createSession({ title: 'mine', userId: 'member' });
    await sessionManager.createSession({ title: 'project', userId: 'owner', projectId: project.id });
    await sessionManager.createSession({ title: 'foreign', userId: 'stranger' });

    const res = await app.request('/api/v2/sessions');
    expect(res.status).toBe(200);
    const body = (await res.json()) as any[];
    expect(body.map((s) => s.name).sort()).toEqual(['mine', 'project']);
  });

  it('elevated (ADMIN/LEAD) видит все сессии', async () => {
    const { app, sessionManager } = makeApp({ userId: 'lead', elevated: true });
    await sessionManager.createSession({ title: 'a', userId: 'u1' });
    await sessionManager.createSession({ title: 'b', userId: 'u2' });

    const res = await app.request('/api/v2/sessions');
    const body = (await res.json()) as any[];
    expect(body).toHaveLength(2);
  });

  it('elevated повышает приоритет над projectIds (все сессии)', async () => {
    const { app, sessionManager, projectStore } = makeApp({ userId: 'lead', elevated: true });
    const project = projectStore.create('P', 'lead');
    await projectStore.save(project);
    await sessionManager.createSession({ title: 'foreign', userId: 'u2' });
    const res = await app.request('/api/v2/sessions');
    expect((await res.json() as any[])).toHaveLength(1);
  });

  it('?project_id= фильтрует поверх проектной видимости', async () => {
    const { app, sessionManager, projectStore } = makeApp({ userId: 'member' });
    const p1 = projectStore.create('P1', 'member');
    const p2 = projectStore.create('P2', 'member');
    await projectStore.save(p1);
    await projectStore.save(p2);
    await sessionManager.createSession({ title: 's1', userId: 'member', projectId: p1.id });
    await sessionManager.createSession({ title: 's2', userId: 'member', projectId: p2.id });

    const res = await app.request(`/api/v2/sessions?project_id=${p1.id}`);
    const body = (await res.json()) as any[];
    expect(body).toHaveLength(1);
    expect(body[0].name).toBe('s1');
  });

  it('участник проекта получает доступ к её сессии по id (resolveCanAccessExtra)', async () => {
    const { app, sessionManager, projectStore } = makeApp({ userId: 'member' });
    const project = projectStore.create('P1', 'owner');
    project.members['member'] = 'viewer' as any;
    await projectStore.save(project);
    const session = await sessionManager.createSession({ title: 'shared', userId: 'owner', projectId: project.id });

    const res = await app.request(`/api/v2/sessions/${session.id}/status`);
    expect(res.status).toBe(200);
  });

  it('посторонний не получает доступ к сессии чужого проекта по id → 403', async () => {
    const { app, sessionManager, projectStore } = makeApp({ userId: 'outsider' });
    const project = projectStore.create('P1', 'owner');
    await projectStore.save(project);
    const session = await sessionManager.createSession({ title: 'shared', userId: 'owner', projectId: project.id });

    const res = await app.request(`/api/v2/sessions/${session.id}/status`);
    expect(res.status).toBe(403);
  });
});

describe('POST /api/v2/sessions/:id/abort — персистентный флаг отмены', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-session-abort-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeApp() {
    const app = new Hono();
    const fileStore = new FileStore({ dataDir: tmpDir });
    const sessionManager = new SessionManager(fileStore);
    const orchestrator = createMockOrchestrator();
    const queueManager = createMockQueueManager();
    const routes = createSessionRoutes(
      createMockAuth(),
      {
        sessionManager,
        eventBus: new EventBus(),
        queueManager: queueManager as any,
        processMessage: orchestrator.createProcessMessage(),
        orchestrator: orchestrator as any,
      },
    );
    app.route('/api/v2/sessions', routes);
    return { app, sessionManager, orchestrator, queueManager };
  }

  it('несуществующая сессия → 404', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/v2/sessions/missing/abort', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('ставит флаг, отменяет активный стрим и просит остановку процессора', async () => {
    const { app, sessionManager, orchestrator, queueManager } = makeApp();
    queueManager.requestStop.mockReturnValue(true);
    const session = await sessionManager.createSession({ title: 'S', userId: 'local' });
    session.currentStream = {
      streamId: 'st1',
      message: '',
      startedAt: nowISO(),
      cancelled: false,
    };
    session.status.blocked = session.id;
    session.status.blockedAt = nowISO();
    await sessionManager.updateSession(session);

    const res = await app.request(`/api/v2/sessions/${session.id}/abort`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'aborted' });

    const s = await sessionManager.getSession(session.id);
    expect(s!.status.cancelRequested).toBe(true);
    expect(typeof s!.status.cancelRequestedAt).toBe('string');
    expect(orchestrator.cancel).toHaveBeenCalledWith('st1');
    expect(queueManager.requestStop).toHaveBeenCalledWith(session.id);
  });

  it('нет запущенного процессора — флаг не оставляем (следующий запуск не отменится)', async () => {
    const { app, sessionManager, queueManager } = makeApp();
    queueManager.requestStop.mockReturnValue(false);
    const session = await sessionManager.createSession({ title: 'S', userId: 'local' });

    const res = await app.request(`/api/v2/sessions/${session.id}/abort`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'aborted' });

    const s = await sessionManager.getSession(session.id);
    expect(s!.status.cancelRequested).toBeUndefined();
    expect(s!.status.cancelRequestedAt).toBeUndefined();
  });
});

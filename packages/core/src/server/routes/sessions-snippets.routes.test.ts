/**
 * PROP-126 §4: раскрытие `#`-сниппетов в приёме промпта (`POST
 * /api/v2/sessions/:id/prompt`) — до очереди и до LLM.
 *
 * Проверяется:
 *   • instance-сниппет раскрывается в тексте пользовательской реплики;
 *   • code-блок (` ``` #foo ``` `) не раскрывается — общий лексер
 *     `engine/input-surface/parser.ts` отсекает токены в коде;
 *   • `/`-команда не раскрывается (сниппет — не скрытый канал инъекции в
 *     шаблоны команд);
 *   • неизвестный `#token` остаётся текстом;
 *   • user-уровень изолирован по `userId`: свой сниппет раскрывается, чужой —
 *     нет.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionRoutes } from './sessions.js';
import { SessionManager, EventBus, FileStore } from '../../index.js';
import type { QueueProcessorManager, ChatOrchestrator } from '../../index.js';
import { ProjectStore } from '../../storage/project-store.js';
import { SnippetService } from '../../engine/snippets/service.js';
import type { AuthKit } from '../../auth/local.js';

function createMockAuth(): AuthKit {
  return {
    getCurrentUser: () => null,
    requireAuth: async (_c: Context, next: Next) => { await next(); },
  } as unknown as AuthKit;
}

/** Мок менеджера очереди: сообщение остаётся в `pendingMessages`. */
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
    // ADR-036: обфускация не меняет текст (в тесте секретов нет).
    obfuscateUserMessageForHistory: vi.fn(async (_sid: string, message: unknown) => message),
    getPromptInfo: vi.fn().mockResolvedValue({
      manifest: { totalChars: 10, estTokens: 3, stablePrefixChars: 5, entries: [] },
      history: {
        messages: { count: 0, chars: 0, estTokens: 0 },
        stateMessages: [],
        excluded: { disabled: 0, hidden: 0, info: 0 },
        attachments: { count: 0, chars: 0 },
        secretPlaceholders: 0,
      },
      promptState: null,
      lastPromptMeta: null,
    }),
    getModelPricing: vi.fn().mockReturnValue(null),
  };
}

describe('POST /api/v2/sessions/:id/prompt — раскрытие сниппетов (PROP-126 §4)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-session-snippets-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function createTestApp(opts?: { userId?: string; trustedProjectDirs?: string[] }) {
    const app = new Hono();
    const fileStore = new FileStore({ dataDir: tmpDir });
    const sessionManager = new SessionManager(fileStore);
    const projectStore = new ProjectStore({ dataDir: tmpDir });
    const eventBus = new EventBus();
    const queueManager = createMockQueueManager();
    const orchestrator = createMockOrchestrator();
    const snippetService = new SnippetService({
      dataDir: tmpDir,
      ...(opts?.trustedProjectDirs ? { trustedProjectDirs: opts.trustedProjectDirs } : {}),
    });

    const sessionRoutes = createSessionRoutes(
      createMockAuth(),
      {
        sessionManager,
        eventBus,
        queueManager: queueManager as unknown as QueueProcessorManager,
        processMessage: orchestrator.createProcessMessage(),
        orchestrator: orchestrator as unknown as ChatOrchestrator,
        projectStore,
        snippetService,
      },
      {
        ...(opts?.userId ? { resolveUserId: () => opts.userId as string } : {}),
        // Владелец сессии — пользователь запроса (как в managed).
        ...(opts?.userId
          ? { canAccess: (session: { ownerId?: string; userId?: string }, _c: Context, userId: string) =>
              (session.ownerId ?? session.userId) === userId }
          : {}),
      },
    );

    app.route('/api/v2/sessions', sessionRoutes);
    return { app, sessionManager, projectStore, snippetService };
  }

  /** Отправить промпт и вернуть текст поставленного в очередь сообщения. */
  async function prompt(
    app: Hono,
    sessionManager: SessionManager,
    sessionId: string,
    content: string,
  ): Promise<{ status: number; text: string; metadata?: Record<string, unknown> }> {
    const res = await app.request(`/api/v2/sessions/${sessionId}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    const fresh = (await sessionManager.getSession(sessionId))!;
    const queued = fresh.pendingMessages[0];
    return {
      status: res.status,
      text: queued?.content ?? '',
      metadata: queued?.metadata,
    };
  }

  it('instance-сниппет раскрывается: в очередь уходит раскрытый текст', async () => {
    const { app, sessionManager, snippetService } = createTestApp();
    await snippetService.create({
      name: 'foo',
      body: 'ТЕЛО СНИППЕТА',
      scope: 'instance',
    });
    const session = await sessionManager.createSession({ title: 'P', userId: 'local' });

    const result = await prompt(app, sessionManager, session.id, 'проверь #foo и всё');

    expect(result.status).toBe(202);
    // Исходный текст в очередь не уходит — только раскрытый.
    expect(result.text).toBe('проверь ТЕЛО СНИППЕТА и всё');
    expect(result.text).not.toContain('#foo');
    // Раскрытые сниппеты — в метаданных сообщения (аддитивно, для диагностики).
    expect(result.metadata?.snippetExpansions).toEqual(['foo']);
  });

  it('code-блок не раскрывается: `#foo` внутри fence остаётся текстом', async () => {
    const { app, sessionManager, snippetService } = createTestApp();
    await snippetService.create({ name: 'foo', body: 'ТЕЛО СНИППЕТА', scope: 'instance' });
    const session = await sessionManager.createSession({ title: 'P', userId: 'local' });

    const result = await prompt(app, sessionManager, session.id, '```\n#foo\n```');

    expect(result.status).toBe(202);
    expect(result.text).toBe('```\n#foo\n```');
    expect(result.metadata?.snippetExpansions).toBeUndefined();
  });

  it('`/`-команда не раскрывается (сниппет — не канал инъекции в шаблоны)', async () => {
    const { app, sessionManager, snippetService } = createTestApp();
    await snippetService.create({ name: 'foo', body: 'ТЕЛО СНИППЕТА', scope: 'instance' });
    const session = await sessionManager.createSession({ title: 'P', userId: 'local' });

    const result = await prompt(app, sessionManager, session.id, '/plan #foo');

    expect(result.status).toBe(202);
    expect(result.text).toBe('/plan #foo');
    expect(result.metadata?.snippetExpansions).toBeUndefined();
  });

  it('неизвестный `#token` остаётся текстом', async () => {
    const { app, sessionManager } = createTestApp();
    const session = await sessionManager.createSession({ title: 'P', userId: 'local' });

    const result = await prompt(app, sessionManager, session.id, 'спроси #nope');

    expect(result.status).toBe(202);
    expect(result.text).toBe('спроси #nope');
    expect(result.metadata?.snippetExpansions).toBeUndefined();
  });

  it('user-уровень: свой сниппет раскрывается, чужой — нет', async () => {
    const { app, sessionManager, snippetService } = createTestApp({ userId: 'user-1' });
    // Сниппет в каталоге пользователя (`{dataDir}/snippets/users/<uid>/`).
    await snippetService.create({
      name: 'mine',
      body: 'МОЙ СНИППЕТ',
      scope: 'user',
      userId: 'user-1',
    });
    const session = await sessionManager.createSession({ title: 'P', userId: 'user-1', ownerId: 'user-1' });

    const own = await prompt(app, sessionManager, session.id, 'возьми #mine');
    expect(own.status).toBe(202);
    expect(own.text).toBe('возьми МОЙ СНИППЕТ');

    // Чужой пользователь свой сниппет не видит: `#mine` остаётся текстом.
    const other = createTestApp({ userId: 'user-2' });
    const otherSession = await other.sessionManager.createSession({ title: 'P', userId: 'user-2', ownerId: 'user-2' });
    const foreign = await prompt(other.app, other.sessionManager, otherSession.id, 'возьми #mine');
    expect(foreign.status).toBe(202);
    expect(foreign.text).toBe('возьми #mine');
    expect(foreign.metadata?.snippetExpansions).toBeUndefined();
  });

  it('project-уровень: сниппет доверенного проекта раскрывается', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'synth-session-snippets-ws-'));
    try {
      const { app, sessionManager, projectStore, snippetService } = createTestApp({
        trustedProjectDirs: [workspace],
      });
      const project = projectStore.create('P', 'local', { workspace });
      await projectStore.save(project);
      await snippetService.create({
        name: 'proj',
        body: 'ПРОЕКТНЫЙ СНИППЕТ',
        scope: 'project',
        projectWorkspace: workspace,
      });
      const session = await sessionManager.createSession({
        title: 'P',
        userId: 'local',
        projectId: project.id,
      });

      const result = await prompt(app, sessionManager, session.id, 'сделай #proj');
      expect(result.status).toBe(202);
      expect(result.text).toBe('сделай ПРОЕКТНЫЙ СНИППЕТ');
      expect(result.metadata?.snippetExpansions).toEqual(['proj']);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

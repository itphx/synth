/**
 * ADR-111 §detach: блокирующие (foreground) прогоны в HTTP-контуре
 * `/api/v2/processes` — `include=blocking`, остановка и чтение live-лога.
 *
 * Проверяется: аддитивность ответа (без `include` он не меняется), 400 на
 * неверный `include`, граничный guard (200/403/404/409) и то, что статические
 * `/blocking/...` роуты не перехватываются параметрическими `/:id/...`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProcessRoutes, toBlockingRunDto } from './processes.js';
import type { BlockingRunDto } from './processes.js';
import { BackgroundRunService } from '../../engine/background/service.js';
import { ProcessService } from '../../engine/processes/service.js';
import { EventBus } from '../../events/bus.js';
import { FileBlobStore } from '../../storage/file-blob-store.js';
import { MemoryBackgroundRunRepository } from '../../storage/memory/background-runs.js';
import { FileStore } from '../../storage/file-store.js';
import { SessionManager } from '../../sessions/manager.js';
import type { ExecutionPort } from '../../execution/ports/index.js';
import type { SessionAccessKind } from '../session-access-guard.js';
import type { ActiveRunHandle } from '../../engine/background/active-runs.js';

/** Мок auth: requireAuth — no-op (single-user режим core). */
function createMockAuth() {
  return {
    getCurrentUser: () => null,
    requireAuth: async (_c: Context, next: Next) => {
      await next();
    },
  };
}

/** Блокирующий прогон для тестов. */
function blockingRun(overrides: Partial<BlockingRunDto> = {}): BlockingRunDto {
  return {
    id: 'blk-1',
    kind: 'process',
    sessionId: 'session-1',
    startedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

interface HarnessOptions {
  /** Правило доступа (по умолчанию — доступ ко всем сессиям). */
  isAllowed?: (sessionId: string, access: SessionAccessKind) => boolean;
  /** `stopBlocking` всегда отвечает «остановить нельзя» (409). */
  stopRefused?: boolean;
}

describe('HTTP: блокирующие прогоны (ADR-111 §detach)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-processes-blocking-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function createHarness(options: HarnessOptions = {}) {
    const app = new Hono();
    const backgroundRuns = new MemoryBackgroundRunRepository();
    const eventBus = new EventBus();
    let counter = 0;
    const background = new BackgroundRunService({
      repository: backgroundRuns,
      eventBus,
      limits: {
        maxSubagentsPerSession: 5,
        maxProcessesPerSession: 5,
        maxRunsPerSession: 20,
      },
      generateId: () => `id-${++counter}`,
    });
    const blobs = new FileBlobStore({ root: join(tmpDir, 'blobs') });
    const processes = new ProcessService({
      executionPort: {} as unknown as ExecutionPort,
      background,
      blobs,
      eventBus,
      limits: { maxLogBytes: 1024 * 1024 },
    });
    const sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));

    /** Снимок «живого» реестра активных прогонов (подменяется тестом). */
    let snapshot: BlockingRunDto[] = [];
    const stopped: string[] = [];

    app.route(
      '/api/v2/processes',
      createProcessRoutes(
        createMockAuth(),
        {
          backgroundRuns,
          background,
          processes,
          sessionManager,
          getBlocking: (sessionIds) => snapshot.filter((run) => sessionIds.includes(run.sessionId)),
          stopBlocking: async (sessionIds, id) => {
            const run = snapshot.find((r) => r.id === id && sessionIds.includes(r.sessionId));
            if (!run) return false;
            if (options.stopRefused) return false;
            stopped.push(id);
            return true;
          },
          readBlockingLog: async (sessionIds, id) => {
            const run = snapshot.find((r) => r.id === id && sessionIds.includes(r.sessionId));
            if (!run) return null;
            if (!run.logPath) return null;
            return { output: 'hello', truncated: false, logPath: run.logPath, size: 5 };
          },
        },
        {
          resolveUserId: () => 'owner',
          isAllowed: async (session, _c, _userId, access) =>
            options.isAllowed ? options.isAllowed(session.id, access) : true,
        },
      ),
    );

    /** Задать снимок блокирующих прогонов (живой реестр оркестратора). */
    const setSnapshot = (runs: BlockingRunDto[]): void => {
      snapshot = runs;
    };

    return { app, backgroundRuns, sessionManager, setSnapshot, stopped };
  }

  /** Создать сессию (владелец — `owner`). */
  async function createSession(
    sessionManager: SessionManager,
    id: string,
    ownerId = 'owner',
  ): Promise<string> {
    const session = await sessionManager.createSession({
      title: id,
      userId: ownerId,
      ownerId,
    });
    await sessionManager.saveSession({ ...session, id });
    return id;
  }

  describe('include=blocking', () => {
    it('добавляет массив блокирующих прогонов видимых сессий', async () => {
      const { app, sessionManager, setSnapshot } = createHarness();
      await createSession(sessionManager, 'session-1');
      setSnapshot([
        blockingRun(),
        blockingRun({ id: 'blk-2', kind: 'subagent', childSessionId: 'child-1', sessionId: 'session-2' }),
      ]);

      const res = await app.request('/api/v2/processes?include=blocking');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { runs: unknown[]; blocking: BlockingRunDto[] };
      expect(body.runs).toEqual([]);
      // Прогон невидимой сессии (`session-2` не создана) не попадает в выдачу.
      expect(body.blocking.map((run) => run.id)).toEqual(['blk-1']);
    });

    it('без include ответ не меняется (только runs)', async () => {
      const { app, sessionManager, setSnapshot } = createHarness();
      await createSession(sessionManager, 'session-1');
      setSnapshot([blockingRun()]);

      const res = await app.request('/api/v2/processes');
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(Object.keys(body)).toEqual(['runs']);
      expect(body.blocking).toBeUndefined();
    });

    it('неверный include → 400 VALIDATION_ERROR', async () => {
      const { app } = createHarness();
      const res = await app.request('/api/v2/processes?include=everything');
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('скоуп sessionId сужает видимые сессии', async () => {
      const { app, sessionManager, setSnapshot } = createHarness();
      await createSession(sessionManager, 'session-1');
      await createSession(sessionManager, 'session-2');
      setSnapshot([blockingRun(), blockingRun({ id: 'blk-2', sessionId: 'session-2' })]);

      const res = await app.request('/api/v2/processes?include=blocking&sessionId=session-2');
      const body = (await res.json()) as { blocking: BlockingRunDto[] };
      expect(body.blocking.map((run) => run.id)).toEqual(['blk-2']);
    });
  });

  describe('POST /blocking/:id/stop', () => {
    it('200 — прогон остановлен', async () => {
      const { app, sessionManager, setSnapshot, stopped } = createHarness();
      await createSession(sessionManager, 'session-1');
      setSnapshot([blockingRun()]);

      const res = await app.request('/api/v2/processes/blocking/blk-1/stop', { method: 'POST' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ stopped: true });
      expect(stopped).toEqual(['blk-1']);
    });

    it('404 — записи нет (в т.ч. чужой сессии)', async () => {
      const { app, sessionManager, setSnapshot } = createHarness();
      await createSession(sessionManager, 'session-1');
      setSnapshot([blockingRun({ id: 'blk-other', sessionId: 'session-2' })]);

      const res = await app.request('/api/v2/processes/blocking/blk-1/stop', { method: 'POST' });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('NOT_FOUND');
    });

    it('403 — прогон виден, но права на мутацию нет (VIEWER)', async () => {
      const { app, sessionManager, setSnapshot } = createHarness({
        isAllowed: (_sessionId, access) => access === 'read',
      });
      await createSession(sessionManager, 'session-1');
      setSnapshot([blockingRun()]);

      const res = await app.request('/api/v2/processes/blocking/blk-1/stop', { method: 'POST' });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('FORBIDDEN');
    });

    it('409 — хэндла остановки нет (stopBlocking вернул false)', async () => {
      const { app, sessionManager, setSnapshot } = createHarness({ stopRefused: true });
      await createSession(sessionManager, 'session-1');
      setSnapshot([blockingRun()]);

      const res = await app.request('/api/v2/processes/blocking/blk-1/stop', { method: 'POST' });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('CONFLICT');
    });
  });

  describe('GET /blocking/:id/logs', () => {
    it('200 — отрезок live-лога в форме `/:id/logs`', async () => {
      const { app, sessionManager, setSnapshot } = createHarness();
      await createSession(sessionManager, 'session-1');
      setSnapshot([blockingRun({ logPath: 'processes/live/blk-1.log' })]);

      const res = await app.request('/api/v2/processes/blocking/blk-1/logs');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        content: 'hello',
        offset: 0,
        nextOffset: 5,
        totalBytes: 5,
        truncated: false,
      });
    });

    it('404 — live-лога нет', async () => {
      const { app, sessionManager, setSnapshot } = createHarness();
      await createSession(sessionManager, 'session-1');
      setSnapshot([blockingRun()]);

      const res = await app.request('/api/v2/processes/blocking/blk-1/logs');
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('NOT_FOUND');
    });

    it('статические /blocking/... не перехватываются параметрическим /:id/logs', async () => {
      const { app, sessionManager, setSnapshot, backgroundRuns } = createHarness();
      await createSession(sessionManager, 'session-1');
      // Запись реестра с id `blocking`: если бы параметрический роут
      // регистрировался раньше, `/blocking/blk-1/logs` ушёл бы не туда.
      await backgroundRuns.save({
        id: 'blocking',
        kind: 'process',
        status: 'running',
        sessionId: 'session-1',
        startedAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });
      setSnapshot([blockingRun({ logPath: 'processes/live/blk-1.log' })]);

      const res = await app.request('/api/v2/processes/blocking/blk-1/logs');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { content: string };
      expect(body.content).toBe('hello');
    });
  });

  describe('toBlockingRunDto', () => {
    it('переносит аддитивные поля хэндла и форматирует дату в ISO', () => {
      const handle: ActiveRunHandle = {
        id: 'proc-1',
        kind: 'process',
        title: 'npm test',
        sessionId: 'session-1',
        processId: 'proc-1',
        logPath: 'processes/live/proc-1.log',
        startedAt: Date.parse('2026-01-01T00:00:00.000Z'),
        detach: () => {},
      };

      expect(toBlockingRunDto(handle)).toEqual({
        id: 'proc-1',
        kind: 'process',
        title: 'npm test',
        sessionId: 'session-1',
        processId: 'proc-1',
        logPath: 'processes/live/proc-1.log',
        startedAt: '2026-01-01T00:00:00.000Z',
      });
    });
  });
});

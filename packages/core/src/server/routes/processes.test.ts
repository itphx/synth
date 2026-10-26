/**
 * PROP-096/097: HTTP-контур единого реестра фоновых прогонов.
 *
 * Проверяется: фильтры и лимиты списка, фильтрация выдачи по доступу к
 * сессии-владельцу, деталь, чтение лога, остановка, удаление и — главное —
 * **граничный guard** (инвариант 16): доступ решается на границе, в
 * обработчиках проверок нет.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BackgroundRunRecord, BackgroundRunStatus } from '@itphx/synth-shared';
import { createProcessRoutes } from './processes.js';
import { BackgroundRunService } from '../../engine/background/service.js';
import { ProcessService } from '../../engine/processes/service.js';
import { EventBus } from '../../events/bus.js';
import { FileBlobStore } from '../../storage/file-blob-store.js';
import { MemoryBackgroundRunRepository } from '../../storage/memory/background-runs.js';
import { FileStore } from '../../storage/file-store.js';
import { SessionManager } from '../../sessions/manager.js';
import type { ExecutionPort } from '../../execution/ports/index.js';
import type { SessionAccessKind } from '../session-access-guard.js';

/** Мок auth: requireAuth — no-op (single-user режим core). */
function createMockAuth() {
  return {
    getCurrentUser: () => null,
    requireAuth: async (_c: Context, next: Next) => {
      await next();
    },
  };
}

/** Запись реестра для тестов. */
function run(
  id: string,
  overrides: Partial<BackgroundRunRecord> = {},
): BackgroundRunRecord {
  return {
    id,
    kind: 'process',
    status: 'running',
    sessionId: 'session-1',
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

interface HarnessOptions {
  /** Правило доступа (по умолчанию — доступ ко всем сессиям). */
  isAllowed?: (sessionId: string, access: SessionAccessKind) => boolean;
  /** userId запроса. */
  userId?: string;
}

describe('HTTP: реестр фоновых прогонов (PROP-096/097)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-processes-'));
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
      // Порт исполнения в чтении лога не участвует — фоновый запуск тут не
      // проверяется (его покрывают тесты подсистемы процессов).
      executionPort: {} as unknown as ExecutionPort,
      background,
      blobs,
      eventBus,
      limits: { maxLogBytes: 1024 * 1024 },
    });
    const sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));

    app.route(
      '/api/v2/processes',
      createProcessRoutes(
        createMockAuth(),
        { backgroundRuns, background, processes, sessionManager },
        {
          resolveUserId: () => options.userId ?? 'owner',
          isAllowed: async (session, _c, _userId, access) =>
            options.isAllowed ? options.isAllowed(session.id, access) : true,
        },
      ),
    );

    return { app, backgroundRuns, background, processes, blobs, sessionManager };
  }

  /** Создать сессию (владелец — `owner`). */
  async function createSession(
    sessionManager: SessionManager,
    id: string,
    ownerId = 'owner',
    projectId?: string,
  ): Promise<string> {
    const session = await sessionManager.createSession({
      title: id,
      userId: ownerId,
      ownerId,
      ...(projectId ? { projectId } : {}),
    });
    // Идентификатор сессии в тесте фиксирован (записи реестра ссылаются на него).
    await sessionManager.saveSession({ ...session, id });
    return id;
  }

  describe('список прогонов', () => {
    it('GET / — отдаёт записи реестра', async () => {
      const { app, backgroundRuns, sessionManager } = createHarness();
      await createSession(sessionManager, 'session-1');
      await backgroundRuns.save(run('bgr_1'));
      await backgroundRuns.save(run('bgr_2', { kind: 'subagent', status: 'completed' }));

      const res = await app.request('/api/v2/processes');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { runs: BackgroundRunRecord[] };
      expect(body.runs).toHaveLength(2);
      expect(body.runs.map((r) => r.id).sort()).toEqual(['bgr_1', 'bgr_2']);
    });

    it('GET / — фильтры sessionId/kind/status', async () => {
      const { app, backgroundRuns, sessionManager } = createHarness();
      await createSession(sessionManager, 'session-1');
      await createSession(sessionManager, 'session-2');
      await backgroundRuns.save(run('bgr_1'));
      await backgroundRuns.save(run('bgr_2', { sessionId: 'session-2' }));
      await backgroundRuns.save(run('bgr_3', { kind: 'subagent' }));
      await backgroundRuns.save(run('bgr_4', { status: 'completed' }));

      const bySession = await app.request('/api/v2/processes?sessionId=session-2');
      expect(((await bySession.json()) as { runs: BackgroundRunRecord[] }).runs.map((r) => r.id))
        .toEqual(['bgr_2']);

      const byKind = await app.request('/api/v2/processes?kind=subagent');
      expect(((await byKind.json()) as { runs: BackgroundRunRecord[] }).runs.map((r) => r.id))
        .toEqual(['bgr_3']);

      const byStatus = await app.request('/api/v2/processes?status=completed');
      expect(((await byStatus.json()) as { runs: BackgroundRunRecord[] }).runs.map((r) => r.id))
        .toEqual(['bgr_4']);
    });

    it('GET / — неверные kind/status → 400 VALIDATION_ERROR', async () => {
      const { app } = createHarness();
      const res = await app.request('/api/v2/processes?kind=unknown');
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
    });

    it('GET / — limit ограничен (максимум 200)', async () => {
      const { app, backgroundRuns, sessionManager } = createHarness();
      await createSession(sessionManager, 'session-1');
      for (let i = 0; i < 5; i += 1) {
        await backgroundRuns.save(run(`bgr_${i}`, { startedAt: `2026-01-0${i + 1}T00:00:00.000Z` }));
      }

      const res = await app.request('/api/v2/processes?limit=2');
      expect(((await res.json()) as { runs: BackgroundRunRecord[] }).runs).toHaveLength(2);

      const huge = await app.request('/api/v2/processes?limit=100000');
      expect(((await huge.json()) as { runs: BackgroundRunRecord[] }).runs).toHaveLength(5);
    });

    it('GET / — чужие сессии скрыты, сессии без записи — тоже', async () => {
      const { app, backgroundRuns, sessionManager } = createHarness({
        isAllowed: (sessionId) => sessionId === 'session-1',
      });
      await createSession(sessionManager, 'session-1');
      await createSession(sessionManager, 'session-2');
      await backgroundRuns.save(run('bgr_1', { sessionId: 'session-1' }));
      await backgroundRuns.save(run('bgr_2', { sessionId: 'session-2' }));
      // Сессия-владелец удалена — запись не показывается.
      await backgroundRuns.save(run('bgr_3', { sessionId: 'session-gone' }));

      const res = await app.request('/api/v2/processes');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { runs: BackgroundRunRecord[] };
      expect(body.runs.map((r) => r.id)).toEqual(['bgr_1']);
    });
  });

  describe('деталь прогона', () => {
    it('GET /:id — 200 с записью', async () => {
      const { app, backgroundRuns, sessionManager } = createHarness();
      await createSession(sessionManager, 'session-1');
      await backgroundRuns.save(run('bgr_1', { command: 'sleep 10' }));

      const res = await app.request('/api/v2/processes/bgr_1');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { run: BackgroundRunRecord };
      expect(body.run.id).toBe('bgr_1');
      expect(body.run.command).toBe('sleep 10');
    });

    it('GET /:id — 404, если записи нет', async () => {
      const { app } = createHarness();
      const res = await app.request('/api/v2/processes/bgr_missing');
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND');
    });

    it('GET /:id — 404, если сессия-владелец отсутствует', async () => {
      const { app, backgroundRuns } = createHarness();
      await backgroundRuns.save(run('bgr_1', { sessionId: 'session-gone' }));

      const res = await app.request('/api/v2/processes/bgr_1');
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND');
    });

    it('GET /:id — чужая сессия → 403 (guard, не обработчик)', async () => {
      const { app, backgroundRuns, sessionManager } = createHarness({
        isAllowed: () => false,
      });
      await createSession(sessionManager, 'session-1');
      await backgroundRuns.save(run('bgr_1'));

      const res = await app.request('/api/v2/processes/bgr_1');
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN');
    });
  });

  describe('лог фонового процесса', () => {
    it('GET /:id/logs — 200 с отрезком (offset/limit)', async () => {
      const { app, backgroundRuns, sessionManager, blobs } = createHarness();
      await createSession(sessionManager, 'session-1');
      await blobs.append('processes/bgr_1.log', 'hello world');
      await backgroundRuns.save(run('bgr_1', { logPath: 'processes/bgr_1.log' }));

      const res = await app.request('/api/v2/processes/bgr_1/logs?offset=6&limit=5');
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        content: string;
        offset: number;
        nextOffset: number;
        totalBytes: number;
      };
      expect(body.content).toBe('world');
      expect(body.offset).toBe(6);
      expect(body.nextOffset).toBe(11);
      expect(body.totalBytes).toBe(11);
    });

    it('GET /:id/logs — 400 для kind=subagent', async () => {
      const { app, backgroundRuns, sessionManager } = createHarness();
      await createSession(sessionManager, 'session-1');
      await backgroundRuns.save(run('bgr_1', { kind: 'subagent' }));

      const res = await app.request('/api/v2/processes/bgr_1/logs');
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
    });

    it('GET /:id/logs — 404, если файла лога нет', async () => {
      const { app, backgroundRuns, sessionManager } = createHarness();
      await createSession(sessionManager, 'session-1');
      // Запись без пути лога — файла нет.
      await backgroundRuns.save(run('bgr_1'));
      await backgroundRuns.save(run('bgr_2', { logPath: 'processes/missing.log' }));

      const noPath = await app.request('/api/v2/processes/bgr_1/logs');
      expect(noPath.status).toBe(404);
      expect(((await noPath.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND');

      const missingFile = await app.request('/api/v2/processes/bgr_2/logs');
      expect(missingFile.status).toBe(404);
    });
  });

  describe('остановка прогона', () => {
    it('POST /:id/stop — 200 {status: stopping}', async () => {
      const { app, backgroundRuns, sessionManager, background } = createHarness();
      await createSession(sessionManager, 'session-1');
      await backgroundRuns.save(run('bgr_1'));
      // Живой хэндл отмены есть только у прогона, начатого в этом процессе.
      background.registerAbort('bgr_1', () => undefined);

      const res = await app.request('/api/v2/processes/bgr_1/stop', { method: 'POST' });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { status: string }).status).toBe('stopping');
    });

    it('POST /:id/stop — 409 для терминального прогона', async () => {
      const { app, backgroundRuns, sessionManager } = createHarness();
      await createSession(sessionManager, 'session-1');
      await backgroundRuns.save(run('bgr_1', { status: 'completed' }));

      const res = await app.request('/api/v2/processes/bgr_1/stop', { method: 'POST' });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('CONFLICT');
    });

    it('POST /:id/stop — чужая сессия → 403 (write-доступ)', async () => {
      const { app, backgroundRuns, sessionManager } = createHarness({
        isAllowed: (_sessionId, access) => access === 'read',
      });
      await createSession(sessionManager, 'session-1');
      await backgroundRuns.save(run('bgr_1'));

      const res = await app.request('/api/v2/processes/bgr_1/stop', { method: 'POST' });
      expect(res.status).toBe(403);
    });
  });

  describe('удаление записи реестра', () => {
    it('DELETE /:id — 204 для терминального прогона', async () => {
      const { app, backgroundRuns, sessionManager } = createHarness();
      await createSession(sessionManager, 'session-1');
      await backgroundRuns.save(run('bgr_1', { status: 'failed' }));

      const res = await app.request('/api/v2/processes/bgr_1', { method: 'DELETE' });
      expect(res.status).toBe(204);
      expect(await backgroundRuns.get('bgr_1')).toBeNull();
    });

    it('DELETE /:id — 409 для идущего прогона', async () => {
      const { app, backgroundRuns, sessionManager } = createHarness();
      await createSession(sessionManager, 'session-1');
      await backgroundRuns.save(run('bgr_1', { status: 'running' }));

      const res = await app.request('/api/v2/processes/bgr_1', { method: 'DELETE' });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('CONFLICT');
      expect(await backgroundRuns.get('bgr_1')).not.toBeNull();
    });

    it('DELETE /:id — 404, если записи нет (в обработчик не попадаем)', async () => {
      const { app } = createHarness();
      const res = await app.request('/api/v2/processes/bgr_missing', { method: 'DELETE' });
      expect(res.status).toBe(404);
    });
  });

  describe('терминальные статусы', () => {
    it('удаляются все терминальные статусы, running — нет', async () => {
      const { app, backgroundRuns, sessionManager } = createHarness();
      await createSession(sessionManager, 'session-1');
      const statuses: BackgroundRunStatus[] = [
        'completed',
        'failed',
        'cancelled',
        'orphaned',
        'running',
      ];
      for (const status of statuses) {
        await backgroundRuns.save(run(`bgr_${status}`, { status }));
      }

      for (const status of statuses) {
        const res = await app.request(`/api/v2/processes/bgr_${status}`, { method: 'DELETE' });
        expect(res.status, `статус ${status}`).toBe(status === 'running' ? 409 : 204);
      }
    });
  });
});

/**
 * ADR-104 × ADR-111/ADR-113: `POST /api/v2/queue/:sessionId/steer` — отправить
 * сообщение из очереди «в разрыв» активного хода.
 *
 * Контракт: нет сообщения по индексу → 404; активного хода нет → 409
 * `NO_ACTIVE_TURN` (сообщение остаётся в очереди); успех → 202
 * `{steered:true, pending_count}`, сообщение снято из `pendingMessages` и
 * истории и положено в `steerInbox`; превышение лимита инъекций → 429.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createQueueRoutes } from './queue.js';
import { SessionManager } from '../../sessions/manager.js';
import { FileStore } from '../../storage/file-store.js';
import { EventBus } from '../../events/bus.js';
import type { QueueProcessorManager, ChatOrchestrator } from '../../index.js';
import type { AuthKit } from '../../auth/local.js';
import { ActiveRunRegistry } from '../../engine/background/active-runs.js';
import { autoDetachOnSteer } from '../../engine/background/auto-detach.js';
import {
  generateId,
  makeTextPart,
  MAX_STEER_INJECTIONS_PER_TURN,
  MessageRole,
  nowISO,
  STEERING_ERROR_CODES,
} from '@itphx/synth-shared';
import type { Message, Session, BusEvent } from '@itphx/synth-shared';

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

describe('POST /api/v2/queue/:sessionId/steer', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;
  let eventBus: EventBus;
  let queueManager: ReturnType<typeof createMockQueueManager>;
  let app: Hono;
  let sessionId: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-queue-steer-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    eventBus = new EventBus();
    queueManager = createMockQueueManager({ running: true });
    app = new Hono();
    app.route('/api/v2/queue', createQueueRoutes(
      createMockAuth(),
      sessionManager,
      queueManager as unknown as QueueProcessorManager,
      eventBus,
      (async () => ({})) as unknown as ReturnType<ChatOrchestrator['createProcessMessage']>,
    ));
    const session = await sessionManager.createSession({ title: 'Q', userId: 'local' });
    sessionId = session.id;
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  /** Сообщение в очереди + его user-копия в истории (как после Phase 1). */
  async function seedPending(content = 'очередное сообщение'): Promise<Message> {
    const message = makeUserMessage(content);
    await sessionManager.addPendingMessage(sessionId, message);
    await sessionManager.addMessage(sessionId, { ...message, seq: 0 });
    return message;
  }

  async function steer(body: Record<string, unknown> = {}): Promise<Response> {
    return app.request(`/api/v2/queue/${sessionId}/steer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('404 — сообщения по индексу нет', async () => {
    const res = await steer({ index: 0 });
    expect(res.status).toBe(404);
    expect((await res.json() as { error: { code: string } }).error.code).toBe('NOT_FOUND');
  });

  it('409 NO_ACTIVE_TURN — хода нет, сообщение остаётся в очереди', async () => {
    queueManager.isRunning.mockReturnValue(false);
    const message = await seedPending();

    const res = await steer();

    expect(res.status).toBe(409);
    expect((await res.json() as { error: { code: string } }).error.code).toBe('NO_ACTIVE_TURN');
    const session = (await sessionManager.getSession(sessionId))!;
    expect(session.pendingMessages.map((m) => m.id)).toEqual([message.id]);
    expect(session.steerInbox ?? []).toHaveLength(0);
  });

  it('202 — при активном ходе сообщение уходит в steerInbox и снимается из очереди/истории', async () => {
    const message = await seedPending();
    const streamId = message.metadata!.stream_id as string;

    const res = await steer();

    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ steered: true, pending_count: 0 });

    const session = (await sessionManager.getSession(sessionId))!;
    expect(session.pendingMessages).toHaveLength(0);
    expect(session.steerInbox).toHaveLength(1);
    expect(session.steerInbox![0]!.id).toBe(message.id);
    expect(session.steerInbox![0]!.metadata?.steer).toBe(true);
    // User-копия из истории снята (иначе после инъекции был бы дубль).
    expect(session.messages.some(
      (m) => m.role === MessageRole.USER && m.metadata?.stream_id === streamId,
    )).toBe(false);
  });

  it('202 — в момент публикации message.enqueued сообщения нет ни в очереди, ни в истории', async () => {
    const message = await seedPending();
    const streamId = message.metadata!.stream_id as string;
    // Снимок состояния на момент публикации события: чтение стартует
    // синхронно из обработчика `message.enqueued` (атомарный перенос из
    // очереди в очередь инъекций уже завершён — событие публикуется после).
    let snapshotPromise: Promise<Session | null> | undefined;
    const unsubscribe = eventBus.subscribe(sessionId, (event) => {
      if (event.type !== 'message.enqueued') return;
      snapshotPromise = sessionManager.getSession(sessionId);
    }, { userId: 'local' });

    const res = await steer();
    unsubscribe();

    expect(res.status).toBe(202);
    expect(snapshotPromise).toBeDefined();
    const snapshot = (await snapshotPromise)!;
    expect(snapshot).not.toBeNull();
    // Сообщения нет в обычной очереди...
    expect(snapshot.pendingMessages.map((m) => m.id)).not.toContain(message.id);
    // ...и нет его user-копии в истории (иначе UI счёл бы реплику «вернувшейся
    // в очередь» и удалил её из ленты).
    expect(snapshot.messages.some(
      (m) => m.role === MessageRole.USER && m.metadata?.stream_id === streamId,
    )).toBe(false);
    // При этом сообщение уже в очереди инъекций.
    expect(snapshot.steerInbox ?? []).toHaveLength(1);
  });

  it('404 — повторный steer того же id (сообщение уже отправлено «в разрыв»)', async () => {
    const message = await seedPending();

    const first = await steer({ id: message.id });
    expect(first.status).toBe(202);

    const second = await steer({ id: message.id });
    expect(second.status).toBe(404);
    expect((await second.json() as { error: { code: string } }).error.code).toBe('NOT_FOUND');

    // Дубля в очереди инъекций нет.
    const session = (await sessionManager.getSession(sessionId))!;
    expect(session.steerInbox ?? []).toHaveLength(1);
    expect(session.pendingMessages).toHaveLength(0);
  });

  it('202 — адресация по id: снимается именно это сообщение, pending_count — длина очереди', async () => {
    const first = await seedPending('первое')
    const second = await seedPending('второе')
    const secondStream = second.metadata!.stream_id as string;

    const res = await steer({ id: second.id });

    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ steered: true, pending_count: 1 });
    const session = (await sessionManager.getSession(sessionId))!;
    expect(session.pendingMessages.map((m) => m.id)).toEqual([first.id]);
    expect(session.steerInbox).toHaveLength(1);
    expect(session.steerInbox![0]!.id).toBe(second.id);
    expect(session.messages.some(
      (m) => m.role === MessageRole.USER && m.metadata?.stream_id === secondStream,
    )).toBe(false);
    // Первое сообщение и его история не тронуты.
    expect(session.messages.some(
      (m) => m.role === MessageRole.USER && m.content === 'первое',
    )).toBe(true);
  });

  it('404 — steer по неизвестному id', async () => {
    await seedPending();
    const res = await steer({ id: 'msg-missing' });
    expect(res.status).toBe(404);
  });

  it('return?id= — возвращает именно это сообщение (id приоритетнее index)', async () => {
    const first = await seedPending('первое')
    const second = await seedPending('второе')

    const res = await app.request(`/api/v2/queue/${sessionId}/return?id=${second.id}`, {
      method: 'POST',
    })

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ texts: ['второе'] });
    const session = (await sessionManager.getSession(sessionId))!;
    expect(session.pendingMessages.map((m) => m.id)).toEqual([first.id]);
  });

  it('400 — нецелый index (1.5), очередь и steerInbox не тронуты', async () => {
    const message = await seedPending()
    const res = await steer({ index: 1.5 })
    expect(res.status).toBe(400)
    expect((await res.json() as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR')
    const session = (await sessionManager.getSession(sessionId))!
    expect(session.pendingMessages.map((m) => m.id)).toEqual([message.id])
    expect(session.steerInbox ?? []).toHaveLength(0)
  });

  it('404 — return?id= для элемента, исчезнувшего между чтением и записью', async () => {
    const message = await seedPending()
    const original = sessionManager.mutateHistory.bind(sessionManager)
    // Спай на правку **истории**: роут возврата снимает user-копию из истории
    // одной атомарной операцией. Имитируем конкурентное удаление элемента из
    // очереди ровно перед ней — роут обязан ответить 404, а не «успех».
    const spy = vi.spyOn(sessionManager, 'mutateHistory').mockImplementation(async (sid, fn, opts) => {
      await sessionManager.mutateMeta(sid, (meta) => {
        meta.pendingMessages = meta.pendingMessages.filter((m) => m.id !== message.id)
      })
      return original(sid, fn, opts)
    });

    try {
      const res = await app.request(`/api/v2/queue/${sessionId}/return?id=${message.id}`, {
        method: 'POST',
      });
      expect(res.status).toBe(404);
    } finally {
      spy.mockRestore();
    }
  });

  it('400 — legacy ?index=abc (локально): ошибка валидации, а не «вся очередь»', async () => {
    const message = await seedPending()
    const res = await app.request(`/api/v2/queue/${sessionId}/return?index=abc`, { method: 'POST' })
    expect(res.status).toBe(400)
    expect((await res.json() as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR')
    const session = (await sessionManager.getSession(sessionId))!
    expect(session.pendingMessages.map((m) => m.id)).toEqual([message.id])
  })

  it('400 — legacy ?index=-1: ошибка валидации, очередь не тронута', async () => {
    const message = await seedPending()
    const res = await app.request(`/api/v2/queue/${sessionId}/return?index=-1`, { method: 'POST' })
    expect(res.status).toBe(400)
    expect((await res.json() as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR')
    const session = (await sessionManager.getSession(sessionId))!
    expect(session.pendingMessages.map((m) => m.id)).toEqual([message.id])
  })

  it('400 — legacy ?index=abc в hybrid-ветке (без запроса к remote)', async () => {
    const remote = { queueReturn: vi.fn(), queueSteer: vi.fn() }
    const hybrid = new Hono()
    hybrid.route('/api/v2/queue', createQueueRoutes(
      createMockAuth(),
      sessionManager,
      queueManager as unknown as QueueProcessorManager,
      eventBus,
      (async () => ({})) as unknown as ReturnType<ChatOrchestrator['createProcessMessage']>,
      () => remote as never,
    ))

    const res = await hybrid.request('/api/v2/queue/remote:abc/return?index=abc', { method: 'POST' })

    expect(res.status).toBe(400)
    expect((await res.json() as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR')
    expect(remote.queueReturn).not.toHaveBeenCalled()
  })

  it('409 CONFLICT — сообщение текущего хода нельзя отправить «в разрыв»', async () => {
    const message = await seedPending();
    const streamId = message.metadata!.stream_id as string;
    await sessionManager.withLock(sessionId, async (s) => {
      s.currentStream = {
        streamId,
        message: message.content,
        startedAt: nowISO(),
        cancelled: false,
      };
      await sessionManager.saveSession(s);
    });

    const res = await steer();

    expect(res.status).toBe(409);
    expect((await res.json() as { error: { code: string; message: string } }).error.code)
      .toBe('CONFLICT');
    const session = (await sessionManager.getSession(sessionId))!;
    expect(session.pendingMessages.map((m) => m.id)).toEqual([message.id]);
    expect(session.steerInbox ?? []).toHaveLength(0);
  });

  // ADR-111 §detach × ADR-104: вклинивание — вмешательство пользователя, поэтому
  // блокирующие прогоны сессии уходят в фон ДО постановки сообщения в очередь
  // инъекций (иначе сообщение ждало бы конца foreground-команды).
  describe('авто-detach блокирующих прогонов (ADR-111 §detach)', () => {
    /** Приложение с seam'ом авто-detach (шов оркестратора подменён). */
    function buildWithSeam(seam: (req: {
      sessionId: string;
      enabled?: boolean;
      reason?: 'user' | 'message';
    }) => Promise<unknown>): Hono {
      const withSeam = new Hono();
      withSeam.route('/api/v2/queue', createQueueRoutes(
        createMockAuth(),
        sessionManager,
        queueManager as unknown as QueueProcessorManager,
        eventBus,
        (async () => ({})) as unknown as ReturnType<ChatOrchestrator['createProcessMessage']>,
        undefined,
        { autoDetachOnSteer: seam },
      ));
      return withSeam;
    }

    async function steerOn(target: Hono, body: Record<string, unknown> = {}): Promise<Response> {
      return target.request(`/api/v2/queue/${sessionId}/steer`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    }

    it('успешный steer → seam вызван один раз с reason:"message"', async () => {
      await seedPending();
      const seam = vi.fn().mockResolvedValue({ detached: [], failed: [] });

      const res = await steerOn(buildWithSeam(seam));

      expect(res.status).toBe(202);
      expect(seam).toHaveBeenCalledTimes(1);
      expect(seam).toHaveBeenCalledWith({ sessionId, reason: 'message' });
    });

    it('404 (нет сообщения) → seam не вызван', async () => {
      const seam = vi.fn().mockResolvedValue({ detached: [], failed: [] });

      const res = await steerOn(buildWithSeam(seam));

      expect(res.status).toBe(404);
      expect(seam).not.toHaveBeenCalled();
    });

    it('409 NO_ACTIVE_TURN → seam не вызван', async () => {
      queueManager.isRunning.mockReturnValue(false);
      await seedPending();
      const seam = vi.fn().mockResolvedValue({ detached: [], failed: [] });

      const res = await steerOn(buildWithSeam(seam));

      expect(res.status).toBe(409);
      expect(seam).not.toHaveBeenCalled();
    });

    it('обычная очередь (/return) не переводит прогоны в фон', async () => {
      await seedPending();
      const seam = vi.fn().mockResolvedValue({ detached: [], failed: [] });
      const target = buildWithSeam(seam);

      const res = await target.request(`/api/v2/queue/${sessionId}/return`, { method: 'POST' });

      expect(res.status).toBe(200);
      expect(seam).not.toHaveBeenCalled();
    });

    it('ошибка seam не ломает ответ: 202 и сообщение в steerInbox', async () => {
      const message = await seedPending();
      const seam = vi.fn().mockRejectedValue(new Error('boom'));

      const res = await steerOn(buildWithSeam(seam));

      expect(res.status).toBe(202);
      expect(await res.json()).toMatchObject({ steered: true });
      const session = (await sessionManager.getSession(sessionId))!;
      expect(session.steerInbox ?? []).toHaveLength(1);
      expect(session.steerInbox![0]!.id).toBe(message.id);
    });

    it('реальный реестр активных прогонов: foreground-прогон переведён с reason:"message", событие опубликовано', async () => {
      await seedPending();
      const registry = new ActiveRunRegistry();
      const detach = vi.fn();
      const unregister = registry.register(sessionId, {
        id: 'proc_1',
        kind: 'process',
        sessionId,
        detach,
      });
      const published: BusEvent[] = [];
      const unsubscribe = eventBus.subscribe(sessionId, (e) => published.push(e), { userId: 'local' });
      const target = buildWithSeam((req) => autoDetachOnSteer({
        orchestrator: { activeRuns: registry, isBackgroundEnabled: () => true },
        sessionId: req.sessionId,
        enabled: req.enabled,
        reason: req.reason,
        eventBus,
      }));

      const res = await steerOn(target);
      unsubscribe();
      unregister();

      expect(res.status).toBe(202);
      expect(detach).toHaveBeenCalledTimes(1);
      expect(detach).toHaveBeenCalledWith('message');
      const autoDetached = published.find((e) => e.type === 'background.auto_detached');
      expect(autoDetached).toBeDefined();
      expect((autoDetached!.data as { detached: Array<{ id: string }> }).detached.map((r) => r.id))
        .toEqual(['proc_1']);
    });
  });

  it('429 — превышен лимит инъекций; очередь и история не тронуты, событий приёма нет', async () => {
    const message = await seedPending();
    const streamId = message.metadata!.stream_id as string;
    // Заполняем очередь инъекций до лимита хода.
    for (let i = 0; i < MAX_STEER_INJECTIONS_PER_TURN; i++) {
      await sessionManager.enqueueSteerMessage(sessionId, makeUserMessage(`инъекция ${i}`), 10);
    }
    const events: BusEvent[] = [];
    const unsubscribe = eventBus.subscribe(sessionId, (e) => events.push(e), { userId: 'local' });

    const res = await steer();
    unsubscribe();

    expect(res.status).toBe(429);
    expect((await res.json() as { error: { code: string } }).error.code)
      .toBe(STEERING_ERROR_CODES.limitExceeded);
    // Сообщение не потеряно: осталось в очереди и в истории.
    const session = (await sessionManager.getSession(sessionId))!;
    expect(session.pendingMessages.map((m) => m.id)).toEqual([message.id]);
    expect(session.messages.some(
      (m) => m.role === MessageRole.USER && m.metadata?.stream_id === streamId,
    )).toBe(true);
    // Приёма не было — ни подтверждения, ни снимка в ленте.
    expect(events.some((e) => e.type === 'message.accepted')).toBe(false);
    expect(events.some((e) => e.type === 'message.enqueued')).toBe(false);
  });
});

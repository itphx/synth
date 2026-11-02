import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMessageRoutes } from './messages.js';
import { SessionManager } from '../../sessions/manager.js';
import { FileStore } from '../../storage/file-store.js';
import type { EventBus } from '../../index.js';
import { generateId, MessageRole, nowISO, makeTextPart } from '@itphx/synth-shared';
import type { Message } from '@itphx/synth-shared';

function makeMessage(content: string): Message {
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
    author: 'user',
  };
}

const auth = { requireAuth: async (_c: Context, next: Next) => { await next(); } };

function createTestApp(tmpDir: string, eventBus?: { publish: ReturnType<typeof vi.fn> }) {
  const app = new Hono();
  const sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
  app.route(
    '/api/v2/messages',
    createMessageRoutes(
      auth,
      sessionManager,
      undefined,
      eventBus ? { eventBus: eventBus as unknown as EventBus } : undefined,
    ),
  );
  return { app, sessionManager };
}

/** Фейковая шина: публикации фиксируются, остальное не нужно роутам сообщений. */
function makeEventBus() {
  return { publish: vi.fn() };
}

/** Сессия с сообщениями `a`,`b`,`c`; возвращает их id в исходном порядке. */
async function seedSession(sessionManager: SessionManager) {
  const session = await sessionManager.createSession({ title: 'M', userId: 'local' });
  const ids: string[] = [];
  for (const text of ['a', 'b', 'c']) {
    const msg = makeMessage(text);
    await sessionManager.addMessage(session.id, msg);
    ids.push(msg.id);
  }
  return { sessionId: session.id, ids };
}

describe('Messages API — адресация мутаций по id (ADR-118 §7)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-messages-core-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('PATCH toggle по id не зависит от позиции сообщения в массиве', async () => {
    const { app, sessionManager } = createTestApp(tmpDir);
    const { sessionId, ids } = await seedSession(sessionManager);
    const target = ids[1]!; // 'b'

    // Вставка в середину сдвигает позицию 'b' с 1 на 2 — id остаётся прежним.
    await sessionManager.withLock(sessionId, async (locked) => {
      locked.messages.splice(1, 0, makeMessage('inserted'));
      locked.messages.forEach((m, i) => { m.seq = i + 1; });
      await sessionManager.updateSession(locked);
    });

    const res = await app.request(`/api/v2/messages/${sessionId}/${target}/toggle`, { method: 'PATCH' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { disabled: boolean }).disabled).toBe(true);

    const s = await sessionManager.getSession(sessionId);
    expect(s!.messages.map((m) => m.content)).toEqual(['a', 'inserted', 'b', 'c']);
    // Затронуто ровно то сообщение, чей id адресован (позиция 1 — уже другое).
    expect(s!.messages[1]!.disabled).toBe(false);
    expect(s!.messages[2]!.disabled).toBe(true);
  });

  it('PATCH pin по id переключает только своё сообщение', async () => {
    const { app, sessionManager } = createTestApp(tmpDir);
    const { sessionId, ids } = await seedSession(sessionManager);

    const res = await app.request(`/api/v2/messages/${sessionId}/${ids[2]}/pin`, { method: 'PATCH' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { pinned: boolean }).pinned).toBe(true);

    const s = await sessionManager.getSession(sessionId);
    expect(s!.messages.map((m) => m.pinned)).toEqual([false, false, true]);
  });

  it('неизвестный id → 404 NOT_FOUND, числовая строка не работает как индекс', async () => {
    const { app, sessionManager } = createTestApp(tmpDir);
    const { sessionId, ids } = await seedSession(sessionManager);

    // «0» не адресует первое сообщение: index-фоллбека нет (ADR-118 §7).
    for (const unknown of ['0', '1', 'missing-id']) {
      const res = await app.request(`/api/v2/messages/${sessionId}/${unknown}/pin`, { method: 'PATCH' });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe('NOT_FOUND');
      expect(body.error.message).toBe('Сообщение не найдено');
    }

    const s = await sessionManager.getSession(sessionId);
    expect(s!.messages.map((m) => m.pinned)).toEqual([false, false, false]);
    expect(s!.messages.map((m) => m.id)).toEqual(ids);
  });

  it('DELETE по id удаляет именно это сообщение и перенумеровывает seq', async () => {
    const { app, sessionManager } = createTestApp(tmpDir);
    const { sessionId, ids } = await seedSession(sessionManager);

    const res = await app.request(`/api/v2/messages/${sessionId}/${ids[1]}`, { method: 'DELETE' });
    expect(res.status).toBe(200);

    const s = await sessionManager.getSession(sessionId);
    expect(s!.messages.map((m) => m.content)).toEqual(['a', 'c']);
    expect(s!.messages.map((m) => m.seq)).toEqual([1, 2]);

    const missing = await app.request(`/api/v2/messages/${sessionId}/${ids[1]}`, { method: 'DELETE' });
    expect(missing.status).toBe(404);
  });

  it('DELETE существующего сообщения публикует ровно одно message.deleted с message_id', async () => {
    const eventBus = makeEventBus();
    const { app, sessionManager } = createTestApp(tmpDir, eventBus);
    const { sessionId, ids } = await seedSession(sessionManager);

    const res = await app.request(`/api/v2/messages/${sessionId}/${ids[1]}`, { method: 'DELETE' });
    expect(res.status).toBe(200);

    expect(eventBus.publish).toHaveBeenCalledTimes(1);
    expect(eventBus.publish).toHaveBeenCalledWith(sessionId, 'message.deleted', { message_id: ids[1] });
  });

  it('DELETE несуществующего сообщения → 404 и событий нет', async () => {
    const eventBus = makeEventBus();
    const { app, sessionManager } = createTestApp(tmpDir, eventBus);
    const { sessionId } = await seedSession(sessionManager);

    const res = await app.request(`/api/v2/messages/${sessionId}/missing-id`, { method: 'DELETE' });
    expect(res.status).toBe(404);
    expect(eventBus.publish).not.toHaveBeenCalled();
  });

  it('retry ищет точку отсчёта от сообщения, найденного по id', async () => {
    const { app, sessionManager } = createTestApp(tmpDir);
    const { sessionId, ids } = await seedSession(sessionManager);

    // Сдвигаем: 'b' оказывается на позиции 2, на позиции 1 — вставка.
    await sessionManager.withLock(sessionId, async (locked) => {
      locked.messages.splice(1, 0, makeMessage('inserted'));
      locked.messages.forEach((m, i) => { m.seq = i + 1; });
      await sessionManager.updateSession(locked);
    });

    const res = await app.request(`/api/v2/messages/${sessionId}/${ids[1]}/retry`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { content: string }).content).toBe('b');

    const s = await sessionManager.getSession(sessionId);
    // Отключено от найденного сообщения и до конца истории.
    expect(s!.messages.map((m) => m.disabled)).toEqual([false, false, true, true]);

    const missing = await app.request(`/api/v2/messages/${sessionId}/nope/retry`, { method: 'POST' });
    expect(missing.status).toBe(404);
  });

  it('GET debug по id отдаёт сообщение, неизвестный id → 404', async () => {
    const { app, sessionManager } = createTestApp(tmpDir);
    const { sessionId, ids } = await seedSession(sessionManager);

    const res = await app.request(`/api/v2/messages/${sessionId}/${ids[0]}/debug`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { role: string; content: string };
    expect(body.role).toBe('user');
    expect(body.content).toBe('a');

    const missing = await app.request(`/api/v2/messages/${sessionId}/0/debug`);
    expect(missing.status).toBe(404);
  });

  it('batch по messageIds: pin с state, ответ — messageId вместо index', async () => {
    const { app, sessionManager } = createTestApp(tmpDir);
    const { sessionId, ids } = await seedSession(sessionManager);

    const res = await app.request(`/api/v2/messages/${sessionId}/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'pin', messageIds: [ids[0], ids[2], 'unknown'], state: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: Array<{ messageId: string; success: boolean; state?: boolean }>;
    };
    expect(body.results).toEqual([
      { messageId: ids[0], success: true, state: true },
      { messageId: ids[2], success: true, state: true },
      { messageId: 'unknown', success: false },
    ]);

    const s = await sessionManager.getSession(sessionId);
    expect(s!.messages.map((m) => m.pinned)).toEqual([true, false, true]);
  });

  it('batch delete по messageIds удаляет все указанные и перенумеровывает seq', async () => {
    const { app, sessionManager } = createTestApp(tmpDir);
    const { sessionId, ids } = await seedSession(sessionManager);

    const res = await app.request(`/api/v2/messages/${sessionId}/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete', messageIds: [ids[0], ids[2]] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: Array<{ messageId: string; success: boolean }> };
    expect(body.results.map((r) => r.messageId).sort()).toEqual([ids[0], ids[2]].sort());

    const s = await sessionManager.getSession(sessionId);
    expect(s!.messages.map((m) => m.content)).toEqual(['b']);
    expect(s!.messages.map((m) => m.seq)).toEqual([1]);
  });

  it('batch delete публикует message.deleted только для реально удалённых id', async () => {
    const eventBus = makeEventBus();
    const { app, sessionManager } = createTestApp(tmpDir, eventBus);
    const { sessionId, ids } = await seedSession(sessionManager);

    const res = await app.request(`/api/v2/messages/${sessionId}/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete', messageIds: [ids[0], ids[2], 'unknown'] }),
    });
    expect(res.status).toBe(200);

    expect(eventBus.publish).toHaveBeenCalledTimes(2);
    const deleted = eventBus.publish.mock.calls.map(
      ([sid, type, data]) => ({ sid, type, messageId: (data as { message_id: string }).message_id }),
    );
    expect(deleted).toEqual([
      { sid: sessionId, type: 'message.deleted', messageId: ids[0] },
      { sid: sessionId, type: 'message.deleted', messageId: ids[2] },
    ]);
  });

  it('batch pin публикует message.updated на каждый существующий id (с актуальным pinned)', async () => {
    const eventBus = makeEventBus();
    const { app, sessionManager } = createTestApp(tmpDir, eventBus);
    const { sessionId, ids } = await seedSession(sessionManager);

    const res = await app.request(`/api/v2/messages/${sessionId}/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'pin', messageIds: [ids[0], ids[1], 'unknown'], state: true }),
    });
    expect(res.status).toBe(200);
    expect(eventBus.publish).toHaveBeenCalledTimes(2);
    expect(eventBus.publish).toHaveBeenNthCalledWith(1, sessionId, 'message.updated', {
      message_id: ids[0],
      pinned: true,
    });
    expect(eventBus.publish).toHaveBeenNthCalledWith(2, sessionId, 'message.updated', {
      message_id: ids[1],
      pinned: true,
    });
  });

  it('batch toggle публикует message.updated с актуальным disabled', async () => {
    const eventBus = makeEventBus();
    const { app, sessionManager } = createTestApp(tmpDir, eventBus);
    const { sessionId, ids } = await seedSession(sessionManager);

    // Первый toggle — включает, второй — выключает; state не задан (инверсия).
    await sessionManager.withLock(sessionId, async (locked) => {
      locked.messages[0]!.disabled = true;
      await sessionManager.updateSession(locked);
    });

    const res = await app.request(`/api/v2/messages/${sessionId}/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'toggle', messageIds: [ids[0], ids[1]] }),
    });
    expect(res.status).toBe(200);
    expect(eventBus.publish).toHaveBeenCalledTimes(2);
    expect(eventBus.publish).toHaveBeenNthCalledWith(1, sessionId, 'message.updated', {
      message_id: ids[0],
      disabled: false,
    });
    expect(eventBus.publish).toHaveBeenNthCalledWith(2, sessionId, 'message.updated', {
      message_id: ids[1],
      disabled: true,
    });
  });

  it('toggle публикует ровно одно message.updated с актуальным disabled', async () => {
    const eventBus = makeEventBus();
    const { app, sessionManager } = createTestApp(tmpDir, eventBus);
    const { sessionId, ids } = await seedSession(sessionManager);

    const res = await app.request(`/api/v2/messages/${sessionId}/${ids[1]}/toggle`, { method: 'PATCH' });
    expect(res.status).toBe(200);

    expect(eventBus.publish).toHaveBeenCalledTimes(1);
    expect(eventBus.publish).toHaveBeenCalledWith(sessionId, 'message.updated', {
      message_id: ids[1],
      disabled: true,
    });

    // Несуществующий id → 404 и событий нет.
    eventBus.publish.mockClear();
    const missing = await app.request(`/api/v2/messages/${sessionId}/missing/toggle`, { method: 'PATCH' });
    expect(missing.status).toBe(404);
    expect(eventBus.publish).not.toHaveBeenCalled();
  });

  it('pin публикует ровно одно message.updated с актуальным pinned', async () => {
    const eventBus = makeEventBus();
    const { app, sessionManager } = createTestApp(tmpDir, eventBus);
    const { sessionId, ids } = await seedSession(sessionManager);

    const res = await app.request(`/api/v2/messages/${sessionId}/${ids[2]}/pin`, { method: 'PATCH' });
    expect(res.status).toBe(200);

    expect(eventBus.publish).toHaveBeenCalledTimes(1);
    expect(eventBus.publish).toHaveBeenCalledWith(sessionId, 'message.updated', {
      message_id: ids[2],
      pinned: true,
    });
  });

  it('retry публикует message.updated на затронутые сообщения и queue.state с нулями', async () => {
    const eventBus = makeEventBus();
    const { app, sessionManager } = createTestApp(tmpDir, eventBus);
    const { sessionId, ids } = await seedSession(sessionManager);

    const res = await app.request(`/api/v2/messages/${sessionId}/${ids[1]}/retry`, { method: 'POST' });
    expect(res.status).toBe(200);

    const calls = eventBus.publish.mock.calls.map(([sid, type, data]) => ({ sid, type, data }));
    expect(calls).toEqual([
      { sid: sessionId, type: 'message.updated', data: { message_id: ids[1], disabled: true } },
      { sid: sessionId, type: 'message.updated', data: { message_id: ids[2], disabled: true } },
      { sid: sessionId, type: 'queue.state', data: { pendingCount: 0, steerCount: 0 } },
    ]);

    eventBus.publish.mockClear();
    const missing = await app.request(`/api/v2/messages/${sessionId}/nope/retry`, { method: 'POST' });
    expect(missing.status).toBe(404);
    expect(eventBus.publish).not.toHaveBeenCalled();
  });

  it('batch: невалидное действие → 400 INVALID_ACTION, пустой messageIds → 400 INVALID_MESSAGE_IDS', async () => {
    const { app, sessionManager } = createTestApp(tmpDir);
    const { sessionId } = await seedSession(sessionManager);

    const badAction = await app.request(`/api/v2/messages/${sessionId}/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'nope', messageIds: ['x'] }),
    });
    expect(badAction.status).toBe(400);
    expect(((await badAction.json()) as { error: { code: string } }).error.code).toBe('INVALID_ACTION');

    for (const payload of [{ action: 'pin' }, { action: 'pin', messageIds: [] }, { action: 'pin', messageIds: [1] }]) {
      const res = await app.request(`/api/v2/messages/${sessionId}/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('INVALID_MESSAGE_IDS');
    }
  });
});

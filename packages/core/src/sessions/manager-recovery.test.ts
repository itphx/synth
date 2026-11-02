import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from './manager.js';
import { FileStore } from '../storage/file-store.js';
import type { Message } from '@itphx/synth-shared';
import { MessageRole, generateId, makeTextPart, nowISO } from '@itphx/synth-shared';

function message(partial: Partial<Message> & Pick<Message, 'role' | 'content'>): Message {
  return {
    id: generateId(),
    seq: 0,
    origin: 'local',
    parts: [makeTextPart(partial.content)],
    createdAt: nowISO(),
    disabled: false,
    pinned: false,
    hidden: false,
    ...partial,
  };
}

describe('SessionManager.recoverStreamingMessages (шаг 2б)', () => {
  let manager: SessionManager;
  let store: FileStore;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-recover-'));
    store = new FileStore({ dataDir: tmpDir });
    manager = new SessionManager(store, { instanceId: 'owner-current' });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('помечает streaming-сообщения прерванными', async () => {
    const session = await manager.createSession({ title: 'Recovery' });
    await manager.appendMessage(session.id, message({
      role: MessageRole.ASSISTANT,
      content: 'частичный ответ',
      metadata: { stream_id: 's1', streaming: true },
    }));

    const changed = await manager.recoverStreamingMessages(session.id);
    expect(changed).toBe(1);

    const stored = (await manager.getSession(session.id))!;
    const assistant = stored.messages[0]!;
    expect(assistant.metadata).toMatchObject({
      streaming: false,
      interrupted: true,
      status: 'error',
    });
    expect(assistant.content).toBe('частичный ответ');
  });

  it('отключает assistant(tool_calls) без пары, парные не трогает', async () => {
    const session = await manager.createSession({ title: 'Recovery pairs' });
    // Осиротевший вызов (tool-результата нет) — должен стать disabled.
    await manager.appendMessage(session.id, message({
      role: MessageRole.ASSISTANT,
      content: 'шаг 1',
      toolCalls: [{ id: 'call_orphan', function: { name: 'read_file', arguments: '{}' } }],
      metadata: { stream_id: 's1', tool_chain: true },
    }));
    // Парный вызов: assistant + tool — не трогаем.
    await manager.appendMessage(session.id, message({
      role: MessageRole.ASSISTANT,
      content: 'шаг 2',
      toolCalls: [{ id: 'call_ok', function: { name: 'read_file', arguments: '{}' } }],
      metadata: { stream_id: 's1', tool_chain: true },
    }));
    await manager.appendMessage(session.id, message({
      role: MessageRole.TOOL,
      content: 'результат',
      toolCallId: 'call_ok',
      metadata: { stream_id: 's1', tool_chain: true },
    }));

    const changed = await manager.recoverStreamingMessages(session.id);
    expect(changed).toBe(1);

    const stored = (await manager.getSession(session.id))!;
    const orphan = stored.messages.find((m) => m.toolCalls?.some((c) => c.id === 'call_orphan'))!;
    const paired = stored.messages.find((m) => m.toolCalls?.some((c) => c.id === 'call_ok'))!;
    expect(orphan.disabled).toBe(true);
    expect(orphan.metadata?.interrupted).toBe(true);
    expect(paired.disabled).toBe(false);
    expect(paired.metadata?.interrupted).toBeUndefined();
  });

  it('не пишет сессию, если нечего исправлять', async () => {
    const session = await manager.createSession({ title: 'Clean' });
    await manager.appendMessage(session.id, message({
      role: MessageRole.ASSISTANT,
      content: 'готовый ответ',
      metadata: { stream_id: 's1' },
    }));

    const before = (await manager.getSession(session.id))!;
    const changed = await manager.recoverStreamingMessages(session.id);
    const after = (await manager.getSession(session.id))!;

    expect(changed).toBe(0);
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(after.messages).toEqual(before.messages);
  });
});

describe('SessionManager.recoverInterruptedSessions (маркеры прошлых процессов)', () => {
  let manager: SessionManager;
  let store: FileStore;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-interrupted-'));
    store = new FileStore({ dataDir: tmpDir });
    manager = new SessionManager(store, { instanceId: 'owner-current' });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  /** Сессия с маркерами хода и блокировки (owner проставляет сохраняющий). */
  async function withMarkers(
    saver: SessionManager,
    opts: { ownerInStream?: string; ownerInBlock?: string; streaming?: boolean } = {},
  ) {
    const created = await manager.createSession({ title: 'Interrupted' });
    if (opts.streaming !== false) {
      await manager.appendMessage(created.id, message({
        role: MessageRole.ASSISTANT,
        content: 'частичный ответ',
        metadata: { stream_id: 'stream-1', streaming: true },
      }));
    }
    const session = (await manager.getSession(created.id))!;
    session.currentStream = {
      streamId: 'stream-1',
      message: 'запрос',
      startedAt: nowISO(),
      cancelled: false,
      turnId: 'turn-1',
      ...(opts.ownerInStream ? { owner: opts.ownerInStream } : {}),
    };
    session.status.blocked = 'process-1';
    session.status.blockedAt = nowISO();
    session.status.blockedOwner = opts.ownerInBlock;
    if (session.status.blockedOwner === undefined) delete session.status.blockedOwner;
    await saver.saveSession(session);
    return created.id;
  }

  it('чужой owner: маркеры сняты, сообщения помечены interrupted', async () => {
    const other = new SessionManager(store, { instanceId: 'owner-dead' });
    const id = await withMarkers(other, { ownerInStream: 'owner-dead', ownerInBlock: 'owner-dead' });

    const recovered = await manager.recoverInterruptedSessions();
    expect(recovered).toEqual([{ sessionId: id, turnId: 'turn-1', streamId: 'stream-1', pendingLeft: 0 }]);

    const stored = (await manager.getSession(id))!;
    expect(stored.currentStream).toBeUndefined();
    expect(stored.status.blocked).toBeUndefined();
    expect(stored.status.blockedAt).toBeUndefined();
    expect(stored.status.blockedOwner).toBeUndefined();
    expect(stored.messages[0]!.metadata).toMatchObject({ streaming: false, interrupted: true });
  });

  it('без owner (legacy/старый под): маркеры сняты', async () => {
    const created = await manager.createSession({ title: 'Legacy' });
    const session = (await manager.getSession(created.id))!;
    session.currentStream = {
      streamId: 'stream-legacy',
      message: 'запрос',
      startedAt: nowISO(),
      cancelled: false,
    };
    // Прямая запись в хранилище — в обход проставления owner.
    await store.save(session);

    const recovered = await manager.recoverInterruptedSessions();
    expect(recovered).toEqual([{ sessionId: created.id, streamId: 'stream-legacy', pendingLeft: 0 }]);

    const stored = (await manager.getSession(created.id))!;
    expect(stored.currentStream).toBeUndefined();
  });

  it('blocked без owner: блокировка снята', async () => {
    const created = await manager.createSession({ title: 'Legacy blocked' });
    const session = (await manager.getSession(created.id))!;
    session.status.blocked = 'process-legacy';
    session.status.blockedAt = nowISO();
    await store.save(session);

    const recovered = await manager.recoverInterruptedSessions();
    expect(recovered).toEqual([{ sessionId: created.id, pendingLeft: 0 }]);

    const stored = (await manager.getSession(created.id))!;
    expect(stored.status.blocked).toBeUndefined();
    expect(stored.status.blockedAt).toBeUndefined();
    expect(stored.status.blockedOwner).toBeUndefined();
  });

  it('saveSession/updateSession не присваивают owner чужому legacy-маркеру', async () => {
    const created = await manager.createSession({ title: 'Legacy save' });
    const session = (await manager.getSession(created.id))!;
    session.currentStream = {
      streamId: 'stream-legacy',
      message: 'запрос',
      startedAt: nowISO(),
      cancelled: false,
    };
    session.status.blocked = 'process-legacy';
    session.status.blockedAt = nowISO();

    // Обычные пути записи (title/очередь/сообщение) не должны «присвоить»
    // legacy-маркер текущему процессу — иначе recovery счёл бы ход своим.
    await manager.saveSession(session);
    const afterSave = (await manager.getSession(created.id))!;
    expect(afterSave.currentStream?.owner).toBeUndefined();
    expect(afterSave.status.blockedOwner).toBeUndefined();

    afterSave.title = 'renamed';
    await manager.updateSession(afterSave);
    const afterUpdate = (await manager.getSession(created.id))!;
    expect(afterUpdate.currentStream?.owner).toBeUndefined();
    expect(afterUpdate.status.blockedOwner).toBeUndefined();

    const recovered = await manager.recoverInterruptedSessions();
    expect(recovered).toEqual([{ sessionId: created.id, streamId: 'stream-legacy', pendingLeft: 0 }]);
    expect((await manager.getSession(created.id))!.currentStream).toBeUndefined();
  });

  it('in-flight из pending: снято из очереди и возвращено как resumeMessage', async () => {
    const created = await manager.createSession({ title: 'Resume pending' });
    const userMsg = message({
      role: MessageRole.USER,
      content: 'сделай',
      metadata: { stream_id: 'stream-1' },
    });
    const laterMsg = message({
      role: MessageRole.USER,
      content: 'потом',
      metadata: { stream_id: 'stream-2' },
    });
    await manager.addPendingMessage(created.id, userMsg);
    await manager.addPendingMessage(created.id, laterMsg);

    const session = (await manager.getSession(created.id))!;
    session.currentStream = {
      streamId: 'stream-1',
      message: 'сделай',
      startedAt: nowISO(),
      cancelled: false,
      turnId: 'turn-1',
      owner: 'owner-dead',
    };
    session.status.blocked = 'process-dead';
    session.status.blockedAt = nowISO();
    session.status.blockedOwner = 'owner-dead';
    await manager.saveSession(session);

    const recovered = await manager.recoverInterruptedSessions();
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({
      sessionId: created.id,
      turnId: 'turn-1',
      streamId: 'stream-1',
      pendingLeft: 1,
      resumeMessage: {
        id: userMsg.id,
        content: 'сделай',
        metadata: { stream_id: 'stream-1', resumed: true },
      },
    });

    const stored = (await manager.getSession(created.id))!;
    expect(stored.pendingMessages.map((m) => m.id)).toEqual([laterMsg.id]);
    expect(stored.currentStream).toBeUndefined();
  });

  it('in-flight нет в pending — resumeMessage берётся из истории', async () => {
    const created = await manager.createSession({ title: 'Resume history' });
    const userMsg = message({
      role: MessageRole.USER,
      content: 'сделай',
      metadata: { stream_id: 'stream-1' },
    });
    await manager.appendMessage(created.id, userMsg);

    const session = (await manager.getSession(created.id))!;
    session.currentStream = {
      streamId: 'stream-1',
      message: 'сделай',
      startedAt: nowISO(),
      cancelled: false,
      turnId: 'turn-1',
      owner: 'owner-dead',
    };
    await manager.saveSession(session);

    const recovered = await manager.recoverInterruptedSessions();
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({
      sessionId: created.id,
      streamId: 'stream-1',
      pendingLeft: 0,
      resumeMessage: {
        id: userMsg.id,
        content: 'сделай',
        metadata: { stream_id: 'stream-1', resumed: true },
      },
    });

    // История не тронута: resume-копия только для процессора.
    const stored = (await manager.getSession(created.id))!;
    expect(stored.messages.map((m) => m.id)).toEqual([userMsg.id]);
    expect(stored.messages[0]!.metadata?.resumed).toBeUndefined();
  });

  it('свой owner: живой ход не тронут', async () => {
    const id = await withMarkers(manager, { ownerInStream: 'owner-current', ownerInBlock: 'owner-current' });

    const recovered = await manager.recoverInterruptedSessions();
    expect(recovered).toEqual([]);

    const stored = (await manager.getSession(id))!;
    expect(stored.currentStream).toMatchObject({ streamId: 'stream-1', turnId: 'turn-1', owner: 'owner-current' });
    expect(stored.status.blocked).toBe('process-1');
    expect(stored.status.blockedOwner).toBe('owner-current');
    expect(stored.messages[0]!.metadata?.streaming).toBe(true);
  });

  it('идемпотентность: повторный проход ничего не находит', async () => {
    const other = new SessionManager(store, { instanceId: 'owner-dead' });
    await withMarkers(other, { ownerInStream: 'owner-dead', ownerInBlock: 'owner-dead' });

    expect((await manager.recoverInterruptedSessions()).length).toBe(1);
    expect(await manager.recoverInterruptedSessions()).toEqual([]);
  });
});

describe('SessionManager.takePendingInFlight (pending уже в истории)', () => {
  let manager: SessionManager;
  let store: FileStore;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-pending-inflight-'));
    store = new FileStore({ dataDir: tmpDir });
    manager = new SessionManager(store, { instanceId: 'owner-current' });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('снимает из pending, возвращает копию с resumed, историю не меняет', async () => {
    const created = await manager.createSession({ title: 'Pending in-flight' });
    const userMsg = message({
      role: MessageRole.USER,
      content: 'сделай',
      metadata: { stream_id: 'stream-1' },
    });
    const laterMsg = message({
      role: MessageRole.USER,
      content: 'потом',
      metadata: { stream_id: 'stream-2' },
    });
    // Сообщение уже материализовано прошлым процессом и одновременно лежит в очереди.
    const pendingCopy = message({
      id: userMsg.id,
      role: MessageRole.USER,
      content: 'сделай',
      metadata: { stream_id: 'stream-1' },
    });
    await manager.appendMessage(created.id, userMsg);
    await manager.addPendingMessage(created.id, pendingCopy, 5, { clearQueueStopped: false });
    await manager.addPendingMessage(created.id, laterMsg);
    await manager.safeUpdate(created.id, (s) => {
      s.status.queueStopped = true;
      s.status.queueStoppedAt = nowISO();
    });

    const resume = await manager.takePendingInFlight(created.id);

    expect(resume).toMatchObject({
      id: userMsg.id,
      content: 'сделай',
      metadata: { stream_id: 'stream-1', resumed: true },
    });

    const stored = (await manager.getSession(created.id))!;
    expect(stored.pendingMessages.map((m) => m.id)).toEqual([laterMsg.id]);
    // История не тронута: та же одна user-реплика, без `resumed`.
    expect(stored.messages.map((m) => m.id)).toEqual([userMsg.id]);
    expect(stored.messages[0]!.metadata?.resumed).toBeUndefined();
    // Осознанная остановка не снимается (её снимает только новый ввод/resume).
    expect(stored.status.queueStopped).toBe(true);
    expect(stored.status.queueStoppedAt).toBeTruthy();
  });

  it('pending, которого нет в истории, не трогается', async () => {
    const created = await manager.createSession({ title: 'Plain queue' });
    const queued = message({
      role: MessageRole.USER,
      content: 'обычная очередь',
      metadata: { stream_id: 'stream-9' },
    });
    await manager.addPendingMessage(created.id, queued);

    expect(await manager.takePendingInFlight(created.id)).toBeUndefined();

    const stored = (await manager.getSession(created.id))!;
    expect(stored.pendingMessages.map((m) => m.id)).toEqual([queued.id]);
    expect(stored.messages).toHaveLength(0);
  });

  it('повторный вызов идемпотентен (pending уже снят)', async () => {
    const created = await manager.createSession({ title: 'Idempotent' });
    const userMsg = message({
      role: MessageRole.USER,
      content: 'сделай',
      metadata: { stream_id: 'stream-1' },
    });
    await manager.appendMessage(created.id, userMsg);
    await manager.addPendingMessage(
      created.id,
      message({
        id: userMsg.id,
        role: MessageRole.USER,
        content: 'сделай',
        metadata: { stream_id: 'stream-1' },
      }),
      5,
      { clearQueueStopped: false },
    );

    expect(await manager.takePendingInFlight(created.id)).toBeDefined();
    expect(await manager.takePendingInFlight(created.id)).toBeUndefined();
  });

  it('пустой stream_id, но тот же id в истории — снимается по id', async () => {
    const created = await manager.createSession({ title: 'By id' });
    const userMsg = message({
      role: MessageRole.USER,
      content: 'без стрима',
      metadata: {},
    });
    await manager.appendMessage(created.id, userMsg);
    await manager.addPendingMessage(
      created.id,
      message({ id: userMsg.id, role: MessageRole.USER, content: 'без стрима', metadata: {} }),
      5,
      { clearQueueStopped: false },
    );

    const resume = await manager.takePendingInFlight(created.id);

    expect(resume).toMatchObject({ id: userMsg.id, content: 'без стрима' });
    expect(resume!.metadata).toMatchObject({ resumed: true });
    expect((await manager.getSession(created.id))!.pendingMessages).toHaveLength(0);
  });
});

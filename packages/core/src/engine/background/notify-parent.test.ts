/**
 * Этап 1 roadmap 0.13 (блок 13): уведомление родителя о завершении фонового
 * прогона (`engine/background/notify-parent.ts`).
 *
 * Инвариант: **ровно одно** попадание уведомления в историю сессии.
 * Раньше колбэк писал сообщение в историю (`addMessage`) **и** ставил его в
 * очередь (`enqueueUserMessage`) — процессор очереди добавлял то же сообщение
 * в историю второй раз: в чате — две копии уведомления и два автохода.
 *
 * Проверяется:
 *   • успех: сообщение уходит в очередь ровно один раз, `addMessage` НЕ
 *     вызывается (историю пополнит процессор);
 *   • отказ постановки (лимит pending) — fallback: `addMessage` + публикация
 *     `message.added`/`session.updated`;
 *   • отказ постановки и отказ записи — уведомление молча теряется (без
 *     публикаций);
 *   • сквозной сценарий с настоящими `SessionManager`/`QueueProcessorManager`:
 *     после обработки сообщение в истории ровно одно.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageRole, makeTextPart } from '@itphx/synth-shared';
import type { Message, Session } from '@itphx/synth-shared';
import { EventBus } from '../../events/bus.js';
import { SessionManager } from '../../sessions/manager.js';
import { FileStore } from '../../storage/file-store.js';
import { QueueProcessorManager, type ProcessMessageFn } from '../../queue/processor.js';
import { createBackgroundParentNotifier } from './notify-parent.js';

/** Сообщение-конверт фонового процесса (как его строит `buildProcessNotification`). */
function buildNotification(): Message {
  const content = [
    '<process processID="proc_1" state="exited" command="npm test">',
    '5 passed',
    '</process>',
  ].join('\n');
  return {
    id: 'msg_1',
    role: MessageRole.USER,
    seq: 0,
    origin: 'local',
    parts: [makeTextPart(content)],
    content,
    createdAt: new Date().toISOString(),
    disabled: false,
    pinned: false,
    hidden: false,
    ephemeral: false,
    author: 'Process',
    metadata: { type: 'background_run_result', kind: 'process', state: 'completed' },
  };
}

describe('createBackgroundParentNotifier — один путь (очередь)', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;
  let baseSession: Session;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-bg-notify-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    baseSession = await sessionManager.createSession({ title: 'parent' });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  /** Мок `SessionManager`: очередь (`addPendingMessage`), история (`addMessage`), steer. */
  function mockSessionManager(opts?: {
    pendingResult?: Session | null;
    addMessageResult?: Session | null;
    steerResult?: { accepted: boolean; pending: number };
  }) {
    const addPendingMessage = vi.fn(async () =>
      opts?.pendingResult === undefined ? baseSession : opts.pendingResult,
    );
    const addMessage = vi.fn(async (_sessionId: string, message: Message) => {
      if (opts?.addMessageResult === null) return null;
      return { ...baseSession, messages: [...baseSession.messages, message] };
    });
    const enqueueSteerMessage = vi.fn(async (_sessionId: string, _message: Message) =>
      opts?.steerResult ?? { accepted: true, pending: 1 },
    );
    const manager = { addPendingMessage, addMessage, enqueueSteerMessage };
    return { manager, addPendingMessage, addMessage, enqueueSteerMessage };
  }

  it('успех: сообщение ставится в очередь ровно один раз, addMessage не вызывается', async () => {
    const { manager, addPendingMessage, addMessage } = mockSessionManager();
    const eventBus = new EventBus();
    const createProcessor = vi.fn();
    const notify = createBackgroundParentNotifier({
      sessionManager: manager as unknown as SessionManager,
      eventBus,
      processorManager: { createProcessor } as unknown as QueueProcessorManager,
      processMessage: (async () => ({})) as unknown as ProcessMessageFn,
    });

    await notify('session-1', buildNotification());

    expect(addPendingMessage).toHaveBeenCalledTimes(1);
    expect(addMessage).not.toHaveBeenCalled();
    // Автоход: процессор очереди запущен для сессии.
    expect(createProcessor).toHaveBeenCalledTimes(1);
    expect(createProcessor.mock.calls[0]?.[0]).toBe('session-1');
  });

  it('успех: публикуется `message.queued`, а не `message.added` (историю пополнит процессор)', async () => {
    const { manager } = mockSessionManager();
    const eventBus = new EventBus();
    const events: Array<{ type: string }> = [];
    eventBus.subscribe('session-1', (e) => events.push({ type: e.type }));
    const notify = createBackgroundParentNotifier({
      sessionManager: manager as unknown as SessionManager,
      eventBus,
      processorManager: { createProcessor: vi.fn() } as unknown as QueueProcessorManager,
      processMessage: (async () => ({})) as unknown as ProcessMessageFn,
    });

    await notify('session-1', buildNotification());

    expect(events.map((e) => e.type)).toContain('message.queued');
    expect(events.map((e) => e.type)).not.toContain('message.added');
  });

  it('отказ постановки (лимит pending) → fallback: addMessage + message.added/session.updated', async () => {
    const { manager, addPendingMessage, addMessage } = mockSessionManager({ pendingResult: null });
    const eventBus = new EventBus();
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    eventBus.subscribe('session-1', (e) => events.push({ type: e.type, data: e.data }));
    const notify = createBackgroundParentNotifier({
      sessionManager: manager as unknown as SessionManager,
      eventBus,
      processorManager: { createProcessor: vi.fn() } as unknown as QueueProcessorManager,
      processMessage: (async () => ({})) as unknown as ProcessMessageFn,
    });

    await notify('session-1', buildNotification());

    expect(addPendingMessage).toHaveBeenCalledTimes(1);
    expect(addMessage).toHaveBeenCalledTimes(1);
    const types = events.map((e) => e.type);
    expect(types).toContain('message.added');
    expect(types).toContain('session.updated');
    // Fallback-путь не ставит сообщение в очередь повторно.
    expect(types).not.toContain('message.queued');
  });

  it('отказ постановки и отказ записи → уведомление молча теряется (без публикаций)', async () => {
    const { manager, addMessage } = mockSessionManager({
      pendingResult: null,
      addMessageResult: null,
    });
    const eventBus = new EventBus();
    const events: Array<{ type: string }> = [];
    eventBus.subscribe('session-1', (e) => events.push({ type: e.type }));
    const notify = createBackgroundParentNotifier({
      sessionManager: manager as unknown as SessionManager,
      eventBus,
      processorManager: { createProcessor: vi.fn() } as unknown as QueueProcessorManager,
      processMessage: (async () => ({})) as unknown as ProcessMessageFn,
    });

    await expect(notify('session-1', buildNotification())).resolves.toBeUndefined();

    expect(addMessage).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(0);
  });

  it('активный ход: уведомление уходит в steerInbox, очередь и автоход не трогаются', async () => {
    const { manager, addPendingMessage, addMessage, enqueueSteerMessage } = mockSessionManager();
    const eventBus = new EventBus();
    const events: Array<{ type: string }> = [];
    eventBus.subscribe('session-1', (e) => events.push({ type: e.type }));
    const createProcessor = vi.fn();
    const notify = createBackgroundParentNotifier({
      sessionManager: manager as unknown as SessionManager,
      eventBus,
      processorManager: { createProcessor } as unknown as QueueProcessorManager,
      processMessage: (async () => ({})) as unknown as ProcessMessageFn,
      isTurnActive: async () => true,
    });

    const message = buildNotification();
    await notify('session-1', message);

    // Ровно один путь: инъекция в текущий ход.
    expect(enqueueSteerMessage).toHaveBeenCalledTimes(1);
    expect(addPendingMessage).not.toHaveBeenCalled();
    expect(addMessage).not.toHaveBeenCalled();
    expect(createProcessor).not.toHaveBeenCalled();
    // Маркер вмешательства выставлен — сообщение вклинится в ход.
    expect(message.metadata?.steer).toBe(true);
    // Обычная очередь не публикуется (её нет).
    expect(events.map((e) => e.type)).not.toContain('message.queued');
    expect(events.map((e) => e.type)).not.toContain('message.added');
  });

  it('хода нет: уведомление уходит в pendingMessages (прежний путь очереди)', async () => {
    const { manager, addPendingMessage, enqueueSteerMessage } = mockSessionManager();
    const eventBus = new EventBus();
    const createProcessor = vi.fn();
    const notify = createBackgroundParentNotifier({
      sessionManager: manager as unknown as SessionManager,
      eventBus,
      processorManager: { createProcessor } as unknown as QueueProcessorManager,
      processMessage: (async () => ({})) as unknown as ProcessMessageFn,
      isTurnActive: async () => false,
    });

    await notify('session-1', buildNotification());

    expect(enqueueSteerMessage).not.toHaveBeenCalled();
    expect(addPendingMessage).toHaveBeenCalledTimes(1);
    expect(createProcessor).toHaveBeenCalledTimes(1);
  });

  it('лимит инъекций: маркер steer снят, уведомление не потеряно — уходит в очередь', async () => {
    const { manager, addPendingMessage, addMessage, enqueueSteerMessage } = mockSessionManager({
      steerResult: { accepted: false, pending: 5 },
    });
    const eventBus = new EventBus();
    const createProcessor = vi.fn();
    const notify = createBackgroundParentNotifier({
      sessionManager: manager as unknown as SessionManager,
      eventBus,
      processorManager: { createProcessor } as unknown as QueueProcessorManager,
      processMessage: (async () => ({})) as unknown as ProcessMessageFn,
      isTurnActive: async () => true,
    });

    const message = buildNotification();
    await notify('session-1', message);

    expect(enqueueSteerMessage).toHaveBeenCalledTimes(1);
    // Не принято инъекцией → обычная очередь (не fallback в историю).
    expect(addPendingMessage).toHaveBeenCalledTimes(1);
    expect(addMessage).not.toHaveBeenCalled();
    // Признак инъекции не «протёк» в обычное сообщение очереди.
    expect(message.metadata?.steer).toBeUndefined();
  });
});

describe('createBackgroundParentNotifier — сквозной сценарий (история)', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;
  let eventBus: EventBus;
  let processorManager: QueueProcessorManager;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-bg-notify-e2e-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    eventBus = new EventBus();
    processorManager = new QueueProcessorManager();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('после обработки очередью сообщение в истории ровно одно', async () => {
    const session = await sessionManager.createSession({ title: 'parent' });
    const added: Array<{ type: string; data: Record<string, unknown> }> = [];
    eventBus.subscribe(session.id, (e) => added.push({ type: e.type, data: e.data }));

    // Обработчик хода ничего не отвечает — важно лишь, что автоход состоялся.
    const processMessage: ProcessMessageFn = async () => ({});
    const notify = createBackgroundParentNotifier({
      sessionManager,
      eventBus,
      processorManager,
      processMessage,
    });

    const message = buildNotification();
    await notify(session.id, message);

    // Ждём, пока процессор очереди заберёт сообщение и добавит его в историю.
    const deadline = Date.now() + 5000;
    let history: Message[] = [];
    while (Date.now() < deadline) {
      const loaded = await sessionManager.getSession(session.id);
      history = loaded?.messages ?? [];
      if (history.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const notifications = history.filter(
      (m) => m.metadata?.type === 'background_run_result',
    );
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.content).toContain('<process');
    // Ровно одно событие `message.added` — второй копии нет.
    expect(added.filter((e) => e.type === 'message.added')).toHaveLength(1);
  });

  it('переполненная очередь pending → fallback: уведомление попадает в историю один раз', async () => {
    const session = await sessionManager.createSession({ title: 'parent' });
    // Заполняем очередь pending до предела (MAX_PENDING = 5) — постановка
    // уведомления не пройдёт, сработает fallback.
    for (let i = 0; i < 5; i++) {
      await sessionManager.addPendingMessage(session.id, buildNotification());
    }

    const notify = createBackgroundParentNotifier({
      sessionManager,
      eventBus,
      processorManager,
      processMessage: (async () => ({})) as unknown as ProcessMessageFn,
    });

    await notify(session.id, buildNotification());

    const loaded = await sessionManager.getSession(session.id);
    const notifications = (loaded?.messages ?? []).filter(
      (m) => m.metadata?.type === 'background_run_result',
    );
    expect(notifications).toHaveLength(1);
  });
});

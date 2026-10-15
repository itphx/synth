/**
 * Тесты `task/child-session.ts` (ADR-095, шаг 5): публикация сообщений/событий
 * дочерней сессии и её жизненный цикл (финализация, usage-счётчики, metadata).
 *
 * Изолированно: EventBus + mock SessionManager, без сети и LLM.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateId, makeTextPart, MessageRole, nowISO } from '@itphx/synth-shared';
import type { Message, Session, TokenUsage } from '@itphx/synth-shared';
import { EventBus } from '../../../events/bus.js';
import type { SessionManager } from '../../../sessions/manager.js';
import { createChildSessionLifecycle, publishMessageAdded } from './child-session.js';
import type { TaskExtra } from './types.js';

interface CapturedEvent {
  type: string;
  sessionId: string;
  data: Record<string, unknown>;
}

function capture(bus: EventBus): { events: CapturedEvent[]; unsubscribe: () => void } {
  const events: CapturedEvent[] = [];
  const unsubscribe = bus.subscribeAll((e) => {
    events.push({ type: e.type, sessionId: e.sessionId, data: e.data as Record<string, unknown> });
  });
  return { events, unsubscribe };
}

function makeMsg(content: string, extra: Partial<Message> = {}): Message {
  return {
    id: generateId(),
    role: MessageRole.ASSISTANT,
    seq: 0,
    origin: 'local',
    parts: [makeTextPart(content)],
    content,
    createdAt: nowISO(),
    disabled: false,
    pinned: false,
    hidden: false,
    ...extra,
  };
}

/** Минимальный Session для lifecycle-тестов. */
function makeSession(id: string): Session {
  return {
    id,
    title: 'child',
    createdAt: nowISO(),
    updatedAt: nowISO(),
    messages: [],
    stickyNotes: [],
    todos: [],
    pendingMessages: [],
    references: [],
    settings: {},
    status: { blocked: false, cancelRequested: false },
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    cacheHitRate: 0,
  } as unknown as Session;
}

/** Mock SessionManager: in-memory сессия + шпионы. */
function makeSessionManager(session: Session) {
  const calls = { updateSession: 0, saveSession: 0, withLock: 0 };
  const manager = {
    calls,
    session,
    getSession: vi.fn(async () => session),
    updateSession: vi.fn(async (s: Session) => { calls.updateSession++; manager.session = s; }),
    addMessage: vi.fn(async (_id: string, msg: Message) => {
      manager.session.messages.push(msg);
      return manager.session;
    }),
    withLock: vi.fn(async (_id: string, fn: (s: Session) => Promise<unknown>) => {
      calls.withLock++;
      return fn(manager.session);
    }),
    saveSession: vi.fn(async (s: Session) => { calls.saveSession++; manager.session = s; }),
  };
  return manager;
}

describe('publishMessageAdded', () => {
  let bus: EventBus;

  beforeEach(() => { bus = new EventBus(); });

  it('публикует message.added в дочернюю сессию и child.message.added в родительскую', () => {
    const { events } = capture(bus);
    const msg = makeMsg('hello');

    void publishMessageAdded(bus, 'parent-1', 'child-1', msg, 4);

    expect(events).toHaveLength(2);
    const childEvt = events.find((e) => e.type === 'message.added')!;
    expect(childEvt.sessionId).toBe('child-1');
    expect(childEvt.data.session_id).toBe('child-1');
    expect(childEvt.data.index).toBe(4);
    expect((childEvt.data.message as Record<string, unknown>).content).toBe('hello');

    const parentEvt = events.find((e) => e.type === 'child.message.added')!;
    expect(parentEvt.sessionId).toBe('parent-1');
    expect(parentEvt.data.child_session_id).toBe('child-1');
    expect(parentEvt.data.index).toBe(4);
  });

  it('с childSession дополнительно публикует child.session.updated в родительскую сессию', () => {
    const { events } = capture(bus);
    const child = makeSession('child-2');

    void publishMessageAdded(bus, 'parent-2', 'child-2', makeMsg('x'), 0, child);

    const updated = events.filter((e) => e.type === 'child.session.updated');
    expect(updated).toHaveLength(1);
    expect(updated[0]!.sessionId).toBe('parent-2');
    expect(updated[0]!.data.session).toBeDefined();
  });

  it('без childSession события child.session.updated нет', () => {
    const { events } = capture(bus);
    void publishMessageAdded(bus, 'p', 'c', makeMsg('x'), 0);
    expect(events.some((e) => e.type === 'child.session.updated')).toBe(false);
  });
});

describe('createChildSessionLifecycle', () => {
  it('finalize: обновляет updatedAt и публикует терминальные события (child + parent)', async () => {
    const bus = new EventBus();
    const session = makeSession('child-1');
    const manager = makeSessionManager(session);
    const { events } = capture(bus);

    const lifecycle = createChildSessionLifecycle({
      childSessionId: 'child-1',
      parentSessionId: 'parent-1',
      extra: { sessionManager: manager as unknown as SessionManager, eventBus: bus, streamId: 'stream-1' } as TaskExtra,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      getModel: () => undefined,
    });

    await lifecycle.finalize();

    expect(manager.calls.updateSession).toBe(1);
    expect(events.map((e) => e.type).sort()).toEqual(
      ['child.session.updated', 'session.updated', 'stream.ended'].sort(),
    );
    const ended = events.find((e) => e.type === 'stream.ended')!;
    expect(ended.sessionId).toBe('child-1');
    expect(ended.data.stream_id).toBe('stream-1');
    const parentEvt = events.find((e) => e.type === 'child.session.updated')!;
    expect(parentEvt.sessionId).toBe('parent-1');
  });

  it('finalize без childSessionId — no-op без обращения к SessionManager', async () => {
    const manager = makeSessionManager(makeSession('c'));
    const lifecycle = createChildSessionLifecycle({
      childSessionId: undefined,
      parentSessionId: 'parent-1',
      extra: { sessionManager: manager as unknown as SessionManager } as TaskExtra,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      getModel: () => undefined,
    });

    await expect(lifecycle.finalize()).resolves.toBeUndefined();
    expect(manager.getSession).not.toHaveBeenCalled();
  });

  it('finalize проглатывает ошибку SessionManager (не фатально)', async () => {
    const manager = {
      getSession: vi.fn(async () => { throw new Error('boom'); }),
      updateSession: vi.fn(),
    };
    const lifecycle = createChildSessionLifecycle({
      childSessionId: 'child-1',
      parentSessionId: 'parent-1',
      extra: { sessionManager: manager as unknown as SessionManager } as TaskExtra,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      getModel: () => undefined,
    });

    await expect(lifecycle.finalize()).resolves.toBeUndefined();
    expect(manager.updateSession).not.toHaveBeenCalled();
  });

  it('addMessage: пишет в дочернюю сессию и публикует message.added/child.message.added', async () => {
    const bus = new EventBus();
    const session = makeSession('child-1');
    const manager = makeSessionManager(session);
    const { events } = capture(bus);

    const lifecycle = createChildSessionLifecycle({
      childSessionId: 'child-1',
      parentSessionId: 'parent-1',
      extra: { sessionManager: manager as unknown as SessionManager, eventBus: bus } as TaskExtra,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      getModel: () => undefined,
    });

    await lifecycle.addMessage(makeMsg('added'));

    expect(manager.session.messages).toHaveLength(1);
    expect(events.some((e) => e.type === 'message.added' && e.sessionId === 'child-1')).toBe(true);
    expect(events.some((e) => e.type === 'child.message.added' && e.sessionId === 'parent-1')).toBe(true);
  });

  it('addMessage без childSessionId — no-op', async () => {
    const manager = makeSessionManager(makeSession('c'));
    const lifecycle = createChildSessionLifecycle({
      childSessionId: undefined,
      parentSessionId: 'p',
      extra: { sessionManager: manager as unknown as SessionManager } as TaskExtra,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      getModel: () => undefined,
    });

    await lifecycle.addMessage(makeMsg('x'));
    expect(manager.addMessage).not.toHaveBeenCalled();
  });

  it('commitUsage: увеличивает session-счётчики и считает cacheHitRate ровно один раз', async () => {
    const session = makeSession('child-1');
    const manager = makeSessionManager(session);
    const usage: TokenUsage = {
      inputTokens: 100,
      outputTokens: 40,
      totalTokens: 140,
      cacheReadTokens: 25,
      cacheWriteTokens: 5,
      reasoningTokens: 7,
    };

    const lifecycle = createChildSessionLifecycle({
      childSessionId: 'child-1',
      parentSessionId: 'p',
      extra: { sessionManager: manager as unknown as SessionManager } as TaskExtra,
      usage,
      getModel: () => undefined,
    });

    await lifecycle.commitUsage();
    // Идемпотентность: повторный вызов не должен удваивать счётчики.
    await lifecycle.commitUsage();

    expect(manager.calls.withLock).toBe(1);
    expect(manager.session.inputTokens).toBe(100);
    expect(manager.session.outputTokens).toBe(40);
    expect(manager.session.totalTokens).toBe(140);
    expect(manager.session.cacheReadTokens).toBe(25);
    expect(manager.session.cacheWriteTokens).toBe(5);
    expect(manager.session.reasoningTokens).toBe(7);
    expect(manager.session.cacheHitRate).toBeCloseTo(0.25, 12);
  });

  it('commitUsage без childSessionId — no-op, счётчик «выполнено» не тратится зря', async () => {
    const manager = makeSessionManager(makeSession('c'));
    const lifecycle = createChildSessionLifecycle({
      childSessionId: undefined,
      parentSessionId: 'p',
      extra: { sessionManager: manager as unknown as SessionManager } as TaskExtra,
      usage: { inputTokens: 10, outputTokens: 0, totalTokens: 10 },
      getModel: () => undefined,
    });

    await lifecycle.commitUsage();
    expect(manager.calls.withLock).toBe(0);
  });

  it('buildAssistantMetadata: status + extraMeta, cost при ценах модели', () => {
    const lifecycle = createChildSessionLifecycle({
      childSessionId: undefined,
      parentSessionId: 'p',
      extra: {
        modelPriceLoader: (m: string) => (m === 'test-model' ? { inputPrice: 1_000_000, outputPrice: 2_000_000 } : null),
      } as TaskExtra,
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      getModel: () => 'test-model',
    });

    const meta = lifecycle.buildAssistantMetadata('completed', { foo: 'bar' });
    expect(meta.status).toBe('completed');
    expect(meta.foo).toBe('bar');
    // 10*1 + 5*2 = 20
    expect(meta.cost_usd).toBeCloseTo(20, 12);
    expect(meta.cost_currency).toBe('USD');
    expect(meta.cost_breakdown).toEqual({ input: 10, output: 10, cacheRead: 0, cacheWrite: 0 });
  });

  it('buildAssistantMetadata: без modelPriceLoader cost-полей нет', () => {
    const lifecycle = createChildSessionLifecycle({
      childSessionId: undefined,
      parentSessionId: 'p',
      extra: {} as TaskExtra,
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      getModel: () => 'test-model',
    });

    const meta = lifecycle.buildAssistantMetadata('error');
    expect(meta.status).toBe('error');
    expect(meta.cost_usd).toBeUndefined();
    expect(meta.cost_currency).toBeUndefined();
    expect(meta.cost_breakdown).toBeUndefined();
  });

  it('buildAssistantMetadata: нет модели (getModel → undefined) — cost не считается', () => {
    const loader = vi.fn(() => ({ inputPrice: 1 }));
    const lifecycle = createChildSessionLifecycle({
      childSessionId: undefined,
      parentSessionId: 'p',
      extra: { modelPriceLoader: loader } as unknown as TaskExtra,
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      getModel: () => undefined,
    });

    const meta = lifecycle.buildAssistantMetadata('cancelled');
    expect(meta.cost_usd).toBeUndefined();
    expect(loader).not.toHaveBeenCalled();
  });
});

import { describe, it, expect } from 'vitest';
import { serializeMessage, serializeSession } from './serialize.js';
import { MessageRole, generateId, makeTextPart, nowISO, TsmState } from '@synth/shared';
import type { Message, Session } from '@synth/shared';

function makeMsg(overrides: Partial<Message> = {}): Message {
  return {
    id: generateId(),
    role: MessageRole.USER,
    seq: 1,
    origin: 'local',
    parts: [makeTextPart('hello')],
    content: 'hello',
    createdAt: nowISO(),
    disabled: false,
    pinned: false,
    hidden: false,
    ...overrides,
  };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: generateId(),
    title: 'Test',
    projectId: 'proj-1',
    engine: 'synth-core',
    sessionOrigin: 'user',
    parentId: null,
    branchPoint: null,
    planPath: null,
    userId: null,
    ownerId: null,
    messages: [],
    pendingMessages: [],
    currentStream: null,
    status: { state: TsmState.PLANNING, iteration: 0, validationAttempts: 0 },
    settings: {},
    stickyNotes: [],
    summarizationPending: false,
    canSummarize: false,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    inputCost: 0,
    outputCost: 0,
    cacheReadCost: 0,
    cacheWriteCost: 0,
    createdAt: nowISO(),
    updatedAt: nowISO(),
    ...overrides,
  } as Session;
}

describe('serializeMessage', () => {
  it('включает поле origin', () => {
    const msg = makeMsg({ origin: 'local' });
    const serialized = serializeMessage(msg, 0);
    expect(serialized.origin).toBe('local');
  });

  it('включает поле origin=inherited', () => {
    const msg = makeMsg({ origin: 'inherited' });
    const serialized = serializeMessage(msg, 0);
    expect(serialized.origin).toBe('inherited');
  });

  it('включает поле origin=merged', () => {
    const msg = makeMsg({ origin: 'merged' });
    const serialized = serializeMessage(msg, 0);
    expect(serialized.origin).toBe('merged');
  });

  it('включает source_msg_id когда задан', () => {
    const msg = makeMsg({ sourceMsgId: 'src-123' });
    const serialized = serializeMessage(msg, 0);
    expect(serialized.source_msg_id).toBe('src-123');
  });

  it('source_msg_id = null когда не задан', () => {
    const msg = makeMsg();
    const serialized = serializeMessage(msg, 0);
    expect(serialized.source_msg_id).toBeNull();
  });

  it('поле index соответствует переданному', () => {
    const msg = makeMsg();
    const serialized = serializeMessage(msg, 5);
    expect(serialized.index).toBe(5);
  });
});

describe('serializeSession', () => {
  it('сериализует origin и source_msg_id в каждом сообщении', () => {
    const m1 = makeMsg({ origin: 'local', sourceMsgId: 'orig-1' });
    const m2 = makeMsg({ origin: 'inherited', sourceMsgId: 'orig-2' });
    const session = makeSession({ messages: [m1, m2] });

    const serialized = serializeSession(session);
    expect(serialized.messages).toHaveLength(2);
    expect(serialized.messages[0]!.origin).toBe('local');
    expect(serialized.messages[0]!.source_msg_id).toBe('orig-1');
    expect(serialized.messages[1]!.origin).toBe('inherited');
    expect(serialized.messages[1]!.source_msg_id).toBe('orig-2');
  });

  it('сериализует pendingMessages с origin и source_msg_id', () => {
    const pm = makeMsg({ origin: 'local' });
    const session = makeSession({ pendingMessages: [pm] });

    const serialized = serializeSession(session);
    expect(serialized.pending_messages).toHaveLength(1);
    expect(serialized.pending_messages[0]!.origin).toBe('local');
    expect(serialized.pending_messages[0]!.source_msg_id).toBeNull();
  });
});

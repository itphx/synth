import { describe, it, expect, afterEach } from 'vitest';
import { serializeMessage, serializeSession } from './serialize.js';
import { resetLiveStreamSnapshots, setLiveStreamSnapshot } from '../engine/live-stream-snapshot.js';
import { generateId, nowISO, makeTextPart, MessageRole, type Message, type Session } from '@itphx/synth-shared';

function message(over: Partial<Message> = {}): Message {
  return {
    id: generateId(), role: MessageRole.ASSISTANT, seq: 1, origin: 'local',
    parts: [makeTextPart('x')], content: 'x', createdAt: nowISO(),
    disabled: false, pinned: false, hidden: false, ...over,
  };
}

describe('serializeMessage — ephemeral (ADR-046 §7.1)', () => {
  it('отдаёт ephemeral:true для локального ответа команды', () => {
    const out = serializeMessage(message({ ephemeral: true }), 0) as Record<string, unknown>;
    expect(out.ephemeral).toBe(true);
  });

  it('обычное сообщение → ephemeral:false', () => {
    const out = serializeMessage(message(), 0) as Record<string, unknown>;
    expect(out.ephemeral).toBe(false);
  });
});

describe('serializeMessage — qa_pass/qa_reason (ADR-034)', () => {
  it('переносит qa_pass/qa_reason сохранённого сообщения', () => {
    const out = serializeMessage(message({ qa_pass: true, qa_reason: 'qc.all_passed' }), 0) as Record<string, unknown>;
    expect(out.qa_pass).toBe(true);
    expect(out.qa_reason).toBe('qc.all_passed');
  });

  it('провал QC → qa_pass:false и причина', () => {
    const out = serializeMessage(message({ qa_pass: false, qa_reason: 'too short' }), 0) as Record<string, unknown>;
    expect(out.qa_pass).toBe(false);
    expect(out.qa_reason).toBe('too short');
  });

  it('без QC-полей ключи отсутствуют (не null) — иначе UI включил бы бейдж', () => {
    const out = serializeMessage(message(), 0) as Record<string, unknown>;
    expect('qa_pass' in out).toBe(false);
    expect('qa_reason' in out).toBe(false);
  });
});

describe('serializeMessage — ord/turn_id/step_index/status (ADR-118)', () => {
  it('переносит поля хода и порядка записи', () => {
    const out = serializeMessage(message({
      ord: 7,
      turnId: 'turn-1',
      stepIndex: 2,
      status: 'completed',
    }), 0) as Record<string, unknown>;
    expect(out.ord).toBe(7);
    expect(out.turn_id).toBe('turn-1');
    expect(out.step_index).toBe(2);
    expect(out.status).toBe('completed');
  });

  it('незаданные поля → null (аддитивно, без падения на legacy-сообщениях)', () => {
    const out = serializeMessage(message(), 0) as Record<string, unknown>;
    expect(out.ord).toBeNull();
    expect(out.turn_id).toBeNull();
    expect(out.step_index).toBeNull();
    expect(out.status).toBeNull();
  });
});

/** Сессия для проверки `activity` (DTO сессии). */
function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    sessionOrigin: 'user',
    messages: [],
    pendingMessages: [],
    status: {},
    settings: {} as Session['settings'],
    checkpoints: [],
    stickyNotes: [],
    references: [],
    summarizationPending: false,
    canSummarize: false,
    inputCost: 0,
    outputCost: 0,
    cacheReadCost: 0,
    cacheWriteCost: 0,
    createdAt: nowISO(),
    updatedAt: nowISO(),
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    ...overrides,
  } as Session;
}

describe('serializeSession — includeMessages/includePromptStates (список сессий)', () => {
  function fullSession(): Session {
    return session({
      messages: [message({ content: 'history' })],
      pendingMessages: [message({ role: MessageRole.USER, content: 'queued' })],
      promptStates: { assistant: { generation: 1 } } as unknown as Session['promptStates'],
    });
  }

  it('по умолчанию история и prompt_states отдаются (деталь не меняется)', () => {
    const out = serializeSession(fullSession()) as Record<string, unknown>;
    expect((out.messages as unknown[]).length).toBe(1);
    expect(out.pending_count).toBe(1);
    expect(out.prompt_states).not.toBeNull();
  });

  it('includeMessages:false → ключа messages нет вовсе, очередь и счётчик сохранены', () => {
    const out = serializeSession(fullSession(), { includeMessages: false }) as Record<string, unknown>;
    // Ключ не включается (не пустой массив): полная история списком не отдаётся.
    expect('messages' in out).toBe(false);
    expect(out.pending_count).toBe(1);
    expect((out.pending_messages as unknown[]).length).toBe(1);
  });

  it('includePromptStates:false → ключа prompt_states нет', () => {
    const out = serializeSession(fullSession(), { includePromptStates: false }) as Record<string, unknown>;
    expect('prompt_states' in out).toBe(false);
  });
});

describe('serializeSession — activity (idle | busy | retry)', () => {
  it('сессия без хода → idle', () => {
    const out = serializeSession(session()) as Record<string, unknown>;
    expect(out.activity).toEqual({ type: 'idle' });
  });

  it('живой ход → busy с идентификаторами хода и потока', () => {
    const out = serializeSession(session({
      currentStream: {
        streamId: 'stream-1',
        message: 'в работе',
        startedAt: nowISO(),
        cancelled: false,
        turnId: 'turn-1',
      },
    })) as Record<string, unknown>;
    expect(out.activity).toEqual({
      type: 'busy',
      turnId: 'turn-1',
      streamId: 'stream-1',
    });
  });

  it('заблокированная сессия без стрима → busy (идентификаторы — null)', () => {
    const out = serializeSession(session({
      status: { blocked: 'sess-1', blockedAt: nowISO() },
    })) as Record<string, unknown>;
    expect(out.activity).toEqual({ type: 'busy', turnId: null, streamId: null });
  });

  it('состояние ретрая → retry (попытка, предел, время следующей попытки)', () => {
    const out = serializeSession(session({
      retry: {
        streamId: 'stream-9',
        attempt: 2,
        maxRetries: 3,
        retryAt: '2026-01-01T00:00:05.000Z',
        error: 'timeout',
      },
    })) as Record<string, unknown>;
    expect(out.activity).toEqual({
      type: 'retry',
      attempt: 2,
      maxRetries: 3,
      retryAt: '2026-01-01T00:00:05.000Z',
      error: 'timeout',
      streamId: 'stream-9',
    });
  });

  it('приоритет: retry важнее busy (ретрай при живом стриме)', () => {
    const out = serializeSession(session({
      currentStream: {
        streamId: 'stream-1',
        message: 'в работе',
        startedAt: nowISO(),
        cancelled: false,
        turnId: 'turn-1',
      },
      retry: {
        streamId: 'stream-1',
        attempt: 1,
        maxRetries: 3,
        retryAt: '2026-01-01T00:00:05.000Z',
      },
    })) as Record<string, unknown>;
    const activity = out.activity as Record<string, unknown>;
    expect(activity.type).toBe('retry');
    expect(activity.turnId).toBeUndefined();
  });

  it('status.queue_stopped/queue_stopped_at — в DTO (осознанная остановка)', () => {
    const stopped = serializeSession(session({
      status: { queueStopped: true, queueStoppedAt: '2026-01-01T00:00:05.000Z' },
    })) as Record<string, unknown>;
    expect(stopped.status).toMatchObject({
      queue_stopped: true,
      queue_stopped_at: '2026-01-01T00:00:05.000Z',
    });

    const fresh = serializeSession(session()) as Record<string, unknown>;
    expect(fresh.status).toMatchObject({ queue_stopped: false, queue_stopped_at: null });
  });
});


describe('serializeSession — current_stream.live (ADR-118 §5)', () => {
  afterEach(() => resetLiveStreamSnapshots());

  const stream = {
    streamId: 'stream-1',
    message: 'в работе',
    startedAt: nowISO(),
    cancelled: false,
    turnId: 'turn-1',
  };

  it('отдаёт снимок живого шага (текст, reasoning, части) для текущего стрима', () => {
    setLiveStreamSnapshot('sess-1', {
      streamId: 'stream-1',
      turnId: 'turn-1',
      messageId: 'msg-step-1',
      stepIndex: 0,
      content: 'привет',
      reasoning: 'думаю',
      parts: [
        { id: 'msg:text:0', type: 'text', data: 'привет' },
        { id: 'msg:reasoning:0', type: 'reasoning', data: 'думаю' },
      ],
      updatedAt: nowISO(),
    });

    const out = serializeSession(session({ currentStream: stream })) as Record<string, unknown>;
    const dto = out.current_stream as Record<string, unknown>;
    expect(dto.live).toMatchObject({
      message_id: 'msg-step-1',
      step_index: 0,
      turn_id: 'turn-1',
      content: 'привет',
      reasoning: 'думаю',
    });
    expect((dto.live as { parts: unknown[] }).parts).toHaveLength(2);
  });

  it('снимок другого стрима не отдаётся (новый ход — новый стрим)', () => {
    setLiveStreamSnapshot('sess-1', {
      streamId: 'stream-old',
      messageId: 'msg-step-old',
      content: 'старое',
      parts: [],
      updatedAt: nowISO(),
    });

    const out = serializeSession(session({ currentStream: stream })) as Record<string, unknown>;
    expect((out.current_stream as Record<string, unknown>).live).toBeNull();
  });

  it('нет снимка → live: null (поле аддитивное)', () => {
    const out = serializeSession(session({ currentStream: stream })) as Record<string, unknown>;
    expect((out.current_stream as Record<string, unknown>).live).toBeNull();
  });
});

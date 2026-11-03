import { describe, it, expect, vi } from 'vitest';
import { MessageRole } from '@itphx/synth-shared';
import type { LLMResponse, Message, Session } from '@itphx/synth-shared';
import type { CompressionPlan } from '../context/optimizer.js';
import { createCompressionSummarySaver, disableCompressedMessages, forceCompression } from './compression.js';
import type { SaveAssistantMessageFn } from './persistence.js';

function makeSession(messages: Message[]): Session {
  return {
    id: 's1',
    settings: { provider: 'p', model: 'm', debugEnabled: false },
    messages,
  } as unknown as Session;
}

function makeManager(session: Session) {
  const saveSession = vi.fn(async () => {});
  return {
    sessionManager: {
      withLock: async (_id: string, fn: (s: Session) => Promise<unknown>) => fn(session),
      getSession: async () => session,
      saveSession,
    } as unknown as {
      withLock: <T>(id: string, fn: (s: Session) => Promise<T>) => Promise<T>;
      getSession: (id: string) => Promise<Session | null>;
      saveSession: (s: Session) => Promise<void>;
    },
    saveSession,
  };
}

function msg(id: string, role: MessageRole): Message {
  return {
    id,
    role,
    seq: 0,
    origin: 'local',
    parts: [{ id: `${id}-p`, type: 'text', data: id }],
    content: id,
    createdAt: new Date().toISOString(),
    disabled: false,
    pinned: false,
    hidden: false,
  } as Message;
}

function plan(patch: Partial<CompressionPlan> = {}): CompressionPlan {
  return {
    mode: 'compaction',
    provider: null as unknown as CompressionPlan['provider'],
    llmMessages: [],
    systemPrompt: 'p',
    messagesToCompress: [],
    coveredIndices: [0, 1],
    keepFromIndex: 2,
    keepFromId: 'u2',
    keepMessages: [],
    ...patch,
  };
}

describe('disableCompressedMessages', () => {
  it('отключает только покрытые, ставит compactedBy, хвост не трогает', async () => {
    const session = makeSession([
      msg('u1', MessageRole.USER),
      msg('a1', MessageRole.ASSISTANT),
      msg('u2', MessageRole.USER),
    ]);
    const { sessionManager } = makeManager(session);
    await disableCompressedMessages(
      { sessionManager, eventBus: { publish: vi.fn() } as never },
      session.id,
      plan(),
    );
    expect(session.messages[0]!.disabled).toBe(true);
    expect(session.messages[1]!.disabled).toBe(true);
    expect(session.messages[0]!.metadata?.compactedBy).toBe('compaction');
    expect(session.messages[2]!.disabled).toBe(false);
  });

  it('идемпотентен: повторный вызов ничего не меняет', async () => {
    const session = makeSession([msg('u1', MessageRole.USER), msg('a1', MessageRole.ASSISTANT)]);
    const { sessionManager, saveSession } = makeManager(session);
    await disableCompressedMessages({ sessionManager, eventBus: { publish: vi.fn() } as never }, session.id, plan());
    expect(saveSession).toHaveBeenCalledTimes(1);
    await disableCompressedMessages({ sessionManager, eventBus: { publish: vi.fn() } as never }, session.id, plan());
    expect(saveSession).toHaveBeenCalledTimes(1);
  });

  it('pinned не отключается', async () => {
    const session = makeSession([msg('u1', MessageRole.USER), msg('a1', MessageRole.ASSISTANT)]);
    session.messages[1]!.pinned = true;
    const { sessionManager } = makeManager(session);
    await disableCompressedMessages(
      { sessionManager, eventBus: { publish: vi.fn() } as never },
      session.id,
      plan(),
    );
    expect(session.messages[0]!.disabled).toBe(true);
    expect(session.messages[1]!.disabled).toBe(false);
  });
});

describe('forceCompression (шов overflow)', () => {
  it('сохраняет резюме, отключает покрытые и публикует summarization_applied', async () => {
    const session = makeSession([
      msg('u1', MessageRole.USER),
      msg('a1', MessageRole.ASSISTANT),
      msg('u2', MessageRole.USER),
    ]);
    const { sessionManager, saveSession } = makeManager(session);
    const response: LLMResponse = {
      content: '## Objective\nx',
      model: 'm',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    };
    const saveSummary = vi.fn(async () => {});
    const eventBus = { publish: vi.fn() };
    const optimizer = {
      prepareCompression: vi.fn(() => plan()),
      completeCompression: vi.fn(async () => ({ content: response.content, response })),
      effectiveMode: () => 'compaction',
    } as unknown as import('../context/optimizer.js').ContextOptimizer;

    const result = await forceCompression(session, {
      optimizer,
      sessionManager,
      eventBus: eventBus as never,
      saveSummary,
    }, { reason: 'overflow' });

    expect(result.summary).toBe(response.content);
    expect(result.plan.mode).toBe('compaction');
    expect(saveSummary).toHaveBeenCalledTimes(1);
    expect(session.messages[0]!.disabled).toBe(true);
    expect(session.messages[2]!.disabled).toBe(false);
    expect(saveSession).toHaveBeenCalled();
    expect(eventBus.publish).toHaveBeenCalledWith(
      's1',
      'context.summarization_applied',
      expect.objectContaining({ reason: 'overflow', mode: 'compaction', covered_indices: [0, 1] }),
    );
  });

  it('M4: режим выключен — сжатие не вызывается, история не меняется', async () => {
    const session = makeSession([msg('u1', MessageRole.USER), msg('a1', MessageRole.ASSISTANT)]);
    const { sessionManager } = makeManager(session);
    const prepareCompression = vi.fn();
    const optimizer = {
      effectiveMode: () => null,
      prepareCompression,
    } as unknown as import('../context/optimizer.js').ContextOptimizer;

    await expect(forceCompression(session, {
      optimizer,
      sessionManager,
      eventBus: { publish: vi.fn() } as never,
      saveSummary: vi.fn(async () => {}),
    }, { reason: 'overflow' })).rejects.toThrow(/mode_disabled/);

    expect(prepareCompression).not.toHaveBeenCalled();
    expect(session.messages[0]!.disabled).toBe(false);
    expect(session.messages[1]!.disabled).toBe(false);
  });
});

describe('createCompressionSummarySaver', () => {
  it('сохраняет SUMMARY через saveAssistantMessage с summaryOf и metadata', async () => {
    const save = vi.fn(async (..._args: unknown[]) => 'msg-id');
    const saver = createCompressionSummarySaver(save as unknown as SaveAssistantMessageFn);
    const session = makeSession([]);
    const response: LLMResponse = {
      content: '## Objective\nx',
      model: 'm',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    };

    await saver({
      session,
      content: '## Objective\nx',
      plan: plan(),
      response,
      reason: 'overflow',
    });

    const args = save.mock.calls[0]!;
    // role / summaryOf / skipEvent / metadataExtra (позиции контракта)
    expect(args[10]).toBe(MessageRole.SUMMARY);
    expect(args[11]).toEqual([0, 1]);
    expect(args[12]).toBe(true);
    expect(args[17]).toMatchObject({
      type: 'auto_summary',
      mode: 'compaction',
      keepFrom: 'u2',
      reason: 'overflow',
    });
  });
});

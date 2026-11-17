import { describe, it, expect, vi } from 'vitest';
import { MessageRole } from '@itphx/synth-shared';
import type { LLMResponse, Message, Session } from '@itphx/synth-shared';
import type { CompressionPlan } from '../context/optimizer.js';
import { createCompressionSummarySaver, disableCompressedMessages, forceCompression } from './compression.js';
import type { SaveAssistantMessageFn } from './persistence.js';
import { SessionManager } from '../../sessions/manager.js';
import { MemorySessionRepository } from '../../storage/memory/sessions.js';

/** Фиксированное время сессии — по нему видно bump/no-bump `updatedAt`. */
const SAVED_AT = '2024-01-01T00:00:00.000Z';

function makeSession(messages: Message[]): Session {
  return {
    id: 's1',
    sessionOrigin: 'user',
    title: 's',
    settings: { provider: 'p', model: 'm', debugEnabled: false },
    messages,
    pendingMessages: [],
    status: {},
    checkpoints: [],
    stickyNotes: [],
    references: [],
    createdAt: SAVED_AT,
    updatedAt: SAVED_AT,
  } as unknown as Session;
}

/**
 * Настоящий менеджер над in-memory портом: проверяется **факт** записи и
 * неизменность `updatedAt`, а не вызовы моков. `writes` считает записи истории,
 * которые порт реально выполнил (`shouldWrite` = решение порта о записи).
 */
async function makeManager(session: Session) {
  const store = new MemorySessionRepository();
  await store.save(session);
  const writes = { count: 0 };
  const original = store.mutateHistory.bind(store);
  vi.spyOn(store, 'mutateHistory').mockImplementation(async (id, mutator, opts) => {
    return original(id, mutator, {
      ...opts,
      shouldWrite: (value) => {
        const ok = opts?.shouldWrite ? opts.shouldWrite(value) : true;
        if (ok) writes.count += 1;
        return ok;
      },
    });
  });
  const sessionManager = new SessionManager(store);
  return { sessionManager, store, writes };
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
  it('отключает только покрытые, ставит compactedBy, хвост не трогает; updatedAt не двигается', async () => {
    const session = makeSession([
      msg('u1', MessageRole.USER),
      msg('a1', MessageRole.ASSISTANT),
      msg('u2', MessageRole.USER),
    ]);
    const { sessionManager, store } = await makeManager(session);
    await disableCompressedMessages(
      { sessionManager, eventBus: { publish: vi.fn() } as never },
      session.id,
      plan(),
    );
    const stored = (await store.load(session.id))!;
    expect(stored.messages[0]!.disabled).toBe(true);
    expect(stored.messages[1]!.disabled).toBe(true);
    expect(stored.messages[0]!.metadata?.compactedBy).toBe('compaction');
    expect(stored.messages[2]!.disabled).toBe(false);
    // Сжатие — служебный проход: сессия в списках не «оживает».
    expect(stored.updatedAt).toBe(SAVED_AT);
  });

  it('идемпотентен: повторный вызов ничего не пишет', async () => {
    const session = makeSession([msg('u1', MessageRole.USER), msg('a1', MessageRole.ASSISTANT)]);
    const { sessionManager, writes } = await makeManager(session);
    await disableCompressedMessages({ sessionManager, eventBus: { publish: vi.fn() } as never }, session.id, plan());
    expect(writes.count).toBe(1);
    await disableCompressedMessages({ sessionManager, eventBus: { publish: vi.fn() } as never }, session.id, plan());
    expect(writes.count).toBe(1);
  });

  it('pinned не отключается', async () => {
    const session = makeSession([msg('u1', MessageRole.USER), msg('a1', MessageRole.ASSISTANT)]);
    session.messages[1]!.pinned = true;
    const { sessionManager, store } = await makeManager(session);
    await disableCompressedMessages(
      { sessionManager, eventBus: { publish: vi.fn() } as never },
      session.id,
      plan(),
    );
    const stored = (await store.load(session.id))!;
    expect(stored.messages[0]!.disabled).toBe(true);
    expect(stored.messages[1]!.disabled).toBe(false);
  });

  it('индекс вне диапазона — пропуск (план не роняет запись)', async () => {
    const session = makeSession([msg('u1', MessageRole.USER)]);
    const { sessionManager, store } = await makeManager(session);
    await disableCompressedMessages(
      { sessionManager, eventBus: { publish: vi.fn() } as never },
      session.id,
      plan({ coveredIndices: [0, 7] }),
    );
    const stored = (await store.load(session.id))!;
    expect(stored.messages).toHaveLength(1);
    expect(stored.messages[0]!.disabled).toBe(true);
  });

  it('«свидетель» в конце и параллельный append не теряются', async () => {
    const session = makeSession([msg('u1', MessageRole.USER), msg('a1', MessageRole.ASSISTANT)]);
    const { sessionManager, store } = await makeManager(session);
    const witness = msg('witness', MessageRole.USER);

    await Promise.all([
      disableCompressedMessages({ sessionManager, eventBus: { publish: vi.fn() } as never }, session.id, plan()),
      sessionManager.appendMessage(session.id, witness),
    ]);

    const stored = (await store.load(session.id))!;
    expect(stored.messages.map((m) => m.content)).toEqual(['u1', 'a1', 'witness']);
    expect(stored.messages[0]!.disabled).toBe(true);
    expect(stored.messages[1]!.disabled).toBe(true);
    expect(stored.messages[2]!.disabled).toBe(false);
  });
});

describe('forceCompression (шов overflow)', () => {
  it('сохраняет резюме, отключает покрытые и публикует summarization_applied', async () => {
    const session = makeSession([
      msg('u1', MessageRole.USER),
      msg('a1', MessageRole.ASSISTANT),
      msg('u2', MessageRole.USER),
    ]);
    const { sessionManager, store } = await makeManager(session);
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
    const stored = (await store.load(session.id))!;
    expect(stored.messages[0]!.disabled).toBe(true);
    expect(stored.messages[1]!.disabled).toBe(true);
    expect(stored.messages[2]!.disabled).toBe(false);
    expect(stored.updatedAt).toBe(SAVED_AT);
    expect(eventBus.publish).toHaveBeenCalledWith(
      's1',
      'context.summarization_applied',
      expect.objectContaining({ reason: 'overflow', mode: 'compaction', covered_indices: [0, 1] }),
    );
  });

  it('M4: режим выключен — сжатие не вызывается, история не меняется', async () => {
    const session = makeSession([msg('u1', MessageRole.USER), msg('a1', MessageRole.ASSISTANT)]);
    const { sessionManager, store } = await makeManager(session);
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
    const stored = (await store.load(session.id))!;
    expect(stored.messages[0]!.disabled).toBe(false);
    expect(stored.messages[1]!.disabled).toBe(false);
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

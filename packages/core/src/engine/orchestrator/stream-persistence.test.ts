import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Message } from '@itphx/synth-shared';
import { MessageRole } from '@itphx/synth-shared';
import type { SessionManager } from '../../sessions/manager.js';
import { StreamMessageDraft } from './stream-persistence.js';

type DraftManager = Pick<SessionManager, 'appendMessage' | 'updateMessage'>;

function makeBase(): Omit<Message, 'id' | 'seq' | 'content' | 'parts' | 'createdAt'> {
  return {
    role: MessageRole.ASSISTANT,
    origin: 'local',
    disabled: false,
    pinned: false,
    hidden: false,
    provider: 'prov',
    agentRole: 'developer',
    model: 'm',
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    metadata: { stream_id: 'stream1' },
  };
}

function makeDraft(overrides: { intervalMs?: number; minChars?: number; warn?: (m: string) => void } = {}) {
  const appendMessage = vi.fn(async (_sessionId: string, message: Message) => ({
    ...message,
    id: message.id,
    seq: 7,
  }));
  const updateMessage = vi.fn(async (_sessionId: string, message: Message) => message);
  const sessionManager = { appendMessage, updateMessage } as unknown as DraftManager;
  const draft = new StreamMessageDraft({
    sessionManager,
    sessionId: 's1',
    base: makeBase(),
    intervalMs: 1000,
    minChars: 4096,
    ...overrides,
  });
  return { draft, appendMessage, updateMessage };
}

describe('StreamMessageDraft (шаг 2б)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('создаёт черновик ровно один раз при серии push', async () => {
    const { draft, appendMessage } = makeDraft();

    draft.push('Привет', '');
    draft.push('Привет,', '');
    draft.push('Привет, мир', '');
    await vi.advanceTimersByTimeAsync(0);

    expect(appendMessage).toHaveBeenCalledTimes(1);
    const saved = appendMessage.mock.calls[0]![1];
    expect(saved.metadata).toMatchObject({ stream_id: 'stream1', streaming: true });
    expect(saved.metadata?.tool_chain).toBeUndefined();
    expect(saved.content).toBe('Привет');
    expect(draft.ref()).toEqual({ id: saved.id, seq: 7 });

    await draft.dispose();
  });

  it('троттлит обновления: несколько push → не больше одной записи за интервал', async () => {
    const { draft, appendMessage, updateMessage } = makeDraft();

    draft.push('a', '');
    await vi.advanceTimersByTimeAsync(0);
    expect(appendMessage).toHaveBeenCalledTimes(1);

    draft.push('ab', '');
    draft.push('abc', '');
    draft.push('abcd', '');

    await vi.advanceTimersByTimeAsync(500);
    expect(updateMessage).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);
    expect(updateMessage).toHaveBeenCalledTimes(1);
    expect(updateMessage.mock.calls[0]![1].content).toBe('abcd');
    expect(updateMessage.mock.calls[0]![1].metadata).toMatchObject({ streaming: true });

    await draft.dispose();
  });

  it('пишет сразу при приросте ≥ minChars', async () => {
    const { draft, updateMessage } = makeDraft({ minChars: 5 });

    draft.push('a', '');
    await vi.advanceTimersByTimeAsync(0);
    draft.push('abcdef', '');
    await vi.advanceTimersByTimeAsync(0);

    expect(updateMessage).toHaveBeenCalledTimes(1);
    expect(updateMessage.mock.calls[0]![1].content).toBe('abcdef');

    await draft.dispose();
  });

  it('finalize дописывает финальный контент и заменяет metadata без streaming', async () => {
    const { draft, appendMessage, updateMessage } = makeDraft();

    draft.push('часть', '');
    await vi.advanceTimersByTimeAsync(0);
    const ref = draft.ref();

    const finalized = await draft.finalize({
      content: 'полный ответ',
      metadata: { stream_id: 'stream1', tool_chain: true },
    });

    expect(finalized).toEqual(ref);
    expect(appendMessage).toHaveBeenCalledTimes(1);
    expect(updateMessage).toHaveBeenCalledTimes(1);
    const message = updateMessage.mock.calls[0]![1];
    expect(message.id).toBe(ref!.id);
    expect(message.seq).toBe(ref!.seq);
    expect(message.content).toBe('полный ответ');
    expect(message.parts[0]).toMatchObject({ type: 'text', data: 'полный ответ' });
    expect(message.metadata).toEqual({ stream_id: 'stream1', tool_chain: true });
    expect(message.metadata?.streaming).toBeUndefined();
  });

  it('finalize без чанков возвращает null и ничего не пишет', async () => {
    const { draft, appendMessage, updateMessage } = makeDraft();

    const ref = await draft.finalize({ content: 'нет черновика' });

    expect(ref).toBeNull();
    expect(appendMessage).not.toHaveBeenCalled();
    expect(updateMessage).not.toHaveBeenCalled();
  });

  it('finalize без чанков, но с tool_calls создаёт промежуточное сообщение', async () => {
    const { draft, appendMessage, updateMessage } = makeDraft();

    const ref = await draft.finalize({
      content: '',
      toolCalls: [{ id: 'call_1', function: { name: 'read_file', arguments: '{}' } }],
      metadata: { stream_id: 'stream1', tool_chain: true },
    });

    expect(ref).toEqual({ id: expect.any(String), seq: 7 });
    expect(appendMessage).toHaveBeenCalledTimes(1);
    const saved = appendMessage.mock.calls[0]![1];
    expect(saved.toolCalls).toHaveLength(1);
    expect(saved.metadata).toEqual({ stream_id: 'stream1', tool_chain: true });
    expect(updateMessage).not.toHaveBeenCalled();
  });

  it('abort сохраняет частичный текст с interrupted/status=error', async () => {
    const { draft, updateMessage } = makeDraft();

    draft.push('частичный ответ', '');
    await vi.advanceTimersByTimeAsync(0);

    await draft.abort('network fail');

    expect(updateMessage).toHaveBeenCalledTimes(1);
    const message = updateMessage.mock.calls[0]![1];
    expect(message.content).toBe('частичный ответ');
    expect(message.metadata).toMatchObject({
      streaming: false,
      interrupted: true,
      status: 'error',
      interrupted_reason: 'network fail',
    });

    // Таймер не висит: после abort дополнительных записей нет.
    await vi.advanceTimersByTimeAsync(5000);
    expect(updateMessage).toHaveBeenCalledTimes(1);
  });

  it('dispose останавливает таймер и не делает лишних записей', async () => {
    const { draft, updateMessage } = makeDraft();

    draft.push('a', '');
    await vi.advanceTimersByTimeAsync(0);
    draft.push('ab', '');
    await draft.dispose();

    await vi.advanceTimersByTimeAsync(5000);
    expect(updateMessage).not.toHaveBeenCalled();
  });

  it('ошибка записи не ломает push и не спамит предупреждениями', async () => {
    const warn = vi.fn();
    const { draft, appendMessage } = makeDraft({ warn });
    appendMessage.mockRejectedValueOnce(new Error('disk full'));

    expect(() => draft.push('a', '')).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    expect(warn).toHaveBeenCalledTimes(1);

    expect(() => draft.push('ab', '')).not.toThrow();
    expect(() => draft.push('abc', '')).not.toThrow();
    await vi.advanceTimersByTimeAsync(5000);
    expect(warn).toHaveBeenCalledTimes(1);

    await draft.dispose();
  });

  it('flush дожидается append и пишет актуальное содержимое', async () => {
    const { draft, updateMessage } = makeDraft();

    draft.push('начало', '');
    draft.push('начало ответа', '');
    await draft.flush();

    expect(updateMessage).toHaveBeenCalledTimes(1);
    expect(updateMessage.mock.calls[0]![1].content).toBe('начало ответа');
    expect(updateMessage.mock.calls[0]![1].parts[0]).toMatchObject({
      type: 'text',
      data: 'начало ответа',
    });

    await draft.dispose();
  });
});

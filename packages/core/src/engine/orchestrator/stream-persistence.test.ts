import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Message } from '@itphx/synth-shared';
import { MessageRole, makeTextPart } from '@itphx/synth-shared';
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
    agentRole: 'fixer',
    model: 'm',
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    metadata: { stream_id: 'stream1' },
  };
}

function makeDraft(
  overrides: {
    intervalMs?: number;
    minChars?: number;
    warn?: (m: string) => void;
    /** Замена `updateMessage`: например, «сообщение не найдено» → `null`. */
    updateMessageImpl?: (sessionId: string, message: Message) => Promise<Message | null>;
  } = {},
) {
  const { updateMessageImpl, ...options } = overrides;
  const appendMessage = vi.fn(async (_sessionId: string, message: Message) => ({
    ...message,
    id: message.id,
    seq: 7,
  }));
  const updateMessage = vi.fn(
    updateMessageImpl ?? (async (_sessionId: string, message: Message) => message),
  );
  const sessionManager = { appendMessage, updateMessage } as unknown as DraftManager;
  const draft = new StreamMessageDraft({
    sessionManager,
    sessionId: 's1',
    base: makeBase(),
    intervalMs: 1000,
    minChars: 4096,
    ...options,
  });
  return { draft, appendMessage, updateMessage };
}

/**
 * Доводит черновик до «грязного» состояния: запись создана, но актуальное
 * содержимое ещё не записано, таймер троттлинга запланирован. Именно так
 * выглядит черновик в момент `finalize`/`abort`/`dispose`.
 */
async function makeDirtyDraft(
  overrides: Parameters<typeof makeDraft>[0] = {},
): Promise<ReturnType<typeof makeDraft>> {
  const made = makeDraft(overrides);
  made.draft.push('a', '');
  await vi.advanceTimersByTimeAsync(0);
  made.draft.push('ab', '');
  return made;
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

  it('flush после finalize не «воскрешает» шаг статусом streaming', async () => {
    const { draft, updateMessage } = await makeDirtyDraft();
    const ref = draft.ref();

    await draft.finalize({
      content: 'финал',
      parts: [makeTextPart('финал')],
      reasoning: '',
      toolCalls: [{ id: 'call_1', function: { name: 'read_file', arguments: '{}' } }],
      status: 'completed',
    });

    expect(updateMessage).toHaveBeenCalledTimes(1);
    expect(updateMessage.mock.calls[0]![1].status).toBe('completed');

    // Поздняя троттлинг-запись (гонка с таймером, `await draft.flush()` из
    // оркестратора) не должна ни писать, ни портить финальную запись.
    await draft.flush();

    expect(updateMessage).toHaveBeenCalledTimes(1);
    const last = updateMessage.mock.calls.at(-1)![1];
    expect(last.status).toBe('completed');
    expect(last.metadata?.streaming).toBeUndefined();
    expect(last.id).toBe(ref!.id);
    expect(last.content).toBe('финал');
    expect(last.toolCalls).toHaveLength(1);
  });

  it('flush после abort не перетирает терминальный статус', async () => {
    const { draft, updateMessage } = await makeDirtyDraft();

    await draft.abort('причина', 'cancelled');

    expect(updateMessage).toHaveBeenCalledTimes(1);
    expect(updateMessage.mock.calls[0]![1].status).toBe('cancelled');

    await draft.flush();

    expect(updateMessage).toHaveBeenCalledTimes(1);
    expect(updateMessage.mock.calls.at(-1)![1].status).toBe('cancelled');
    expect(updateMessage.mock.calls.at(-1)![1].metadata).toMatchObject({
      streaming: false,
      interrupted: true,
    });
  });

  it('flush после dispose не пишет ничего', async () => {
    const { draft, updateMessage } = await makeDirtyDraft();

    await draft.dispose();
    await draft.flush();

    expect(updateMessage).not.toHaveBeenCalled();
  });

  it('не применённая финальная запись (updateMessage → null) — предупреждение с id сообщения', async () => {
    const warn = vi.fn();
    const { draft } = await makeDirtyDraft({ warn, updateMessageImpl: async () => null });
    const id = draft.messageId();

    const ref = await draft.finalize({ content: 'финал', parts: [makeTextPart('финал')] });

    // Финализация не бросает и не теряет ссылку на запись.
    expect(ref).toEqual(draft.ref());
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toBe(
      `StreamMessageDraft: финальная запись шага не применена (сообщение не найдено): ${id}`,
    );
    expect(warn.mock.calls[0]![0]).not.toContain('не удалось финализировать');
  });

  it('не применённое сохранение прерванного стрима (updateMessage → null) — предупреждение с id', async () => {
    const warn = vi.fn();
    const { draft } = await makeDirtyDraft({ warn, updateMessageImpl: async () => null });
    const id = draft.messageId();

    await draft.abort('причина', 'cancelled');

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toBe(
      `StreamMessageDraft: прерванный стрим не сохранён (сообщение не найдено): ${id}`,
    );
  });

  it('не применённая промежуточная запись (updateMessage → null) — одно предупреждение без спама', async () => {
    const warn = vi.fn();
    const { draft, updateMessage } = await makeDirtyDraft({
      warn,
      updateMessageImpl: async () => null,
    });
    const id = draft.messageId();

    await draft.flush();
    draft.push('abc', '');
    await draft.flush();

    expect(updateMessage).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toBe(
      `StreamMessageDraft: частичный стрим не обновлён (сообщение не найдено): ${id}`,
    );

    await draft.dispose();
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextOptimizer } from './optimizer.js';
import { ContextConfig } from './config.js';
import { BaseProvider } from '../../providers/base.js';
import { MessageRole, nowISO, makeTextPart } from '@itphx/synth-shared';
import type { LLMChunk, LLMResponse, Session, Message, TokenUsage } from '@itphx/synth-shared';

/** Мок провайдера: delta-чанки + финальный чанк с ПОЛНЫМ контентом (как реальный openai.ts). */
class MockStreamProvider extends BaseProvider {
  async chat(): Promise<LLMResponse> {
    return { content: 'итог', model: this.model, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
  }

  async *chatAsync(): AsyncGenerator<LLMChunk> {
    yield { content: 'ит', isFinal: false, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
    yield { content: 'ог', isFinal: false, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
    yield { content: 'итог', isFinal: true, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
  }

  getProviderName(): string {
    return 'mock-sum';
  }
}

function makeSession(): Session {
  return {
    id: 's1',
    parent_id: null,
    project_id: null,
    agent: 'developer',
    title: 'test',
    mode: 'act',
    settings: {
      language: 'ru',
      provider: 'mock',
      model: 'mock-model',
      temperature: 0.7,
      summarizationEnabled: true,
      summarizationTriggerMode: 'manual',
    },
    messages: [
      { id: 'm1', role: 'user', content: 'привет', seq: 1, origin: 'local', created_at: new Date().toISOString(), disabled: false, pinned: false, hidden: false },
      { id: 'm2', role: 'assistant', content: 'здравствуй', seq: 2, origin: 'local', created_at: new Date().toISOString(), disabled: false, pinned: false, hidden: false },
    ],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  } as unknown as Session;
}

describe('ContextOptimizer.summarizeStream', () => {
  let tmpDir: string;
  let optimizer: ContextOptimizer;
  let mockProvider: MockStreamProvider;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-opt-'));
    mockProvider = new MockStreamProvider({ url: 'http://mock', apiKey: 'k', model: 'mock-model' });
    const config = new ContextConfig({ userDataDir: tmpDir });
    optimizer = new ContextOptimizer(config, () => null, {
      provider: 'mock',
      model: 'mock-model',
      temperature: 0.3,
      promptFile: 'SUMMARIZER',
    });
    // Подменяем фабрику провайдера: всегда возвращаем мок с delta + финальным чанком.
    const proto = ContextOptimizer.prototype as unknown as {
      _createSummarizationProvider: () => BaseProvider;
    };
    vi.spyOn(proto, '_createSummarizationProvider').mockReturnValue(mockProvider);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('финальный чанк полного контента НЕ дублирует суммаризацию', async () => {
    const session = makeSession();
    const chunks: string[] = [];
    let doneContent = '';

    for await (const ev of optimizer.summarizeStream(session)) {
      if (ev.type === 'chunk') chunks.push(ev.content);
      if (ev.type === 'done') doneContent = ev.content;
    }

    // Финальный чанк («итог») не отдаётся как отдельный фрагмент UI
    expect(chunks.join('')).toBe('итог');
    // Итоговый контент — однократный (не «итогитог»)
    expect(doneContent).toBe('итог');
  });

  it('без финального чанка суммаризация собирается из delta-чанков', async () => {
    mockProvider.chatAsync = async function* () {
      yield { content: 'а', isFinal: false, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
      yield { content: 'б', isFinal: false, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
    };

    const session = makeSession();
    const chunks: string[] = [];
    let doneContent = '';

    for await (const ev of optimizer.summarizeStream(session)) {
      if (ev.type === 'chunk') chunks.push(ev.content);
      if (ev.type === 'done') doneContent = ev.content;
    }

    expect(chunks.join('')).toBe('аб');
    expect(doneContent).toBe('аб');
  });
});

// ====================================================================
// Скользящее окно в токен-режиме: «ход» (tool-chain) — атомарная единица
// ====================================================================

function tok(total: number): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, totalTokens: total };
}

/** Сообщение с полным набором полей Message (usage — источник токенов). */
function makeMsg(
  partial: Partial<Message> & { id: string; role: MessageRole; content: string },
): Message {
  return {
    seq: 0,
    origin: 'local',
    parts: [makeTextPart(partial.content)],
    createdAt: nowISO(),
    disabled: false,
    pinned: false,
    hidden: false,
    ...partial,
  } as Message;
}

/**
 * Сессия с 4 «ходами»: три простых (user+assistant) и самый свежий — tool-chain
 * (user + assistant(toolUse) + tool + финальный assistant) с общим stream_id.
 * Токены: tool-результат дороже остальных — при бюджете ~160 старый
 * поштучный отбор обрезал бы ход на середине (tool без assistant(toolUse)).
 */
function makeTurnSession(): Session {
  const messages: Message[] = [
    // Ход 1 (самый старый): 120 токенов
    makeMsg({ id: 'u1', role: MessageRole.USER, content: 'u1', metadata: { stream_id: 'st1' }, usage: tok(60) }),
    makeMsg({ id: 'a1', role: MessageRole.ASSISTANT, content: 'a1', metadata: { stream_id: 'st1' }, usage: tok(60) }),
    // Ход 2: 120 токенов
    makeMsg({ id: 'u2', role: MessageRole.USER, content: 'u2', metadata: { stream_id: 'st2' }, usage: tok(60) }),
    makeMsg({ id: 'a2', role: MessageRole.ASSISTANT, content: 'a2', metadata: { stream_id: 'st2' }, usage: tok(60) }),
    // Ход 3: 120 токенов
    makeMsg({ id: 'u3', role: MessageRole.USER, content: 'u3', metadata: { stream_id: 'st3' }, usage: tok(60) }),
    makeMsg({ id: 'a3', role: MessageRole.ASSISTANT, content: 'a3', metadata: { stream_id: 'st3' }, usage: tok(60) }),
    // Ход 4 (самый свежий) — tool-chain: 280 токенов суммарно
    makeMsg({ id: 'u4', role: MessageRole.USER, content: 'u4', metadata: { stream_id: 'st4' }, usage: tok(60) }),
    makeMsg({
      id: 'a4tc',
      role: MessageRole.ASSISTANT,
      content: 'a4tc',
      toolCalls: [{ id: 'call_x', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
      metadata: { stream_id: 'st4', tool_chain: true },
      usage: tok(60),
    }),
    makeMsg({ id: 't4', role: MessageRole.TOOL, content: 't4', toolCallId: 'call_x', metadata: { stream_id: 'st4', tool_chain: true }, usage: tok(100) }),
    makeMsg({ id: 'a4f', role: MessageRole.ASSISTANT, content: 'a4f', metadata: { stream_id: 'st4' }, usage: tok(60) }),
  ];

  return {
    id: 's-window',
    settings: {
      model: 'gpt-4', // контекстное окно 8192; порог 2% → maxTokens = 163
      slidingWindowMode: 'tokens',
      slidingWindowTokenThreshold: 2,
      slidingWindowMessageLimit: 10,
      contextOptimization: 'sliding_window',
      temperature: 0.7,
      maxTokens: 4096,
      debugEnabled: false,
      streamEnabled: true,
      summarizationEnabled: false,
      summarizationTriggerMode: 'messages',
      summarizeAfterN: 10,
      summarizeTokenThreshold: 50,
      summarizationHeadMessages: 2,
      summarizationTailMessages: 3,
      showInterview: false,
      websocketEnabled: false,
      routingEnabled: false,
      routingStrategy: 'auto',
      routingContent: {},
      routingEscalation: { enabled: false, fallbackProvider: '', fallbackModel: '', checks: [], minLength: 10 },
      routingCost: { enabled: false, cheapProvider: '', cheapModel: '', maxCheapTokens: 500 },
      subagentRouting: { enabled: false },
      microFirst: false,
      microConfidenceThreshold: 0.8,
      embeddingEnabled: false,
    } as unknown as Session['settings'],
    messages,
  } as unknown as Session;
}

/** Проверка инварианта: в наборе нет «сирот» — assistant(toolUse) без tool-результата и наоборот. */
function expectNoOrphanToolChain(messages: Message[]): void {
  const assistantCallIds = new Set<string>();
  for (const m of messages) {
    if (m.role === MessageRole.ASSISTANT && Array.isArray(m.toolCalls)) {
      for (const tc of m.toolCalls) {
        if (tc.id) assistantCallIds.add(tc.id as string);
      }
    }
  }
  const toolResultIds = new Set<string>();
  for (const m of messages) {
    if (m.role === MessageRole.TOOL && m.toolCallId) toolResultIds.add(m.toolCallId);
  }
  for (const id of toolResultIds) {
    expect(assistantCallIds.has(id), `tool ${id} без парного assistant(toolUse)`).toBe(true);
  }
  for (const id of assistantCallIds) {
    expect(toolResultIds.has(id), `assistant(toolUse) ${id} без парного tool-результата`).toBe(true);
  }
}

describe('ContextOptimizer — токен-окно: «ход» (tool-chain) как атомарная единица', () => {
  let tmpDir: string;
  let optimizer: ContextOptimizer;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-opt-window-'));
    optimizer = new ContextOptimizer(
      new ContextConfig({ userDataDir: tmpDir }),
      () => null,
      { provider: 'mock', model: 'mock-model', temperature: 0.3, promptFile: 'SUMMARIZER' },
    );
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function getMessagesForSlidingWindow(session: Session): Message[] {
    return (optimizer as unknown as {
      _getMessagesForSlidingWindow(s: Session): Message[];
    })._getMessagesForSlidingWindow(session);
  }

  it('при маленьком бюджете окно содержит самый свежий ход ЦЕЛИКОМ (не разрывает tool-chain)', () => {
    const session = makeTurnSession();
    const window = getMessagesForSlidingWindow(session);

    // maxTokens = floor(8192 * 0.02) = 163; ход st4 (280 токенов) добавляется
    // всегда, старые ходы (120 токенов каждый) не помещаются
    expect(window.map((m) => m.id)).toEqual(['u4', 'a4tc', 't4', 'a4f']);
    expectNoOrphanToolChain(window);
  });

  it('applySlidingWindow отключает только целые ходы — tool-chain не обрезается', () => {
    const session = makeTurnSession();
    const result = optimizer.applySlidingWindow(session);

    expect(result.disabledCount).toBe(6);
    const activeIds = session.messages.filter((m) => !m.disabled).map((m) => m.id);
    expect(activeIds).toEqual(['u4', 'a4tc', 't4', 'a4f']);
    expectNoOrphanToolChain(session.messages.filter((m) => !m.disabled));
  });

  it('при большом бюджете окно не трогает сообщения вообще', () => {
    const session = makeTurnSession();
    session.settings.slidingWindowTokenThreshold = 100; // maxTokens = 8192 — всё помещается
    const window = getMessagesForSlidingWindow(session);
    expect(window.map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2', 'u3', 'a3', 'u4', 'a4tc', 't4', 'a4f']);

    const session2 = makeTurnSession();
    session2.settings.slidingWindowTokenThreshold = 100;
    const result = optimizer.applySlidingWindow(session2);
    expect(result.disabledCount).toBe(0);
  });

  it('messages-режим по-прежнему режет по user-сообщению, не разрывая tool-chain', () => {
    const session = makeTurnSession();
    session.settings.slidingWindowMode = 'messages';
    session.settings.slidingWindowMessageLimit = 1;
    const result = optimizer.applySlidingWindow(session);

    expect(result.disabledCount).toBe(6);
    const activeIds = session.messages.filter((m) => !m.disabled).map((m) => m.id);
    expect(activeIds).toEqual(['u4', 'a4tc', 't4', 'a4f']);
    expectNoOrphanToolChain(session.messages.filter((m) => !m.disabled));
  });
});

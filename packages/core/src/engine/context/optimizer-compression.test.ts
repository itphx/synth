import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageRole, makeTextPart, nowISO } from '@itphx/synth-shared';
import type { LLMResponse, Message, Session, TokenUsage } from '@itphx/synth-shared';
import { ContextOptimizer } from './optimizer.js';
import { ContextConfig } from './config.js';
import { BaseProvider } from '../../providers/base.js';

class MockCompressionProvider extends BaseProvider {
  static response: LLMResponse = {
    content: '## Objective\nцель\n\n## Work State\n- готово',
    model: 'mock-compressor',
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  };

  async chat(): Promise<LLMResponse> {
    return MockCompressionProvider.response;
  }

  async *chatAsync() {
    yield { content: MockCompressionProvider.response.content, isFinal: true, usage: MockCompressionProvider.response.usage };
  }

  getProviderName(): string {
    return 'mock-compressor';
  }
}

function settings(patch: Partial<Session['settings']> = {}): Session['settings'] {
  return {
    provider: 'mock',
    model: 'mock-model',
    contextOptimization: 'compaction',
    summarizationEnabled: true,
    summarizationTriggerMode: 'messages',
    summarizeAfterN: 10,
    summarizeTokenThreshold: 50,
    summarizationKeepTokens: 5000,
    compactionKeepTokens: 15000,
    compactionTokenThreshold: 85,
    slidingWindowMode: 'messages',
    slidingWindowMessageLimit: 10,
    slidingWindowTokenThreshold: 80,
    ...patch,
  } as unknown as Session['settings'];
}

function msg(
  id: string,
  role: MessageRole,
  content: string,
  patch: Partial<Message> = {},
): Message {
  return {
    id,
    role,
    seq: 0,
    origin: 'local',
    parts: [makeTextPart(content)],
    content,
    createdAt: nowISO(),
    disabled: false,
    pinned: false,
    hidden: false,
    ...patch,
  } as Message;
}

function session(messages: Message[], patch: Partial<Session['settings']> = {}): Session {
  return {
    id: 's-compress',
    settings: settings(patch),
    messages,
  } as unknown as Session;
}

function tok(total: number): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, totalTokens: total };
}

describe('ContextOptimizer — граница хвоста сжатия', () => {
  let tmpDir: string;
  let optimizer: ContextOptimizer;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-opt-compress-'));
    optimizer = new ContextOptimizer(
      new ContextConfig({ userDataDir: tmpDir }),
      () => null,
      { provider: 'mock', model: 'mock-compressor', temperature: 0.1, promptFile: 'COMPACTOR' },
      () => 200_000,
    );
    vi.spyOn(
      ContextOptimizer.prototype as unknown as { _createSummarizationProvider: () => BaseProvider },
      '_createSummarizationProvider',
    ).mockReturnValue(
      new MockCompressionProvider({ url: 'http://mock', apiKey: 'k', model: 'mock-compressor' }),
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('бюджет хвоста + user-граница: старые ходы покрываются, хвост начинается с user', () => {
    const s = session([
      msg('u1', MessageRole.USER, 'u1', { usage: tok(100) }),
      msg('a1', MessageRole.ASSISTANT, 'a1', { usage: tok(100) }),
      msg('u2', MessageRole.USER, 'u2', { usage: tok(100) }),
      msg('a2', MessageRole.ASSISTANT, 'a2', { usage: tok(100) }),
    ], { compactionKeepTokens: 250 });

    const plan = optimizer.prepareCompression(s, 'ru');
    expect(plan.coveredIndices).toEqual([0, 1]);
    expect(plan.keepFromIndex).toBe(2);
    expect(plan.keepFromId).toBe('u2');
    expect(plan.messagesToCompress.map((m) => m.id)).toEqual(['u1', 'a1']);
    expect(plan.keepMessages.map((m) => m.id)).toEqual(['u2', 'a2']);
  });

  it('keepTokens: 0 → хвоста нет (покрыты все кандидаты)', () => {
    const s = session([
      msg('u1', MessageRole.USER, 'u1'),
      msg('a1', MessageRole.ASSISTANT, 'a1'),
    ]);
    const plan = optimizer.prepareCompression(s, 'ru', { keepTokens: 0 });
    expect(plan.coveredIndices).toEqual([0, 1]);
    expect(plan.keepFromIndex).toBe(-1);
    expect(plan.keepMessages).toEqual([]);
  });

  it('pinned не покрывается и не считается хвостом', () => {
    const s = session([
      msg('u1', MessageRole.USER, 'u1', { usage: tok(100) }),
      msg('a1', MessageRole.ASSISTANT, 'a1', { usage: tok(100), pinned: true }),
      msg('u2', MessageRole.USER, 'u2', { usage: tok(100) }),
      msg('a2', MessageRole.ASSISTANT, 'a2', { usage: tok(100) }),
    ], { compactionKeepTokens: 250 });

    const plan = optimizer.prepareCompression(s, 'ru');
    // a1 pinned — исключён из кандидатов; бюджет 250 → хвост u2/a2.
    expect(plan.coveredIndices).toEqual([0]);
    expect(plan.messagesToCompress.map((m) => m.id)).toEqual(['u1']);
    expect(plan.keepMessages.map((m) => m.id)).toEqual(['u2', 'a2']);
  });

  it('нет user-границы → хвост пуст', () => {
    const s = session([
      msg('a1', MessageRole.ASSISTANT, 'a1', { usage: tok(100) }),
      msg('t1', MessageRole.TOOL, 't1', { usage: tok(100), toolCallId: 'c1' }),
    ]);
    const plan = optimizer.prepareCompression(s, 'ru');
    expect(plan.coveredIndices).toEqual([0, 1]);
    expect(plan.keepFromIndex).toBe(-1);
  });

  it('minKeepFromIndex защищает текущий ход от покрытия', () => {
    const s = session([
      msg('u1', MessageRole.USER, 'u1', { usage: tok(100) }),
      msg('a1', MessageRole.ASSISTANT, 'a1', { usage: tok(100) }),
      msg('u2', MessageRole.USER, 'u2', { usage: tok(100) }),
    ], { compactionKeepTokens: 0 });
    const plan = optimizer.prepareCompression(s, 'ru', { keepTokens: 0, minKeepFromIndex: 2 });
    expect(plan.coveredIndices).toEqual([0, 1]);
    expect(plan.keepFromIndex).toBe(2);
    expect(plan.keepFromId).toBe('u2');
  });
});

describe('ContextOptimizer — рендер транскрипта (summarization / compaction)', () => {
  let tmpDir: string;
  let optimizer: ContextOptimizer;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-opt-render-'));
    optimizer = new ContextOptimizer(
      new ContextConfig({ userDataDir: tmpDir }),
      () => null,
      { provider: 'mock', model: 'mock-compressor', temperature: 0.1, promptFile: 'COMPACTOR' },
      () => 200_000,
    );
    vi.spyOn(
      ContextOptimizer.prototype as unknown as { _createSummarizationProvider: () => BaseProvider },
      '_createSummarizationProvider',
    ).mockReturnValue(
      new MockCompressionProvider({ url: 'http://mock', apiKey: 'k', model: 'mock-compressor' }),
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  function renderSession(): Session {
    const longArgs = `{"file_path":"${'a'.repeat(600)}.ts"}`;
    const longResult = 'R'.repeat(3000);
    return session([
      msg('u1', MessageRole.USER, 'пользовательский запрос'),
      msg('a1', MessageRole.ASSISTANT, 'ответ ассистента', {
        reasoning: 'секретное размышление',
        toolCalls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: longArgs } }],
      }),
      msg('t1', MessageRole.TOOL, longResult, {
        toolCallId: 'c1',
        metadata: { tool_name: 'read_file' },
      }),
      msg('u2', MessageRole.USER, 'вложение', {
        parts: [makeTextPart('вложение'), {
          id: 'p1',
          type: 'image',
          data: { blobPath: 'attachments/x', sha256: 'a'.repeat(64), mime: 'image/png', size: 10 },
        }],
      }),
    ]);
  }

  it('summarization: tool_use/tool-результат попадают, args ≤200, результат ≤300, reasoning нет', () => {
    const plan = optimizer.prepareCompression(renderSession(), 'ru', {
      mode: 'summarization',
      keepTokens: 0,
    });
    const text = plan.llmMessages[0]!.content;
    expect(text).toContain('[Вызов] read_file(');
    expect(text).toContain('[Результат] read_file: ok — ');
    expect(text).toContain('…');
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toContain('секретное размышление');
    expect(text).not.toContain('R'.repeat(400));
    expect(text).toContain('[Вложение: image/png]');
  });

  it('compaction: args и результат до 2000 символов, есть блок предыдущего резюме', () => {
    const s = renderSession();
    s.messages.unshift(msg('sum0', MessageRole.SUMMARY, 'предыдущий итог'));
    const plan = optimizer.prepareCompression(s, 'ru', {
      mode: 'compaction',
      keepTokens: 0,
    });
    const text = plan.llmMessages[0]!.content;
    expect(text).toContain('## Предыдущее резюме');
    expect(text).toContain('предыдущий итог');
    expect(text).toContain('a'.repeat(300));
    expect(text).toContain('R'.repeat(500));
    expect(text).not.toContain('R'.repeat(2500));
    expect(text).not.toContain('секретное размышление');
  });

  it('compaction добавляет хвост отдельной секцией, когда он влезает в окно', () => {
    const s = session([
      msg('u1', MessageRole.USER, 'старое', { usage: tok(100) }),
      msg('a1', MessageRole.ASSISTANT, 'старый ответ', { usage: tok(100) }),
      msg('u2', MessageRole.USER, 'новое', { usage: tok(100) }),
    ], { compactionKeepTokens: 150 });
    const plan = optimizer.prepareCompression(s, 'ru');
    const text = plan.llmMessages[0]!.content;
    expect(plan.coveredIndices).toEqual([0, 1]);
    expect(text).toContain('## Последние сообщения (останутся у агента дословно)');
    expect(text).toContain('новое');
  });

  it('M8: маленькое окно (2000) — старые выбрасываются, последний user сохранён, вызов не бросает', () => {
    const small = new ContextOptimizer(
      new ContextConfig({ userDataDir: tmpDir }),
      () => null,
      { provider: 'mock', model: 'mock-compressor', temperature: 0.1, promptFile: 'COMPACTOR' },
      () => 2000,
    );
    const s = session([
      msg('u1', MessageRole.USER, `OLD-${'x'.repeat(5000)}`),
      msg('a1', MessageRole.ASSISTANT, `OLD-A-${'y'.repeat(5000)}`),
      msg('u2', MessageRole.USER, 'LAST-USER'),
    ]);
    const plan = small.prepareCompression(s, 'ru', { mode: 'compaction', keepTokens: 0 });
    const text = plan.llmMessages[0]!.content;
    expect(text).toContain('LAST-USER');
    expect(text).toContain('старых сообщений опущено');
    expect(text).not.toContain('OLD-');
  });

  it('M8: окно 128k, всё влезает — полные тексты без маркера', () => {
    const large = new ContextOptimizer(
      new ContextConfig({ userDataDir: tmpDir }),
      () => null,
      { provider: 'mock', model: 'mock-compressor', temperature: 0.1, promptFile: 'COMPACTOR' },
      () => 128_000,
    );
    const s = session([
      msg('u1', MessageRole.USER, 'запрос'),
      msg('a1', MessageRole.ASSISTANT, 'ответ', {
        toolCalls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: `{"p":"${'a'.repeat(1500)}"}` } }],
      }),
      msg('t1', MessageRole.TOOL, `RESULT-${'R'.repeat(1500)}`, { toolCallId: 'c1' }),
      msg('u2', MessageRole.USER, 'дальше'),
    ]);
    const plan = large.prepareCompression(s, 'ru', { mode: 'compaction', keepTokens: 0 });
    const text = plan.llmMessages[0]!.content;
    expect(text).toContain('a'.repeat(1000));
    expect(text).toContain('R'.repeat(1000));
    expect(text).not.toContain('старых сообщений опущено');
  });

  it('m1: summarization не видит дословных тел успешных тулов, ошибки важны', () => {
    const s = session([
      msg('u1', MessageRole.USER, 'запрос'),
      msg('a1', MessageRole.ASSISTANT, 'вызов', {
        toolCalls: [
          { id: 'c1', type: 'function', function: { name: 'read_file', arguments: `{"p":"${'a'.repeat(600)}"}` } },
          { id: 'c2', type: 'function', function: { name: 'shell', arguments: '{"cmd":"x"}' } },
        ],
      }),
      msg('t1', MessageRole.TOOL, `first line\n${'R'.repeat(1000)}`, { toolCallId: 'c1' }),
      msg('t2', MessageRole.TOOL, `Error: ${'E'.repeat(1000)}`, { toolCallId: 'c2' }),
      msg('u2', MessageRole.USER, 'дальше'),
    ]);
    const plan = optimizer.prepareCompression(s, 'ru', { mode: 'summarization', keepTokens: 0 });
    const text = plan.llmMessages[0]!.content;
    // успешный результат — только первая строка, без тела
    expect(text).toContain('ok — first line');
    expect(text).not.toContain('R'.repeat(200));
    // ошибка — сохраняется до 300 (не обрезается до нуля)
    expect(text).toContain('error — ');
    expect(text).toContain('E'.repeat(200));
    // args — до 120
    expect(text).not.toContain('a'.repeat(200));
  });

  it('m2: английские метки транскрипта при language=en', () => {
    const plan = optimizer.prepareCompression(renderSession(), 'en', {
      mode: 'compaction',
      keepTokens: 0,
    });
    const text = plan.llmMessages[0]!.content;
    expect(text).toContain('[User]');
    expect(text).toContain('[Assistant]');
    expect(text).toContain('[Tool call]');
    expect(text).toContain('[Tool result]');
    expect(text).toContain('[Attachment: image/png]');
    expect(text).not.toContain('[Пользователь]');
    expect(text).not.toContain('[Результат]');
  });
});

describe('ContextOptimizer — shouldCompress / effectiveMode', () => {
  let tmpDir: string;
  let optimizer: ContextOptimizer;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-opt-trigger-'));
    optimizer = new ContextOptimizer(
      new ContextConfig({ userDataDir: tmpDir }),
      () => null,
      { provider: 'mock', model: 'mock-model', temperature: 0.1, promptFile: 'SUMMARIZER' },
      () => 200_000,
    );
    vi.spyOn(
      ContextOptimizer.prototype as unknown as { _createSummarizationProvider: () => BaseProvider },
      '_createSummarizationProvider',
    ).mockReturnValue(
      new MockCompressionProvider({ url: 'http://mock', apiKey: 'k', model: 'mock-compressor' }),
    );
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('B1: после сжатия getMessagesForLlm = [SUMMARY, ...живой хвост] без потерь', () => {
    const summary = msg('sum', MessageRole.SUMMARY, 'итог', { summaryOf: [0, 1] });
    const tool = msg('t1', MessageRole.TOOL, 'tool result', {
      toolCallId: 'c1',
      metadata: { tool_name: 'read_file' },
    });
    const pinned = msg('u-pin', MessageRole.USER, 'pinned', { pinned: true });
    const s = session([
      msg('u1', MessageRole.USER, 'old', { disabled: true }),
      msg('a1', MessageRole.ASSISTANT, 'old answer', { disabled: true }),
      tool,
      pinned,
      summary,
    ]);
    const out = optimizer.getMessagesForLlm(s);
    expect(out.map((m) => m.id)).toEqual(['sum', 't1', 'u-pin']);
    expect(out.some((m) => m.id === 't1')).toBe(true);
    expect(out.some((m) => m.id === 'u-pin')).toBe(true);
  });

  it('M1: cache/reasoning не считаются дважды (input+output)', () => {
    const s = session([
      msg('u1', MessageRole.USER, 'история'),
      msg('a1', MessageRole.ASSISTANT, 'ответ', {
        model: 'mock-model',
        provider: 'mock',
        usage: {
          inputTokens: 100_000,
          outputTokens: 1_000,
          totalTokens: 191_000,
          cacheReadTokens: 90_000,
          cacheWriteTokens: 0,
          reasoningTokens: 500,
        },
      }),
    ], { compactionTokenThreshold: 85 });
    expect(optimizer.estimatePromptTokens(s)).toBe(101_000);
  });

  it('M2: после сжатия старое измерение неактуально — триггер снят', () => {
    const s = session([
      msg('u1', MessageRole.USER, 'old', { disabled: true }),
      msg('a1', MessageRole.ASSISTANT, 'old long answer', {
        disabled: true,
        model: 'mock-model',
        provider: 'mock',
        usage: { inputTokens: 190_000, outputTokens: 0, totalTokens: 190_000 },
      }),
      msg('u2', MessageRole.USER, 'new tail'),
      msg('sum', MessageRole.SUMMARY, 'итог', { summaryOf: [0, 1] }),
    ], { compactionTokenThreshold: 85 });
    // окно 200000, порог 170000; без M2 measured usage дал бы triggered.
    expect(optimizer.estimatePromptTokens(s)).toBeLessThan(170_000);
    expect(optimizer.shouldCompress(s)).toMatchObject({ triggered: false, mode: 'compaction' });
  });

  it('M3: весь объём в одном ходе → капать нечего (canCompress=false)', () => {
    const s = session([
      msg('u1', MessageRole.USER, 'единственный запрос'),
      msg('a1', MessageRole.ASSISTANT, 'ответ', {
        model: 'mock-model',
        provider: 'mock',
        usage: { inputTokens: 180_000, outputTokens: 0, totalTokens: 180_000 },
      }),
    ], { compactionTokenThreshold: 85 });
    expect(optimizer.shouldCompress(s).triggered).toBe(true);
    expect(optimizer.canCompress(s)).toBe(false);
  });

  it('M7: окно 16000 — резерв съедает окно, авто-триггер выключен', () => {
    const small = new ContextOptimizer(
      new ContextConfig({ userDataDir: tmpDir }),
      () => null,
      { provider: 'mock', model: 'mock-model', temperature: 0.1, promptFile: 'SUMMARIZER' },
      () => 16_000,
    );
    const s = session([
      msg('u1', MessageRole.USER, 'история'),
      msg('a1', MessageRole.ASSISTANT, 'ответ', {
        model: 'mock-model',
        provider: 'mock',
        usage: { inputTokens: 15_000, outputTokens: 0, totalTokens: 15_000 },
      }),
    ], { compactionTokenThreshold: 85 });
    expect(small.shouldCompress(s)).toMatchObject({ triggered: false, mode: 'compaction' });
  });

  it('m4: явный summarization работает без summarizationEnabled', () => {
    const s = session([
      msg('u1', MessageRole.USER, 'a'),
      msg('a1', MessageRole.ASSISTANT, 'b'),
    ], {
      contextOptimization: 'summarization',
      summarizationEnabled: false,
      summarizationTriggerMode: 'messages',
      summarizeAfterN: 1,
    });
    expect(optimizer.shouldCompress(s)).toMatchObject({ triggered: true, mode: 'summarization' });
  });

  it('легаси: contextOptimization=none + summarizationEnabled → summarization', () => {
    const s = session([msg('u1', MessageRole.USER, 'a')], {
      contextOptimization: 'none',
      summarizationEnabled: true,
    });
    expect(optimizer.effectiveMode(s)).toBe('summarization');
  });

  it('message-триггер суммаризации', () => {
    const s = session([
      msg('u1', MessageRole.USER, 'a'),
      msg('a1', MessageRole.ASSISTANT, 'b'),
    ], {
      contextOptimization: 'summarization',
      summarizationEnabled: true,
      summarizationTriggerMode: 'messages',
      summarizeAfterN: 2,
    });
    const result = optimizer.shouldCompress(s);
    expect(result).toMatchObject({ triggered: false, mode: 'summarization' });
    s.messages.push(msg('u2', MessageRole.USER, 'c'));
    expect(optimizer.shouldCompress(s)).toMatchObject({
      triggered: true,
      reason: 'messages',
      mode: 'summarization',
      userCount: 2,
      limit: 2,
    });
  });

  it('compaction: measured usage + оценка хвоста, порог от окна', () => {
    const s = session([
      msg('u1', MessageRole.USER, 'история'),
      msg('a1', MessageRole.ASSISTANT, 'ответ', {
        model: 'mock-model',
        provider: 'mock',
        usage: { inputTokens: 170_000, outputTokens: 0, totalTokens: 0 },
      }),
    ], {
      compactionTokenThreshold: 85,
    });
    // окно 200000, резерв max(30000,16000)=30000, порог 170000
    expect(optimizer.shouldCompress(s)).toMatchObject({
      triggered: true,
      reason: 'tokens',
      mode: 'compaction',
      currentTokens: 170_000,
      threshold: 170_000,
    });
    s.messages[1]!.usage = { inputTokens: 100_000, outputTokens: 0, totalTokens: 0 };
    expect(optimizer.shouldCompress(s).triggered).toBe(false);
  });

  it('неизвестное окно (0) не включает авто-триггер', () => {
    const noWindow = new ContextOptimizer(
      new ContextConfig({ userDataDir: tmpDir }),
      () => null,
      { provider: 'mock', model: 'mock-model', temperature: 0.1, promptFile: 'SUMMARIZER' },
      () => 0,
    );
    const s = session([
      msg('u1', MessageRole.USER, 'a'),
      msg('a1', MessageRole.ASSISTANT, 'b', {
        model: 'mock-model',
        usage: { inputTokens: 999_999, outputTokens: 0, totalTokens: 0 },
      }),
    ], { model: 'unknown-model-xyz', compactionTokenThreshold: 85 });
    expect(noWindow.shouldCompress(s)).toMatchObject({ triggered: false, mode: 'compaction' });
  });

  it('старый SUMMARY без keepFrom не ломает план', () => {
    const s = session([
      msg('sum0', MessageRole.SUMMARY, 'старый итог', { summaryOf: [0, 1] }),
      msg('u1', MessageRole.USER, 'новый запрос'),
      msg('a1', MessageRole.ASSISTANT, 'ответ'),
      msg('u2', MessageRole.USER, 'следующий'),
    ], { compactionKeepTokens: 1 });
    const plan = optimizer.prepareCompression(s, 'ru');
    expect(plan.coveredIndices).toEqual([1, 2]);
    expect(plan.keepFromIndex).toBe(3);
    expect(plan.llmMessages[0]!.content).toContain('## Предыдущее резюме');
  });
});

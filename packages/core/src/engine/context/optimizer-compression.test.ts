import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageRole, makeTextPart, nowISO } from '@itphx/synth-shared';
import type { LLMResponse, Message, Session, TokenUsage } from '@itphx/synth-shared';
import { ContextOptimizer, CompressionCancelledError, validateCompressionContent } from './optimizer.js';
import { ContextConfig } from './config.js';
import { BaseProvider } from '../../providers/base.js';
import type { CancellationToken } from '../../providers/base.js';
import { hasValidToolPairs } from '../orchestrator/overflow.js';
import { sessionMessagesToLlm } from '../orchestrator/prompt-info.js';

class MockCompressionProvider extends BaseProvider {
  static response: LLMResponse = {
    content: '## Objective\nцель\n\n## Work State\n- готово',
    model: 'mock-compressor',
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  };
  /** Счётчик потоковых вызовов (`chatAsync`). */
  static chatAsyncCalls = 0;
  /** Токен, который провайдер отменяет прямо в стриме (тест отмены). */
  static cancelToken: CancellationToken | null = null;

  async chat(): Promise<LLMResponse> {
    return MockCompressionProvider.response;
  }

  async *chatAsync() {
    MockCompressionProvider.chatAsyncCalls += 1;
    MockCompressionProvider.cancelToken?.cancel();
    yield { content: MockCompressionProvider.response.content, isFinal: true, usage: MockCompressionProvider.response.usage };
  }

  getProviderName(): string {
    return 'mock-compressor';
  }
}

/** Провайдер со счётчиком непотоковых вызовов (`chat`). */
class CountingCompressionProvider extends BaseProvider {
  static chatCalls = 0;
  static content = '## Objective\nцель\n\n## Work State\n- готово';

  async chat(): Promise<LLMResponse> {
    CountingCompressionProvider.chatCalls += 1;
    return {
      content: CountingCompressionProvider.content,
      model: 'mock-compressor',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    };
  }

  async *chatAsync() {
    yield { content: CountingCompressionProvider.content, isFinal: true, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
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

/** Граница хвоста напрямую (приватный метод оптимизатора). */
interface CompressionBoundary {
  coveredIndices: number[];
  keepFromIndex: number;
  keepFromId?: string;
  messages: Message[];
  keepMessages: Message[];
}

function boundary(
  optimizer: ContextOptimizer,
  s: Session,
  opts: { minKeepFromIndex?: number; keepTokens?: number } = {},
): CompressionBoundary {
  const private_ = optimizer as unknown as {
    _buildCompressionBoundary: (
      session: Session,
      mode: string,
      minKeepFromIndex?: number,
      keepTokens?: number,
    ) => CompressionBoundary;
  };
  return private_._buildCompressionBoundary(
    s,
    'compaction',
    opts.minKeepFromIndex,
    opts.keepTokens,
  );
}

/** Сессия «1 user + N шагов (assistant с вызовом → tool)». */
function longTurnSession(steps: number, tokensPerMessage = 100): Session {
  const messages: Message[] = [msg('u0', MessageRole.USER, 'длинный запрос', { usage: tok(tokensPerMessage) })];
  for (let i = 0; i < steps; i++) {
    messages.push(msg(`a${i}`, MessageRole.ASSISTANT, `шаг ${i}`, {
      usage: tok(tokensPerMessage),
      toolCalls: [{
        id: `c${i}`,
        type: 'function',
        function: { name: 'read_file', arguments: '{"file_path":"a.ts"}' },
      }],
    }));
    messages.push(msg(`t${i}`, MessageRole.TOOL, `результат ${i}`, {
      usage: tok(tokensPerMessage),
      toolCallId: `c${i}`,
      metadata: { tool_name: 'read_file' },
    }));
  }
  return session(messages, { compactionKeepTokens: 15_000 });
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

  it('нет user-границы → хвост начинается с шага (assistant), покрытия нет', () => {
    const s = session([
      msg('a1', MessageRole.ASSISTANT, 'a1', { usage: tok(100) }),
      msg('t1', MessageRole.TOOL, 't1', { usage: tok(100), toolCallId: 'c1' }),
    ]);
    // Срез по шагу: хвост — весь кандидатный список (начинается с
    // assistant), покрывать нечего → сжатие падает на пустом покрытии
    // (корректно: лучше отказ, чем разрыв tool-пар).
    const b = boundary(optimizer, s);
    expect(b.coveredIndices).toEqual([]);
    expect(b.keepMessages.map((m) => m.id)).toEqual(['a1', 't1']);
    expect(() => optimizer.prepareCompression(s, 'ru')).toThrow();
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

describe('ContextOptimizer — срез хвоста по шагу (без user-границы)', () => {
  let tmpDir: string;
  let optimizer: ContextOptimizer;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-opt-step-'));
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

  it('длинный ход (1 user + 200 шагов) — хвост режется по шагу, а не разворачивается на весь ход', () => {
    const s = longTurnSession(200);
    const plan = optimizer.prepareCompression(s, 'ru');

    // Ход покрывается (до фикса user-граница разворачивала хвост на весь
    // ход: покрытие было пустым, сжатие не уменьшало контекст).
    expect(plan.coveredIndices.length).toBeGreaterThan(0);
    // Хвост начинается с шага (user/assistant) — не с середины tool-пары.
    expect(['assistant', 'user']).toContain(plan.keepMessages[0]!.role);
    // Хвост укладывается в бюджет (иначе сжатие контекст не уменьшает).
    expect(plan.keepMessages.length).toBeLessThan(s.messages.length);
    // Tool-пары хвоста целы: assistant(toolUse) → tool.
    expect(hasValidToolPairs(sessionMessagesToLlm(plan.keepMessages))).toBe(true);
    // Покрытый префикс не обрывает пару: его последнее сообщение — не
    // assistant с вызовом (чей результат остался бы в хвосте без пары).
    const lastCovered = plan.messagesToCompress[plan.messagesToCompress.length - 1]!;
    const hasOpenCall = lastCovered.role === MessageRole.ASSISTANT
      && Array.isArray(lastCovered.toolCalls) && lastCovered.toolCalls.length > 0;
    expect(hasOpenCall).toBe(false);
  });

  it('minKeepFromIndex — жёсткий пол: защищённые сообщения не покрываются', () => {
    const s = longTurnSession(200);
    const protectedFrom = 250;
    const plan = optimizer.prepareCompression(s, 'ru', { minKeepFromIndex: protectedFrom });

    // Ни одно защищённое сообщение не покрыто (пол жёсткий).
    expect(plan.coveredIndices.every((i) => i < protectedFrom)).toBe(true);
    // Хвост начинается не позже защищённой границы и непуст.
    expect(plan.keepFromIndex).toBeLessThanOrEqual(protectedFrom);
    expect(plan.keepMessages.length).toBeGreaterThan(0);
  });

  it('хвост не привязан к user-сообщению: единственный user — в начале хода', () => {
    const s = longTurnSession(200);
    const plan = optimizer.prepareCompression(s, 'ru');
    // Хвост начинается с шага (assistant), а не с единственного user в начале.
    expect(plan.keepMessages[0]!.role).toBe(MessageRole.ASSISTANT);
    expect(plan.coveredIndices.length).toBeGreaterThan(0);
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

  it('неизвестное окно (0) считается fallback 200k — авто-триггер включён', () => {
    const noWindow = new ContextOptimizer(
      new ContextConfig({ userDataDir: tmpDir }),
      () => null,
      { provider: 'mock', model: 'mock-model', temperature: 0.1, promptFile: 'SUMMARIZER' },
      () => 0,
    );
    const s = session([
      msg('u1', MessageRole.USER, 'a'),
      msg('a1', MessageRole.ASSISTANT, 'b', {
        model: 'unknown-model-xyz',
        usage: { inputTokens: 999_999, outputTokens: 0, totalTokens: 0 },
      }),
    ], { model: 'unknown-model-xyz', compactionTokenThreshold: 85 });
    // окно 0 → оценка 200000, резерв max(30000,16000)=30000, порог 170000
    expect(noWindow.shouldCompress(s)).toMatchObject({
      triggered: true,
      reason: 'tokens',
      mode: 'compaction',
      threshold: 170_000,
    });
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

describe('ContextOptimizer — fallback контекстного окна (DEFAULT_CONTEXT_WINDOW)', () => {
  let tmpDir: string;
  let noWindow: ContextOptimizer;

  const makeOptimizer = (window: number): ContextOptimizer =>
    new ContextOptimizer(
      new ContextConfig({ userDataDir: tmpDir }),
      () => null,
      { provider: 'mock', model: 'mock-model', temperature: 0.1, promptFile: 'SUMMARIZER' },
      () => window,
    );

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-opt-window-fallback-'));
    // Окно модели неизвестно: загрузчик отдаёт 0, справочник имя не знает.
    noWindow = makeOptimizer(0);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('compaction: порог считается от 200k (85% → 170k), а не отключается', () => {
    const s = session([
      msg('u1', MessageRole.USER, 'история'),
      msg('a1', MessageRole.ASSISTANT, 'ответ', {
        model: 'unknown-model-xyz',
        usage: { inputTokens: 170_000, outputTokens: 0, totalTokens: 0 },
      }),
    ], { model: 'unknown-model-xyz', compactionTokenThreshold: 85 });

    expect(noWindow.shouldCompress(s)).toMatchObject({
      triggered: true,
      reason: 'tokens',
      mode: 'compaction',
      currentTokens: 170_000,
      threshold: 170_000,
    });

    s.messages[1]!.usage = { inputTokens: 169_999, outputTokens: 0, totalTokens: 0 };
    expect(noWindow.shouldCompress(s)).toMatchObject({ triggered: false, mode: 'compaction' });
  });

  it('summarization/tokens: порог 50% от 200k → триггер на 100 000', () => {
    const s = session([
      msg('u1', MessageRole.USER, 'история'),
      msg('a1', MessageRole.ASSISTANT, 'ответ', {
        model: 'unknown-model-xyz',
        usage: { inputTokens: 100_000, outputTokens: 0, totalTokens: 0 },
      }),
    ], {
      model: 'unknown-model-xyz',
      contextOptimization: 'summarization',
      summarizationTriggerMode: 'tokens',
      summarizeTokenThreshold: 50,
    });

    expect(noWindow.shouldCompress(s)).toMatchObject({
      triggered: true,
      reason: 'tokens',
      mode: 'summarization',
      currentTokens: 100_000,
      threshold: 100_000,
    });

    s.messages[1]!.usage = { inputTokens: 99_999, outputTokens: 0, totalTokens: 0 };
    expect(noWindow.shouldCompress(s).triggered).toBe(false);
  });

  it('sliding_window/tokens: порог 80% от 200k → триггер на 160 000', () => {
    const s = session([
      msg('u1', MessageRole.USER, 'a'),
      msg('a1', MessageRole.ASSISTANT, 'b', {
        usage: { inputTokens: 160_000, outputTokens: 0, totalTokens: 0 },
      }),
    ], {
      model: 'unknown-model-xyz',
      contextOptimization: 'sliding_window',
      slidingWindowMode: 'tokens',
      slidingWindowTokenThreshold: 80,
    });

    expect(noWindow.shouldApplySlidingWindow(s)).toMatchObject({
      triggered: true,
      reason: 'tokens',
      currentTokens: 160_000,
      threshold: 160_000,
    });

    s.messages[1]!.usage = { inputTokens: 159_999, outputTokens: 0, totalTokens: 0 };
    expect(noWindow.shouldApplySlidingWindow(s).triggered).toBe(false);
  });

  it('явное окно 128k приоритетнее fallback', () => {
    const explicit = makeOptimizer(128_000);
    const s = session([
      msg('u1', MessageRole.USER, 'история'),
      msg('a1', MessageRole.ASSISTANT, 'ответ', {
        model: 'unknown-model-xyz',
        usage: { inputTokens: 110_000, outputTokens: 0, totalTokens: 0 },
      }),
    ], { model: 'unknown-model-xyz', compactionTokenThreshold: 85 });

    // 128000 − max(19200, 16000) = 108800 — считается от 128k, не от 200k.
    expect(explicit.shouldCompress(s)).toMatchObject({
      triggered: true,
      mode: 'compaction',
      threshold: 108_800,
    });

    s.messages[1]!.usage = { inputTokens: 108_799, outputTokens: 0, totalTokens: 0 };
    expect(explicit.shouldCompress(s).triggered).toBe(false);
  });

  it('неизвестное окно + очень маленькая история → не триггерится', () => {
    const s = session([
      msg('u1', MessageRole.USER, 'привет'),
      msg('a1', MessageRole.ASSISTANT, 'ответ', {
        model: 'unknown-model-xyz',
        usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
      }),
    ], { model: 'unknown-model-xyz', compactionTokenThreshold: 85 });

    expect(noWindow.shouldCompress(s)).toMatchObject({
      triggered: false,
      mode: 'compaction',
      currentTokens: 150,
    });
  });
});

describe('ContextOptimizer — валидация шаблона компактизации', () => {
  it('принимает английские заголовки (как в шаблоне)', () => {
    const res = validateCompressionContent(
      'compaction',
      '## Objective\nчего добиваемся\n\n## Requirements\n- требования',
    );
    expect(res.ok).toBe(true);
  });

  it('принимает markdown-заголовки (**Objective**)', () => {
    const res = validateCompressionContent(
      'compaction',
      '**Objective**\nчего добиваемся\n\n**Requirements**\n- требования',
    );
    expect(res.ok).toBe(true);
  });

  it('принимает русские заголовки (модель перевела заголовки)', () => {
    const res = validateCompressionContent(
      'compaction',
      '## Цель\nчего добиваемся\n\n## Важные файлы\n- `a.ts`',
    );
    expect(res.ok).toBe(true);
  });

  it('принимает смешанные заголовки и регистр', () => {
    const res = validateCompressionContent(
      'compaction',
      '## objective\nчего добиваемся\n\n## СОСТОЯНИЕ РАБОТЫ\n- готово',
    );
    expect(res.ok).toBe(true);
  });

  it('по-прежнему отвергает текст без шаблона (порог ≥2 раздела)', () => {
    const res = validateCompressionContent('compaction', 'просто текст без заголовков');
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toContain('0/2 headings');
  });

  it('один раздел — недостаточно', () => {
    const res = validateCompressionContent('compaction', '## Objective\nчего добиваемся');
    expect(res.ok).toBe(false);
  });

  /**
   * Деградированный режим (ADR-128): модель ответила содержательным резюме в
   * **своём** формате — лучше принятое сжатие, чем растущий контекст.
   */
  it('degraded: содержательный текст без заголовков принимается (allowDegraded)', () => {
    const long = 'свободное резюме без заголовков. '.repeat(12);
    expect(long.length).toBeGreaterThanOrEqual(200);

    const res = validateCompressionContent('compaction', long, { allowDegraded: true });
    expect(res.ok).toBe(true);
    expect(res.ok === true && res.degraded).toBe(true);
  });

  it('degraded: короткий текст без заголовков — по-прежнему отказ', () => {
    const res = validateCompressionContent('compaction', 'короткий текст без заголовков', {
      allowDegraded: true,
    });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toContain('0/2 headings');
  });

  it('degraded: строгий шаблон не помечается degraded', () => {
    const res = validateCompressionContent(
      'compaction',
      '## Objective\nчего добиваемся\n\n## Work State\n- готово',
      { allowDegraded: true },
    );
    expect(res.ok).toBe(true);
    expect(res.ok === true && res.degraded).toBeUndefined();
  });

  it('degraded: суммаризация не деградирует (формат произвольный)', () => {
    const res = validateCompressionContent('summarization', 'свободное резюме беседы', {
      allowDegraded: true,
    });
    expect(res.ok).toBe(true);
    expect(res.ok === true && res.degraded).toBeUndefined();
  });
});

describe('ContextOptimizer — completeCompression: nudge и число вызовов', () => {
  let tmpDir: string;
  let optimizer: ContextOptimizer;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-opt-nudge-'));
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
      new CountingCompressionProvider({ url: 'http://mock', apiKey: 'k', model: 'mock-compressor' }),
    );
    CountingCompressionProvider.chatCalls = 0;
    CountingCompressionProvider.content = '## Objective\nцель\n\n## Work State\n- готово';
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  function compressionSession(): Session {
    return session([
      msg('u1', MessageRole.USER, 'история'),
      msg('a1', MessageRole.ASSISTANT, 'ответ'),
    ], { compactionKeepTokens: 0 });
  }

  it('nudge:false — ровно один chat-вызов на невалидном ответе', async () => {
    CountingCompressionProvider.content = 'совсем не шаблон компактизации';
    const plan = optimizer.prepareCompression(compressionSession(), 'ru');

    await expect(optimizer.completeCompression(plan, { nudge: false })).rejects.toThrow();
    expect(CountingCompressionProvider.chatCalls).toBe(1);
  });

  it('nudge:false — валидный ответ принимается с одним вызовом', async () => {
    const plan = optimizer.prepareCompression(compressionSession(), 'ru');
    const result = await optimizer.completeCompression(plan, { nudge: false });
    expect(result.content).toContain('## Objective');
    expect(CountingCompressionProvider.chatCalls).toBe(1);
  });

  it('по умолчанию (nudge не задан) — невалидный ответ добивается вторым вызовом', async () => {
    CountingCompressionProvider.content = 'совсем не шаблон компактизации';
    const plan = optimizer.prepareCompression(compressionSession(), 'ru');

    await expect(optimizer.completeCompression(plan)).rejects.toThrow();
    expect(CountingCompressionProvider.chatCalls).toBe(2);
  });

  /**
   * Деградированный режим: модель дважды отдала свободный текст (200+ символов)
   * — сжатие состоялось, контент возвращён, в лог — предупреждение (без
   * содержимого ответа).
   */
  it('degraded: свободный текст 200+ символов — контент возвращён, провала нет', async () => {
    CountingCompressionProvider.content = 'свободное резюме без заголовков. '.repeat(10);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const plan = optimizer.prepareCompression(compressionSession(), 'ru');

      const result = await optimizer.completeCompression(plan);

      expect(result.content).toBe(CountingCompressionProvider.content);
      // Предупреждение в лог — факт деградированного режима.
      expect(warn).toHaveBeenCalled();
      const logged = warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toContain('свободном формате');
      // Содержимое ответа в лог не попадает.
      expect(logged).not.toContain(CountingCompressionProvider.content);
    } finally {
      warn.mockRestore();
    }
  });

  it('degraded: nudge:false — свободный текст 200+ символов тоже принимается', async () => {
    CountingCompressionProvider.content = 'свободное резюме без заголовков. '.repeat(10);
    const plan = optimizer.prepareCompression(compressionSession(), 'ru');

    const result = await optimizer.completeCompression(plan, { nudge: false });
    expect(result.content).toBe(CountingCompressionProvider.content);
    expect(CountingCompressionProvider.chatCalls).toBe(1);
  });
});

describe('ContextOptimizer — cooldown неудачного сжатия', () => {
  let tmpDir: string;
  let optimizer: ContextOptimizer;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-opt-cooldown-'));
    optimizer = new ContextOptimizer(
      new ContextConfig({ userDataDir: tmpDir }),
      () => null,
      { provider: 'mock', model: 'mock-model', temperature: 0.1, promptFile: 'SUMMARIZER' },
      () => 200_000,
    );
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(tmpDir, { recursive: true, force: true });
  });

  /** Сессия с порогом компактизации, который заведомо превышен. */
  function overflowingSession(): Session {
    return session([
      msg('u1', MessageRole.USER, 'история'),
      msg('a1', MessageRole.ASSISTANT, 'ответ', {
        model: 'mock-model',
        provider: 'mock',
        usage: { inputTokens: 170_000, outputTokens: 0, totalTokens: 170_000 },
      }),
    ], { compactionTokenThreshold: 85 });
  }

  it('cooldown блокирует shouldCompress, clear — снимает', () => {
    const s = overflowingSession();
    expect(optimizer.shouldCompress(s).triggered).toBe(true);

    optimizer.noteCompressionFailure(s.id);
    expect(optimizer.isCompressionCoolingDown(s.id)).toBe(true);
    expect(optimizer.shouldCompress(s)).toMatchObject({
      triggered: false,
      reason: 'none',
      mode: 'compaction',
    });

    optimizer.clearCompressionFailure(s.id);
    expect(optimizer.isCompressionCoolingDown(s.id)).toBe(false);
    expect(optimizer.shouldCompress(s).triggered).toBe(true);
  });

  it('cooldown истекает по TTL (10 минут)', () => {
    vi.useFakeTimers();
    const s = overflowingSession();

    optimizer.noteCompressionFailure(s.id);
    expect(optimizer.isCompressionCoolingDown(s.id)).toBe(true);

    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(optimizer.isCompressionCoolingDown(s.id)).toBe(false);
    expect(optimizer.shouldCompress(s).triggered).toBe(true);
  });

  it('cooldown относится к конкретной сессии', () => {
    const s = overflowingSession();
    optimizer.noteCompressionFailure(s.id);
    expect(optimizer.isCompressionCoolingDown('other-session')).toBe(false);
  });

  it('ignoreCooldown: прогресс-гард видит порог даже при активном cooldown', () => {
    const s = overflowingSession();

    optimizer.noteCompressionFailure(s.id);
    // Публичный вызов — cooldown учитывается (прежнее поведение).
    expect(optimizer.shouldCompress(s).triggered).toBe(false);
    // Прогресс-гард после сжатия — cooldown игнорируется.
    expect(optimizer.shouldCompress(s, { ignoreCooldown: true }).triggered).toBe(true);

    optimizer.clearCompressionFailure(s.id);
    expect(optimizer.shouldCompress(s, { ignoreCooldown: true }).triggered).toBe(true);
  });
});

describe('ContextOptimizer — вторая компактизация покрывает хвост первой', () => {
  let tmpDir: string;
  let optimizer: ContextOptimizer;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-opt-tail-'));
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

  it('хвост, оставленный первой компактизацией, покрывается второй (SUMMARY не прячет хвост)', () => {
    // Первая компактизация: покрывает u0/a0, живой хвост — u1/a1/u2.
    const s = session([
      msg('u0', MessageRole.USER, 'u0', { usage: tok(100) }),
      msg('a0', MessageRole.ASSISTANT, 'a0', { usage: tok(100) }),
      msg('u1', MessageRole.USER, 'u1', { usage: tok(100) }),
      msg('a1', MessageRole.ASSISTANT, 'a1', { usage: tok(100) }),
      msg('u2', MessageRole.USER, 'u2', { usage: tok(100) }),
    ], { compactionKeepTokens: 300 });

    const first = optimizer.prepareCompression(s, 'ru', { keepTokens: 300 });
    expect(first.coveredIndices).toEqual([0, 1]);
    expect(first.keepMessages.map((m) => m.id)).toEqual(['u1', 'a1', 'u2']);

    // Первое сжатие применено: покрытые отключены, резюме дописано в конец
    // истории (SUMMARY всегда последний — так его и кладёт `saveSummary`).
    for (const idx of first.coveredIndices) s.messages[idx]!.disabled = true;
    s.messages.push(msg('s1', MessageRole.SUMMARY, 'резюме первой компактизации', { usage: tok(10) }));

    // После первой компактизации пришли новые сообщения.
    s.messages.push(msg('u3', MessageRole.USER, 'u3', { usage: tok(100) }));
    s.messages.push(msg('a3', MessageRole.ASSISTANT, 'a3', { usage: tok(100) }));

    // Вторая компактизация обязана покрыть «живой хвост» первой (u1/a1/u2), а
    // не только новые сообщения: иначе он копился бы навсегда и контекст рос.
    const second = optimizer.prepareCompression(s, 'ru', { keepTokens: 100 });
    expect(second.coveredIndices).toEqual([2, 3, 4, 6]);
    expect(second.messagesToCompress.map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'u3']);
    // Хвост второй компактизации — то, что осталось живого.
    expect(second.keepMessages.map((m) => m.id)).toEqual(['a3']);
    // Первое сжатие не тронуто: его покрытые сообщения остались отключены.
    expect(s.messages[0]!.disabled).toBe(true);
    expect(s.messages[1]!.disabled).toBe(true);
  });

  it('без SUMMARY (первая компактизация) — граница прежняя', () => {
    const s = session([
      msg('u1', MessageRole.USER, 'u1', { usage: tok(100) }),
      msg('a1', MessageRole.ASSISTANT, 'a1', { usage: tok(100) }),
      msg('u2', MessageRole.USER, 'u2', { usage: tok(100) }),
    ], { compactionKeepTokens: 100 });
    const plan = optimizer.prepareCompression(s, 'ru', { keepTokens: 100 });
    expect(plan.coveredIndices).toEqual([0, 1]);
    expect(plan.keepMessages.map((m) => m.id)).toEqual(['u2']);
  });
});

describe('ContextOptimizer — отмена сжатия', () => {
  let tmpDir: string;
  let optimizer: ContextOptimizer;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-opt-cancel-'));
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
    MockCompressionProvider.chatAsyncCalls = 0;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('уже отменённый токен: запрос не делается, бросается CompressionCancelledError', async () => {
    const s = session([
      msg('u1', MessageRole.USER, 'u1', { usage: tok(100) }),
      msg('a1', MessageRole.ASSISTANT, 'a1', { usage: tok(100) }),
    ]);
    const plan = optimizer.prepareCompression(s, 'ru', { keepTokens: 0 });
    const token: CancellationToken = { cancelled: true, cancel: () => {} };

    await expect(optimizer.completeCompression(plan, { cancelToken: token }))
      .rejects.toBeInstanceOf(CompressionCancelledError);
    // Запрос к провайдеру не уходил.
    expect(MockCompressionProvider.chatAsyncCalls).toBe(0);
  });

  it('отмена в середине потока: CompressionCancelledError, ответ не принимается', async () => {
    const s = session([
      msg('u1', MessageRole.USER, 'u1', { usage: tok(100) }),
      msg('a1', MessageRole.ASSISTANT, 'a1', { usage: tok(100) }),
    ]);
    const plan = optimizer.prepareCompression(s, 'ru', { keepTokens: 0 });
    // Провайдер отменяет токен прямо в стриме — ответ уже неполный.
    const token: CancellationToken = { cancelled: false, cancel: () => { token.cancelled = true; } };
    MockCompressionProvider.cancelToken = token;

    try {
      await expect(optimizer.completeCompression(plan, { cancelToken: token }))
        .rejects.toBeInstanceOf(CompressionCancelledError);
      expect(MockCompressionProvider.chatAsyncCalls).toBe(1);
    } finally {
      MockCompressionProvider.cancelToken = null;
    }
  });
});

/**
 * Overflow-восстановление основного цикла: `context_length` → одно сжатие →
 * повтор шага с чекпоинтом и хвостом (system prompt не пересобирается).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContextOptimizer } from './context/optimizer.js';
import type { BaseProvider, LLMMessage } from '../providers/base.js';
import type { LLMChunk, Message, LLMResponse, TokenUsage } from '@itphx/synth-shared';
import { ChatOrchestrator } from './orchestrator.js';
import { SessionManager } from '../sessions/manager.js';
import { FileStore } from '../storage/file-store.js';
import { EventBus } from '../events/bus.js';
import { ProviderFactory, BaseProvider as ProviderBase } from '../providers/base.js';
import type { ContextBuilder } from './context/builder.js';
import { generateId, MessageRole, nowISO, makeTextPart, makeTextPart as textPart } from '@itphx/synth-shared';

const USAGE: TokenUsage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

class OverflowProvider extends ProviderBase {
  static calls = 0;
  static messages: LLMMessage[] = [];
  static failContextLength = false;

  async chat(): Promise<LLMResponse> {
    OverflowProvider.calls += 1;
    return { content: 'ok', model: this.model, usage: USAGE };
  }

  async *chatAsync(messages: LLMMessage[]): AsyncGenerator<LLMChunk> {
    OverflowProvider.calls += 1;
    OverflowProvider.messages = messages;
    if (OverflowProvider.failContextLength) {
      throw new Error('context length exceeded');
    }
    yield { content: 'ok', isFinal: true, model: this.model, usage: USAGE };
  }

  getProviderName(): string {
    return 'mockoverflow';
  }
}

function makeCtxBuilder(): ContextBuilder {
  return {
    buildSystemPrompt: async () => 'system prompt',
    buildBaseBlocks: async () => [
      { key: 'role', tier: 'stable', order: 10, content: 'system prompt' },
    ],
  } as unknown as ContextBuilder;
}

function makeMessage(content: string): Message {
  return {
    id: generateId(),
    role: MessageRole.USER,
    seq: 0,
    origin: 'local',
    parts: [makeTextPart(content)],
    content,
    createdAt: nowISO(),
    disabled: false,
    pinned: false,
    hidden: false,
    author: 'user',
    metadata: { stream_id: generateId() },
  };
}

function makeStubOptimizer(opts: {
  windowTokens: number;
  coveredIndices: number[];
  failPrepare?: boolean;
  mode?: 'summarization' | 'compaction' | null;
}): ContextOptimizer & { prepareCalls: number; completeCalls: number } {
  const stub = {
    prepareCalls: 0,
    completeCalls: 0,
    setGatewayHooks: () => {},
    getContextWindow: () => opts.windowTokens,
    estimateTokens: () => 0,
    getMessagesForLlm: (session: { messages: Message[] }) => session.messages.filter((m) => !m.disabled),
    canSummarize: () => true,
    effectiveMode: () => (opts.mode === undefined ? 'summarization' : opts.mode),
    prepareCompression: () => {
      stub.prepareCalls += 1;
      if (opts.failPrepare) throw new Error('No messages to compress');
      return {
        mode: 'summarization',
        provider: {} as BaseProvider,
        llmMessages: [],
        systemPrompt: 'SUMMARIZER',
        messagesToCompress: [],
        coveredIndices: opts.coveredIndices,
        keepFromIndex: -1,
        keepMessages: [],
      };
    },
    completeCompression: async () => {
      stub.completeCalls += 1;
      return {
        content: 's',
        response: { content: 's', model: 'm', usage: USAGE },
      };
    },
  };
  return stub as unknown as ContextOptimizer & { prepareCalls: number; completeCalls: number };
}

describe('ChatOrchestrator — overflow → сжатие → повтор', () => {
  let sessionManager: SessionManager;
  let eventBus: EventBus;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-overflow-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    eventBus = new EventBus();
    OverflowProvider.calls = 0;
    OverflowProvider.messages = [];
    OverflowProvider.failContextLength = false;
    ProviderFactory.register('mockoverflow', OverflowProvider);
  });

  afterEach(async () => {
    ProviderFactory['_providers'].delete('mockoverflow');
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function run(opts: {
    optimizer: ContextOptimizer;
    policy?: 'enforce' | 'warn' | 'off';
    seed?: Message[];
  }) {
    const orchestrator = new ChatOrchestrator({
      sessionManager,
      eventBus,
      contextBuilder: makeCtxBuilder(),
      contextOptimizer: opts.optimizer,
      providerLoader: (name: string) => ({
        name,
        type: 'mockoverflow',
        baseUrl: '',
        apiKey: '',
        defaultModel: 'm',
      }) as unknown as import('@itphx/synth-shared').ProviderConfig,
      defaultWorkingDir: tmpDir,
      contextWindowPolicy: () => opts.policy ?? 'enforce',
    });

    const session = await sessionManager.createSession({
      title: 'Overflow',
      settings: {
        provider: 'mockoverflow',
        model: 'm',
        systemPrompt: 'test',
        agentRole: 'fixer',
        maxTokens: 10,
      },
    });
    for (const message of opts.seed ?? []) await sessionManager.addMessage(session.id, message);
    const current = makeMessage('u2');
    await sessionManager.addMessage(session.id, current);
    const fresh = (await sessionManager.getSession(session.id))!;

    const processMessage = orchestrator.createProcessMessage();
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const result = await processMessage(
      fresh,
      current,
      new AbortController().signal,
      (event, data) => events.push({ event, data }),
    );
    return { result, sessionId: session.id, events };
  }

  function longMessage(role: MessageRole, content: string): Message {
    return {
      id: generateId(),
      role,
      seq: 0,
      origin: 'local',
      parts: [textPart(content)],
      content,
      createdAt: nowISO(),
      disabled: false,
      pinned: false,
      hidden: false,
      ...(role === MessageRole.ASSISTANT ? { author: 'assistant' } : { author: 'user' }),
    } as Message;
  }

  it('ContextLengthExceededError → сжатие один раз, повтор с чекпоинтом и хвостом', async () => {
    const optimizer = makeStubOptimizer({ windowTokens: 300, coveredIndices: [0, 1] });
    const { result, sessionId, events } = await run({
      optimizer,
      seed: [longMessage(MessageRole.USER, 'U'.repeat(2000)), longMessage(MessageRole.ASSISTANT, 'A'.repeat(2000))],
    });

    expect(result.errorType).toBeUndefined();
    expect(optimizer.prepareCalls).toBe(1);
    expect(optimizer.completeCalls).toBe(1);
    expect(OverflowProvider.calls).toBe(1);
    expect(OverflowProvider.messages[0]!.role).toBe('user');
    expect(OverflowProvider.messages[0]!.content).toContain('[CONTEXT CHECKPOINT]');
    expect(OverflowProvider.messages.some((m) => m.content === 'u2')).toBe(true);

    const session = (await sessionManager.getSession(sessionId))!;
    const summary = session.messages.find((m) => m.role === MessageRole.SUMMARY);
    expect(summary).toBeDefined();
    expect(session.messages[0]!.disabled).toBe(true);
    expect(session.messages[1]!.disabled).toBe(true);

    // M5: на каждый step.started — step.finished, индексы уникальны.
    const started = events.filter((e) => e.event === 'step.started');
    const finished = events.filter((e) => e.event === 'step.finished');
    expect(started.length).toBe(finished.length);
    const stepIndexes = started.map((e) => e.data.stepIndex as number);
    expect(new Set(stepIndexes).size).toBe(stepIndexes.length);
  });

  it('второй overflow не зацикливает: сжатие ровно один раз, затем ошибка', async () => {
    OverflowProvider.failContextLength = true;
    const optimizer = makeStubOptimizer({ windowTokens: 1_000_000, coveredIndices: [0, 1] });
    const { result } = await run({
      optimizer,
      policy: 'warn',
      seed: [longMessage(MessageRole.USER, 'U'), longMessage(MessageRole.ASSISTANT, 'A')],
    });

    expect(result.errorType).toBe('context_length');
    expect(optimizer.prepareCalls).toBe(1);
    expect(OverflowProvider.calls).toBe(2);
  });

  it('нечего сжимать → поведение прежнее (ошибка context_length)', async () => {
    const optimizer = makeStubOptimizer({
      windowTokens: 100,
      coveredIndices: [],
      failPrepare: true,
    });
    const { result } = await run({
      optimizer,
      seed: [longMessage(MessageRole.USER, 'U'.repeat(2000))],
    });

    expect(result.errorType).toBe('context_length');
    expect(optimizer.prepareCalls).toBe(1);
    expect(OverflowProvider.calls).toBe(0);
  });

  it('M4: сжатие выключено (none) → история не мутируется, SUMMARY нет', async () => {
    const optimizer = makeStubOptimizer({
      windowTokens: 100,
      coveredIndices: [0, 1],
      mode: null,
    });
    const { result, sessionId } = await run({
      optimizer,
      seed: [longMessage(MessageRole.USER, 'U'.repeat(2000))],
    });

    expect(result.errorType).toBe('context_length');
    expect(optimizer.prepareCalls).toBe(0);
    const session = (await sessionManager.getSession(sessionId))!;
    expect(session.messages.some((m) => m.role === MessageRole.SUMMARY)).toBe(false);
    expect(session.messages.every((m) => m.disabled === false)).toBe(true);
  });

  it('warn: блокировки нет, сжатие не запускается', async () => {
    const optimizer = makeStubOptimizer({ windowTokens: 100, coveredIndices: [0, 1] });
    const { result } = await run({
      optimizer,
      policy: 'warn',
      seed: [longMessage(MessageRole.USER, 'U'.repeat(2000))],
    });

    expect(result.errorType).toBeUndefined();
    expect(optimizer.prepareCalls).toBe(0);
    expect(OverflowProvider.calls).toBe(1);
  });
});

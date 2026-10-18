import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatOrchestrator } from './orchestrator.js';
import { SessionManager } from '../sessions/manager.js';
import { FileStore } from '../storage/file-store.js';
import { ProjectStore } from '../storage/project-store.js';
import { EventBus } from '../events/bus.js';
import { createToolRegistry } from './tools/index.js';
import { ContextConfig } from './context/config.js';
import { ProviderFactory, BaseProvider } from '../providers/base.js';
import type { LLMMessage, CancellationToken } from '../providers/base.js';
import type { ContextBuilder } from './context/builder.js';
import type { Message, PermissionConfig } from '@itphx/synth-shared';
import { generateId, MessageRole, nowISO, makeTextPart } from '@itphx/synth-shared';

function makeCtxBuilder(): ContextBuilder {
  return {
    buildSystemPrompt: async () => 'system prompt',
    buildBaseBlocks: async () => [
      { key: 'role', tier: 'stable', order: 10, content: 'system prompt' },
    ],
  } as unknown as ContextBuilder;
}

function makeUserMessage(): Message {
  return {
    id: generateId(),
    role: MessageRole.USER,
    seq: 0,
    origin: 'local',
    parts: [makeTextPart('ответь')],
    content: 'ответь',
    createdAt: nowISO(),
    disabled: false,
    pinned: false,
    hidden: false,
    author: 'user',
    metadata: { stream_id: generateId() },
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

/**
 * Провайдер с паузой между чанками: тест успевает прочитать сессию, пока
 * стрим ещё не завершён (частичный текст уже в истории).
 */
class MockGatedPartialProvider extends BaseProvider {
  static firstChunk = deferred();
  static gate = deferred();

  static reset(): void {
    MockGatedPartialProvider.firstChunk = deferred();
    MockGatedPartialProvider.gate = deferred();
  }

  async chat(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
  ): Promise<import('@itphx/synth-shared').LLMResponse> {
    return { content: 'Привет, мир!', model: this.model, usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } };
  }

  async *chatAsync(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
    _debugCollector?: unknown,
    _ct?: CancellationToken,
  ): AsyncGenerator<import('@itphx/synth-shared').LLMChunk> {
    yield { content: 'Привет', isFinal: false, model: this.model, usage: ZERO_USAGE };
    MockGatedPartialProvider.firstChunk.resolve();
    await MockGatedPartialProvider.gate.promise;
    yield {
      content: 'Привет, мир!', isFinal: true, model: this.model,
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    };
  }

  getProviderName(): string {
    return 'mockgated';
  }
}

/** Провайдер: два обычных чанка и финал с полным текстом (проверка отсутствия дублей). */
class MockTwoChunksProvider extends BaseProvider {
  async chat(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
  ): Promise<import('@itphx/synth-shared').LLMResponse> {
    return { content: 'Часть 1 Часть 2', model: this.model, usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } };
  }

  async *chatAsync(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
    _debugCollector?: unknown,
    _ct?: CancellationToken,
  ): AsyncGenerator<import('@itphx/synth-shared').LLMChunk> {
    yield { content: 'Часть 1 ', isFinal: false, model: this.model, usage: ZERO_USAGE };
    yield { content: 'Часть 2', isFinal: false, model: this.model, usage: ZERO_USAGE };
    yield {
      content: 'Часть 1 Часть 2', isFinal: true, model: this.model,
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    };
  }

  getProviderName(): string {
    return 'mocktwochunks';
  }
}

/** Провайдер отмены: первый чанк сохраняется, затем ждём «Стоп». */
class MockPartialCancelProvider extends BaseProvider {
  static firstChunk = deferred();

  static reset(): void {
    MockPartialCancelProvider.firstChunk = deferred();
  }

  async chat(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
  ): Promise<import('@itphx/synth-shared').LLMResponse> {
    return { content: 'Начало ответа', model: this.model, usage: ZERO_USAGE };
  }

  async *chatAsync(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
    _debugCollector?: unknown,
    ct?: CancellationToken,
  ): AsyncGenerator<import('@itphx/synth-shared').LLMChunk> {
    yield { content: 'Начало ответа', isFinal: false, model: this.model, usage: ZERO_USAGE };
    MockPartialCancelProvider.firstChunk.resolve();
    while (!ct?.cancelled) {
      await new Promise((r) => setTimeout(r, 5));
    }
    return;
  }

  getProviderName(): string {
    return 'mockpartialcancel';
  }
}

/** Провайдер падает после первого чанка — частичный текст должен остаться. */
class MockFailAfterPartialProvider extends BaseProvider {
  async chat(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
  ): Promise<import('@itphx/synth-shared').LLMResponse> {
    return { content: '', model: this.model, usage: ZERO_USAGE };
  }

  async *chatAsync(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
    _debugCollector?: unknown,
    _ct?: CancellationToken,
  ): AsyncGenerator<import('@itphx/synth-shared').LLMChunk> {
    yield { content: 'Частичный текст', isFinal: false, model: this.model, usage: ZERO_USAGE };
    await new Promise((r) => setTimeout(r, 20));
    throw new Error('network fail: provider unavailable');
  }

  getProviderName(): string {
    return 'mockfailpartial';
  }
}

interface Harness {
  orchestrator: ChatOrchestrator;
  sessionManager: SessionManager;
  eventBus: EventBus;
  tmpDir: string;
  sessionId: string;
  streamId: string;
}

async function makeHarness(providerName: string): Promise<Harness> {
  const tmpDir = await mkdtemp(join(tmpdir(), 'synth-stream-persist-'));
  const store = new FileStore({ dataDir: tmpDir });
  const sessionManager = new SessionManager(store);
  const eventBus = new EventBus();
  const projectStore = new ProjectStore({ dataDir: tmpDir });
  const project = projectStore.create('StreamPersist', 'u1', { workspace: tmpDir });
  await projectStore.save(project);
  const orchestrator = new ChatOrchestrator({
    sessionManager,
    eventBus,
    contextBuilder: makeCtxBuilder(),
    providerLoader: (name: string) => ({
      name,
      type: providerName,
      baseUrl: '',
      apiKey: '',
      defaultModel: 'm',
    }) as unknown as import('@itphx/synth-shared').ProviderConfig,
    toolRegistry: createToolRegistry(),
    permissionConfig: { rules: {}, askTimeoutMs: 1000 } as PermissionConfig,
    projectStore,
    defaultWorkingDir: tmpDir,
    contextConfig: new ContextConfig({ userDataDir: join(tmpDir, 'context') }),
    // Тестовый интервал: не ждём реальную секунду.
    streamPersistIntervalMs: 2,
  });
  const session = await sessionManager.createSession({
    title: 'StreamPersist',
    projectId: project.id,
    settings: { provider: providerName, model: 'm', systemPrompt: 'test', agentRole: 'developer' },
  });
  const msg = makeUserMessage();
  await sessionManager.addMessage(session.id, msg);
  return {
    orchestrator,
    sessionManager,
    eventBus,
    tmpDir,
    sessionId: session.id,
    streamId: msg.metadata!.stream_id as string,
  };
}

async function run(
  h: Harness,
  signal: AbortSignal,
  publishChunk: (event: string, data: Record<string, unknown>) => void = () => {},
): Promise<import('./orchestrator.js').ProcessMessageResult> {
  const processMessage = h.orchestrator.createProcessMessage();
  const fresh = (await h.sessionManager.getSession(h.sessionId))!;
  const userMsg = fresh.messages.find((m) => m.role === MessageRole.USER)!;
  return processMessage(fresh, userMsg, signal, publishChunk);
}

function nonToolChainAssistants(messages: Message[]): Message[] {
  return messages.filter((m) => m.role === MessageRole.ASSISTANT && m.metadata?.tool_chain !== true);
}

describe('ChatOrchestrator: персистентность частичного стрима (шаг 2б)', () => {
  beforeEach(() => {
    ProviderFactory.register('mockgated', MockGatedPartialProvider);
    ProviderFactory.register('mocktwochunks', MockTwoChunksProvider);
    ProviderFactory.register('mockpartialcancel', MockPartialCancelProvider);
    ProviderFactory.register('mockfailpartial', MockFailAfterPartialProvider);
    MockGatedPartialProvider.reset();
    MockPartialCancelProvider.reset();
  });

  afterEach(async () => {
    ProviderFactory['_providers'].delete('mockgated');
    ProviderFactory['_providers'].delete('mocktwochunks');
    ProviderFactory['_providers'].delete('mockpartialcancel');
    ProviderFactory['_providers'].delete('mockfailpartial');
  });

  it('частичный стрим виден в сессии до финала', async () => {
    const h = await makeHarness('mockgated');
    const runPromise = run(h, new AbortController().signal);

    await MockGatedPartialProvider.firstChunk.promise;
    await new Promise((r) => setTimeout(r, 20));

    const mid = (await h.sessionManager.getSession(h.sessionId))!;
    const assistant = nonToolChainAssistants(mid.messages);
    expect(assistant).toHaveLength(1);
    expect(assistant[0]!.content).toContain('Привет');
    expect(assistant[0]!.metadata?.streaming).toBe(true);

    MockGatedPartialProvider.gate.resolve();
    const result = await runPromise;
    expect(result.error).toBeUndefined();

    const done = (await h.sessionManager.getSession(h.sessionId))!;
    const final = nonToolChainAssistants(done.messages);
    expect(final).toHaveLength(1);
    expect(final[0]!.content).toBe('Привет, мир!');
    expect(final[0]!.metadata?.streaming).toBeUndefined();

    await rm(h.tmpDir, { recursive: true, force: true });
  });

  it('обычный ход без тулов: ровно user + один финальный assistant (без дубля)', async () => {
    const h = await makeHarness('mocktwochunks');
    const chunks: Array<{ event: string; data: Record<string, unknown> }> = [];
    const result = await run(h, new AbortController().signal, (event, data) => chunks.push({ event, data }));
    expect(result.error).toBeUndefined();

    const session = (await h.sessionManager.getSession(h.sessionId))!;
    const users = session.messages.filter((m) => m.role === MessageRole.USER);
    const assistants = nonToolChainAssistants(session.messages);
    expect(users).toHaveLength(1);
    expect(assistants).toHaveLength(1);
    expect(assistants[0]!.content).toBe('Часть 1 Часть 2');
    // State-сообщения (mode/agent) — не сообщения хода; пользовательских и
    // assistant-сообщений ровно по одному.
    expect(session.messages.filter((m) => m.role !== MessageRole.SYSTEM)).toHaveLength(2);

    const done = chunks.find((c) => c.event === 'stream.done')!;
    expect(done.data.content).toBe('Часть 1 Часть 2');

    await rm(h.tmpDir, { recursive: true, force: true });
  });

  it('отмена: один non-tool_chain assistant со статусом cancelled и частичным текстом', async () => {
    const h = await makeHarness('mockpartialcancel');
    const runPromise = run(h, new AbortController().signal);

    await MockPartialCancelProvider.firstChunk.promise;
    await new Promise((r) => setTimeout(r, 20));
    h.orchestrator.cancel(h.streamId);
    const result = await runPromise;
    expect(result.error).toBeUndefined();

    const session = (await h.sessionManager.getSession(h.sessionId))!;
    const assistants = nonToolChainAssistants(session.messages);
    expect(assistants).toHaveLength(1);
    expect(assistants[0]!.content).toContain('Начало ответа');
    expect(assistants[0]!.metadata?.status).toBe('cancelled');
    expect(assistants[0]!.metadata?.streaming).not.toBe(true);

    await rm(h.tmpDir, { recursive: true, force: true });
  });

  it('падение после частичного стрима: текст сохраняется как interrupted/error', async () => {
    const h = await makeHarness('mockfailpartial');
    const result = await run(h, new AbortController().signal);
    expect(result.error).toBeDefined();

    const session = (await h.sessionManager.getSession(h.sessionId))!;
    const interrupted = session.messages.find(
      (m) => m.role === MessageRole.ASSISTANT && m.metadata?.interrupted === true,
    );
    expect(interrupted).toBeDefined();
    expect(interrupted!.content).toContain('Частичный текст');
    expect(interrupted!.metadata).toMatchObject({ streaming: false, status: 'error' });

    // Сообщение об ошибке LLM сохраняется отдельно (семантика handleLlmFailure).
    const errorAssistant = session.messages.find(
      (m) => m.role === MessageRole.ASSISTANT && m.metadata?.status === 'error' && m !== interrupted,
    );
    expect(errorAssistant).toBeDefined();

    await rm(h.tmpDir, { recursive: true, force: true });
  });
});

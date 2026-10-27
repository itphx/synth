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

const ZERO_USAGE = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

/**
 * Провайдер: в первой итерации отдаёт рассуждение и tool-вызов, во второй —
 * ровно то же рассуждение (модель повторила его) и финальный ответ.
 * Классический источник дубля блоков «Размышления».
 */
class MockRepeatReasoningProvider extends BaseProvider {
  static calls = 0;

  static reset(): void {
    MockRepeatReasoningProvider.calls = 0;
  }

  async chat(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
  ): Promise<import('@itphx/synth-shared').LLMResponse> {
    return { content: 'Готово', model: this.model, usage: ZERO_USAGE, reasoning: 'Думаю' };
  }

  async *chatAsync(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
    _debugCollector?: unknown,
    _ct?: CancellationToken,
  ): AsyncGenerator<import('@itphx/synth-shared').LLMChunk> {
    const call = MockRepeatReasoningProvider.calls++;
    if (call === 0) {
      yield { content: '', reasoning: 'Думаю', isFinal: false, model: this.model, usage: ZERO_USAGE };
      yield {
        content: '',
        reasoning: 'Думаю',
        isFinal: true,
        model: this.model,
        usage: ZERO_USAGE,
        toolCalls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'read_file', arguments: JSON.stringify({ path: 'missing.txt' }) },
        }],
      };
      return;
    }
    // Повтор рассуждения в новой итерации — блок не должен задвоиться.
    yield { content: 'Готово', reasoning: 'Думаю', isFinal: true, model: this.model, usage: ZERO_USAGE };
  }

  getProviderName(): string {
    return 'mockrepeatreasoning';
  }
}

describe('ChatOrchestrator: reasoning_blocks без дублей (повтор в новой итерации)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    ProviderFactory.register('mockrepeatreasoning', MockRepeatReasoningProvider);
    MockRepeatReasoningProvider.reset();
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-orch-reasoning-'));
  });

  afterEach(async () => {
    ProviderFactory['_providers'].delete('mockrepeatreasoning');
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('финальный stream.done несёт один блок рассуждений', async () => {
    const store = new FileStore({ dataDir: tmpDir });
    const sessionManager = new SessionManager(store);
    const eventBus = new EventBus();
    const projectStore = new ProjectStore({ dataDir: tmpDir });
    const project = projectStore.create('Reasoning', 'u1', { workspace: tmpDir });
    await projectStore.save(project);
    const orchestrator = new ChatOrchestrator({
      sessionManager,
      eventBus,
      contextBuilder: makeCtxBuilder(),
      providerLoader: (name: string) => ({
        name,
        type: 'mockrepeatreasoning',
        baseUrl: '',
        apiKey: '',
        defaultModel: 'm',
      }) as unknown as import('@itphx/synth-shared').ProviderConfig,
      toolRegistry: createToolRegistry(),
      permissionConfig: { rules: {}, askTimeoutMs: 1000 } as PermissionConfig,
      projectStore,
      defaultWorkingDir: tmpDir,
      contextConfig: new ContextConfig({ userDataDir: join(tmpDir, 'context') }),
      streamPersistIntervalMs: 2,
    });
    const session = await sessionManager.createSession({
      title: 'Reasoning',
      projectId: project.id,
      settings: {
        provider: 'mockrepeatreasoning',
        model: 'm',
        systemPrompt: 'test',
        agentRole: 'developer',
      },
    });
    const msg = makeUserMessage();
    await sessionManager.addMessage(session.id, msg);

    const published: Array<{ event: string; data: Record<string, unknown> }> = [];
    const processMessage = orchestrator.createProcessMessage();
    const fresh = (await sessionManager.getSession(session.id))!;
    const userMsg = fresh.messages.find((m) => m.role === MessageRole.USER)!;
    const result = await processMessage(
      fresh,
      userMsg,
      new AbortController().signal,
      (event, data) => published.push({ event, data }),
    );

    expect(result.error).toBeUndefined();
    // Две итерации: tool-вызов в первой, финальный ответ во второй.
    expect(MockRepeatReasoningProvider.calls).toBe(2);

    const done = published.find((c) => c.event === 'stream.done')!;
    const blocks = done.data.reasoning_blocks as Array<{ text: string; iteration: number }>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.text).toBe('Думаю');
  });
});

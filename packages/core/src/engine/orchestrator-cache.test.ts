/**
 * ADR-070 §2.2 (Ф2-часть 1): оркестратор передаёт в провайдер `SystemPromptPayload`
 * с границей stable-префикса из Composer, ключом кэша (session.id) и политикой
 * из config `llm.cache`. Проверяется через мок-провайдер (статический capture).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatOrchestrator } from './orchestrator.js';
import { SessionManager } from '../sessions/manager.js';
import { FileStore } from '../storage/file-store.js';
import { EventBus } from '../events/bus.js';
import { ProviderFactory, BaseProvider } from '../providers/base.js';
import type { LLMMessage, SystemPromptInput, SystemPromptPayload, CancellationToken } from '../providers/base.js';
import type { ContextBuilder } from './context/builder.js';
import { generateId, MessageRole, nowISO, makeTextPart } from '@itphx/synth-shared';
import type { Message } from '@itphx/synth-shared';

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
    parts: [makeTextPart('Привет')],
    content: 'Привет',
    createdAt: nowISO(),
    disabled: false,
    pinned: false,
    hidden: false,
    author: 'user',
    metadata: { stream_id: generateId() },
  };
}

/** Мок-провайдер: фиксирует systemPrompt, отдаёт финальный ответ без тулов. */
class CapturePromptProvider extends BaseProvider {
  static captured: SystemPromptInput | undefined;

  async chat(
    _messages: LLMMessage[],
    systemPrompt?: SystemPromptInput,
    _tools?: Record<string, unknown>[],
    _stream?: boolean,
    _debugCollector?: unknown,
  ): Promise<import('@itphx/synth-shared').LLMResponse> {
    CapturePromptProvider.captured = systemPrompt;
    return { content: 'ok', model: this.model, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
  }

  async *chatAsync(
    _messages: LLMMessage[],
    systemPrompt?: SystemPromptInput,
    _tools?: Record<string, unknown>[],
    _debugCollector?: unknown,
    _cancellationToken?: CancellationToken,
  ): AsyncGenerator<import('@itphx/synth-shared').LLMChunk> {
    CapturePromptProvider.captured = systemPrompt;
    yield {
      content: 'ok',
      isFinal: true,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      model: this.model,
    };
  }

  getProviderName(): string {
    return 'captureprompt';
  }
}

describe('ChatOrchestrator — SystemPromptPayload (ADR-070 §2.2)', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-orch-cache-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    CapturePromptProvider.captured = undefined;
    ProviderFactory.register('captureprompt', CapturePromptProvider);
  });

  afterEach(async () => {
    ProviderFactory['_providers'].delete('captureprompt');
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function run(opts: { cachePolicy?: 'auto' | 'none'; systemPrompt?: string } = {}): Promise<{
    sessionId: string;
    captured: SystemPromptInput | undefined;
  }> {
    const orchestrator = new ChatOrchestrator({
      sessionManager,
      eventBus: new EventBus(),
      contextBuilder: makeCtxBuilder(),
      providerLoader: (name: string) =>
        ({
          name,
          type: 'captureprompt',
          baseUrl: '',
          apiKey: '',
          defaultModel: 'm',
        }) as unknown as import('@itphx/synth-shared').ProviderConfig,
      defaultWorkingDir: tmpDir,
      cachePolicy: opts.cachePolicy,
    });

    const session = await sessionManager.createSession({
      title: 'Cache',
      settings: {
        provider: 'captureprompt',
        model: 'm',
        agentRole: 'developer',
        ...(opts.systemPrompt !== undefined ? { systemPrompt: opts.systemPrompt } : {}),
      },
    });
    const msg = makeUserMessage();
    await sessionManager.addMessage(session.id, msg);
    const fresh = (await sessionManager.getSession(session.id))!;

    await orchestrator.createProcessMessage()(fresh, msg, new AbortController().signal, () => {});
    return { sessionId: session.id, captured: CapturePromptProvider.captured };
  }

  it('payload: cacheKey=session.id, stablePrefix из Composer, cachePolicy=auto', async () => {
    const { sessionId, captured } = await run();

    expect(typeof captured).toBe('object');
    const payload = captured as SystemPromptPayload;
    expect(payload.cacheKey).toBe(sessionId);
    expect(payload.cachePolicy).toBe('auto');
    expect(payload.stablePrefix).toBe('system prompt');
    expect(payload.text).toContain('system prompt');
  });

  it('cachePolicy=none прокидывается в payload', async () => {
    const { captured } = await run({ cachePolicy: 'none' });

    const payload = captured as SystemPromptPayload;
    expect(payload.cachePolicy).toBe('none');
  });

  it('override systemPrompt → stablePrefix не задаётся', async () => {
    const { captured } = await run({ systemPrompt: 'мой оверрайд' });

    const payload = captured as SystemPromptPayload;
    expect(payload.stablePrefix).toBeUndefined();
    expect(payload.text).toContain('мой оверрайд');
  });
});

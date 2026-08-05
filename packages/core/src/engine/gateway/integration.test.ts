/**
 * Интеграция ChatOrchestrator × LLM Gateway (AD-036), слой 3:
 * - _getProvider оборачивает провайдер в GatewayProvider когда gateway включён;
 * - при выключенном gateway возвращается исходный провайдер;
 * - _saveAssistantMessage добавляет metadata.secrets для существующих плейсхолдеров.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatOrchestrator } from '../orchestrator.js';
import { SessionManager } from '../../sessions/manager.js';
import { FileStore } from '../../storage/file-store.js';
import { EventBus } from '../../events/bus.js';
import { ProviderFactory, BaseProvider } from '../../providers/base.js';
import type { LLMMessage, CancellationToken } from '../../providers/base.js';
import { GatewayProvider } from './index.js';
import { DebugCollector } from '../../debug.js';
import type { ContextBuilder } from '../context/builder.js';
import type { Session, LLMGatewayConfig, TokenUsage } from '@synth/shared';
import { MessageRole } from '@synth/shared';

class MockGwProvider extends BaseProvider {
  async chat(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
    _stream?: boolean,
    _debugCollector?: unknown,
  ): Promise<import('@synth/shared').LLMResponse> {
    return { content: 'ok', model: this.model, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
  }

  async *chatAsync(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
    _debugCollector?: unknown,
    _cancellationToken?: CancellationToken,
  ): AsyncGenerator<import('@synth/shared').LLMChunk> {
    yield { content: 'ok', isFinal: true, model: this.model, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
  }

  getProviderName(): string {
    return 'mockgw';
  }
}

function makeCtxBuilder(): ContextBuilder {
  return {
    buildSystemPrompt: async () => 'system prompt',
  } as unknown as ContextBuilder;
}

function makeGatewayConfig(): LLMGatewayConfig {
  return {
    enabled: true,
    inputMode: 'obfuscate',
    rateLimit: { userPerMinute: 60, providerPerMinute: 120 },
    audit: { enabled: true, logPath: '' },
  };
}

describe('ChatOrchestrator × LLM Gateway (AD-036)', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-gw-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    ProviderFactory.register('mockgw', MockGwProvider);
  });

  afterEach(async () => {
    ProviderFactory['_providers'].delete('mockgw');
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeOrchestrator(gatewayConfig?: LLMGatewayConfig) {
    return new ChatOrchestrator({
      sessionManager,
      eventBus: new EventBus(),
      contextBuilder: makeCtxBuilder(),
      providerLoader: (name) => (name === 'mockgw' ? {
        name,
        type: 'mockgw',
        baseUrl: 'http://localhost:9999/v1',
        apiKey: 'test-key',
        defaultModel: 'mock-model',
        timeout: 10,
      } : null),
      dataDir: tmpDir,
      gatewayConfig,
    });
  }

  async function makeSession(opts: { obfuscationMap?: Record<string, string> } = {}): Promise<Session> {
    const session = await sessionManager.createSession({
      title: 'S',
      settings: { provider: 'mockgw', model: 'mock-model' },
      userId: 'u1',
    });
    if (opts.obfuscationMap) {
      await sessionManager.withLock(session.id, async (s) => {
        s.obfuscationMap = opts.obfuscationMap;
        await sessionManager.saveSession(s);
      });
    }
    return session;
  }

  function getProviderOf(orch: ChatOrchestrator, session: Session) {
    return (orch as unknown as {
      _getProvider(providerName: string, session: Session): import('../../providers/base.js').BaseProvider | null;
    })._getProvider('mockgw', session);
  }

  it('_getProvider оборачивает провайдер в GatewayProvider когда gateway включён', async () => {
    const orch = makeOrchestrator(makeGatewayConfig());
    const session = await makeSession();

    const provider = getProviderOf(orch, session);
    expect(provider).not.toBeNull();
    expect(provider).toBeInstanceOf(GatewayProvider);
  });

  it('_getProvider возвращает исходный провайдер когда gateway выключен', async () => {
    const orch = makeOrchestrator({ ...makeGatewayConfig(), enabled: false });
    const session = await makeSession();

    const provider = getProviderOf(orch, session);
    expect(provider).not.toBeNull();
    expect(provider).not.toBeInstanceOf(GatewayProvider);
    expect(provider).toBeInstanceOf(MockGwProvider);
  });

  it('_saveAssistantMessage добавляет metadata.secrets для существующих плейсхолдеров', async () => {
    const orch = makeOrchestrator(makeGatewayConfig());
    const session = await makeSession({
      obfuscationMap: {
        '⟦SYNTH_SECRET_1⟧': 'sk-abc123',
        '⟦SYNTH_SECRET_2⟧': 'other-token',
      },
    });

    const save = (orch as unknown as {
      _saveAssistantMessage(
        sessionId: string,
        content: string,
        streamId: string,
        agentRole: string | undefined,
        usage: TokenUsage,
        model: string | undefined,
        reasoning: string | undefined,
        debugCollector: DebugCollector,
        isCancelled: boolean,
        provider?: string,
        role?: MessageRole,
      ): Promise<string>;
    })._saveAssistantMessage;

    await save.call(
      orch,
      session.id,
      'Подключение с ⟦SYNTH_SECRET_1⟧ установлено',
      'stream-1',
      undefined,
      { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      'mock-model',
      undefined,
      new DebugCollector(false),
      false,
      'mockgw',
      MessageRole.ASSISTANT,
    );

    const updated = await sessionManager.getSession(session.id);
    const msg = updated?.messages[updated.messages.length - 1];
    expect(msg?.role).toBe(MessageRole.ASSISTANT);
    expect((msg?.metadata?.secrets as Record<string, string> | undefined)?.['⟦SYNTH_SECRET_1⟧']).toBe('sk-abc123');
    // Плейсхолдер, которого нет в ответе — не попадает в metadata
    expect(Object.keys((msg?.metadata?.secrets ?? {}) as Record<string, string>)).not.toContain('⟦SYNTH_SECRET_2⟧');
  });

  it('_saveAssistantMessage не добавляет metadata.secrets без плейсхолдеров в ответе', async () => {
    const orch = makeOrchestrator(makeGatewayConfig());
    const session = await makeSession({
      obfuscationMap: { '⟦SYNTH_SECRET_1⟧': 'sk-abc123' },
    });

    const save = (orch as unknown as {
      _saveAssistantMessage(
        sessionId: string,
        content: string,
        streamId: string,
        agentRole: string | undefined,
        usage: TokenUsage,
        model: string | undefined,
        reasoning: string | undefined,
        debugCollector: DebugCollector,
        isCancelled: boolean,
        provider?: string,
        role?: MessageRole,
      ): Promise<string>;
    })._saveAssistantMessage;

    await save.call(
      orch,
      session.id,
      'Обычный ответ без секретов',
      'stream-2',
      undefined,
      { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      'mock-model',
      undefined,
      new DebugCollector(false),
      false,
      'mockgw',
      MessageRole.ASSISTANT,
    );

    const updated = await sessionManager.getSession(session.id);
    const msg = updated?.messages[updated.messages.length - 1];
    expect(msg?.metadata?.secrets).toBeUndefined();
  });
});

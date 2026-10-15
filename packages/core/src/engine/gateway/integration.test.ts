/**
 * Интеграция ChatOrchestrator × LLM Gateway (ADR-036), слой 3:
 * - _getProvider оборачивает провайдер в GatewayProvider когда gateway включён;
 * - при выключенном gateway возвращается исходный провайдер;
 * - _saveAssistantMessage добавляет metadata.secrets для существующих плейсхолдеров.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatOrchestrator } from '../orchestrator.js';
import { SessionManager } from '../../sessions/manager.js';
import { FileStore } from '../../storage/file-store.js';
import { EventBus } from '../../events/bus.js';
import { ProviderFactory, BaseProvider, resolveSystemPromptText } from '../../providers/base.js';
import type { LLMMessage, CancellationToken } from '../../providers/base.js';
import { GatewayProvider, AuditLogger } from './index.js';
import { DebugCollector } from '../../debug.js';
import { ContextConfig } from '../context/config.js';
import { ContextBuilder } from '../context/builder.js';
import type { Session, Message, LLMGatewayConfig, TokenUsage } from '@itphx/synth-shared';
import { MessageRole, nowISO } from '@itphx/synth-shared';
import { enqueueUserMessage, QueueProcessorManager, type ProcessMessageFn } from '../../queue/processor.js';

class MockGwProvider extends BaseProvider {
  static capturedSystemPrompt: string | null = null;

  async chat(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
    _stream?: boolean,
    _debugCollector?: unknown,
  ): Promise<import('@itphx/synth-shared').LLMResponse> {
    return { content: 'ok', model: this.model, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
  }

  async *chatAsync(
    _messages: LLMMessage[],
    systemPrompt?: string,
    _tools?: Record<string, unknown>[],
    _debugCollector?: unknown,
    _cancellationToken?: CancellationToken,
  ): AsyncGenerator<import('@itphx/synth-shared').LLMChunk> {
    MockGwProvider.capturedSystemPrompt = resolveSystemPromptText(systemPrompt) ?? null;
    yield { content: 'ok', isFinal: true, model: this.model, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
  }

  getProviderName(): string {
    return 'mockgw';
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

function makeGatewayConfig(): LLMGatewayConfig {
  return {
    enabled: true,
    inputMode: 'obfuscate',
    logPayloads: false,
    payloadLogPath: '',
    rateLimit: { userPerMinute: 60, providerPerMinute: 120 },
    audit: { enabled: true, logPath: '' },
  };
}

describe('ChatOrchestrator × LLM Gateway (ADR-036)', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-gw-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    ProviderFactory.register('mockgw', MockGwProvider);
    MockGwProvider.capturedSystemPrompt = null;
  });

  afterEach(async () => {
    ProviderFactory['_providers'].delete('mockgw');
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeOrchestrator(gatewayConfig?: LLMGatewayConfig, auditLogger?: AuditLogger, contextBuilder?: ContextBuilder) {
    return new ChatOrchestrator({
      sessionManager,
      eventBus: new EventBus(),
      contextBuilder: contextBuilder ?? makeCtxBuilder(),
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
      gatewayAuditLogger: auditLogger,
    });
  }

  async function makeSession(opts: { obfuscationMap?: Record<string, string>; language?: string; systemPrompt?: string } = {}): Promise<Session> {
    const session = await sessionManager.createSession({
      title: 'S',
      settings: {
        provider: 'mockgw',
        model: 'mock-model',
        language: opts.language,
        systemPrompt: opts.systemPrompt,
      },
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

  it('_getAssistantSecrets возвращает секреты для плейсхолдеров в тексте (проброс в stream.done)', async () => {
    const orch = makeOrchestrator(makeGatewayConfig());
    const session = await makeSession({
      obfuscationMap: {
        '⟦SYNTH_SECRET_1⟧': 'sk-abc123',
        '⟦SYNTH_SECRET_2⟧': 'other-token',
      },
    });

    const getSecrets = (orch as unknown as {
      _getAssistantSecrets(sessionId: string, content: string): Promise<Record<string, string>>;
    })._getAssistantSecrets;

    const secrets = await getSecrets.call(orch, session.id, 'Ключ ⟦SYNTH_SECRET_1⟧ в ответе');
    expect(secrets['⟦SYNTH_SECRET_1⟧']).toBe('sk-abc123');
    // Плейсхолдер, которого нет в тексте — не возвращается
    expect(Object.keys(secrets)).not.toContain('⟦SYNTH_SECRET_2⟧');
  });

  it('_getAssistantSecrets возвращает пустой объект без плейсхолдеров или при выключенном gateway', async () => {
    const orch = makeOrchestrator(makeGatewayConfig());
    const session = await makeSession({
      obfuscationMap: { '⟦SYNTH_SECRET_1⟧': 'sk-abc123' },
    });

    const getSecrets = (orch as unknown as {
      _getAssistantSecrets(sessionId: string, content: string): Promise<Record<string, string>>;
    })._getAssistantSecrets;

    const noPlaceholders = await getSecrets.call(orch, session.id, 'Обычный ответ');
    expect(Object.keys(noPlaceholders)).toHaveLength(0);

    const disabled = makeOrchestrator({ ...makeGatewayConfig(), enabled: false });
    const disabledSecrets = await getSecrets.call(disabled, session.id, 'Ключ ⟦SYNTH_SECRET_1⟧ в ответе');
    expect(Object.keys(disabledSecrets)).toHaveLength(0);
  });

  it('setGatewayConfig включает gateway на лету (live-переключение без рестарта)', async () => {
    const orch = makeOrchestrator(); // gateway выключен по умолчанию
    const session = await makeSession();

    // До включения — исходный провайдер без обёртки
    let provider = getProviderOf(orch, session);
    expect(provider).toBeInstanceOf(MockGwProvider);

    // Включаем на лету — провайдер оборачивается в GatewayProvider
    orch.setGatewayConfig(makeGatewayConfig());
    provider = getProviderOf(orch, session);
    expect(provider).toBeInstanceOf(GatewayProvider);

    // Выключаем — обёртка снова снимается
    orch.setGatewayConfig({ ...makeGatewayConfig(), enabled: false });
    provider = getProviderOf(orch, session);
    expect(provider).toBeInstanceOf(MockGwProvider);
  });

  it('setGatewayConfig повторное включение не теряет карту обфускации сессии', async () => {
    const orch = makeOrchestrator(makeGatewayConfig());
    const session = await makeSession({
      obfuscationMap: { '⟦SYNTH_SECRET_1⟧': 'sk-abc123' },
    });

    // Выключаем и снова включаем — карта живёт в сессии (Session.obfuscationMap)
    orch.setGatewayConfig(null);
    orch.setGatewayConfig(makeGatewayConfig());

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
      'stream-3',
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
    expect((msg?.metadata?.secrets as Record<string, string> | undefined)?.['⟦SYNTH_SECRET_1⟧']).toBe('sk-abc123');
  });

  function makeUserMessage(content: string, id = 'msg-user'): Message {
    return {
      id,
      role: MessageRole.USER,
      seq: 1,
      origin: 'local',
      parts: [{ id: `part-${id}`, type: 'text', data: content }],
      content,
      createdAt: nowISO(),
      disabled: false,
      pinned: false,
      hidden: false,
      author: 'u1',
      metadata: { stream_id: 'stream-user' },
    };
  }

  it('obfuscateUserMessageForHistory обфусцирует user-сообщение и сохраняет карту (gateway включён)', async () => {
    const orch = makeOrchestrator(makeGatewayConfig());
    const session = await makeSession();

    const result = await orch.obfuscateUserMessageForHistory(
      session.id,
      makeUserMessage('Мой email a@b.com для связи'),
    );

    expect(result.content).toContain('⟦SYNTH_SECRET_1⟧');
    expect(result.content).not.toContain('a@b.com');
    expect((result.metadata?.secrets as Record<string, string> | undefined)?.['⟦SYNTH_SECRET_1⟧']).toBe('a@b.com');
    expect(result.parts[0]).toMatchObject({ type: 'text', data: expect.stringContaining('⟦SYNTH_SECRET_1⟧') });

    // Карта обфускации сохранена в сессию (Session.obfuscationMap)
    const updated = await sessionManager.getSession(session.id);
    expect(updated?.obfuscationMap?.['⟦SYNTH_SECRET_1⟧']).toBe('a@b.com');
  });

  it('obfuscateUserMessageForHistory не меняет сообщение когда gateway выключен', async () => {
    const orch = makeOrchestrator({ ...makeGatewayConfig(), enabled: false });
    const session = await makeSession();

    const userMsg = makeUserMessage('Мой email a@b.com для связи');
    const result = await orch.obfuscateUserMessageForHistory(session.id, userMsg);

    // Тот же объект, без изменений — обратная совместимость
    expect(result).toBe(userMsg);
    expect(result.content).toBe('Мой email a@b.com для связи');

    const updated = await sessionManager.getSession(session.id);
    expect(updated?.obfuscationMap).toBeUndefined();
  });

  it('obfuscateUserMessageForHistory переиспользует существующий плейсхолдер для повторного секрета', async () => {
    const orch = makeOrchestrator(makeGatewayConfig());
    const session = await makeSession({
      obfuscationMap: { '⟦SYNTH_SECRET_1⟧': 'a@b.com' },
    });

    const result = await orch.obfuscateUserMessageForHistory(
      session.id,
      makeUserMessage('Пиши на a@b.com или a@b.com'),
    );

    expect(result.content).toContain('⟦SYNTH_SECRET_1⟧');
    expect(result.content).not.toContain('⟦SYNTH_SECRET_2⟧');
    expect(result.content).not.toContain('a@b.com');
  });

  it('obfuscateUserMessageForHistory пишет запись type:obfuscated в аудит (gateway включён)', async () => {
    const audit = new AuditLogger(join(tmpDir, 'audit', 'llm-gateway.jsonl'));
    const auditSpy = vi.spyOn(audit, 'append');
    const orch = makeOrchestrator(makeGatewayConfig(), audit);
    const session = await makeSession();

    await orch.obfuscateUserMessageForHistory(
      session.id,
      makeUserMessage('Мой email a@b.com для связи'),
    );

    // Секреты в аудите — только маской, без реальных значений
    expect(auditSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: 'obfuscated',
      sessionId: session.id,
      userId: 'u1',
      secretsFound: ['email***'],
      placeholders: ['⟦SYNTH_SECRET_1⟧'],
    }));
  });

  it('obfuscateUserMessageForHistory не пишет в аудит когда секретов нет', async () => {
    const audit = new AuditLogger(join(tmpDir, 'audit', 'llm-gateway.jsonl'));
    const auditSpy = vi.spyOn(audit, 'append');
    const orch = makeOrchestrator(makeGatewayConfig(), audit);
    const session = await makeSession();

    await orch.obfuscateUserMessageForHistory(
      session.id,
      makeUserMessage('Обычное сообщение без секретов'),
    );

    expect(auditSpy).not.toHaveBeenCalled();
  });

  it('enqueueUserMessage сохраняет обфусцированное user-сообщение в pending (gateway включён)', async () => {
    const orch = makeOrchestrator(makeGatewayConfig());
    const session = await makeSession();
    const queueManager = { createProcessor: () => {} } as unknown as QueueProcessorManager;
    const processMessage: ProcessMessageFn = async () => ({});

    const result = await enqueueUserMessage(
      sessionManager, new EventBus(), session.id,
      makeUserMessage('Напиши на a@b.com'),
      queueManager, processMessage,
      (sid, msg) => orch.obfuscateUserMessageForHistory(sid, msg),
    );

    expect(result).not.toBeNull();
    const updated = await sessionManager.getSession(session.id);
    expect(updated?.pendingMessages[0]?.content).toContain('⟦SYNTH_SECRET_1⟧');
    expect(updated?.pendingMessages[0]?.content).not.toContain('a@b.com');
    expect(updated?.obfuscationMap?.['⟦SYNTH_SECRET_1⟧']).toBe('a@b.com');
  });

  it('enqueueUserMessage не обфусцирует когда gateway выключен (обратная совместимость)', async () => {
    const orch = makeOrchestrator({ ...makeGatewayConfig(), enabled: false });
    const session = await makeSession();
    const queueManager = { createProcessor: () => {} } as unknown as QueueProcessorManager;
    const processMessage: ProcessMessageFn = async () => ({});

    const result = await enqueueUserMessage(
      sessionManager, new EventBus(), session.id,
      makeUserMessage('Мой email a@b.com для связи'),
      queueManager, processMessage,
      (sid, msg) => orch.obfuscateUserMessageForHistory(sid, msg),
    );

    expect(result).not.toBeNull();
    const updated = await sessionManager.getSession(session.id);
    expect(updated?.pendingMessages[0]?.content).toContain('a@b.com');
    expect(updated?.obfuscationMap).toBeUndefined();
  });

  function runPromptOnce(orch: ChatOrchestrator, session: Session, msg: Message) {
    const processMessage = orch.createProcessMessage();
    return processMessage(session, msg, new AbortController().signal, () => {});
  }

  it('system prompt содержит [GATEWAY] и ⟦SYNTH_SECRET_N⟧ когда gateway включён', async () => {
    const contextBuilder = new ContextBuilder(new ContextConfig({ userDataDir: join(tmpDir, 'context') }));
    const orch = makeOrchestrator(makeGatewayConfig(), undefined, contextBuilder);
    const session = await makeSession({ language: 'ru' });
    const msg = makeUserMessage('Привет');
    await sessionManager.addMessage(session.id, msg);
    const fresh = (await sessionManager.getSession(session.id))!;

    const result = await runPromptOnce(orch, fresh, msg);
    expect(result.error).toBeUndefined();

    const sp = MockGwProvider.capturedSystemPrompt ?? '';
    expect(sp).toContain('[GATEWAY]');
    expect(sp).toContain('⟦SYNTH_SECRET_N⟧');
  });

  it('system prompt НЕ содержит [GATEWAY] когда gateway выключен', async () => {
    const contextBuilder = new ContextBuilder(new ContextConfig({ userDataDir: join(tmpDir, 'context') }));
    const orch = makeOrchestrator({ ...makeGatewayConfig(), enabled: false }, undefined, contextBuilder);
    const session = await makeSession({ language: 'ru' });
    const msg = makeUserMessage('Привет');
    await sessionManager.addMessage(session.id, msg);
    const fresh = (await sessionManager.getSession(session.id))!;

    const result = await runPromptOnce(orch, fresh, msg);
    expect(result.error).toBeUndefined();

    const sp = MockGwProvider.capturedSystemPrompt ?? '';
    expect(sp).not.toContain('[GATEWAY]');
    expect(sp).not.toContain('⟦SYNTH_SECRET_N⟧');
  });

  it('gateway-инструкция добавляется даже когда systemPrompt задан пользователем', async () => {
    const contextBuilder = new ContextBuilder(new ContextConfig({ userDataDir: join(tmpDir, 'context') }));
    const orch = makeOrchestrator(makeGatewayConfig(), undefined, contextBuilder);
    const session = await makeSession({ language: 'ru', systemPrompt: 'Ты — персональный ассистент.' });
    const msg = makeUserMessage('Привет');
    await sessionManager.addMessage(session.id, msg);
    const fresh = (await sessionManager.getSession(session.id))!;

    const result = await runPromptOnce(orch, fresh, msg);
    expect(result.error).toBeUndefined();

    const sp = MockGwProvider.capturedSystemPrompt ?? '';
    expect(sp).toContain('Ты — персональный ассистент.');
    expect(sp).toContain('[GATEWAY]');
    expect(sp).toContain('⟦SYNTH_SECRET_N⟧');
  });
});

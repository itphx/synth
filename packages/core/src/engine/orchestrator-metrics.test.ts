/**
 * ADR-094: проводка реестра метрик в оркестратор — LLM-вызовы обычной сессии
 * (не через LLM-прокси) учитываются даже при выключенном LLM Gateway.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatOrchestrator } from './orchestrator.js';
import { SessionManager } from '../sessions/manager.js';
import { FileStore } from '../storage/file-store.js';
import { EventBus } from '../events/bus.js';
import { MetricsRegistry } from '../metrics/registry.js';
import { ProviderFactory, BaseProvider } from '../providers/base.js';
import type { LLMMessage, SystemPromptInput, CancellationToken } from '../providers/base.js';
import type { ContextBuilder } from './context/builder.js';
import { generateId, MessageRole, nowISO, makeTextPart } from '@itphx/synth-shared';
import type { Message, TokenUsage } from '@itphx/synth-shared';

const USAGE: TokenUsage = { inputTokens: 7, outputTokens: 3, totalTokens: 10 };

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

/** Мок-провайдер: отдаёт usage, чтобы токенные метрики точно появились. */
class MetricsProvider extends BaseProvider {
  async chat(
    _messages: LLMMessage[],
    _systemPrompt?: SystemPromptInput,
    _tools?: Record<string, unknown>[],
    _stream?: boolean,
    _debugCollector?: unknown,
  ): Promise<import('@itphx/synth-shared').LLMResponse> {
    return { content: 'ok', model: this.model, usage: USAGE };
  }

  async *chatAsync(
    _messages: LLMMessage[],
    _systemPrompt?: SystemPromptInput,
    _tools?: Record<string, unknown>[],
    _debugCollector?: unknown,
    _cancellationToken?: CancellationToken,
  ): AsyncGenerator<import('@itphx/synth-shared').LLMChunk> {
    yield { content: 'ok', isFinal: true, usage: USAGE, model: this.model };
  }

  getProviderName(): string {
    return 'metricsprovider';
  }
}

describe('ChatOrchestrator — метрики LLM-вызовов (ADR-094)', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-orch-metrics-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    ProviderFactory.register('metricsprovider', MetricsProvider);
  });

  afterEach(async () => {
    ProviderFactory['_providers'].delete('metricsprovider');
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('при выключенном gateway пишет requests/duration/tokens', async () => {
    const registry = new MetricsRegistry();
    const orchestrator = new ChatOrchestrator({
      sessionManager,
      eventBus: new EventBus(),
      contextBuilder: makeCtxBuilder(),
      providerLoader: (name: string) =>
        ({
          name,
          type: 'metricsprovider',
          baseUrl: '',
          apiKey: '',
          defaultModel: 'm',
        }) as unknown as import('@itphx/synth-shared').ProviderConfig,
      defaultWorkingDir: tmpDir,
      // gatewayConfig не задан — обёртка должна создаваться только из-за metrics.
      metrics: registry,
    });

    const session = await sessionManager.createSession({
      title: 'Metrics',
      settings: { provider: 'metricsprovider', model: 'm', agentRole: 'developer' },
    });
    const msg = makeUserMessage();
    await sessionManager.addMessage(session.id, msg);
    const fresh = (await sessionManager.getSession(session.id))!;

    await orchestrator.createProcessMessage()(fresh, msg, new AbortController().signal, () => {});

    const text = registry.render().text;
    expect(text).toContain('synth_llm_requests_total');
    expect(text).toContain('synth_llm_tokens_total');
    expect(text).toContain('synth_llm_duration_seconds');

    const byName = new Map(registry.snapshot().map((m) => [m.name, m]));
    expect(byName.get('synth_llm_requests_total')?.series[0]?.labels).toEqual({
      provider: 'metricsprovider',
      model: 'm',
      outcome: 'ok',
    });
    const tokenKinds = Object.fromEntries(
      (byName.get('synth_llm_tokens_total')?.series ?? []).map((s) => [s.labels.kind, s.value]),
    );
    expect(tokenKinds).toEqual({ input: 7, output: 3 });
  });
});

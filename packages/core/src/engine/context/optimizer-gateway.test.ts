/**
 * ADR-036/ADR-119: суммаризация и компактизация — LLM-вызов через
 * `GatewayProvider` **всегда** (инвариант 3), а не только при включённом
 * gateway/метриках.
 *
 * - при выключенных gateway/метриках провайдер всё равно обёрнут
 *   (`DISABLED_GATEWAY_CONFIG` — passthrough, guard/обфускация no-op);
 * - вызов учитывается метриками, но не создаёт audit-файл;
 * - при включённом gateway секреты в транскрипте обфусцируются до провайдера;
 * - провайдер суммаризации может быть задан отдельно (`summarization.provider`)
 *   и всё равно проходит через обёртку.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageRole, makeTextPart, nowISO } from '@itphx/synth-shared';
import type {
  LLMGatewayConfig,
  LLMResponse,
  Message,
  Session,
  TokenUsage,
} from '@itphx/synth-shared';
import { ContextOptimizer, type ContextOptimizerGatewayHooks } from './optimizer.js';
import { ContextConfig } from './config.js';
import { BaseProvider, ProviderFactory, type LLMMessage } from '../../providers/base.js';
import {
  AuditLogger,
  DISABLED_GATEWAY_CONFIG,
  GatewayProvider,
  LlmFilterRegistry,
  ObfuscationMapStore,
  RateLimiter,
} from '../gateway/index.js';
import { MetricsRegistry } from '../../metrics/registry.js';

const SK_KEY = 'sk-abcdefghijklmnopqrst';
const USAGE: TokenUsage = { inputTokens: 100, outputTokens: 0, totalTokens: 100 };

class MockSummProvider extends BaseProvider {
  static capturedMessages: LLMMessage[] | null = null;
  static response: LLMResponse = {
    content: '## Objective\nцель\n\n## Work State\n- готово',
    model: 'summ-model',
    usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
  };

  async chat(messages: LLMMessage[]): Promise<LLMResponse> {
    MockSummProvider.capturedMessages = messages;
    return MockSummProvider.response;
  }

  async *chatAsync() {
    yield { content: MockSummProvider.response.content, isFinal: true, usage: MockSummProvider.response.usage };
  }

  getProviderName(): string {
    return 'summ-provider';
  }
}

function makeSession(messages: Message[]): Session {
  return {
    id: 's-summ',
    userId: 'u1',
    settings: {
      provider: 'session-provider',
      model: 'session-model',
      contextOptimization: 'compaction',
      compactionKeepTokens: 250,
      compactionTokenThreshold: 85,
      language: 'ru',
    },
    messages,
  } as unknown as Session;
}

function makeMessage(id: string, role: MessageRole, content: string, usage: TokenUsage = USAGE): Message {
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
    usage,
  } as Message;
}

describe('ContextOptimizer × LLM Gateway (ADR-036/ADR-119)', () => {
  let tmpDir: string;
  let optimizer: ContextOptimizer;
  let auditPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-opt-gw-'));
    auditPath = join(tmpDir, 'audit', 'llm-gateway.jsonl');
    MockSummProvider.capturedMessages = null;
    ProviderFactory.register('mock-summ', MockSummProvider);
    optimizer = new ContextOptimizer(
      new ContextConfig({ userDataDir: tmpDir }),
      (name) => (name === 'summ-provider'
        ? {
            name,
            type: 'mock-summ',
            baseUrl: 'http://localhost:9999/v1',
            apiKey: 'test-key',
            defaultModel: 'summ-model',
            timeout: 10,
          }
        : null),
      // Провайдер суммаризации задан отдельно — отличается от сессионного.
      { provider: 'summ-provider', model: 'summ-model', temperature: 0.1, promptFile: 'COMPACTOR' },
      () => 200_000,
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    ProviderFactory['_providers'].delete('mock-summ');
    await rm(tmpDir, { recursive: true, force: true });
  });

  function hooks(
    config: LLMGatewayConfig,
    opts: { metrics?: MetricsRegistry; filters?: LlmFilterRegistry } = {},
  ): ContextOptimizerGatewayHooks {
    return {
      config,
      audit: new AuditLogger(auditPath),
      rateLimiter: new RateLimiter(100, 100),
      obfMapStore: {
        get: async () => ({}),
        set: async () => {},
      } as unknown as ObfuscationMapStore,
      ...(opts.metrics ? { metrics: opts.metrics } : {}),
      ...(opts.filters ? { filters: opts.filters } : {}),
    };
  }

  function compressibleSession(content = 'u1'): Session {
    return makeSession([
      makeMessage('u1', MessageRole.USER, content),
      makeMessage('a1', MessageRole.ASSISTANT, 'a1'),
      makeMessage('u2', MessageRole.USER, 'u2'),
      makeMessage('a2', MessageRole.ASSISTANT, 'a2'),
    ]);
  }

  it('при выключенных gateway/метриках провайдер суммаризации всё равно обёрнут', () => {
    optimizer.setGatewayHooks(hooks(DISABLED_GATEWAY_CONFIG));

    const plan = optimizer.prepareCompression(compressibleSession());

    expect(plan.provider).toBeInstanceOf(GatewayProvider);
    // Провайдер суммаризации — не провайдер сессии, но обёрнут он.
    expect(plan.provider.getProviderName()).toBe('summ-provider');
    expect(plan.provider.model).toBe('summ-model');
  });

  it('вызов суммаризации учитывается метриками, но audit-файл не создаётся', async () => {
    const metrics = new MetricsRegistry();
    optimizer.setGatewayHooks(hooks(DISABLED_GATEWAY_CONFIG, { metrics }));

    const plan = optimizer.prepareCompression(compressibleSession());
    await optimizer.completeCompression(plan);

    const rendered = metrics.render().text;
    expect(rendered).toContain('synth_llm_requests_total');
    expect(rendered).toContain('outcome="ok"');
    // Ленивый AuditLogger при `enabled:false` не пишет и не создаёт файл.
    await expect(access(auditPath)).rejects.toThrow();
  });

  it('при включённом gateway секрет обфусцируется, а pre_request-фильтр видит вызов', async () => {
    const filters = new LlmFilterRegistry();
    const inspect = vi.fn(() => ({ verdict: 'allow' as const }));
    filters.register(
      { id: 'plugin:test:see-summ', phase: 'pre_request', inspect },
      { trustLevel: 'trusted' },
    );
    optimizer.setGatewayHooks(hooks({ ...DISABLED_GATEWAY_CONFIG, enabled: true }, { filters }));

    const plan = optimizer.prepareCompression(compressibleSession(`ключ ${SK_KEY}`));
    await optimizer.completeCompression(plan);

    // Суммаризация проходит общий контур фильтров (ADR-090).
    expect(inspect).toHaveBeenCalledTimes(1);

    const sent = (MockSummProvider.capturedMessages ?? []).map((m) => m.content).join('\n');
    expect(sent).toContain('⟦SYNTH_SECRET_1⟧');
    expect(sent).not.toContain(SK_KEY);
    // Аудит включён — запись появилась (guard работал по общему контуру).
    await expect(access(auditPath)).resolves.toBeUndefined();
  });
});

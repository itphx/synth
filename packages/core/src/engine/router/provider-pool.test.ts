/**
 * Тесты интеграции ProviderPool × LLM Gateway (AD-036):
 * провайдер оборачивается GatewayProvider когда gateway включён,
 * и не оборачивается когда выключен/не задана фабрика.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ProviderPool } from './provider-pool.js';
import { ProviderFactory, BaseProvider } from '../../providers/base.js';
import type { LLMMessage, CancellationToken } from '../../providers/base.js';
import { GatewayProvider } from '../gateway/index.js';
import type { AuditLogger, RateLimiter } from '../gateway/index.js';
import type { LLMGatewayConfig } from '@synth/shared';

const noopAudit = (): AuditLogger => ({ append: async () => {} }) as unknown as AuditLogger;
const noopRateLimiter = (): RateLimiter =>
  ({ checkUser: () => true, checkProvider: () => true, reset: () => {} }) as unknown as RateLimiter;

class MockPoolProvider extends BaseProvider {
  async chat(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
    _stream?: boolean,
    _debugCollector?: unknown,
  ): Promise<import('@synth/shared').LLMResponse> {
    return { content: 'ok', model: this.model, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
  }

  async *chatAsync(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
    _debugCollector?: unknown,
    _cancellationToken?: CancellationToken,
  ): AsyncGenerator<import('@synth/shared').LLMChunk> {
    yield { content: 'ok', isFinal: true, model: this.model, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
  }

  getProviderName(): string {
    return 'mockpool';
  }
}

function makeGatewayConfig(overrides: Partial<LLMGatewayConfig> = {}): LLMGatewayConfig {
  return {
    enabled: true,
    inputMode: 'obfuscate',
    rateLimit: { userPerMinute: 60, providerPerMinute: 120 },
    audit: { enabled: true, logPath: '' },
    ...overrides,
  };
}

function makeLoader(): (name: string) => import('@synth/shared').ProviderConfig | null {
  return (name: string) => {
    if (name !== 'mockpool') return null;
    return {
      name,
      type: 'mockpool',
      baseUrl: 'http://localhost:9999/v1',
      apiKey: 'test-key',
      defaultModel: 'mock-model',
      timeout: 10,
    };
  };
}

describe('ProviderPool × LLM Gateway (AD-036)', () => {
  beforeEach(() => {
    ProviderFactory.register('mockpool', MockPoolProvider);
  });

  afterEach(() => {
    ProviderFactory['_providers'].delete('mockpool');
  });

  it('оборачивает провайдер в GatewayProvider когда gateway enabled и задана фабрика', () => {
    const pool = new ProviderPool(
      makeLoader(),
      makeGatewayConfig(),
      (inner) => new GatewayProvider(inner, makeGatewayConfig(), {
        getMap: async () => ({}),
        saveMap: async () => {},
        getAudit: noopAudit,
        getRateLimiter: noopRateLimiter,
        sessionId: '',
        userId: '',
      }),
    );

    const provider = pool.getProvider('mockpool', 'mock-model');
    expect(provider).not.toBeNull();
    expect(provider).toBeInstanceOf(GatewayProvider);
  });

  it('не оборачивает провайдер когда gateway disabled', () => {
    const pool = new ProviderPool(
      makeLoader(),
      makeGatewayConfig({ enabled: false }),
      (inner) => new GatewayProvider(inner, makeGatewayConfig(), {
        getMap: async () => ({}),
        saveMap: async () => {},
        getAudit: noopAudit,
        getRateLimiter: noopRateLimiter,
        sessionId: '',
        userId: '',
      }),
    );

    const provider = pool.getProvider('mockpool', 'mock-model');
    expect(provider).not.toBeNull();
    expect(provider).not.toBeInstanceOf(GatewayProvider);
    expect(provider).toBeInstanceOf(MockPoolProvider);
  });

  it('не оборачивает провайдер когда фабрика не задана', () => {
    const pool = new ProviderPool(makeLoader(), makeGatewayConfig());

    const provider = pool.getProvider('mockpool', 'mock-model');
    expect(provider).not.toBeNull();
    expect(provider).not.toBeInstanceOf(GatewayProvider);
    expect(provider).toBeInstanceOf(MockPoolProvider);
  });

  it('кеширует один обёрнутый экземпляр на ключ', () => {
    const pool = new ProviderPool(
      makeLoader(),
      makeGatewayConfig(),
      (inner) => new GatewayProvider(inner, makeGatewayConfig(), {
        getMap: async () => ({}),
        saveMap: async () => {},
        getAudit: noopAudit,
        getRateLimiter: noopRateLimiter,
        sessionId: '',
        userId: '',
      }),
    );

    const first = pool.getProvider('mockpool', 'mock-model');
    const second = pool.getProvider('mockpool', 'mock-model');
    expect(first).toBe(second);
    expect(first).toBeInstanceOf(GatewayProvider);
  });
});

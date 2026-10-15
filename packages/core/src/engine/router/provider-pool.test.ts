/**
 * Тесты интеграции ProviderPool × LLM Gateway (ADR-036):
 * провайдер оборачивается GatewayProvider когда gateway включён,
 * и не оборачивается когда выключен/не задана фабрика.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ProviderPool } from './provider-pool.js';
import { ProviderFactory, BaseProvider } from '../../providers/base.js';
import type { LLMMessage, CancellationToken } from '../../providers/base.js';
import { GatewayProvider } from '../gateway/index.js';
import type { AuditLogger, RateLimiter } from '../gateway/index.js';
import type { LLMGatewayConfig } from '@itphx/synth-shared';

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
  ): Promise<import('@itphx/synth-shared').LLMResponse> {
    return { content: 'ok', model: this.model, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
  }

  async *chatAsync(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
    _debugCollector?: unknown,
    _cancellationToken?: CancellationToken,
  ): AsyncGenerator<import('@itphx/synth-shared').LLMChunk> {
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
    logPayloads: false,
    payloadLogPath: '',
    rateLimit: { userPerMinute: 60, providerPerMinute: 120 },
    audit: { enabled: true, logPath: '' },
    ...overrides,
  };
}

function makeLoader(): (name: string) => import('@itphx/synth-shared').ProviderConfig | null {
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

/** ADR-084: decision-провайдер-мок для проверки безусловной обвязки. */
class MockDecisionProvider extends BaseProvider {
  async chat(): Promise<import('@itphx/synth-shared').LLMResponse> {
    throw new Error('not chat');
  }

  chatAsync(): AsyncGenerator<import('@itphx/synth-shared').LLMChunk> {
    throw new Error('not chat');
  }

  getProviderName(): string {
    return 'decision-mock';
  }

  async decide(): Promise<import('@itphx/synth-shared').DecisionResponse> {
    return { answers: {} };
  }
}

function makeDecisionLoader(): (name: string) => import('@itphx/synth-shared').ProviderConfig | null {
  return (name: string) => {
    if (name !== 'decision-mock') return null;
    return {
      name,
      type: 'decision-mock',
      baseUrl: 'http://localhost:9999/api/v1',
      defaultModel: 'clef-flash',
      timeout: 10,
    };
  };
}

describe('ProviderPool × LLM Gateway (ADR-036)', () => {
  beforeEach(() => {
    ProviderFactory.register('mockpool', MockPoolProvider);
    ProviderFactory.register('decision-mock', MockDecisionProvider);
  });

  afterEach(() => {
    ProviderFactory['_providers'].delete('mockpool');
    ProviderFactory['_providers'].delete('decision-mock');
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

  it('setGateway включает обёртку на лету и сбрасывает кеш', () => {
    // Стартуем без gateway — провайдер не обёрнут
    const pool = new ProviderPool(makeLoader());
    let provider = pool.getProvider('mockpool', 'mock-model');
    expect(provider).toBeInstanceOf(MockPoolProvider);

    // Включаем gateway — старый кеш сбрасывается, новый провайдер обёрнут
    pool.setGateway(
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
    provider = pool.getProvider('mockpool', 'mock-model');
    expect(provider).toBeInstanceOf(GatewayProvider);
  });

  it('setGateway выключает обёртку на лету и сбрасывает кеш', () => {
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
    let provider = pool.getProvider('mockpool', 'mock-model');
    expect(provider).toBeInstanceOf(GatewayProvider);

    // Выключаем — кеш сбрасывается, провайдер создаётся без обёртки
    pool.setGateway(null, null);
    provider = pool.getProvider('mockpool', 'mock-model');
    expect(provider).not.toBeInstanceOf(GatewayProvider);
    expect(provider).toBeInstanceOf(MockPoolProvider);
  });

  it('ADR-084: getDecisionProvider оборачивает в GatewayProvider даже при gateway disabled', () => {
    const pool = new ProviderPool(makeDecisionLoader(), makeGatewayConfig({ enabled: false }));
    pool.setDecisionGatewayFactory((inner) => new GatewayProvider(inner, makeGatewayConfig({ enabled: false }), {
      getMap: async () => ({}),
      saveMap: async () => {},
      getAudit: noopAudit,
      getRateLimiter: noopRateLimiter,
      sessionId: '',
      userId: '',
    }));

    const provider = pool.getDecisionProvider('decision-mock', 'clef-flash');
    expect(provider).not.toBeNull();
    expect(provider).toBeInstanceOf(GatewayProvider);
  });

  it('ADR-084: decision-кеш отделён от chat-кеша и переиспользует обёрнутый экземпляр', () => {
    const pool = new ProviderPool(makeDecisionLoader(), makeGatewayConfig({ enabled: false }));
    pool.setDecisionGatewayFactory((inner) => new GatewayProvider(inner, makeGatewayConfig({ enabled: false }), {
      getMap: async () => ({}),
      saveMap: async () => {},
      getAudit: noopAudit,
      getRateLimiter: noopRateLimiter,
      sessionId: '',
      userId: '',
    }));

    const first = pool.getDecisionProvider('decision-mock', 'clef-flash');
    const second = pool.getDecisionProvider('decision-mock', 'clef-flash');
    expect(first).toBe(second);
    expect(first).toBeInstanceOf(GatewayProvider);
  });

  it('ADR-084: без decision-фабрики провайдер создаётся без обвязки', () => {
    const pool = new ProviderPool(makeDecisionLoader());
    const provider = pool.getDecisionProvider('decision-mock', 'clef-flash');
    expect(provider).toBeInstanceOf(MockDecisionProvider);
  });
});

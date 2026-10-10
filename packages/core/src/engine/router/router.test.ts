/**
 * Тесты ModelRouter × DecisionContentClassifier (AD-084 × AD-034).
 * Проверяем порядок приоритетов: keyword >= 0.5 → routingCategory → decision →
 * keyword-fallback, а также что `route` стал async.
 */
import { describe, it, expect, vi } from 'vitest';
import { ModelRouter } from './router.js';
import type { ContentClassifier, ClassifyResult } from './content-classifier.js';
import type { DecisionContentClassifier } from './decision-content-classifier.js';
import type { ProviderPool } from './provider-pool.js';
import type { QualityChecker } from './quality-checker.js';
import type { RouterConfig, SessionSettings } from '@itphx/synth-shared';
import type { BaseProvider } from '../../providers/base.js';

function stubClassifier(result: ClassifyResult): ContentClassifier {
  return { classify: () => result } as unknown as ContentClassifier;
}

function stubPool(): ProviderPool {
  return {
    getProvider: () => ({ name: 'stub', model: 'stub-model' }) as unknown as BaseProvider,
  } as unknown as ProviderPool;
}

function stubRouterConfig(overrides: Partial<RouterConfig> = {}): RouterConfig {
  return {
    enabled: true,
    strategy: 'content',
    content: {
      coding: { provider: 'p-code', model: 'm-code' },
      research: { provider: 'p-res', model: 'm-res' },
      chat: { provider: 'p-chat', model: 'm-chat' },
    },
    escalation: { enabled: true, checks: ['min_length'], minLength: 10 },
    cost: { enabled: false, cheapProvider: '', cheapModel: '', maxCheapTokens: 500 },
    ...overrides,
  } as unknown as RouterConfig;
}

function makeSettings(overrides: Partial<SessionSettings> = {}): SessionSettings {
  return {
    provider: 'default-p',
    model: 'default-m',
    routingEnabled: true,
    routingStrategy: 'content',
    routingCost: { enabled: false, cheapProvider: '', cheapModel: '', maxCheapTokens: 500 },
    ...overrides,
  } as unknown as SessionSettings;
}

interface DecisionStub {
  classifier: DecisionContentClassifier;
  classify: ReturnType<typeof vi.fn>;
}

function stubDecision(impl: () => Promise<ClassifyResult | null>): DecisionStub {
  const classify = vi.fn(impl);
  return { classifier: { classify } as unknown as DecisionContentClassifier, classify };
}

describe('ModelRouter × decision-классификатор (AD-084)', () => {
  it('keyword < 0.5 и нет routingCategory → используется decision-результат', async () => {
    const decision = stubDecision(async () => ({
      category: 'research',
      confidence: 0.9,
      signals: ['decision:research'],
    }));
    const router = new ModelRouter(
      stubClassifier({ category: 'chat', confidence: 0.3, signals: ['fallback'] }),
      stubPool(),
      {} as QualityChecker,
      stubRouterConfig(),
      decision.classifier,
    );

    const result = await router.route({ sessionSettings: makeSettings(), userMessage: 'непонятно' });

    expect(result.strategy).toBe('decision');
    expect(result.providerName).toBe('p-res');
    expect(result.modelName).toBe('m-res');
    expect(result.reason).toContain('decision:research');
    expect(decision.classify).toHaveBeenCalledTimes(1);
  });

  it('keyword >= 0.5 → decision не вызывается', async () => {
    const decision = stubDecision(async () => ({
      category: 'research',
      confidence: 0.9,
      signals: ['decision:research'],
    }));
    const router = new ModelRouter(
      stubClassifier({ category: 'coding', confidence: 0.7, signals: ['keyword:fix'] }),
      stubPool(),
      {} as QualityChecker,
      stubRouterConfig(),
      decision.classifier,
    );

    const result = await router.route({ sessionSettings: makeSettings(), userMessage: 'исправь' });

    expect(result.strategy).toBe('content');
    expect(result.providerName).toBe('p-code');
    expect(decision.classify).not.toHaveBeenCalled();
  });

  it('routingCategory задана → decision не вызывается (приоритет classify_conversation)', async () => {
    const decision = stubDecision(async () => ({
      category: 'research',
      confidence: 0.9,
      signals: ['decision:research'],
    }));
    const router = new ModelRouter(
      stubClassifier({ category: 'chat', confidence: 0.3, signals: ['fallback'] }),
      stubPool(),
      {} as QualityChecker,
      stubRouterConfig(),
      decision.classifier,
    );

    const result = await router.route({
      sessionSettings: makeSettings({ routingCategory: 'coding' }),
      userMessage: 'непонятно',
    });

    expect(result.strategy).toBe('model');
    expect(result.providerName).toBe('p-code');
    expect(decision.classify).not.toHaveBeenCalled();
  });

  it('decision вернул null (низкая уверенность/ошибка) → keyword-fallback', async () => {
    const decision = stubDecision(async () => null);
    const router = new ModelRouter(
      stubClassifier({ category: 'chat', confidence: 0.3, signals: ['fallback'] }),
      stubPool(),
      {} as QualityChecker,
      stubRouterConfig(),
      decision.classifier,
    );

    const result = await router.route({ sessionSettings: makeSettings(), userMessage: 'непонятно' });

    expect(result.strategy).toBe('content');
    expect(result.providerName).toBe('p-chat');
    expect(decision.classify).toHaveBeenCalledTimes(1);
  });

  it('strategy content+cost: keyword<0.5 → decision срабатывает в фоллбеке', async () => {
    const decision = stubDecision(async () => ({
      category: 'research',
      confidence: 0.85,
      signals: ['decision:research'],
    }));
    const router = new ModelRouter(
      stubClassifier({ category: 'chat', confidence: 0.3, signals: ['fallback'] }),
      stubPool(),
      {} as QualityChecker,
      stubRouterConfig({ strategy: 'content+cost' }),
      decision.classifier,
    );

    const result = await router.route({
      sessionSettings: makeSettings({ routingStrategy: 'content+cost' }),
      userMessage: 'непонятно',
    });

    expect(result.strategy).toBe('decision');
    expect(decision.classify).toHaveBeenCalledTimes(1);
  });

  it('без decision-классификатора поведение прежнее (keyword-fallback)', async () => {
    const router = new ModelRouter(
      stubClassifier({ category: 'chat', confidence: 0.3, signals: ['fallback'] }),
      stubPool(),
      {} as QualityChecker,
      stubRouterConfig(),
    );

    const result = await router.route({ sessionSettings: makeSettings(), userMessage: 'привет' });

    expect(result.strategy).toBe('content');
    expect(result.providerName).toBe('p-chat');
  });
});

/**
 * ADR-095 (шаг 6a): собственные тесты выбора провайдера/модели, gateway-обвязки
 * и fallback-цепочки роутера (ADR-034/ADR-036).
 *
 * Контракты:
 *  - `resolveModelContextWindow` — приоритет сохранённого окна (ModelConfig)
 *    над справочником;
 *  - `getEffectiveModel` — fallback-цепочка «настройка сессии → defaultModel»;
 *  - `getProvider` — `null` при неизвестном/недоступном провайдере (не бросает);
 *  - `wrapWithGateway` — выключенный gateway возвращает провайдер как есть;
 *  - `routeProvider` — порядок «роутер → fallback на провайдера сессии» и
 *    отсутствие двойной обёртки GatewayProvider.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lookupContextWindow } from '@itphx/synth-shared';
import type {
  LLMGatewayConfig,
  LLMChunk,
  LLMResponse,
  Message,
  ProviderConfig as SharedProviderConfig,
  Session,
} from '@itphx/synth-shared';
import { BaseProvider, ProviderFactory } from '../../providers/base.js';
import { GatewayProvider } from '../gateway/index.js';
import { AuditLogger } from '../gateway/audit-logger.js';
import { RateLimiter } from '../gateway/rate-limiter.js';
import type { ContextOptimizer } from '../context/optimizer.js';
import type { ModelRouter } from '../router/router.js';
import { DebugCollector } from '../../debug.js';
import {
  toCoreProviderConfig,
  resolveModelContextWindow,
  getEffectiveModel,
  wrapWithGateway,
  getProvider,
  routeProvider,
  type GatewayWrapDeps,
  type GetProviderDeps,
} from './routing.js';
import { DEFAULT_MAX_OUTPUT_TOKENS, REASONING_MIN_OUTPUT_TOKENS } from './max-output.js';

class MockProvider extends BaseProvider {
  async chat(): Promise<LLMResponse> {
    return { content: 'ok', model: this.model, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
  }

  async *chatAsync(): AsyncGenerator<LLMChunk> {
    yield { content: 'ok', isFinal: true, model: this.model };
  }

  getProviderName(): string {
    return 'orchmock';
  }
}

function makeSession(settings: Record<string, unknown> = {}): Session {
  return { id: 's1', userId: 'u1', settings: { ...settings } } as unknown as Session;
}

function makeMessage(extra: Partial<Message> = {}): Message {
  return { id: 'm1', role: 'user', content: 'привет', ...extra } as unknown as Message;
}

function providerLoader(configs: Record<string, SharedProviderConfig>) {
  return (name: string) => configs[name] ?? null;
}

function makeLoader(overrides: Partial<SharedProviderConfig> = {}): (name: string) => SharedProviderConfig | null {
  return providerLoader({
    mock: {
      name: 'mock',
      type: 'orchmock',
      baseUrl: 'http://localhost:1',
      apiKey: '',
      defaultModel: 'default-model',
      ...overrides,
    } as unknown as SharedProviderConfig,
  });
}

function makeGatewayDeps(overrides: Partial<GatewayWrapDeps> = {}): GatewayWrapDeps {
  return {
    gatewayConfig: null,
    gatewayPatternStore: null,
    obfMapStore: null,
    gatewayAudit: null,
    gatewayRateLimiter: null,
    gatewayPayloadLogPath: undefined,
    ...overrides,
  };
}

function makeGatewayConfig(enabled: boolean): LLMGatewayConfig {
  return {
    enabled,
    inputMode: 'obfuscate',
    logPayloads: false,
    payloadLogPath: '',
    rateLimit: { enabled: false, userPerMinute: 100, providerPerMinute: 100 },
    audit: { enabled: false, logPath: '' },
  } as unknown as LLMGatewayConfig;
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'synth-orch-routing-'));
  ProviderFactory.register('orchmock', MockProvider);
});

afterEach(async () => {
  ProviderFactory['_providers'].delete('orchmock');
  await rm(tmpDir, { recursive: true, force: true });
});

describe('toCoreProviderConfig / resolveModelContextWindow / getEffectiveModel', () => {
  it('маппит shared-конфиг в core-конфиг (baseUrl→url, дефолты пустые)', () => {
    const core = toCoreProviderConfig(
      { name: 'p', type: 'orchmock', baseUrl: 'http://x', apiKey: 'k', timeout: 5, numCtx: 1024 } as unknown as SharedProviderConfig,
      'model-x',
      'high',
    );
    expect(core).toEqual({
      name: 'p', type: 'orchmock', url: 'http://x', apiKey: 'k', model: 'model-x',
      timeout: 5, reasoningLevel: 'high', numCtx: 1024,
    });

    const empty = toCoreProviderConfig({ name: 'p', type: 'orchmock' } as unknown as SharedProviderConfig, 'm');
    expect(empty).toMatchObject({ url: '', apiKey: '' });
    expect(empty.reasoningLevel).toBeUndefined();
  });

  it('окно контекста: сохранённое значение приоритетнее справочника', () => {
    const optimizer = { getContextWindow: (m: string) => (m === 'm1' ? 4096 : 0) } as unknown as ContextOptimizer;
    expect(resolveModelContextWindow('m1', optimizer)).toBe(4096);
    expect(resolveModelContextWindow('m2', optimizer)).toBe(lookupContextWindow('m2').window);
    expect(resolveModelContextWindow('m2', null)).toBe(lookupContextWindow('m2').window);
  });

  it('эффективная модель: настройка сессии → defaultModel провайдера → пустая строка', () => {
    expect(getEffectiveModel(makeSession({ model: 's-model' }), 'mock', makeLoader())).toBe('s-model');
    expect(getEffectiveModel(makeSession(), 'mock', makeLoader())).toBe('default-model');
    expect(getEffectiveModel(makeSession(), 'missing', makeLoader())).toBe('');
  });
});

describe('wrapWithGateway (ADR-036)', () => {
  it('выключенный gateway возвращает провайдер как есть', () => {
    const provider = new MockProvider({ url: '', apiKey: '', model: 'm' });
    expect(wrapWithGateway(provider, makeSession(), makeGatewayDeps())).toBe(provider);
    expect(wrapWithGateway(provider, makeSession(), makeGatewayDeps({ gatewayConfig: makeGatewayConfig(false) }))).toBeInstanceOf(GatewayProvider);
  });

  it('включённый gateway оборачивает провайдера и обращается к карте обфускации сессии', async () => {
    const getMap = vi.fn(async () => ({}));
    const saveMap = vi.fn(async () => {});
    const provider = new MockProvider({ url: '', apiKey: '', model: 'm' });

    const wrapped = wrapWithGateway(
      provider,
      makeSession(),
      makeGatewayDeps({
        gatewayConfig: makeGatewayConfig(true),
        obfMapStore: { get: getMap, set: saveMap } as never,
        gatewayAudit: new AuditLogger(join(tmpDir, 'audit.jsonl')),
        gatewayRateLimiter: new RateLimiter(100, 100),
      }),
    );

    expect(wrapped).toBeInstanceOf(GatewayProvider);
    await wrapped.chat([]);
    expect(getMap).toHaveBeenCalledWith('s1');
    expect(saveMap).toHaveBeenCalledWith('s1', expect.any(Object));
  });
});

describe('getProvider', () => {
  function deps(overrides: Partial<GetProviderDeps> = {}): GetProviderDeps {
    return { providerLoader: makeLoader(), optimizer: null, gateway: makeGatewayDeps(), ...overrides };
  }

  it('неизвестный провайдер → null (без исключения)', () => {
    expect(getProvider('missing', makeSession(), undefined, deps())).toBeNull();
  });

  it('неизвестный тип провайдера → null (ошибка создания не выносит ход)', () => {
    const loader = makeLoader({ type: 'definitely-unknown-type' } as never);
    expect(getProvider('mock', makeSession({ model: 'm' }), undefined, deps({ providerLoader: loader }))).toBeNull();
  });

  it('модель сессии приоритетнее defaultModel; окно контекста подставляется в numCtx', () => {
    const optimizer = { getContextWindow: () => 8192 } as unknown as ContextOptimizer;
    const provider = getProvider('mock', makeSession({ model: 's-model' }), 'low', deps({ optimizer }))!;

    expect(provider).toBeInstanceOf(MockProvider);
    expect(provider.model).toBe('s-model');
    expect(provider.numCtx).toBe(8192);
    expect(provider.reasoningLevel).toBe('low');
  });

  it('provider.numCtx приоритетнее вычисленного окна', () => {
    const loader = makeLoader({ numCtx: 2048 } as never);
    const optimizer = { getContextWindow: () => 8192 } as unknown as ContextOptimizer;
    const provider = getProvider('mock', makeSession({ model: 'm' }), undefined, deps({ providerLoader: loader, optimizer }))!;
    expect(provider.numCtx).toBe(2048);
  });

  it('maxTokens/temperature сессии уходят в провайдер', () => {
    const provider = getProvider(
      'mock', makeSession({ model: 'm', maxTokens: 777, temperature: 0.1 }), undefined, deps(),
    )!;
    expect(provider.maxTokens).toBe(777);
    expect(provider.temperature).toBe(0.1);
  });

  it('maxTokens=0 (авто) → конфиг llm.maxTokens, затем дефолт ядра', () => {
    const fromConfig = getProvider(
      'mock', makeSession({ model: 'm', maxTokens: 0 }), undefined, deps({ defaultMaxOutputTokens: 12_000 }),
    )!;
    expect(fromConfig.maxTokens).toBe(12_000);

    const fallback = getProvider('mock', makeSession({ model: 'm', maxTokens: 0 }), undefined, deps())!;
    expect(fallback.maxTokens).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
  });

  it('каталог модели: лимит вывода берётся при авто и капит явное значение', () => {
    const resolve = () => 32_000;
    const auto = getProvider(
      'mock', makeSession({ model: 'm', maxTokens: 0 }), undefined,
      deps({ resolveModelMaxOutputTokens: resolve }),
    )!;
    expect(auto.maxTokens).toBe(32_000);

    const capped = getProvider(
      'mock', makeSession({ model: 'm', maxTokens: 64_000 }), undefined,
      deps({ resolveModelMaxOutputTokens: () => 8192 }),
    )!;
    expect(capped.maxTokens).toBe(8192);
  });

  it('reasoning-модель (MiniMax): пол вывода 8192 даже при сохранённых 4096', () => {
    const loader = providerLoader({
      minimax: {
        name: 'minimax', type: 'orchmock', baseUrl: 'https://api.minimax.io/v1',
        apiKey: '', defaultModel: 'MiniMax-M3.1',
      } as unknown as SharedProviderConfig,
    });
    const provider = getProvider(
      'minimax', makeSession({ model: 'MiniMax-M3.1', maxTokens: 4096 }), undefined,
      deps({ providerLoader: loader }),
    )!;
    expect(provider.maxTokens).toBe(REASONING_MIN_OUTPUT_TOKENS);

    // Кап каталога важнее пола: модель умеет меньше — не выходим за него.
    const capped = getProvider(
      'minimax', makeSession({ model: 'MiniMax-M3.1', maxTokens: 4096 }), undefined,
      deps({ providerLoader: loader, resolveModelMaxOutputTokens: () => 4096 }),
    )!;
    expect(capped.maxTokens).toBe(4096);
  });

  it('явная температура (агента) приоритетнее настройки сессии', () => {
    const provider = getProvider(
      'mock', makeSession({ model: 'm', temperature: 0.1 }), undefined, deps(), { temperature: 0.9 },
    )!;
    expect(provider.temperature).toBe(0.9);
  });

  it('модель агента перекрывает настройку сессии', () => {
    const provider = getProvider(
      'mock', makeSession({ model: 's-model' }), undefined, deps(), { model: 'agent-model' },
    )!;
    expect(provider.model).toBe('agent-model');
  });

  it('topP/topK агента уходят в провайдер', () => {
    const provider = getProvider(
      'mock', makeSession({ model: 'm' }), undefined, deps(), { topP: 0.9, topK: 40 },
    )!;
    expect(provider.topP).toBe(0.9);
    expect(provider.topK).toBe(40);
  });

  it('без topP/topK — поля не заданы (дефолт модели)', () => {
    const provider = getProvider('mock', makeSession({ model: 'm' }), undefined, deps())!;
    expect(provider.topP).toBeUndefined();
    expect(provider.topK).toBeUndefined();
  });

  it('без температур агента и сессии — дефолт модели (temperature undefined)', () => {
    const provider = getProvider('mock', makeSession({ model: 'm' }), undefined, deps())!;
    expect(provider.temperature).toBeUndefined();
  });

  it('провайдер оборачивается в gateway при заданном gatewayConfig', () => {
    const provider = getProvider(
      'mock', makeSession({ model: 'm' }), undefined,
      deps({ gateway: makeGatewayDeps({
        gatewayConfig: makeGatewayConfig(false),
        obfMapStore: { get: async () => ({}), set: async () => {} } as never,
        gatewayAudit: new AuditLogger(join(tmpDir, 'a.jsonl')),
        gatewayRateLimiter: new RateLimiter(1, 1),
      }) }),
    )!;
    expect(provider).toBeInstanceOf(GatewayProvider);
  });
});

describe('routeProvider (ADR-034)', () => {
  const decision = {
    providerName: 'mock',
    modelName: 'decision-model',
    reason: 'test',
    strategy: 'default',
  };

  function depsWithRouter(router: unknown, overrides: Partial<GetProviderDeps> = {}) {
    return {
      providerLoader: makeLoader(),
      optimizer: null,
      gateway: makeGatewayDeps(),
      router: router as ModelRouter,
      ...overrides,
    };
  }

  it('без роутера — провайдер из сообщения (приоритет) или из сессии', async () => {
    const fromMessage = await routeProvider(
      makeSession({ provider: 'session-provider' }), makeMessage({ provider: 'mock' } as never),
      undefined, undefined, depsWithRouter(null),
    );
    expect(fromMessage).toMatchObject({ providerName: 'mock', modelName: 'default-model' });

    const fromSession = await routeProvider(
      makeSession({ provider: 'mock', model: 's-model' }), makeMessage(), undefined, undefined, depsWithRouter(null),
    );
    expect(fromSession).toMatchObject({ providerName: 'mock', modelName: 's-model' });
  });

  it('routingEnabled=false отключает роутер — используется обычная цепочка', async () => {
    const route = vi.fn();
    const result = await routeProvider(
      makeSession({ provider: 'mock', model: 's-model', routingEnabled: false }),
      makeMessage(), undefined, undefined, depsWithRouter({ route, getProvider: vi.fn() }),
    );

    expect(route).not.toHaveBeenCalled();
    expect(result).toMatchObject({ providerName: 'mock', modelName: 's-model' });
  });

  it('решение роутера побеждает: providerName/modelName из решения', async () => {
    const routerProvider = new MockProvider({ url: '', apiKey: '', model: 'decision-model', type: 'orchmock' });
    const getProviderSpy = vi.fn(() => routerProvider);
    const result = await routeProvider(
      makeSession({ provider: 'mock', model: 's-model' }), makeMessage(), undefined, undefined,
      depsWithRouter({ route: vi.fn(async () => decision), getProvider: getProviderSpy }),
    );

    expect(result).toMatchObject({ providerName: 'mock', modelName: 'decision-model' });
    expect(result!.decision).toEqual(decision);
    expect(getProviderSpy).toHaveBeenCalled();
  });

  it('debug-контекст decision_routing пишется только для strategy=decision', async () => {
    const collector = new DebugCollector(true);
    const routerProvider = new MockProvider({ url: '', apiKey: '', model: 'm', type: 'orchmock' });

    await routeProvider(
      makeSession({ provider: 'mock' }), makeMessage(), undefined, collector,
      depsWithRouter({ route: vi.fn(async () => decision), getProvider: () => routerProvider }),
    );
    expect(collector.getDebugInfo()).toBeNull();

    const decisionStrategy = { ...decision, strategy: 'decision', category: 'coding', confidence: 0.9, signals: ['kw'] };
    await routeProvider(
      makeSession({ provider: 'mock' }), makeMessage(), undefined, collector,
      depsWithRouter({ route: vi.fn(async () => decisionStrategy), getProvider: () => routerProvider }),
    );
    expect(collector.getDebugInfo()).toMatchObject({
      extra_context: { decision_routing: { category: 'coding', confidence: 0.9, signals: ['kw'] } },
    });
  });

  it('провайдер роутера, уже обёрнутый в GatewayProvider, не оборачивается повторно', async () => {
    const inner = new MockProvider({ url: '', apiKey: '', model: 'm' });
    const alreadyWrapped = new GatewayProvider(inner, makeGatewayConfig(false), {
      getMap: async () => ({}),
      saveMap: async () => {},
      getAudit: () => new AuditLogger(join(tmpDir, 'a.jsonl')),
      getRateLimiter: () => new RateLimiter(1, 1),
      sessionId: 's1',
      userId: 'u1',
    });
    const result = await routeProvider(
      makeSession({ provider: 'mock' }), makeMessage(), undefined, undefined,
      depsWithRouter({ route: vi.fn(async () => decision), getProvider: () => alreadyWrapped }),
    );

    // Тот же экземпляр: повторная обёртка дублировала бы guard/аудит/rate-limit
    expect(result!.provider).toBe(alreadyWrapped);
  });

  it('роутер не дал провайдера → fallback на провайдера сессии с сохранением decision', async () => {
    const result = await routeProvider(
      makeSession({ provider: 'mock', model: 's-model' }), makeMessage(), undefined, undefined,
      depsWithRouter({ route: vi.fn(async () => decision), getProvider: () => null }),
    );

    expect(result).toMatchObject({ providerName: 'mock', modelName: 's-model' });
    expect(result!.decision).toEqual(decision);
  });

  it('ни роутер, ни fallback не дали провайдера → null', async () => {
    const result = await routeProvider(
      makeSession({ provider: 'missing' }), makeMessage(), undefined, undefined,
      depsWithRouter({ route: vi.fn(async () => decision), getProvider: () => null }),
    );
    expect(result).toBeNull();
  });

  it('явная температура агента перекрывает session.temperature в пуле', async () => {
    const getProviderSpy = vi.fn((_decision: unknown, _temperature?: number) => new MockProvider({
      url: '', apiKey: '', model: 'decision-model', type: 'orchmock',
    }));
    await routeProvider(
      makeSession({ provider: 'mock', model: 's-model', temperature: 0.1 }), makeMessage(), undefined, undefined,
      depsWithRouter({ route: vi.fn(async () => decision), getProvider: getProviderSpy }), { temperature: 0.9 },
    );
    // Пул получает effective-температуру вторым аргументом.
    expect(getProviderSpy.mock.calls[0]![1]).toBe(0.9);
  });

  it('без температуры агента в пул уходит session.temperature', async () => {
    const getProviderSpy = vi.fn((_decision: unknown, _temperature?: number) => new MockProvider({
      url: '', apiKey: '', model: 'decision-model', type: 'orchmock',
    }));
    await routeProvider(
      makeSession({ provider: 'mock', model: 's-model', temperature: 0.1 }), makeMessage(), undefined, undefined,
      depsWithRouter({ route: vi.fn(async () => decision), getProvider: getProviderSpy }),
    );
    expect(getProviderSpy.mock.calls[0]![1]).toBe(0.1);
  });

  it('fallback провайдера сессии получает явную температуру агента', async () => {
    const result = await routeProvider(
      makeSession({ provider: 'mock', model: 's-model', temperature: 0.1 }), makeMessage(), undefined, undefined,
      depsWithRouter({ route: vi.fn(async () => decision), getProvider: () => null }), { temperature: 0.9 },
    );
    expect(result!.provider.temperature).toBe(0.9);
  });

  // --- Переопределения агента (AgentDefinition.provider/model/topP/topK) ---
  const twoProviders = providerLoader({
    mock: { name: 'mock', type: 'orchmock', baseUrl: 'http://localhost:1', apiKey: '', defaultModel: 'mock-default' } as unknown as SharedProviderConfig,
    other: { name: 'other', type: 'orchmock', baseUrl: 'http://localhost:2', apiKey: '', defaultModel: 'other-default' } as unknown as SharedProviderConfig,
  });

  it('агент задал provider+model — роутер не вызывается, пара берётся от агента', async () => {
    const route = vi.fn(async () => decision);
    const result = await routeProvider(
      makeSession({ provider: 'mock', model: 's-model' }), makeMessage(), undefined, undefined,
      depsWithRouter({ route, getProvider: vi.fn() }, { providerLoader: twoProviders }),
      { provider: 'other', model: 'agent-model' },
    );

    expect(route).not.toHaveBeenCalled();
    expect(result).toMatchObject({ providerName: 'other', modelName: 'agent-model' });
    expect(result!.provider.name).toBe('other');
    expect(result!.provider.model).toBe('agent-model');
    expect(result!.decision).toBeUndefined();
  });

  it('агент задал только provider — модель берётся из сессии', async () => {
    const result = await routeProvider(
      makeSession({ provider: 'mock', model: 's-model' }), makeMessage(), undefined, undefined,
      depsWithRouter(null, { providerLoader: twoProviders }), { provider: 'other' },
    );

    expect(result).toMatchObject({ providerName: 'other', modelName: 's-model' });
    expect(result!.provider.name).toBe('other');
    expect(result!.provider.model).toBe('s-model');
  });

  it('агент задал только model — провайдер берётся из сессии', async () => {
    const result = await routeProvider(
      makeSession({ provider: 'mock', model: 's-model' }), makeMessage(), undefined, undefined,
      depsWithRouter(null, { providerLoader: twoProviders }), { model: 'agent-model' },
    );

    expect(result).toMatchObject({ providerName: 'mock', modelName: 'agent-model' });
    expect(result!.provider.model).toBe('agent-model');
  });

  it('переопределение модели агента перекрывает модель сообщения', async () => {
    const result = await routeProvider(
      makeSession({ provider: 'mock', model: 's-model' }),
      makeMessage({ provider: 'mock', model: 'msg-model' } as never),
      undefined, undefined,
      depsWithRouter(null, { providerLoader: twoProviders }), { model: 'agent-model' },
    );
    expect(result!.modelName).toBe('agent-model');
  });

  it('настройки сессии не мутируются переопределениями агента', async () => {
    const session = makeSession({ provider: 'mock', model: 's-model', temperature: 0.1 });
    await routeProvider(
      session, makeMessage(), undefined, undefined,
      depsWithRouter(null, { providerLoader: twoProviders }),
      { provider: 'other', model: 'agent-model', temperature: 0.9, topP: 0.5, topK: 10 },
    );
    expect(session.settings.provider).toBe('mock');
    expect(session.settings.model).toBe('s-model');
    expect(session.settings.temperature).toBe(0.1);
    expect(Object.keys(session.settings).sort()).toEqual(['model', 'provider', 'temperature']);
  });

  it('topP/topK агента уходят в пул роутера', async () => {
    const getProviderSpy = vi.fn((..._args: unknown[]) => new MockProvider({
      url: '', apiKey: '', model: 'decision-model', type: 'orchmock',
    }));
    await routeProvider(
      makeSession({ provider: 'mock', model: 's-model' }), makeMessage(), undefined, undefined,
      depsWithRouter({ route: vi.fn(async () => decision), getProvider: getProviderSpy }),
      { topP: 0.5, topK: 10 },
    );
    const call = getProviderSpy.mock.calls[0]!;
    expect(call[5]).toBe(0.5);
    expect(call[6]).toBe(10);
  });

  it('лимит вывода decision-модели резолвится (сессия → каталог → конфиг)', async () => {
    const mkSpy = () => vi.fn((..._args: unknown[]) => new MockProvider({
      url: '', apiKey: '', model: 'decision-model', type: 'orchmock',
    }));

    // Сессия в авто → лимит каталога decision-модели (позиция 3 — maxTokens).
    const withCatalog = mkSpy();
    await routeProvider(
      makeSession({ provider: 'mock', model: 's-model', maxTokens: 0 }), makeMessage(), undefined, undefined,
      depsWithRouter(
        { route: vi.fn(async () => decision), getProvider: withCatalog },
        { resolveModelMaxOutputTokens: () => 24_000 },
      ),
    );
    expect(withCatalog.mock.calls[0]![3]).toBe(24_000);

    // Каталога нет → конфиг llm.maxTokens; явное значение сессии приоритетнее.
    const fromConfig = mkSpy();
    await routeProvider(
      makeSession({ provider: 'mock', model: 's-model', maxTokens: 0 }), makeMessage(), undefined, undefined,
      depsWithRouter(
        { route: vi.fn(async () => decision), getProvider: fromConfig },
        { defaultMaxOutputTokens: 12_000 },
      ),
    );
    expect(fromConfig.mock.calls[0]![3]).toBe(12_000);

    const explicit = mkSpy();
    await routeProvider(
      makeSession({ provider: 'mock', model: 's-model', maxTokens: 3000 }), makeMessage(), undefined, undefined,
      depsWithRouter({ route: vi.fn(async () => decision), getProvider: explicit }),
    );
    expect(explicit.mock.calls[0]![3]).toBe(3000);
  });
});

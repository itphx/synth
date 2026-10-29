/**
 * Тесты резолвера провайдера **агентского** шага пайплайна (ADR-101 §4 ×
 * `AgentDefinition`).
 *
 * Проверяются контракты точки сборки:
 *   • приоритет пары агента (`provider`/`model`) над дефолтами инстанса;
 *   • температура и sampling агента уходят в создание провайдера
 *     (`ProviderFactory.create` — 3-й, 4-й и 5-й аргументы);
 *   • провайдер агента не наследует модель чужого провайдера;
 *   • «не задано» (`''`/`0`) не перекрывает дефолты;
 *   • ненастроенный провайдер и сбой сборки → `null` (шаг падает с
 *     `pipeline.provider_not_found`, поведение прежнее);
 *   • провайдер возвращается уже обёрнутым (`wrapProvider`, ADR-036).
 *
 * Изолированно: фабрики подменены шпионами, реальных провайдеров нет.
 */
import { describe, it, expect, vi } from 'vitest';

import type { ProviderConfig as SharedProviderConfig } from '@itphx/synth-shared';

import type { BaseProvider, ProviderConfig } from '../../providers/base.js';
import type { PipelineStepContext } from './step-context.js';
import type { StepExecutionContext } from './types.js';
import {
  resolvePipelineStepProvider,
  type PipelineStepProviderConfigLike,
  type PipelineStepProviderDeps,
} from './step-provider.js';

/** Заглушка провайдера: резолвер её только возвращает, вызовов нет. */
function fakeProvider(label: string): BaseProvider {
  return { name: label, model: label } as unknown as BaseProvider;
}

/** Конфиг провайдера инстанса (поля, которые читает резолвер). */
function sharedConfig(name: string, defaultModel?: string): SharedProviderConfig {
  return {
    name,
    type: 'generic',
    baseUrl: `http://${name}.local`,
    enabled: true,
    ...(defaultModel ? { defaultModel } : {}),
  };
}

/** Контекст шага с заданным агентом (или без него). */
function makeCtx(agent?: Record<string, unknown>): Pick<StepExecutionContext, 'step'> {
  return {
    ...(agent ? { step: { agent } as unknown as PipelineStepContext } : {}),
  };
}

interface Harness {
  deps: PipelineStepProviderDeps<SharedProviderConfig>;
  createProvider: ReturnType<typeof vi.fn>;
  wrapProvider: ReturnType<typeof vi.fn>;
  loadProviderConfig: ReturnType<typeof vi.fn>;
}

/** Зависимости резолвера: провайдеры `p-a`/`p-b` настроены, шпионы — на месте. */
function makeHarness(over: {
  defaults?: { provider?: string; model?: string };
  configs?: Record<string, SharedProviderConfig>;
  wrapProvider?: boolean;
} = {}): Harness {
  const configs = over.configs ?? {
    'p-a': sharedConfig('p-a', 'a-default'),
    'p-b': sharedConfig('p-b', 'b-default'),
  };
  const createProvider = vi.fn(
    (
      name: string,
      _config: ProviderConfig,
      _temperature?: number,
      _topP?: number,
      _topK?: number,
    ) => fakeProvider(name),
  );
  const wrapProvider = vi.fn(
    (provider: BaseProvider) => ({ provider, wrapped: true }) as unknown as BaseProvider,
  );
  const loadProviderConfig = vi.fn((name: string) => configs[name] ?? null);

  const deps: PipelineStepProviderDeps<SharedProviderConfig> = {
    resolveLlmDefaults: async () => over.defaults ?? { provider: 'p-a', model: 'a-model' },
    loadProviderConfig,
    toProviderConfig: (shared: SharedProviderConfig, model: string): ProviderConfig => ({
      name: shared.name,
      type: shared.type ?? 'generic',
      url: shared.baseUrl ?? '',
      apiKey: shared.apiKey ?? '',
      model,
    }),
    createProvider,
    ...(over.wrapProvider === false ? {} : { wrapProvider }),
  };
  return { deps, createProvider, wrapProvider, loadProviderConfig };
}

describe('resolvePipelineStepProvider — пара provider/model', () => {
  it('без агента: пара инстанса, sampling/температура не заданы', async () => {
    const h = makeHarness();

    const provider = await resolvePipelineStepProvider(makeCtx(), h.deps);

    expect(provider).not.toBeNull();
    expect(h.createProvider).toHaveBeenCalledTimes(1);
    const [name, config, temperature, topP, topK] = h.createProvider.mock.calls[0]!;
    expect(name).toBe('p-a');
    expect(config.model).toBe('a-model');
    // Поля агента не заданы — прежняя арность создания провайдера.
    expect(temperature).toBeUndefined();
    expect(topP).toBeUndefined();
    expect(topK).toBeUndefined();
  });

  it('агент: его provider/model перекрывают дефолты инстанса', async () => {
    const h = makeHarness();

    const provider = await resolvePipelineStepProvider(
      makeCtx({ provider: 'p-b', model: 'b-agent', temperature: 0.15, topP: 0.8, topK: 40 }),
      h.deps,
    );

    expect(provider).not.toBeNull();
    const [name, config, temperature, topP, topK] = h.createProvider.mock.calls[0]!;
    expect(name).toBe('p-b');
    expect(config.model).toBe('b-agent');
    // Температура и sampling агента — в создание провайдера (не в клон):
    // `applyStepTemperature` в шаге клон уже не делает.
    expect(temperature).toBe(0.15);
    expect(topP).toBe(0.8);
    expect(topK).toBe(40);
  });

  it('агент сменил провайдера без модели: берётся defaultModel провайдера, не модель инстанса', async () => {
    const h = makeHarness();

    await resolvePipelineStepProvider(makeCtx({ provider: 'p-b' }), h.deps);

    const [name, config] = h.createProvider.mock.calls[0]!;
    expect(name).toBe('p-b');
    // `a-model` относится к `p-a` — чужая пара не собирается.
    expect(config.model).toBe('b-default');
  });

  it('агент задал только модель: провайдер из дефолтов', async () => {
    const h = makeHarness();

    await resolvePipelineStepProvider(makeCtx({ model: 'a-agent' }), h.deps);

    const [name, config] = h.createProvider.mock.calls[0]!;
    expect(name).toBe('p-a');
    expect(config.model).toBe('a-agent');
  });

  it('пустые строки и нулевой sampling агента — «не задано» (дефолты сохраняются)', async () => {
    const h = makeHarness();

    await resolvePipelineStepProvider(
      makeCtx({ provider: '  ', model: '', temperature: undefined, topP: 0, topK: 0 }),
      h.deps,
    );

    const [name, config, temperature, topP, topK] = h.createProvider.mock.calls[0]!;
    expect(name).toBe('p-a');
    expect(config.model).toBe('a-model');
    expect(temperature).toBeUndefined();
    expect(topP).toBeUndefined();
    expect(topK).toBeUndefined();
  });

  it('модель не задана нигде: defaultModel провайдера', async () => {
    const h = makeHarness({ defaults: { provider: 'p-a' } });

    await resolvePipelineStepProvider(makeCtx(), h.deps);

    expect(h.createProvider.mock.calls[0]![1].model).toBe('a-default');
  });

  it('провайдер возвращается обёрнутым (GatewayProvider, ADR-036)', async () => {
    const h = makeHarness();

    const provider = await resolvePipelineStepProvider(makeCtx({ provider: 'p-b' }), h.deps);

    expect(h.wrapProvider).toHaveBeenCalledTimes(1);
    expect(h.wrapProvider.mock.calls[0]![0]).toBe(h.createProvider.mock.results[0]!.value);
    expect((provider as unknown as { wrapped?: boolean }).wrapped).toBe(true);
  });

  it('без wrapProvider возвращается созданный провайдер как есть', async () => {
    const h = makeHarness({ wrapProvider: false });

    const provider = await resolvePipelineStepProvider(makeCtx(), h.deps);

    expect(provider).toBe(h.createProvider.mock.results[0]!.value);
  });
});

describe('resolvePipelineStepProvider — недоступность', () => {
  it('нет ни пары агента, ни дефолтов → null', async () => {
    const h = makeHarness({ defaults: {} });

    expect(await resolvePipelineStepProvider(makeCtx(), h.deps)).toBeNull();
    expect(h.createProvider).not.toHaveBeenCalled();
  });

  it('провайдер агента не настроен в инстансе → null', async () => {
    const h = makeHarness();

    const provider = await resolvePipelineStepProvider(makeCtx({ provider: 'missing' }), h.deps);

    expect(provider).toBeNull();
    expect(h.loadProviderConfig).toHaveBeenCalledWith('missing');
    expect(h.createProvider).not.toHaveBeenCalled();
  });

  it('сбой создания провайдера → null (шаг падает pipeline.provider_not_found)', async () => {
    const h = makeHarness();
    h.createProvider.mockImplementation(() => {
      throw new Error('boom');
    });

    expect(await resolvePipelineStepProvider(makeCtx(), h.deps)).toBeNull();
  });

  it('сбой резолвера дефолтов → null', async () => {
    const h = makeHarness();
    h.deps.resolveLlmDefaults = async () => {
      throw new Error('no settings');
    };

    expect(await resolvePipelineStepProvider(makeCtx(), h.deps)).toBeNull();
  });
});

describe('PipelineStepProviderConfigLike — структурный минимум', () => {
  it('резолвер принимает конфиг только с defaultModel', async () => {
    const createProvider = vi.fn(
      (_name: string, _config: ProviderConfig, _temperature?: number, _topP?: number, _topK?: number) =>
        fakeProvider('x'),
    );
    const deps: PipelineStepProviderDeps<PipelineStepProviderConfigLike> = {
      resolveLlmDefaults: () => ({ provider: 'p', model: 'm' }),
      loadProviderConfig: () => ({}),
      toProviderConfig: (_shared, model): ProviderConfig => ({
        url: '',
        apiKey: '',
        model,
      }),
      createProvider,
    };

    const provider = await resolvePipelineStepProvider(makeCtx(), deps);

    expect(provider).not.toBeNull();
    expect(createProvider.mock.calls[0]![0]).toBe('p');
    expect(createProvider.mock.calls[0]![1].model).toBe('m');
  });
});

/**
 * ProviderPool — кеширование экземпляров BaseProvider (ADR-034).
 * Ключ кеша: `${providerName}:${modelName}`.
 * При включённом LLM Gateway (ADR-036) созданный провайдер оборачивается
 * в GatewayProvider через gatewayFactory. Фабрику передаёт оркестратор:
 * GatewayProvider нужны getMap/saveMap от сессии, которых в пуле нет,
 * поэтому пул сам GatewayProvider не создаёт.
 */

import type { ProviderConfig as SharedProviderConfig, LLMGatewayConfig, ReasoningLevel } from '@itphx/synth-shared';
import { ProviderFactory } from '../../providers/base.js';
import type { BaseProvider } from '../../providers/base.js';
import { toCoreProviderConfig } from './utils.js';

export class ProviderPool {
  private readonly _cache = new Map<string, BaseProvider>();
  /** ADR-084: кеш decision-провайдеров (всегда обёрнутых в GatewayProvider). */
  private readonly _decisionCache = new Map<string, BaseProvider>();
  private readonly _providerLoader: (name: string) => SharedProviderConfig | null;
  private _gatewayConfig: LLMGatewayConfig | null;
  private _gatewayFactory: ((inner: BaseProvider) => BaseProvider) | null;
  /** ADR-084: фабрика обвязки decision-провайдеров (применяется всегда). */
  private _decisionGatewayFactory: ((inner: BaseProvider) => BaseProvider) | null;

  constructor(
    providerLoader: (name: string) => SharedProviderConfig | null,
    gatewayConfig?: LLMGatewayConfig,
    gatewayFactory?: (inner: BaseProvider) => BaseProvider,
    decisionGatewayFactory?: (inner: BaseProvider) => BaseProvider,
  ) {
    this._providerLoader = providerLoader;
    this._gatewayConfig = gatewayConfig ?? null;
    this._gatewayFactory = gatewayFactory ?? null;
    this._decisionGatewayFactory = decisionGatewayFactory ?? null;
  }

  getProvider(
    providerName: string,
    modelName: string,
    temperature?: number,
    reasoningLevel?: ReasoningLevel,
    maxTokens?: number,
    numCtx?: number,
  ): BaseProvider | null {
    const cacheKey = `${providerName}:${modelName}:${reasoningLevel ?? 'none'}:${maxTokens ?? ''}:${numCtx ?? ''}`;
    const cached = this._cache.get(cacheKey);
    if (cached) return cached;

    const sharedConfig = this._providerLoader(providerName);
    if (!sharedConfig) return null;

    try {
      const coreConfig = toCoreProviderConfig(
        sharedConfig,
        modelName || sharedConfig.defaultModel || '',
        reasoningLevel,
      );
      coreConfig.maxTokens = maxTokens;
      coreConfig.numCtx = numCtx;
      const provider = ProviderFactory.create(
        providerName,
        coreConfig,
        temperature ?? 0.7,
      );
      const wrapped = this._applyGateway(provider);
      this._cache.set(cacheKey, wrapped);
      return wrapped;
    } catch {
      return null;
    }
  }

  clear(): void {
    this._cache.clear();
    this._decisionCache.clear();
  }

  /**
   * ADR-084: decision-провайдер (`type: 'decision'`), обёрнутый в GatewayProvider
   * **всегда** (при заданной фабрике обвязки). В отличие от `getProvider`, gateway
   * не опционален: decision-путь обязан проходить через guard/обфускацию/аудит.
   */
  getDecisionProvider(providerName: string, modelName: string): BaseProvider | null {
    const model = modelName || '';
    const cacheKey = `decision:${providerName}:${model}`;
    const cached = this._decisionCache.get(cacheKey);
    if (cached) return cached;

    const sharedConfig = this._providerLoader(providerName);
    if (!sharedConfig) return null;

    try {
      const coreConfig = toCoreProviderConfig(sharedConfig, model || sharedConfig.defaultModel || '');
      const provider = ProviderFactory.create(providerName, coreConfig);
      const wrapped = this._decisionGatewayFactory
        ? this._decisionGatewayFactory(provider)
        : provider;
      this._decisionCache.set(cacheKey, wrapped);
      return wrapped;
    } catch {
      return null;
    }
  }

  /** ADR-084: обновление обвязки decision-провайдеров (сбрасывает их кеш). */
  setDecisionGatewayFactory(
    factory: ((inner: BaseProvider) => BaseProvider) | null,
  ): void {
    this._decisionGatewayFactory = factory;
    this._decisionCache.clear();
  }

  /** ADR-036: live-переключение gateway. Сбрасывает кеш — провайдеры пересоздаются с новой обёрткой. */
  setGateway(
    gatewayConfig: LLMGatewayConfig | null | undefined,
    gatewayFactory: ((inner: BaseProvider) => BaseProvider) | null,
  ): void {
    this._gatewayConfig = gatewayConfig ?? null;
    this._gatewayFactory = gatewayFactory ?? null;
    this._cache.clear();
  }

  /** ADR-036: если gateway включён и задана фабрика — оборачиваем провайдер. */
  private _applyGateway(provider: BaseProvider): BaseProvider {
    if (this._gatewayConfig?.enabled && this._gatewayFactory) {
      return this._gatewayFactory(provider);
    }
    return provider;
  }
}

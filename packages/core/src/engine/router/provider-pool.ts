/**
 * ProviderPool — кеширование экземпляров BaseProvider (AD-034).
 * Ключ кеша: `${providerName}:${modelName}`.
 * При включённом LLM Gateway (AD-036) созданный провайдер оборачивается
 * в GatewayProvider через gatewayFactory. Фабрику передаёт оркестратор:
 * GatewayProvider нужны getMap/saveMap от сессии, которых в пуле нет,
 * поэтому пул сам GatewayProvider не создаёт.
 */

import type { ProviderConfig as SharedProviderConfig, LLMGatewayConfig } from '@synth/shared';
import { ProviderFactory } from '../../providers/base.js';
import type { BaseProvider } from '../../providers/base.js';
import { toCoreProviderConfig } from './utils.js';

export class ProviderPool {
  private readonly _cache = new Map<string, BaseProvider>();
  private readonly _providerLoader: (name: string) => SharedProviderConfig | null;
  private readonly _gatewayConfig: LLMGatewayConfig | null;
  private readonly _gatewayFactory: ((inner: BaseProvider) => BaseProvider) | null;

  constructor(
    providerLoader: (name: string) => SharedProviderConfig | null,
    gatewayConfig?: LLMGatewayConfig,
    gatewayFactory?: (inner: BaseProvider) => BaseProvider,
  ) {
    this._providerLoader = providerLoader;
    this._gatewayConfig = gatewayConfig ?? null;
    this._gatewayFactory = gatewayFactory ?? null;
  }

  getProvider(
    providerName: string,
    modelName: string,
    temperature?: number,
  ): BaseProvider | null {
    const cacheKey = `${providerName}:${modelName}`;
    const cached = this._cache.get(cacheKey);
    if (cached) return cached;

    const sharedConfig = this._providerLoader(providerName);
    if (!sharedConfig) return null;

    try {
      const coreConfig = toCoreProviderConfig(sharedConfig, modelName || sharedConfig.defaultModel || '');
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
  }

  /** AD-036: если gateway включён и задана фабрика — оборачиваем провайдер. */
  private _applyGateway(provider: BaseProvider): BaseProvider {
    if (this._gatewayConfig?.enabled && this._gatewayFactory) {
      return this._gatewayFactory(provider);
    }
    return provider;
  }
}

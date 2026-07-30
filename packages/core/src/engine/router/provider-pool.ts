/**
 * ProviderPool — кеширование экземпляров BaseProvider (AD-034).
 * Ключ кеша: `${providerName}:${modelName}`.
 */

import type { ProviderConfig as SharedProviderConfig } from '@synth/shared';
import { ProviderFactory } from '../../providers/base.js';
import type { BaseProvider } from '../../providers/base.js';
import { toCoreProviderConfig } from './utils.js';

export class ProviderPool {
  private readonly _cache = new Map<string, BaseProvider>();
  private readonly _providerLoader: (name: string) => SharedProviderConfig | null;

  constructor(providerLoader: (name: string) => SharedProviderConfig | null) {
    this._providerLoader = providerLoader;
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
      this._cache.set(cacheKey, provider);
      return provider;
    } catch {
      return null;
    }
  }

  clear(): void {
    this._cache.clear();
  }
}

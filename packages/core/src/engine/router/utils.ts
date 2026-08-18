/**
 * Общие утилиты для подсистемы роутинга (AD-034).
 */

import type { ProviderConfig as SharedProviderConfig } from '@itphx/synth-shared';
import type { ProviderConfig as CoreProviderConfig } from '../../providers/base.js';

export function toCoreProviderConfig(
  shared: SharedProviderConfig,
  model: string,
): CoreProviderConfig {
  return {
    name: shared.name,
    type: shared.type,
    url: shared.baseUrl || '',
    apiKey: shared.apiKey || '',
    model,
    timeout: shared.timeout,
  };
}

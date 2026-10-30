/**
 * Общие утилиты для подсистемы роутинга (ADR-034).
 */

import type { ProviderConfig as SharedProviderConfig, ReasoningLevel, ModelCompatibility } from '@itphx/synth-shared';
import { mergeModelCompatibility } from '@itphx/synth-shared';
import type { ProviderConfig as CoreProviderConfig } from '../../providers/base.js';

/**
 * Конфиг инстанса → конфиг ядра.
 *
 * `compatibility` собирается из двух уровней: `provider.compatibility` (из
 * JSON провайдера) + переданный `compatibility` модели (резолвер по каталогу
 * моделей). Модель перекрывает провайдера по каждому полю; недостающее
 * добирает эвристика в провайдере (`resolveProviderCompatibility`).
 */
export function toCoreProviderConfig(
  shared: SharedProviderConfig,
  model: string,
  reasoningLevel?: ReasoningLevel,
  compatibility?: ModelCompatibility,
): CoreProviderConfig {
  const merged = mergeModelCompatibility(shared.compatibility, compatibility);
  return {
    name: shared.name,
    type: shared.type,
    url: shared.baseUrl || '',
    apiKey: shared.apiKey || '',
    model,
    timeout: shared.timeout,
    reasoningLevel,
    ...(Object.keys(merged).length > 0 ? { compatibility: merged } : {}),
    numCtx: shared.numCtx,
  };
}

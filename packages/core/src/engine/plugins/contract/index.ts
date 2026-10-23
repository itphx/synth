/**
 * ADR-090 (Ф3в): баррел контрактного suite расширений.
 *
 * `describePluginContract(name, make)` — «паспорт» плагина: проверки, которым
 * обязан удовлетворять любой плагин, реализующий точки `promptBlocks`,
 * `llmFilters`, `tools` (по образцу контрактных suite'ов слоя хранения,
 * `packages/core/src/storage/contract/*`).
 */
export {
  describePluginContract,
  DEFAULT_PLUGIN_CONTRACT_REFERENCE,
} from './plugin-contract.js';
export type {
  PluginContractHarness,
  PluginContractHarnessFactory,
  PluginContractReference,
  PluginContractTransport,
} from './plugin-contract.js';

export { createContractHarness, createFixtureLoader } from './harness.js';
export type { PluginContractHarnessOptions } from './harness.js';

export {
  PLUGIN_CONTRACT_FIXTURES,
  PLUGIN_FIXTURE_SET,
  REFERENCE_BLOCK_KEY,
  REFERENCE_EMPTY_BLOCK_KEY,
  REFERENCE_LONG_CONTENT,
  REFERENCE_PLUGIN,
  REFERENCE_REQUEST_FILTER,
  REFERENCE_RESPONSE_FILTER,
  REFERENCE_TOOL_FULL_NAME,
  REFERENCE_TOOL_NAME,
  REFERENCE_VERSION,
} from './fixtures.js';
export type { PluginContractFixtureName, PluginFixture } from './fixtures.js';

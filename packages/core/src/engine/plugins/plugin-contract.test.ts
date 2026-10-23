/**
 * ADR-090 (Ф3в): контрактный suite расширений — прогон на
 * **in-memory** реализации (ядро: `PluginHost` + общий `ToolRegistry`, реестры
 * `PromptBlockRegistry`/`LlmFilterRegistry`, `SystemPromptComposer`,
 * `GatewayProvider`, `PermissionEvaluator`).
 *
 * Тот же suite прогоняется на `out-of-process` реализации
 * (`plugin-contract-remote.test.ts`, Ф4б-3): харнесс собирает вызывающая
 * сторона (`contract/harness.ts`), suite работает только через его операции.
 */
import { describe, expect, it } from 'vitest';
import type { PackManifest } from '@itphx/synth-shared';

import { describePluginContract, type PluginContractHarness } from './contract/plugin-contract.js';
import { createContractHarness, createFixtureLoader } from './contract/harness.js';
import {
  PLUGIN_FIXTURE_SET,
  PLUGIN_CONTRACT_FIXTURES,
} from './contract/fixtures.js';

/** Харнесс на in-memory реализации: загрузчик отдаёт модуль фикстуры. */
function makeHarness(): Promise<PluginContractHarness> {
  return createContractHarness({
    transport: 'inline',
    loader: createFixtureLoader(),
  });
}

describePluginContract('PluginHost + in-memory реестры', makeHarness);

/** Набор фикстур должен быть полным: эталон + по одному нарушению. */
describe('фикстуры контрактного suite расширений', () => {
  it('каждая фикстура — самостоятельный плагин', () => {
    const names = PLUGIN_CONTRACT_FIXTURES.map((name) => PLUGIN_FIXTURE_SET[name].name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('манифест фикстуры ссылается на её же имя и вид plugin', () => {
    for (const name of PLUGIN_CONTRACT_FIXTURES) {
      const fixture = PLUGIN_FIXTURE_SET[name];
      expect(fixture.manifest as PackManifest).toMatchObject({
        name: fixture.name,
        version: fixture.version,
        kind: 'plugin',
      });
    }
  });
});

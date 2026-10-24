/**
 * М1: тест активации плагина настоящим хостом (`PluginHost`).
 *
 * Проверяется главное для волны М1: манифест `synth.pack` **совпадает** с
 * фактическими регистрациями (иначе хост отклоняет активацию с
 * `plugin.provides_mismatch`), тулы лежат в общем реестре под namespace'ом
 * хоста, а деактивация снимает и тулы, и блоки промпта.
 *
 * Манифест читается из настоящего файла пакета — тест защищает и его от
 * расхождения с кодом.
 */
import { readFile } from 'node:fs/promises';

import {
  MemoryPluginAuditRepository,
  PluginHost,
  PromptBlockRegistry,
  ToolRegistry,
  createMemoryStorage,
} from '@itphx/synth-core';
import { packManifestSchema, pluginsConfigSchema, pluginToolFullName } from '@itphx/synth-shared';
import type { PackManifest, PluginsConfig } from '@itphx/synth-shared';
import { describe, expect, it } from 'vitest';

import { apply } from './index.js';

/** Манифест пакета — настоящий файл `synth.pack`. */
async function loadManifest(): Promise<PackManifest> {
  const raw = await readFile(new URL('../synth.pack', import.meta.url), 'utf-8');
  return packManifestSchema.parse(JSON.parse(raw));
}

/** Конфиг слоя плагинов: исполнение кода включено (иначе шаг `import` не дойдёт). */
function config(): PluginsConfig {
  return { ...pluginsConfigSchema.parse({}), executionEnabled: true };
}

/** Хост с настоящими реестрами и настоящим in-memory хранилищем. */
async function makeHost(applyModule: (facade: never) => void) {
  const storage = createMemoryStorage();
  const tools = new ToolRegistry();
  const promptBlocks = new PromptBlockRegistry();
  const warnings: string[] = [];
  const host = new PluginHost({
    audit: new MemoryPluginAuditRepository(),
    config: config(),
    hostVersion: '0.12.1',
    logger: { warn: (message: string) => warnings.push(message) },
    tools,
    promptBlocks,
    memory: { facts: storage.memoryFacts, indexes: storage.memoryIndexes },
    loader: async () => ({ apply: applyModule }),
  });
  const manifest = await loadManifest();
  return { host, tools, promptBlocks, storage, manifest, warnings };
}

describe('активация плагина памяти хостом', () => {
  it('активация проходит без provides_mismatch', async () => {
    const { host, manifest, warnings } = await makeHost(apply as never);

    const result = await host.activate({
      name: manifest.name,
      version: manifest.version,
      manifest,
      trustLevel: 'trusted',
      files: { 'dist/index.js': 'export const ok = 1;' },
    });

    expect(result.outcome).toBe('activated');
    expect(result.reason).not.toBe('plugin.provides_mismatch');
    expect(result.reason).toBeUndefined();
    expect(warnings.join('\n')).toBe('');
    expect(host.isActive('synth-plugin-memory')).toBe(true);
  });

  it('тулы зарегистрированы под namespace-именем хоста', async () => {
    const { host, tools, manifest } = await makeHost(apply as never);
    await host.activate({
      name: manifest.name,
      version: manifest.version,
      manifest,
      trustLevel: 'trusted',
      files: { 'dist/index.js': 'export const ok = 1;' },
    });

    const searchName = pluginToolFullName('synth-plugin-memory', 'memory_search');
    expect(searchName).toBe('plugin_synth_plugin_memory_memory_search');

    const search = tools.get(searchName);
    expect(search).toBeDefined();
    expect(search!.source).toBe('plugin');
    expect(search!.pluginName).toBe('synth-plugin-memory');
    expect(search!.capabilities).toEqual(['memory']);

    expect(tools.get('plugin_synth_plugin_memory_memory_write')).toBeDefined();
    expect(tools.get('plugin_synth_plugin_memory_memory_forget')).toBeDefined();
    expect(tools.get('plugin_synth_plugin_memory_memory_index')).toBeDefined();
    expect(tools.pluginLocalNames('synth-plugin-memory').sort()).toEqual([
      'memory_forget',
      'memory_index',
      'memory_search',
      'memory_write',
    ]);
  });

  it('блоки промпта зарегистрированы с ключами манифеста', async () => {
    const { host, promptBlocks, manifest } = await makeHost(apply as never);
    await host.activate({
      name: manifest.name,
      version: manifest.version,
      manifest,
      trustLevel: 'trusted',
      files: { 'dist/index.js': 'export const ok = 1;' },
    });

    expect(promptBlocks.size).toBe(2);
    expect(promptBlocks.get('plugin.synth-plugin-memory.facts')).toBeDefined();
    expect(promptBlocks.get('plugin.synth-plugin-memory.recall')).toBeDefined();
  });

  it('деактивация снимает и тулы, и блоки', async () => {
    const { host, tools, promptBlocks, manifest } = await makeHost(apply as never);
    await host.activate({
      name: manifest.name,
      version: manifest.version,
      manifest,
      trustLevel: 'trusted',
      files: { 'dist/index.js': 'export const ok = 1;' },
    });

    const deactivated = await host.deactivate('synth-plugin-memory');
    expect(deactivated.outcome).toBe('ok');
    expect(deactivated.failures).toEqual([]);
    expect(tools.get('plugin_synth_plugin_memory_memory_search')).toBeUndefined();
    expect(tools.pluginLocalNames('synth-plugin-memory')).toEqual([]);
    expect(promptBlocks.size).toBe(0);
  });

  it('тул через реестр пишет факт в память инстанса', async () => {
    const { host, tools, storage, manifest } = await makeHost(apply as never);
    await host.activate({
      name: manifest.name,
      version: manifest.version,
      manifest,
      trustLevel: 'trusted',
      files: { 'dist/index.js': 'export const ok = 1;' },
    });

    const write = tools.get('plugin_synth_plugin_memory_memory_write');
    expect(write).toBeDefined();
    const result = await write!.execute(
      { text: 'Деплой в test идёт через Fleet' },
      { sessionId: 's1', messageId: 'm1', workingDir: '/ws' },
    );
    expect(result.isError).toBeUndefined();

    const facts = await storage.memoryFacts.list({ status: 'active' });
    expect(facts).toHaveLength(1);
    expect(facts[0]!.text).toBe('Деплой в test идёт через Fleet');
    expect(facts[0]!.namespace).toBe('plugin:synth-plugin-memory');
  });

  it('хранилище памяти недоступно → активация не падает (фича-детект)', async () => {
    const tools = new ToolRegistry();
    const promptBlocks = new PromptBlockRegistry();
    const host = new PluginHost({
      audit: new MemoryPluginAuditRepository(),
      config: config(),
      hostVersion: '0.12.1',
      logger: { warn: () => undefined },
      tools,
      promptBlocks,
      // `memory` не передан → `facade.memory === undefined`.
      loader: async () => ({ apply }),
    });
    const manifest = await loadManifest();

    const result = await host.activate({
      name: manifest.name,
      version: manifest.version,
      manifest,
      trustLevel: 'trusted',
      files: { 'dist/index.js': 'export const ok = 1;' },
    });
    expect(result.outcome).toBe('activated');
    expect(result.reason).toBeUndefined();

    // Тулы зарегистрированы, но отвечают понятной ошибкой.
    const write = tools.get('plugin_synth_plugin_memory_memory_write');
    const result2 = await write!.execute(
      { text: 'Деплой идёт через Fleet' },
      { sessionId: 's1', messageId: 'm1', workingDir: '/ws' },
    );
    expect(result2.isError).toBe(true);
    expect(result2.content).toBe('Хранилище памяти недоступно в этом инстансе');
  });

  it('неполная регистрация → plugin.provides_mismatch (контроль манифеста)', async () => {    // Плагин, который зарегистрировал не все заявленные тулы, — отклоняется.
    const partial = (facade: {
      registerPromptBlock: (provider: unknown) => void;
      registerTool: (def: unknown) => void;
    }): void => {
      facade.registerPromptBlock({
        key: 'plugin.synth-plugin-memory.facts',
        tier: 'context',
        order: 100,
        load: () => null,
      });
      facade.registerPromptBlock({
        key: 'plugin.synth-plugin-memory.recall',
        tier: 'volatile',
        order: 110,
        load: () => null,
      });
    };
    const { host, manifest } = await makeHost(partial as never);
    const result = await host.activate({
      name: manifest.name,
      version: manifest.version,
      manifest,
      trustLevel: 'trusted',
      files: { 'dist/index.js': 'export const ok = 1;' },
    });

    expect(result.outcome).toBe('rejected');
    expect(result.reason).toBe('plugin.provides_mismatch');
    expect(host.isActive('synth-plugin-memory')).toBe(false);
  });
});

/**
 * ADR-090 (WP-F): сервисы фасада — `facade.embed` (эмбеддинги через
 * Gateway) и `facade.getSettings` (свои настройки плагина).
 *
 * Проверяется контракт, который видит плагин:
 * - эмбеддинги доходят до инъецированной функции (фейк в тесте) с
 *   разрешённым провайдером/моделью;
 * - лимиты запроса (батч/длина текста/суммарный объём) дают
 *   `plugin.embed_limit` **до** обращения к провайдеру;
 * - без сконфигурированного провайдера — `plugin.embedding_not_configured`
 *   (хост не падает: ошибку видит плагин);
 * - векторы разной длины — `plugin.embed_invalid_result`;
 * - ошибка провайдера пробрасывается как есть (не глотается);
 * - `getSettings` отдаёт настройки **своего** плагина, чужие не видны,
 *   отсутствующая запись — `{}`.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PackManifest, PluginsConfig } from '@itphx/synth-shared';
import { pluginsConfigSchema } from '@itphx/synth-shared';
import { describe, expect, it } from 'vitest';

import { MemoryPluginAuditRepository } from '../../storage/memory/plugin-audit.js';
import { PluginFacadeError } from './activation.js';
import type {
  PluginActivationDescriptor,
  PluginEmbedFn,
  PluginEmbedOptions,
  PluginFacade,
  PluginLoader,
  PluginSettingsReader,
} from './activation.js';
import { PluginHost } from './plugin-host.js';
import { createPluginSettingsReader } from './settings.js';

/**
 * Манифест плагина без вкладов (сверка `provides` — пусто с пустым).
 *
 * Собирается **без каста**: объект реально удовлетворяет `PackManifest`
 * (`provides.authority` — обязательное поле выходного типа схемы манифеста,
 * ADR-106).
 */
function manifest(name: string): PackManifest {
  return {
    name,
    version: '1.0.0',
    kind: 'plugin',
    description: 'демонстрационный плагин',
    provides: {
      mcp: [],
      skills: [],
      agents: [],
      pipelines: [],
      tools: [],
      promptBlocks: [],
      llmFilters: [],
      authority: { roles: [], actions: [], targets: [], agents: [] },
    },
  };
}

/** Параметры активации демо-плагина с перехватом фасада. */
interface ActivateOptions {
  /** Имя плагина (разные — разные записи настроек). */
  name?: string;
  /** Перекрытия конфига слоя плагинов. */
  config?: Partial<PluginsConfig>;
  /** Инъецированная функция эмбеддингов (фейк). */
  embed?: PluginEmbedFn;
  /** Ридер настроек плагина. */
  settings?: PluginSettingsReader;
}

/** Активировать демо-плагин и вернуть его фасад. */
async function activateAndCapture(
  options: ActivateOptions = {},
): Promise<{ facade: PluginFacade; host: PluginHost }> {
  let captured: PluginFacade | undefined;
  const loader: PluginLoader = async () => ({
    apply: (facade: PluginFacade) => {
      captured = facade;
    },
  });
  const host = new PluginHost({
    audit: new MemoryPluginAuditRepository(),
    config: {
      ...pluginsConfigSchema.parse({}),
      executionEnabled: true,
      ...options.config,
    },
    hostVersion: '0.11.0',
    logger: { warn: () => undefined },
    loader,
    ...(options.embed ? { embed: options.embed } : {}),
    ...(options.settings ? { settings: options.settings } : {}),
  });
  const name = options.name ?? 'demo-plugin';
  const descriptor: PluginActivationDescriptor = {
    name,
    version: '1.0.0',
    manifest: manifest(name),
    trustLevel: 'trusted',
    files: { 'dist/index.js': 'export const ok = 1;' },
  };
  const result = await host.activate(descriptor);
  expect(result.outcome).toBe('activated');
  if (!captured) throw new Error('фасад не перехвачен');
  return { facade: captured, host };
}

/** Код ошибки фасада (или `undefined`, если ошибка не `PluginFacadeError`). */
function errorCode(err: unknown): string | undefined {
  return err instanceof PluginFacadeError ? err.code : undefined;
}

describe('facade.embed — эмбеддинги только через Gateway', () => {
  it('доходит до инъецированной функции с провайдером/моделью конфига', async () => {
    const calls: Array<{ texts: readonly string[]; opts?: PluginEmbedOptions }> = [];
    const embed: PluginEmbedFn = async (texts, opts) => {
      calls.push({ texts, opts });
      return texts.map(() => [0.1, 0.2]);
    };
    const { facade } = await activateAndCapture({
      config: { embeddingProvider: 'ollama', embeddingModel: 'nomic-embed-text' },
      embed,
    });

    const vectors = await facade.embed(['первый', 'второй']);

    expect(vectors).toEqual([
      [0.1, 0.2],
      [0.1, 0.2],
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.texts).toEqual(['первый', 'второй']);
    expect(calls[0]?.opts).toEqual({ provider: 'ollama', model: 'nomic-embed-text' });
  });

  it('перекрывает конфиг аргументами вызова', async () => {
    const calls: PluginEmbedOptions[] = [];
    const embed: PluginEmbedFn = async (texts, opts) => {
      if (opts) calls.push(opts);
      return texts.map(() => [1]);
    };
    const { facade } = await activateAndCapture({
      config: { embeddingProvider: 'ollama', embeddingModel: 'nomic-embed-text' },
      embed,
    });

    await facade.embed(['текст'], { provider: 'openai', model: 'text-embedding-3-small' });

    expect(calls[0]).toEqual({ provider: 'openai', model: 'text-embedding-3-small' });
  });

  it('отклоняет батч больше 64 текстов (plugin.embed_limit) до вызова провайдера', async () => {
    let called = false;
    const embed: PluginEmbedFn = async (texts) => {
      called = true;
      return texts.map(() => [1]);
    };
    const { facade } = await activateAndCapture({
      config: { embeddingProvider: 'ollama' },
      embed,
    });

    const texts = Array.from({ length: 65 }, (_, i) => `текст ${i}`);
    await expect(facade.embed(texts)).rejects.toMatchObject({
      code: 'plugin.embed_limit',
    });
    expect(called).toBe(false);
  });

  it('отклоняет текст длиннее 8000 символов (plugin.embed_limit)', async () => {
    const { facade } = await activateAndCapture({
      config: { embeddingProvider: 'ollama' },
      embed: async (texts) => texts.map(() => [1]),
    });

    const long = 'я'.repeat(8001);
    await expect(facade.embed([long])).rejects.toMatchObject({ code: 'plugin.embed_limit' });
  });

  it('отклоняет суммарный объём больше 64000 символов (plugin.embed_limit)', async () => {
    const { facade } = await activateAndCapture({
      config: { embeddingProvider: 'ollama' },
      embed: async (texts) => texts.map(() => [1]),
    });

    const chunk = 'я'.repeat(8000);
    const texts = Array.from({ length: 9 }, () => chunk);
    await expect(facade.embed(texts)).rejects.toMatchObject({ code: 'plugin.embed_limit' });
  });

  it('без сконфигурированного провайдера — plugin.embedding_not_configured', async () => {
    let called = false;
    const embed: PluginEmbedFn = async (texts) => {
      called = true;
      return texts.map(() => [1]);
    };
    const { facade } = await activateAndCapture({ embed });

    await expect(facade.embed(['текст'])).rejects.toMatchObject({
      code: 'plugin.embedding_not_configured',
    });
    expect(called).toBe(false);
  });

  it('без инъецированного сервиса — plugin.embed_unavailable (хост не падает)', async () => {
    const { facade } = await activateAndCapture({
      config: { embeddingProvider: 'ollama' },
    });

    await expect(facade.embed(['текст'])).rejects.toMatchObject({
      code: 'plugin.embed_unavailable',
    });
  });

  it('векторы разной длины — plugin.embed_invalid_result', async () => {
    const { facade } = await activateAndCapture({
      config: { embeddingProvider: 'ollama' },
      embed: async (texts) => texts.map((_, i) => (i === 0 ? [0.1, 0.2] : [0.1])),
    });

    await expect(facade.embed(['первый', 'второй'])).rejects.toMatchObject({
      code: 'plugin.embed_invalid_result',
    });
  });

  it('ошибку провайдера пробрасывает как есть (не глотает)', async () => {
    const { facade } = await activateAndCapture({
      config: { embeddingProvider: 'ollama' },
      embed: async () => {
        throw new Error('провайдер недоступен');
      },
    });

    const err = await facade.embed(['текст']).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('провайдер недоступен');
    expect(errorCode(err)).toBeUndefined();
  });

  it('пустой запрос не обращается к провайдеру', async () => {
    let called = false;
    const { facade } = await activateAndCapture({
      config: { embeddingProvider: 'ollama' },
      embed: async (texts) => {
        called = true;
        return texts.map(() => [1]);
      },
    });

    await expect(facade.embed([])).resolves.toEqual([]);
    expect(called).toBe(false);
  });
});

describe('facade.getSettings — свои настройки плагина', () => {
  /** Файл `plugins.json` с настройками двух плагинов. */
  async function settingsFile(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'synth-plugin-settings-'));
    const path = join(dir, 'plugins.json');
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        plugins: {
          'demo-plugin': { enabled: true, settings: { namespace: 'demo', limit: 10 } },
          'other-plugin': { enabled: true, settings: { namespace: 'other' } },
        },
      }),
      'utf-8',
    );
    return path;
  }

  it('отдаёт настройки своего плагина', async () => {
    const path = await settingsFile();
    const { facade } = await activateAndCapture({
      name: 'demo-plugin',
      settings: createPluginSettingsReader({ path }),
    });

    expect(facade.getSettings()).toEqual({ namespace: 'demo', limit: 10 });
  });

  it('чужие настройки не видны', async () => {
    const path = await settingsFile();
    const { facade } = await activateAndCapture({
      name: 'other-plugin',
      settings: createPluginSettingsReader({ path }),
    });

    const settings = facade.getSettings();
    expect(settings).toEqual({ namespace: 'other' });
    expect(settings).not.toHaveProperty('limit');
  });

  it('отсутствующая запись — пустой объект (не undefined)', async () => {
    const path = await settingsFile();
    const { facade } = await activateAndCapture({
      name: 'unknown-plugin',
      settings: createPluginSettingsReader({ path }),
    });

    const settings = facade.getSettings();
    expect(settings).toEqual({});
    expect(settings).toBeDefined();
  });

  it('без ридера настроек — пустой объект', async () => {
    const { facade } = await activateAndCapture({ name: 'demo-plugin' });

    expect(facade.getSettings()).toEqual({});
  });

  it('битый файл настроек не ломает чтение (пустой объект)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'synth-plugin-settings-broken-'));
    const path = join(dir, 'plugins.json');
    await writeFile(path, '{ это не json', 'utf-8');
    const { facade } = await activateAndCapture({
      name: 'demo-plugin',
      settings: createPluginSettingsReader({ path }),
    });

    expect(facade.getSettings()).toEqual({});
  });

  it('снимок читается на каждый вызов (изменения видны без рестарта)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'synth-plugin-settings-live-'));
    const path = join(dir, 'plugins.json');
    const write = async (value: string): Promise<void> => {
      await writeFile(
        path,
        JSON.stringify({ version: 1, plugins: { 'demo-plugin': { settings: { mode: value } } } }),
        'utf-8',
      );
    };
    await write('one');
    const { facade } = await activateAndCapture({
      name: 'demo-plugin',
      settings: createPluginSettingsReader({ path }),
    });

    expect(facade.getSettings()).toEqual({ mode: 'one' });
    await write('two');
    expect(facade.getSettings()).toEqual({ mode: 'two' });
  });
});

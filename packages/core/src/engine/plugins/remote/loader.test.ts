/**
 * ADR-090 Ф4б-1: тесты удалённого загрузчика (`remote/loader.ts`).
 *
 * Заглушка плагина — **реальный** `node:http`-сервер на `127.0.0.1:0` (не
 * мок `fetch`): проверяются протокол, активация через `PluginHost`, подстановка
 * `capabilities` в провайдеры и отказы (401, чужая версия, недоступный порт,
 * `mode: 'inline'`).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PackManifest, PluginsConfig } from '@itphx/synth-shared';
import {
  PLUGIN_PROTOCOL_MAX_PROMPT_BLOCK_CHARS,
  PLUGIN_PROTOCOL_VERSION,
  ToolCapability,
  pluginsConfigSchema,
} from '@itphx/synth-shared';

import { MemoryPluginAuditRepository } from '../../../storage/memory/plugin-audit.js';
import { createPluginRuntime } from '../../../execution/plugin-runtime.js';
import type { ExecutionFs, ExecutionPort } from '../../../execution/ports/index.js';
import { LlmFilterRegistry } from '../../gateway/llm-filter-registry.js';
import { PromptBlockRegistry } from '../../context/prompt-block-registry.js';
import { ToolRegistry } from '../../tools/registry.js';
import { PluginHost } from '../plugin-host.js';
import { PluginLoadError } from '../activation.js';
import type {
  PluginActivationDescriptor,
  PluginLogger,
  PluginModule,
} from '../activation.js';
import { RemotePluginUnavailableError } from './client.js';
import { createRemotePluginLoader } from './loader.js';
import { PluginProcessManager } from './process.js';
import type { PluginProcessHandle } from './process.js';

const TOKEN = 'plugin-remote-loader-token-1234567890';
const NAME = 'demo-plugin';
const VERSION = '1.0.0';
const BLOCK_KEY = 'plugin.demo.memory';
const FILTER_ID = 'plugin:demo-plugin:dlp';
const TOOL_NAME = 'memory_search';
const TOOL_FULL_NAME = 'plugin_demo_plugin_memory_search';

/** JSON-Schema параметров удалённого тула (приходит из протокола). */
const TOOL_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: { query: { type: 'string' } },
  required: ['query'],
};

const silentLogger: PluginLogger = { warn: () => undefined };

const servers: Array<{ close: () => Promise<void> }> = [];

type InvokeHandler = (point: string, id: string, input: unknown) => unknown | Promise<unknown>;

/** Поднять заглушку процесса плагина: `/capabilities` + `/invoke`. */
async function startPluginStub(options: {
  capabilities?: Record<string, unknown>;
  onInvoke?: InvokeHandler;
  capabilitiesStatus?: number;
  capabilitiesBody?: unknown;
} = {}): Promise<string> {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf-8');
    });
    req.on('end', () => {
      void (async () => {
        try {
          if (req.url === '/health') {
            // Liveness — без токена (менеджер процессов опрашивает health).
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok' }));
            return;
          }
          if (req.url === '/capabilities') {
            res.writeHead(options.capabilitiesStatus ?? 200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(options.capabilitiesBody ?? options.capabilities ?? capabilities()));
            return;
          }
          if (req.url === '/invoke') {
            const parsed = JSON.parse(body) as { point: string; id: string; input: unknown };
            const output = options.onInvoke
              ? await options.onInvoke(parsed.point, parsed.id, parsed.input)
              : { content: 'ПАМЯТЬ ИЗ ПРОЦЕССА' };
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true, output }));
            return;
          }
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { reason: 'unknown_id' } }));
        } catch {
          if (!res.writableEnded) res.destroy();
        }
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push({
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  });
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(({ close }) => close()));
});

/** Ответ `/capabilities` по умолчанию. */
function capabilities(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocol: PLUGIN_PROTOCOL_VERSION,
    name: NAME,
    version: VERSION,
    points: {
      promptBlocks: [{ key: BLOCK_KEY, tier: 'context', order: 100, title: 'Memory' }],
      llmFilters: [{ id: FILTER_ID, phase: 'pre_request', failMode: 'closed' }],
    },
    ...over,
  };
}

/** Описание удалённого тула в `/capabilities` (точка `tools`). */
function toolCapability(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: TOOL_NAME,
    description: 'Поиск по памяти плагина',
    parameters: TOOL_JSON_SCHEMA,
    capabilities: ['search'],
    ...over,
  };
}

/** Ответ `/capabilities` с единственной точкой `tools`. */
function toolsCapabilities(tools: Record<string, unknown>[] = [toolCapability()]): Record<string, unknown> {
  return capabilities({ points: { tools } });
}

/** Манифест удалённого плагина. */
function manifest(over: Partial<PackManifest> = {}): PackManifest {
  return {
    name: NAME,
    version: VERSION,
    kind: 'plugin',
    description: 'удалённый плагин',
    mode: 'remote',
    provides: {
      mcp: [],
      skills: [],
      agents: [],
      pipelines: [],
      tools: [],
      promptBlocks: [{ key: BLOCK_KEY, tier: 'context', order: 100 }],
      llmFilters: [{ id: FILTER_ID, phase: 'pre_request', failMode: 'closed' }],
    },
    ...over,
  } as PackManifest;
}

/** Манифест плагина, объявляющего только инструмент. */
function toolsManifest(over: Partial<PackManifest> = {}): PackManifest {
  return manifest({
    provides: {
      mcp: [],
      skills: [],
      agents: [],
      pipelines: [],
      tools: [TOOL_NAME],
      promptBlocks: [],
      llmFilters: [],
    },
    ...over,
  } as Partial<PackManifest>);
}

/** Дескриптор активации с адресом и токеном процесса. */
function descriptor(
  url: string,
  over: Partial<PluginActivationDescriptor> = {},
): PluginActivationDescriptor {
  return {
    name: NAME,
    version: VERSION,
    manifest: manifest(),
    trustLevel: 'trusted',
    files: { 'dist/index.js': 'export function apply() {}\n' },
    remote: { url, token: TOKEN },
    ...over,
  };
}

/** Конфиг слоя плагинов: исполнение включено, доверие по умолчанию. */
function config(over: Partial<PluginsConfig> = {}): PluginsConfig {
  return { ...pluginsConfigSchema.parse({ executionEnabled: true }), ...over };
}

/** Хост с реестрами и удалённым загрузчиком. */
function makeHost(over: {
  promptBlocks?: PromptBlockRegistry;
  llmFilters?: LlmFilterRegistry;
  tools?: ToolRegistry;
} = {}): {
  host: PluginHost;
  audit: MemoryPluginAuditRepository;
  promptBlocks: PromptBlockRegistry;
  llmFilters: LlmFilterRegistry;
  tools: ToolRegistry;
} {
  const audit = new MemoryPluginAuditRepository();
  const promptBlocks = over.promptBlocks ?? new PromptBlockRegistry();
  const llmFilters = over.llmFilters ?? new LlmFilterRegistry();
  const tools = over.tools ?? new ToolRegistry();
  const host = new PluginHost({
    audit,
    config: config(),
    hostVersion: '0.11.4',
    logger: silentLogger,
    // Ф4б-2: хост выбирает транспорт по режиму/дескриптору, поэтому удалённый
    // загрузчик передаётся каналом `loaders.remote` (а не `loader` — это inline).
    loaders: { remote: createRemotePluginLoader({ logger: silentLogger }) },
    promptBlocks,
    llmFilters,
    tools,
  });
  return { host, audit, promptBlocks, llmFilters, tools };
}

/** Ожидаемый `PluginLoadError` с причиной. */
async function expectLoadError(
  promise: Promise<unknown>,
  reason: 'plugin.loader_unavailable' | 'plugin.module_invalid' = 'plugin.loader_unavailable',
): Promise<PluginLoadError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(PluginLoadError);
  const loadError = err as PluginLoadError;
  expect(loadError.reason).toBe(reason);
  expect(loadError.message).not.toContain(TOKEN);
  return loadError;
}

/** Порт, на котором никто не слушает. */
async function deadPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

// ── Успешная активация ──────────────────────────────────────────────────

describe('createRemotePluginLoader: активация через PluginHost', () => {
  it('promptBlocks: блок зарегистрирован, load() возвращает содержимое процесса', async () => {
    const registry = new PromptBlockRegistry();
    const url = await startPluginStub();
    const { host } = makeHost({ promptBlocks: registry });

    const result = await host.activate(descriptor(url));
    expect(result.outcome).toBe('activated');
    expect(registry.size).toBe(1);

    const registered = registry.get(BLOCK_KEY);
    expect(registered).toBeDefined();
    expect(registered!.provenance).toBe(`plugin:${NAME}`);
    expect(registered!.provider.title).toBe('Memory');

    const content = await registered!.provider.load({
      sessionId: 's1',
      agentRole: 'assistant',
      language: 'ru',
      mode: 'act',
      query: 'что в памяти?',
    });
    expect(content).toEqual({ content: 'ПАМЯТЬ ИЗ ПРОЦЕССА' });

    const deactivated = await host.deactivate(NAME);
    expect(deactivated.outcome).toBe('ok');
    expect(registry.size).toBe(0);
  });

  it('llmFilters: фильтр зарегистрирован, inspect() возвращает вердикт процесса', async () => {
    const registry = new LlmFilterRegistry();
    const url = await startPluginStub({
      onInvoke: () => ({ verdict: 'deny', reason: 'DLP' }),
    });
    const { host } = makeHost({ llmFilters: registry });

    const result = await host.activate(descriptor(url));
    expect(result.outcome).toBe('activated');

    const entry = registry.get(FILTER_ID);
    expect(entry).toBeDefined();
    expect(entry!.pluginName).toBe(NAME);
    expect(entry!.trustLevel).toBe('trusted');
    expect(entry!.failMode).toBe('closed');

    const verdict = await entry!.filter.inspect({
      phase: 'pre_request',
      provider: 'itphx',
      model: 'gpt',
      messages: [{ role: 'user', content: 'привет' }],
    });
    expect(verdict).toEqual({ verdict: 'deny', reason: 'DLP' });
  });

  it('ответы точек нормализуются: строка блока и redact-вердикт', async () => {
    const promptBlocks = new PromptBlockRegistry();
    const llmFilters = new LlmFilterRegistry();
    const url = await startPluginStub({
      onInvoke: (point) =>
        point === 'promptBlocks'
          ? 'СТРОКА ОТ ПЛАГИНА'
          : { verdict: 'redact', redactedTexts: ['a', 'b'] },
    });
    const { host } = makeHost({ promptBlocks, llmFilters });
    const at = await host.activate(descriptor(url));
    expect(at.outcome).toBe('activated');

    const block = promptBlocks.get(BLOCK_KEY)!;
    expect(await block.provider.load({
      sessionId: 's1',
      agentRole: 'assistant',
      language: 'ru',
      mode: 'act',
    })).toEqual({ content: 'СТРОКА ОТ ПЛАГИНА' });

    const verdict = await llmFilters.get(FILTER_ID)!.filter.inspect({
      phase: 'embedding',
      provider: 'itphx',
      model: 'emb',
      texts: ['x'],
    });
    expect(verdict).toEqual({ verdict: 'redact', redactedTexts: ['a', 'b'] });
  });
});

// ── Точка `tools` (Ф4б-3) ───────────────────────────────────────────────

describe('createRemotePluginLoader: точка tools', () => {
  it('тул регистрируется под namespace: source plugin, capabilities и JSON-Schema из протокола', async () => {
    const url = await startPluginStub({ capabilities: toolsCapabilities() });
    const { host, tools } = makeHost();

    const result = await host.activate(descriptor(url, { manifest: toolsManifest() }));
    expect(result.outcome).toBe('activated');

    const tool = tools.get(TOOL_FULL_NAME);
    expect(tool).toBeDefined();
    expect(tool!.source).toBe('plugin');
    expect(tool!.pluginName).toBe(NAME);
    // Полное имя составил хост; локальное — только в протоколе/манифесте.
    expect(tool!.name).toBe(TOOL_FULL_NAME);
    expect(tools.pluginLocalNames(NAME)).toEqual([TOOL_NAME]);
    // Capabilities пришли из протокола (permission-слой видит тул).
    expect(tool!.capabilities).toEqual([ToolCapability.SEARCH]);

    // Схема для модели — из протокола, а не из «проницаемой» zod-схемы.
    const llm = tools.toLLMFormatForSession();
    const entry = llm.find((item) => item.function.name === TOOL_FULL_NAME);
    expect(entry).toBeDefined();
    expect(entry!.function.description).toBe('Поиск по памяти плагина');
    expect(entry!.function.parameters).toEqual(TOOL_JSON_SCHEMA);
  });

  it('без JSON-Schema в протоколе подставляется минимальная схема (не выдумываем)', async () => {
    const raw = toolCapability();
    delete raw.parameters;
    const url = await startPluginStub({ capabilities: toolsCapabilities([raw]) });
    const { host, tools } = makeHost();
    expect((await host.activate(descriptor(url, { manifest: toolsManifest() }))).outcome)
      .toBe('activated');

    const entry = tools
      .toLLMFormatForSession()
      .find((item) => item.function.name === TOOL_FULL_NAME);
    expect(entry!.function.parameters).toEqual({
      type: 'object',
      properties: {},
      additionalProperties: true,
    });
  });

  it('execute() уходит в /invoke с параметрами и контекстом, возвращая контент', async () => {
    const calls: Array<{ point: string; id: string; input: unknown }> = [];
    const url = await startPluginStub({
      capabilities: toolsCapabilities(),
      onInvoke: (point, id, input) => {
        calls.push({ point, id, input });
        return { content: `memory:${JSON.stringify((input as { parameters: unknown }).parameters)}` };
      },
    });
    const { host, tools } = makeHost();
    expect((await host.activate(descriptor(url, { manifest: toolsManifest() }))).outcome)
      .toBe('activated');

    const result = await tools.get(TOOL_FULL_NAME)!.execute(
      { query: 'x' },
      { sessionId: 's1', messageId: 'm1', workingDir: '/ws' },
    );

    expect(result).toEqual({ content: 'memory:{"query":"x"}' });
    expect(calls).toEqual([
      {
        point: 'tools',
        id: TOOL_NAME,
        input: {
          parameters: { query: 'x' },
          context: { sessionId: 's1', messageId: 'm1', workingDir: '/ws' },
        },
      },
    ]);
  });

  it('isError: true — ошибка тула, а не хоста: контент возвращается без броска', async () => {
    const url = await startPluginStub({
      capabilities: toolsCapabilities(),
      onInvoke: () => ({ content: 'память недоступна', isError: true }),
    });
    const { host, tools } = makeHost();
    expect((await host.activate(descriptor(url, { manifest: toolsManifest() }))).outcome)
      .toBe('activated');

    const result = await tools.get(TOOL_FULL_NAME)!.execute(
      {},
      { sessionId: 's1', messageId: 'm1', workingDir: '/ws' },
    );
    expect(result).toEqual({ content: 'память недоступна', isError: true });
  });

  it('результат не по контракту → бросок (вызывающий деградирует сам)', async () => {
    const url = await startPluginStub({
      capabilities: toolsCapabilities(),
      onInvoke: () => 42,
    });
    const { host, tools } = makeHost();
    expect((await host.activate(descriptor(url, { manifest: toolsManifest() }))).outcome)
      .toBe('activated');

    await expect(
      tools.get(TOOL_FULL_NAME)!.execute(
        {},
        { sessionId: 's1', messageId: 'm1', workingDir: '/ws' },
      ),
    ).rejects.toThrow(/не по контракту/);
  });

  it('сетевая ошибка (процесс погас) → бросок', async () => {
    const url = await startPluginStub({ capabilities: toolsCapabilities() });
    const { host, tools } = makeHost();
    expect((await host.activate(descriptor(url, { manifest: toolsManifest() }))).outcome)
      .toBe('activated');

    await Promise.all(servers.splice(0).map(({ close }) => close()));

    const failure = tools.get(TOOL_FULL_NAME)!.execute(
      {},
      { sessionId: 's1', messageId: 'm1', workingDir: '/ws' },
    );
    await expect(failure).rejects.toBeInstanceOf(RemotePluginUnavailableError);
  });

  it('деактивация снимает удалённый тул из реестра', async () => {
    const url = await startPluginStub({ capabilities: toolsCapabilities() });
    const { host, tools } = makeHost();
    expect((await host.activate(descriptor(url, { manifest: toolsManifest() }))).outcome)
      .toBe('activated');
    expect(tools.listPlugin()).toHaveLength(1);

    expect((await host.deactivate(NAME)).outcome).toBe('ok');
    expect(tools.listPlugin()).toHaveLength(0);
  });
});

describe('createRemotePluginLoader: отказы объявления точки tools', () => {
  it('тул без capabilities → отказ активации (fail-closed)', async () => {
    const raw = toolCapability();
    delete raw.capabilities;
    const url = await startPluginStub({ capabilities: toolsCapabilities([raw]) });
    const { host, tools } = makeHost();

    const result = await host.activate(descriptor(url, { manifest: toolsManifest() }));
    expect(result.outcome).toBe('rejected');
    expect(result.step).toBe('import');
    expect(result.reason).toBe('plugin.loader_unavailable');
    expect(result.message).toContain('capabilities');
    expect(tools.listPlugin()).toHaveLength(0);
  });

  it('пустой набор capabilities → отказ активации', async () => {
    const url = await startPluginStub({
      capabilities: toolsCapabilities([toolCapability({ capabilities: [] })]),
    });
    const { host, tools } = makeHost();
    const result = await host.activate(descriptor(url, { manifest: toolsManifest() }));
    expect(result.outcome).toBe('rejected');
    expect(result.reason).toBe('plugin.loader_unavailable');
    expect(tools.listPlugin()).toHaveLength(0);
  });

  it('неизвестная capability → отказ активации', async () => {
    const url = await startPluginStub({
      capabilities: toolsCapabilities([toolCapability({ capabilities: ['root'] })]),
    });
    const { host, tools } = makeHost();
    const result = await host.activate(descriptor(url, { manifest: toolsManifest() }));
    expect(result.outcome).toBe('rejected');
    expect(result.reason).toBe('plugin.loader_unavailable');
    expect(result.message).toContain('capability');
    expect(tools.listPlugin()).toHaveLength(0);
  });

  it('пустое имя и пустое описание → отказ активации', async () => {
    for (const over of [{ name: '   ' }, { name: undefined }, { description: '' }, { description: undefined }]) {
      const url = await startPluginStub({
        capabilities: toolsCapabilities([toolCapability(over)]),
      });
      const { host } = makeHost();
      const result = await host.activate(descriptor(url, { manifest: toolsManifest() }));
      expect(result.outcome, JSON.stringify(over)).toBe('rejected');
      expect(result.reason).toBe('plugin.loader_unavailable');
    }
  });

  it('дубли локальных имён → отказ активации', async () => {
    const url = await startPluginStub({
      capabilities: toolsCapabilities([toolCapability(), toolCapability()]),
    });
    const { host, tools } = makeHost();
    const result = await host.activate(descriptor(url, { manifest: toolsManifest() }));
    expect(result.outcome).toBe('rejected');
    expect(result.reason).toBe('plugin.loader_unavailable');
    expect(result.message).toContain('дважды');
    expect(tools.listPlugin()).toHaveLength(0);
  });

  it('зарезервированная реестром capability runtime → регистрация отклонена → provides_mismatch', async () => {
    const url = await startPluginStub({
      capabilities: toolsCapabilities([toolCapability({ capabilities: ['runtime'] })]),
    });
    const { host, tools } = makeHost();
    const result = await host.activate(descriptor(url, { manifest: toolsManifest() }));
    expect(result.outcome).toBe('rejected');
    expect(result.reason).toBe('plugin.provides_mismatch');
    expect(tools.listPlugin()).toHaveLength(0);
  });

  it('имя с зарезервированным namespace plugin_ → регистрация отклонена → provides_mismatch', async () => {
    const url = await startPluginStub({
      capabilities: toolsCapabilities([toolCapability({ name: 'plugin_victim_tool' })]),
    });
    const { host, tools } = makeHost();
    const result = await host.activate(
      descriptor(url, {
        manifest: toolsManifest({
          provides: {
            mcp: [],
            skills: [],
            agents: [],
            pipelines: [],
            tools: ['plugin_victim_tool'],
            promptBlocks: [],
            llmFilters: [],
            authority: { roles: [], actions: [], targets: [], agents: [] },
          },
        } as Partial<PackManifest>),
      }),
    );
    expect(result.outcome).toBe('rejected');
    expect(result.reason).toBe('plugin.provides_mismatch');
    expect(tools.listPlugin()).toHaveLength(0);
  });
});

// ── Отказы активации ────────────────────────────────────────────────────

describe('createRemotePluginLoader: отказы загрузчика', () => {
  it('неверный токен (401) → активация отклонена, текст без токена', async () => {
    const url = await startPluginStub({
      capabilitiesStatus: 401,
      capabilitiesBody: {
        error: { reason: 'unauthorized', message: `bad token ${TOKEN}` },
      },
    });
    const { host } = makeHost();
    const result = await host.activate(descriptor(url));

    expect(result.outcome).toBe('rejected');
    expect(result.step).toBe('import');
    expect(result.reason).toBe('plugin.loader_unavailable');
    expect(result.message).not.toContain(TOKEN);
    expect(host.isActive(NAME)).toBe(false);
  });

  it('чужая версия протокола в /capabilities → отказ', async () => {
    const url = await startPluginStub({
      capabilities: capabilities({ protocol: PLUGIN_PROTOCOL_VERSION + 1 }),
    });
    const { host } = makeHost();
    const result = await host.activate(descriptor(url));
    expect(result.reason).toBe('plugin.loader_unavailable');
    expect(result.message).toContain('протокол');
  });

  it('плагин с mode: inline загрузчик не обслуживает', async () => {
    const loader = createRemotePluginLoader({ logger: silentLogger });
    await expectLoadError(
      loader(descriptor('http://127.0.0.1:1', { manifest: manifest({ mode: 'inline' }) })),
    );
  });

  it('нет descriptor.remote → отказ (fail-closed)', async () => {
    const loader = createRemotePluginLoader({ logger: silentLogger });
    const desc = descriptor('http://127.0.0.1:1');
    delete desc.remote;
    await expectLoadError(loader(desc));
  });

  it('внешний адрес процесса → отказ', async () => {
    const loader = createRemotePluginLoader({ logger: silentLogger });
    await expectLoadError(
      loader(descriptor('http://example.com:8080')),
    );
  });

  it('процесс недоступен (порт закрыт) → отказ', async () => {
    const port = await deadPort();
    const { host } = makeHost();
    const result = await host.activate(descriptor(`http://127.0.0.1:${port}`));
    expect(result.outcome).toBe('rejected');
    expect(result.reason).toBe('plugin.loader_unavailable');
    expect(result.message).toContain('недоступен');
  });

  it('mode: both обслуживается удалённым загрузчиком', async () => {
    const registry = new PromptBlockRegistry();
    const url = await startPluginStub();
    const { host } = makeHost({ promptBlocks: registry });
    const result = await host.activate(
      descriptor(url, { manifest: manifest({ mode: 'both' }) }),
    );
    expect(result.outcome).toBe('activated');
    expect(registry.size).toBe(1);
  });
});

// ── Ошибки вызова точки (не активации) ──────────────────────────────────

describe('createRemotePluginLoader: ответы точек не по контракту', () => {
  it('promptBlocks: не строка/объект → load() отклоняется (деградация точки)', async () => {
    const registry = new PromptBlockRegistry();
    const url = await startPluginStub({ onInvoke: () => 42 });
    const { host } = makeHost({ promptBlocks: registry });
    expect((await host.activate(descriptor(url))).outcome).toBe('activated');

    await expect(
      registry.get(BLOCK_KEY)!.provider.load({
        sessionId: 's1',
        agentRole: 'assistant',
        language: 'ru',
        mode: 'act',
      }),
    ).rejects.toThrow(/не по контракту/);
  });

  it('promptBlocks: содержимое больше 64 КиБ → load() отклоняется', async () => {
    const registry = new PromptBlockRegistry();
    const tooLong = 'x'.repeat(PLUGIN_PROTOCOL_MAX_PROMPT_BLOCK_CHARS + 1);
    const url = await startPluginStub({ onInvoke: () => tooLong });
    const { host } = makeHost({ promptBlocks: registry });
    expect((await host.activate(descriptor(url))).outcome).toBe('activated');

    await expect(
      registry.get(BLOCK_KEY)!.provider.load({
        sessionId: 's1',
        agentRole: 'assistant',
        language: 'ru',
        mode: 'act',
      }),
    ).rejects.toThrow(/превышает предел/);
  });

  it('llmFilters: неизвестный вердикт → inspect() отклоняется (gateway применит failMode)', async () => {
    const registry = new LlmFilterRegistry();
    const url = await startPluginStub({ onInvoke: () => ({ verdict: 'block' }) });
    const { host } = makeHost({ llmFilters: registry });
    expect((await host.activate(descriptor(url))).outcome).toBe('activated');

    await expect(
      registry.get(FILTER_ID)!.filter.inspect({
        phase: 'pre_request',
        provider: 'itphx',
        model: 'm',
      }),
    ).rejects.toThrow(/verdict/);
  });

  it('llmFilters: redactedTexts не массив строк → inspect() отклоняется', async () => {
    const registry = new LlmFilterRegistry();
    const url = await startPluginStub({
      onInvoke: () => ({ verdict: 'redact', redactedTexts: [1, 2] }),
    });
    const { host } = makeHost({ llmFilters: registry });
    expect((await host.activate(descriptor(url))).outcome).toBe('activated');

    await expect(
      registry.get(FILTER_ID)!.filter.inspect({
        phase: 'embedding',
        provider: 'itphx',
        model: 'm',
        texts: ['x'],
      }),
    ).rejects.toThrow(/redactedTexts/);
  });
});

// ── Сверка provides ─────────────────────────────────────────────────────

describe('createRemotePluginLoader: сверка provides', () => {
  it('манифест объявил provides.tools, а процесс тул не объявил → provides_mismatch', async () => {
    const url = await startPluginStub();
    const { host } = makeHost({
      promptBlocks: new PromptBlockRegistry(),
      llmFilters: new LlmFilterRegistry(),
    });
    const result = await host.activate(
      descriptor(url, {
        manifest: manifest({
          provides: {
            ...manifest().provides,
            tools: ['memory_search'],
          },
        }),
      }),
    );
    expect(result.outcome).toBe('rejected');
    expect(result.reason).toBe('plugin.provides_mismatch');
    expect(result.message).toContain('memory_search');
  });

  it('сервер объявил больше точек, чем манифест — отказ и откат регистраций', async () => {
    const registry = new PromptBlockRegistry();
    const url = await startPluginStub({
      capabilities: capabilities({
        points: {
          promptBlocks: [
            { key: BLOCK_KEY, tier: 'context', order: 100 },
            { key: 'plugin.demo.extra', tier: 'volatile', order: 1 },
          ],
          llmFilters: [{ id: FILTER_ID, phase: 'pre_request', failMode: 'closed' }],
        },
      }),
    });
    const { host } = makeHost({
      promptBlocks: registry,
      llmFilters: new LlmFilterRegistry(),
    });
    const result = await host.activate(descriptor(url));
    expect(result.reason).toBe('plugin.provides_mismatch');
    // Отклонённый плагин не оставляет блоков в живом реестре.
    expect(registry.size).toBe(0);
  });
});

// ── Runtime-контур (PROP-138, Ф2) ────────────────────────────────────────

describe('createRemotePluginLoader: runtime-контур', () => {
  /** Порт исполнения для фейкового runtime'а (команда → `stdout`). */
  function fakePort(stdout: string): ExecutionPort {
    const fs: ExecutionFs = {
      realpath: async (path) => path,
      stat: async () => ({ kind: 'file', size: 0, mtimeMs: 0 }),
      readdir: async () => [],
      readText: async () => ({ lines: [], totalLines: 0, truncated: false, bytes: 0 }),
      sniff: async () => ({ binary: false }),
      readBytes: async () => ({ dataBase64: '', size: 0 }),
      writeFile: async () => undefined,
      mkdir: async () => undefined,
      remove: async () => undefined,
      readRawText: async () => ({ text: '', size: 0 }),
      rename: async () => undefined,
      download: async () => Buffer.from(''),
      upload: async () => undefined,
      hash: async () => '0'.repeat(64),
    };
    return {
      execute: async () => ({
        stdout,
        stderr: '',
        exitCode: 0,
        truncated: false,
        durationMs: 1,
      }),
      fs,
    };
  }

  /**
   * `spawn`-заглушка: процесс «живой» (готовность + health через stub
   * сервера), при `kill` — выход.
   */
  function fakeSpawn(readyPort: number): PluginProcessHandle {
    let onExit: ((code: number | null) => void) | undefined;
    return {
      stdout: {
        on: (event: string, cb: (chunk: Buffer | string) => void) => {
          if (event === 'data') {
            setTimeout(() => cb(Buffer.from(`SYNTH_PLUGIN_READY port=${readyPort}\n`)), 0);
          }
          return undefined;
        },
      },
      stderr: { on: () => undefined },
      on: (event: string, cb: (code: number | null) => void) => {
        if (event === 'exit') onExit = cb;
        return undefined;
      },
      kill: () => {
        onExit?.(0);
        return undefined;
      },
    };
  }

  /** Хост + менеджер процессов: процесс плагина поднимает сам менеджер. */
  async function makeRuntimeHost(url: string): Promise<{
    host: PluginHost;
    tools: ToolRegistry;
    manager: PluginProcessManager;
    rootDir: string;
    /** Окружение процесса плагина (в нём — адрес/токен runtime'а). */
    env: Record<string, string>;
  }> {
    const secretsDir = await mkdtemp(join(tmpdir(), 'synth-plugin-loader-secrets-'));
    // Бандл: менеджер проверяет наличие точки входа (`dist/server.js`);
    // сам процесс не запускается — `spawn` подменён заглушкой.
    const rootDir = await mkdtemp(join(tmpdir(), 'synth-plugin-loader-bundle-'));
    await mkdir(join(rootDir, 'dist'), { recursive: true });
    await writeFile(join(rootDir, 'dist', 'server.js'), '// process stub\n', 'utf-8');
    const env: Record<string, string> = {};
    const manager = new PluginProcessManager({
      secretsDir,
      readyTimeoutMs: 2_000,
      healthTimeoutMs: 1_000,
      stopTimeoutMs: 200,
      logger: silentLogger,
      spawn: (_command, _args, options) => {
        Object.assign(env, options.env);
        return fakeSpawn(Number(new URL(url).port));
      },
    });
    const tools = new ToolRegistry();
    const host = new PluginHost({
      audit: new MemoryPluginAuditRepository(),
      config: config(),
      hostVersion: '0.11.4',
      logger: silentLogger,
      loaders: {
        remote: createRemotePluginLoader({ processManager: manager, logger: silentLogger }),
      },
      promptBlocks: new PromptBlockRegistry(),
      llmFilters: new LlmFilterRegistry(),
      tools,
    });
    return { host, tools, manager, rootDir, env };
  }

  it('плагин v2: id invocation\'а в контексте; runtime отвечает во время вызова', async () => {
    const contexts: Array<Record<string, unknown>> = [];
    const url = await startPluginStub({
      capabilities: toolsCapabilities(),
      onInvoke: (point, id, input) => {
        contexts.push((input as { context?: Record<string, unknown> }).context ?? {});
        return { content: 'ok' };
      },
    });

    const { host, tools, manager, rootDir } = await makeRuntimeHost(url);
    const desc = descriptor(url, { manifest: toolsManifest(), rootDir });
    delete desc.remote;
    expect((await host.activate(desc)).outcome).toBe('activated');

    const result = await tools.get(TOOL_FULL_NAME)!.execute(
      { query: 'x' },
      {
        sessionId: 's1',
        messageId: 'm1',
        workingDir: '/ws',
        runtime: createPluginRuntime(fakePort('OK')),
      },
    );

    expect(result).toEqual({ content: 'ok' });
    // В контексте вызова — id invocation'а (привязка runtime к вызову).
    const context = contexts[0]!;
    expect(typeof context.invocationId).toBe('string');
    expect(String(context.invocationId).length).toBeGreaterThan(0);

    await manager.stopAll();
  });

  it('плагин получает runtime в env и вызывает /runtime/exec → ответ', async () => {
    // Плагин (в отдельном процессе) ходит в host-side прокси runtime'а:
    // адрес и токен он берёт из окружения, id invocation'а — из контекста
    // вызова.
    let runtimeResponse: Record<string, unknown> | undefined;
    let runtimeStatus = 0;
    const env: Record<string, string> = {};
    const url = await startPluginStub({
      capabilities: toolsCapabilities(),
      onInvoke: async (point, id, input) => {
        const context = (input as { context?: { invocationId?: string } }).context ?? {};
        const response = await fetch(`${env.SYNTH_RUNTIME_URL ?? ''}/runtime/exec`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${env.SYNTH_RUNTIME_TOKEN ?? ''}`,
          },
          body: JSON.stringify({
            invocation_id: context.invocationId,
            argv: ['git', 'log'],
          }),
        });
        runtimeStatus = response.status;
        runtimeResponse = (await response.json()) as Record<string, unknown>;
        return { content: 'ok' };
      },
    });

    const secretsDir = await mkdtemp(join(tmpdir(), 'synth-plugin-loader-secrets-'));
    const rootDir = await mkdtemp(join(tmpdir(), 'synth-plugin-loader-bundle-'));
    await mkdir(join(rootDir, 'dist'), { recursive: true });
    await writeFile(join(rootDir, 'dist', 'server.js'), '// process stub\n', 'utf-8');
    const manager = new PluginProcessManager({
      secretsDir,
      readyTimeoutMs: 2_000,
      healthTimeoutMs: 1_000,
      stopTimeoutMs: 200,
      logger: silentLogger,
      spawn: (_command, _args, options) => {
        Object.assign(env, options.env);
        return fakeSpawn(Number(new URL(url).port));
      },
    });
    const tools = new ToolRegistry();
    const host = new PluginHost({
      audit: new MemoryPluginAuditRepository(),
      config: config(),
      hostVersion: '0.11.4',
      logger: silentLogger,
      loaders: {
        remote: createRemotePluginLoader({ processManager: manager, logger: silentLogger }),
      },
      promptBlocks: new PromptBlockRegistry(),
      llmFilters: new LlmFilterRegistry(),
      tools,
    });

    const desc = descriptor(url, { manifest: toolsManifest(), rootDir });
    delete desc.remote;
    expect((await host.activate(desc)).outcome).toBe('activated');

    // Плагин получил адрес и токен runtime'а в окружении.
    expect(env.SYNTH_RUNTIME_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(env.SYNTH_RUNTIME_TOKEN ?? '').not.toBe(env.SYNTH_PLUGIN_TOKEN);

    await tools.get(TOOL_FULL_NAME)!.execute(
      { query: 'x' },
      {
        sessionId: 's1',
        messageId: 'm1',
        workingDir: '/ws',
        runtime: createPluginRuntime(fakePort('ВЫВОД КОМАНДЫ')),
      },
    );

    // Команда ушла в порт сессии, а её вывод вернулся плагину.
    expect(runtimeStatus).toBe(200);
    expect(runtimeResponse).toEqual({
      stdout: 'ВЫВОД КОМАНДЫ',
      stderr: '',
      exit_code: 0,
    });

    await manager.stopAll();
  });

  it('плагин v1: id invocation\'а не приходит (runtime по проводу нет)', async () => {
    const contexts: Array<Record<string, unknown>> = [];
    const url = await startPluginStub({
      capabilities: capabilities({
        protocol: 1,
        points: { tools: [toolCapability()] },
      }),
      onInvoke: (point, id, input) => {
        contexts.push((input as { context?: Record<string, unknown> }).context ?? {});
        return { content: 'ok' };
      },
    });

    const { host, tools, manager, rootDir } = await makeRuntimeHost(url);
    const desc = descriptor(url, { manifest: toolsManifest(), rootDir });
    delete desc.remote;
    expect((await host.activate(desc)).outcome).toBe('activated');

    await tools.get(TOOL_FULL_NAME)!.execute(
      { query: 'x' },
      {
        sessionId: 's1',
        messageId: 'm1',
        workingDir: '/ws',
        runtime: createPluginRuntime(fakePort('OK')),
      },
    );

    expect(contexts).toHaveLength(1);
    expect(contexts[0]!.invocationId).toBeUndefined();

    await manager.stopAll();
  });
});

// ── Тип модуля ──────────────────────────────────────────────────────────

describe('createRemotePluginLoader: форма модуля', () => {
  it('возвращает apply(facade), но не вызывает его до шага facade хоста', async () => {
    const url = await startPluginStub();
    const loader = createRemotePluginLoader({ logger: silentLogger });
    const module: PluginModule = await loader(descriptor(url));
    expect(typeof module.apply).toBe('function');
  });
});

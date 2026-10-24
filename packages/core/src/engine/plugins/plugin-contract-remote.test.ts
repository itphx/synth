/**
 * ADR-090 / Ф4б-3: **контрактный suite расширений на
 * удалённой реализации** (`out-of-process`).
 *
 * Тот же набор проверок, что и на in-memory (`plugin-contract.test.ts`), но
 * плагин — **реальный HTTP-сервер** на `127.0.0.1:0`, обслуживающий
 * wire-протокол (`GET /health`, `GET /capabilities`, `POST /invoke`):
 * - хост получает `loaders.remote` (`createRemotePluginLoader`);
 * - дескриптор активации несёт `remote: { url, token }`;
 * - вклады (блоки/фильтры/тул) приходят **по проводу**, а не из `apply()`.
 *
 * Сервер-заглушка обслуживает эталонный набор фикстуры `reference` (блок с
 * содержимым, пустой блок, два фильтра, тул) и по одному «плохому» объявлению
 * на каждое нарушение (тир `stable`, неизвестная фаза, неизвестная capability,
 * чужой namespace, `deny` недоверенного плагина, несовпадение `provides`).
 *
 * Чем remote отличается от in-memory по существу: невалидное объявление точки
 * отклоняется **на `/capabilities`** (`checkPluginCapabilities`, fail-closed) —
 * до регистрации, тогда как inline получает отказ от реестра уже при
 * регистрации. Результат один: регистрации не появляется, причина названа.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { PLUGIN_PROTOCOL_VERSION } from '@itphx/synth-shared';

import { createRemotePluginLoader } from './remote/loader.js';
import type { PluginLogger } from './activation.js';
import { describePluginContract, type PluginContractHarness } from './contract/plugin-contract.js';
import { createContractHarness } from './contract/harness.js';
import {
  PLUGIN_CONTRACT_FIXTURES,
  PLUGIN_FIXTURE_SET,
  REFERENCE_BLOCK_KEY,
  REFERENCE_EMPTY_BLOCK_KEY,
  REFERENCE_LONG_CONTENT,
  REFERENCE_PLUGIN,
  REFERENCE_REQUEST_FILTER,
  REFERENCE_RESPONSE_FILTER,
  REFERENCE_TOOL_NAME,
  REFERENCE_VERSION,
  type PluginContractFixtureName,
} from './contract/fixtures.js';

/** Токен процесса (тестовый; в лог не попадает). */
const TOKEN = 'plugin-contract-remote-token-1234567890';

const silentLogger: PluginLogger = { warn: () => undefined };

/** JSON-Schema параметров эталонного тула (приходит по проводу). */
const TOOL_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: { query: { type: 'string' } },
  required: ['query'],
};

/** Объявление точки `tools` для сервера. */
function tool(
  name: string,
  description: string,
  capabilities: string[],
): Record<string, unknown> {
  return { name, description, parameters: TOOL_PARAMETERS, capabilities };
}

/**
 * `/capabilities` по фикстуре: что процесс объявляет по проводу.
 *
 * Значения намеренно повторяют регистрации фикстур (`fixtures.ts`), включая
 * «плохие» — так suite проверяет одинаковые правила на обоих транспортах.
 */
function capabilitiesFor(fixture: PluginContractFixtureName): Record<string, unknown> {
  const name = PLUGIN_FIXTURE_SET[fixture].name;
  const base = { protocol: PLUGIN_PROTOCOL_VERSION, name, version: REFERENCE_VERSION };

  switch (fixture) {
    case 'reference':
      return {
        ...base,
        points: {
          promptBlocks: [
            { key: REFERENCE_BLOCK_KEY, tier: 'context', order: 120, title: 'Contract recall' },
            { key: REFERENCE_EMPTY_BLOCK_KEY, tier: 'volatile', order: 130 },
          ],
          llmFilters: [
            { id: REFERENCE_REQUEST_FILTER, phase: 'pre_request' },
            { id: REFERENCE_RESPONSE_FILTER, phase: 'post_response' },
          ],
          tools: [tool(REFERENCE_TOOL_NAME, 'Поиск по памяти плагина', ['search'])],
        },
      };
    case 'stable-block':
      // Невалидный тир: /capabilities обязан быть отклонён (граница prompt-cache).
      return {
        ...base,
        points: {
          promptBlocks: [{ key: 'plugin.contract.stable', tier: 'stable', order: 100 }],
        },
      };
    case 'bad-phase':
      return {
        ...base,
        points: {
          llmFilters: [{ id: 'plugin:contract-bad-phase:x', phase: 'on_before_everything' }],
        },
      };
    case 'bad-verdict':
      return {
        ...base,
        points: { llmFilters: [{ id: 'plugin:contract-bad-verdict:x', phase: 'pre_request' }] },
      };
    case 'provides-mismatch':
      // Манифест объявляет `declared_only`, процесс — `actual_tool`.
      return { ...base, points: { tools: [tool('actual_tool', 'фактический тул', ['search'])] } };
    case 'unknown-capability':
      return {
        ...base,
        points: { tools: [tool('bypass', 'тул с несуществующей capability', ['root'])] },
      };
    case 'reserved-tool-name':
      return {
        ...base,
        points: {
          tools: [tool('plugin_victim_tool', 'попытка занять чужой namespace', ['search'])],
        },
      };
    case 'untrusted-deny':
      return {
        ...base,
        points: { llmFilters: [{ id: 'plugin:contract-untrusted:block', phase: 'pre_request' }] },
      };
    case 'memory':
      // Сервис памяти по проводу не экспонируется: у процесса нет точек.
      return { ...base, points: {} };
  }
}

/**
 * `POST /invoke` по фикстуре: выход точки или `undefined` (неизвестный id).
 *
 * Ответы — те же, что у in-memory фикстур: фильтры эталона `allow`,
 * `bad-verdict` — неизвестный вердикт, `untrusted-deny` — `deny`; тул эталона
 * эхо параметров (`memory:{…}`), блок — длинный текст и пустая строка.
 */
function invokeFor(
  fixture: PluginContractFixtureName,
  point: string,
  id: string,
  input: unknown,
): unknown {
  if (point === 'promptBlocks') {
    if (id === REFERENCE_BLOCK_KEY) return { content: REFERENCE_LONG_CONTENT };
    if (id === REFERENCE_EMPTY_BLOCK_KEY) return { content: '' };
    return undefined;
  }
  if (point === 'llmFilters') {
    if (fixture === 'bad-verdict') return { verdict: 'block' };
    if (fixture === 'untrusted-deny') return { verdict: 'deny', reason: 'хочу блок' };
    return { verdict: 'allow' };
  }
  if (point === 'tools') {
    const parameters = (input as { parameters?: unknown } | null)?.parameters;
    return { content: `memory:${JSON.stringify(parameters)}` };
  }
  return undefined;
}

/** Поднять процесс-заглушку фикстуры (реальный HTTP на `127.0.0.1:0`). */
async function startFixtureServer(fixture: PluginContractFixtureName): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const capabilities = capabilitiesFor(fixture);

  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf-8');
    });
    req.on('end', () => {
      const send = (status: number, payload: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      try {
        if (req.url === '/health') {
          // Liveness — без токена.
          send(200, { status: 'ok' });
          return;
        }
        if (req.headers.authorization !== `Bearer ${TOKEN}`) {
          send(401, { error: { reason: 'unauthorized' } });
          return;
        }
        if (req.url === '/capabilities') {
          send(200, capabilities);
          return;
        }
        if (req.url === '/invoke') {
          const parsed = JSON.parse(body) as { point?: unknown; id?: unknown; input?: unknown };
          if (typeof parsed.point !== 'string' || typeof parsed.id !== 'string') {
            send(400, { error: { reason: 'invalid_request' } });
            return;
          }
          const output = invokeFor(fixture, parsed.point, parsed.id, parsed.input);
          if (output === undefined) {
            send(404, { error: { reason: 'unknown_id' } });
            return;
          }
          send(200, { ok: true, output });
          return;
        }
        send(404, { error: { reason: 'unknown_id' } });
      } catch {
        if (!res.writableEnded) res.destroy();
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/** Серверы текущего теста (закрываются в afterEach). */
const started: Array<{ close: () => Promise<void> }> = [];
/** Процессы по имени плагина-фикстуры (поднимаются лениво). */
const serversByPlugin = new Map<string, { url: string; close: () => Promise<void> }>();

afterEach(async () => {
  await Promise.all(started.splice(0).map(({ close }) => close()));
  serversByPlugin.clear();
});

/** Харнесс на удалённой реализации: `loaders.remote` + адрес процесса. */
async function makeRemoteHarness(): Promise<PluginContractHarness> {
  return createContractHarness({
    transport: 'remote',
    loaders: { remote: createRemotePluginLoader({ logger: silentLogger }) },
    descriptorExtra: async (fixture) => {
      const plugin = PLUGIN_FIXTURE_SET[fixture].name;
      let process = serversByPlugin.get(plugin);
      if (!process) {
        process = await startFixtureServer(fixture);
        serversByPlugin.set(plugin, process);
        started.push(process);
      }
      return {
        // Режим манифеста — `remote`: удалённый загрузчик обслуживает только
        // `remote`/`both` (fixtures.ts описывает плагин без привязки к транспорту).
        manifest: { ...PLUGIN_FIXTURE_SET[fixture].manifest, mode: 'remote' },
        remote: { url: process.url, token: TOKEN },
      };
    },
    cleanup: async () => {
      await Promise.all(started.splice(0).map(({ close }) => close()));
      serversByPlugin.clear();
    },
  });
}

describePluginContract('PluginHost + out-of-process (wire-протокол)', makeRemoteHarness);

describe('remote-харнесс контрактного suite: протокол и отказы', () => {
  it('сервер-заглушка обслуживает все фикстуры набора (эталон + нарушения)', () => {
    for (const fixture of PLUGIN_CONTRACT_FIXTURES) {
      const capabilities = capabilitiesFor(fixture);
      expect(capabilities.protocol).toBe(PLUGIN_PROTOCOL_VERSION);
      expect(capabilities.name).toBe(PLUGIN_FIXTURE_SET[fixture].name);
      expect(capabilities.version).toBe(REFERENCE_VERSION);
    }
  });

  it('эталон обслуживается по проводу: тул, блок и фильтры — из /capabilities', async () => {
    const h = await makeRemoteHarness();
    try {
      const result = await h.activate('reference');
      expect(result.outcome).toBe('activated');
      // Полное имя составил хост, локальное пришло по проводу.
      expect(h.tools.get(h.reference.fullToolName)?.pluginName).toBe(REFERENCE_PLUGIN);
      expect(h.promptBlocks.get(h.reference.blockKey)?.provider.order).toBe(120);
      expect(h.llmFilters.get(h.reference.requestFilterId)?.filter.phase).toBe('pre_request');
    } finally {
      await h.dispose();
    }
  });

  it('неверный токен процесса → активация отклонена (fail-closed)', async () => {
    const process = await startFixtureServer('reference');
    started.push(process);
    const h = await createContractHarness({
      transport: 'remote',
      loaders: { remote: createRemotePluginLoader({ logger: silentLogger }) },
      descriptorExtra: () => ({
        manifest: { ...PLUGIN_FIXTURE_SET.reference.manifest, mode: 'remote' },
        remote: { url: process.url, token: 'wrong-token' },
      }),
    });
    try {
      const result = await h.activate('reference');
      expect(result.outcome).toBe('rejected');
      expect(result.step).toBe('import');
      expect(result.reason).toBe('plugin.loader_unavailable');
      expect(h.tools.listPlugin()).toHaveLength(0);
    } finally {
      await h.dispose();
    }
  });
});

/** Проверки самого remote-харнесса (не входят в контракт плагина). */
describe('remote-харнесс: окружение', () => {
  it('адрес процесса — loopback, токен задан тестом', async () => {
    const process = await startFixtureServer('reference');
    started.push(process);
    expect(process.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(TOKEN.length).toBeGreaterThan(16);
  });
});

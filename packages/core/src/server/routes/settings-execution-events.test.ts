/**
 * События шины на write-путях `createSettingsRoutes`: `execution.updated` и
 * `mcp.updated { action: 'policy' }`.
 *
 * Баг, который эти события закрывают: «профиль исполнения (или MCP-политика),
 * изменённые в другом клиенте, не видны в текущем». Селекторы профиля (агент в
 * админ-панели, проект, настройки сессии) и панели MCP/«Отключённые инструменты»
 * грузят свои данные **один раз** при монтировании, а перечитывать их было не из
 * чего — сервер молчал о мутации (инвариант 27 `AGENTS.md`).
 *
 * Контракт проверяется здесь целиком:
 * - каталог профилей исполнения: `PUT /settings/execution` → `profile.save`,
 *   `DELETE /settings/execution` → `profile.reset`;
 * - политики MCP (`tools-policy`, `mcp-policy`, `mcp-network-policy`,
 *   `tools-disabled`) — `PUT` и `DELETE` → `mcp.updated { action: 'policy' }`;
 * - **не** публикуется при ошибке: 400 (невалидное тело) и 403 (нет прав) —
 *   тишина; `GET` — тоже (чтение не мутирует);
 * - payload — только вид мутации: адреса исполнителей, токен provisioner'а и
 *   конфиг профиля в событие не попадают (инвариант 13).
 *
 * Хуки подменены настоящими публикаторами поверх фейковой шины
 * (`executionChangedPublisher`/`mcpChangedPublisher` — те же, что ставит точка
 * сборки): тест про контракт фабрики, а сами швы проверяются в
 * `src/events/execution-events.test.ts` и `src/events/mcp-events.test.ts`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Context, MiddlewareHandler, Next } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSettingsRoutes } from './settings.js';
import { RuntimeSettingsStore } from '../../storage/runtime-settings.js';
import type { AuthKit } from '../../auth/local.js';
import { defaultConfig, resolveExecutionConfig } from '@itphx/synth-shared/config';
import type { ResolvedExecutionConfig } from '@itphx/synth-shared';
import { publishExecutionUpdated } from '../../events/execution-events.js';
import type { ExecutionChangedInfo } from '../../events/execution-events.js';
import { publishMcpUpdated } from '../../events/mcp-events.js';
import type { McpChangedInfo } from '../../events/mcp-events.js';

/** Записанное событие (тип + payload; инстансный канал подразумевается). */
interface PublishedEvent {
  type: string;
  data: Record<string, unknown>;
}

/** Фейковая шина: только инстансный канал (события ресурсов инстанса). */
function makeBus(published: PublishedEvent[]) {
  return {
    publishInstance: (type: string, data: Record<string, unknown> = {}) => {
      published.push({ type, data });
    },
  };
}

/** Тот же путь публикации, что у точки сборки: `executionChangedPublisher(eventBus)`. */
function executionHook(published: PublishedEvent[]) {
  const bus = makeBus(published);
  return (info: ExecutionChangedInfo) => publishExecutionUpdated(bus, info);
}

/** Тот же путь публикации для политик: `mcpChangedPublisher(eventBus)`. */
function mcpHook(published: PublishedEvent[]) {
  const bus = makeBus(published);
  return (info: McpChangedInfo) => publishMcpUpdated(bus, info);
}

function createMockAuth(): AuthKit {
  return {
    getCurrentUser: () => null,
    requireAuth: async (_c: Context, next: Next) => { await next(); },
  } as unknown as AuthKit;
}

/** Guard, отклоняющий запись (403) — имитация «нет прав» в managed. */
const denyWrite: MiddlewareHandler = async (c) =>
  c.json({ error: { code: 'FORBIDDEN', message: 'no' } }, 403);

let tmpDir: string;

/**
 * Config-уровень секции `execution` (база runtime-каталога).
 *
 * Профили `browser`/`browser-full` — **metadata без image/url** (браузерные
 * образы задаёт Helm, а не runtime-секция).
 */
function baseExecution(): ResolvedExecutionConfig {
  return resolveExecutionConfig(
    {
      ...defaultConfig,
      execution: {
        mode: 'remote',
        remote: {
          ...defaultConfig.execution.remote,
          url: ['http://executor:8080'],
          defaultProfile: 'base',
          browserProfile: 'browser',
          browserProfiles: ['browser', 'browser-full'],
          profiles: {
            base: { url: ['http://base:8080'] },
            legacy: { url: ['http://legacy:8080'] },
            browser: { url: [], description: 'браузер' },
            'browser-full': { url: [], description: 'браузер (полный)' },
          },
        },
      },
    },
    {},
  );
}

function makeApp(
  published: PublishedEvent[],
  opts: { settingsWriteGuard?: MiddlewareHandler } = {},
) {
  const app = new Hono();
  const settingsStore = new RuntimeSettingsStore({ dataDir: tmpDir });
  const base = baseExecution();
  app.route('/api/v2/settings', createSettingsRoutes(createMockAuth(), {
    settingsStore,
    fallbackWorkspace: '/default/workspace',
    fallbackExecution: base,
    getRunningExecution: () => base,
    onExecutionChanged: executionHook(published),
    onMcpPolicyChanged: mcpHook(published),
  }, opts.settingsWriteGuard ? { settingsWriteGuard: opts.settingsWriteGuard } : {}));
  return { app, settingsStore };
}

function json(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'synth-settings-events-'));
});
afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('createSettingsRoutes — событие execution.updated на каталоге профилей', () => {
  let published: PublishedEvent[];

  beforeEach(() => {
    published = [];
  });

  it('PUT /execution публикует { action: profile.save }', async () => {
    const { app, settingsStore } = makeApp(published);

    const res = await app.request('/api/v2/settings/execution', json('PUT', {
      defaultProfile: 'p1',
      profiles: { p1: { image: 'img:p1' } },
    }));

    expect(res.status).toBe(200);
    // Каталог правится целиком, поэтому `profileId` не передаётся: клиент всё
    // равно перечитывает `GET /execution/profiles`.
    expect(published).toEqual([
      { type: 'execution.updated', data: { action: 'profile.save' } },
    ]);
    expect(await settingsStore.getExecution()).toBeDefined();
  });

  it('DELETE /execution публикует { action: profile.reset }', async () => {
    const { app, settingsStore } = makeApp(published);
    await app.request('/api/v2/settings/execution', json('PUT', {
      profiles: { p1: { image: 'img:p1' } },
    }));
    published.length = 0;

    const res = await app.request('/api/v2/settings/execution', { method: 'DELETE' });

    expect(res.status).toBe(200);
    expect(published).toEqual([
      { type: 'execution.updated', data: { action: 'profile.reset' } },
    ]);
    expect(await settingsStore.getExecution()).toBeUndefined();
  });

  it('GET /execution молчит (чтение не мутирует)', async () => {
    const { app } = makeApp(published);

    expect((await app.request('/api/v2/settings/execution')).status).toBe(200);

    expect(published).toEqual([]);
  });

  it('ошибки молчат: 400 (неизвестное поле), 400 (defaultProfile вне каталога)', async () => {
    const { app, settingsStore } = makeApp(published);

    const unknown = await app.request('/api/v2/settings/execution', json('PUT', {
      profiles: { p1: { image: 'img:p1' } },
      unknownField: true,
    }));
    expect(unknown.status).toBe(400);

    const ghostProfile = await app.request('/api/v2/settings/execution', json('PUT', {
      defaultProfile: 'ghost',
      profiles: { p1: { image: 'img:p1' } },
    }));
    expect(ghostProfile.status).toBe(400);

    expect(published).toEqual([]);
    expect(await settingsStore.getExecution()).toBeUndefined();

    // Контроль: после ошибок исправная запись событие всё же публикует.
    expect((await app.request('/api/v2/settings/execution', json('PUT', {
      profiles: { p1: { image: 'img:p1' } },
    }))).status).toBe(200);
    expect(published).toEqual([
      { type: 'execution.updated', data: { action: 'profile.save' } },
    ]);
  });

  it('403 без прав: PUT/DELETE молчат и не пишут', async () => {
    const { app, settingsStore } = makeApp(published, { settingsWriteGuard: denyWrite });

    // `GET /settings/execution` намеренно под тем же guard'ом, что и запись:
    // ответ содержит адреса исполнителей (инвариант 13), поэтому «нет прав» —
    // это 403 и на чтение.
    expect((await app.request('/api/v2/settings/execution')).status).toBe(403);

    const put = await app.request('/api/v2/settings/execution', json('PUT', {
      profiles: { p1: { image: 'img:p1' } },
    }));
    const del = await app.request('/api/v2/settings/execution', { method: 'DELETE' });

    expect(put.status).toBe(403);
    expect(del.status).toBe(403);
    expect(published).toEqual([]);
    expect(await settingsStore.getExecution()).toBeUndefined();
  });

  it('адреса исполнителей в payload не попадают', async () => {
    const { app } = makeApp(published);

    await app.request('/api/v2/settings/execution', json('PUT', {
      profiles: { p1: { url: ['http://user:token@executor.local:8080'] } },
    }));

    expect(published).toHaveLength(1);
    const serialized = JSON.stringify(published);
    expect(serialized).not.toContain('user:token');
    expect(serialized).not.toContain('executor.local');
  });
});

describe('createSettingsRoutes — событие mcp.updated { action: policy } на политиках', () => {
  let published: PublishedEvent[];

  beforeEach(() => {
    published = [];
  });

  /** Секции политик: путь, валидное тело, заведомо невалидное тело. */
  const SECTIONS: readonly { path: string; valid: Record<string, unknown> }[] = [
    { path: 'tools-policy', valid: { toolsPolicy: 'available' } },
    { path: 'mcp-policy', valid: { mcpPolicy: 'consistency' } },
    { path: 'mcp-network-policy', valid: { policy: { mode: 'allow', list: ['example.com'] } } },
    { path: 'tools-disabled', valid: { toolsDisabled: { capabilities: ['git_read'], tools: [] } } },
  ];

  for (const section of SECTIONS) {
    it(`PUT /${section.path} публикует { action: policy }`, async () => {
      const { app } = makeApp(published);

      const res = await app.request(`/api/v2/settings/${section.path}`, json('PUT', section.valid));

      expect(res.status).toBe(200);
      // Политика меняет эффективный MCP-скоуп, а не состав реестра: вид
      // мутации `policy`, без имён серверов.
      expect(published).toEqual([
        { type: 'mcp.updated', data: { action: 'policy' } },
      ]);
    });

    it(`DELETE /${section.path} публикует { action: policy }`, async () => {
      const { app } = makeApp(published);

      const res = await app.request(`/api/v2/settings/${section.path}`, { method: 'DELETE' });

      expect(res.status).toBe(200);
      expect(published).toEqual([
        { type: 'mcp.updated', data: { action: 'policy' } },
      ]);
    });

    it(`GET /${section.path} молчит (чтение не мутирует)`, async () => {
      const { app } = makeApp(published);

      expect((await app.request(`/api/v2/settings/${section.path}`)).status).toBe(200);

      expect(published).toEqual([]);
    });
  }

  it('ошибки молчат: 400 на невалидное тело каждой секции', async () => {
    const { app } = makeApp(published);

    const invalidBodies: readonly [string, Record<string, unknown>][] = [
      ['tools-policy', { toolsPolicy: 'nope' }],
      ['mcp-policy', { mcpPolicy: 'nope' }],
      ['mcp-network-policy', { policy: { mode: 'block', list: [] } }],
      ['tools-disabled', { toolsDisabled: { capabilities: ['nope'], tools: [] } }],
    ];
    for (const [path, body] of invalidBodies) {
      expect((await app.request(`/api/v2/settings/${path}`, json('PUT', body))).status).toBe(400);
    }

    expect(published).toEqual([]);

    // Контроль: исправная запись событие всё же публикует.
    expect((await app.request('/api/v2/settings/tools-policy', json('PUT', {
      toolsPolicy: 'auto',
    }))).status).toBe(200);
    expect(published).toEqual([
      { type: 'mcp.updated', data: { action: 'policy' } },
    ]);
  });

  it('403 без прав: PUT/DELETE политик молчат', async () => {
    const { app, settingsStore } = makeApp(published, { settingsWriteGuard: denyWrite });

    for (const section of SECTIONS) {
      expect((await app.request(
        `/api/v2/settings/${section.path}`,
        json('PUT', section.valid),
      )).status).toBe(403);
      expect((await app.request(
        `/api/v2/settings/${section.path}`,
        { method: 'DELETE' },
      )).status).toBe(403);
    }

    expect(published).toEqual([]);
    expect(await settingsStore.getToolsPolicy()).toBeUndefined();
    expect(await settingsStore.getMcpPolicy()).toBeUndefined();
  });
});

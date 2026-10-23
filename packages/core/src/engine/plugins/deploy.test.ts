/**
 * PROP-090 Ф5в: тесты deploy-каталога (образ/PVC) — разбор и установка при
 * старте.
 *
 * Проверки идут на **реальных** временных каталогах (`mkdtemp`), как у
 * установщика/рантайма: deploy-конвейер работает с файловой системой
 * (`synth.pack`, `dist/`, раскладка `installed/`), и подмена `fs` скрыла бы
 * именно те дефекты (битый манифест, пропуск бандла, content-hash), ради
 * которых он написан. Порты хранения — in-memory.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PackManifest, PluginsConfig } from '@itphx/synth-shared';
import { pluginsConfigSchema } from '@itphx/synth-shared';

import { MemoryPluginAuditRepository } from '../../storage/memory/plugin-audit.js';
import { MemoryPluginLockRepository } from '../../storage/memory/plugin-lock.js';
import { PromptBlockRegistry } from '../context/prompt-block-registry.js';
import { LlmFilterRegistry } from '../gateway/llm-filter-registry.js';
import { createToolRegistry } from '../tools/index.js';
import { listDeployPlugins } from './deploy.js';
import { resolvePluginLayout } from './layout.js';
import { PluginRuntime } from './runtime.js';

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

/** Конфиг слоя: установка разрешена, доверие по умолчанию (`verified`). */
function config(over: Partial<PluginsConfig> = {}): PluginsConfig {
  return { ...pluginsConfigSchema.parse({ runtimeInstall: 'allow' }), ...over };
}

/** Манифест плагина (provides — один блок промпта: пустой provides невалиден). */
function manifest(over: Partial<PackManifest> = {}): PackManifest {
  const name = over.name ?? 'demo-plugin';
  return {
    name,
    version: '1.0.0',
    kind: 'plugin',
    description: 'deploy-плагин',
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

/** Каталог бандла: `synth.pack` + `dist/index.js`. */
async function makeBundle(
  opts: { manifest?: PackManifest; code?: string; manifestText?: string } = {},
): Promise<string> {
  const dir = await makeTempDir('synth-plugin-deploy-bundle-');
  await writeFile(
    join(dir, 'synth.pack'),
    opts.manifestText ?? `${JSON.stringify(opts.manifest ?? manifest(), null, 2)}\n`,
    'utf-8',
  );
  await mkdir(join(dir, 'dist'), { recursive: true });
  await writeFile(
    join(dir, 'dist', 'index.js'),
    opts.code ?? 'export function apply() { return undefined; }\n',
    'utf-8',
  );
  return dir;
}

/** Каталог развёртывания: подкаталоги-бандлы `name` → каталог бандла. */
async function makeDeployDir(bundles: Array<{ sub: string; dir: string }>): Promise<string> {
  const root = await makeTempDir('synth-plugin-deploy-root-');
  for (const bundle of bundles) {
    // deploy-каталог = набор подкаталогов-бандлов; копируем бандл целиком.
    await cp(bundle.dir, join(root, bundle.sub), { recursive: true });
  }
  return root;
}

/** Стенд рантайма: раскладка во временном каталоге + in-memory порты. */
async function makeRuntime(over: Partial<PluginsConfig> = {}) {
  const dataDir = await makeTempDir('synth-plugin-deploy-data-');
  const lock = new MemoryPluginLockRepository();
  const runtime = new PluginRuntime({
    layout: resolvePluginLayout({ dataDir, env: {} }),
    lock,
    audit: new MemoryPluginAuditRepository(),
    config: config(over),
    hostVersion: '0.11.0',
    promptBlocks: new PromptBlockRegistry(),
    llmFilters: new LlmFilterRegistry(),
    tools: createToolRegistry(),
    logger: { warn: () => undefined },
  });
  return { runtime, lock };
}

// ── Разбор каталога ──────────────────────────────────────────────────────

describe('listDeployPlugins: разбор deploy-каталога', () => {
  it('два бандла + битый манифест → 2 записи, битый пропущен с предупреждением', async () => {
    const alpha = await makeBundle({ manifest: manifest({ name: 'alpha' }) });
    const beta = await makeBundle({ manifest: manifest({ name: 'beta', version: '2.0.0' }) });
    const root = await makeDeployDir([
      { sub: 'alpha', dir: alpha },
      { sub: 'beta', dir: beta },
    ]);
    // Битый манифест: подкаталог есть, `synth.pack` — не JSON.
    const broken = join(root, 'broken');
    await mkdir(join(broken, 'dist'), { recursive: true });
    await writeFile(join(broken, 'synth.pack'), '{ not json', 'utf-8');

    const warnings: string[] = [];
    const entries = await listDeployPlugins(root, {
      logger: { warn: (message: string) => warnings.push(message) },
    });

    expect(entries.map((entry) => entry.name)).toEqual(['alpha', 'beta']);
    expect(entries[1]?.version).toBe('2.0.0');
    expect(entries[0]?.dir).toBe(join(root, 'alpha'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('broken');
  });

  it('каталог не задан/отсутствует → пустой список, без исключения', async () => {
    await expect(listDeployPlugins('')).resolves.toEqual([]);
    await expect(
      listDeployPlugins(join(tmpdir(), 'synth-plugin-deploy-missing-dir-xyz')),
    ).resolves.toEqual([]);
  });
});

// ── Установка при старте ─────────────────────────────────────────────────

describe('PluginRuntime.installDeployPlugins (Ф5в)', () => {
  it('deployDir не задан (пустая строка) → no-op (пустой результат, lock пуст)', async () => {
    const { runtime, lock } = await makeRuntime({ deployDir: '' });

    const result = await runtime.installDeployPlugins({ actor: 'startup' });

    expect(result).toEqual({ installed: [], skipped: [], failed: [] });
    expect(await lock.list()).toEqual([]);
  });

  it('ставит бандлы без активации; повторный вызов → skipped (content-hash совпал)', async () => {
    const alpha = await makeBundle({ manifest: manifest({ name: 'alpha' }) });
    const beta = await makeBundle({ manifest: manifest({ name: 'beta' }) });
    const root = await makeDeployDir([
      { sub: 'alpha', dir: alpha },
      { sub: 'beta', dir: beta },
    ]);
    const { runtime, lock } = await makeRuntime({ deployDir: root });

    const first = await runtime.installDeployPlugins({ actor: 'startup' });
    expect(first.installed.sort()).toEqual(['alpha', 'beta']);
    expect(first.failed).toEqual([]);
    expect(runtime.host.isActive('alpha')).toBe(false);

    const entries = await lock.list();
    expect(entries.map((entry) => entry.source)).toEqual(['deploy', 'deploy']);
    expect(entries[0]?.identifier).toBe(join(root, 'alpha'));

    const second = await runtime.installDeployPlugins({ actor: 'startup' });
    expect(second.installed).toEqual([]);
    expect(second.skipped.sort()).toEqual(['alpha', 'beta']);
  });

  it('ошибка одного бандла не ломает остальные: dangerous → failed, соседний ставится', async () => {
    const good = await makeBundle({ manifest: manifest({ name: 'good' }) });
    const bad = await makeBundle({
      manifest: manifest({ name: 'bad' }),
      code: 'export function apply() { return eval("1 + 1"); }\n',
    });
    const root = await makeDeployDir([
      { sub: 'bad', dir: bad },
      { sub: 'good', dir: good },
    ]);
    const { runtime, lock } = await makeRuntime({ deployDir: root });

    const result = await runtime.installDeployPlugins({ actor: 'startup' });

    expect(result.installed).toEqual(['good']);
    expect(result.failed).toEqual([{ name: 'bad', reason: 'plugin.scan_rejected' }]);
    expect((await lock.list()).map((entry) => entry.name)).toEqual(['good']);
  });

  it('доверие ниже trust-floor → failed plugin.trust_below_floor, lock пуст', async () => {
    const alpha = await makeBundle({ manifest: manifest({ name: 'alpha' }) });
    const root = await makeDeployDir([{ sub: 'alpha', dir: alpha }]);
    const { runtime, lock } = await makeRuntime({
      deployDir: root,
      deployTrust: 'community',
      trustFloor: 'trusted',
    });

    const result = await runtime.installDeployPlugins({ actor: 'startup' });

    expect(result.installed).toEqual([]);
    expect(result.failed).toEqual([{ name: 'alpha', reason: 'plugin.trust_below_floor' }]);
    expect(await lock.list()).toEqual([]);
  });

  it('переустановка при изменившемся бандле: версия та же, content-hash другой → installed', async () => {
    const alpha = await makeBundle({ manifest: manifest({ name: 'alpha' }) });
    const root = await makeDeployDir([{ sub: 'alpha', dir: alpha }]);
    const { runtime } = await makeRuntime({ deployDir: root });
    expect((await runtime.installDeployPlugins()).installed).toEqual(['alpha']);

    // Обновили файл в deploy-каталоге (новый образ) — та же версия, новый хеш.
    await writeFile(
      join(root, 'alpha', 'dist', 'index.js'),
      'export function apply() { return 42; }\n',
      'utf-8',
    );

    const result = await runtime.installDeployPlugins();
    expect(result.installed).toEqual(['alpha']);
    expect(result.skipped).toEqual([]);
  });
});

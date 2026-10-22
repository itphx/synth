/**
 * PROP-090 Ф4а: тесты `inline`-загрузчика кода плагина
 * (`engine/plugins/inline-loader.ts`).
 *
 * Все проверки — на **реальных** временных каталогах и реальных ESM-файлах:
 * загрузчик работает с файловой системой (`realpath`/`stat`) и настоящим
 * `import()`, поэтому подмена `fs` скрыла бы именно те дефекты (containment,
 * симлинки, кэш ESM), ради которых он написан.
 *
 * Ключевое свойство Ф4а: шаг `import` пайплайна `PluginHost` больше не глухая
 * стена — при `plugins.executionEnabled=true` и подключённом `inline`-загрузчике
 * плагин реально активируется и его вклады попадают в живые реестры.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { PackManifest, PluginsConfig } from '@itphx/synth-shared';
import { pluginsConfigSchema } from '@itphx/synth-shared';

import { MemoryPluginAuditRepository } from '../../storage/memory/plugin-audit.js';
import { PromptBlockRegistry } from '../context/prompt-block-registry.js';
import { PluginHost } from './plugin-host.js';
import { PluginLoadError } from './activation.js';
import type { PluginActivationDescriptor, PluginModule, PluginLogger } from './activation.js';
import { createInlinePluginLoader, DEFAULT_PLUGIN_ENTRY } from './inline-loader.js';

/** Логгер-заглушка: загрузчик предупреждает про mtime, шум в выводе не нужен. */
const silentLogger: PluginLogger = { warn: () => undefined };

/** Временные каталоги теста (убираются в `afterEach`). */
const tempDirs: string[] = [];

/** Создать временный каталог и разложить в него файлы бандла. */
async function makeBundleDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'synth-inline-loader-'));
  tempDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const target = join(dir, rel);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, 'utf-8');
  }
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Манифест плагина (`kind: 'plugin'`) с пустыми вкладами. */
function manifest(over: Partial<PackManifest> = {}): PackManifest {
  return {
    name: 'demo-plugin',
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
    },
    ...over,
  } as PackManifest;
}

/** Дескриптор установки для загрузчика. */
function descriptor(over: Partial<PluginActivationDescriptor> = {}): PluginActivationDescriptor {
  return {
    name: 'demo-plugin',
    version: '1.0.0',
    manifest: manifest(),
    trustLevel: 'trusted',
    ...over,
  };
}

/** Конфиг слоя плагинов с дефолтами схемы (+ переопределения). */
function config(over: Partial<PluginsConfig> = {}): PluginsConfig {
  return { ...pluginsConfigSchema.parse({}), ...over };
}

/** Ожидаемый отказ загрузчика: `PluginLoadError` с причиной. */
async function expectLoadError(
  promise: Promise<unknown>,
  reason: 'plugin.loader_unavailable' | 'plugin.module_invalid',
): Promise<PluginLoadError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(PluginLoadError);
  const loadError = err as PluginLoadError;
  expect(loadError.reason).toBe(reason);
  return loadError;
}

// ── Контракт модуля ──────────────────────────────────────────────────────

describe('inline-загрузчик: формы модуля', () => {
  it('export function apply → возвращает apply, но не вызывает его', async () => {
    const dir = await makeBundleDir({
      'dist/index.js': 'export function apply(facade) { facade.registerDisposer(() => {}); }\n',
    });
    const loader = createInlinePluginLoader({ logger: silentLogger });
    const mod: PluginModule = await loader(descriptor({ rootDir: dir }));
    expect(typeof mod.apply).toBe('function');
  });

  it('export default { apply } принимается', async () => {
    const dir = await makeBundleDir({
      'dist/index.js': 'export default { apply() { return undefined; } };\n',
    });
    const loader = createInlinePluginLoader({ logger: silentLogger });
    const mod = await loader(descriptor({ rootDir: dir }));
    expect(typeof mod.apply).toBe('function');
  });

  it('export default function принимается как apply', async () => {
    const dir = await makeBundleDir({
      'dist/index.js': 'export default function apply() { return undefined; }\n',
    });
    const loader = createInlinePluginLoader({ logger: silentLogger });
    const mod = await loader(descriptor({ rootDir: dir }));
    expect(typeof mod.apply).toBe('function');
  });

  it('точка входа по умолчанию — dist/index.js (entry не задан)', async () => {
    const dir = await makeBundleDir({
      [DEFAULT_PLUGIN_ENTRY]: 'export function apply() { return undefined; }\n',
    });
    expect(DEFAULT_PLUGIN_ENTRY).toBe('dist/index.js');
    const loader = createInlinePluginLoader({ logger: silentLogger });
    const mod = await loader(descriptor({ rootDir: dir }));
    expect(typeof mod.apply).toBe('function');
  });

  it('entry из lock-записи (не dist/index.js) загружается', async () => {
    const dir = await makeBundleDir({
      'bundle/main.mjs': 'export function apply() { return undefined; }\n',
    });
    const loader = createInlinePluginLoader({ logger: silentLogger });
    const mod = await loader(descriptor({ rootDir: dir, entry: 'bundle/main.mjs' }));
    expect(typeof mod.apply).toBe('function');
  });

  it('модуль без apply (export const x = 1) → plugin.module_invalid', async () => {
    const dir = await makeBundleDir({ 'dist/index.js': 'export const x = 1;\n' });
    const loader = createInlinePluginLoader({ logger: silentLogger });
    const err = await expectLoadError(
      loader(descriptor({ rootDir: dir })),
      'plugin.module_invalid',
    );
    expect(err.message).toContain('apply');
  });

  it('export default 42 → plugin.module_invalid', async () => {
    const dir = await makeBundleDir({ 'dist/index.js': 'export default 42;\n' });
    const loader = createInlinePluginLoader({ logger: silentLogger });
    await expectLoadError(loader(descriptor({ rootDir: dir })), 'plugin.module_invalid');
  });

  it('бросок на верхнем уровне модуля → plugin.loader_unavailable', async () => {
    const dir = await makeBundleDir({
      'dist/index.js': "throw new Error('boom');\n",
    });
    const loader = createInlinePluginLoader({ logger: silentLogger });
    const err = await expectLoadError(
      loader(descriptor({ rootDir: dir })),
      'plugin.loader_unavailable',
    );
    expect(err.message).toContain('boom');
  });
});

// ── Containment, расширение, размер ──────────────────────────────────────

describe('inline-загрузчик: containment и проверки файла', () => {
  it('rootDir не задан → отказ', async () => {
    const loader = createInlinePluginLoader({ logger: silentLogger });
    const err = await expectLoadError(
      loader(descriptor()),
      'plugin.loader_unavailable',
    );
    expect(err.message).toContain('rootDir');
  });

  it('entry «../evil.js» (файл реально есть рядом с rootDir) → отказ', async () => {
    const dir = await makeBundleDir({ 'dist/index.js': 'export function apply() {}\n' });
    // Файл-приманка лежит рядом с каталогом бандла и валиден как модуль.
    const outside = join(dir, 'evil.js');
    await writeFile(outside, 'export function apply() {}\n', 'utf-8');

    const loader = createInlinePluginLoader({ logger: silentLogger });
    const err = await expectLoadError(
      loader(descriptor({ rootDir: join(dir, 'dist'), entry: '../evil.js' })),
      'plugin.loader_unavailable',
    );
    expect(err.message).toContain('за пределы');
  });

  it('абсолютный путь вне rootDir → отказ', async () => {
    const dir = await makeBundleDir({ 'dist/index.js': 'export function apply() {}\n' });
    const outside = join(dir, 'outside.js');
    await writeFile(outside, 'export function apply() {}\n', 'utf-8');

    const loader = createInlinePluginLoader({ logger: silentLogger });
    const err = await expectLoadError(
      loader(descriptor({ rootDir: join(dir, 'dist'), entry: outside })),
      'plugin.loader_unavailable',
    );
    expect(err.message).toContain('абсолютным путём');
  });

  it('симлинк наружу из rootDir → отказ', async () => {
    const dir = await makeBundleDir({ 'dist/index.js': 'export function apply() {}\n' });
    const outside = join(dir, 'outside.js');
    await writeFile(outside, 'export function apply() {}\n', 'utf-8');
    const link = join(dir, 'dist', 'link.js');
    await symlink(outside, link);

    const loader = createInlinePluginLoader({ logger: silentLogger });
    const err = await expectLoadError(
      loader(descriptor({ rootDir: join(dir, 'dist'), entry: 'link.js' })),
      'plugin.loader_unavailable',
    );
    expect(err.message).toContain('за пределы');
  });

  it('расширение .ts → отказ (загружается только собранный бандл)', async () => {
    const dir = await makeBundleDir({
      'dist/index.ts': 'export function apply() {}\n',
    });
    const loader = createInlinePluginLoader({ logger: silentLogger });
    const err = await expectLoadError(
      loader(descriptor({ rootDir: dir, entry: 'dist/index.ts' })),
      'plugin.loader_unavailable',
    );
    expect(err.message).toContain('.ts');
  });

  it('превышение maxBundleBytes → отказ', async () => {
    const dir = await makeBundleDir({
      'dist/index.js': `export function apply() { /* ${'x'.repeat(200)} */ }\n`,
    });
    const loader = createInlinePluginLoader({ logger: silentLogger, maxBundleBytes: 16 });
    const err = await expectLoadError(
      loader(descriptor({ rootDir: dir })),
      'plugin.loader_unavailable',
    );
    expect(err.message).toContain('больше предела');
  });

  it('отсутствующий файл входа → отказ', async () => {
    const dir = await makeBundleDir({ 'dist/other.js': 'export function apply() {}\n' });
    const loader = createInlinePluginLoader({ logger: silentLogger });
    await expectLoadError(loader(descriptor({ rootDir: dir })), 'plugin.loader_unavailable');
  });
});

// ── Cache-busting ────────────────────────────────────────────────────────

describe('inline-загрузчик: cache-busting', () => {
  it('URL импорта содержит ?v=<contentHash>, если hash задан', async () => {
    const dir = await makeBundleDir({ 'dist/index.js': 'export function apply() {}\n' });
    const urls: string[] = [];
    const loader = createInlinePluginLoader({
      logger: silentLogger,
      importModule: (url: string) => {
        urls.push(url);
        return import(url);
      },
    });
    await loader(descriptor({ rootDir: dir, contentHash: 'abc123' }));
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('?v=abc123');
  });

  it('без contentHash cache-busting идёт по mtime', async () => {
    const dir = await makeBundleDir({ 'dist/index.js': 'export function apply() {}\n' });
    const urls: string[] = [];
    const loader = createInlinePluginLoader({
      logger: silentLogger,
      importModule: (url: string) => {
        urls.push(url);
        return import(url);
      },
    });
    await loader(descriptor({ rootDir: dir }));
    expect(urls[0]).toMatch(/\?v=\d+(\.\d+)?$/);
  });

  it('после перезаписи бандла загружается новое содержимое (не кэш ESM)', async () => {
    const dir = await makeBundleDir({
      'dist/index.js': "export function apply() { return 'one'; }\n",
    });
    const file = join(dir, 'dist', 'index.js');
    const loader = createInlinePluginLoader({ logger: silentLogger });

    const first = await loader(descriptor({ rootDir: dir }));
    const firstApply = first.apply as unknown as () => string;
    expect(firstApply()).toBe('one');

    await writeFile(file, "export function apply() { return 'two'; }\n", 'utf-8');
    // mtime в файловых системах с секундной гранулярностью может не измениться
    // при быстрой перезаписи — сдвигаем явно.
    const later = new Date(Date.now() + 5_000);
    await utimes(file, later, later);

    const second = await loader(descriptor({ rootDir: dir }));
    const secondApply = second.apply as unknown as () => string;
    expect(secondApply()).toBe('two');
  });
});

// ── Сквозной тест через PluginHost ───────────────────────────────────────

/** Эталонный бандл: регистрирует блок системного промпта. */
const REFERENCE_BUNDLE = `
export function apply(facade) {
  facade.registerPromptBlock({
    key: 'plugin.demo.e2e',
    tier: 'volatile',
    order: 10,
    async load() {
      return { content: 'E2E-BLOCK' };
    },
  });
}
`;

/** Манифест эталона: объявленный блок совпадает с регистрируемым. */
function referenceManifest(): PackManifest {
  return manifest({
    provides: {
      mcp: [],
      skills: [],
      agents: [],
      pipelines: [],
      tools: [],
      promptBlocks: [{ key: 'plugin.demo.e2e', tier: 'volatile', order: 10 }],
      llmFilters: [],
    },
  } as Partial<PackManifest>);
}

/** Хост с журналом аудита, реестром блоков и логгером-заглушкой. */
function makeHost(over: Partial<ConstructorParameters<typeof PluginHost>[0]> = {}): {
  host: PluginHost;
  audit: MemoryPluginAuditRepository;
} {
  const audit = new MemoryPluginAuditRepository();
  const host = new PluginHost({
    audit,
    config: config({ executionEnabled: true }),
    hostVersion: '0.11.0',
    logger: { warn: () => undefined },
    ...over,
  });
  return { host, audit };
}

describe('PluginHost × inline-загрузчик: шаг import больше не глухая стена', () => {
  it('виртуальный каталог с бандлом → activated, блок в реестре, аудит', async () => {
    const dir = await makeBundleDir({ 'dist/index.js': REFERENCE_BUNDLE });
    const registry = new PromptBlockRegistry();
    const { host, audit } = makeHost({
      loader: createInlinePluginLoader({ logger: silentLogger }),
      promptBlocks: registry,
    });

    const result = await host.activate(
      descriptor({ manifest: referenceManifest(), rootDir: dir }),
    );

    expect(result.outcome).toBe('activated');
    expect(result.plugin).toBe('demo-plugin');
    expect(host.isActive('demo-plugin')).toBe(true);
    expect(registry.get('plugin.demo.e2e')).toBeDefined();
    expect(registry.size).toBe(1);

    const entries = await audit.list();
    expect(entries.some((e) => e.action === 'activate' && e.outcome === 'ok')).toBe(true);

    // Деактивация снимает блок (disposer дошёл до реестра через фасад).
    await host.deactivate('demo-plugin');
    expect(registry.size).toBe(0);
  });

  it('модуль без apply → отказ plugin.module_invalid (шаг import) + аудит', async () => {
    const dir = await makeBundleDir({ 'dist/index.js': 'export const x = 1;\n' });
    const { host, audit } = makeHost({
      loader: createInlinePluginLoader({ logger: silentLogger }),
    });

    const result = await host.activate(descriptor({ rootDir: dir }));

    expect(result.outcome).toBe('rejected');
    expect(result.reason).toBe('plugin.module_invalid');
    expect(result.step).toBe('import');
    expect(host.isActive('demo-plugin')).toBe(false);

    const entries = await audit.list();
    const rejected = entries.filter((e) => e.action === 'activate' && e.outcome === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBe('plugin.module_invalid');
  });

  it('сбой загрузки (файла нет) → plugin.loader_unavailable', async () => {
    const dir = await makeBundleDir({ 'dist/other.js': 'export function apply() {}\n' });
    const { host } = makeHost({
      loader: createInlinePluginLoader({ logger: silentLogger }),
    });

    const result = await host.activate(descriptor({ rootDir: dir }));
    expect(result.outcome).toBe('rejected');
    expect(result.reason).toBe('plugin.loader_unavailable');
    expect(result.step).toBe('import');
  });
});

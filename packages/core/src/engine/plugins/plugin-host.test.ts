/**
 * PROP-090 Ф1: тесты `PluginHost` — пайплайн активации, реестр активаций,
 * обратная прокрутка disposers и журнал аудита.
 *
 * Ключевое свойство Ф1: **исполнение кода выключено по умолчанию** —
 * `plugins.executionEnabled=false`, поэтому шаг `import` останавливается с
 * `plugin.execution_disabled` (ожидаемый исход, а не ошибка).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PackManifest, PluginsConfig, PromptBlockProvider, Session } from '@itphx/synth-shared';
import { pluginsConfigSchema } from '@itphx/synth-shared';

import { MemoryPluginAuditRepository } from '../../storage/memory/plugin-audit.js';
import { PluginHost } from './plugin-host.js';
import type {
  PluginActivationDescriptor,
  PluginDisposer,
  PluginLoader,
  PluginModule,
} from './activation.js';
import { computePluginContentHash } from './integrity.js';
import { PromptBlockRegistry } from '../context/prompt-block-registry.js';
import { SystemPromptComposer, type ComposerContext } from '../context/composer.js';
import { ContextBuilder } from '../context/builder.js';
import { ContextConfig } from '../context/config.js';

/** Конфиг слоя плагинов с дефолтами схемы. */
function config(over: Partial<PluginsConfig> = {}): PluginsConfig {
  return { ...pluginsConfigSchema.parse({}), ...over };
}

/** Манифест плагина (`kind: 'plugin'`). */
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
      tools: ['demo_tool'],
      promptBlocks: [],
      llmFilters: [],
    },
    ...over,
  } as PackManifest;
}

/** Дескриптор плагина, подготовленного к активации. */
function descriptor(over: Partial<PluginActivationDescriptor> = {}): PluginActivationDescriptor {
  const files = over.files ?? { 'dist/index.js': 'console.log(1);' };
  return {
    name: 'demo-plugin',
    version: '1.0.0',
    manifest: manifest(),
    trustLevel: 'trusted',
    files,
    ...over,
  };
}

/** Хост с журналом аудита и логгером-заглушкой. */
function makeHost(
  over: Partial<ConstructorParameters<typeof PluginHost>[0]> = {},
): { host: PluginHost; audit: MemoryPluginAuditRepository } {
  const audit = new MemoryPluginAuditRepository();
  const host = new PluginHost({
    audit,
    config: config(),
    hostVersion: '0.11.0',
    logger: { warn: () => undefined },
    ...over,
  });
  return { host, audit };
}

// ── Ф3а: композер для проверки блоков промпта ─────────────────────────

/** Временный каталог с ролями — ContextBuilder читает оттуда ролевой промпт. */
async function makeUserDataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'synth-plugin-host-'));
  await mkdir(join(dir, 'user'), { recursive: true });
  await mkdir(join(dir, 'roles'), { recursive: true });
  await writeFile(join(dir, 'roles', 'ASSISTANT.md'), 'ROLE-MARKER', 'utf-8');
  return dir;
}

/**
 * Композер с общим реестром провайдеров (тот же, что у хоста плагинов).
 *
 * `userDataDir` — временный каталог с ролями: без него `ContextBuilder` не
 * находит ролевой промпт, и проверка «блок попал в промпт» зависела бы от
 * того, что в системе нет постороннего `roles/ASSISTANT.md`.
 */
function makeComposer(registry: PromptBlockRegistry, userDataDir: string): SystemPromptComposer {
  const builder = new ContextBuilder(new ContextConfig({ userDataDir }));
  return new SystemPromptComposer({ contextBuilder: builder, promptBlocks: registry });
}

/** Минимальный контекст композера (сессия без проекта). */
function makeComposerCtx(): ComposerContext {
  const session = {
    id: 's1',
    messages: [],
    settings: { language: 'ru', agentRole: 'assistant', showInterview: false },
  } as unknown as Session;
  return {
    session,
    workingDir: '/ws',
    language: 'ru',
    routingEnabled: false,
    gatewayEnabled: false,
  };
}

describe('PluginHost: шаг resolve', () => {
  it('пустой дескриптор → plugin.not_found', async () => {
    const { host, audit } = makeHost();
    const result = await host.activate(null);
    expect(result.outcome).toBe('rejected');
    expect(result.reason).toBe('plugin.not_found');
    expect(result.step).toBe('resolve');
    expect(await audit.list()).toHaveLength(1);
  });

  it('манифест не kind: plugin → plugin.manifest_invalid', async () => {
    const { host } = makeHost();
    const result = await host.activate(
      descriptor({ manifest: manifest({ kind: 'pack', packType: 'skills' }) }),
    );
    expect(result.reason).toBe('plugin.manifest_invalid');
  });

  it('расхождение дескриптора и манифеста → plugin.manifest_invalid', async () => {
    const { host } = makeHost();
    const result = await host.activate(descriptor({ version: '2.0.0' }));
    expect(result.reason).toBe('plugin.manifest_invalid');
  });
});

describe('PluginHost: шаг integrity', () => {
  it('расхождение content-hash → plugin.integrity_mismatch', async () => {
    const { host } = makeHost();
    const result = await host.activate(descriptor({ contentHash: 'b'.repeat(64) }));
    expect(result.outcome).toBe('rejected');
    expect(result.reason).toBe('plugin.integrity_mismatch');
    expect(result.step).toBe('integrity');
  });

  it('ожидаемый hash без файлов → plugin.integrity_unverifiable (fail-closed)', async () => {
    const { host } = makeHost();
    const result = await host.activate(descriptor({ contentHash: 'c'.repeat(64), files: undefined }));
    expect(result.reason).toBe('plugin.integrity_unverifiable');
  });

  it('совпадающий hash — шаг пройден (доходим до import)', async () => {
    const { host } = makeHost();
    const files = { 'dist/index.js': 'console.log(1);' };
    const result = await host.activate(
      descriptor({ files, contentHash: computePluginContentHash(files) }),
    );
    expect(result.reason).toBe('plugin.execution_disabled');
    expect(result.step).toBe('import');
  });

  it('content-hash зависит от состава файлов (не только от их содержимого)', () => {
    const a = computePluginContentHash({ 'a.js': 'x' });
    const b = computePluginContentHash({ 'b.js': 'x' });
    const c = computePluginContentHash({ 'a.js': 'x', 'b.js': 'x' });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    // Порядок ключей не влияет.
    expect(computePluginContentHash({ 'a.js': 'x', 'b.js': 'y' })).toBe(
      computePluginContentHash({ 'b.js': 'y', 'a.js': 'x' }),
    );
  });
});

describe('PluginHost: шаг semver-гейт', () => {
  it('несовместимый контракт → plugin.contract_mismatch', async () => {
    const { host } = makeHost();
    const result = await host.activate(
      descriptor({ manifest: manifest({ contracts: { extensionApi: '^2' } }) }),
    );
    expect(result.reason).toBe('plugin.contract_mismatch');
    expect(result.step).toBe('semver');
  });

  it('несовместимая версия host → plugin.host_mismatch', async () => {
    const { host } = makeHost();
    const result = await host.activate(descriptor({ manifest: manifest({ host: '^0.9.0' }) }));
    expect(result.reason).toBe('plugin.host_mismatch');
  });

  it('exactHostExceptions снимает отказ по host-диапазону', async () => {
    const { host } = makeHost({ exactHostExceptions: ['0.11.0'] });
    const result = await host.activate(descriptor({ manifest: manifest({ host: '^0.9.0' }) }));
    expect(result.reason).toBe('plugin.execution_disabled');
    expect(result.step).toBe('import');
  });
});

describe('PluginHost: шаг trust/scan', () => {
  it('community при trust-floor trusted → plugin.trust_below_floor', async () => {
    const { host } = makeHost();
    const result = await host.activate(descriptor({ trustLevel: 'community' }));
    expect(result.reason).toBe('plugin.trust_below_floor');
    expect(result.step).toBe('trust');
  });

  it('доверие не задано → fail-closed (считается community)', async () => {
    const { host } = makeHost();
    const result = await host.activate(descriptor({ trustLevel: undefined }));
    expect(result.reason).toBe('plugin.trust_below_floor');
  });

  it('verified при trust-floor trusted — проходит', async () => {
    const { host } = makeHost();
    const result = await host.activate(descriptor({ trustLevel: 'verified' }));
    expect(result.step).toBe('import');
  });

  it('trust-floor community — community проходит', async () => {
    const { host } = makeHost({ config: config({ trustFloor: 'community' }) });
    const result = await host.activate(descriptor({ trustLevel: 'community' }));
    expect(result.step).toBe('import');
  });

  it('хук скана с вердиктом не safe → plugin.scan_rejected (точка расширения Ф2)', async () => {
    const { host } = makeHost({
      scan: async () => ({ verdict: 'dangerous', reason: 'бинарный файл' }),
    });
    const result = await host.activate(descriptor());
    expect(result.reason).toBe('plugin.scan_rejected');
    expect(result.message).toContain('бинарный файл');
  });

  it('хук скана с вердиктом safe — проходит', async () => {
    const { host } = makeHost({ scan: async () => ({ verdict: 'safe' }) });
    const result = await host.activate(descriptor());
    expect(result.step).toBe('import');
  });
});

describe('PluginHost: Ф2 — скан и install-policy', () => {
  it('вердикт dangerous → plugin.scan_rejected', async () => {
    const { host, audit } = makeHost({
      scan: async () => ({ verdict: 'dangerous', performed: true, findings: [] }),
    });
    const result = await host.activate(descriptor());
    expect(result.outcome).toBe('rejected');
    expect(result.reason).toBe('plugin.scan_rejected');
    expect(result.step).toBe('trust');

    const scans = (await audit.list()).filter((entry) => entry.action === 'scan');
    expect(scans).toHaveLength(1);
    expect(scans[0]!.scanVerdict).toBe('dangerous');
    expect(scans[0]!.outcome).toBe('rejected');
    expect(scans[0]!.reason).toBe('plugin.scan_rejected');
  });

  it('вердикт caution → plugin.approval_required (не scan_rejected)', async () => {
    const { host, audit } = makeHost({
      scan: async () => ({ verdict: 'caution', performed: true, findings: [] }),
    });
    const result = await host.activate(descriptor());
    expect(result.outcome).toBe('rejected');
    expect(result.reason).toBe('plugin.approval_required');
    expect(result.reason).not.toBe('plugin.scan_rejected');

    const scans = (await audit.list()).filter((entry) => entry.action === 'scan');
    expect(scans[0]!.scanVerdict).toBe('caution');
    expect(scans[0]!.reason).toBe('plugin.approval_required');
  });

  it('plugins.scan=disabled → активация проходит, в аудите scanPerformed=false', async () => {
    const { host, audit } = makeHost({ config: config({ scan: 'disabled' }) });
    const result = await host.activate(descriptor());
    expect(result.step).toBe('import');

    const scans = (await audit.list()).filter((entry) => entry.action === 'scan');
    expect(scans).toHaveLength(1);
    expect(scans[0]!.scanPerformed).toBe(false);
    expect(scans[0]!.scanVerdict).toBe('safe');
    expect(scans[0]!.outcome).toBe('ok');
  });

  it('plugins.scan=disabled → сканирование не выполняется вовсе', async () => {
    const scan = vi.fn(async () => ({ verdict: 'dangerous' as const }));
    const { host } = makeHost({ config: config({ scan: 'disabled' }), scan });
    const result = await host.activate(descriptor());
    expect(result.step).toBe('import');
    expect(scan).not.toHaveBeenCalled();
  });

  it('trust-floor срабатывает ДО install-policy (dangerous не перебивает доверие)', async () => {
    const { host, audit } = makeHost({
      scan: async () => ({ verdict: 'dangerous', performed: true, findings: [] }),
    });
    const result = await host.activate(descriptor({ trustLevel: 'community' }));
    expect(result.reason).toBe('plugin.trust_below_floor');
    expect(result.reason).not.toBe('plugin.scan_rejected');

    // Скан не запускался — в журнале нет записи `scan`.
    const scans = (await audit.list()).filter((entry) => entry.action === 'scan');
    expect(scans).toHaveLength(0);
  });

  it('встроенный сканер (без явного хука) отклоняет опасный бандл', async () => {
    const { host } = makeHost();
    const result = await host.activate(
      descriptor({ files: { 'a.js': "readFileSync('.env')" } }),
    );
    expect(result.reason).toBe('plugin.scan_rejected');
  });

  it('встроенный сканер: caution → plugin.approval_required', async () => {
    const { host } = makeHost();
    const result = await host.activate(
      descriptor({ files: { 'a.js': 'const k = process.env.KEY; fetch(url);' } }),
    );
    expect(result.reason).toBe('plugin.approval_required');
  });

  it('сбой сканера → fail-closed (plugin.scan_rejected)', async () => {
    const { host } = makeHost({
      scan: async () => {
        throw new Error('сканер упал');
      },
    });
    const result = await host.activate(descriptor());
    expect(result.outcome).toBe('rejected');
    expect(result.reason).toBe('plugin.scan_rejected');
  });

  it('число находок и вердикт пишутся в запись аудита `scan`', async () => {
    const { host, audit } = makeHost({
      scan: async () => ({
        verdict: 'caution',
        performed: true,
        findings: [
          { category: 'injection', severity: 'medium', file: 'a.js', line: 1, description: 'x' },
        ],
        contentHash: 'a'.repeat(64),
      }),
    });
    await host.activate(descriptor());

    const scans = (await audit.list()).filter((entry) => entry.action === 'scan');
    expect(scans[0]!.scanFindings).toBe(1);
    expect(scans[0]!.contentHash).toBe('a'.repeat(64));
    expect(scans[0]!.trustLevel).toBe('trusted');
  });
});

describe('PluginHost: шаг политики режима', () => {
  it('plugins.enabled=false → plugin.disabled', async () => {
    const { host } = makeHost({ config: config({ enabled: false }) });
    const result = await host.activate(descriptor());
    expect(result.reason).toBe('plugin.disabled');
    expect(result.step).toBe('policy');
  });

  it('runtime-install при runtimeInstall=deny → plugin.runtime_install_denied', async () => {
    const { host } = makeHost({ config: config({ runtimeInstall: 'deny' }) });
    const result = await host.activate(descriptor({ installKind: 'runtime' }));
    expect(result.reason).toBe('plugin.runtime_install_denied');
  });

  it('deploy-time плагин при runtimeInstall=deny — проходит', async () => {
    const { host } = makeHost({ config: config({ runtimeInstall: 'deny' }) });
    const result = await host.activate(descriptor({ installKind: 'deploy' }));
    expect(result.step).toBe('import');
  });

  it('denylist → plugin.denylisted; allowlist → plugin.not_allowlisted', async () => {
    const denied = makeHost({ config: config({ denylist: ['demo-plugin'] }) });
    expect((await denied.host.activate(descriptor())).reason).toBe('plugin.denylisted');

    const allowed = makeHost({ config: config({ allowlist: ['other-plugin'] }) });
    expect((await allowed.host.activate(descriptor())).reason).toBe('plugin.not_allowlisted');
  });
});

describe('PluginHost: шаг import (исполнение кода выключено в Ф1)', () => {
  it('executionEnabled=false → plugin.execution_disabled', async () => {
    const { host } = makeHost();
    const result = await host.activate(descriptor());
    expect(result.outcome).toBe('rejected');
    expect(result.reason).toBe('plugin.execution_disabled');
    expect(result.step).toBe('import');
  });

  it('executionEnabled=true без загрузчика → plugin.loader_unavailable', async () => {
    const { host } = makeHost({ config: config({ executionEnabled: true }) });
    const result = await host.activate(descriptor());
    expect(result.reason).toBe('plugin.loader_unavailable');
  });

  it('загрузчик не вызывается при executionEnabled=false', async () => {
    const loader = vi.fn(async (): Promise<PluginModule> => ({ apply: () => undefined }));
    const { host } = makeHost({ loader });
    await host.activate(descriptor());
    expect(loader).not.toHaveBeenCalled();
  });
});

describe('PluginHost: активация, реестр и идемпотентность', () => {
  /** Загрузчик-заглушка: Ф1 core не грузит код — seam инъецируется. */
  function loaderWith(disposers: PluginDisposer[] = []): PluginLoader {
    return async () => ({
      apply: (facade) => {
        for (const disposer of disposers) facade.registerDisposer(disposer);
      },
    });
  }

  it('успешная активация → outcome activated, запись в реестре', async () => {
    const { host, audit } = makeHost({
      config: config({ executionEnabled: true }),
      loader: loaderWith(),
    });
    const result = await host.activate(descriptor(), { actor: 'admin' });
    expect(result.outcome).toBe('activated');
    expect(result.step).toBe('facade');
    expect(host.isActive('demo-plugin')).toBe(true);
    expect(host.listActivations()).toHaveLength(1);
    expect(host.getActivation('demo-plugin')?.version).toBe('1.0.0');

    const entries = await audit.list();
    // Ф2: активация + отдельная запись скана.
    expect(entries).toHaveLength(2);
    expect(entries[0]!.outcome).toBe('ok');
    expect(entries[0]!.action).toBe('activate');
    expect(entries[0]!.actor).toBe('admin');
    expect(entries[0]!.scope).toBe('plugin');
    expect(entries[1]!.action).toBe('scan');
    expect(entries[1]!.scanVerdict).toBe('safe');
    expect(entries[1]!.scanPerformed).toBe(true);
  });

  it('повторная активация активного плагина → plugin.already_active', async () => {
    const { host, audit } = makeHost({
      config: config({ executionEnabled: true }),
      loader: loaderWith(),
    });
    await host.activate(descriptor());
    const second = await host.activate(descriptor());
    expect(second.outcome).toBe('rejected');
    expect(second.reason).toBe('plugin.already_active');

    const entries = await audit.list();
    // Ф2: scan + activate(ok) + activate(rejected).
    expect(entries).toHaveLength(3);
    expect(entries[0]!.outcome).toBe('rejected');
    expect(entries[0]!.reason).toBe('plugin.already_active');
  });

  it('отказ пишется в журнал аудита (outcome rejected + код причины)', async () => {
    const { host, audit } = makeHost();
    await host.activate(descriptor({ trustLevel: 'community' }));
    const entries = await audit.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.outcome).toBe('rejected');
    expect(entries[0]!.reason).toBe('plugin.trust_below_floor');
    expect(entries[0]!.plugin).toBe('demo-plugin');
    expect(entries[0]!.version).toBe('1.0.0');
  });

  it('ошибка загрузчика → plugin.loader_unavailable, плагин не активен', async () => {
    const { host } = makeHost({
      config: config({ executionEnabled: true }),
      loader: async () => {
        throw new Error('сломанный бандл');
      },
    });
    const result = await host.activate(descriptor());
    expect(result.reason).toBe('plugin.loader_unavailable');
    expect(host.isActive('demo-plugin')).toBe(false);
  });

  it('ошибка apply() → вклады откатываются, плагин не активен', async () => {
    const disposed: string[] = [];
    const { host } = makeHost({
      config: config({ executionEnabled: true }),
      loader: async () => ({
        apply: (facade) => {
          facade.registerDisposer(() => {
            disposed.push('a');
          });
          throw new Error('регистрация отвергнута');
        },
      }),
    });
    const result = await host.activate(descriptor());
    expect(result.reason).toBe('plugin.loader_unavailable');
    expect(host.isActive('demo-plugin')).toBe(false);
    expect(disposed).toEqual(['a']);
  });
});

describe('PluginHost: Ф3а — фасад (точка promptBlocks)', () => {
  /** Каталог с ролями для композера (создаётся на каждый кейс). */
  let userDataDir: string;

  beforeEach(async () => {
    userDataDir = await makeUserDataDir();
  });

  afterEach(async () => {
    await rm(userDataDir, { recursive: true, force: true });
  });

  it('плагин регистрирует блок промпта → блок в промпте; deactivate() → блок исчезает', async () => {
    const registry = new PromptBlockRegistry();
    const { host } = makeHost({
      config: config({ executionEnabled: true }),
      promptBlocks: registry,
      loader: async () => ({
        apply: (facade) => {
          facade.registerPromptBlock({
            key: 'plugin.demo.memory',
            tier: 'context',
            order: 100,
            load: () => 'ПАМЯТЬ ПЛАГИНА',
          });
        },
      }),
    });

    const activated = await host.activate(
      descriptor({
        manifest: manifest({
          provides: {
            ...manifest().provides,
            promptBlocks: [{ key: 'plugin.demo.memory', tier: 'context', order: 100 }],
          },
        }),
      }),
    );
    expect(activated.outcome).toBe('activated');
    expect(registry.size).toBe(1);

    const composer = makeComposer(registry, userDataDir);
    const composed = await composer.compose(makeComposerCtx());
    expect(composed.system).toContain('ПАМЯТЬ ПЛАГИНА');
    const block = composed.blocks.find((b) => b.key === 'plugin.demo.memory');
    expect(block?.provenance).toBe('plugin:demo-plugin');

    // Деактивация снимает блок (обратная прокрутка disposers).
    const deactivated = await host.deactivate('demo-plugin');
    expect(deactivated.outcome).toBe('ok');
    expect(registry.size).toBe(0);

    const after = await composer.compose(makeComposerCtx());
    expect(after.system).not.toContain('ПАМЯТЬ ПЛАГИНА');
  });

  it('провайдер с тиром stable отклоняется, активация плагина не падает', async () => {
    const warnings: string[] = [];
    const registry = new PromptBlockRegistry();
    const { host } = makeHost({
      config: config({ executionEnabled: true }),
      promptBlocks: registry,
      logger: { warn: (message: string) => warnings.push(message) },
      loader: async () => ({
        apply: (facade) => {
          facade.registerPromptBlock({
            key: 'plugin.demo.stable',
            tier: 'stable',
            order: 100,
            load: () => 'НЕ ДОЛЖНО ПОПАСТЬ',
          } as unknown as PromptBlockProvider);
        },
      }),
    });

    const result = await host.activate(descriptor());
    expect(result.outcome).toBe('activated');
    expect(registry.size).toBe(0);
    expect(warnings.join('\n')).toContain('stable');

    const composer = makeComposer(registry, userDataDir);
    const composed = await composer.compose(makeComposerCtx());
    expect(composed.system).not.toContain('НЕ ДОЛЖНО ПОПАСТЬ');
  });

  it('провайдер, бросающий исключение → ход не падает, блок пуст', async () => {
    const registry = new PromptBlockRegistry();
    const { host } = makeHost({
      config: config({ executionEnabled: true }),
      promptBlocks: registry,
      loader: async () => ({
        apply: (facade) => {
          facade.registerPromptBlock({
            key: 'plugin.demo.broken',
            tier: 'context',
            order: 100,
            load: () => {
              throw new Error('сбой retrieval');
            },
          });
        },
      }),
    });

    // Активация не падает: ошибка провайдера — дело хода, а не регистрации.
    const result = await host.activate(descriptor());
    expect(result.outcome).toBe('activated');
    expect(registry.size).toBe(1);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const composer = makeComposer(registry, userDataDir);
      const composed = await composer.compose(makeComposerCtx());
      expect(composed.system).not.toContain('сбой retrieval');
      const block = composed.blocks.find((b) => b.key === 'plugin.demo.broken');
      expect(block).toBeDefined();
      expect(block!.content).toBe('');
      expect(block!.status).toBe('empty');
      // Деградация зафиксирована предупреждением, а не исключением.
      expect(warn).toHaveBeenCalled();
      expect(String(warn.mock.calls[0]![0])).toContain('plugin.demo.broken');
    } finally {
      warn.mockRestore();
    }
  });

  it('без реестра провайдеров регистрация блока — предупреждение, не падение', async () => {
    const warnings: string[] = [];
    const { host } = makeHost({
      config: config({ executionEnabled: true }),
      logger: { warn: (message: string) => warnings.push(message) },
      loader: async () => ({
        apply: (facade) => {
          facade.registerPromptBlock({
            key: 'plugin.demo.memory',
            tier: 'context',
            order: 100,
            load: () => 'x',
          });
        },
      }),
    });

    const result = await host.activate(descriptor());
    expect(result.outcome).toBe('activated');
    expect(warnings.join('\n')).toContain('promptBlocks');
  });
});

describe('PluginHost: решение владельца — scan=disabled при включённом исполнении', () => {
  it('plugins.scan=disabled + executionEnabled=true → plugin.scan_disabled_with_execution', async () => {
    const { host, audit } = makeHost({
      config: config({ scan: 'disabled', executionEnabled: true }),
    });
    const result = await host.activate(descriptor());
    expect(result.outcome).toBe('rejected');
    expect(result.reason).toBe('plugin.scan_disabled_with_execution');
    expect(result.step).toBe('trust');

    // Скан не выполнялся — записи `scan` в журнале нет.
    const scans = (await audit.list()).filter((entry) => entry.action === 'scan');
    expect(scans).toHaveLength(0);
  });

  it('plugins.scan=disabled без исполнения кода — поведение прежнее (активация проходит)', async () => {
    const { host } = makeHost({ config: config({ scan: 'disabled' }) });
    const result = await host.activate(descriptor());
    expect(result.step).toBe('import');
  });
});

describe('PluginHost: деактивация и disposers', () => {
  /** Хост с загрузчиком, регистрирующим заданные disposer'ы. */
  async function hostWithDisposers(
    disposers: PluginDisposer[],
    over: Partial<ConstructorParameters<typeof PluginHost>[0]> = {},
  ): Promise<{ host: PluginHost; audit: MemoryPluginAuditRepository }> {
    const made = makeHost({
      config: config({ executionEnabled: true }),
      loader: async () => ({
        apply: (facade) => {
          for (const disposer of disposers) facade.registerDisposer(disposer);
        },
      }),
      ...over,
    });
    await made.host.activate(descriptor());
    return made;
  }

  it('disposer’ы вызываются в обратном порядке регистрации', async () => {
    const order: string[] = [];
    const { host } = await hostWithDisposers([
      () => {
        order.push('first');
      },
      () => {
        order.push('second');
      },
      () => {
        order.push('third');
      },
    ]);
    const result = await host.deactivate('demo-plugin');
    expect(result.outcome).toBe('ok');
    expect(result.disposed).toBe(3);
    expect(order).toEqual(['third', 'second', 'first']);
    expect(host.isActive('demo-plugin')).toBe(false);
  });

  it('ошибка одного disposer’а не прерывает остальные', async () => {
    const order: string[] = [];
    const { host, audit } = await hostWithDisposers([
      () => {
        order.push('first');
      },
      () => {
        throw new Error('disposer упал');
      },
      () => {
        order.push('third');
      },
    ]);
    const result = await host.deactivate('demo-plugin');
    expect(result.outcome).toBe('ok');
    expect(result.disposed).toBe(2);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.error).toContain('disposer упал');
    expect(order).toEqual(['third', 'first']);

    const entries = await audit.list();
    expect(entries[0]!.action).toBe('deactivate');
    expect(entries[0]!.outcome).toBe('ok');
    expect(entries[0]!.reason).toBe('plugin.disposer_failed');
  });

  it('деактивация неактивного плагина → plugin.not_active', async () => {
    const { host, audit } = makeHost();
    const result = await host.deactivate('demo-plugin');
    expect(result.outcome).toBe('rejected');
    expect(result.reason).toBe('plugin.not_active');
    const entries = await audit.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.action).toBe('deactivate');
    expect(entries[0]!.outcome).toBe('rejected');
  });

  it('registerDisposer работает только для активного плагина', async () => {
    const { host } = await hostWithDisposers([]);
    expect(host.registerDisposer('demo-plugin', () => undefined)).toBe(true);
    expect(host.registerDisposer('other-plugin', () => undefined)).toBe(false);
  });
});

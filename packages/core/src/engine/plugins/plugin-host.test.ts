/**
 * PROP-090 Ф1: тесты `PluginHost` — пайплайн активации, реестр активаций,
 * обратная прокрутка disposers и журнал аудита.
 *
 * Ключевое свойство Ф1: **исполнение кода выключено по умолчанию** —
 * `plugins.executionEnabled=false`, поэтому шаг `import` останавливается с
 * `plugin.execution_disabled` (ожидаемый исход, а не ошибка).
 */
import { describe, expect, it, vi } from 'vitest';
import type { PackManifest, PluginsConfig } from '@itphx/synth-shared';
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
    expect(entries).toHaveLength(1);
    expect(entries[0]!.outcome).toBe('ok');
    expect(entries[0]!.action).toBe('activate');
    expect(entries[0]!.actor).toBe('admin');
    expect(entries[0]!.scope).toBe('plugin');
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
    expect(entries).toHaveLength(2);
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

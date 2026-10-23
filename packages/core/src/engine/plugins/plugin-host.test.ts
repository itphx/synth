/**
 * PROP-090 Ф1: тесты `PluginHost` — пайплайн активации, реестр активаций,
 * обратная прокрутка disposers и журнал аудита.
 *
 * Ключевое свойство Ф1: **исполнение кода выключено по умолчанию** —
 * `plugins.executionEnabled=false`, поэтому шаг `import` останавливается с
 * `plugin.execution_disabled` (ожидаемый исход, а не ошибка).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  LlmCallFilter,
  LlmFilterPhase,
  LLMChunk,
  LLMGatewayConfig,
  LLMResponse,
  PackManifest,
  PluginsConfig,
  PromptBlockProvider,
  Session,
  ToolContext,
} from '@itphx/synth-shared';
import { pluginsConfigSchema, ToolCapability } from '@itphx/synth-shared';

import { MemoryPluginAuditRepository } from '../../storage/memory/plugin-audit.js';
import { PluginHost } from './plugin-host.js';
import type {
  PluginActivationDescriptor,
  PluginDisposer,
  PluginFacade,
  PluginLoader,
  PluginModule,
} from './activation.js';
import { computePluginContentHash } from './integrity.js';
import { PromptBlockRegistry } from '../context/prompt-block-registry.js';
import { SystemPromptComposer, type ComposerContext } from '../context/composer.js';
import { ContextBuilder } from '../context/builder.js';
import { ContextConfig } from '../context/config.js';
import { AuditLogger, GatewayProvider, LlmFilterRegistry, RateLimiter } from '../gateway/index.js';
import { BaseProvider, type CancellationToken, type LLMMessage } from '../../providers/base.js';
import { ToolRegistry } from '../tools/registry.js';
import { PermissionEvaluator } from '../permission/evaluator.js';

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
      // Ф3в: тулы сверяются с фактическими регистрациями — по умолчанию плагин
      // тулов не объявляет (кейсы точки `tools` задают список явно).
      tools: [],
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

describe('PluginHost: Ф7 — серверная политика гибрида (Уровень 1, cooperative)', () => {
  it('плагина нет в серверном allow-list → plugin.hybrid_not_allowed', async () => {
    const { host, audit } = makeHost({
      serverPolicy: () => ({ mode: 'allowlist', allow: ['other-plugin'] }),
    });
    const result = await host.activate(descriptor());
    expect(result.outcome).toBe('rejected');
    expect(result.reason).toBe('plugin.hybrid_not_allowed');
    expect(result.step).toBe('policy');

    // Отказ записан в журнал аудита плагинов.
    const entries = await audit.list();
    expect(entries.some((e) => e.action === 'activate' && e.reason === 'plugin.hybrid_not_allowed')).toBe(true);
  });

  it('плагин в серверном allow-list → активация проходит', async () => {
    const { host } = makeHost({
      serverPolicy: () => ({ mode: 'allowlist', allow: ['demo-plugin'] }),
    });
    const result = await host.activate(descriptor());
    // Дальше гейта активации идёт шаг import (исполнение кода выключено).
    expect(result.step).toBe('import');
    expect(result.reason).toBe('plugin.execution_disabled');
  });

  it('политика неизвестна (сервера нет/недоступен) → активация проходит (cooperative)', async () => {
    const { host } = makeHost({ serverPolicy: () => undefined });
    const result = await host.activate(descriptor());
    expect(result.step).toBe('import');
    expect(result.reason).toBe('plugin.execution_disabled');
    // Статус проверки сервером — «не проверен» (cooperative-маркер).
    expect(await host.serverPolicyStatus('demo-plugin')).toBe('unverified');
  });

  it('сервер в режиме off → ограничений нет, статус allowed', async () => {
    const { host } = makeHost({ serverPolicy: () => ({ mode: 'off', allow: [] }) });
    const result = await host.activate(descriptor());
    expect(result.step).toBe('import');
    expect(await host.serverPolicyStatus('demo-plugin')).toBe('allowed');
  });

  it('сбой резолвера политики не ломает активацию (cooperative)', async () => {
    const { host } = makeHost({
      serverPolicy: () => {
        throw new Error('сервер недоступен');
      },
    });
    const result = await host.activate(descriptor());
    expect(result.step).toBe('import');
    expect(await host.serverPolicyStatus('demo-plugin')).toBe('unverified');
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
    // Блок объявлен в `provides` — сверка «объявлено ↔ зарегистрировано» (Ф3б)
    // проходит.
    const result = await host.activate(
      descriptor({
        manifest: manifest({
          provides: {
            ...manifest().provides,
            promptBlocks: [{ key: 'plugin.demo.broken', tier: 'context', order: 100 }],
          },
        }),
      }),
    );
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

// ── Ф3б: точка `llmFilters` — фасад, реестр, gateway, сверка `provides` ──

/** Мок-провайдер: считает вызовы `chat` (эмбеддинги в этих кейсах не нужны). */
class MockPluginFilterProvider extends BaseProvider {
  static chatCalls = 0;
  static responseContent = 'ответ модели';

  async chat(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
    _stream?: boolean,
    _debugCollector?: unknown,
  ): Promise<LLMResponse> {
    MockPluginFilterProvider.chatCalls += 1;
    return {
      content: MockPluginFilterProvider.responseContent,
      model: this.model,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    };
  }

  async *chatAsync(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
    _debugCollector?: unknown,
    _cancellationToken?: CancellationToken,
  ): AsyncGenerator<LLMChunk> {
    MockPluginFilterProvider.chatCalls += 1;
    yield { content: MockPluginFilterProvider.responseContent, isFinal: true, model: this.model };
  }

  async embed(_text: string): Promise<number[]> {
    return [0.1, 0.2];
  }

  getProviderName(): string {
    return 'mockplugin';
  }
}

/** Gateway с общим реестром фильтров — тот же экземпляр, что у хоста плагинов. */
function makeFilterGateway(registry: LlmFilterRegistry, auditDir: string): GatewayProvider {
  const inner = new MockPluginFilterProvider({ url: 'http://mock', apiKey: 'k', model: 'm' });
  const gatewayConfig: LLMGatewayConfig = {
    enabled: true,
    inputMode: 'obfuscate',
    logPayloads: false,
    payloadLogPath: '',
    rateLimit: { userPerMinute: 100, providerPerMinute: 100 },
    audit: { enabled: true, logPath: '' },
  };
  return new GatewayProvider(inner, gatewayConfig, {
    getMap: async () => ({}),
    saveMap: async () => undefined,
    getAudit: () => new AuditLogger(join(auditDir, 'gateway-audit.jsonl')),
    getRateLimiter: () => new RateLimiter(100, 100),
    sessionId: 's1',
    userId: 'u1',
    filters: registry,
  });
}

/** Одно сообщение пользователя для вызова gateway. */
function makeLlmMessage(content: string): LLMMessage {
  return {
    id: 'm1',
    role: 'user',
    content,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    disabled: false,
    pinned: false,
    branchId: 'b1',
  };
}

/** Манифест плагина, объявивший фильтры LLM-вызовов (`provides.llmFilters[]`). */
function manifestWithFilters(filters: Array<{ id: string; phase?: LlmFilterPhase }>): PackManifest {
  return manifest({
    provides: {
      ...manifest().provides,
      llmFilters: filters.map((filter) => ({
        id: filter.id,
        phase: filter.phase ?? 'pre_request',
      })),
    },
  });
}

describe('PluginHost: Ф3б — фасад (точка llmFilters)', () => {
  let auditDir: string;

  beforeEach(async () => {
    auditDir = await mkdtemp(join(tmpdir(), 'synth-plugin-filters-'));
    MockPluginFilterProvider.chatCalls = 0;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(auditDir, { recursive: true, force: true });
  });

  /** Загрузчик, регистрирующий фильтры через фасад. */
  function filterLoader(filters: LlmCallFilter[]): PluginLoader {
    return async () => ({
      apply: (facade: PluginFacade) => {
        for (const filter of filters) facade.registerLlmFilter(filter);
      },
    });
  }

  it('фильтр из плагина применяется: deny блокирует вызов, событие — в журнале плагинов', async () => {
    const registry = new LlmFilterRegistry();
    const { host, audit } = makeHost({
      config: config({ executionEnabled: true }),
      llmFilters: registry,
      loader: filterLoader([
        {
          id: 'plugin:demo-plugin:dlp',
          phase: 'pre_request',
          inspect: () => ({ verdict: 'deny', reason: 'DLP' }),
        },
      ]),
    });

    const activated = await host.activate(
      descriptor({ manifest: manifestWithFilters([{ id: 'plugin:demo-plugin:dlp' }]) }),
    );
    expect(activated.outcome).toBe('activated');

    // Хост подставил владельца: имя/версия/фактическое доверие.
    const entry = registry.get('plugin:demo-plugin:dlp');
    expect(entry).toBeDefined();
    expect(entry!.pluginName).toBe('demo-plugin');
    expect(entry!.pluginVersion).toBe('1.0.0');
    expect(entry!.trustLevel).toBe('trusted');

    const gateway = makeFilterGateway(registry, auditDir);
    const response = await gateway.chat([makeLlmMessage('привет')]);

    expect(MockPluginFilterProvider.chatCalls).toBe(0);
    expect(response.content).toContain('extension filter');

    const filterEntries = (await audit.list()).filter((e) => e.action === 'filter');
    expect(filterEntries).toHaveLength(1);
    expect(filterEntries[0]).toMatchObject({
      plugin: 'demo-plugin',
      version: '1.0.0',
      outcome: 'rejected',
      reason: 'plugin_filter.denied',
      trustLevel: 'trusted',
    });
    // Текст запроса в журнал не попадает (инвариант 13).
    expect(JSON.stringify(filterEntries)).not.toContain('привет');
  });

  it('deactivate() снимает фильтр — вызов снова уходит провайдеру', async () => {
    const registry = new LlmFilterRegistry();
    const { host } = makeHost({
      config: config({ executionEnabled: true }),
      llmFilters: registry,
      loader: filterLoader([
        { id: 'plugin:demo-plugin:dlp', phase: 'pre_request', inspect: () => ({ verdict: 'deny' }) },
      ]),
    });
    await host.activate(
      descriptor({ manifest: manifestWithFilters([{ id: 'plugin:demo-plugin:dlp' }]) }),
    );
    expect(registry.size).toBe(1);

    const deactivated = await host.deactivate('demo-plugin');
    expect(deactivated.outcome).toBe('ok');
    expect(registry.size).toBe(0);

    const gateway = makeFilterGateway(registry, auditDir);
    const response = await gateway.chat([makeLlmMessage('привет')]);
    expect(MockPluginFilterProvider.chatCalls).toBe(1);
    expect(response.content).toBe('ответ модели');
  });

  it('фильтр недоверенного плагина: deny понижается до allow, в журнале — факт понижения', async () => {
    const registry = new LlmFilterRegistry();
    const { host, audit } = makeHost({
      config: config({ executionEnabled: true, trustFloor: 'community' }),
      llmFilters: registry,
      loader: filterLoader([
        {
          id: 'plugin:demo-plugin:block',
          phase: 'pre_request',
          inspect: () => ({ verdict: 'deny', reason: 'хочу блок' }),
        },
      ]),
    });

    const activated = await host.activate(
      descriptor({
        trustLevel: 'community',
        manifest: manifestWithFilters([{ id: 'plugin:demo-plugin:block' }]),
      }),
    );
    expect(activated.outcome).toBe('activated');
    expect(registry.get('plugin:demo-plugin:block')!.trustLevel).toBe('community');

    const gateway = makeFilterGateway(registry, auditDir);
    const response = await gateway.chat([makeLlmMessage('привет')]);

    // Право вето — только у доверенных: вызов ушёл провайдеру.
    expect(MockPluginFilterProvider.chatCalls).toBe(1);
    expect(response.content).toBe('ответ модели');

    const filterEntries = (await audit.list()).filter((e) => e.action === 'filter');
    expect(filterEntries).toHaveLength(1);
    expect(filterEntries[0]).toMatchObject({
      outcome: 'ok',
      reason: 'plugin_filter.deny_downgraded',
      trustLevel: 'community',
    });
  });

  it('битый фильтр (дубль id) → предупреждение, активация не падает, disposer — no-op', async () => {
    const warnings: string[] = [];
    const registry = new LlmFilterRegistry();
    const filter: LlmCallFilter = {
      id: 'plugin:demo-plugin:dup',
      phase: 'pre_request',
      inspect: () => ({ verdict: 'allow' }),
    };
    const { host } = makeHost({
      config: config({ executionEnabled: true }),
      llmFilters: registry,
      logger: { warn: (message: string) => warnings.push(message) },
      loader: filterLoader([filter, filter]),
    });

    const result = await host.activate(
      descriptor({ manifest: manifestWithFilters([{ id: 'plugin:demo-plugin:dup' }]) }),
    );
    expect(result.outcome).toBe('activated');
    expect(registry.size).toBe(1);
    expect(warnings.join('\n')).toContain('plugin:demo-plugin:dup');

    // Деактивация проходит: no-op disposer не бросает, живой фильтр снят.
    await host.deactivate('demo-plugin');
    expect(registry.size).toBe(0);
  });

  it('фильтр с пустым id отклоняется на регистрации: предупреждение, активация не падает', async () => {
    const warnings: string[] = [];
    const registry = new LlmFilterRegistry();
    const { host } = makeHost({
      config: config({ executionEnabled: true }),
      llmFilters: registry,
      logger: { warn: (message: string) => warnings.push(message) },
      loader: filterLoader([
        { id: '', phase: 'pre_request', inspect: () => ({ verdict: 'allow' }) },
      ]),
    });

    const result = await host.activate(descriptor());
    expect(result.outcome).toBe('activated');
    expect(registry.size).toBe(0);
    expect(warnings.join('\n')).toContain('фильтра LLM-вызовов');
  });

  it('без реестра фильтров регистрация — предупреждение, активация не падает', async () => {
    const warnings: string[] = [];
    const { host } = makeHost({
      config: config({ executionEnabled: true }),
      logger: { warn: (message: string) => warnings.push(message) },
      loader: filterLoader([
        { id: 'plugin:demo-plugin:x', phase: 'pre_request', inspect: () => ({ verdict: 'allow' }) },
      ]),
    });

    const result = await host.activate(descriptor());
    expect(result.outcome).toBe('activated');
    expect(warnings.join('\n')).toContain('llmFilters');
  });

  it('сверка provides: объявлен, но не зарегистрирован → plugin.provides_mismatch', async () => {
    const registry = new LlmFilterRegistry();
    const { host, audit } = makeHost({
      config: config({ executionEnabled: true }),
      llmFilters: registry,
      loader: filterLoader([]),
    });

    const result = await host.activate(
      descriptor({ manifest: manifestWithFilters([{ id: 'plugin:demo-plugin:f1' }]) }),
    );
    expect(result.outcome).toBe('rejected');
    expect(result.reason).toBe('plugin.provides_mismatch');
    expect(result.step).toBe('facade');
    expect(result.message).toContain('plugin:demo-plugin:f1');
    expect(host.isActive('demo-plugin')).toBe(false);

    const rejected = (await audit.list()).find(
      (entry) => entry.action === 'activate' && entry.outcome === 'rejected',
    );
    expect(rejected?.reason).toBe('plugin.provides_mismatch');
  });

  it('сверка provides: зарегистрирован, но не объявлен → отказ и откат регистрации', async () => {
    const registry = new LlmFilterRegistry();
    const { host } = makeHost({
      config: config({ executionEnabled: true }),
      llmFilters: registry,
      loader: filterLoader([
        { id: 'plugin:demo-plugin:extra', phase: 'pre_request', inspect: () => ({ verdict: 'allow' }) },
      ]),
    });

    const result = await host.activate(descriptor());
    expect(result.outcome).toBe('rejected');
    expect(result.reason).toBe('plugin.provides_mismatch');
    // Отклонённый плагин не оставляет фильтров в живом реестре.
    expect(registry.size).toBe(0);
  });
});

// ── Ф3в: точка `tools` — фасад, реестр, permission-слой, сверка `provides` ──

/** Манифест плагина, объявивший тулы (`provides.tools[]` — локальные имена). */
function manifestWithTools(tools: string[]): PackManifest {
  return manifest({ provides: { ...manifest().provides, tools } });
}

/** Загрузчик, регистрирующий тулы через фасад. */
function toolLoader(
  tools: Array<{ name: string; capabilities?: ToolCapability[] }>,
): PluginLoader {
  return async () => ({
    apply: (facade: PluginFacade) => {
      for (const tool of tools) {
        facade.registerTool({
          name: tool.name,
          description: `плагинный ${tool.name}`,
          parameters: z.object({ query: z.string().optional() }),
          capabilities: tool.capabilities ?? [ToolCapability.SEARCH],
          execute: async (params: unknown) => ({
            content: `ok:${JSON.stringify(params)}`,
          }),
        });
      }
    },
  });
}

/** Контекст исполнения встроенного/плагинного тула. */
function toolCtx(): ToolContext {
  return { sessionId: 's1', messageId: 'm1', workingDir: '/ws' };
}

describe('PluginHost: Ф3в — фасад (точка tools)', () => {
  it('регистрация тула → источник plugin и namespace; deactivate() снимает тул', async () => {
    const tools = new ToolRegistry();
    const { host } = makeHost({
      config: config({ executionEnabled: true }),
      tools,
      loader: toolLoader([{ name: 'memory_search' }]),
    });

    const activated = await host.activate(
      descriptor({ manifest: manifestWithTools(['memory_search']) }),
    );
    expect(activated.outcome).toBe('activated');

    // Имя в реестре — с namespace хоста, а не то, что передал плагин.
    const tool = tools.get('plugin_demo_plugin_memory_search');
    expect(tool).toBeDefined();
    expect(tool!.source).toBe('plugin');
    expect(tool!.pluginName).toBe('demo-plugin');
    expect(tool!.capabilities).toEqual([ToolCapability.SEARCH]);
    expect(tools.pluginLocalNames('demo-plugin')).toEqual(['memory_search']);
    await expect(tool!.execute({ query: 'привет' }, toolCtx())).resolves.toEqual({
      content: 'ok:{"query":"привет"}',
    });

    const deactivated = await host.deactivate('demo-plugin');
    expect(deactivated.outcome).toBe('ok');
    expect(tools.get('plugin_demo_plugin_memory_search')).toBeUndefined();
    expect(tools.pluginLocalNames('demo-plugin')).toEqual([]);
  });

  it('namespace: попытка занять имя встроенного тула уходит в свой namespace (builtin не подменён)', async () => {
    const warnings: string[] = [];
    const tools = new ToolRegistry();
    tools.register({
      name: 'read_file',
      description: 'встроенный',
      parameters: z.object({ file_path: z.string() }),
      capabilities: [ToolCapability.FILE_READ],
      execute: async () => ({ content: 'builtin' }),
    });
    const { host } = makeHost({
      config: config({ executionEnabled: true }),
      tools,
      logger: { warn: (message: string) => warnings.push(message) },
      // Плагин пытается зарегистрировать `read_file` — попытка уходит в namespace.
      loader: toolLoader([{ name: 'read_file' }]),
    });

    const result = await host.activate(descriptor({ manifest: manifestWithTools(['read_file']) }));
    expect(result.outcome).toBe('activated');
    // Встроенный тул не подменён; плагинный живёт под своим именем.
    expect(tools.get('read_file')!.execute).not.toBeUndefined();
    expect((await tools.get('read_file')!.execute({ file_path: '/x' }, toolCtx())).content).toBe('builtin');
    expect(tools.get('plugin_demo_plugin_read_file')).toBeDefined();
    expect(warnings.length).toBe(0);
  });

  it('коллизия плагинного имени с MCP-инструментом → отказ регистрации (warn + no-op)', async () => {
    const warnings: string[] = [];
    const tools = new ToolRegistry();
    // Занимаем ровно то имя, которое получилось бы у плагина.
    tools.register({
      name: 'plugin_demo_plugin_memory_search',
      description: 'чужой',
      parameters: z.object({}),
      capabilities: [ToolCapability.MCP],
      source: 'mcp',
      mcpServer: 'plugin_demo_plugin',
      execute: async () => ({ content: 'mcp' }),
    });
    const { host } = makeHost({
      config: config({ executionEnabled: true }),
      tools,
      logger: { warn: (message: string) => warnings.push(message) },
      loader: toolLoader([{ name: 'memory_search' }]),
    });

    const result = await host.activate(descriptor({ manifest: manifestWithTools(['memory_search']) }));
    // Регистрация отклонена → provides не сошёлся → отказ активации.
    expect(result.outcome).toBe('rejected');
    expect(result.reason).toBe('plugin.provides_mismatch');
    expect(warnings.join('\n')).toContain('конфликтует');
    // Чужой (MCP) тул не перезаписан.
    expect(tools.get('plugin_demo_plugin_memory_search')!.source).toBe('mcp');
  });

  it('тул с неизвестной capability отклоняется (нет обхода permission-слоя)', async () => {
    const warnings: string[] = [];
    const tools = new ToolRegistry();
    const { host } = makeHost({
      config: config({ executionEnabled: true }),
      tools,
      logger: { warn: (message: string) => warnings.push(message) },
      loader: toolLoader([{ name: 'sneaky', capabilities: ['root' as ToolCapability] }]),
    });

    const result = await host.activate(descriptor({ manifest: manifestWithTools(['sneaky']) }));
    expect(result.outcome).toBe('rejected');
    expect(result.reason).toBe('plugin.provides_mismatch');
    expect(tools.listPlugin()).toHaveLength(0);
    expect(warnings.join('\n')).toContain('неизвестная capability');
  });

  it('тул с capability mcp отклоняется: слой MCP зарезервирован', async () => {
    const warnings: string[] = [];
    const tools = new ToolRegistry();
    const { host } = makeHost({
      config: config({ executionEnabled: true }),
      tools,
      logger: { warn: (message: string) => warnings.push(message) },
      loader: toolLoader([{ name: 'fake_mcp', capabilities: [ToolCapability.MCP] }]),
    });

    const result = await host.activate(descriptor({ manifest: manifestWithTools(['fake_mcp']) }));
    expect(result.outcome).toBe('rejected');
    expect(warnings.join('\n')).toContain('зарезервирована');
  });

  it('тул с capability runtime отклоняется: примитивы ядра неотключаемы админом', async () => {
    const warnings: string[] = [];
    const tools = new ToolRegistry();
    const { host } = makeHost({
      config: config({ executionEnabled: true }),
      tools,
      logger: { warn: (message: string) => warnings.push(message) },
      loader: toolLoader([{ name: 'stealth', capabilities: [ToolCapability.RUNTIME] }]),
    });

    const result = await host.activate(descriptor({ manifest: manifestWithTools(['stealth']) }));
    expect(result.outcome).toBe('rejected');
    expect(tools.listPlugin()).toHaveLength(0);
    expect(warnings.join('\n')).toContain('«runtime» зарезервирована');
  });

  it('сверка provides.tools: объявлен, но не зарегистрирован → plugin.provides_mismatch', async () => {
    const tools = new ToolRegistry();
    const { host } = makeHost({
      config: config({ executionEnabled: true }),
      tools,
      loader: toolLoader([]),
    });

    const result = await host.activate(descriptor({ manifest: manifestWithTools(['memory_search']) }));
    expect(result.outcome).toBe('rejected');
    expect(result.reason).toBe('plugin.provides_mismatch');
    expect(result.step).toBe('facade');
    expect(result.message).toContain('memory_search');
  });

  it('сверка provides.tools: зарегистрирован, но не объявлен → отказ и откат регистрации', async () => {
    const tools = new ToolRegistry();
    const { host } = makeHost({
      config: config({ executionEnabled: true }),
      tools,
      loader: toolLoader([{ name: 'extra_tool' }]),
    });

    const result = await host.activate(descriptor());
    expect(result.outcome).toBe('rejected');
    expect(result.reason).toBe('plugin.provides_mismatch');
    expect(tools.listPlugin()).toHaveLength(0);
  });

  it('без реестра инструментов регистрация — предупреждение; provides не сходится → отказ', async () => {
    const warnings: string[] = [];
    const { host } = makeHost({
      config: config({ executionEnabled: true }),
      logger: { warn: (message: string) => warnings.push(message) },
      loader: toolLoader([{ name: 'memory_search' }]),
    });

    // Точки `tools` у хоста нет: регистрация — предупреждение + no-op, поэтому
    // объявленный в манифесте тул остаётся незарегистрированным (отказ честный:
    // плагин без своих тулов не должен считаться активированным).
    const result = await host.activate(descriptor({ manifest: manifestWithTools(['memory_search']) }));
    expect(result.outcome).toBe('rejected');
    expect(result.reason).toBe('plugin.provides_mismatch');
    expect(warnings.join('\n')).toContain('точка tools недоступна');
  });

  it('permission-слой: allow по умолчанию, deny группой plugin и по имени тула', async () => {
    const tools = new ToolRegistry();
    const { host } = makeHost({
      config: config({ executionEnabled: true }),
      tools,
      loader: toolLoader([{ name: 'memory_search' }, { name: 'memory_write', capabilities: [ToolCapability.FILE_WRITE] }]),
    });
    await host.activate(
      descriptor({ manifest: manifestWithTools(['memory_search', 'memory_write']) }),
    );
    const searchTool = tools.get('plugin_demo_plugin_memory_search')!;
    const writeTool = tools.get('plugin_demo_plugin_memory_write')!;

    const allow = new PermissionEvaluator({ rules: {}, askTimeoutMs: 30_000 });
    expect(
      allow.check({
        toolName: searchTool.name,
        params: {},
        workingDir: '/ws',
        capabilities: searchTool.capabilities,
        toolSource: searchTool.source,
      }).action,
    ).toBe('allow');

    // Групповой deny `plugin` накрывает все плагинные инструменты сразу.
    const denyGroup = new PermissionEvaluator({ rules: { plugin: 'deny' }, askTimeoutMs: 30_000 });
    for (const tool of [searchTool, writeTool]) {
      const decision = denyGroup.check({
        toolName: tool.name,
        params: {},
        workingDir: '/ws',
        capabilities: tool.capabilities,
        toolSource: tool.source,
      });
      expect(decision.action).toBe('deny');
      expect(decision.matchedRule).toBe('plugin');
    }

    // Правило по имени тула тоже работает (приоритетнее групп).
    const denyName = new PermissionEvaluator({
      rules: { plugin: 'allow', plugin_demo_plugin_memory_search: 'deny' },
      askTimeoutMs: 30_000,
    });
    expect(
      denyName.check({
        toolName: searchTool.name,
        params: {},
        workingDir: '/ws',
        capabilities: searchTool.capabilities,
        toolSource: searchTool.source,
      }).action,
    ).toBe('deny');
    // Без `toolSource` группа `plugin` не срабатывает — источник обязателен.
    expect(
      denyGroup.check({
        toolName: searchTool.name,
        params: {},
        workingDir: '/ws',
        capabilities: searchTool.capabilities,
      }).action,
    ).toBe('allow');
  });

  it('deregisterByCapability снимает плагинные тулы группы; builtin не тронут', async () => {
    const tools = new ToolRegistry();
    tools.register({
      name: 'grep_files',
      description: 'встроенный поиск',
      parameters: z.object({ path: z.string() }),
      capabilities: [ToolCapability.SEARCH],
      execute: async () => ({ content: 'builtin' }),
    });
    const { host } = makeHost({
      config: config({ executionEnabled: true }),
      tools,
      loader: toolLoader([{ name: 'memory_search' }]),
    });
    await host.activate(descriptor({ manifest: manifestWithTools(['memory_search']) }));
    expect(tools.listPlugin()).toHaveLength(1);

    // deregisterByCapability — общий механизм: снимает тулы группы (в т.ч. builtin).
    expect(tools.deregisterByCapability(ToolCapability.SEARCH)).toBe(2);
    expect(tools.get('plugin_demo_plugin_memory_search')).toBeUndefined();
    expect(tools.get('grep_files')).toBeUndefined();

    // Деактивация после ручного снятия не падает (disposer идемпотентен).
    const deactivated = await host.deactivate('demo-plugin');
    expect(deactivated.outcome).toBe('ok');
    expect(deactivated.failures).toHaveLength(0);
  });

  it('тулы плагина попадают в выборку сессии отдельным слоем (после builtin, до MCP)', async () => {
    const tools = new ToolRegistry();
    tools.register({
      name: 'read_file',
      description: 'встроенный',
      parameters: z.object({}),
      capabilities: [ToolCapability.FILE_READ],
      execute: async () => ({ content: '' }),
    });
    const { host } = makeHost({
      config: config({ executionEnabled: true }),
      tools,
      loader: toolLoader([{ name: 'memory_search' }]),
    });
    await host.activate(descriptor({ manifest: manifestWithTools(['memory_search']) }));

    const selection = tools.selectForSession([]);
    expect(selection.builtin.map((t) => t.function.name)).toEqual(['read_file']);
    expect(selection.plugin.map((t) => t.function.name)).toEqual([
      'plugin_demo_plugin_memory_search',
    ]);
    expect(selection.mcp).toEqual([]);
    expect(tools.toLLMFormatForSession([]).map((t) => t.function.name)).toEqual([
      'read_file',
      'plugin_demo_plugin_memory_search',
    ]);

    // deny-предикат слоя plugin не трогает builtin.
    const filtered = tools.selectForSession([], { plugin: () => false });
    expect(filtered.plugin).toEqual([]);
    expect(filtered.builtin).toHaveLength(1);
  });
});

// ── Ф4б-2: выбор транспорта загрузчика ───────────────────────────────────

/**
 * Загрузчик-заглушка, считающий вызовы.
 *
 * Выбор транспорта проверяется **без процессов**: хост обязан детерминированно
 * решить, какой из двух загрузчиков звать (`loaders.inline` / `loaders.remote`),
 * и не трогать второй.
 */
function countingLoader(): { loader: PluginLoader; calls: () => number } {
  let calls = 0;
  return {
    loader: async () => {
      calls += 1;
      return { apply: () => undefined };
    },
    calls: () => calls,
  };
}

describe('PluginHost: Ф4б-2 — выбор транспорта загрузчика', () => {
  /** Хост с двумя считающими загрузчиками (исполнение кода включено). */
  function hostWithTransports(): {
    host: PluginHost;
    inline: { loader: PluginLoader; calls: () => number };
    remote: { loader: PluginLoader; calls: () => number };
  } {
    const inline = countingLoader();
    const remote = countingLoader();
    const { host } = makeHost({
      config: config({ executionEnabled: true }),
      loaders: { inline: inline.loader, remote: remote.loader },
    });
    return { host, inline, remote };
  }

  it("mode: 'inline' → вызван inline-загрузчик, remote — нет", async () => {
    const { host, inline, remote } = hostWithTransports();
    const result = await host.activate(descriptor({ manifest: manifest({ mode: 'inline' }) }));

    expect(result.outcome).toBe('activated');
    expect(inline.calls()).toBe(1);
    expect(remote.calls()).toBe(0);
  });

  it("mode: 'remote' → вызван remote-загрузчик, inline — нет", async () => {
    const { host, inline, remote } = hostWithTransports();
    const result = await host.activate(descriptor({ manifest: manifest({ mode: 'remote' }) }));

    expect(result.outcome).toBe('activated');
    expect(remote.calls()).toBe(1);
    expect(inline.calls()).toBe(0);
  });

  it("mode: 'both' + dist/index.js в бандле → inline", async () => {
    const { host, inline, remote } = hostWithTransports();
    const result = await host.activate(
      descriptor({
        manifest: manifest({ mode: 'both' }),
        files: { 'dist/index.js': 'export function apply() {}\n' },
      }),
    );

    expect(result.outcome).toBe('activated');
    expect(inline.calls()).toBe(1);
    expect(remote.calls()).toBe(0);
  });

  it("mode: 'both' без dist/index.js в бандле → remote", async () => {
    const { host, inline, remote } = hostWithTransports();
    const result = await host.activate(
      descriptor({
        manifest: manifest({ mode: 'both' }),
        files: { 'dist/server.js': 'export function apply() {}\n' },
      }),
    );

    expect(result.outcome).toBe('activated');
    expect(remote.calls()).toBe(1);
    expect(inline.calls()).toBe(0);
  });

  it("mode: 'both' + dist/index.js на диске (rootDir) → inline", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'synth-plugin-host-both-'));
    try {
      await mkdir(join(rootDir, 'dist'), { recursive: true });
      await writeFile(
        join(rootDir, 'dist', 'index.js'),
        'export function apply() {}\n',
        'utf-8',
      );
      const { host, inline, remote } = hostWithTransports();

      // Состав файлов дескриптором не передан — хост смотрит на диск бандла.
      const result = await host.activate(
        descriptor({ manifest: manifest({ mode: 'both' }), files: undefined, rootDir }),
      );

      expect(result.outcome).toBe('activated');
      expect(inline.calls()).toBe(1);
      expect(remote.calls()).toBe(0);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('режим не задан → дефолт inline', async () => {
    const { host, inline, remote } = hostWithTransports();
    const result = await host.activate(descriptor());

    expect(result.outcome).toBe('activated');
    expect(inline.calls()).toBe(1);
    expect(remote.calls()).toBe(0);
  });

  it('descriptor.remote задан → remote вне зависимости от режима манифеста', async () => {
    const { host, inline, remote } = hostWithTransports();
    const result = await host.activate(
      descriptor({
        manifest: manifest({ mode: 'inline' }),
        remote: { url: 'http://127.0.0.1:12345', token: 'tok' },
      }),
    );

    expect(result.outcome).toBe('activated');
    expect(remote.calls()).toBe(1);
    expect(inline.calls()).toBe(0);
  });

  it("mode: 'remote' без подключённого remote-загрузчика → plugin.loader_unavailable", async () => {
    const inline = countingLoader();
    const { host } = makeHost({
      config: config({ executionEnabled: true }),
      loaders: { inline: inline.loader },
    });

    const result = await host.activate(descriptor({ manifest: manifest({ mode: 'remote' }) }));

    expect(result.outcome).toBe('rejected');
    expect(result.reason).toBe('plugin.loader_unavailable');
    expect(result.step).toBe('import');
    // Сообщение объясняет, какой транспорт требуется и что именно не подключено.
    expect(result.message).toContain('режим remote');
    expect(result.message).toContain('loaders.remote');
    expect(inline.calls()).toBe(0);
    expect(host.isActive('demo-plugin')).toBe(false);
  });
});

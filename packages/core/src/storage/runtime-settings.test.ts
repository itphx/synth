import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeSettingsStore, mergeMcpNetworkPolicy, mergeEventsConfig, mergeDecisionConfig, mergePluginsConfig, resolveAttachmentsSettings, createLiveAttachmentsSettings } from './runtime-settings.js';

describe('RuntimeSettingsStore.clear* (ADR-072 Ф2)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-runtime-settings-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  /** Заполняет все runtime-поля, чтобы проверять изоляцию clear* друг от друга. */
  async function seedAll(store: RuntimeSettingsStore): Promise<void> {
    await store.setWorkspace('/ws');
    await store.setMcpSettings({ github: { default: { plan: true, act: true } } });
    await store.setLlmGatewaySettings({ enabled: true, inputMode: 'block' });
    await store.setSecuritySettings({ protectedPaths: { enabled: false }, askTimeoutMs: 1234 });
    await store.setToolsPolicy('consistency');
    await store.setMcpPolicy('available');
    await store.setToolsDisabled({ capabilities: ['web'], tools: ['git_read'] });
    await store.setMcpNetworkPolicy({ mode: 'allow', list: ['example.com'] });
  }

  it('clearWorkspace удаляет только workspace', async () => {
    const store = new RuntimeSettingsStore({ dataDir: tmpDir });
    await seedAll(store);
    await store.clearWorkspace();

    const settings = await store.load();
    expect(settings.workspace).toBeUndefined();
    expect(settings.mcpServers?.github?.default).toEqual({ plan: true, act: true });
    expect(settings.llmGateway?.enabled).toBe(true);
    expect(settings.security?.askTimeoutMs).toBe(1234);
    expect(settings.toolsPolicy).toBe('consistency');
    expect(settings.mcpPolicy).toBe('available');
    expect(settings.toolsDisabled?.tools).toEqual(['git_read']);
    expect(settings.mcpNetworkPolicy?.mode).toBe('allow');
  });

  it('clearMcpSettings удаляет только mcpServers', async () => {
    const store = new RuntimeSettingsStore({ dataDir: tmpDir });
    await seedAll(store);
    await store.clearMcpSettings();

    const settings = await store.load();
    expect(settings.mcpServers).toBeUndefined();
    expect(settings.workspace).toBe('/ws');
    expect(settings.toolsPolicy).toBe('consistency');
  });

  it('clearLlmGatewaySettings удаляет только llmGateway', async () => {
    const store = new RuntimeSettingsStore({ dataDir: tmpDir });
    await seedAll(store);
    await store.clearLlmGatewaySettings();

    const settings = await store.load();
    expect(settings.llmGateway).toBeUndefined();
    expect(settings.workspace).toBe('/ws');
    expect(settings.security?.askTimeoutMs).toBe(1234);
  });

  it('clearSecuritySettings удаляет только security', async () => {
    const store = new RuntimeSettingsStore({ dataDir: tmpDir });
    await seedAll(store);
    await store.clearSecuritySettings();

    const settings = await store.load();
    expect(settings.security).toBeUndefined();
    expect(settings.llmGateway?.enabled).toBe(true);
    expect(settings.workspace).toBe('/ws');
  });

  it('clearToolsPolicy удаляет только toolsPolicy', async () => {
    const store = new RuntimeSettingsStore({ dataDir: tmpDir });
    await seedAll(store);
    await store.clearToolsPolicy();

    const settings = await store.load();
    expect(settings.toolsPolicy).toBeUndefined();
    expect(settings.mcpPolicy).toBe('available');
  });

  it('clearMcpPolicy удаляет только mcpPolicy', async () => {
    const store = new RuntimeSettingsStore({ dataDir: tmpDir });
    await seedAll(store);
    await store.clearMcpPolicy();

    const settings = await store.load();
    expect(settings.mcpPolicy).toBeUndefined();
    expect(settings.toolsPolicy).toBe('consistency');
  });

  it('clearToolsDisabled удаляет только toolsDisabled', async () => {
    const store = new RuntimeSettingsStore({ dataDir: tmpDir });
    await seedAll(store);
    await store.clearToolsDisabled();

    const settings = await store.load();
    expect(settings.toolsDisabled).toBeUndefined();
    expect(settings.mcpNetworkPolicy?.mode).toBe('allow');
  });

  it('clearMcpNetworkPolicy удаляет только mcpNetworkPolicy', async () => {
    const store = new RuntimeSettingsStore({ dataDir: tmpDir });
    await seedAll(store);
    await store.clearMcpNetworkPolicy();

    const settings = await store.load();
    expect(settings.mcpNetworkPolicy).toBeUndefined();
    expect(settings.toolsDisabled?.tools).toEqual(['git_read']);
  });

  it('последовательный сброс всех полей оставляет пустой объект', async () => {
    const store = new RuntimeSettingsStore({ dataDir: tmpDir });
    await seedAll(store);
    await store.clearWorkspace();
    await store.clearMcpSettings();
    await store.clearLlmGatewaySettings();
    await store.clearSecuritySettings();
    await store.clearToolsPolicy();
    await store.clearMcpPolicy();
    await store.clearToolsDisabled();
    await store.clearMcpNetworkPolicy();

    expect(await store.load()).toEqual({});
  });
});

describe('RuntimeSettingsStore.defaultAgent', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-runtime-settings-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('getDefaultAgent возвращает undefined, если не задан', async () => {
    const store = new RuntimeSettingsStore({ dataDir: tmpDir });
    expect(await store.getDefaultAgent()).toBeUndefined();
  });

  it('set/getDefaultAgent сохраняет и читает значение; переживает рестарт', async () => {
    const store = new RuntimeSettingsStore({ dataDir: tmpDir });
    await store.setDefaultAgent('assistant');
    expect(await store.getDefaultAgent()).toBe('assistant');

    const restarted = new RuntimeSettingsStore({ dataDir: tmpDir });
    expect(await restarted.getDefaultAgent()).toBe('assistant');
  });

  it('clearDefaultAgent удаляет только defaultAgent', async () => {
    const store = new RuntimeSettingsStore({ dataDir: tmpDir });
    await store.setDefaultAgent('assistant');
    await store.setToolsPolicy('available');
    await store.clearDefaultAgent();

    const settings = await store.load();
    expect(settings.defaultAgent).toBeUndefined();
    expect(settings.toolsPolicy).toBe('available');
  });
});

describe('RuntimeSettingsStore.defaultModel', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-runtime-settings-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('getDefaultModel возвращает undefined, если не задана', async () => {
    const store = new RuntimeSettingsStore({ dataDir: tmpDir });
    expect(await store.getDefaultModel()).toBeUndefined();
  });

  it('set/getDefaultModel сохраняет пару provider+model; переживает рестарт', async () => {
    const store = new RuntimeSettingsStore({ dataDir: tmpDir });
    await store.setDefaultModel({ provider: 'openai', model: 'gpt-4o' });
    expect(await store.getDefaultModel()).toEqual({ provider: 'openai', model: 'gpt-4o' });

    const restarted = new RuntimeSettingsStore({ dataDir: tmpDir });
    expect(await restarted.getDefaultModel()).toEqual({ provider: 'openai', model: 'gpt-4o' });
  });

  it('clearDefaultModel удаляет только defaultModel', async () => {
    const store = new RuntimeSettingsStore({ dataDir: tmpDir });
    await store.setDefaultModel({ provider: 'ollama', model: 'qwen3:8b' });
    await store.setDefaultAgent('assistant');
    await store.setToolsPolicy('available');
    await store.clearDefaultModel();

    const settings = await store.load();
    expect(settings.defaultModel).toBeUndefined();
    expect(settings.defaultAgent).toBe('assistant');
    expect(settings.toolsPolicy).toBe('available');
  });
});

describe('mergeMcpNetworkPolicy (ADR-071 §2.3.1)', () => {
  const config = { mode: 'deny' as const, list: ['10.0.0.0/8'] };
  const runtime = { mode: 'allow' as const, list: ['192.168.0.0/16'] };

  it('полная runtime-политика приоритетнее config', () => {
    expect(mergeMcpNetworkPolicy(config, runtime)).toEqual({ ...runtime, exceptions: [] });
  });

  it('при отсутствии runtime берётся config', () => {
    expect(mergeMcpNetworkPolicy(config, undefined)).toEqual({ ...config, exceptions: [] });
  });

  it('при отсутствии обоих — undefined (дефолт подставляет вызывающий)', () => {
    expect(mergeMcpNetworkPolicy(undefined, undefined)).toBeUndefined();
  });
});

describe('RuntimeSettingsStore.events (ADR-089)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-runtime-settings-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('getEvents возвращает {} без runtime-настроек', async () => {
    const store = new RuntimeSettingsStore({ dataDir: tmpDir });
    expect(await store.getEvents()).toEqual({});
  });

  it('set/getEvents сохраняет патч, переживает рестарт', async () => {
    const store = new RuntimeSettingsStore({ dataDir: tmpDir });
    await store.setEvents({ enabled: false, journalRetentionDays: 7, keyRateLimitPerMinute: 5 });
    const events = await store.getEvents();
    expect(events.enabled).toBe(false);
    expect(events.journalRetentionDays).toBe(7);
    expect(events.keyRateLimitPerMinute).toBe(5);

    const restarted = new RuntimeSettingsStore({ dataDir: tmpDir });
    expect((await restarted.getEvents()).enabled).toBe(false);
  });

  it('clearEvents удаляет только events', async () => {
    const store = new RuntimeSettingsStore({ dataDir: tmpDir });
    await store.setEvents({ enabled: false });
    await store.setToolsPolicy('available');
    await store.clearEvents();

    const settings = await store.load();
    expect(settings.events).toBeUndefined();
    expect(settings.toolsPolicy).toBe('available');
  });
});

describe('mergeEventsConfig (ADR-089)', () => {
  const base = {
    enabled: false,
    defaultMode: 'ephemeral' as const,
    ephemeralTtl: '1h',
    journalRetentionDays: 5,
    allowedSources: ['telegram'],
    dedupStore: 'file' as const,
    unknownAgentTemplate: 'default-agent' as const,
    keyRateLimitPerMinute: 3,
    decisionRouting: false,
    autoBind: true,
    autoBindAgentTemplate: 'agent-a',
    identityMap: { 'chat:telegram:1': 'u-base' },
  };

  it('runtime поверх base: каждое заданное поле перекрывает base', () => {
    const merged = mergeEventsConfig(base, {
      enabled: true,
      defaultMode: 'bound',
      ephemeralTtl: '24h',
      journalRetentionDays: 30,
      allowedSources: [],
      unknownAgentTemplate: 'drop',
      keyRateLimitPerMinute: 0,
      decisionRouting: true,
      autoBind: false,
      autoBindAgentTemplate: 'agent-b',
      identityMap: { 'tg:2': 'u-runtime' },
    });
    expect(merged).toEqual({
      enabled: true,
      defaultMode: 'bound',
      ephemeralTtl: '24h',
      journalRetentionDays: 30,
      allowedSources: [],
      unknownAgentTemplate: 'drop',
      keyRateLimitPerMinute: 0,
      decisionRouting: true,
      autoBind: false,
      autoBindAgentTemplate: 'agent-b',
      identityMap: { 'tg:2': 'u-runtime' },
    });
  });

  it('при отсутствии runtime берётся base (dedupStore и прочие поля не теряются)', () => {
    expect(mergeEventsConfig(base, {})).toEqual({
      enabled: false,
      defaultMode: 'ephemeral',
      ephemeralTtl: '1h',
      journalRetentionDays: 5,
      allowedSources: ['telegram'],
      unknownAgentTemplate: 'default-agent',
      keyRateLimitPerMinute: 3,
      decisionRouting: false,
      autoBind: true,
      autoBindAgentTemplate: 'agent-a',
      identityMap: { 'chat:telegram:1': 'u-base' },
    });
  });

  it('при отсутствии обоих — дефолты', () => {
    expect(mergeEventsConfig(undefined, {})).toEqual({
      enabled: true,
      defaultMode: 'bound',
      ephemeralTtl: '24h',
      journalRetentionDays: 30,
      allowedSources: [],
      unknownAgentTemplate: 'drop',
      keyRateLimitPerMinute: 0,
      decisionRouting: false,
      autoBind: false,
      autoBindAgentTemplate: '',
      identityMap: {},
    });
  });
});

describe('RuntimeSettingsStore.decision (ADR-084)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-runtime-settings-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('getDecision возвращает {} без runtime-настроек', async () => {
    const store = new RuntimeSettingsStore({ dataDir: tmpDir });
    expect(await store.getDecision()).toEqual({});
  });

  it('set/getDecision сохраняет патч, переживает рестарт', async () => {
    const store = new RuntimeSettingsStore({ dataDir: tmpDir });
    await store.setDecision({ enabled: true, provider: 'routerai-decision', confidenceThreshold: 0.8 });
    const decision = await store.getDecision();
    expect(decision.enabled).toBe(true);
    expect(decision.provider).toBe('routerai-decision');
    expect(decision.confidenceThreshold).toBe(0.8);

    const restarted = new RuntimeSettingsStore({ dataDir: tmpDir });
    expect((await restarted.getDecision()).enabled).toBe(true);
  });

  it('clearDecision удаляет только decision', async () => {
    const store = new RuntimeSettingsStore({ dataDir: tmpDir });
    await store.setDecision({ enabled: true });
    await store.setEvents({ enabled: false });
    await store.clearDecision();

    const settings = await store.load();
    expect(settings.decision).toBeUndefined();
    expect(settings.events).toEqual({ enabled: false });
  });
});

describe('mergeDecisionConfig (ADR-084)', () => {
  const base = {
    enabled: false,
    provider: '',
    model: '',
    confidenceThreshold: 0.6,
    escalationProvider: '',
    escalationModel: '',
  };

  it('runtime поверх base: каждое заданное поле перекрывает base', () => {
    const merged = mergeDecisionConfig(base, {
      enabled: true,
      provider: 'routerai-decision',
      model: 'clef-flash',
      confidenceThreshold: 0.9,
      escalationProvider: 'routerai-decision',
      escalationModel: 'clef',
    });
    expect(merged).toEqual({
      enabled: true,
      provider: 'routerai-decision',
      model: 'clef-flash',
      confidenceThreshold: 0.9,
      escalationProvider: 'routerai-decision',
      escalationModel: 'clef',
    });
  });

  it('при отсутствии runtime берётся base', () => {
    expect(mergeDecisionConfig(base, {})).toEqual(base);
  });

  it('при отсутствии обоих — дефолты схемы', () => {
    expect(mergeDecisionConfig(undefined, {})).toEqual({
      enabled: false,
      provider: '',
      model: '',
      confidenceThreshold: 0.6,
      escalationProvider: '',
      escalationModel: '',
    });
  });
});

describe('RuntimeSettingsStore.plugins (ADR-090)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-runtime-settings-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('getPlugins возвращает {} без runtime-настроек', async () => {
    const store = new RuntimeSettingsStore({ dataDir: tmpDir });
    expect(await store.getPlugins()).toEqual({});
  });

  it('set/getPlugins сохраняет патч и переживает рестарт', async () => {
    const store = new RuntimeSettingsStore({ dataDir: tmpDir });
    await store.setPlugins({
      enabled: false,
      runtimeInstall: 'allow',
      trustFloor: 'verified',
      promptBlockMaxChars: 8000,
    });

    const plugins = await store.getPlugins();
    expect(plugins.enabled).toBe(false);
    expect(plugins.runtimeInstall).toBe('allow');
    expect(plugins.trustFloor).toBe('verified');
    expect(plugins.promptBlockMaxChars).toBe(8000);

    const restarted = new RuntimeSettingsStore({ dataDir: tmpDir });
    expect((await restarted.getPlugins()).promptBlockMaxChars).toBe(8000);
  });

  it('clearPlugins удаляет только plugins', async () => {
    const store = new RuntimeSettingsStore({ dataDir: tmpDir });
    await store.setPlugins({ enabled: false });
    await store.setMetrics({ enabled: true });
    await store.clearPlugins();

    const settings = await store.load();
    expect(settings.plugins).toBeUndefined();
    expect(settings.metrics).toEqual({ enabled: true });
  });
});

describe('mergePluginsConfig (ADR-090)', () => {
  const base = {
    enabled: false,
    runtimeInstall: 'allow' as const,
    trustFloor: 'community' as const,
    scan: 'disabled' as const,
    allowlist: ['a'],
    denylist: ['b'],
    remoteAllowlist: ['c'],
    exactHostExceptions: '/etc/synth/base-hosts.txt',
    promptBlockMaxChars: 1000,
    executionEnabled: false,
    // ADR-090 (Ф3б): бюджет времени фильтра.
    llmFilterTimeoutMs: 1500,
    // ADR-090 (Ф5в): образные бандлы и управляемость.
    deployDir: '/opt/synth/plugins',
    deployTrust: 'trusted' as const,
    managedReadonly: true,
    // ADR-090 (WP-F): провайдер/модель эмбеддингов для `facade.embed`.
    embeddingProvider: 'ollama',
    embeddingModel: 'nomic-embed-text',
    // Ф7: серверная политика плагинов в гибридном режиме.
    hybrid: { mode: 'off' as const, allow: [] },
  };

  it('runtime поверх base: каждое заданное поле перекрывает base', () => {
    expect(
      mergePluginsConfig(base, {
        enabled: true,
        runtimeInstall: 'deny',
        trustFloor: 'builtin',
        scan: 'enabled',
        allowlist: [],
        denylist: [],
        remoteAllowlist: [],
        exactHostExceptions: '/etc/synth/runtime-hosts.txt',
        promptBlockMaxChars: 8000,
        // ADR-090 (WP-F): провайдер/модель эмбеддингов перекрываются runtime.
        embeddingProvider: 'openai',
        embeddingModel: 'text-embedding-3-small',
      }),
    ).toEqual({
      enabled: true,
      runtimeInstall: 'deny',
      trustFloor: 'builtin',
      scan: 'enabled',
      allowlist: [],
      denylist: [],
      remoteAllowlist: [],
      exactHostExceptions: '/etc/synth/runtime-hosts.txt',
      promptBlockMaxChars: 8000,
      executionEnabled: false,
      llmFilterTimeoutMs: 1500,
      // Ф5в: ключи managed deploy-time наследуются из base (не перекрыты runtime).
      deployDir: '/opt/synth/plugins',
      deployTrust: 'trusted',
      managedReadonly: true,
      // ADR-090 (WP-F): провайдер/модель эмбеддингов — из runtime.
      embeddingProvider: 'openai',
      embeddingModel: 'text-embedding-3-small',
      // Ф7: серверная политика плагинов наследуется из base.
      hybrid: { mode: 'off', allow: [] },
    });
  });

  it('частичный runtime: незаданные поля берутся из base', () => {
    expect(mergePluginsConfig(base, { enabled: true, promptBlockMaxChars: 2000 })).toEqual({
      ...base,
      enabled: true,
      promptBlockMaxChars: 2000,
    });
  });

  it('при отсутствии runtime берётся base', () => {
    expect(mergePluginsConfig(base, {})).toEqual(base);
  });

  it('при отсутствии обоих — дефолты схемы', () => {
    expect(mergePluginsConfig(undefined, {})).toEqual({
      enabled: true,
      runtimeInstall: 'deny',
      trustFloor: 'trusted',
      scan: 'enabled',
      allowlist: [],
      denylist: [],
      remoteAllowlist: [],
      exactHostExceptions: '',
      promptBlockMaxChars: 4000,
      executionEnabled: false,
      llmFilterTimeoutMs: 1000,
      // Ф5в: дефолты managed deploy-time из схемы (конвенциональный путь
      // образа; env его перекрывает, config.yaml — тоже).
      deployDir: '/opt/synth/plugins',
      deployTrust: 'trusted',
      managedReadonly: true,
      // ADR-090 (WP-F): дефолты схемы — эмбеддинги не сконфигурированы.
      embeddingProvider: '',
      embeddingModel: '',
      // Ф7: серверная политика плагинов — дефолт схемы (сервер не ограничивает).
      hybrid: { mode: 'off', allow: [] },
    });
  });

  it('executionEnabled: runtime перекрывает config (приоритет runtime > config)', () => {
    // config разрешает исполнение кода, runtime запрещает — побеждает runtime.
    expect(mergePluginsConfig({ ...base, executionEnabled: true }, { executionEnabled: false }))
      .toMatchObject({ executionEnabled: false });
    // config запрещает, runtime разрешает — побеждает runtime.
    expect(mergePluginsConfig(base, { executionEnabled: true })).toMatchObject({
      executionEnabled: true,
    });
    // runtime не задал — берётся значение config.
    expect(mergePluginsConfig({ ...base, executionEnabled: true }, {})).toMatchObject({
      executionEnabled: true,
    });
    // Ни config, ни runtime — дефолт `false` (исполнение кода выключено).
    expect(mergePluginsConfig(undefined, {})).toMatchObject({ executionEnabled: false });
  });

  it('llmFilterTimeoutMs (Ф3б): runtime перекрывает config, иначе дефолт схемы', () => {
    expect(mergePluginsConfig(base, { llmFilterTimeoutMs: 250 })).toMatchObject({
      llmFilterTimeoutMs: 250,
    });
    expect(mergePluginsConfig(base, {})).toMatchObject({ llmFilterTimeoutMs: 1500 });
    expect(mergePluginsConfig(undefined, {})).toMatchObject({ llmFilterTimeoutMs: 1000 });
  });
});

describe('RuntimeSettingsStore.attachments (ADR-115)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-runtime-settings-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('getAttachments возвращает {} без runtime-настроек', async () => {
    const store = new RuntimeSettingsStore({ dataDir: tmpDir });
    expect(await store.getAttachments()).toEqual({});
  });

  it('set/getAttachments сохраняет патч и переживает рестарт', async () => {
    const store = new RuntimeSettingsStore({ dataDir: tmpDir });
    await store.setAttachments({ enabled: false, gcDays: 0, modalities: { video: false } as never });

    const saved = await store.getAttachments();
    expect(saved.enabled).toBe(false);
    expect(saved.gcDays).toBe(0);
    expect(saved.modalities).toEqual({ video: false });

    const restarted = new RuntimeSettingsStore({ dataDir: tmpDir });
    expect((await restarted.getAttachments()).enabled).toBe(false);
  });

  it('clearAttachments удаляет только attachments', async () => {
    const store = new RuntimeSettingsStore({ dataDir: tmpDir });
    await store.setAttachments({ enabled: false });
    await store.setMetrics({ enabled: true });
    await store.clearAttachments();

    const settings = await store.load();
    expect(settings.attachments).toBeUndefined();
    expect(settings.metrics).toEqual({ enabled: true });
  });
});

describe('resolveAttachmentsSettings (ADR-115)', () => {
  it('дефолты схемы, если не задано ничего', () => {
    const resolved = resolveAttachmentsSettings({ env: {} });
    expect(resolved.source).toBe('default');
    expect(resolved.envLocked).toEqual([]);
    expect(resolved.effective).toEqual({
      enabled: true,
      modalities: { image: true, pdf: true, audio: true, video: true },
      maxBytesPerFile: 25 * 1024 * 1024,
      maxFilesPerMessage: 10,
      maxBytesPerSession: 1024 * 1024 * 1024,
      allowedMimePrefixes: ['image/', 'audio/', 'application/pdf', 'text/'],
      workspaceFallback: true,
      gcDays: 30,
    });
  });

  it('config: источник config, вложенные modalities мёржатся с дефолтами', () => {
    const resolved = resolveAttachmentsSettings({
      config: { enabled: false, maxBytesPerFile: 1024, modalities: { video: false } as never },
      env: {},
    });
    expect(resolved.source).toBe('config');
    expect(resolved.effective.enabled).toBe(false);
    expect(resolved.effective.maxBytesPerFile).toBe(1024);
    // Незаданные семейства — из дефолтов схемы.
    expect(resolved.effective.modalities).toEqual({
      image: true,
      pdf: true,
      audio: true,
      video: false,
    });
  });

  it('runtime перекрывает config, незаданные поля остаются из config', () => {
    const resolved = resolveAttachmentsSettings({
      config: { enabled: false, maxFilesPerMessage: 5, modalities: { image: false } as never },
      runtime: { gcDays: 7, modalities: { audio: false } as never },
      env: {},
    });
    expect(resolved.source).toBe('runtime');
    expect(resolved.effective.enabled).toBe(false);
    expect(resolved.effective.maxFilesPerMessage).toBe(5);
    expect(resolved.effective.gcDays).toBe(7);
    // Вложенный merge: выключенное в config семейство остаётся выключенным.
    expect(resolved.effective.modalities).toEqual({
      image: false,
      pdf: true,
      audio: false,
      video: true,
    });
  });

  it('env приоритетнее runtime и config; поля попадают в envLocked', () => {
    const resolved = resolveAttachmentsSettings({
      config: { enabled: true },
      runtime: { enabled: true, gcDays: 7 },
      env: { SYNTH_ATTACHMENTS_ENABLED: 'false', SYNTH_ATTACHMENTS_GC_DAYS: '0' },
    });
    expect(resolved.source).toBe('env');
    expect(resolved.effective.enabled).toBe(false);
    expect(resolved.effective.gcDays).toBe(0);
    expect(resolved.envLocked).toEqual(['enabled', 'gcDays']);
  });

  it('env модульности: csv перечисляет включённые семейства', () => {
    const resolved = resolveAttachmentsSettings({
      env: { SYNTH_ATTACHMENTS_MODALITIES: 'image,pdf' },
    });
    expect(resolved.source).toBe('env');
    expect(resolved.effective.modalities).toEqual({
      image: true,
      pdf: true,
      audio: false,
      video: false,
    });
    expect(resolved.envLocked).toEqual(['modalities']);
  });

  it('невалидные env-значения игнорируются (без блокировки поля)', () => {
    const resolved = resolveAttachmentsSettings({
      config: { gcDays: 5 },
      env: {
        SYNTH_ATTACHMENTS_ENABLED: 'maybe',
        SYNTH_ATTACHMENTS_GC_DAYS: '-1',
        SYNTH_ATTACHMENTS_MODALITIES: 'telepathy',
      },
    });
    expect(resolved.source).toBe('config');
    expect(resolved.effective.enabled).toBe(true);
    expect(resolved.effective.gcDays).toBe(5);
    expect(resolved.envLocked).toEqual([]);
  });

  it('envLocked-поле не перекрывается runtime', () => {
    const resolved = resolveAttachmentsSettings({
      runtime: { enabled: true },
      env: { SYNTH_ATTACHMENTS_ENABLED: 'false' },
    });
    expect(resolved.effective.enabled).toBe(false);
    expect(resolved.envLocked).toEqual(['enabled']);
  });

  it('workspaceFallback из env/config', () => {
    expect(
      resolveAttachmentsSettings({ env: { SYNTH_ATTACHMENTS_WORKSPACE_FALLBACK: '0' } })
        .effective.workspaceFallback,
    ).toBe(false);
    expect(
      resolveAttachmentsSettings({ config: { workspaceFallback: false }, env: {} })
        .effective.workspaceFallback,
    ).toBe(false);
  });
});

describe('createLiveAttachmentsSettings (ADR-115)', () => {
  it('setRuntime применяется к getConfig сразу', () => {
    const live = createLiveAttachmentsSettings({ env: {} });
    expect(live.getConfig().enabled).toBe(true);

    live.setRuntime({ enabled: false, modalities: { video: false } as never });
    expect(live.getConfig().enabled).toBe(false);
    expect(live.getConfig().modalities.video).toBe(false);
    expect(live.resolve().source).toBe('runtime');

    // Сброс runtime — возврат к config/default.
    live.setRuntime({});
    expect(live.getConfig().enabled).toBe(true);
    expect(live.resolve().source).toBe('default');
  });

  it('env приоритетнее runtime и в живом состоянии', () => {
    const live = createLiveAttachmentsSettings({
      env: { SYNTH_ATTACHMENTS_ENABLED: 'false' },
    });
    live.setRuntime({ enabled: true });
    expect(live.getConfig().enabled).toBe(false);
    expect(live.resolve().envLocked).toEqual(['enabled']);
  });
});

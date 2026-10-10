import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeSettingsStore, mergeMcpNetworkPolicy, mergeEventsConfig } from './runtime-settings.js';

describe('RuntimeSettingsStore.clear* (AD-072 Ф2)', () => {
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

describe('mergeMcpNetworkPolicy (AD-071 §2.3.1)', () => {
  const config = { mode: 'deny' as const, list: ['10.0.0.0/8'] };
  const runtime = { mode: 'allow' as const, list: ['192.168.0.0/16'] };

  it('полная runtime-политика приоритетнее config', () => {
    expect(mergeMcpNetworkPolicy(config, runtime)).toEqual(runtime);
  });

  it('при отсутствии runtime берётся config', () => {
    expect(mergeMcpNetworkPolicy(config, undefined)).toEqual(config);
  });

  it('при отсутствии обоих — undefined (дефолт подставляет вызывающий)', () => {
    expect(mergeMcpNetworkPolicy(undefined, undefined)).toBeUndefined();
  });
});

describe('RuntimeSettingsStore.events (AD-089)', () => {
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

describe('mergeEventsConfig (AD-089)', () => {
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
    });
  });
});

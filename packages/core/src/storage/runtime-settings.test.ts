import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeSettingsStore } from './runtime-settings.js';

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

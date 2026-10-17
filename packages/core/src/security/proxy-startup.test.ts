/**
 * ADR-099: стартовое применение runtime-override прокси (второй шаг после TLS).
 * Проверяем, что после «сбора хранилища» dispatcher собран с runtime-политикой,
 * а env `SYNTH_PROXY_*` остаётся выше UI.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as undici from 'undici';
import { MemorySettingsRepository } from '../storage/memory/settings.js';
import { applyStartupProxyConfig } from './proxy-startup.js';
import { getEgressProxyConfig, resetEgressProxyState } from './proxy-state.js';
import { EgressDispatcher } from './proxy-dispatcher.js';
import { _resetTlsTrustForTests } from './tls.js';

afterEach(() => {
  _resetTlsTrustForTests();
  undici.setGlobalDispatcher(new undici.Agent());
});

describe('applyStartupProxyConfig', () => {
  it('применяет runtime-override и собирает EgressDispatcher', async () => {
    const settings = new MemorySettingsRepository();
    await settings.setProxySettings({ url: 'http://ui:8080', noProxy: ['ui.local'], fromEnv: false });

    await applyStartupProxyConfig(
      settings,
      { proxy: { url: 'http://config:3128', fromEnv: false } },
      {},
      { dataDir: '/tmp/synth-proxy-startup-unused' },
    );

    const config = getEgressProxyConfig();
    expect(config).toMatchObject({ enabled: true, url: 'http://ui:8080', source: 'runtime' });
    expect(config?.noProxy).toEqual(['ui.local']);
    expect(undici.getGlobalDispatcher()).toBeInstanceOf(EgressDispatcher);
  });

  it('без runtime — config-уровень', async () => {
    const settings = new MemorySettingsRepository();
    await applyStartupProxyConfig(
      settings,
      { proxy: { url: 'http://config:3128', fromEnv: false } },
      {},
    );
    expect(getEgressProxyConfig()).toMatchObject({ enabled: true, url: 'http://config:3128', source: 'config' });
  });

  it('явный SYNTH_PROXY_URL выше runtime (деплой не переопределяется UI)', async () => {
    const settings = new MemorySettingsRepository();
    await settings.setProxySettings({ url: 'http://ui:8080', fromEnv: false });
    await applyStartupProxyConfig(
      settings,
      { proxy: { url: 'http://config:3128', fromEnv: false } },
      { SYNTH_PROXY_URL: 'http://deploy:3128' },
    );
    expect(getEgressProxyConfig()).toMatchObject({ url: 'http://deploy:3128', source: 'env' });
  });

  it('runtime enabled:false выключает прокси и не требует URL', async () => {
    const settings = new MemorySettingsRepository();
    await settings.setProxySettings({ enabled: false });
    await applyStartupProxyConfig(
      settings,
      { proxy: { url: 'http://config:3128', fromEnv: false } },
      {},
    );
    expect(getEgressProxyConfig()).toMatchObject({ enabled: false, source: 'none' });
    resetEgressProxyState();
    expect(getEgressProxyConfig()).toBeNull();
  });
});

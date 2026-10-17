import { describe, it, expect, afterEach } from 'vitest';
import * as undici from 'undici';
import { initTlsTrust, gitProxyConfig, _resetTlsTrustForTests } from '../security/tls.js';

afterEach(() => {
  _resetTlsTrustForTests();
  undici.setGlobalDispatcher(new undici.Agent());
});

describe('gitProxyConfig (ADR-099 D1)', () => {
  it('прокси выключен → пусто (прежнее поведение git)', async () => {
    await initTlsTrust({ proxy: { enabled: false } }, {});
    expect(gitProxyConfig()).toEqual([]);
  });

  it('прокси включён → `-c http.proxy=<url>`', async () => {
    await initTlsTrust({ proxy: { url: 'http://proxy.corp:3128' } }, {});
    expect(gitProxyConfig()).toEqual(['http.proxy=http://proxy.corp:3128']);
  });

  it('выбор URL: httpsProxy → allProxy → url → httpProxy', async () => {
    await initTlsTrust(
      { proxy: { url: 'http://fallback:3128', httpProxy: 'http://http:3128', httpsProxy: 'http://https:3128' } },
      {},
    );
    expect(gitProxyConfig()).toEqual(['http.proxy=http://https:3128']);

    await initTlsTrust({ proxy: { url: 'http://fallback:3128', httpProxy: 'http://http:3128' } }, {});
    expect(gitProxyConfig()).toEqual(['http.proxy=http://fallback:3128']);
  });

  it('после сброса — пусто', async () => {
    await initTlsTrust({ proxy: { url: 'http://proxy:3128' } }, {});
    _resetTlsTrustForTests();
    expect(gitProxyConfig()).toEqual([]);
  });
});

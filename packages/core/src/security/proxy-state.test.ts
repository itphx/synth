/**
 * ADR-099: состояние egress-прокси — отпечаток конфигурации (restartRequired),
 * маршрут для target и env дочерних процессов (git/MCP).
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  emptyResolvedProxyConfig,
  resolveProxyConfig,
  type ProxyConfig,
  type ResolvedProxyConfig,
} from '@itphx/synth-shared';
import {
  gitProxyEnv,
  mcpProxyEnv,
  proxyConfigFingerprint,
  proxyUrlForTarget,
  resetEgressProxyState,
  setEgressProxyConfig,
  shouldProxyUrl,
} from './proxy-state.js';

afterEach(() => resetEgressProxyState());

const CA_ONE = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----';
const CA_TWO = '-----BEGIN CERTIFICATE-----\nMIIC\n-----END CERTIFICATE-----';

function config(proxy: Partial<ProxyConfig>, env: NodeJS.ProcessEnv = {}): ResolvedProxyConfig {
  return resolveProxyConfig({ proxy }, env);
}

function profiled(mutator: (proxy: Partial<ProxyConfig>) => void): ResolvedProxyConfig {
  const proxy: Partial<ProxyConfig> = {
    mode: 'all',
    fromEnv: false,
    profiles: { default: { url: 'http://proxy.corp:3128' } },
  };
  mutator(proxy);
  return config(proxy);
}

describe('proxyConfigFingerprint', () => {
  it('выключенный прокси и отсутствие инициализации — одинаковый disabled', () => {
    expect(proxyConfigFingerprint(null)).toBe('disabled');
    expect(proxyConfigFingerprint(undefined)).toBe('disabled');
    expect(proxyConfigFingerprint(emptyResolvedProxyConfig())).toBe('disabled');
    expect(proxyConfigFingerprint(config({ url: 'http://p:3128', fromEnv: false, enabled: false }))).toBe(
      'disabled',
    );
  });

  it('меняется при изменении правил и их порядка', () => {
    const base = profiled((proxy) => {
      proxy.rules = [
        { id: 'a', hosts: ['*.a.example'], action: 'direct' },
        { id: 'b', hosts: ['*.b.example'], action: 'proxy', profile: 'default' },
      ];
    });
    const changed = profiled((proxy) => {
      proxy.rules = [
        { id: 'a', hosts: ['*.a.example'], action: 'direct' },
        { id: 'b', hosts: ['*.b.example', '*.c.example'], action: 'proxy', profile: 'default' },
      ];
    });
    const reordered = profiled((proxy) => {
      proxy.rules = [
        { id: 'b', hosts: ['*.b.example'], action: 'proxy', profile: 'default' },
        { id: 'a', hosts: ['*.a.example'], action: 'direct' },
      ];
    });
    expect(proxyConfigFingerprint(base)).not.toBe(proxyConfigFingerprint(changed));
    expect(proxyConfigFingerprint(base)).not.toBe(proxyConfigFingerprint(reordered));
  });

  it('меняется при изменении профиля (URL/label)', () => {
    const base = profiled(() => {});
    const otherUrl = profiled((proxy) => {
      proxy.profiles = { default: { url: 'http://other.corp:3128' } };
    });
    const otherLabel = profiled((proxy) => {
      proxy.profiles = { default: { label: 'Corp', url: 'http://proxy.corp:3128' } };
    });
    expect(proxyConfigFingerprint(base)).not.toBe(proxyConfigFingerprint(otherUrl));
    expect(proxyConfigFingerprint(base)).not.toBe(proxyConfigFingerprint(otherLabel));
  });

  it('меняется при изменении TLS профиля, но сами PEM не раскрываются', () => {
    const one = profiled((proxy) => {
      proxy.profiles = {
        default: { url: 'https://proxy.corp:8443', tls: { caPem: CA_ONE } },
      };
    });
    const two = profiled((proxy) => {
      proxy.profiles = {
        default: { url: 'https://proxy.corp:8443', tls: { caPem: CA_TWO } },
      };
    });
    const noTls = profiled((proxy) => {
      proxy.profiles = { default: { url: 'https://proxy.corp:8443' } };
    });

    const fingerprint = proxyConfigFingerprint(one);
    expect(fingerprint).not.toBe(proxyConfigFingerprint(two));
    expect(fingerprint).not.toBe(proxyConfigFingerprint(noTls));
    expect(fingerprint).not.toContain('BEGIN CERTIFICATE');
    expect(fingerprint).not.toContain(CA_ONE);
  });

  it('меняется при смене пароля профиля (только хеш, пароль не раскрыт)', () => {
    const make = (password: string): ResolvedProxyConfig =>
      config(
        {
          mode: 'all',
          defaultProfile: 'secure',
          fromEnv: false,
          profiles: {
            secure: { url: 'http://proxy.corp:3128', auth: { type: 'basic', username: 'user' } },
          },
        },
        { SYNTH_PROXY_SECURE_PASSWORD: password },
      );
    // Пароли одинаковой длины — сравнение не должно схлопываться.
    const first = proxyConfigFingerprint(make('secret-1'));
    const second = proxyConfigFingerprint(make('secret-2'));
    expect(first).not.toBe(second);
    expect(first).not.toContain('secret-1');
    expect(second).not.toContain('secret-2');
    expect(first).toContain('user');
  });

  it('legacy-default: URL из flat-полей в отпечатке', () => {
    const fingerprint = proxyConfigFingerprint(
      config({ url: 'http://legacy:3128', fromEnv: false }),
    );
    expect(fingerprint).not.toBe('disabled');
    expect(fingerprint).toContain('http://legacy:3128');
    expect(fingerprint).toContain('"mode":"all"');
    expect(fingerprint).toContain('"defaultProfile":"default"');
  });
});

describe('маршрут для target (shared route)', () => {
  it('proxyUrlForTarget/shouldProxyUrl учитывают правила и selected', () => {
    setEgressProxyConfig(
      config({
        mode: 'selected',
        fromEnv: false,
        profiles: { llm: { url: 'http://llm:3128' } },
        rules: [{ hosts: ['api.openai.com'], action: 'proxy', profile: 'llm' }],
      }),
    );
    expect(shouldProxyUrl('https://api.openai.com/v1')).toBe(true);
    expect(proxyUrlForTarget('https://api.openai.com/v1')).toBe('http://llm:3128');
    expect(shouldProxyUrl('https://example.com')).toBe(false);
    expect(proxyUrlForTarget('https://example.com')).toBeUndefined();
  });

  it('noProxy → undefined', () => {
    setEgressProxyConfig(
      config({ url: 'http://p:3128', fromEnv: false, noProxy: ['example.com'] }),
    );
    expect(shouldProxyUrl('https://example.com')).toBe(false);
    expect(proxyUrlForTarget('https://example.com')).toBeUndefined();
    expect(shouldProxyUrl('https://other.test')).toBe(true);
  });
});

describe('gitProxyEnv / mcpProxyEnv (дочерние процессы)', () => {
  it('mode=all: default-профиль, креды в userinfo git-env, no_proxy', () => {
    setEgressProxyConfig(
      config(
        {
          mode: 'all',
          fromEnv: false,
          noProxy: ['127.0.0.1'],
          profiles: {
            default: {
              url: 'http://proxy.corp:3128',
              auth: { type: 'basic', username: 'user' },
            },
          },
        },
        { SYNTH_PROXY_PASSWORD: 'pass' },
      ),
    );
    const git = gitProxyEnv();
    expect(git.http_proxy).toBe('http://user:pass@proxy.corp:3128');
    expect(git.https_proxy).toBe('http://user:pass@proxy.corp:3128');
    expect(git.no_proxy).toBe('127.0.0.1');

    const mcp = mcpProxyEnv();
    expect(mcp.HTTP_PROXY).toBe('http://proxy.corp:3128');
    expect(mcp.HTTPS_PROXY).toBe('http://proxy.corp:3128');
    expect(mcp.NO_PROXY).toBe('127.0.0.1');
    // Пароль не уезжает в MCP-env (там нет userinfo).
    expect(mcp.HTTP_PROXY).not.toContain('pass');
  });

  it('mode=selected: прокси-env не выставляется (per-host маршрут недоступен), no_proxy остаётся', () => {
    setEgressProxyConfig(
      config({
        mode: 'selected',
        fromEnv: false,
        noProxy: ['corp.local'],
        profiles: { llm: { url: 'http://llm:3128' } },
        rules: [{ hosts: ['*.openai.com'], action: 'proxy', profile: 'llm' }],
      }),
    );
    expect(gitProxyEnv()).toEqual({ no_proxy: 'corp.local' });
    expect(mcpProxyEnv()).toEqual({ NO_PROXY: 'corp.local' });
  });

  it('legacy-default (mode=all): URL из flat-полей', () => {
    setEgressProxyConfig(config({ url: 'http://legacy:3128', fromEnv: false }));
    expect(gitProxyEnv()).toMatchObject({
      http_proxy: 'http://legacy:3128',
      https_proxy: 'http://legacy:3128',
      all_proxy: 'http://legacy:3128',
    });
    expect(mcpProxyEnv()).toMatchObject({
      HTTP_PROXY: 'http://legacy:3128',
      HTTPS_PROXY: 'http://legacy:3128',
      ALL_PROXY: 'http://legacy:3128',
    });
  });

  it('прокси выключен → env пустой', () => {
    setEgressProxyConfig(config({ url: 'http://legacy:3128', fromEnv: false, enabled: false }));
    expect(gitProxyEnv()).toEqual({});
    expect(mcpProxyEnv()).toEqual({});
  });
});

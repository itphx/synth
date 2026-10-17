import { describe, it, expect } from 'vitest';
import {
  NoProxyMatcher,
  ProxyConfigError,
  parseProxyUrl,
  proxyStatus,
  proxyUrlFor,
  redactProxyUrl,
  resolveProxyConfig,
  shouldProxyUrl,
} from './proxy.js';

describe('NoProxyMatcher (ADR-099 D1)', () => {
  it('exact host', () => {
    const matcher = new NoProxyMatcher(['example.com']);
    expect(matcher.matches('example.com')).toBe(true);
    expect(matcher.matches('EXAMPLE.com')).toBe(true);
    expect(matcher.matches('example.com.')).toBe(true);
    expect(matcher.matches('api.example.com')).toBe(false);
  });

  it('.suffix — сам домен и поддомены', () => {
    const matcher = new NoProxyMatcher(['.corp.example']);
    expect(matcher.matches('corp.example')).toBe(true);
    expect(matcher.matches('a.corp.example')).toBe(true);
    expect(matcher.matches('notcorp.example')).toBe(false);
  });

  it('*.suffix — только поддомены', () => {
    const matcher = new NoProxyMatcher(['*.corp.example']);
    expect(matcher.matches('a.corp.example')).toBe(true);
    expect(matcher.matches('corp.example')).toBe(false);
  });

  it('host:port — только точный порт', () => {
    const matcher = new NoProxyMatcher(['example.com:8443']);
    expect(matcher.matches('example.com', 8443)).toBe(true);
    expect(matcher.matches('example.com', 443)).toBe(false);
    expect(matcher.matches('example.com')).toBe(false);
  });

  it('IP-литерал и IPv6 в скобках', () => {
    const ips = new NoProxyMatcher(['127.0.0.1', '[::1]']);
    expect(ips.matches('127.0.0.1')).toBe(true);
    expect(ips.matches('::1')).toBe(true);

    // host:port для IPv6 — только точный порт.
    const withPort = new NoProxyMatcher(['[::1]:8080', '1.2.3.4:80']);
    expect(withPort.matches('::1', 8080)).toBe(true);
    expect(withPort.matches('::1', 443)).toBe(false);
    expect(withPort.matches('1.2.3.4', 80)).toBe(true);
    expect(withPort.matches('1.2.3.4', 443)).toBe(false);
  });

  it('CIDR — только для IP-литералов (DNS не выполняется)', () => {
    const matcher = new NoProxyMatcher(['10.0.0.0/8', 'fe80::/10']);
    expect(matcher.matches('10.1.2.3')).toBe(true);
    expect(matcher.matches('11.0.0.1')).toBe(false);
    expect(matcher.matches('fe80::1')).toBe(true);
    expect(matcher.matches('example.com')).toBe(false);
  });

  it('`*` — всё напрямую', () => {
    const matcher = new NoProxyMatcher(['*']);
    expect(matcher.matches('example.com')).toBe(true);
    expect(matcher.matches('10.0.0.1')).toBe(true);
  });

  it('пустые/невалидные записи игнорируются', () => {
    const matcher = new NoProxyMatcher(['', '   ', 'not-a/cidr', 'example.com']);
    expect(matcher.matches('example.com')).toBe(true);
    expect(matcher.matches('other.com')).toBe(false);
  });
});

describe('parseProxyUrl (fail-closed)', () => {
  it('нормализует http/https, сохраняет порт по умолчанию', () => {
    expect(parseProxyUrl('http://proxy.corp:3128').href).toBe('http://proxy.corp:3128');
    expect(parseProxyUrl('https://proxy.corp').href).toBe('https://proxy.corp');
    expect(parseProxyUrl('http://proxy.corp:3128/some/path').href).toBe('http://proxy.corp:3128');
  });

  it('SOCKS5 — этап D2 (ошибка)', () => {
    expect(() => parseProxyUrl('socks5://proxy:1080')).toThrow(ProxyConfigError);
  });

  it('userinfo (Basic/NTLM) — этап D2 (ошибка, секрет не эхоится)', () => {
    let message = '';
    try {
      parseProxyUrl('http://user:secret@proxy:3128');
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toMatch(/этап D2/i);
    expect(message).not.toContain('secret');
  });

  it('битый URL/чужая схема — ошибка', () => {
    expect(() => parseProxyUrl('not a url')).toThrow(ProxyConfigError);
    expect(() => parseProxyUrl('ftp://proxy:21')).toThrow(ProxyConfigError);
    expect(() => parseProxyUrl('')).toThrow(ProxyConfigError);
  });
});

describe('resolveProxyConfig (ADR-023: SYNTH > config > env > defaults)', () => {
  it('по умолчанию выключен, поведение не меняется', () => {
    const cfg = resolveProxyConfig(undefined, {});
    expect(cfg.enabled).toBe(false);
    expect(cfg.source).toBe('none');
    expect(cfg.fromEnv).toBe(true);
    expect(cfg.fallbackDirect).toBe(false);
    expect(cfg.connectTimeoutMs).toBe(10_000);
    expect(cfg.noProxy).toEqual([]);
  });

  it('config.url включает прокси (source=config)', () => {
    const cfg = resolveProxyConfig({ proxy: { url: 'http://proxy:3128' } }, {});
    expect(cfg.enabled).toBe(true);
    expect(cfg.source).toBe('config');
    expect(cfg.url).toBe('http://proxy:3128');
  });

  it('SYNTH_PROXY_URL приоритетнее config (source=env)', () => {
    const cfg = resolveProxyConfig(
      { proxy: { url: 'http://config:3128' } },
      { SYNTH_PROXY_URL: 'http://env:3128' },
    );
    expect(cfg.url).toBe('http://env:3128');
    expect(cfg.source).toBe('env');
  });

  it('стандартные env учитываются при fromEnv=true', () => {
    const cfg = resolveProxyConfig({}, { HTTPS_PROXY: 'http://std:3128' });
    expect(cfg.enabled).toBe(true);
    expect(cfg.httpsProxy).toBe('http://std:3128');
    expect(cfg.source).toBe('env');
    expect(shouldProxyUrl(cfg, 'https://example.com')).toBe(true);
    expect(shouldProxyUrl(cfg, 'http://example.com')).toBe(false);
  });

  it('явный enabled:false подавляет стандартные env', () => {
    const cfg = resolveProxyConfig({ proxy: { enabled: false } }, { HTTPS_PROXY: 'http://std:3128' });
    expect(cfg.enabled).toBe(false);
    expect(cfg.source).toBe('none');
  });

  it('fromEnv:false игнорирует стандартные env', () => {
    const cfg = resolveProxyConfig({ proxy: { fromEnv: false } }, { HTTPS_PROXY: 'http://std:3128' });
    expect(cfg.enabled).toBe(false);
  });

  it('enabled=true без URL — fail-closed', () => {
    expect(() => resolveProxyConfig({ proxy: { enabled: true } }, {})).toThrow(ProxyConfigError);
  });

  it('noProxy: SYNTH-список приоритетнее config, стандартный NO_PROXY — фоллбэк', () => {
    expect(
      resolveProxyConfig({ proxy: { url: 'http://p:3128', noProxy: ['a.example'] } }, {
        SYNTH_PROXY_NO_PROXY: 'b.example, .c.example',
      }).noProxy,
    ).toEqual(['b.example', '.c.example']);
    expect(
      resolveProxyConfig({ proxy: { url: 'http://p:3128', noProxy: ['a.example'] } }, {}).noProxy,
    ).toEqual(['a.example']);
    expect(
      resolveProxyConfig({ proxy: { url: 'http://p:3128' } }, { NO_PROXY: 'x.example y.example' }).noProxy,
    ).toEqual(['x.example', 'y.example']);
  });

  it('fallbackDirect/connectTimeoutMs: env > config > default', () => {
    expect(resolveProxyConfig({ proxy: { url: 'http://p:3128', fallbackDirect: true } }, {}).fallbackDirect).toBe(true);
    expect(
      resolveProxyConfig({ proxy: { url: 'http://p:3128', fallbackDirect: true } }, {
        SYNTH_PROXY_FALLBACK_DIRECT: 'false',
      }).fallbackDirect,
    ).toBe(false);
    expect(
      resolveProxyConfig({ proxy: { url: 'http://p:3128', connectTimeoutMs: 500 } }, {}).connectTimeoutMs,
    ).toBe(500);
    expect(
      resolveProxyConfig({ proxy: { url: 'http://p:3128' } }, {
        SYNTH_PROXY_CONNECT_TIMEOUT_MS: '2500',
      }).connectTimeoutMs,
    ).toBe(2500);
  });
});

describe('proxyUrlFor / shouldProxyUrl', () => {
  const cfg = resolveProxyConfig(
    {
      proxy: {
        url: 'http://all-fallback:3128',
        httpProxy: 'http://http:3128',
        httpsProxy: 'http://https:3128',
        allProxy: 'http://all:3128',
        noProxy: ['direct.example', '.corp.example'],
      },
    },
    {},
  );

  it('выбор по схеме цели: httpsProxy/httpProxy → allProxy → url', () => {
    expect(proxyUrlFor(cfg, 'https://example.com')).toBe('http://https:3128');
    expect(proxyUrlFor(cfg, 'http://example.com')).toBe('http://http:3128');
    const onlyAll = { ...cfg, httpProxy: undefined, httpsProxy: undefined };
    expect(proxyUrlFor(onlyAll, 'https://example.com')).toBe('http://all:3128');
    const onlyUrl = { ...cfg, httpProxy: undefined, httpsProxy: undefined, allProxy: undefined };
    expect(proxyUrlFor(onlyUrl, 'http://example.com')).toBe('http://all-fallback:3128');
    expect(proxyUrlFor(cfg, 'ftp://example.com')).toBeUndefined();
  });

  it('noProxy исключает хост (и поддомен suffix)', () => {
    expect(shouldProxyUrl(cfg, 'https://direct.example/x')).toBe(false);
    expect(shouldProxyUrl(cfg, 'https://a.corp.example/x')).toBe(false);
    expect(shouldProxyUrl(cfg, 'https://example.com/x')).toBe(true);
  });

  it('no_proxy=* → всё напрямую', () => {
    const direct = { ...cfg, noProxy: ['*'] };
    expect(shouldProxyUrl(direct, 'https://example.com')).toBe(false);
  });

  it('выключенный прокси → false', () => {
    expect(shouldProxyUrl({ ...cfg, enabled: false }, 'https://example.com')).toBe(false);
  });
});

describe('redactProxyUrl / proxyStatus (секреты не утекают)', () => {
  it('убирает userinfo/query/hash', () => {
    expect(redactProxyUrl('http://user:secret@proxy:3128/path?token=x#y')).toBe('http://proxy:3128');
    expect(redactProxyUrl('not a url')).toBe('');
  });

  it('статус не содержит кред даже если они попали в объект', () => {
    const status = proxyStatus({
      enabled: true,
      source: 'config',
      url: 'http://user:secret@proxy:3128',
      httpProxy: 'http://user:secret@http:3128',
      noProxy: [],
      fromEnv: false,
      fallbackDirect: false,
      connectTimeoutMs: 1000,
    });
    const json = JSON.stringify(status);
    expect(json).not.toContain('secret');
    expect(status.url).toBe('http://proxy:3128');
    expect(status.restartRequired).toBe(true);
  });
});

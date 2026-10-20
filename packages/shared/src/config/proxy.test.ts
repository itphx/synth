import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  NoProxyMatcher,
  PROXY_PASSWORD_ENV,
  ProxyConfigError,
  defaultProxyEntry,
  parseProxyUrl,
  proxyEntryFor,
  proxyStatus,
  proxyUrlFor,
  redactProxyUrl,
  mergeProxyConfig,
  resolveProxyConfig,
  resolveProxyTls,
  shouldProxyUrl,
  validateProxyConfig,
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

  it('SOCKS5/socks5h: порт по умолчанию 1080, userinfo отдельно', () => {
    const plain = parseProxyUrl('socks5://proxy:1080');
    expect(plain.href).toBe('socks5://proxy:1080');
    expect(plain.protocol).toBe('socks5:');
    expect(parseProxyUrl('socks5h://proxy').port).toBe(1080);
    expect(parseProxyUrl('socks5h://proxy').href).toBe('socks5h://proxy');

    const auth = parseProxyUrl('socks5://user:pass@proxy:1080');
    expect(auth.href).toBe('socks5://proxy:1080');
    expect(auth.username).toBe('user');
    expect(auth.password).toBe('pass');
  });

  it('схема socks: (без 5) — ошибка', () => {
    expect(() => parseProxyUrl('socks://proxy:1080')).toThrow(ProxyConfigError);
  });

  it('userinfo извлекается отдельно, href — без кред', () => {
    const parsed = parseProxyUrl('http://user:secret@proxy:3128');
    expect(parsed.href).toBe('http://proxy:3128');
    expect(parsed.username).toBe('user');
    expect(parsed.password).toBe('secret');
  });

  it('пароль без username — ошибка', () => {
    expect(() => parseProxyUrl('http://:secret@proxy:3128')).toThrow(ProxyConfigError);
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
      mode: 'all',
      profiles: {},
      rules: [],
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

describe('proxy.auth / credentials (D2a)', () => {
  it('env-пароль + auth.username → Basic-креды', () => {
    const cfg = resolveProxyConfig(
      { proxy: { url: 'http://proxy:3128', auth: { type: 'basic', username: 'user' }, fromEnv: false } },
      { [PROXY_PASSWORD_ENV]: 'secret' },
    );
    expect(cfg.url).toBe('http://proxy:3128');
    expect(cfg.credentials?.url).toEqual({ username: 'user', password: 'secret' });
  });

  it('userinfo без пароля + env-пароль → креды из URL + env', () => {
    const cfg = resolveProxyConfig(
      { proxy: { url: 'http://user@proxy:3128', fromEnv: false } },
      { [PROXY_PASSWORD_ENV]: 'secret' },
    );
    expect(cfg.url).toBe('http://proxy:3128');
    expect(cfg.credentials?.url).toEqual({ username: 'user', password: 'secret' });
  });

  it('userinfo с паролем имеет приоритет (пароль не нужен)', () => {
    const cfg = resolveProxyConfig(
      { proxy: { url: 'http://user:urlpass@proxy:3128', fromEnv: false } },
      { [PROXY_PASSWORD_ENV]: 'envpass' },
    );
    expect(cfg.credentials?.url).toEqual({ username: 'user', password: 'urlpass' });
  });

  it('username без пароля (нет env/файла) → fail-closed', () => {
    expect(() =>
      resolveProxyConfig(
        { proxy: { url: 'http://user@proxy:3128', fromEnv: false } },
        {},
      ),
    ).toThrow(/не задан пароль/);
  });

  it('auth.type ntlm/negotiate → ошибка (D3/D4)', () => {
    expect(() =>
      resolveProxyConfig(
        { proxy: { url: 'http://proxy:3128', auth: { type: 'ntlm', username: 'u' }, fromEnv: false } },
        {},
      ),
    ).toThrow(/D3\/D4/);
    expect(() =>
      resolveProxyConfig(
        { proxy: { url: 'http://proxy:3128', auth: { type: 'negotiate', username: 'u' }, fromEnv: false } },
        {},
      ),
    ).toThrow(/D3\/D4/);
  });

  it('креды по полям: httpProxy/httpsProxy независимы; proxyEntryFor выбирает по схеме', () => {
    const cfg = resolveProxyConfig(
      {
        proxy: {
          httpProxy: 'http://user:http@http-proxy:3128',
          httpsProxy: 'http://user:https@https-proxy:3128',
          fromEnv: false,
        },
      },
      {},
    );
    expect(cfg.credentials?.httpProxy).toEqual({ username: 'user', password: 'http' });
    expect(cfg.credentials?.httpsProxy).toEqual({ username: 'user', password: 'https' });
    expect(proxyEntryFor(cfg, 'https://example.com')).toEqual({
      url: 'http://https-proxy:3128',
      credentials: { username: 'user', password: 'https' },
    });
    expect(proxyEntryFor(cfg, 'http://example.com')).toEqual({
      url: 'http://http-proxy:3128',
      credentials: { username: 'user', password: 'http' },
    });
    expect(defaultProxyEntry(cfg)?.url).toBe('http://https-proxy:3128');
  });
});

describe('proxy.tls (D2a)', () => {
  const fixture = (name: string): string =>
    new URL(`../../../core/src/security/__fixtures__/${name}`, import.meta.url).pathname;

  it('caPem/cert/key/rejectUnauthorized', () => {
    const caPem = readFileSync(fixture('tls-test-proxy.pem'), 'utf8');
    const cert = readFileSync(fixture('tls-test-proxy-client.pem'), 'utf8');
    const key = readFileSync(fixture('tls-test-proxy-client.key'), 'utf8');
    const cfg = resolveProxyConfig(
      {
        proxy: {
          url: 'https://proxy:3128',
          tls: {
            caPem,
            certFile: fixture('tls-test-proxy-client.pem'),
            keyFile: fixture('tls-test-proxy-client.key'),
            rejectUnauthorized: false,
          },
          fromEnv: false,
        },
      },
      {},
    );
    expect(cfg.tls?.ca).toBe(caPem);
    expect(cfg.tls?.rejectUnauthorized).toBe(false);
    expect(cfg.tls?.cert).toBe(cert);
    expect(cfg.tls?.key).toBe(key);
  });

  it('caFile ↔ caPem взаимоисключающие', () => {
    expect(() =>
      resolveProxyTls(
        { proxy: { tls: { caFile: fixture('tls-test-proxy.pem'), caPem: 'x' } } },
        {},
      ),
    ).toThrow(/взаимоисключащи/);
  });

  it('certFile без keyFile → ошибка; нечитаемый/не-PEM файл → fail-closed', () => {
    expect(() =>
      resolveProxyTls({ proxy: { tls: { certFile: fixture('tls-test-proxy.pem') } } }, {}),
    ).toThrow(/certFile, и keyFile/);
    expect(() =>
      resolveProxyTls({ proxy: { tls: { caFile: '/no/such/proxy-ca.pem' } } }, {}),
    ).toThrow(/proxy\.tls\.caFile/);
    expect(() =>
      resolveProxyTls({ proxy: { tls: { caFile: fixture('tls-test-proxy.key') } } }, {}),
    ).toThrow(/не содержит PEM/);
  });

  it('env SYNTH_PROXY_TLS_* имеет приоритет', () => {
    const tls = resolveProxyTls(
      { proxy: { tls: { rejectUnauthorized: true } } },
      { SYNTH_PROXY_TLS_REJECT_UNAUTHORIZED: 'false' },
    );
    expect(tls.rejectUnauthorized).toBe(false);
  });
});

describe('redaction resolved-конфига (D2a)', () => {
  it('userinfo вырезан из URL/статуса, креды только в credentials', () => {
    const cfg = resolveProxyConfig(
      { proxy: { url: 'http://user:super-secret@proxy.corp:3128', fromEnv: false } },
      {},
    );
    expect(cfg.url).toBe('http://proxy.corp:3128');
    expect(cfg.credentials?.url).toEqual({ username: 'user', password: 'super-secret' });
    const status = proxyStatus(cfg);
    expect(status.url).toBe('http://proxy.corp:3128');
    expect(JSON.stringify(status)).not.toContain('super-secret');
    expect(JSON.stringify(status)).not.toContain('user:');
  });
});

describe('SOCKS5-конфиг (D2b)', () => {
  it('userinfo/auth → username/password для SOCKS5', () => {
    const cfg = resolveProxyConfig(
      { proxy: { url: 'socks5://user:urlpass@proxy:1080', fromEnv: false } },
      {},
    );
    expect(cfg.url).toBe('socks5://proxy:1080');
    expect(cfg.credentials?.url).toEqual({ username: 'user', password: 'urlpass' });

    const authCfg = resolveProxyConfig(
      {
        proxy: {
          url: 'socks5h://proxy:1080',
          auth: { type: 'basic', username: 'user' },
          fromEnv: false,
        },
      },
      { [PROXY_PASSWORD_ENV]: 'envpass' },
    );
    expect(authCfg.credentials?.url).toEqual({ username: 'user', password: 'envpass' });
  });

  it('proxy.tls вместе с socks5 → ошибка конфигурации', () => {
    expect(() =>
      resolveProxyConfig(
        {
          proxy: {
            url: 'socks5://proxy:1080',
            tls: { caPem: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----' },
            fromEnv: false,
          },
        },
        {},
      ),
    ).toThrow(/несовместим с socks5/);
  });

  it('redaction SOCKS-URL: protocol//host, без userinfo (не "null")', () => {
    expect(redactProxyUrl('socks5h://user:secret@proxy:1080/path')).toBe('socks5h://proxy:1080');
    const cfg = resolveProxyConfig(
      { proxy: { url: 'socks5://user:secret@proxy:1080', fromEnv: false } },
      {},
    );
    expect(proxyStatus(cfg).url).toBe('socks5://proxy:1080');
    expect(JSON.stringify(proxyStatus(cfg))).not.toContain('secret');
  });
});

describe('runtime-override (ADR-099: settings/UI)', () => {
  it('runtime > config: URL и noProxy берутся из runtime, source=runtime', () => {
    const cfg = resolveProxyConfig(
      { proxy: { url: 'http://config:3128', noProxy: ['config.local'], fromEnv: false } },
      {},
      { runtime: { url: 'http://ui:8080', noProxy: ['ui.local'] } },
    );
    expect(cfg.url).toBe('http://ui:8080');
    expect(cfg.noProxy).toEqual(['ui.local']);
    expect(cfg.source).toBe('runtime');
  });

  it('env > runtime: явный SYNTH_PROXY_URL перекрывает UI', () => {
    const cfg = resolveProxyConfig(
      { proxy: { url: 'http://config:3128', fromEnv: false } },
      { SYNTH_PROXY_URL: 'http://deploy:3128' },
      { runtime: { url: 'http://ui:8080' } },
    );
    expect(cfg.url).toBe('http://deploy:3128');
    expect(cfg.source).toBe('env');
  });

  it('runtime enabled:false подавляет config URL и стандартные env', () => {
    const cfg = resolveProxyConfig(
      { proxy: { url: 'http://config:3128' } },
      { HTTPS_PROXY: 'http://std:3128' },
      { runtime: { enabled: false } },
    );
    expect(cfg.enabled).toBe(false);
    expect(cfg.source).toBe('none');
    expect(shouldProxyUrl(cfg, 'https://example.com')).toBe(false);
  });

  it('runtime fromEnv:false игнорирует стандартные env', () => {
    const cfg = resolveProxyConfig(
      {},
      { HTTPS_PROXY: 'http://std:3128' },
      { runtime: { fromEnv: false } },
    );
    expect(cfg.enabled).toBe(false);
  });

  it('креды не требуются, если прокси выключен (enabled:false)', () => {
    const cfg = resolveProxyConfig(
      {
        proxy: {
          enabled: false,
          url: 'http://user@proxy:3128',
          fromEnv: false,
        },
      },
      {},
    );
    expect(cfg.enabled).toBe(false);
    expect(cfg.credentials).toBeUndefined();
  });

  it('mergeProxyConfig: вложенные tls/auth мёржатся по полям', () => {
    const merged = mergeProxyConfig(
      { url: 'http://config:3128', tls: { caFile: '/ca.pem', rejectUnauthorized: true } },
      { tls: { rejectUnauthorized: false } },
    );
    expect(merged.url).toBe('http://config:3128');
    expect(merged.tls).toEqual({ caFile: '/ca.pem', rejectUnauthorized: false });
  });
});

describe('validateProxyConfig (сохранение runtime-override)', () => {
  it('возвращает нормализованную схему (defaults)', () => {
    const config = validateProxyConfig({ url: 'http://proxy:3128' }, {});
    expect(config.url).toBe('http://proxy:3128');
    expect(config.noProxy).toEqual([]);
    expect(config.fromEnv).toBe(true);
    expect(config.fallbackDirect).toBe(false);
    expect(config.connectTimeoutMs).toBe(10_000);
  });

  it('bad URL / socks: / ftp / ntlm → понятная ошибка', () => {
    expect(() => validateProxyConfig({ url: 'not-a-url' }, {})).toThrow(/некорректный URL/);
    expect(() => validateProxyConfig({ url: 'socks://proxy:1080' }, {})).toThrow(/socks:/);
    expect(() => validateProxyConfig({ url: 'ftp://proxy:21' }, {})).toThrow(/не поддерживается/);
    expect(() =>
      validateProxyConfig({ url: 'http://proxy:3128', auth: { type: 'ntlm', username: 'u' } }, {}),
    ).toThrow(/не поддерживается/);
  });

  it('пароль в userinfo запрещён (инвариант 13)', () => {
    expect(() => validateProxyConfig({ url: 'http://user:pass@proxy:3128' }, {})).toThrow(
      /пароль в URL не хранится/,
    );
  });

  it('пароль в теле запроса (auth.password) запрещён (инвариант 13)', () => {
    // top-level: пароль прокси — только env/файл, поле не принимается.
    expect(() =>
      validateProxyConfig(
        { url: 'http://proxy:3128', auth: { type: 'basic', username: 'user', password: 'p' } },
        { [PROXY_PASSWORD_ENV]: 'pass' },
      ),
    ).toThrow(/пароль не хранится в настройках/);
    // профиль: подсказка указывает на env/файл именно этого профиля.
    expect(() =>
      validateProxyConfig(
        {
          mode: 'all',
          defaultProfile: 'corp',
          profiles: {
            corp: { url: 'http://proxy:3128', auth: { type: 'basic', username: 'u', password: 'p' } },
          },
        },
        { SYNTH_PROXY_CORP_PASSWORD: 'pass' },
      ),
    ).toThrow(/SYNTH_PROXY_CORP_PASSWORD/);
  });

  it('auth.password: значение не попадает в текст ошибки', () => {
    try {
      validateProxyConfig(
        { url: 'http://proxy:3128', auth: { type: 'basic', username: 'user', password: 'top-secret' } },
        { [PROXY_PASSWORD_ENV]: 'pass' },
      );
      throw new Error('expected');
    } catch (err) {
      expect(err).toBeInstanceOf(ProxyConfigError);
      expect((err as Error).message).not.toContain('top-secret');
    }
  });

  it('username без пароля (нет env/файла) → ошибка; с env → ok', () => {
    const input = {
      url: 'http://proxy:3128',
      auth: { type: 'basic' as const, username: 'user' },
      fromEnv: false,
    };
    expect(() => validateProxyConfig(input, {})).toThrow(/не задан пароль/);
    expect(() => validateProxyConfig(input, { [PROXY_PASSWORD_ENV]: 'pass' })).not.toThrow();
  });

  it('tls: caFile ↔ caPem взаимоисключащи, cert/key только вместе', () => {
    expect(() =>
      validateProxyConfig(
        { url: 'http://proxy:3128', tls: { caFile: '/a.pem', caPem: 'PEM' }, fromEnv: false },
        {},
      ),
    ).toThrow(/взаимоисключащи/);
    expect(() =>
      validateProxyConfig(
        { url: 'http://proxy:3128', tls: { certFile: '/c.pem' }, fromEnv: false },
        {},
      ),
    ).toThrow(/certFile.*keyFile|и certFile, и keyFile/);
  });

  it('SYNTH_PROXY_* не маскируют невалидный сохраняемый объект', () => {
    expect(() =>
      validateProxyConfig({ url: 'not-a-url' }, { SYNTH_PROXY_URL: 'http://env:3128' }),
    ).toThrow(/некорректный URL/);
  });

  it('ProxyConfigError-код', () => {
    try {
      validateProxyConfig({ url: 'not-a-url' }, {});
      throw new Error('expected');
    } catch (err) {
      expect(err).toBeInstanceOf(ProxyConfigError);
      expect((err as ProxyConfigError).code).toBe('EGRESS_PROXY_CONFIG_INVALID');
    }
  });
});

describe('proxyStatus: поля для предзаполнения UI (redacted)', () => {
  const CA_PEM = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----';

  it('fromEnv/auth.username/tls-флаги есть, caPem и пароль — нет', () => {
    const cfg = resolveProxyConfig(
      {
        proxy: {
          url: 'http://user@proxy:3128',
          fromEnv: false,
          fallbackDirect: true,
          connectTimeoutMs: 1234,
          auth: { type: 'basic', username: 'user' },
          tls: { caPem: CA_PEM, rejectUnauthorized: false },
        },
      },
      { [PROXY_PASSWORD_ENV]: 'super-secret' },
    );
    const status = proxyStatus(cfg);
    expect(status).toMatchObject({
      enabled: true,
      url: 'http://proxy:3128',
      fromEnv: false,
      fallbackDirect: true,
      connectTimeoutMs: 1234,
      auth: { type: 'basic', username: 'user' },
      tls: {
        hasCaPem: true,
        rejectUnauthorized: false,
      },
    });
    const json = JSON.stringify(status);
    expect(json).not.toContain('MIIB');
    expect(json).not.toContain('BEGIN CERTIFICATE');
    expect(json).not.toContain('super-secret');
    expect(json).not.toContain('user:');
    expect(json).not.toContain('caPem');
  });

  it('tls отсутствует, если TLS к прокси не настроен', () => {
    const status = proxyStatus(
      resolveProxyConfig({ proxy: { url: 'http://proxy:3128', fromEnv: false } }, {}),
    );
    expect(status.tls).toBeUndefined();
    expect(status.auth).toBeUndefined();
    expect(status.fromEnv).toBe(false);
  });

  it('caFile/certFile/keyFile отдаются путями, hasCaPem=false', () => {
    const fixtures = fileURLToPath(new URL('../../../core/src/security/__fixtures__/', import.meta.url));
    const caFile = `${fixtures}tls-test-selfsigned.pem`;
    const certFile = `${fixtures}tls-test-proxy-client.pem`;
    const keyFile = `${fixtures}tls-test-proxy-client.key`;
    const cfg = resolveProxyConfig(
      { proxy: { url: 'http://proxy:3128', fromEnv: false, tls: { caFile, certFile, keyFile } } },
      {},
    );
    const status = proxyStatus(cfg);
    expect(status.tls).toMatchObject({ hasCaPem: false, caFile, certFile, keyFile });
    expect(JSON.stringify(status)).not.toContain('BEGIN CERTIFICATE');
  });
});

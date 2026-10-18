import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ProxyConfigError,
  defaultProxyEntry,
  emptyResolvedProxyConfig,
  mergeProxyConfig,
  proxyEntryFor,
  proxyProfilePasswordEnv,
  proxyProfilePasswordPath,
  proxyStatus,
  proxyUrlFor,
  resolveProxyConfig,
  resolveProxyRoute,
  shouldProxyUrl,
  validateProxyConfig,
  validateProxyHostPatterns,
} from './proxy.js';
import type { ProxyConfig } from './types.js';
import type { ResolvedProxyConfig } from './proxy.js';

const CA_PEM = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----';
const CLIENT_CERT = '-----BEGIN CERTIFICATE-----\nMIIC\n-----END CERTIFICATE-----';
const CLIENT_KEY = '-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'synth-proxy-profiles-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Конфиг с профилями в режиме `all` (default) и правилом на llm. */
function profilesConfig() {
  return {
    proxy: {
      mode: 'all' as const,
      fromEnv: false,
      profiles: {
        default: { label: 'Corporate', url: 'http://proxy.corp:3128' },
        llm: { label: 'LLM egress', url: 'https://llm-proxy:8443' },
      },
      rules: [
        { id: 'r_openai', label: 'OpenAI', hosts: ['api.openai.com', '*.openai.com'], action: 'proxy' as const, profile: 'llm' },
        { hosts: ['*.corp.local', '10.0.0.0/8'], action: 'direct' as const },
      ],
    },
  };
}

describe('legacy ↔ профили (совместимость)', () => {
  it('без profiles/rules — синтетический default и прежний выбор поля по схеме', () => {
    const cfg = resolveProxyConfig(
      { proxy: { url: 'http://fallback:3128', httpsProxy: 'http://https:3128', fromEnv: false } },
      {},
    );
    expect(cfg.mode).toBe('all');
    expect(cfg.defaultProfile).toBe('default');
    expect(cfg.profiles.default).toMatchObject({
      name: 'default',
      legacy: true,
      source: 'config',
      url: 'http://fallback:3128',
      httpsProxy: 'http://https:3128',
    });
    expect(cfg.rules).toEqual([]);
    // Flat-поля сохранены для backcompat.
    expect(cfg.url).toBe('http://fallback:3128');
    expect(cfg.httpsProxy).toBe('http://https:3128');
    expect(proxyUrlFor(cfg, 'https://example.com')).toBe('http://https:3128');
    expect(proxyUrlFor(cfg, 'http://example.com')).toBe('http://fallback:3128');
  });

  it('rules без profiles ссылаются только на синтетический default', () => {
    const cfg = resolveProxyConfig(
      {
        proxy: {
          url: 'http://proxy:3128',
          fromEnv: false,
          rules: [{ hosts: ['*.openai.com'], action: 'proxy' }],
        },
      },
      {},
    );
    expect(cfg.rules[0]).toMatchObject({ id: 'rule-1', action: 'proxy', profile: 'default' });
    expect(resolveProxyRoute(cfg, 'https://api.openai.com')).toMatchObject({
      action: 'proxy',
      reason: 'rule',
      profile: 'default',
      proxyUrl: 'http://proxy:3128',
    });
    expect(() =>
      resolveProxyConfig(
        {
          proxy: {
            url: 'http://proxy:3128',
            fromEnv: false,
            rules: [{ hosts: ['*.openai.com'], action: 'proxy', profile: 'llm' }],
          },
        },
        {},
      ),
    ).toThrow(/профиль "llm" не найден/);
  });

  it('profiles + top-level URL/auth/tls — ошибка (два источника)', () => {
    expect(() =>
      resolveProxyConfig(
        { proxy: { url: 'http://proxy:3128', profiles: { default: { url: 'http://p:3128' } } } },
        {},
      ),
    ).toThrow(/top-level url\/httpProxy/);
    expect(() =>
      resolveProxyConfig(
        {
          proxy: {
            profiles: { default: { url: 'http://p:3128' } },
            auth: { type: 'basic', username: 'u' },
          },
        },
        { SYNTH_PROXY_PASSWORD: 'x' },
      ),
    ).toThrow(/proxy.auth запрещён/);
    expect(() =>
      resolveProxyConfig(
        {
          proxy: {
            profiles: { default: { url: 'http://p:3128' } },
            tls: { caPem: CA_PEM },
          },
        },
        {},
      ),
    ).toThrow(/proxy.tls запрещён/);
  });

  it('profiles + env SYNTH_PROXY_URL — ошибка', () => {
    expect(() =>
      resolveProxyConfig({ proxy: { profiles: { default: { url: 'http://p:3128' } } } }, {
        SYNTH_PROXY_URL: 'http://env:3128',
      }),
    ).toThrow(/env SYNTH_PROXY_URL/);
  });
});

describe('режимы и правила', () => {
  it('mode=all: default-профиль для всех, правило переопределяет', () => {
    const cfg = resolveProxyConfig(profilesConfig(), {});
    expect(cfg.mode).toBe('all');
    expect(cfg.defaultProfile).toBe('default');
    expect(resolveProxyRoute(cfg, 'https://example.com')).toMatchObject({
      action: 'proxy',
      reason: 'default',
      profile: 'default',
      proxyUrl: 'http://proxy.corp:3128',
    });
    expect(resolveProxyRoute(cfg, 'https://api.openai.com')).toMatchObject({
      action: 'proxy',
      reason: 'rule',
      profile: 'llm',
      proxyUrl: 'https://llm-proxy:8443',
    });
    expect(resolveProxyRoute(cfg, 'https://a.corp.local').reason).toBe('rule');
    expect(resolveProxyRoute(cfg, 'https://a.corp.local').action).toBe('direct');
  });

  it('mode=selected: только правила, несовпавшие — direct (no-match)', () => {
    const cfg = resolveProxyConfig(
      {
        proxy: {
          mode: 'selected',
          fromEnv: false,
          profiles: { llm: { url: 'https://llm-proxy:8443' } },
          rules: [{ hosts: ['*.openai.com'], action: 'proxy', profile: 'llm' }],
        },
      },
      {},
    );
    expect(resolveProxyRoute(cfg, 'https://api.openai.com')).toMatchObject({
      action: 'proxy',
      reason: 'rule',
      profile: 'llm',
    });
    expect(resolveProxyRoute(cfg, 'https://example.com')).toEqual({
      action: 'direct',
      reason: 'no-match',
    });
  });

  it('defaultProfile задаёт профиль для mode=all и правил без profile', () => {
    const cfg = resolveProxyConfig(
      {
        proxy: {
          mode: 'all',
          defaultProfile: 'corp',
          fromEnv: false,
          profiles: {
            corp: { url: 'http://proxy.corp:3128' },
            llm: { url: 'https://llm-proxy:8443' },
          },
          rules: [{ hosts: ['*.openai.com'], action: 'proxy' }],
        },
      },
      {},
    );
    expect(cfg.defaultProfile).toBe('corp');
    expect(resolveProxyRoute(cfg, 'https://example.com')).toMatchObject({
      action: 'proxy',
      profile: 'corp',
    });
    expect(resolveProxyRoute(cfg, 'https://api.openai.com')).toMatchObject({
      action: 'proxy',
      rule: expect.objectContaining({ id: 'rule-1' }),
      profile: 'corp',
    });
  });

  it('первое совпадение правил; `*` — catch-all', () => {
    const cfg = resolveProxyConfig(
      {
        proxy: {
          mode: 'selected',
          fromEnv: false,
          profiles: { llm: { url: 'http://llm:3128' }, default: { url: 'http://p:3128' } },
          rules: [
            { hosts: ['*.openai.com'], action: 'direct' },
            { hosts: ['*'], action: 'proxy', profile: 'llm' },
          ],
        },
      },
      {},
    );
    expect(resolveProxyRoute(cfg, 'https://api.openai.com')).toMatchObject({
      action: 'direct',
      reason: 'rule',
    });
    expect(resolveProxyRoute(cfg, 'https://anything.example')).toMatchObject({
      action: 'proxy',
      reason: 'rule',
      profile: 'llm',
    });
  });

  it('noProxy всегда выигрывает у правил (direct)', () => {
    const cfg = resolveProxyConfig(
      {
        proxy: {
          mode: 'all',
          fromEnv: false,
          noProxy: ['api.openai.com', '.corp.local'],
          profiles: { default: { url: 'http://p:3128' }, llm: { url: 'http://llm:3128' } },
          rules: [{ hosts: ['*.openai.com', '*.corp.local'], action: 'proxy', profile: 'llm' }],
        },
      },
      {},
    );
    expect(resolveProxyRoute(cfg, 'https://api.openai.com')).toEqual({
      action: 'direct',
      reason: 'no-proxy',
    });
    expect(resolveProxyRoute(cfg, 'https://a.corp.local')).toEqual({
      action: 'direct',
      reason: 'no-proxy',
    });
  });

  it('`*.suffix` — только поддомены, `.suffix` — apex+поддомены', () => {
    const wildcard = resolveProxyConfig(
      {
        proxy: {
          mode: 'selected',
          fromEnv: false,
          profiles: { llm: { url: 'http://llm:3128' } },
          rules: [
            { hosts: ['*.corp.local'], action: 'proxy', profile: 'llm' },
            { hosts: ['*'], action: 'direct' },
          ],
        },
      },
      {},
    );
    expect(resolveProxyRoute(wildcard, 'https://corp.local').action).toBe('direct');
    expect(resolveProxyRoute(wildcard, 'https://a.corp.local').action).toBe('proxy');

    const suffix = resolveProxyConfig(
      {
        proxy: {
          mode: 'selected',
          fromEnv: false,
          profiles: { llm: { url: 'http://llm:3128' } },
          rules: [
            { hosts: ['.corp.local'], action: 'proxy', profile: 'llm' },
            { hosts: ['*'], action: 'direct' },
          ],
        },
      },
      {},
    );
    expect(resolveProxyRoute(suffix, 'https://corp.local').action).toBe('proxy');
    expect(resolveProxyRoute(suffix, 'https://a.corp.local').action).toBe('proxy');
  });

  it('CIDR матчит только IP-литерал (IPv4/IPv6), не hostname', () => {
    const cfg = resolveProxyConfig(
      {
        proxy: {
          mode: 'selected',
          fromEnv: false,
          profiles: { llm: { url: 'http://llm:3128' } },
          rules: [
            { hosts: ['10.0.0.0/8', 'fd00::/8'], action: 'proxy', profile: 'llm' },
          ],
        },
      },
      {},
    );
    expect(resolveProxyRoute(cfg, 'http://10.1.2.3')).toMatchObject({ action: 'proxy', reason: 'rule' });
    expect(resolveProxyRoute(cfg, 'http://[fd00::1]/')).toMatchObject({ action: 'proxy', reason: 'rule' });
    expect(resolveProxyRoute(cfg, 'http://example.com').reason).toBe('no-match');
  });

  it('host:port и IPv6-литерал с портом', () => {
    const cfg = resolveProxyConfig(
      {
        proxy: {
          mode: 'selected',
          fromEnv: false,
          profiles: { llm: { url: 'http://llm:3128' } },
          rules: [
            { hosts: ['example.com:8443', '[::1]:8080'], action: 'proxy', profile: 'llm' },
          ],
        },
      },
      {},
    );
    expect(resolveProxyRoute(cfg, 'https://example.com:8443').action).toBe('proxy');
    expect(resolveProxyRoute(cfg, 'https://example.com').action).toBe('direct');
    expect(resolveProxyRoute(cfg, 'http://[::1]:8080/').action).toBe('proxy');
    expect(resolveProxyRoute(cfg, 'http://[::1]:9090/').action).toBe('direct');
  });

  it('id генерируется как rule-<n>, если не задан', () => {
    const cfg = resolveProxyConfig(
      {
        proxy: {
          mode: 'selected',
          fromEnv: false,
          profiles: { default: { url: 'http://p:3128' } },
          rules: [
            { hosts: ['a.example'], action: 'direct' },
            { id: 'custom', hosts: ['b.example'], action: 'direct' },
            { hosts: ['c.example'], action: 'proxy' },
          ],
        },
      },
      {},
    );
    expect(cfg.rules.map((rule) => rule.id)).toEqual(['rule-1', 'custom', 'rule-3']);
    expect(cfg.rules[2]?.profile).toBe('default');
  });
});

describe('ошибки конфигурации (fail-closed)', () => {
  it('неизвестный профиль в правиле', () => {
    expect(() =>
      resolveProxyConfig(
        {
          proxy: {
            mode: 'selected',
            fromEnv: false,
            profiles: { default: { url: 'http://p:3128' } },
            rules: [{ hosts: ['a.example'], action: 'proxy', profile: 'missing' }],
          },
        },
        {},
      ),
    ).toThrow(/профиль "missing" не найден/);
  });

  it('action=direct + profile', () => {
    expect(() =>
      resolveProxyConfig(
        {
          proxy: {
            mode: 'selected',
            fromEnv: false,
            profiles: { default: { url: 'http://p:3128' } },
            rules: [{ hosts: ['a.example'], action: 'direct', profile: 'default' }],
          },
        },
        {},
      ),
    ).toThrow(/action=direct несовместим с profile/);
  });

  it('пустые hosts (schema) и битые паттерны', () => {
    expect(() =>
      validateProxyConfig(
        {
          mode: 'selected',
          profiles: { default: { url: 'http://p:3128' } },
          rules: [{ hosts: [], action: 'direct' }],
        },
        {},
      ),
    ).toThrow(/hosts/);

    for (const pattern of ['**', 'foo bar', '10.0.0.0/33', 'host:abc', '*.', 'a.*.b', '']) {
      expect(() =>
        validateProxyConfig(
          {
            mode: 'selected',
            profiles: { default: { url: 'http://p:3128' } },
            rules: [{ hosts: [pattern], action: 'direct' }],
          },
          {},
        ),
        pattern,
      ).toThrow(ProxyConfigError);
    }
  });

  it('mode=selected без rules; mode=all без default-профиля', () => {
    expect(() =>
      resolveProxyConfig(
        { proxy: { mode: 'selected', fromEnv: false, profiles: { llm: { url: 'http://l:3128' } } } },
        {},
      ),
    ).toThrow(/mode=selected требует хотя бы одно правило/);

    expect(() =>
      resolveProxyConfig(
        { proxy: { mode: 'all', fromEnv: false, profiles: { llm: { url: 'http://l:3128' } } } },
        {},
      ),
    ).toThrow(/mode=all требует default-профиль/);
  });

  it('defaultProfile ссылается на несуществующий профиль', () => {
    expect(() =>
      resolveProxyConfig(
        {
          proxy: {
            defaultProfile: 'nope',
            fromEnv: false,
            profiles: { default: { url: 'http://p:3128' } },
          },
        },
        {},
      ),
    ).toThrow(/профиль "nope" не найден/);
  });

  it('профиль без URL', () => {
    expect(() =>
      resolveProxyConfig({ proxy: { fromEnv: false, profiles: { llm: { label: 'x' } } } }, {}),
    ).toThrow(/не задан URL/);
  });

  it('повторяющийся id правила', () => {
    expect(() =>
      resolveProxyConfig(
        {
          proxy: {
            mode: 'selected',
            fromEnv: false,
            profiles: { default: { url: 'http://p:3128' } },
            rules: [
              { id: 'dup', hosts: ['a.example'], action: 'direct' },
              { id: 'dup', hosts: ['b.example'], action: 'direct' },
            ],
          },
        },
        {},
      ),
    ).toThrow(/id "dup" повторяется/);
  });

  it('username без пароля — fail-closed; с env/файлом — ok', async () => {
    const config = {
      proxy: {
        fromEnv: false,
        profiles: {
          default: { url: 'http://proxy:3128', auth: { type: 'basic' as const, username: 'synth' } },
        },
      },
    };
    expect(() => resolveProxyConfig(config, {})).toThrow(/не задан пароль/);
    expect(
      resolveProxyConfig(config, { SYNTH_PROXY_PASSWORD: 'legacy-pass' }).profiles.default
        ?.credentials?.url,
    ).toEqual({ username: 'synth', password: 'legacy-pass' });

    const dir = await tempDir();
    await mkdir(join(dir, 'secrets'), { recursive: true });
    await writeFile(join(dir, 'secrets', 'proxy-password'), 'file-pass\n', 'utf-8');
    expect(
      resolveProxyConfig(config, {}, { dataDir: dir }).profiles.default?.credentials?.url,
    ).toEqual({ username: 'synth', password: 'file-pass' });
  });

  it('validateProxyConfig запрещает пароль в userinfo любого профиля', () => {
    expect(() =>
      validateProxyConfig(
        {
          profiles: {
            default: { url: 'http://u:secret@proxy:3128' },
            llm: { url: 'http://u:secret@llm:8443' },
          },
        },
        {},
      ),
    ).toThrow(/proxy\.profiles\.default\.url: пароль в URL не хранится/);
    expect(() =>
      validateProxyConfig(
        {
          profiles: {
            default: { url: 'http://proxy:3128' },
            llm: { url: 'http://u:secret@llm:8443' },
          },
        },
        {},
      ),
    ).toThrow(/proxy\.profiles\.llm\.url: пароль в URL не хранится/);
  });
});

describe('пароли профилей (env/файл)', () => {
  it('хелперы: имя env и путь файла', () => {
    expect(proxyProfilePasswordEnv('default')).toBe('SYNTH_PROXY_PASSWORD');
    expect(proxyProfilePasswordEnv('llm')).toBe('SYNTH_PROXY_LLM_PASSWORD');
    expect(proxyProfilePasswordEnv('llm-egress')).toBe('SYNTH_PROXY_LLM_EGRESS_PASSWORD');
    expect(proxyProfilePasswordPath('/data', 'default')).toBe('/data/secrets/proxy-password');
    expect(proxyProfilePasswordPath('/data', 'llm')).toBe('/data/secrets/proxy/llm.password');
  });

  it('per-profile env > файл; креды не попадают в status', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'secrets', 'proxy'), { recursive: true });
    await writeFile(join(dir, 'secrets', 'proxy', 'llm.password'), 'file-llm', 'utf-8');

    const config = {
      proxy: {
        mode: 'selected' as const,
        fromEnv: false,
        profiles: {
          llm: { url: 'http://llm:8443', auth: { type: 'basic' as const, username: 'synth-llm' } },
        },
        rules: [{ hosts: ['*'], action: 'proxy' as const, profile: 'llm' }],
      },
    };
    const fromFile = resolveProxyConfig(config, {}, { dataDir: dir });
    expect(fromFile.profiles.llm?.credentials?.url).toEqual({
      username: 'synth-llm',
      password: 'file-llm',
    });

    const fromEnv = resolveProxyConfig(
      config,
      { SYNTH_PROXY_LLM_PASSWORD: 'env-llm' },
      { dataDir: dir },
    );
    expect(fromEnv.profiles.llm?.credentials?.url?.password).toBe('env-llm');
    expect(JSON.stringify(proxyStatus(fromEnv))).not.toContain('env-llm');
  });

  it('userinfo профиля: username без пароля → env профиля', () => {
    const cfg = resolveProxyConfig(
      {
        proxy: {
          mode: 'selected',
          fromEnv: false,
          profiles: { llm: { url: 'http://synth-llm@llm:8443' } },
          rules: [{ hosts: ['*'], action: 'proxy', profile: 'llm' }],
        },
      },
      { SYNTH_PROXY_LLM_PASSWORD: 'p' },
    );
    expect(cfg.profiles.llm?.credentials?.url).toEqual({ username: 'synth-llm', password: 'p' });
    expect(cfg.profiles.llm?.url).toBe('http://llm:8443');
  });

  it('выключенный прокси не требует пароля', () => {
    const cfg = resolveProxyConfig(
      {
        proxy: {
          enabled: false,
          fromEnv: false,
          profiles: {
            default: { url: 'http://p:3128', auth: { type: 'basic', username: 'u' } },
          },
        },
      },
      {},
    );
    expect(cfg.enabled).toBe(false);
    expect(cfg.profiles.default?.credentials).toBeUndefined();
  });
});

describe('TLS профиля', () => {
  it('ca/cert/key резолвятся, tlsMeta без PEM; env SYNTH_PROXY_TLS_* не влияет', async () => {
    const dir = await tempDir();
    const caFile = join(dir, 'ca.pem');
    const certFile = join(dir, 'client.pem');
    const keyFile = join(dir, 'client.key');
    await writeFile(caFile, CA_PEM, 'utf-8');
    await writeFile(certFile, CLIENT_CERT, 'utf-8');
    await writeFile(keyFile, CLIENT_KEY, 'utf-8');

    const cfg = resolveProxyConfig(
      {
        proxy: {
          mode: 'selected',
          fromEnv: false,
          profiles: {
            llm: {
              url: 'https://llm:8443',
              tls: { caFile, certFile, keyFile, rejectUnauthorized: true },
            },
          },
          rules: [{ hosts: ['*'], action: 'proxy', profile: 'llm' }],
        },
      },
      { SYNTH_PROXY_TLS_CA_FILE: '/does/not/exist.pem', SYNTH_PROXY_TLS_REJECT_UNAUTHORIZED: 'false' },
    );
    const profile = cfg.profiles.llm!;
    expect(profile.tls?.ca).toContain('BEGIN CERTIFICATE');
    expect(profile.tls?.cert).toContain('BEGIN CERTIFICATE');
    expect(profile.tls?.key).toContain('BEGIN PRIVATE KEY');
    expect(profile.tls?.rejectUnauthorized).toBe(true);
    expect(profile.tlsMeta).toEqual({ hasCaPem: false, caFile, certFile, keyFile });
    // Flat legacy-поля в режиме профилей не заполняются (в т.ч. из env).
    expect(cfg.tls).toBeUndefined();
    expect(cfg.tlsMeta).toBeUndefined();

    const status = proxyStatus(cfg);
    expect(status.profiles.llm?.tls).toMatchObject({ hasCaPem: false, caFile, certFile, keyFile });
    const json = JSON.stringify(status);
    expect(json).not.toContain('BEGIN CERTIFICATE');
    expect(json).not.toContain('BEGIN PRIVATE KEY');
  });

  it('caPem профиля: PEM прочитан, status отдаёт только hasCaPem', () => {
    const cfg = resolveProxyConfig(
      {
        proxy: {
          fromEnv: false,
          profiles: { default: { url: 'https://p:8443', tls: { caPem: CA_PEM } } },
        },
      },
      {},
    );
    expect(cfg.profiles.default?.tls?.ca).toBe(CA_PEM);
    const status = proxyStatus(cfg);
    expect(status.profiles.default?.tls).toMatchObject({ hasCaPem: true });
    expect(JSON.stringify(status)).not.toContain('MIIB');
  });

  it('caFile↔caPem и неполная mTLS-пара в профиле — ошибка', () => {
    expect(() =>
      resolveProxyConfig(
        {
          proxy: {
            fromEnv: false,
            profiles: {
              llm: { url: 'https://l:8443', tls: { caFile: '/a.pem', caPem: CA_PEM } },
            },
          },
        },
        {},
      ),
    ).toThrow(/взаимоисключащи/);
    expect(() =>
      resolveProxyConfig(
        {
          proxy: {
            fromEnv: false,
            profiles: { llm: { url: 'https://l:8443', tls: { certFile: '/c.pem' } } },
          },
        },
        {},
      ),
    ).toThrow(/certFile, и keyFile|и certFile, и keyFile/);
  });
});

describe('runtime-override и env', () => {
  it('runtime заменяет profiles/rules целиком', () => {
    const cfg = resolveProxyConfig(
      {
        proxy: {
          fromEnv: false,
          profiles: { default: { url: 'http://base:3128' } },
          rules: [{ hosts: ['base.example'], action: 'direct' }],
        },
      },
      {},
      {
        runtime: {
          mode: 'selected',
          profiles: { llm: { url: 'https://runtime-llm:8443' } },
          rules: [{ hosts: ['*.openai.com'], action: 'proxy', profile: 'llm' }],
        },
      },
    );
    expect(cfg.source).toBe('runtime');
    expect(Object.keys(cfg.profiles)).toEqual(['llm']);
    expect(cfg.rules).toHaveLength(1);
    expect(cfg.rules[0]?.hosts).toEqual(['*.openai.com']);
  });

  it('env top-level приоритетнее config для legacy', () => {
    const cfg = resolveProxyConfig(
      { proxy: { url: 'http://config:3128', fromEnv: false } },
      { SYNTH_PROXY_URL: 'http://env:3128' },
    );
    expect(cfg.url).toBe('http://env:3128');
    expect(cfg.source).toBe('env');
    expect(cfg.profiles.default?.url).toBe('http://env:3128');
  });
});

describe('runtime: переключение legacy ↔ профили (mergeProxyConfig)', () => {
  it('runtime-профили поверх legacy-конфига: top-level URL/auth/tls не подмешиваются', () => {
    const base: { proxy: Partial<ProxyConfig> } = {
      proxy: {
        fromEnv: false,
        url: 'http://legacy:3128',
        auth: { type: 'basic', username: 'legacy-user' },
        tls: { caPem: CA_PEM },
      },
    };
    const runtime: Partial<ProxyConfig> = {
      profiles: { default: { url: 'http://ui-proxy:3128' } },
    };

    const merged = mergeProxyConfig(base.proxy, runtime);
    expect(merged.profiles).toEqual(runtime.profiles);
    expect(merged.url).toBeUndefined();
    expect(merged.httpProxy).toBeUndefined();
    expect(merged.httpsProxy).toBeUndefined();
    expect(merged.allProxy).toBeUndefined();
    expect(merged.auth).toBeUndefined();
    expect(merged.tls).toBeUndefined();

    // API-сценарий: resolveProxyConfig с base-конфигом и runtime (профили из UI).
    const cfg = resolveProxyConfig(base, { SYNTH_PROXY_PASSWORD: 'p' }, { runtime });
    expect(Object.keys(cfg.profiles)).toEqual(['default']);
    expect(cfg.profiles.default).toMatchObject({
      name: 'default',
      legacy: false,
      url: 'http://ui-proxy:3128',
      source: 'runtime',
    });
    expect(cfg.url).toBeUndefined();
    expect(cfg.auth).toBeUndefined();
    expect(cfg.tls).toBeUndefined();
    expect(cfg.tlsMeta).toBeUndefined();
    expect(cfg.source).toBe('runtime');
  });

  it('runtime-профили + явный runtime-top-level оставляет его (валидация — ошибка)', () => {
    expect(() =>
      resolveProxyConfig(
        { proxy: { fromEnv: false, url: 'http://legacy:3128' } },
        {},
        {
          runtime: {
            url: 'http://runtime-legacy:3128',
            profiles: { default: { url: 'http://ui-proxy:3128' } },
          },
        },
      ),
    ).toThrow(/top-level url\/httpProxy/);
  });

  it('base-профили + runtime legacy URL: профили исчезают, legacy резолвится', () => {
    const base: { proxy: Partial<ProxyConfig> } = {
      proxy: {
        fromEnv: false,
        profiles: { default: { url: 'http://base:3128' }, llm: { url: 'http://llm:3128' } },
        rules: [{ hosts: ['*.openai.com'], action: 'proxy', profile: 'llm' }],
      },
    };
    const runtime: Partial<ProxyConfig> = { url: 'http://legacy:3128' };

    const merged = mergeProxyConfig(base.proxy, runtime);
    expect(merged.profiles).toBeUndefined();

    const cfg = resolveProxyConfig(base, {}, { runtime });
    expect(cfg.profiles.default).toMatchObject({ legacy: true, url: 'http://legacy:3128' });
    expect(Object.keys(cfg.profiles)).toEqual(['default']);
    expect(cfg.url).toBe('http://legacy:3128');
    expect(cfg.rules).toEqual([]);
    expect(cfg.source).toBe('runtime');
    expect(resolveProxyRoute(cfg, 'https://example.com')).toMatchObject({
      action: 'proxy',
      reason: 'default',
      profile: 'default',
      proxyUrl: 'http://legacy:3128',
    });
  });

  it('base-профили (mode/defaultProfile/rules) + runtime legacy URL без mode: legacy резолвится', () => {
    const base: { proxy: Partial<ProxyConfig> } = {
      proxy: {
        fromEnv: false,
        mode: 'selected',
        defaultProfile: 'llm',
        profiles: { default: { url: 'http://base:3128' }, llm: { url: 'http://llm:3128' } },
        rules: [{ hosts: ['*.openai.com'], action: 'proxy', profile: 'llm' }],
      },
    };
    const runtime: Partial<ProxyConfig> = { url: 'http://legacy:3128' };
    const merged = mergeProxyConfig(base.proxy, runtime);
    expect(merged.profiles).toBeUndefined();
    expect(merged.rules).toBeUndefined();
    expect(merged.defaultProfile).toBeUndefined();
    expect(merged.mode).toBeUndefined();

    const cfg = resolveProxyConfig(base, {}, { runtime });
    expect(cfg.mode).toBe('all');
    expect(cfg.defaultProfile).toBe('default');
    expect(cfg.rules).toEqual([]);
    expect(cfg.profiles.default).toMatchObject({ legacy: true, url: 'http://legacy:3128' });
  });

  it('base-профили + runtime legacy auth (без URL): профили не тянутся', () => {
    const base: { proxy: Partial<ProxyConfig> } = {
      proxy: { fromEnv: false, profiles: { default: { url: 'http://base:3128' } } },
    };
    const runtime: Partial<ProxyConfig> = { auth: { type: 'basic', username: 'u' } };
    const merged = mergeProxyConfig(base.proxy, runtime);
    expect(merged.profiles).toBeUndefined();
    expect(merged.auth).toEqual({ type: 'basic', username: 'u' });

    // base URL отсутствует → legacy без URL (enabled не форсируется auth).
    const cfg = resolveProxyConfig(base, { SYNTH_PROXY_PASSWORD: 'p' }, { runtime });
    expect(cfg.profiles).toEqual({});
    expect(cfg.enabled).toBe(false);
  });

  it('base-профили + runtime только rules: профили сохраняются', () => {
    const base: { proxy: Partial<ProxyConfig> } = {
      proxy: {
        fromEnv: false,
        profiles: { default: { url: 'http://base:3128' }, llm: { url: 'https://llm:8443' } },
      },
    };
    const runtime: Partial<ProxyConfig> = {
      rules: [{ hosts: ['*.openai.com'], action: 'proxy', profile: 'llm' }],
    };
    const merged = mergeProxyConfig(base.proxy, runtime);
    expect(merged.profiles).toEqual(base.proxy.profiles);

    const cfg = resolveProxyConfig(base, {}, { runtime });
    expect(Object.keys(cfg.profiles).sort()).toEqual(['default', 'llm']);
    expect(cfg.rules).toHaveLength(1);
    expect(cfg.rules[0]).toMatchObject({ hosts: ['*.openai.com'], profile: 'llm' });
  });

  it('base-профили + runtime mode/defaultProfile: профили сохраняются', () => {
    const base: { proxy: Partial<ProxyConfig> } = {
      proxy: { fromEnv: false, profiles: { default: { url: 'http://base:3128' } } },
    };
    const cfg = resolveProxyConfig(base, {}, {
      runtime: { mode: 'all', defaultProfile: 'default' },
    });
    expect(cfg.profiles.default?.legacy).toBe(false);
    expect(cfg.defaultProfile).toBe('default');
  });

  it('legacy-base + runtime legacy URL: правила base сохраняются (профили не исчезали)', () => {
    const merged = mergeProxyConfig(
      { url: 'http://config:3128', rules: [{ hosts: ['*.corp.local'], action: 'direct' }] },
      { url: 'http://runtime:3128' },
    );
    expect(merged.profiles).toBeUndefined();
    expect(merged.rules).toHaveLength(1);
    expect(merged.url).toBe('http://runtime:3128');
  });

  it('validateProxyConfig валидирует только вход (без base) и не ломается', () => {
    // Вход с профилями валиден сам по себе — legacy-конфиг в base не подмешивается.
    expect(validateProxyConfig({ profiles: { default: { url: 'http://p:3128' } } }, {})).toMatchObject({
      profiles: { default: { url: 'http://p:3128' } },
    });
    expect(validateProxyConfig({ url: 'http://proxy:3128' }, {}).url).toBe('http://proxy:3128');
    // Два источника внутри одного входа — по-прежнему ошибка.
    expect(() =>
      validateProxyConfig(
        { url: 'http://proxy:3128', profiles: { default: { url: 'http://p:3128' } } },
        {},
      ),
    ).toThrow(/top-level url\/httpProxy/);
  });
});

describe('resolveProxyRoute: все причины', () => {
  const base = (): ResolvedProxyConfig => emptyResolvedProxyConfig();

  it('disabled', () => {
    expect(resolveProxyRoute(base(), 'https://example.com')).toEqual({
      action: 'direct',
      reason: 'disabled',
    });
  });

  it('no-default (нет default-профиля/URL)', () => {
    const cfg: ResolvedProxyConfig = {
      ...base(),
      enabled: true,
      source: 'config',
      defaultProfile: 'default',
    };
    expect(resolveProxyRoute(cfg, 'https://example.com').reason).toBe('no-default');
    expect(defaultProxyEntry(cfg)).toBeUndefined();
  });

  it('profile без URL нужной схемы → no-default', () => {
    const cfg = resolveProxyConfig(
      {
        proxy: {
          fromEnv: false,
          profiles: { default: { httpProxy: 'http://p:3128' } },
        },
      },
      {},
    );
    expect(resolveProxyRoute(cfg, 'https://example.com')).toEqual({
      action: 'direct',
      reason: 'no-default',
    });
    expect(resolveProxyRoute(cfg, 'http://example.com')).toMatchObject({
      action: 'proxy',
      reason: 'default',
    });
  });
});

describe('proxyEntryFor / shouldProxyUrl / defaultProxyEntry согласованы', () => {
  it('маршрут правила и default дают одинаковые entry/url', () => {
    const cfg = resolveProxyConfig(profilesConfig(), {});
    const ruleOrigin = 'https://api.openai.com/v1/models';
    const defaultOrigin = 'https://example.com/';
    expect(proxyEntryFor(cfg, ruleOrigin)).toEqual({
      url: 'https://llm-proxy:8443',
    });
    expect(proxyUrlFor(cfg, ruleOrigin)).toBe('https://llm-proxy:8443');
    expect(shouldProxyUrl(cfg, ruleOrigin)).toBe(true);
    expect(proxyEntryFor(cfg, defaultOrigin)).toEqual({ url: 'http://proxy.corp:3128' });
    expect(shouldProxyUrl(cfg, defaultOrigin)).toBe(true);
    expect(defaultProxyEntry(cfg)).toEqual({ url: 'http://proxy.corp:3128' });
    expect(resolveProxyRoute(cfg, defaultOrigin)).toMatchObject({
      action: 'proxy',
      reason: 'default',
    });
  });

  it('direct/noProxy: shouldProxyUrl=false, entry=undefined', () => {
    const cfg = resolveProxyConfig(
      { proxy: { ...profilesConfig().proxy, noProxy: ['example.com'] } },
      {},
    );
    expect(shouldProxyUrl(cfg, 'https://example.com')).toBe(false);
    expect(proxyEntryFor(cfg, 'https://example.com')).toBeUndefined();
    expect(proxyUrlFor(cfg, 'https://example.com')).toBeUndefined();
    // defaultProxyEntry — маршрут по умолчанию, noProxy не применяется (check).
    expect(defaultProxyEntry(cfg)).toEqual({ url: 'http://proxy.corp:3128' });
  });

  it('не-HTTP(S)/битый URL — direct', () => {
    const cfg = resolveProxyConfig(profilesConfig(), {});
    expect(shouldProxyUrl(cfg, 'ftp://example.com')).toBe(false);
    expect(shouldProxyUrl(cfg, 'not a url')).toBe(false);
    expect(proxyUrlFor(cfg, 'ftp://example.com')).toBeUndefined();
  });

  it('legacy credentials выбираются по полю; route отдаёт креды', () => {
    const cfg = resolveProxyConfig(
      {
        proxy: {
          url: 'http://user@proxy:3128',
          httpsProxy: 'http://https-user@https-proxy:3128',
          fromEnv: false,
        },
      },
      { SYNTH_PROXY_PASSWORD: 'secret' },
    );
    expect(resolveProxyRoute(cfg, 'https://example.com').credentials).toEqual({
      username: 'https-user',
      password: 'secret',
    });
    expect(proxyEntryFor(cfg, 'https://example.com')).toEqual({
      url: 'http://https-proxy:3128',
      credentials: { username: 'https-user', password: 'secret' },
    });
    expect(proxyEntryFor(cfg, 'http://example.com')).toEqual({
      url: 'http://proxy:3128',
      credentials: { username: 'user', password: 'secret' },
    });
  });
});

describe('proxyStatus: профили и правила (redaction)', () => {
  it('есть mode/defaultProfile/profiles/rules; нет паролей/userinfo/PEM', () => {
    const cfg = resolveProxyConfig(
      {
        proxy: {
          mode: 'all',
          fromEnv: false,
          profiles: {
            default: {
              label: 'Corporate',
              url: 'http://user:urlsecret@proxy.corp:3128',
              auth: { type: 'basic', username: 'user' },
              tls: { caPem: CA_PEM },
            },
            llm: {
              label: 'LLM egress',
              url: 'http://synth-llm@llm-proxy:8443',
              auth: { type: 'basic', username: 'synth-llm' },
            },
          },
          rules: [
            { id: 'r_openai', label: 'OpenAI', hosts: ['*.openai.com'], action: 'proxy', profile: 'llm' },
          ],
        },
      },
      { SYNTH_PROXY_PASSWORD: 'legacy-secret', SYNTH_PROXY_LLM_PASSWORD: 'llm-secret' },
    );
    const status = proxyStatus(cfg);
    expect(status.mode).toBe('all');
    expect(status.defaultProfile).toBe('default');
    expect(Object.keys(status.profiles)).toEqual(['default', 'llm']);
    expect(status.profiles.default).toMatchObject({
      name: 'default',
      label: 'Corporate',
      url: 'http://proxy.corp:3128',
      auth: { type: 'basic', username: 'user' },
      legacy: false,
      source: 'config',
    });
    expect(status.rules).toEqual([
      { id: 'r_openai', label: 'OpenAI', hosts: ['*.openai.com'], action: 'proxy', profile: 'llm' },
    ]);
    const json = JSON.stringify(status);
    for (const secret of ['urlsecret', 'legacy-secret', 'llm-secret', 'MIIB', 'BEGIN CERTIFICATE', 'user:']) {
      expect(json).not.toContain(secret);
    }
  });

  it('legacy-профиль в статусе помечен legacy=true', () => {
    const status = proxyStatus(
      resolveProxyConfig({ proxy: { url: 'http://p:3128', fromEnv: false } }, {}),
    );
    expect(status.profiles.default).toMatchObject({ legacy: true, source: 'config' });
  });
});

describe('validateProxyHostPatterns: нормализация', () => {
  it('trim/lower-case/завершающая точка', () => {
    expect(validateProxyHostPatterns([' API.Example.COM. ', '*.Corp.Local'])).toEqual([
      'api.example.com',
      '*.corp.local',
    ]);
  });

  it('контекст ошибки содержит путь', () => {
    expect(() => validateProxyHostPatterns(['bad pattern'], 'proxy.rules[2]')).toThrow(
      /proxy\.rules\[2\]\.hosts\[0\]/,
    );
  });
});

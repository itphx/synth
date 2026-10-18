import { describe, it, expect } from 'vitest';
import {
  displayProfileUrl,
  pendingProfilePasswords,
  profileDraftToInput,
  profileUsage,
  proxyDraftToInput,
  statusToDraft,
  validateProxyDraft,
  type ProxyDraft,
} from './proxy-draft';

const LEGACY = {
  enabled: true,
  source: 'config' as const,
  mode: 'all' as const,
  url: 'http://proxy.local:3128',
  httpsProxy: 'http://proxy.local:3129',
  auth: { type: 'basic' as const, username: 'svc' },
  tls: { caFile: '/etc/ca.pem', hasCaPem: false, rejectUnauthorized: false },
  noProxy: ['localhost'],
  fromEnv: false,
  fallbackDirect: false,
  connectTimeoutMs: 5000,
  restartRequired: true as const,
  profiles: {},
  rules: [],
};

function baseDraft(over: Partial<ProxyDraft> = {}): ProxyDraft {
  return {
    enabled: true,
    mode: 'all',
    defaultProfile: 'corp',
    profiles: {
      corp: {
        label: 'Corp',
        url: 'http://proxy.corp:3128',
        httpProxy: '',
        httpsProxy: '',
        allProxy: '',
        username: 'svc',
        tlsCaFile: '',
        tlsCertFile: '',
        tlsKeyFile: '',
        rejectUnauthorized: true,
      },
    },
    rules: [],
    noProxy: [],
    fromEnv: false,
    fallbackDirect: false,
    connectTimeoutMs: 5000,
    ...over,
  };
}

describe('statusToDraft — legacy и профили', () => {
  it('legacy flat-конфигурация синтезируется в профиль default (scheme-поля/auth/tls)', () => {
    const draft = statusToDraft(LEGACY);

    expect(Object.keys(draft.profiles)).toEqual(['default']);
    expect(draft.defaultProfile).toBe('default');
    expect(draft.profiles.default).toMatchObject({
      url: 'http://proxy.local:3128',
      httpsProxy: 'http://proxy.local:3129',
      username: 'svc',
      tlsCaFile: '/etc/ca.pem',
      rejectUnauthorized: false,
    });
    expect(draft.noProxy).toEqual(['localhost']);
  });

  it('не теряет mode/rules при отсутствии profiles', () => {
    const draft = statusToDraft({
      ...LEGACY,
      mode: 'selected',
      rules: [{ id: 'r1', hosts: ['a.example'], action: 'direct' }],
    });

    expect(draft.mode).toBe('selected');
    expect(draft.rules).toHaveLength(1);
    expect(draft.rules[0]).toMatchObject({ id: 'r1', hosts: ['a.example'], action: 'direct' });
  });

  it('использует именованные профили как есть (без синтетического default)', () => {
    const draft = statusToDraft({
      ...LEGACY,
      url: undefined,
      httpsProxy: undefined,
      auth: undefined,
      tls: undefined,
      defaultProfile: 'corp',
      profiles: {
        corp: {
          name: 'corp',
          label: 'Corp',
          url: 'http://proxy.corp:3128',
          auth: { type: 'basic', username: 'svc' },
          legacy: false,
          source: 'config',
          password: { source: 'none', set: false, removable: false },
        },
      },
    });

    expect(Object.keys(draft.profiles)).toEqual(['corp']);
    expect(draft.defaultProfile).toBe('corp');
  });

  it('не возвращает pendingPassword (он живёт только в клиентском черновике)', () => {
    const draft = statusToDraft({
      ...LEGACY,
      url: undefined,
      httpsProxy: undefined,
      auth: undefined,
      tls: undefined,
      defaultProfile: 'corp',
      profiles: {
        corp: {
          name: 'corp',
          url: 'http://proxy.corp:3128',
          auth: { type: 'basic', username: 'svc' },
          legacy: false,
          source: 'config',
          password: { source: 'file', set: true, removable: true },
        },
      },
    });

    expect(draft.profiles.corp).not.toHaveProperty('pendingPassword');
  });
});

describe('proxyDraftToInput — structured payload', () => {
  it('always sends mode/defaultProfile/profiles/rules и не шлёт top-level url/auth/tls', () => {
    const input = proxyDraftToInput(baseDraft());

    expect(input).toMatchObject({
      enabled: true,
      mode: 'all',
      defaultProfile: 'corp',
      profiles: {
        corp: {
          label: 'Corp',
          url: 'http://proxy.corp:3128',
          auth: { type: 'basic', username: 'svc' },
        },
      },
      rules: [],
    });
    expect(input).not.toHaveProperty('url');
    expect(input).not.toHaveProperty('auth');
    expect(input).not.toHaveProperty('tls');
  });

  it('скрытые legacy scheme-поля сохраняются, если URL не менялся', () => {
    const profile = baseDraft().profiles.corp!;
    profile.url = '';
    profile.httpProxy = 'http://proxy.corp:3128';
    profile.allProxy = 'socks5://proxy.corp:1080';

    const input = profileDraftToInput(profile);

    expect(input).toEqual({
      label: 'Corp',
      httpProxy: 'http://proxy.corp:3128',
      allProxy: 'socks5://proxy.corp:1080',
      auth: { type: 'basic', username: 'svc' },
    });
  });

  it('правило direct не отправляет profile; proxy без профиля использует default', () => {
    const input = proxyDraftToInput(
      baseDraft({
        rules: [
          {
            key: 'k1',
            id: 'r1',
            label: '',
            hosts: ['a.example'],
            action: 'direct',
            profile: 'corp',
          },
          { key: 'k2', id: '', label: 'B', hosts: ['b.example'], action: 'proxy', profile: '' },
        ],
      }),
    );

    expect(input.rules).toEqual([
      { id: 'r1', hosts: ['a.example'], action: 'direct' },
      { hosts: ['b.example'], action: 'proxy', label: 'B' },
    ]);
  });

  it('не отправляет пароли и PEM (redaction)', () => {
    const input = proxyDraftToInput(
      baseDraft({
        profiles: {
          corp: {
            ...baseDraft().profiles.corp!,
            tlsCaFile: '/etc/ca.pem',
          },
        },
      }),
    );

    const payload = JSON.stringify(input);
    expect(payload).not.toContain('password');
    expect(payload).not.toContain('BEGIN CERTIFICATE');
    expect(payload).not.toContain('caPem');
  });

  it('не отправляет pendingPassword нового профиля и не теряет остальные поля', () => {
    const draft = baseDraft();
    draft.profiles.corp = { ...draft.profiles.corp!, pendingPassword: 's3cret-value' };

    const input = proxyDraftToInput(draft);

    expect(input.profiles?.corp).toEqual({
      label: 'Corp',
      url: 'http://proxy.corp:3128',
      auth: { type: 'basic', username: 'svc' },
    });
    expect(JSON.stringify(input)).not.toContain('s3cret-value');
    expect(JSON.stringify(input)).not.toContain('pendingPassword');
  });
});

describe('pendingProfilePasswords', () => {
  it('возвращает только непустые pending-пароли', () => {
    expect(pendingProfilePasswords(baseDraft())).toEqual([]);

    const draft = baseDraft();
    draft.profiles.corp = { ...draft.profiles.corp!, pendingPassword: 'p1' };
    draft.profiles.blank = { ...draft.profiles.corp!, url: 'http://b:1', pendingPassword: '  ' };

    expect(pendingProfilePasswords(draft)).toEqual([{ name: 'corp', password: 'p1' }]);
  });
});

describe('validateProxyDraft', () => {
  it('валидный черновик — без замечаний', () => {
    expect(validateProxyDraft(baseDraft())).toEqual([]);
  });

  it('mode=selected без правил — ошибка', () => {
    const issues = validateProxyDraft(baseDraft({ mode: 'selected' }));
    expect(issues).toContainEqual({ kind: 'selectedNoRules' });
  });

  it('профиль без URL и невалидное имя — ошибки', () => {
    const draft = baseDraft();
    draft.profiles.corp = { ...draft.profiles.corp!, url: '' };
    draft.profiles['Bad Name'] = { ...draft.profiles.corp! };

    const issues = validateProxyDraft(draft);
    expect(issues).toContainEqual({ kind: 'profileUrl', name: 'corp' });
    expect(issues).toContainEqual({ kind: 'profileName', name: 'Bad Name' });
  });

  it('mode=all без валидного default-профиля — ошибка', () => {
    const issues = validateProxyDraft(baseDraft({ defaultProfile: 'nope' }));
    expect(issues).toContainEqual({ kind: 'defaultProfile' });
  });

  it('включённый прокси без профилей — ошибка', () => {
    const issues = validateProxyDraft(baseDraft({ profiles: {} }));
    expect(issues).toContainEqual({ kind: 'noProfiles' });
  });

  it('proxy-правило без профиля и default — ошибка; direct без профиля — ок', () => {
    const draft = baseDraft({
      defaultProfile: '',
      rules: [
        { key: 'k1', id: '', label: '', hosts: ['a.example'], action: 'proxy', profile: '' },
        { key: 'k2', id: '', label: '', hosts: ['b.example'], action: 'direct', profile: '' },
      ],
    });
    const issues = validateProxyDraft(draft);
    expect(issues).toContainEqual({ kind: 'ruleProfile', index: 0 });
    expect(issues).not.toContainEqual({ kind: 'ruleProfile', index: 1 });
  });

  it('пустые hosts и timeout — ошибки', () => {
    const issues = validateProxyDraft(
      baseDraft({
        connectTimeoutMs: 0,
        rules: [{ key: 'k1', id: '', label: '', hosts: [''], action: 'direct', profile: '' }],
      }),
    );
    expect(issues).toContainEqual({ kind: 'timeout' });
    expect(issues).toContainEqual({ kind: 'ruleHosts', index: 0 });
  });
});

describe('profileUsage / displayProfileUrl', () => {
  it('определяет default и правила', () => {
    const draft = baseDraft({
      rules: [{ key: 'k1', id: 'r1', label: '', hosts: ['a'], action: 'proxy', profile: 'corp' }],
    });
    expect(profileUsage(draft, 'corp')).toEqual({ isDefault: true, rules: ['r1'] });
    expect(profileUsage(draft, 'other')).toEqual({ isDefault: false, rules: [] });
  });

  it('displayProfileUrl предпочитает url, затем scheme-поля', () => {
    const profile = { ...baseDraft().profiles.corp!, url: '' };
    profile.httpsProxy = 'http://https:1';
    profile.httpProxy = 'http://http:1';
    expect(displayProfileUrl(profile)).toBe('http://https:1');
  });
});

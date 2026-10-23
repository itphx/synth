import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { ensureDataDir } from '@itphx/synth-shared';
import type { AuthConfig } from '@itphx/synth-shared';
import { createAuthRoutes } from './auth.js';

// /auth/oidc-meta не использует kit — достаточно заглушки.
function makeApp(config: AuthConfig): Hono {
  const app = new Hono();
  app.route('/auth', createAuthRoutes({} as never, config));
  return app;
}

const BASE_CONFIG: AuthConfig = { debugMode: false, sessionMaxAgeMinutes: 1440 };

const OIDC_ENABLED: AuthConfig = {
  ...BASE_CONFIG,
  oidc: {
    enabled: true,
    issuer: 'https://kc.test/realms/synth',
    clientId: 'synth-web',
    clientSecret: 'top-secret',
    redirectUri: 'http://localhost:5002/auth/callback',
  },
};

describe('routes/auth: GET /auth/oidc-meta', () => {
  it('oidc выключен → { enabled: false }', async () => {
    const app = makeApp({ ...BASE_CONFIG });
    const res = await app.request('/auth/oidc-meta');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false });
  });

  it('oidc включён + cliClientId → issuer и clientId из конфига', async () => {
    const app = makeApp({
      ...OIDC_ENABLED,
      oidc: { ...OIDC_ENABLED.oidc!, cliClientId: 'synth-cli' },
    });
    const res = await app.request('/auth/oidc-meta');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      enabled: true,
      issuer: 'https://kc.test/realms/synth',
      clientId: 'synth-cli',
    });
  });

  it('oidc включён, cliClientId не задан → дефолт synth-cli', async () => {
    const app = makeApp({ ...OIDC_ENABLED });
    const res = await app.request('/auth/oidc-meta');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      enabled: true,
      issuer: 'https://kc.test/realms/synth',
      clientId: 'synth-cli',
    });
  });

  it('не отдаёт clientSecret в ответе', async () => {
    const app = makeApp({
      ...OIDC_ENABLED,
      oidc: { ...OIDC_ENABLED.oidc!, cliClientId: 'synth-cli' },
    });
    const res = await app.request('/auth/oidc-meta');
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty('clientSecret');
    expect(body).not.toHaveProperty('client_secret');
  });

  /**
   * PROP-090 Ф7: сигнал о серверной политике плагинов в публичном дискавери.
   *
   * Сигнал содержит только `{enabled, mode}` — **без списка имён**: allow-list
   * не публичен (полный список — по аутентифицированному роуту
   * `GET /api/v2/settings/plugins`).
   */
  it('сигнал plugins: {enabled, mode} — без списка имён', async () => {
    const app = new Hono();
    app.route('/auth', createAuthRoutes({} as never, { ...OIDC_ENABLED }, undefined, undefined, undefined, {
      enabled: true,
      mode: 'allowlist',
    }));
    const res = await app.request('/auth/oidc-meta');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { plugins?: Record<string, unknown> };
    expect(body.plugins).toEqual({ enabled: true, mode: 'allowlist' });
    // Списка имён в публичном ответе нет.
    expect(body.plugins).not.toHaveProperty('allow');
  });

  it('сигнал plugins отдаётся и при выключенном OIDC', async () => {
    const app = new Hono();
    app.route('/auth', createAuthRoutes({} as never, { ...BASE_CONFIG }, undefined, undefined, undefined, {
      enabled: false,
      mode: 'off',
    }));
    const res = await app.request('/auth/oidc-meta');
    const body = (await res.json()) as { enabled: boolean; plugins?: Record<string, unknown> };
    expect(body.enabled).toBe(false);
    expect(body.plugins).toEqual({ enabled: false, mode: 'off' });
  });

  it('сигнал не задан → поле plugins отсутствует (старый клиент) ', async () => {
    const app = makeApp({ ...OIDC_ENABLED });
    const res = await app.request('/auth/oidc-meta');
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty('plugins');
  });
});

// Path traversal в аватаре: username приходит из OIDC и раньше подставлялся в
// `join(avatarsDir, `${username}.png`)` без санитайза.
describe('routes/auth: GET/POST /auth/profile/avatar — санитайз username', () => {
  let root: string;

  const makeApp = (username: string): Hono => {
    const kit = {
      getCurrentUser: async () => ({
        id: 'u1',
        username,
        roles: ['USER'],
        preferredLanguage: 'ru',
        createdAt: '',
        teamRole: 'USER',
        notes: '',
        interviewCompleted: false,
      }),
    };
    const app = new Hono();
    app.route('/auth', createAuthRoutes(kit as never, BASE_CONFIG, undefined, root));
    return app;
  };

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'synth-avatar-'));
    await ensureDataDir(root);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('POST с traversal-username (../../evil) → 400, файл вне каталога не создаётся', async () => {
    const app = makeApp('../../evil');
    const res = await app.request('/auth/profile/avatar', {
      method: 'POST',
      body: Buffer.from([1, 2, 3]),
    });
    expect(res.status).toBe(400);
    await expect(access(join(root, 'evil.png'))).rejects.toThrow();
  });

  it('POST с username-разделителем пути (a/b) → 400', async () => {
    const app = makeApp('a/b');
    const res = await app.request('/auth/profile/avatar', {
      method: 'POST',
      body: Buffer.from([1]),
    });
    expect(res.status).toBe(400);
  });

  it('GET с traversal-username (..) → 400', async () => {
    const app = makeApp('..');
    const res = await app.request('/auth/profile/avatar');
    expect(res.status).toBe(400);
  });

  it('корректный username → 200, файл внутри каталога аватаров', async () => {
    const app = makeApp('alice');
    const post = await app.request('/auth/profile/avatar', {
      method: 'POST',
      body: Buffer.from([1, 2, 3]),
    });
    expect(post.status).toBe(200);
    await expect(access(join(root, 'auth', 'avatars', 'alice.png'))).resolves.toBeUndefined();
    const get = await app.request('/auth/profile/avatar');
    expect(get.status).toBe(200);
  });
});

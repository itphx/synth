import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
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
});

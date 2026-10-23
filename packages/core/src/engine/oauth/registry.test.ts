import { describe, it, expect } from 'vitest';
import { OAuthError } from './types.js';
import { OAuthProviderRegistry, registerOAuthProvidersFromConfig } from './registry.js';

describe('OAuthProviderRegistry (ADR-105 Ф3)', () => {
  it('неизвестный провайдер → понятная ошибка not_found', () => {
    const registry = new OAuthProviderRegistry();
    expect(() => registry.clientFor('github')).toThrow(OAuthError);
    try {
      registry.clientFor('github');
      throw new Error('ожидалась ошибка');
    } catch (err) {
      expect(err).toBeInstanceOf(OAuthError);
      expect((err as OAuthError).code).toBe('not_found');
      expect((err as OAuthError).message).toContain('github');
    }
  });

  it('пустой реестр — штатное состояние (список пуст)', () => {
    const registry = new OAuthProviderRegistry();
    expect(registry.list()).toEqual([]);
  });
});

describe('registerOAuthProvidersFromConfig (ADR-105 Ф3)', () => {
  it('провайдер из конфига резолвится: описание и клиент', async () => {
    const registry = new OAuthProviderRegistry();
    const count = await registerOAuthProvidersFromConfig(registry, {
      github: {
        authorizeUrl: 'https://github.com/login/oauth/authorize',
        tokenUrl: 'https://github.com/login/oauth/access_token',
        revokeUrl: 'https://api.github.com/applications/token',
        clientId: 'synth-client',
        scopes: ['repo', 'read:user'],
      },
    });

    expect(count).toBe(1);
    const description = registry.get('github');
    expect(description?.provider).toBe('github');
    expect(description?.clientId).toBe('synth-client');
    expect(description?.scopes).toEqual(['repo', 'read:user']);
    expect(description?.revokeUrl).toBe('https://api.github.com/applications/token');

    // Клиент строится — значит описание достаточно для refresh.
    const client = registry.clientFor('github');
    expect(client).toBeDefined();
    expect(registry.list()).toHaveLength(1);
  });

  it('неизвестный провайдер после наполнения → понятная ошибка', async () => {
    const registry = new OAuthProviderRegistry();
    await registerOAuthProvidersFromConfig(registry, {
      github: {
        authorizeUrl: 'https://github.com/login/oauth/authorize',
        tokenUrl: 'https://github.com/login/oauth/access_token',
        clientId: 'synth-client',
      },
    });

    expect(() => registry.clientFor('gitlab')).toThrow(OAuthError);
    try {
      registry.clientFor('gitlab');
      throw new Error('ожидалась ошибка');
    } catch (err) {
      expect((err as OAuthError).code).toBe('not_found');
      expect((err as OAuthError).message).toContain('gitlab');
    }
  });

  it('client_secret подтягивается отдельно (env/файл) и в описание не попадает', async () => {
    const registry = new OAuthProviderRegistry();
    await registerOAuthProvidersFromConfig(
      registry,
      {
        google: {
          authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
          tokenUrl: 'https://oauth2.googleapis.com/token',
          clientId: 'synth-client',
        },
      },
      {
        env: { SYNTH_OAUTH_GOOGLE_CLIENT_SECRET: 'top-secret' },
      },
    );

    const description = registry.get('google');
    expect(JSON.stringify(description)).not.toContain('top-secret');
    // Клиент собирается с секретом (иначе refresh confidential-клиента не пройдёт).
    expect(registry.clientFor('google')).toBeDefined();
  });

  it('пустой/отсутствующий каталог — не ошибка (доступы, созданные кодом, живут)', async () => {
    const registry = new OAuthProviderRegistry();
    expect(await registerOAuthProvidersFromConfig(registry, undefined)).toBe(0);
    expect(await registerOAuthProvidersFromConfig(registry, {})).toBe(0);
    expect(registry.list()).toEqual([]);
  });
});

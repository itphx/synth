/**
 * ADR-105 (Ф2): `client_secret` — только env или файл
 * `{dataDir}/secrets/oauth/<provider>.client_secret`; в конфиге его нет, в
 * логах/текстах ошибок он не появляется.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  oauthClientSecretEnv,
  oauthClientSecretPath,
  resolveOAuthClientSecret,
} from './client-secret.js';
import { OAuthClient } from './client.js';
import { OAuthError } from './types.js';
import type { OAuthProviderDescription } from './types.js';

const tmpDirs: string[] = [];

afterEach(async () => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

/** Временный каталог данных инстанса. */
async function makeDataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'synth-oauth-secret-'));
  tmpDirs.push(dir);
  return dir;
}

/** Кладёт файл секрета клиента (права `0600`, как требует инвариант 13). */
async function writeSecretFile(dataDir: string, provider: string, value: string): Promise<string> {
  const path = oauthClientSecretPath(dataDir, provider);
  await mkdir(join(dataDir, 'secrets', 'oauth'), { recursive: true, mode: 0o700 });
  await writeFile(path, `${value}\n`, { encoding: 'utf-8', mode: 0o600 });
  return path;
}

describe('oauth: client_secret (env или файл)', () => {
  it('имя env-переменной выводится из ключа провайдера', () => {
    expect(oauthClientSecretEnv('google')).toBe('SYNTH_OAUTH_GOOGLE_CLIENT_SECRET');
    expect(oauthClientSecretEnv('my-provider')).toBe('SYNTH_OAUTH_MY_PROVIDER_CLIENT_SECRET');
  });

  it('env: секрет читается из переменной окружения', async () => {
    const secret = await resolveOAuthClientSecret({
      provider: 'local',
      env: { SYNTH_OAUTH_LOCAL_CLIENT_SECRET: 'env-secret' },
    });
    expect(secret).toBe('env-secret');
  });

  it('файл: секрет читается из {dataDir}/secrets/oauth/<provider>.client_secret', async () => {
    const dataDir = await makeDataDir();
    const path = await writeSecretFile(dataDir, 'local', 'file-secret');
    expect(path).toBe(join(dataDir, 'secrets', 'oauth', 'local.client_secret'));

    const secret = await resolveOAuthClientSecret({ provider: 'local', dataDir, env: {} });
    expect(secret).toBe('file-secret');
  });

  it('env приоритетнее файла; без источников — секрета нет', async () => {
    const dataDir = await makeDataDir();
    await writeSecretFile(dataDir, 'local', 'file-secret');
    const fromEnv = await resolveOAuthClientSecret({
      provider: 'local',
      dataDir,
      env: { SYNTH_OAUTH_LOCAL_CLIENT_SECRET: 'env-secret' },
    });
    expect(fromEnv).toBe('env-secret');

    const none = await resolveOAuthClientSecret({
      provider: 'local',
      dataDir: await makeDataDir(),
      env: {},
    });
    expect(none).toBeUndefined();
  });
});

describe('oauth: применение client_secret', () => {
  const provider: OAuthProviderDescription = {
    provider: 'local',
    authorizeUrl: 'http://127.0.0.1:1/authorize',
    tokenUrl: 'http://127.0.0.1:1/token',
    clientId: 'client-1',
    clientAuth: 'client_secret_post',
  };

  it('client_secret_post: секрет уходит в тело запроса, в текст ошибки — нет', async () => {
    const seen: Array<Record<string, string>> = [];
    const client = new OAuthClient({
      provider,
      clientSecret: 'super-secret',
      fetchImpl: async (_input, init) => {
        const body = new URLSearchParams(String(init?.body ?? ''));
        seen.push(Object.fromEntries(body.entries()));
        return new Response(JSON.stringify({ error: 'invalid_client' }), { status: 401 });
      },
    });

    await expect(client.exchangeCode({ code: 'c' })).rejects.toBeInstanceOf(OAuthError);
    expect(seen[0]?.client_secret).toBe('super-secret');
    try {
      await client.exchangeCode({ code: 'c' });
    } catch (err) {
      expect((err as Error).message).not.toContain('super-secret');
    }
  });

  it('client_secret_basic: секрет уходит в заголовок Authorization', async () => {
    let authorization: string | undefined;
    const client = new OAuthClient({
      provider: { ...provider, clientAuth: 'client_secret_basic' },
      clientSecret: 'super-secret',
      fetchImpl: async (_input, init) => {
        const headers = init?.headers as Record<string, string> | undefined;
        authorization = headers?.Authorization;
        return new Response(JSON.stringify({ access_token: 'a' }), { status: 200 });
      },
    });

    await client.exchangeCode({ code: 'c' });
    const expected = Buffer.from('client-1:super-secret').toString('base64');
    expect(authorization).toBe(`Basic ${expected}`);
  });

  it('секрет не задан, а провайдер требует его — понятная ошибка без утечки', async () => {
    const client = new OAuthClient({
      provider,
      fetchImpl: async () => new Response('{}', { status: 200 }),
    });
    await expect(client.exchangeCode({ code: 'c' })).rejects.toMatchObject({
      code: 'missing_client_secret',
    });
  });
});

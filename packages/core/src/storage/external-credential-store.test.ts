import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createTmpDir } from './contract/helpers.js';
import { ExternalCredentialStore } from './external-credential-store.js';
import { ExternalCredentialStoreError } from './ports/external-credential-repository.js';

/** Мастер-ключ (base64, 32 байта) — файл `master.key` не создаётся. */
const MASTER_KEY = Buffer.alloc(32, 7).toString('base64');
/** Другой мастер-ключ — расшифровка чужого токена должна падать. */
const OTHER_MASTER_KEY = Buffer.alloc(32, 9).toString('base64');

const disposers: Array<() => Promise<void>> = [];
afterAll(async () => {
  await Promise.all(disposers.map((d) => d()));
});

async function tmp(): Promise<string> {
  const { dir, dispose } = await createTmpDir();
  disposers.push(dispose);
  return dir;
}

const ACCESS_TOKEN = 'ya29.plain-token-must-not-hit-disk';

describe('ExternalCredentialStore (ADR-105 Ф1)', () => {
  it('файл доступов лежит в secrets/oauth/ и создан с правами 0600', async () => {
    const dir = await tmp();
    const store = new ExternalCredentialStore({ dataDir: dir, secretKey: MASTER_KEY });

    await store.create({
      provider: 'google',
      clientId: 'client-123',
      owner: { kind: 'local', id: 'local' },
      accessToken: ACCESS_TOKEN,
      createdBy: 'local',
    });

    const path = join(dir, 'secrets', 'oauth', 'credentials.json');
    const info = await stat(path);
    expect(info.isFile()).toBe(true);
    expect(info.mode & 0o777).toBe(0o600);
  });

  it('на диске только enc:v1:… — plaintext-токена нет ни в файле, ни во временных', async () => {
    const dir = await tmp();
    const store = new ExternalCredentialStore({ dataDir: dir, secretKey: MASTER_KEY });

    await store.create({
      provider: 'google',
      clientId: 'client-123',
      owner: { kind: 'local', id: 'local' },
      accessToken: ACCESS_TOKEN,
      refreshToken: 'refresh-plain-token',
      createdBy: 'local',
    });

    const path = join(dir, 'secrets', 'oauth', 'credentials.json');
    const raw = await readFile(path, 'utf-8');
    expect(raw).toContain('enc:v1:');
    expect(raw).not.toContain(ACCESS_TOKEN);
    expect(raw).not.toContain('refresh-plain-token');
  });

  it('чужой мастер-ключ не расшифровывает токен (ошибка decrypt_failed)', async () => {
    const dir = await tmp();
    const store = new ExternalCredentialStore({ dataDir: dir, secretKey: MASTER_KEY });
    const created = await store.create({
      provider: 'google',
      clientId: 'client-123',
      owner: { kind: 'local', id: 'local' },
      accessToken: ACCESS_TOKEN,
      createdBy: 'local',
    });

    const other = new ExternalCredentialStore({ dataDir: dir, secretKey: OTHER_MASTER_KEY });
    await expect(other.reveal(created.id)).rejects.toBeInstanceOf(ExternalCredentialStoreError);
    await expect(other.reveal(created.id)).rejects.toMatchObject({ code: 'decrypt_failed' });
  });

  it('повреждённый файл не ломает чтение (list → [])', async () => {
    const dir = await tmp();
    const store = new ExternalCredentialStore({ dataDir: dir, secretKey: MASTER_KEY });
    const path = join(dir, 'secrets', 'oauth', 'credentials.json');
    await mkdir(dirname(path), { recursive: true });

    await writeFile(path, 'не-json-мусор', 'utf-8');
    expect(await store.list()).toEqual([]);
    expect(await store.get('missing')).toBeNull();
  });

  it('после перезапуска (новый инстанс стора) запись читается и расшифровывается', async () => {
    const dir = await tmp();
    const store = new ExternalCredentialStore({ dataDir: dir, secretKey: MASTER_KEY });
    const created = await store.create({
      provider: 'github',
      clientId: 'client-456',
      owner: { kind: 'user', id: 'user-1' },
      accessToken: ACCESS_TOKEN,
      createdBy: 'user-1',
    });

    const reopened = new ExternalCredentialStore({ dataDir: dir, secretKey: MASTER_KEY });
    expect((await reopened.get(created.id))?.provider).toBe('github');
    expect((await reopened.reveal(created.id))?.accessToken).toBe(ACCESS_TOKEN);
  });

  it('неверный вход отклоняется (пустой токен/provider/clientId)', async () => {
    const dir = await tmp();
    const store = new ExternalCredentialStore({ dataDir: dir, secretKey: MASTER_KEY });

    await expect(
      store.create({
        provider: 'google',
        clientId: 'client-123',
        owner: { kind: 'local', id: 'local' },
        accessToken: '',
        createdBy: 'local',
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
    await expect(
      store.create({
        provider: '',
        clientId: 'client-123',
        owner: { kind: 'local', id: 'local' },
        accessToken: ACCESS_TOKEN,
        createdBy: 'local',
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
  });
});

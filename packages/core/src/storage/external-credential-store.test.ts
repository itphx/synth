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
/** Ключ, на который ротируем (ADR-105 Ф4). */
const NEW_MASTER_KEY = Buffer.alloc(32, 11).toString('base64');
/** Ещё один ключ — «совсем чужой», им ничего не расшифровывается. */
const WRONG_MASTER_KEY = Buffer.alloc(32, 13).toString('base64');

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

describe('ExternalCredentialStore.rotateMasterKey (ADR-105 Ф4)', () => {
  /** Создать доступ с access/refresh-токенами (запись на диске — `enc:v1:…`). */
  async function seed(dir: string): Promise<string> {
    const store = new ExternalCredentialStore({ dataDir: dir, secretKey: MASTER_KEY });
    const created = await store.create({
      provider: 'google',
      clientId: 'client-123',
      owner: { kind: 'local', id: 'local' },
      accessToken: ACCESS_TOKEN,
      refreshToken: 'refresh-plain-token',
      createdBy: 'local',
    });
    return created.id;
  }

  it('перешифровывает токены новым ключом: новый ключ читает, старый — decrypt_failed', async () => {
    const dir = await tmp();
    const id = await seed(dir);
    const store = new ExternalCredentialStore({ dataDir: dir, secretKey: MASTER_KEY });

    const result = await store.rotateMasterKey(
      Buffer.from(MASTER_KEY, 'base64'),
      Buffer.from(NEW_MASTER_KEY, 'base64'),
    );

    expect(result.total).toBe(1);
    expect(result.rotated).toBe(1);
    expect(result.upgraded).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.ids).toEqual([id]);

    // На диске — новый шифр, plaintext-токенов нет.
    const raw = await readFile(join(dir, 'secrets', 'oauth', 'credentials.json'), 'utf-8');
    expect(raw).toContain('enc:v1:');
    expect(raw).not.toContain(ACCESS_TOKEN);
    expect(raw).not.toContain('refresh-plain-token');

    // Новым ключом токены читаются.
    const withNew = new ExternalCredentialStore({ dataDir: dir, secretKey: NEW_MASTER_KEY });
    expect(await withNew.reveal(id)).toEqual({
      accessToken: ACCESS_TOKEN,
      refreshToken: 'refresh-plain-token',
    });

    // Старым ключом — уже нет.
    const withOld = new ExternalCredentialStore({ dataDir: dir, secretKey: MASTER_KEY });
    await expect(withOld.reveal(id)).rejects.toMatchObject({ code: 'decrypt_failed' });
  });

  it('dry-run ничего не меняет (файл и счётчики)', async () => {
    const dir = await tmp();
    const id = await seed(dir);
    const store = new ExternalCredentialStore({ dataDir: dir, secretKey: MASTER_KEY });
    const path = join(dir, 'secrets', 'oauth', 'credentials.json');
    const before = await readFile(path, 'utf-8');

    const result = await store.rotateMasterKey(
      Buffer.from(MASTER_KEY, 'base64'),
      Buffer.from(NEW_MASTER_KEY, 'base64'),
      { dryRun: true },
    );

    expect(result.rotated).toBe(1);
    expect(result.ids).toEqual([id]);
    expect(await readFile(path, 'utf-8')).toBe(before);

    // Старый ключ всё ещё работает — запись не тронута.
    expect((await store.reveal(id))?.accessToken).toBe(ACCESS_TOKEN);
  });

  it('неверный старый ключ → preflight-отказ, файл не изменён', async () => {
    const dir = await tmp();
    const id = await seed(dir);
    const store = new ExternalCredentialStore({ dataDir: dir, secretKey: MASTER_KEY });
    const path = join(dir, 'secrets', 'oauth', 'credentials.json');
    const before = await readFile(path, 'utf-8');

    const err = await store
      .rotateMasterKey(
        Buffer.from(WRONG_MASTER_KEY, 'base64'),
        Buffer.from(NEW_MASTER_KEY, 'base64'),
      )
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ExternalCredentialStoreError);
    expect((err as ExternalCredentialStoreError).code).toBe('preflight_failed');
    expect((err as ExternalCredentialStoreError).message).toContain(id);
    expect(await readFile(path, 'utf-8')).toBe(before);
  });

  it('повторный прогон идемпотентен: уже новые записи — skipped', async () => {
    const dir = await tmp();
    await seed(dir);
    const store = new ExternalCredentialStore({ dataDir: dir, secretKey: MASTER_KEY });
    const oldKey = Buffer.from(MASTER_KEY, 'base64');
    const newKey = Buffer.from(NEW_MASTER_KEY, 'base64');

    const first = await store.rotateMasterKey(oldKey, newKey);
    expect(first.rotated).toBe(1);

    const second = await store.rotateMasterKey(oldKey, newKey);
    expect(second.total).toBe(1);
    expect(second.rotated).toBe(0);
    expect(second.upgraded).toBe(0);
    expect(second.skipped).toBe(1);
    expect(second.ids).toEqual([]);
  });

  it('plaintext-поля апгрейдятся новым ключом', async () => {
    const dir = await tmp();
    const path = join(dir, 'secrets', 'oauth', 'credentials.json');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        credentials: [
          {
            id: 'extc_plain',
            provider: 'google',
            clientId: 'client-123',
            scopes: [],
            owner: { kind: 'local', id: 'local' },
            secretEnc: ACCESS_TOKEN,
            status: 'active',
            createdBy: 'local',
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      }),
      'utf-8',
    );

    const store = new ExternalCredentialStore({ dataDir: dir, secretKey: NEW_MASTER_KEY });
    const result = await store.rotateMasterKey(
      Buffer.from(MASTER_KEY, 'base64'),
      Buffer.from(NEW_MASTER_KEY, 'base64'),
    );

    expect(result.total).toBe(1);
    expect(result.rotated).toBe(0);
    expect(result.upgraded).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.ids).toEqual(['extc_plain']);

    const raw = await readFile(path, 'utf-8');
    expect(raw).toContain('enc:v1:');
    expect(raw).not.toContain(ACCESS_TOKEN);
    expect((await store.reveal('extc_plain'))?.accessToken).toBe(ACCESS_TOKEN);
  });
});

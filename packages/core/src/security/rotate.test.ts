import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SSHKeyStore, SSHKeyStoreError } from '../storage/ssh-key-store.js';
import { ExternalCredentialStore } from '../storage/external-credential-store.js';
import { ExternalCredentialStoreError } from '../storage/ports/external-credential-repository.js';
import { clearMasterKeyCache, decryptSecret, masterKeyFilePath } from './crypto.js';
import { rotateSecretsMasterKey } from './rotate.js';

const SECRET_MARKER = 'SUPERSECRETPRIVATEKEYMATERIAL';
const SAMPLE_KEY = `-----BEGIN OPENSSH PRIVATE KEY-----\n${SECRET_MARKER}\n-----END OPENSSH PRIVATE KEY-----`;

describe('rotateSecretsMasterKey (ADR-076)', () => {
  let tmpDir: string;
  let oldKey: Buffer;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-rotate-'));
    oldKey = randomBytes(32);
    await mkdir(join(tmpDir, 'secrets'), { recursive: true });
    await writeFile(masterKeyFilePath(tmpDir), oldKey.toString('base64'), { mode: 0o600 });
    clearMasterKeyCache();
  });

  afterEach(async () => {
    clearMasterKeyCache();
    await rm(tmpDir, { recursive: true, force: true });
  });

  function sshKeysDir(): string {
    return join(tmpDir, 'secrets', 'ssh-keys');
  }

  function rawPath(id: string): string {
    return join(sshKeysDir(), `${id}.json`);
  }

  /** Store поверх файла master.key (env пуст, secretKey не задан). */
  function fileStore(): SSHKeyStore {
    return new SSHKeyStore({ dataDir: tmpDir, env: {} });
  }

  it('перешифровывает записи новым ключом и перезаписывает master.key (0600)', async () => {
    const store = fileStore();
    const a = await store.create({ name: 'a', privateKey: SAMPLE_KEY, passphrase: 'p@ss' });
    const b = await store.create({ name: 'b', privateKey: `${SAMPLE_KEY}\n2` });

    const newKey = randomBytes(32);
    const result = await rotateSecretsMasterKey({
      dataDir: tmpDir,
      newKey: newKey.toString('base64'),
      env: {},
    });

    expect(result.total).toBe(2);
    expect(result.rotated).toBe(2);
    expect(result.upgraded).toBe(0);
    expect(result.skipped).toBe(0);
    expect(new Set(result.ids)).toEqual(new Set([a.id, b.id]));
    expect(result.oldKeySource).toBe('file');
    expect(result.newKeySource).toBe('explicit');
    expect(result.dryRun).toBe(false);

    const filePath = masterKeyFilePath(tmpDir);
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    const stored = Buffer.from((await readFile(filePath, 'utf-8')).trim(), 'base64');
    expect(stored.equals(newKey)).toBe(true);

    // Новый инстанс читает секреты новым ключом.
    const restarted = fileStore();
    expect(await restarted.reveal(a.id)).toEqual({ privateKey: SAMPLE_KEY, passphrase: 'p@ss' });
    expect(await restarted.reveal(b.id)).toEqual({ privateKey: `${SAMPLE_KEY}\n2` });

    // Старым ключом — decrypt_failed.
    const withOld = new SSHKeyStore({ dataDir: tmpDir, secretKey: oldKey.toString('base64') });
    await expect(withOld.reveal(a.id)).rejects.toMatchObject({ code: 'decrypt_failed' });
  });

  it('dryRun ничего не пишет', async () => {
    const store = fileStore();
    const a = await store.create({ name: 'dry', privateKey: SAMPLE_KEY });
    const beforeRaw = await readFile(rawPath(a.id), 'utf-8');
    const beforeMaster = await readFile(masterKeyFilePath(tmpDir), 'utf-8');

    const newKey = randomBytes(32);
    const result = await rotateSecretsMasterKey({
      dataDir: tmpDir,
      newKey: newKey.toString('base64'),
      dryRun: true,
      env: {},
    });

    expect(result.dryRun).toBe(true);
    expect(result.rotated).toBe(1);
    expect(await readFile(rawPath(a.id), 'utf-8')).toBe(beforeRaw);
    expect(await readFile(masterKeyFilePath(tmpDir), 'utf-8')).toBe(beforeMaster);

    // Старый ключ всё ещё работает.
    expect(await fileStore().reveal(a.id)).toEqual({ privateKey: SAMPLE_KEY });
  });

  it('plaintext-поля апгрейдятся новым ключом', async () => {
    await mkdir(sshKeysDir(), { recursive: true });
    const id = 'plain-1';
    await writeFile(
      rawPath(id),
      JSON.stringify({
        id,
        name: 'plain',
        type: 'user',
        privateKey: SAMPLE_KEY,
        agentIds: [],
        createdAt: new Date().toISOString(),
      }),
      'utf-8',
    );

    const newKey = randomBytes(32);
    const result = await rotateSecretsMasterKey({
      dataDir: tmpDir,
      newKey: newKey.toString('base64'),
      env: {},
    });

    expect(result.total).toBe(1);
    expect(result.rotated).toBe(0);
    expect(result.upgraded).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.ids).toEqual([id]);

    const raw = JSON.parse(await readFile(rawPath(id), 'utf-8')) as { privateKey: string };
    expect(raw.privateKey.startsWith('enc:v1:')).toBe(true);
    expect(decryptSecret(raw.privateKey, newKey)).toBe(SAMPLE_KEY);
    expect(raw.privateKey).not.toContain(SECRET_MARKER);
  });

  it('неверный старый ключ → preflight abort, файлы не изменены', async () => {
    const store = fileStore();
    const a = await store.create({ name: 'abort', privateKey: SAMPLE_KEY });
    const beforeRaw = await readFile(rawPath(a.id), 'utf-8');
    const beforeMaster = await readFile(masterKeyFilePath(tmpDir), 'utf-8');

    const err = await rotateSecretsMasterKey({
      dataDir: tmpDir,
      oldKey: randomBytes(32).toString('base64'),
      newKey: randomBytes(32).toString('base64'),
      env: {},
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SSHKeyStoreError);
    expect((err as SSHKeyStoreError).code).toBe('preflight_failed');
    expect((err as SSHKeyStoreError).message).toContain(a.id);

    expect(await readFile(rawPath(a.id), 'utf-8')).toBe(beforeRaw);
    expect(await readFile(masterKeyFilePath(tmpDir), 'utf-8')).toBe(beforeMaster);
  });

  it('повторный прогон идемпотентен: уже новые записи — skipped', async () => {
    const store = fileStore();
    await store.create({ name: 'x', privateKey: SAMPLE_KEY });
    await store.create({ name: 'y', privateKey: `${SAMPLE_KEY}\n2` });

    const newKey = randomBytes(32);
    const first = await rotateSecretsMasterKey({
      dataDir: tmpDir,
      newKey: newKey.toString('base64'),
      env: {},
    });
    expect(first.rotated).toBe(2);

    const second = await rotateSecretsMasterKey({
      dataDir: tmpDir,
      newKey: newKey.toString('base64'),
      env: {},
    });
    expect(second.total).toBe(2);
    expect(second.rotated).toBe(0);
    expect(second.upgraded).toBe(0);
    expect(second.skipped).toBe(2);
    expect(second.ids).toEqual([]);
  });

  it('отсутствие master.key → явная ошибка (без генерации)', async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), 'synth-rotate-empty-'));
    try {
      const err = await rotateSecretsMasterKey({ dataDir: emptyDir, env: {} }).catch(
        (e: unknown) => e,
      );
      expect(err).toMatchObject({ code: 'master_key_missing' });
      await expect(stat(masterKeyFilePath(emptyDir))).rejects.toThrow();
    } finally {
      await rm(emptyDir, { recursive: true, force: true });
    }
  });

  it('эффективный ключ из env/config → предупреждение, файл всё равно перезаписан', async () => {
    const store = fileStore();
    await store.create({ name: 'warn', privateKey: SAMPLE_KEY });

    const newKey = randomBytes(32);
    const result = await rotateSecretsMasterKey({
      dataDir: tmpDir,
      secretKey: oldKey.toString('base64'),
      newKey: newKey.toString('base64'),
      env: {},
    });

    expect(result.oldKeySource).toBe('config');
    expect(result.warnings.some((w) => w.includes('config.security.secretKey'))).toBe(true);

    const stored = Buffer.from(
      (await readFile(masterKeyFilePath(tmpDir), 'utf-8')).trim(),
      'base64',
    );
    expect(stored.equals(newKey)).toBe(true);
  });

  it('одновременно значение и файл ключа → key_conflict', async () => {
    const err = await rotateSecretsMasterKey({
      dataDir: tmpDir,
      oldKey: oldKey.toString('base64'),
      oldKeyFile: join(tmpDir, 'whatever.key'),
      env: {},
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'key_conflict' });
  });

  it('listRaw отдаёт зашифрованные записи, list — только метаданные', async () => {
    const store = fileStore();
    const a = await store.create({ name: 'raw', privateKey: SAMPLE_KEY });

    const raw = await store.listRaw();
    expect(raw).toHaveLength(1);
    expect(raw[0]?.id).toBe(a.id);
    expect(raw[0]?.privateKey.startsWith('enc:v1:')).toBe(true);

    const metas = await store.list();
    expect(metas).toHaveLength(1);
    expect(metas[0] && 'privateKey' in metas[0]).toBe(false);
  });
});

describe('rotateSecretsMasterKey — внешние доступы (ADR-105 Ф4)', () => {
  const ACCESS_TOKEN = 'ya29.access-token-must-not-leak';
  const REFRESH_TOKEN = 'refresh-token-must-not-leak';

  let tmpDir: string;
  let oldKey: Buffer;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-rotate-oauth-'));
    oldKey = randomBytes(32);
    await mkdir(join(tmpDir, 'secrets'), { recursive: true });
    await writeFile(masterKeyFilePath(tmpDir), oldKey.toString('base64'), { mode: 0o600 });
    clearMasterKeyCache();
  });

  afterEach(async () => {
    clearMasterKeyCache();
    await rm(tmpDir, { recursive: true, force: true });
  });

  /** Store доступов поверх файла master.key (env пуст, secretKey не задан). */
  function credentialStore(): ExternalCredentialStore {
    return new ExternalCredentialStore({ dataDir: tmpDir, env: {} });
  }

  /** Создать доступ (access+refresh) мастер-ключом из файла. */
  async function seed(): Promise<string> {
    const created = await credentialStore().create({
      provider: 'google',
      clientId: 'client-123',
      owner: { kind: 'local', id: 'local' },
      accessToken: ACCESS_TOKEN,
      refreshToken: REFRESH_TOKEN,
      createdBy: 'local',
    });
    return created.id;
  }

  function credentialsPath(): string {
    return join(tmpDir, 'secrets', 'oauth', 'credentials.json');
  }

  it('перешифровывает доступы новым мастер-ключом: новый ключ читает, старый — decrypt_failed', async () => {
    const id = await seed();
    const newKey = randomBytes(32);

    const result = await rotateSecretsMasterKey({
      dataDir: tmpDir,
      newKey: newKey.toString('base64'),
      env: {},
    });

    expect(result.credentials.total).toBe(1);
    expect(result.credentials.rotated).toBe(1);
    expect(result.credentials.upgraded).toBe(0);
    expect(result.credentials.skipped).toBe(0);
    expect(result.credentials.ids).toEqual([id]);

    // Файл master.key перезаписан новым ключом.
    const stored = Buffer.from(
      (await readFile(masterKeyFilePath(tmpDir), 'utf-8')).trim(),
      'base64',
    );
    expect(stored.equals(newKey)).toBe(true);

    // На диске — только шифр.
    const raw = await readFile(credentialsPath(), 'utf-8');
    expect(raw).toContain('enc:v1:');
    expect(raw).not.toContain(ACCESS_TOKEN);
    expect(raw).not.toContain(REFRESH_TOKEN);

    // Новый инстанс читает токены новым ключом.
    clearMasterKeyCache();
    const reopened = credentialStore();
    expect(await reopened.reveal(id)).toEqual({
      accessToken: ACCESS_TOKEN,
      refreshToken: REFRESH_TOKEN,
    });

    // Старым ключом — decrypt_failed.
    clearMasterKeyCache();
    const withOld = new ExternalCredentialStore({
      dataDir: tmpDir,
      secretKey: oldKey.toString('base64'),
    });
    await expect(withOld.reveal(id)).rejects.toMatchObject({ code: 'decrypt_failed' });
  });

  it('dry-run ничего не меняет (доступы и master.key)', async () => {
    const id = await seed();
    const before = await readFile(credentialsPath(), 'utf-8');
    const beforeMaster = await readFile(masterKeyFilePath(tmpDir), 'utf-8');

    const result = await rotateSecretsMasterKey({
      dataDir: tmpDir,
      newKey: randomBytes(32).toString('base64'),
      dryRun: true,
      env: {},
    });

    expect(result.dryRun).toBe(true);
    expect(result.credentials.rotated).toBe(1);
    expect(result.credentials.ids).toEqual([id]);
    expect(await readFile(credentialsPath(), 'utf-8')).toBe(before);
    expect(await readFile(masterKeyFilePath(tmpDir), 'utf-8')).toBe(beforeMaster);

    // Старый ключ всё ещё работает.
    expect((await credentialStore().reveal(id))?.accessToken).toBe(ACCESS_TOKEN);
  });

  it('неверный старый ключ → preflight-отказ, ничего не изменено', async () => {
    const id = await seed();
    const before = await readFile(credentialsPath(), 'utf-8');
    const beforeMaster = await readFile(masterKeyFilePath(tmpDir), 'utf-8');

    const err = await rotateSecretsMasterKey({
      dataDir: tmpDir,
      oldKey: randomBytes(32).toString('base64'),
      newKey: randomBytes(32).toString('base64'),
      env: {},
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ExternalCredentialStoreError);
    expect((err as ExternalCredentialStoreError).code).toBe('preflight_failed');
    expect((err as ExternalCredentialStoreError).message).toContain(id);
    expect(await readFile(credentialsPath(), 'utf-8')).toBe(before);
    expect(await readFile(masterKeyFilePath(tmpDir), 'utf-8')).toBe(beforeMaster);
  });
});

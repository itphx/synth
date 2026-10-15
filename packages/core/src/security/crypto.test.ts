import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AUTH_TAG_LENGTH,
  CryptoError,
  ENCRYPTED_PREFIX,
  IV_LENGTH,
  SecretDecryptionError,
  clearMasterKeyCache,
  decryptSecret,
  encryptSecret,
  isEncrypted,
  resolveMasterKey,
} from './crypto.js';

const KEY = randomBytes(32);

const tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'synth-crypto-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  clearMasterKeyCache();
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('crypto: encrypt/decrypt (ADR-076)', () => {
  it('roundtrip сохраняет значение, включая unicode и пустую строку', () => {
    const values = ['', 'hello', 'ключ🔑\nвторая строка', 'a'.repeat(5000)];
    for (const value of values) {
      const token = encryptSecret(value, KEY);
      expect(isEncrypted(token)).toBe(true);
      expect(token.startsWith(ENCRYPTED_PREFIX)).toBe(true);
      expect(decryptSecret(token, KEY)).toBe(value);
    }
  });

  it('формат токена: enc:v1:<iv 12Б>:<tag 16Б>:<ct>', () => {
    const token = encryptSecret('data', KEY);
    const parts = token.slice(ENCRYPTED_PREFIX.length).split(':');
    expect(parts).toHaveLength(3);
    expect(Buffer.from(parts[0] ?? '', 'base64')).toHaveLength(IV_LENGTH);
    expect(Buffer.from(parts[1] ?? '', 'base64')).toHaveLength(AUTH_TAG_LENGTH);
  });

  it('не-enc:v1 значение возвращается как есть (back-compat plaintext)', () => {
    expect(isEncrypted('plain')).toBe(false);
    expect(decryptSecret('plain-private-key', KEY)).toBe('plain-private-key');
    expect(decryptSecret('encrypted:legacy-data', KEY)).toBe('encrypted:legacy-data');
  });

  it('tamper ciphertext → SecretDecryptionError', () => {
    const token = encryptSecret('secret-value', KEY);
    const parts = token.slice(ENCRYPTED_PREFIX.length).split(':');
    const iv = parts[0] ?? '';
    const tag = parts[1] ?? '';
    const ct = parts[2] ?? '';
    const mutated = Buffer.from(ct, 'base64');
    mutated.writeUInt8(mutated.readUInt8(0) ^ 0xff, 0);
    const tampered = `${ENCRYPTED_PREFIX}${iv}:${tag}:${mutated.toString('base64')}`;
    expect(() => decryptSecret(tampered, KEY)).toThrow(SecretDecryptionError);
  });

  it('tamper authTag → SecretDecryptionError', () => {
    const token = encryptSecret('secret-value', KEY);
    const parts = token.slice(ENCRYPTED_PREFIX.length).split(':');
    const iv = parts[0] ?? '';
    const tag = parts[1] ?? '';
    const ct = parts[2] ?? '';
    const mutated = Buffer.from(tag, 'base64');
    mutated.writeUInt8(mutated.readUInt8(0) ^ 0xff, 0);
    const tampered = `${ENCRYPTED_PREFIX}${iv}:${mutated.toString('base64')}:${ct}`;
    expect(() => decryptSecret(tampered, KEY)).toThrow(SecretDecryptionError);
  });

  it('неверный ключ → SecretDecryptionError', () => {
    const token = encryptSecret('secret-value', KEY);
    expect(() => decryptSecret(token, randomBytes(32))).toThrow(SecretDecryptionError);
  });

  it('битый формат токена → SecretDecryptionError', () => {
    expect(() => decryptSecret('enc:v1:only-two:parts', KEY)).toThrow(SecretDecryptionError);
    expect(() => decryptSecret('enc:v1:bad:bad:bad', KEY)).toThrow(SecretDecryptionError);
  });
});

describe('crypto: resolveMasterKey (ADR-076)', () => {
  it('env base64 (32 Б) используется и файл не создаётся', async () => {
    const dir = await makeTmpDir();
    const key = randomBytes(32);
    const result = await resolveMasterKey({ dataDir: dir, env: { SYNTH_SECRET_KEY: key.toString('base64') } });
    expect(result.source).toBe('env');
    expect(result.key.equals(key)).toBe(true);
    await expect(stat(join(dir, 'secrets', 'master.key'))).rejects.toThrow();
  });

  it('env hex (64 символа) принимается', async () => {
    const dir = await makeTmpDir();
    const key = randomBytes(32);
    const result = await resolveMasterKey({ dataDir: dir, env: { SYNTH_SECRET_KEY: key.toString('hex') } });
    expect(result.source).toBe('env');
    expect(result.key.equals(key)).toBe(true);
  });

  it('явный secretKey приоритетнее env', async () => {
    const dir = await makeTmpDir();
    const explicit = randomBytes(32);
    const fromEnv = randomBytes(32);
    const result = await resolveMasterKey({
      dataDir: dir,
      secretKey: explicit.toString('base64'),
      env: { SYNTH_SECRET_KEY: fromEnv.toString('hex') },
    });
    expect(result.key.equals(explicit)).toBe(true);
  });

  it('файл создаётся с правами 0600, каталог 0700; повторный вызов стабилен', async () => {
    const dir = await makeTmpDir();
    const first = await resolveMasterKey({ dataDir: dir, env: {} });
    expect(first.source).toBe('file');

    const secretsDir = join(dir, 'secrets');
    const filePath = join(secretsDir, 'master.key');
    expect((await stat(secretsDir)).mode & 0o777).toBe(0o700);
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);

    const raw = (await readFile(filePath, 'utf-8')).trim();
    expect(Buffer.from(raw, 'base64').equals(first.key)).toBe(true);

    const second = await resolveMasterKey({ dataDir: dir, env: {} });
    expect(second.key.equals(first.key)).toBe(true);

    // Сброс кэша → ключ читается из файла (эмуляция рестарта).
    clearMasterKeyCache();
    const third = await resolveMasterKey({ dataDir: dir, env: {} });
    expect(third.source).toBe('file');
    expect(third.key.equals(first.key)).toBe(true);
  });

  it('невалидный env → encryption_unavailable', async () => {
    const dir = await makeTmpDir();
    await expect(
      resolveMasterKey({ dataDir: dir, env: { SYNTH_SECRET_KEY: 'not-a-valid-key' } }),
    ).rejects.toMatchObject({ code: 'encryption_unavailable' });
    await expect(
      resolveMasterKey({ dataDir: dir, env: { SYNTH_SECRET_KEY: randomBytes(31).toString('base64') } }),
    ).rejects.toBeInstanceOf(CryptoError);
    await expect(
      resolveMasterKey({ dataDir: dir, secretKey: 'abc' }),
    ).rejects.toMatchObject({ code: 'encryption_unavailable' });
  });
});

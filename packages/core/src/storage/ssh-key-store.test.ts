import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SSHKeyStore, SSHKeyStoreError } from './ssh-key-store.js';
import { clearMasterKeyCache } from '../security/crypto.js';

const SECRET_MARKER = 'SUPERSECRETPRIVATEKEYMATERIAL';
const SAMPLE_KEY = `-----BEGIN OPENSSH PRIVATE KEY-----\n${SECRET_MARKER}\n-----END OPENSSH PRIVATE KEY-----`;

describe('SSHKeyStore (AD-076 §T2)', () => {
  let tmpDir: string;
  let store: SSHKeyStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-sshkeys-'));
    store = new SSHKeyStore({ dataDir: tmpDir });
  });

  afterEach(async () => {
    clearMasterKeyCache();
    await rm(tmpDir, { recursive: true, force: true });
  });

  function rawPath(id: string): string {
    return join(tmpDir, 'secrets', 'ssh-keys', `${id}.json`);
  }

  it('create возвращает метаданные без секретов', async () => {
    const created = await store.create({ name: 'deploy', privateKey: SAMPLE_KEY, passphrase: 'p@ss' });
    expect(created.id).toBeTruthy();
    expect(created.name).toBe('deploy');
    expect(created.type).toBe('user');
    expect(created.agentIds).toEqual([]);
    expect(created.createdAt).toBeTruthy();
    expect(created.updatedAt).toBe(created.createdAt);
    expect('privateKey' in created).toBe(false);
    expect('passphrase' in created).toBe(false);
  });

  it('list/get/listForAgent не содержат privateKey/passphrase', async () => {
    const a = await store.create({ name: 'a', privateKey: SAMPLE_KEY, agentIds: ['agent-1'] });
    await store.create({ name: 'b', privateKey: SAMPLE_KEY });

    const list = await store.list();
    expect(list).toHaveLength(2);
    for (const meta of list) {
      expect('privateKey' in meta).toBe(false);
      expect('passphrase' in meta).toBe(false);
    }

    const got = await store.get(a.id);
    expect(got?.name).toBe('a');
    expect(got && 'privateKey' in got).toBe(false);

    const forAgent = await store.listForAgent('agent-1');
    expect(forAgent.map((k) => k.id)).toEqual([a.id]);
    expect(await store.listForAgent('agent-missing')).toEqual([]);
    expect(await store.get('missing')).toBeNull();
  });

  it('в сыром JSON-файле нет plaintext, секреты зашифрованы enc:v1:', async () => {
    const created = await store.create({ name: 'raw', privateKey: SAMPLE_KEY, passphrase: 'p@ss' });
    const raw = await readFile(rawPath(created.id), 'utf-8');
    expect(raw).toContain('enc:v1:');
    expect(raw).not.toContain(SECRET_MARKER);
    expect(raw).not.toContain('p@ss');
  });

  it('reveal возвращает исходные секреты', async () => {
    const created = await store.create({ name: 'reveal', privateKey: SAMPLE_KEY, passphrase: 'p@ss' });
    expect(await store.reveal(created.id)).toEqual({ privateKey: SAMPLE_KEY, passphrase: 'p@ss' });
    expect(await store.reveal('missing')).toBeNull();
  });

  it('reveal работает без passphrase', async () => {
    const created = await store.create({ name: 'nopass', privateKey: SAMPLE_KEY });
    expect(await store.reveal(created.id)).toEqual({ privateKey: SAMPLE_KEY });
  });

  it('update — частичный merge, updatedAt меняется, createdAt/секреты сохраняются', async () => {
    const created = await store.create({ name: 'upd', privateKey: SAMPLE_KEY, passphrase: 'p@ss' });
    const updated = await store.update(created.id, { name: 'upd-2', type: 'deploy', agentIds: ['a1'] });
    expect(updated?.id).toBe(created.id);
    expect(updated?.name).toBe('upd-2');
    expect(updated?.type).toBe('deploy');
    expect(updated?.agentIds).toEqual(['a1']);
    expect(updated?.createdAt).toBe(created.createdAt);
    expect(await store.reveal(created.id)).toEqual({ privateKey: SAMPLE_KEY, passphrase: 'p@ss' });
  });

  it('update перешифровывает privateKey/passphrase', async () => {
    const created = await store.create({ name: 'reenc', privateKey: SAMPLE_KEY, passphrase: 'old' });
    await store.update(created.id, { privateKey: SAMPLE_KEY + '\n2', passphrase: 'new' });
    expect(await store.reveal(created.id)).toEqual({ privateKey: SAMPLE_KEY + '\n2', passphrase: 'new' });
  });

  it('update несуществующего id → null', async () => {
    expect(await store.update('missing', { name: 'x' })).toBeNull();
  });

  it('delete удаляет, повторно → false', async () => {
    const created = await store.create({ name: 'del', privateKey: SAMPLE_KEY });
    expect(await store.delete(created.id)).toBe(true);
    expect(await store.get(created.id)).toBeNull();
    expect(await store.delete(created.id)).toBe(false);
  });

  it('name-конфликт (case-insensitive) → name_exists при create и update', async () => {
    const first = await store.create({ name: 'Unique', privateKey: SAMPLE_KEY });
    await expect(store.create({ name: 'unique', privateKey: SAMPLE_KEY })).rejects.toMatchObject({
      code: 'name_exists',
    });

    const second = await store.create({ name: 'Other', privateKey: SAMPLE_KEY });
    await expect(store.update(second.id, { name: 'UNIQUE' })).rejects.toMatchObject({
      code: 'name_exists',
    });
    // Смена только регистра собственного имени разрешена.
    const solo = await store.create({ name: 'Solo', privateKey: SAMPLE_KEY });
    const renamed = await store.update(solo.id, { name: 'SOLO' });
    expect(renamed?.name).toBe('SOLO');
    expect(first.id).not.toBe(second.id);
  });

  it('пустой privateKey → ошибка', async () => {
    await expect(store.create({ name: 'empty', privateKey: '   ' })).rejects.toBeInstanceOf(
      SSHKeyStoreError,
    );
    const created = await store.create({ name: 'ok', privateKey: SAMPLE_KEY });
    await expect(store.update(created.id, { privateKey: '' })).rejects.toBeInstanceOf(SSHKeyStoreError);
  });

  it('link/unlink идемпотентны', async () => {
    const created = await store.create({ name: 'links', privateKey: SAMPLE_KEY, agentIds: ['a1'] });
    expect((await store.linkAgent(created.id, 'a1'))?.agentIds).toEqual(['a1']);
    expect((await store.linkAgent(created.id, 'a2'))?.agentIds).toEqual(['a1', 'a2']);
    expect((await store.unlinkAgent(created.id, 'a2'))?.agentIds).toEqual(['a1']);
    expect((await store.unlinkAgent(created.id, 'a3'))?.agentIds).toEqual(['a1']);
    expect(await store.linkAgent('missing', 'a1')).toBeNull();
    expect(await store.unlinkAgent('missing', 'a1')).toBeNull();
  });

  it('повторный reveal после перезапуска (новый инстанс store) работает', async () => {
    const created = await store.create({ name: 'persist', privateKey: SAMPLE_KEY, passphrase: 'p@ss' });
    clearMasterKeyCache();

    const restarted = new SSHKeyStore({ dataDir: tmpDir });
    expect(await restarted.reveal(created.id)).toEqual({ privateKey: SAMPLE_KEY, passphrase: 'p@ss' });
    expect((await restarted.list())[0]?.name).toBe('persist');
  });

  it('tamper зашифрованного файла → reveal с кодом decrypt_failed', async () => {
    const created = await store.create({ name: 'tamper', privateKey: SAMPLE_KEY });
    const path = rawPath(created.id);
    const record = JSON.parse(await readFile(path, 'utf-8')) as { privateKey: string };
    const parts = record.privateKey.slice('enc:v1:'.length).split(':');
    const iv = parts[0] ?? '';
    const tag = parts[1] ?? '';
    const ct = parts[2] ?? '';
    const mutated = Buffer.from(ct, 'base64');
    mutated.writeUInt8(mutated.readUInt8(0) ^ 0xff, 0);
    record.privateKey = `enc:v1:${iv}:${tag}:${mutated.toString('base64')}`;
    await writeFile(path, JSON.stringify(record), 'utf-8');

    await expect(store.reveal(created.id)).rejects.toMatchObject({ code: 'decrypt_failed' });
  });

  it('невалидный мастер-ключ → encryption_unavailable', async () => {
    const bad = new SSHKeyStore({ dataDir: tmpDir, secretKey: 'not-a-valid-key' });
    await expect(bad.create({ name: 'x', privateKey: SAMPLE_KEY })).rejects.toMatchObject({
      code: 'encryption_unavailable',
    });
  });

  it('id уникален и не зависит от имени', async () => {
    const created = await store.create({ name: 'uuid', privateKey: SAMPLE_KEY });
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.id).not.toBe(randomUUID());
  });
});

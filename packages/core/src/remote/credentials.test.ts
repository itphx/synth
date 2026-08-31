import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, stat, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadCredentials, saveCredentials, clearCredentials } from './credentials.js';
import type { RemoteCredentials } from './types.js';

describe('credentials', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'synth-cred-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function filePath(name = 'credentials.json'): string {
    return join(dir, name);
  }

  function makeCreds(overrides: Partial<RemoteCredentials> = {}): RemoteCredentials {
    return {
      backendUrl: 'https://synth.example.loc',
      accessToken: 'token-1',
      refreshToken: 'refresh-1',
      expiresAt: '2026-09-01T00:00:00.000Z',
      user: { id: 'u1', username: 'admin', roles: ['ADMIN'] },
      ...overrides,
    };
  }

  it('round-trip: save → load возвращает те же credentials', async () => {
    const creds = makeCreds();
    await saveCredentials(creds, filePath());
    const loaded = await loadCredentials(creds.backendUrl, filePath());
    expect(loaded).toEqual(creds);
  });

  it('файл credentials имеет права 0600', async () => {
    await saveCredentials(makeCreds(), filePath());
    const st = await stat(filePath());
    expect(st.mode & 0o777).toBe(0o600);
  });

  it('хранит несколько backendUrl в одном файле', async () => {
    const a = makeCreds({ backendUrl: 'https://a.example.loc', accessToken: 'a' });
    const b = makeCreds({ backendUrl: 'https://b.example.loc', accessToken: 'b' });
    await saveCredentials(a, filePath());
    await saveCredentials(b, filePath());
    expect(await loadCredentials(a.backendUrl, filePath())).toEqual(a);
    expect(await loadCredentials(b.backendUrl, filePath())).toEqual(b);
  });

  it('clear удаляет запись; при пустом файле файл удаляется', async () => {
    await saveCredentials(makeCreds(), filePath());
    await clearCredentials('https://synth.example.loc', filePath());
    expect(await loadCredentials('https://synth.example.loc', filePath())).toBeNull();
    await expect(access(filePath())).rejects.toThrow();
  });

  it('clear не трогает записи других backendUrl', async () => {
    const a = makeCreds({ backendUrl: 'https://a.example.loc', accessToken: 'a' });
    const b = makeCreds({ backendUrl: 'https://b.example.loc', accessToken: 'b' });
    await saveCredentials(a, filePath());
    await saveCredentials(b, filePath());
    await clearCredentials(a.backendUrl, filePath());
    expect(await loadCredentials(a.backendUrl, filePath())).toBeNull();
    expect(await loadCredentials(b.backendUrl, filePath())).toEqual(b);
  });

  it('несовпадение backendUrl → null', async () => {
    await saveCredentials(makeCreds({ backendUrl: 'https://a.example.loc' }), filePath());
    expect(await loadCredentials('https://b.example.loc', filePath())).toBeNull();
  });

  it('отсутствующий файл → null', async () => {
    expect(await loadCredentials('https://a.example.loc', filePath('missing.json'))).toBeNull();
  });
});

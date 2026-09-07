import { describe, it, expect, vi, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Реестр профилей перенаправляем на временный файл, чтобы тест НЕ читал реальный
// ~/.config/synth/profiles.json (listProfiles/getLastProfile в app.ts вызываются
// без path). ensureProfile пишем с явным path — на тот же временный реестр.
const mockTmpRoot = mkdtempSync(join(tmpdir(), 'synth-profiles-status-'));
const mockProfilesPath = join(mockTmpRoot, 'profiles.json');

vi.mock('../profiles.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../profiles.js')>();
  return {
    ...actual,
    listProfiles: (path?: string) => actual.listProfiles(path ?? mockProfilesPath),
    getLastProfile: (path?: string) => actual.getLastProfile(path ?? mockProfilesPath),
  };
});

import { mkdtemp, rm } from 'node:fs/promises';
import { createStandaloneApp } from './app.js';
import { ensureProfile } from '../profiles.js';

describe('createStandaloneApp: /api/v2/hybrid/status отдаёт knownServers/lastServer из реестра профилей', () => {
  afterAll(() => {
    rmSync(mockTmpRoot, { recursive: true, force: true });
  });

  it('реестр пуст → knownServers: [], lastServer: null', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'synth-app-hybrid-profiles-'));
    try {
      const handle = await createStandaloneApp({ port: 0, dataDir: dir, apiKey: 'test-key', hybridEnabled: true });
      const res = await handle.app.request('/api/v2/hybrid/status');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { knownServers: string[]; lastServer: string | null };
      expect(body.knownServers).toEqual([]);
      expect(body.lastServer).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('профили в реестре → knownServers (свежие первыми) и lastServer из lastProfileId', async () => {
    // Старый сервер входим первым, свежий — вторым (последний = lastProfileId).
    await ensureProfile('https://old.example.loc', { username: 'dev' }, mockProfilesPath);
    await new Promise((r) => setTimeout(r, 5));
    await ensureProfile('https://synth.k3s.itphx.loc', { username: 'admin' }, mockProfilesPath);

    const dir = await mkdtemp(join(tmpdir(), 'synth-app-hybrid-profiles-'));
    try {
      const handle = await createStandaloneApp({ port: 0, dataDir: dir, apiKey: 'test-key', hybridEnabled: true });
      const res = await handle.app.request('/api/v2/hybrid/status');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { knownServers: string[]; lastServer: string | null };
      // listProfiles сортирует по lastUsedAt desc — свежий сервер первым.
      expect(body.knownServers).toEqual(['https://synth.k3s.itphx.loc', 'https://old.example.loc']);
      expect(body.lastServer).toBe('https://synth.k3s.itphx.loc');
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
});

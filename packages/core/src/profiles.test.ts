import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, stat, access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  profileIdForUrl,
  profileDataDir,
  profileCredentialsPath,
  loadProfiles,
  listProfiles,
  getLastProfile,
  findProfileByUrl,
  ensureProfile,
  removeProfile,
  migrateCredentialsToProfile,
} from './profiles.js';
import { saveCredentials, loadCredentials } from './remote/credentials.js';
import type { RemoteCredentials } from './remote/types.js';

describe('profiles', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'synth-profile-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function registryPath(): string {
    return join(dir, 'profiles.json');
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

  describe('profileIdForUrl', () => {
    it('строит корректный slug из hostname (точки → дефисы)', () => {
      expect(profileIdForUrl('https://synth.k3s.itphx.loc')).toBe('synth-k3s-itphx-loc');
    });

    it('учитывает нестандартный порт и игнорирует завершающий слэш', () => {
      expect(profileIdForUrl('https://synth.k3s.itphx.loc:8443/')).toBe('synth-k3s-itphx-loc-8443');
    });

    it('не добавляет стандартный порт схемы', () => {
      expect(profileIdForUrl('https://synth.k3s.itphx.loc:443')).toBe('synth-k3s-itphx-loc');
      expect(profileIdForUrl('http://synth.example.loc:80')).toBe('synth-example-loc');
    });

    it('учитывает порт для http', () => {
      expect(profileIdForUrl('http://localhost:5000')).toBe('localhost-5000');
    });
  });

  describe('profileDataDir / profileCredentialsPath', () => {
    it('строит каталог профиля внутри base', () => {
      expect(profileDataDir(dir, 'synth-k3s-itphx-loc')).toBe(
        join(dir, 'profiles', 'synth-k3s-itphx-loc'),
      );
    });

    it('строит путь к credentials профиля', () => {
      expect(profileCredentialsPath(dir, 'synth-k3s-itphx-loc')).toBe(
        join(dir, 'profiles', 'synth-k3s-itphx-loc', 'credentials.json'),
      );
    });
  });

  describe('ensureProfile', () => {
    it('создаёт профиль и выставляет lastProfileId', async () => {
      const profile = await ensureProfile(
        'https://synth.k3s.itphx.loc',
        { username: 'admin', label: 'synth.k3s.itphx.loc' },
        registryPath(),
      );
      expect(profile.id).toBe('synth-k3s-itphx-loc');
      expect(profile.url).toBe('https://synth.k3s.itphx.loc');
      expect(profile.label).toBe('synth.k3s.itphx.loc');
      expect(profile.username).toBe('admin');
      expect(profile.lastUsedAt).toBeTruthy();

      const list = await listProfiles(registryPath());
      expect(list).toHaveLength(1);
      expect((await loadProfiles(registryPath())).lastProfileId).toBe('synth-k3s-itphx-loc');
    });

    it('нормализует url (убирает завершающие слэши)', async () => {
      const profile = await ensureProfile('https://synth.example.loc///', {}, registryPath());
      expect(profile.url).toBe('https://synth.example.loc');
    });

    it('повторный вызов обновляет lastUsedAt/username и не дублирует', async () => {
      const old = '2020-01-01T00:00:00.000Z';
      await writeFile(
        registryPath(),
        JSON.stringify({
          version: 1,
          lastProfileId: 'synth-example-loc',
          profiles: [
            { id: 'synth-example-loc', url: 'https://synth.example.loc', lastUsedAt: old, username: 'first' },
          ],
        }),
      );

      const profile = await ensureProfile('https://synth.example.loc', { username: 'admin' }, registryPath());
      expect(profile.username).toBe('admin');

      const list = await listProfiles(registryPath());
      expect(list).toHaveLength(1);
      expect(list[0]?.id).toBe('synth-example-loc');
      expect(list[0]?.username).toBe('admin');
      expect(Date.parse(list[0]!.lastUsedAt!)).toBeGreaterThan(Date.parse(old));
    });

    it('при коллизии hostname добавляет короткий хэш url', async () => {
      const first = await ensureProfile('https://synth.example.loc', {}, registryPath());
      const second = await ensureProfile('http://synth.example.loc', {}, registryPath());
      expect(first.id).toBe('synth-example-loc');
      expect(second.id).toMatch(/^synth-example-loc-[0-9a-f]+$/);
      expect(second.id).not.toBe(first.id);

      const list = await listProfiles(registryPath());
      expect(list).toHaveLength(2);
      expect(list.some((p) => p.url === 'https://synth.example.loc')).toBe(true);
      expect(list.some((p) => p.url === 'http://synth.example.loc')).toBe(true);
    });

    it('пишет реестр с правами 0600', async () => {
      await ensureProfile('https://synth.example.loc', {}, registryPath());
      const st = await stat(registryPath());
      expect(st.mode & 0o777).toBe(0o600);
    });
  });

  describe('listProfiles / getLastProfile / findProfileByUrl', () => {
    it('сортирует профили по свежести (desc)', async () => {
      await writeFile(
        registryPath(),
        JSON.stringify({
          version: 1,
          lastProfileId: 'old',
          profiles: [
            { id: 'mid', url: 'https://mid.example.loc', lastUsedAt: '2026-01-02T00:00:00.000Z' },
            { id: 'new', url: 'https://new.example.loc', lastUsedAt: '2026-01-03T00:00:00.000Z' },
            { id: 'old', url: 'https://old.example.loc', lastUsedAt: '2026-01-01T00:00:00.000Z' },
          ],
        }),
      );

      const list = await listProfiles(registryPath());
      expect(list.map((p) => p.id)).toEqual(['new', 'mid', 'old']);
    });

    it('getLastProfile возвращает профиль по lastProfileId (не по свежести)', async () => {
      await writeFile(
        registryPath(),
        JSON.stringify({
          version: 1,
          lastProfileId: 'old',
          profiles: [
            { id: 'new', url: 'https://new.example.loc', lastUsedAt: '2026-01-03T00:00:00.000Z' },
            { id: 'old', url: 'https://old.example.loc', lastUsedAt: '2026-01-01T00:00:00.000Z' },
          ],
        }),
      );

      const last = await getLastProfile(registryPath());
      expect(last?.id).toBe('old');
    });

    it('getLastProfile/loadProfiles при отсутствии файла → null/пустой реестр', async () => {
      expect(await getLastProfile(registryPath())).toBeNull();
      const file = await loadProfiles(registryPath());
      expect(file.profiles).toEqual([]);
      expect(file.lastProfileId).toBeNull();
    });

    it('findProfileByUrl находит по нормализованному url и не находит чужой', async () => {
      await ensureProfile('https://synth.example.loc', {}, registryPath());
      expect((await findProfileByUrl('https://synth.example.loc/', registryPath()))?.id).toBe(
        'synth-example-loc',
      );
      expect(await findProfileByUrl('https://other.example.loc', registryPath())).toBeNull();
    });
  });

  describe('removeProfile', () => {
    it('удаляет по id и по url; чужой url не трогает', async () => {
      await ensureProfile('https://a.example.loc', {}, registryPath());
      await ensureProfile('https://b.example.loc', {}, registryPath());

      await removeProfile('https://a.example.loc', registryPath());
      expect((await listProfiles(registryPath())).map((p) => p.id)).toEqual(['b-example-loc']);

      await removeProfile('b-example-loc', registryPath());
      expect(await listProfiles(registryPath())).toEqual([]);

      // реестр пуст — файл удалён
      await expect(access(registryPath())).rejects.toThrow();
    });
  });

  describe('migrateCredentialsToProfile', () => {
    it('переносит запись из глобального файла в профильный и удаляет из глобального', async () => {
      const url = 'https://synth.example.loc';
      const globalPath = join(dir, 'global-credentials.json');
      const a = makeCreds({ backendUrl: url, accessToken: 'tok-a' });
      const b = makeCreds({ backendUrl: 'https://other.example.loc', accessToken: 'tok-b' });
      await saveCredentials(a, globalPath);
      await saveCredentials(b, globalPath);

      const migrated = await migrateCredentialsToProfile(url, dir, 'synth-example-loc', globalPath);
      expect(migrated).toBe(true);

      // из глобального удалена, другие записи целы
      expect(await loadCredentials(url, globalPath)).toBeNull();
      expect(await loadCredentials('https://other.example.loc', globalPath)).toEqual(b);

      // в профильном файле появилась
      const profileCredPath = profileCredentialsPath(dir, 'synth-example-loc');
      expect(await loadCredentials(url, profileCredPath)).toEqual(a);
    });

    it('при отсутствии записи — no-op (глобальный файл не меняется)', async () => {
      const url = 'https://synth.example.loc';
      const globalPath = join(dir, 'global-credentials.json');
      const a = makeCreds({ backendUrl: url });
      await saveCredentials(a, globalPath);

      const migrated = await migrateCredentialsToProfile(
        'https://absent.example.loc',
        dir,
        'absent-example-loc',
        globalPath,
      );
      expect(migrated).toBe(false);
      expect(await loadCredentials(url, globalPath)).toEqual(a);
      await expect(access(profileCredentialsPath(dir, 'absent-example-loc'))).rejects.toThrow();
    });
  });
});

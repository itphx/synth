// ADR-133: тесты проверки обновлений — каналы, реестры, кэш по каналам, ошибки.
//
// Сеть не используется: `egressFetch` подменён моком, `fetchDistTags` принимает
// `fetchImpl` явно. Каталог данных — временный (`mkdtemp`).
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));

vi.mock('./security/tls.js', () => ({
  egressFetch: fetchMock,
}));

import {
  checkForUpdates,
  compareVersions,
  fetchDistTags,
  isNewer,
  packageMetadataUrl,
  parseVersion,
  resolveUpdateChannel,
  resolveUpdatesRegistry,
} from './update-checker.js';

/** JSON-ответ реестра. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Метаданные пакета с dist-tags. */
function metadata(tags: Record<string, string>): unknown {
  return { 'dist-tags': tags, versions: {} };
}

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'synth-updates-'));
  fetchMock.mockReset();
});

afterEach(() => {
  fetchMock.mockReset();
});

describe('канал и реестр (ADR-133)', () => {
  it('auto: релизная версия → stable, пре-релиз → beta', () => {
    expect(resolveUpdateChannel('0.13.7')).toBe('stable');
    expect(resolveUpdateChannel('0.13.7-beta.1')).toBe('beta');
    expect(resolveUpdateChannel('1.0.0-rc.1')).toBe('stable');
  });

  it('явный override важнее версии', () => {
    expect(resolveUpdateChannel('0.13.7', 'beta')).toBe('beta');
    expect(resolveUpdateChannel('0.13.7-beta.1', 'stable')).toBe('stable');
  });

  it('реестр канала: stable — npmjs, beta — Gitea; хвостовой `/` снимается', () => {
    expect(resolveUpdatesRegistry('stable', {})).toBe('https://registry.npmjs.org');
    expect(resolveUpdatesRegistry('beta', {})).toBe('https://git.itphx.ru/api/packages/itphx/npm');
    expect(
      resolveUpdatesRegistry('beta', { betaRegistry: 'https://example.test/npm///' }),
    ).toBe('https://example.test/npm');
    expect(packageMetadataUrl('https://example.test/npm/')).toBe(
      'https://example.test/npm/@itphx%2Fsynth',
    );
  });

  it('сравнение версий пре-релиз-aware: beta ниже релиза', () => {
    expect(compareVersions('0.13.7', '0.13.7-beta.1')).toBeGreaterThan(0);
    expect(compareVersions('0.13.7-beta.1', '0.13.7')).toBeLessThan(0);
  });

  it('пре-релиз следующей базовой версии выше текущего релиза', () => {
    // Регрессия: `parseVersion` не отрезал суффикс, `9-beta` → NaN → patch 0.
    expect(parseVersion('0.13.9-beta.1')).toEqual([0, 13, 9]);
    expect(compareVersions('0.13.9-beta.1', '0.13.7')).toBeGreaterThan(0);
    expect(isNewer('0.13.9-beta.1', '0.13.7')).toBe(true);
  });
});

describe('fetchDistTags', () => {
  it('запрашивает @itphx%2Fsynth и возвращает dist-tags', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse(metadata({ latest: '1.2.3', beta: '1.3.0-beta.1' })),
    );
    const tags = await fetchDistTags('https://registry.test', fetchImpl);

    expect(tags).toEqual({ latest: '1.2.3', beta: '1.3.0-beta.1' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://registry.test/@itphx%2Fsynth');
    expect((init as RequestInit).headers).toMatchObject({ Accept: 'application/json' });
  });

  it('при 404 пробует «сырой» путь @itphx/synth', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('not found', { status: 404 }))
      .mockResolvedValueOnce(jsonResponse(metadata({ latest: '2.0.0' })));

    const tags = await fetchDistTags('https://registry.test', fetchImpl);
    expect(tags).toEqual({ latest: '2.0.0' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1]![0]).toBe('https://registry.test/@itphx/synth');
  });

  it('ошибка HTTP — понятный текст без URL с токенами', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 500 }));
    const err = await fetchDistTags('https://user:token@registry.test', fetchImpl).catch(
      (e: unknown) => e as Error,
    );
    expect(err.message).toContain('HTTP 500');
    expect(err.message).not.toContain('token');
  });
});

describe('checkForUpdates: кэш по каналам (ADR-133)', () => {
  it('второй вызов того же канала — без сети; другой канал — свой запрос', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      String(url).includes('git.itphx.ru')
        ? jsonResponse(metadata({ beta: '99.0.0-beta.1' }))
        : jsonResponse(metadata({ latest: '99.0.0' })),
    );

    const stable1 = await checkForUpdates(dataDir, { channel: 'stable' });
    expect(stable1.channel).toBe('stable');
    expect(stable1.hasUpdate).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const stable2 = await checkForUpdates(dataDir, { channel: 'stable' });
    expect(stable2.latestVersion).toBe(stable1.latestVersion);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const beta = await checkForUpdates(dataDir, { channel: 'beta' });
    expect(beta.channel).toBe('beta');
    expect(beta.latestVersion).toBe('99.0.0-beta.1');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('force игнорирует кэш', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(metadata({ latest: '99.0.0' })));

    await checkForUpdates(dataDir, { channel: 'stable' });
    await checkForUpdates(dataDir, { channel: 'stable' });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await checkForUpdates(dataDir, { channel: 'stable', force: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('ошибка кэшируется на 1 ч и не ломает фоновый режим', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    const first = await checkForUpdates(dataDir, {
      channel: 'stable',
      background: true,
      updates: { stableRegistry: 'https://registry.test' },
    });
    expect(first.error).toContain('ECONNREFUSED');
    expect(first.hasUpdate).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Ошибка ещё свежая — повторный фоновый тик сеть не трогает.
    const second = await checkForUpdates(dataDir, {
      channel: 'stable',
      background: true,
      updates: { stableRegistry: 'https://registry.test' },
    });
    expect(second.error).toContain('ECONNREFUSED');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('явная проверка (force) пробрасывает сетевую ошибку', async () => {
    fetchMock.mockRejectedValue(new Error('ETIMEDOUT'));
    await expect(checkForUpdates(dataDir, { channel: 'stable', force: true })).rejects.toThrow(
      'ETIMEDOUT',
    );
  });

  it('legacy плоский кэш читается как stable', async () => {
    await writeFile(
      join(dataDir, 'update-check.json'),
      JSON.stringify({
        currentVersion: '0.1.0',
        latestVersion: '0.2.0',
        hasUpdate: true,
        checkedAt: '2026-01-01T00:00:00.000Z',
        _ts: Date.now(),
      }),
      'utf-8',
    );

    const info = await checkForUpdates(dataDir, { channel: 'stable' });
    expect(info.latestVersion).toBe('0.2.0');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

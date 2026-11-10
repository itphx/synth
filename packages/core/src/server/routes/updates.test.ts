// ADR-133: тесты HTTP-контура обновлений — `?force=1`, канал, admission-гейт,
// рестарт после установки. Сеть/установка/рестарт инжектируются.
import { describe, expect, it, vi } from 'vitest';
import type { AuthKit } from '../../auth/local.js';
import { createUpdateRoutes } from './updates.js';

const { checkMock, latestMock, versionsMock } = vi.hoisted(() => ({
  checkMock: vi.fn(),
  latestMock: vi.fn(),
  versionsMock: vi.fn(),
}));

vi.mock('../../update-checker.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../update-checker.js')>();
  return {
    ...actual,
    checkForUpdates: checkMock,
    fetchLatestVersion: latestMock,
    fetchAvailableVersions: versionsMock,
  };
});

/** Pass-through guard (RBAC тестирует backend отдельно). */
const auth = {
  requireAuth: async (_c: unknown, next: () => Promise<void>) => next(),
} as unknown as AuthKit;

/** Разбор SSE-тела в массив событий. */
function parseEvents(text: string): Array<Record<string, unknown>> {
  return text
    .split('\n\n')
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.startsWith('data: '))
    .map((chunk) => JSON.parse(chunk.slice('data: '.length)) as Record<string, unknown>);
}

describe('GET /api/v2/updates/check (ADR-133)', () => {
  it('прокидывает force=1 и channel=beta в проверку', async () => {
    checkMock.mockResolvedValue({
      currentVersion: '0.13.7',
      latestVersion: '0.14.0-beta.1',
      channel: 'beta',
      prerelease: true,
      registry: 'https://git.itphx.ru/api/packages/itphx/npm',
      hasUpdate: true,
      checkedAt: '2026-01-01T00:00:00.000Z',
    });

    const app = createUpdateRoutes(auth, '/tmp/unused', {
      updates: { betaRegistry: 'https://git.itphx.ru/api/packages/itphx/npm/' },
    });
    const res = await app.request('/check?channel=beta&force=1');

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.channel).toBe('beta');
    expect(checkMock).toHaveBeenCalledWith('/tmp/unused', {
      channel: 'beta',
      updates: { betaRegistry: 'https://git.itphx.ru/api/packages/itphx/npm/' },
      force: true,
    });
  });

  it('невалидный channel → 400', async () => {
    const app = createUpdateRoutes(auth, '/tmp/unused');
    const res = await app.request('/check?channel=nightly');
    expect(res.status).toBe(400);
  });

  it('сетевая ошибка → 502 UPDATE_CHECK_FAILED', async () => {
    checkMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const app = createUpdateRoutes(auth, '/tmp/unused');
    const res = await app.request('/check?force=1');
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('UPDATE_CHECK_FAILED');
  });
});

describe('POST /api/v2/updates/apply (ADR-133)', () => {
  it('admission-гейт: supported:false → 409 UPDATE_UNSUPPORTED', async () => {
    const app = createUpdateRoutes(auth, '/tmp/unused', {
      selfUpdateSupport: () => ({ supported: false, reason: 'container' }),
    });
    const res = await app.request('/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; reason?: string } };
    expect(body.error.code).toBe('UPDATE_UNSUPPORTED');
    expect(body.error.reason).toBe('container');
    expect(latestMock).not.toHaveBeenCalled();
  });

  it('restart:true при поддержанном рестарте → restartScheduled:true', async () => {
    latestMock.mockResolvedValue('1.2.3');
    const requestRestart = vi.fn(async () => ({ accepted: true }));

    const app = createUpdateRoutes(auth, '/tmp/unused', {
      selfUpdateSupport: () => ({ supported: true }),
      npmInstall: async () => 0,
      getRestartStatus: () => ({ supported: true }),
      requestRestart,
    });
    const res = await app.request('/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ restart: true }),
    });

    expect(res.status).toBe(200);
    const events = parseEvents(await res.text());
    const done = events.find((e) => e.type === 'done');
    expect(done).toMatchObject({ version: '1.2.3', restartScheduled: true });
    // Рестарт запрашивается после `done` (микрозадача после закрытия потока).
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(requestRestart).toHaveBeenCalledTimes(1);
  });

  it('restart:true без поддержки → restartScheduled:false, рестарт не запрашивается', async () => {
    latestMock.mockResolvedValue('1.2.3');
    const requestRestart = vi.fn(async () => ({ accepted: false }));

    const app = createUpdateRoutes(auth, '/tmp/unused', {
      selfUpdateSupport: () => ({ supported: true }),
      npmInstall: async () => 0,
      getRestartStatus: () => ({ supported: false }),
      requestRestart,
    });
    const res = await app.request('/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ restart: true }),
    });

    const events = parseEvents(await res.text());
    const done = events.find((e) => e.type === 'done');
    expect(done).toMatchObject({ restartScheduled: false });
    expect(requestRestart).not.toHaveBeenCalled();
  });

  it('явная версия вне реестра канала → 400', async () => {
    versionsMock.mockResolvedValue(['1.0.0']);
    const app = createUpdateRoutes(auth, '/tmp/unused', {
      selfUpdateSupport: () => ({ supported: true }),
    });
    const res = await app.request('/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: '9.9.9' }),
    });
    expect(res.status).toBe(400);
  });

  it('dist-tag вместо версии → 400', async () => {
    const app = createUpdateRoutes(auth, '/tmp/unused', {
      selfUpdateSupport: () => ({ supported: true }),
    });
    const res = await app.request('/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: 'beta' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('RBAC-граница /api/v2/updates (инвариант 16)', () => {
  /** Guard, который всегда отказывает (как `requirePermission('ADMIN')` для USER). */
  const forbidden = (async (c: { json: (body: unknown, status: 403) => Response }) =>
    c.json({ error: { code: 'FORBIDDEN' } }, 403)) as never;

  it('readGuard: /check → 403, проверка не вызывается', async () => {
    checkMock.mockClear();
    const app = createUpdateRoutes(auth, '/tmp/unused', {}, { readGuard: forbidden });
    const res = await app.request('/check?force=1');
    expect(res.status).toBe(403);
    expect(checkMock).not.toHaveBeenCalled();
  });

  it('writeGuard: /apply → 403, версия не запрашивается и установка не идёт', async () => {
    latestMock.mockClear();
    versionsMock.mockClear();
    const npmInstall = vi.fn(async () => 0);
    const app = createUpdateRoutes(auth, '/tmp/unused', {
      selfUpdateSupport: () => ({ supported: true }),
      npmInstall,
    }, { writeGuard: forbidden });
    const res = await app.request('/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
    expect(latestMock).not.toHaveBeenCalled();
    expect(versionsMock).not.toHaveBeenCalled();
    expect(npmInstall).not.toHaveBeenCalled();
  });

  it('дефолт без opts — прежнее поведение: guard = auth.requireAuth', async () => {
    const deniedAuth = { requireAuth: forbidden } as unknown as AuthKit;
    checkMock.mockClear();
    const app = createUpdateRoutes(deniedAuth, '/tmp/unused');
    expect((await app.request('/check')).status).toBe(403);
    expect((await app.request('/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })).status).toBe(403);
    expect(checkMock).not.toHaveBeenCalled();
  });
});

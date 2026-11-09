/**
 * Публичные роуты, которые UI запрашивает ДО аутентификации (аудит F13):
 * на экране входа консоль браузера не должна показывать 401/404.
 *
 * `GET /api/config/themes` регистрируется в `app.ts` до `requireAuth`
 * (заглушка UI), `GET /auth/locales` и `GET /auth/defaults` — публичные
 * маршруты core-фабрики auth (паритет с backend).
 */
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createStandaloneApp } from './app.js';

describe('createStandaloneApp: публичные роуты экрана входа (без auth)', () => {
  it('GET /api/config/themes, /auth/locales, /auth/defaults → 200', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'synth-app-public-routes-'));
    try {
      const handle = await createStandaloneApp({ port: 0, dataDir: dir, apiKey: 'test-key' });

      const themes = await handle.app.request('/api/config/themes');
      expect(themes.status).toBe(200);
      expect(await themes.json()).toEqual({ themes: [] });

      const locales = await handle.app.request('/auth/locales');
      expect(locales.status).toBe(200);
      expect(await locales.json()).toEqual({
        locales: [
          { code: 'ru', name: 'Russian', native_name: 'Русский' },
          { code: 'en', name: 'English', native_name: 'English' },
        ],
        default: 'ru',
      });

      const defaults = await handle.app.request('/auth/defaults');
      expect(defaults.status).toBe(200);
      expect(await defaults.json()).toEqual({
        locale: 'ru',
        themeMode: 'system',
        theme: 'synthesis',
        uiScaleMobile: null,
        uiScaleDesktop: null,
        chatViewMode: null,
        chatDensity: null,
        chatScaleMobile: null,
        chatScaleDesktop: null,
      });

      // Контроль: `/api/*` по-прежнему под guard'ом (маршрут тем не «сломал» его).
      const protectedRes = await handle.app.request('/api/v2/sessions');
      expect(protectedRes.status).toBe(401);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('GET /auth/defaults: сохранённые умолчания перекрывают встроенные', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'synth-app-public-defaults-'));
    try {
      // Файл порта `DefaultsRepository` (`{dataDir}/defaults.json`) — тот же,
      // что читает/пишет UI через `PUT /auth/defaults` в managed-сборке.
      await writeFile(
        join(dir, 'defaults.json'),
        JSON.stringify({ locale: 'en', theme: 'nord', chatDensity: 'compact' }),
      );
      const handle = await createStandaloneApp({ port: 0, dataDir: dir, apiKey: 'test-key' });

      const res = await handle.app.request('/auth/defaults');
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.locale).toBe('en');
      expect(body.theme).toBe('nord');
      expect(body.chatDensity).toBe('compact');
      // Незаданные поля остаются встроенными.
      expect(body.themeMode).toBe('system');
      expect(body.chatScaleMobile).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
});

/**
 * F6 (аудит §6.1): публичность `/api/v2/meta` и `/api/v2/health` в standalone.
 *
 * Allowlist — **общий** с managed backend (`server/app/public-routes.ts`), гейт
 * на границе `/api/*` — fail-closed: публичны только перечисленные пути,
 * остальное требует аутентификации (`401`).
 */
describe('createStandaloneApp: публичный allowlist `/api/v2/*` (ADR-118 §8)', () => {
  it('GET /api/v2/meta и /api/v2/health без Authorization → 200', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'synth-app-public-allowlist-'));
    try {
      const handle = await createStandaloneApp({ port: 0, dataDir: dir, apiKey: 'test-key' });

      const meta = await handle.app.request('/api/v2/meta');
      expect(meta.status).toBe(200);
      const body = (await meta.json()) as { messageModel?: number; version?: string };
      expect(body.messageModel).toBe(2);
      expect(typeof body.version).toBe('string');

      const health = await handle.app.request('/api/v2/health');
      expect(health.status).toBe(200);

      // Query-строка не влияет на сверку пути (публичность — по pathname).
      const metaWithQuery = await handle.app.request('/api/v2/meta?probe=1');
      expect(metaWithQuery.status).toBe(200);

      // `/health` (вне `/api/*`) — публичный, как и раньше.
      const rootHealth = await handle.app.request('/health');
      expect(rootHealth.status).toBe(200);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('остальные `/api/v2/*` без креды → 401 (гейт не ослаблен)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'synth-app-public-allowlist-guard-'));
    try {
      const handle = await createStandaloneApp({ port: 0, dataDir: dir, apiKey: 'test-key' });

      for (const path of ['/api/v2/projects', '/api/v2/sessions', '/api/v2/meta/extra']) {
        const res = await handle.app.request(path);
        expect(res.status, path).toBe(401);
        const body = (await res.json()) as { error?: { code?: string } };
        expect(body.error?.code, path).toBe('UNAUTHORIZED');
      }
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('публичность строгая по методу: мутация публичного пути → 401', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'synth-app-public-allowlist-method-'));
    try {
      const handle = await createStandaloneApp({ port: 0, dataDir: dir, apiKey: 'test-key' });

      const res = await handle.app.request('/api/v2/meta', { method: 'POST' });
      expect(res.status).toBe(401);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
});

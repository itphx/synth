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

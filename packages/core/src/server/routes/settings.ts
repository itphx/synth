import { Hono } from 'hono';
import type { AuthKit } from '../../auth/local.js';
import type { RuntimeSettingsStore } from '../../storage/runtime-settings.js';

export interface SettingsRoutesDeps {
  /** Store runtime-настроек ({dataDir}/settings.json). */
  settingsStore: RuntimeSettingsStore;
  /** Значение по умолчанию (env > config > {dataDir}/workspaces/default), если runtime-настройка не задана. */
  fallbackWorkspace: string;
}

/**
 * Настройки приложения для UI (раздел «Проекты»).
 *
 * GET/PUT /api/v2/settings/workspace — рабочий каталог по умолчанию.
 * Значение сохраняется в {dataDir}/settings.json (AD-005, атомарно) и
 * переживает рестарт: при старте createStandaloneApp читает его и применяет
 * в приоритете над config.yaml.
 */
export function createSettingsRoutes(
  auth: AuthKit,
  deps: SettingsRoutesDeps,
): Hono {
  const app = new Hono();

  app.get('/workspace', auth.requireAuth, async (c) => {
    const runtimeWorkspace = await deps.settingsStore.getWorkspace();
    return c.json({ workspace: runtimeWorkspace ?? deps.fallbackWorkspace });
  });

  app.put('/workspace', auth.requireAuth, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const workspace = typeof body.workspace === 'string' ? body.workspace.trim() : '';

    if (!workspace) {
      return c.json({
        error: { code: 'VALIDATION_ERROR', message: 'Поле workspace обязательно и не может быть пустым' },
      }, 400);
    }

    await deps.settingsStore.setWorkspace(workspace);
    return c.json({ workspace });
  });

  return app;
}

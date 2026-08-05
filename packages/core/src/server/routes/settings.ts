import { Hono } from 'hono';
import type { AuthKit } from '../../auth/local.js';
import type { RuntimeSettingsStore } from '../../storage/runtime-settings.js';
import type { McpServerToolSettings, McpToolAvailability } from '@synth/shared';

export interface SettingsRoutesDeps {
  /** Store runtime-настроек ({dataDir}/settings.json). */
  settingsStore: RuntimeSettingsStore;
  /** Значение по умолчанию (env > config > {dataDir}/workspaces/default), если runtime-настройка не задана. */
  fallbackWorkspace: string;
}

function isValidAvailability(value: unknown): value is McpToolAvailability {
  return !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof (value as Record<string, unknown>).plan === 'boolean'
    && typeof (value as Record<string, unknown>).act === 'boolean';
}

function isValidMcpServers(servers: unknown): servers is Record<string, McpServerToolSettings> {
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return false;
  for (const [serverName, server] of Object.entries(servers as Record<string, unknown>)) {
    if (typeof serverName !== 'string' || !serverName.trim()) return false;
    if (!server || typeof server !== 'object' || Array.isArray(server)) return false;
    const s = server as Record<string, unknown>;
    if (s.default !== undefined && !isValidAvailability(s.default)) return false;
    if (s.tools !== undefined) {
      if (!s.tools || typeof s.tools !== 'object' || Array.isArray(s.tools)) return false;
      for (const [toolName, avail] of Object.entries(s.tools as Record<string, unknown>)) {
        if (typeof toolName !== 'string' || !toolName.trim()) return false;
        if (!isValidAvailability(avail)) return false;
      }
    }
  }
  return true;
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

  app.get('/mcp', auth.requireAuth, async (c) => {
    const servers = await deps.settingsStore.getMcpSettings();
    return c.json({ servers });
  });

  app.put('/mcp', auth.requireAuth, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const servers = (body as { servers?: unknown }).servers;

    if (!isValidMcpServers(servers)) {
      return c.json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'servers: ожидается структура { "<serverName>": { default: { plan, act }, tools: { "<toolName>": { plan, act } } } }',
        },
      }, 400);
    }

    await deps.settingsStore.setMcpSettings(servers);
    return c.json({ servers });
  });

  return app;
}

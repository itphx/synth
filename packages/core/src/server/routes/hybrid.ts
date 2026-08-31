import { Hono } from 'hono';
import type { RemoteBackendClient } from '../../remote/client.js';
import { RemoteError } from '../../remote/types.js';

export interface HybridStatusUser {
  id: string;
  username: string;
  roles: string[];
}

export interface HybridStatusResponse {
  enabled: boolean;
  connected: boolean;
  backendUrl: string | null;
  user?: HybridStatusUser | null;
}

/**
 * Короткий таймаут для auth-статуса удалённого backend: UI опрашивает
 * эндпоинт каждые ~30 с, поэтому запрос не должен висеть на медленном OIDC.
 */
const AUTH_STATUS_TIMEOUT_MS = 5_000;

/**
 * Статус гибридного режима (без auth, как /health).
 * - enabled   — настроен ли remoteClient (`serve --connect`).
 * - connected — доступен ли удалённый backend (краткий health-check).
 * - backendUrl — URL удалённого backend (null без гибрида).
 * - user      — пользователь backend (из /auth/status; null при недоступности).
 */
export function createHybridRoutes(remoteClient?: RemoteBackendClient): Hono {
  const app = new Hono();

  app.get('/api/v2/hybrid/status', async (c) => {
    if (!remoteClient) {
      return c.json({ enabled: false, connected: false, backendUrl: null, user: null });
    }

    const connected = await remoteClient.isReachable();
    let user: HybridStatusUser | null = null;
    if (connected) {
      try {
        const status = await remoteClient.getAuthStatus({ timeoutMs: AUTH_STATUS_TIMEOUT_MS });
        if (status.authenticated && status.user) {
          user = status.user;
        }
      } catch (err) {
        // Backend недоступен/не авторизован: connected оставляем по isReachable,
        // user — null. Эндпоинт не должен падать из-за медленного auth.
        if (err instanceof RemoteError) {
          // ок — статус просто недоступен
        } else {
          console.warn(
            `[hybrid] не удалось получить auth-статус: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    return c.json({
      enabled: true,
      connected,
      backendUrl: remoteClient.backendUrl,
      user,
    });
  });

  return app;
}

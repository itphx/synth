import { Hono } from 'hono';

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
  /** Адрес сервера известен (defaultBackendUrl задан при старте) — даже если не подключено. */
  serverConfigured: boolean;
  /** Доступен вход на сервер (адрес известен ИЛИ есть OIDC issuer ИЛИ уже подключено). */
  serverLoginAvailable: boolean;
  /** URL серверов из реестра профилей (для dropdown формы входа), свежие первыми. */
  knownServers: string[];
  /** URL последнего использованного профиля (или null, если профилей нет). */
  lastServer: string | null;
}

/** Текущее состояние гибрида: колбэк читает RemoteConnection в момент запроса. */
export type HybridStatusState = HybridStatusResponse | Promise<HybridStatusResponse>;

/**
 * Статус гибридного режима (без auth, как /health).
 * Роут читает состояние через getState() в момент каждого запроса — гибрид
 * подключается в рантайме (RemoteConnection), поэтому статический remoteClient
 * здесь не передаётся.
 * - enabled   — настроен ли гибрид (задан defaultBackendUrl ИЛИ есть подключение).
 * - connected — активно ли runtime-подключение к удалённому backend.
 * - backendUrl — URL удалённого backend (null без гибрида).
 * - user      — пользователь backend (из /auth/status; null при недоступности).
 * - serverConfigured — адрес сервера известен при старте (defaultBackendUrl), UI скрывает поле адреса.
 * - serverLoginAvailable — можно войти на сервер (адрес/issuer известен ИЛИ подключено).
 * - knownServers — известные серверы из реестра профилей (список для datalist формы входа).
 * - lastServer — последний использованный сервер (предзаполнение поля адреса).
 */
export function createHybridRoutes(getState: () => HybridStatusState): Hono {
  const app = new Hono();

  app.get('/api/v2/hybrid/status', async (c) => {
    return c.json(await getState());
  });

  return app;
}

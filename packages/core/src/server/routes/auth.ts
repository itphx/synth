import { Hono } from 'hono';
import type { User } from '@itphx/synth-shared';
import { serverUserToUser, type LocalAuthKit, type ServerUserPayload } from '../../auth/local.js';
import type { RemoteConnection } from '../../remote/connection.js';
import type { RemoteCredentials, RemoteUser } from '../../remote/types.js';
import { RemoteError } from '../../remote/types.js';
import { startDeviceFlow, pollDeviceToken } from '../../remote/device-flow.js';
import { saveCredentials } from '../../remote/credentials.js';

/**
 * Remote-зависимости standalone auth-роутов (гибридный режим).
 * Гибрид подключается в РАНТАЙМЕ через RemoteConnection: роуты получают сам
 * connection (текущее состояние) и функции-обёртки connectRemote/disconnectRemote,
 * которые создаёт createStandaloneApp (connect + инъекция провайдера).
 */
export interface AuthRoutesRemoteDeps {
  /** Runtime-подключение к удалённому backend (состояние: connected/backendUrl/user). */
  connection: RemoteConnection;
  /** Полное подключение по логину/паролю (ROPC): connect + applyConnected. */
  connectRemote: (serverUrl: string, username: string, password: string) => Promise<RemoteUser>;
  /** Авто-логин по сохранённым credentials (без device flow); null — нет/не вышло. */
  connectRemoteFromSaved?: (backendUrl?: string) => Promise<RemoteUser | null>;
  /** Подключение по API-ключу (машинный доступ). */
  connectRemoteWithApiKey?: (serverUrl: string, apiKey: string) => Promise<RemoteUser>;
  /** Полный сброс runtime-подключения (bridge + провайдер + connection). */
  disconnectRemote?: () => Promise<void>;
  /** Дефолтный адрес сервера (из --connect/env/конфига) — если в запросе не указан server. */
  defaultBackendUrl?: string;
  /** Задан OIDC issuer (--oidc-issuer/--oidc-client-id) — fallback дискавери для входа в UI. */
  issuerAvailable?: boolean;
  /**
   * Гибридный режим включён (remote.enabled || задан OIDC fallback) — даже если
   * адрес сервера ещё не известен. Даёт oidc_enabled=true, чтобы UI показал
   * форму входа с полем «Адрес сервера» (если адрес не задан) и парольным входом.
   */
  hybridEnabled?: boolean;
  /** Процесс перезапускаемый обёрткой (env SYNTH_RESTARTABLE=1): switch-profile завершит процесс кодом 77. */
  restartable?: boolean;
  /** Вход в профиль сервера (создание профиля + credentials в профильный файл) без runtime-подключения процесса. */
  switchToProfile?: (serverUrl: string, username: string, password: string) => Promise<void>;
  /** Отложенный запрос перезапуска процесса (graceful, код 77). */
  scheduleRestart?: () => void;
}

function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

function toPayload(user: User): ServerUserPayload {
  return { id: user.id, username: user.username, email: user.email, roles: user.roles };
}

function remoteUserToPayload(user: RemoteUser): ServerUserPayload {
  return { id: user.id, username: user.username, roles: user.roles };
}

/**
 * Активный device flow (RFC 8628), запущенный через POST /auth/device-start.
 * Хранится в замыкании createAuthRoutes: один активный flow — новый start
 * перезаписывает старый. Фоновый pollDeviceToken обновляет status.
 */
interface ActiveDeviceFlow {
  deviceCode: string;
  status: 'pending' | 'authenticated' | 'error';
  errorMessage?: string;
  user?: ServerUserPayload;
}

/**
 * Авто-логин (GET /auth/status|session): если локальной cookie нет, но remote
 * подключён (connection.active) — пользователь известен; иначе пробуем тихое
 * подключение по сохранённым credentials (connectRemoteFromSaved, без device flow).
 * Возвращает null, если авто-логин невозможен.
 */
async function tryAutoLogin(
  c: Parameters<LocalAuthKit['getCurrentUser']>[0],
  auth: LocalAuthKit,
  deps: AuthRoutesRemoteDeps,
): Promise<User | null> {
  // Уже подключены — серверная личность известна из runtime-сессии.
  if (deps.connection.connected && deps.connection.user) {
    const user = deps.connection.user;
    auth.setServerUserCookie(c, remoteUserToPayload(user));
    return serverUserToUser(remoteUserToPayload(user));
  }

  // Гибрид сконфигурирован (есть дефолтный сервер), но не подключён —
  // тихо подключаемся по сохранённым credentials (без интерактива).
  if (!deps.connection.connected && deps.defaultBackendUrl && deps.connectRemoteFromSaved) {
    try {
      const user = await deps.connectRemoteFromSaved(deps.defaultBackendUrl);
      if (user) {
        auth.setServerUserCookie(c, remoteUserToPayload(user));
        return serverUserToUser(remoteUserToPayload(user));
      }
    } catch {
      // best-effort: сервер недоступен / credentials не подошли — авто-логин невозможен
    }
  }
  return null;
}

/** Маппинг RemoteError ROPC-логина в HTTP-ответ. */
function mapLoginError(err: unknown): Response {
  if (err instanceof RemoteError) {
    if (err.code === 'OFFLINE') {
      return new Response(JSON.stringify({ error: { code: 'OFFLINE', message: err.message } }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (err.code === 'AUTH' || err.code === 'UNAUTHORIZED') {
      return new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: err.message } }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }
  return new Response(JSON.stringify({
    error: { code: 'INTERNAL_ERROR', message: 'Не удалось выполнить вход' },
  }), { status: 500, headers: { 'Content-Type': 'application/json' } });
}

/**
 * 409 «требуется перезапуск для смены сервера». Два случая:
 * - нейтральный процесс + явный адрес: вход выполнен в ПРОФИЛЬ сервера (не в
 *   runtime), но процесс не перезапускаемый (прямой `synth serve`) — пользователь
 *   сам перезапустит с адресом (`synth serve --connect <server>`);
 * - процесс привязан к серверу A, запрошен B: смена активного сервера «на лету»
 *   не поддерживается (dataDir/runtime принадлежат профилю A) — нужен перезапуск.
 */
function profileSwitchRequired(server: string): Response {
  return new Response(JSON.stringify({
    error: {
      code: 'PROFILE_SWITCH_REQUIRED',
      message: `Перезапустите с адресом сервера: synth serve --connect ${server}`,
    },
  }), { status: 409, headers: { 'Content-Type': 'application/json' } });
}

export function createAuthRoutes(auth: LocalAuthKit, deps: AuthRoutesRemoteDeps): Hono {
  const app = new Hono();
  // Активный device flow (один на сервер; новый start перезаписывает старый).
  let activeDeviceFlow: ActiveDeviceFlow | null = null;

  app.get('/status', async (c) => {
    let user = auth.getCurrentUser(c);
    if (!user) {
      const auto = await tryAutoLogin(c, auth, deps);
      if (auto) user = auto;
    }
    return c.json({
      authenticated: !!user,
      debug_mode: false,
      // Тип развёртывания: standalone-core — единственный, кто отдаёт
      // /api/v2/hybrid/status (по этому признаку UI включает поллинг гибрида).
      deployment: 'standalone',
      // OIDC-вход на сервер возможен, когда известен адрес сервера
      // (defaultBackendUrl), задан OIDC issuer (--oidc-issuer/--oidc-client-id —
      // fallback дискавери; UI тогда показывает форму с полем адреса), есть
      // runtime-подключение либо включён гибридный режим (remote.enabled/--connect/
      // --oidc-issuer — адрес можно ввести в UI). Иначе — только локальный API-ключ.
      oidc_enabled: !!(deps.defaultBackendUrl || deps.issuerAvailable || deps.connection.connected || deps.hybridEnabled),
      user: user ? toPayload(user) : null,
    });
  });

  app.get('/session', async (c) => {
    let user = auth.getCurrentUser(c);
    if (!user) {
      const auto = await tryAutoLogin(c, auth, deps);
      if (auto) user = auto;
    }
    if (!user) {
      return c.json({ user: null }, 401);
    }
    return c.json({ deployment: 'standalone', user: toPayload(user) });
  });

  app.get('/me', async (c) => {
    const user = auth.getCurrentUser(c);
    if (!user) {
      return c.json({ error: { code: 'UNAUTHORIZED' } }, 401);
    }
    return c.json(toPayload(user));
  });

  app.post('/spa-login', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const apiKey: string | undefined = body.api_key || body.apiKey;

    if (!apiKey) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Требуется API-ключ' } }, 400);
    }

    const user = auth.getCurrentUser({ req: { header: () => `Bearer ${apiKey}` } });
    if (!user) {
      return c.json({ error: { code: 'UNAUTHORIZED', message: 'Неверный API-ключ' } }, 401);
    }

    // Устанавливаем cookie-сессию, чтобы SPA авторизовался на API автоматически
    auth.setSessionCookie(c);

    return c.json({ deployment: 'standalone', user: toPayload(user) });
  });

  /**
   * POST /auth/login — вход по логину/паролю (ROPC) в гибридном режиме.
   * Локальная личность = серверная: ROPC против OIDC issuer, пользователь
   * (username + роли) приходит с сервера, cookie ставится с kind:'server'.
   * body: { server?, username, password } — server пуст → активный сервер
   * процесса (defaultBackendUrl/подключение); если сервер неизвестен и нет
   * подключения — 400.
   *
   * Сценарии «вход = переход в профиль» (процессы-профили серверов):
   * - нейтральный процесс (без defaultBackendUrl и подключения) + передан
   *   server → вход выполняется НЕ в runtime-состояние процесса, а в ПРОФИЛЬ
   *   сервера (switchToProfile: реестр + профильные credentials). Если процесс
   *   перезапускаемый (restartable, env SYNTH_RESTARTABLE=1) — ответ 200
   *   { action:'switch-profile' } и отложенный exit(77) (обёртка hybrid.sh
   *   перезапустит процесс в новом профиле); иначе — 409 PROFILE_SWITCH_REQUIRED.
   * - процесс привязан к серверу A + передан server B (≠ A) — смена активного
   *   сервера «на лету» не поддерживается: 409 PROFILE_SWITCH_REQUIRED, runtime
   *   процесса не трогается.
   * - иначе (server пуст → активный, либо равен активному) — обычный runtime-вход
   *   (connectRemote), как раньше.
   */
  app.post('/login', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const rawServer = typeof body.server === 'string' ? body.server.trim() : '';
    const username = typeof body.username === 'string' ? body.username : '';
    const password = typeof body.password === 'string' ? body.password : '';

    // Адрес из тела запроса (куда хочет войти пользователь) и активный сервер
    // процесса: runtime-подключение (приоритет) или дефолтный адрес при старте.
    const requested = rawServer ? normalizeUrl(rawServer) : '';
    const activeRaw = deps.connection.backendUrl ?? deps.defaultBackendUrl ?? '';
    const active = activeRaw ? normalizeUrl(activeRaw) : '';
    // Адрес для входа: явный server → defaultBackendUrl → уже подключённый backend.
    const target = requested || active;
    if (!target) {
      return c.json({
        error: { code: 'BAD_REQUEST', message: 'Не указан адрес сервера' },
      }, 400);
    }
    if (!username || !password) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Укажите логин и пароль' } }, 400);
    }

    // Процесс привязан к другому серверу, а запрошен новый — смена активного
    // сервера «на лету» не поддерживается (runtime/dataDir принадлежат профилю
    // активного сервера): просим перезапустить процесс с адресом.
    if (requested && active && requested !== active) {
      return profileSwitchRequired(requested);
    }

    // Нейтральный процесс + явный адрес → «переход в профиль»: вход выполняется
    // в профиль сервера (реестр + профильный каталог + credentials), runtime
    // процесса НЕ подключается. Без switchToProfile (deps без профильной
    // поддержки) — обратная совместимость: обычный runtime-вход как раньше.
    if (requested && !active && deps.switchToProfile) {
      try {
        await deps.switchToProfile(requested, username, password);
      } catch (err) {
        return mapLoginError(err);
      }
      // Перезапускаемый процесс (hybrid.sh): отвечаем 200 switch-profile и
      // отложенно завершаем процесс кодом 77 — обёртка перезапустит serve в
      // новом профиле (serve без --connect берёт lastProfile из реестра).
      if (deps.restartable && deps.scheduleRestart) {
        deps.scheduleRestart();
        return c.json({
          action: 'switch-profile',
          server: requested,
          message: 'Профиль сервера сохранён — процесс перезапускается в новом профиле',
        });
      }
      // Прямой synth serve без обёртки: процесс не завершаем, пользователь сам
      // перезапустит с адресом сервера.
      return profileSwitchRequired(requested);
    }

    try {
      // Всегда пробуем connectByPassword заново: безопаснее и проще, чем
      // сверять «уже подключённого» пользователя (состояние фиксируется
      // только после успешного входа).
      const user = await deps.connectRemote(target, username, password);
      auth.setServerUserCookie(c, remoteUserToPayload(user));
      return c.json({ deployment: 'standalone', user: remoteUserToPayload(user) });
    } catch (err) {
      return mapLoginError(err);
    }
  });

  /**
   * POST /auth/device-start — OIDC device flow (вход через браузер) из UI.
   * Без auth. Адрес сервера берётся из текущего подключения/defaultBackendUrl;
   * OIDC issuer/client_id узнаём через connection.discoverOidc (fallback на
   * deps.defaultIssuer/defaultClientId). Запускает startDeviceFlow и фоновый
   * pollDeviceToken: по успеху — saveCredentials + connectRemoteFromSaved
   * (runtime-подключение), статус 'authenticated'; по ошибке — 'error'.
   */
  app.post('/device-start', async (c) => {
    const serverUrl = deps.connection.backendUrl ?? deps.defaultBackendUrl;
    if (!serverUrl) {
      return c.json({
        error: { code: 'BAD_REQUEST', message: 'Гибридный режим не настроен (запустите с --connect)' },
      }, 400);
    }

    // Remote-сессия уже валидна — UI просто перелогинится.
    if (deps.connection.connected) {
      return c.json({ status: 'already_authenticated' });
    }

    let meta: { issuer: string; clientId: string };
    try {
      meta = await deps.connection.discoverOidc(serverUrl);
    } catch (err) {
      if (err instanceof RemoteError && err.code === 'OFFLINE') {
        return c.json({ error: { code: 'OFFLINE', message: err.message } }, 502);
      }
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: { code: 'AUTH_ERROR', message } }, 400);
    }

    try {
      const session = await startDeviceFlow(meta.issuer, meta.clientId);
      const flow: ActiveDeviceFlow = { deviceCode: session.deviceCode, status: 'pending' };
      activeDeviceFlow = flow;

      // Фоновый опрос token_endpoint (не блокирует ответ /device-start).
      void (async () => {
        try {
          const token = await pollDeviceToken(session);
          const creds: RemoteCredentials = {
            backendUrl: serverUrl,
            accessToken: token.accessToken,
            refreshToken: token.refreshToken,
            expiresAt: token.expiresIn
              ? new Date(Date.now() + token.expiresIn * 1000).toISOString()
              : undefined,
          };
          await saveCredentials(creds, deps.connection.deps.credentialsPath);

          // Активируем runtime-подключение по сохранённым credentials.
          let user: ServerUserPayload | undefined;
          if (deps.connectRemoteFromSaved) {
            const connected = await deps.connectRemoteFromSaved(serverUrl).catch(() => null);
            if (connected) {
              user = remoteUserToPayload(connected);
            }
          }

          if (activeDeviceFlow === flow) {
            flow.status = 'authenticated';
            flow.user = user;
          }
        } catch (err) {
          if (activeDeviceFlow === flow) {
            flow.status = 'error';
            flow.errorMessage = err instanceof Error ? err.message : String(err);
          }
        }
      })();

      return c.json({
        status: 'pending',
        verification_uri: session.verificationUri,
        user_code: session.userCode,
        verification_uri_complete: session.verificationUriComplete,
      });
    } catch (err) {
      // startDeviceFlow не выдал код (сервер авторизации недоступен/конфиг клиента)
      if (err instanceof RemoteError && err.code === 'OFFLINE') {
        return c.json({ error: { code: 'OFFLINE', message: err.message } }, 502);
      }
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: { code: 'AUTH_ERROR', message } }, 400);
    }
  });

  /**
   * POST /auth/device-check — состояние активного device flow (без auth).
   * При 'authenticated' ставит server-cookie (auth.setServerUserCookie) и
   * очищает состояние; при 'error' очищает состояние и возвращает message.
   */
  app.post('/device-check', async (c) => {
    const flow = activeDeviceFlow;
    if (!flow) {
      return c.json({ status: 'error', message: 'Нет активного процесса авторизации' });
    }
    if (flow.status === 'pending') {
      return c.json({ status: 'pending' });
    }
    if (flow.status === 'authenticated') {
      activeDeviceFlow = null;
      if (flow.user) {
        auth.setServerUserCookie(c, flow.user);
      }
      return c.json({ status: 'authenticated', user: flow.user ?? null });
    }
    activeDeviceFlow = null;
    return c.json({ status: 'error', message: flow.errorMessage ?? 'Авторизация не удалась' });
  });

  app.post('/logout', (c) => {
    auth.clearSessionCookie(c);
    return c.body(null, 204);
  });

  // GET /auth/profile — в гибриде проксируется на backend (серверный профиль
  // с настройками и предпочтениями), в локальном режиме — минимальный профиль.
  app.get('/profile', async (c) => {
    const client = deps.connection.client;
    if (client) {
      try {
        const profile = await client.request<unknown>('GET', '/auth/profile');
        return c.json(profile);
      } catch (err) {
        if (err instanceof RemoteError && err.code === 'OFFLINE') {
          return c.json({ error: { code: 'OFFLINE', message: err.message } }, 502);
        }
        return c.json({ error: { code: 'UNAUTHORIZED', message: 'Не авторизован на удалённом сервере' } }, 401);
      }
    }
    const user = auth.getCurrentUser(c);
    if (!user) return c.json({ error: { code: 'UNAUTHORIZED' } }, 401);
    return c.json({
      id: user.id,
      username: user.username,
      roles: user.roles,
      preferences: {},
    });
  });

  // PUT /auth/profile — в гибриде проксируется на backend.
  app.put('/profile', async (c) => {
    const client = deps.connection.client;
    if (client) {
      const body = await c.req.json().catch(() => ({}));
      try {
        const profile = await client.request<unknown>('PUT', '/auth/profile', body);
        return c.json(profile);
      } catch (err) {
        if (err instanceof RemoteError && err.code === 'OFFLINE') {
          return c.json({ error: { code: 'OFFLINE', message: err.message } }, 502);
        }
        return c.json({ error: { code: 'UNAUTHORIZED', message: 'Не авторизован на удалённом сервере' } }, 401);
      }
    }
    const user = auth.getCurrentUser(c);
    if (!user) return c.json({ error: { code: 'UNAUTHORIZED' } }, 401);
    return c.json({ status: 'ok', user: { id: user.id, username: user.username, roles: user.roles } });
  });

  return app;
}

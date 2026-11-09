import { Hono } from 'hono';
import type { ProfileData, ProfileStore, User } from '@itphx/synth-shared';
import { serverUserToUser, type LocalAuthKit, type ServerUserPayload } from '../../auth/local.js';
import type { RemoteConnection } from '../../remote/connection.js';
import type { RemoteCredentials, RemoteUser } from '../../remote/types.js';
import { RemoteError } from '../../remote/types.js';
import { startDeviceFlow, pollDeviceToken } from '../../remote/device-flow.js';
import { saveCredentials } from '../../remote/credentials.js';
import type { DefaultsRepository } from '../../storage/ports/index.js';
import { resolveAppearanceDefaults } from '../appearance-defaults.js';

/**
 * Remote-зависимости standalone auth-роутов (гибридный режим).
 * Гибрид подключается в РАНТАЙМЕ через RemoteConnection: роуты получают сам
 * connection (текущее состояние) и функции-обёртки connectRemote/disconnectRemote,
 * которые создаёт createStandaloneApp (connect + инъекция провайдера). Вход всегда
 * лёгкий (runtime), без перезапуска процесса: никаких профильных каталогов/смены
 * dataDir — локальные данные в едином каталоге, профили серверов (profiles.json) —
 * только мета-реестр для UX.
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
   * форму входа с полем «Адрес сервера» и парольным входом.
   */
  hybridEnabled?: boolean;
  /**
   * Обновить мета-профиль сервера в реестре профилей (ensureProfile: lastUsedAt/
   * lastProfileId/username) после успешного входа. Best-effort — ошибка реестра
   * не должна ронять логин. Нужен для knownServers/lastServer в форме входа UI.
   */
  rememberServer?: (serverUrl: string, username: string) => Promise<void>;
  /**
   * Полный выход из гибрида: best-effort revoke refresh-токена на IdP + удаление
   * credentials активного сервера + runtime disconnect. Мета-профиль из реестра
   * НЕ удаляется (сервер остаётся в knownServers/lastServer). Все ошибки тихо
   * игнорируются — главное локальная очистка.
   */
  logoutRemote?: () => Promise<void>;
  /**
   * Порт умолчаний оформления инстанса (`GET /auth/defaults`, ADR-096).
   * Не передан — отдаются только встроенные умолчания: UI на экране входа
   * не должен получать 404 (ошибка в консоли браузера).
   */
  defaultsStore?: DefaultsRepository | null;
  /**
   * Стор профилей пользователей (local standalone): локальный профиль владельца
   * инстанса (`local` или серверная личность в гибриде). Без него GET/PUT
   * /auth/profile работают в прежнем fallback-режиме (паритет со старым
   * поведением), а PATCH/DELETE preferences не персистят данные.
   */
  profilesStore?: ProfileStore | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Полный DTO профиля — паритет с backend `GET /auth/profile`
 * (`packages/backend/src/routes/auth.ts`). `team_roles` — аддитивно: UI читает
 * массив, а не одиночный `team_role`.
 */
function profileToDto(user: User, profile: ProfileData | null): Record<string, unknown> {
  return {
    id: user.id,
    username: user.username,
    email: profile?.email ?? user.email,
    phone: profile?.phone ?? null,
    roles: profile?.roles ?? user.roles,
    preferred_language: user.preferredLanguage,
    team_role: profile?.teamRoles?.[0] ?? user.teamRole,
    team_roles: profile?.teamRoles ?? [],
    notes: profile?.notes ?? user.notes,
    interview_completed: profile?.interviewCompleted ?? user.interviewCompleted,
    display_name: profile?.displayName ?? null,
    is_active: profile?.isActive ?? true,
    created_at: profile?.createdAt ?? user.createdAt,
    preferences: (profile?.preferences as Record<string, unknown>) ?? {},
  };
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

export function createAuthRoutes(auth: LocalAuthKit, deps: AuthRoutesRemoteDeps): Hono {
  const app = new Hono();
  // Активный device flow (один на сервер; новый start перезаписывает старый).
  let activeDeviceFlow: ActiveDeviceFlow | null = null;

  // GET /locales — публичный список языков UI (паритет с backend).
  // UI запрашивает его на экране входа; без маршрута консоль браузера
  // показывала 404 (аудит F13).
  app.get('/locales', (c) => c.json({
    locales: [
      { code: 'ru', name: 'Russian', native_name: 'Русский' },
      { code: 'en', name: 'English', native_name: 'English' },
    ],
    default: 'ru',
  }));

  // GET /defaults — публичные умолчания оформления инстанса (паритет с
  // backend): встроенные значения + сохранённые поверх. Доступны до входа —
  // по ним UI настраивает тему/масштаб экрана входа.
  app.get('/defaults', async (c) => c.json(await resolveAppearanceDefaults(deps.defaultsStore)));

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
   * Вход всегда лёгкий (runtime), без перезапуска процесса:
   * - адрес может отличаться от активного — connectRemote выполняет runtime
   *   reconnect (зеркала провайдеров/мост пересоздаются в applyConnected);
   * - после успешного входа best-effort обновляется мета-профиль сервера в
   *   реестре (rememberServer → knownServers/lastServer для формы входа UI);
   * - локальные данные процесса НЕ затрагиваются (единый dataDir).
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

    try {
      // Всегда пробуем connectByPassword заново: безопаснее и проще, чем
      // сверять «уже подключённого» пользователя (состояние фиксируется
      // только после успешного входа). Если сервер отличается от активного —
      // connectRemote сам выполняет runtime-reconnect (applyConnected).
      const user = await deps.connectRemote(target, username, password);
      // Мета-профиль в реестре (известные серверы/lastServer для формы входа) —
      // best-effort: ошибка реестра не должна ронять успешный вход.
      if (deps.rememberServer) {
        await deps.rememberServer(target, username).catch(() => {});
      }
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

  app.post('/logout', async (c) => {
    // Гибрид: полный выход — best-effort revoke refresh-токена на IdP + удаление
    // credentials активного сервера + runtime disconnect (все ошибки тихо
    // игнорируются). Мета-профиль из реестра при этом НЕ удаляется — сервер
    // остаётся в knownServers/lastServer для формы входа.
    await deps.logoutRemote?.().catch(() => {});
    auth.clearSessionCookie(c);
    return c.body(null, 204);
  });

  // GET /auth/profile — в гибриде проксируется на backend (серверный профиль
  // с настройками и предпочтениями), локально — профиль из `profilesStore`
  // (паритет DTO с backend). Без стора — прежняя минимальная заглушка.
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
    if (!deps.profilesStore) {
      return c.json({
        id: user.id,
        username: user.username,
        phone: null,
        roles: user.roles,
        preferences: {},
      });
    }
    // Локальный профиль создаётся при первом обращении (username — ключ).
    const profile = await deps.profilesStore.getOrCreateProfile({
      username: user.username,
      roles: user.roles,
    });
    return c.json(profileToDto(user, profile));
  });

  // PUT /auth/profile — в гибриде проксируется на backend; локально —
  // персист в `profilesStore` тех же полей, что сохраняет backend. Ответ несёт
  // `profile` — UI (`updateProfile`) читает именно его.
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
    const rawBody = await c.req.json().catch(() => ({}));
    const body = isRecord(rawBody) ? rawBody : {};
    if (!deps.profilesStore) {
      return c.json({ status: 'ok', user: { id: user.id, username: user.username, roles: user.roles } });
    }

    // In-memory обновление личности (паритет с backend; не персистится —
    // серверная личность в гибриде живёт в cookie, локальная — константа).
    if (typeof body.preferred_language === 'string') user.preferredLanguage = body.preferred_language;
    if (typeof body.team_role === 'string') user.teamRole = body.team_role;
    if (typeof body.notes === 'string') user.notes = body.notes;
    if (typeof body.interview_completed === 'boolean') user.interviewCompleted = body.interview_completed;

    const profile = await deps.profilesStore.getOrCreateProfile({
      username: user.username,
      roles: user.roles,
    });
    if (typeof body.notes === 'string') profile.notes = body.notes;
    // Новый формат — массив `team_roles`; legacy `team_role` — одиночное значение.
    const teamRoles = Array.isArray(body.team_roles)
      ? body.team_roles.filter((r): r is string => typeof r === 'string')
      : typeof body.team_role === 'string'
        ? [body.team_role]
        : undefined;
    if (teamRoles !== undefined) profile.teamRoles = teamRoles;
    if (typeof body.display_name === 'string' && body.display_name) profile.displayName = body.display_name;
    if (typeof body.interview_completed === 'boolean') {
      profile.interviewCompleted = body.interview_completed;
      profile.interviewCompletedAt = body.interview_completed ? new Date().toISOString() : undefined;
    }
    if (isRecord(body.preferences)) {
      profile.preferences = { ...(profile.preferences ?? {}), ...body.preferences };
    }
    if (typeof body.email === 'string') profile.email = body.email;
    if (typeof body.phone === 'string') profile.phone = body.phone;
    await deps.profilesStore.saveProfile(profile);

    return c.json({ status: 'ok', profile: profileToDto(user, profile) });
  });

  // PATCH /auth/profile/preferences — слить preferences. В гибриде проксируется
  // на backend; локально — merge в профиль.
  app.patch('/profile/preferences', async (c) => {
    const client = deps.connection.client;
    if (client) {
      const body = await c.req.json().catch(() => ({}));
      try {
        const result = await client.request<unknown>('PATCH', '/auth/profile/preferences', body);
        return c.json(result);
      } catch (err) {
        if (err instanceof RemoteError && err.code === 'OFFLINE') {
          return c.json({ error: { code: 'OFFLINE', message: err.message } }, 502);
        }
        return c.json({ error: { code: 'UNAUTHORIZED', message: 'Не авторизован на удалённом сервере' } }, 401);
      }
    }
    const user = auth.getCurrentUser(c);
    if (!user) return c.json({ error: { code: 'UNAUTHORIZED' } }, 401);
    const rawBody = await c.req.json().catch(() => ({}));
    const patch = isRecord(rawBody) ? rawBody : {};
    if (!deps.profilesStore) {
      return c.json({ status: 'ok', preferences: patch });
    }
    const profile = await deps.profilesStore.getOrCreateProfile({
      username: user.username,
      roles: user.roles,
    });
    profile.preferences = { ...(profile.preferences ?? {}), ...patch };
    await deps.profilesStore.saveProfile(profile);
    return c.json({ status: 'ok', preferences: profile.preferences });
  });

  // DELETE /auth/profile/preferences — сбросить preferences (оставить avatar,
  // как backend). В гибриде проксируется на backend.
  app.delete('/profile/preferences', async (c) => {
    const client = deps.connection.client;
    if (client) {
      try {
        const result = await client.request<unknown>('DELETE', '/auth/profile/preferences');
        return c.json(result);
      } catch (err) {
        if (err instanceof RemoteError && err.code === 'OFFLINE') {
          return c.json({ error: { code: 'OFFLINE', message: err.message } }, 502);
        }
        return c.json({ error: { code: 'UNAUTHORIZED', message: 'Не авторизован на удалённом сервере' } }, 401);
      }
    }
    const user = auth.getCurrentUser(c);
    if (!user) return c.json({ error: { code: 'UNAUTHORIZED' } }, 401);
    if (!deps.profilesStore) {
      return c.json({ status: 'ok', preferences: {} });
    }
    const profile = await deps.profilesStore.getProfileByUsername(user.username);
    if (profile) {
      const avatar = (profile.preferences as Record<string, unknown> | undefined)?.avatar;
      profile.preferences = avatar ? { avatar } : {};
      await deps.profilesStore.saveProfile(profile);
      return c.json({ status: 'ok', preferences: profile.preferences });
    }
    return c.json({ status: 'ok', preferences: {} });
  });

  return app;
}

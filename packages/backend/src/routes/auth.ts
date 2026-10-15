import { Hono } from 'hono';
import type { AuthKit } from '../auth/middleware.js';
import type { AuthConfig, User } from '@itphx/synth-shared';
import type { ProfileStore } from '@itphx/synth-shared';
import { createRateLimiter } from '../middleware/rate-limiter.js';
import { createLazyOidcClient, oidcUserToUser } from '../auth/oidc.js';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { t } from '../lib/i18n.js';
import { getDefaultLang, setDefaultLang, type Lang } from '../lib/i18n-config.js';
import type { DefaultsStore, AppearanceDefaults } from '../lib/defaults-store.js';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

const OIDC_STATE_COOKIE = 'oidc_state';

// Встроенные умолчания оформления (совпадают с тем, что использует UI
// по умолчанию: packages/ui/src/lib/defaults.ts + uiScale.ts).
const BUILT_IN_DEFAULTS = {
  themeMode: 'system' as const,
  theme: 'synthesis',
  uiScaleMobile: null as number | null,
  uiScaleDesktop: null as number | null,
};

export function createAuthRoutes(
  kit: AuthKit,
  config: AuthConfig,
  profiles?: ProfileStore,
  dataDir?: string,
  defaultsStore?: DefaultsStore | null,
): Hono {
  const app = new Hono();
  const avatarsDir = dataDir ? join(dataDir, 'auth', 'avatars') : null;
  // Корень каталога аватаров (абсолютный) — для containment-проверки.
  const avatarsRoot = avatarsDir ? resolve(avatarsDir) : null;

  /**
   * Безопасный абсолютный путь к файлу аватара по `username`.
   * Отклоняет пустое имя, разделители пути (`/`, `\`) и `.`/`..` (traversal),
   * а также результат вне каталога аватаров (defense-in-depth). `null` — отказ.
   */
  const resolveAvatarPath = (username: string): string | null => {
    if (!avatarsRoot) return null;
    const name = username.trim();
    if (!name || name === '.' || name === '..') return null;
    if (/[/\\\0]/.test(name)) return null;
    const full = resolve(avatarsRoot, `${name}.png`);
    return full.startsWith(avatarsRoot + sep) ? full : null;
  };

  // Сохранённые умолчания перекрывают встроенные; uiScaleMobile/uiScaleDesktop: null — умолчание не задано.
  const resolveDefaults = async () => {
    const stored: AppearanceDefaults = defaultsStore ? await defaultsStore.loadDefaults() : {};
    return {
      locale: getDefaultLang(),
      ...BUILT_IN_DEFAULTS,
      ...stored,
    };
  };
  const getOidcClient = createLazyOidcClient(config.oidc);

  // GET /auth/login — редирект на Keycloak authorize endpoint
  app.get('/login', async (c) => {
    const client = getOidcClient();
    if (!client) {
      return c.json({ error: { code: 'BAD_REQUEST', message: t('auth.oidcDisabled', undefined, c) } }, 400);
    }
    const state = crypto.randomUUID();
    setCookie(c, OIDC_STATE_COOKIE, state, {
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
      maxAge: 600,
    });
    const authorizeUrl = await client.authorizeUrl(state);
    return c.redirect(authorizeUrl);
  });

  // POST /auth/login — вход по логину/паролю (ROPC) без редиректа на Keycloak
  app.post('/login', async (c) => {
    const client = getOidcClient();
    if (!client) {
      return c.json({ error: { code: 'BAD_REQUEST', message: t('auth.oidcDisabled', undefined, c) } }, 400);
    }
    const body = await c.req.json().catch(() => ({}));
    const username = body.username ?? body.login;
    const password = body.password;
    if (!username || !password) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: t('auth.credentialsRequired', undefined, c) } }, 400);
    }
    try {
      const { id_token: idToken, access_token: accessToken } = await client.exchangePassword(username, password);
      const oidcUser = await client.verifyTokens(idToken, accessToken);
      const user: User = oidcUserToUser(oidcUser);
      const sessionId = kit.createSession(user);
      kit.setSessionCookie(c, sessionId);
      return c.json({ deployment: 'managed', user: { id: user.id, username: user.username, email: user.email, roles: user.roles } });
    } catch (err) {
      console.error('[auth/login] ROPC error:', err);
      return c.json({ error: { code: 'UNAUTHORIZED', message: t('auth.oidcLoginFailed', undefined, c) } }, 401);
    }
  });

  // GET /auth/callback — обмен кода на токены, верификация, создание сессии
  app.get('/callback', async (c) => {
    const code = c.req.query('code');
    const state = c.req.query('state');
    const cookieState = getCookie(c, OIDC_STATE_COOKIE);
    deleteCookie(c, OIDC_STATE_COOKIE, { path: '/' });
    if (!code || !state || state !== cookieState) {
      return c.json({ error: { code: 'BAD_REQUEST', message: t('auth.oidcStateMismatch', undefined, c) } }, 400);
    }

    const client = getOidcClient();
    if (!client) {
      return c.json({ error: { code: 'BAD_REQUEST', message: t('auth.oidcDisabled', undefined, c) } }, 400);
    }

    try {
      const { id_token: idToken, access_token: accessToken } = await client.exchangeCode(code);
      const oidcUser = await client.verifyTokens(idToken, accessToken);
      const user: User = oidcUserToUser(oidcUser);
      const sessionId = kit.createSession(user);
      kit.setSessionCookie(c, sessionId);
      return c.redirect('/');
    } catch (err) {
      console.error('[auth/callback] OIDC callback error:', err);
      return c.json({ error: { code: 'UNAUTHORIZED', message: t('auth.oidcExchangeFailed', undefined, c) } }, 401);
    }
  });

  // GET /auth/status — статус аутентификации
  app.get('/status', async (c) => {
    const user = await kit.getCurrentUser(c);
    return c.json({
      authenticated: !!user,
      debug_mode: config.debugMode,
      oidc_enabled: !!config.oidc?.enabled,
      // Тип развёртывания: managed (API Hub) — UI по этому признаку НЕ опрашивает
      // /api/v2/hybrid/status (эндпоинт есть только в standalone-core).
      deployment: 'managed',
      user: user ? {
        id: user.id,
        username: user.username,
        email: user.email,
        roles: user.roles,
      } : null,
    });
  });

  // GET /auth/oidc-meta — публичные OIDC-параметры для локальных клиентов (дискавери).
  // Локальный core по адресу сервера узнаёт issuer и public client_id (для ROPC/device flow).
  // Секрет клиента НЕ отдаётся.
  app.get('/oidc-meta', (c) => {
    if (!config.oidc?.enabled) {
      return c.json({ enabled: false });
    }
    return c.json({
      enabled: true,
      issuer: config.oidc.issuer,
      clientId: config.oidc.cliClientId || 'synth-cli',
    });
  });

  // GET /auth/session — проверка cookie-сессии
  app.get('/session', async (c) => {
    const user = await kit.getCurrentUser(c);
    if (!user) {
      return c.json({ user: null }, 401);
    }
    return c.json({
      deployment: 'managed',
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        roles: user.roles,
      },
    });
  });

  // GET /auth/me — текущий пользователь
  app.get('/me', async (c) => {
    const user = await kit.getCurrentUser(c);
    if (!user) {
      return c.json({ error: { code: 'UNAUTHORIZED' } }, 401);
    }
    return c.json({
      id: user.id,
      username: user.username,
      email: user.email,
      roles: user.roles,
    });
  });

  // POST /auth/spa-login — SPA-логин
  app.post('/spa-login', createRateLimiter(5, 60_000), async (c) => {
    if (config.oidc?.enabled) {
      return c.json({ error: { code: 'FORBIDDEN', message: t('auth.spaLoginDisabled', undefined, c) } }, 403);
    }

    const body = await c.req.json().catch(() => ({}));
    const apiKey: string | undefined = body.api_key || body.apiKey;

    if (!apiKey) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: t('errors.validation.apiKeyRequired', undefined, c) } }, 400);
    }

    let user: User | null = null;

    if (config.debugMode) {
      const testUser = config.testUsers?.find((u) => u.apiKey === apiKey);
      if (testUser) {
        user = {
          id: testUser.username,
          username: testUser.username,
          roles: testUser.roles,
          preferredLanguage: 'ru',
          createdAt: new Date().toISOString(),
          teamRole: testUser.roles[0] || 'USER',
          notes: '',
          interviewCompleted: false,
          isTestUser: true,
        };
      }
    } else if (config.apiKey && apiKey === config.apiKey) {
      user = {
        id: 'api',
        username: 'api',
        roles: ['ADMIN'],
        preferredLanguage: 'ru',
        createdAt: new Date().toISOString(),
        teamRole: 'ADMIN',
        notes: '',
        interviewCompleted: false,
      };
    }

    if (!user) {
      return c.json({ error: { code: 'UNAUTHORIZED', message: t('auth.invalidApiKey', undefined, c) } }, 401);
    }

    const sessionId = kit.createSession(user);
    kit.setSessionCookie(c, sessionId);

    return c.json({
      deployment: 'managed',
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        roles: user.roles,
      },
    });
  });

  // POST /auth/logout
  app.post('/logout', (c) => {
    const cookieHeader = c.req.header('Cookie') || '';
    const match = cookieHeader.match(/user_session=([^;]+)/);
    if (match?.[1]) {
      kit.deleteSessionCookie(c, match[1]);
    }
    return c.body(null, 204);
  });

  // GET /auth/profile
  app.get('/profile', async (c) => {
    const user = await kit.getCurrentUser(c);
    if (!user) {
      return c.json({ error: { code: 'UNAUTHORIZED' } }, 401);
    }

    let profile = null;
    if (profiles) {
      profile = await profiles.getProfileByUsername(user.username);
    }

    return c.json({
      id: user.id,
      username: user.username,
      email: profile?.email ?? user.email,
      phone: profile?.phone ?? null,
      roles: profile?.roles ?? user.roles,
      preferred_language: user.preferredLanguage,
      team_role: profile?.teamRoles?.[0] ?? user.teamRole,
      notes: profile?.notes ?? user.notes,
      interview_completed: profile?.interviewCompleted ?? user.interviewCompleted,
      display_name: profile?.displayName ?? null,
      is_active: profile?.isActive ?? true,
      created_at: profile?.createdAt ?? user.createdAt,
      preferences: (profile?.preferences as Record<string, unknown>) ?? {},
    });
  });

  // PUT /auth/profile
  app.put('/profile', async (c) => {
    const user = await kit.getCurrentUser(c);
    if (!user) {
      return c.json({ error: { code: 'UNAUTHORIZED' } }, 401);
    }
    const body = await c.req.json();

    // In-memory обновление
    if (body.preferred_language) user.preferredLanguage = body.preferred_language;
    if (body.team_role) user.teamRole = body.team_role;
    if (body.notes !== undefined) user.notes = body.notes;
    if (body.interview_completed !== undefined) user.interviewCompleted = body.interview_completed;

    // Persist в FileProfileStore
    if (profiles) {
      const profile = await profiles.getOrCreateProfile({
        username: user.username,
        roles: user.roles,
      });
      if (body.notes !== undefined) profile.notes = body.notes;
      if (body.team_role) profile.teamRoles = [body.team_role];
      if (body.display_name) profile.displayName = body.display_name;
      if (body.interview_completed !== undefined) {
        // Отдельное поле статуса интервью — персистим вместе с временем.
        profile.interviewCompleted = body.interview_completed;
        profile.interviewCompletedAt = body.interview_completed ? new Date().toISOString() : undefined;
      }
      if (body.preferences !== undefined) {
        profile.preferences = { ...(profile.preferences || {}), ...body.preferences };
      }
      if (body.email !== undefined) profile.email = body.email;
      if (body.phone !== undefined) profile.phone = body.phone;
      await profiles.saveProfile(profile);

      return c.json({
        status: 'ok',
        profile: {
          id: user.id,
          username: user.username,
          roles: user.roles,
          email: profile.email,
          phone: profile.phone,
          display_name: profile.displayName,
          notes: profile.notes,
          team_role: profile.teamRoles?.[0],
          interview_completed: profile.interviewCompleted,
          preferences: profile.preferences,
        },
      });
    }

    return c.json({ status: 'ok', user: { id: user.id, username: user.username, roles: user.roles } });
  });

  // PATCH /auth/profile/preferences
  app.patch('/profile/preferences', async (c) => {
    const user = await kit.getCurrentUser(c);
    if (!user) {
      return c.json({ error: { code: 'UNAUTHORIZED' } }, 401);
    }
    const body = await c.req.json();

    if (profiles) {
      const profile = await profiles.getOrCreateProfile({
        username: user.username,
        roles: user.roles,
      });
      profile.preferences = { ...(profile.preferences || {}), ...body };
      await profiles.saveProfile(profile);
      return c.json({ status: 'ok', preferences: profile.preferences });
    }

    return c.json({ status: 'ok', preferences: body });
  });

  // DELETE /auth/profile/preferences
  app.delete('/profile/preferences', async (c) => {
    const user = await kit.getCurrentUser(c);
    if (!user) {
      return c.json({ error: { code: 'UNAUTHORIZED' } }, 401);
    }

    if (profiles) {
      const profile = await profiles.getProfileByUsername(user.username);
      if (profile) {
        const avatar = (profile.preferences as Record<string, unknown>)?.avatar;
        profile.preferences = avatar ? { avatar } : {};
        await profiles.saveProfile(profile);
        return c.json({ status: 'ok', preferences: profile.preferences });
      }
    }

    return c.json({ status: 'ok', preferences: {} });
  });

  // GET /auth/locales
  app.get('/locales', (c) => {
    return c.json({
      locales: [
        { code: 'ru', name: 'Russian', native_name: t('locales.ru.nativeName', undefined, c) },
        { code: 'en', name: 'English', native_name: 'English' },
      ],
      default: 'ru',
    });
  });

  // GET /auth/users — только в debug mode
  app.get('/users', (c) => {
    if (!config.debugMode) {
      return c.json({ error: { code: 'FORBIDDEN' } }, 403);
    }
    const users = (config.testUsers || []).map((tu) => ({
      id: tu.username,
      username: tu.username,
    }));
    return c.json({ users });
  });

  // GET /auth/defaults
  app.get('/defaults', async (c) => {
    return c.json(await resolveDefaults());
  });

  // PUT /auth/defaults — сохранение умолчаний оформления (только ADMIN).
  app.put('/defaults', kit.requireAdmin, async (c) => {
    const body = await c.req.json().catch(() => ({}));

    // locale может прийти как locale или language (обратная совместимость).
    const locale = body.locale ?? body.language;
    if (locale === 'en' || locale === 'ru') {
      setDefaultLang(locale as Lang);
    }

    if (defaultsStore) {
      const patch: AppearanceDefaults = { ...body };
      if (patch.locale === undefined && (locale === 'en' || locale === 'ru')) {
        patch.locale = locale;
      }
      await defaultsStore.saveDefaults(patch);
    }

    return c.json({ status: 'ok', defaults: await resolveDefaults() });
  });

  // GET /auth/profile/avatar — отдаёт файл аватара
  app.get('/profile/avatar', async (c) => {
    const user = await kit.getCurrentUser(c);
    if (!user) return c.json({ error: { code: 'UNAUTHORIZED' } }, 401);
    if (!avatarsDir) return c.body(null, 404);

    const avatarPath = resolveAvatarPath(user.username);
    if (!avatarPath) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: t('errors.validation.invalidUsername', undefined, c) } }, 400);
    }
    try {
      const data = await readFile(avatarPath);
      return new Response(data, {
        headers: { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=3600' },
      });
    } catch {
      return c.body(null, 404);
    }
  });

  // POST /auth/profile/avatar — сохраняет аватар (binary)
  app.post('/profile/avatar', async (c) => {
    const user = await kit.getCurrentUser(c);
    if (!user) return c.json({ error: { code: 'UNAUTHORIZED' } }, 401);
    if (!avatarsDir) return c.json({ error: { code: 'INTERNAL_ERROR' } }, 500);

    const avatarPath = resolveAvatarPath(user.username);
    if (!avatarPath) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: t('errors.validation.invalidUsername', undefined, c) } }, 400);
    }

    try {
      const buffer = await c.req.arrayBuffer();
      if (buffer.byteLength === 0) {
        // Удаление аватара
        await unlink(avatarPath).catch(() => {});
        if (profiles) {
          const profile = await profiles.getOrCreateProfile({ username: user.username, roles: user.roles });
          const prefs = { ...(profile.preferences as Record<string, unknown> || {}), avatar: '' };
          profile.preferences = prefs;
          await profiles.saveProfile(profile);
        }
        return c.json({ status: 'ok' });
      }
      await writeFile(avatarPath, Buffer.from(buffer));
      if (profiles) {
        const profile = await profiles.getOrCreateProfile({ username: user.username, roles: user.roles });
        const prefs = { ...(profile.preferences as Record<string, unknown> || {}), avatar: true };
        profile.preferences = prefs;
        await profiles.saveProfile(profile);
      }
      return c.json({ status: 'ok' });
    } catch (err) {
      return c.json({ error: { code: 'INTERNAL_ERROR', message: String(err) } }, 500);
    }
  });

  return app;
}

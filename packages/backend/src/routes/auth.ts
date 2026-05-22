import { Hono } from 'hono';
import type { AuthKit } from '../auth/middleware.js';
import type { AuthConfig, User } from '@synth/shared';
import type { ProfileStore } from '@synth/shared';
import { setCookie } from 'hono/cookie';
import { nowISO } from '@synth/shared';
import { t } from '../lib/i18n.js';
import { getDefaultLang, setDefaultLang, type Lang } from '../lib/i18n-config.js';

export function createAuthRoutes(kit: AuthKit, config: AuthConfig, profiles?: ProfileStore): Hono {
  const app = new Hono();

  // GET /auth/status — статус аутентификации
  app.get('/status', (c) => {
    const user = kit.getCurrentUser(c);
    return c.json({
      authenticated: !!user,
      debug_mode: config.debugMode,
      oidc_enabled: !!config.oidc?.enabled,
      user: user ? {
        id: user.id,
        username: user.username,
        email: user.email,
        roles: user.roles,
      } : null,
    });
  });

  // GET /auth/session — проверка cookie-сессии
  app.get('/session', (c) => {
    const user = kit.getCurrentUser(c);
    if (!user) {
      return c.json({ user: null }, 401);
    }
    return c.json({
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        roles: user.roles,
      },
    });
  });

  // GET /auth/me — текущий пользователь
  app.get('/me', (c) => {
    const user = kit.getCurrentUser(c);
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
  app.post('/spa-login', async (c) => {
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
    const user = kit.getCurrentUser(c);
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
      roles: profile?.roles ?? user.roles,
      preferred_language: user.preferredLanguage,
      team_role: profile?.teamRoles?.[0] ?? user.teamRole,
      notes: profile?.notes ?? user.notes,
      interview_completed: user.interviewCompleted,
      display_name: profile?.displayName ?? null,
      is_active: profile?.isActive ?? true,
      created_at: profile?.createdAt ?? user.createdAt,
      preferences: (profile?.preferences as Record<string, unknown>) ?? {},
    });
  });

  // PUT /auth/profile
  app.put('/profile', async (c) => {
    const user = kit.getCurrentUser(c);
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
      if (body.preferences !== undefined) {
        profile.preferences = { ...(profile.preferences || {}), ...body.preferences };
      }
      if (body.email !== undefined) profile.email = body.email;
      await profiles.saveProfile(profile);

      return c.json({
        status: 'ok',
        profile: {
          id: user.id,
          username: user.username,
          roles: user.roles,
          email: profile.email,
          display_name: profile.displayName,
          notes: profile.notes,
          team_role: profile.teamRoles?.[0],
          preferences: profile.preferences,
        },
      });
    }

    return c.json({ status: 'ok', user: { id: user.id, username: user.username, roles: user.roles } });
  });

  // PATCH /auth/profile/preferences
  app.patch('/profile/preferences', async (c) => {
    const user = kit.getCurrentUser(c);
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
    const user = kit.getCurrentUser(c);
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
  app.get('/defaults', (c) => {
    const lang = getDefaultLang();
    return c.json({ locale: lang, themeMode: 'dark', theme: 'flexoki' });
  });

  // PUT /auth/defaults
  app.put('/defaults', async (c) => {
    const body = await c.req.json();
    const locale = body.locale || body.language;
    if (locale === 'en' || locale === 'ru') {
      setDefaultLang(locale as Lang);
    }
    return c.json({ status: 'ok', defaults: { ...body, locale: getDefaultLang() } });
  });

  return app;
}

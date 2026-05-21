import { Hono } from 'hono';
import type { AuthKit } from '../auth/middleware.js';
import type { AuthConfig, User } from '@synth/shared';

export function createAuthRoutes(kit: AuthKit, config: AuthConfig): Hono {
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
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'api_key обязателен' } }, 400);
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
      return c.json({ error: { code: 'UNAUTHORIZED', message: 'Неверный API-ключ' } }, 401);
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
  app.get('/profile', (c) => {
    const user = kit.getCurrentUser(c);
    if (!user) {
      return c.json({ error: { code: 'UNAUTHORIZED' } }, 401);
    }
    return c.json({
      id: user.id,
      username: user.username,
      email: user.email,
      roles: user.roles,
      preferred_language: user.preferredLanguage,
      team_role: user.teamRole,
      notes: user.notes,
      interview_completed: user.interviewCompleted,
      created_at: user.createdAt,
    });
  });

  // PUT /auth/profile
  app.put('/profile', async (c) => {
    const user = kit.getCurrentUser(c);
    if (!user) {
      return c.json({ error: { code: 'UNAUTHORIZED' } }, 401);
    }
    const body = await c.req.json();
    // In-memory обновление (для debug mode)
    if (body.preferred_language) user.preferredLanguage = body.preferred_language;
    if (body.team_role) user.teamRole = body.team_role;
    if (body.notes !== undefined) user.notes = body.notes;
    if (body.interview_completed !== undefined) user.interviewCompleted = body.interview_completed;
    return c.json({ status: 'ok', user: { id: user.id, username: user.username, roles: user.roles } });
  });

  // PATCH /auth/profile/preferences
  app.patch('/profile/preferences', async (c) => {
    const user = kit.getCurrentUser(c);
    if (!user) {
      return c.json({ error: { code: 'UNAUTHORIZED' } }, 401);
    }
    const body = await c.req.json();
    // Сохраняем предпочтения (in-memory)
    return c.json({ status: 'ok', preferences: body });
  });

  // DELETE /auth/profile/preferences
  app.delete('/profile/preferences', (c) => {
    return c.json({ status: 'ok', preferences: {} });
  });

  // GET /auth/locales
  app.get('/locales', (c) => {
    return c.json({
      locales: [
        { code: 'ru', name: 'Russian', native_name: 'Русский' },
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
    return c.json({ locale: 'ru', themeMode: 'dark', theme: 'flexoki' });
  });

  // PUT /auth/defaults
  app.put('/defaults', async (c) => {
    return c.json({ status: 'ok', defaults: await c.req.json() });
  });

  return app;
}

import type { AuthConfig, User } from '@synth/shared';
import { createMiddleware } from 'hono/factory';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { t } from '../lib/i18n.js';

const SESSION_COOKIE = 'user_session';

// In-memory хранилище сессий (для debug mode)
const sessions = new Map<string, { user: User; expiresAt: number }>();

// Очистка истёкших сессий каждые 5 минут
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (session.expiresAt <= now) {
      sessions.delete(id);
    }
  }
}, 300_000);

function extractBearerToken(h: string | undefined): string | null {
  if (!h) return null;
  if (h.startsWith('Bearer ')) return h.slice(7);
  return null;
}

export function createAuthMiddleware(config: AuthConfig) {
  // Определить пользователя из запроса
  const getCurrentUser = (c: { req: { header(name: string): string | undefined } }): User | null => {
    // 1. Cookie-сессия
    const sessionId = typeof getCookie === 'function'
      ? getCookie(c as Parameters<typeof getCookie>[0], SESSION_COOKIE)
      : undefined;
    if (sessionId) {
      const session = sessions.get(sessionId);
      if (session && session.expiresAt > Date.now()) return session.user;
    }

    // 2. Debug mode — test_users
    if (config.debugMode) {
      const apiKey = extractBearerToken(c.req.header('Authorization'));
      if (apiKey) {
        const testUser = config.testUsers?.find((u) => u.apiKey === apiKey);
        if (testUser) {
          return {
            id: testUser.username,
            username: testUser.username,
            roles: testUser.roles,
            preferredLanguage: 'ru',
            createdAt: '',
            teamRole: testUser.roles[0] || 'USER',
            notes: '',
            interviewCompleted: false,
            isTestUser: true,
          };
        }
      }
    }

    // 3. OIDC JWT
    if (config.oidc?.enabled) {
      const token = extractBearerToken(c.req.header('Authorization'));
      if (token) {
        // TODO: OIDC validate
      }
    }

    // 4. API Key mode (продакшен без OIDC)
    if (!config.debugMode && !config.oidc?.enabled && config.apiKey) {
      const apiKey = extractBearerToken(c.req.header('Authorization'));
      if (apiKey === config.apiKey) {
        return {
          id: 'api',
          username: 'api',
          roles: ['ADMIN'],
          preferredLanguage: 'ru',
          createdAt: '',
          teamRole: 'ADMIN',
          notes: '',
          interviewCompleted: false,
        };
      }
    }

    return null;
  };

  // Middleware: прикрепить пользователя к контексту (без ошибки)
  const attachUser = createMiddleware(async (c, next) => {
    const user = getCurrentUser(c);
    if (user) c.set('user', user);
    await next();
  });

  // Middleware: требовать аутентификации
  const requireAuth = createMiddleware(async (c, next) => {
    const user = getCurrentUser(c);
    if (!user) {
      return c.json({ error: { code: 'UNAUTHORIZED', message: t('auth.unauthorized', undefined, c) } }, 401);
    }
    c.set('user', user);
    await next();
  });

  // Middleware: требовать роль ADMIN
  const requireAdmin = createMiddleware(async (c, next) => {
    const user = c.get('user') as User | undefined;
    if (!user || !user.roles.includes('ADMIN')) {
      return c.json({ error: { code: 'FORBIDDEN', message: t('auth.forbidden', undefined, c) } }, 403);
    }
    await next();
  });

  // Middleware: требовать одну из указанных ролей (например, ADMIN/AUDITOR)
  const requirePermission = (...roles: string[]) => createMiddleware(async (c, next) => {
    const user = c.get('user') as User | undefined;
    if (!user || !roles.some((r) => user.roles.includes(r))) {
      return c.json({ error: { code: 'FORBIDDEN', message: t('auth.forbidden', undefined, c) } }, 403);
    }
    await next();
  });

  // Создать cookie-сессию
  const createSession = (user: User): string => {
    const sessionId = crypto.randomUUID();
    sessions.set(sessionId, {
      user,
      expiresAt: Date.now() + config.sessionMaxAgeMinutes * 60_000,
    });
    return sessionId;
  };

  // Удалить сессию
  const deleteSessionCookie = (c: Parameters<typeof deleteCookie>[0], sessionId: string): void => {
    sessions.delete(sessionId);
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
  };

  // Установить cookie сессии в ответе
  const setSessionCookie = (c: Parameters<typeof setCookie>[0], sessionId: string): void => {
    setCookie(c, SESSION_COOKIE, sessionId, {
      path: '/',
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'Lax',
      maxAge: config.sessionMaxAgeMinutes * 60,
    });
  };

  return {
    getCurrentUser,
    attachUser,
    requireAuth,
    requireAdmin,
    requirePermission,
    createSession,
    setSessionCookie,
    deleteSessionCookie,
  };
}

export type AuthKit = ReturnType<typeof createAuthMiddleware>;

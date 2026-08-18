import { createHmac, timingSafeEqual } from 'node:crypto';
import type { User } from '@itphx/synth-shared';
import { createMiddleware } from 'hono/factory';

// Cookie-сессия standalone: подписанный API-ключ (HMAC-SHA256)
const SESSION_COOKIE = 'synth_session';
// 24 часа — как дефолт сессий backend
const SESSION_MAX_AGE = 60 * 60 * 24;

function extractBearerToken(h: string | undefined): string | null {
  if (!h) return null;
  if (h.startsWith('Bearer ')) return h.slice(7);
  return null;
}

/** Формат cookie: `base64url(apiKey).hex(hmacSha256(base64url(apiKey), secret))`. */
function signApiKey(apiKey: string, secret: string): string {
  const payload = Buffer.from(apiKey, 'utf8').toString('base64url');
  const sig = createHmac('sha256', secret).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

/** Верифицирует подпись и возвращает apiKey из cookie, либо null. */
function verifySignedApiKey(value: string, secret: string): string | null {
  const idx = value.lastIndexOf('.');
  if (idx <= 0 || idx === value.length - 1) return null;
  const payload = value.slice(0, idx);
  const sig = value.slice(idx + 1);
  const expected = createHmac('sha256', secret).update(payload).digest('hex');
  const a = Buffer.from(sig, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    return Buffer.from(payload, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

/** Достаёт значение cookie из заголовка `Cookie`. */
function readCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match?.[1] ?? null;
}

function buildCookie(value: string, maxAge: number): string {
  return [
    `${SESSION_COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ].join('; ');
}

export interface LocalAuthConfig {
  apiKey: string;
}

export interface AuthKit {
  getCurrentUser(c: ContextLike): User | null;
  requireAuth: ReturnType<typeof createMiddleware>;
}

/**
 * Local-auth с cookie-сессией (SPA после spa-login).
 * Отдельный интерфейс, чтобы не ломать структурную совместимость базового
 * `AuthKit` с backend-реализацией (backend передаёт свой AuthKit в core-роуты).
 */
export interface LocalAuthKit extends AuthKit {
  /** Установить cookie-сессию (подписанный API-ключ) в ответе. */
  setSessionCookie(c: ContextLike): void;
  /** Очистить cookie-сессию (истёкший срок). */
  clearSessionCookie(c: ContextLike): void;
}

export interface ContextLike {
  req: { header(name: string): string | undefined };
  /** Опциональная запись заголовка ответа (Hono `c.header`); не требуется для чтения. */
  header?(name: string, value: string): void;
}

export function createLocalAuth(config: LocalAuthConfig): LocalAuthKit {
  const localUser: User = {
    id: 'local',
    username: 'local',
    roles: ['USER'],
    preferredLanguage: 'ru',
    createdAt: new Date().toISOString(),
    teamRole: 'USER',
    notes: '',
    interviewCompleted: false,
  };

  const getCurrentUser = (c: ContextLike): User | null => {
    // 1. Authorization: Bearer <api-key>
    const token = extractBearerToken(c.req.header('Authorization'));
    if (token === config.apiKey) {
      return localUser;
    }

    // 2. Cookie synth_session — подписанный API-ключ (для SPA после spa-login)
    const cookieValue = readCookie(c.req.header('Cookie'), SESSION_COOKIE);
    if (cookieValue) {
      const signedKey = verifySignedApiKey(cookieValue, config.apiKey);
      if (signedKey === config.apiKey) {
        return localUser;
      }
    }

    return null;
  };

  const setSessionCookie = (c: ContextLike): void => {
    if (!c.header) return;
    c.header('Set-Cookie', buildCookie(signApiKey(config.apiKey, config.apiKey), SESSION_MAX_AGE));
  };

  const clearSessionCookie = (c: ContextLike): void => {
    if (!c.header) return;
    c.header('Set-Cookie', buildCookie('', 0));
  };

  const requireAuth = createMiddleware(async (c, next) => {
    const user = getCurrentUser(c);
    if (!user) {
      return c.json({ error: { code: 'UNAUTHORIZED', message: 'Требуется аутентификация' } }, 401);
    }
    c.set('user', user);
    await next();
  });

  return {
    getCurrentUser,
    requireAuth,
    setSessionCookie,
    clearSessionCookie,
  };
}

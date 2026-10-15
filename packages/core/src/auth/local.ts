import { createHmac, timingSafeEqual } from 'node:crypto';
import type { User } from '@itphx/synth-shared';
import { createMiddleware } from 'hono/factory';
import { isServiceKeySecret } from '../storage/service-api-key-store.js';
import type { ServiceKeyCredential } from '../storage/service-api-key-store.js';

// Cookie-сессия standalone: подписанный API-ключ (HMAC-SHA256)
const SESSION_COOKIE = 'synth_session';
// 24 часа — как дефолт сессий backend
const SESSION_MAX_AGE = 60 * 60 * 24;

function extractBearerToken(h: string | undefined): string | null {
  if (!h) return null;
  if (h.startsWith('Bearer ')) return h.slice(7);
  return null;
}

/**
 * Подписанный payload cookie: `base64url(payload).hex(hmacSha256(base64url(payload), secret))`.
 * Используется и для v1 (payload = apiKey), и для v2 (payload = JSON).
 */
function signPayload(payload: string, secret: string): string {
  const p = Buffer.from(payload, 'utf8').toString('base64url');
  const sig = createHmac('sha256', secret).update(p).digest('hex');
  return `${p}.${sig}`;
}

/** Верифицирует подпись и возвращает декодированный payload, либо null. */
function verifySignedPayload(value: string, secret: string): string | null {
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

/** Формат cookie v1: `base64url(apiKey).hex(hmac)`. */
function signApiKey(apiKey: string, secret: string): string {
  return signPayload(apiKey, secret);
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
  /**
   * ADR-052 (этап I): резолвер service-key (`synth_svc_…`) → синтетический
   * пользователь + контекст (roles/scopes/allowedProjects). Не задан — приём
   * по service-key недоступен. Интерактивные креды (api-key/cookie) не
   * затрагиваются.
   */
  resolveServiceKey?: (
    rawSecret: string,
  ) => Promise<{ user: User; credential: ServiceKeyCredential } | null>;
}

/**
 * Серверный пользователь (гибридная личность): хранится в cookie v2
 * и возвращается API-роутами /auth. Подмножество User из @itphx/synth-shared.
 */
export interface ServerUserPayload {
  id: string;
  username: string;
  email?: string;
  roles: string[];
}

/** Формат cookie v2: JSON-объект с kind и данными пользователя. */
interface SessionCookiePayloadV2 {
  v: 2;
  kind: 'server' | 'local';
  user: ServerUserPayload;
}

/** Собрать полного локального User из серверных данных (cookie v2 / авто-логин). */
export function serverUserToUser(u: ServerUserPayload): User {
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    roles: u.roles,
    preferredLanguage: 'ru',
    createdAt: new Date().toISOString(),
    teamRole: u.roles[0] || 'USER',
    notes: '',
    interviewCompleted: false,
    isLocal: false,
  };
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
  /** Установить cookie с серверной личностью (v2, kind:'server') в ответе. */
  setServerUserCookie(c: ContextLike, user: ServerUserPayload): void;
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
    roles: ['ADMIN'],
    preferredLanguage: 'ru',
    createdAt: new Date().toISOString(),
    teamRole: 'ADMIN',
    notes: '',
    interviewCompleted: false,
  };

  const getCurrentUser = (c: ContextLike): User | null => {
    // 1. Authorization: Bearer <api-key>
    const token = extractBearerToken(c.req.header('Authorization'));
    if (token === config.apiKey) {
      return localUser;
    }

    // 2. Cookie synth_session
    const cookieValue = readCookie(c.req.header('Cookie'), SESSION_COOKIE);
    if (cookieValue) {
      const payload = verifySignedPayload(cookieValue, config.apiKey);
      if (payload !== null) {
        // v2: JSON {v:2, kind:'server'|'local', user} — серверная/локальная личность
        if (payload.startsWith('{')) {
          try {
            const parsed = JSON.parse(payload) as SessionCookiePayloadV2;
            if (parsed?.v === 2 && parsed.user?.username) {
              if (parsed.kind === 'server') return serverUserToUser(parsed.user);
              if (parsed.kind === 'local') return localUser;
            }
          } catch {
            // повреждённый JSON — cookie отклоняем
          }
          return null;
        }
        // v1: подписанный apiKey (совместимость со старыми cookie)
        if (payload === config.apiKey) {
          return localUser;
        }
      }
    }

    return null;
  };

  const setSessionCookie = (c: ContextLike): void => {
    if (!c.header) return;
    c.header('Set-Cookie', buildCookie(signApiKey(config.apiKey, config.apiKey), SESSION_MAX_AGE));
  };

  const setServerUserCookie = (c: ContextLike, user: ServerUserPayload): void => {
    if (!c.header) return;
    const payload = JSON.stringify({
      v: 2,
      kind: 'server',
      user,
    } satisfies SessionCookiePayloadV2);
    c.header('Set-Cookie', buildCookie(signPayload(payload, config.apiKey), SESSION_MAX_AGE));
  };

  const clearSessionCookie = (c: ContextLike): void => {
    if (!c.header) return;
    c.header('Set-Cookie', buildCookie('', 0));
  };

  const requireAuth = createMiddleware(async (c, next) => {
    // ADR-052 (этап I): service-key — машинный доступ со scopes/проектной
    // проекцией. Распознаётся по префиксу секрета `synth_svc_`; резолвер
    // асинхронный, поэтому ветка живёт в middleware, а не в sync `getCurrentUser`.
    const token = extractBearerToken(c.req.header('Authorization'));
    if (token && isServiceKeySecret(token)) {
      const resolved = config.resolveServiceKey ? await config.resolveServiceKey(token) : null;
      if (!resolved) {
        return c.json({ error: { code: 'UNAUTHORIZED', message: 'Неверный service-key' } }, 401);
      }
      c.set('user', resolved.user);
      c.set('serviceKey', resolved.credential);
      await next();
      return;
    }

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
    setServerUserCookie,
    clearSessionCookie,
  };
}

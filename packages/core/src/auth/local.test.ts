import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { createLocalAuth } from './local.js';
import type { ContextLike } from './local.js';

const API_KEY = 'test-key';
const COOKIE_NAME = 'synth_session';

/** Собирает заголовки ответа, как Hono `c.header(name, value)`. */
function makeContext(cookieHeader?: string): { c: ContextLike; headers: Map<string, string> } {
  const headers = new Map<string, string>();
  return {
    headers,
    c: {
      req: {
        header: (name: string) => (name === 'Cookie' ? cookieHeader : undefined),
      },
      header: (name: string, value: string) => {
        headers.set(name, value);
      },
    },
  };
}

function extractCookieValue(setCookie: string | undefined): string | null {
  if (!setCookie) return null;
  const match = setCookie.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
  return match?.[1] ?? null;
}

describe('createLocalAuth (server-личность, cookie v2)', () => {
  const SERVER_USER = { id: 'u-1', username: 'lucky', email: 'lucky@itphx.ru', roles: ['ADMIN', 'USER'] };

  it('setServerUserCookie → getCurrentUser возвращает серверного юзера с ролями', () => {
    const auth = createLocalAuth({ apiKey: API_KEY });
    const { c, headers } = makeContext();
    auth.setServerUserCookie(c, SERVER_USER);

    const setCookie = headers.get('Set-Cookie');
    expect(setCookie).toBeDefined();
    expect(setCookie).toContain('Path=/');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toMatch(/Max-Age=\d+/);

    const cookieValue = extractCookieValue(setCookie)!;
    const user = auth.getCurrentUser(makeContext(`${COOKIE_NAME}=${cookieValue}`).c);
    expect(user?.username).toBe('lucky');
    expect(user?.roles).toEqual(['ADMIN', 'USER']);
    expect(user?.id).toBe('u-1');
    expect(user?.email).toBe('lucky@itphx.ru');
  });

  it('server-cookie не отдаёт локального юзера, а local-cookie (v1) — локального', () => {
    const auth = createLocalAuth({ apiKey: API_KEY });

    // v2 server cookie
    const srv = makeContext();
    auth.setServerUserCookie(srv.c, SERVER_USER);
    const serverCookie = extractCookieValue(srv.headers.get('Set-Cookie'))!;
    const fromServer = auth.getCurrentUser(makeContext(`${COOKIE_NAME}=${serverCookie}`).c);
    expect(fromServer?.username).toBe('lucky');
    expect(fromServer?.isLocal).toBe(false);

    // v1 local cookie (старый формат — подписанный apiKey)
    const loc = makeContext();
    auth.setSessionCookie(loc.c);
    const localCookie = extractCookieValue(loc.headers.get('Set-Cookie'))!;
    const fromLocal = auth.getCurrentUser(makeContext(`${COOKIE_NAME}=${localCookie}`).c);
    expect(fromLocal?.username).toBe('local');
    expect(fromLocal?.roles).toEqual(['ADMIN']);
  });

  it('server-cookie с испорченной подписью отклоняется', () => {
    const auth = createLocalAuth({ apiKey: API_KEY });
    const { c, headers } = makeContext();
    auth.setServerUserCookie(c, SERVER_USER);
    const cookieValue = extractCookieValue(headers.get('Set-Cookie'))!;

    const broken = cookieValue.slice(0, -1) + (cookieValue.endsWith('0') ? '1' : '0');
    expect(auth.getCurrentUser(makeContext(`${COOKIE_NAME}=${broken}`).c)).toBeNull();
  });

  it('server-cookie, подписанный для другого ключа, отклоняется', () => {
    const auth = createLocalAuth({ apiKey: API_KEY });
    const other = createLocalAuth({ apiKey: 'other-key' });
    const { c, headers } = makeContext();
    other.setServerUserCookie(c, SERVER_USER);
    const foreignCookie = extractCookieValue(headers.get('Set-Cookie'))!;

    expect(auth.getCurrentUser(makeContext(`${COOKIE_NAME}=${foreignCookie}`).c)).toBeNull();
  });

  it('clearSessionCookie стирает и server-cookie (Max-Age=0)', () => {
    const auth = createLocalAuth({ apiKey: API_KEY });
    const { c, headers } = makeContext();
    auth.clearSessionCookie(c);
    expect(headers.get('Set-Cookie')).toContain('Max-Age=0');
  });
});

describe('createLocalAuth (cookie-сессия)', () => {
  it('getCurrentUser: авторизация по Bearer-заголовку работает как раньше', () => {
    const auth = createLocalAuth({ apiKey: API_KEY });
    const user = auth.getCurrentUser({
      req: { header: () => `Bearer ${API_KEY}` },
    });
    expect(user?.username).toBe('local');
    expect(auth.getCurrentUser({ req: { header: () => 'Bearer wrong' } })).toBeNull();
    expect(auth.getCurrentUser({ req: { header: () => undefined } })).toBeNull();
  });

  it('setSessionCookie ставит synth_session с подписью и параметрами', () => {
    const auth = createLocalAuth({ apiKey: API_KEY });
    const { c, headers } = makeContext();
    auth.setSessionCookie(c);

    const setCookie = headers.get('Set-Cookie');
    expect(setCookie).toBeDefined();
    expect(setCookie).toContain(`${COOKIE_NAME}=`);
    expect(setCookie).toContain('Path=/');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toMatch(/Max-Age=\d+/);
    expect(extractCookieValue(setCookie)).not.toBeNull();
  });

  it('getCurrentUser: авторизация по валидному cookie проходит', () => {
    const auth = createLocalAuth({ apiKey: API_KEY });
    const { c, headers } = makeContext();
    auth.setSessionCookie(c);
    const cookieValue = extractCookieValue(headers.get('Set-Cookie'))!;

    const user = auth.getCurrentUser(makeContext(`other=1; ${COOKIE_NAME}=${cookieValue}`).c);
    expect(user?.username).toBe('local');
  });

  it('getCurrentUser: cookie с испорченной подписью отклоняется', () => {
    const auth = createLocalAuth({ apiKey: API_KEY });
    const { c, headers } = makeContext();
    auth.setSessionCookie(c);
    const cookieValue = extractCookieValue(headers.get('Set-Cookie'))!;

    // Портим последний символ подписи
    const broken = cookieValue.slice(0, -1) + (cookieValue.endsWith('0') ? '1' : '0');
    expect(auth.getCurrentUser(makeContext(`${COOKIE_NAME}=${broken}`).c)).toBeNull();
  });

  it('getCurrentUser: cookie, подписанный для другого ключа, отклоняется', () => {
    const auth = createLocalAuth({ apiKey: API_KEY });
    const other = createLocalAuth({ apiKey: 'other-key' });
    const { c, headers } = makeContext();
    other.setSessionCookie(c);
    const foreignCookie = extractCookieValue(headers.get('Set-Cookie'))!;

    expect(auth.getCurrentUser(makeContext(`${COOKIE_NAME}=${foreignCookie}`).c)).toBeNull();
  });

  it('getCurrentUser: отсутствие cookie и Bearer → null', () => {
    const auth = createLocalAuth({ apiKey: API_KEY });
    expect(auth.getCurrentUser(makeContext().c)).toBeNull();
  });

  it('clearSessionCookie стирает cookie (Max-Age=0)', () => {
    const auth = createLocalAuth({ apiKey: API_KEY });
    const { c, headers } = makeContext();
    auth.clearSessionCookie(c);

    const setCookie = headers.get('Set-Cookie');
    expect(setCookie).toContain(`${COOKIE_NAME}=`);
    expect(setCookie).toContain('Max-Age=0');
  });

  it('requireAuth: пропускает с валидным cookie и отдаёт 401 без него', async () => {
    const auth = createLocalAuth({ apiKey: API_KEY });
    const app = new Hono();
    app.use('*', auth.requireAuth);
    app.get('/x', (c) => c.json({ ok: true }));

    // Без авторизации — 401
    const unauth = await app.request('http://localhost/x');
    expect(unauth.status).toBe(401);

    // С валидным cookie — 200 и user в контексте
    const { c, headers } = makeContext();
    auth.setSessionCookie(c);
    const cookieValue = extractCookieValue(headers.get('Set-Cookie'))!;
    const authed = await app.request('http://localhost/x', {
      headers: { Cookie: `${COOKIE_NAME}=${cookieValue}` },
    });
    expect(authed.status).toBe(200);
  });

  it('spa-login ставит cookie, после чего requireAuth проходит (интеграция роутов)', async () => {
    const auth = createLocalAuth({ apiKey: API_KEY });
    const app = new Hono();
    app.post('/auth/spa-login', async (c) => {
      const body = await c.req.json();
      if (body.api_key !== API_KEY) return c.json({ error: 'bad' }, 401);
      auth.setSessionCookie(c);
      return c.json({ user: { id: 'local' } });
    });
    app.use('/api/*', auth.requireAuth);
    app.get('/api/v2/projects', (c) => c.json({ projects: [] }));

    const login = await app.request('http://localhost/auth/spa-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: API_KEY }),
    });
    expect(login.status).toBe(200);
    const setCookie = login.headers.get('Set-Cookie');
    expect(setCookie).toContain(`${COOKIE_NAME}=`);

    const cookieValue = extractCookieValue(setCookie!)!;
    const projects = await app.request('http://localhost/api/v2/projects', {
      headers: { Cookie: `${COOKIE_NAME}=${cookieValue}` },
    });
    expect(projects.status).toBe(200);
  });
});

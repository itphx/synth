import { Hono } from 'hono';
import type { AuthKit } from '../../auth/local.js';

export function createAuthRoutes(auth: AuthKit): Hono {
  const app = new Hono();

  app.get('/status', (c) => {
    const user = auth.getCurrentUser(c);
    return c.json({
      authenticated: !!user,
      debug_mode: false,
      oidc_enabled: false,
      user: user ? {
        id: user.id,
        username: user.username,
        email: user.email,
        roles: user.roles,
      } : null,
    });
  });

  app.get('/session', (c) => {
    const user = auth.getCurrentUser(c);
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

  app.get('/me', (c) => {
    const user = auth.getCurrentUser(c);
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

    return c.json({
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        roles: user.roles,
      },
    });
  });

  app.post('/logout', (c) => c.body(null, 204));

  app.get('/profile', (c) => {
    const user = auth.getCurrentUser(c);
    if (!user) return c.json({ error: { code: 'UNAUTHORIZED' } }, 401);
    return c.json({
      id: user.id,
      username: user.username,
      roles: user.roles,
      preferences: {},
    });
  });

  return app;
}

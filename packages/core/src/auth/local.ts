import type { User } from '@synth/shared';
import { createMiddleware } from 'hono/factory';

function extractBearerToken(h: string | undefined): string | null {
  if (!h) return null;
  if (h.startsWith('Bearer ')) return h.slice(7);
  return null;
}

export interface LocalAuthConfig {
  apiKey: string;
}

export interface AuthKit {
  getCurrentUser(c: ContextLike): User | null;
  requireAuth: ReturnType<typeof createMiddleware>;
}

interface ContextLike {
  req: { header(name: string): string | undefined };
}

export function createLocalAuth(config: LocalAuthConfig): AuthKit {
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
    const token = extractBearerToken(c.req.header('Authorization'));
    // Также разрешаем api_key в query string для SSE/EventSource
    if (token === config.apiKey) {
      return localUser;
    }
    return null;
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
  };
}

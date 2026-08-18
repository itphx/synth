import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogsRoutes } from './logs.js';
import type { User } from '@itphx/synth-shared';

const adminUser: User = {
  id: 'admin',
  username: 'admin',
  roles: ['ADMIN'],
  preferredLanguage: 'ru',
  createdAt: '',
  teamRole: 'ADMIN',
  notes: '',
  interviewCompleted: false,
};

const auditorUser: User = {
  id: 'auditor',
  username: 'auditor',
  roles: ['AUDITOR'],
  preferredLanguage: 'ru',
  createdAt: '',
  teamRole: 'AUDITOR',
  notes: '',
  interviewCompleted: false,
};

const userUser: User = {
  id: 'developer',
  username: 'developer',
  roles: ['USER'],
  preferredLanguage: 'ru',
  createdAt: '',
  teamRole: 'USER',
  notes: '',
  interviewCompleted: false,
};

/** Формат ответа GET /api/v2/logs/:name (тестовое зеркало контракта). */
interface LogsResponseBody {
  name: string;
  file: string;
  total: number;
  tail: number;
  lines: string[];
}

/** Формат ошибки API v2. */
interface ErrorResponseBody {
  error: { code: string; message: string };
}

/** Формат ответа GET /api/v2/logs/llm (тестовое зеркало контракта). */
interface LlmPayloadListResponse {
  entries: Array<{ ts: string; sessionId?: string; request: unknown; response: unknown }>;
  total: number;
}

/** kit с user === null — для проверки 401 (requireAuth отклоняет). */
function createMockKit(user: User | null) {
  return {
    requireAuth: async (c: Context, next: Next) => {
      if (!user) {
        return c.json({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } }, 401);
      }
      c.set('user', user);
      await next();
    },
    requirePermission: (...roles: string[]) => async (c: Context, next: Next) => {
      const u = c.get('user') as User | undefined;
      if (!u || !roles.some((r) => u.roles.includes(r))) {
        return c.json({ error: { code: 'FORBIDDEN', message: 'Access denied' } }, 403);
      }
      await next();
    },
    getCurrentUser: () => user,
  };
}

describe('Logs API Routes', () => {
  let tmpDir: string;
  let logDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-logs-'));
    logDir = tmpDir;
    await writeFile(join(logDir, 'backend.log'), [
      'line 1 INFO started',
      'line 2 DEBUG detail',
      'line 3 ERROR boom',
      'line 4 WARNING careful',
      'line 5 INFO ok',
      'line 6 ERROR again',
    ].join('\n') + '\n', 'utf8');
    await writeFile(join(logDir, 'core.log'), 'core line\n', 'utf8');
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function createApp(user: User | null, payloadLogPath?: string) {
    const app = new Hono();
    const kit = createMockKit(user);
    app.use('*', kit.requireAuth);
    app.route('/api/v2/logs', createLogsRoutes(kit as any, { logDir, payloadLogPath }));
    return app;
  }

  describe('RBAC', () => {
    it('неавторизованный получает 401', async () => {
      const app = createApp(null);
      const res = await app.request('/api/v2/logs/backend');
      expect(res.status).toBe(401);
    });

    it('USER получает 403', async () => {
      const app = createApp(userUser);
      const res = await app.request('/api/v2/logs/backend');
      expect(res.status).toBe(403);
    });

    it('ADMIN получает 200', async () => {
      const app = createApp(adminUser);
      const res = await app.request('/api/v2/logs/backend');
      expect(res.status).toBe(200);
    });

    it('AUDITOR получает 200', async () => {
      const app = createApp(auditorUser);
      const res = await app.request('/api/v2/logs/backend');
      expect(res.status).toBe(200);
    });
  });

  describe('GET /api/v2/logs/:name', () => {
    it('возвращает дефолтный хвост (последние 200 строк) и total', async () => {
      const app = createApp(adminUser);
      const res = await app.request('/api/v2/logs/backend');
      expect(res.status).toBe(200);
      const body = (await res.json()) as LogsResponseBody;
      expect(body.name).toBe('backend');
      expect(body.file).toBe(join(logDir, 'backend.log'));
      expect(body.total).toBe(6);
      expect(body.lines).toHaveLength(6);
      expect(body.lines[0]).toBe('line 1 INFO started');
      expect(body.lines[5]).toBe('line 6 ERROR again');
    });

    it('tail=2 возвращает только 2 последние строки', async () => {
      const app = createApp(adminUser);
      const res = await app.request('/api/v2/logs/backend?tail=2');
      const body = (await res.json()) as LogsResponseBody;
      expect(body.total).toBe(6);
      expect(body.lines).toHaveLength(2);
      expect(body.lines).toEqual(['line 5 INFO ok', 'line 6 ERROR again']);
    });

    it('tail больше размера файла — возвращает все строки', async () => {
      const app = createApp(adminUser);
      const res = await app.request('/api/v2/logs/backend?tail=100');
      const body = (await res.json()) as LogsResponseBody;
      expect(body.lines).toHaveLength(6);
    });

    it('tail=99999 clamp до 2000', async () => {
      const app = createApp(adminUser);
      const res = await app.request('/api/v2/logs/backend?tail=99999');
      const body = (await res.json()) as LogsResponseBody;
      expect(body.tail).toBe(2000);
      expect(body.lines).toHaveLength(6);
    });

    it('tail=0 clamp до 1', async () => {
      const app = createApp(adminUser);
      const res = await app.request('/api/v2/logs/backend?tail=0');
      const body = (await res.json()) as LogsResponseBody;
      expect(body.tail).toBe(1);
      expect(body.lines).toHaveLength(1);
      expect(body.lines[0]).toBe('line 6 ERROR again');
    });

    it('невалидный tail — дефолт 200', async () => {
      const app = createApp(adminUser);
      const res = await app.request('/api/v2/logs/backend?tail=abc');
      const body = (await res.json()) as LogsResponseBody;
      expect(body.tail).toBe(200);
    });

    it('search фильтрует case-insensitive', async () => {
      const app = createApp(adminUser);
      const res = await app.request('/api/v2/logs/backend?search=error');
      const body = (await res.json()) as LogsResponseBody;
      expect(body.total).toBe(2);
      expect(body.lines).toEqual(['line 3 ERROR boom', 'line 6 ERROR again']);
    });

    it('search + tail: фильтр применяется до хвоста', async () => {
      const app = createApp(adminUser);
      const res = await app.request('/api/v2/logs/backend?search=line&tail=2');
      const body = (await res.json()) as LogsResponseBody;
      expect(body.total).toBe(6);
      expect(body.lines).toHaveLength(2);
      expect(body.lines).toEqual(['line 5 INFO ok', 'line 6 ERROR again']);
    });

    it('search без совпадений — пустой список', async () => {
      const app = createApp(adminUser);
      const res = await app.request('/api/v2/logs/backend?search=notfound');
      const body = (await res.json()) as LogsResponseBody;
      expect(body.total).toBe(0);
      expect(body.lines).toEqual([]);
    });

    it('пустой файл — пустой список', async () => {
      await writeFile(join(logDir, 'core.log'), '', 'utf8');
      const app = createApp(adminUser);
      const res = await app.request('/api/v2/logs/core');
      const body = (await res.json()) as LogsResponseBody;
      expect(body.total).toBe(0);
      expect(body.lines).toEqual([]);
    });
  });

  describe('защита от path traversal и whitelist', () => {
    it('name вне whitelist → 404', async () => {
      const app = createApp(adminUser);
      const res = await app.request('/api/v2/logs/logs');
      expect(res.status).toBe(404);
      const body = (await res.json()) as ErrorResponseBody;
      expect(body.error.code).toBe('NOT_FOUND');
    });

    it('name=../../etc/passwd (encoded) → 404, файл не читается', async () => {
      const app = createApp(adminUser);
      const res = await app.request(`/api/v2/logs/${encodeURIComponent('../../etc/passwd')}`);
      expect(res.status).toBe(404);
      const body = (await res.json()) as ErrorResponseBody;
      expect(body.error.code).toBe('NOT_FOUND');
    });

    it('сырой путь /api/v2/logs/../../etc/passwd → не 200', async () => {
      const app = createApp(adminUser);
      const res = await app.request('/api/v2/logs/../../etc/passwd');
      expect(res.status).not.toBe(200);
    });

    it('файл отсутствует → 404 NOT_FOUND', async () => {
      const app = createApp(adminUser);
      const res = await app.request('/api/v2/logs/ui');
      expect(res.status).toBe(404);
      const body = (await res.json()) as ErrorResponseBody;
      expect(body.error.code).toBe('NOT_FOUND');
    });

    it('name с подстрокой whitelist (core.log) → 404', async () => {
      const app = createApp(adminUser);
      const res = await app.request(`/api/v2/logs/${encodeURIComponent('core.log')}`);
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/v2/logs/llm (полный лог запросов/ответов LLM)', () => {
    it('RBAC: USER получает 403', async () => {
      const app = createApp(userUser, join(logDir, 'llm-payloads.jsonl'));
      const res = await app.request('/api/v2/logs/llm');
      expect(res.status).toBe(403);
    });

    it('ADMIN получает 200; файл отсутствует → entries: []', async () => {
      const app = createApp(adminUser, join(logDir, 'llm-payloads.jsonl'));
      const res = await app.request('/api/v2/logs/llm');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ entries: [], total: 0 });
    });

    it('payloadLogPath не задан → entries: [] (логирование не настроено)', async () => {
      const app = createApp(adminUser);
      const res = await app.request('/api/v2/logs/llm');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ entries: [], total: 0 });
    });

    it('читает записи из JSONL, фильтрует по sessionId и limit', async () => {
      const payloadPath = join(logDir, 'llm-payloads.jsonl');
      const entry1 = { ts: '1', sessionId: 's1', request: { messages: [] }, response: { content: 'a' } };
      const entry2 = { ts: '2', sessionId: 's2', request: { messages: [] }, response: { content: 'b' } };
      const entry3 = { ts: '3', sessionId: 's1', request: { messages: [] }, response: { content: 'c' } };
      await writeFile(payloadPath, [entry1, entry2, entry3].map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');

      const app = createApp(adminUser, payloadPath);

      const all = await app.request('/api/v2/logs/llm?limit=10');
      expect(all.status).toBe(200);
      const allBody = (await all.json()) as LlmPayloadListResponse;
      expect(allBody.total).toBe(3);
      expect(allBody.entries).toHaveLength(3);

      const s1 = await app.request('/api/v2/logs/llm?sessionId=s1&limit=10');
      const s1Body = (await s1.json()) as LlmPayloadListResponse;
      expect(s1Body.total).toBe(2);
      expect(s1Body.entries.every((e) => e.sessionId === 's1')).toBe(true);

      const limited = await app.request('/api/v2/logs/llm?limit=1');
      const limitedBody = (await limited.json()) as LlmPayloadListResponse;
      expect(limitedBody.total).toBe(3);
      expect(limitedBody.entries).toHaveLength(1);
      expect(limitedBody.entries[0]?.ts).toBe('3');
    });

    it('пустой файл → entries: []', async () => {
      const payloadPath = join(logDir, 'llm-payloads.jsonl');
      await writeFile(payloadPath, '', 'utf8');
      const app = createApp(adminUser, payloadPath);
      const res = await app.request('/api/v2/logs/llm');
      const body = await res.json();
      expect(body).toEqual({ entries: [], total: 0 });
    });
  });
});

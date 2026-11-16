/**
 * ADR-126 §5: тесты HTTP-контура реестра скриптов сессии
 * (`server/routes/session-scripts.ts`).
 *
 * Проверяется роут, а не сервис: `ScriptService` — фейковый (структурный
 * объект), доступ решает prefix-guard сессий (в проде), здесь — заглушка
 * `requireAuth` (как в `commands.test.ts`).
 *
 * Что проверяется:
 * - список (`{scripts}`, `?diagnostics=1`), деталь скрипта (200/404);
 * - запуск: 202, строгое тело (`{arguments?}`), маппинг кодов доменной
 *   ошибки в HTTP-коды;
 * - права: `deny` блокирует запуск, `ask` — нет (человек инициировал).
 */
import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import type { PermissionConfig } from '@itphx/synth-shared';
import { createSessionScriptRoutes } from './session-scripts.js';
import type { ScriptService } from '../../engine/scripts/service.js';
import { ScriptError } from '../../engine/scripts/types.js';
import type { SessionManager } from '../../sessions/manager.js';

const SESSION_ID = 'sess-1';

const session = {
  id: SESSION_ID,
  projectId: 'proj-1',
  userId: 'local',
  ownerId: 'local',
  settings: {},
} as never;

const sessionManager = {
  getSession: async (id: string) => (id === SESSION_ID ? session : null),
} as unknown as SessionManager;

/** Заглушка `requireAuth` (доступ в проде решает prefix-guard сессий). */
const requireAuth = async (_c: Context, next: Next) => {
  await next();
};

/** Фейковый сервис скриптов (структурный объект — каст). */
function makeService(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    list: vi.fn(async () => ({
      scripts: [
        {
          name: 'dev',
          description: 'Поднять локальное окружение',
          origin: 'project',
          available: true,
          trusted: true,
          background: true,
        },
      ],
      diagnostics: [{ level: 'warning', code: 'shadowed', message: 'затенён' }],
    })),
    get: vi.fn(async (name: string) =>
      name === 'dev'
        ? {
            name: 'dev',
            description: 'Поднять локальное окружение',
            origin: 'project',
            available: true,
            trusted: true,
            background: true,
            run: './scripts/dev.sh',
            shell: false,
            args: false,
            file: '.synth/scripts/dev.md',
            body: 'Локальная отладка.',
          }
        : null
    ),
    run: vi.fn(async () => ({
      run_id: 'bgr_run1',
      process_id: 'proc_1',
      log_path: 'processes/bgr_run1.log',
      status: 'running' as const,
    })),
    ...overrides,
  } as unknown as ScriptService;
}

function makeApp(
  opts: {
    scriptService?: ScriptService;
    permissionConfig?: PermissionConfig;
  } = {},
) {
  const app = new Hono();
  app.route(
    '/api/v2/sessions',
    createSessionScriptRoutes(
      {
        requireAuth,
        sessionManager,
        ...(opts.scriptService ? { scriptService: opts.scriptService } : {}),
        resolveWorkingDir: async () => '/work/project',
        ...(opts.permissionConfig ? { permissionConfig: opts.permissionConfig } : {}),
      },
      {},
    ),
  );
  return app;
}

describe('/api/v2/sessions/:id/scripts (ADR-126 §5)', () => {
  describe('GET /', () => {
    it('список скриптов — 200 {scripts}', async () => {
      const app = makeApp({ scriptService: makeService() });
      const res = await app.request(`/api/v2/sessions/${SESSION_ID}/scripts`);

      expect(res.status).toBe(200);
      const body = await res.json() as { scripts: Array<{ name: string }> };
      expect(body.scripts.map((s) => s.name)).toEqual(['dev']);
      expect(body).not.toHaveProperty('diagnostics');
    });

    it('?diagnostics=1 — диагностика в ответе', async () => {
      const app = makeApp({ scriptService: makeService() });
      const res = await app.request(`/api/v2/sessions/${SESSION_ID}/scripts?diagnostics=1`);

      expect(res.status).toBe(200);
      const body = await res.json() as { diagnostics: unknown[] };
      expect(Array.isArray(body.diagnostics)).toBe(true);
    });

    it('deny-скрипт скрыт из списка', async () => {
      const app = makeApp({
        scriptService: makeService(),
        permissionConfig: { rules: { script: { 'dev*': 'deny' } }, askTimeoutMs: 1000 },
      });
      const res = await app.request(`/api/v2/sessions/${SESSION_ID}/scripts`);

      expect(res.status).toBe(200);
      const body = await res.json() as { scripts: unknown[] };
      expect(body.scripts).toEqual([]);
    });
  });

  describe('GET /:name', () => {
    it('деталь скрипта — 200', async () => {
      const app = makeApp({ scriptService: makeService() });
      const res = await app.request(`/api/v2/sessions/${SESSION_ID}/scripts/dev`);

      expect(res.status).toBe(200);
      const body = await res.json() as { name: string; run: string };
      expect(body.name).toBe('dev');
      expect(body.run).toBe('./scripts/dev.sh');
    });

    it('неизвестный скрипт — 404 SCRIPT_NOT_FOUND', async () => {
      const app = makeApp({ scriptService: makeService() });
      const res = await app.request(`/api/v2/sessions/${SESSION_ID}/scripts/nope`);

      expect(res.status).toBe(404);
      const body = await res.json() as { error: { code: string } };
      expect(body.error.code).toBe('SCRIPT_NOT_FOUND');
    });
  });

  describe('POST /:name/run', () => {
    it('запуск — 202 с run_id/process_id/log_path', async () => {
      const app = makeApp({ scriptService: makeService() });
      const res = await app.request(`/api/v2/sessions/${SESSION_ID}/scripts/dev/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ arguments: '--fast' }),
      });

      expect(res.status).toBe(202);
      const body = await res.json() as { run_id: string; process_id: string; log_path: string };
      expect(body.run_id).toBe('bgr_run1');
      expect(body.process_id).toBe('proc_1');
      expect(body.log_path).toBe('processes/bgr_run1.log');
    });

    it('аргументы уходят в сервис как есть', async () => {
      const service = makeService();
      const app = makeApp({ scriptService: service });
      await app.request(`/api/v2/sessions/${SESSION_ID}/scripts/dev/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ arguments: '--fast' }),
      });

      const run = (service.run as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
      expect(run).toMatchObject({ name: 'dev', args: '--fast', origin: 'user' });
    });

    it('неизвестное поле в теле — 400 VALIDATION_ERROR', async () => {
      const app = makeApp({ scriptService: makeService() });
      const res = await app.request(`/api/v2/sessions/${SESSION_ID}/scripts/dev/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ unexpected: true }),
      });

      expect(res.status).toBe(400);
      const body = await res.json() as { error: { code: string } };
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('маппинг кодов доменной ошибки в HTTP', async () => {
      const cases: Array<[string, number]> = [
        ['script_untrusted', 403],
        ['script_args_not_allowed', 409],
        ['script_args_invalid', 400],
        ['script_cwd_outside', 400],
        ['script_background_disabled', 503],
        ['script_not_found', 404],
      ];

      for (const [code, status] of cases) {
        const service = makeService({
          run: vi.fn(async () => {
            throw new ScriptError(code as never, 'ошибка');
          }),
        });
        const app = makeApp({ scriptService: service });
        const res = await app.request(`/api/v2/sessions/${SESSION_ID}/scripts/dev/run`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        });

        expect(res.status, code).toBe(status);
        const body = await res.json() as { error: { code: string } };
        expect(body.error.code).toBe(code === 'script_not_found' ? 'SCRIPT_NOT_FOUND' : code
          .toUpperCase());
      }
    });

    it('deny-правило блокирует запуск — 403 SCRIPT_DENIED', async () => {
      const service = makeService();
      const app = makeApp({
        scriptService: service,
        permissionConfig: { rules: { script: 'deny' }, askTimeoutMs: 1000 },
      });
      const res = await app.request(`/api/v2/sessions/${SESSION_ID}/scripts/dev/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(403);
      const body = await res.json() as { error: { code: string } };
      expect(body.error.code).toBe('SCRIPT_DENIED');
      expect((service.run as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });

    it('ask-правило не блокирует (человек инициировал действие)', async () => {
      const app = makeApp({
        scriptService: makeService(),
        permissionConfig: { rules: { script: 'ask' }, askTimeoutMs: 1000 },
      });
      const res = await app.request(`/api/v2/sessions/${SESSION_ID}/scripts/dev/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(202);
    });
  });

  describe('контур недоступен', () => {
    it('без сервиса — 404 SCRIPTS_UNAVAILABLE', async () => {
      const app = makeApp();
      const res = await app.request(`/api/v2/sessions/${SESSION_ID}/scripts`);

      expect(res.status).toBe(404);
      const body = await res.json() as { error: { code: string } };
      expect(body.error.code).toBe('SCRIPTS_UNAVAILABLE');
    });
  });
});

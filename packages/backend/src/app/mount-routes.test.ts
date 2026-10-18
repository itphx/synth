/**
 * Контракт монтирования роутов backend (`src/app/mount-routes.ts`) — тесты на
 * РЕАЛЬНО смонтированном приложении (`createBackendApp`), а не на отдельных
 * фабриках. Цель — ловить ОСЛАБЛЕНИЕ защиты, а не «фабрика вызвалась»:
 *
 * 1) перепись по таблице маршрутов (`app.routes`) — ключевые роуты смонтированы
 *    (пропажа `app.route(...)` ломает API, но не типы);
 * 2) публичные эндпоинты остаются публичными (`/health`, i18n);
 * 3) защищённые эндпоинты без креды → 401/403 (никогда 2xx): снятие guard'а
 *    делает тест красным;
 * 4) RBAC-матрица по ролям (USER / ADMIN / LEAD / AUDITOR) — `requireAdmin`,
 *    `requirePermission('ADMIN','LEAD')`, `requirePermission('ADMIN','AUDITOR')`
 *    на месте там, где задокументировано (`docs/API_V2.md` §5);
 * 5) доступ по id сессии — единая точка (`canAccess`/`resolveElevated`/
 *    `resolveCanAccessExtra`) фабрики `createSessionRoutes`: владелец → 200,
 *    чужой USER → 403 `FORBIDDEN`, LEAD/ADMIN → 200 (сквозной обзор),
 *    AUDITOR → 403;
 * 6) live-проводка runtime-настроек «События» (`deps.live.setEvents`) — PUT
 *    `/settings/events` реально глушит приём событий (503).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBackendApp } from '../app.js';
import type { BackendAppHandle } from '../app.js';

const ADMIN = 'admin-key-123';
const USER = 'user-key-456';
const LEAD = 'lead-key-789';
const AUDITOR = 'auditor-key-012';

const stopHandle = (b: BackendAppHandle): void => {
  b.stopScheduler();
  b.stopEphemeralSweeper();
  b.stopEventJournalPruner();
  b.stopWebhookService();
  b.stopWebhookDeliveryPruner();
  b.stopMetrics();
};

describe('backend: контракт монтирования роутов (mount-routes)', () => {
  let dataDir: string;
  let backend: BackendAppHandle;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'synth-backend-mount-'));
    backend = await createBackendApp({
      dataDir,
      authDebug: true,
      // ADR-094: фиксируем выключенные метрики (иначе внешний env инстанса
      // сделал бы проверку «серии не создаются» недетерминированной).
      env: { SYNTH_METRICS_ENABLED: 'false' },
    });
  });

  afterAll(async () => {
    stopHandle(backend);
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const req = (path: string, init: RequestInit = {}, token?: string): Promise<Response> =>
    Promise.resolve(backend.app.request(path, {
      ...init,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init.headers ?? {}),
      },
    }));

  const json = (path: string, body: unknown, token?: string, method = 'POST'): Promise<Response> =>
    req(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, token);

  // ---------------------------------------------------------------------------
  // 1. Перепись по таблице маршрутов
  // ---------------------------------------------------------------------------

  it('ключевые роуты смонтированы (перепись по app.routes)', () => {
    const mounted = new Set(backend.app.routes.map((r) => `${r.method.toUpperCase()} ${r.path}`));
    const expected = [
      'GET /health',
      'GET /api/v2/health',
      // ADR-094: readiness отделён от liveness, `/metrics` — экспорт Prometheus.
      'GET /ready',
      'GET /metrics',
      'GET /api/v2/openapi.json',
      // sessions — core-фабрика с prefix-guard'ом доступа
      'GET /api/v2/sessions',
      'POST /api/v2/sessions',
      'GET /api/v2/sessions/:id',
      'POST /api/v2/sessions/:id/abort',
      // проекты/сообщения/очередь — общая семантика RBAC
      'GET /api/v2/projects',
      'GET /api/v2/messages/:sessionId/:index/debug',
      'POST /api/v2/queue/:sessionId/clear',
      // backend-only группы
      'GET /api/v2/events/bindings',
      'GET /api/v2/events/journal',
      'GET /api/v2/events/routes',
      'POST /api/v2/events',
      'GET /api/v2/events',
      'GET /api/v2/schedules',
      'POST /api/v2/schedules/:id/run',
      'GET /api/v2/service-keys',
      'GET /api/v2/webhooks',
      'GET /api/v2/maintenance/status',
      'GET /api/v2/mcp/registry',
      'GET /api/v2/audit',
      // PROP-102: аналитика (только чтение)
      'GET /api/v2/analytics/summary',
      'GET /api/v2/analytics/usage',
      'GET /api/v2/analytics/export',
      'GET /api/v2/logs/llm',
      'GET /api/v2/gateway/patterns',
      'GET /api/v2/me/identities',
      'GET /api/v2/users',
      'GET /api/v2/context/files',
      'GET /api/v2/settings/events',
      'PUT /api/v2/settings/events',
      'GET /api/v2/fs',
      'GET /api/v2/git/log',
      'GET /api/v2/ssh-keys',
      'GET /api/v2/skills',
      'GET /api/v2/commands',
      'GET /api/v2/skill-bundles',
      'GET /api/v2/dictionaries',
      'GET /api/v2/admin/debug/config',
    ];
    for (const e of expected) {
      expect(mounted.has(e), `не смонтирован роут: ${e}`).toBe(true);
    }
  });

  // ---------------------------------------------------------------------------
  // 2. Публичные эндпоинты
  // ---------------------------------------------------------------------------

  it('публичные эндпоинты доступны без аутентификации', async () => {
    for (const path of [
      '/health',
      '/api/v2/health',
      '/ready',
      '/api/v2/i18n/current',
      '/api/v2/i18n/translations/ru',
      '/api/v2/i18n/translations/en',
      '/api/config/themes',
    ]) {
      const res = await req(path);
      expect(res.status, `публичный роут ${path}`).toBe(200);
    }
  });

  it('ADR-094: /ready публичный, /metrics при metrics.enabled=false → 404 и серии не создаются', async () => {
    const ready = await req('/ready');
    expect(ready.status).toBe(200);
    const readyBody = (await ready.json()) as { status: string; storage: string };
    expect(readyBody.status).toBe('ready');
    expect(readyBody.storage).toBe('ok');

    const res = await req('/metrics');
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND');
    // Middleware не установлен — HTTP-серии не появились от предыдущих запросов.
    expect(backend.metrics.render().series).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // 3. Защищённые эндпоинты без креды
  // ---------------------------------------------------------------------------

  const PROTECTED_GET = [
    '/api/v2/sessions',
    '/api/v2/projects',
    '/api/v2/agents',
    '/api/v2/agents/all',
    '/api/v2/providers',
    '/api/v2/models',
    '/api/v2/messages/unknown',
    '/api/v2/queue/unknown',
    '/api/v2/git/log?project_id=x',
    '/api/v2/ssh-keys',
    '/api/v2/fs?project_id=x',
    '/api/v2/events/bindings',
    '/api/v2/events/routes',
    '/api/v2/events/journal',
    '/api/v2/schedules',
    '/api/v2/service-keys',
    '/api/v2/webhooks',
    '/api/v2/maintenance/status',
    '/api/v2/maintenance/backups',
    '/api/v2/mcp/registry',
    '/api/v2/skills',
    '/api/v2/commands',
    '/api/v2/skill-bundles',
    '/api/v2/dictionaries',
    '/api/v2/settings/workspace',
    '/api/v2/settings/events',
    '/api/v2/settings/tools-policy',
    '/api/v2/me/identities',
    '/api/v2/users',
    '/api/v2/context/files',
    '/api/v2/audit',
    '/api/v2/logs/llm',
    '/api/v2/gateway/patterns',
    '/api/v2/admin/debug/config',
    '/api/v2/openapi.json',
    '/api/v2/events',
    // PROP-102: аналитика — только чтение, но под requireAuth
    '/api/v2/analytics/summary',
    '/api/v2/analytics/usage',
    '/api/v2/analytics/export?report=usage&format=csv',
  ];

  it('защищённые эндпоинты без креды → 401/403, но не 2xx', async () => {
    for (const path of PROTECTED_GET) {
      const res = await req(path);
      expect([401, 403], `без креды на ${path} (получен ${res.status})`).toContain(res.status);
    }
  });

  it('`requireAuth`-роуты без креды отдают именно 401', async () => {
    for (const path of [
      '/api/v2/sessions',
      '/api/v2/projects',
      '/api/v2/agents',
      '/api/v2/providers',
      '/api/v2/models',
      '/api/v2/git/log?project_id=x',
      '/api/v2/ssh-keys',
      '/api/v2/events/bindings',
      '/api/v2/events/routes',
      '/api/v2/events/journal',
      '/api/v2/schedules',
      '/api/v2/settings/workspace',
      '/api/v2/me/identities',
      '/api/v2/dictionaries',
      '/api/v2/mcp/registry',
      '/api/v2/skills',
      '/api/v2/commands',
      '/api/v2/skill-bundles',
      '/api/v2/openapi.json',
      '/api/v2/events', // SSE-хаб: requireAuth + scope, до стрима
    ]) {
      const res = await req(path);
      expect(res.status, `requireAuth на ${path}`).toBe(401);
    }
  });

  it('мутации без креды не выполняются (401/403)', async () => {
    const mutations: Array<{ method: string; path: string; body: unknown }> = [
      { method: 'POST', path: '/api/v2/sessions', body: { name: 'x' } },
      { method: 'POST', path: '/api/v2/projects', body: { name: 'x' } },
      { method: 'POST', path: '/api/v2/service-keys', body: { label: 'x', roles: ['USER'] } },
      { method: 'POST', path: '/api/v2/webhooks', body: { label: 'x', url: 'https://example.com', events: ['*'] } },
      { method: 'POST', path: '/api/v2/maintenance/backups', body: {} },
      { method: 'POST', path: '/api/v2/agents', body: { id: 'x' } },
      { method: 'POST', path: '/api/v2/events/bindings', body: {} },
      { method: 'POST', path: '/api/v2/schedules', body: {} },
      { method: 'PUT', path: '/api/v2/dictionaries/test/ru', body: { entries: [] } },
      { method: 'POST', path: '/api/v2/fs/write', body: { projectId: 'x', path: 'a', content: 'b' } },
      { method: 'PUT', path: '/api/v2/settings/events', body: { events: { enabled: false } } },
    ];
    for (const { method, path, body } of mutations) {
      const res = await json(path, body, undefined, method);
      expect([401, 403], `без креды на ${method} ${path} (получен ${res.status})`).toContain(res.status);
    }
  });

  it('ADMIN-роуты (requirePermission/requireAdminOrScope): аноним → 401, USER → 403, ADMIN → 2xx', async () => {
    // Семантика HTTP на РЕАЛЬНОМ наборе guard'ов смонтированного приложения:
    // нет аутентификации → 401 UNAUTHORIZED; аутентифицирован без роли → 403 FORBIDDEN.
    for (const path of ['/api/v2/maintenance/status', '/api/v2/service-keys', '/api/v2/webhooks']) {
      const anon = await req(path);
      expect(anon.status, `аноним ${path}`).toBe(401);
      expect(((await anon.json()) as { error: { code: string } }).error.code).toBe('UNAUTHORIZED');

      const user = await req(path, {}, USER);
      expect(user.status, `USER ${path}`).toBe(403);
      expect(((await user.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN');

      const admin = await req(path, {}, ADMIN);
      expect([401, 403], `ADMIN ${path} (получен ${admin.status})`).not.toContain(admin.status);
    }
  });

  // ---------------------------------------------------------------------------
  // 4. RBAC-матрица по ролям
  // ---------------------------------------------------------------------------

  /** ADMIN-only (requireAdmin / requireAdminOrScope / requirePermission('ADMIN')). */
  const ADMIN_ONLY_GET = [
    '/api/v2/users',
    '/api/v2/context/files',
    '/api/v2/context/enabled',
    '/api/v2/audit',
    '/api/v2/logs/llm',
    '/api/v2/gateway/patterns',
    '/api/v2/admin/debug/config',
    '/api/v2/agents/all',
    '/api/v2/service-keys',
    '/api/v2/webhooks',
    '/api/v2/maintenance/status',
    '/api/v2/maintenance/backups',
  ];

  it('ADMIN-only GET: USER → 403, ADMIN → доступ', async () => {
    for (const path of ADMIN_ONLY_GET) {
      expect((await req(path, {}, USER)).status, `USER на ${path}`).toBe(403);
      const admin = await req(path, {}, ADMIN);
      expect([401, 403], `ADMIN на ${path} (получен ${admin.status})`).not.toContain(admin.status);
    }
  });

  it('ADMIN-only мутации: USER → 403, ADMIN → не 401/403', async () => {
    const cases: Array<[string, unknown, string]> = [
      ['/api/v2/agents', { id: 'demo-agent', displayName: 'Demo' }, 'POST'],
      ['/api/v2/users', { username: 'u1' }, 'POST'],
      ['/api/v2/dictionaries/test/ru', { entries: [] }, 'PUT'],
      ['/api/v2/skill-bundles', { name: 'b1', skills: [] }, 'POST'],
      ['/api/v2/ssh-keys', { name: 'k', privateKey: 'x' }, 'POST'],
    ];
    for (const [path, body, method] of cases) {
      expect((await json(path, body, USER, method)).status, `USER на ${method} ${path}`).toBe(403);
      const admin = await json(path, body, ADMIN, method);
      expect([401, 403], `ADMIN на ${method} ${path} (получен ${admin.status})`).not.toContain(admin.status);
    }
  });

  it('ADMIN/LEAD-эндпоинты событий: USER/AUDITOR → 403, LEAD/ADMIN → доступ', async () => {
    const cases: Array<{ method: string; path: string; body?: unknown }> = [
      { method: 'POST', path: '/api/v2/events/bindings', body: { source: 'test', sessionId: 'x' } },
      { method: 'GET', path: '/api/v2/events/bindings/unknown/keys' },
      { method: 'DELETE', path: '/api/v2/events/bindings/unknown' },
    ];
    for (const { method, path, body } of cases) {
      const call = (token: string): Promise<Response> =>
        body === undefined ? req(path, { method }, token) : json(path, body, token, method);
      expect((await call(USER)).status, `USER на ${method} ${path}`).toBe(403);
      expect((await call(AUDITOR)).status, `AUDITOR на ${method} ${path}`).toBe(403);
      for (const token of [LEAD, ADMIN]) {
        const res = await call(token);
        expect([401, 403], `${token} на ${method} ${path} (получен ${res.status})`).not.toContain(res.status);
      }
    }
  });

  it('ADMIN/AUDITOR-чтение (audit/logs): USER → 403, AUDITOR → доступ', async () => {
    for (const path of ['/api/v2/audit', '/api/v2/logs/llm']) {
      expect((await req(path, {}, USER)).status, `USER на ${path}`).toBe(403);
      const auditor = await req(path, {}, AUDITOR);
      expect([401, 403], `AUDITOR на ${path} (получен ${auditor.status})`).not.toContain(auditor.status);
    }
  });

  it('PROP-102: аналитика — elevated/auditor сквозной обзор; USER → свой скоуп + 403 на сквозные', async () => {
    // ADMIN/LEAD/AUDITOR — сквозной обзор: сводка и любые отчёты 200.
    for (const token of [ADMIN, LEAD, AUDITOR]) {
      expect((await req('/api/v2/analytics/summary', {}, token)).status, `summary ${token}`).toBe(200);
      expect((await req('/api/v2/analytics/usage', {}, token)).status, `usage ${token}`).toBe(200);
      expect((await req('/api/v2/analytics/decision', {}, token)).status, `decision ${token}`).toBe(200);
    }
    // Обычный USER: сводка и `decision` (сквозные, без оси user) → 403 FORBIDDEN.
    const summary = await req('/api/v2/analytics/summary', {}, USER);
    expect(summary.status).toBe(403);
    expect(((await summary.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN');
    expect((await req('/api/v2/analytics/decision', {}, USER)).status).toBe(403);
    // ...но собственный отчёт по себе — 200 (принудительный скоуп оси `user`).
    expect((await req('/api/v2/analytics/usage', {}, USER)).status).toBe(200);
    // Невалидный groupBy → 400 VALIDATION_ERROR (валидация — в сервисе).
    const bad = await req('/api/v2/analytics/usage?groupBy=nonsense', {}, ADMIN);
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
    // export: невалидный report/format → 400; корректный — 200 CSV.
    expect((await req('/api/v2/analytics/export?report=nope&format=csv', {}, ADMIN)).status).toBe(400);
    const csv = await req('/api/v2/analytics/export?report=usage&format=csv', {}, ADMIN);
    expect(csv.status).toBe(200);
    expect(csv.headers.get('content-type')).toContain('text/csv');
  });

  it('runtime-настройки «События»/decision: мутации только ADMIN (USER → 403)', async () => {
    expect((await json('/api/v2/settings/events', { events: { enabled: true } }, USER, 'PUT')).status).toBe(403);
    expect((await json('/api/v2/settings/decision', { decision: {} }, USER, 'PUT')).status).toBe(403);
    expect((await req('/api/v2/settings/decision/metrics', { method: 'DELETE' }, USER)).status).toBe(403);
    // GET остаётся доступен обычному пользователю (auth, не ADMIN).
    expect((await req('/api/v2/settings/events', {}, USER)).status).toBe(200);
    expect((await req('/api/v2/settings/decision', {}, USER)).status).toBe(200);
  });

  it('чтение instance-настроек доступно USER (GET не ограничивается ADMIN)', async () => {
    // Ограничиваются только мутации; чтение остаётся `auth` (UI/агенты читают настройки).
    for (const path of [
      '/api/v2/settings/workspace',
      '/api/v2/settings/mcp',
      '/api/v2/settings/llm-gateway',
      '/api/v2/settings/security',
      '/api/v2/settings/tools-policy',
      '/api/v2/settings/mcp-policy',
      '/api/v2/settings/mcp-network-policy',
      '/api/v2/settings/default-agent',
      '/api/v2/settings/workspace-policy',
      '/api/v2/settings/tools-disabled',
      '/api/v2/settings/protected-paths',
    ]) {
      expect((await req(path, {}, USER)).status, `USER GET ${path}`).toBe(200);
    }
  });

  it('instance-wide мутации настроек: USER/LEAD/AUDITOR → 403, ADMIN → 2xx', async () => {
    // Все мутации `/api/v2/settings/*` меняют состояние всего инстанса —
    // в managed доступны только ADMIN (`settingsWriteGuard`). PUT/DELETE идут
    // парами, чтобы прогон не оставлял runtime-переопределений.
    const cases: Array<{ method: string; path: string; body?: unknown; adminStatus?: number }> = [
      { method: 'PUT', path: '/api/v2/settings/workspace', body: { workspace: '/tmp/mount-ws' } },
      { method: 'DELETE', path: '/api/v2/settings/workspace' },
      { method: 'PUT', path: '/api/v2/settings/mcp', body: { servers: {} } },
      { method: 'DELETE', path: '/api/v2/settings/mcp' },
      { method: 'PUT', path: '/api/v2/settings/llm-gateway', body: { llmGateway: {} } },
      { method: 'DELETE', path: '/api/v2/settings/llm-gateway' },
      { method: 'PUT', path: '/api/v2/settings/security', body: { security: {} } },
      { method: 'DELETE', path: '/api/v2/settings/security' },
      { method: 'PUT', path: '/api/v2/settings/tools-policy', body: { toolsPolicy: 'auto' } },
      { method: 'DELETE', path: '/api/v2/settings/tools-policy' },
      { method: 'PUT', path: '/api/v2/settings/mcp-policy', body: { mcpPolicy: 'auto' } },
      { method: 'DELETE', path: '/api/v2/settings/mcp-policy' },
      { method: 'PUT', path: '/api/v2/settings/mcp-network-policy', body: { policy: { mode: 'deny', list: [] } } },
      { method: 'DELETE', path: '/api/v2/settings/mcp-network-policy' },
      { method: 'PUT', path: '/api/v2/settings/default-agent', body: { defaultAgent: 'assistant' } },
      { method: 'DELETE', path: '/api/v2/settings/default-agent' },
      { method: 'PUT', path: '/api/v2/settings/tools-disabled', body: { toolsDisabled: { capabilities: [], tools: [] } } },
      { method: 'DELETE', path: '/api/v2/settings/tools-disabled' },
      {
        method: 'PUT',
        path: '/api/v2/settings/protected-paths',
        body: { policy: { deniedPaths: [], deniedPrefixes: [], approvalPaths: [], deniedCommandPrefixes: [] } },
      },
      { method: 'DELETE', path: '/api/v2/settings/protected-paths' },
      { method: 'PUT', path: '/api/v2/settings/events', body: { events: { enabled: true } } },
      { method: 'DELETE', path: '/api/v2/settings/events' },
      { method: 'PUT', path: '/api/v2/settings/decision', body: { decision: {} } },
      { method: 'DELETE', path: '/api/v2/settings/decision' },
      { method: 'DELETE', path: '/api/v2/settings/decision/metrics' },
      // Managed: политика workspace вне root — read-only (403 всем, включая ADMIN).
      { method: 'PUT', path: '/api/v2/settings/workspace-policy', body: { outsideRoot: 'confirm' }, adminStatus: 403 },
      { method: 'DELETE', path: '/api/v2/settings/workspace-policy', adminStatus: 403 },
    ];
    for (const { method, path, body, adminStatus = 200 } of cases) {
      const call = (token: string): Promise<Response> =>
        body === undefined ? req(path, { method }, token) : json(path, body, token, method);
      for (const token of [USER, LEAD, AUDITOR]) {
        expect((await call(token)).status, `${token} на ${method} ${path}`).toBe(403);
      }
      const admin = await call(ADMIN);
      expect(admin.status, `ADMIN на ${method} ${path} (получен ${admin.status})`).toBe(adminStatus);
    }
  });

  it('instance-настройки и service-key: роль ADMIN проходит, роль USER → 403', async () => {
    // scope-гейт (`addons:install`) к настройкам инстанса не применяется —
    // доступ в managed определяется ролью ADMIN; service-key с ней работает.
    const adminKeyRes = await json('/api/v2/service-keys', { label: 'mount-settings-admin', roles: ['ADMIN'], scopes: ['sessions:read'] }, ADMIN);
    expect(adminKeyRes.status).toBe(201);
    const adminSvc = ((await adminKeyRes.json()) as { key: string }).key;
    const allowed = await json('/api/v2/settings/tools-policy', { toolsPolicy: 'auto' }, adminSvc, 'PUT');
    expect(allowed.status).toBe(200);

    const userKeyRes = await json('/api/v2/service-keys', { label: 'mount-settings-user', roles: ['USER'], scopes: ['sessions:read'] }, ADMIN);
    expect(userKeyRes.status).toBe(201);
    const userSvc = ((await userKeyRes.json()) as { key: string }).key;
    const denied = await json('/api/v2/settings/tools-policy', { toolsPolicy: 'auto' }, userSvc, 'PUT');
    expect(denied.status).toBe(403);
  });

  // ---------------------------------------------------------------------------
  // 5. Доступ по id сессии — единая точка фабрики sessions
  // ---------------------------------------------------------------------------

  describe('доступ по id сессии (canAccess / resolveElevated / resolveCanAccessExtra)', () => {
    /** Чужой USER — service-key с ролью USER и scope чтения сессий (отличный от владельца id). */
    async function strangerUserKey(): Promise<string> {
      const res = await json(
        '/api/v2/service-keys',
        { label: 'mount-stranger', roles: ['USER'], scopes: ['sessions:read'] },
        ADMIN,
      );
      expect(res.status).toBe(201);
      return ((await res.json()) as { key: string }).key;
    }

    it('владелец → 200; чужой USER → 403 FORBIDDEN; LEAD/ADMIN → 200; AUDITOR → 403', async () => {
      const created = await json('/api/v2/sessions', { name: 'mount-access' }, USER);
      expect(created.status).toBe(201);
      const sessionId = ((await created.json()) as { id: string }).id;

      expect((await req(`/api/v2/sessions/${sessionId}`, {}, USER)).status).toBe(200);
      expect((await req(`/api/v2/sessions/${sessionId}`, {}, LEAD)).status).toBe(200);
      expect((await req(`/api/v2/sessions/${sessionId}`, {}, ADMIN)).status).toBe(200);
      expect((await req(`/api/v2/sessions/${sessionId}`, {}, AUDITOR)).status).toBe(403);

      const strangerKey = await strangerUserKey();
      const denied = await req(`/api/v2/sessions/${sessionId}`, {}, strangerKey);
      expect(denied.status).toBe(403);
      expect(((await denied.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN');

      // Мутация чужой сессии тем же «чужим» USER — тоже 403 (read/write выводятся из метода).
      const writeDenied = await req(`/api/v2/sessions/${sessionId}`, { method: 'DELETE' }, strangerKey);
      expect(writeDenied.status).toBe(403);
    });

    it('GET несуществующей сессии → 404 (не раскрывает доступ)', async () => {
      const res = await req('/api/v2/sessions/does-not-exist', {}, USER);
      expect(res.status).toBe(404);
    });
  });

  // ---------------------------------------------------------------------------
  // 6. Live-проводка runtime-настроек «События» (mount-routes → deps.live)
  // ---------------------------------------------------------------------------

  it('PUT /settings/events {enabled:false} глушит приём событий (503 UNAVAILABLE)', async () => {
    const off = await json('/api/v2/settings/events', { events: { enabled: false } }, ADMIN, 'PUT');
    expect(off.status).toBe(200);

    const ingestOff = await json('/api/v2/events', { source: 'test', type: 'ping' }, ADMIN);
    expect(ingestOff.status).toBe(503);
    expect(((await ingestOff.json()) as { error: { code: string } }).error.code).toBe('UNAVAILABLE');

    // Возврат: приём снова включён; невалидное JSON-тело → 400 (а не 503).
    const on = await json('/api/v2/settings/events', { events: { enabled: true } }, ADMIN, 'PUT');
    expect(on.status).toBe(200);
    const ingestOn = await req(
      '/api/v2/events',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' },
      ADMIN,
    );
    expect(ingestOn.status).toBe(400);
    expect(((await ingestOn.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');

    // Чистый сброс runtime-настроек (чтобы не влиять на другие прогоны/файлы).
    const reset = await req('/api/v2/settings/events', { method: 'DELETE' }, ADMIN);
    expect(reset.status).toBe(200);
  });

  // ---------------------------------------------------------------------------
  // 7. Managed-специфика: FS workspace-root запрещён
  // ---------------------------------------------------------------------------

  it('managed: /api/v2/fs/workspace-root → 403 FORBIDDEN даже для ADMIN', async () => {
    const res = await req('/api/v2/fs/workspace-root', {}, ADMIN);
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// 8. ADR-094: включённый экспорт метрик (env SYNTH_METRICS_ENABLED)
// ---------------------------------------------------------------------------

describe('backend: /metrics при metrics.enabled=true (ADR-094)', () => {
  let dataDir: string;
  let backend: BackendAppHandle;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'synth-backend-metrics-'));
    backend = await createBackendApp({
      dataDir,
      authDebug: true,
      env: { SYNTH_METRICS_ENABLED: 'true' },
    });
  });

  afterAll(async () => {
    stopHandle(backend);
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('HTTP/процессные метрики + доменные коллекторы в ответе', async () => {
    // Запрос до скрейпа — появляется HTTP-серия с шаблоном маршрута.
    expect((await backend.app.request('/health')).status).toBe(200);

    // ADR-094: readiness переключён в ready после композиции.
    const ready = await backend.app.request('/ready');
    expect(ready.status).toBe(200);
    expect((await ready.json()) as { status: string }).toMatchObject({ status: 'ready', storage: 'ok' });

    const res = await backend.app.request('/metrics');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain; version=0.0.4; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store');

    const body = await res.text();
    expect(body).toContain('# TYPE synth_http_requests_total counter');
    expect(body).toContain('synth_http_requests_total{method="GET",route="/health",status="200"} 1');
    expect(body).toContain('# TYPE synth_http_request_duration_seconds histogram');
    expect(body).toContain('# TYPE synth_http_in_flight gauge');
    expect(body).toContain('# TYPE synth_http_streams_active gauge');
    expect(body).toContain('# HELP synth_metrics_series');
    expect(body).toContain('# TYPE synth_metrics_scrape_duration_seconds gauge');
    expect(body).toContain('# TYPE synth_process_uptime_seconds gauge');
    expect(body).toContain('# TYPE synth_build_info gauge');

    // ADR-094: readiness и доменные коллекторы backend (bus/sessions/storage/decision/
    // scheduler/webhooks/events) подключены при `metrics.enabled=true`.
    expect(body).toContain('synth_ready 1');
    expect(body).toContain('synth_storage_backend_info{backend="file"} 1');
    expect(body).toContain('# TYPE synth_decision_calls_total counter');
    expect(body).toContain('# TYPE synth_scheduler_jobs_total counter');
    expect(body).toContain('# TYPE synth_webhook_deliveries_total counter');
    expect(body).toContain('# TYPE synth_events_ingested_total counter');
    expect(body).toContain('# TYPE synth_sessions_active gauge');
    expect(body).toContain('# TYPE synth_queue_pending gauge');

    // `synth_metrics_series` учитывает и собственные служебные серии скрейпа.
    expect(body).toMatch(/synth_metrics_series \d+/);
    expect(body).not.toContain('synth_metrics_series 0');
  });
});

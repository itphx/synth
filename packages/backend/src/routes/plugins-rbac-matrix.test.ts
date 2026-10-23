/**
 * PROP-090 §«HTTP API» / Ф5б-2: **своя** RBAC-матрица контура плагинов
 * (`/api/v2/plugins*`, `/api/v2/settings/plugins`).
 *
 * Матрица сессий (`session-idor-matrix.test.ts`) здесь не применима: ресурс —
 * не сессия, а инстанс-уровневый реестр расширений. Правило (PROP-090
 * §«HTTP API», «Правило RBAC»):
 *
 * | Действие                         | core (standalone) | managed                          |
 * |----------------------------------|-------------------|----------------------------------|
 * | чтение (список/деталь/настройки) | `requireAuth`     | **ADMIN**                        |
 * | установка/активация/деактивация  | `requireAuth`     | ADMIN или scope `addons:install` |
 * | подтверждение карантина, снятие  | `requireAuth`     | **только ADMIN**                 |
 * | `PUT/DELETE /settings/plugins`   | `requireAuth`     | **ADMIN**                        |
 *
 * Тест идёт по **реально смонтированному** приложению (`createBackendApp` +
 * `app.request`), а не по вызову фабрики: цель — ловить ослабление guard'ов
 * (сняли `requirePermission`/`requireAdminRoleOrScope` — тест красный), а не
 * «фабрика вызвалась». Негативная часть — USER/LEAD/AUDITOR → 403; позитивная —
 * ADMIN (2xx/ожидаемый код обработчика), service-key со scope `addons:install`
 * и service-key без scope (403 `SCOPE_REQUIRED`).
 *
 * Коды обработчика проверяются там, где они и есть доказательство «guard
 * пропустил»: managed-запрет локальной установки → 403 `LOCAL_INSTALL_DISABLED`,
 * `update` без `name` → 400 `VALIDATION_ERROR`, `enable`/`rollback`
 * несуществующего → 404 `plugin.not_found`, снятие несуществующего → 204
 * (идемпотентно).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createBackendApp } from '../app.js';
import type { BackendAppHandle } from '../app.js';

const ADMIN = 'admin-key-123';
const USER = 'user-key-456';
const LEAD = 'lead-key-789';
const AUDITOR = 'auditor-key-012';

/** Остановить фоновые подсистемы backend (как в mount-routes.test.ts). */
const stopHandle = (b: BackendAppHandle): void => {
  b.stopScheduler();
  b.stopEphemeralSweeper();
  b.stopEventJournalPruner();
  b.stopWebhookService();
  b.stopWebhookDeliveryPruner();
  b.stopMetrics();
};

describe('backend: RBAC-матрица контура плагинов (PROP-090 Ф5б-2)', () => {
  let dataDir: string;
  let backend: BackendAppHandle;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'synth-backend-plugins-'));
    backend = await createBackendApp({
      dataDir,
      authDebug: true,
      // Детерминизм: метрики инстанса выключены (внешний env не влияет).
      env: { SYNTH_METRICS_ENABLED: 'false' },
    });
  });

  afterAll(async () => {
    stopHandle(backend);
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const req = (path: string, init: RequestInit = {}, token?: string): Promise<Response> =>
    Promise.resolve(
      backend.app.request(path, {
        ...init,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(init.headers ?? {}),
        },
      }),
    );

  const json = (
    path: string,
    body: unknown,
    token?: string,
    method = 'POST',
  ): Promise<Response> =>
    req(
      path,
      { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      token,
    );

  /** Создать service-key (ADMIN) и вернуть секрет `synth_svc_…`. */
  async function createServiceKey(input: {
    label: string;
    roles?: string[];
    scopes?: string[];
  }): Promise<string> {
    const res = await json(
      '/api/v2/service-keys',
      { roles: ['USER'], scopes: [], ...input },
      ADMIN,
    );
    expect(res.status, `создание ключа ${input.label}`).toBe(201);
    return ((await res.json()) as { key: string }).key;
  }

  /** Код ошибки из `{error:{code}}`. */
  async function errorCode(res: Response): Promise<string> {
    const body = (await res.json()) as { error?: { code?: string } };
    return body.error?.code ?? '';
  }

  // -------------------------------------------------------------------------
  // 0. Перепись маршрутов — смонтированы (пропажа app.route ломает API)
  // -------------------------------------------------------------------------
  it('маршруты плагинов и настроек смонтированы', () => {
    const mounted = new Set(backend.app.routes.map((r) => `${r.method.toUpperCase()} ${r.path}`));
    for (const route of [
      'GET /api/v2/plugins',
      'GET /api/v2/plugins/:name',
      'POST /api/v2/plugins/install',
      'POST /api/v2/plugins/token',
      'POST /api/v2/plugins/update',
      'POST /api/v2/plugins/:name/approve',
      'POST /api/v2/plugins/:name/enable',
      'POST /api/v2/plugins/:name/disable',
      'POST /api/v2/plugins/:name/rollback',
      'DELETE /api/v2/plugins/:name',
      'GET /api/v2/settings/plugins',
      'PUT /api/v2/settings/plugins',
      'DELETE /api/v2/settings/plugins',
    ]) {
      expect(mounted.has(route), `маршрут ${route} должен быть смонтирован`).toBe(true);
    }
  });

  // -------------------------------------------------------------------------
  // 1. Негативная матрица: USER / LEAD / AUDITOR → 403 на всех действиях
  // -------------------------------------------------------------------------
  it('негативная матрица: не-ADMIN → 403 на каждом действии контура плагинов', async () => {
    const cases: Array<{ method: string; path: string; body?: unknown }> = [
      { method: 'GET', path: '/api/v2/plugins' },
      { method: 'GET', path: '/api/v2/plugins/demo-plugin' },
      { method: 'POST', path: '/api/v2/plugins/install', body: { path: '/tmp/whatever' } },
      { method: 'POST', path: '/api/v2/plugins/token', body: { pluginId: 'demo-plugin' } },
      { method: 'POST', path: '/api/v2/plugins/update', body: {} },
      { method: 'POST', path: '/api/v2/plugins/demo-plugin/approve' },
      { method: 'POST', path: '/api/v2/plugins/demo-plugin/enable' },
      { method: 'POST', path: '/api/v2/plugins/demo-plugin/disable' },
      { method: 'POST', path: '/api/v2/plugins/demo-plugin/rollback' },
      { method: 'DELETE', path: '/api/v2/plugins/demo-plugin' },
      { method: 'GET', path: '/api/v2/settings/plugins' },
      { method: 'PUT', path: '/api/v2/settings/plugins', body: { executionEnabled: true } },
      { method: 'DELETE', path: '/api/v2/settings/plugins' },
    ];

    for (const { method, path, body } of cases) {
      for (const token of [USER, LEAD, AUDITOR]) {
        const res =
          body === undefined
            ? await req(path, { method }, token)
            : await json(path, body, token, method);
        expect(res.status, `${token} на ${method} ${path}`).toBe(403);
      }
    }
  });

  it('без креды → 401 (защита не «публичная»)', async () => {
    expect((await req('/api/v2/plugins')).status).toBe(401);
    expect((await req('/api/v2/settings/plugins')).status).toBe(401);
  });

  // -------------------------------------------------------------------------
  // 2. Позитивная матрица: ADMIN проходит guard и получает код обработчика
  // -------------------------------------------------------------------------
  it('ADMIN: список/настройки → 200, update без name → 400, установка → 403 LOCAL_INSTALL_DISABLED', async () => {
    const list = await req('/api/v2/plugins', {}, ADMIN);
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ plugins: [] });

    const settings = await req('/api/v2/settings/plugins', {}, ADMIN);
    expect(settings.status).toBe(200);
    const settingsBody = (await settings.json()) as { restartRequired: boolean };
    expect(settingsBody.restartRequired).toBe(true);

    const put = await json('/api/v2/settings/plugins', { promptBlockMaxChars: 4096 }, ADMIN, 'PUT');
    expect(put.status).toBe(200);

    const del = await req('/api/v2/settings/plugins', { method: 'DELETE' }, ADMIN);
    expect(del.status).toBe(200);

    // Managed: установка из локального каталога запрещена — guard пропустил,
    // отказ даёт режим инстанса (путь с ФС хоста не принимается).
    const install = await json('/api/v2/plugins/install', { path: '/tmp/bundle' }, ADMIN);
    expect(install.status).toBe(403);
    expect(await errorCode(install)).toBe('LOCAL_INSTALL_DISABLED');

    // `update`/`rollback`: guard пропустил, отказ даёт обработчик. Пустое тело
    // update — ошибка ввода (400), откат несуществующего — 404.
    const update = await json('/api/v2/plugins/update', {}, ADMIN);
    expect(update.status).toBe(400);
    expect(await errorCode(update)).toBe('VALIDATION_ERROR');
    const rollback = await json('/api/v2/plugins/absent/rollback', {}, ADMIN);
    expect(rollback.status).toBe(404);
    expect(await errorCode(rollback)).toBe('plugin.not_found');

    // Активация/подтверждение несуществующего — 404 (guard пропустил).
    const enable = await json('/api/v2/plugins/absent/enable', {}, ADMIN);
    expect(enable.status).toBe(404);
    expect(await errorCode(enable)).toBe('plugin.not_found');

    const approve = await json('/api/v2/plugins/absent/approve', {}, ADMIN);
    expect(approve.status).toBe(404);
    expect(await errorCode(approve)).toBe('plugin.not_found');

    // Снятие идемпотентно: нет записи — 204.
    const remove = await req('/api/v2/plugins/absent', { method: 'DELETE' }, ADMIN);
    expect(remove.status).toBe(204);
  });

  it('ADMIN: GET неизвестного плагина → 404 plugin.not_found', async () => {
    const res = await req('/api/v2/plugins/absent', {}, ADMIN);
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe('plugin.not_found');
  });

  // -------------------------------------------------------------------------
  // 3. Service-key: scope `addons:install` даёт установку/активацию, не снятие
  // -------------------------------------------------------------------------
  it('service-key со scope addons:install: install/update/rollback/enable разрешены, DELETE — только ADMIN', async () => {
    const key = await createServiceKey({
      label: 'plugins-scoped',
      roles: ['USER'],
      scopes: ['addons:install'],
    });

    // Установка: scope проходит guard, дальше — managed-запрет локального пути.
    const install = await json('/api/v2/plugins/install', { path: '/tmp/bundle' }, key);
    expect(install.status).toBe(403);
    expect(await errorCode(install)).toBe('LOCAL_INSTALL_DISABLED');

    // update/enable/rollback — тот же writeGuard.
    expect(
      (await json('/api/v2/plugins/update', {}, key)).status,
    ).toBe(400);
    expect((await json('/api/v2/plugins/absent/enable', {}, key)).status).toBe(404);
    expect((await json('/api/v2/plugins/absent/disable', {}, key)).status).toBe(404);
    expect((await json('/api/v2/plugins/absent/rollback', {}, key)).status).toBe(404);

    // Чтение реестра и настроек — только ADMIN (scope не заменяет роль).
    expect((await req('/api/v2/plugins', {}, key)).status).toBe(403);
    expect((await req('/api/v2/settings/plugins', {}, key)).status).toBe(403);

    // Подтверждение карантина и снятие — только ADMIN (scope не помогает).
    const approve = await json('/api/v2/plugins/absent/approve', {}, key);
    expect(approve.status).toBe(403);
    const remove = await req('/api/v2/plugins/absent', { method: 'DELETE' }, key);
    expect(remove.status).toBe(403);
  });

  it('service-key без scope addons:install → 403 SCOPE_REQUIRED на install/enable', async () => {
    const key = await createServiceKey({
      label: 'plugins-unscoped',
      roles: ['USER'],
      scopes: ['events:ingest'],
    });

    const install = await json('/api/v2/plugins/install', { path: '/tmp/bundle' }, key);
    expect(install.status).toBe(403);
    expect(await errorCode(install)).toBe('SCOPE_REQUIRED');

    const enable = await json('/api/v2/plugins/absent/enable', {}, key);
    expect(enable.status).toBe(403);
    expect(await errorCode(enable)).toBe('SCOPE_REQUIRED');

    const rollback = await json('/api/v2/plugins/absent/rollback', {}, key);
    expect(rollback.status).toBe(403);
    expect(await errorCode(rollback)).toBe('SCOPE_REQUIRED');
  });

  it('service-key с ролью ADMIN (без scope) проходит writeGuard установки', async () => {
    // `requireAdminRoleOrScope`: роль ADMIN у ключа — явное решение админа и
    // до введения зонтичных scope'ов давала доступ; сохраняем паритет.
    const key = await createServiceKey({
      label: 'plugins-admin-key',
      roles: ['ADMIN'],
      scopes: ['sessions:read'],
    });
    const install = await json('/api/v2/plugins/install', { path: '/tmp/bundle' }, key);
    expect(install.status).toBe(403);
    expect(await errorCode(install)).toBe('LOCAL_INSTALL_DISABLED');
    // Чтение для ключа с ролью ADMIN — 200 (readGuard = requirePermission('ADMIN')).
    expect((await req('/api/v2/plugins', {}, key)).status).toBe(200);
  });
});

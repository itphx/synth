import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { Context, MiddlewareHandler, Next } from 'hono';
import type { MaintenanceAuditEntry } from '@itphx/synth-shared';
import { createMaintenanceRoutes } from './maintenance.js';
import type { MaintenanceRoutesOptions } from './maintenance.js';
import { MemoryMaintenanceAuditRepository } from '../../storage/memory/audit.js';
import type { MaintenanceAuditRepository } from '../../storage/ports/index.js';

/** Mock-auth: requireAuth пропускает запрос (для проверки самих роутов). */
const passAuth = {
  requireAuth: (async (_c: Context, next: Next) => {
    await next();
  }) as MiddlewareHandler,
};

/** Mock-auth, эмулирующий отказ аутентификации (проверка дефолтного guard'а). */
const denyAuth = {
  requireAuth: (async (c: Context) =>
    c.json({ error: { code: 'UNAUTHORIZED', message: 'unauthorized' } }, 401)) as MiddlewareHandler,
};

describe('Maintenance API Routes (ADR-091/ADR-092)', () => {
  let tmpDir: string;

  const makeApp = (opts: MaintenanceRoutesOptions = {}, auth = passAuth): Hono => {
    const app = new Hono();
    app.route('/api/v2/maintenance', createMaintenanceRoutes(auth, { dataDir: tmpDir }, opts));
    return app;
  };

  const postJson = (app: Hono, path: string, body: unknown) =>
    app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  /** Создаёт реальный архив бэкапа через API и возвращает его имя. */
  const createBackupViaApi = async (app: Hono): Promise<string> => {
    const res = await postJson(app, '/api/v2/maintenance/backups', {});
    expect(res.status).toBe(200);
    return ((await res.json()) as { name: string }).name;
  };

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-maintenance-routes-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('GET /status — 200 и ожидаемая структура', async () => {
    const res = await makeApp().request('/api/v2/maintenance/status');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      version: string;
      dataDir: string;
      schema: { current: number; expected: number; applied: string[]; pending: unknown[] };
      backups: unknown[];
      pendingRestore: unknown;
      doctor: { ok: boolean; fail: number; warn: number };
    };
    expect(typeof body.version).toBe('string');
    expect(body.version.length).toBeGreaterThan(0);
    expect(body.dataDir).toBe(tmpDir);
    expect(body.schema.current).toBe(0);
    expect(body.schema.expected).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(body.schema.pending)).toBe(true);
    expect(body.backups).toEqual([]);
    expect(body.pendingRestore).toBeNull();
    expect(typeof body.doctor.ok).toBe('boolean');
  });

  it('GET /doctor — 200 и список проверок', async () => {
    const res = await makeApp().request('/api/v2/maintenance/doctor');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { checks: Array<{ id: string }> };
    expect(body.checks.some((check) => check.id === 'data-dir')).toBe(true);
  });

  it('GET /migrations — current/expected/applied/pending', async () => {
    const res = await makeApp().request('/api/v2/maintenance/migrations');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      current: number;
      expected: number;
      applied: string[];
      pending: Array<{ id: string; toVersion: number; description: string }>;
    };
    expect(body.current).toBe(0);
    expect(body.expected).toBeGreaterThanOrEqual(1);
    expect(body.applied).toEqual([]);
    expect(body.pending.length).toBeGreaterThanOrEqual(1);
    expect(body.pending[0]?.id).toBeTruthy();
    // `run`-функция миграции не должна утекать в JSON.
    expect(body.pending[0]).not.toHaveProperty('run');
  });

  it('POST /migrations/apply — без confirm 400, с confirm применяет и пишет meta.json', async () => {
    const app = makeApp();
    expect((await postJson(app, '/api/v2/maintenance/migrations/apply', {})).status).toBe(400);

    const res = await postJson(app, '/api/v2/maintenance/migrations/apply', { confirm: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { applied: string[]; safetyCopyPath?: string };
    expect(body.applied.length).toBeGreaterThanOrEqual(1);
    // ADR-092: страховочная копия обязательна перед записью.
    expect(typeof body.safetyCopyPath).toBe('string');

    const meta = JSON.parse(await readFile(join(tmpDir, 'meta.json'), 'utf-8')) as { schemaVersion: number };
    expect(meta.schemaVersion).toBeGreaterThanOrEqual(1);
  });

  it('POST /backups → архив; GET /backups; download; DELETE', async () => {
    const app = makeApp();
    const name = await createBackupViaApi(app);
    expect(name.endsWith('.tar.gz')).toBe(true);
    expect((await stat(join(tmpDir, 'backups', name))).isFile()).toBe(true);

    const list = await app.request('/api/v2/maintenance/backups');
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { backups: Array<{ name: string; bytes: number }> };
    expect(listBody.backups).toHaveLength(1);
    expect(listBody.backups[0]?.name).toBe(name);
    expect(listBody.backups[0]?.bytes).toBeGreaterThan(0);

    const dl = await app.request(`/api/v2/maintenance/backups/${encodeURIComponent(name)}/download`);
    expect(dl.status).toBe(200);
    expect(dl.headers.get('Content-Type')).toBe('application/gzip');
    expect(dl.headers.get('Content-Disposition')).toContain('attachment');
    expect(dl.headers.get('Content-Disposition')).toContain(encodeURIComponent(name));

    const del = await app.request(`/api/v2/maintenance/backups/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    });
    expect(del.status).toBe(204);
    expect((await app.request('/api/v2/maintenance/backups')).status).toBe(200);
    const after = (await (await app.request('/api/v2/maintenance/backups')).json()) as {
      backups: unknown[];
    };
    expect(after.backups).toHaveLength(0);
  });

  it('download: traversal в имени архива → 400, файл не отдаётся', async () => {
    const app = makeApp();
    // Процентное кодирование `/` и `..` переживает нормализацию URL (литеральные
    // `..` схлопывает сам URL-парсер, поэтому до роутера такой путь не доходит).
    const res = await app.request(
      '/api/v2/maintenance/backups/..%2F..%2Fetc%2Fpasswd/download',
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');

    // Литеральный `..` нормализуется URL-парсером → роут не матчится (ничего не отдаём).
    const normalized = await app.request('/api/v2/maintenance/backups/../../etc/passwd/download');
    expect(normalized.status).not.toBe(200);
  });

  it('DELETE /backups/:name — unsafe имя → 400, отсутствующий → 404', async () => {
    const app = makeApp();
    const unsafe = await app.request('/api/v2/maintenance/backups/not-a-backup.txt', { method: 'DELETE' });
    expect(unsafe.status).toBe(400);
    const missing = await app.request('/api/v2/maintenance/backups/missing.tar.gz', { method: 'DELETE' });
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND');
  });

  it('POST /restore/validate — несуществующий архив → 404, реальный → 200 ok:true', async () => {
    const app = makeApp();
    const missing = await postJson(app, '/api/v2/maintenance/restore/validate', { archive: 'nope.tar.gz' });
    expect([400, 404]).toContain(missing.status);

    const name = await createBackupViaApi(app);
    const ok = await postJson(app, '/api/v2/maintenance/restore/validate', { archive: name });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { ok: boolean; manifest?: { entries: number } };
    expect(body.ok).toBe(true);
    expect(body.manifest).toBeTruthy();
  });

  it('POST /restore/validate — multipart: staged-файл в backups/uploads с санитизированным именем', async () => {
    const app = makeApp();
    const fd = new FormData();
    fd.set('file', new File(['not-an-archive'], 'My Weird Name!.tar.gz', { type: 'application/gzip' }));

    const res = await app.request('/api/v2/maintenance/restore/validate', { method: 'POST', body: fd });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; staged?: string };
    expect(body.ok).toBe(false); // содержимое не архив — отчёт валидации, не ошибка
    expect(body.staged).toBe('My_Weird_Name_.tar.gz');

    const staged = await readdir(join(tmpDir, 'backups', 'uploads'));
    expect(staged).toContain('My_Weird_Name_.tar.gz');
  });

  it('POST /restore/schedule: без confirm 400; с confirm 201; GET pending; DELETE cancelled', async () => {
    const app = makeApp();
    const name = await createBackupViaApi(app);

    expect((await postJson(app, '/api/v2/maintenance/restore', { archive: name })).status).toBe(400);

    const scheduled = await postJson(app, '/api/v2/maintenance/restore', { archive: name, confirm: true });
    expect(scheduled.status).toBe(201);
    const scheduledBody = (await scheduled.json()) as {
      pending: { archive: string; requestedAt: string };
      appliesOnNextStart: boolean;
    };
    expect(scheduledBody.pending.archive.endsWith(name)).toBe(true);
    expect(scheduledBody.appliesOnNextStart).toBe(true);

    const pending = await app.request('/api/v2/maintenance/restore');
    expect(pending.status).toBe(200);
    expect(((await pending.json()) as { pending: unknown }).pending).not.toBeNull();

    const cancelled = await app.request('/api/v2/maintenance/restore', { method: 'DELETE' });
    expect(cancelled.status).toBe(200);
    expect(((await cancelled.json()) as { cancelled: boolean }).cancelled).toBe(true);

    const after = await app.request('/api/v2/maintenance/restore');
    expect(((await after.json()) as { pending: unknown }).pending).toBeNull();
  });

  it('POST /restore — невалидный архив не планируется (400)', async () => {
    const app = makeApp();
    // Кладём под видом архива мусор, чтобы имя было безопасным, но содержимое — нет.
    const fd = new FormData();
    fd.set('file', new File(['garbage'], 'broken.tar.gz', { type: 'application/gzip' }));
    await app.request('/api/v2/maintenance/restore/validate', { method: 'POST', body: fd });

    const res = await postJson(app, '/api/v2/maintenance/restore', { archive: 'broken.tar.gz', confirm: true });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
  });

  it('дефолтные guard\'ы core требуют auth (read и write)', async () => {
    const app = makeApp({}, denyAuth);
    expect((await app.request('/api/v2/maintenance/status')).status).toBe(401);
    expect((await postJson(app, '/api/v2/maintenance/backups', {})).status).toBe(401);
    expect((await postJson(app, '/api/v2/maintenance/migrations/apply', { confirm: true })).status).toBe(401);
  });

  it('maxUploadBytes: превышение лимита на multipart → 413 PAYLOAD_TOO_LARGE', async () => {
    const app = makeApp({ maxUploadBytes: 8 });
    const fd = new FormData();
    fd.set('file', new File(['x'.repeat(64)], 'big.tar.gz', { type: 'application/gzip' }));
    const res = await app.request('/api/v2/maintenance/restore/validate', { method: 'POST', body: fd });
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  describe('AUDIT — журнал обслуживания (ADR-092)', () => {
    const auditEntry = (over: Partial<MaintenanceAuditEntry>): MaintenanceAuditEntry => ({
      id: 'ma_1',
      ts: '2026-10-16T12:00:00.000Z',
      op: 'backup.created',
      status: 'ok',
      ...over,
    });

    const makeAuditApp = (
      audit: MaintenanceAuditRepository,
      opts: MaintenanceRoutesOptions = {},
    ): Hono => {
      const app = new Hono();
      app.route(
        '/api/v2/maintenance',
        createMaintenanceRoutes(passAuth, { dataDir: tmpDir, audit }, opts),
      );
      return app;
    };

    /** userId инициатора для проверки поля `actor` (core-дефолт — из `c.get('user')`). */
    const withActor: MaintenanceRoutesOptions = { resolveUserId: () => 'admin' };

    it('GET /audit без порта — 200 и пустой список (не 500)', async () => {
      const res = await makeApp().request('/api/v2/maintenance/audit');
      expect(res.status).toBe(200);
      expect(((await res.json()) as { entries: unknown[] }).entries).toEqual([]);
    });

    it('GET /audit — «свежие первыми», фильтры op и limit', async () => {
      const audit = new MemoryMaintenanceAuditRepository();
      await audit.append(auditEntry({ id: 'ma_1', op: 'backup.created' }));
      await audit.append(auditEntry({ id: 'ma_2', op: 'migrate.applied' }));
      await audit.append(auditEntry({ id: 'ma_3', op: 'backup.created', status: 'failed' }));
      const app = makeAuditApp(audit);

      const all = (await (await app.request('/api/v2/maintenance/audit')).json()) as {
        entries: MaintenanceAuditEntry[];
      };
      expect(all.entries.map((e) => e.id)).toEqual(['ma_3', 'ma_2', 'ma_1']);

      const filtered = (await (
        await app.request('/api/v2/maintenance/audit?op=backup.created')
      ).json()) as { entries: MaintenanceAuditEntry[] };
      expect(filtered.entries.map((e) => e.id)).toEqual(['ma_3', 'ma_1']);

      const limited = (await (
        await app.request('/api/v2/maintenance/audit?limit=1')
      ).json()) as { entries: MaintenanceAuditEntry[] };
      expect(limited.entries.map((e) => e.id)).toEqual(['ma_3']);
    });

    it('GET /audit — невалидные limit/op → 400 VALIDATION_ERROR', async () => {
      const app = makeAuditApp(new MemoryMaintenanceAuditRepository());
      for (const query of ['limit=0', 'limit=501', 'limit=abc', 'limit=1.5', 'op=unknown.op']) {
        const res = await app.request(`/api/v2/maintenance/audit?${query}`);
        expect(res.status, query).toBe(400);
        expect(((await res.json()) as { error: { code: string } }).error.code, query).toBe(
          'VALIDATION_ERROR',
        );
      }
    });

    it('DELETE /audit — без confirm 400; с confirm очищает и возвращает число удалённых', async () => {
      const audit = new MemoryMaintenanceAuditRepository();
      await audit.append(auditEntry({ id: 'ma_1' }));
      await audit.append(auditEntry({ id: 'ma_2' }));
      const app = makeAuditApp(audit);

      const noConfirm = await app.request('/api/v2/maintenance/audit', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(noConfirm.status).toBe(400);

      const cleared = await app.request('/api/v2/maintenance/audit', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true }),
      });
      expect(cleared.status).toBe(200);
      expect(((await cleared.json()) as { cleared: number }).cleared).toBe(2);
      expect((await audit.list())).toEqual([]);
    });

    it('DELETE /audit без порта — 200 {cleared: 0}', async () => {
      const res = await makeApp().request('/api/v2/maintenance/audit', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true }),
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { cleared: number }).cleared).toBe(0);
    });

    it('POST /backups — пишет backup.created с actor и именем архива', async () => {
      const audit = new MemoryMaintenanceAuditRepository();
      const app = makeAuditApp(audit, withActor);

      const name = await createBackupViaApi(app);

      const entries = await audit.list({ op: 'backup.created' });
      expect(entries).toHaveLength(1);
      expect(entries[0]!.status).toBe('ok');
      expect(entries[0]!.actor).toBe('admin');
      expect(entries[0]!.details).toMatchObject({ name });
    });

    it('DELETE /backups/:name — пишет backup.deleted с actor; отсутствующий — без события', async () => {
      const audit = new MemoryMaintenanceAuditRepository();
      const app = makeAuditApp(audit, withActor);

      const name = await createBackupViaApi(app);
      const del = await app.request(
        `/api/v2/maintenance/backups/${encodeURIComponent(name)}`,
        { method: 'DELETE' },
      );
      expect(del.status).toBe(204);

      const entries = await audit.list({ op: 'backup.deleted' });
      expect(entries).toHaveLength(1);
      expect(entries[0]!.status).toBe('ok');
      expect(entries[0]!.actor).toBe('admin');
      expect(entries[0]!.details).toMatchObject({ name });

      // Повторное удаление: файла нет → 404, нового события не появляется.
      const again = await app.request(
        `/api/v2/maintenance/backups/${encodeURIComponent(name)}`,
        { method: 'DELETE' },
      );
      expect(again.status).toBe(404);
      expect(await audit.list({ op: 'backup.deleted' })).toHaveLength(1);
    });

    it('POST /restore и DELETE /restore — пишут restore.scheduled (actor) и restore.cancelled', async () => {
      const audit = new MemoryMaintenanceAuditRepository();
      const app = makeAuditApp(audit, withActor);

      const name = await createBackupViaApi(app);
      const scheduled = await postJson(app, '/api/v2/maintenance/restore', {
        archive: name,
        confirm: true,
      });
      expect(scheduled.status).toBe(201);

      const scheduledEntries = await audit.list({ op: 'restore.scheduled' });
      expect(scheduledEntries).toHaveLength(1);
      expect(scheduledEntries[0]!.status).toBe('scheduled');
      expect(scheduledEntries[0]!.actor).toBe('admin');

      const cancelled = await app.request('/api/v2/maintenance/restore', { method: 'DELETE' });
      expect(cancelled.status).toBe(200);

      const cancelledEntries = await audit.list({ op: 'restore.cancelled' });
      expect(cancelledEntries).toHaveLength(1);
      expect(cancelledEntries[0]!.status).toBe('ok');
    });

    it('POST /migrations/apply — пишет migrate.applied с actor', async () => {
      const audit = new MemoryMaintenanceAuditRepository();
      const app = makeAuditApp(audit, withActor);

      const res = await postJson(app, '/api/v2/maintenance/migrations/apply', { confirm: true });
      expect(res.status).toBe(200);

      const entries = await audit.list({ op: 'migrate.applied' });
      expect(entries).toHaveLength(1);
      expect(entries[0]!.status).toBe('ok');
      expect(entries[0]!.actor).toBe('admin');
    });

    it('без порта audit — операции по-прежнему работают (аудит best-effort)', async () => {
      const app = makeApp();

      const name = await createBackupViaApi(app);

      const scheduled = await postJson(app, '/api/v2/maintenance/restore', {
        archive: name,
        confirm: true,
      });
      expect(scheduled.status).toBe(201);

      const cancelled = await app.request('/api/v2/maintenance/restore', { method: 'DELETE' });
      expect(cancelled.status).toBe(200);

      const applied = await postJson(app, '/api/v2/maintenance/migrations/apply', { confirm: true });
      expect(applied.status).toBe(200);

      const del = await app.request(
        `/api/v2/maintenance/backups/${encodeURIComponent(name)}`,
        { method: 'DELETE' },
      );
      expect(del.status).toBe(204);
    });
  });
});

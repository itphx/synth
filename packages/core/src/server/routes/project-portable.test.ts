// ADR-091 (этап 2): тесты HTTP-переноса проекта (экспорт/импорт) на tmp-каталогах.
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Context, MiddlewareHandler, Next } from 'hono';
import { createProjectPortableRoutes } from './project-portable.js';
import type {
  ProjectPortableRoutesDeps,
  ProjectPortableRoutesOptions,
} from './project-portable.js';
import { createFileStorage } from '../../storage/storage-context.js';
import { SessionManager } from '../../sessions/manager.js';
import { MemoryMaintenanceAuditRepository } from '../../storage/memory/index.js';
import { readTarGz } from '../../maintenance/archive.js';
import { exportProject } from '../../projects/portable.js';

/** Реальный секрет в карте обфускации сессии (плейсхолдер → значение). */
const REAL_SECRET = 'sk-live-DO-NOT-LEAK';
const PLACEHOLDER = '⟦SYNTH_SECRET_1⟧';

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

describe('Project Portable API Routes (ADR-091 §6)', () => {
  let tmpDir: string;

  const makeApp = (
    deps: Partial<ProjectPortableRoutesDeps> = {},
    opts: ProjectPortableRoutesOptions = {},
    auth = passAuth,
  ): Hono => {
    const app = new Hono();
    app.route(
      '/api/v2/projects',
      createProjectPortableRoutes(
        auth,
        {
          dataDir: tmpDir,
          getProject: (id) => createFileStorage({ dataDir: tmpDir }).projects.load(id),
          ...deps,
        },
        opts,
      ),
    );
    return app;
  };

  /** Создаёт проект (и одну сессию) в каталоге данных теста. */
  const makeProject = async (name: string): Promise<string> => {
    const storage = createFileStorage({ dataDir: tmpDir });
    const project = storage.projects.create(name, 'local');
    await storage.projects.save(project);
    const manager = new SessionManager(storage.sessions, { projectStore: storage.projects });
    const session = await manager.createSession({ title: 'Сессия 1', projectId: project.id });
    // Карта обфускации LLM Gateway + раскрытые значения плейсхолдера в
    // metadata сообщения (ADR-036) — секреты, не должны уезжать в архив
    // проекта по умолчанию (security-фикс 0.11.3).
    session.obfuscationMap = { [PLACEHOLDER]: REAL_SECRET };
    session.messages = [
      {
        id: 'm1',
        role: 'assistant' as never,
        seq: 1,
        origin: 'local',
        parts: [],
        content: 'ответ',
        createdAt: '2026-01-01T00:00:00.000Z',
        disabled: false,
        pinned: false,
        hidden: false,
        metadata: { secrets: { [PLACEHOLDER]: REAL_SECRET } },
      } as never,
    ];
    await manager.saveSession(session);
    return project.id;
  };

  /** Тексты payload'ов сессий из архива (gzip-байты). */
  const sessionPayloads = async (bytes: Buffer): Promise<string[]> => {
    const out: string[] = [];
    const tmp = join(tmpDir, `read-${Math.random().toString(36).slice(2)}.tar.gz`);
    await writeFile(tmp, bytes);
    try {
      await readTarGz(tmp, (entry) => {
        if (entry.type === 'file' && entry.path.startsWith('sessions/') && entry.path.endsWith('.json')) {
          out.push(entry.content.toString('utf-8'));
        }
      });
    } finally {
      await rm(tmp, { force: true });
    }
    return out;
  };

  /** Экспортирует проект в файл внутри tmp-каталога теста и возвращает байты. */
  const exportBytes = async (projectId: string): Promise<Buffer> => {
    const out = join(tmpDir, `export-${projectId}.synth-project.tar.gz`);
    await exportProject({ dataDir: tmpDir, projectId, out });
    return readFile(out);
  };

  /** Многоразовый multipart с архивом (и опциональными полями). */
  const archiveForm = (bytes: Buffer, fields: Record<string, string> = {}): FormData => {
    const fd = new FormData();
    fd.set('file', new File([bytes], 'project.synth-project.tar.gz', { type: 'application/gzip' }));
    for (const [key, value] of Object.entries(fields)) fd.set(key, value);
    return fd;
  };

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-project-portable-routes-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('GET /:id/export — 200, gzip + attachment, временный файл не остаётся', async () => {
    const id = await makeProject('Export Demo');
    const app = makeApp();

    const res = await app.request(`/api/v2/projects/${id}/export`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/gzip');
    const disposition = res.headers.get('content-disposition') ?? '';
    expect(disposition).toContain('attachment');
    expect(disposition).toContain('filename="export-demo.synth-project.tar.gz"');

    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(0);
    // gzip-magic — архив реальный, не пустышка.
    expect(bytes[0]).toBe(0x1f);
    expect(bytes[1]).toBe(0x8b);

    // Временный файл удалён (staging и сам архив).
    const tmp = join(tmpDir, 'tmp');
    if (existsSync(tmp)) {
      const left = (await readdir(tmp)).filter((name) => name.endsWith('.synth-project.tar.gz'));
      expect(left).toEqual([]);
    }
  });

  it('GET /:id/export — несуществующий проект → 404', async () => {
    const res = await makeApp().request('/api/v2/projects/does-not-exist/export');
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND');
  });

  it('GET /:id/export — canRead=false → 403', async () => {
    const id = await makeProject('Private');
    const res = await makeApp({ canRead: () => false }).request(`/api/v2/projects/${id}/export`);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN');
  });

  describe('security-фикс 0.11.3: секреты сессий в архиве проекта', () => {
    it('GET /:id/export (по умолчанию) — архив БЕЗ карты обфускации и metadata.secrets', async () => {
      const id = await makeProject('No Secrets');
      const res = await makeApp().request(`/api/v2/projects/${id}/export`);
      expect(res.status).toBe(200);

      const payloads = await sessionPayloads(Buffer.from(await res.arrayBuffer()));
      expect(payloads.length).toBeGreaterThan(0);
      for (const payload of payloads) {
        expect(payload).not.toContain('obfuscationMap');
        expect(payload).not.toContain('obfuscation_map');
        expect(payload).not.toContain(REAL_SECRET);
        expect(payload).not.toContain('"secrets"');
      }
    });

    it('GET /:id/export?withSecrets=true — непривилегированный инициатор → 403', async () => {
      const id = await makeProject('Opt-in denied');
      const res = await makeApp({ canExportSecrets: () => false }).request(
        `/api/v2/projects/${id}/export?withSecrets=true`,
      );
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN');
    });

    it('GET /:id/export?withSecrets=true — без `canExportSecrets` → 403 (fail-closed)', async () => {
      const id = await makeProject('Opt-in default');
      const res = await makeApp().request(`/api/v2/projects/${id}/export?withSecrets=true`);
      expect(res.status).toBe(403);
    });

    it('GET /:id/export?withSecrets=true — привилегированный инициатор → 200, секреты в архиве, аудит с withSecrets=true', async () => {
      const id = await makeProject('Opt-in allowed');
      const audit = new MemoryMaintenanceAuditRepository();
      const res = await makeApp({ canExportSecrets: () => true, audit }).request(
        `/api/v2/projects/${id}/export?withSecrets=true`,
      );
      expect(res.status).toBe(200);

      const payloads = await sessionPayloads(Buffer.from(await res.arrayBuffer()));
      expect(payloads.some((p) => p.includes(REAL_SECRET))).toBe(true);
      expect(payloads.some((p) => p.includes('obfuscationMap'))).toBe(true);

      const created = (await audit.list()).find((e) => e.op === 'export.created');
      expect(created?.details?.withSecrets).toBe(true);
    });

    it('GET /:id/export (по умолчанию) — аудит с withSecrets=false', async () => {
      const id = await makeProject('Audit default');
      const audit = new MemoryMaintenanceAuditRepository();
      const res = await makeApp({ canExportSecrets: () => true, audit }).request(
        `/api/v2/projects/${id}/export`,
      );
      expect(res.status).toBe(200);

      const created = (await audit.list()).find((e) => e.op === 'export.created');
      expect(created?.details?.withSecrets).toBe(false);
    });
  });

  it('POST /import — 201, проект и сессии созданы', async () => {
    const id = await makeProject('Source');
    const bytes = await exportBytes(id);

    const app = makeApp();
    const res = await app.request('/api/v2/projects/import', {
      method: 'POST',
      body: archiveForm(bytes, { name: 'Imported' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      projectId: string;
      sessionsImported: number;
      messagesImported: number;
      idMap: Record<string, string>;
    };
    expect(body.projectId).toBeTruthy();
    expect(body.sessionsImported).toBeGreaterThanOrEqual(1);
    expect(Object.keys(body.idMap).length).toBeGreaterThanOrEqual(1);

    const projects = await createFileStorage({ dataDir: tmpDir }).projects.list();
    expect(projects.map((p) => p.name)).toContain('Imported');
  });

  it('POST /import — битый архив → 400 VALIDATION_ERROR', async () => {
    const app = makeApp();
    const res = await app.request('/api/v2/projects/import', {
      method: 'POST',
      body: archiveForm(Buffer.from('not-an-archive')),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
  });

  it('POST /import — без multipart/file → 400 VALIDATION_ERROR', async () => {
    const app = makeApp();
    const res = await app.request('/api/v2/projects/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
  });

  it('POST /import — превышение maxUploadBytes → 413 PAYLOAD_TOO_LARGE', async () => {
    const id = await makeProject('Big');
    const bytes = await exportBytes(id);
    const app = makeApp({ maxUploadBytes: 8 });
    const res = await app.request('/api/v2/projects/import', {
      method: 'POST',
      body: archiveForm(bytes),
    });
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('POST /import — mergeInto без canEdit → 403', async () => {
    const source = await makeProject('Source');
    const target = await makeProject('Target');
    const bytes = await exportBytes(source);

    const app = makeApp({ canEdit: () => false });
    const res = await app.request('/api/v2/projects/import', {
      method: 'POST',
      body: archiveForm(bytes, { mergeInto: target }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN');
  });

  it('дефолтные guard\'ы core требуют auth (read и write) → 401', async () => {
    const app = makeApp({}, {}, denyAuth);
    expect((await app.request('/api/v2/projects/any/export')).status).toBe(401);
    const fd = archiveForm(Buffer.from('x'));
    expect((await app.request('/api/v2/projects/import', { method: 'POST', body: fd })).status).toBe(401);
  });
});

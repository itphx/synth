// AD-089 (P0): авторизация project-aware FS-роутов `/api/v2/fs/*`. До фикса
// `getProjectWorkspace` резолвил workspace по `project_id` без проверки прав —
// любой USER мог читать и записывать файлы чужого проекта (IDOR). Теперь
// `authorizeProject` (чтение — canRead, мутации — canEditContent) обязателен.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBackendApp } from '../app.js';
import type { BackendAppHandle } from '../app.js';

const ADMIN_KEY = 'admin-key-123';
const USER_KEY = 'user-key-456';

describe('AD-089 (P0): авторизация /api/v2/fs (IDOR, backend)', () => {
  let dataDir: string;
  let backend: BackendAppHandle;
  let adminProject: string;
  let userProject: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'synth-backend-fs-auth-'));
    backend = await createBackendApp({ dataDir, authDebug: true });
    adminProject = await createProject('admin-project', ADMIN_KEY);
    userProject = await createProject('user-project', USER_KEY);
  });

  afterAll(async () => {
    backend.stopScheduler();
    backend.stopEphemeralSweeper();
    backend.stopEventJournalPruner();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const req = async (path: string, init: RequestInit = {}, token?: string): Promise<Response> =>
    backend.app.request(path, {
      ...init,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init.headers ?? {}),
      },
    });

  const json = (body: unknown, method = 'POST'): RequestInit => ({
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  async function createProject(name: string, token: string): Promise<string> {
    const res = await req('/api/v2/projects', json({ name }), token);
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  }

  const write = (token: string, projectId: string, path: string, content: string): Promise<Response> =>
    req('/api/v2/fs/write', json({ project_id: projectId, path, content }), token);

  it('USER не может читать чужой проект: GET / и /read → 403 FORBIDDEN', async () => {
    const list = await req(`/api/v2/fs?project_id=${adminProject}`, {}, USER_KEY);
    expect(list.status).toBe(403);
    expect(((await list.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN');

    const read = await req(`/api/v2/fs/read?project_id=${adminProject}&path=a.txt`, {}, USER_KEY);
    expect(read.status).toBe(403);
    expect(((await read.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN');
  });

  it('USER не может писать в чужой проект: write/mkdir/delete → 403 FORBIDDEN', async () => {
    const w = await write(USER_KEY, adminProject, 'evil.txt', 'owned');
    expect(w.status).toBe(403);
    expect(((await w.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN');

    const mk = await req('/api/v2/fs/mkdir', json({ project_id: adminProject, path: 'evil-dir' }), USER_KEY);
    expect(mk.status).toBe(403);
    expect(((await mk.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN');

    const del = await req(`/api/v2/fs?project_id=${adminProject}&path=evil.txt`, { method: 'DELETE' }, USER_KEY);
    expect(del.status).toBe(403);
    expect(((await del.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN');
  });

  it('владелец проекта (ADMIN) пишет и читает свой проект', async () => {
    const w = await write(ADMIN_KEY, adminProject, 'note.txt', 'hello');
    expect(w.status).toBe(200);

    const read = await req(`/api/v2/fs/read?project_id=${adminProject}&path=note.txt`, {}, ADMIN_KEY);
    expect(read.status).toBe(200);
    expect(((await read.json()) as { content: string }).content).toBe('hello');
  });

  it('владелец проекта (USER) пишет в свой проект, но не в чужой', async () => {
    const own = await write(USER_KEY, userProject, 'own.txt', 'mine');
    expect(own.status).toBe(200);

    const foreign = await write(USER_KEY, adminProject, 'nope.txt', 'nope');
    expect(foreign.status).toBe(403);
  });
});

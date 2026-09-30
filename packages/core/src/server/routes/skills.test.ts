import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next, MiddlewareHandler } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSkillRoutes } from './skills.js';
import { SkillService } from '../../engine/skills/service.js';
import type { AuthKit } from '../../auth/local.js';

function createMockAuth(): AuthKit {
  return {
    getCurrentUser: () => null,
    requireAuth: async (_c: Context, next: Next) => { await next(); },
  } as unknown as AuthKit;
}

let tmpDir: string;

function makeApp(opts?: { writeGuard?: MiddlewareHandler }) {
  const app = new Hono();
  // home изолирован, чтобы внешний `~/.config/opencode/skills` хоста не влиял на реестр.
  const skillService = new SkillService({ dataDir: tmpDir, home: join(tmpDir, 'home') });
  app.route('/api/v2/skills', createSkillRoutes(createMockAuth(), { skillService }, opts));
  return { app, skillService };
}

async function post(app: Hono, url: string, body: unknown, method = 'POST') {
  return app.request(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'synth-skills-routes-'));
});
afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('/api/v2/skills (AD-046 §9.1)', () => {
  it('GET / — реестр содержит builtin skill-creator и synth-agents-md (AD-046 §9.5)', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/v2/skills');
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.skills.map((s: any) => s.name)).toEqual(['skill-creator', 'synth-agents-md']);
    expect(body.skills[0].trusted).toBe(true);
    expect(body.skills[0].scope).toBe('instance');
    expect(body.skills[0].level).toBe('system');
    expect(body.skills[1].trusted).toBe(true);
    expect(body.skills[1].requiresCapabilities).toEqual(['file_read', 'search', 'file_write']);
  });

  it('POST / создаёт instance-скилл; GET /:name отдаёт деталь', async () => {
    const { app } = makeApp();
    const created = await post(app, '/api/v2/skills', {
      name: 'api-review',
      description: 'Проверяет API',
      body: '# API Review\n\nШаги.',
      files: { 'references/checklist.md': '- [ ] step' },
    });
    expect(created.status).toBe(201);
    const detail: any = await created.json();
    expect(detail.name).toBe('api-review');
    expect(detail.body).toContain('API Review');
    expect(detail.files).toContain('references/checklist.md');

    const list: any = await (await app.request('/api/v2/skills')).json();
    expect(list.skills.map((s: any) => s.name)).toContain('api-review');

    const got = await app.request('/api/v2/skills/api-review');
    expect(got.status).toBe(200);
  });

  it('POST / повторно → 409 CONFLICT', async () => {
    const { app } = makeApp();
    await post(app, '/api/v2/skills', { name: 'a', description: 'd' });
    const dup = await post(app, '/api/v2/skills', { name: 'a', description: 'd' });
    expect(dup.status).toBe(409);
  });

  it('POST / невалидные данные → 400', async () => {
    const { app } = makeApp();
    const res = await post(app, '/api/v2/skills', { name: 'Bad Name', description: '' });
    expect(res.status).toBe(400);
  });

  it('GET /:name не найден → 404', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/v2/skills/ghost');
    expect(res.status).toBe(404);
  });

  it('PATCH /:name обновляет описание и тело', async () => {
    const { app } = makeApp();
    await post(app, '/api/v2/skills', { name: 'a', description: 'old', body: 'old body' });
    const res = await post(app, '/api/v2/skills/a', { description: 'new', body: 'new body' }, 'PATCH');
    expect(res.status).toBe(200);
    const detail: any = await res.json();
    expect(detail.description).toBe('new');
    expect(detail.body).toContain('new body');
  });

  it('PATCH /:name для несуществующего → 404', async () => {
    const { app } = makeApp();
    const res = await post(app, '/api/v2/skills/ghost', { description: 'x' }, 'PATCH');
    expect(res.status).toBe(404);
  });

  it('files: список, PUT/write, GET/read, DELETE', async () => {
    const { app } = makeApp();
    await post(app, '/api/v2/skills', { name: 's', description: 'd' });

    const put = await post(app, '/api/v2/skills/s/files/references/a.md', { content: 'hello' }, 'PUT');
    expect(put.status).toBe(200);

    const list: any = await (await app.request('/api/v2/skills/s/files')).json();
    expect(list.files).toContain('references/a.md');

    const got: any = await (await app.request('/api/v2/skills/s/files/references/a.md')).json();
    expect(got.content).toBe('hello');

    const del = await app.request('/api/v2/skills/s/files/references/a.md', { method: 'DELETE' });
    expect(del.status).toBe(200);
    const after = await app.request('/api/v2/skills/s/files/references/a.md');
    expect(after.status).toBe(404);
  });

  it('PUT файла для не-instance скилла → 404', async () => {
    const { app } = makeApp();
    const res = await post(app, '/api/v2/skills/ghost/files/a.md', { content: 'x' }, 'PUT');
    expect(res.status).toBe(404);
  });

  it('DELETE /:name удаляет instance-скилл', async () => {
    const { app } = makeApp();
    await post(app, '/api/v2/skills', { name: 'a', description: 'd' });
    const del = await app.request('/api/v2/skills/a', { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect((await app.request('/api/v2/skills/a')).status).toBe(404);
  });

  it('POST /reload сбрасывает кэш', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/v2/skills/reload', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'reloaded' });
  });

  it('writeGuard блокирует мутации, чтение проходит', async () => {
    const guard: MiddlewareHandler = async (c) => c.json({ error: { code: 'FORBIDDEN' } }, 403);
    const { app } = makeApp({ writeGuard: guard });
    const blocked = await post(app, '/api/v2/skills', { name: 'a', description: 'd' });
    expect(blocked.status).toBe(403);
    const read = await app.request('/api/v2/skills');
    expect(read.status).toBe(200);
  });
});

describe('/api/v2/skills/:name — невалидные и отсутствующие имена (4xx, не 500)', () => {
  const INVALID_NAMES = ['Bad_Name', 'UPPER', 'скилл', 'has space', '-leading', 'a'.repeat(65)];

  it.each(INVALID_NAMES)('GET/PATCH/DELETE с невалидным именем "%s" → 404', async (name) => {
    const { app } = makeApp();
    const encoded = encodeURIComponent(name);
    const get = await app.request(`/api/v2/skills/${encoded}`);
    expect(get.status).toBe(404);
    const patch = await post(app, `/api/v2/skills/${encoded}`, { description: 'x' }, 'PATCH');
    expect(patch.status).toBe(404);
    const del = await app.request(`/api/v2/skills/${encoded}`, { method: 'DELETE' });
    expect(del.status).toBe(404);
  });

  it.each(INVALID_NAMES)('files-роуты с невалидным именем "%s" → 404', async (name) => {
    const { app } = makeApp();
    const encoded = encodeURIComponent(name);
    expect((await app.request(`/api/v2/skills/${encoded}/files`)).status).toBe(404);
    expect((await app.request(`/api/v2/skills/${encoded}/files/a.md`)).status).toBe(404);
    expect((await post(app, `/api/v2/skills/${encoded}/files/a.md`, { content: 'x' }, 'PUT')).status).toBe(404);
    expect((await app.request(`/api/v2/skills/${encoded}/files/a.md`, { method: 'DELETE' })).status).toBe(404);
  });

  it('GET/PATCH/DELETE с неизвестным валидным именем → 404', async () => {
    const { app } = makeApp();
    expect((await app.request('/api/v2/skills/no-such-skill')).status).toBe(404);
    expect((await post(app, '/api/v2/skills/no-such-skill', { description: 'x' }, 'PATCH')).status).toBe(404);
    expect((await app.request('/api/v2/skills/no-such-skill', { method: 'DELETE' })).status).toBe(404);
  });

  it('повторный DELETE существующего скилла → 200, затем 404', async () => {
    const { app } = makeApp();
    await post(app, '/api/v2/skills', { name: 'a', description: 'd' });
    const first = await app.request('/api/v2/skills/a', { method: 'DELETE' });
    expect(first.status).toBe(200);
    const second = await app.request('/api/v2/skills/a', { method: 'DELETE' });
    expect(second.status).toBe(404);
  });

  it('DELETE с невалидным именем не оставляет созданных данных', async () => {
    const { app, skillService } = makeApp();
    const res = await app.request('/api/v2/skills/Bad_Name', { method: 'DELETE' });
    expect(res.status).toBe(404);
    const list: any = await (await app.request('/api/v2/skills')).json();
    // Только builtin; скилл с невалидным именем не создан.
    expect(list.skills.map((s: any) => s.name)).toEqual(['skill-creator', 'synth-agents-md']);
    expect(await skillService.instanceExists('Bad_Name')).toBe(false);
  });
});

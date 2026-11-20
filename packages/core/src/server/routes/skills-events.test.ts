/**
 * Событие шины `skills.updated` на HTTP-путях реестра скиллов и бандлов.
 *
 * Баг: «панели скиллов и долларовый пикер в композере показывают старый состав,
 * пока не перезагрузишь страницу». Причина — сервер молчал о мутации реестра:
 * перечитывать состав было не из чего, если скилл правили из админки, из другой
 * вкладки или через `reload` после ручной правки файлов на диске.
 *
 * Контракт проверяется здесь целиком:
 * - публикуется на `POST /reload` (`reload`), `POST /` (`create`),
 *   `PATCH /:name` (`update`), `PUT`/`DELETE /:name/files/*` (`files`),
 *   `DELETE /:name` (`delete`);
 * - бандлы (`createSkillBundleRoutes`) — тот же `skills.updated` (для клиента
 *   бандл это часть реестра скиллов): `create`/`update`/`delete`;
 * - **не** публикуется при ошибке: 400 (невалидное тело), 404 (нет скилла или
 *   не-instance скилл), 409 (имя занято);
 * - payload — только имя и вид мутации: тело `SKILL.md` (`body`), `metadata` и
 *   supporting-файлы (`files`) в событие не попадают ни при каких условиях — в
 *   скиллах встречаются рецепты с секретами (инвариант 13 `AGENTS.md`).
 *
 * Хук подменён фейком (`onSkillsChanged` — тот же хук, что у
 * `skillsChangedPublisher`): тест про контракт фабрики, а не про EventBus
 * (сам шов — `src/events/skills-events.test.ts`).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSkillRoutes } from './skills.js';
import type { SkillRoutesOptions } from './skills.js';
import { createSkillBundleRoutes } from './skill-bundles.js';
import type { SkillBundleRoutesOptions } from './skill-bundles.js';
import { SkillService } from '../../engine/skills/service.js';
import { SkillBundleStore } from '../../storage/skill-bundle-store.js';
import type { AuthKit } from '../../auth/local.js';
import { publishSkillsUpdated } from '../../events/skills-events.js';
import type { SkillsChangedInfo } from '../../events/skills-events.js';

/** Записанное событие (канал + тип + payload). */
interface PublishedEvent {
  channel: string;
  type: string;
  data: Record<string, unknown>;
}

/** Фейковая шина: инстансные события + события канала сессии. */
function makeBus(published: PublishedEvent[]) {
  return {
    publishInstance: (type: string, data: Record<string, unknown> = {}) => {
      published.push({ channel: 'instance', type, data });
    },
    publish: (channel: string, type: string, data: Record<string, unknown> = {}) => {
      published.push({ channel, type, data });
    },
  };
}

/** Тот же путь публикации, что у точки сборки: `skillsChangedPublisher(eventBus)`. */
function skillsHook(published: PublishedEvent[]) {
  const bus = makeBus(published);
  return (info: SkillsChangedInfo) => publishSkillsUpdated(bus, info);
}

function createMockAuth(): AuthKit {
  return {
    getCurrentUser: () => null,
    requireAuth: async (_c: Context, next: Next) => { await next(); },
    // Фейк: реализованы только `getCurrentUser`/`requireAuth`.
  } as unknown as AuthKit;
}

let tmpDir: string;

function makeSkillsApp(opts?: SkillRoutesOptions) {
  const app = new Hono();
  // home изолирован, чтобы внешний каталог скиллов хоста не влиял на реестр
  // (как в `skills.test.ts`).
  const skillService = new SkillService({ dataDir: tmpDir, home: join(tmpDir, 'home') });
  app.route('/api/v2/skills', createSkillRoutes(createMockAuth(), { skillService }, opts));
  return { app, skillService };
}

function makeBundlesApp(opts?: SkillBundleRoutesOptions) {
  const app = new Hono();
  const bundleStore = new SkillBundleStore({ dataDir: tmpDir });
  app.route('/api/v2/skill-bundles', createSkillBundleRoutes(createMockAuth(), { bundleStore }, opts));
  return { app, bundleStore };
}

async function json(app: Hono, url: string, body?: unknown, method = 'GET') {
  return app.request(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'synth-skills-events-'));
});
afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('createSkillRoutes — событие skills.updated на write-путях', () => {
  let published: PublishedEvent[];

  beforeEach(() => {
    published = [];
  });

  it('POST /reload публикует { action: reload } без имени', async () => {
    const { app } = makeSkillsApp({ onSkillsChanged: skillsHook(published) });
    const res = await app.request('/api/v2/skills/reload', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(published).toEqual([
      { channel: 'instance', type: 'skills.updated', data: { action: 'reload' } },
    ]);
    // Конкретного имени у пересканирования нет — ключ не добавляется.
    expect('name' in published[0]!.data).toBe(false);
  });

  it('POST / публикует { action: create, name }', async () => {
    const { app } = makeSkillsApp({ onSkillsChanged: skillsHook(published) });
    const res = await json(app, '/api/v2/skills', { name: 'api-review', description: 'Проверяет API' }, 'POST');
    expect(res.status).toBe(201);
    expect(published).toEqual([
      { channel: 'instance', type: 'skills.updated', data: { action: 'create', name: 'api-review' } },
    ]);
  });

  it('PATCH /:name публикует { action: update, name }', async () => {
    const { app } = makeSkillsApp({ onSkillsChanged: skillsHook(published) });
    await json(app, '/api/v2/skills', { name: 'a', description: 'old' }, 'POST');
    published.length = 0;

    const res = await json(app, '/api/v2/skills/a', { description: 'new' }, 'PATCH');
    expect(res.status).toBe(200);
    expect(published).toEqual([
      { channel: 'instance', type: 'skills.updated', data: { action: 'update', name: 'a' } },
    ]);
  });

  it('PUT /:name/files/* публикует { action: files, name }', async () => {
    const { app } = makeSkillsApp({ onSkillsChanged: skillsHook(published) });
    await json(app, '/api/v2/skills', { name: 's', description: 'd' }, 'POST');
    published.length = 0;

    const res = await json(app, '/api/v2/skills/s/files/references/a.md', { content: 'hello' }, 'PUT');
    expect(res.status).toBe(200);
    expect(published).toEqual([
      { channel: 'instance', type: 'skills.updated', data: { action: 'files', name: 's' } },
    ]);
  });

  it('DELETE /:name/files/* публикует { action: files, name }', async () => {
    const { app } = makeSkillsApp({ onSkillsChanged: skillsHook(published) });
    await json(app, '/api/v2/skills', { name: 's', description: 'd' }, 'POST');
    await json(app, '/api/v2/skills/s/files/references/a.md', { content: 'hello' }, 'PUT');
    published.length = 0;

    const res = await app.request('/api/v2/skills/s/files/references/a.md', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(published).toEqual([
      { channel: 'instance', type: 'skills.updated', data: { action: 'files', name: 's' } },
    ]);
  });

  it('DELETE /:name публикует { action: delete, name }', async () => {
    const { app } = makeSkillsApp({ onSkillsChanged: skillsHook(published) });
    await json(app, '/api/v2/skills', { name: 'a', description: 'd' }, 'POST');
    published.length = 0;

    const res = await app.request('/api/v2/skills/a', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(published).toEqual([
      { channel: 'instance', type: 'skills.updated', data: { action: 'delete', name: 'a' } },
    ]);
  });

  // --- тишина при ошибках ---------------------------------------------------

  it('POST / с невалидным телом (400) событие не публикует', async () => {
    const { app } = makeSkillsApp({ onSkillsChanged: skillsHook(published) });
    const res = await json(app, '/api/v2/skills', { name: 'Bad Name', description: '' }, 'POST');
    expect(res.status).toBe(400);
    expect(published).toEqual([]);
  });

  it('POST / с занятым именем (409) событие не публикует', async () => {
    const { app } = makeSkillsApp({ onSkillsChanged: skillsHook(published) });
    await json(app, '/api/v2/skills', { name: 'a', description: 'd' }, 'POST');
    published.length = 0;

    const res = await json(app, '/api/v2/skills', { name: 'a', description: 'd' }, 'POST');
    expect(res.status).toBe(409);
    expect(published).toEqual([]);
  });

  it('PATCH /:name с невалидным телом (400) и неизвестным скиллом (404) — тишина', async () => {
    const { app } = makeSkillsApp({ onSkillsChanged: skillsHook(published) });
    await json(app, '/api/v2/skills', { name: 'a', description: 'd' }, 'POST');
    published.length = 0;

    const empty = await json(app, '/api/v2/skills/a', {}, 'PATCH');
    expect(empty.status).toBe(400);
    const ghost = await json(app, '/api/v2/skills/ghost', { description: 'x' }, 'PATCH');
    expect(ghost.status).toBe(404);
    expect(published).toEqual([]);
  });

  it('PUT /:name/files/* с невалидным телом (400) — тишина', async () => {
    const { app } = makeSkillsApp({ onSkillsChanged: skillsHook(published) });
    await json(app, '/api/v2/skills', { name: 's', description: 'd' }, 'POST');
    published.length = 0;

    const res = await json(app, '/api/v2/skills/s/files/a.md', {}, 'PUT');
    expect(res.status).toBe(400);
    expect(published).toEqual([]);
  });

  it('files-роуты и DELETE для не-instance/неизвестного скилла (404) — тишина', async () => {
    const { app } = makeSkillsApp({ onSkillsChanged: skillsHook(published) });

    // Не-instance скилл (builtin) — files писать нельзя.
    const builtin = await json(app, '/api/v2/skills/skill-creator/files/a.md', { content: 'x' }, 'PUT');
    expect(builtin.status).toBe(404);
    // Неизвестный скилл — файла нет.
    const ghostFile = await app.request('/api/v2/skills/ghost/files/a.md', { method: 'DELETE' });
    expect(ghostFile.status).toBe(404);
    // Неизвестный скилл — удалять нечего.
    const ghostSkill = await app.request('/api/v2/skills/ghost', { method: 'DELETE' });
    expect(ghostSkill.status).toBe(404);
    // Невалидное имя — не ресурс (404).
    const badName = await app.request(`/api/v2/skills/${encodeURIComponent('Bad_Name')}`, { method: 'DELETE' });
    expect(badName.status).toBe(404);

    expect(published).toEqual([]);
  });

  // --- содержимое скилла в событие не попадает ------------------------------

  it('в payload нет body/metadata/files (содержимое скилла не уходит в шину)', async () => {
    const { app } = makeSkillsApp({ onSkillsChanged: skillsHook(published) });
    const body = '# Секретное тело\n\nТокен: sk-live-123456';
    const fileContent = 'секретная подсказка: sk-file-654321';

    await json(app, '/api/v2/skills', {
      name: 'leaky',
      description: 'скилл с секретами',
      body,
      files: { 'references/a.md': fileContent },
    }, 'POST');
    await json(app, '/api/v2/skills/leaky', {
      body,
      metadata: { token: 'sk-meta-999' },
    }, 'PATCH');
    await json(app, '/api/v2/skills/leaky/files/references/b.md', { content: fileContent }, 'PUT');
    await app.request('/api/v2/skills/leaky', { method: 'DELETE' });

    expect(published.map((e) => e.data.action)).toEqual(['create', 'update', 'files', 'delete']);
    for (const event of published) {
      // Разрешённые ключи payload — только метаданные мутации.
      expect(Object.keys(event.data).sort()).toEqual(['action', 'name']);
      expect(event.data).not.toHaveProperty('body');
      expect(event.data).not.toHaveProperty('metadata');
      expect(event.data).not.toHaveProperty('files');
      const serialized = JSON.stringify(event);
      expect(serialized).not.toContain('sk-live-123456');
      expect(serialized).not.toContain('sk-file-654321');
      expect(serialized).not.toContain('sk-meta-999');
    }
  });

  it('без хука фабрика работает как раньше (мутации проходят, событий нет)', async () => {
    const { app } = makeSkillsApp();
    const created = await json(app, '/api/v2/skills', { name: 'quiet', description: 'd' }, 'POST');
    expect(created.status).toBe(201);
    expect((await json(app, '/api/v2/skills/quiet', { description: 'e' }, 'PATCH')).status).toBe(200);
    expect((await app.request('/api/v2/skills/quiet', { method: 'DELETE' })).status).toBe(200);
    expect((await app.request('/api/v2/skills/reload', { method: 'POST' })).status).toBe(200);
    expect(published).toEqual([]);
  });
});

describe('createSkillBundleRoutes — событие skills.updated', () => {
  let published: PublishedEvent[];

  beforeEach(() => {
    published = [];
  });

  it('POST / публикует { action: create, name бандла }', async () => {
    const { app } = makeBundlesApp({ onSkillsChanged: skillsHook(published) });
    const res = await json(app, '/api/v2/skill-bundles', {
      name: 'backend', description: 'Backend', skills: ['a', 'b'],
    }, 'POST');
    expect(res.status).toBe(201);
    expect(published).toEqual([
      { channel: 'instance', type: 'skills.updated', data: { action: 'create', name: 'backend' } },
    ]);
  });

  it('PATCH /:name публикует { action: update, name }', async () => {
    const { app } = makeBundlesApp({ onSkillsChanged: skillsHook(published) });
    await json(app, '/api/v2/skill-bundles', { name: 'backend', description: 'B', skills: ['a'] }, 'POST');
    published.length = 0;

    const res = await json(app, '/api/v2/skill-bundles/backend', { description: 'B2', skills: ['a'] }, 'PATCH');
    expect(res.status).toBe(200);
    expect(published).toEqual([
      { channel: 'instance', type: 'skills.updated', data: { action: 'update', name: 'backend' } },
    ]);
  });

  it('DELETE /:name публикует { action: delete, name }', async () => {
    const { app } = makeBundlesApp({ onSkillsChanged: skillsHook(published) });
    await json(app, '/api/v2/skill-bundles', { name: 'backend', description: 'B', skills: ['a'] }, 'POST');
    published.length = 0;

    const res = await json(app, '/api/v2/skill-bundles/backend', undefined, 'DELETE');
    expect(res.status).toBe(200);
    expect(published).toEqual([
      { channel: 'instance', type: 'skills.updated', data: { action: 'delete', name: 'backend' } },
    ]);
  });

  it('ошибки (400/404/409) событие не публикуют', async () => {
    const { app } = makeBundlesApp({ onSkillsChanged: skillsHook(published) });
    await json(app, '/api/v2/skill-bundles', { name: 'x', description: 'X', skills: ['a'] }, 'POST');
    published.length = 0;

    // 400 — невалидное тело (пустой список скиллов).
    expect((await json(app, '/api/v2/skill-bundles', { name: 'y', description: 'Y', skills: [] }, 'POST')).status).toBe(400);
    // 409 — имя занято.
    expect((await json(app, '/api/v2/skill-bundles', { name: 'x', description: 'X', skills: ['a'] }, 'POST')).status).toBe(409);
    // 404 — неизвестный бандл (PATCH и DELETE).
    expect((await json(app, '/api/v2/skill-bundles/ghost', { description: 'G', skills: ['a'] }, 'PATCH')).status).toBe(404);
    expect((await json(app, '/api/v2/skill-bundles/ghost', undefined, 'DELETE')).status).toBe(404);

    expect(published).toEqual([]);
  });

  it('бандл с несуществующими скиллами (400) событие не публикует', async () => {
    const app = new Hono();
    const bundleStore = new SkillBundleStore({ dataDir: tmpDir });
    app.route('/api/v2/skill-bundles', createSkillBundleRoutes(
      createMockAuth(),
      { bundleStore, validateSkills: async (names) => names.filter((n) => n !== 'known') },
      { onSkillsChanged: skillsHook(published) },
    ));

    const res = await json(app, '/api/v2/skill-bundles', {
      name: 'mixed', description: 'M', skills: ['known', 'missing'],
    }, 'POST');
    expect(res.status).toBe(400);
    expect(published).toEqual([]);
    // Записи не появилось — мутации не было.
    expect(await bundleStore.exists('mixed')).toBe(false);
  });
});

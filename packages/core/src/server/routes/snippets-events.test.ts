/**
 * Событие шины `snippets.updated` на HTTP-путях реестра `#`-сниппетов
 * (`createSnippetRoutes`, ADR-126 §4).
 *
 * Баг: «сниппет, созданный/изменённый/удалённый в другом клиенте, соседней
 * вкладке или агентом через HTTP API, виден в панели „Сниппеты“ и `#`-пикере
 * композера только после перезагрузки страницы»: `SnippetsSettings` и
 * `SnippetAutocomplete` грузят список один раз при монтировании и перечитывают
 * его только после **своих** действий.
 *
 * Контракт проверяется здесь целиком:
 * - `POST /` → `action: 'create'`, `PATCH /:name` → `action: 'update'`
 *   (в том числе переименование и перенос на другой уровень — это **одна**
 *   мутация и **одно** событие), `DELETE /:name` → `action: 'delete'`;
 * - `POST /expand` (предпросмотр раскрытия) — тишина: записи нет;
 * - **не** публикуется при ошибке: 400 (невалидное имя/тело), 403 (нет права на
 *   слот), 404 (сниппета нет);
 * - payload — только `{action, snippetId?}`, где `snippetId` — каноническое
 *   **имя** записи: **текста сниппета (`body`), описания и алиасов в событии
 *   нет** (сниппет — пользовательский и проектный, то есть недоверенный, ввод).
 *
 * Хук подменён тем же путём, что у точки сборки (`snippetsChangedPublisher`
 * поверх фейковой шины): тест про контракт фабрики, а не про EventBus (сам шов —
 * `src/events/snippets-events.test.ts`).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Context, MiddlewareHandler, Next } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuthKit } from '../../auth/local.js';
import { createSnippetRoutes } from './snippets.js';
import { SnippetService } from '../../engine/snippets/service.js';
import { snippetsChangedPublisher } from '../../events/snippets-events.js';

const ADMIN = 'admin-1';

/** Записанное событие (канал + тип + payload). */
interface PublishedEvent {
  channel: string;
  type: string;
  data: Record<string, unknown>;
}

/** Фейковая шина: инстансные события. */
function makeBus(published: PublishedEvent[]) {
  return {
    publishInstance: (type: string, data: Record<string, unknown> = {}) => {
      published.push({ channel: 'instance', type, data });
    },
  };
}

/** Тот же путь публикации, что у точки сборки: `snippetsChangedPublisher(eventBus)`. */
function snippetsHook(published: PublishedEvent[]) {
  return snippetsChangedPublisher(makeBus(published));
}

function createMockAuth(): AuthKit {
  return {
    getCurrentUser: () => null,
    requireAuth: async (_c: Context, next: Next) => { await next(); },
  } as unknown as AuthKit;
}

/** Guard записи: как `requireAdmin` в backend — писать может только ADMIN. */
const adminGuard: MiddlewareHandler = async (c, next) => {
  const userId = c.req.header('x-user-id') ?? '';
  if (userId !== ADMIN) {
    return c.json({ error: { code: 'FORBIDDEN', message: 'нужна роль ADMIN' } }, 403);
  }
  await next();
};

let dataDir: string;
let workspace: string;
let published: PublishedEvent[];

function makeApp(opts: { writeGuard?: MiddlewareHandler } = {}) {
  const app = new Hono();
  const service = new SnippetService({ dataDir, trustedProjectDirs: [workspace] });
  app.route(
    '/api/v2/snippets',
    createSnippetRoutes(
      createMockAuth(),
      {
        snippetService: service,
        projectStore: { load: async () => null },
        resolveProjectWorkspace: async () => workspace,
      },
      {
        writeGuard: opts.writeGuard ?? adminGuard,
        resolveUserId: (c) => c.req.header('x-user-id') ?? '',
        onSnippetsChanged: snippetsHook(published),
      },
    ),
  );
  return app;
}

async function send(
  app: Hono,
  method: string,
  url: string,
  body?: unknown,
  userId = ADMIN,
): Promise<Response> {
  return app.request(url, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeEach(async () => {
  published = [];
  dataDir = await mkdtemp(join(tmpdir(), 'synth-snippets-events-data-'));
  workspace = await mkdtemp(join(tmpdir(), 'synth-snippets-events-ws-'));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(workspace, { recursive: true, force: true });
});

describe('createSnippetRoutes — событие snippets.updated на write-путях', () => {
  it('POST / публикует { action: create, snippetId: имя } без текста сниппета', async () => {
    const app = makeApp();

    const res = await send(app, 'POST', '/api/v2/snippets', {
      name: 'greet',
      body: 'секретный-текст-сниппета: rm -rf /',
      description: 'секретное-описание',
      aliases: ['secret-alias'],
      scope: 'instance',
    });

    expect(res.status).toBe(201);
    expect(published).toEqual([
      {
        channel: 'instance',
        type: 'snippets.updated',
        data: { action: 'create', snippetId: 'greet' },
      },
    ]);
    // Текста, описания и алиасов в событии нет.
    const serialized = JSON.stringify(published);
    expect(serialized).not.toContain('секретный-текст-сниппета');
    expect(serialized).not.toContain('rm -rf');
    expect(serialized).not.toContain('секретное-описание');
    expect(serialized).not.toContain('secret-alias');
  });

  it('PATCH /:name (правка тела) публикует { action: update }', async () => {
    const app = makeApp();
    await send(app, 'POST', '/api/v2/snippets', {
      name: 'greet',
      body: 'Привет',
      scope: 'instance',
    });
    published.length = 0;

    const res = await send(app, 'PATCH', '/api/v2/snippets/greet', { body: 'Пока' });

    expect(res.status).toBe(200);
    expect(published).toEqual([
      {
        channel: 'instance',
        type: 'snippets.updated',
        data: { action: 'update', snippetId: 'greet' },
      },
    ]);
  });

  it('PATCH с переименованием и переносом уровня — одна мутация и одно событие update', async () => {
    const app = makeApp();
    await send(app, 'POST', '/api/v2/snippets', {
      name: 'movable',
      body: 'текст',
      scope: 'user',
    });
    published.length = 0;

    const res = await send(app, 'PATCH', '/api/v2/snippets/movable', {
      name: 'moved',
      scope: 'instance',
    });

    expect(res.status).toBe(200);
    // Промежуточные create/delete внутри запроса клиенту не видны: реестр
    // изменился один раз — одно событие, и `snippetId` — новое имя записи.
    expect(published).toEqual([
      {
        channel: 'instance',
        type: 'snippets.updated',
        data: { action: 'update', snippetId: 'moved' },
      },
    ]);
  });

  it('DELETE /:name публикует { action: delete }', async () => {
    const app = makeApp();
    await send(app, 'POST', '/api/v2/snippets', {
      name: 'greet',
      body: 'Привет',
      scope: 'instance',
    });
    published.length = 0;

    const res = await send(app, 'DELETE', '/api/v2/snippets/greet');

    expect(res.status).toBe(200);
    expect(published).toEqual([
      {
        channel: 'instance',
        type: 'snippets.updated',
        data: { action: 'delete', snippetId: 'greet' },
      },
    ]);
  });

  it('POST /expand (предпросмотр раскрытия) не публикует: записи нет', async () => {
    const app = makeApp();
    await send(app, 'POST', '/api/v2/snippets', {
      name: 'greet',
      body: 'Привет, #name',
      scope: 'instance',
    });
    published.length = 0;

    const res = await send(app, 'POST', '/api/v2/snippets/expand', { text: 'текст #greet' });

    expect(res.status).toBe(200);
    expect(published).toEqual([]);
  });

  it('ошибки молчат: 400 (тело/имя), 403 (guard), 404 (нет сниппета)', async () => {
    const app = makeApp();

    // 400 — пустое имя и невалидное имя.
    expect((await send(app, 'POST', '/api/v2/snippets', { name: '', body: 'x' })).status).toBe(400);
    expect((await send(app, 'POST', '/api/v2/snippets', { name: 'плохое имя', body: 'x' })).status)
      .toBe(400);
    // 403 — не ADMIN (write-guard слота instance).
    expect(
      (await send(app, 'POST', '/api/v2/snippets', {
        name: 'greet',
        body: 'Привет',
        scope: 'instance',
      }, 'user-1')).status,
    ).toBe(403);
    // 404 — править/удалять нечего.
    expect((await send(app, 'PATCH', '/api/v2/snippets/absent', { body: 'x' })).status).toBe(404);
    expect((await send(app, 'DELETE', '/api/v2/snippets/absent')).status).toBe(404);

    expect(published).toEqual([]);

    // Контроль: после ошибок исправная запись событие всё же публикует.
    expect(
      (await send(app, 'POST', '/api/v2/snippets', {
        name: 'greet',
        body: 'Привет',
        scope: 'instance',
      })).status,
    ).toBe(201);
    expect(published.map((e) => e.data.action)).toEqual(['create']);
  });

  it('каждая успешная мутация — ровно одно событие в инстансном канале', async () => {
    const app = makeApp();

    await send(app, 'POST', '/api/v2/snippets', { name: 'greet', body: 'a', scope: 'instance' });
    await send(app, 'PATCH', '/api/v2/snippets/greet', { body: 'b' });
    await send(app, 'DELETE', '/api/v2/snippets/greet');

    expect(published.map((e) => e.data.action)).toEqual(['create', 'update', 'delete']);
    expect(published.every((e) => e.channel === 'instance')).toBe(true);
    expect(published.every((e) => e.type === 'snippets.updated')).toBe(true);
  });
});

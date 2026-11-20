/**
 * Событие шины `dictionaries.updated` на HTTP-путях словарей классификации.
 *
 * Баг: «словарь, сохранённый или сброшенный в другом клиенте или соседней вкладке
 * настроек, виден в секции "Словари" только после перезагрузки страницы»: секция
 * `DictionarySection` (`RoutingSettings`) грузит список один раз
 * (`useEffect(..., [])`) и перечитывает его только после **своего**
 * сохранения/сброса, а сервер о чужих мутациях молчал — метка источника
 * (`user`/`system`) и размер словаря оставались прежними.
 *
 * Контракт проверяется здесь целиком:
 * - `PUT /:category/:lang` (`save` — оба формата тела: `{ content }` и legacy
 *   `{ keywords, tools }`), `DELETE /:category/:lang` (`reset`);
 * - **не** публикуется при ошибке: 400 (неизвестная категория/язык, битый YAML,
 *   мусорные `keywords`), 404 (сбрасывать нечего), 403 (write-guard);
 * - payload — только категория, язык и вид мутации: **содержимое словаря (YAML и
 *   разобранные `keywords`/`tools`) в событие не попадает**.
 *
 * Хук подменён фейком (`onDictionariesChanged` — тот же хук, что у
 * `dictionariesChangedPublisher`): тест про контракт фабрики, а не про EventBus
 * (сам шов — `src/events/dictionaries-events.test.ts`).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDictionaryRoutes } from './dictionaries.js';
import { DictionaryStore } from '../../engine/router/dictionary-store.js';
import { publishDictionariesUpdated } from '../../events/dictionaries-events.js';
import type { DictionariesChangedInfo } from '../../events/dictionaries-events.js';

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

/** Тот же путь публикации, что у точки сборки: `dictionariesChangedPublisher(eventBus)`. */
function dictionariesHook(published: PublishedEvent[]) {
  const bus = makeBus(published);
  return (info: DictionariesChangedInfo) => publishDictionariesUpdated(bus, info);
}

const passAuth: MiddlewareHandler = async (_c, next) => { await next(); };

describe('createDictionaryRoutes — событие dictionaries.updated на write-путях', () => {
  let root: string;
  let dataDir: string;
  let systemDir: string;
  let store: DictionaryStore;
  let published: PublishedEvent[];

  const makeApp = (writeGuard?: MiddlewareHandler) => {
    const app = new Hono();
    app.route(
      '/api/v2/dictionaries',
      createDictionaryRoutes(
        { requireAuth: passAuth },
        store,
        {
          onDictionariesChanged: dictionariesHook(published),
          ...(writeGuard ? { writeGuard } : {}),
        },
      ),
    );
    return app;
  };

  const put = (app: Hono, path: string, payload: unknown) =>
    app.request(path, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

  beforeEach(async () => {
    published = [];
    root = await mkdtemp(join(tmpdir(), 'synth-dict-events-'));
    systemDir = join(root, 'system');
    dataDir = join(root, 'data');
    await mkdir(systemDir, { recursive: true });
    await writeFile(join(systemDir, 'coding.ru.yaml'), 'keywords:\n  - системное\n  - код\n');
    await writeFile(join(systemDir, 'coding.en.yaml'), 'keywords:\n  - system\n  - code\n');
    await writeFile(join(systemDir, 'coding.tools.yaml'), 'tools:\n  - write_file\n');
    store = new DictionaryStore(dataDir, systemDir);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('PUT /:category/:lang ({ content }) публикует { action: save, category, lang } без содержимого', async () => {
    const app = makeApp();
    const content = 'keywords:\n  - моё-секретное-слово\n';

    const res = await put(app, '/api/v2/dictionaries/coding/ru', { content });

    expect(res.status).toBe(200);
    expect(published).toEqual([
      {
        channel: 'instance',
        type: 'dictionaries.updated',
        data: { action: 'save', category: 'coding', lang: 'ru' },
      },
    ]);
    // Содержимое словаря в событие не попадает.
    const serialized = JSON.stringify(published);
    expect(serialized).not.toContain('моё-секретное-слово');
    expect(serialized).not.toContain('keywords');
  });

  it('PUT /:category/:lang (legacy { keywords, tools }) тоже публикует save', async () => {
    const app = makeApp();

    const res = await put(app, '/api/v2/dictionaries/coding/en', {
      keywords: ['custom-word'],
      tools: ['write_file'],
    });

    expect(res.status).toBe(200);
    expect(published).toEqual([
      {
        channel: 'instance',
        type: 'dictionaries.updated',
        data: { action: 'save', category: 'coding', lang: 'en' },
      },
    ]);
    expect(JSON.stringify(published)).not.toContain('custom-word');
    expect(JSON.stringify(published)).not.toContain('write_file');
  });

  it('DELETE /:category/:lang публикует { action: reset, category, lang }', async () => {
    const app = makeApp();
    expect((await put(app, '/api/v2/dictionaries/coding/ru', { content: 'keywords:\n  - моё\n' })).status)
      .toBe(200);
    published.length = 0;

    const res = await app.request('/api/v2/dictionaries/coding/ru', { method: 'DELETE' });

    expect(res.status).toBe(200);
    expect(published).toEqual([
      {
        channel: 'instance',
        type: 'dictionaries.updated',
        data: { action: 'reset', category: 'coding', lang: 'ru' },
      },
    ]);
  });

  it('ошибки молчат: 400 (категория/язык/тело), 403 (guard)', async () => {
    const app = makeApp();

    // 400 — неизвестная категория/язык.
    expect((await put(app, '/api/v2/dictionaries/unknown/ru', { content: 'keywords:\n  - x\n' })).status)
      .toBe(400);
    expect((await put(app, '/api/v2/dictionaries/coding/de', { content: 'keywords:\n  - x\n' })).status)
      .toBe(400);
    // 400 — битый YAML и мусорные keywords.
    expect((await put(app, '/api/v2/dictionaries/coding/ru', { content: 'keywords: [a, b' })).status)
      .toBe(400);
    expect((await put(app, '/api/v2/dictionaries/coding/ru', { keywords: 'x' })).status).toBe(400);
    expect((await put(app, '/api/v2/dictionaries/coding/ru', {})).status).toBe(400);
    expect((await app.request('/api/v2/dictionaries/unknown/ru', { method: 'DELETE' })).status).toBe(400);
    expect(published).toEqual([]);

    // 403 — write-guard (в managed это ADMIN): записи нет, события нет.
    const deny: MiddlewareHandler = async (c) => c.json({ error: { code: 'FORBIDDEN' } }, 403);
    const guarded = makeApp(deny);
    expect((await put(guarded, '/api/v2/dictionaries/coding/ru', { content: 'keywords:\n  - x\n' })).status)
      .toBe(403);
    expect((await guarded.request('/api/v2/dictionaries/coding/ru', { method: 'DELETE' })).status).toBe(403);
    expect(published).toEqual([]);

    // Контроль: после ошибок исправная запись событие всё же публикует.
    expect((await put(app, '/api/v2/dictionaries/coding/ru', { content: 'keywords:\n  - x\n' })).status)
      .toBe(200);
    expect(published.map((e) => e.data.action)).toEqual(['save']);
  });

  it('DELETE идемпотентен: сброс уже системного словаря всё равно даёт один reset', async () => {
    const app = makeApp();

    // Пользовательского переопределения нет — `deleteUserDictionary` возвращает
    // действующий (системный) словарь, статус 200; клиенту это полезно так же:
    // список перечитывается, метка источника остаётся `system`.
    const res = await app.request('/api/v2/dictionaries/coding/ru', { method: 'DELETE' });

    expect(res.status).toBe(200);
    expect(published).toEqual([
      {
        channel: 'instance',
        type: 'dictionaries.updated',
        data: { action: 'reset', category: 'coding', lang: 'ru' },
      },
    ]);
  });

  it('каждое сохранение — ровно одно событие', async () => {
    const app = makeApp();

    await put(app, '/api/v2/dictionaries/coding/ru', { content: 'keywords:\n  - a\n' });
    await put(app, '/api/v2/dictionaries/coding/ru', { content: 'keywords:\n  - b\n' });

    expect(published).toHaveLength(2);
    expect(published.every((e) => e.channel === 'instance')).toBe(true);
    expect(published.every((e) => e.type === 'dictionaries.updated')).toBe(true);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { mkdtemp, rm, mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDictionaryRoutes } from './dictionaries.js';
import { DictionaryStore } from '../../engine/router/dictionary-store.js';

const passAuth: MiddlewareHandler = async (_c, next) => { await next(); };

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function createTestApp(store: DictionaryStore, writeGuard?: MiddlewareHandler) {
  const app = new Hono();
  app.route('/api/v2/dictionaries', createDictionaryRoutes(
    { requireAuth: passAuth },
    store,
    writeGuard ? { writeGuard } : {},
  ));
  return app;
}

describe('Dictionaries API Routes', () => {
  let root: string;
  let dataDir: string;
  let systemDir: string;
  let store: DictionaryStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'synth-dict-routes-'));
    systemDir = join(root, 'system');
    dataDir = join(root, 'data');
    await mkdir(systemDir, { recursive: true });
    await writeFile(join(systemDir, 'coding.ru.yaml'), 'keywords:\n  - системное\n  - код\n');
    await writeFile(join(systemDir, 'coding.en.yaml'), 'keywords:\n  - system\n  - code\n');
    await writeFile(join(systemDir, 'research.ru.yaml'), 'keywords:\n  - исследуй\n');
    await writeFile(join(systemDir, 'coding.tools.yaml'), 'tools:\n  - write_file\n  - edit_file\n');
    store = new DictionaryStore(dataDir, systemDir);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe('GET /api/v2/dictionaries', () => {
    it('возвращает список словарей', async () => {
      const app = createTestApp(store);
      const res = await app.request('/api/v2/dictionaries');
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(Array.isArray(body.dictionaries)).toBe(true);
      const coding = body.dictionaries.find((d: any) => d.category === 'coding' && d.language === 'ru');
      expect(coding).toMatchObject({ source: 'system' });
      expect(coding.keywords).toContain('код');
      expect(coding.tools).toContain('write_file');
    });
  });

  describe('GET /api/v2/dictionaries/:category/:lang', () => {
    it('возвращает словарь', async () => {
      const app = createTestApp(store);
      const res = await app.request('/api/v2/dictionaries/coding/ru');
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.dictionary).toMatchObject({ category: 'coding', language: 'ru', source: 'system' });
    });

    it('400 на неизвестную категорию и язык', async () => {
      const app = createTestApp(store);
      expect((await app.request('/api/v2/dictionaries/unknown/ru')).status).toBe(400);
      expect((await app.request('/api/v2/dictionaries/coding/de')).status).toBe(400);
    });
  });

  describe('PUT /api/v2/dictionaries/:category/:lang', () => {
    it('пишет файл и возвращает source=user', async () => {
      const app = createTestApp(store);
      const res = await app.request('/api/v2/dictionaries/coding/ru', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keywords: ['  моё  ', 'слово', 'моё'] }),
      });
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.status).toBe('ok');
      expect(body.dictionary).toMatchObject({ category: 'coding', language: 'ru', source: 'user' });
      // тримминг и дедупликация
      expect(body.dictionary.keywords).toEqual(['моё', 'слово']);

      const raw = await readFile(join(dataDir, 'dictionaries', 'coding.ru.yaml'), 'utf-8');
      expect(raw).toContain('- моё');

      const after = await app.request('/api/v2/dictionaries/coding/ru');
      const afterBody: any = await after.json();
      expect(afterBody.dictionary.source).toBe('user');
    });

    it('принимает tools и для coding отражает их в getCodingTools', async () => {
      const app = createTestApp(store);
      const res = await app.request('/api/v2/dictionaries/coding/ru', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keywords: ['моё'], tools: ['my_tool'] }),
      });
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.dictionary.tools).toEqual(['my_tool']);
      expect(store.getCodingTools()).toEqual(['my_tool']);
    });

    it('400 на неизвестную категорию, язык, мусорные keywords и отсутствие keywords', async () => {
      const app = createTestApp(store);
      const put = (path: string, payload: unknown) => app.request(path, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const unknown = await put('/api/v2/dictionaries/unknown/ru', { keywords: ['x'] });
      expect(unknown.status).toBe(400);
      expect((await unknown.json() as any).error.code).toBe('VALIDATION_ERROR');

      const badLang = await put('/api/v2/dictionaries/coding/de', { keywords: ['x'] });
      expect(badLang.status).toBe(400);

      const missing = await put('/api/v2/dictionaries/coding/ru', {});
      expect(missing.status).toBe(400);

      const notArray = await put('/api/v2/dictionaries/coding/ru', { keywords: 'x' });
      expect(notArray.status).toBe(400);

      const nonString = await put('/api/v2/dictionaries/coding/ru', { keywords: ['ok', 42] });
      expect(nonString.status).toBe(400);

      const tooMany = await put('/api/v2/dictionaries/coding/ru', {
        keywords: Array.from({ length: 2001 }, (_, i) => `w${i}`),
      });
      expect(tooMany.status).toBe(400);
    });

    it('400 на path traversal в категории', async () => {
      const app = createTestApp(store);
      const res = await app.request('/api/v2/dictionaries/..%2F..%2Fetc/ru', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keywords: ['x'] }),
      });
      expect(res.status).toBe(400);
    });

    it('уважает writeGuard (backend: ADMIN-only)', async () => {
      const deny: MiddlewareHandler = async (c) => c.json({ error: { code: 'FORBIDDEN' } }, 403);
      const app = createTestApp(store, deny);
      const res = await app.request('/api/v2/dictionaries/coding/ru', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keywords: ['x'] }),
      });
      expect(res.status).toBe(403);
      // GET при этом доступен
      expect((await app.request('/api/v2/dictionaries/coding/ru')).status).toBe(200);
    });
  });

  describe('DELETE /api/v2/dictionaries/:category/:lang', () => {
    it('убирает пользовательский файл и возвращает system-словарь', async () => {
      const app = createTestApp(store);
      await app.request('/api/v2/dictionaries/coding/ru', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keywords: ['моё'], tools: ['my_tool'] }),
      });
      expect(await exists(join(dataDir, 'dictionaries', 'coding.ru.yaml'))).toBe(true);

      const res = await app.request('/api/v2/dictionaries/coding/ru', { method: 'DELETE' });
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.status).toBe('ok');
      expect(body.dictionary).toMatchObject({ source: 'system' });
      expect(body.dictionary.keywords).toEqual(['системное', 'код']);
      expect(await exists(join(dataDir, 'dictionaries', 'coding.ru.yaml'))).toBe(false);
    });

    it('400 на неизвестную категорию/язык', async () => {
      const app = createTestApp(store);
      expect((await app.request('/api/v2/dictionaries/unknown/ru', { method: 'DELETE' })).status).toBe(400);
      expect((await app.request('/api/v2/dictionaries/coding/de', { method: 'DELETE' })).status).toBe(400);
    });
  });

  describe('content/size в ответах', () => {
    it('GET :category/:lang отдаёт системный content и корректный size', async () => {
      const app = createTestApp(store);
      const res = await app.request('/api/v2/dictionaries/research/ru');
      expect(res.status).toBe(200);
      const body: any = await res.json();
      const expected = await readFile(join(systemDir, 'research.ru.yaml'), 'utf-8');
      expect(body.dictionary.content).toBe(expected);
      expect(body.dictionary.size).toBe(Buffer.byteLength(expected, 'utf8'));
    });

    it('GET список содержит content и size', async () => {
      const app = createTestApp(store);
      const body: any = await (await app.request('/api/v2/dictionaries')).json();
      for (const entry of body.dictionaries) {
        expect(typeof entry.content).toBe('string');
        expect(entry.size).toBe(Buffer.byteLength(entry.content, 'utf8'));
      }
    });

    it('старый формат PUT { keywords, tools } по-прежнему работает и отдаёт content/size', async () => {
      const app = createTestApp(store);
      const res = await app.request('/api/v2/dictionaries/research/ru', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keywords: ['моё', 'слово'] }),
      });
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.dictionary).toMatchObject({ source: 'user' });
      expect(body.dictionary.keywords).toEqual(['моё', 'слово']);
      expect(body.dictionary.content).toBe('keywords:\n  - моё\n  - слово\n');
      expect(body.dictionary.size).toBe(Buffer.byteLength(body.dictionary.content, 'utf8'));
    });
  });

  describe('PUT { content }', () => {
    it('пишет YAML-текст, возвращает source=user, content и size', async () => {
      const app = createTestApp(store);
      const content = 'keywords:\n  - моё\n  - слово\n';
      const res = await app.request('/api/v2/dictionaries/research/ru', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.status).toBe('ok');
      expect(body.dictionary).toMatchObject({ category: 'research', language: 'ru', source: 'user' });
      expect(body.dictionary.keywords).toEqual(['моё', 'слово']);
      expect(body.dictionary.content).toBe(content);
      expect(body.dictionary.size).toBe(Buffer.byteLength(content, 'utf8'));

      expect(await exists(join(dataDir, 'dictionaries', 'research.ru.yaml'))).toBe(true);
      const after: any = await (await app.request('/api/v2/dictionaries/research/ru')).json();
      expect(after.dictionary.source).toBe('user');
      expect(after.dictionary.content).toBe(content);
    });

    it('400 на некорректный YAML (понятное сообщение)', async () => {
      const app = createTestApp(store);
      const res = await app.request('/api/v2/dictionaries/research/ru', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'keywords: [a, b' }),
      });
      expect(res.status).toBe(400);
      const body: any = await res.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(typeof body.error.message).toBe('string');
      expect(body.error.message.length).toBeGreaterThan(0);
    });

    it('400 если content не строка или отсутствует keywords', async () => {
      const app = createTestApp(store);
      const put = (payload: unknown) => app.request('/api/v2/dictionaries/research/ru', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      expect((await put({ content: 42 })).status).toBe(400);
      expect((await put({ content: 'tools:\n  - x\n' })).status).toBe(400);
    });

    it('coding: content с tools зеркалится в getCodingTools', async () => {
      const app = createTestApp(store);
      const content = 'keywords:\n  - моё\ntools:\n  - my_tool\n';
      const res = await app.request('/api/v2/dictionaries/coding/ru', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.dictionary.tools).toEqual(['my_tool']);
      expect(body.dictionary.content).toBe(content);
      expect(store.getCodingTools()).toEqual(['my_tool']);
    });
  });

  describe('DELETE после PUT { content }', () => {
    it('возвращает системный content и size', async () => {
      const app = createTestApp(store);
      await app.request('/api/v2/dictionaries/research/ru', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'keywords:\n  - моё\n' }),
      });
      const res = await app.request('/api/v2/dictionaries/research/ru', { method: 'DELETE' });
      expect(res.status).toBe(200);
      const body: any = await res.json();
      const expected = await readFile(join(systemDir, 'research.ru.yaml'), 'utf-8');
      expect(body.dictionary).toMatchObject({ source: 'system' });
      expect(body.dictionary.content).toBe(expected);
      expect(body.dictionary.size).toBe(Buffer.byteLength(expected, 'utf8'));
      expect(await exists(join(dataDir, 'dictionaries', 'research.ru.yaml'))).toBe(false);
    });
  });
});

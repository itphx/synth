import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBindingStore } from './event-binding-store.js';
import type { UpsertEventBindingInput } from './event-binding-store.js';

const binding = (overrides: Partial<UpsertEventBindingInput> = {}): UpsertEventBindingInput => ({
  source: 'telegram',
  mode: 'bound',
  ...overrides,
});

describe('EventBindingStore (AD-089)', () => {
  let store: EventBindingStore;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-event-bindings-'));
    store = new EventBindingStore({ dataDir: tmpDir });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('upsert без id генерирует bnd_<uuid>', async () => {
    const created = await store.upsert(binding({ chatKey: 'chat:telegram:1' }));
    expect(created.id).toMatch(/^bnd_/);
    expect(created.source).toBe('telegram');
    expect(created.mode).toBe('bound');
  });

  it('get/list/remove — базовый CRUD', async () => {
    const created = await store.upsert(binding({ chatKey: 'chat:telegram:1' }));
    expect((await store.get(created.id))?.id).toBe(created.id);
    expect(await store.list()).toHaveLength(1);
    expect(await store.get('missing')).toBeNull();

    expect(await store.remove(created.id)).toBe(true);
    expect(await store.get(created.id)).toBeNull();
    expect(await store.remove(created.id)).toBe(false);
  });

  it('upsert с существующим id заменяет запись', async () => {
    const created = await store.upsert(binding({ chatKey: 'chat:telegram:1' }));
    const updated = await store.upsert({ ...binding({ chatKey: 'chat:telegram:2' }), id: created.id });
    expect(updated.id).toBe(created.id);
    expect(updated.chatKey).toBe('chat:telegram:2');
    expect(await store.list()).toHaveLength(1);
  });

  it('findByKey: threadKey приоритетнее chatKey', async () => {
    const chat = await store.upsert(binding({ chatKey: 'chat:telegram:1', sessionId: 's-chat' }));
    const thread = await store.upsert(
      binding({ chatKey: 'chat:telegram:1', threadKey: 'thread:telegram:1:7', sessionId: 's-thread' }),
    );

    const found = await store.findByKey({
      source: 'telegram',
      chatKey: 'chat:telegram:1',
      threadKey: 'thread:telegram:1:7',
    });
    expect(found?.id).toBe(thread.id);

    // Без threadKey — падаем на чат.
    const byChat = await store.findByKey({ source: 'telegram', chatKey: 'chat:telegram:1' });
    expect(byChat?.id).toBe(chat.id);
  });

  it('findByKey: fallback на chatKey, если threadKey задан, но привязки нет', async () => {
    const chat = await store.upsert(binding({ chatKey: 'chat:telegram:1' }));
    const found = await store.findByKey({
      source: 'telegram',
      chatKey: 'chat:telegram:1',
      threadKey: 'thread:telegram:1:99',
    });
    expect(found?.id).toBe(chat.id);
  });

  it('findByKey: разные source не матчатся; отсутствие → null', async () => {
    await store.upsert(binding({ source: 'telegram', chatKey: 'chat:telegram:1' }));
    expect(await store.findByKey({ source: 'synth-media', chatKey: 'chat:telegram:1' })).toBeNull();
    expect(await store.findByKey({ source: 'telegram', chatKey: 'chat:telegram:404' })).toBeNull();
    expect(await store.findByKey({ source: 'telegram' })).toBeNull();
  });

  it('персистит данные между инстансами', async () => {
    const created = await store.upsert(binding({ chatKey: 'chat:telegram:1' }));
    const reloaded = new EventBindingStore({ dataDir: tmpDir });
    expect((await reloaded.get(created.id))?.chatKey).toBe('chat:telegram:1');
  });

  it('отклоняет id с path traversal', async () => {
    await expect(store.upsert({ ...binding(), id: '../evil' })).rejects.toThrow('Недопустимый id');
  });

  it('пишет файл атомарно: нет .tmp-файлов, JSON валиден', async () => {
    await store.upsert(binding({ chatKey: 'chat:telegram:1' }));
    const dir = join(tmpDir, 'events');
    const files = await readdir(dir);
    expect(files.filter((f) => f.includes('.tmp'))).toHaveLength(0);
    expect(files).toContain('bindings.json');
    const raw = JSON.parse(await readFile(join(dir, 'bindings.json'), 'utf-8'));
    expect(raw.schemaVersion).toBe(1);
    expect(raw.bindings).toHaveLength(1);
  });

  it('параллельные upsert не теряют записи (per-file lock)', async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => store.upsert(binding({ chatKey: `chat:telegram:${i}` }))),
    );
    const entries = await store.list();
    expect(entries).toHaveLength(10);
    expect(new Set(entries.map((e) => e.id)).size).toBe(10);
  });
});

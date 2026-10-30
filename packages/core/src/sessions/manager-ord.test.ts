import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from './manager.js';
import { FileStore } from '../storage/file-store.js';
import type { Message } from '@itphx/synth-shared';
import { MessageRole, generateId, makeTextPart, nowISO } from '@itphx/synth-shared';

describe('SessionManager — `ord` (ADR-118 §2)', () => {
  let store: FileStore;
  let manager: SessionManager;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-test-'));
    store = new FileStore({ dataDir: tmpDir });
    manager = new SessionManager(store);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeMsg(content: string, role: MessageRole = MessageRole.USER): Message {
    return {
      id: generateId(),
      role,
      seq: 0,
      origin: 'local',
      parts: [makeTextPart(content)],
      content,
      createdAt: nowISO(),
      disabled: false,
      pinned: false,
      hidden: false,
    };
  }

  it('addMessage проставляет монотонный ord', async () => {
    const session = await manager.createSession({});

    await manager.addMessage(session.id, makeMsg('first'));
    await manager.addMessage(session.id, makeMsg('second', MessageRole.ASSISTANT));
    await manager.addMessage(session.id, makeMsg('third', MessageRole.ASSISTANT));

    const stored = await manager.getSession(session.id);
    expect(stored!.messages.map((m) => m.ord)).toEqual([1, 2, 3]);
  });

  it('addMessage не перетирает уже проставленный ord', async () => {
    const session = await manager.createSession({});
    await manager.addMessage(session.id, makeMsg('first'));

    await manager.addMessage(session.id, { ...makeMsg('pre-assigned'), ord: 10 });

    const stored = await manager.getSession(session.id);
    expect(stored!.messages.map((m) => m.ord)).toEqual([1, 10]);
  });

  it('appendMessage (порт) выдаёт ord — монотонный и переживает перезагрузку', async () => {
    const session = await manager.createSession({});

    const first = await manager.appendMessage(session.id, makeMsg('first'));
    const second = await manager.appendMessage(session.id, makeMsg('second', MessageRole.ASSISTANT));
    expect(first!.ord).toBe(1);
    expect(second!.ord).toBe(2);

    const stored = await manager.getSession(session.id);
    expect(stored!.messages.map((m) => m.ord)).toEqual([1, 2]);
  });

  it('updateMessage сохраняет ord исходного сообщения', async () => {
    const session = await manager.createSession({});
    const appended = await manager.appendMessage(session.id, makeMsg('draft', MessageRole.ASSISTANT));
    expect(appended!.ord).toBe(1);

    // Обновление (финализация черновика) не перебивает выданный `ord`, даже
    // если в теле обновления `ord` другой.
    const updated = await manager.updateMessage(session.id, {
      ...appended!,
      content: 'финал',
      ord: 999,
      status: 'completed',
    });
    expect(updated!.ord).toBe(1);
    expect(updated!.status).toBe('completed');

    const stored = await manager.getSession(session.id);
    expect(stored!.messages[0]!.ord).toBe(1);
  });

  it('legacy-сообщение получает ord при обновлении (путь миграции данных)', async () => {
    const session = await manager.createSession({});
    // Запись до ADR-118: `ord` не выдан.
    const legacy = { ...makeMsg('legacy'), seq: 1 };
    const stored = await store.load(session.id);
    stored!.messages = [legacy];
    await store.save(stored!);

    const updated = await manager.updateMessage(session.id, {
      ...legacy,
      ord: 5,
      turnId: 'turn-1',
      stepIndex: 0,
    });
    expect(updated!.ord).toBe(5);

    const reloaded = await manager.getSession(session.id);
    expect(reloaded!.messages[0]!.ord).toBe(5);
    expect(reloaded!.messages[0]!.turnId).toBe('turn-1');
    expect(reloaded!.messages[0]!.stepIndex).toBe(0);
  });

  it('вставка в середину не перенумеровывает существующие сообщения', async () => {
    const target = await manager.createSession({ title: 'target' });
    await manager.addMessage(target.id, makeMsg('target-1'));
    await manager.addMessage(target.id, makeMsg('target-2', MessageRole.ASSISTANT));

    const source = await manager.createSession({ title: 'source' });
    const sourceMsg = await manager.addMessage(source.id, makeMsg('вставка'));
    const inserted = sourceMsg!.messages[0]!;
    // `ord` источника — счётчик чужой сессии, в цель не переносится.
    expect(inserted.ord).toBe(1);

    const merged = await manager.mergeMessages(target.id, source.id, {
      sourceRange: [1, 1],
      position: 'before',
    });
    expect(merged).toHaveLength(1);

    const stored = await manager.getSession(target.id);
    // Первые два сообщения сохранили свои `ord`, копия получила свежий.
    expect(stored!.messages.map((m) => m.ord)).toEqual([3, 1, 2]);
    expect(stored!.messages.map((m) => m.content)).toEqual(['вставка', 'target-1', 'target-2']);
  });

  it('forkSession: копии получают собственный счётчик новой сессии', async () => {
    const source = await manager.createSession({ title: 'src' });
    source.messages = [makeMsg('a'), makeMsg('b', MessageRole.ASSISTANT)];
    source.messages[0]!.ord = 5;
    source.messages[1]!.ord = 6;
    await manager.saveSession(source);

    const forked = await manager.forkSession(source.id, {});
    expect(forked.messages.map((m) => m.ord)).toEqual([1, 2]);

    // Счётчик форка продолжается монотонно.
    await manager.addMessage(forked.id, makeMsg('c'));
    const stored = await manager.getSession(forked.id);
    expect(stored!.messages.map((m) => m.ord)).toEqual([1, 2, 3]);
  });
});

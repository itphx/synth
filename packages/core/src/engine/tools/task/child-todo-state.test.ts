/**
 * Этап 3a-1: durable state-сообщение `todos_updated` дочерней сессии.
 *
 * Контракт записи: одна атомарная мутация истории (`mutateHistory`) —
 *  - `updatedAt` не двигается (паритет с прежним `saveSession` без бампа);
 *  - повторный вызов без изменений **не пишет** (ранний `return`);
 *  - список задач добавлен/обновлён/удалён — состояние истории следует за ним.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message, TodoItem } from '@itphx/synth-shared';
import { MessageRole, generateId, makeTextPart, nowISO } from '@itphx/synth-shared';
import { SessionManager } from '../../../sessions/manager.js';
import { FileStore } from '../../../storage/file-store.js';
import { ensureTodoStateMessage } from './child-todo-state.js';

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

function todo(id: string, content: string, status: TodoItem['status'] = 'pending'): TodoItem {
  return { id, content, status, priority: 'medium' } as TodoItem;
}

/** State-сообщения списка задач (derived state). */
function todoStateMessages(messages: Message[]): Message[] {
  return messages.filter((m) => m.metadata?.state === true && m.metadata?.type === 'todos_updated');
}

describe('ensureTodoStateMessage (этап 3a-1)', () => {
  let tmpDir: string;
  let store: FileStore;
  let sessionManager: SessionManager;
  /** Число фактических записей истории (`shouldWrite` = решение порта). */
  let writes: { count: number };

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-child-todo-'));
    store = new FileStore({ dataDir: tmpDir });
    writes = { count: 0 };
    const original = store.mutateHistory.bind(store);
    vi.spyOn(store, 'mutateHistory').mockImplementation(async (id, mutator, opts) => {
      return original(id, mutator, {
        ...opts,
        shouldWrite: (value) => {
          const ok = opts?.shouldWrite ? opts.shouldWrite(value) : true;
          if (ok) writes.count += 1;
          return ok;
        },
      });
    });
    sessionManager = new SessionManager(store);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  /** Сид задачи: список правится без бампа `updatedAt` (служебная правка). */
  async function seedTodos(sessionId: string, todos: TodoItem[]): Promise<string> {
    await sessionManager.mutateMeta(sessionId, (meta) => {
      meta.todos = todos;
    }, { touchUpdatedAt: false });
    return (await sessionManager.getSession(sessionId))!.updatedAt;
  }

  it('добавляет state-сообщение по списку задач; updatedAt не меняется', async () => {
    const session = await sessionManager.createSession({ title: 'child' });
    const updatedAt = await seedTodos(session.id, [todo('t1', 'первая')]);

    await ensureTodoStateMessage(sessionManager, session.id);

    const stored = (await sessionManager.getSession(session.id))!;
    const states = todoStateMessages(stored.messages);
    expect(states).toHaveLength(1);
    expect(states[0]!.role).toBe(MessageRole.SYSTEM);
    expect(states[0]!.content).toContain('первая');
    expect(states[0]!.ord).toBeGreaterThan(0);
    expect(states[0]!.seq).toBe(stored.messages.length);
    // Служебная запись времени сессии не двигает.
    expect(stored.updatedAt).toBe(updatedAt);
    expect(writes.count).toBe(1);
  });

  it('изменение списка добавляет новое state-сообщение (старое остаётся)', async () => {
    const session = await sessionManager.createSession({ title: 'child' });
    await seedTodos(session.id, [todo('t1', 'первая')]);
    await ensureTodoStateMessage(sessionManager, session.id);

    const updatedAt = await seedTodos(session.id, [
      todo('t1', 'первая', 'completed'),
      todo('t2', 'вторая'),
    ]);
    await ensureTodoStateMessage(sessionManager, session.id);

    const stored = (await sessionManager.getSession(session.id))!;
    const states = todoStateMessages(stored.messages);
    expect(states).toHaveLength(2);
    expect(states[1]!.content).toContain('вторая');
    // `ord` новых записей растёт монотонно, ранее выданные не перенумерованы.
    expect(states[1]!.ord!).toBeGreaterThan(states[0]!.ord!);
    expect(stored.updatedAt).toBe(updatedAt);
  });

  it('пустой список удаляет state-сообщения', async () => {
    const session = await sessionManager.createSession({ title: 'child' });
    await seedTodos(session.id, [todo('t1', 'первая')]);
    await ensureTodoStateMessage(sessionManager, session.id);
    expect(todoStateMessages((await sessionManager.getSession(session.id))!.messages)).toHaveLength(1);

    const updatedAt = await seedTodos(session.id, []);
    await ensureTodoStateMessage(sessionManager, session.id);

    const stored = (await sessionManager.getSession(session.id))!;
    expect(todoStateMessages(stored.messages)).toHaveLength(0);
    expect(stored.updatedAt).toBe(updatedAt);
    expect(writes.count).toBe(2);
  });

  it('идемпотентность: повторный вызов без изменений не пишет', async () => {
    const session = await sessionManager.createSession({ title: 'child' });
    await seedTodos(session.id, [todo('t1', 'первая')]);

    await ensureTodoStateMessage(sessionManager, session.id);
    expect(writes.count).toBe(1);
    await ensureTodoStateMessage(sessionManager, session.id);
    expect(writes.count).toBe(1);

    // Устаревшего state нет и список пуст — тоже без записи.
    const empty = await sessionManager.createSession({ title: 'empty-child' });
    await ensureTodoStateMessage(sessionManager, empty.id);
    expect(writes.count).toBe(1);
  });

  it('параллельная дозапись сообщения не теряется', async () => {
    const session = await sessionManager.createSession({ title: 'child' });
    await seedTodos(session.id, [todo('t1', 'первая')]);
    const witness = makeMsg('свидетель', MessageRole.TOOL);

    await Promise.all([
      ensureTodoStateMessage(sessionManager, session.id),
      sessionManager.appendMessage(session.id, witness),
    ]);

    const stored = (await sessionManager.getSession(session.id))!;
    expect(stored.messages.map((m) => m.id)).toContain(witness.id);
    expect(todoStateMessages(stored.messages)).toHaveLength(1);
  });
});

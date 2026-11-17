import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MARKDOWN_LIMITS, MessageRole, generateId, makeTextPart, nowISO } from '@itphx/synth-shared';
import type { Message, TodoItem } from '@itphx/synth-shared';
import { SessionManager } from '../../sessions/manager.js';
import { FileStore } from '../../storage/file-store.js';
import {
  TodoService,
  TodoLimitExceededError,
  TodoNotFoundError,
  TodoValidationError,
} from './service.js';

/** Доменный сервис списка задач сессии (PROP-054). */
describe('TodoService', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;
  let service: TodoService;
  let sessionId: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-todo-service-'));
    const store = new FileStore({ dataDir: tmpDir });
    sessionManager = new SessionManager(store);
    service = new TodoService(sessionManager);
    const session = await sessionManager.createSession({ title: 'Todo' });
    sessionId = session.id;
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('добавляет пункт с id и дефолтами', async () => {
    const todos = await service.add(sessionId, { content: 'Шаг' });
    expect(todos).toHaveLength(1);
    expect(todos[0]!.status).toBe('pending');
    expect(todos[0]!.priority).toBe('medium');
    expect(todos[0]!.id).toBeTruthy();
  });

  it('текст длиннее лимита Markdown — TodoLimitExceededError', async () => {
    const long = 'x'.repeat(MARKDOWN_LIMITS.todoContent + 1);
    await expect(service.add(sessionId, { content: long }))
      .rejects.toBeInstanceOf(TodoLimitExceededError);
  });

  it('пустой текст — TodoValidationError', async () => {
    await expect(service.add(sessionId, { content: '   ' }))
      .rejects.toBeInstanceOf(TodoValidationError);
  });

  it('неизвестный пункт — TodoNotFoundError', async () => {
    await expect(service.update(sessionId, 'nope', { content: 'x' }))
      .rejects.toBeInstanceOf(TodoNotFoundError);
    await expect(service.remove(sessionId, 'nope'))
      .rejects.toBeInstanceOf(TodoNotFoundError);
  });

  it('reorder: неизвестные id игнорируются, не названные — в конец', async () => {
    const todos = await service.add(sessionId, [
      { content: 'A' },
      { content: 'B' },
      { content: 'C' },
    ]);
    const [a, b, c] = todos.map((t) => t.id);

    const after = await service.reorder(sessionId, [c!, 'nope', a!]);
    expect(after.map((t) => t.id)).toEqual([c, a, b]);
  });

  it('clear по статусам (по умолчанию — completed и cancelled)', async () => {
    const todos = await service.add(sessionId, [
      { content: 'A', status: 'completed' },
      { content: 'B', status: 'cancelled' },
      { content: 'C', status: 'in_progress' },
    ]);
    const after = await service.clear(sessionId);
    expect(after.map((t) => t.content)).toEqual(['C']);

    const only = await service.clear(sessionId, ['in_progress']);
    expect(only).toHaveLength(0);
    void todos;
  });

  it('update сбрасывает связь с пунктом плана при planItemId=null', async () => {
    const todos = await service.add(sessionId, { content: 'A', planItemId: 'plan-1' });
    const after = await service.update(sessionId, todos[0]!.id, { planItemId: null });
    expect(after[0]!.planItemId).toBeUndefined();
  });
});

/**
 * Этап 2b-1: ToDo-мутации пишутся **точечной мутацией метаданных**
 * (`mutateMeta`), а не полной записью сессии.
 *
 * Паритет с прежним поведением: `updatedAt` не меняется (ToDo не «оживляет»
 * сессию в списках), история не переписывается (параллельный `appendMessage`
 * цел), возвраты — те же массивы пунктов.
 */
describe('TodoService — точечные мутации (этап 2b-1)', () => {
  const OLD_UPDATED_AT = '2020-01-01T00:00:00.000Z';
  let tmpDir: string;
  let sessionManager: SessionManager;
  let service: TodoService;
  let sessionId: string;

  function witnessMessage(): Message {
    return {
      id: generateId(),
      role: MessageRole.USER,
      seq: 0,
      origin: 'local',
      parts: [makeTextPart('tool-результат')],
      content: 'tool-результат',
      createdAt: nowISO(),
      disabled: false,
      pinned: false,
      hidden: false,
    };
  }

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-todo-mutations-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    service = new TodoService(sessionManager);
    const session = await sessionManager.createSession({ title: 'Todo' });
    sessionId = session.id;
    await sessionManager.mutateMeta(sessionId, (meta) => {
      meta.updatedAt = OLD_UPDATED_AT;
    }, { touchUpdatedAt: false });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('add ∥ appendMessage: пункт добавлен, сообщение цело, ToDo-запись не двигает updatedAt', async () => {
    const witness = witnessMessage();
    const [todos, appended] = await Promise.all([
      service.add(sessionId, { content: 'Шаг' }),
      sessionManager.addMessage(sessionId, witness),
    ]);
    expect(todos).toHaveLength(1);
    expect(todos[0]!.content).toBe('Шаг');

    const saved = (await sessionManager.getSession(sessionId))!;
    expect(saved.todos).toHaveLength(1);
    expect(saved.messages.map((m) => m.id)).toContain(witness.id);
    // `updatedAt` принадлежит дозаписи сообщения (паритет: ToDo его не двигает).
    expect(saved.updatedAt).toBe(appended!.updatedAt);
  });

  it('update ∥ appendMessage: сообщение цело, статус обновлён, ToDo-запись не двигает updatedAt', async () => {
    const [a] = await service.add(sessionId, { content: 'A' });
    const witness = witnessMessage();

    const [updated, appended] = await Promise.all([
      service.update(sessionId, a!.id, { status: 'completed' }),
      sessionManager.addMessage(sessionId, witness),
    ]);
    expect(updated.find((t) => t.id === a!.id)!.status).toBe('completed');

    const saved = (await sessionManager.getSession(sessionId))!;
    expect(saved.messages.map((m) => m.id)).toContain(witness.id);
    expect(saved.todos![0]!.status).toBe('completed');
    expect(saved.updatedAt).toBe(appended!.updatedAt);
  });

  it('reorder ∥ appendMessage: сообщение цело, порядок прежний, ToDo-запись не двигает updatedAt', async () => {
    const [a, b, c] = await service.add(sessionId, [
      { content: 'A' },
      { content: 'B' },
      { content: 'C' },
    ]);
    const witness = witnessMessage();

    const [order, appended] = await Promise.all([
      service.reorder(sessionId, [c!.id, a!.id]),
      sessionManager.addMessage(sessionId, witness),
    ]);
    expect(order.map((t) => t.id)).toEqual([c!.id, a!.id, b!.id]);

    const saved = (await sessionManager.getSession(sessionId))!;
    expect(saved.messages.map((m) => m.id)).toContain(witness.id);
    expect(saved.todos!.map((t) => t.id)).toEqual([c!.id, a!.id, b!.id]);
    expect(saved.updatedAt).toBe(appended!.updatedAt);
  });

  it('remove/clear не двигают updatedAt (паритет: раньше saveSession снимка)', async () => {
    const [a, b] = await service.add(sessionId, [
      { content: 'A', status: 'completed' },
      { content: 'B' },
    ]);
    const remaining = await service.remove(sessionId, b!.id);
    expect(remaining.map((t) => t.id)).toEqual([a!.id]);

    const afterClear = await service.clear(sessionId);
    expect(afterClear).toHaveLength(0);

    const saved = (await sessionManager.getSession(sessionId))!;
    expect(saved.todos).toEqual([]);
    expect(saved.updatedAt).toBe(OLD_UPDATED_AT);
  });

  it('list без legacy-id ничего не пишет (updatedAt не меняется)', async () => {
    await service.add(sessionId, { content: 'A' });

    const first = await service.list(sessionId);
    const second = await service.list(sessionId);
    expect(second).toEqual(first);

    const saved = (await sessionManager.getSession(sessionId))!;
    expect(saved.updatedAt).toBe(OLD_UPDATED_AT);
  });

  it('list с legacy-id мигрирует пункты (id появляются) и не двигает updatedAt', async () => {
    // Legacy-пункт без id (так лежали списки до появления id).
    await sessionManager.mutateMeta(sessionId, (meta) => {
      meta.todos = [{ content: 'старый', status: 'pending', priority: 'medium' } as TodoItem];
    }, { touchUpdatedAt: false });

    const listed = await service.list(sessionId);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.id).toBeTruthy();

    const saved = (await sessionManager.getSession(sessionId))!;
    expect(saved.todos![0]!.id).toBe(listed[0]!.id);
    expect(saved.updatedAt).toBe(OLD_UPDATED_AT);
  });

  it('отсутствие сессии — ошибка (паритет с прежним withLock)', async () => {
    await expect(service.add('missing-session', { content: 'A' }))
      .rejects.toThrow(/not found/);
  });
});

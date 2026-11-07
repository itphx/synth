import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MARKDOWN_LIMITS } from '@itphx/synth-shared';
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

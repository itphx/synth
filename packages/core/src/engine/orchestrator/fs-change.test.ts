/**
 * ADR-095 (шаг 6a): собственные тесты публикации `fs.changed`.
 *
 * Модуль — тонкая обвязка над `resolveFsChange` (классификация в
 * `engine/fs-change.ts`), поэтому проверяется контракт **события**: read-only и
 * неуспешные тулы событий не дают, payload несёт ровно те поля, что ожидает UI
 * (scope/op/paths/from/to/workspace_changed, project_id=null без проекта).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { nowISO } from '@itphx/synth-shared';
import type { BusEvent, Session } from '@itphx/synth-shared';
import { EventBus } from '../../events/bus.js';
import { publishFsChange } from './fs-change.js';

function makeSession(projectId?: string): Session {
  return {
    id: 's1',
    ...(projectId ? { projectId } : {}),
    sessionOrigin: 'user',
    messages: [],
    pendingMessages: [],
    status: {},
    settings: {},
    checkpoints: [],
    stickyNotes: [],
    references: [],
    summarizationPending: false,
    canSummarize: false,
    createdAt: nowISO(),
    updatedAt: nowISO(),
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    inputCost: 0,
    outputCost: 0,
    cacheReadCost: 0,
    cacheWriteCost: 0,
  } as unknown as Session;
}

describe('publishFsChange', () => {
  let eventBus: EventBus;
  let events: BusEvent[];
  let unsubscribe: () => void;
  const workingDir = '/ws/project';

  beforeEach(() => {
    eventBus = new EventBus();
    events = [];
    unsubscribe = eventBus.subscribeAll((e) => events.push(e));
  });

  afterEach(() => unsubscribe());

  it('успешный write_file внутри workspace → scope=file с POSIX-путём и op', () => {
    publishFsChange(
      makeSession('p1'), 'write_file',
      { metadata: { path: '/ws/project/sub/hello.txt' } },
      workingDir, eventBus,
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'fs.changed',
      sessionId: 's1',
      data: {
        session_id: 's1',
        project_id: 'p1',
        scope: 'file',
        paths: ['sub/hello.txt'],
        op: 'write',
        tool: 'write_file',
      },
    });
  });

  it('сессия без проекта → project_id=null', () => {
    publishFsChange(
      makeSession(), 'delete_file',
      { metadata: { path: '/ws/project/a.txt' } },
      workingDir, eventBus,
    );
    expect(events[0]!.data.project_id).toBeNull();
    expect(events[0]!.data.op).toBe('delete');
  });

  it('read-only тул событий не даёт', () => {
    publishFsChange(makeSession(), 'read_file', { metadata: { path: '/ws/project/a.txt' } }, workingDir, eventBus);
    publishFsChange(makeSession(), 'grep_files', { metadata: { path: '/ws/project/a.txt' } }, workingDir, eventBus);
    expect(events).toHaveLength(0);
  });

  it('ошибка тула событий не даёт (даже для мутирующего)', () => {
    publishFsChange(
      makeSession(), 'write_file',
      { isError: true, metadata: { path: '/ws/project/a.txt' } },
      workingDir, eventBus,
    );
    expect(events).toHaveLength(0);
  });

  it('путь вне workspace → scope=all без paths', () => {
    publishFsChange(
      makeSession(), 'write_file',
      { metadata: { path: '/etc/passwd' } },
      workingDir, eventBus,
    );
    expect(events[0]!.data.scope).toBe('all');
    expect(events[0]!.data).not.toHaveProperty('paths');
    expect(events[0]!.data).not.toHaveProperty('op');
  });

  it('project_workspace_set → scope=all + workspace_changed', () => {
    publishFsChange(makeSession('p1'), 'project_workspace_set', {}, workingDir, eventBus);
    expect(events[0]!.data).toMatchObject({ scope: 'all', workspace_changed: true, tool: 'project_workspace_set' });
  });

  it('execute_shell с простой `mv` внутри workspace → op=move с from/to', () => {
    publishFsChange(
      makeSession('p1'), 'execute_shell',
      { metadata: {} },
      workingDir, eventBus,
      { command: 'mv old/a.txt new/b.txt' },
    );

    expect(events[0]!.data).toMatchObject({
      scope: 'file',
      op: 'move',
      from: 'old/a.txt',
      to: 'new/b.txt',
      paths: ['old/a.txt', 'new/b.txt'],
    });
  });

  it('execute_shell со сложной командой → scope=all (move не разбирается)', () => {
    publishFsChange(
      makeSession(), 'execute_shell',
      { metadata: {} },
      workingDir, eventBus,
      { command: 'mv a.txt b.txt && echo done' },
    );
    expect(events[0]!.data.scope).toBe('all');
    expect(events[0]!.data).not.toHaveProperty('op');
  });

  it('широкий мутирующий тул (git_commit) → scope=all', () => {
    publishFsChange(makeSession(), 'git_commit', { metadata: {} }, workingDir, eventBus);
    expect(events[0]!.data.scope).toBe('all');
    expect(events[0]!.data).toMatchObject({ tool: 'git_commit' });
  });

  it('неизвестный тул событий не даёт (консервативно)', () => {
    publishFsChange(makeSession(), 'unknown_tool', {}, workingDir, eventBus);
    expect(events).toHaveLength(0);
  });

  it('публикует ровно одно событие на вызов (идемпотентность вызова)', () => {
    for (let i = 0; i < 3; i++) {
      publishFsChange(
        makeSession(), 'create_directory',
        { metadata: { path: '/ws/project/newdir' } },
        workingDir, eventBus,
      );
    }
    expect(events).toHaveLength(3);
    expect(events.every((e) => e.data.op === 'mkdir')).toBe(true);
  });
});

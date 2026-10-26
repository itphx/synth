/**
 * Тесты публикации события `worktree.updated` (ADR-114 §6, этап 1 roadmap
 * 0.13 — блок 1.4.2b).
 *
 * Событие идёт в **каналы всех сессий проекта** (инвентарь worktree'ов —
 * ресурс проекта, а не одной сессии) + `fs.changed { scope: 'all' }`
 * (структура каталогов на диске изменилась). Payload — `{ project_id,
 * worktree_id?, action }`: по `action` UI отличает создание от удаления и
 * привязки, не читая инвентарь.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Session } from '@itphx/synth-shared';
import { publishWorktreeUpdated, WORKTREE_EVENT_MAX_SESSIONS } from './events.js';
import type { WorktreeEventDeps, WorktreeEventSessionSource } from './events.js';

/** Мок шины: видно, что и в какой канал опубликовано. */
function makeBus() {
  const published: Array<{ sessionId: string; type: string; data: Record<string, unknown> }> = [];
  const eventBus = {
    publish(sessionId: string, type: string, data: Record<string, unknown> = {}) {
      published.push({ sessionId, type, data });
    },
  } as unknown as WorktreeEventDeps['eventBus'];
  return { eventBus, published };
}

/** Фейковая сессия (нужны только id). */
function fakeSession(id: string): Session {
  return { id } as unknown as Session;
}

/** Источник сессий: отдаёт заранее заданный список. */
function makeSource(sessions: Session[]): WorktreeEventSessionSource {
  return {
    listSessions: vi.fn().mockResolvedValue(sessions),
  };
}

describe('publishWorktreeUpdated (ADR-114 §6)', () => {
  it('публикует worktree.updated {project_id, action} и fs.changed {scope:"all"} в каналы сессий проекта', async () => {
    const { eventBus, published } = makeBus();
    const deps: WorktreeEventDeps = {
      eventBus,
      sessionStore: makeSource([fakeSession('s1'), fakeSession('s2')]),
    };

    await publishWorktreeUpdated(deps, { projectId: 'prj-1', action: 'created' });

    expect(published).toHaveLength(4);
    expect(published.filter((p) => p.type === 'worktree.updated')).toHaveLength(2);
    expect(published.filter((p) => p.type === 'fs.changed')).toHaveLength(2);

    const updated = published.find((p) => p.type === 'worktree.updated')!;
    expect(updated.sessionId).toBe('s1');
    expect(updated.data).toEqual({ project_id: 'prj-1', action: 'created' });

    const fsChanged = published.find((p) => p.type === 'fs.changed')!;
    expect(fsChanged.sessionId).toBe('s1');
    expect(fsChanged.data).toEqual({ scope: 'all' });

    // Каждая сессия проекта получила оба события.
    expect(published.filter((p) => p.sessionId === 's2')).toHaveLength(2);
  });

  it('payload несёт id записи и действие (UI отличает создание от привязки)', async () => {
    const { eventBus, published } = makeBus();
    const deps: WorktreeEventDeps = {
      eventBus,
      sessionStore: makeSource([fakeSession('s1')]),
    };

    await publishWorktreeUpdated(deps, {
      projectId: 'prj-1',
      worktreeId: 'wkt_abc',
      action: 'attached',
    });

    const updated = published.find((p) => p.type === 'worktree.updated')!;
    expect(updated.data).toEqual({
      project_id: 'prj-1',
      worktree_id: 'wkt_abc',
      action: 'attached',
    });
  });

  it('источник сессий запрашивается по id проекта', async () => {
    const { eventBus } = makeBus();
    const sessionStore = makeSource([]);
    await publishWorktreeUpdated({ eventBus, sessionStore }, { projectId: 'prj-42', action: 'pruned' });
    expect(sessionStore.listSessions).toHaveBeenCalledWith({ projectId: 'prj-42' });
  });

  it('проект без сессий — ни одного вызова, без ошибок', async () => {
    const { eventBus, published } = makeBus();

    await expect(
      publishWorktreeUpdated(
        { eventBus, sessionStore: makeSource([]) },
        { projectId: 'prj-1', action: 'removed' },
      ),
    ).resolves.toBeUndefined();
    expect(published).toHaveLength(0);
  });

  it('ошибка чтения сессий не ломает операцию (событие — побочный сигнал)', async () => {
    const { eventBus, published } = makeBus();
    const sessionStore: WorktreeEventSessionSource = {
      listSessions: vi.fn().mockRejectedValue(new Error('store unavailable')),
    };

    await expect(
      publishWorktreeUpdated(
        { eventBus, sessionStore },
        { projectId: 'prj-1', action: 'removed' },
      ),
    ).resolves.toBeUndefined();
    expect(published).toHaveLength(0);
  });

  it('лимит сессий: не больше WORKTREE_EVENT_MAX_SESSIONS (200)', async () => {
    const { eventBus, published } = makeBus();
    const sessions = Array.from({ length: WORKTREE_EVENT_MAX_SESSIONS + 50 }, (_, i) =>
      fakeSession(`s${i}`),
    );

    await publishWorktreeUpdated(
      { eventBus, sessionStore: makeSource(sessions) },
      { projectId: 'prj-1', action: 'created' },
    );

    const channels = new Set(published.map((p) => p.sessionId));
    expect(channels.size).toBe(WORKTREE_EVENT_MAX_SESSIONS);
    // На каждый канал — ровно два события.
    expect(published).toHaveLength(WORKTREE_EVENT_MAX_SESSIONS * 2);
  });
});

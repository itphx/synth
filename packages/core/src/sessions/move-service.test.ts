/**
 * PROP-141 (Часть D): единая модель переноса сессии между проектами.
 *
 * Тесты на фейках: порядок эффектов, fail-closed при ошибке останова, перенос
 * поддерева, переатрибуция завершённых записей, отмена автоматизаций, снятие
 * worktree и блокировка активного хода.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BackgroundRunRecord, Message, Schedule, Timer } from '@itphx/synth-shared';
import { generateId, makeTextPart, MessageRole, nowISO } from '@itphx/synth-shared';
import { SessionManager } from './manager.js';
import { FileStore } from '../storage/file-store.js';
import {
  SessionMoveError,
  SessionMoveService,
  hasAttachedStateBlockers,
  summarizeAttachedState,
} from './move-service.js';
import type { BackgroundRunRepository } from '../storage/ports/background-run-repository.js';
import type { TimerRepository } from '../storage/ports/timer-repository.js';
import type { EventBus } from '../events/bus.js';

/** Запись фонового прогона (упрощённая). */
function run(
  id: string,
  overrides: Partial<BackgroundRunRecord> = {},
): BackgroundRunRecord {
  return {
    id,
    kind: 'process',
    status: 'running',
    sessionId: 's1',
    startedAt: '2026-11-17T00:00:00.000Z',
    updatedAt: '2026-11-17T00:00:00.000Z',
    ...overrides,
  };
}

/** Запись таймера/будильника (упрощённая). */
function timer(id: string, overrides: Partial<Timer> = {}): Timer {
  return {
    id,
    kind: 'timer',
    comment: 'через 15 минут',
    projectId: 'p1',
    sessionId: 's1',
    ownerId: 'local',
    repeat: { mode: 'once' },
    status: 'active',
    firesAt: '2026-11-17T00:15:00.000Z',
    createdAt: '2026-11-17T00:00:00.000Z',
    updatedAt: '2026-11-17T00:00:00.000Z',
    ...overrides,
  };
}

/** Расписание (упрощённое). */
function schedule(id: string, overrides: Partial<Schedule> = {}): Schedule {
  return {
    id,
    name: id,
    enabled: true,
    projectId: 'p1',
    ownerId: 'local',
    target: { mode: 'bound', sessionId: 's1' },
    createdAt: '2026-11-17T00:00:00.000Z',
    updatedAt: '2026-11-17T00:00:00.000Z',
    ...overrides,
  } as Schedule;
}

/** Реестр фоновых прогонов в памяти (порт). */
class FakeBackgroundRuns implements BackgroundRunRepository {
  records = new Map<string, BackgroundRunRecord>();
  async save(record: BackgroundRunRecord): Promise<void> {
    this.records.set(record.id, { ...record });
  }
  async get(id: string): Promise<BackgroundRunRecord | null> {
    return this.records.get(id) ?? null;
  }
  async list(filter?: Parameters<BackgroundRunRepository['list']>[0]): Promise<BackgroundRunRecord[]> {
    let items = [...this.records.values()];
    if (filter?.kind) items = items.filter((r) => r.kind === filter.kind);
    if (filter?.status) items = items.filter((r) => r.status === filter.status);
    if (filter?.sessionId) items = items.filter((r) => r.sessionId === filter.sessionId);
    if (filter?.projectId) items = items.filter((r) => r.projectId === filter.projectId);
    return items;
  }
  async remove(id: string): Promise<boolean> {
    return this.records.delete(id);
  }
  async prune(): Promise<number> {
    return 0;
  }
}

/** Реестр таймеров в памяти (порт). */
class FakeTimers implements TimerRepository {
  records = new Map<string, Timer>();
  async list(filter?: Parameters<TimerRepository['list']>[0]): Promise<Timer[]> {
    let items = [...this.records.values()];
    if (filter?.sessionId) items = items.filter((t) => t.sessionId === filter.sessionId);
    if (filter?.projectId) items = items.filter((t) => t.projectId === filter.projectId);
    if (filter?.status) items = items.filter((t) => t.status === filter.status);
    if (filter?.kind) items = items.filter((t) => t.kind === filter.kind);
    return items;
  }
  async get(id: string): Promise<Timer | null> {
    return this.records.get(id) ?? null;
  }
  async create(): Promise<Timer> {
    throw new Error('не используется');
  }
  async update(id: string, patch: Partial<Timer>): Promise<Timer | null> {
    const current = this.records.get(id);
    if (!current) return null;
    const next = { ...current, ...patch } as Timer;
    this.records.set(id, next);
    return next;
  }
  async remove(id: string): Promise<boolean> {
    return this.records.delete(id);
  }
  async listDue(): Promise<Timer[]> {
    return [];
  }
  async countActive(sessionId: string): Promise<number> {
    return (await this.list({ sessionId, status: 'active' })).length;
  }
  async setStatus(id: string, status: Timer['status']): Promise<Timer | null> {
    return this.update(id, { status });
  }
  async removeBySession(sessionId: string): Promise<number> {
    let removed = 0;
    for (const [id, t] of this.records) {
      if (t.sessionId !== sessionId) continue;
      this.records.delete(id);
      removed += 1;
    }
    return removed;
  }
}

describe('SessionMoveService (PROP-141, Часть D)', () => {
  let tmpDir: string;
  let manager: SessionManager;
  let runs: FakeBackgroundRuns;
  let timers: FakeTimers;
  let schedules: Schedule[];
  let stopProcess: ReturnType<typeof vi.fn>;
  let stopSubagent: ReturnType<typeof vi.fn>;
  let closeTerminal: ReturnType<typeof vi.fn>;
  let cancelTimers: ReturnType<typeof vi.fn>;
  let publish: ReturnType<typeof vi.fn>;
  let appendAudit: ReturnType<typeof vi.fn>;
  let turnActive: boolean;
  let service: SessionMoveService;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-move-'));
    manager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    runs = new FakeBackgroundRuns();
    timers = new FakeTimers();
    schedules = [];
    stopProcess = vi.fn(async () => true);
    stopSubagent = vi.fn(async () => true);
    closeTerminal = vi.fn(async () => undefined);
    cancelTimers = vi.fn(async () => 1);
    publish = vi.fn();
    appendAudit = vi.fn(async () => undefined);
    turnActive = false;
    terminals = [];

    service = new SessionMoveService({
      sessionManager: manager,
      backgroundRuns: runs,
      backgroundService: { stop: stopSubagent } as never,
      processService: { stop: stopProcess } as never,
      terminalService: {
        list: (filter: { sessionId?: string; includeExited?: boolean }) =>
          (terminals
            .filter((t) => !filter?.sessionId || t.sessionId === filter.sessionId)
            .filter((t) => filter?.includeExited !== false || t.status !== 'exited') as never),
        close: closeTerminal,
      } as never,
      timerService: { cancelForSessions: cancelTimers } as never,
      timers,
      scheduleStore: {
        list: async () => schedules,
        update: async (id: string, patch: Partial<Schedule>) => {
          const index = schedules.findIndex((s) => s.id === id);
          if (index === -1) return null;
          const next = { ...schedules[index]!, ...patch } as Schedule;
          schedules[index] = next;
          return next;
        },
      },
      isTurnActive: async () => turnActive,
      eventBus: { publish } as unknown as EventBus,
      audit: { append: appendAudit } as never,
    });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  /** Живые терминалы сессии (фейк сервиса терминалов). */
  let terminals: Array<{
    id: string;
    sessionId?: string;
    projectId?: string;
    status: string;
    title?: string;
  }> = [];

  /** Создать сессию с проектом. */
  async function makeSession(projectId: string | undefined, title = 'S'): Promise<string> {
    const session = await manager.createSession({ title, userId: 'u1' });
    if (projectId !== undefined) {
      await manager.withLock(session.id, async (s) => {
        s.projectId = projectId;
        await manager.updateSession(s);
      });
    }
    return session.id;
  }

  it('preview считает все классы привязанного состояния', async () => {
    const sessionId = await makeSession('p1');
    terminals = [
      { id: 'term1', sessionId, status: 'running', title: 'shell' },
      { id: 'term2', sessionId, status: 'exited' },
    ];
    await runs.save(run('bgr1', { kind: 'process', status: 'running', sessionId }));
    await runs.save(run('bgr2', { kind: 'subagent', status: 'running', sessionId, childSessionId: 'child1' }));
    await runs.save(run('bgr3', { kind: 'process', status: 'completed', sessionId }));
    timers.records.set('tmr1', timer('tmr1', { sessionId }));
    timers.records.set('tmr2', timer('tmr2', { kind: 'alarm', sessionId }));
    timers.records.set('tmr3', timer('tmr3', { status: 'fired', sessionId }));
    schedules = [
      schedule('sch1', { target: { mode: 'bound', sessionId } }),
      schedule('sch2', { enabled: false, target: { mode: 'bound', sessionId } }),
      schedule('sch3', { target: { mode: 'pipeline', projectId: 'p1', pipelineId: 'pl1' } } as never),
    ];
    await manager.withLock(sessionId, async (s) => {
      s.worktree = {
        worktreeId: 'wkt1',
        projectId: 'p1',
        directory: '/tmp/wt',
        branch: 'feature',
      };
      await manager.updateSession(s);
    });

    const state = await service.preview(sessionId);
    expect(state.active_turn).toBe(false);
    expect(state.processes.count).toBe(1);
    expect(state.subagents.count).toBe(1);
    expect(state.terminals.count).toBe(1);
    expect(state.timers.count).toBe(1);
    expect(state.alarms.count).toBe(1);
    expect(state.schedules.count).toBe(1);
    expect(state.worktree.count).toBe(1);
    expect(state.worktree.items[0]?.id).toBe('wkt1');
    expect(hasAttachedStateBlockers(state)).toBe(true);
    expect(summarizeAttachedState(state)).toContain('процессы: 1');
  });

  it('активный ход блокирует перенос даже с согласием', async () => {
    const sessionId = await makeSession('p1');
    turnActive = true;
    await expect(
      service.move({ sessionId, targetProjectId: 'p2', consent: { stop_running: true, cancel_automations: true } }),
    ).rejects.toMatchObject({ code: 'SESSION_HAS_ATTACHED_STATE', status: 409 });
    const session = await manager.getSession(sessionId);
    expect(session?.projectId).toBe('p1');
  });

  it('без согласия при блокерах — 409 с деталями (counts + компактный список)', async () => {
    const sessionId = await makeSession('p1');
    await runs.save(run('bgr1', { kind: 'process', status: 'running', sessionId, command: 'npm run dev' }));

    let error: SessionMoveError | undefined;
    try {
      await service.move({ sessionId, targetProjectId: 'p2' });
    } catch (err) {
      error = err as SessionMoveError;
    }
    expect(error?.code).toBe('SESSION_HAS_ATTACHED_STATE');
    expect(error?.status).toBe(409);
    const details = error?.details as {
      active_turn: boolean;
      processes: { count: number; items: Array<{ id: string; kind: string; name?: string }> };
    };
    expect(details.active_turn).toBe(false);
    expect(details.processes.count).toBe(1);
    expect(details.processes.items[0]).toMatchObject({ id: 'bgr1', kind: 'process' });
    const session = await manager.getSession(sessionId);
    expect(session?.projectId).toBe('p1');
  });

  it('порядок эффектов: stop processes → stop subagents → close terminals', async () => {
    const sessionId = await makeSession('p1');
    terminals = [{ id: 'term1', sessionId, status: 'running' }];
    await runs.save(run('bgr1', { kind: 'process', status: 'running', sessionId }));
    await runs.save(run('bgr2', { kind: 'subagent', status: 'running', sessionId, childSessionId: 'child1' }));

    const order: string[] = [];
    stopProcess.mockImplementation(async () => { order.push('process'); return true; });
    stopSubagent.mockImplementation(async () => { order.push('subagent'); return true; });
    closeTerminal.mockImplementation(async () => { order.push('terminal'); });

    const result = await service.move({
      sessionId,
      targetProjectId: 'p2',
      consent: { stop_running: true },
    });

    expect(order).toEqual(['process', 'subagent', 'terminal']);
    expect(result.effects.map((e) => `${e.kind}:${e.action}`)).toEqual([
      'process:stopped',
      'subagent:stopped',
      'terminal:closed',
      'session:moved',
    ]);
  });

  it('fail-closed: неудача останова — перенос не выполняется', async () => {
    const sessionId = await makeSession('p1');
    await runs.save(run('bgr1', { kind: 'process', status: 'running', sessionId }));
    stopProcess.mockImplementation(async () => { throw new Error('не от-stop-ился'); });

    await expect(
      service.move({ sessionId, targetProjectId: 'p2', consent: { stop_running: true } }),
    ).rejects.toMatchObject({ code: 'SESSION_MOVE_STOP_FAILED', status: 409 });

    const session = await manager.getSession(sessionId);
    expect(session?.projectId).toBe('p1');
    expect(publish).not.toHaveBeenCalled();
  });

  it('переносится поддерево сессий (включая завершённые), чужие проекты не трогаются', async () => {
    const rootId = await makeSession('p1', 'root');
    const child = await manager.createSession({ title: 'child', userId: 'u1', parentId: rootId });
    const grandChild = await manager.createSession({ title: 'gc', userId: 'u1', parentId: child.id });
    const foreign = await manager.createSession({ title: 'foreign', userId: 'u1', parentId: rootId });
    for (const [id, projectId] of [[child.id, 'p1'], [grandChild.id, 'p1'], [foreign.id, 'p9']] as const) {
      await manager.withLock(id, async (s) => {
        s.projectId = projectId;
        await manager.updateSession(s);
      });
    }

    // Свидетели истории + метки времени «до переноса».
    const witness = (content: string): Message => ({
      id: generateId(),
      role: MessageRole.USER,
      seq: 0,
      origin: 'local',
      parts: [makeTextPart(content)],
      content,
      createdAt: nowISO(),
      disabled: false,
      pinned: false,
      hidden: false,
    });
    await manager.addMessage(rootId, witness('root-свидетель'));
    await manager.addMessage(child.id, witness('child-свидетель'));
    const stamps = new Map<string, string>();
    for (const id of [rootId, child.id, grandChild.id, foreign.id]) {
      stamps.set(id, (await manager.getSession(id))!.updatedAt);
    }

    const result = await service.move({ sessionId: rootId, targetProjectId: 'p2' });

    expect(result.moved.sort()).toEqual([rootId, child.id, grandChild.id].sort());
    expect((await manager.getSession(rootId))?.projectId).toBe('p2');
    expect((await manager.getSession(child.id))?.projectId).toBe('p2');
    expect((await manager.getSession(grandChild.id))?.projectId).toBe('p2');
    // Потомок в другом проекте не тронут.
    expect((await manager.getSession(foreign.id))?.projectId).toBe('p9');
    // Паритет `updateSession`: перенос двигает `updatedAt` перенесённых сессий.
    for (const id of [rootId, child.id, grandChild.id]) {
      expect((await manager.getSession(id))!.updatedAt).not.toBe(stamps.get(id));
    }
    // Ребёнок с уже изменённым проектом не пишется (shouldWrite): время стоит.
    expect((await manager.getSession(foreign.id))!.updatedAt).toBe(stamps.get(foreign.id));
    // История цела: свидетели на месте, полной перезаписи нет.
    expect((await manager.getSession(rootId))!.messages.some((m) => m.content === 'root-свидетель')).toBe(true);
    expect((await manager.getSession(child.id))!.messages.some((m) => m.content === 'child-свидетель')).toBe(true);
  });

  it('завершённые прогоны переатрибутируются на новый проект', async () => {
    const sessionId = await makeSession('p1');
    await runs.save(run('bgr_done', { kind: 'process', status: 'completed', sessionId, projectId: 'p1' }));
    await runs.save(run('bgr_other', { kind: 'process', status: 'completed', sessionId, projectId: 'p9' }));

    await service.move({ sessionId, targetProjectId: 'p2' });

    expect((await runs.get('bgr_done'))?.projectId).toBe('p2');
    expect((await runs.get('bgr_other'))?.projectId).toBe('p9');
  });

  it('таймеры/будильники отменяются, расписания отключаются', async () => {
    const sessionId = await makeSession('p1');
    timers.records.set('tmr1', timer('tmr1', { sessionId }));
    timers.records.set('tmr2', timer('tmr2', { kind: 'alarm', sessionId }));
    schedules = [schedule('sch1', { target: { mode: 'bound', sessionId } })];

    const result = await service.move({
      sessionId,
      targetProjectId: 'p2',
      consent: { cancel_automations: true },
    });

    expect(cancelTimers).toHaveBeenCalledWith([sessionId]);
    expect(schedules[0]?.enabled).toBe(false);
    expect(result.effects.map((e) => `${e.kind}:${e.action}`)).toEqual([
      'timer:cancelled',
      'alarm:cancelled',
      'schedule:disabled',
      'session:moved',
    ]);
  });

  it('worktree снимается, а effects содержат все действия', async () => {
    const sessionId = await makeSession('p1');
    await manager.withLock(sessionId, async (s) => {
      s.worktree = {
        worktreeId: 'wkt1',
        projectId: 'p1',
        directory: '/tmp/wt',
        branch: 'feature',
      };
      await manager.updateSession(s);
    });

    const result = await service.move({ sessionId, targetProjectId: 'p2' });

    expect((await manager.getSession(sessionId))?.worktree).toBeUndefined();
    expect(result.effects.some((e) => e.kind === 'worktree' && e.action === 'detached')).toBe(true);
    expect(result.effects.some((e) => e.kind === 'session' && e.action === 'moved')).toBe(true);
  });

  it('session.moved публикуется по одному на перенесённую сессию и несёт effects', async () => {
    const rootId = await makeSession('p1', 'root');
    const child = await manager.createSession({ title: 'child', userId: 'u1', parentId: rootId });
    await manager.withLock(child.id, async (s) => {
      s.projectId = 'p1';
      await manager.updateSession(s);
    });

    await service.move({ sessionId: rootId, targetProjectId: 'p2' });

    const moved = publish.mock.calls.filter((call) => call[1] === 'session.moved');
    expect(moved).toHaveLength(2);
    const payload = moved[0]![2] as { effects: unknown[]; project_id: string };
    expect(payload.project_id).toBe('p2');
    expect(Array.isArray(payload.effects)).toBe(true);
    expect(payload.effects.length).toBeGreaterThan(0);
  });

  it('аудит переноса пишется со scope=session и action=move', async () => {
    const sessionId = await makeSession('p1');
    await service.move({ sessionId, targetProjectId: 'p2', actor: 'user-1' });
    expect(appendAudit).toHaveBeenCalledTimes(1);
    const entry = appendAudit.mock.calls[0]![0] as { scope: string; action: string; actor: string };
    expect(entry.scope).toBe('session');
    expect(entry.action).toBe('move');
    expect(entry.actor).toBe('user-1');
  });

  it('завершённые терминалы остаются в старом проекте — отклонение в effects', async () => {
    const sessionId = await makeSession('p1');
    terminals = [{ id: 'term_done', sessionId, projectId: 'p1', status: 'exited', title: 'old shell' }];

    const result = await service.move({ sessionId, targetProjectId: 'p2' });

    const deviation = result.effects.find(
      (e) => e.kind === 'terminal' && e.action === 'left_in_old_project',
    );
    expect(deviation?.id).toBe('term_done');
    // У терминалов нет безопасного способа сменить проект — запись остаётся.
    expect(deviation?.action).toBe('left_in_old_project');
  });

  it('удалённая сессия (remote:) не переносится', async () => {
    await expect(
      service.move({ sessionId: 'remote:abc', targetProjectId: 'p2' }),
    ).rejects.toMatchObject({ code: 'SESSION_MOVE_REMOTE_UNSUPPORTED', status: 409 });
  });

  it('сессия без проекта переносится в проект', async () => {
    const sessionId = await makeSession(undefined);
    const result = await service.move({ sessionId, targetProjectId: 'p2' });
    expect(result.moved).toEqual([sessionId]);
    expect((await manager.getSession(sessionId))?.projectId).toBe('p2');
  });

  it('после переноса — ровно одно служебное сообщение session_moved в корневой сессии', async () => {
    const rootId = await makeSession('p1', 'root');
    const child = await manager.createSession({ title: 'child', userId: 'u1', parentId: rootId });
    await manager.withLock(child.id, async (s) => {
      s.projectId = 'p1';
      await manager.updateSession(s);
    });
    await runs.save(run('bgr1', { kind: 'process', status: 'running', sessionId: rootId }));

    const result = await service.move({
      sessionId: rootId,
      targetProjectId: 'p2',
      consent: { stop_running: true },
    });

    const root = await manager.getSession(rootId);
    const notices = root?.messages.filter((m) => m.metadata?.type === 'session_moved') ?? [];
    expect(notices).toHaveLength(1);
    // В истории корня это единственное сообщение (уведомление — не реплика).
    expect(root?.messages).toHaveLength(1);

    const notice = notices[0]!;
    expect(notice.role).toBe(MessageRole.USER);
    expect(notice.author).toBe('Session');
    expect(notice.metadata?.type).toBe('session_moved');
    expect(notice.metadata?.from_project_id).toBe('p1');
    expect(notice.metadata?.to_project_id).toBe('p2');
    expect(notice.metadata?.moved_sessions).toEqual(result.moved);
    const noticeEffects = notice.metadata?.effects as Array<{ kind: string; action: string; id: string }>;
    expect(noticeEffects).toHaveLength(result.effects.length);
    expect(noticeEffects[0]).toMatchObject({ kind: 'process', action: 'stopped', id: 'bgr1' });

    // Конверт: факты без пользовательского текста.
    expect(notice.content).toContain('<session_moved from="p1" to="p2">');
    expect(notice.content).toContain('process.stopped bgr1');
    expect(notice.content).toContain('</session_moved>');

    // В дочернюю сессию поддерева уведомление не пишется.
    const childSession = await manager.getSession(child.id);
    expect(childSession?.messages.filter((m) => m.metadata?.type === 'session_moved')).toHaveLength(0);

    // Ход не запускался: ни очереди, ни событий хода/приёма.
    expect(root?.pendingMessages).toHaveLength(0);
    const types = publish.mock.calls.map((call) => call[1]);
    expect(types).not.toContain('turn.started');
    expect(types).not.toContain('message.accepted');
    expect(types).not.toContain('message.enqueued');
    expect(types).toContain('message.added');
    const added = publish.mock.calls.filter((call) => call[1] === 'message.added');
    expect(added).toHaveLength(1);
    expect(added[0]![0]).toBe(rootId);
  });
});

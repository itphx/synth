/**
 * Сессии инстанса из чата: `synth_sessions_active`, `synth_session_stop`,
 * `synth_session_resume`.
 *
 * Покрытие — паритет с HTTP-поверхностями (`GET /api/v2/sessions`,
 * `POST /:id/abort`, `POST /:id/resume-subagent`):
 * - снимок считает `working/idle/total`, фильтрует по `include_idle`/`project_id`,
 *   обрезается на 50 записях, отдаёт `session.active.empty` на пустом снимке и
 *   **не падает** при сбое одного реестра счётчиков;
 * - «Стоп» идёт единой семантикой `sessions/turn-abort.ts` через прокладку
 *   `extra.sessionControl.abortTurn`: владелец и ADMIN проходят, чужая сессия
 *   получает `session.forbidden` **без** вызова `abortTurn`, «нечего
 *   останавливать» — не ошибка;
 * - возобновление: обычная сессия — служебное сообщение `resume_notice` в
 *   очередь (`enqueueContinuation`), сабагент — цикл саб-агента
 *   (`resumeSubagent`), сессия не создаётся;
 * - plan-режим: write-имена блокирует permission-слой (`isPlanBlockedTool`),
 *   снимок остаётся доступен (ADR-025/ADR-029).
 *
 * Зависимости — fake-прокладки (как в `instance-maintenance.test.ts`): никаких
 * реальных сервисов и никакого `node:fs`.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  MessageRole,
  ToolCapability,
  type Message,
  type Session,
  type ToolContext,
} from '@itphx/synth-shared';
import {
  synthSessionsActiveTool,
  synthSessionStopTool,
  synthSessionResumeTool,
  type SessionControlDeps,
} from './instance-sessions.js';
import { ALL_BUILTIN_TOOLS } from './index.js';
import { SESSIONS_READ_TOOLS, SESSIONS_TOOLS, SESSIONS_WRITE_TOOLS } from '../permission/groups.js';
import { PermissionEvaluator, isPlanBlockedTool } from '../permission/evaluator.js';
import { SubagentResumeError } from './task/resume-target.js';
import type { AbortSessionTurnResult } from '../../sessions/turn-abort.js';
import type { SessionManager } from '../../sessions/manager.js';
import type { ProjectStoreContract } from '../../storage/project-store.js';
import type { InstanceRuntimeMeta } from '../instance/meta.js';
import type { ToolPrincipal } from './project-resolve.js';
import { LOCAL_USER_ID } from '../../server/local-owner.js';

const STANDALONE_META = { mode: 'standalone' } as unknown as InstanceRuntimeMeta;

/** Предел снимка (`MAX_SNAPSHOT_SESSIONS` в `instance-sessions.ts`). */
const SNAPSHOT_CAP = 50;

interface SessionOverrides {
  id?: string;
  title?: string;
  projectId?: string;
  agentRole?: string;
  ownerId?: string;
  parentId?: string;
  /** Активный стрим хода (`currentStream`) — признак «работает». */
  streaming?: boolean;
  /** Сколько сообщений в очереди (`pendingMessages`) — тоже признак работы. */
  pending?: number;
  updatedAt?: string;
}

const T0 = '2026-01-01T00:00:00.000Z';

function queueMessage(id: string): Message {
  return {
    id,
    role: MessageRole.USER,
    seq: 0,
    origin: 'local',
    parts: [],
    content: 'queued',
    createdAt: T0,
    disabled: false,
    pinned: false,
    hidden: false,
  } as unknown as Message;
}

/** Сессия-минимум: только поля, которые читают тулы сессий. */
function makeSession(over: SessionOverrides = {}): Session {
  const id = over.id ?? 's1';
  const pendingMessages = Array.from(
    { length: over.pending ?? 0 },
    (_, index) => queueMessage(`${id}-p${index}`),
  );
  return {
    id,
    title: over.title,
    sessionOrigin: over.parentId ? 'subagent' : 'user',
    parentId: over.parentId,
    projectId: over.projectId,
    ownerId: over.ownerId,
    messages: [],
    pendingMessages,
    status: {},
    settings: over.agentRole ? { agentRole: over.agentRole } : {},
    checkpoints: [],
    stickyNotes: [],
    references: [],
    summarizationPending: false,
    canSummarize: false,
    createdAt: T0,
    updatedAt: over.updatedAt ?? T0,
    currentStream: over.streaming
      ? { streamId: `st_${id}`, turnId: `turn_${id}` }
      : undefined,
  } as unknown as Session;
}

/** Итог «Стоп» по умолчанию: что-то шло и живой процессор остановлен. */
function abortResult(sessionId: string, over: Partial<AbortSessionTurnResult> = {}): AbortSessionTurnResult {
  return {
    sessionId,
    wasRunning: true,
    processorStopped: true,
    queueStopped: false,
    pending: 0,
    ...over,
  };
}

interface FakeControl {
  deps: SessionControlDeps;
  abortTurn: ReturnType<typeof vi.fn>;
  resumeSubagent: ReturnType<typeof vi.fn>;
  enqueueContinuation: ReturnType<typeof vi.fn>;
}

/**
 * Прокладка управления сессиями. По умолчанию все зависимости заданы и
 * «успешны»; точечные сценарии переопределяют нужную функцию.
 */
function makeControl(over: Partial<SessionControlDeps> = {}): FakeControl {
  const abortTurn = vi.fn(async (sessionId: string) => abortResult(sessionId));
  const resumeSubagent = vi.fn(async (sessionId: string) => ({
    child_session_id: sessionId,
    parent_session_id: 'parent-1',
    stream_id: 'st_child',
  }));
  const enqueueContinuation = vi.fn(async () => true);
  const deps: SessionControlDeps = {
    abortTurn: abortTurn as unknown as SessionControlDeps['abortTurn'],
    resumeSubagent: resumeSubagent as unknown as SessionControlDeps['resumeSubagent'],
    enqueueContinuation: enqueueContinuation as unknown as SessionControlDeps['enqueueContinuation'],
    ...over,
  };
  return { deps, abortTurn, resumeSubagent, enqueueContinuation };
}

interface CtxOptions {
  sessions?: Session[];
  control?: SessionControlDeps;
  /** `null` — принципала нет вовсе (fail-closed). */
  principal?: ToolPrincipal | null;
  instanceMeta?: InstanceRuntimeMeta;
  /** Проекты, видимые не-elevated вызывающему (фейковый порт). */
  projects?: Array<{ id: string; name: string }>;
  /** `false` — прокладки `extra.sessionControl` нет (тул обязан отдать ошибку). */
  withDeps?: boolean;
  /**
   * Сессия разговора (`extra.sessionId`) — фоллбек идентичности, когда
   * принципала нет: `resolveViewer` берёт владельца именно этой сессии.
   */
  currentSessionId?: string;
}

interface FakeCtx {
  ctx: ToolContext;
  listSessions: ReturnType<typeof vi.fn>;
  getSession: ReturnType<typeof vi.fn>;
  createSession: ReturnType<typeof vi.fn>;
  addSession: ReturnType<typeof vi.fn>;
}

function makeCtx(opts: CtxOptions = {}): FakeCtx {
  const sessions = opts.sessions ?? [];
  const principal = opts.principal === undefined
    ? ({ userId: 'u1', roles: ['ADMIN'] } as ToolPrincipal)
    : opts.principal;
  const listSessions = vi.fn(async (filter?: { userId?: string; projectIds?: string[] }) => {
    if (!filter?.userId) return sessions;
    if (filter.projectIds) {
      return sessions.filter((session) => (session.projectId ?? '') !== ''
        && filter.projectIds!.includes(session.projectId!));
    }
    return sessions.filter((session) => (session.ownerId ?? session.userId) === filter.userId);
  });
  const getSession = vi.fn(async (id: string) => sessions.find((session) => session.id === id) ?? null);
  const createSession = vi.fn(async () => makeSession({ id: 'created' }));
  const addSession = vi.fn(async () => makeSession({ id: 'created' }));

  const sessionManager = {
    listSessions,
    getSession,
    createSession,
    addSession,
  } as unknown as SessionManager;

  const projectStore = opts.projects
    ? ({
      list: vi.fn(async () => opts.projects),
      load: vi.fn(async (id: string) => opts.projects!.find((project) => project.id === id) ?? null),
    } as unknown as ProjectStoreContract)
    : undefined;

  const control = opts.withDeps === false
    ? undefined
    : opts.control ?? makeControl().deps;

  const currentSessionId = opts.currentSessionId ?? 's1';
  const ctx = {
    sessionId: currentSessionId,
    messageId: 'm1',
    abortSignal: new AbortController().signal,
    workingDir: '/work',
    dataDir: '/data',
    extra: {
      instanceMeta: opts.instanceMeta ?? STANDALONE_META,
      ...(principal ? { principal } : {}),
      sessionId: currentSessionId,
      sessionManager,
      ...(projectStore ? { projectStore } : {}),
      ...(control ? { sessionControl: control } : {}),
    },
  } as unknown as ToolContext;

  return { ctx, listSessions, getSession, createSession, addSession };
}

/** Ключ i18n из результата тула (все тексты — через `system-messages`). */
function i18nKey(result: { metadata?: Record<string, unknown> }): string | undefined {
  return (result.metadata?.i18n as { key?: string } | undefined)?.key;
}

interface SnapshotRow {
  session_id: string;
  streaming: boolean;
  pending: number;
  background_runs: number;
  terminals: number;
  approvals: number;
  project_id: string | null;
}

function rows(result: { metadata?: Record<string, unknown> }): SnapshotRow[] {
  return (result.metadata?.sessions ?? []) as SnapshotRow[];
}

// ─────────────────────────── регистрация и группы ────────────────────────────

describe('регистрация и группы', () => {
  const TOOLS = [synthSessionsActiveTool, synthSessionStopTool, synthSessionResumeTool];

  it('все тулы зарегистрированы в ALL_BUILTIN_TOOLS с capability sessions', () => {
    for (const tool of TOOLS) {
      const registered = ALL_BUILTIN_TOOLS.find((candidate) => candidate.name === tool.name);
      expect(registered, `${tool.name} не зарегистрирован`).toBeDefined();
      expect(registered?.capabilities).toEqual([ToolCapability.SESSIONS]);
    }
  });

  it('имена входят в группы sessions (read/write) — правило permission.rules.sessions', () => {
    expect(SESSIONS_READ_TOOLS).toContain('synth_sessions_active');
    expect(SESSIONS_WRITE_TOOLS).not.toContain('synth_sessions_active');
    for (const name of ['synth_session_stop', 'synth_session_resume']) {
      expect(SESSIONS_WRITE_TOOLS, name).toContain(name);
      expect(SESSIONS_READ_TOOLS, name).not.toContain(name);
    }
    expect(SESSIONS_TOOLS).toEqual([...SESSIONS_READ_TOOLS, ...SESSIONS_WRITE_TOOLS]);
  });
});

// ─────────────────────────── synth_sessions_active ────────────────────────────

describe('synth_sessions_active', () => {
  const SESSIONS = [
    makeSession({ id: 's1', title: 'стрим', streaming: true, updatedAt: '2026-01-04T00:00:00.000Z' }),
    makeSession({ id: 's2', title: 'простой', updatedAt: '2026-01-03T00:00:00.000Z' }),
    makeSession({
      id: 's3',
      title: 'очередь',
      pending: 2,
      projectId: 'p1',
      updatedAt: '2026-01-02T00:00:00.000Z',
    }),
    makeSession({
      id: 's4',
      title: 'фон',
      projectId: 'p2',
      agentRole: 'keeper',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }),
  ];

  function control(): FakeControl {
    return makeControl({
      backgroundRuns: async () => new Map([['s4', 2]]),
      terminals: () => new Map([['s1', 1]]),
      approvalCounts: () => new Map([['s3', 1]]),
    });
  }

  it('снимок считает working/idle/total и склеивает счётчики реестров', async () => {
    const fake = makeControl({
      backgroundRuns: async () => new Map([['s4', 2]]),
      terminals: () => new Map([['s1', 1]]),
      approvalCounts: () => new Map([['s3', 1]]),
    });
    // s3 работает не только очередью: висящее подтверждение — тоже работа.
    const { ctx } = makeCtx({ sessions: SESSIONS, control: fake.deps });

    const result = await synthSessionsActiveTool.execute({}, ctx);

    expect(result.isError).toBeUndefined();
    expect(i18nKey(result)).toBe('session.active.snapshot');
    expect(result.metadata?.summary).toEqual({ working: 3, idle: 1, total: 4 });
    expect(result.metadata?.total).toBe(4);
    expect(result.metadata?.truncated).toBe(false);

    const byId = new Map(rows(result).map((row) => [row.session_id, row]));
    expect(byId.get('s1')).toMatchObject({ streaming: true, terminals: 1, pending: 0 });
    expect(byId.get('s2')).toMatchObject({ streaming: false, pending: 0, background_runs: 0 });
    expect(byId.get('s3')).toMatchObject({ pending: 2, approvals: 1, project_id: 'p1' });
    expect(byId.get('s4')).toMatchObject({ background_runs: 2, project_id: 'p2' });
    // Счётчики реестров просуммированы в тексте ответа.
    expect(result.content).toContain('s4');
    expect(JSON.stringify(result.metadata)).not.toContain('queued');
  });

  it('живой процессор очереди — тоже «работает» (ход между итерациями)', async () => {
    // Обе сессии без стрима/очереди/прогонов: без процессора они были бы idle.
    const idleOnly = [
      makeSession({ id: 'a', updatedAt: '2026-01-02T00:00:00.000Z' }),
      makeSession({ id: 'b', updatedAt: '2026-01-01T00:00:00.000Z' }),
    ];
    const withoutProcessor = await synthSessionsActiveTool.execute(
      {},
      makeCtx({ sessions: idleOnly, control: makeControl().deps }).ctx,
    );
    expect(withoutProcessor.metadata?.summary).toEqual({ working: 0, idle: 2, total: 2 });

    const fake = makeControl({ isProcessorRunning: (id: string) => id === 'b' });
    const result = await synthSessionsActiveTool.execute(
      {},
      makeCtx({ sessions: idleOnly, control: fake.deps }).ctx,
    );

    const byId = new Map(rows(result).map((row) => [row.session_id, row]));
    expect(byId.get('b')?.streaming).toBe(true);
    expect(byId.get('a')?.streaming).toBe(false);
    expect(result.metadata?.summary).toEqual({ working: 1, idle: 1, total: 2 });
  });

  it('include_idle: false оставляет только работающие, сводка считается по всем', async () => {
    const fake = makeControl({
      backgroundRuns: async () => new Map([['s4', 1]]),
      approvalCounts: () => new Map([['s3', 1]]),
    });
    const { ctx } = makeCtx({ sessions: SESSIONS, control: fake.deps });

    const result = await synthSessionsActiveTool.execute({ include_idle: false }, ctx);

    expect(rows(result).map((row) => row.session_id).sort()).toEqual(['s1', 's3', 's4']);
    expect(result.metadata?.summary).toEqual({ working: 3, idle: 1, total: 4 });
    expect(result.metadata?.total).toBe(3);
  });

  it('project_id фильтрует снимок и сводку', async () => {
    const { ctx } = makeCtx({ sessions: SESSIONS, control: control().deps });

    const result = await synthSessionsActiveTool.execute({ project_id: 'p1' }, ctx);

    expect(rows(result).map((row) => row.session_id)).toEqual(['s3']);
    expect(result.metadata?.summary).toEqual({ working: 1, idle: 0, total: 1 });
    expect(rows(result)[0]?.project_id).toBe('p1');
  });

  it(`кап ${SNAPSHOT_CAP}: лишние записи обрезаются, truncated: true`, async () => {
    const many = Array.from({ length: SNAPSHOT_CAP + 1 }, (_, index) => makeSession({
      id: `s${String(index).padStart(2, '0')}`,
      updatedAt: `2026-01-01T00:00:${String(index).padStart(2, '0')}.000Z`,
    }));
    const { ctx } = makeCtx({ sessions: many, control: control().deps });

    const result = await synthSessionsActiveTool.execute({}, ctx);

    expect(result.isError).toBeUndefined();
    expect(rows(result)).toHaveLength(SNAPSHOT_CAP);
    expect(result.metadata?.truncated).toBe(true);
    expect(result.metadata?.total).toBe(SNAPSHOT_CAP + 1);
    expect(result.metadata?.summary).toEqual({ working: 0, idle: SNAPSHOT_CAP + 1, total: SNAPSHOT_CAP + 1 });
  });

  it('пустой снимок → session.active.empty без ошибки', async () => {
    const { ctx } = makeCtx({ sessions: [], control: control().deps });

    const result = await synthSessionsActiveTool.execute({}, ctx);

    expect(result.isError).toBeUndefined();
    expect(i18nKey(result)).toBe('session.active.empty');
    expect(result.metadata?.summary).toEqual({ working: 0, idle: 0, total: 0 });
    expect(rows(result)).toEqual([]);
  });

  it('сбой одного реестра (terminals/backgroundRuns) не роняет снимок', async () => {
    const fake = makeControl({
      terminals: () => { throw new Error('terminal registry down'); },
      approvalCounts: () => { throw new Error('approvals down'); },
      backgroundRuns: async () => { throw new Error('runs down'); },
      isProcessorRunning: () => { throw new Error('processor registry down'); },
    });
    const { ctx } = makeCtx({ sessions: SESSIONS, control: fake.deps });

    const result = await synthSessionsActiveTool.execute({}, ctx);

    expect(result.isError).toBeUndefined();
    expect(i18nKey(result)).toBe('session.active.snapshot');
    for (const row of rows(result)) {
      expect(row.terminals).toBe(0);
      expect(row.background_runs).toBe(0);
      expect(row.approvals).toBe(0);
    }
    // s1 работал стримом, s3 — очередью; сбой реестров их не «погасил».
    expect(result.metadata?.summary).toEqual({ working: 2, idle: 2, total: 4 });
  });

  it('видимость как у GET /sessions: не-elevated видит только свои сессии', async () => {
    const sessions = [
      makeSession({ id: 'own', ownerId: 'u2', streaming: true }),
      makeSession({ id: 'foreign', ownerId: 'u1' }),
    ];
    const { ctx, listSessions } = makeCtx({
      sessions,
      control: control().deps,
      principal: { userId: 'u2', roles: ['USER'] },
    });

    const result = await synthSessionsActiveTool.execute({}, ctx);

    expect(listSessions).toHaveBeenCalledWith({ userId: 'u2' });
    expect(rows(result).map((row) => row.session_id)).toEqual(['own']);
  });

  it('без sessionManager → session.tool.deps_unavailable', async () => {
    const ctx = {
      sessionId: 's1',
      messageId: 'm1',
      abortSignal: new AbortController().signal,
      workingDir: '/work',
      dataDir: '/data',
      extra: { principal: { userId: 'u1', roles: ['ADMIN'] } },
    } as unknown as ToolContext;

    const result = await synthSessionsActiveTool.execute({}, ctx);

    expect(result.isError).toBe(true);
    expect(i18nKey(result)).toBe('session.tool.deps_unavailable');
  });
});

// ───────────────────────────── synth_session_stop ─────────────────────────────

describe('synth_session_stop', () => {
  const SESSION = makeSession({ id: 's1', ownerId: 'u1', streaming: true });

  it('владелец → abortTurn вызван ровно один раз с сессией', async () => {
    const fake = makeControl();
    const { ctx } = makeCtx({
      sessions: [SESSION],
      control: fake.deps,
      principal: { userId: 'u1', roles: ['USER'] },
    });

    const result = await synthSessionStopTool.execute({ session_id: 's1', reason: 'перед рестартом' }, ctx);

    expect(result.isError).toBeUndefined();
    expect(i18nKey(result)).toBe('session.stop.ok');
    expect(fake.abortTurn).toHaveBeenCalledTimes(1);
    expect(fake.abortTurn).toHaveBeenCalledWith('s1', SESSION);
    expect(result.metadata).toMatchObject({
      session_id: 's1',
      stopped: true,
      was_running: true,
      processor_stopped: true,
      reason: 'перед рестартом',
      actor: 'u1',
    });
    expect(result.content).toContain('перед рестартом');
  });

  it('ADMIN инстанса останавливает чужую сессию', async () => {
    const fake = makeControl();
    const { ctx } = makeCtx({
      sessions: [SESSION],
      control: fake.deps,
      principal: { userId: 'admin', roles: ['ADMIN'] },
    });

    const result = await synthSessionStopTool.execute({ session_id: 's1' }, ctx);

    expect(result.isError).toBeUndefined();
    expect(fake.abortTurn).toHaveBeenCalledTimes(1);
  });

  it('локальный владелец standalone — ADMIN-паритет', async () => {
    const fake = makeControl();
    const { ctx } = makeCtx({
      sessions: [SESSION],
      control: fake.deps,
      principal: { userId: LOCAL_USER_ID, roles: [] },
      instanceMeta: STANDALONE_META,
    });

    const result = await synthSessionStopTool.execute({ session_id: 's1' }, ctx);

    expect(result.isError).toBeUndefined();
    expect(fake.abortTurn).toHaveBeenCalledTimes(1);
  });

  it('чужая сессия → session.forbidden, abortTurn НЕ вызван', async () => {
    const fake = makeControl();
    const { ctx } = makeCtx({
      sessions: [SESSION],
      control: fake.deps,
      principal: { userId: 'u2', roles: ['USER'] },
    });

    const result = await synthSessionStopTool.execute({ session_id: 's1' }, ctx);

    expect(result.isError).toBe(true);
    expect(i18nKey(result)).toBe('session.forbidden');
    expect(fake.abortTurn).not.toHaveBeenCalled();
  });

  it('нет принципала → session.forbidden (fail-closed, ADMIN не выводится)', async () => {
    // Принципала нет: идентичность — фоллбек на владельца сессии разговора.
    // Сессия разговора чужая (её нет в реестре → `local`), поэтому даже
    // standalone-литерал не даёт ADMIN-прав над чужой сессией.
    const fake = makeControl();
    const { ctx } = makeCtx({
      sessions: [SESSION],
      control: fake.deps,
      principal: null,
      currentSessionId: 'other-conversation',
    });

    const result = await synthSessionStopTool.execute({ session_id: 's1' }, ctx);

    expect(result.isError).toBe(true);
    expect(i18nKey(result)).toBe('session.forbidden');
    expect(fake.abortTurn).not.toHaveBeenCalled();
  });

  it('без принципала, но сессия разговора своя — владелец управляет (фоллбек identity)', async () => {
    const fake = makeControl();
    const { ctx } = makeCtx({
      sessions: [SESSION],
      control: fake.deps,
      principal: null,
      currentSessionId: 's1',
    });

    const result = await synthSessionStopTool.execute({ session_id: 's1' }, ctx);

    expect(result.isError).toBeUndefined();
    expect(fake.abortTurn).toHaveBeenCalledTimes(1);
  });

  it('нет такой сессии → session.not_found, abortTurn НЕ вызван', async () => {
    const fake = makeControl();
    const { ctx } = makeCtx({ sessions: [SESSION], control: fake.deps });

    const result = await synthSessionStopTool.execute({ session_id: 'nope' }, ctx);

    expect(result.isError).toBe(true);
    expect(i18nKey(result)).toBe('session.not_found');
    expect(fake.abortTurn).not.toHaveBeenCalled();
  });

  it('нет прокладки extra.sessionControl → session.tool.deps_unavailable', async () => {
    const { ctx } = makeCtx({ sessions: [SESSION], withDeps: false });

    const result = await synthSessionStopTool.execute({ session_id: 's1' }, ctx);

    expect(result.isError).toBe(true);
    expect(i18nKey(result)).toBe('session.tool.deps_unavailable');
  });

  it('«нечего останавливать» — не ошибка: stopped:false, was_running:false', async () => {
    const fake = makeControl({
      abortTurn: vi.fn(async (sessionId: string) => abortResult(sessionId, {
        wasRunning: false,
        processorStopped: false,
        pending: 1,
      })),
    });
    const { ctx } = makeCtx({ sessions: [SESSION], control: fake.deps });

    const result = await synthSessionStopTool.execute({ session_id: 's1' }, ctx);

    expect(result.isError).toBeUndefined();
    expect(i18nKey(result)).toBe('session.stop.ok');
    expect(result.metadata).toMatchObject({
      stopped: false,
      was_running: false,
      processor_stopped: false,
      pending: 1,
    });
  });

  it('фоновые прогоны «Стоп» не гасит — их число попадает в ответ', async () => {
    const fake = makeControl({ backgroundRuns: async () => new Map([['s1', 3]]) });
    const { ctx } = makeCtx({ sessions: [SESSION], control: fake.deps });

    const result = await synthSessionStopTool.execute({ session_id: 's1' }, ctx);

    expect(result.metadata?.background_runs).toBe(3);
    expect(result.content).toContain('process_stop');
  });

  it('сбой abortTurn → session.conflict с причиной (не исключение)', async () => {
    const fake = makeControl({
      abortTurn: vi.fn(async () => { throw new Error('storage down'); }),
    });
    const { ctx } = makeCtx({ sessions: [SESSION], control: fake.deps });

    const result = await synthSessionStopTool.execute({ session_id: 's1' }, ctx);

    expect(result.isError).toBe(true);
    expect(i18nKey(result)).toBe('session.conflict');
    expect(result.metadata?.i18n).toMatchObject({ params: { reason: 'storage down' } });
  });

  it('пустой session_id не проходит валидацию схемы', async () => {
    const fake = makeControl();
    const { ctx } = makeCtx({ sessions: [SESSION], control: fake.deps });

    const result = await synthSessionStopTool.execute({ session_id: '   ' }, ctx);

    expect(result.isError).toBe(true);
    expect(fake.abortTurn).not.toHaveBeenCalled();
  });
});

// ──────────────────────────── synth_session_resume ────────────────────────────

describe('synth_session_resume', () => {
  const PLAIN = makeSession({ id: 's1', ownerId: 'u1' });
  const CHILD = makeSession({ id: 'c1', ownerId: 'u1', parentId: 'p1' });

  it('обычная сессия → служебное resume_notice в очередь, сессия не создаётся', async () => {
    const fake = makeControl();
    const { ctx, createSession, addSession } = makeCtx({
      sessions: [PLAIN],
      control: fake.deps,
      principal: { userId: 'u1', roles: ['USER'] },
    });

    const result = await synthSessionResumeTool.execute(
      { session_id: 's1', note: 'продолжи с шага 3' },
      ctx,
    );

    expect(result.isError).toBeUndefined();
    expect(i18nKey(result)).toBe('session.resume.ok');
    expect(fake.enqueueContinuation).toHaveBeenCalledTimes(1);
    expect(fake.resumeSubagent).not.toHaveBeenCalled();

    const [sessionId, message] = fake.enqueueContinuation.mock.calls[0] as [string, Message];
    expect(sessionId).toBe('s1');
    expect(message.role).toBe(MessageRole.USER);
    expect(message.author).toBe('System');
    expect(message.metadata).toMatchObject({ type: 'resume_notice' });
    // Текст — служебный маркер `session.resume.notice` + переданное указание.
    expect(message.content).toContain('[RESUME]');
    expect(message.content).toContain('продолжи с шага 3');
    expect(result.metadata).toMatchObject({ mode: 'queue', resumed: true, session_id: 's1' });
    expect(result.metadata?.message_id).toBe(message.id);
    // Возобновление не создаёт сессию: очередь поднимает процессор.
    expect(createSession).not.toHaveBeenCalled();
    expect(addSession).not.toHaveBeenCalled();
  });

  it('note не задан — сообщение равно служебному маркеру без дописанного текста', async () => {
    const fake = makeControl();
    const { ctx } = makeCtx({ sessions: [PLAIN], control: fake.deps });

    const result = await synthSessionResumeTool.execute({ session_id: 's1' }, ctx);

    expect(result.isError).toBeUndefined();
    const message = fake.enqueueContinuation.mock.calls[0]?.[1] as Message;
    expect(message.content.trimEnd()).toBe(message.content);
    expect(message.content.startsWith('[RESUME]')).toBe(true);
    expect(result.metadata).not.toHaveProperty('note');
  });

  it('сабагент (parentId) → resumeSubagent, режим subagent', async () => {
    const fake = makeControl();
    const { ctx } = makeCtx({
      sessions: [CHILD],
      control: fake.deps,
      principal: { userId: 'u1', roles: ['USER'] },
    });

    const result = await synthSessionResumeTool.execute({ session_id: 'c1', note: 'доделай' }, ctx);

    expect(result.isError).toBeUndefined();
    expect(i18nKey(result)).toBe('session.resume.ok');
    expect(fake.resumeSubagent).toHaveBeenCalledTimes(1);
    expect(fake.resumeSubagent).toHaveBeenCalledWith('c1', 'доделай');
    expect(fake.enqueueContinuation).not.toHaveBeenCalled();
    expect(result.metadata).toMatchObject({
      mode: 'subagent',
      resumed: true,
      child_session_id: 'c1',
      parent_session_id: 'parent-1',
      stream_id: 'st_child',
    });
  });

  it('NOT_FOUND/PARENT_NOT_FOUND сабагента → session.not_found', async () => {
    for (const code of ['NOT_FOUND', 'PARENT_NOT_FOUND'] as const) {
      const fake = makeControl({
        resumeSubagent: vi.fn(async () => {
          throw new SubagentResumeError(code, 'ребёнка нет');
        }),
      });
      const { ctx } = makeCtx({ sessions: [CHILD], control: fake.deps });

      const result = await synthSessionResumeTool.execute({ session_id: 'c1' }, ctx);

      expect(result.isError, code).toBe(true);
      expect(i18nKey(result), code).toBe('session.not_found');
    }
  });

  it('прочие коды сабагента (LOCKED/NO_PROVIDER) → session.conflict с причиной', async () => {
    for (const code of ['LOCKED', 'NO_PROVIDER'] as const) {
      const fake = makeControl({
        resumeSubagent: vi.fn(async () => {
          throw new SubagentResumeError(code, `причина ${code}`);
        }),
      });
      const { ctx } = makeCtx({ sessions: [CHILD], control: fake.deps });

      const result = await synthSessionResumeTool.execute({ session_id: 'c1' }, ctx);

      expect(result.isError, code).toBe(true);
      expect(i18nKey(result), code).toBe('session.conflict');
      expect(result.metadata?.i18n).toMatchObject({ params: { reason: `причина ${code}` } });
    }
  });

  it('очередь переполнена/сессия исчезла (enqueueContinuation → false) → session.conflict', async () => {
    const fake = makeControl({ enqueueContinuation: vi.fn(async () => false) });
    const { ctx } = makeCtx({ sessions: [PLAIN], control: fake.deps });

    const result = await synthSessionResumeTool.execute({ session_id: 's1' }, ctx);

    expect(result.isError).toBe(true);
    expect(i18nKey(result)).toBe('session.conflict');
  });

  it('чужая сессия → session.forbidden, ничего не поставлено и не запущено', async () => {
    const fake = makeControl();
    const { ctx } = makeCtx({
      sessions: [PLAIN],
      control: fake.deps,
      principal: { userId: 'u2', roles: ['USER'] },
    });

    const result = await synthSessionResumeTool.execute({ session_id: 's1' }, ctx);

    expect(result.isError).toBe(true);
    expect(i18nKey(result)).toBe('session.forbidden');
    expect(fake.enqueueContinuation).not.toHaveBeenCalled();
    expect(fake.resumeSubagent).not.toHaveBeenCalled();
  });

  it('нет сессии → session.not_found; нет прокладки → session.tool.deps_unavailable', async () => {
    const fake = makeControl();
    const missing = makeCtx({ sessions: [PLAIN], control: fake.deps });
    const notFound = await synthSessionResumeTool.execute({ session_id: 'nope' }, missing.ctx);
    expect(i18nKey(notFound)).toBe('session.not_found');

    const noDeps = makeCtx({ sessions: [PLAIN], withDeps: false });
    const unavailable = await synthSessionResumeTool.execute({ session_id: 's1' }, noDeps.ctx);
    expect(i18nKey(unavailable)).toBe('session.tool.deps_unavailable');
    expect(fake.enqueueContinuation).not.toHaveBeenCalled();
  });
});

// ────────────────────────────── plan-режим ───────────────────────────────────

describe('plan-режим (ADR-025/ADR-029)', () => {
  it('write-имена блокируются, снимок разрешён', () => {
    for (const name of ['synth_session_stop', 'synth_session_resume']) {
      expect(SESSIONS_WRITE_TOOLS, name).toContain(name);
      expect(isPlanBlockedTool(name), name).toBe(true);
    }
    expect(isPlanBlockedTool('synth_sessions_active', [ToolCapability.SESSIONS])).toBe(false);
  });

  it('PermissionEvaluator: plan → deny на управление, allow на снимок', () => {
    const evaluator = new PermissionEvaluator({ rules: {}, askTimeoutMs: 0 });

    const denied = evaluator.check({
      toolName: 'synth_session_stop',
      params: {},
      workingDir: '/work',
      capabilities: [ToolCapability.SESSIONS],
      sessionMode: 'plan',
    });
    expect(denied.action).toBe('deny');
    expect(denied.unavailable?.reason).toBe('mode');

    const allowed = evaluator.check({
      toolName: 'synth_sessions_active',
      params: {},
      workingDir: '/work',
      capabilities: [ToolCapability.SESSIONS],
      sessionMode: 'plan',
    });
    expect(allowed.action).toBe('allow');
  });
});

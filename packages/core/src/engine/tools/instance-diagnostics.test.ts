/**
 * Диагностика сессии из чата: `synth_session_inspect`, `synth_permission_journal`,
 * `synth_session_pending`, `synth_session_history` (только чтение).
 *
 * Покрытие:
 * - `inspect`: действующие правила с источником (`session`/`parent`/`instance`),
 *   `askTimeoutMs` и его источник, счётчики сообщений, durable `stop_reason`
 *   (`metadata.type === 'execution_stopped'`), ожидания в снимке (кратко и с
 *   капом), режим списка по `project_id`/`limit`, отсутствие текста сообщений и
 *   аргументов вызова в снимке;
 * - `journal`: порядок «свежие первыми» (как отдал порт), фильтры по
 *   `session_id`/`action`, видимость для не-elevated (свои сессии; запись без
 *   сессии — только её актору), elevated (ADMIN/AUDITOR) видит всё;
 * - `pending`: пустой список, несколько ожиданий с `trigger`, чужое ожидание не
 *   видно (fail-closed, в том числе при отсутствии `ownerId`), кап, проект;
 * - `history`: сводка без текста, текст по `include_text` с лимитами на
 *   сообщение и на ответ, `tail` с потолком;
 * - матрица доступа на всех четырёх тулах: владелец / чужой / ADMIN / AUDITOR /
 *   без принципала (fail-closed), плюс `session.not_found`;
 * - plan-режим: группа `diagnostics` не блокируется (ADR-025/ADR-029).
 *
 * Зависимости — фейковые порты (`securityAudit`/`pendingApprovals`) и фейковый
 * `sessionManager`: ни реальной ФС, ни сети, ни таймеров. Тексты не сверяются
 * дословно — только ключи i18n и структура metadata (ADR-041).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  MessageRole,
  ToolCapability,
  type Message,
  type PermissionConfig,
  type SecurityAuditEntry,
  type Session,
  type ToolContext,
  type ToolDefinition,
  type ToolResult,
} from '@itphx/synth-shared';
import {
  synthSessionInspectTool,
  synthPermissionJournalTool,
  synthSessionPendingTool,
  synthSessionHistoryTool,
  type DiagnosticsDeps,
} from './instance-diagnostics.js';
import { ALL_BUILTIN_TOOLS } from './index.js';
import { DIAGNOSTICS_TOOLS, PERMISSION_GROUPS, getToolGroups } from '../permission/groups.js';
import { PermissionEvaluator, isPlanBlockedTool } from '../permission/evaluator.js';
import { DEFAULT_ASK_TIMEOUT_MS } from '../permission/derive.js';
import { STOP_MESSAGE_TYPE, buildStopRecord } from '../stop-reason.js';
import type { SessionManager } from '../../sessions/manager.js';
import type {
  SecurityAuditListOptions,
  SecurityAuditRepository,
} from '../../storage/ports/security-audit-repository.js';
import type {
  PendingApprovalRecord,
  PendingApprovalRepository,
} from '../../storage/ports/pending-approval-repository.js';
import type { InstanceRuntimeMeta } from '../instance/meta.js';
import type { ToolPrincipal } from './project-resolve.js';

const T0 = '2026-01-01T00:00:00.000Z';
const STANDALONE_META = { mode: 'standalone' } as unknown as InstanceRuntimeMeta;

/** Потолки/дефолты модуля (для проверки капов без «магических» чисел). */
const MAX_INSPECT_SESSIONS = 25;
const MAX_PENDING_IN_SNAPSHOT = 5;
const MAX_PENDING_RECORDS = 50;
const MAX_HISTORY_TAIL = 50;
const MAX_HISTORY_TEXT_CHARS = 400;
const MAX_JOURNAL_LIMIT = 200;

// ──────────────────────────────── фейки ──────────────────────────────────────

interface SessionOverrides {
  id?: string;
  title?: string;
  projectId?: string;
  parentId?: string;
  ownerId?: string;
  mode?: 'plan' | 'act' | 'yolo';
  planApproved?: boolean;
  agentRole?: string;
  provider?: string;
  model?: string;
  effort?: string;
  permission?: PermissionConfig;
  messages?: Message[];
  pending?: number;
  steer?: number;
  streaming?: boolean;
  status?: Record<string, unknown>;
  retry?: { attempt: number; maxRetries: number; retryAt?: string };
  updatedAt?: string;
}

/** Сессия-минимум: только поля, которые читают тулы диагностики. */
function makeSession(over: SessionOverrides = {}): Session {
  const id = over.id ?? 's1';
  const message = (messageId: string): Message => ({
    id: messageId,
    role: MessageRole.USER,
    seq: 0,
    origin: 'local',
    parts: [],
    content: 'queued',
    createdAt: T0,
    disabled: false,
    pinned: false,
    hidden: false,
  }) as unknown as Message;
  return {
    id,
    title: over.title,
    sessionOrigin: over.parentId ? 'subagent' : 'user',
    parentId: over.parentId,
    projectId: over.projectId,
    ownerId: over.ownerId,
    mode: over.mode,
    planApproved: over.planApproved ?? false,
    messages: over.messages ?? [],
    pendingMessages: Array.from({ length: over.pending ?? 0 }, (_, index) => message(`${id}-p${index}`)),
    steerInbox: Array.from({ length: over.steer ?? 0 }, (_, index) => message(`${id}-s${index}`)),
    status: over.status ?? {},
    retry: over.retry,
    settings: {
      ...(over.agentRole !== undefined ? { agentRole: over.agentRole } : {}),
      ...(over.provider !== undefined ? { provider: over.provider } : {}),
      ...(over.model !== undefined ? { model: over.model } : {}),
      ...(over.effort !== undefined ? { effort: over.effort } : {}),
      ...(over.permission !== undefined ? { permission: over.permission } : {}),
    },
    checkpoints: [],
    stickyNotes: [],
    references: [],
    summarizationPending: false,
    canSummarize: false,
    createdAt: T0,
    updatedAt: over.updatedAt ?? T0,
    currentStream: over.streaming ? { streamId: `st_${id}`, turnId: `turn_${id}` } : undefined,
  } as unknown as Session;
}

/**
 * Конфиг прав **без** `askTimeoutMs` — так выглядят записи сессии в JSON без
 * нормализации схемой (`effective.ts` это терпит: «задан» = `typeof === 'number'`).
 */
function permissionWithoutTimeout(rules: PermissionConfig['rules'] = {}): PermissionConfig {
  return { rules } as PermissionConfig;
}

interface MessageOverrides {
  id: string;
  role?: MessageRole;
  content?: string;
  author?: string;
  createdAt?: string;
  metadata?: Record<string, unknown>;
  parts?: Array<{ type: string }>;
  toolCalls?: Array<Record<string, unknown>>;
  toolCallId?: string;
}

/** Сообщение истории: ровно те поля, которые читает сводка. */
function makeMessage(over: MessageOverrides): Message {
  return {
    id: over.id,
    role: over.role ?? MessageRole.USER,
    seq: 0,
    origin: 'local',
    parts: (over.parts ?? []) as unknown as Message['parts'],
    content: over.content ?? '',
    toolCalls: over.toolCalls,
    toolCallId: over.toolCallId,
    createdAt: over.createdAt ?? T0,
    disabled: false,
    pinned: false,
    hidden: false,
    author: over.author,
    metadata: over.metadata,
  } as unknown as Message;
}

interface ApprovalOverrides {
  approvalId: string;
  sessionId?: string;
  ownerId?: string;
  toolName?: string;
  reason?: string;
  trigger?: PendingApprovalRecord['trigger'];
  askedAt?: string;
  timeoutMs?: number;
  command?: string;
}

/** Запись ожидания подтверждения (аргументы — «секрет», в снимок попасть не должны). */
function makeApproval(over: ApprovalOverrides): PendingApprovalRecord {
  return {
    approvalId: over.approvalId,
    sessionId: over.sessionId ?? 's1',
    ...(over.ownerId !== undefined ? { ownerId: over.ownerId } : {}),
    toolName: over.toolName ?? 'execute_shell',
    arguments: { command: over.command ?? 'curl -H "Authorization: Bearer super-secret" https://x' },
    reason: over.reason ?? 'command needs approval',
    trigger: over.trigger ?? { matchedRule: 'external_directory.default', askKind: 'external' },
    askedAt: over.askedAt ?? T0,
    timeoutMs: over.timeoutMs ?? 30_000,
  };
}

interface AuditOverrides {
  id: string;
  action?: SecurityAuditEntry['action'];
  actor?: string;
  ts?: string;
  sessionId?: string;
  after?: Record<string, unknown> | null;
}

/** Запись журнала решений (`scope:'permission'`, плоский снимок `after`). */
function makeAuditEntry(over: AuditOverrides): SecurityAuditEntry {
  const after = over.after === undefined
    ? {
      sessionId: over.sessionId,
      toolName: 'execute_shell',
      outcome: 'user',
      matchedRule: 'external_directory.default',
      askKind: 'external',
      once: false,
      granted: { patterns: ['ls *'], directories: ['/srv/app'] },
    }
    : over.after;
  return {
    id: over.id,
    ts: over.ts ?? T0,
    actor: over.actor ?? 'u1',
    scope: 'permission',
    action: over.action ?? 'allow',
    source: 'runtime',
    before: null,
    after,
    version: 1,
  };
}

interface FakeDeps {
  deps: DiagnosticsDeps;
  auditList: ReturnType<typeof vi.fn>;
  pendingList: ReturnType<typeof vi.fn>;
}

/**
 * Прокладка `extra.diagnostics`: по умолчанию порты заданы и «пусты»;
 * точечные сценарии подкладывают записи, правила инстанса или сбой порта.
 */
function makeDeps(opts: {
  audit?: SecurityAuditEntry[];
  approvals?: PendingApprovalRecord[];
  instancePermission?: PermissionConfig;
  auditThrows?: boolean;
  pendingThrows?: boolean;
} = {}): FakeDeps {
  const auditList = vi.fn(async (listOpts?: SecurityAuditListOptions) => {
    void listOpts;
    if (opts.auditThrows) throw new Error('audit down');
    return opts.audit ?? [];
  });
  const pendingList = vi.fn(async (sessionId?: string) => {
    if (opts.pendingThrows) throw new Error('pending down');
    const all = opts.approvals ?? [];
    return sessionId ? all.filter((record) => record.sessionId === sessionId) : all;
  });
  const deps: DiagnosticsDeps = {
    securityAudit: {
      append: vi.fn(async () => undefined),
      list: auditList,
      clear: vi.fn(async () => 0),
    } as unknown as SecurityAuditRepository,
    pendingApprovals: {
      save: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
      list: pendingList,
      clear: vi.fn(async () => 0),
    } as unknown as PendingApprovalRepository,
    ...(opts.instancePermission ? { getInstancePermission: () => opts.instancePermission } : {}),
  };
  return { deps, auditList, pendingList };
}

interface CtxOptions {
  sessions?: Session[];
  /** `null` — принципала нет вовсе (fail-closed). */
  principal?: ToolPrincipal | null;
  instanceMeta?: InstanceRuntimeMeta;
  deps?: DiagnosticsDeps;
  /** Удобная форма: готовый фейк портов вместе со шпионами. */
  fake?: FakeDeps;
  /** `false` — прокладки `extra.diagnostics` нет вовсе. */
  withDeps?: boolean;
  /**
   * Сессия разговора (`extra.sessionId`) — фоллбек идентичности, когда
   * принципала нет: `resolveViewer` берёт владельца именно этой сессии.
   */
  currentSessionId?: string;
}

interface FakeCtx {
  ctx: ToolContext;
  getSession: ReturnType<typeof vi.fn>;
  listSessions: ReturnType<typeof vi.fn>;
}

function makeCtx(opts: CtxOptions = {}): FakeCtx {
  const sessions = opts.sessions ?? [];
  const principal: ToolPrincipal | null = opts.principal === undefined
    ? { userId: 'u1', roles: ['ADMIN'] }
    : opts.principal;

  const listSessions = vi.fn(async (filter?: { userId?: string; projectIds?: string[] }) => {
    if (!filter?.userId) return sessions;
    return sessions.filter((session) => (session.ownerId || session.userId) === filter.userId);
  });
  const getSession = vi.fn(async (id: string) => sessions.find((session) => session.id === id) ?? null);
  const sessionManager = { listSessions, getSession } as unknown as SessionManager;

  const diagnostics = opts.withDeps === false
    ? undefined
    : opts.deps ?? opts.fake?.deps ?? makeDeps().deps;

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
      ...(diagnostics ? { diagnostics } : {}),
    },
  } as unknown as ToolContext;

  return { ctx, getSession, listSessions };
}

/** Ключ i18n из результата тула (все тексты — через `system-messages`). */
function i18nKey(result: ToolResult): string | undefined {
  return (result.metadata?.i18n as { key?: string } | undefined)?.key;
}

/** Сериализованный ответ (для проверки «секретов/текста в снимке нет»). */
function dumped(result: ToolResult): string {
  return JSON.stringify(result.metadata);
}

interface RuleRow {
  key: string;
  rule: unknown;
  source: string;
  parent_session_id?: string;
}

/** Снимок `synth_session_inspect` (только те поля, которые читает тест). */
interface InspectSnapshot {
  permissions?: { ask_timeout_ms: number; ask_timeout_source: string; rules: RuleRow[] };
  approvals?: { count: number | null; items: Array<Record<string, unknown>>; error?: string } | null;
  stop_reason?: Record<string, unknown> | null;
  [key: string]: unknown;
}

function snapshotOf(result: ToolResult): InspectSnapshot {
  return (result.metadata?.session ?? {}) as InspectSnapshot;
}

const PRINCIPAL_USER = { userId: 'u1', roles: ['USER'] } as ToolPrincipal;

// ─────────────────────────── регистрация и группы ────────────────────────────

describe('регистрация и группы', () => {
  const TOOLS: ToolDefinition[] = [
    synthSessionInspectTool,
    synthPermissionJournalTool,
    synthSessionPendingTool,
    synthSessionHistoryTool,
  ];

  it('все тулы зарегистрированы в ALL_BUILTIN_TOOLS с capability diagnostics', () => {
    for (const tool of TOOLS) {
      const registered = ALL_BUILTIN_TOOLS.find((candidate) => candidate.name === tool.name);
      expect(registered, `${tool.name} не зарегистрирован`).toBeDefined();
      expect(registered?.capabilities, tool.name).toEqual([ToolCapability.DIAGNOSTICS]);
    }
  });

  it('имена входят в группу diagnostics (правило permission.rules.diagnostics)', () => {
    expect(DIAGNOSTICS_TOOLS).toEqual(TOOLS.map((tool) => tool.name));
    expect(PERMISSION_GROUPS.diagnostics).toEqual(DIAGNOSTICS_TOOLS);
    for (const tool of TOOLS) {
      expect(getToolGroups(tool.name, tool.capabilities), tool.name).toEqual(['diagnostics']);
    }
  });

  it('группа матчится и по capability (плагинный тул с capability diagnostics)', () => {
    expect(getToolGroups('plugin_vendor_whatever', [ToolCapability.DIAGNOSTICS])).toEqual(['diagnostics']);
  });
});

// ─────────────────────────── synth_session_inspect ───────────────────────────

describe('synth_session_inspect: права с источниками', () => {
  const PARENT = makeSession({
    id: 'p1',
    ownerId: 'u1',
    permission: {
      rules: { external_directory: 'ask', shell: 'allow' },
      askTimeoutMs: 7_000,
    },
  });
  const BASE: PermissionConfig = {
    rules: { read: 'ask' },
    askTimeoutMs: 9_999,
  };

  /** Сессия-ребёнок: своё правило `shell`, унаследованный `external_directory`. */
  const CHILD = makeSession({
    id: 's1',
    ownerId: 'u1',
    parentId: 'p1',
    permission: { rules: { shell: 'deny' }, askTimeoutMs: 5_000 },
  });

  async function inspectChild(
    child: Session,
    deps: DiagnosticsDeps,
  ): Promise<InspectSnapshot> {
    const { ctx } = makeCtx({
      sessions: [child, PARENT],
      principal: PRINCIPAL_USER,
      deps,
      currentSessionId: 's1',
    });
    const result = await synthSessionInspectTool.execute({ session_id: child.id }, ctx);
    expect(result.isError, i18nKey(result)).toBeUndefined();
    expect(i18nKey(result)).toBe('diagnostics.session.inspect');
    return snapshotOf(result);
  }

  it('правило листа → session, предка → parent (с id), базы инстанса → instance', async () => {
    const snapshot = await inspectChild(CHILD, makeDeps({ instancePermission: BASE }).deps);
    const permissions = snapshot.permissions!;

    expect(permissions.rules.map((row) => row.key)).toEqual(['external_directory', 'read', 'shell']);
    const byKey = new Map(permissions.rules.map((row) => [row.key, row]));
    expect(byKey.get('shell')).toMatchObject({ source: 'session', rule: 'deny' });
    expect(byKey.get('external_directory')).toMatchObject({ source: 'parent', parent_session_id: 'p1', rule: 'ask' });
    expect(byKey.get('read')).toMatchObject({ source: 'instance', rule: 'ask' });
    // Своё у сессии важнее унаследованного.
    expect(byKey.get('shell')?.parent_session_id).toBeUndefined();

    expect(permissions.ask_timeout_ms).toBe(5_000);
    expect(permissions.ask_timeout_source).toBe('session');
  });

  it('askTimeoutMs: источник parent, когда свой не задан', async () => {
    const child = makeSession({ id: 's1', ownerId: 'u1', parentId: 'p1', permission: permissionWithoutTimeout() });
    const snapshot = await inspectChild(child, makeDeps({ instancePermission: BASE }).deps);
    const permissions = snapshot.permissions!;
    expect(permissions).toMatchObject({ ask_timeout_ms: 7_000, ask_timeout_source: 'parent' });
  });

  it('askTimeoutMs: источник instance, когда в цепочке его нет', async () => {
    const parent = makeSession({ id: 'p1', ownerId: 'u1', permission: permissionWithoutTimeout({ shell: 'allow' }) });
    const child = makeSession({ id: 's1', ownerId: 'u1', parentId: 'p1', permission: permissionWithoutTimeout() });
    const { ctx } = makeCtx({
      sessions: [child, parent],
      principal: PRINCIPAL_USER,
      deps: makeDeps({ instancePermission: BASE }).deps,
    });

    const result = await synthSessionInspectTool.execute({ session_id: 's1' }, ctx);
    const permissions = snapshotOf(result).permissions!;
    expect(permissions).toMatchObject({ ask_timeout_ms: 9_999, ask_timeout_source: 'instance' });
    // Правило родителя из этой цепочки по-прежнему `parent`.
    expect(permissions.rules.find((row) => row.key === 'shell')).toMatchObject({ source: 'parent', parent_session_id: 'p1' });
  });

  it('askTimeoutMs: источник default без правил инстанса', async () => {
    const child = makeSession({ id: 's1', ownerId: 'u1', permission: permissionWithoutTimeout() });
    const snapshot = await inspectChild(child, makeDeps().deps);
    const permissions = snapshot.permissions!;
    expect(permissions).toMatchObject({
      ask_timeout_ms: DEFAULT_ASK_TIMEOUT_MS,
      ask_timeout_source: 'default',
    });
  });
});

describe('synth_session_inspect: снимок сессии', () => {
  it('режим/агент/модель/статус/стрим/ретрай/очередь и счётчики сообщений', async () => {
    const session = makeSession({
      id: 's1',
      ownerId: 'u1',
      projectId: 'p1',
      mode: 'plan',
      planApproved: true,
      agentRole: 'keeper',
      provider: 'openai',
      model: 'gpt-x',
      effort: 'high',
      streaming: true,
      pending: 2,
      steer: 1,
      status: { blocked: true, cancelRequested: true, queueStopped: true },
      retry: { attempt: 2, maxRetries: 3, retryAt: T0 },
      messages: [
        makeMessage({ id: 'm1', role: MessageRole.USER, content: 'привет' }),
        makeMessage({ id: 'm2', role: MessageRole.ASSISTANT, content: 'ответ' }),
        makeMessage({ id: 'm3', role: MessageRole.USER, content: 'ещё' }),
      ],
    });
    const { ctx } = makeCtx({ sessions: [session], principal: PRINCIPAL_USER });

    const result = await synthSessionInspectTool.execute({ session_id: 's1' }, ctx);
    expect(result.isError, i18nKey(result)).toBeUndefined();

    expect(snapshotOf(result)).toMatchObject({
      session_id: 's1',
      project_id: 'p1',
      owner_id: 'u1',
      mode: 'plan',
      plan_approved: true,
      agent_role: 'keeper',
      provider: 'openai',
      model: 'gpt-x',
      effort: 'high',
      streaming: true,
      current_stream: { stream_id: 'st_s1', turn_id: 'turn_s1' },
      retry: { attempt: 2, max_retries: 3, retry_at: T0 },
      status: { blocked: true, cancel_requested: true, queue_stopped: true },
      messages: { total: 3, by_role: { user: 2, assistant: 1 } },
      pending_count: 2,
      steer_count: 1,
      viewer_id: 'u1',
      stop_reason: null,
      // Порт ожиданий задан (пусто) — пустой снимок, а не `null`.
      approvals: { count: 0, items: [] },
    });
  });

  it('порта ожиданий нет → approvals: null (а не пустой снимок)', async () => {
    const session = makeSession({ id: 's1', ownerId: 'u1' });
    const { ctx } = makeCtx({
      sessions: [session],
      principal: PRINCIPAL_USER,
      // Прокладка есть, но порта ожиданий в ней нет (деградированный режим).
      deps: {},
    });

    const result = await synthSessionInspectTool.execute({ session_id: 's1' }, ctx);

    expect(result.isError).toBeUndefined();
    expect(snapshotOf(result).approvals).toBeNull();
  });

  it('stop_reason — последняя durable-запись execution_stopped (PROP-143)', async () => {
    // Нижняя запись (реальный производитель `buildStopRecord`) перекрыта верхней:
    // снимок отдаёт **последнюю** причину остановки.
    const real = buildStopRecord({ reason: 'steps_limit', turnId: 'turn-1' });
    const last = makeMessage({
      id: 'stop-last',
      role: MessageRole.USER,
      author: 'System',
      createdAt: '2026-01-05T00:00:00.000Z',
      content: '<execution_stopped reason="provider_error"/>',
      metadata: {
        type: STOP_MESSAGE_TYPE,
        reason: 'provider_error',
        error_type: 'rate_limit',
        retryable: true,
        attempts: 3,
        finish_reason: 'max_tokens',
        turn_id: 'turn-7',
      },
    });
    const session = makeSession({ id: 's1', ownerId: 'u1', messages: [real, last] });
    const { ctx } = makeCtx({ sessions: [session], principal: PRINCIPAL_USER });

    const result = await synthSessionInspectTool.execute({ session_id: 's1' }, ctx);
    const stopReason = snapshotOf(result).stop_reason;

    expect(stopReason).toEqual({
      reason: 'provider_error',
      stopped_at: '2026-01-05T00:00:00.000Z',
      error_type: 'rate_limit',
      finish_reason: 'max_tokens',
      retryable: true,
      attempts: 3,
      turn_id: 'turn-7',
    });

    // Только реальная запись в истории — её и отдаём (createdAt = stopped_at).
    const onlyReal = makeSession({ id: 's2', ownerId: 'u1', messages: [real] });
    const second = await synthSessionInspectTool.execute(
      { session_id: 's2' },
      makeCtx({ sessions: [onlyReal], principal: PRINCIPAL_USER }).ctx,
    );
    const fromProducer = snapshotOf(second).stop_reason!;
    expect(fromProducer.reason).toBe('steps_limit');
    expect(fromProducer.stopped_at).toBe(real.createdAt);
    expect(fromProducer.turn_id).toBe('turn-1');
  });

  it('ожидания в снимке: счётчик полный, список обрезан капом', async () => {
    const session = makeSession({ id: 's1', ownerId: 'u1' });
    const approvals = Array.from({ length: MAX_PENDING_IN_SNAPSHOT + 2 }, (_, index) => makeApproval({
      approvalId: `a${index}`,
      sessionId: 's1',
      ownerId: 'u1',
    }));
    const fake = makeDeps({ approvals });
    const { ctx } = makeCtx({ sessions: [session], principal: PRINCIPAL_USER, fake });

    const result = await synthSessionInspectTool.execute({ session_id: 's1' }, ctx);
    const approvalsView = snapshotOf(result).approvals!;

    expect(fake.pendingList).toHaveBeenCalledWith('s1');
    expect(approvalsView.count).toBe(MAX_PENDING_IN_SNAPSHOT + 2);
    expect(approvalsView.items).toHaveLength(MAX_PENDING_IN_SNAPSHOT);
    expect(approvalsView.items[0]).toMatchObject({
      approval_id: 'a0',
      tool_name: 'execute_shell',
      matched_rule: 'external_directory.default',
      ask_kind: 'external',
      timeout_ms: 30_000,
    });
    // Аргументы вызова (секреты) в снимок не попадают.
    expect(dumped(result)).not.toContain('super-secret');
    expect(dumped(result)).not.toContain('Authorization');
  });

  it('сбой порта ожиданий не роняет снимок: count: null, error: unavailable', async () => {
    const session = makeSession({ id: 's1', ownerId: 'u1' });
    const fake = makeDeps({ pendingThrows: true });
    const { ctx } = makeCtx({ sessions: [session], principal: PRINCIPAL_USER, fake });

    const result = await synthSessionInspectTool.execute({ session_id: 's1' }, ctx);

    expect(result.isError).toBeUndefined();
    expect(snapshotOf(result).approvals).toEqual({ count: null, items: [], error: 'unavailable' });
  });

  it('текста сообщений и аргументов в снимке нет', async () => {
    const session = makeSession({
      id: 's1',
      ownerId: 'u1',
      messages: [makeMessage({ id: 'm1', content: 'СЕКРЕТНЫЙ_ТЕКСТ_ПОЛЬЗОВАТЕЛЯ' })],
    });
    const { ctx } = makeCtx({ sessions: [session], principal: PRINCIPAL_USER });

    const result = await synthSessionInspectTool.execute({ session_id: 's1' }, ctx);

    expect(result.isError).toBeUndefined();
    expect(dumped(result)).not.toContain('СЕКРЕТНЫЙ_ТЕКСТ_ПОЛЬЗОВАТЕЛЯ');
    expect(result.content).not.toContain('СЕКРЕТНЫЙ_ТЕКСТ_ПОЛЬЗОВАТЕЛЯ');
  });
});

describe('synth_session_inspect: режим списка', () => {
  const SESSIONS = [
    makeSession({ id: 's1', ownerId: 'u1', projectId: 'p1', updatedAt: '2026-01-03T00:00:00.000Z' }),
    makeSession({ id: 's2', ownerId: 'u1', projectId: 'p1', updatedAt: '2026-01-02T00:00:00.000Z' }),
    makeSession({ id: 's3', ownerId: 'u1', projectId: 'p1', updatedAt: '2026-01-01T00:00:00.000Z' }),
    makeSession({ id: 's4', ownerId: 'u1', projectId: 'p2', updatedAt: '2026-01-04T00:00:00.000Z' }),
  ];

  function rows(result: ToolResult): Array<Record<string, unknown>> {
    return (result.metadata?.sessions ?? []) as Array<Record<string, unknown>>;
  }

  it('project_id + limit: свежие первыми, total/truncated по проекту', async () => {
    const { ctx, listSessions } = makeCtx({ sessions: SESSIONS, principal: PRINCIPAL_USER });

    const result = await synthSessionInspectTool.execute({ project_id: 'p1', limit: 2 }, ctx);

    expect(result.isError, i18nKey(result)).toBeUndefined();
    expect(i18nKey(result)).toBe('diagnostics.session.inspect_list');
    expect(listSessions).toHaveBeenCalledWith({ userId: 'u1' });
    expect(rows(result).map((row) => row.session_id)).toEqual(['s1', 's2']);
    expect(rows(result)[0]).toMatchObject({ project_id: 'p1', viewer_id: 'u1' });
    expect(result.metadata?.total).toBe(3);
    expect(result.metadata?.truncated).toBe(true);
  });

  it('без фильтра отдаёт все видимые (кап не превышен), чужие не видны', async () => {
    const sessions = [...SESSIONS, makeSession({ id: 'foreign', ownerId: 'u9', updatedAt: '2026-01-05T00:00:00.000Z' })];
    const { ctx } = makeCtx({ sessions, principal: PRINCIPAL_USER });

    const result = await synthSessionInspectTool.execute({}, ctx);

    expect(rows(result).map((row) => row.session_id)).toEqual(['s4', 's1', 's2', 's3']);
    expect(result.metadata?.total).toBe(4);
    expect(result.metadata?.truncated).toBe(false);
  });

  it('ADMIN видит чужие сессии в списке (elevated — без фильтра по владельцу)', async () => {
    const sessions = [
      makeSession({ id: 'own', ownerId: 'u1' }),
      makeSession({ id: 'foreign', ownerId: 'u9', updatedAt: '2026-01-02T00:00:00.000Z' }),
    ];
    const { ctx, listSessions } = makeCtx({ sessions, principal: { userId: 'admin', roles: ['ADMIN'] } });

    const result = await synthSessionInspectTool.execute({}, ctx);

    expect(listSessions).toHaveBeenCalledWith();
    expect(rows(result).map((row) => row.session_id).sort()).toEqual(['foreign', 'own']);
  });

  it('пустой список → session.list_empty без ошибки', async () => {
    const { ctx } = makeCtx({ sessions: [], principal: PRINCIPAL_USER });

    const result = await synthSessionInspectTool.execute({ project_id: 'nope' }, ctx);

    expect(result.isError).toBeUndefined();
    expect(i18nKey(result)).toBe('session.list_empty');
    expect(rows(result)).toEqual([]);
  });

  it('limit вне 1..25 — ошибка аргументов', async () => {
    const { ctx } = makeCtx({ sessions: SESSIONS, principal: PRINCIPAL_USER });

    const tooBig = await synthSessionInspectTool.execute({ limit: MAX_INSPECT_SESSIONS + 1 }, ctx);
    const zero = await synthSessionInspectTool.execute({ limit: 0 }, ctx);

    expect(tooBig.isError).toBe(true);
    expect(zero.isError).toBe(true);
  });
});

// ────────────────────────── synth_permission_journal ─────────────────────────

describe('synth_permission_journal', () => {
  /** Три записи «свежие первыми»: две по своей сессии, одна по чужой. */
  const ENTRIES: SecurityAuditEntry[] = [
    makeAuditEntry({ id: 'e1', sessionId: 's-own', action: 'allow', actor: 'u2', ts: '2026-01-03T00:00:00.000Z' }),
    makeAuditEntry({
      id: 'e2',
      sessionId: 's-foreign',
      action: 'deny',
      actor: 'u9',
      ts: '2026-01-02T00:00:00.000Z',
      after: { sessionId: 's-foreign', toolName: 'write_file', outcome: 'user' },
    }),
    makeAuditEntry({
      id: 'e3',
      sessionId: 's-own',
      action: 'update',
      actor: 'admin',
      ts: '2026-01-01T00:00:00.000Z',
      after: { sessionId: 's-own', toolName: 'read_file', outcome: 'rule', matchedRule: 'read' },
    }),
  ];

  const SESSIONS = [
    makeSession({ id: 's-own', ownerId: 'u2' }),
    makeSession({ id: 's-foreign', ownerId: 'u9' }),
  ];

  function items(result: ToolResult): Array<Record<string, unknown>> {
    return (result.metadata?.entries ?? []) as Array<Record<string, unknown>>;
  }

  it('порядок порта сохраняется (свежие первыми), поля решения на месте', async () => {
    const fake = makeDeps({ audit: ENTRIES });
    const { ctx } = makeCtx({ sessions: SESSIONS, principal: { userId: 'admin', roles: ['ADMIN'] }, fake });

    const result = await synthPermissionJournalTool.execute({}, ctx);

    expect(result.isError, i18nKey(result)).toBeUndefined();
    expect(i18nKey(result)).toBe('diagnostics.permission.journal');
    expect(fake.auditList).toHaveBeenCalledWith({ scope: 'permission', limit: 50 });
    expect(items(result).map((entry) => entry.id)).toEqual(['e1', 'e2', 'e3']);
    expect(items(result)[0]).toMatchObject({
      ts: '2026-01-03T00:00:00.000Z',
      actor: 'u2',
      action: 'allow',
      session_id: 's-own',
      tool_name: 'execute_shell',
      outcome: 'user',
      matched_rule: 'external_directory.default',
      ask_kind: 'external',
      once: false,
      granted: { patterns: ['ls *'], directories: ['/srv/app'] },
    });
    expect(result.metadata).toMatchObject({ scope: 'permission', action: 'all', limit: 50 });
  });

  it('фильтр по action: deny оставляет только отказы, all — все', async () => {
    const fake = makeDeps({ audit: ENTRIES });
    const admin = { userId: 'admin', roles: ['ADMIN'] } as ToolPrincipal;

    const denied = await synthPermissionJournalTool.execute(
      { action: 'deny' },
      makeCtx({ sessions: SESSIONS, principal: admin, fake }).ctx,
    );
    expect(items(denied).map((entry) => entry.id)).toEqual(['e2']);
    expect(denied.metadata?.action).toBe('deny');

    const all = await synthPermissionJournalTool.execute(
      { action: 'all' },
      makeCtx({ sessions: SESSIONS, principal: admin, fake }).ctx,
    );
    expect(items(all).map((entry) => entry.id)).toEqual(['e1', 'e2', 'e3']);
  });

  it('фильтр по session_id: только записи этой сессии (порт-страница ищется по after.sessionId)', async () => {
    const fake = makeDeps({ audit: ENTRIES });
    const { ctx } = makeCtx({ sessions: SESSIONS, principal: { userId: 'u2', roles: ['USER'] }, fake });

    const result = await synthPermissionJournalTool.execute({ session_id: 's-own' }, ctx);

    expect(result.isError, i18nKey(result)).toBeUndefined();
    expect(items(result).map((entry) => entry.id)).toEqual(['e1', 'e3']);
    expect(fake.auditList).toHaveBeenCalledTimes(1);
  });

  it('не-elevated видит только свои сессии; запись без сессии — только своему актору', async () => {
    const entries = [
      ...ENTRIES,
      makeAuditEntry({ id: 'no-session-own', actor: 'u2', action: 'revoke', after: null }),
      makeAuditEntry({ id: 'no-session-foreign', actor: 'u9', action: 'revoke', after: null }),
    ];
    const fake = makeDeps({ audit: entries });
    const { ctx } = makeCtx({ sessions: SESSIONS, principal: { userId: 'u2', roles: ['USER'] }, fake });

    const result = await synthPermissionJournalTool.execute({}, ctx);

    expect(items(result).map((entry) => entry.id)).toEqual(['e1', 'e3', 'no-session-own']);
  });

  it('ADMIN и AUDITOR видят журнал целиком', async () => {
    const entries = [
      ...ENTRIES,
      makeAuditEntry({ id: 'no-session-foreign', actor: 'u9', action: 'revoke', after: null }),
    ];
    for (const principal of [
      { userId: 'admin', roles: ['ADMIN'] },
      { userId: 'auditor', roles: ['AUDITOR'] },
    ] as ToolPrincipal[]) {
      const fake = makeDeps({ audit: entries });
      const { ctx } = makeCtx({ sessions: SESSIONS, principal, fake });

      const result = await synthPermissionJournalTool.execute({}, ctx);

      expect(result.isError, principal.userId).toBeUndefined();
      expect(items(result).map((entry) => entry.id)).toEqual(['e1', 'e2', 'e3', 'no-session-foreign']);
    }
  });

  it('чужая сессия в фильтре → session.forbidden, журнал не читается', async () => {
    const fake = makeDeps({ audit: ENTRIES });
    const { ctx } = makeCtx({ sessions: SESSIONS, principal: { userId: 'u2', roles: ['USER'] }, fake });

    const result = await synthPermissionJournalTool.execute({ session_id: 's-foreign' }, ctx);

    expect(result.isError).toBe(true);
    expect(i18nKey(result)).toBe('session.forbidden');
    expect(fake.auditList).not.toHaveBeenCalled();
  });

  it('нет сессии в фильтре → session.not_found, журнал не читается', async () => {
    const fake = makeDeps({ audit: ENTRIES });
    const { ctx } = makeCtx({ sessions: SESSIONS, principal: { userId: 'admin', roles: ['ADMIN'] }, fake });

    const result = await synthPermissionJournalTool.execute({ session_id: 'nope' }, ctx);

    expect(result.isError).toBe(true);
    expect(i18nKey(result)).toBe('session.not_found');
    expect(fake.auditList).not.toHaveBeenCalled();
  });

  it('пустой журнал (или всё чужое) → journal_empty без ошибки', async () => {
    const empty = await synthPermissionJournalTool.execute(
      {},
      makeCtx({ sessions: SESSIONS, principal: { userId: 'admin', roles: ['ADMIN'] }, fake: makeDeps() }).ctx,
    );
    expect(empty.isError).toBeUndefined();
    expect(i18nKey(empty)).toBe('diagnostics.permission.journal_empty');
    expect(items(empty)).toEqual([]);

    const onlyForeign = await synthPermissionJournalTool.execute(
      {},
      makeCtx({
        sessions: SESSIONS,
        principal: { userId: 'u2', roles: ['USER'] },
        fake: makeDeps({ audit: [ENTRIES[1]!] }),
      }).ctx,
    );
    expect(onlyForeign.isError).toBeUndefined();
    expect(i18nKey(onlyForeign)).toBe('diagnostics.permission.journal_empty');
    expect(items(onlyForeign)).toEqual([]);
  });

  it('порт журнала сбоит → diagnostics.tool.deps_unavailable (не исключение)', async () => {
    const fake = makeDeps({ auditThrows: true });
    const { ctx } = makeCtx({ sessions: SESSIONS, principal: { userId: 'admin', roles: ['ADMIN'] }, fake });

    const result = await synthPermissionJournalTool.execute({}, ctx);

    expect(result.isError).toBe(true);
    expect(i18nKey(result)).toBe('diagnostics.tool.deps_unavailable');
  });

  it('нет прокладки extra.diagnostics → diagnostics.tool.deps_unavailable', async () => {
    const { ctx } = makeCtx({ sessions: SESSIONS, principal: { userId: 'admin', roles: ['ADMIN'] }, withDeps: false });

    const result = await synthPermissionJournalTool.execute({}, ctx);

    expect(result.isError).toBe(true);
    expect(i18nKey(result)).toBe('diagnostics.tool.deps_unavailable');
  });

  it('limit вне 1..200 — ошибка аргументов', async () => {
    const fake = makeDeps({ audit: ENTRIES });
    const { ctx } = makeCtx({ sessions: SESSIONS, principal: { userId: 'admin', roles: ['ADMIN'] }, fake });

    const result = await synthPermissionJournalTool.execute({ limit: MAX_JOURNAL_LIMIT + 1 }, ctx);

    expect(result.isError).toBe(true);
    expect(fake.auditList).not.toHaveBeenCalled();
  });

  /**
   * Записи `revoke` пишутся с `before: { sessionId, tool, pattern, action }` и
   * `after: null` — журнал обязан читать оба поля, иначе снятие гранта не
   * находится фильтром по `session_id` и теряет имя тула.
   */
  it('запись revoke (after: null) находится фильтром по session_id', async () => {
    const revoke = makeAuditEntry({
      id: 'rev-1',
      action: 'revoke',
      actor: 'u2',
      after: null,
    });
    // `before` реальной записи несёт сессию и правило — журнал их не читает.
    const entry: SecurityAuditEntry = {
      ...revoke,
      before: { sessionId: 's-own', tool: 'execute_shell', pattern: 'ls *', action: 'allow' },
    };
    const fake = makeDeps({ audit: [entry] });
    const { ctx } = makeCtx({ sessions: SESSIONS, principal: { userId: 'u2', roles: ['USER'] }, fake });

    const result = await synthPermissionJournalTool.execute({ session_id: 's-own' }, ctx);

    expect(items(result)).toHaveLength(1);
    expect(items(result)[0]).toMatchObject({ session_id: 's-own', tool_name: 'execute_shell' });
  });
});

// ─────────────────────────── synth_session_pending ───────────────────────────

describe('synth_session_pending', () => {
  const SESSIONS = [
    makeSession({ id: 's1', ownerId: 'u1', projectId: 'p1' }),
    makeSession({ id: 's2', ownerId: 'u2', projectId: 'p2' }),
    makeSession({ id: 's3', ownerId: 'u1', projectId: 'p1' }),
  ];

  function items(result: ToolResult): Array<Record<string, unknown>> {
    return (result.metadata?.approvals ?? []) as Array<Record<string, unknown>>;
  }

  it('пусто → diagnostics.pending.empty без ошибки', async () => {
    const fake = makeDeps();
    const { ctx } = makeCtx({ sessions: SESSIONS, principal: PRINCIPAL_USER, fake });

    const result = await synthSessionPendingTool.execute({}, ctx);

    expect(result.isError).toBeUndefined();
    expect(i18nKey(result)).toBe('diagnostics.pending.empty');
    expect(items(result)).toEqual([]);
  });

  it('несколько ожиданий: trigger.matched_rule/ask_kind/params и session_id', async () => {
    const approvals = [
      makeApproval({
        approvalId: 'a1',
        sessionId: 's1',
        ownerId: 'u1',
        toolName: 'execute_shell',
        reason: 'external path outside workspace',
        trigger: { matchedRule: 'external_directory.default', askKind: 'external', params: { path: '/etc' } },
        askedAt: '2026-01-02T00:00:00.000Z',
        timeoutMs: 60_000,
      }),
      makeApproval({
        approvalId: 'a2',
        sessionId: 's3',
        ownerId: 'u1',
        toolName: 'write_file',
        trigger: { matchedRule: 'write_file.*.env', askKind: 'protected' },
      }),
    ];
    const fake = makeDeps({ approvals });
    const { ctx } = makeCtx({ sessions: SESSIONS, principal: PRINCIPAL_USER, fake });

    const result = await synthSessionPendingTool.execute({}, ctx);

    expect(result.isError, i18nKey(result)).toBeUndefined();
    expect(i18nKey(result)).toBe('diagnostics.pending.list');
    expect(fake.pendingList).toHaveBeenCalledTimes(1);
    expect(items(result)).toHaveLength(2);
    expect(items(result)[0]).toMatchObject({
      approval_id: 'a1',
      session_id: 's1',
      tool_name: 'execute_shell',
      reason: 'external path outside workspace',
      matched_rule: 'external_directory.default',
      ask_kind: 'external',
      trigger_params: { path: '/etc' },
      asked_at: '2026-01-02T00:00:00.000Z',
      timeout_ms: 60_000,
    });
    expect(items(result)[1]).toMatchObject({ ask_kind: 'protected' });
    // Аргументы вызова не раскрываются (секреты в команде).
    expect(dumped(result)).not.toContain('super-secret');
    expect(result.metadata?.total).toBe(2);
    expect(result.metadata?.truncated).toBe(false);
  });

  it('чужие ожидания не видны (fail-closed), ADMIN видит все', async () => {
    const approvals = [
      makeApproval({ approvalId: 'own', sessionId: 's1', ownerId: 'u1' }),
      makeApproval({ approvalId: 'foreign', sessionId: 's2', ownerId: 'u2' }),
      // Владелец записи неизвестен — тоже не показываем (fail-closed).
      makeApproval({ approvalId: 'no-owner', sessionId: 's1' }),
    ];
    const fake = makeDeps({ approvals });

    const userView = await synthSessionPendingTool.execute(
      {},
      makeCtx({ sessions: SESSIONS, principal: PRINCIPAL_USER, fake }).ctx,
    );
    expect(items(userView).map((item) => item.approval_id)).toEqual(['own']);

    const adminView = await synthSessionPendingTool.execute(
      {},
      makeCtx({ sessions: SESSIONS, principal: { userId: 'admin', roles: ['ADMIN'] }, fake }).ctx,
    );
    expect(items(adminView).map((item) => item.approval_id)).toEqual(['own', 'foreign', 'no-owner']);
  });

  it('фильтр по project_id: только ожидания сессий проекта', async () => {
    const approvals = [
      makeApproval({ approvalId: 'p1', sessionId: 's1', ownerId: 'u1' }),
      makeApproval({ approvalId: 'p2', sessionId: 's2', ownerId: 'u1' }),
    ];
    const fake = makeDeps({ approvals });
    const { ctx } = makeCtx({ sessions: SESSIONS, principal: PRINCIPAL_USER, fake });

    const result = await synthSessionPendingTool.execute({ project_id: 'p1' }, ctx);

    expect(items(result).map((item) => item.approval_id)).toEqual(['p1']);
  });

  it('session_id: чужая сессия → session.forbidden, порт не читается', async () => {
    const fake = makeDeps({ approvals: [makeApproval({ approvalId: 'a1', sessionId: 's2', ownerId: 'u2' })] });
    const { ctx } = makeCtx({ sessions: SESSIONS, principal: PRINCIPAL_USER, fake });

    const result = await synthSessionPendingTool.execute({ session_id: 's2' }, ctx);

    expect(result.isError).toBe(true);
    expect(i18nKey(result)).toBe('session.forbidden');
    expect(fake.pendingList).not.toHaveBeenCalled();
  });

  it('session_id: своя сессия → порт спрашивается по сессии', async () => {
    const fake = makeDeps({ approvals: [makeApproval({ approvalId: 'a1', sessionId: 's1', ownerId: 'u1' })] });
    const { ctx } = makeCtx({ sessions: SESSIONS, principal: PRINCIPAL_USER, fake });

    const result = await synthSessionPendingTool.execute({ session_id: 's1' }, ctx);

    expect(result.isError).toBeUndefined();
    expect(fake.pendingList).toHaveBeenCalledWith('s1');
    expect(items(result).map((item) => item.approval_id)).toEqual(['a1']);
  });

  it('кап 50 записей: лишние обрезаются, truncated: true', async () => {
    const approvals = Array.from({ length: MAX_PENDING_RECORDS + 1 }, (_, index) => makeApproval({
      approvalId: `a${String(index).padStart(3, '0')}`,
      sessionId: 's1',
      ownerId: 'u1',
    }));
    const fake = makeDeps({ approvals });
    const { ctx } = makeCtx({ sessions: SESSIONS, principal: PRINCIPAL_USER, fake });

    const result = await synthSessionPendingTool.execute({}, ctx);

    expect(items(result)).toHaveLength(MAX_PENDING_RECORDS);
    expect(result.metadata?.total).toBe(MAX_PENDING_RECORDS + 1);
    expect(result.metadata?.truncated).toBe(true);
  });

  it('сбой порта ожиданий → diagnostics.tool.deps_unavailable', async () => {
    const fake = makeDeps({ pendingThrows: true });
    const { ctx } = makeCtx({ sessions: SESSIONS, principal: PRINCIPAL_USER, fake });

    const result = await synthSessionPendingTool.execute({}, ctx);

    expect(result.isError).toBe(true);
    expect(i18nKey(result)).toBe('diagnostics.tool.deps_unavailable');
  });
});

// ─────────────────────────── synth_session_history ───────────────────────────

describe('synth_session_history', () => {
  function items(result: ToolResult): Array<Record<string, unknown>> {
    return (result.metadata?.messages ?? []) as Array<Record<string, unknown>>;
  }

  it('сводка без текста: части по типам, размеры, маркеры, tool-call', async () => {
    const session = makeSession({
      id: 's1',
      ownerId: 'u1',
      messages: [
        makeMessage({
          id: 'm1',
          role: MessageRole.USER,
          content: 'СЕКРЕТНЫЙ_ТЕКСТ_ПОЛЬЗОВАТЕЛЯ',
          author: 'u1',
          parts: [{ type: 'text' }],
        }),
        makeMessage({
          id: 'm2',
          role: MessageRole.ASSISTANT,
          content: 'вызов тула',
          parts: [{ type: 'text' }, { type: 'tool-call' }],
          toolCalls: [{ id: 'call-1', name: 'read_file' }],
          metadata: { finish_reason: 'tool_use' },
        }),
        makeMessage({
          id: 'm3',
          role: MessageRole.TOOL,
          content: 'ok',
          toolCallId: 'call-1',
          parts: [{ type: 'tool-result' }],
        }),
        makeMessage({
          id: 'm4',
          role: MessageRole.USER,
          author: 'System',
          content: '<execution_stopped/>',
          metadata: { type: STOP_MESSAGE_TYPE, reason: 'denied', finish_reason: 'max_tokens' },
        }),
      ],
    });
    const { ctx } = makeCtx({ sessions: [session], principal: PRINCIPAL_USER });

    const result = await synthSessionHistoryTool.execute({ session_id: 's1' }, ctx);

    expect(result.isError, i18nKey(result)).toBeUndefined();
    expect(i18nKey(result)).toBe('diagnostics.history.summary');
    expect(result.metadata).toMatchObject({ session_id: 's1', total: 4, tail: 4, include_text: false });

    const [u, assistant, tool, stop] = items(result);
    expect(u).toMatchObject({
      index: 0,
      message_id: 'm1',
      role: 'user',
      author: 'u1',
      parts: { text: 1 },
      chars: 'СЕКРЕТНЫЙ_ТЕКСТ_ПОЛЬЗОВАТЕЛЯ'.length,
      has_tool_calls: false,
    });
    expect(assistant).toMatchObject({ parts: { text: 1, 'tool-call': 1 }, has_tool_calls: true, finish_reason: 'tool_use' });
    expect(tool).toMatchObject({ role: 'tool', tool_call_id: 'call-1', parts: { 'tool-result': 1 } });
    expect(stop).toMatchObject({ type: STOP_MESSAGE_TYPE, stop_reason: 'denied', finish_reason: 'max_tokens' });

    // Текста в ответе нет ни в каком виде (ни в metadata, ни в content).
    for (const entry of items(result)) expect(entry).not.toHaveProperty('text');
    expect(dumped(result)).not.toContain('СЕКРЕТНЫЙ_ТЕКСТ_ПОЛЬЗОВАТЕЛЯ');
    expect(result.content).not.toContain('СЕКРЕТНЫЙ_ТЕКСТ_ПОЛЬЗОВАТЕЛЯ');
  });

  it('include_text: true — текст есть, обрезан лимитом на сообщение', async () => {
    const long = 'x'.repeat(1_000);
    const session = makeSession({
      id: 's1',
      ownerId: 'u1',
      messages: [makeMessage({ id: 'm1', content: long })],
    });
    const { ctx } = makeCtx({ sessions: [session], principal: PRINCIPAL_USER });

    const result = await synthSessionHistoryTool.execute({ session_id: 's1', include_text: true }, ctx);

    expect(result.metadata?.include_text).toBe(true);
    const entry = items(result)[0]!;
    const text = entry.text as string;
    expect(text).toHaveLength(MAX_HISTORY_TEXT_CHARS);
    expect(text.endsWith('…')).toBe(true);
    expect(entry.text_truncated).toBe(true);
    expect(entry.chars).toBe(1_000);
    // Короткое сообщение не обрезается и не помечается.
    const short = makeSession({ id: 's2', ownerId: 'u1', messages: [makeMessage({ id: 'm9', content: 'привет' })] });
    const second = await synthSessionHistoryTool.execute(
      { session_id: 's2', include_text: true },
      makeCtx({ sessions: [short], principal: PRINCIPAL_USER }).ctx,
    );
    expect(items(second)[0]).toMatchObject({ text: 'привет' });
    expect(items(second)[0]).not.toHaveProperty('text_truncated');
  });

  it('include_text: true — общий бюджет ответа исчерпывается (text_omitted)', async () => {
    const body = 'y'.repeat(300);
    const messages = Array.from({ length: 20 }, (_, index) => makeMessage({
      id: `m${String(index).padStart(2, '0')}`,
      content: body,
    }));
    const session = makeSession({ id: 's1', ownerId: 'u1', messages });
    const { ctx } = makeCtx({ sessions: [session], principal: PRINCIPAL_USER });

    const result = await synthSessionHistoryTool.execute(
      { session_id: 's1', tail: 20, include_text: true },
      ctx,
    );

    const rows = items(result);
    expect(rows).toHaveLength(20);
    expect(rows[0]).toMatchObject({ text: body });
    // 13 полных сообщений по 300 символов = 3900 из 4000; 14-е урезано до остатка.
    expect(rows[13]).toMatchObject({ text_truncated: true });
    expect((rows[13]!.text as string).length).toBe(100);
    // Дальше бюджет исчерпан — текст не отдаётся вовсе, только пометка.
    for (const row of rows.slice(14)) {
      expect(row.text_omitted).toBe(true);
      expect(row).not.toHaveProperty('text');
    }
    expect(result.metadata?.text_budget_left).toBe(0);
  });

  it('tail ограничен сверху: 50 из 60 сообщений', async () => {
    const messages = Array.from({ length: 60 }, (_, index) => makeMessage({ id: `m${index}`, content: 'a' }));
    const session = makeSession({ id: 's1', ownerId: 'u1', messages });
    const { ctx } = makeCtx({ sessions: [session], principal: PRINCIPAL_USER });

    const result = await synthSessionHistoryTool.execute({ session_id: 's1', tail: MAX_HISTORY_TAIL }, ctx);

    const rows = items(result);
    expect(rows).toHaveLength(MAX_HISTORY_TAIL);
    expect(rows[0]?.index).toBe(10);
    expect(rows[0]?.message_id).toBe('m10');
    expect(result.metadata).toMatchObject({ total: 60, tail: MAX_HISTORY_TAIL });
  });

  it('tail вне 1..50 — ошибка аргументов', async () => {
    const session = makeSession({ id: 's1', ownerId: 'u1', messages: [makeMessage({ id: 'm1' })] });
    const { ctx } = makeCtx({ sessions: [session], principal: PRINCIPAL_USER });

    const tooBig = await synthSessionHistoryTool.execute({ session_id: 's1', tail: MAX_HISTORY_TAIL + 1 }, ctx);
    const zero = await synthSessionHistoryTool.execute({ session_id: 's1', tail: 0 }, ctx);

    expect(tooBig.isError).toBe(true);
    expect(zero.isError).toBe(true);
  });

  it('пустая история → diagnostics.history.empty без ошибки', async () => {
    const session = makeSession({ id: 's1', ownerId: 'u1', messages: [] });
    const { ctx } = makeCtx({ sessions: [session], principal: PRINCIPAL_USER });

    const result = await synthSessionHistoryTool.execute({ session_id: 's1' }, ctx);

    expect(result.isError).toBeUndefined();
    expect(i18nKey(result)).toBe('diagnostics.history.empty');
    expect(items(result)).toEqual([]);
  });
});

// ─────────────────────────── матрица доступа ────────────────────────────────

describe('матрица доступа: владелец / чужой / ADMIN / AUDITOR / без принципала', () => {
  const OWN = makeSession({ id: 's1', ownerId: 'u1', messages: [makeMessage({ id: 'm1', content: 'hi' })] });
  /** Сессия разговора без принципала: её владелец становится «viewer». */
  const CONVERSATION = makeSession({ id: 'conv', ownerId: 'u3' });
  const SESSIONS = [OWN, CONVERSATION];

  const CASES: Array<{ tool: ToolDefinition; args: Record<string, unknown> }> = [
    { tool: synthSessionInspectTool, args: { session_id: 's1' } },
    { tool: synthPermissionJournalTool, args: { session_id: 's1' } },
    { tool: synthSessionPendingTool, args: { session_id: 's1' } },
    { tool: synthSessionHistoryTool, args: { session_id: 's1' } },
  ];

  const PRINCIPALS: Array<{ name: string; principal: ToolPrincipal | null; allowed: boolean }> = [
    { name: 'владелец', principal: { userId: 'u1', roles: ['USER'] }, allowed: true },
    { name: 'чужой', principal: { userId: 'u2', roles: ['USER'] }, allowed: false },
    { name: 'ADMIN', principal: { userId: 'admin', roles: ['ADMIN'] }, allowed: true },
    { name: 'AUDITOR', principal: { userId: 'auditor', roles: ['AUDITOR'] }, allowed: true },
    // Без принципала идентичность — фоллбек на владельца сессии разговора
    // (`conv` → u3): чужая сессия → отказ (fail-closed).
    { name: 'без принципала', principal: null, allowed: false },
  ];

  for (const { tool, args } of CASES) {
    for (const { name, principal, allowed } of PRINCIPALS) {
      it(`${tool.name}: ${name} → ${allowed ? 'разрешено' : 'session.forbidden'}`, async () => {
        const fake = makeDeps();
        const { ctx } = makeCtx({ sessions: SESSIONS, principal, fake, currentSessionId: 'conv' });

        const result = await tool.execute(args, ctx);

        if (allowed) {
          expect(result.isError, i18nKey(result)).toBeUndefined();
        } else {
          expect(result.isError).toBe(true);
          expect(i18nKey(result)).toBe('session.forbidden');
        }
      });
    }

    it(`${tool.name}: нет сессии → session.not_found (сначала чтение, потом решение)`, async () => {
      const fake = makeDeps();
      const { ctx } = makeCtx({ sessions: SESSIONS, principal: { userId: 'admin', roles: ['ADMIN'] }, fake });

      const result = await tool.execute({ session_id: 'nope' }, ctx);

      expect(result.isError).toBe(true);
      expect(i18nKey(result)).toBe('session.not_found');
    });
  }

  it('без sessionManager → diagnostics.tool.deps_unavailable (источник данных обязателен)', async () => {
    for (const { tool, args } of CASES) {
      const ctx = {
        sessionId: 's1',
        messageId: 'm1',
        abortSignal: new AbortController().signal,
        workingDir: '/work',
        dataDir: '/data',
        extra: { principal: { userId: 'u1', roles: ['ADMIN'] }, diagnostics: makeDeps().deps },
      } as unknown as ToolContext;

      const result = await tool.execute(args, ctx);

      expect(result.isError, tool.name).toBe(true);
      expect(i18nKey(result), tool.name).toBe('diagnostics.tool.deps_unavailable');
    }
  });
});

// ────────────────────────────── plan-режим ──────────────────────────────────

describe('plan-режим (ADR-025/ADR-029)', () => {
  const TOOLS: ToolDefinition[] = [
    synthSessionInspectTool,
    synthPermissionJournalTool,
    synthSessionPendingTool,
    synthSessionHistoryTool,
  ];

  it('тулы диагностики в plan не блокируются и входят в группу diagnostics', () => {
    for (const tool of TOOLS) {
      expect(isPlanBlockedTool(tool.name, tool.capabilities), tool.name).toBe(false);
      expect(getToolGroups(tool.name, tool.capabilities), tool.name).toContain('diagnostics');
    }
  });

  it('PermissionEvaluator: plan → allow (чтение ничего не меняет)', () => {
    const evaluator = new PermissionEvaluator({ rules: {}, askTimeoutMs: 0 });
    for (const tool of TOOLS) {
      const decision = evaluator.check({
        toolName: tool.name,
        params: {},
        workingDir: '/work',
        capabilities: tool.capabilities,
        sessionMode: 'plan',
      });
      expect(decision.action, tool.name).toBe('allow');
    }
  });
});

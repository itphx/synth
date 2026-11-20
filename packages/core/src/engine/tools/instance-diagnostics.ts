/**
 * Диагностика сессии из чата (**только чтение**): `synth_session_inspect`,
 * `synth_permission_journal`, `synth_session_pending`, `synth_session_history`.
 *
 * ## Зачем
 *
 * Разбор «почему спросило подтверждение / почему отказало / что вообще с этой
 * сессией» раньше требовал HTTP (`GET /api/v2/sessions/:id/secrets`,
 * `/api/v2/audit`, `/api/v2/settings/*`) или чтения файлов инстанса. Агент
 * `keeper` при обслуживании видел симптом («тул не сработал»), но не мог
 * показать **решение**: какие правила прав реально действуют на сессию, откуда
 * они взялись (свои / родителя / инстанса), что записано в журнале решений, что
 * висит в ожидании подтверждения и как выглядит хвост истории.
 *
 * ## Границы (паритет с чтениями HTTP-слоя)
 *
 * - **Только чтение.** Ни один тул не пишет в хранилище: правила резолвятся
 *   `resolveEffectivePermission` (он чистый по вводу-выводу), журнал читается
 *   портом `securityAudit.list`, ожидания — портом `pendingApprovals.list`,
 *   история — из документа сессии. Запись в хранилище отсюда невозможна по
 *   конструкции, поэтому в plan-режиме группа доступна целиком.
 * - **Доступ (fail-closed).** Читать диагностику сессии может её владелец
 *   (`ownerId`/`userId` = принципал хода), `ADMIN` инстанса (`isInstanceAdmin`:
 *   роль `ADMIN` либо локальный владелец standalone) или роль `AUDITOR` (роль
 *   аудита инстанса — тот же набор, что у полного экспорта сессии,
 *   `server/session-export-guard.ts`). Иначе — `session.forbidden` (тот же код,
 *   что у `instance-sessions.ts`); сначала читаем сессию, потом решаем: нет
 *   сессии → `session.not_found`, чужая → `session.forbidden`.
 * - **Журнал без `session_id` — только по доступным сессиям.** Записи
 *   `scope:'permission'` содержат `after.sessionId`; показывать журнал целиком
 *   значило бы раскрыть чужие сессии. Поэтому не-`ADMIN`/не-`AUDITOR`
 *   получает лишь записи сессий, которыми владеет (запись без `sessionId` —
 *   только если её `actor` совпадает с вызывающим). Правило сказано и в
 *   описании тула: «журнал фильтруется по доступным вам сессиям».
 * - **Текста сообщений в снимках нет.** `synth_session_inspect`/
 *   `synth_session_pending`/`synth_permission_journal` отдают метаданные и
 *   решения; полный текст — только `synth_session_history` с явным
 *   `include_text: true` и жёсткими лимитами (на сообщение и на весь ответ).
 *   Секретов (`command`, пути `askPaths`, значения env) в снимках нет: в журнале
 *   показываются только перечисленные поля решения.
 * - Тексты — через ключи `shared/i18n` (ADR-041): `content` — en-текст для
 *   модели, `metadata.i18n` — шаблон и параметры для UI.
 */
import { ToolCapability } from '@itphx/synth-shared';
import type {
  Message,
  PermissionConfig,
  PermissionRule,
  SecurityAuditEntry,
  Session,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '@itphx/synth-shared';
import { z } from 'zod';
import type { SessionManager } from '../../sessions/manager.js';
import type { SecurityAuditRepository } from '../../storage/ports/security-audit-repository.js';
import type {
  PendingApprovalRecord,
  PendingApprovalRepository,
} from '../../storage/ports/pending-approval-repository.js';
import { MAX_PERMISSION_PARENT_DEPTH, resolveEffectivePermission } from '../permission/effective.js';
import { STOP_MESSAGE_TYPE } from '../stop-reason.js';
import { isAborted, abortedResult } from './abort.js';
import { t as sm, i18n as i18nMeta } from '../system-messages.js';
import { argErrorResult } from './arg-error.js';
import { isInstanceAdmin, principalOf } from './instance-auth.js';
import type { InstanceRuntimeMeta } from '../instance/meta.js';
import {
  type PrincipalExtra,
  type ProjectViewer,
  resolveViewer,
} from './project-resolve.js';
import { listVisibleSessions } from './session-manage.js';

/**
 * Прокладка зависимостей диагностики (`ToolContext.extra.diagnostics`).
 *
 * Собирается в точке сборки (`server/app/deps.ts`, `backend/app/deps.ts`), где
 * порты хранилища и база правил инстанса — в одном скоупе. В деградированном
 * режиме порты **не передаются** (fail-closed): тулы ответят
 * `diagnostics.tool.deps_unavailable`, а слой доступности и так скрывает их
 * причиной `unavailable(storage)` (ADR-098).
 */
export interface DiagnosticsDeps {
  /** Журнал решений по правам (`scope:'permission'`, ADR-029). */
  securityAudit?: SecurityAuditRepository;
  /** Порт ожиданий подтверждения (ADR-029/ADR-096). */
  pendingApprovals?: PendingApprovalRepository;
  /**
   * База правил прав инстанса — последний источник цепочки наследования
   * (`fallback` у `resolveEffectivePermission`). Не задан — правил инстанса нет.
   */
  getInstancePermission?: () => PermissionConfig | undefined;
}

/** Поля `extra`, которые читают тулы диагностики. */
export interface DiagnosticsExtra extends PrincipalExtra {
  diagnostics?: DiagnosticsDeps;
  sessionManager?: SessionManager;
  /** Снимок метаданных инстанса (режим — для ADMIN-паритета standalone). */
  instanceMeta?: InstanceRuntimeMeta;
}

/** Сколько сессий максимум показывает `synth_session_inspect` в режиме списка. */
const MAX_INSPECT_SESSIONS = 25;
/** Размер страницы журнала по умолчанию и потолок. */
const DEFAULT_JOURNAL_LIMIT = 50;
const MAX_JOURNAL_LIMIT = 200;
/** Сколько ожиданий максимум отдаёт `synth_session_pending`. */
const MAX_PENDING_RECORDS = 50;
/** Краткий список ожиданий внутри снимка `synth_session_inspect`. */
const MAX_PENDING_IN_SNAPSHOT = 5;
/** Хвост истории: по умолчанию и потолок. */
const DEFAULT_HISTORY_TAIL = 10;
const MAX_HISTORY_TAIL = 50;
/** Лимиты текста истории: на сообщение и на весь ответ. */
const MAX_HISTORY_TEXT_CHARS = 400;
const MAX_HISTORY_TOTAL_TEXT_CHARS = 4_000;

function getExtra(ctx: ToolContext): DiagnosticsExtra {
  return (ctx.extra ?? {}) as DiagnosticsExtra;
}

function fail(
  key: Parameters<typeof sm>[0],
  params?: Record<string, string>,
  extra?: Record<string, unknown>,
): ToolResult {
  return {
    content: sm(key, params),
    isError: true,
    metadata: { ...(extra ?? {}), i18n: i18nMeta(key, params) },
  };
}

function ok(
  key: Parameters<typeof sm>[0],
  params: Record<string, string>,
  metadata: Record<string, unknown>,
): ToolResult {
  return { content: sm(key, params), metadata: { ...metadata, i18n: i18nMeta(key, params) } };
}

/** Порт журнала: нет прокладки — понятная ошибка, а не исключение. */
function auditPort(ctx: ToolContext, toolName: string): SecurityAuditRepository | ToolResult {
  const port = getExtra(ctx).diagnostics?.securityAudit;
  if (!port) return fail('diagnostics.tool.deps_unavailable', { tool: toolName });
  return port;
}

/** Порт ожиданий: нет прокладки — понятная ошибка, а не исключение. */
function pendingPort(ctx: ToolContext, toolName: string): PendingApprovalRepository | ToolResult {
  const port = getExtra(ctx).diagnostics?.pendingApprovals;
  if (!port) return fail('diagnostics.tool.deps_unavailable', { tool: toolName });
  return port;
}

function isResult(value: unknown): value is ToolResult {
  return typeof value === 'object' && value !== null && (value as { isError?: unknown }).isError === true;
}

/** Менеджер сессий: без него диагностика невозможна (источник данных). */
function managerOf(ctx: ToolContext, toolName: string): SessionManager | ToolResult {
  const manager = getExtra(ctx).sessionManager;
  if (!manager) return fail('diagnostics.tool.deps_unavailable', { tool: toolName });
  return manager;
}

/** Владелец сессии (legacy-поле `userId` — фоллбек, как у DTO/списков). */
function sessionOwnerId(session: Session): string | undefined {
  return session.ownerId || session.userId || undefined;
}

/** Роль аудита инстанса (`AUDITOR`) у принципала хода. */
function isInstanceAuditor(ctx: ToolContext): boolean {
  const roles = principalOf(ctx)?.roles ?? [];
  return roles.some((role) => role.toUpperCase() === 'AUDITOR');
}

/**
 * Доступ к чтению диагностики сессии (fail-closed): владелец сессии, `ADMIN`
 * инстанса или `AUDITOR`. Нет принципала — только владелец по фоллбеку
 * идентичности (`resolveViewer`), ADMIN/AUDITOR не выводятся.
 */
function canReadSession(ctx: ToolContext, session: Session, viewer: ProjectViewer): boolean {
  if (isInstanceAdmin(ctx)) return true;
  if (isInstanceAuditor(ctx)) return true;
  const owner = sessionOwnerId(session);
  return owner !== undefined && owner === viewer.userId;
}

/**
 * Цепочка наследования прав: `[сессия, родитель, …, корень]`.
 *
 * Собственный обход нужен **только для атрибуции источника** правила (своё /
 * родителя / инстанса): сам резолв делает `resolveEffectivePermission`, и его
 * результат — источник истины. Обход повторяет его предохранители (потолок
 * глубины, защита от циклов, висячий `parentId`), поэтому «источник» не может
 * разойтись с «действующим значением» по составу цепочки.
 */
async function permissionChain(
  session: Session,
  getSession: (id: string) => Promise<Session | null | undefined>,
): Promise<Session[]> {
  const chain: Session[] = [session];
  const visited = new Set<string>([session.id]);
  let current = session;
  while (current.parentId) {
    if (chain.length >= MAX_PERMISSION_PARENT_DEPTH) break;
    const parentId = current.parentId;
    if (visited.has(parentId)) break;
    let parent: Session | null | undefined;
    try {
      parent = await getSession(parentId);
    } catch {
      break;
    }
    if (!parent) break;
    visited.add(parent.id);
    chain.push(parent);
    current = parent;
  }
  return chain;
}

/** Откуда взялось действующее правило (`session` — своё, `parent` — предок). */
type RuleSource = 'session' | 'parent' | 'instance';

/** Снимок одного действующего правила с источником. */
interface RuleEntry {
  key: string;
  rule: PermissionRule;
  source: RuleSource;
  /** Какой именно предок дал правило (`parent_session_id`) — только для `parent`. */
  parent_session_id?: string;
}

/** Действующие правила и `askTimeoutMs` вместе с источниками. */
interface EffectivePermissionSnapshot {
  rules: RuleEntry[];
  ask_timeout_ms: number;
  ask_timeout_source: RuleSource | 'default';
}

/**
 * Действующие правила сессии с указанием источника каждого правила.
 *
 * Значение берётся из `resolveEffectivePermission` (живой резолв по цепочке
 * `parentId`, ADR-029 chain-no-copy); источник — первый уровень цепочки
 * (лист → корень), где ключ встречается: лист → `session`, предок → `parent`,
 * ключ есть только в базе инстанса → `instance`.
 */
async function effectivePermissionSnapshot(
  session: Session,
  manager: SessionManager,
  base: PermissionConfig | undefined,
): Promise<EffectivePermissionSnapshot> {
  const effective = await resolveEffectivePermission({
    session,
    getSession: (id) => manager.getSession(id),
    ...(base ? { fallback: base } : {}),
  });
  const chain = await permissionChain(session, (id) => manager.getSession(id));

  const entries: RuleEntry[] = [];
  for (const [key, rule] of Object.entries(effective.rules)) {
    const index = chain.findIndex(
      (node) => node.settings?.permission?.rules
        && Object.prototype.hasOwnProperty.call(node.settings.permission.rules, key),
    );
    if (index === 0) {
      entries.push({ key, rule, source: 'session' });
    } else if (index > 0) {
      entries.push({ key, rule, source: 'parent', parent_session_id: chain[index]!.id });
    } else {
      entries.push({ key, rule, source: 'instance' });
    }
  }
  // Порядок ключей — стабильный (модель читает снимок сверху вниз).
  entries.sort((a, b) => a.key.localeCompare(b.key));

  const askTimeout = askTimeoutSource(session, chain, base);
  return {
    rules: entries,
    ask_timeout_ms: effective.askTimeoutMs,
    ask_timeout_source: askTimeout,
  };
}

/** Источник действующего `askTimeoutMs`: своё → предок → база инстанса → дефолт. */
function askTimeoutSource(
  session: Session,
  chain: Session[],
  base: PermissionConfig | undefined,
): RuleSource | 'default' {
  if (typeof session.settings?.permission?.askTimeoutMs === 'number') return 'session';
  if (chain.slice(1).some((node) => typeof node.settings?.permission?.askTimeoutMs === 'number')) {
    return 'parent';
  }
  if (typeof base?.askTimeoutMs === 'number') return 'instance';
  return 'default';
}

/** Последняя durable-запись причины остановки хода (PROP-143) — метаданные. */
function stopReasonOf(session: Session): Record<string, unknown> | null {
  for (let index = session.messages.length - 1; index >= 0; index -= 1) {
    const message = session.messages[index]!;
    if (message.metadata?.type !== STOP_MESSAGE_TYPE) continue;
    const meta = message.metadata ?? {};
    const str = (key: string): string | undefined =>
      typeof meta[key] === 'string' ? (meta[key] as string) : undefined;
    return {
      reason: str('reason') ?? null,
      stopped_at: str('stopped_at') ?? message.createdAt ?? null,
      ...(str('error_type') !== undefined ? { error_type: str('error_type') } : {}),
      ...(str('finish_reason') !== undefined ? { finish_reason: str('finish_reason') } : {}),
      ...(typeof meta.retryable === 'boolean' ? { retryable: meta.retryable } : {}),
      ...(typeof meta.attempts === 'number' ? { attempts: meta.attempts } : {}),
      turn_id: str('turn_id') ?? null,
    };
  }
  return null;
}

/** Счётчики сообщений истории: всего и по ролям (без текста). */
function messageCounters(session: Session): { total: number; by_role: Record<string, number> } {
  const byRole: Record<string, number> = {};
  const messages = Array.isArray(session.messages) ? session.messages : [];
  for (const message of messages) {
    const role = String(message.role);
    byRole[role] = (byRole[role] ?? 0) + 1;
  }
  return { total: messages.length, by_role: byRole };
}

/** Краткая запись ожидания подтверждения (без аргументов вызова). */
function pendingBrief(record: PendingApprovalRecord): Record<string, unknown> {
  return {
    approval_id: record.approvalId,
    tool_name: record.toolName,
    reason: record.reason,
    asked_at: record.askedAt,
    timeout_ms: record.timeoutMs,
    ...(record.trigger?.matchedRule ? { matched_rule: record.trigger.matchedRule } : {}),
    ...(record.trigger?.askKind ? { ask_kind: record.trigger.askKind } : {}),
  };
}

/** Компактный статус сессии (без истории). */
function statusOf(session: Session): Record<string, unknown> {
  return {
    blocked: session.status?.blocked ?? null,
    cancel_requested: Boolean(session.status?.cancelRequested),
    queue_stopped: Boolean(session.status?.queueStopped),
  };
}

/** Полный снимок одной сессии: режим, агент, модель, статус, причина остановки. */
async function sessionSnapshot(
  ctx: ToolContext,
  session: Session,
  manager: SessionManager,
  viewer: ProjectViewer,
): Promise<Record<string, unknown>> {
  const extra = getExtra(ctx);
  const deps = extra.diagnostics;
  const settings = session.settings ?? ({} as Session['settings']);
  const base = deps?.getInstancePermission?.();
  const permissions = await effectivePermissionSnapshot(session, manager, base);

  let pending: Record<string, unknown> | null = null;
  if (deps?.pendingApprovals) {
    try {
      const records = await deps.pendingApprovals.list(session.id);
      pending = {
        count: records.length,
        items: records.slice(0, MAX_PENDING_IN_SNAPSHOT).map(pendingBrief),
      };
    } catch {
      pending = { count: null, items: [], error: 'unavailable' };
    }
  }

  return {
    session_id: session.id,
    title: session.title || null,
    project_id: session.projectId ?? null,
    parent_session_id: session.parentId ?? null,
    owner_id: sessionOwnerId(session) ?? null,
    session_origin: session.sessionOrigin,
    mode: session.mode ?? null,
    plan_approved: Boolean(session.planApproved),
    agent_role: settings.agentRole ?? null,
    provider: settings.provider ?? null,
    model: settings.model ?? null,
    effort: settings.effort ?? null,
    status: statusOf(session),
    streaming: Boolean(session.currentStream),
    current_stream: session.currentStream
      ? {
        stream_id: session.currentStream.streamId ?? null,
        turn_id: session.currentStream.turnId ?? null,
      }
      : null,
    retry: session.retry
      ? { attempt: session.retry.attempt, max_retries: session.retry.maxRetries, retry_at: session.retry.retryAt }
      : null,
    stop_reason: stopReasonOf(session),
    messages: messageCounters(session),
    pending_count: session.pendingMessages?.length ?? 0,
    steer_count: session.steerInbox?.length ?? 0,
    approvals: pending,
    permissions: {
      ask_timeout_ms: permissions.ask_timeout_ms,
      ask_timeout_source: permissions.ask_timeout_source,
      // Действующие правила с источником: `session` — свои, `parent` —
      // унаследованные по цепочке `parentId`, `instance` — база инстанса.
      rules: permissions.rules,
    },
    created_at: session.createdAt ?? null,
    updated_at: session.updatedAt ?? null,
    viewer_id: viewer.userId,
  };
}

/** Может ли вызывающий видеть записи журнала этой сессии (по её документу). */
async function ownerOfSession(
  manager: SessionManager,
  sessionId: string,
): Promise<string | undefined> {
  try {
    const session = await manager.getSession(sessionId);
    return session ? sessionOwnerId(session) : undefined;
  } catch {
    return undefined;
  }
}

/** Снимок записи журнала решений — только перечисленные поля (без секретов). */
/**
 * Снимок записи аудита — `before` поверх которого лежит `after`.
 *
 * Часть записей несёт данные **только в одном** из полей: решение по
 * подтверждению — в `after`, а снятие сессионного правила (`revoke`) — в
 * `before` (`after: null`). Читая только `after`, журнал терял `revoke`-записи:
 * они не находились фильтром по сессии и не имели имени тула.
 */
function auditSnapshot(entry: SecurityAuditEntry): Record<string, unknown> {
  const pick = (value: unknown): Record<string, unknown> | undefined =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  return { ...(pick(entry.before) ?? {}), ...(pick(entry.after) ?? {}) };
}

function journalEntry(entry: SecurityAuditEntry): Record<string, unknown> {
  const after = auditSnapshot(entry);
  const str = (key: string): string | undefined =>
    typeof after[key] === 'string' ? (after[key] as string) : undefined;
  // `revoke` пишет имя тула ключом `tool`, решения — `toolName`.
  const toolName = str('toolName') ?? str('tool');
  const granted = after.granted && typeof after.granted === 'object'
    ? after.granted as Record<string, unknown>
    : undefined;
  return {
    id: entry.id,
    ts: entry.ts,
    actor: entry.actor,
    action: entry.action,
    ...(typeof after.sessionId === 'string' && after.sessionId !== ''
      ? { session_id: after.sessionId }
      : {}),
    ...(toolName !== undefined ? { tool_name: toolName } : {}),
    ...(str('outcome') !== undefined ? { outcome: str('outcome') } : {}),
    ...(str('matchedRule') !== undefined ? { matched_rule: str('matchedRule') } : {}),
    ...(str('askKind') !== undefined ? { ask_kind: str('askKind') } : {}),
    ...(typeof after.once === 'boolean' ? { once: after.once } : {}),
    ...(granted
      ? {
        granted: {
          patterns: Array.isArray(granted.patterns) ? granted.patterns : [],
          directories: Array.isArray(granted.directories) ? granted.directories : [],
        },
      }
      : {}),
  };
}

/** Сессия записи журнала (для фильтра по `session_id` и по доступу). */
function journalSessionId(entry: SecurityAuditEntry): string | undefined {
  const value = auditSnapshot(entry).sessionId;
  return typeof value === 'string' && value !== '' ? value : undefined;
}

// ──────────────────────────── synth_session_inspect ───────────────────────────

const sessionInspectSchema = z.object({
  session_id: z.string().optional()
    .describe('Session id to inspect (from synth_sessions_active / list_sessions)'),
  project_id: z.string().optional()
    .describe('Without session_id: list diagnostics of the sessions of this project (project id)'),
  limit: z.number().int().min(1).max(MAX_INSPECT_SESSIONS).optional()
    .describe(`Without session_id: how many sessions to show (1..${MAX_INSPECT_SESSIONS}, default 10)`),
});

export const synthSessionInspectTool: ToolDefinition = {
  name: 'synth_session_inspect',
  description:
    'Diagnostics of a session (read-only): mode (plan/act), plan_approved, agent role, provider/model/effort, '
    + 'status (blocked, cancel_requested, queue_stopped), streaming/retry, the durable stop reason (last '
    + 'execution_stopped record: reason, error_type, finish_reason), message counters (total and by role), '
    + 'queued/steering counts, pending approvals (count and a short list) and the EFFECTIVE permission rules '
    + 'with the source of each rule (session = this session, parent = inherited through the parentId chain, '
    + 'instance = instance base) plus the source of askTimeoutMs. Without session_id it lists such snapshots '
    + 'for the sessions visible to you (optionally filtered by project_id, limit 1..25). Allowed to the session '
    + "owner, an instance ADMIN or an AUDITOR; message text and secrets are never included (use "
    + 'synth_session_history with include_text for text).',
  parameters: sessionInspectSchema,
  capabilities: [ToolCapability.DIAGNOSTICS],
  async execute(args, ctx) {
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) return argErrorResult(this.name, parsed.error.issues);
    const params = parsed.data as { session_id?: string; project_id?: string; limit?: number };
    const manager = managerOf(ctx, this.name);
    if (isResult(manager)) return manager;

    const extra = getExtra(ctx);
    const viewer = await resolveViewer(ctx, extra);
    const sessionId = params.session_id?.trim();

    if (sessionId) {
      const session = await manager.getSession(sessionId);
      if (!session) return fail('session.not_found', { id: sessionId });
      if (!canReadSession(ctx, session, viewer)) return fail('session.forbidden', { id: sessionId });
      const snapshot = await sessionSnapshot(ctx, session, manager, viewer);
      return ok('diagnostics.session.inspect', { id: sessionId, json: JSON.stringify(snapshot) }, {
        session: snapshot,
      });
    }

    // Режим списка: только сессии, которые вызывающему разрешено читать.
    // Elevated (ADMIN/AUDITOR) видит всё — тот же объём, что и по `session_id`
    // (иначе AUDITOR мог прочитать любую сессию точечно, но не перечислить их).
    const limit = params.limit ?? 10;
    const projectFilter = params.project_id?.trim();
    const all = isInstanceAdmin(ctx) || isInstanceAuditor(ctx)
      ? await manager.listSessions()
      : await listVisibleSessions(extra, viewer);
    const accessible = all.filter((session) => canReadSession(ctx, session, viewer));
    const scoped = projectFilter
      ? accessible.filter((session) => session.projectId === projectFilter)
      : accessible;
    const sorted = [...scoped].sort(
      (a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || a.id.localeCompare(b.id),
    );
    const shown = sorted.slice(0, limit);
    const snapshots: Record<string, unknown>[] = [];
    for (const session of shown) {
      // `listSessions` отдаёт сводки без истории — снимку нужен документ.
      const full = await manager.getSession(session.id);
      if (!full) continue;
      snapshots.push(await sessionSnapshot(ctx, full, manager, viewer));
    }

    if (snapshots.length === 0) {
      return { content: sm('session.list_empty'), metadata: { sessions: [], i18n: i18nMeta('session.list_empty') } };
    }
    return ok(
      'diagnostics.session.inspect_list',
      { count: String(snapshots.length), json: JSON.stringify(snapshots) },
      { sessions: snapshots, total: scoped.length, truncated: scoped.length > snapshots.length },
    );
  },
};

// ────────────────────────── synth_permission_journal ──────────────────────────

const permissionJournalSchema = z.object({
  limit: z.number().int().min(1).max(MAX_JOURNAL_LIMIT).optional()
    .describe(`How many journal entries to read (1..${MAX_JOURNAL_LIMIT}, default ${DEFAULT_JOURNAL_LIMIT})`),
  session_id: z.string().optional().describe('Only decisions of this session'),
  action: z.enum(['allow', 'deny', 'revoke', 'update', 'all']).optional()
    .describe('Filter by decision action (default all)'),
});

export const synthPermissionJournalTool: ToolDefinition = {
  name: 'synth_permission_journal',
  description:
    'Permission decision journal (read-only, security audit scope "permission"): the last decisions with ts, '
    + 'actor, action (allow/deny/revoke/update), tool_name, outcome (user/timeout/cascade/cancelled/rule), '
    + 'matched_rule, ask_kind, once and granted (the rules actually written to the session). Use it to answer '
    + '"why did it ask" and "why was it denied". Without session_id the journal is filtered to sessions you may '
    + 'read (owner, ADMIN or AUDITOR) — an entry without a session is shown only to its actor; ADMIN/AUDITOR see '
    + 'everything. Filters are applied to the returned page (newest first). No command lines, paths or secrets '
    + 'are included.',
  parameters: permissionJournalSchema,
  capabilities: [ToolCapability.DIAGNOSTICS],
  async execute(args, ctx) {
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) return argErrorResult(this.name, parsed.error.issues);
    const params = parsed.data as { limit?: number; session_id?: string; action?: string };
    const port = auditPort(ctx, this.name);
    if (isResult(port)) return port;
    const manager = managerOf(ctx, this.name);
    if (isResult(manager)) return manager;

    const extra = getExtra(ctx);
    const viewer = await resolveViewer(ctx, extra);
    const limit = params.limit ?? DEFAULT_JOURNAL_LIMIT;
    const sessionId = params.session_id?.trim();
    const action = params.action ?? 'all';

    // Явный фильтр по сессии: сначала доступ к ней (как у остальных тулов).
    if (sessionId) {
      const session = await manager.getSession(sessionId);
      if (!session) return fail('session.not_found', { id: sessionId });
      if (!canReadSession(ctx, session, viewer)) return fail('session.forbidden', { id: sessionId });
    }

    let entries: SecurityAuditEntry[];
    try {
      entries = await port.list({ scope: 'permission', limit });
    } catch {
      return fail('diagnostics.tool.deps_unavailable', { tool: this.name });
    }

    const filtered = sessionId
      ? entries.filter((entry) => journalSessionId(entry) === sessionId)
      : entries;
    const byAction = action === 'all'
      ? filtered
      : filtered.filter((entry) => entry.action === action);

    // Видимость: elevated (ADMIN/AUDITOR) — всё; иначе только свои сессии.
    const elevated = isInstanceAdmin(ctx) || isInstanceAuditor(ctx);
    let visible: SecurityAuditEntry[];
    if (elevated) {
      visible = byAction;
    } else if (sessionId) {
      // Доступ к сессии уже проверен выше — её записи показываем целиком.
      visible = byAction;
    } else {
      const sessionIds = [...new Set(
        byAction.map((entry) => journalSessionId(entry)).filter((id): id is string => id !== undefined),
      )];
      const owners = new Map<string, string | undefined>();
      for (const id of sessionIds) {
        owners.set(id, await ownerOfSession(manager, id));
      }
      visible = byAction.filter((entry) => {
        const entrySessionId = journalSessionId(entry);
        if (!entrySessionId) return entry.actor === viewer.userId;
        const owner = owners.get(entrySessionId);
        return owner !== undefined && owner === viewer.userId;
      });
    }

    const items = visible.map(journalEntry);
    if (items.length === 0) {
      return {
        content: sm('diagnostics.permission.journal_empty'),
        metadata: { entries: [], i18n: i18nMeta('diagnostics.permission.journal_empty') },
      };
    }
    return ok(
      'diagnostics.permission.journal',
      { count: String(items.length), json: JSON.stringify(items) },
      { entries: items, limit, action, scope: 'permission' },
    );
  },
};

// ──────────────────────────── synth_session_pending ───────────────────────────

const sessionPendingSchema = z.object({
  session_id: z.string().optional().describe('Only approvals of this session'),
  project_id: z.string().optional().describe('Only approvals of the sessions of this project (project id)'),
});

export const synthSessionPendingTool: ToolDefinition = {
  name: 'synth_session_pending',
  description:
    'Approvals waiting for a decision (read-only): entries of the pending-approval port with approval_id, '
    + 'tool_name, reason, trigger (matched_rule / ask_kind / params) and asked_at/timeout_ms. Use it to see what '
    + 'is blocking a turn right now (nothing pending is not an error). Without session_id only approvals of '
    + 'sessions you may read are returned (owner, ADMIN or AUDITOR), optionally filtered by project_id. Tool '
    + 'arguments are not included: no command lines or secrets.',
  parameters: sessionPendingSchema,
  capabilities: [ToolCapability.DIAGNOSTICS],
  async execute(args, ctx) {
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) return argErrorResult(this.name, parsed.error.issues);
    const params = parsed.data as { session_id?: string; project_id?: string };
    const port = pendingPort(ctx, this.name);
    if (isResult(port)) return port;
    const manager = managerOf(ctx, this.name);
    if (isResult(manager)) return manager;

    const extra = getExtra(ctx);
    const viewer = await resolveViewer(ctx, extra);
    const sessionId = params.session_id?.trim();
    const projectFilter = params.project_id?.trim();

    if (sessionId) {
      const session = await manager.getSession(sessionId);
      if (!session) return fail('session.not_found', { id: sessionId });
      if (!canReadSession(ctx, session, viewer)) return fail('session.forbidden', { id: sessionId });
    }

    let records: PendingApprovalRecord[];
    try {
      records = await port.list(sessionId);
    } catch {
      return fail('diagnostics.tool.deps_unavailable', { tool: this.name });
    }

    const elevated = isInstanceAdmin(ctx) || isInstanceAuditor(ctx);
    let visible = records;
    if (!sessionId && !elevated) {
      // Владелец записи известен из самой записи — без чтения сессии (её нет
      // в записи — fail-closed: чужие ожидания не показываем).
      visible = records.filter((record) => record.ownerId !== undefined && record.ownerId === viewer.userId);
    }
    if (projectFilter) {
      const projectSessions = new Set<string>();
      for (const recordSessionId of new Set(visible.map((record) => record.sessionId))) {
        try {
          const session = await manager.getSession(recordSessionId);
          if (session?.projectId === projectFilter) projectSessions.add(recordSessionId);
        } catch {
          // Сессию не прочитали — считаем «не из этого проекта» (fail-closed).
        }
      }
      visible = visible.filter((record) => projectSessions.has(record.sessionId));
    }

    const shown = visible.slice(0, MAX_PENDING_RECORDS);
    const items = shown.map((record) => ({
      ...pendingBrief(record),
      session_id: record.sessionId,
      ...(record.trigger?.params ? { trigger_params: record.trigger.params } : {}),
    }));

    if (items.length === 0) {
      return {
        content: sm('diagnostics.pending.empty'),
        metadata: { approvals: [], i18n: i18nMeta('diagnostics.pending.empty') },
      };
    }
    return ok(
      'diagnostics.pending.list',
      { count: String(items.length), json: JSON.stringify(items) },
      { approvals: items, total: visible.length, truncated: visible.length > items.length },
    );
  },
};

// ──────────────────────────── synth_session_history ───────────────────────────

const sessionHistorySchema = z.object({
  session_id: z.string().min(1).describe('Session id whose history tail is summarized'),
  tail: z.number().int().min(1).max(MAX_HISTORY_TAIL).optional()
    .describe(`How many last messages to summarize (1..${MAX_HISTORY_TAIL}, default ${DEFAULT_HISTORY_TAIL})`),
  include_text: z.boolean().optional()
    .describe('Include message text (default false; capped per message and for the whole answer)'),
});

/** Части сообщения по типам (без содержимого). */
function partTypesOf(message: Message): Record<string, number> {
  const result: Record<string, number> = {};
  const parts = Array.isArray(message.parts) ? message.parts : [];
  for (const part of parts) {
    const type = String(part.type);
    result[type] = (result[type] ?? 0) + 1;
  }
  return result;
}

/** Сводка одного сообщения истории; текст — только по флагу и в пределах лимита. */
function historyEntry(
  message: Message,
  index: number,
  includeText: boolean,
  budget: { left: number },
): Record<string, unknown> {
  const content = typeof message.content === 'string' ? message.content : '';
  const meta = message.metadata ?? {};
  const entry: Record<string, unknown> = {
    index,
    message_id: message.id,
    role: String(message.role),
    author: message.author ?? null,
    created_at: message.createdAt ?? null,
    parts: partTypesOf(message),
    chars: content.length,
    bytes: Buffer.byteLength(content, 'utf8'),
    has_tool_calls: Array.isArray(message.toolCalls) ? message.toolCalls.length > 0 : false,
    tool_call_id: message.toolCallId ?? null,
    ...(typeof meta.type === 'string' ? { type: meta.type } : {}),
    ...(typeof meta.reason === 'string' ? { stop_reason: meta.reason } : {}),
    ...(typeof meta.finish_reason === 'string' ? { finish_reason: meta.finish_reason } : {}),
    ...(message.disabled === true ? { disabled: true } : {}),
    ...(message.hidden === true ? { hidden: true } : {}),
    ...(message.ephemeral === true ? { ephemeral: true } : {}),
  };
  if (!includeText) return entry;
  if (budget.left <= 0) {
    entry.text_omitted = true;
    return entry;
  }
  const max = Math.min(MAX_HISTORY_TEXT_CHARS, budget.left);
  const text = content.length > max ? `${content.slice(0, max - 1)}…` : content;
  budget.left -= text.length;
  entry.text = text;
  if (text.length < content.length) entry.text_truncated = true;
  return entry;
}

export const synthSessionHistoryTool: ToolDefinition = {
  name: 'synth_session_history',
  description:
    'History tail summary of a session (read-only): per message — role, author, part types, chars/bytes, '
    + 'finish_reason/stop_reason markers (execution_stopped reason, finish_reason) and whether it carries tool '
    + 'calls. Message TEXT is not returned by default: pass include_text: true to get it, capped per message '
    + `(${MAX_HISTORY_TEXT_CHARS} chars) and for the whole answer (${MAX_HISTORY_TOTAL_TEXT_CHARS} chars); the `
    + `tail is capped at ${MAX_HISTORY_TAIL} messages. Use it to see what shape a turn had (tool calls, stop `
    + 'reason, empty answers) without dumping the conversation. Allowed to the session owner, an instance ADMIN '
    + 'or an AUDITOR.',
  parameters: sessionHistorySchema,
  capabilities: [ToolCapability.DIAGNOSTICS],
  async execute(args, ctx) {
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) return argErrorResult(this.name, parsed.error.issues);
    const params = parsed.data as { session_id: string; tail?: number; include_text?: boolean };
    const manager = managerOf(ctx, this.name);
    if (isResult(manager)) return manager;

    const extra = getExtra(ctx);
    const viewer = await resolveViewer(ctx, extra);
    const sessionId = params.session_id.trim();
    const session = await manager.getSession(sessionId);
    if (!session) return fail('session.not_found', { id: sessionId });
    if (!canReadSession(ctx, session, viewer)) return fail('session.forbidden', { id: sessionId });

    const messages = Array.isArray(session.messages) ? session.messages : [];
    if (messages.length === 0) {
      return {
        content: sm('diagnostics.history.empty', { id: sessionId }),
        metadata: { session_id: sessionId, messages: [], i18n: i18nMeta('diagnostics.history.empty', { id: sessionId }) },
      };
    }

    const tail = params.tail ?? DEFAULT_HISTORY_TAIL;
    const includeText = params.include_text === true;
    const start = Math.max(0, messages.length - tail);
    const budget = { left: includeText ? MAX_HISTORY_TOTAL_TEXT_CHARS : 0 };
    const items = messages
      .slice(start)
      .map((message, offset) => historyEntry(message, start + offset, includeText, budget));

    return ok(
      'diagnostics.history.summary',
      {
        id: sessionId,
        tail: String(items.length),
        total: String(messages.length),
        json: JSON.stringify(items),
      },
      {
        session_id: sessionId,
        messages: items,
        total: messages.length,
        tail: items.length,
        include_text: includeText,
        text_budget_left: budget.left,
      },
    );
  },
};

/** Все тулы диагностики сессии (регистрация — `engine/tools/index.ts`). */
export const diagnosticsTools: ToolDefinition[] = [
  synthSessionInspectTool,
  synthPermissionJournalTool,
  synthSessionPendingTool,
  synthSessionHistoryTool,
];

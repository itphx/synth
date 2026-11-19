/**
 * Сессии инстанса из чата: `synth_sessions_active`, `synth_session_stop`,
 * `synth_session_resume`.
 *
 * ## Зачем
 *
 * Обзор работы инстанса и управление ею («что сейчас работает», «останови
 * сессию», «продолжи после остановки») были доступны только через HTTP
 * (`GET /api/v2/sessions`, `POST /:id/abort`, `POST /:id/resume-subagent`) и UI.
 * Агент-хранитель инстанса (`keeper`) перед обслуживанием/рестартом не мог ни
 * увидеть, кто работает прямо сейчас, ни штатно притормозить ход, ни
 * возобновить его после подъёма — он объяснял человеку, куда идти.
 *
 * ## Границы (паритет с HTTP-роутами `createSessionRoutes`)
 *
 * - **«Стоп» — тот же путь, что у роута.** `synth_session_stop` вызывает
 *   `sessions/turn-abort.ts` (`abortSessionTurn`) через прокладку
 *   `extra.sessionControl.abortTurn`: флаг отмены, отмена стрима, остановка
 *   процессора, снятие steer-инъекций и сохранение очереди — одна семантика на
 *   обе поверхности. Фоновые прогоны «Стоп» не гасит (решение 2026-10-31):
 *   тул отвечает подсказкой про `process_stop`, а не глушит их сам.
 * - **Возобновление идёт штатным funnel'ом.** Сабагент (`parentId != null`) —
 *   цикл саб-агента (`orchestrator.startSubagentResume`, режим `subagent`);
 *   обычная сессия — служебное сообщение `metadata.type='resume_notice'` в
 *   очередь через `enqueueUserMessage` (ADR-089/ADR-118): сессию **не**
 *   создаём (`RequestSessionService`/`createSession` не вызываются), очередь
 *   поднимает процессор — как у обычного ввода.
 * - **Права (fail-closed).** Управлять сессией может её владелец
 *   (`ownerId`/`userId` = принципал хода) **или** ADMIN инстанса
 *   (`isInstanceAdmin`: роль `ADMIN` либо локальный владелец standalone —
 *   паритет с локальным API-ключом). Иначе — `session.forbidden`; отсутствие
 *   сессии и чужая сессия для не-админа неотличимы по коду (`session.forbidden`
 *   на первом шаге доступа нельзя выдавать существование чужого ресурса
 *   лишний раз — сначала читаем сессию, затем решаем: нет сессии →
 *   `session.not_found`).
 * - **В plan-режиме доступен только снимок**: write-имена
 *   (`synth_session_stop`/`synth_session_resume`) блокирует permission-слой
 *   (`permission/evaluator.ts` → `isPlanBlockedTool`, список
 *   `SESSIONS_WRITE_TOOLS`), а не проверка внутри `execute` (ADR-025/ADR-029).
 * - **Снимок — только метаданные и счётчики.** Ни текста сообщений, ни промптов,
 *   ни значений секретов: id, заголовок, проект, роль агента, признаки
 *   активности, счётчики очереди/прогонов/терминалов/подтверждений и время
 *   последней активности. Видимость — та же, что у `GET /api/v2/sessions`
 *   (elevated видят всё, остальные — свои сессии и сессии проектов участия).
 * - Тексты — через ключи `shared/i18n` (ADR-041): `content` — en-текст для
 *   модели, `metadata.i18n` — шаблон и параметры для UI.
 */
import { MessageRole, generateId, makeTextPart, nowISO } from '@itphx/synth-shared';
import { z } from 'zod';
import { ToolCapability } from '@itphx/synth-shared';
import type { Message, Session, ToolContext, ToolDefinition, ToolResult } from '@itphx/synth-shared';
import type { SessionManager } from '../../sessions/manager.js';
import type { ProjectStoreContract } from '../../storage/project-store.js';
import type { AbortSessionTurnResult } from '../../sessions/turn-abort.js';
import { SubagentResumeError } from './task/resume-target.js';
import { isAborted, abortedResult } from './abort.js';
import { t as sm, i18n as i18nMeta } from '../system-messages.js';
import { argErrorResult } from './arg-error.js';
import { isInstanceAdmin } from './instance-auth.js';
import type { InstanceRuntimeMeta } from '../instance/meta.js';
import {
  type PrincipalExtra,
  resolveViewer,
  type ToolPrincipal,
  type ProjectViewer,
} from './project-resolve.js';
import { listVisibleSessions } from './session-manage.js';

/**
 * Итог возобновления сабагента (`orchestrator.startSubagentResume`).
 *
 * Структурный тип вместо импорта класса оркестратора: тул не зависит от
 * реализации (прокладка — точка сборки), а поля совпадают с ответом HTTP-роута
 * `POST /:id/resume-subagent`.
 */
export interface SubagentResumeOutcome {
  child_session_id: string;
  parent_session_id: string;
  stream_id: string;
}

/**
 * Прокладка зависимостей тулов сессий (`ToolContext.extra.sessionControl`).
 *
 * Собирается в точке сборки (`server/app/deps.ts`, `backend/app/deps.ts`), где
 * `sessionManager`/`eventBus`/`queueManager`/`processMessage`/`orchestrator` —
 * в одном скоупе; тулы не создают сервисов и процессоров сами.
 */
export interface SessionControlDeps {
  /**
   * «Стоп» хода — единая семантика `sessions/turn-abort.ts` (тот же вызов, что
   * у `POST /:id/abort`). `null` — сессии нет.
   */
  abortTurn: (
    sessionId: string,
    session: Session | null,
  ) => Promise<AbortSessionTurnResult | null>;
  /**
   * Возобновление прерванной/упавшей дочерней сессии саб-агента — цикл
   * саб-агента (`orchestrator.startSubagentResume`). Ошибки доступа/состояния —
   * `SubagentResumeError` (маппятся в `session.conflict`/`session.not_found`).
   */
  resumeSubagent: (sessionId: string, note?: string) => Promise<SubagentResumeOutcome>;
  /**
   * Постановка служебного сообщения-продолжения в обычную сессию — штатный
   * funnel `enqueueUserMessage` (ADR-089/ADR-118): очередь + автоход
   * процессора. `false` — очередь переполнена либо сессии уже нет.
   */
  enqueueContinuation: (sessionId: string, message: Message) => Promise<boolean>;
  /** Живой процессор очереди сессии (признак активности в снимке). */
  isProcessorRunning?: (sessionId: string) => boolean;
  /**
   * Число ожидающих подтверждений по сессиям (ADR-029,
   * `PermissionApprovalManager.listPendingCounts`): `sessionId → count`.
   */
  approvalCounts?: () => ReadonlyMap<string, number>;
  /**
   * Живые фоновые прогоны по сессиям (ADR-111/ADR-113): `sessionId → count`.
   * Один проход по реестру — снимок показывает все сессии сразу.
   */
  backgroundRuns?: () => Promise<ReadonlyMap<string, number>>;
  /**
   * Живые терминалы по сессиям (PROP-132): `sessionId → count`.
   * Терминал без привязки к сессии в снимок не попадает.
   */
  terminals?: () => ReadonlyMap<string, number>;
}

/** Поля `extra`, которые читают тулы сессий. */
export interface SessionControlExtra extends PrincipalExtra {
  sessionControl?: SessionControlDeps;
  sessionManager?: SessionManager;
  projectStore?: ProjectStoreContract;
  /** Снимок метаданных инстанса (режим — для ADMIN-паритета standalone). */
  instanceMeta?: InstanceRuntimeMeta;
}

/** Предел числа сессий в одном снимке (краткость для модели). */
const MAX_SNAPSHOT_SESSIONS = 50;

/** Допустимая длина `reason`/`note` (краткость и защита от «простыни»). */
const MAX_TEXT_PARAM = 500;

function getExtra(ctx: ToolContext): SessionControlExtra {
  return (ctx.extra ?? {}) as SessionControlExtra;
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

/** Зависимости тула: нет прокладки — понятная ошибка, а не исключение. */
function controlDeps(ctx: ToolContext, toolName: string): SessionControlDeps | ToolResult {
  const control = getExtra(ctx).sessionControl;
  if (!control?.abortTurn || !control.resumeSubagent || !control.enqueueContinuation) {
    return fail('session.tool.deps_unavailable', { tool: toolName });
  }
  return control;
}

function isResult(value: unknown): value is ToolResult {
  return typeof value === 'object' && value !== null && (value as { isError?: unknown }).isError === true;
}

/** Владелец сессии (legacy-поле `userId` — фоллбек, как у DTO/списков). */
function sessionOwnerId(session: Session): string | undefined {
  return session.ownerId || session.userId || undefined;
}

/**
 * Доступ к управлению сессией (fail-closed): владелец **или** ADMIN инстанса.
 *
 * Та же пара правил, что у HTTP-границы (владелец ресурса или администратор) и
 * у `synth_mcp_*`/`synth_agent_*` (`isInstanceAdmin` — режим инстанса учитывает
 * standalone-владельца).
 */
function canControlSession(ctx: ToolContext, session: Session, viewer: ProjectViewer): boolean {
  if (isInstanceAdmin(ctx)) return true;
  const owner = sessionOwnerId(session);
  return owner !== undefined && owner === viewer.userId;
}

/** Принципал хода (для metadata — «кто остановил»). */
function actorOf(ctx: ToolContext): string | undefined {
  const principal: ToolPrincipal | undefined = getExtra(ctx).principal;
  return principal?.userId;
}

/** Безопасное чтение карты счётчиков (сбой реестра не ломает снимок). */
async function safeCounts(
  read: (() => Promise<ReadonlyMap<string, number>>) | undefined,
): Promise<ReadonlyMap<string, number>> {
  if (!read) return new Map();
  try {
    return await read();
  } catch {
    return new Map();
  }
}

/** Синхронный вариант `safeCounts` (терминалы живут в памяти процесса). */
function safeCountsSync(
  read: (() => ReadonlyMap<string, number>) | undefined,
): ReadonlyMap<string, number> {
  if (!read) return new Map();
  try {
    return read();
  } catch {
    return new Map();
  }
}

/** Обрезать пользовательский текст-параметр (устойчивость к «простыням»). */
function clampText(value: string | undefined): string | undefined {
  const text = (value ?? '').trim();
  if (!text) return undefined;
  return text.length > MAX_TEXT_PARAM ? `${text.slice(0, MAX_TEXT_PARAM)}…` : text;
}

/** Снимок одной сессии — только метаданные и счётчики (без текста сообщений). */
interface SessionActivitySnapshot {
  session_id: string;
  title: string | null;
  project_id: string | null;
  agent_role: string | null;
  streaming: boolean;
  pending: number;
  background_runs: number;
  terminals: number;
  approvals: number;
  last_activity: string | null;
}

/**
 * Работает ли сессия прямо сейчас.
 *
 * Признаки: активный стрим хода, живой процессор очереди, непустая очередь,
 * фоновые прогоны и висящие подтверждения. Живые терминалы — отдельный счётчик
 * (открытая оболочка не означает идущий ход), в признак активности не входят.
 */
function isWorking(snapshot: SessionActivitySnapshot): boolean {
  return snapshot.streaming
    || snapshot.pending > 0
    || snapshot.background_runs > 0
    || snapshot.approvals > 0;
}

/** Сбой реестра процессоров не должен ломать снимок — `false`. */
function safeProcessorRunning(
  read: ((sessionId: string) => boolean) | undefined,
  sessionId: string,
): boolean {
  if (!read) return false;
  try {
    return read(sessionId) === true;
  } catch {
    return false;
  }
}

// ──────────────────────────── synth_sessions_active ────────────────────────────

const sessionsActiveSchema = z.object({
  project_id: z.string().optional()
    .describe('Only sessions of this project (project id)'),
  include_idle: z.boolean().optional()
    .describe('Include idle sessions without any activity (default true); false — only working sessions'),
});

export const synthSessionsActiveTool: ToolDefinition = {
  name: 'synth_sessions_active',
  description:
    'Snapshot of the work currently going on in the instance (read-only). For every session visible to the '
    + 'caller: session_id, title, project_id, agent_role, streaming (active turn or live queue processor), '
    + 'pending (queued messages), background_runs (running background runs), terminals (live terminals of '
    + 'that session), approvals (pending tool-approval requests) and last_activity. Plus a summary '
    + '{working, idle, total}. No message text is returned. Optional project_id filter and include_idle: '
    + 'false to see only working sessions. Use it before restarting or stopping work on the instance.',
  parameters: sessionsActiveSchema,
  capabilities: [ToolCapability.SESSIONS],
  async execute(args, ctx) {
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) return argErrorResult(this.name, parsed.error.issues);
    const params = parsed.data as { project_id?: string; include_idle?: boolean };

    const extra = getExtra(ctx);
    if (!extra.sessionManager) {
      return fail('session.tool.deps_unavailable', { tool: this.name });
    }

    const viewer = await resolveViewer(ctx, extra);
    const control = extra.sessionControl;
    const all = await listVisibleSessions(extra, viewer);
    const projectFilter = params.project_id?.trim();
    const sessions = projectFilter
      ? all.filter((session) => session.projectId === projectFilter)
      : all;

    // Счётчики — по одному проходу на реестр (а не по вызову на сессию).
    const backgroundRuns = await safeCounts(control?.backgroundRuns);
    const terminals = safeCountsSync(control?.terminals);
    const approvals = safeCountsSync(control?.approvalCounts);
    const isProcessorRunning = control?.isProcessorRunning;

    const items: SessionActivitySnapshot[] = sessions
      .map((session) => ({
        session_id: session.id,
        title: session.title || null,
        project_id: session.projectId ?? null,
        agent_role: session.settings.agentRole ?? null,
        // Живой процессор при отсутствующем `currentStream` — ход в подготовке
        // (между итерациями/в очереди): сессия всё равно работает.
        streaming: Boolean(session.currentStream)
          || Boolean(safeProcessorRunning(isProcessorRunning, session.id)),
        pending: session.pendingMessages?.length ?? 0,
        background_runs: backgroundRuns.get(session.id) ?? 0,
        terminals: terminals.get(session.id) ?? 0,
        approvals: approvals.get(session.id) ?? 0,
        last_activity: session.updatedAt || null,
      }))
      // Свежая активность — выше: модель читает снимок сверху вниз.
      .sort((a, b) => (b.last_activity ?? '').localeCompare(a.last_activity ?? '')
        || a.session_id.localeCompare(b.session_id));

    const working = items.filter(isWorking).length;
    const summary = {
      working,
      idle: items.length - working,
      total: items.length,
    };
    const shown = params.include_idle === false ? items.filter(isWorking) : items;
    const truncated = shown.length > MAX_SNAPSHOT_SESSIONS;
    const visible = shown.slice(0, MAX_SNAPSHOT_SESSIONS);

    const runsTotal = visible.reduce((sum, item) => sum + item.background_runs, 0);
    const terminalsTotal = visible.reduce((sum, item) => sum + item.terminals, 0);

    const base = {
      summary,
      sessions: visible,
      total: shown.length,
      truncated,
    };

    if (visible.length === 0) {
      return {
        content: sm('session.active.empty'),
        metadata: { ...base, i18n: i18nMeta('session.active.empty') },
      };
    }

    const paramsText = {
      sessions: String(visible.length),
      runs: String(runsTotal),
      terminals: String(terminalsTotal),
      json: JSON.stringify(visible),
    };
    return {
      content: sm('session.active.snapshot', paramsText),
      metadata: { ...base, i18n: i18nMeta('session.active.snapshot', paramsText) },
    };
  },
};

// ───────────────────────────── synth_session_stop ─────────────────────────────

const sessionStopSchema = z.object({
  session_id: z.string().min(1).describe('Session id to interrupt (from synth_sessions_active)'),
  reason: z.string().optional()
    .describe('Why the turn is interrupted (recorded in the tool answer, not in the session)'),
});

export const synthSessionStopTool: ToolDefinition = {
  name: 'synth_session_stop',
  description:
    'Interrupt the current turn of a session (write) — the same "Stop" as the UI button and '
    + 'POST /api/v2/sessions/:id/abort: the persistent cancel flag is set, the active stream is cancelled, '
    + 'the live queue processor is stopped, unapplied steering injections are returned to the queue. The '
    + 'queue itself is preserved. Background runs and background processes are NOT stopped by this tool — '
    + 'use process_stop for them. Allowed to the session owner and to an instance ADMIN. Nothing to stop is '
    + 'not an error: the answer reports stopped:false, was_running:false.',
  parameters: sessionStopSchema,
  capabilities: [ToolCapability.SESSIONS],
  async execute(args, ctx) {
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) return argErrorResult(this.name, parsed.error.issues);
    const params = parsed.data as { session_id: string; reason?: string };
    const sessionId = params.session_id.trim();

    const deps = controlDeps(ctx, this.name);
    if (isResult(deps)) return deps;
    const extra = getExtra(ctx);
    if (!extra.sessionManager) {
      return fail('session.tool.deps_unavailable', { tool: this.name });
    }

    const session = await extra.sessionManager.getSession(sessionId);
    if (!session) return fail('session.not_found', { id: sessionId });

    const viewer = await resolveViewer(ctx, extra);
    if (!canControlSession(ctx, session, viewer)) {
      return fail('session.forbidden', { id: sessionId });
    }

    let result: AbortSessionTurnResult | null;
    try {
      result = await deps.abortTurn(sessionId, session);
    } catch (err) {
      return fail('session.conflict', {
        id: sessionId,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
    if (!result) return fail('session.not_found', { id: sessionId });

    // Фоновые прогоны «Стоп» не гасит (решение 2026-10-31): сколько их осталось —
    // в ответе, чтобы модель сказала человеку про `process_stop`.
    const runs = await safeCounts(deps.backgroundRuns);
    const backgroundRuns = runs.get(sessionId) ?? 0;
    const reason = clampText(params.reason);
    const textParams = {
      id: sessionId,
      reason: reason ?? 'not specified',
      runs: String(backgroundRuns),
      was_running: String(result.wasRunning),
    };
    const details = {
      session_id: sessionId,
      stopped: result.wasRunning,
      was_running: result.wasRunning,
      processor_stopped: result.processorStopped,
      queue_stopped: result.queueStopped,
      pending: result.pending,
      background_runs: backgroundRuns,
      ...(reason !== undefined ? { reason } : {}),
      ...(actorOf(ctx) !== undefined ? { actor: actorOf(ctx) } : {}),
    };
    return {
      content: sm('session.stop.ok', textParams),
      metadata: { ...details, i18n: i18nMeta('session.stop.ok', textParams) },
    };
  },
};

// ──────────────────────────── synth_session_resume ────────────────────────────

const sessionResumeSchema = z.object({
  session_id: z.string().min(1).describe('Session id to resume (from synth_sessions_active)'),
  note: z.string().optional()
    .describe('Optional instruction added to the continuation (what to continue with)'),
});

export const synthSessionResumeTool: ToolDefinition = {
  name: 'synth_session_resume',
  description:
    'Resume work in a session that was interrupted by "Stop" or by a crash (write). A subagent child session '
    + 'is resumed by the subagent loop (the result is written to the parent session); a regular session gets a '
    + 'service continuation message queued through the normal message funnel, so the queue processor starts the '
    + 'turn as if the user had written it. No new session is created. Allowed to the session owner and to an '
    + 'instance ADMIN. An instance restart does not resume anything by itself — this tool is the explicit step.',
  parameters: sessionResumeSchema,
  capabilities: [ToolCapability.SESSIONS],
  async execute(args, ctx) {
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) return argErrorResult(this.name, parsed.error.issues);
    const params = parsed.data as { session_id: string; note?: string };
    const sessionId = params.session_id.trim();
    const note = clampText(params.note);

    const deps = controlDeps(ctx, this.name);
    if (isResult(deps)) return deps;
    const extra = getExtra(ctx);
    if (!extra.sessionManager) {
      return fail('session.tool.deps_unavailable', { tool: this.name });
    }

    const session = await extra.sessionManager.getSession(sessionId);
    if (!session) return fail('session.not_found', { id: sessionId });

    const viewer = await resolveViewer(ctx, extra);
    if (!canControlSession(ctx, session, viewer)) {
      return fail('session.forbidden', { id: sessionId });
    }

    // Сабагент: продолжение ведёт цикл саб-агента (тот же путь, что у
    // `POST /:id/resume-subagent`), итог пишется в родительскую сессию.
    if (session.parentId) {
      try {
        const started = await deps.resumeSubagent(sessionId, note);
        const textParams = { id: sessionId, mode: 'subagent' };
        return {
          content: sm('session.resume.ok', textParams),
          metadata: {
            session_id: sessionId,
            mode: 'subagent',
            resumed: true,
            child_session_id: started.child_session_id,
            parent_session_id: started.parent_session_id,
            stream_id: started.stream_id,
            ...(actorOf(ctx) !== undefined ? { actor: actorOf(ctx) } : {}),
            i18n: i18nMeta('session.resume.ok', textParams),
          },
        };
      } catch (err) {
        // Коды `SubagentResumeError` — паритет с HTTP-статусами роута: нет
        // ребёнка → `not_found`, всё остальное (занята/нет провайдера/родителя)
        // → `conflict` с причиной.
        const code = err instanceof SubagentResumeError ? err.code : null;
        if (code === 'NOT_FOUND' || code === 'PARENT_NOT_FOUND') {
          return fail('session.not_found', { id: sessionId });
        }
        return fail('session.conflict', {
          id: sessionId,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Обычная сессия: служебное сообщение-продолжение через штатный funnel
    // (`enqueueUserMessage`): очередь + автоход процессора. Сессию не создаём.
    const streamId = generateId();
    const notice = note === undefined
      ? sm('session.resume.notice')
      : `${sm('session.resume.notice')}\n\n${note}`;
    const message: Message = {
      id: generateId(),
      role: MessageRole.USER,
      seq: 0,
      origin: 'local',
      parts: [makeTextPart(notice)],
      content: notice,
      createdAt: nowISO(),
      disabled: false,
      pinned: false,
      hidden: false,
      // Служебное сообщение: видно модели и в ленте, но это не реплика человека.
      author: 'System',
      metadata: { type: 'resume_notice', stream_id: streamId },
    };

    let queued: boolean;
    try {
      queued = await deps.enqueueContinuation(sessionId, message);
    } catch (err) {
      return fail('session.conflict', {
        id: sessionId,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
    if (!queued) {
      // Сессия исчезла или очередь переполнена — это не «возобновлено».
      return fail('session.conflict', {
        id: sessionId,
        reason: 'the message queue is full or the session is gone — check synth_sessions_active',
      });
    }

    const textParams = { id: sessionId, mode: 'queue' };
    return {
      content: sm('session.resume.ok', textParams),
      metadata: {
        session_id: sessionId,
        mode: 'queue',
        resumed: true,
        message_id: message.id,
        stream_id: streamId,
        ...(note !== undefined ? { note } : {}),
        ...(actorOf(ctx) !== undefined ? { actor: actorOf(ctx) } : {}),
        i18n: i18nMeta('session.resume.ok', textParams),
      },
    };
  },
};

/** Все тулы сессий инстанса (регистрация — `engine/tools/index.ts`). */
export const instanceSessionTools: ToolDefinition[] = [
  synthSessionsActiveTool,
  synthSessionStopTool,
  synthSessionResumeTool,
];

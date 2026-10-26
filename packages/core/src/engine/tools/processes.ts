/**
 * Этап 1 roadmap 0.13 (блок 16): тулы реестра фоновых прогонов —
 * `process_list` и `process_logs`.
 *
 * Паритет с UI-вкладкой «Процессы» (ADR-111/PROP-097) и с opencode: агент
 * видит **тот же** реестр фоновой работы, что и человек, и может читать лог
 * фонового процесса, не выходя в HTTP API.
 *
 * ## Границы
 *
 * - **Скоуп — «своя сессия + дочерние».** Видны прогоны текущей сессии и
 *   прогонов её дочерних сессий (саб-агенты: у фонового прогона-саб-агента
 *   `sessionId` — родитель, `childSessionId` — ребёнок; у фонового процесса,
 *   запущенного внутри ребёнка, `sessionId` — сам ребёнок). Чужой прогон
 *   выглядит как отсутствующий (`process.tool.not_found`) — существование
 *   чужого ресурса не раскрывается.
 * - **Только чтение.** Ни один из тулов ничего не мутирует; в plan-режиме
 *   оба разрешены (см. `isPlanBlockedTool` — список блокируемых имён их не
 *   содержит).
 * - **Лог есть только у `kind: 'process'`.** У фонового саб-агента лога нет:
 *   его история живёт в дочерней сессии (`read_session_reference`).
 * - Тексты — только через ключи `shared/i18n` (ADR-041).
 */
import { z } from 'zod';
import { ToolCapability } from '@itphx/synth-shared';
import type {
  BackgroundRunKind,
  BackgroundRunRecord,
  BackgroundRunStatus,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '@itphx/synth-shared';
import type { BackgroundRunService } from '../background/service.js';
import type { ProcessService } from '../processes/service.js';
import type { SessionManager } from '../../sessions/manager.js';
import { isAborted, abortedResult } from './abort.js';
import { t as sm, i18n as i18nMeta } from '../system-messages.js';

/**
 * Зависимости тулов из `ToolContext.extra` (упаковка — оркестратор).
 *
 * - `backgroundService` — реестр фоновых прогонов (ADR-111): список и запись
 *   прогона. Не задан — реестр недоступен (`process.tool.deps_unavailable`).
 * - `processService` — сервис фоновых шелл-процессов (PROP-097): чтение лога.
 *   Не задан — лог процесса недоступен (`process.tool.deps_unavailable`).
 * - `sessionManager` — менеджер сессий: дочерние сессии (расширение скоупа).
 *   Не задан — виден только прогон текущей сессии.
 */
export interface ProcessToolsExtra {
  backgroundService?: BackgroundRunService;
  processService?: ProcessService;
  sessionManager?: SessionManager;
}

/** Дефолтный размер выборки реестра. */
const DEFAULT_LIMIT = 20;

/** Абсолютный потолок выборки реестра. */
const MAX_LIMIT = 100;

/** Дефолтный предел выдачи лога, байт. */
const DEFAULT_LOG_LIMIT = 16_384;

/** Абсолютный потолок выдачи лога за один вызов, байт. */
const MAX_LOG_LIMIT = 65_536;

/** Предел длины команды/описания прогона в строке списка, символов. */
const MAX_TEXT_CHARS = 80;

/** Предел длины summary прогона-саб-агента, символов. */
const MAX_SUMMARY_CHARS = 2_000;

/** Статусы прогона (фильтр `process_list`). */
const RUN_STATUSES = ['running', 'completed', 'failed', 'cancelled', 'orphaned'] as const;

/** Виды фоновой работы (фильтр `process_list`). */
const RUN_KINDS = ['subagent', 'process'] as const;

/** Единый текст ошибки разбора аргументов (как у соседних тулов). */
function argError(toolName: string, issues: z.ZodIssue[]): ToolResult {
  return {
    content: sm('tool.args_error', {
      tool: toolName,
      issues: issues.map((i) => `${i.path.join('.') || 'root'}: ${i.message}`).join('; '),
    }),
    isError: true,
    metadata: { i18n: i18nMeta('tool.args_error', { tool: toolName }) },
  };
}

/** Единый отказ «реестр недоступен» (сервис/реестр не подключены). */
function depsUnavailable(): ToolResult {
  return {
    content: sm('process.tool.deps_unavailable'),
    isError: true,
    metadata: { i18n: i18nMeta('process.tool.deps_unavailable') },
  };
}

/**
 * Единый отказ «прогон не найден» (нет такого **или** он вне скоупа).
 *
 * Одинаковый текст для обоих случаев: существование чужого прогона не
 * раскрывается (то же правило, что у `schedule.tool.not_found`).
 */
function runNotFound(runId: string): ToolResult {
  return {
    content: sm('process.tool.not_found', { id: runId }),
    isError: true,
    metadata: { i18n: i18nMeta('process.tool.not_found', { id: runId }) },
  };
}

/** Привести `limit` к допустимому виду: дефолт 20, потолок 100. */
function resolveLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(limit), MAX_LIMIT);
}

/** Привести предел лога к допустимому виду: дефолт 16 КиБ, потолок 64 КиБ. */
function resolveLogLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return DEFAULT_LOG_LIMIT;
  return Math.min(Math.floor(limit), MAX_LOG_LIMIT);
}

/** Обрезать текст до предела (многоточие — «обрезано»). */
function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * Скоуп видимости: текущая сессия + её дочерние сессии.
 *
 * Дочерние сессии — саб-агенты (`task`): у фонового процесса, запущенного
 * внутри ребёнка, запись реестра принадлежит ребёнку (`sessionId` = id
 * ребёнка), поэтому без детей родитель не увидел бы свой же прогон.
 *
 * Сбой чтения детей не ломает тул — скоуп сужается до текущей сессии.
 */
async function resolveScope(ctx: ToolContext, extra?: ProcessToolsExtra): Promise<Set<string>> {
  const scope = new Set<string>();
  if (ctx.sessionId) scope.add(ctx.sessionId);
  const manager = extra?.sessionManager;
  if (!manager || !ctx.sessionId) return scope;
  try {
    const children = await manager.getChildren(ctx.sessionId, { light: true });
    for (const child of children) scope.add(child.id);
  } catch {
    // Скоуп сужаем до текущей сессии (fail-closed по видимости).
  }
  return scope;
}

/** Строка прогона для списка: машиночитаемые `key=value`. */
function formatRunLine(record: BackgroundRunRecord): string {
  const title = record.command ?? record.description ?? '';
  const exitCode = record.exitCode !== undefined ? String(record.exitCode) : '-';
  const signal = record.signal ?? '-';
  return [
    `- ${record.id}`,
    `kind=${record.kind}`,
    `status=${record.status}`,
    `cmd=${title ? truncate(title, MAX_TEXT_CHARS) : '-'}`,
    `started=${record.startedAt}`,
    `finished=${record.finishedAt ?? '-'}`,
    `exit_code=${exitCode}`,
    `signal=${signal}`,
    `child_session=${record.childSessionId ?? '-'}`,
  ].join(' | ');
}

/** Поля прогона для метаданных (id/status/kind — для UI и отладки). */
function runMetadata(record: BackgroundRunRecord): Record<string, unknown> {
  return { id: record.id, status: record.status, kind: record.kind };
}

// ─────────────────────────────── process_list ───────────────────────────────

const processListSchema = z
  .object({
    status: z
      .enum(RUN_STATUSES)
      .optional()
      .describe('Filter by status (running, completed, failed, cancelled, orphaned)'),
    kind: z
      .enum(RUN_KINDS)
      .optional()
      .describe('Filter by kind (subagent — background subagent, process — background shell command)'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_LIMIT)
      .optional()
      .describe(`Maximum number of runs to return (default: ${DEFAULT_LIMIT}, max: ${MAX_LIMIT})`),
  })
  .strict();

export const processListTool: ToolDefinition = {
  name: 'process_list',
  description:
    'List background runs of the current session and its child sessions: background subagents and background shell commands. '
    + 'Returns the id, kind, status, command or description, start/finish time, exit code and the child session id. '
    + 'Use it to check whether a background job is still running or has finished; do not poll in a loop — '
    + 'a notification with the result arrives automatically.',
  parameters: processListSchema,
  capabilities: [ToolCapability.PROCESS],
  async execute(args, ctx) {
    // «Стоп» пришёл до запуска — операция не выполняется (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);

    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) return argError(this.name, parsed.error.issues);
    const params = parsed.data as {
      status?: BackgroundRunStatus;
      kind?: BackgroundRunKind;
      limit?: number;
    };

    const extra = ctx.extra as ProcessToolsExtra | undefined;
    const registry = extra?.backgroundService;
    if (!registry) return depsUnavailable();

    const limit = resolveLimit(params.limit);
    const scope = await resolveScope(ctx, extra);

    // Реестр фильтрует по одной сессии за раз — собираем по скоупу и сливаем.
    const collected: BackgroundRunRecord[] = [];
    for (const sessionId of scope) {
      const runs = await registry.list({
        sessionId,
        ...(params.status !== undefined ? { status: params.status } : {}),
        ...(params.kind !== undefined ? { kind: params.kind } : {}),
      });
      collected.push(...runs);
    }
    const runs = collected
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt) || a.id.localeCompare(b.id))
      .slice(0, limit);

    if (runs.length === 0) {
      return {
        content: sm('process.tool.empty'),
        metadata: { count: 0, runs: [], i18n: i18nMeta('process.tool.empty') },
      };
    }

    const lines = [
      sm('process.tool.header', { count: String(runs.length) }),
      ...runs.map(formatRunLine),
    ];
    return {
      content: lines.join('\n'),
      metadata: {
        count: runs.length,
        runs: runs.map(runMetadata),
      },
    };
  },
};

// ─────────────────────────────── process_logs ───────────────────────────────

const processLogsSchema = z
  .object({
    process_id: z
      .string()
      .min(1)
      .describe('Id of the background run record (bgr_...) as returned by process_list'),
    stream: z
      .enum(['stdout', 'stderr', 'combined'])
      .optional()
      .describe('Requested stream of the log (the log is stored combined, so the whole log is returned)'),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Offset in bytes from the beginning of the log'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_LOG_LIMIT)
      .optional()
      .describe(`Maximum number of bytes of the log to return (default: ${DEFAULT_LOG_LIMIT}, max: ${MAX_LOG_LIMIT})`),
  })
  .strict();

export const processLogsTool: ToolDefinition = {
  name: 'process_logs',
  description:
    'Read the log of a background shell process by the id of its background run record (from process_list). '
    + 'A background subagent has no log: its history is in the child session (read_session_reference). '
    + 'The log is stored combined (stdout and stderr are not separated).',
  parameters: processLogsSchema,
  capabilities: [ToolCapability.PROCESS],
  async execute(args, ctx) {
    // «Стоп» пришёл до запуска — операция не выполняется (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);

    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) return argError(this.name, parsed.error.issues);
    const params = parsed.data as {
      process_id: string;
      stream?: 'stdout' | 'stderr' | 'combined';
      offset?: number;
      limit?: number;
    };

    const extra = ctx.extra as ProcessToolsExtra | undefined;
    const registry = extra?.backgroundService;
    if (!registry) return depsUnavailable();

    const record = await registry.get(params.process_id);
    if (!record) return runNotFound(params.process_id);

    // Скоуп: прогон другой сессии выглядит как отсутствующий (без утечки).
    const scope = await resolveScope(ctx, extra);
    if (!scope.has(record.sessionId)) return runNotFound(params.process_id);

    // У фонового саб-агента лога нет — отдаём summary и id дочерней сессии.
    if (record.kind === 'subagent') {
      const lines = [
        sm('process.tool.no_log'),
        formatRunLine(record),
        record.summary ? `summary: ${truncate(record.summary, MAX_SUMMARY_CHARS)}` : '',
        record.childSessionId
          ? sm('process.tool.child_history', { child_session: record.childSessionId })
          : '',
      ].filter((line) => line.length > 0);
      return {
        content: lines.join('\n'),
        metadata: {
          run_id: record.id,
          kind: record.kind,
          status: record.status,
          ...(record.childSessionId ? { child_session_id: record.childSessionId } : {}),
        },
      };
    }

    const service = extra?.processService;
    if (!service) return depsUnavailable();

    const offset = params.offset !== undefined && Number.isFinite(params.offset)
      ? Math.max(0, Math.floor(params.offset))
      : 0;
    const limit = resolveLogLimit(params.limit);
    const logs = await service.logs(record.id, { offset, limit });
    if (!logs) {
      return {
        content: sm('process.tool.no_log'),
        metadata: { run_id: record.id, kind: record.kind, status: record.status },
      };
    }

    const lines = [
      formatRunLine(record),
      `requested_stream=${params.stream ?? 'combined'} | log_stream=combined`,
      `next_offset=${logs.nextOffset} | total_bytes=${logs.totalBytes} | truncated=${logs.truncated === true}`,
      '--- log ---',
      logs.content,
      '--- end of log ---',
    ];
    return {
      content: lines.join('\n'),
      metadata: {
        run_id: record.id,
        kind: record.kind,
        status: record.status,
        next_offset: logs.nextOffset,
        total_bytes: logs.totalBytes,
        truncated: logs.truncated === true,
      },
    };
  },
};

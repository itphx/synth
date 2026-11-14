/**
 * PROP-132 (Ф5): тулы агента для интерактивных терминалов.
 *
 * Тулы: `terminal_list`, `terminal_open`, `terminal_read`, `terminal_write`,
 * `terminal_close` — тот же контур, что у HTTP-роутов `/api/v2/terminals*`
 * (`server/routes/terminals.ts`), только вызывает его агент.
 *
 * ## Границы
 *
 * - **Скоуп — проект сессии.** Видны только терминалы проекта текущей сессии
 *   (`ctx.projectId`); чужой терминал выглядит как отсутствующий
 *   (`terminal.tool.not_found`) — существование чужого ресурса не раскрывается.
 *   Терминал без проекта невозможен: у сессии без проекта тулы терминалов
 *   недоступны (`terminal.tool.project_required`).
 * - **Рабочий каталог вычисляет сервер.** `cwd` терминала = рабочий каталог
 *   сессии (`session.worktree.directory` → `project.workspace`, ADR-114/ADR-075);
 *   параметра `cwd` у тулов нет — терминал не уехал бы за периметр проекта.
 * - **Права — на границе, не в туле.** Скоуп/права решает permission-слой
 *   (группа `terminal`, `permission.rules.terminal`), а мастер-выключатель
 *   инстанса `terminal.enabled` — слой доступности (`unavailable(policy)`).
 *   Здесь — только исполнение.
 * - **Аудит — внутри `TerminalService`** (`terminal.open`/`terminal.input`/
 *   `terminal.close`, только метаданные, ADR-136): дублировать нельзя.
 * - **Ввод с Enter проверяется shell-guard'ом** — тем же чекером, что у
 *   `execute_shell` (`checkShellCommand`): команда, запрещённая политикой,
 *   до терминала не доходит.
 */
import { z } from 'zod';
import { ToolCapability } from '@itphx/synth-shared';
import type { ToolContext, ToolDefinition, ToolResult } from '@itphx/synth-shared';
import type { SessionManager } from '../../sessions/manager.js';
import type { TerminalService } from '../terminal/service.js';
import type { TerminalRecord } from '../terminal/types.js';
import {
  TerminalDisabledError,
  TerminalLimitError,
  TerminalNotFoundError,
  TerminalUnavailableError,
} from '../terminal/types.js';
import { checkShellCommand, type ShellPolicy } from '../security/shell-guard.js';
import { isAborted, abortedResult } from './abort.js';
import { t as sm, i18n as i18nMeta } from '../system-messages.js';
import { argErrorResult } from './arg-error.js';

/**
 * Зависимости тулов из `ToolContext.extra` (упаковка — оркестратор).
 *
 * - `terminalService` — сервис терминалов инстанса (PROP-132): реестр живых
 *   терминалов, ввод, вывод. Не задан — тулы терминалов недоступны
 *   (`terminal.tool.deps_unavailable`).
 * - `sessionManager` — менеджер сессий: владелец сессии (аудит ввода) и её
 *   проект. Не задан — владелец не определяется (`local`).
 * - `shellPolicy` — политика shell-guard (те же правила, что у
 *   `execute_shell`: защищённые пути, `external_directory`,
 *   `deniedCommandPrefixes`). Не задана — проверяется пустая политика (как у
 *   permission-слоя при отсутствии политики).
 */
export interface TerminalToolsExtra {
  terminalService?: TerminalService;
  sessionManager?: SessionManager;
  shellPolicy?: ShellPolicy;
}

/** Дефолтный размер терминала (колонки/строки). */
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

/** Потолок размера терминала (как у сервиса: `MAX_TERMINAL_DIMENSION`). */
const MAX_DIMENSION = 1000;

/** Кап текста вывода, отдаваемого моделью, байт. */
const MAX_OUTPUT_BYTES = 32 * 1024;

/** Потолок числа строк в параметре `tail`. */
const MAX_TAIL_LINES = 5000;

/**
 * ANSI-последовательности (CSI/OSC и прочие escape-последовательности).
 *
 * По умолчанию вывод терминала отдаётся **как есть** (цвета и позиционирование
 * значимы для агента, читающего вывод команды); `strip_ansi: true` — для
 * случаев, когда модель не должна видеть управляющие последовательности.
 */
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

/** Убрать ANSI-последовательности из текста. */
function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

/** Единый отказ «сервис терминалов не подключён». */
function depsUnavailable(): ToolResult {
  return {
    content: sm('terminal.tool.deps_unavailable'),
    isError: true,
    metadata: { i18n: i18nMeta('terminal.tool.deps_unavailable') },
  };
}

/** Единый отказ «терминалы на инстансе выключены». */
function disabledResult(): ToolResult {
  return {
    content: sm('terminal.tool.disabled'),
    isError: true,
    metadata: { i18n: i18nMeta('terminal.tool.disabled') },
  };
}

/** Единый отказ «у сессии нет проекта» (терминал — ресурс проекта). */
function projectRequired(): ToolResult {
  return {
    content: sm('terminal.tool.project_required'),
    isError: true,
    metadata: { i18n: i18nMeta('terminal.tool.project_required') },
  };
}

/**
 * Единый отказ «терминала нет».
 *
 * Один текст и для несуществующего, и для чужого терминала: существование
 * чужого ресурса не раскрывается (то же правило, что у `process.tool.not_found`).
 */
function notFound(id: string): ToolResult {
  return {
    content: sm('terminal.tool.not_found', { id }),
    isError: true,
    metadata: { i18n: i18nMeta('terminal.tool.not_found', { id }) },
  };
}

/**
 * Отказ по типизированной ошибке сервиса терминалов.
 *
 * Единственное место, где машинный код сервиса (`TERMINAL_*`) превращается в
 * текст модели.
 */
function serviceErrorResult(err: unknown): ToolResult {
  if (err instanceof TerminalDisabledError) return disabledResult();
  if (err instanceof TerminalNotFoundError) return notFound(err.terminalId);
  if (err instanceof TerminalLimitError) {
    const text = sm('terminal.tool.limit', { limit: String(err.limit) });
    return {
      content: text,
      isError: true,
      metadata: { scope: err.scope, limit: err.limit, i18n: i18nMeta('terminal.tool.limit', { limit: String(err.limit) }) },
    };
  }
  if (err instanceof TerminalUnavailableError) {
    const text = sm('terminal.tool.unavailable', { reason: err.reason });
    return {
      content: text,
      isError: true,
      metadata: { reason: err.reason, i18n: i18nMeta('terminal.tool.unavailable', { reason: err.reason }) },
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: sm('tool.exec_error', { tool: 'terminal', error: message }),
    isError: true,
    metadata: { error: message },
  };
}

/** Зависимости тулов из контекста (упаковка — оркестратор). */
function extraOf(ctx: ToolContext): TerminalToolsExtra {
  return (ctx.extra ?? {}) as TerminalToolsExtra;
}

/**
 * Сервис терминалов из контекста.
 *
 * `null` — сервис не подключён (сборка без терминального контура).
 */
function serviceOf(ctx: ToolContext): TerminalService | null {
  return extraOf(ctx).terminalService ?? null;
}

/**
 * Владелец вызова (для аудита в терминальном сервисе).
 *
 * Владелец сессии — человек; в single-user инстансе человек один, поэтому
 * фолбэк — `local`. Аудит пишет **только метаданные** (ADR-136).
 */
async function resolveActorId(ctx: ToolContext): Promise<string> {
  const manager = extraOf(ctx).sessionManager;
  if (!manager || !ctx.sessionId) return 'local';
  try {
    const session = await manager.getSession(ctx.sessionId);
    return session?.ownerId ?? session?.userId ?? 'local';
  } catch {
    return 'local';
  }
}

/**
 * Терминал в скоупе сессии.
 *
 * `null` — терминала нет **или** он чужого проекта (тот же ответ).
 */
function terminalInScope(ctx: ToolContext, service: TerminalService, id: string): TerminalRecord | null {
  const record = service.get(id);
  if (!record) return null;
  const projectId = ctx.projectId;
  if (projectId && record.projectId !== projectId) return null;
  return record;
}

/** Может ли агент писать в терминал (для сводки списка). */
function canWrite(service: TerminalService, record: TerminalRecord): boolean {
  return service.isEnabled() && record.status !== 'exited';
}

/** Строка терминала для списка — машиночитаемые `key=value`. */
function formatTerminalLine(record: TerminalRecord, writable: boolean): string {
  return [
    `- ${record.id}`,
    `cwd=${record.cwd}`,
    `shell=${record.shell}`,
    `status=${record.status}`,
    `can_write=${writable ? 'true' : 'false'}`,
    `session=${record.sessionId ?? '-'}`,
    `size=${record.cols}x${record.rows}`,
  ].join(' | ');
}

// ─────────────────────────────── terminal_list ───────────────────────────────

const terminalListSchema = z
  .object({
    session_id: z
      .string()
      .min(1)
      .optional()
      .describe('Only terminals bound to this session (by default — all terminals of the project)'),
    include_exited: z
      .boolean()
      .optional()
      .describe('Include terminals that have already exited (by default — only live ones)'),
  })
  .strict();

export const terminalListTool: ToolDefinition = {
  name: 'terminal_list',
  description:
    'List the interactive terminals of the current project: id, working directory, shell, status, '
    + 'whether the agent can write to it, and the session it is bound to. '
    + 'Use it to find the terminal id for terminal_read/terminal_write/terminal_close. '
    + 'Only terminals of the current project are visible.',
  parameters: terminalListSchema,
  capabilities: [ToolCapability.TERMINAL],
  async execute(args, ctx) {
    if (isAborted(ctx)) return abortedResult(this.name);

    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) return argErrorResult(this.name, parsed.error.issues);
    const params = parsed.data as { session_id?: string; include_exited?: boolean };

    const service = serviceOf(ctx);
    if (!service) return depsUnavailable();
    if (!service.isEnabled()) return disabledResult();
    const projectId = ctx.projectId;
    if (!projectId) return projectRequired();

    const records = service.list({
      projectId,
      ...(params.session_id !== undefined ? { sessionId: params.session_id } : {}),
      ...(params.include_exited === true ? { includeExited: true } : {}),
    });

    if (records.length === 0) {
      return {
        content: sm('terminal.tool.empty'),
        metadata: { count: 0, terminals: [], i18n: i18nMeta('terminal.tool.empty') },
      };
    }

    const lines = [
      sm('terminal.tool.header', { count: String(records.length) }),
      ...records.map((record) => formatTerminalLine(record, canWrite(service, record))),
    ];
    return {
      content: lines.join('\n'),
      metadata: {
        count: records.length,
        terminals: records.map((record) => ({
          id: record.id,
          status: record.status,
          cwd: record.cwd,
          shell: record.shell,
          can_write: canWrite(service, record),
          session_id: record.sessionId ?? null,
        })),
      },
    };
  },
};

// ─────────────────────────────── terminal_open ───────────────────────────────

const terminalOpenSchema = z
  .object({
    cols: z
      .number()
      .int()
      .min(1)
      .max(MAX_DIMENSION)
      .optional()
      .describe(`Terminal width in columns (default: ${DEFAULT_COLS})`),
    rows: z
      .number()
      .int()
      .min(1)
      .max(MAX_DIMENSION)
      .optional()
      .describe(`Terminal height in rows (default: ${DEFAULT_ROWS})`),
    session_id: z
      .string()
      .min(1)
      .optional()
      .describe('Bind the terminal to this session (by default — the current session)'),
    title: z.string().min(1).max(120).optional().describe('Optional terminal title'),
  })
  .strict();

export const terminalOpenTool: ToolDefinition = {
  name: 'terminal_open',
  description:
    'Open an interactive terminal (PTY) in the working directory of the current session '
    + '(the session worktree directory, or the project workspace) and return its id, shell, size and status. '
    + 'Reopening a terminal in the same directory returns the same live terminal. '
    + 'Use terminal_write to send input and terminal_read to read the output.',
  parameters: terminalOpenSchema,
  capabilities: [ToolCapability.TERMINAL],
  async execute(args, ctx) {
    if (isAborted(ctx)) return abortedResult(this.name);

    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) return argErrorResult(this.name, parsed.error.issues);
    const params = parsed.data as {
      cols?: number;
      rows?: number;
      session_id?: string;
      title?: string;
    };

    const service = serviceOf(ctx);
    if (!service) return depsUnavailable();
    if (!service.isEnabled()) return disabledResult();
    const projectId = ctx.projectId;
    if (!projectId) return projectRequired();

    const actorId = await resolveActorId(ctx);
    try {
      const record = await service.create({
        projectId,
        ownerId: actorId,
        // Каталог терминала вычисляет сервер: рабочий каталог сессии
        // (worktree → workspace). Параметра `cwd` у тула нет.
        cwd: ctx.workingDir,
        cols: params.cols ?? DEFAULT_COLS,
        rows: params.rows ?? DEFAULT_ROWS,
        sessionId: params.session_id ?? ctx.sessionId,
        ...(params.title !== undefined ? { title: params.title } : {}),
      });
      return {
        content: sm('terminal.tool.opened', { id: record.id }),
        metadata: {
          terminal_id: record.id,
          cwd: record.cwd,
          shell: record.shell,
          status: record.status,
          cols: record.cols,
          rows: record.rows,
          session_id: record.sessionId ?? null,
          i18n: i18nMeta('terminal.tool.opened', { id: record.id }),
        },
      };
    } catch (err) {
      return serviceErrorResult(err);
    }
  },
};

// ─────────────────────────────── terminal_read ───────────────────────────────

const terminalReadSchema = z
  .object({
    terminal_id: z.string().min(1).describe('Terminal id (term_...) from terminal_list/terminal_open'),
    since: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Return only output chunks newer than this sequence number (from a previous read)'),
    tail: z
      .number()
      .int()
      .min(1)
      .max(MAX_TAIL_LINES)
      .optional()
      .describe('Return only the last N lines of the output'),
    strip_ansi: z
      .boolean()
      .optional()
      .describe('Remove ANSI escape sequences (colors/positions) from the output (default: keep them)'),
  })
  .strict();

export const terminalReadTool: ToolDefinition = {
  name: 'terminal_read',
  description:
    'Read the output of an interactive terminal by its id. '
    + 'Returns the text produced so far (ANSI escape sequences are kept unless strip_ansi is true), '
    + 'capped at 32 KiB. Use `since` to read only what appeared after the previous read, '
    + 'or `tail` to get the last N lines. The output is not returned until the command has produced it.',
  parameters: terminalReadSchema,
  capabilities: [ToolCapability.TERMINAL],
  async execute(args, ctx) {
    if (isAborted(ctx)) return abortedResult(this.name);

    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) return argErrorResult(this.name, parsed.error.issues);
    const params = parsed.data as {
      terminal_id: string;
      since?: number;
      tail?: number;
      strip_ansi?: boolean;
    };

    const service = serviceOf(ctx);
    if (!service) return depsUnavailable();
    if (!service.isEnabled()) return disabledResult();

    const record = terminalInScope(ctx, service, params.terminal_id);
    if (!record) return notFound(params.terminal_id);

    const snapshot = service.output(params.terminal_id);
    if (!snapshot || snapshot.chunks.length === 0) {
      return {
        content: sm('terminal.tool.no_output'),
        metadata: {
          terminal_id: params.terminal_id,
          status: record.status,
          bytes: 0,
          truncated: false,
          i18n: i18nMeta('terminal.tool.no_output'),
        },
      };
    }

    const chunks = params.since !== undefined
      ? snapshot.chunks.filter((chunk) => chunk.seq > params.since!)
      : snapshot.chunks;
    let text = chunks.map((chunk) => chunk.data).join('');
    if (params.strip_ansi === true) text = stripAnsi(text);

    let truncated = false;
    if (params.tail !== undefined) {
      // «Последние N строк»: завершающий пустой элемент (следствие
      // завершающего `\n`) отбрасывается — иначе в хвост попадала бы пустая
      // строка вместо последней строки вывода. Строк меньше N — текст как есть
      // (без завершающего перевода строки).
      const lines = text.replace(/\n$/, '').split('\n');
      if (lines.length > params.tail) {
        text = lines.slice(-params.tail).join('\n');
        truncated = true;
      } else {
        text = lines.join('\n');
      }
    }
    if (text.length > MAX_OUTPUT_BYTES) {
      text = text.slice(text.length - MAX_OUTPUT_BYTES);
      truncated = true;
    }

    return {
      content: text,
      metadata: {
        terminal_id: params.terminal_id,
        status: record.status,
        bytes: Buffer.byteLength(text, 'utf8'),
        first_seq: chunks.length > 0 ? chunks[0]!.seq : snapshot.firstSeq,
        last_seq: snapshot.lastSeq,
        total_bytes: snapshot.totalBytes,
        dropped_bytes: snapshot.droppedBytes,
        truncated,
      },
    };
  },
};

// ────────────────────────────── terminal_write ──────────────────────────────

const terminalWriteSchema = z
  .object({
    terminal_id: z.string().min(1).describe('Terminal id (term_...) from terminal_list/terminal_open'),
    data: z
      .string()
      .min(1)
      .describe('Text to send to the terminal (keystrokes)'),
    enter: z
      .boolean()
      .optional()
      .describe('Append a newline (submit the line). The line is checked by the shell policy before sending (default: false)'),
  })
  .strict();

export const terminalWriteTool: ToolDefinition = {
  name: 'terminal_write',
  description:
    'Send input to an interactive terminal by its id (keystrokes, no newline by default). '
    + 'With enter=true a newline is appended and the line is checked by the same shell policy as execute_shell: '
    + 'a command that the policy forbids is not sent to the terminal. '
    + 'The terminal output becomes visible via terminal_read.',
  parameters: terminalWriteSchema,
  capabilities: [ToolCapability.TERMINAL],
  async execute(args, ctx) {
    if (isAborted(ctx)) return abortedResult(this.name);

    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) return argErrorResult(this.name, parsed.error.issues);
    const params = parsed.data as { terminal_id: string; data: string; enter?: boolean };

    const service = serviceOf(ctx);
    if (!service) return depsUnavailable();
    if (!service.isEnabled()) return disabledResult();

    const record = terminalInScope(ctx, service, params.terminal_id);
    if (!record) return notFound(params.terminal_id);

    let payload = params.data;
    if (params.enter === true) {
      // Строка, уходящая в терминал с Enter, — это команда: её проверяет тот
      // же shell-guard, что и `execute_shell` (ADR-029/ADR-136).
      const command = params.data.replace(/[\r\n]+$/, '');
      if (command.trim() !== '') {
        const policy = extraOf(ctx).shellPolicy;
        const check = checkShellCommand(command, record.cwd, policy ?? { deniedPaths: [], deniedPrefixes: [], approvalPaths: [], deniedCommandPrefixes: [] }, {
          ...(ctx.allowedRoots ? { allowedRoots: ctx.allowedRoots } : {}),
        });
        if (check.action === 'deny') {
          return {
            content: sm('terminal.tool.command_denied', { reason: check.reason }),
            isError: true,
            metadata: {
              terminal_id: params.terminal_id,
              reason: 'command_denied',
              matched_rule: check.matchedRule ?? null,
              i18n: i18nMeta('terminal.tool.command_denied', { reason: check.reason }),
            },
          };
        }
        if (check.action === 'ask') {
          // Тул не умеет спрашивать пользователя (у permission-слоя есть ask,
          // здесь — только текст): требующее подтверждения — не выполняем.
          return {
            content: sm('terminal.tool.command_requires_approval', { reason: check.reason }),
            isError: true,
            metadata: {
              terminal_id: params.terminal_id,
              reason: 'command_requires_approval',
              matched_rule: check.matchedRule ?? null,
              i18n: i18nMeta('terminal.tool.command_requires_approval', { reason: check.reason }),
            },
          };
        }
      }
      payload = `${params.data.replace(/[\r\n]+$/, '')}\n`;
    }

    const actorId = await resolveActorId(ctx);
    try {
      service.write(params.terminal_id, payload, { actorId });
    } catch (err) {
      return serviceErrorResult(err);
    }

    return {
      content: sm('terminal.tool.written', { id: params.terminal_id }),
      metadata: {
        terminal_id: params.terminal_id,
        bytes: Buffer.byteLength(payload, 'utf8'),
        enter: params.enter === true,
        i18n: i18nMeta('terminal.tool.written', { id: params.terminal_id }),
      },
    };
  },
};

// ────────────────────────────── terminal_close ──────────────────────────────

const terminalCloseSchema = z
  .object({
    terminal_id: z.string().min(1).describe('Terminal id (term_...) from terminal_list/terminal_open'),
  })
  .strict();

export const terminalCloseTool: ToolDefinition = {
  name: 'terminal_close',
  description:
    'Close an interactive terminal by its id: the shell process is terminated and the terminal is removed '
    + 'from the registry. Use it when the terminal is no longer needed.',
  parameters: terminalCloseSchema,
  capabilities: [ToolCapability.TERMINAL],
  async execute(args, ctx) {
    if (isAborted(ctx)) return abortedResult(this.name);

    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) return argErrorResult(this.name, parsed.error.issues);
    const params = parsed.data as { terminal_id: string };

    const service = serviceOf(ctx);
    if (!service) return depsUnavailable();
    if (!service.isEnabled()) return disabledResult();

    const record = terminalInScope(ctx, service, params.terminal_id);
    if (!record) return notFound(params.terminal_id);

    const actorId = await resolveActorId(ctx);
    try {
      await service.close(params.terminal_id, { actorId });
    } catch (err) {
      return serviceErrorResult(err);
    }

    return {
      content: sm('terminal.tool.closed', { id: params.terminal_id }),
      metadata: {
        terminal_id: params.terminal_id,
        i18n: i18nMeta('terminal.tool.closed', { id: params.terminal_id }),
      },
    };
  },
};

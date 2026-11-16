/**
 * ADR-126 §5: тулы реестра скриптов проекта — `script_list`, `script_run`.
 *
 * Скрипт — **объявленный** артефакт проекта (`.synth/scripts/<name>.md`),
 * а не исполняемый файл: интерпретатор и аргументы — данные декларации.
 * Единственный путь исполнения — `ScriptService` (ADR-113: фоновый процесс,
 * лог в blob-хранилище, события `process.*`).
 *
 * ## Границы
 *
 * - **Права — не здесь.** Решение по `permission.rules.script` (allow/deny/
 *   ask + glob по имени) принимает permission-слой; тул `script_run` его
 *   не дублирует (ADR-025/ADR-029). Тул **скрывает** deny-скрипты в списке —
 *   это видимость реестра, а не проверка права.
 * - **Скоуп — проект сессии.** Скрипты проекта и инстанса видны всем сессиям
 *   (реестр — общий); каталог проекта — рабочий каталог сессии.
 * - **Аудит — только метаданные** (ADR-136): имя скрипта, cwd, число
 *   аргументов, origin. Сами аргументы не пишутся.
 * - Тексты — только через ключи `shared/i18n` (ADR-041).
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ToolCapability } from '@itphx/synth-shared';
import type {
  PermissionConfig,
  ToolDefinition,
  ToolResult,
} from '@itphx/synth-shared';
import type { ScriptService } from '../scripts/service.js';
import { splitScriptArguments } from '../scripts/args.js';
import { ScriptError, type ScriptErrorCode } from '../scripts/types.js';
import { resolveScriptRule } from '../permission/evaluator.js';
import { sha256Hex, type CommandAuditLog } from '../security/command-audit.js';
import { isAborted, abortedResult } from './abort.js';
import { t as sm, i18n as i18nMeta } from '../system-messages.js';
import { argErrorResult } from './arg-error.js';

/**
 * Зависимости тулов скриптов из `ToolContext.extra` (упаковка — оркестратор).
 *
 * - `scriptService` — реестр и запуск скриптов. Не задан — контур скриптов
 *   в этой сборке недоступен (`script.tool.deps_unavailable`).
 * - `permissionConfig` — правила прав сессии: deny-скрипты скрываются из
 *   списка (ADR-126 §5).
 * - `commandAudit` — журнал исполнений (ADR-136): запись `script.run`
 *   (только метаданные).
 */
export interface ScriptToolsExtra {
  scriptService?: ScriptService;
  permissionConfig?: PermissionConfig;
  commandAudit?: CommandAuditLog;
}

/** Единый отказ «контур скриптов недоступен в этой сборке». */
function depsUnavailable(): ToolResult {
  return {
    content: sm('script.tool.deps_unavailable'),
    isError: true,
    metadata: { i18n: i18nMeta('script.tool.deps_unavailable') },
  };
}

/**
 * Отказ по коду доменной ошибки скриптов → текст для модели.
 *
 * Коды разбирает **вызывающий** (тул/роут), а не сервис: сервис не знает ни
 * формат ответа, ни коды API.
 */
function scriptErrorResult(code: ScriptErrorCode, name: string): ToolResult {
  const key = (
    {
      script_not_found: 'script.not_found',
      script_untrusted: 'script.untrusted',
      script_args_not_allowed: 'script.args_not_allowed',
      script_args_invalid: 'script.args_invalid',
      script_cwd_outside: 'script.cwd_outside',
      script_background_disabled: 'script.background_disabled',
    } as const
  )[code];
  return {
    content: sm(key, { name }),
    isError: true,
    metadata: { i18n: i18nMeta(key, { name }), code },
  };
}

/** Строка скрипта для списка: машиночитаемые `key=value`. */
function formatScriptLine(script: {
  name: string;
  origin: string;
  available: boolean;
  description: string;
  argumentHint?: string;
}): string {
  return [
    `- ${script.name}`,
    `origin=${script.origin}`,
    `available=${script.available}`,
    ...(script.argumentHint ? [`args=${script.argumentHint}`] : []),
    script.description,
  ].join(' | ');
}

/**
 * Число аргументов скрипта — только для аудита (сами аргументы не пишутся).
 *
 * Разбор лексером скриптов: неразобранные аргументы дают `0` — сервис вернёт
 * ошибку разбора отдельно.
 */
function countArguments(args: string | undefined): number {
  if (!args) return 0;
  try {
    return splitScriptArguments(args).length;
  } catch {
    return 0;
  }
}

// ─────────────────────────────── script_list ───────────────────────────────

const scriptListSchema = z.object({}).strict();

export const scriptListTool: ToolDefinition = {
  name: 'script_list',
  description:
    'List the declared project scripts (the script registry of the project). '
    + 'A script is a declaration (.synth/scripts/<name>.md) that says what to run — the executable file itself '
    + 'is an ordinary repository file. The list shows the name, description, origin (project/instance/config) '
    + 'and whether the script is available to run. Scripts denied by the permission rules are not shown.',
  parameters: scriptListSchema,
  capabilities: [ToolCapability.SHELL],
  async execute(args, ctx) {
    // «Стоп» пришёл до запуска — операция не выполняется (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);

    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) return argErrorResult(this.name, parsed.error.issues);

    const extra = ctx.extra as ScriptToolsExtra | undefined;
    const service = extra?.scriptService;
    if (!service) return depsUnavailable();

    // ADR-126 §5: рабочий каталог сессии — корень проекта (или его worktree):
    // там лежит `.synth/scripts`.
    const { scripts } = await service.list({ projectWorkspace: ctx.workingDir });

    // `deny` скрывает скрипт из реестра (ADR-126 §5) — и для агента, и для
    // человека: правило — политика инстанса/сессии, а не только агентская.
    const visible = scripts.filter(
      (script) => resolveScriptRule(extra?.permissionConfig, script.name)?.action !== 'deny',
    );

    if (visible.length === 0) {
      return {
        content: sm('script.tool.empty'),
        metadata: { count: 0, scripts: [], i18n: i18nMeta('script.tool.empty') },
      };
    }

    const lines = [
      sm('script.tool.header', { count: String(visible.length) }),
      ...visible.map(formatScriptLine),
    ];
    return {
      content: lines.join('\n'),
      metadata: {
        count: visible.length,
        scripts: visible.map((script) => ({
          name: script.name,
          origin: script.origin,
          available: script.available,
          ...(script.argumentHint ? { argument_hint: script.argumentHint } : {}),
        })),
      },
    };
  },
};

// ─────────────────────────────── script_run ────────────────────────────────

const scriptRunSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .describe('Script name from script_list (for example: dev)'),
    arguments: z
      .string()
      .optional()
      .describe('Arguments of the script as a single string (parsed by the script lexer, no shell)'),
  })
  .strict();

export const scriptRunTool: ToolDefinition = {
  name: 'script_run',
  description:
    'Run a declared project script by name (from script_list) as a background process. '
    + 'The script decides what to execute — the tool only starts it. Optionally pass the script arguments '
    + 'as a single string (parsed by the script lexer, never evaluated by a shell). '
    + 'The run is asynchronous: read its log with process_logs and stop it with process_stop.',
  parameters: scriptRunSchema,
  capabilities: [ToolCapability.SHELL],
  async execute(args, ctx) {
    // «Стоп» пришёл до запуска — операция не выполняется (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);

    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) return argErrorResult(this.name, parsed.error.issues);
    const params = parsed.data as { name: string; arguments?: string };

    const extra = ctx.extra as ScriptToolsExtra | undefined;
    const service = extra?.scriptService;
    if (!service) return depsUnavailable();

    const argCount = countArguments(params.arguments);

    // Тот же порядок, что у HTTP-роута: отклонённый вызов не оставляет запись
    // `started` в журнале исполнений (ADR-136). `run` повторит проверки.
    const detail = await service.get(params.name, { projectWorkspace: ctx.workingDir });
    if (!detail) return scriptErrorResult('script_not_found', params.name);
    if (!detail.trusted) return scriptErrorResult('script_untrusted', params.name);
    if ((params.arguments ?? '').trim().length > 0 && !detail.args) {
      return scriptErrorResult('script_args_not_allowed', params.name);
    }

    // ADR-136: журнал исполнений — `started` **до** запуска. Ошибка записи
    // при включённом журнале блокирует исполнение (как у `execute_shell`).
    //
    // `execution_id` — один на пару `started`/`finished`: тот же id уходит в
    // запись реестра прогона (`metadata.audit_id`), по нему терминальный
    // переход дописывает парную запись `finished`.
    const audit = extra?.commandAudit;
    let auditId: string | undefined;
    if (audit && audit.enabled) {
      const executionId = randomUUID();
      auditId = executionId;
      const description = `script.run name=${params.name} args=${argCount} origin=agent`;
      try {
        await audit.append({
          id: executionId,
          ts: new Date().toISOString(),
          sessionId: ctx.sessionId,
          ...(ctx.projectId ? { projectId: ctx.projectId } : {}),
          ...(ctx.agentRole ? { agentRole: ctx.agentRole } : {}),
          tool: 'script.run',
          command: description,
          commandHash: sha256Hex(description),
          cwd: ctx.workingDir,
          background: true,
          decision: 'allow',
          decidedBy: 'permission',
          phase: 'started',
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return {
          content: sm('script.tool.audit_failed', { reason }),
          isError: true,
          metadata: {
            i18n: i18nMeta('script.tool.audit_failed', { reason }),
            command_audit_failed: true,
          },
        };
      }
    }

    try {
      const result = await service.run({
        name: params.name,
        ...(params.arguments !== undefined ? { args: params.arguments } : {}),
        sessionId: ctx.sessionId,
        ...(ctx.projectId ? { projectId: ctx.projectId } : {}),
        workingDir: ctx.workingDir,
        ...(ctx.allowedRoots && ctx.allowedRoots.length > 0 ? { allowedRoots: ctx.allowedRoots } : {}),
        origin: 'agent',
        projectWorkspace: ctx.workingDir,
        ...(auditId ? { auditId } : {}),
      });

      const lines = [
        sm('script.started', { name: params.name, run: result.run_id }),
        `run_id=${result.run_id} | process_id=${result.process_id} | log_path=${result.log_path}`,
        sm('script.tool.run_hint'),
      ];
      return {
        content: lines.join('\n'),
        metadata: {
          status: 'script_started',
          script: params.name,
          run_id: result.run_id,
          process_id: result.process_id,
          log_path: result.log_path,
          i18n: i18nMeta('script.started', { name: params.name, run: result.run_id }),
        },
      };
    } catch (err) {
      if (err instanceof ScriptError) return scriptErrorResult(err.code, params.name);
      throw err;
    }
  },
};

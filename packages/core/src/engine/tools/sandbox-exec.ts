/**
 * PROP-135 слайс 5a: тул `sandbox_exec` — разовый запуск команд в **отдельном
 * профиле исполнения** (пул класса `sandbox`).
 *
 * ## Зачем отдельный тул, а не `execute_shell`
 *
 * `execute_shell` исполняет команды в пуле сессии (класс `exec`): там лежит
 * рабочее дерево и обычный toolchain. «Песочный» запуск — это **другой
 * образ/набор программ** и отдельный пул: адрес и параметры пула выдаёт
 * provisioner по профилю, который выбирает вызывающий. Смешивать эти два
 * режима в одном туле нельзя: ключ пула различался бы неявно, а модель не
 * могла бы выбрать профиль.
 *
 * ## Что делает
 *
 * 1. Запрашивает у роутера порт для класса `sandbox`
 *    (`router.portFor({profile, class:'sandbox', ...})`) — адрес пула при
 *    `provider: http` приходит от provisioner'а;
 * 2. Запускает команды **последовательно** (1..5 штук) в одном `cwd`,
 *    собирает stdout/stderr/код выхода каждой;
 * 3. После первой ошибки **останавливается** — следующие команды не
 *    выполняются (частичный результат честнее «продолжения после сбоя»).
 *
 * ## Границы
 *
 * - **Нет shell-guard/protected-paths.** Это проверки `execute_shell`
 *   (`engine/security/shell-guard.ts`/`shell-policy`): они анализируют
 *   команду против **локальной** файловой системы control plane, а команда
 *   здесь уходит в другой образ/пул — локальный анализ ничего не доказывал
 *   бы. Permission-слой при этом гейтит тул по группе `shell` (те же правила,
 *   ask/deny, plan-режим блокирует), поэтому без разрешения пользователя
 *   команда не запускается.
 * - **Containment `cwd` — лексический.** Проверяется вхождение в периметр
 *   сессии (`toolRoots`); реальный containment делает исполнитель пула
 *   (у него свой workspace и своя проверка `cwd`).
 * - **Без роутера — понятный отказ.** `execution.mode=inline` (или сборка без
 *   роутера) не имеют пулов: тихий inline-фоллбэк означал бы, что «песочная»
 *   команда исполнилась в процессе control plane.
 */
import { z } from 'zod';
import { ToolCapability } from '@itphx/synth-shared';
import type { ToolDefinition, ToolResult } from '@itphx/synth-shared';
import {
  isLexicallyInside,
  pathEscapesWorkspaceResult,
  resolvePath,
  toolRoots,
  validateInputPath,
} from './path-utils.js';
import { isAborted, abortedResult } from './abort.js';
import { argErrorResult } from './arg-error.js';
import { resolveExecutionRouter } from '../../execution/tool-port.js';
import { DEFAULT_MAX_OUTPUT_BYTES, isExecutionError } from '../../execution/ports/index.js';
import { TIMEOUT_FG_MAX_SEC, timeoutParam } from '../timeout.js';
import type { ExecutionError } from '../../execution/ports/index.js';

/** Предел числа команд за один вызов. */
export const SANDBOX_MAX_COMMANDS = 5;

/**
 * Таймаут одной команды по умолчанию, **секунды** (как у `execute_shell`).
 *
 * Ограничение — **на команду**, а не на вызов: команды идут последовательно,
 * и модель должна видеть, какая именно не уложилась.
 */
const DEFAULT_TIMEOUT_SEC = 120;

/** Текст отказа, когда роутера исполнения нет (inline/без пулов). */
const NO_ROUTER_TEXT =
  'Sandbox execution is unavailable: no execution router '
  + '(requires execution.mode=remote with a pool provider).';

const sandboxExecSchema = z.object({
  profile: z
    .string()
    .min(1)
    .describe(
      'Execution profile name for the sandbox pool (from the instance execution profile catalog)',
    ),
  commands: z
    .array(z.string().min(1))
    .min(1)
    .max(SANDBOX_MAX_COMMANDS)
    .describe(
      `Shell commands (bash) to run sequentially in the sandbox, 1..${SANDBOX_MAX_COMMANDS}; `
      + 'execution stops at the first failure',
    ),
  cwd: z
    .string()
    .optional()
    .describe(
      'Working directory for the commands (absolute or relative to the working directory; '
      + 'defaults to the working directory)',
    ),
  timeout: timeoutParam({
    max: TIMEOUT_FG_MAX_SEC,
    description: 'Timeout per command in seconds (default: 120; max 600)',
  }),
});

/** Разобранные аргументы `sandbox_exec`. */
type SandboxExecParams = z.infer<typeof sandboxExecSchema>;

/** Один блок отчёта по команде: заголовок, вывод, код выхода либо ошибка. */
function commandReport(params: {
  profile: string;
  command: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  error?: string;
}): string {
  const lines: string[] = [`[sandbox:${params.profile}] $ ${params.command}`];
  const stdout = params.stdout ?? '';
  if (stdout !== '') {
    lines.push(stdout);
  }
  const stderr = params.stderr ?? '';
  if (stderr !== '') {
    lines.push('[stderr]', stderr);
  }
  if (params.error !== undefined) {
    lines.push(`Error: ${params.error}`);
  } else {
    lines.push(`(exit ${params.exitCode ?? 0})`);
  }
  return lines.join('\n');
}

export const sandboxExecTool: ToolDefinition = {
  name: 'sandbox_exec',
  description:
    'Run up to 5 shell commands (bash) sequentially in a SEPARATE sandbox execution pool bound to the given '
    + 'execution profile — a different image/toolchain than the session workspace (use execute_shell for the '
    + 'project working tree). Each command starts in `cwd` (absolute or relative to the working directory; '
    + 'defaults to the working directory) and execution stops at the first failure. '
    + 'Timeout in seconds: 120 per command by default (set timeout to change it, 1..600). '
    + 'Returns the per-command stdout, stderr, and exit code. '
    + 'Permission-wise this tool belongs to the `shell` group; it does not apply the shell guard of '
    + 'execute_shell (the command runs in another pool), and it is unavailable when the instance runs '
    + 'execution inline (no pool provider).',
  parameters: sandboxExecSchema,
  capabilities: [ToolCapability.SHELL],
  async execute(args, ctx): Promise<ToolResult> {
    // «Стоп» пришёл до запуска — ни одна команда не стартует (tools/abort.ts).
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = sandboxExecSchema.safeParse(args);
    if (!parsed.success) {
      return argErrorResult(this.name, parsed.error.issues);
    }
    const params: SandboxExecParams = parsed.data;
    if (params.cwd !== undefined) validateInputPath(params.cwd, 'cwd');

    // Роутер — шов оркестратора (`ctx.extra.executionRouter`). Нет его —
    // пулов нет вовсе, inline-фоллбэк здесь недопустим (см. шапку файла).
    const router = resolveExecutionRouter(ctx);
    if (!router) {
      return { content: NO_ROUTER_TEXT, isError: true, metadata: { profile: params.profile } };
    }

    const cwd = resolvePath(params.cwd, ctx.workingDir);
    // Лексический периметр: реальный containment — на стороне исполнителя
    // (у пула свой workspace). Внешний путь — обычный `external_directory`
    // отказ, как у файловых тулов.
    const roots = toolRoots(ctx);
    if (roots.length > 0 && !roots.some((root) => isLexicallyInside(root, cwd))) {
      return pathEscapesWorkspaceResult(cwd);
    }

    let port: ReturnType<typeof router.portFor>;
    try {
      // Класс пула `sandbox` входит в ключ (`poolKeyString`): тул адресует
      // отдельный пул своего профиля, а не пул обычных команд области.
      port = router.portFor({
        profile: params.profile,
        projectId: ctx.projectId,
        sessionId: ctx.sessionId,
        workspaceSubPath: (ctx.extra as { executionWorkspaceSubPath?: string } | undefined)
          ?.executionWorkspaceSubPath,
        class: 'sandbox',
      });
    } catch (err) {
      // `fallback: fail` без идентификатора области/профиля — fail-closed
      // роутера; это отказ тула, а не падение шага.
      return {
        content: `Sandbox execution is unavailable: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
        metadata: { profile: params.profile },
      };
    }

    // Параметр тула — **секунды**; в порт уходит миллисекунды (перевод на
    // границе, внутренний контракт остаётся в мс).
    const timeoutMs = (params.timeout ?? DEFAULT_TIMEOUT_SEC) * 1000;
    const reports: string[] = [];
    const exitCodes: number[] = [];
    let failed = false;

    for (const command of params.commands) {
      try {
        const result = await port.execute({
          // Оболочка — bash явно (как `execute_shell`): `/bin/sh` в образах
          // это dash/busybox ash, bash-синтаксис агентских команд там не работает.
          command: { kind: 'shell', command, shell: 'bash' },
          cwd,
          timeoutMs,
          // «Стоп» сессии прерывает команду (порт убивает процесс).
          signal: ctx.abortSignal,
          maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
        });
        exitCodes.push(result.exitCode);
        reports.push(
          commandReport({
            profile: params.profile,
            command,
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode,
          }),
        );
      } catch (err) {
        // Прерывание пользователем — единый маркер отмены + уже собранный отчёт.
        if (isAborted(ctx)) {
          return abortedResult(this.name, reports.join('\n\n') || undefined);
        }
        const execError = err as Partial<ExecutionError> & { message?: string };
        const numericCode = typeof execError.code === 'number' ? execError.code : -1;
        exitCodes.push(numericCode);
        reports.push(
          commandReport({
            profile: params.profile,
            command,
            stdout: isExecutionError(err) ? execError.stdout : undefined,
            stderr: isExecutionError(err) ? execError.stderr : undefined,
            error: execError.message || 'command failed',
          }),
        );
        failed = true;
        // Останавливаемся: следующая команда могла бы зависеть от успеха этой.
        break;
      }
    }

    return {
      content: reports.join('\n\n'),
      ...(failed ? { isError: true } : {}),
      metadata: {
        profile: params.profile,
        commands: [...params.commands],
        cwd,
        exit_codes: exitCodes,
      },
    };
  },
};

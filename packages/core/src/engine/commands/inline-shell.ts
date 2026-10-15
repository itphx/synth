import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * ADR-046 §7.4: исполнение inline shell (`` !`cmd` ``) шаблонной команды.
 *
 * Это низкоуровневый исполнитель: permission-проверку (`PermissionEvaluator`,
 * ADR-029) и аудит делает вызывающая сторона (оркестратор). Параметры процесса
 * зеркалят тул `execute_shell`: `sh -c`, timeout 30 c, maxBuffer 10 MB,
 * `signal` сессии для «Стоп».
 */
export const INLINE_SHELL_TIMEOUT_MS = 30_000;

/** Буфер процесса (10 MB) — как у `execute_shell`; обрезка до 50 KB — в template.ts. */
export const INLINE_SHELL_MAX_BUFFER = 10 * 1024 * 1024;

export interface InlineShellExecution {
  output: string;
  isError: boolean;
  exitCode: number;
}

export interface InlineShellOptions {
  command: string;
  workingDir: string;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Запускает команду и возвращает объединённый вывод (stdout + stderr).
 * Пустой вывод — пустая строка (в отличие от тула, который подставляет маркер
 * `tool.empty_output`). Ошибка процесса/ненулевой код/отмена — `isError: true`.
 */
export async function runInlineShell(opts: InlineShellOptions): Promise<InlineShellExecution> {
  try {
    const { stdout, stderr } = await execFileAsync('sh', ['-c', opts.command], {
      cwd: opts.workingDir,
      timeout: opts.timeoutMs ?? INLINE_SHELL_TIMEOUT_MS,
      signal: opts.abortSignal,
      maxBuffer: INLINE_SHELL_MAX_BUFFER,
      env: { ...process.env, HOME: process.env.HOME || '/root' },
    });
    let output = stdout ?? '';
    if (stderr) output += (output ? '\n--- stderr ---\n' : '') + stderr;
    return { output, isError: false, exitCode: 0 };
  } catch (err: unknown) {
    const execError = err as { stdout?: string; stderr?: string; code?: number; message?: string };
    let output = execError.stdout ?? '';
    if (execError.stderr) output += (output ? '\n--- stderr ---\n' : '') + execError.stderr;
    if (!output) output = execError.message ?? '';
    return {
      output,
      isError: true,
      exitCode: typeof execError.code === 'number' ? execError.code : -1,
    };
  }
}

import { readFile, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import type { CommandDiagnostic } from '@itphx/synth-shared';
import { t as sm } from '../system-messages.js';
import type { TemplateCommand } from './types.js';

/** Лимит одного supporting-файла, подставляемого через `@file` (50 KB). */
export const TEMPLATE_FILE_MAX_BYTES = 50 * 1024;

/** ADR-046 §7.4: лимит вывода одной inline shell-команды (50 KB). */
export const TEMPLATE_SHELL_MAX_BYTES = 50 * 1024;

export interface RenderTemplateOptions {
  workingDir: string;
  args: string;
  maxArgumentsLength: number;
  maxRenderedBytes: number;
  /** ADR-046 §7.4: включён ли inline shell (`` !`cmd` ``); по умолчанию выключено. */
  inlineShell?: boolean;
  /** ADR-046 §7.4: раннер (уже прошёл permission в оркестраторе). */
  runShell?: (cmd: string) => Promise<{ output: string; isError: boolean }>;
}

export interface RenderTemplateResult {
  content: string;
  diagnostics: CommandDiagnostic[];
  /** Подставленные файлы (относительные пути). */
  files: string[];
}

/** Безопасный резолв внутри каталога (защита от `..`/абсолютных путей). */
export function resolveInDir(baseDir: string, relPath: string): string | null {
  const base = resolve(baseDir);
  const target = resolve(base, relPath);
  if (target === base) return null;
  if (!target.startsWith(base.endsWith(sep) ? base : base + sep)) return null;
  return target;
}

/** Эвристика бинарного файла: NUL-байт в первых 8 KB. */
export function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** Обрезка строки до `maxBytes` по UTF-8 (не рвёт многобайтовые символы). */
function truncateUtf8(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, 'utf-8') <= maxBytes) return s;
  let bytes = 0;
  let end = s.length;
  for (let i = 0; i < s.length; i++) {
    const b = Buffer.byteLength(s[i]!, 'utf-8');
    if (bytes + b > maxBytes) { end = i; break; }
    bytes += b;
  }
  return s.slice(0, end);
}

/**
 * ADR-046 §7.2: рендер шаблонной команды. Подстановки:
 * - `$ARGUMENTS` — аргументы после имени команды (лимит `maxArgumentsLength`);
 * - `@path` — содержимое файла относительно `workingDir` (защита от escape,
 *   бинарники и превышение размера отклоняются с диагностикой);
 * - `$1`..`$9` — позиционные аргументы.
 * Результат ограничен `maxRenderedBytes`.
 */
export async function renderTemplate(
  command: TemplateCommand,
  opts: RenderTemplateOptions,
): Promise<RenderTemplateResult> {
  const diagnostics: CommandDiagnostic[] = [];
  const files: string[] = [];
  const args = opts.args.slice(0, opts.maxArgumentsLength);
  const positional = args.split(/\s+/).filter((x) => x.length > 0);

  let content = command.body;
  content = content.replace(/\$ARGUMENTS/g, args);
  content = content.replace(/\$([1-9])/g, (_m, d: string) => positional[Number(d) - 1] ?? '');

  // ADR-046 §7.4: inline shell `` !`cmd` ``. По умолчанию выключено — литерал
  // остаётся нетронутым (диагностического шума не создаём). При включении
  // команда исполняется ТОЛЬКО через переданный раннер: permission-проверку
  // (ADR-029) и аудит делает оркестратор, сервис команд их не дублирует.
  if (opts.inlineShell === true) {
    if (!opts.runShell) {
      diagnostics.push({
        level: 'warning',
        code: 'read-error',
        message: sm('command.inline_shell_unavailable'),
        command: command.name,
      });
    } else {
      // Токен в начале строки или после пробела; команда — без переносов строк.
      const shellRefs = [...content.matchAll(/(^|\s)!`([^`\n]+)`/g)];
      for (const match of shellRefs) {
        const shellCmd = match[2]!;
        let output: string;
        let isError: boolean;
        try {
          const res = await opts.runShell(shellCmd);
          output = res.output ?? '';
          isError = res.isError;
        } catch {
          output = '';
          isError = true;
        }
        if (Buffer.byteLength(output, 'utf-8') > TEMPLATE_SHELL_MAX_BYTES) {
          output = truncateUtf8(output, TEMPLATE_SHELL_MAX_BYTES);
          diagnostics.push({
            level: 'warning',
            code: 'read-error',
            message: sm('command.inline_shell_truncated', { limit: String(TEMPLATE_SHELL_MAX_BYTES) }),
            command: command.name,
          });
        }
        if (isError) {
          diagnostics.push({
            level: 'warning',
            code: 'read-error',
            message: sm('command.inline_shell_failed', { output }),
            command: command.name,
          });
        }
        content = content.split(match[0]).join(`${match[1]}${output}`);
      }
    }
  }

  // `@file` — только в начале токена (как у opencode). Не трогаем email-подобное.
  const refs = [...content.matchAll(/(^|\s)@([^\s@]+)/g)];
  for (const match of refs) {
    const rawRef = match[2]!;
    const rel = rawRef.replace(/[.,;:!?]+$/, '');
    const target = resolveInDir(opts.workingDir, rel);
    if (!target) {
      diagnostics.push({
        level: 'warning',
        code: 'read-error',
        message: `ссылка @${rel} выходит за пределы рабочего каталога`,
        command: command.name,
      });
      content = content.split(match[0]).join('');
      continue;
    }
    try {
      const info = await stat(target);
      if (!info.isFile()) throw new Error('not a file');
      if (info.size > TEMPLATE_FILE_MAX_BYTES) {
        diagnostics.push({
          level: 'warning',
          code: 'read-error',
          message: `файл ${rel} превышает лимит ${TEMPLATE_FILE_MAX_BYTES} байт`,
          command: command.name,
        });
        continue;
      }
      const buf = await readFile(target);
      if (looksBinary(buf)) {
        diagnostics.push({
          level: 'warning',
          code: 'read-error',
          message: `файл ${rel} — бинарный, подстановка пропущена`,
          command: command.name,
        });
        continue;
      }
      content = content.split(match[0]).join(`${match[1]}${buf.toString('utf-8')}`);
      files.push(rel);
    } catch {
      diagnostics.push({
        level: 'warning',
        code: 'read-error',
        message: `не удалось прочитать файл ${rel}`,
        command: command.name,
      });
    }
  }

  if (Buffer.byteLength(content, 'utf-8') > opts.maxRenderedBytes) {
    content = truncateUtf8(content, opts.maxRenderedBytes);
    diagnostics.push({
      level: 'warning',
      code: 'read-error',
      message: `рендер команды ${command.name} обрезан до ${opts.maxRenderedBytes} байт`,
      command: command.name,
    });
  }

  return { content, diagnostics, files };
}

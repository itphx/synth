/**
 * ADR-024/fs.changed: классификация мутирующих tool-вызовов для WS-события
 * `fs.changed`. Ядро публикует событие после успешного тула, UI по нему
 * инвалидирует дерево Files, открытые редакторы и Git-вкладку (debounce).
 *
 * Событие даёт максимально точный scope:
 * - `file` — для тулов, работающих с одним путём внутри workspace (дерево можно
 *   обновить точечно; редактор перечитывает только затронутый файл);
 * - `all` — для «широких» мутирующих тулов (shell/git/проектные) либо когда путь
 *   неизвестен/вне workspace.
 *
 * Read-only тулы возвращают `null` — события не публикуются.
 */

import { isAbsolute, relative, resolve, sep } from 'node:path';

/** Операция, которую выполнил инструмент (для точной инвалидации в UI). */
export type FsChangeOp = 'write' | 'delete' | 'mkdir' | 'move';

export interface FsChange {
  scope: 'file' | 'all';
  /** Относительные пути внутри workspace проекта, POSIX (`foo/bar.txt`, `dir`). */
  paths?: string[];
  /** Смена рабочего каталога проекта (`project_workspace_set`). */
  workspaceChanged?: boolean;
  /** Тип операции для `scope:'file'`; у «широких» тулов не задаётся. */
  op?: FsChangeOp;
  /** Для `op:'move'` — исходный относительный POSIX-путь внутри workspace. */
  from?: string;
  /** Для `op:'move'` — целевой относительный POSIX-путь внутри workspace. */
  to?: string;
}

/** Тулы записи в единичный файл/каталог → операция события `fs.changed`. */
const FILE_TOOL_OPS: Record<string, FsChangeOp> = {
  write_file: 'write',
  edit_file: 'write',
  delete_file: 'delete',
  create_directory: 'mkdir',
};

/** Тулы записи в единичный файл/каталог — могут дать точный относительный путь. */
const FILE_MUTATING_TOOLS = new Set(Object.keys(FILE_TOOL_OPS));

/** «Широкие» мутирующие тулы — обновляем всё дерево проекта. */
const BROAD_MUTATING_TOOLS = new Set([
  'execute_shell',
  'git_commit',
  'git_push',
  'git_pull',
  'git_checkout',
  'git_stash',
  'project_repo_clone',
  'project_repo_init',
  'project_repo_fetch',
  'project_repo_remove',
  'project_create',
  'project_attach',
  'task',
]);

/**
 * Символы, при которых команда не считается «простой»: shell-метасимволы,
 * перенаправления, подстановки, переменные, glob. Такие `mv` разбирать нельзя —
 * fallback на `{scope:'all'}`.
 */
const SHELL_UNSAFE_CHARS = /[;&|<>`$()\n\r*?[\]{}]/;

/**
 * Токенизация простой команды: пробелы/табы — разделители, операнды могут быть
 * обрамлены одинарными/двойными кавычками (снимаются). Незакрытая кавычка или
 * другой тип кавычки внутри строки → `null` (не разбираем).
 */
function tokenizeSimple(command: string): string[] | null {
  const tokens: string[] = [];
  let i = 0;
  while (i < command.length) {
    while (i < command.length && (command[i] === ' ' || command[i] === '\t')) i++;
    if (i >= command.length) break;

    let token = '';
    let hasContent = false;
    while (i < command.length && command[i] !== ' ' && command[i] !== '\t') {
      const ch = command[i]!;
      if (ch === '"' || ch === "'") {
        i++;
        let closed = false;
        while (i < command.length) {
          const inner = command[i]!;
          if (inner === ch) {
            closed = true;
            i++;
            break;
          }
          if (inner === '"' || inner === "'") return null; // иные кавычки внутри
          token += inner;
          i++;
        }
        if (!closed) return null;
        hasContent = true;
      } else {
        token += ch;
        i++;
        hasContent = true;
      }
    }
    if (hasContent) tokens.push(token);
  }
  return tokens;
}

/**
 * Разбирает простую команду `mv [flags] <src> <dst>` / `git mv [flags] <src> <dst>`.
 * Возвращает операнды либо `null` (цепочки, подстановки, glob, не то число путей).
 */
function parseMoveOperands(command: string): { src: string; dst: string } | null {
  if (SHELL_UNSAFE_CHARS.test(command)) return null;

  const tokens = tokenizeSimple(command);
  if (!tokens || tokens.length < 3) return null;

  let idx: number;
  if (tokens[0] === 'mv') {
    idx = 1;
  } else if (tokens[0] === 'git' && tokens[1] === 'mv') {
    idx = 2;
  } else {
    return null;
  }

  const operands: string[] = [];
  for (; idx < tokens.length; idx++) {
    const token = tokens[idx]!;
    if (token.startsWith('-')) continue; // флаги
    operands.push(token);
  }
  if (operands.length !== 2) return null;

  const [src, dst] = operands as [string, string];
  if (!src || !dst) return null;
  return { src, dst };
}

/** Путь относительно `workingDir` → POSIX-относительный; вне workspace → `null`. */
function toWorkspaceRel(workingDir: string, rawPath: string): string | null {
  const rel = relative(resolve(workingDir), resolve(workingDir, rawPath));
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return rel.split(sep).join('/');
}

/** `execute_shell` с простой `mv`/`git mv` внутри workspace → move-изменение. */
function resolveShellMove(
  args: Record<string, unknown> | undefined,
  workingDir: string,
): FsChange | null {
  const command = args?.command;
  if (typeof command !== 'string') return null;
  const operands = parseMoveOperands(command);
  if (!operands) return null;

  const from = toWorkspaceRel(workingDir, operands.src);
  const to = toWorkspaceRel(workingDir, operands.dst);
  if (!from || !to) return null;

  return { scope: 'file', paths: [from, to], op: 'move', from, to };
}

/**
 * Определяет, какое `fs.changed` нужно опубликовать после тула.
 * Возвращает `null` для read-only тулов (или неизвестных — консервативно не шумим).
 */
export function resolveFsChange(
  toolName: string,
  metadata: Record<string, unknown> | undefined,
  workingDir: string,
  args?: Record<string, unknown>,
): FsChange | null {
  // Смена рабочего каталога проекта — отдельный флаг для UI (сброс дерева).
  if (toolName === 'project_workspace_set') {
    return { scope: 'all', workspaceChanged: true };
  }
  // execute_shell (широкий тул): точный move, если это простая `mv`/`git mv`.
  if (toolName === 'execute_shell') {
    return resolveShellMove(args, workingDir) ?? { scope: 'all' };
  }
  if (BROAD_MUTATING_TOOLS.has(toolName)) {
    return { scope: 'all' };
  }
  if (!FILE_MUTATING_TOOLS.has(toolName)) {
    return null;
  }

  const rawPath = metadata?.path;
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    return { scope: 'all' };
  }

  const rel = relative(resolve(workingDir), resolve(rawPath));
  // Путь вне workspace (`..`, абсолютный) или совпадает с корнем — обновляем всё.
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return { scope: 'all' };
  }

  // Приводим разделители к POSIX (контракт события).
  const posixRel = rel.split(sep).join('/');
  return { scope: 'file', paths: [posixRel], op: FILE_TOOL_OPS[toolName] };
}

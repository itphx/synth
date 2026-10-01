/**
 * AD-024/fs.changed: классификация мутирующих tool-вызовов для WS-события
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
export type FsChangeOp = 'write' | 'delete' | 'mkdir';

export interface FsChange {
  scope: 'file' | 'all';
  /** Относительные пути внутри workspace проекта, POSIX (`foo/bar.txt`, `dir`). */
  paths?: string[];
  /** Смена рабочего каталога проекта (`project_workspace_set`). */
  workspaceChanged?: boolean;
  /** Тип операции для `scope:'file'`; у «широких» тулов не задаётся. */
  op?: FsChangeOp;
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
 * Определяет, какое `fs.changed` нужно опубликовать после тула.
 * Возвращает `null` для read-only тулов (или неизвестных — консервативно не шумим).
 */
export function resolveFsChange(
  toolName: string,
  metadata: Record<string, unknown> | undefined,
  workingDir: string,
): FsChange | null {
  // Смена рабочего каталога проекта — отдельный флаг для UI (сброс дерева).
  if (toolName === 'project_workspace_set') {
    return { scope: 'all', workspaceChanged: true };
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

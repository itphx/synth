import { ToolCapability } from '@itphx/synth-shared';

/**
 * ADR-029: соответствие групп permissions → конкретные имена тулов.
 * Секция `read` применяется к read_file/list_directory/glob, `edit` — к
 * write_file/edit_file/create_directory/delete_file и т.п.
 * Группы можно указывать короткими именами (read/edit/shell/...) или
 * capability-именами из ToolCapability (file_read/file_write/...).
 */

const READ_TOOLS = ['read_file', 'list_directory', 'glob'];
const WRITE_TOOLS = ['write_file', 'edit_file', 'create_directory', 'delete_file'];
const GIT_READ_TOOLS = ['git_status', 'git_diff', 'git_log', 'git_branch_list', 'git_show', 'git_blame'];
const GIT_WRITE_TOOLS = ['git_commit', 'git_push', 'git_pull', 'git_checkout', 'git_stash', 'project_repo_clone', 'project_repo_init', 'project_repo_fetch'];
const GIT_TOOLS = [...GIT_READ_TOOLS, ...GIT_WRITE_TOOLS];
const RUNTIME_TOOLS = [
  'classify_conversation',
  'read_session_reference',
  'get_project_info',
  'list_repos',
  'plan_enter',
  'plan_exit',
  'todo_write',
  'todo_list',
  'todo_add',
  'todo_update',
  'todo_delete',
  'project_create',
  'project_attach',
  'project_update',
  'project_workspace_set',
  'project_repo_add',
  'project_repo_remove',
  'project_log_write',
  'project_log_read',
  'project_invariants_read',
  'project_invariants_write',
];

export const PERMISSION_GROUPS: Record<string, string[]> = {
  read: READ_TOOLS,
  edit: WRITE_TOOLS,
  shell: ['execute_shell'],
  search: ['grep_files', 'glob'],
  web: ['web_fetch', 'web_search'],
  git: GIT_TOOLS,
  task: ['task'],
  mcp: [],
  runtime: RUNTIME_TOOLS,
  user: ['profile_update'],
  [ToolCapability.FILE_READ]: READ_TOOLS,
  [ToolCapability.FILE_WRITE]: WRITE_TOOLS,
  [ToolCapability.GIT_READ]: GIT_READ_TOOLS,
  [ToolCapability.GIT_WRITE]: GIT_WRITE_TOOLS,
};

/** Порядок проверки групповых правил (первая сработавшая группа побеждает). */
export const PERMISSION_GROUP_ORDER: string[] = [
  'read',
  'edit',
  'shell',
  'search',
  'web',
  'git',
  'task',
  'mcp',
  'runtime',
  'user',
  ToolCapability.FILE_READ,
  ToolCapability.FILE_WRITE,
  ToolCapability.GIT_READ,
  ToolCapability.GIT_WRITE,
];

/** Имена параметров тулов, которые являются путями к файлам/директориям. */
export const TOOL_PATH_PARAMS: Record<string, string[]> = {
  read_file: ['file_path'],
  list_directory: ['path'],
  glob: ['path'],
  write_file: ['file_path'],
  edit_file: ['file_path'],
  delete_file: ['file_path'],
  create_directory: ['path'],
  execute_shell: ['cwd'],
  grep_files: ['path'],
  git_status: ['path'],
  git_diff: ['path'],
  git_log: ['path'],
  git_commit: ['path'],
  git_push: ['path'],
  git_pull: ['path'],
  git_checkout: ['path'],
  git_branch_list: ['path'],
  git_show: ['path'],
  git_blame: ['path'],
  git_stash: ['path'],
};

/** Группы, к которым принадлежит тул (по имени и по capabilities). */
export function getToolGroups(toolName: string, capabilities?: readonly string[]): string[] {
  const result: string[] = [];
  for (const group of PERMISSION_GROUP_ORDER) {
    const tools = PERMISSION_GROUPS[group];
    if (!tools) continue;
    if (tools.includes(toolName)) {
      result.push(group);
      continue;
    }
    // Динамические MCP-инструменты не имеют фиксированного имени — матчим по capability
    if (group === 'mcp' && capabilities?.includes(ToolCapability.MCP)) {
      result.push(group);
      continue;
    }
    // Capability-имена групп можно матчить напрямую по capabilities тула
    if (capabilities?.includes(group)) {
      result.push(group);
    }
  }
  return result;
}

/** Есть ли у тула файловые параметры (read/edit/external_directory имеют смысл). */
export function isFileTool(toolName: string): boolean {
  return (TOOL_PATH_PARAMS[toolName]?.length ?? 0) > 0;
}

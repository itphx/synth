import { ToolCapability, type ToolSource } from '@itphx/synth-shared';

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

/**
 * ADR-101: тулы пайплайнов проекта (спецификация, версии, прогоны, шаблоны).
 *
 * Отдельные группы read/write — чтобы правило permission-слоя могло разделить
 * чтение и мутацию (ADR-029). Имена тулов — единственный источник истины для
 * блокировки в plan-режиме (`isPlanBlockedTool`, `permission/evaluator.ts`).
 */
export const PIPELINE_READ_TOOLS = [
  'pipeline_list',
  'pipeline_get',
  'pipeline_run_status',
  'pipeline_run_list',
  'pipeline_templates',
];

export const PIPELINE_WRITE_TOOLS = [
  'pipeline_save',
  'pipeline_publish',
  'pipeline_delete',
  'pipeline_run',
  'pipeline_run_resume',
  'pipeline_run_cancel',
  'pipeline_instantiate',
];

/**
 * ADR-051: тулы расписаний планировщика.
 *
 * Фундамент заложен вместе с capability `schedule`; сами тулы — следующий
 * этап (Stage C), но группа и список имён нужны уже сейчас: правила
 * permission-слоя и блокировка в plan-режиме не должны «появиться» позже
 * отдельным изменением.
 */
export const SCHEDULE_READ_TOOLS = ['schedule_list', 'schedule_get', 'schedule_jobs'];

export const SCHEDULE_WRITE_TOOLS = ['schedule_save', 'schedule_delete', 'schedule_run'];

/** Все тулы пайплайнов (read + write). */
export const PIPELINE_TOOLS = [...PIPELINE_READ_TOOLS, ...PIPELINE_WRITE_TOOLS];
/** Все тулы расписаний (read + write). */
export const SCHEDULE_TOOLS = [...SCHEDULE_READ_TOOLS, ...SCHEDULE_WRITE_TOOLS];

export const PERMISSION_GROUPS: Record<string, string[]> = {
  read: READ_TOOLS,
  edit: WRITE_TOOLS,
  shell: ['execute_shell'],
  search: ['grep_files', 'glob'],
  web: ['web_fetch', 'web_search'],
  git: GIT_TOOLS,
  task: ['task'],
  mcp: [],
  plugin: [],
  runtime: RUNTIME_TOOLS,
  user: ['profile_update'],
  // ADR-107: память — capability тулов плагина памяти; группа пустая (имён
  // встроенных тулов нет), матчится по capability `memory` у плагинного тула.
  memory: [],
  // ADR-101: пайплайны проекта (спецификация/прогоны/шаблоны). Ключ группы
  // совпадает со значением capability `pipeline` — поэтому правило
  // `permission.rules.pipeline` работает и по именам встроенных тулов, и по
  // capability плагинного тула (как `runtime`/`mcp`).
  pipeline: PIPELINE_TOOLS,
  // ADR-051: расписания планировщика (ключ совпадает с capability `schedule`).
  schedule: SCHEDULE_TOOLS,
  [ToolCapability.FILE_READ]: READ_TOOLS,
  [ToolCapability.FILE_WRITE]: WRITE_TOOLS,
  [ToolCapability.GIT_READ]: GIT_READ_TOOLS,
  [ToolCapability.GIT_WRITE]: GIT_WRITE_TOOLS,
};

/**
 * Порядок проверки групповых правил (первая сработавшая группа побеждает).
 *
 * Группы `pipeline`/`schedule` стоят **в конце**: их наборы имён не
 * пересекаются с прочими группами, поэтому порядок не меняет разрешение
 * существующих правил — а новые группы не сдвигают порядок проверки старых.
 */
export const PERMISSION_GROUP_ORDER: string[] = [
  'read',
  'edit',
  'shell',
  'search',
  'web',
  'git',
  'task',
  'mcp',
  'plugin',
  'runtime',
  'user',
  'memory',
  ToolCapability.FILE_READ,
  ToolCapability.FILE_WRITE,
  ToolCapability.GIT_READ,
  ToolCapability.GIT_WRITE,
  'pipeline',
  'schedule',
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
export function getToolGroups(
  toolName: string,
  capabilities?: readonly string[],
  /**
   * Источник тула (`ToolDefinition.source`, ADR-071 §2.1 + ADR-090). Не задан — считается встроенным.
   *
   * Нужен для групп, которые **не выражаются** именем или capability:
   * MCP-инструменты матчатся по capability `mcp`, а инструменты плагинов —
   * по источнику `plugin` (у них свои, содержательные capabilities вроде
   * `file_read`, и группа `plugin` должна срабатывать поверх них).
   */
  source?: ToolSource,
): string[] {
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
    // Инструменты плагинов (ADR-090, Ф3в): группа по источнику, а не по
    // capability — плагин не может «выписаться» из правила `plugin`.
    if (group === 'plugin' && source === 'plugin') {
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

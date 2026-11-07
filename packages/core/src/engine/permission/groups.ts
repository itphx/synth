import { ToolCapability, type ToolSource } from '@itphx/synth-shared';

/**
 * ADR-029: соответствие групп permissions → конкретные имена тулов.
 * Секция `read` применяется к read_file/list_directory/glob, `edit` — к
 * write_file/edit_file/create_directory/delete_file и т.п.
 * Группы можно указывать короткими именами (read/edit/shell/...) или
 * capability-именами из ToolCapability (file_read/file_write/...).
 */

// ADR-115: `attach_workspace_file` читает файл проекта (запись — только в
// blob-хранилище вложений), поэтому его группа — как у файловых read-тулов.
// `list_models` — каталог моделей инстанса (только чтение, ADR-115), тоже `read`.
// `send_attachment` тоже только читает файл проекта (байты уходят в blob и в
// вложение ответа, workspace не мутируется) — группа `read`.
const READ_TOOLS = [
  'read_file',
  'list_directory',
  'glob',
  'attach_workspace_file',
  'list_models',
  'send_attachment',
];
const WRITE_TOOLS = ['write_file', 'edit_file', 'create_directory', 'delete_file', 'save_attachment', 'patch'];
// ADR-076: `ssh_keys_list` — метаданные SSH-ключей инстанса. Группа `git_read`
// (capability `git_read`, как у остальных читающих git-тулов), поэтому в
// plan-режиме тул разрешён; к рабочему каталогу проекта он не привязан
// (`isWorkspaceDependentTool` в `availability.ts`).
const GIT_READ_TOOLS = ['git_status', 'git_diff', 'git_log', 'git_branch_list', 'git_show', 'git_blame', 'git_worktree_list', 'ssh_keys_list'];
const GIT_WRITE_TOOLS = [
  'git_commit',
  'git_push',
  'git_pull',
  'git_checkout',
  'git_stash',
  'project_repo_clone',
  'project_repo_init',
  'project_repo_fetch',
  // ADR-114: мутации инвентаря git-worktree'ов (создание/удаление/prune) —
  // группа `git_write`, поэтому plan-режим их блокирует (ADR-029/ADR-025).
  'git_worktree_create',
  'git_worktree_remove',
  'git_worktree_prune',
];
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

/**
 * Этап 1 roadmap 0.13 (блок 3): тул `question` — вопрос пользователю посреди
 * хода.
 *
 * Отдельная группа (как `pipeline`/`schedule`): вопрос — доменный ресурс
 * (персистентная запись вопроса), а не примитив ядра. Ключ группы совпадает со
 * значением capability `question`, поэтому правило `permission.rules.question`
 * работает и по имени встроенного тула, и по capability плагинного тула.
 */
export const QUESTION_TOOLS = ['question'];

/**
 * Этап 1 roadmap 0.13 (блок 16): реестр фоновых прогонов (ADR-111/PROP-097).
 *
 * Отдельная группа (как `pipeline`/`schedule`/`question`): реестр фоновой
 * работы — доменный ресурс (персистентные записи прогонов + логи), а не
 * примитив ядра. Ключ группы совпадает со значением capability `process`,
 * поэтому правило `permission.rules.process` работает и по именам встроенных
 * тулов, и по capability плагинного тула.
 *
 * Группа `process` — чтение **и управление**: `process_list`/`process_logs` в
 * plan-режиме разрешены, `process_stop`/`process_delete` — заблокированы
 * (`isPlanBlockedTool`).
 */
export const PROCESS_TOOLS = ['process_list', 'process_logs', 'process_stop', 'process_delete'];

/**
 * PROP-124 §4/§9: адресные ssh-тулы (`ssh_exec` и дальше `ssh_copy`/
 * `ssh_tunnel`) — отдельная группа, как `pipeline`/`schedule`/`process`.
 *
 * Ключ группы совпадает со значением capability `ssh`, поэтому правило
 * `permission.rules.ssh` работает и по именам встроенных тулов, и по
 * capability плагинного тула. В plan-режиме группа блокируется целиком
 * (`isPlanBlockedTool`, `evaluator.ts`): план ничего не выполняет, а адресный
 * SSH — выполнение на удалённом хосте.
 */
export const SSH_TOOLS = ['ssh_exec', 'ssh_copy', 'ssh_tunnel'];

/**
 * ADR-039: операционный список задач сессии (`session.todos`, не `project.plan`).
 *
 * Имена **уже** входят в `RUNTIME_TOOLS` — группа `runtime` продолжает их
 * матчить (тул попадает в обе группы, `getToolGroups`), поэтому правило
 * `permission.rules.runtime` действует как прежде. Отдельная группа `todo`
 * нужна, чтобы админ/пользователь мог отключать именно список задач
 * (`permission.rules.todo`), не выключая остальные примитивы ядра.
 *
 * Capability `todo` — **в дополнение** к `runtime` (совместимость с
 * существующими агентами): у встроенных агентов она есть, кроме `title`.
 */
export const TODO_TOOLS = ['todo_write', 'todo_list', 'todo_add', 'todo_update', 'todo_delete'];

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
  // Этап 1 roadmap 0.13 (блок 3): вопрос пользователю (ключ совпадает с
  // capability `question`).
  question: QUESTION_TOOLS,
  // Этап 1 roadmap 0.13 (блок 16): реестр фоновых прогонов (ключ совпадает с
  // capability `process`).
  process: PROCESS_TOOLS,
  // PROP-124 §4/§9: адресные ssh-тулы (ключ совпадает с capability `ssh`).
  ssh: SSH_TOOLS,
  // ADR-039: список задач сессии (ключ совпадает с capability `todo`).
  // Имена дублируются в `runtime` намеренно: тул принадлежит обеим группам.
  todo: TODO_TOOLS,
  [ToolCapability.FILE_READ]: READ_TOOLS,
  [ToolCapability.FILE_WRITE]: WRITE_TOOLS,
  [ToolCapability.GIT_READ]: GIT_READ_TOOLS,
  [ToolCapability.GIT_WRITE]: GIT_WRITE_TOOLS,
};

/**
 * Порядок проверки групповых правил (первая сработавшая группа побеждает).
 *
 * Группы `pipeline`/`schedule`/`ssh` стоят **в конце**: их наборы имён не
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
  'question',
  'process',
  'ssh',
  'todo',
];

/** Имена параметров тулов, которые являются путями к файлам/директориям. */
export const TOOL_PATH_PARAMS: Record<string, string[]> = {
  read_file: ['file_path'],
  // ADR-115: путь к файлу из workspace — file-паттерны правил (`read`/
  // `external_directory`) применяются к привязке вложения так же, как к чтению.
  attach_workspace_file: ['path'],
  // ADR-115: путь к файлу, отправляемому в ответ, — file-паттерны правил
  // (`read`/`external_directory`) применяются так же, как к чтению.
  send_attachment: ['path'],
  // ADR-115: выгрузка вложения в workspace — путь назначения участвует в
  // file-паттернах (`edit`/`external_directory`), как у записи файлов.
  save_attachment: ['path'],
  list_directory: ['path'],
  glob: ['path'],
  write_file: ['file_path'],
  edit_file: ['file_path'],
  delete_file: ['file_path'],
  create_directory: ['path'],
  execute_shell: ['cwd'],
  grep_files: ['path'],
  // PROP-124 §4b: локальный путь адресного ssh-тула передачи файлов — путь
  // файла проекта: правила `external_directory`/`protected_paths` применяются к
  // нему так же, как к путям файловых тулов (передача наружу — тоже вынос
  // данных). Путь `remote` (на другом хосте) локальным путём **не** является и
  // в проверку не попадает.
  ssh_copy: ['local'],
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

/**
 * Пути одной правки `patch`.
 *
 * У `update`/`add`/`delete` путь лежит в `file_path`, у `rename` — в `from`
 * и `to` (оба участвуют в правилах: внешний доступ, `protected_paths`,
 * периметр цели). Правка без `op` — это `update` (обратная совместимость).
 */
function patchEditPaths(edit: unknown): string[] {
  if (!edit || typeof edit !== 'object') return [];
  const record = edit as { op?: unknown; file_path?: unknown; from?: unknown; to?: unknown };
  const op = typeof record.op === 'string' ? record.op : 'update';
  const names = op === 'rename' ? ['from', 'to'] : ['file_path'];
  const result: string[] = [];
  for (const name of names) {
    const value = record[name as 'file_path' | 'from' | 'to'];
    if (typeof value === 'string' && value.trim() !== '') result.push(value);
  }
  return result;
}

/**
 * Сырые файловые параметры тула (до `resolvePath`).
 *
 * Обычный случай — плоская карта `TOOL_PATH_PARAMS`. Особый случай — тул
 * `patch`: пути лежат во вложенном массиве `edits[]` (`file_path` либо
 * `from`/`to` у переименования), поэтому плоская карта их не описывает.
 * Ветка нужна, чтобы файловые паттерны правил, `external_directory`,
 * `protected_paths`, Authority-слой и матрица доверия работали для `patch`
 * так же, как для `write_file`/`edit_file`.
 *
 * Функция живёт здесь, а не в `evaluator.ts`: её используют и permission-слой,
 * и Authority-слой (`authority/target.ts`), и trust (`security/trust.ts`), а
 * `groups.ts` не импортирует движок — цикла зависимостей нет.
 */
export function extractPathParams(
  toolName: string,
  params: Record<string, unknown>,
): string[] {
  if (toolName === 'patch') {
    const edits = params.edits;
    if (!Array.isArray(edits)) return [];
    const result: string[] = [];
    for (const edit of edits) {
      result.push(...patchEditPaths(edit));
    }
    return result;
  }
  const paramNames = TOOL_PATH_PARAMS[toolName];
  if (!paramNames || paramNames.length === 0) return [];
  const result: string[] = [];
  for (const name of paramNames) {
    const value = params[name];
    if (typeof value === 'string' && value.trim() !== '') {
      result.push(value);
    }
  }
  return result;
}

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
  // `patch` несёт пути во вложенном `edits[]` — плоской карты TOOL_PATH_PARAMS нет.
  if (toolName === 'patch') return true;
  return (TOOL_PATH_PARAMS[toolName]?.length ?? 0) > 0;
}

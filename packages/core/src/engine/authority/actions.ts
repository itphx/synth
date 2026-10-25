/**
 * ADR-106 Ф1: отображение оси тулов на ось действий и целей.
 *
 * Authority-слой **доменно-нейтрален**: «действие» и «цель» — данные
 * (ADR-106 §«Доменная нейтральность»). Но в Ф0–Ф1 контента с доменными
 * ролями ещё нет, а shadow-решение должно быть чем-то Comparable с текущим
 * решением permission-слоя. Поэтому ядро держит **отображение** существующей
 * оси тулов на ось действий — ровно так, как предсказывает таблица
 * совместимости ADR-106: «`ToolCapability` (11 групп) — остаётся как
 * **отображение** действий на группы тулов».
 *
 * Это отображение — **мост миграции**, а не источник истины:
 * - доменные действия (`sign`, `approve`, `delegate`) приезжают контентом
 *   (`provides.authority.actions[]`) и имеют приоритет;
 * - тул, для которого отображения нет, **не угадывается**: действие
 *   неизвестно → `deny('unknown')` (fail-closed, ADR-106 §«Инварианты
 *   модели», п. 1). Отдельный тест фиксирует это поведение.
 *
 * Цели строятся по той же схеме: путь внутри workspace — `path:` с
 * **относительным** путём (без сырых абсолютных путей, инвариант 25/ADR-094),
 * рабочая область — `workspace:`, сессия — `session:`, внешний ресурс —
 * `external:`, MCP-инструмент — `mcp:`.
 *
 * ## Про автоматизацию (ADR-101/ADR-051)
 *
 * - **`pipeline_run_resume` → `approve`**: возобновление HITL-прогона — это
 *   решение человека о продолжении работы (ровно как `plan_exit`). Отдельного
 *   действия «resume» не заводим: доменные глаголы приезжают контентом, а
 *   базовый словарь ядра уже содержит `approve`.
 * - **Цель пайплайнов и расписаний — `session`**: проект — свойство сессии
 *   (ADR-014), а пайплайн/расписание живут внутри проекта сессии. Новый вид
 *   цели («pipeline») потребовал бы новых правил в политике полномочий и не
 *   усиливал бы контроль: право на проект уже выражено тем, что действие
 *   применяется к сессии.
 */
import { ToolCapability } from '@itphx/synth-shared';

/**
 * Базовый словарь действий ядра.
 *
 * Это **не** доменный словарь: доменные глаголы (`sign`, `invoice` и пр.)
 * приезжают контентом. Здесь — только действия, в которые проецируются
 * встроенные инструменты ядра, плюс базовые глаголы из модели
 * (ADR-106 §«Модель»).
 */
export const AUTHORITY_CORE_ACTIONS = [
  'read',
  'write',
  'execute',
  'commit',
  'publish',
  'approve',
  'sign',
  'delegate',
] as const;

export type AuthorityCoreAction = (typeof AUTHORITY_CORE_ACTIONS)[number];

const CORE_ACTIONS_SET: ReadonlySet<string> = new Set(AUTHORITY_CORE_ACTIONS);

/** true — действие известно ядру (без контента). */
export function isCoreAuthorityAction(id: string): id is AuthorityCoreAction {
  return CORE_ACTIONS_SET.has(id);
}

/**
 * Отображение имени тула на действие (мост миграции Ф1).
 *
 * Явно перечислены встроенные инструменты ядра; остальные (MCP/плагины)
 * проецируются по capability (`ToolCapability` → действие).
 */
const TOOL_ACTIONS: Readonly<Record<string, string>> = {
  // Чтение.
  read_file: 'read',
  list_directory: 'read',
  glob: 'read',
  grep_files: 'read',
  skill: 'read',
  plan_read: 'read',
  todo_list: 'read',
  project_log_read: 'read',
  project_invariants_read: 'read',
  get_project_info: 'read',
  list_repos: 'read',
  git_status: 'read',
  git_diff: 'read',
  git_log: 'read',
  git_branch_list: 'read',
  git_show: 'read',
  git_blame: 'read',
  web_fetch: 'read',
  web_search: 'read',
  // Запись.
  write_file: 'write',
  edit_file: 'write',
  create_directory: 'write',
  delete_file: 'write',
  plan_write: 'write',
  todo_write: 'write',
  todo_add: 'write',
  todo_update: 'write',
  todo_delete: 'write',
  project_log_write: 'write',
  project_invariants_write: 'write',
  project_create: 'write',
  project_attach: 'write',
  project_update: 'write',
  project_workspace_set: 'write',
  project_repo_add: 'write',
  project_repo_remove: 'write',
  profile_update: 'write',
  git_pull: 'write',
  git_checkout: 'write',
  git_stash: 'write',
  // Исполнение.
  execute_shell: 'execute',
  project_repo_clone: 'execute',
  project_repo_init: 'execute',
  project_repo_fetch: 'execute',
  // Коммит и публикация.
  git_commit: 'commit',
  git_push: 'commit',
  // Утверждение и делегирование.
  plan_exit: 'approve',
  task: 'delegate',
  task_resume: 'delegate',
  // ADR-101: пайплайны проекта. Чтение — `read`; правка спецификации —
  // `write`; публикация версии — `publish` (необратимое действие: версия
  // становится неизменяемой); запуск/отмена прогона — `execute` (движок
  // исполняет шаги); возобновление HITL-прогона — `approve` (решение
  // человека: ровно то же действие, что `plan_exit`).
  pipeline_list: 'read',
  pipeline_get: 'read',
  pipeline_run_status: 'read',
  pipeline_run_list: 'read',
  pipeline_templates: 'read',
  pipeline_save: 'write',
  pipeline_delete: 'write',
  pipeline_publish: 'publish',
  pipeline_run: 'execute',
  pipeline_run_cancel: 'execute',
  pipeline_instantiate: 'execute',
  pipeline_run_resume: 'approve',
  // ADR-051: расписания планировщика (область — свои + проект сессии).
  schedule_list: 'read',
  schedule_get: 'read',
  schedule_jobs: 'read',
  schedule_save: 'write',
  schedule_delete: 'write',
  schedule_run: 'execute',
};

/** Отображение capability на действие — для MCP/плагинных тулов. */
const CAPABILITY_ACTIONS: Readonly<Record<string, string>> = {
  [ToolCapability.FILE_READ]: 'read',
  [ToolCapability.FILE_WRITE]: 'write',
  [ToolCapability.SHELL]: 'execute',
  [ToolCapability.SEARCH]: 'read',
  [ToolCapability.WEB]: 'read',
  [ToolCapability.GIT_READ]: 'read',
  [ToolCapability.GIT_WRITE]: 'write',
  [ToolCapability.TASK]: 'delegate',
  [ToolCapability.RUNTIME]: 'write',
  [ToolCapability.USER]: 'write',
  // ADR-101/ADR-051: capability `pipeline`/`schedule` — фоллбак для
  // плагинных тулов с этими capability (встроенные тулы маппингом выше).
  [ToolCapability.PIPELINE]: 'write',
  [ToolCapability.SCHEDULE]: 'write',
};

/**
 * Действие тула; `undefined` — отображения нет (действие неизвестно →
 * `deny('unknown')`).
 */
export function authorityActionForTool(
  toolName: string,
  capabilities?: readonly string[],
): string | undefined {
  const byName = TOOL_ACTIONS[toolName];
  if (byName !== undefined) return byName;
  for (const capability of capabilities ?? []) {
    const action = CAPABILITY_ACTIONS[capability];
    if (action !== undefined) return action;
  }
  return undefined;
}

/**
 * Вид цели тула.
 *
 * Путь внутри workspace — `path`; рабочая область (shell/git) — `workspace`;
 * сессионные тулы (план, todo, профиль, делегирование) — `session`; веб —
 * `external`; MCP-инструменты — `mcp`.
 */
const TOOL_TARGET_KINDS: Readonly<Record<string, string>> = {
  read_file: 'path',
  list_directory: 'path',
  glob: 'path',
  grep_files: 'path',
  write_file: 'path',
  edit_file: 'path',
  create_directory: 'path',
  delete_file: 'path',
  execute_shell: 'workspace',
  git_status: 'workspace',
  git_diff: 'workspace',
  git_log: 'workspace',
  git_branch_list: 'workspace',
  git_show: 'workspace',
  git_blame: 'workspace',
  git_commit: 'workspace',
  git_push: 'workspace',
  git_pull: 'workspace',
  git_checkout: 'workspace',
  git_stash: 'workspace',
  project_repo_clone: 'workspace',
  project_repo_init: 'workspace',
  project_repo_fetch: 'workspace',
  project_repo_add: 'workspace',
  project_repo_remove: 'workspace',
  web_fetch: 'external',
  web_search: 'external',
  // ADR-101/ADR-051: пайплайны и расписания — **цель `session`**.
  //
  // Новые виды цели не вводим: проект — свойство сессии (ADR-014), а
  // пайплайн/расписание — доменный ресурс **внутри** проекта сессии. Отдельный
  // вид «pipeline» потребовал бы новых правил в политике полномочий и не
  // дал бы выигрыша: право на проект уже выражено тем, что действие
  // применяется к сессии её владельца.
  pipeline_list: 'session',
  pipeline_get: 'session',
  pipeline_run_status: 'session',
  pipeline_run_list: 'session',
  pipeline_templates: 'session',
  pipeline_save: 'session',
  pipeline_delete: 'session',
  pipeline_publish: 'session',
  pipeline_run: 'session',
  pipeline_run_cancel: 'session',
  pipeline_instantiate: 'session',
  pipeline_run_resume: 'session',
  schedule_list: 'session',
  schedule_get: 'session',
  schedule_jobs: 'session',
  schedule_save: 'session',
  schedule_delete: 'session',
  schedule_run: 'session',
};

/**
 * Вид цели тула; `undefined` — тул не выражается в known-видах цели
 * (тогда действие/цель считаются неизвестными → `deny('unknown')`).
 */
export function authorityTargetKindForTool(
  toolName: string,
  capabilities?: readonly string[],
  source?: string,
): string | undefined {
  const byName = TOOL_TARGET_KINDS[toolName];
  if (byName !== undefined) return byName;
  if (source === 'mcp') return 'mcp';
  if (capabilities?.includes(ToolCapability.MCP)) return 'mcp';
  if (capabilities?.includes(ToolCapability.SHELL)) return 'workspace';
  if (capabilities?.includes(ToolCapability.WEB)) return 'external';
  if (capabilities?.includes(ToolCapability.FILE_READ)) return 'path';
  if (capabilities?.includes(ToolCapability.FILE_WRITE)) return 'path';
  return 'session';
}

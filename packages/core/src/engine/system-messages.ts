/**
 * SystemMessages — словарь системных сообщений ядра (i18n ядра).
 *
 * Схема «LLM = один язык / UI = локализация»:
 *  - LLM-канал: все системные тексты (tool_result, assistant-фоллбеки,
 *    INFO-сообщения) — на английском, через t(key, params).
 *  - UI-канал: вместе с текстом наружу отдаётся metadata.i18n =
 *    { key, params } — UI рендерит перевод по ключу (formatMessage),
 *    fallback — на content (en).
 *
 * Плейсхолдеры — `{param}`, совместимы с formatMessage на UI.
 * Словарь — типобезопасный TS-объект (без файлового I/O).
 * Ключи — стабильные en-like идентификаторы с группировкой по префиксам:
 *   session.*, task.*, tool.*, fs.*, plan.*, todo.*, project.*, permission.*,
 *   shellguard.*, protectedpaths.*, security.*, gateway.*, router.*, qc.*, micro.*
 */
import { ENGINE_MESSAGE_KEYS, type EngineMessageKey } from '@itphx/synth-shared/i18n';
import type { MessageI18n } from '@itphx/synth-shared';

export const ENGINE_MESSAGE_KEYS_REGISTRY = ENGINE_MESSAGE_KEYS;

export const SYSTEM_MESSAGES = {
  // --- Сессия: статусы, заголовки, ссылки ---
  'session.max_iterations': '(tool iteration limit reached)',
  // Отчёт по исполненному шагу-лимиту основного агента (механика opencode):
  // пустой ответ на финальном шаге — говорим, что лимит шагов исчерпан.
  'session.steps_limit':
    'The step limit ({limit}) is exhausted: the agent stopped at the step limit without a textual report',
  'session.stopped': 'Processing stopped: {reason}',
  'session.stopped_reason_denied': 'the user denied the request',
  'session.denied_blocked': 'Could not proceed: the action was blocked by the security policy',
  'session.role_tool_blocked': 'Could not proceed: tool "{tool}" is unavailable to agent "{agent}" — delegate the task via @ (e.g. @fixer or @general) or explain it to the user.',
  'session.empty_response': 'Could not complete the request: the model response was empty',
  // Ответ срезан лимитом вывода (`max_tokens`): у reasoning-моделей весь
  // бюджет может уйти в размышления — видимого текста не остаётся вовсе.
  // `limit` — фактический расход вывода, `reasoning` — его часть на thinking.
  'session.output_limit':
    'The response was cut off by the output token limit: max_tokens={limit}, of which {reasoning} were spent on reasoning. Increase the response limit for this session and retry.',
  'session.default_title': 'New session',
  'session.reference_label': 'Session',
  'session.reference_link': 'Session link: {label} ({id}, messages {from}-{to})',
  'session.retry_cancelled': 'Retries cancelled by the user',
  'session.subtask_title': 'Subtask: {description}',

  // --- Управление сессиями из чата (list_sessions/get_session_info/rename) ---
  'session.list': 'Sessions ({count}):\n{items}',
  'session.list_empty': 'No sessions available.',
  'session.details': 'Session "{name}" ({id})\n{json}',
  'session.not_found': 'Error: session {id} not found',
  'session.rename_ok': 'Session renamed to "{title}".',
  'session.save_error': 'Error saving the session: {error}',
  'session.remote_truncated': 'Remote session list is truncated (page cap) — cross-world pagination is unavailable.',

  // --- Сабагент (task) ---
  'task.stopped_by_user': 'Task stopped by the user',
  'task.stopped_before_completion':
    'The task was stopped by the user before completion. Above is the partial subagent answer; completed steps are listed. Details and history are in the child session.',
  'task.stopped_by_deny': 'Processing stopped: the user denied the tool execution request',
  'task.empty_response': '(empty subagent response)',
  'task.subagent_exec_error': 'Subagent execution error "{type}": {error}',
  'task.subagent_not_found': 'Subagent "{type}" not found. Available types: {types}',
  'task.subagent_not_allowed': 'Agent "{type}" cannot be used as a subagent (modes: {modes})',
  'task.deps_unavailable': 'Error: provider or agent registry unavailable for subagent launch',
  'task.model_unavailable':
    'Error: the model "{provider}/{model}" requested for the subagent is unavailable — the provider is not configured or the model is unknown',
  'task.model_not_in_catalog':
    'Error: the model "{provider}/{model}" requested for the subagent is not in the instance model catalog (or is disabled). Available: {available}. Use the list_models tool to pick a provider/model pair.',
  'task.subagent_exec_error_after_retries': 'Subagent execution error "{type}" after {attempts} attempt(s): {error}',
  'task.depth_limit':
    'Subagent depth limit reached ({limit}). Finish the work in the current session instead of delegating further.',

  // --- Возобновление дочерней сессии саб-агента (resume) ---
  'task.resume_marker': 'Resume the interrupted task. Continue from where you stopped.',
  'task.resume_result': 'Resumed subagent "{type}" completed. Result:\n\n{summary}',
  'task.resume_failed': 'Resumed subagent "{type}" failed: {error}',
  'task.resume_aborted': 'Resumed subagent "{type}" was stopped by the user before completion.',
  'task.resume_session_not_found': 'Session {id} not found',
  'task.resume_no_parent': 'Session {id} is not a subagent session (no parent session) — resume is not applicable',
  'task.resume_parent_not_found': 'Parent session {id} not found — cannot resume the subagent session',
  'task.resume_locked': 'Session {id} is busy or already being resumed',
  'task.resume_agent_not_found': 'Agent "{type}" not found or cannot be used as a subagent',
  'task.resume_provider_unavailable': 'Provider is not configured for session {id} — cannot resume',

  // --- Фоновые саб-агенты и лимит шагов (этап 1 roadmap 0.13, блок 4) ---
  // `[steps_limit]` — короткая страховка после отчёта саб-агента: причина
  // (лимит шагов) и сам лимит. Подробности — в отчёте модели выше.
  'task.steps_limit':
    '[steps_limit] The subagent was stopped by the step limit ({limit}).',
  'task.steps_limit_empty':
    'The subagent exhausted the step limit ({limit}) and gave no textual answer; continue from its history or raise the limit',
  // Предохранитель по объёму промпта саб-агента (`agents.subagentMaxInputTokens`):
  // отчёт формируется детерминированно (без LLM), маркер `[context_budget]`.
  'task.context_budget':
    '[context_budget] Context budget reached ({tokens} tokens). Steps completed: {steps}. Unfinished: {tasks}',
  'subagent.context_budget':
    'Subagent stopped by the context budget ({tokens} tokens, steps: {steps})',
  'task.background_started':
    'The subagent is running in the background (sessionID: {id}). You will be notified automatically; do not poll its status.',
  'task.background_limit':
    'The background subagent limit for this session ({limit}) is reached — finish or cancel the running background subagents first',
  'task.background_disabled':
    'Background subagents are disabled on this instance (background.enabled = false) — run the subagent in the foreground',
  'task.resume_foreign_child':
    'Session {id} is not a subagent session of the current session — it cannot be continued from here',
  'task.resume_child_busy':
    'Session {id} is busy or already running — it cannot be continued right now',

  // --- Тулы: общие ошибки и результаты ---
  'tool.args_error': 'Tool "{tool}" argument error: {issues}',
  'tool.exec_error': 'Tool "{tool}" execution error: {error}',
  // Вызов без имени инструмента: результат обязателен — иначе assistant(tool_calls)
  // остаётся без парного tool и следующий LLM-вызов падает у провайдера.
  'tool.malformed_call': 'Error: malformed tool call "{tool}" (id: {id}) — the call was not executed',
  'tool.not_found': 'Tool "{tool}" not found',
  'tool.permission_denied_default': 'Access denied by the security policy',
  'tool.doom_loop': 'Error: tool "{tool}" called {count} time(s) with the same arguments. Loop broken.',
  // Шаг-лимит (паритет с opencode): провайдер вернул tool call, хотя
  // `toolChoice: 'none'` вызов запрещает. Вызов не исполняется, но парный
  // `tool`-результат пишется — иначе assistant(tool_calls) останется без пары.
  'tool.disabled_by_step_limit':
    'Error: tool "{tool}" was not executed — tools are disabled after the maximum agent steps ({limit})',
  'tool.empty_output': '(empty output)',
  'tool.output_truncated': '\n... (output truncated)',
  // Общий предел вывода инструментов (`tools.outputMaxLines`/
  // `tools.outputMaxBytes`): результат усечён по строкам/байтам — показываем,
  // сколько строк показано из скольких, и подсказываем, как получить остальное.
  'tool.output_bounded':
    'Output truncated: showing {shown} of {total} lines. Narrow the command or pattern, or read a smaller range (offset/limit).',
  'tool.shell_error': 'Error: {message}',
  'tool.shell_timeout':
    'Command timed out after {timeout} ms. Retry with a larger timeout if the command is expected to take longer.',
  'tool.search_timeout':
    'Search timed out after {seconds} seconds. Consider using a more specific path or pattern.',
  'tool.command_failed_default': 'Command failed',
  'tool.aborted': 'Execution interrupted by the user.',
  'tool.binary_missing':
    'Tool "{tool}" is unavailable: the required program "{binary}" is not installed in the environment',

  // --- Файлы (fs-write) ---
  'fs.file_written': 'File written: {path} ({lines} lines, {bytes} bytes)',
  'fs.file_edited': 'File edited: {path} ({count} replacements)',
  'fs.replace_not_found': 'Error: replacement string not found in file "{path}"',
  'fs.replace_multiple': 'Error: found {count} matches of the replacement string. Provide more context for a unique match.',
  // Отказы до записи: правка «сама в себя», пустой old_string (при replace_all
  // он вставляет текст между каждым символом) и смешанные переводы строк.
  'fs.no_changes': 'No changes to apply: old_string and new_string are identical.',
  'fs.empty_old_string': 'old_string must not be empty. Use write_file to create or overwrite a file.',
  'fs.mixed_line_endings':
    'The file has mixed line endings (CRLF and LF). Normalize it to a single style before editing.',
  // Защита от бинаря и гигантских файлов (паритет с `patch`).
  'fs.edit_binary': 'Cannot edit binary file: {path}',
  'fs.write_binary': 'Cannot overwrite binary file: {path}',
  'fs.file_too_large': 'Error: file is too large (limit {limit} bytes)',
  'fs.file_not_found': 'Error: file not found: {path}',
  'fs.dir_created': 'Directory created: {path}',
  'fs.file_deleted': 'File deleted: {path}',
  // Мультифайловая атомарная правка (`patch`, JSON-edits): всё-или-ничего.
  'fs.patch_applied': 'Patch applied: {files} files, {replacements} replacements',
  'fs.patch_file_line': '{path}: {count} replacements',
  'fs.patch_not_found': 'Error: patch edit #{index} did not find its text in "{path}"',
  'fs.patch_multiple': 'Error: patch edit #{index} matched {count} times in "{path}". Provide more context or set replace_all.',
  'fs.patch_write_failed': 'Error: failed to write patch result for "{path}": {error}',
  'fs.patch_file_missing': 'Error: patch target file not found: {path}',
  'fs.patch_not_regular': 'Error: patch target is not a regular file: {path}',
  'fs.patch_too_large': 'Error: file "{path}" is too large for atomic patching ({bytes} bytes, limit {limit})',
  'fs.patch_binary': 'Cannot patch binary file: {path}',
  // Операции патча add/delete/rename: сводка по операциям + строки по файлам.
  'fs.patch_summary': 'Operations: {added} added, {updated} updated, {deleted} deleted, {renamed} renamed',
  'fs.patch_file_added': '{path}: created',
  'fs.patch_file_deleted': '{path}: deleted',
  'fs.patch_file_renamed': '{from}: renamed to {to}',
  'fs.patch_add_exists': 'Error: patch add target file already exists: {path}',
  'fs.patch_delete_missing': 'Error: patch delete target file not found: {path}',
  'fs.patch_rename_missing': 'Error: patch rename source file not found: {from}',
  'fs.patch_rename_exists': 'Error: patch rename target already exists: {to}',
  'fs.patch_path_escapes': 'Error: patch path is outside the session perimeter: {path}',

  // --- Чтение файлов (fs-read) ---
  'fsread.empty_directory': '(empty directory)',
  'fsread.empty_file': '(empty file)',
  'fsread.no_files': '(no files found)',
  'fsread.glob_error': '(file search error)',
  'fsread.truncated': '... (showing the first {count} lines; continue with offset {next})',
  'fsread.directory_truncated': '... (showing the first {count} entries; continue with offset {next})',
  'fsread.line_truncated': '... (line truncated)',
  'fsread.offset_out_of_range': '(offset {offset} is out of range: the file has {total} lines)',
  'fsread.binary':
    'Cannot read binary file: {path}. To show an image or PDF to the model use attach_workspace_file; to inspect other bytes use execute_shell (file, xxd, head -c).',
  'fsread.glob_truncated': '... (showing the first {count} of {total} files; refine the pattern or raise the limit)',

  // --- Веб (web_fetch / web_search) ---
  'web.duckduckgo_blocked':
    'DuckDuckGo is temporarily blocking requests (anti-bot challenge). Wait a moment and retry, or rephrase the query with different keywords.',
  'web.search_failed': 'Failed to get results from DuckDuckGo',
  'web.search_results': 'Search results for "{query}" ({count}):\n\n{items}',
  'web.fetch_args_url_required': 'specify url or urls',
  'web.js_framework_warning': '\n\n⚠️ The site uses a JavaScript framework — some content may be unavailable without executing JS.',
  'web.low_content_warning': '\n\n⚠️ The page has very little text content (possibly JavaScript rendering).',
  'web.content_truncated': '\n... (content truncated)',
  'web.body_truncated': '\n... (response body truncated at the {limit} byte limit)',
  'web.block_timeout': '❌ Timeout',
  'web.block_error': '❌ Load error: {error}',
  'web.fetch_all_failed': 'Failed to load any of the URLs',
  'web.no_results':
    'No results found for "{query}". Try rephrasing the query with different or more specific keywords.',
  'web.search_error': 'Web search error: {error}',
  'web.search_rate_limited':
    'Web search rate limited by the provider (HTTP 429). Wait and retry, or try a different query.',
  'web.search_auth_failed':
    'Web search authentication failed (HTTP 401). The search provider rejected the credentials.',
  'web.ssrf_blocked': '🚫 Blocked by the network policy: {reason}',
  'web.too_many_redirects': '❌ Too many redirects',

  // --- Поиск ---
  'search.no_matches': '(no matches found)',
  'search.matches_truncated': '... (showing {shown} of {total} matches)',
  // Строка совпадения длиннее капа (`line-limits.ts`: `MAX_LINE_LENGTH`)
  // обрезается — иначе одна минифицированная строка (source map) съедает
  // контекстное окно модели.
  'search.line_truncated': '... (line truncated)',
  // Совпадения в исключённых путях (зависимости, артефакты сборки, lock-файлы)
  // скрываются по умолчанию — маркер говорит модели, что часть вывода не показана.
  'search.matches_excluded':
    '... ({count} matches hidden: excluded paths were skipped — {categories})',
  'search.rg_not_installed': '(rg (ripgrep) is not installed. Search is unavailable)',
  'search.error': 'Search error: {error}',
  // Различимые причины отказа поиска: модель должна понимать, что именно
  // исправлять (путь, тип пути или сам шаблон поиска).
  'search.path_not_found': 'Search path not found: {path}',
  'search.path_not_directory': 'Search path is not a directory: {path}',
  'search.invalid_regex':
    'Invalid regular expression: {error}. Fix the pattern and search again (escape special characters or use literal=true).',

  // --- План ---
  'plan.enter_success':
    'Plan mode activated: file writes are blocked, reading is allowed. Investigate the task, work with the plan via plan_read/plan_write and finish via plan_exit to switch back to act mode.',
  'plan.exit_success': 'Plan approved. Act mode activated: file writes are allowed.',
  'plan.session_manager_unavailable': 'Error: session manager unavailable for {tool}',
  'plan.enter_failed': 'Error: failed to switch the session to plan mode',
  'plan.exit_failed': 'Error: failed to switch the session to act mode',
  'plan.project_store_unavailable': 'Error: project store unavailable for plan_write',
  'plan.no_project': 'Error: no project (the plan belongs to the project)',
  'plan.no_project_read': 'No project: the plan is unavailable (the plan belongs to the project)',
  'plan.column_not_found': 'Error: column "{columnId}" not found',
  'plan.item_not_found': 'Error: plan item with id "{itemId}" not found',
  'plan.save_error': 'Error saving the plan: {error}',
  'plan.markdown_title': '# Plan (v{version})',
  'plan.markdown_empty': 'No items',
  'plan.markdown_column_empty': '(empty)',
  'plan.markdown_dependencies': '  - Dependencies: {deps}',
  'plan.default_column_backlog': 'Backlog',
  'plan.default_column_todo': 'To do',
  'plan.default_column_in_progress': 'In progress',
  'plan.default_column_done': 'Done',

  // --- Todo ---
  'todo.save_error': 'Error saving the todo list: {error}',
  'todo.read_error': 'Error reading the todo list: {error}',
  'todo.list_empty': 'Todo list is empty',
  'todo.list': 'Todo list ({count}):\n{items}',
  'todo.item_not_found': 'Error: todo item with id "{id}" not found',
  'todo.items_not_found': 'Error: todo items with ids "{ids}" not found',
  'todo.status_pending': 'pending',
  'todo.status_in_progress': 'in progress',
  'todo.status_completed': 'done',
  'todo.status_cancelled': 'cancelled',
  'todo.priority_high': 'high',
  'todo.priority_medium': 'medium',
  'todo.priority_low': 'low',
  // Компактный вывод тулов todo: сводка + строка на пункт (JSON не отдаётся —
  // он шумит и съедает контекст модели).
  'todo.summary': 'Todo list: {completed}/{total} completed, {inProgress} in progress.',
  'todo.line': '- [{mark}] {title} ({status})',
  'todo.more': '... and {count} more',
  'todo.added': 'Todo items added: {ids}',
  'todo.updated': 'Todo item {id} updated.',
  'todo.deleted': 'Todo items deleted: {count}.',
  'todo.hint_priority': 'priority: {priority}',
  'todo.hint_plan': 'plan: {plan}',

  // --- Проект ---
  'project.deps_unavailable': 'Error: session manager or project store unavailable for {tool}',
  'project.session_read_error': 'Error: failed to read the session',
  'project.query_not_found': 'Project "{name}" not found. Use list_projects to see available projects.',
  'project.query_ambiguous': 'Project name "{name}" is ambiguous. Candidates:\n{items}',
  'project.list': 'Projects ({count}):\n{items}',
  'project.list_empty': 'No projects available.',
  'project.details': 'Project "{name}" ({id})\n{json}',
  'project.attached_no_workspace': 'Session attached to project "{name}". Warning: the project has no workspace — file, shell and git tools are unavailable until project_workspace_set is called.',
  'project.cross_instance': 'Project "{name}" ({id}) belongs to another instance. Use `synth project export`/`import` or create the session on that instance.',
  'project.hybrid_ambiguous': 'Project name "{name}" exists locally and on the remote instance. Candidates:\n{items}',
  'project.remote_unavailable': 'Error: the remote instance is unavailable (hybrid is not connected)',
  'project.remote_truncated': 'Remote project list is truncated (page cap) — cross-world pagination is unavailable.',
  'project.session_not_found': 'Error: session not found',
  'project.save_error': 'Error saving the project: {error}',
  'project.workspace_create_error': 'Error creating project workspace: {error}',
  'project.created': 'Project "{name}" created and attached to the session.\n{json}',
  'project.read_error': 'Error: failed to read the project',
  'project.not_found': 'Project {id} not found',
  'project.attached': 'Session attached to project "{name}".',
  'project.log_no_project': 'No project: the log is available only within a project',
  'project.log_save_error': 'Error saving the project log: {error}',
  'project.log_added': 'Log entry added. Total entries: {count}.',
  'project.log_empty': 'Log is empty',
  'project.log_list': 'Project log ({count}):\n{items}',
  'project.invariants_no_project': 'No project: invariants are available only within a project',
  'project.invariants_empty': 'Invariants are not set',
  'project.invariants_saved': 'Project invariants saved.',
  'project.invariants_save_error': 'Error saving the invariants: {error}',
  'project.write_forbidden': 'Error: you do not have permission to modify this project (owner or editor role required)',
  'project.updated': 'Project updated.',
  'project.updated_ok': 'Project "{name}" updated.',
  'project.invalid_icon': 'Invalid icon "{value}". Allowed values: {allowed}.',
  'project.invalid_color': 'Invalid color "{value}". Allowed values: {allowed}.',
  'project.no_project': 'No project: this action is available only within a project',
  'project.workspace_set': 'Project working directory set: {dir}',
  'project.workspace_invalid': 'Error: invalid project working directory',
  'project.workspace_denied': 'Error: working directory outside the allowed root is denied by policy',
  'project.workspace_confirm_required': 'Error: working directory outside the allowed root requires confirmation',
  'project.workspace_missing': 'Error: project working directory is not set',
  'project.repo_cloned': 'Repository cloned: {path}',
  'project.repo_initialized': 'Repository initialized: {path}',
  'project.repo_registered': 'Repository registered: {path}',
  'project.repo_fetched': 'Repository updated (fetch): {path}',
  'project.repo_removed': 'Repository removed from the project registry: {path}',
  'project.repo_not_found': 'Error: repository not found in the project registry: {path}',

  // --- Контекст проекта (get_project_info / list_repos) ---
  'projectctx.info_title': '# Project: {name}',
  'projectctx.info_id': '- ID: {id}',
  'projectctx.info_workspace': '- Project working directory: {dir}',
  'projectctx.info_description': '- Description: {description}',
  'projectctx.not_found': '# Project: not found (id: {id})',
  'projectctx.missing': '# Project: none',
  'projectctx.working_dir': '- Working directory: {dir}',
  'projectctx.no_plan_hint':
    '- The plan is unavailable (the plan belongs to the project). To work with the plan — create a project.',
  'projectctx.git_section': '## Git repository',
  'projectctx.repo_branch': '  - Branch: {branch}',
  'projectctx.repo_remote': '  - Remote: {url}',
  'projectctx.repo_state': '  - State: {state}',
  'projectctx.repo_state_dirty': 'has changes',
  'projectctx.repo_state_clean': 'clean',
  'projectctx.repo_last_commit': '  - Last commit: {commit}',
  'projectctx.repos_title': '# Repositories of project {name}:',
  'projectctx.repo_not_found': '- {path} (not found or not a git repository)',
  'projectctx.repos_none': 'No git repositories in "{dir}"',
  'projectctx.repos_found': '# Git repositories in {dir}:',
  'projectctx.repo_destination': '  - Destination: {dir}',
  'projectctx.repo_name': '  - Name: {name}',
  'projectctx.repo_url': '  - URL: {url}',
  'projectctx.repo_type': '  - Type: {type}',
  'projectctx.repo_default_branch': '  - Default branch: {branch}',
  'projectctx.repo_ssh_key': '  - SSH key: {id}',
  'projectctx.repo_last_fetch': '  - Last fetch: {time}',

  // --- Классификация ---
  'tool.classified': 'Conversation classified as "{category}"',

  // --- Ссылки на сессии ---
  'reference.session_manager_unavailable': 'SessionManager unavailable',
  'reference.session_not_found': 'Session {id} not found',
  'reference.no_messages': 'No messages in session {id} in the specified range',
  'reference.session_title': '# Session: {title}',

  // --- Permissions (evaluator) ---
  'permission.yolo_auto_approved': '{reason} (yolo mode: auto-approved)',
  'permission.plan_write_blocked': 'plan mode: file writes are blocked ({source})',
  'permission.plan_source_mode': 'plan mode',
  'permission.plan_source_strict': 'strict: plan not approved',
  'permission.plan_shell_denied': 'plan mode: shell command mutates state',
  'permission.mcp_unavailable': 'MCP tool unavailable in {mode} mode',
  'permission.dep_unavailable':
    'Tool is unavailable: the required program "{binary}" is not installed in the environment',
  'permission.workspace_unavailable':
    'Tool is unavailable: the project working directory is not set. Create or attach a project and set its working directory first.',
  'permission.storage_unavailable':
    'Tool is unavailable: the storage backend is down and Synth runs read-only in degraded mode. Restore the database connection and restart the instance (see GET /api/v2/storage/status).',
  'permission.external_directory_default':
    'Path "{path}" is outside the project working directory → {action} (permission.rules.external_directory)',
  'permission.no_rules': 'no permission rules for "{tool}" — allowed by default',
  'permission.rule_matched': 'rule "{key}" → {action}',
  'permission.rule_pattern_matched': 'rule "{key}.{pattern}" → {action} (path: {path})',
  'permission.rule_prefix_matched': 'rule "{key}.*" → {action}',
  'permission.rule_command_matched': 'rule "{key}.{pattern}" → {action} (command: {command})',
  'permission.ask_timeout': 'approval timed out',
  'permission.ask_cancelled': 'cancelled by user',
  'permission.ask_no_subscribers': 'no connected user to approve',
  'permission.ask_denied': 'denied by the user',
  'permission.authority_denied_unknown':
    'Action "{action}" is not covered by the authority layer (unknown action or target) — denied',
  'permission.authority_denied_explicit': 'Action "{action}" is forbidden by the authority policy — denied',
  'permission.authority_denied_no_grant': 'No grant for action "{action}" — denied',
  'permission.authority_ask': 'Action "{action}" requires confirmation by a grant holder',

  // --- Shell-политика (shell-guard) ---
  'shellguard.allow_default': 'command does not violate the shell policy',
  'shellguard.deny_prefix': 'Command denied by shell policy: prefix "{prefix}"',
  'shellguard.deny_path': 'Access denied by shell policy: path "{path}" is protected',
  'shellguard.ask_path': 'Path "{path}" requires approval per shell policy',
  'shellguard.ask_command': 'Command "{command}" is resolved dynamically and requires approval per shell policy',
  'shellguard.ask_code': 'Dynamic substitution "{code}" is passed as code/argument and cannot be verified in advance',
  'shellguard.deny_dir': 'Access denied by shell policy: path "{path}" is in protected directory "{dir}"',

  // --- Защищённые пути (protected-paths) ---
  'protectedpaths.unresolvable': 'path cannot be resolved — not blocking',
  'protectedpaths.dynamic': 'path contains dynamic parts — could not verify (not blocking)',
  'protectedpaths.allow_default': 'path does not violate the protected paths policy',

  // --- Prompt injection ---
  'security.warn_prefix': '[WARN: prompt injection signs detected',
  'security.injection_blocked':
    '[BLOCKED] Tool "{tool}" result blocked: prompt injection signs detected ({matches})',

  // --- LLM Gateway ---
  'gateway.input_blocked': 'Secrets detected in the request ({reason}). Request blocked by LLM Gateway.',
  'gateway.rate_limit_warning': '⚠️ Rate limit exceeded. Please retry later.',
  'gateway.output_secrets_reason': 'secrets in the model response',
  // ADR-090: решения фильтров LLM-вызовов.
  'gateway.filter_denied': 'LLM request denied by an extension filter ({reason}).',
  'gateway.filter_unavailable': 'LLM request blocked: extension filter unavailable ({reason}).',

  // --- Router / провайдеры ---
  'router.timeout': 'Timeout or connection drop to the LLM provider',
  'router.network_error': 'Failed to connect to the LLM provider (network error)',
  'router.provider_not_found': 'Provider {provider} not found or not configured',
  'router.provider_disabled': 'Provider {provider} is disabled by the administrator',
  'router.provider_unspecified': 'unspecified',
  'router.model_disabled': 'Model {provider}/{model} is disabled by the administrator',
  'router.escalation': 'Escalated to {provider}/{model}: {reason}',
  'router.context_length_exceeded': 'Context window exceeded',
  'router.rate_limit_exceeded': 'Request rate limit exceeded',
  'router.no_user_query':
    'The model could not process the tool-call chain (the original user query was lost). Try again, reduce the number of tools, or increase the model context window.',
  // Гибрид (ADR-042): токена к серверу нет — чаще всего истекла серверная
  // сессия. `classifyLlmErrorFor` относит типизированную ошибку
  // (`RemoteAuthExpiredError`/`RemoteError('AUTH'|'UNAUTHORIZED')`) к
  // `remote_auth_expired` — невосстановимый тип, без 3 бесполезных ретраев по
  // 5/15/30 с (ADR-041). Маркер «authentication» в тексте остаётся для старых
  // текстовых путей (`classifyLlmError` = `auth_error`).
  'router.remote_auth_expired':
    'The server session has expired — sign in to hybrid mode again (authentication required)',

  // --- Quality check (ADR-034) ---
  'qc.min_length_ok': 'Response length {length} >= {min}',
  'qc.min_length_fail_detail': 'Response is shorter than {min} characters ({length})',
  'qc.min_length_fail': 'Response is shorter than {min} characters',
  'qc.constraint_empty': 'Response is empty or contains only whitespace',
  'qc.constraint_parse_error': 'Response contains an explicit parsing error: {snippet}',
  'qc.constraint_ok': 'Constraints passed',
  'qc.self_check_skipped': 'Self-check skipped: provider not specified',
  'qc.self_check_unparsed': 'Failed to parse the score: "{score}" — counting as passed',
  'qc.self_check_low': 'Self-check score: {score}/10 (threshold: 5)',
  'qc.self_check_low_reason': 'Model self-assessment is low: {score}/10',
  'qc.self_check_ok': 'Self-check score: {score}/10',
  'qc.self_check_error': 'Self-check error: {error} — counting as passed',
  'qc.all_passed': 'All checks passed',

  // --- Микро-слой (ADR-035) ---
  'micro.greeting': 'Hi! How can I help you?',
  'micro.farewell': 'Goodbye! Reach out anytime you need me.',
  'micro.thanks': "You're welcome! Glad to help.",
  'micro.enum.yes': 'Yes.',
  'micro.enum.no': 'No.',
  'micro.enum.approve': 'Approved.',
  'micro.enum.reject': 'Rejected.',
  'micro.enum.mode_plan': 'Switching to planning mode. Investigating and drafting a plan.',
  'micro.enum.mode_act': 'Switching to working mode. Executing.',
  'micro.intent.question': 'Got a good question. I need more context for a precise answer — what exactly are you interested in?',
  'micro.intent.command': "Understood. What's the specific task? Describe what needs to be done.",
  'micro.intent.review': "Got it, a review is needed. Show me the code fragment and I'll assess its quality.",
  'micro.intent.explain': 'Got it, an explanation is needed. Which fragment/concept are we talking about?',
  'micro.intent.debug': "Looks like a debugging task. Describe the error or attach the log — we'll figure it out.",
  'micro.intent.fix': "Got it, a bug fix is needed. Show me the problematic code — we'll find the cause.",
  'micro.intent.test': "Got it, tests are needed. Specify the function or module — I'll write the tests.",

  // --- Скиллы (ADR-046) ---
  'skill.args_error': 'Skill argument error: {issues}',
  'skill.not_found': 'Skill "{name}" not found',
  'skill.untrusted': 'Skill "{name}" belongs to an untrusted project and cannot be loaded',
  'skill.delegation': 'The skill "{name}" requires capabilities: {capabilities}; agent "{agent}" does not have them. Call `task` with an agent that supports these capabilities.',
  'skill.file_not_found': 'Supporting file "{path}" not found in the skill directory',
  'skill.scope_disabled': 'Skill "{name}" is disabled ({reason}) and cannot be loaded',

  // --- Slash-команды (ADR-046 §7) ---
  'command.unknown': 'Unknown command: /{name}',
  'command.denied': 'Command /{name} is denied by permission rules',
  'command.unavailable': 'Command /{name} is unavailable: missing capabilities {capabilities}',
  'command.help': 'Available commands: /help, /skills, /commands, /summary, /init. Type /<skill-or-bundle> to load it. Any other text goes to the model.',
  'command.list_empty': 'No commands available',
  'command.skills_empty': 'No skills available',
  'command.summary_enqueued': 'Summarization started',
  'command.summary_unavailable': 'Not enough active messages to summarize',

  // --- Сжатие контекста (summarization / compaction) ---
  'context.compression_empty': 'No messages to compress',
  'context.compression_failed': 'Context compression failed ({mode}): {reason}',
  'context.compression_template': 'Compression response does not match the required template',
  'context.compression_output_limit': 'Compression response was cut off by the output limit',
  'context.summary_applied': 'Context compacted ({mode})',

  // --- Inline shell (ADR-046 §7.4) ---
  'command.inline_shell_disabled': 'Inline shell is disabled',
  'command.inline_shell_denied': 'Inline shell command "!`{command}`" denied: {reason}',
  'command.inline_shell_failed': 'Inline shell command failed: {output}',
  'command.inline_shell_truncated': 'Inline shell output truncated to {limit} bytes',
  'command.inline_shell_unavailable': 'Inline shell is unavailable',

  // --- Git-репозитории и SSH-ключи (ADR-076) ---
  'sshkey.not_found': 'SSH key {id} not found',
  'sshkey.name_exists': 'SSH key with name "{name}" already exists',
  'sshkey.encryption_unavailable': 'SSH key encryption is unavailable: secret key is not configured',
  'sshkey.decrypt_failed': 'Failed to decrypt SSH key {id}',
  'sshkey.env_failed': 'Failed to prepare SSH environment (temporary key or askpass)',
  // Отказы единого гейта SSH-ключей (PROP-124 §3) — по одному ключу на
  // машинный код отказа (`SshAccessErrorCode`).
  'ssh.access.key_not_found': 'SSH key "{key}" not found',
  'ssh.access.usage_denied': 'SSH key "{key}" is not allowed for {usage} access',
  'ssh.access.agent_not_linked': 'SSH key "{key}" is not linked to the agent role "{agent}"',
  'ssh.access.host_denied': 'Host "{host}" is not allowed for SSH key "{key}"',
  'ssh.access.port_denied': 'Port {port} is not allowed for SSH key "{key}"',
  'ssh.access.policy_required': 'SSH key "{key}" requires a host: the host policy is mandatory',
  'ssh.access.ambiguous': 'Several SSH keys fit: {keys} — a specific one is required',
  // PROP-124 §4b: адресный ssh-тул передачи файлов — результат операции.
  'ssh.copy.uploaded': 'Uploaded {local} to {remote} on host {host}',
  'ssh.copy.downloaded': 'Downloaded {remote} from host {host} to {local}',
  // PROP-124 §4c: адресный ssh-тул проброса порта — туннель запущен.
  'ssh.tunnel.started':
    'SSH tunnel started (direction {direction}): 127.0.0.1:{listen_port} → {target} on host {host}. '
    + 'Process {id}, log {log}. The tunnel stays up until it is stopped with process_stop.',
  // SOCKS-проброс (-D) не поддерживается: у него нет целевого порта, а
  // значит, нечего проверять политикой портов ключа.
  'ssh.tunnel.socks_unsupported':
    'SOCKS forwarding (-D) is not supported: it has no target port, so the key port policy cannot be '
    + 'checked. Use direction "local" (-L) or "remote" (-R) with an explicit target port instead.',
  'git.ssh_key_required': 'SSH key is required for repository "{path}"',
  // ADR-076: подсказка вместо тупика — какие ключи доступны и что с ними делать.
  // Прежний `git.ssh_key_required` остаётся для путей без стора ключей (HTTP-роуты,
  // стор не сконфигурирован) — поведение не ломается.
  'git.ssh_key_required_hint':
    'Error: SSH key is required for repository "{path}" but none is set or the configured key was not found. '
    + 'Available SSH keys: {keys}. '
    + 'Pass the id of a suitable key as `sshKeyId` (the `ssh_keys_list` tool shows the same list); '
    + 'if no key fits or the list is empty, the user must add a key in Settings → SSH keys.',
  'git.ssh_keys_none': 'none configured',
  // Тул метаданных ключей (ssh_keys_list) — ADR-076.
  'sshkeys.tool.header': 'SSH keys ({count}):',
  'sshkeys.tool.empty':
    'No SSH keys are configured. Add one in Settings → SSH keys (or POST /api/v2/ssh-keys).',
  'sshkeys.tool.deps_unavailable':
    'The SSH key store is unavailable in this build — SSH keys cannot be listed',
  'git.repo_path_invalid': 'Invalid repository path "{path}" (must be inside the project workspace)',
  'git.repo_not_a_repo':
    'Error: "{path}" is not a git repository (the directory is missing, empty or has no `.git`). '
    + 'The registry entry points to a path without a repository — re-register the path of an existing '
    + 'repository (tool `project_repo_add`) or clone the repository again (tool `project_repo_clone`).',
  'git.repo_exists': 'Repository already exists at "{path}"',
  'git.repo_occupied_repo':
    'Error: "{path}" already contains a git repository. Register the existing one instead of cloning again '
    + '(HTTP `POST /api/v2/git/repos/register`, tool `project_repo_add`).',
  'git.repo_occupied_stub':
    'Error: "{path}" contains an incomplete clone (a `.git` directory without commits) left by an interrupted operation. '
    + 'Delete the directory and retry the clone.',
  'git.repo_occupied_dir':
    'Error: "{path}" is a non-empty directory ({entries} entries) without a git repository. '
    + 'Choose another path or clean the directory, then retry.',
  'git.repo_path_unreadable':
    'Error: "{path}" exists but cannot be read (permissions?). Fix access to the directory or choose another path.',
  'git.clone_timeout':
    'Error: git clone did not finish within {timeout} ms and was interrupted; no files were left behind. '
    + 'Retry, or raise `git.cloneTimeoutMs` for a slow network.',
  'git.fetch_timeout':
    'Error: git fetch did not finish within {timeout} ms and was interrupted. '
    + 'Retry, or raise `git.fetchTimeoutMs` for a slow network.',
  'git.timeout':
    'Error: {tool} was interrupted after the {timeout} ms timeout. '
    + 'Retry with a larger `timeout` argument, raise the git local/network timeout in config, '
    + 'or run the command in the background (execute_shell with background: true). '
    + 'If the repository is left in an inconsistent state (for example a merge in progress), '
    + 'finish or abort it before retrying.',

  // --- Git worktrees: per-session рабочий каталог (ADR-114) ---
  'worktree.directory_missing':
    'The working directory of the linked git worktree "{path}" does not exist. '
    + 'The worktree was probably deleted — the session cannot continue in another directory.',
  'worktree.tool.deps_unavailable':
    'Error: the git worktree service is not available in this instance',
  'worktree.tool.no_project':
    'Error: the session has no project — git worktree operations require a project',
  'worktree.tool.list_empty': 'The project has no git worktrees',
  'worktree.tool.list_header': 'Git worktrees of the project ({count}):',
  'worktree.tool.list_row':
    'name: {name} | branch: {branch} | directory: {directory} | dirty: {dirty} | attached session: {attached} | exists: {exists}',
  'worktree.tool.created':
    'Git worktree "{name}" created on branch "{branch}" (directory: {directory}, id: {worktree_id}). '
    + 'It is not attached to any session yet — bind it with PATCH /api/v2/sessions/<sessionId> '
    + 'and the "worktreeId" field, or let the user attach it in the UI.',
  'worktree.tool.removed': 'Git worktree "{name}" removed',
  'worktree.tool.pruned':
    'Pruned git worktrees: {records} stale record(s) removed, git metadata pruned: {git_pruned}',
  'worktree.tool.force_required':
    'Error: git worktree "{name}" has uncommitted changes — repeat the call with force: true to remove it anyway',
  'worktree.tool.busy':
    'Error: git worktree "{name}" is attached to a live session ({session}) — detach the session first',
  'worktree.tool.not_found': 'Error: git worktree "{id}" not found',

  // --- Внешние события и хуки (ADR-030 / ADR-089) ---
  'event.ingested': 'Event {id} ingested from source "{source}"',
  'event.routed.bound': 'Event routed to bound session {sessionId}',
  'event.routed.ephemeral': 'Event routed to ephemeral session (agent "{agentTemplate}")',
  'event.routed.queue': 'Event queued for {owner}: {reason}',
  'event.routed.drop': 'Event dropped: {reason}',
  'event.binding.not_found': 'Event binding not found for "{key}"',
  'event.source_not_allowed': 'Event source "{source}" is not allowed',
  'event.duplicate': 'Duplicate event ignored: {dedupKey}',
  'hook.blocked': 'Hook "{hook}" blocked execution: {reason}',

  // --- Steering: форсированная отправка во время хода (ADR-104) ---
  'steer.injected': 'Message injected into the running turn',
  'steer.limit_exceeded':
    'Steering limit reached: at most {limit} injected messages per turn',
  'steer.interrupted': 'Generation interrupted — the turn continues with the new message',
  'steer.dropped_aborted':
    'Turn stopped — {count} pending intervention(s) discarded (send them again as a new message)',
  'steer.dropped_turn_ended':
    'Turn already finished — {count} pending intervention(s) discarded (send them again as a new message)',
  'steer.requeued_aborted':
    'Turn stopped — {count} pending message(s) returned to the queue',
  'steer.requeued_turn_ended':
    'Turn finished — {count} pending message(s) returned to the queue and will be processed next',

  // --- Профиль пользователя и онбординг ---
  'profile.deps_unavailable': 'Error: session manager or profiles store unavailable for {tool}',
  'profile.session_read_error': 'Error: failed to read the session',
  'profile.session_not_found': 'Error: session not found',
  'profile.user_unavailable': 'Error: the session has no owner — profile update is unavailable',
  'profile.save_error': 'Error saving the profile: {error}',
  'profile.updated': 'Profile updated ({fields}).',

  // --- Движок пайплайнов (ADR-101) ---
  'pipeline.not_found': 'Pipeline "{id}" not found',
  'pipeline.not_published': 'Pipeline "{id}" has no published version',
  'pipeline.invalid_spec': 'Invalid pipeline specification: {problems}',
  'pipeline.loop_limit': 'Pipeline run stopped: transition limit ({limit}) exceeded',
  'pipeline.cancelled': 'Pipeline run cancelled',
  'pipeline.executor_missing': 'No executor registered for step kind "{kind}"',
  'pipeline.gate_rejected': 'Step "{node}" was rejected by a human',
  'pipeline.gate_timeout': 'Waiting for step "{node}" timed out after {timeoutSec}s',
  'pipeline.step_failed': 'Step "{node}" failed: {error}',
  'pipeline.step_timeout': 'Step "{node}" timed out after {timeoutSec}s',
  'pipeline.run_not_found': 'Pipeline run "{id}" not found',
  'pipeline.invalid_state': 'Pipeline run "{id}" cannot be resumed (status: {status})',
  'pipeline.tool_not_found': 'Tool "{tool}" for step "{node}" is not registered',
  'pipeline.tool_failed': 'Tool "{tool}" of step "{node}" failed: {error}',
  'pipeline.script_failed': 'Command of step "{node}" exited with code {code}: {error}',
  'pipeline.script_no_command': 'Step "{node}" has no command to run',
  'pipeline.permission_denied': 'Step "{node}" was denied for tool "{tool}": {reason}',
  // --- Исполнитель agent-шага (ADR-101 §4) ---
  'pipeline.agent_unavailable':
    'Step "{node}" cannot run an agent: the LLM runtime is not configured (no prompt composer)',
  'pipeline.provider_not_found':
    'Step "{node}" has no LLM provider configured (provider: "{provider}")',
  'pipeline.llm_failed': 'Step "{node}" failed: LLM error ({type})',
  'pipeline.llm_unrecoverable': 'Step "{node}" failed: LLM error ({type}) is not recoverable',
  // --- Встроенные тулы пайплайнов (ADR-101) ---
  'pipeline.tool.deps_unavailable': 'Error: the pipeline runtime is unavailable for {tool}',
  'pipeline.tool.no_project':
    'No project: pipelines are available only within a project of the session',
  'pipeline.tool.forbidden':
    'Error: you do not have permission to modify this project (owner or editor role required)',
  'pipeline.tool.not_found': 'Pipeline "{id}" not found',
  'pipeline.tool.already_running':
    'Pipeline "{id}" already has a running execution — wait for it to finish',
  'pipeline.tool.invalid_spec': 'Invalid pipeline specification: {problems}',
  'pipeline.tool.not_published': 'Pipeline "{id}" has no published version',
  'pipeline.tool.run_not_found': 'Pipeline run "{id}" not found',
  'pipeline.tool.run_foreign': 'Pipeline run "{id}" belongs to another project',
  'pipeline.tool.run_not_waiting':
    'Pipeline run "{id}" is not waiting for a human decision (status: {status})',
  'pipeline.tool.template_not_found': 'Pipeline template "{id}" not found',
  'pipeline.tool.template_unsupported':
    'Pipeline template "{id}" cannot be instantiated: {problems}',
  'pipeline.tool.saved': 'Pipeline draft saved: {id} (version {version})',
  'pipeline.tool.published': 'Pipeline version {version} published: {id}',
  'pipeline.tool.deleted': 'Pipeline deleted: {id}',
  'pipeline.tool.run_started': 'Pipeline run started: {run_id}',
  'pipeline.tool.run_resumed': 'Pipeline run {run_id}: the human decision was applied',
  'pipeline.tool.run_cancelled': 'Pipeline run cancelled: {run_id}',
  'pipeline.tool.instantiated': 'Pipeline created from the template: {id}',
  'pipeline.tool.list_empty': 'No pipelines in the project',
  'pipeline.tool.runs_empty': 'No pipeline runs',
  'pipeline.tool.templates_empty': 'No pipeline templates in the instance',

  // --- Встроенные тулы расписаний (ADR-051) ---
  'schedule.tool.deps_unavailable': 'Error: the schedule runtime is unavailable for {tool}',
  'schedule.tool.forbidden':
    'Error: you do not have permission to modify this schedule (owner or project editor role required)',
  'schedule.tool.not_found': 'Schedule "{id}" not found',
  'schedule.tool.invalid': 'Invalid schedule: {problems}',
  'schedule.tool.saved': 'Schedule saved: {id}',
  'schedule.tool.deleted': 'Schedule deleted: {id}',
  'schedule.tool.ran': 'Schedule "{id}" triggered (status: {status})',
  'schedule.tool.list_empty': 'No schedules',
  'schedule.tool.jobs_empty': 'No schedule runs',
  'schedule.tool.target_forbidden': 'The target of the schedule is not allowed: {reason}',
  'schedule.tool.not_published': 'Pipeline "{id}" has no published version',

  // --- Исполнение (ADR-077) ---
  'execution.remote_url_required':
    'Remote execution mode (execution.mode=remote) requires at least one executor address (execution.remote.url / SYNTH_EXECUTION_REMOTE_URL).',
  'execution.remote_unavailable':
    'Remote execution mode (execution.mode=remote) is unavailable: {reason}',

  // --- Вопрос пользователю и фоновые процессы (этап 1 roadmap 0.13) ---
  'question.answered': 'The user answered the questions: {answers}. Continue with the answers.',
  'question.cancelled': 'The user cancelled the question: {reason}',
  'question.timeout': 'The question expired by timeout',
  'question.deps_unavailable': 'The question mechanism is unavailable in this build',
  'process.background_started':
    'Command started in the background (processId: {id}). Output: {log}',
  'process.deps_unavailable': 'Background processes are unavailable in this build',
  'process.background_limit':
    'The limit of background processes for this session has been reached ({limit}). Wait for a running process to finish or stop it.',
  'process.background_unsupported':
    'Background execution is unavailable in the current execution mode',
  'process.background_disabled': 'Background processes are disabled (background.enabled: false)',
  'process.detached_started':
    'Command moved to the background (processId: {id}). Output: {log}',
  'process.tool.empty': 'No background runs',
  'process.tool.not_found': 'Background run "{id}" not found',
  'process.tool.deps_unavailable': 'The background run registry is unavailable in this build',
  'process.tool.header': 'Background runs ({count}):',
  'process.tool.no_log': 'There is no log for this background run',
  'process.tool.child_history':
    'The history of the child session {child_session} is available via the read_session_reference tool',
  'process.tool.not_running': 'Background run "{id}" is not running',
  'process.tool.running': 'Background run "{id}" is still running — stop it first with process_stop',
  'process.tool.stopping': 'Stop requested for background run "{id}"',
  'process.tool.deleted': 'Background run "{id}" deleted',

  // --- Повторная привязка файла из workspace (ADR-115) ---
  // Тул `attach_workspace_file`: текст доставленного user-сообщения и результаты
  // привязки/отказов. Канал LLM — en (ADR-041); UI переводит по `metadata.i18n`.
  'attach.message.from_workspace': 'File from the working directory: {path}',
  'attach.tool.attached':
    'File "{path}" attached; it will be available to the model on the next step of this turn',
  'attach.tool.deps_unavailable': 'Attachments are unavailable in this build',
  'attach.tool.delivery_unavailable':
    'File was uploaded, but message delivery to the session is unavailable in this context — the model will not see it',
  'attach.tool.disabled': 'Attachments are disabled on this instance',
  'attach.tool.not_found': 'File or attachment "{path}" not found',
  'attach.tool.not_a_file': '"{path}" is not a file',
  'attach.tool.too_large': 'File "{path}" is {size} bytes — the attachment limit is {limit} bytes',
  'attach.tool.unsupported_mime': 'File "{path}" cannot be attached: {detail}',
  'attach.tool.modality_unsupported':
    'File "{path}" is not attached: the current model does not accept {modality} attachments. '
    + 'Assign an auxiliary model for this modality (Settings → "Multimodal input", modalityModels) '
    + 'or ask the user to send the text or a description — re-attaching the file will not help',
  'attach.tool.unrecognized': 'File "{path}" format was not recognized — it cannot be attached',

  // --- Отправка файла в ответе (ADR-115): тул `send_attachment` ---
  // Файл из workspace уходит в blob-хранилище и прикрепляется к **финальному**
  // сообщению хода: шлюз (Telegram/VK) получает его в `stream.done.attachments`.
  'attach.tool.queued':
    'File "{name}" will be sent as an attachment of the reply at the end of this turn',

  // --- Сохранение вложения в workspace (ADR-115): тул `save_attachment` ---
  // Байты берутся из blob-хранилища по ссылке из медиа-части сессии; файл
  // публикуется в workspace без перезаписи существующего.
  'attach.tool.saved': 'Attachment saved to "{path}" ({size} bytes)',
  'attach.tool.ambiguous':
    'Several attachments match "{query}": {list}. Pass sha256 to pick one exactly',
  'attach.tool.no_attachment': 'This session has no media attachments',
  'attach.tool.exists':
    'File "{path}" already exists in the working directory — pass another path to save the attachment',
  'attach.tool.save_failed': 'Failed to save the attachment: {error}',

  // --- Каталог моделей для агента (ADR-115) ---
  // Тул `list_models`: компактный каталог моделей инстанса (модальности,
  // текущая пара, назначения aux-моделей). Канал LLM — en (ADR-041);
  // строки списка собираются в коде, локализуются заголовок и хвосты.
  'models.list.header': 'Models (filter: {filter}; shown {shown} of {total}):',
  'models.list.current': 'Current: {model} ({modalities})',
  'models.list.defaults': 'Assigned by modality: {assignments}',
  'models.list.skipped': 'Skipped models with unknown modalities: {count}',
  'models.list.empty': 'No models found',
  'models.list.provider_unknown': 'Provider "{provider}" not found in the model catalog',
  'models.list.deps_unavailable': 'The model catalog is unavailable in this build',
  'models.list.unavailable': 'The model catalog is unavailable: {reason}',

  // --- Инстанс и MCP-реестр (Workstream A1) ---
  'instance.deps_unavailable': 'Error: instance/MCP dependencies are unavailable for {tool}',
  'instance.info': 'Instance information:\n{json}',
  'instance.mcp_list': 'MCP servers ({count}):\n{json}',
  'instance.mcp_not_found': 'MCP server "{name}" is not configured. Available servers: {available}',
  'instance.mcp_test_ok': 'MCP server "{name}" is reachable; tools: {count}.',
  'instance.mcp_test_failed': 'MCP server "{name}" check failed: {error}',

  // --- Write-мутации MCP (Workstream A2) ---
  'instance.mcp_add.added': 'MCP server "{name}" added ({origin}). It is not enabled for the session; call synth_mcp_enable to use it.',
  'instance.mcp_update.updated': 'MCP server "{name}" updated.',
  'instance.mcp_remove.removed': 'MCP server "{name}" removed.',
  'instance.mcp_enable.session_ok': 'MCP server "{name}" for the session: {enabled}.',
  'instance.mcp_enable.project_ok': 'MCP server "{name}" for the project: {enabled}.',
  'instance.mcp_enable.instance_ok': 'MCP server "{name}" at the instance level: {enabled}.',
  'instance.mcp_enable.no_project': 'No project: the project-level MCP switch is available only within a project',
  'instance.mcp_enable.no_session': 'Error: the current session is unavailable',
  'instance.mcp_enable.session_forbidden': 'Error: only the session owner (or ADMIN/LEAD) can change MCP settings for this session',
  'instance.mcp_reconnect.ok': 'MCP server "{name}" reconnected; tools: {count}.',
  'instance.mcp_reconnect.failed': 'MCP server "{name}" did not reconnect: {error}',
  'instance.mcp.forbidden': 'Error: not enough permissions for this MCP operation (record author, or ADMIN/LEAD required)',
  'instance.mcp.instance_forbidden': 'Error: this MCP operation requires ADMIN (instance records, stdio, instance master flag)',
  'instance.mcp.project_forbidden': 'Error: you do not have permission to change this project (owner or editor role required)',
  'instance.mcp.credential_unsupported': 'Error: credential-backed MCP auth is not supported by this tool — bind the credential via the UI/API',
  'instance.mcp.secret_header': 'Error: MCP config contains plaintext secret headers: {error}',
  'instance.mcp.network_denied': 'Error: MCP network policy denied {url}: {reason}. Add a local service as origin "instance" (ADMIN) or add an exception in settings.',
  'instance.mcp.invalid_config': 'Error: invalid MCP config: {error}',
  'instance.mcp.exists': 'Error: MCP server "{name}" already exists',
} as const satisfies Record<SystemMessageKey, string>;

export type SystemMessageKey = EngineMessageKey;

/** Интерполяция `{param}` в шаблоне. Неизвестные плейсхолдеры остаются как есть. */
function interpolate(template: string, params?: Record<string, string>): string {
  if (!params) return template;
  let out = template;
  for (const [name, value] of Object.entries(params)) {
    out = out.split(`{${name}}`).join(value);
  }
  return out;
}

/**
 * Возвращает en-текст системного сообщения по ключу с интерполяцией.
 * Неизвестный ключ → fallback на сам ключ (никогда не undefined).
 */
export function t(key: SystemMessageKey, params?: Record<string, string>): string {
  const template = SYSTEM_MESSAGES[key];
  if (template === undefined) return key;
  return interpolate(template, params);
}

/**
 * metadata.i18n для сообщения/tool_result: ключ + параметры подстановки.
 * Помимо ключей словаря допускаются динамические ключи (например
 * `security.{messageId}` из prompts/security/*.md).
 */
export function i18n(key: SystemMessageKey | (string & {}), params?: Record<string, string>): MessageI18n {
  return params ? { key, params } : { key };
}

/** Проверка существования ключа в словаре. */
export function hasSystemMessage(key: string): key is SystemMessageKey {
  return Object.prototype.hasOwnProperty.call(SYSTEM_MESSAGES, key);
}

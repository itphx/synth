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
  'session.stopped': 'Processing stopped: {reason}',
  'session.stopped_reason_denied': 'the user denied the request',
  'session.denied_blocked': 'Could not proceed: the action was blocked by the security policy',
  'session.empty_response': 'Could not complete the request: the model response was empty',
  'session.dialog_title': 'Dialog — {id}',
  'session.default_title': 'New session',
  'session.reference_label': 'Session',
  'session.reference_link': 'Session link: {label} ({id}, messages {from}-{to})',
  'session.retry_cancelled': 'Retries cancelled by the user',
  'session.subtask_title': 'Subtask: {description}',

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
  'task.subagent_exec_error_after_retries': 'Subagent execution error "{type}" after {attempts} attempt(s): {error}',

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

  // --- Тулы: общие ошибки и результаты ---
  'tool.args_error': 'Tool "{tool}" argument error: {issues}',
  'tool.exec_error': 'Tool "{tool}" execution error: {error}',
  'tool.not_found': 'Tool "{tool}" not found',
  'tool.permission_denied_default': 'Access denied by the security policy',
  'tool.doom_loop': 'Error: tool "{tool}" called {count} time(s) with the same arguments. Loop broken.',
  'tool.empty_output': '(empty output)',
  'tool.output_truncated': '\n... (output truncated)',
  'tool.shell_error': 'Error: {message}',
  'tool.command_failed_default': 'Command failed',
  'tool.aborted': 'Execution interrupted by the user.',
  'tool.binary_missing':
    'Tool "{tool}" is unavailable: the required program "{binary}" is not installed in the environment',

  // --- Файлы (fs-write) ---
  'fs.file_written': 'File written: {path} ({lines} lines, {bytes} bytes)',
  'fs.file_edited': 'File edited: {path} ({count} replacements)',
  'fs.replace_not_found': 'Error: replacement string not found in file "{path}"',
  'fs.replace_multiple': 'Error: found {count} matches of the replacement string. Provide more context for a unique match.',
  'fs.dir_created': 'Directory created: {path}',
  'fs.file_deleted': 'File deleted: {path}',

  // --- Чтение файлов (fs-read) ---
  'fsread.empty_directory': '(empty directory)',
  'fsread.no_files': '(no files found)',
  'fsread.glob_error': '(file search error)',

  // --- Веб (web_fetch / web_search) ---
  'web.duckduckgo_blocked': 'DuckDuckGo is temporarily blocking requests (anti-bot challenge)',
  'web.search_failed': 'Failed to get results from DuckDuckGo',
  'web.search_results': 'Search results for "{query}" ({count}):\n\n{items}',
  'web.fetch_args_url_required': 'specify url or urls',
  'web.js_framework_warning': '\n\n⚠️ The site uses a JavaScript framework — some content may be unavailable without executing JS.',
  'web.low_content_warning': '\n\n⚠️ The page has very little text content (possibly JavaScript rendering).',
  'web.content_truncated': '\n... (content truncated)',
  'web.block_timeout': '❌ Timeout',
  'web.block_error': '❌ Load error: {error}',
  'web.fetch_all_failed': 'Failed to load any of the URLs',
  'web.no_results': 'No results found for "{query}".',
  'web.search_error': 'Web search error: {error}',

  // --- Поиск ---
  'search.no_matches': '(no matches found)',
  'search.matches_truncated': '... (showing 200 of {total} matches)',
  'search.rg_not_installed': '(rg (ripgrep) is not installed. Search is unavailable)',
  'search.error': 'Search error: {error}',

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

  // --- Проект ---
  'project.deps_unavailable': 'Error: session manager or project store unavailable for {tool}',
  'project.session_read_error': 'Error: failed to read the session',
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
  'permission.no_rules': 'no permission rules for "{tool}" — allowed by default',
  'permission.rule_matched': 'rule "{key}" → {action}',
  'permission.rule_pattern_matched': 'rule "{key}.{pattern}" → {action} (path: {path})',
  'permission.rule_prefix_matched': 'rule "{key}.*" → {action}',
  'permission.rule_command_matched': 'rule "{key}.{pattern}" → {action} (command: {command})',
  'permission.ask_timeout': 'approval timed out',
  'permission.ask_no_subscribers': 'no connected user to approve',
  'permission.ask_denied': 'denied by the user',

  // --- Shell-политика (shell-guard) ---
  'shellguard.allow_default': 'command does not violate the shell policy',
  'shellguard.deny_prefix': 'Command denied by shell policy: prefix "{prefix}"',
  'shellguard.deny_path': 'Access denied by shell policy: path "{path}" is protected',
  'shellguard.ask_path': 'Path "{path}" requires approval per shell policy',
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

  // --- Router / провайдеры ---
  'router.timeout': 'Timeout or connection drop to the LLM provider',
  'router.network_error': 'Failed to connect to the LLM provider (network error)',
  'router.provider_not_found': 'Provider {provider} not found or not configured',
  'router.provider_unspecified': 'unspecified',
  'router.escalation': 'Escalated to {provider}/{model}: {reason}',
  'router.context_length_exceeded': 'Context window exceeded',
  'router.rate_limit_exceeded': 'Request rate limit exceeded',

  // --- Quality check (AD-034) ---
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

  // --- Микро-слой (AD-035) ---
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

  // --- Скиллы (AD-046) ---
  'skill.args_error': 'Skill argument error: {issues}',
  'skill.not_found': 'Skill "{name}" not found',
  'skill.untrusted': 'Skill "{name}" belongs to an untrusted project and cannot be loaded',
  'skill.delegation': 'The skill "{name}" requires capabilities: {capabilities}; agent "{agent}" does not have them. Call `task` with an agent that supports these capabilities.',
  'skill.file_not_found': 'Supporting file "{path}" not found in the skill directory',
  'skill.scope_disabled': 'Skill "{name}" is disabled ({reason}) and cannot be loaded',

  // --- Slash-команды (AD-046 §7) ---
  'command.unknown': 'Unknown command: /{name}',
  'command.denied': 'Command /{name} is denied by permission rules',
  'command.unavailable': 'Command /{name} is unavailable: missing capabilities {capabilities}',
  'command.help': 'Available commands: /help, /skills, /commands, /summary, /init. Type /<skill-or-bundle> to load it. Any other text goes to the model.',
  'command.list_empty': 'No commands available',
  'command.skills_empty': 'No skills available',
  'command.summary_enqueued': 'Summarization started',
  'command.summary_unavailable': 'Not enough active messages to summarize',

  // --- Inline shell (AD-046 §7.4) ---
  'command.inline_shell_disabled': 'Inline shell is disabled',
  'command.inline_shell_denied': 'Inline shell command "!`{command}`" denied: {reason}',
  'command.inline_shell_failed': 'Inline shell command failed: {output}',
  'command.inline_shell_truncated': 'Inline shell output truncated to {limit} bytes',
  'command.inline_shell_unavailable': 'Inline shell is unavailable',

  // --- Git-репозитории и SSH-ключи (AD-076) ---
  'sshkey.not_found': 'SSH key {id} not found',
  'sshkey.name_exists': 'SSH key with name "{name}" already exists',
  'sshkey.encryption_unavailable': 'SSH key encryption is unavailable: secret key is not configured',
  'sshkey.decrypt_failed': 'Failed to decrypt SSH key {id}',
  'sshkey.env_failed': 'Failed to prepare SSH environment (temporary key or askpass)',
  'git.ssh_key_required': 'SSH key is required for repository "{path}"',
  'git.repo_path_invalid': 'Invalid repository path "{path}" (must be inside the project workspace)',
  'git.repo_exists': 'Repository already exists at "{path}"',

  // --- Внешние события и хуки (AD-030 / AD-089) ---
  'event.ingested': 'Event {id} ingested from source "{source}"',
  'event.routed.bound': 'Event routed to bound session {sessionId}',
  'event.routed.ephemeral': 'Event routed to ephemeral session (agent "{agentTemplate}")',
  'event.routed.queue': 'Event queued for {owner}: {reason}',
  'event.routed.drop': 'Event dropped: {reason}',
  'event.binding.not_found': 'Event binding not found for "{key}"',
  'event.source_not_allowed': 'Event source "{source}" is not allowed',
  'event.duplicate': 'Duplicate event ignored: {dedupKey}',
  'hook.blocked': 'Hook "{hook}" blocked execution: {reason}',

  // --- Профиль пользователя и онбординг ---
  'profile.deps_unavailable': 'Error: session manager or profiles store unavailable for {tool}',
  'profile.session_read_error': 'Error: failed to read the session',
  'profile.session_not_found': 'Error: session not found',
  'profile.user_unavailable': 'Error: the session has no owner — profile update is unavailable',
  'profile.save_error': 'Error saving the profile: {error}',
  'profile.updated': 'Profile updated ({fields}).',
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

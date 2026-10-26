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
  'task.model_unavailable':
    'Error: the model "{provider}/{model}" requested for the subagent is unavailable — the provider is not configured or the model is unknown',
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

  // --- Фоновые саб-агенты и лимит шагов (этап 1 roadmap 0.13, блок 4) ---
  // `[steps_limit]` — короткая страховка после отчёта саб-агента: причина
  // (лимит шагов) и сам лимит. Подробности — в отчёте модели выше.
  'task.steps_limit':
    '[steps_limit] The subagent was stopped by the step limit ({limit}).',
  'task.steps_limit_empty':
    'The subagent exhausted the step limit ({limit}) and gave no textual answer; continue from its history or raise the limit',
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
  'web.ssrf_blocked': '🚫 Blocked by the network policy: {reason}',
  'web.too_many_redirects': '❌ Too many redirects',

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
  'router.provider_unspecified': 'unspecified',
  'router.escalation': 'Escalated to {provider}/{model}: {reason}',
  'router.context_length_exceeded': 'Context window exceeded',
  'router.rate_limit_exceeded': 'Request rate limit exceeded',
  'router.no_user_query':
    'The model could not process the tool-call chain (the original user query was lost). Try again, reduce the number of tools, or increase the model context window.',

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
  'git.ssh_key_required': 'SSH key is required for repository "{path}"',
  'git.repo_path_invalid': 'Invalid repository path "{path}" (must be inside the project workspace)',
  'git.repo_exists': 'Repository already exists at "{path}"',

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
  'process.tool.empty': 'No background runs',
  'process.tool.not_found': 'Background run "{id}" not found',
  'process.tool.deps_unavailable': 'The background run registry is unavailable in this build',
  'process.tool.header': 'Background runs ({count}):',
  'process.tool.no_log': 'There is no log for this background run',
  'process.tool.child_history':
    'The history of the child session {child_session} is available via the read_session_reference tool',
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

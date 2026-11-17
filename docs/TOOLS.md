# Инструменты агента — каталог групп и тулов

> Полный каталог встроенных инструментов (`packages/core/src/engine/tools/*`, capability-группы —
> `ToolCapability` в `@itphx/synth-shared`). Правила периметра (workspace, containment, `allowedRoots`,
> служебные каталоги инстанса вне проекта) — в корневом [`AGENTS.md`](../AGENTS.md) §«Рабочий каталог
> и инструменты»; здесь — состав и ограничения самих тулов.

| Группа | Тулы |
|---|---|
| Файлы (чтение) | `read_file` (потоком; `offset`/`limit`, дефолт и максимум 2000 строк, cap 50 КБ, строка ≤ 2000 символов; бинарь — ошибка с подсказкой, каталог — листинг), `list_directory`, `glob` (на `rg --files`: `hidden`, `limit` 100/макс 1000, сортировка по имени; **без исключений поиска** — перечисление отвечает на вопрос «что есть в проекте») |
| Файлы (запись) | `write_file`, `edit_file`, `create_directory`, `delete_file`, `patch` (`patch` — атомарная мультифайловая правка: JSON-массив `edits[]` с `file_path`/`old_string`/`new_string`/`replace_all`, 1..50 правок, всё-или-ничего — при любой ошибке ни один файл не меняется; запись атомарна по файлу tmp→rename с откатом) |
| Вложения (ADR-115) | `attach_workspace_file` — файл из workspace → **вложение диалога** (capability `file_read`, группа `read`, plan разрешён): containment (`path-utils`), `stat` до чтения, общие лимиты/allowlist `attachments.*`; тул возвращает `ToolResult.attachments`, а оркестратор (`_injectToolAttachments`) вставляет медиа-часть в **текущий** ход — сообщение служебное (`metadata.source='tool-attachment'`, `author='Tool'`, `metadata.agent_role`), в UI это системный блок «Агент · <имя> · вложение», а не user-пузырь; `blob_refs` пишет инъекция. `save_attachment` — вложение **текущей** сессии → файл в workspace (capability `file_write`, группа `write`, plan запрещён): выбор по сообщению (`message_id`/`message_seq`), затем `sha256`/`name`/последнее (неоднозначное имя → ошибка `attach.tool.ambiguous`), только объекты `attachments/`, публикация **без перезаписи** (`link`/`COPYFILE_EXCL`, занято → `attach.tool.exists`), `fs.changed`. `send_attachment` — файл workspace → вложение **ответа** (capability `file_read`, группа `read`): медиа-часть в коллектор хода → `parts` финального assistant-сообщения → `step.finished.attachments`; ошибка/отмена хода ничего не отправляет |
| Поиск | `grep_files` (`literal`, `caseSensitive` — default true, `hidden`, `limit` 100/макс 1000 по строкам совпадений; строка совпадения ≤ 2000 символов — длинная строка обрезается маркером `search.line_truncated`, общий счётчик совпадений при этом реальный; **мусорные пути исключены по умолчанию** — см. «Исключения поиска» ниже), `glob` (перечисление — без исключений) |
| Shell | `execute_shell`, `sandbox_exec` (ADR-135: разовый запуск 1..5 команд в отдельном профиле исполнения — пул класса `sandbox`; см. «Песочный запуск» ниже) |
| Git | `git_status`, `git_diff`, `git_log`, `git_commit`, `git_push`, `git_pull`, `git_checkout`, `git_branch_list`, `git_show`, `git_blame`, `git_stash` |
| SSH-ключи (ADR-076) | `ssh_keys_list` — метаданные ключей инстанса (`id`, `name`, `type`, `agentIds`, `createdAt`; приватный ключ и passphrase — **никогда**), фильтр `agent_id`; capability `git_read`, группа `git_read` (plan разрешён), **без привязки к workspace**. Нужен, чтобы взять `sshKeyId` для `project_repo_clone`/`project_repo_fetch`: у этих тулов текст отказа для SSH-URL перечисляет доступные ключи (`git.ssh_key_required_hint`, `id → name`, до 10) и отсылает к `ssh_keys_list`; нет стора ключей — прежний текст без списка |
| Git worktrees (ADR-114) | `git_worktree_list`, `git_worktree_create`, `git_worktree_remove`, `git_worktree_prune` — проект **только из сессии**; `git_worktree_list` — только чтение (группа `git_read`), мутации (`create`/`remove`/`prune`) — группа `git_write`, в plan-режиме запрещены; `create` не привязывает сессию — привязку делает `PATCH /api/v2/sessions/:id { worktreeId }` |
| Удалённый SSH (ADR-124) | `ssh_exec`, `ssh_copy`, `ssh_tunnel` — адресный доступ к удалённому хосту по SSH; capability `ssh`, группа правил `ssh` (authority: действие `execute`, вид цели `external`), в plan-режиме группа блокируется **целиком**; в режиме инстанса `ssh.mode='agent'` — `unavailable(policy)`; ключ — секрет вызова (`ExecSecret.mode='agent'`, эфемерный `ssh-agent`), пути к ключу в argv не бывает; ssh-клиент всегда с `-F /dev/null` (пользовательский `~/.ssh/config` не читается), `-o BatchMode=yes`, `-o StrictHostKeyChecking=accept-new`; параметры и ограничения — в разделе «Адресные SSH-тулы» ниже |
| План/ToDo | `plan_enter`, `plan_exit`, `plan_read`, `plan_list`, `plan_write`, `todo_write`, `todo_list`, `todo_add`, `todo_update`, `todo_delete`, `todo_reorder`, `todo_clear` — todo-тулы объявляют capability `[runtime, todo]` (группа правил `todo`, имена продублированы в `runtime`); список принадлежит **сессии вызова**: у саб-агента — своя дочерняя сессия (`extra.todoSessionId`), а не родительская; мутации публикуют `todos.updated` в канал сессии-владельца |
| Пайплайны (ADR-101) | `pipeline_list`, `pipeline_get`, `pipeline_save`, `pipeline_publish`, `pipeline_delete`, `pipeline_run`, `pipeline_run_status`, `pipeline_run_list`, `pipeline_run_resume`, `pipeline_run_cancel`, `pipeline_templates`, `pipeline_instantiate` — capability `pipeline`; проект **только из сессии** (параметра `project_id` нет), чтение доступно участнику проекта, мутации (`save`/`publish`/`delete`/`run`/`resume`/`cancel`/`instantiate`) — только с правом изменения содержимого проекта (`VIEWER` только читает) и не в plan-режиме; прогон — только по **опубликованной** версии, одновременно у пайплайна не более одного активного прогона; `resume` — действие `approve` (ADR-106) |
| Расписания (ADR-051) | `schedule_list`, `schedule_get`, `schedule_save`, `schedule_delete`, `schedule_run`, `schedule_jobs` — capability `schedule`; область — **проект** (`projectId` обязателен, инстансных нет; `GET /schedules` скоупится по доступным проектам), мутации — по праву изменения содержимого проекта, не в plan-режиме; триггер ровно один (`cron` 5 полей в UTC **или** `every` `30s\|15m\|1h\|24h`); цель `pipeline` требует **опубликованный** пайплайн и не создаёт сессию (прогон в фоне, прогресс — `pipeline_run_status`) |
| Таймеры и будильники (ADR-141) | `timer` (`create\|list\|show\|update\|stop\|delete`) и `alarm` (те же действия) — capability `schedule`, доступны без workspace; привязка к **проекту и сессии** (без проекта — отказ); `timer`: `delay` 10…2 592 000 с; `alarm`: `at` (ISO; без смещения — **локальная зона сервера**) **или** `time` (`HH:MM`) + `timezone`, `repeat: once\|daily\|every`; `comment` 1…500 — **единственный смысл** срабатывания. Глаголы: `stop` — статус `cancelled`, запись остаётся (`include_stopped`), `delete` — удаление; `show` — полный комментарий; `list` — фильтр `status` (найти `fired`/`cancelled`) и `include_stopped`; `update` — задержка/время/повтор/комментарий (недостающие поля `daily`/`every` при правке берутся из текущего правила: на существующем `daily` можно менять только `timezone`); `allow_duplicate` (по умолчанию false) — иначе активный дубликат (тот же вид/комментарий/имя) отклоняется; `at` в прошлом — ошибка (допуск 60 с); лимит 50 активных на сессию; id `tmr_`/`alm_`; срабатывание — служебное `timer_fired` (вклинивается в ход). Точность — приблизительная (десятки мс дрейфа под нагрузкой); `update` по `fired`/`cancelled` — отказ. В описаниях: для ожидания использовать `timer`, а не `sleep` |
| Инстанс и MCP (self-help, Workstream A1/A2) | `synth_info`, `synth_mcp_list`, `synth_mcp_test` (read) и `synth_mcp_add`, `synth_mcp_update`, `synth_mcp_remove`, `synth_mcp_enable`, `synth_mcp_reconnect` (write) — capability `instance`, группа `instance`, in-process (не HTTP-прокси), рабочий каталог не нужен; write-имена блокируются в plan-режиме. `synth_info` — версия/режим/dataDir/auth-флаги/storage/счётчики (видимые проекты/сессии), без значений ключей. `synth_mcp_list` — реестр MCP, статус, эффективный scope, причина и политика; URL редактируется, `headers`/`env` не отдаются. `synth_mcp_test` — временное подключение; `synth_mcp_add` — `origin:'instance'`/stdio **только ADMIN**, plaintext-секретные заголовки и `auth.kind:'credential'` отклоняются, user HTTP/SSE проверяются сетевой политикой; добавленный сервер **не** включается в сессию (opt-in). `synth_mcp_update`/`remove` — user-запись: автор или ADMIN/LEAD; instance-запись: **ADMIN**; `synth_mcp_enable` — `session` (владелец; событие `session.updated`), `project` (право изменения проекта; `project.updated`), `instance` (**ADMIN**); `synth_mcp_reconnect` — `refreshServer` без рестарта Synth. MCP-реестр и CLI — **локальные**; remote MCP (PROP-125) в инструменты не сливается (не критично). Секреты не читаются и не возвращаются |
| Проекты/сессии (discovery, Workstream B + A1 hybrid) | `list_projects`, `get_project`, `list_sessions`, `get_session_info`, `session_rename` — capability `runtime` (read-тулы доступны в plan); видимость как у HTTP: elevated (ADMIN/LEAD) видит всё, остальные — свои проекты/сессии и проекты участия; ответы — компактные сводки без истории сообщений и без `log`/`invariants`/секретов. `get_session_info` дополнительно отдаёт блок **`execution`** (ADR-135/PROP-135): `mode` (`inline`/`remote`), `pooling` (`instance`/`project`/`session`; в `inline` — `null`), `session_profile` (эффективные профиль сессии и браузерный профиль), `profiles` (каталог профилей инстанса: `name`, `class` (`exec`/`browser`/`both`), `default`, `browser_default`, `running`, `state`; ≤ 30 записей, лишнее — `truncated:true`) и `pools_error` (короткий код: провайдер пулов недоступен или не умеет перечислять пулы). `running` считается **только по пулам текущей области** (`project:<projectId>:…` / `session:<sessionId>:…` / `instance:…`): `ready` → `true`, `draining` → `false`, `configured`/пула нет → `null` (`state` — `ready`/`configured`/`draining`); чужие области не учитываются. **Адреса и токены пулов в сводку не попадают** (только имена/класс/состояние). В гибриде discovery **read-only** сливает оба мира: `origin:'local'|'remote'`, удалённые id `remote:<uuid>`, `can_attach:false`, `cross_instance:true`; `remote_offline`/`remote_truncated` — backend недоступен/список обрезан. `get_project` по `remote:<id>` читает удалённый проект, по имени ищет локально, затем в remote. `get_project`/`list_sessions` принимают id **или точное имя** (неоднозначность — `ambiguous` + кандидаты). `list_sessions`: без фильтра — оба мира, локальный проект — только локальные, `remote:` проект — только удалённые. `project_attach` не делает cross-world move: `remote:`/только remote → `project.cross_instance`, одинаковое имя локально+remote → `project.hybrid_ambiguous` (кандидаты), локальный `projectId` привязывается без remote-проверки. `session_rename` меняет только текущую сессию (1..200 символов, без LLM-регенерации) и публикует `session.renamed`/`session.updated` |
| Реестр фоновых прогонов (ADR-111/ADR-113) | `process_list`, `process_logs` (чтение; plan разрешён; `stream` — `combined` (по умолчанию) / `stdout` / `stderr`: у прогона три файла лога — общий и по одному на поток; файлы потоков есть у прогонов, запущенных после разделения потоков, у старых их нет — понятный ответ, не ошибка), `process_stop` (остановка running-прогона: процесс — `SIGTERM`→`SIGKILL`, фоновый саб-агент — abort дочернего прогона), `process_delete` (удаление только терминальной записи); скоуп «своя сессия + дочерние»; мутации в plan запрещены; capability `process`; лог — только у `kind: 'process'` |
| Задачи | `task` (в т.ч. `background: true` — фоновый саб-агент, ADR-111; продолжатель — `task({task_id})`), `classify_conversation`, `read_session_reference` |
| Вопрос пользователю (ADR-112) | `question` — capability `question`, группа правил `question`; пауза хода до ответа (срок — необязательный `timeout` **в секундах**, 300…86 400; по умолчанию таймаута нет); саб-агентам `deny`, в plan-режиме разрешён |
| Проект | `get_project_info`, `list_repos`, `project_create`, `project_attach`, `project_update`, `project_workspace_set`, `project_repo_clone`, `project_repo_init`, `project_repo_add`, `project_repo_fetch`, `project_repo_remove` — `project_attach` принимает `projectId` **или** `project` (id/точное имя, регистронезависимо; при неоднозначности — `ambiguous` + кандидаты; перенос снимает worktree, сбрасывает утверждение плана и публикует `session.moved`; пустой workspace нового проекта оставляет file/shell/git заблокированными до `project_workspace_set`) |
| Лог/Инварианты | `project_log_write`, `project_log_update`, `project_log_delete`, `project_log_read`, `project_invariants_read`, `project_invariants_write` |
| Веб | `web_fetch` (в т.ч. `include_media` — медиа ответа в blob + `ToolResult.attachments`, ADR-115), `web_search` (DuckDuckGo, при anti-bot — fallback на Bing) |
| Браузер (D1/D2) | `browser_navigate {url, timeout?}`, `browser_snapshot {}`, `browser_click {element, ref}`, `browser_type {element, ref, text, submit?}`, `browser_press {key}`, `browser_wait {time?, text?, timeout?}`, `browser_screenshot {filename?, fullPage?, timeout?}`, `browser_close {}` — capability `web` (группа правил `web`, plan разрешён). Вызов идёт **портом исполнения** в **проектный** пул класса `browser` (`project:<projectId>:browser:<profile>`, cookies общие внутри проекта и не текут между проектами); профиль — эффективный **браузерный** профиль хода (сессия → агент → проект → `execution.remote.browserProfile`, дефолт `browser`, **не** `defaultProfile`; каталог — `execution.remote.browserProfiles`, оркестратор кладёт значение в `ToolContext.extra.executionBrowserProfile`), MCP-сервер в поде — `execution.remote.browserMcpServer` (дефолт `playwright-mcp` — совпадает с дефолтом образа исполнителя). `browser_snapshot` отдаёт accessibility-снимок страницы (роли/имена/текст) и **ссылки элементов** (`ref` вида `e12`) — их принимают `browser_click`/`browser_type` вместе с человекочитаемым описанием (`element`); `browser_type` с `submit: true` жмёт Enter после ввода. `browser_press {key}` — клавиша (`Enter`/`Escape`/`Tab`/`Control+A`), `browser_wait` — пауза `time` **в секундах** и/или ожидание появления `text` (нужен хотя бы один параметр). Параметр `timeout` (**в секундах**, 1…600) у `browser_navigate`/`browser_wait`/`browser_screenshot` задаёт таймаут **одного** вызова; по умолчанию — таймаут инстанса `execution.remote.browserTimeoutMs` (дефолт 120 с, env `SYNTH_EXECUTION_BROWSER_TIMEOUT_MS`, потолок 600 с — в конфиге значение в мс). `browser_screenshot` снимает вьюпорт (`fullPage: true` — всю страницу) и публикует изображение **вложением сообщения** (`ToolResult.attachments` → оркестратор вставляет медиа-часть в текущий ход): байты пишет `AttachmentService` (`attachments.*`, MIME по сигнатуре), имя **вложения** — `filename` (по умолчанию `screenshot.png`; `.jpg`/`.jpeg` → JPEG); в Playwright `filename` **не передаётся**, уходит только `type`; MCP этой версии сохраняет файл в `/tmp/.playwright-mcp` и возвращает текстовую ссылку — тул читает файл через `ExecutionFs` того же пула и публикует байты вложением. Нет сервиса вложений/ошибка загрузки — текст-предупреждение с причиной (`metadata.reason`), `isError` **не** ставится: инструмент выполнен. `browser_close` освобождает браузер (следующий вызов открывает свежую страницу). Ошибки (нет адреса, 404, ошибка инструмента, таймаут) — `isError`-результат, шаг не падает; в `inline`-режиме тулы отвечают понятным отказом |
| Модели (ADR-115) | `list_models` — каталог моделей инстанса (capability `models`, группа `read`, plan разрешён, рабочий каталог не нужен): `provider/model` + `modalities`, **текущая** модель сессии и `defaultFor` (семейства, где модель назначена в `attachments.modalityModels`); без аргументов — компактный ответ (текущая + aux, без дампа каталога: у больших каталогов — сотни моделей), фильтры `modality`/`provider` и `limit` 1..50 (по умолчанию 20); модели без известных модальностей пропускаются и считаются отдельно |
| Профиль | `profile_update` (capability `user` — выдан только Агенту `assistant`; онбординг владельца сессии: `display_name`/`email`/`phone`/`notes`, завершение интервью — `ProfileData.interviewCompleted`) |
| Скиллы | `skill` (ADR-126: загрузка тела `SKILL.md` по имени + supporting-файлы; глобально отключается через `tools.disabled`) |
| Терминалы (ADR-132) | `terminal_list`, `terminal_read`, `terminal_snapshot` (чтение; plan разрешён), `terminal_open`, `terminal_write`, `terminal_signal`, `terminal_close`, `terminal_run` (мутации/исполнение; plan запрещён) — capability `terminal`, группа правил `terminal`; параметры, лимиты, обрамление `[CONTENT …]`, режимы запуска (`background`, `kill_on_timeout`), «экран вместо потока» (`terminal_snapshot`), полноэкранные приложения (`TERMINAL_FOREGROUND_APP`, рецепт ввода в диалог TUI), сигналы (`terminal_signal`) и правило «нет `cwd` — нет открытия» — в разделе «Терминалы» ниже |
| Скрипты проекта (ADR-126 §5) | `script_list` (чтение; plan разрешён), `script_run` (запуск; plan запрещён) — capability `shell`, группа правил `script` (`permission.rules.script`: allow/deny/ask + glob по имени; `deny` **скрывает** скрипт из списка и блокирует запуск). Скрипт — **декларация** (`.synth/scripts/<name>.md`), а не исполняемый файл: интерпретатор и аргументы — данные декларации. Запуск идёт через **тот же** реестр фоновых процессов (ADR-113), а не отдельным путём: ответ — `run_id`/`process_id`/`log_path`, лог читается `process_logs`, остановка — `process_stop`; параметры и ограничения — в разделе «Скрипты проекта» ниже |

**Общий предел вывода** (`tools.outputMaxLines`/`tools.outputMaxBytes`, по умолчанию
2000 строк / 51 200 байт) применяется в единой точке вызова (`executeToolDef`)
**поверх** лимитов тулов: усечение результата самим тулом (пагинация
`read_file`/`list_directory`, число совпадений `grep_files`) общий предел не
отменяет — отключить его тул не может (см.
[`docs/CONFIGURATION.md`](./CONFIGURATION.md) §«Предел вывода инструментов»).

### Таймауты инструментов

Параметр `timeout` у всех инструментов с таймаутом — **целое число секунд**.
Потолок задаёт **режим исполнения**, а не тул:

| Режим | Предел | Комментарий |
|---|---|---|
| foreground (синхронный вызов) | **600 с** (10 минут) | дольше — «подвесит» ход агента |
| background (фоновый процесс) | **86 400 с** (сутки) | фоновый процесс переживает ход агента, но не бесконечно |

`0` («без лимита») **не принимается**: у фонового процесса лимит — сутки, у
синхронного — 10 минут. Предел по режиму проверяется на границе вызова:
значение выше потолка режима — отказ аргументов с понятным текстом
(«timeout must be 1..600 seconds in foreground; use background mode for up to
86400»).

Исключения:

- `web_fetch` — отдельный сетевой предохранитель: 1…600 с, дефолт 30 с;
- `question` — это ожидание человека, а не исполнение: 300…86 400 с
  (по умолчанию срока нет — вопрос ждёт ответа бесконечно);
- декларация скрипта `.synth/scripts/*.md` — поле `timeout` в **секундах**,
  1…86 400 (скрипт всегда запускается в фоне; отсутствие поля — 86 400 с).

Внутри всё остаётся в **миллисекундах**: порты исполнения
(`ExecRequest.timeoutMs`), executor-протокол и конфиг-дефолты
(`git.*TimeoutMs`, `execution.remote.browserTimeoutMs`). Перевод — **на
границе** (`timeoutMs = timeout * 1000`). Метаданные результата тула несут
`timeout` в секундах.

Для ожидания не используй `sleep` в `execute_shell`/`terminal_run`: в
foreground он ограничен 10 минутами. Долгое ожидание — фоновый запуск
(`background: true`), результат придёт уведомлением.

### Проверки `execute_shell`

Shell — произвольный код: проверки ниже — **guardrail** (UX/defense-in-depth), а не граница
безопасности (ADR-136; изоляция — ADR-137). Guard работает **только с явными правилами**
(ADR-029, аддендум 2026-11-13), без эвристик разбора команд:

| Правило | Что даёт |
|---|---|
| `protected-paths.json` (тот же файл, что у файловых тулов) | защищённый путь → `deny` (`deny-protected-path`), `approvalPaths` → `ask` (`ask-protected-path`); проверяются лексический путь и `realpath` (симлинк не обходит денлист) |
| `external_directory` | путь вне периметра (`workingDir` + `allowedRoots`) → `ask` с `askKind: 'external'` и `askPaths`; решение принимает правило `permission.rules.external_directory` (дефолт `ask`, `plan`/`strict` — `deny`, явный `allow` снимает). Исключения — `/dev/null`, `/dev/stdin|stdout|stderr|tty`, `/dev/fd/N`, `/proc/self/fd/N` |
| `deniedCommandPrefixes` | явный список опасных команд (`rm -rf /`, `find / -delete`, …) → `deny`; матч по токенам в любом сегменте |
| plan-режим | мутирующая команда (`isMutatingCommand`) → `deny` |

Кандидат-путь — токен, который: после резолва `~`/`$HOME`/`${HOME}`/`$PWD`/`$SYNTH_DATA_DIR`
**существует** на ФС или попадает в защищённый путь; является целью редиректа (`>`, `>>`, `2>`,
`&>` — всегда путь); является не-флаговым операндом команды-писателя (`cp mv ln install mkdir
rmdir touch rm chmod chown tee truncate shred dd`); содержит glob-символы, и его литеральный
каталог существует (совпадения раскрываются и проверяются, лимит 2000); является целью
`cd`/`pushd` (проверяется и меняет cwd для следующих сегментов).

**Не проверяется** (принятые риски): `$VAR` (кроме известных), `$(...)`, backticks,
awk/sed/find-программы, heredoc, обёртки `sh -c`/`sudo`/`env`/`nohup`, интерпретаторы,
`for`/присваивания, `xargs`, `git -c`, `tar --to-command`, `rsync -e`. Наблюдаемость и внешнее
решение — аудит исполнений и `CommandPolicyProvider` (§9.1–9.2 [EXECUTION](./EXECUTION.md)).

### Исключения поиска (`grep_files`)

По умолчанию `grep_files` **не показывает** совпадения из служебных и
сгенерированных путей — зависимостей и артефактов сборки:

| Вид | Значения |
|---|---|
| Каталоги (сегмент пути на любой глубине) | `node_modules`, `dist`, `build`, `out`, `coverage`, `.venv`, `venv`, `__pycache__`, `.next`, `.turbo`, `.cache` |
| Файлы (имя файла) | `*.map`, `*.min.js`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `*.lock` |

Правила — в `packages/core/src/engine/tools/search-exclusions.ts`.

- **Считаются относительно корня поиска.** Исключается сегмент пути *внутри*
  каталога поиска; сам корень исключением не считается.
- **Явный путь важнее исключения.** Если `path` указывает на каталог внутри
  исключаемой области (`path: "node_modules/@itphx/synth-ui"`) или прямо на
  исключённый файл — поиск идёт, исключения внутри не применяются.
- **Прозрачность.** Скрытые совпадения считаются: в вывод добавляется маркер
  `search.matches_excluded` («сколько совпадений скрыто и какие категории
  пропущены»), а в `metadata` — `excludedMatches` (число) и
  `excludedCategories` (список категорий). Маркер не конфликтует с маркером
  усечения `search.matches_truncated` — оба доезжают до модели (в том числе
  когда общий предел вывода срезает хвост).
- **`glob`/`list_directory` не фильтруются** — перечисление отвечает на вопрос
  «что есть в проекте» (включая артефакты сборки), а не «где искать совпадения».

Основание — инцидент 2026-11-08: поиск из корня workspace нашёл совпадение в
`node_modules/@itphx/synth-ui/dist/assets/currency-D7Ta9S_Z.js.map` (файл целиком
в одну строку — 236 487 символов) и унёс в контекст модели 243 КБ.

### Фоновые прогоны: `process_logs` (ADR-111/ADR-113)

`process_logs` читает лог фонового шелл-процесса по id записи реестра
(`process_list`). У прогона **три** файла лога (blob-хранилище,
`processes/<runId>.log` / `.stdout.log` / `.stderr.log`) — общий и по одному на
поток; параметр `stream` выбирает, какой из них читать.

| Параметр | Описание |
|---|---|
| `process_id` | id записи реестра (`bgr_...`) — из `process_list` |
| `stream` | `combined` (по умолчанию) — общий лог: stdout и stderr в порядке прихода; `stdout`/`stderr` — только свой поток. Файлы потоков есть у прогонов, запущенных **после** разделения потоков; у более старых их нет — тул отдаёт понятный ответ (`log_stream=missing`), а не ошибку |
| `offset` | Смещение от начала лога, байт |
| `limit` | Предел выдачи, байт (по умолчанию 16 КиБ, максимум 64 КиБ) |

Лог есть только у `kind: 'process'` — у фонового саб-агента тул отдаёт
summary и id дочерней сессии (её история — в `read_session_reference`).
Скоуп — «своя сессия + дочерние»: чужой прогон выглядит как отсутствующий
(`process.tool.not_found`).

### План, ToDo, журнал и инварианты (PROP-054)

Тулы `plan_write`, `todo_*`, `project_log_*`, `project_invariants_write` пишут через
**доменные сервисы** (`engine/plan/service.ts`, `engine/todo/service.ts`,
`engine/project/{log,invariants}-service.ts`) — те же, что у HTTP-роутов
(`/api/v2/projects/:id/plan*`, `/api/v2/sessions/:id/todos*`), поэтому лимиты,
нормализация порядка и версия плана одинаковы в обоих контурах.

- **`plan_write`** — действия: `create_item` (`title`, `description?`, `columnId?`,
  `priority?`, `dependsOn?`, `tags?`), `update_item` (`itemId`, `title?`,
  `description?`, `priority?`, `tags?`), `move_item` (`itemId`, `columnId`,
  `beforeItemId?`/`afterItemId?` либо `order?`), `delete_item` (`itemId`),
  `set_dependencies` (`itemId`, `dependsOn`), `add_column` (`name`, `wipLimit?`),
  `update_column` (`columnId`, `name?`, `wipLimit?`), `delete_column`
  (`columnId`, `moveItemsTo`), `reorder_columns` (`order` — полный список id
  колонок). Ответ — **компактный**: id изменённого объекта и новая версия
  плана; полный markdown — в `plan_read`. После мутации событие `plan.updated`
  публикуется в каналы **всех сессий проекта** с payload `{project_id, version}`.
- **`todo_reorder`** (`ids` — желаемый порядок; неизвестные id игнорируются, не
  названные пункты — в конец) и **`todo_clear`** (`statuses?`; по умолчанию
  `completed` + `cancelled`). Оба публикуют `todos.updated` в канал сессии.
- **`project_log_write`** (append), **`project_log_update`** (`entryId`, `text`),
  **`project_log_delete`** (`entryId`) — журнал проекта; правка ставит
  аддитивные `updatedAt`/`updatedBy`. После мутации событие `project.updated`
  публикуется в каналы всех сессий проекта с payload `{project_id, kind:'log'}`.
- **`project_invariants_write`** — полная замена текста инвариантов; после
  мутации — `project.updated` с `kind:'invariants'`.

**Лимиты Markdown** (байты; превышение — ошибка валидации, `400 VALIDATION_ERROR`
в HTTP и отказ тула):

| Поле | Лимит | Где |
|---|---|---|
| `invariants` | 64 КиБ | `project.invariants` (попадает в системный промпт) |
| текст записи журнала | 16 КиБ | `project.log[].text` |
| описание пункта плана | 16 КиБ | `plan.items[].description` |
| текст пункта ToDo | 4 КиБ | `session.todos[].content` |

Лимиты и проверки — в `@itphx/synth-shared` (`MARKDOWN_LIMITS`) и в доменных
сервисах; HTTP и инструменты берут **одну и ту же** проверку.

**Markdown в промпте.** Многострочные значения (`plan.items[].description`,
`session.todos[].content`, `project.log[].text`) встраиваются в списки с
**отступом продолжения** (`engine/markdown.ts`): переводы строк и заголовки
внутри значения не разрывают внешний список.

### Саб-агент `task`: список задач и результат (ADR-129)

- **Параметр `todos`** (`todoAddItemSchema[]`) — стартовый список задач **дочерней** сессии
  (её операционный список, не `project.plan`). У новой сессии он засевается при создании (до
  публикации `session.created`); вместе с `task_id` — **полная замена** существующего списка
  (семантика `todo_write`); без параметра список не трогается. `status` (`pending`/`in_progress`/
  `completed`/`cancelled`) и `priority` (`high`/`medium`/`low`) опциональны — дефолты `pending` и
  `medium`; `id` сохраняются как переданы, чтобы вызывающий агент мог сверять списки.
- **Видимость у ребёнка.** Список синхронизируется durable state-сообщением `todos_updated`
  (как в основном ходе), а при непустом списке и доступном `todo_write` в системный промпт
  добавляется `[TODO FINALIZE]` — требование привести список в актуальное состояние. Сам список
  в промпте не дублируется.
- **Результат.** В `<task_result>` добавляется секция `<todos>` (кап **30** пунктов, хвост —
  `todo.more`), а в `metadata` — полный массив `todos`, `todos_total`, `todos_unfinished`. Поля
  есть во всех терминальных ветках: обычный финал, отмена, ошибка LLM, бюджет контекста
  (`task.context_budget`), шаг-лимит и жёсткий сбой (`task.subagent_exec_error`). Пустой список —
  секции и полей нет.
- **Фон.** Терминальное уведомление фонового прогона содержит тот же `<todos>` и `metadata.todos`;
  немедленный ответ `background:true` — прежний `{status:'running'}`. Авто-merge в родительский
  список нет: вызывающий агент сам решает, что перенести (`todo_update`).

Встроенные скиллы (ADR-126 §15, объявлены в коде — `packages/core/src/engine/skills/builtin.ts`): `synth-pipelines` (вызов `$synth-pipelines` — жизненный цикл пайплайна: спецификация → публикация → прогон → журнал, шаблоны инстанца), `synth-schedules` (вызов `$synth-schedules` — cron/интервал → цель, ручной запуск, история срабатываний), `synth-instance` (вызов `$synth-instance` — self-help по инстансу и MCP: вход/ключи, реестр MCP и его уровни, проекты/сессии, сетевая политика, перезапуск; `synth-instance` не требует capability `instance` — при недоступности `synth_*` делегирует @admin или UI/API), `synth-service` (вызов `$synth-service` — регистрация userspace-сервиса systemd через `synth service install`: вопросы о режиме/каталоге/порте/адресе, показ unit'а, установка без sudo; требует capability `shell`+`question`, ADR-134) и `synth-html-report` (вызов `$synth-html-report` — единый аналитический отчёт в self-contained HTML: каркас, сравнение вариантов, рекомендация, риски, открытые вопросы; capabilities `file_read`+`file_write`; поставляется каталогом `prompts/skills/synth-html-report` — CSS/логотип/чекер читаются только тулом `skill`, файловыми тулами base directory недоступен). Пайплайны/расписания требуют capability `pipeline`/`schedule` соответственно и работают в рамках правил области и прав, что и перечисленные выше тулы.

Доступность групп — в `ToolCapability` (`@itphx/synth-shared`); группа `user` (тул `profile_update`, только Агент `assistant`) отключаемая — админ может снять её через `tools.disabled`; группа `ssh` (адресные ssh-тулы, ADR-124) отключаема так же — по capability `ssh`; MCP-тулы регистрируются как `{serverName}_{toolName}`, подчиняются режимам (ADR-029) и выбираются **per-session** — в промпт идут только тулы активных серверов сессии. Слои разделены: `tools` — встроенные, `mcp.tools`/`mcp.servers`/`mcp.status` — MCP (всегда `volatile`) (ADR-071).

## MCP в локальных сессиях гибрида (ADR-125)

Серверные MCP-серверы доступны и локальным сессиям гибрида — их исполняет backend, а локальный
core получает доступ через серверный контракт. **Прямых egress к upstream MCP из локального core
нет**: сеть, TLS, SSRF-политика и секреты остаются на сервере (ADR-099/ADR-105).

- **Источник.** В DTO сервера — `origin` (реестр: `instance`/`user`) и аддитивно `source`
  (`local`/`server` — локальный инстанс или сервер гибрида); `source` нужен UI (бейдж «серверный»),
  а не резолверу скоупа.
- **Режимы доставки** — `remoteMode` в записи реестра: `auto` (дефолт: `http`/`sse` → `relay`,
  `stdio` → `tools`), `relay`, `tools`. Неудачный relay — **всегда** деградация в `tools` с причиной.
- **Скоуп — как у удалённых сессий:** системный мастер → `project.mcp.enabled` → сессионный снимок;
  обхода проекта (как у серверов исполнителя) нет.
- **Статус.** Недоступный серверный MCP остаётся в `GET /sessions/:id/mcp` со `status:'error'` и
  причиной в поле `error`; причина попадает и в блок `mcp.status` промпта (однострочная, ≤ 200
  символов, без секретов). Тулы недоступного сервера в промпт и в `ToolRegistry` не попадают, пока
  сервер не восстановится.

Подробности — [ADR-125](./arch_decisions/adr-125-hybrid-remote-mcp.md), контракт —
[docs/API_V2.md](./API_V2.md) §5.16.

## Адресные SSH-тулы (ADR-124)

Три тула `ssh_exec`/`ssh_copy`/`ssh_tunnel` работают в режиме инстанса `ssh.mode='tools'` — адресный доступ к удалённому хосту с проверяемой политикой ключа. Общее для всех: capability `ssh`, группа правил `ssh` (ключ группы совпадает со значением capability — правило `permission.rules.ssh` работает и по именам встроенных тулов, и по capability плагинного тула), authority-действие `execute` и вид цели `external`; в plan-режиме группа блокируется **целиком** (`isPlanBlockedTool` — план ничего не выполняет, а адресный SSH — выполнение на удалённом хосте); в режиме инстанса `ssh.mode='agent'` ключ выдаётся командам через `execute_shell`, и адресные тулы недоступны — `unavailable(policy)` (`engine/permission/availability.ts`), причина снимается сменой режима инстанса (runtime-настройка «SSH-ключи»), а не режима хода.

**Ключ — секрет вызова, а не аргумент.** Путь к приватному ключу в argv утекал бы в `ps`, поэтому на время вызова поднимается эфемерный `ssh-agent` (`ExecSecret.mode='agent'`), а материал готовит **точка исполнения** (ADR-077). В control plane файла с ключом не остаётся. Клиент (`ssh`/`sftp`) собирается всегда с `-F /dev/null` (пользовательский `~/.ssh/config` не читается — иначе конфиг хоста мог бы подсунуть `ProxyCommand`/`LocalCommand` и обойти политику хостов), `-o BatchMode=yes` (пароль не спрашивается) и `-o StrictHostKeyChecking=accept-new` (новый хост принимается, known_hosts обновляется).

**Пользователь — обязателен.** `user` у всех трёх тулов — обязательный параметр, и адрес собирается всегда как `user@host`. Причина: `-F /dev/null` отключает чтение пользовательского `~/.ssh/config`, поэтому «умолчательного» пользователя не существует. Без явного `user` клиент ssh подставил бы локального пользователя исполнителя (`node`) и получил бы `Permission denied (publickey,password)` — вызов выглядел бы как сломанный инструмент. Поэтому вызов без `user` отклоняется валидацией схемы (`tool.args_error`, поле `user`), а команда не запускается.

**Гейт — до запуска.** Единый гейт (`engine/ssh/access.ts`) проверяет `usages`/`agentIds`/`allowHosts`/`allowPorts` и **не раскрывает** ключ при отказе: отказ возвращается модели как `ToolResult` с ключом `ssh.access.<code>` (`key_not_found`/`usage_denied`/`agent_not_linked`/`host_denied`/`port_denied`/`policy_required`/`ambiguous`), список ключей в текст не попадает.

| Тул | Параметры | Runtime-зависимости | Ограничения |
|---|---|---|---|
| `ssh_exec` | `host` (обязателен; ≤ 253 симв., только буквы/цифры/точка/двоеточие/дефис/подчёркивание, не начинается с дефиса), `user` (**обязателен**, ≤ 64 симв., только буквы/цифры/точка/дефис/подчёркивание, не начинается с дефиса — конфиг ssh не читается, «умолчательного» пользователя нет), `port` (необязателен, 1…65535; по умолчанию 22), `key_id` (необязателен — id ключа из `ssh_keys_list`; не задан — берётся единственный подходящий), `argv` (обязателен: массив аргументов удалённой команды, 1…256 шт., каждый ≤ 4096 симв., без NUL), `timeout` (необязателен, **в секундах**: foreground — 1…600, по умолчанию 120; background — 1…86 400, по умолчанию 86 400), `background` (необязателен) | `ssh` (клиент) | Команда — **argv, а не shell**: локальной оболочки нет, значение аргумента не может стать инъекцией; разделитель `--` стоит **после** адреса, поэтому `-o`/`-F`/`-J`/`-l`/`-i` в `argv` остаются аргументами удалённой команды; `background: true` — уход в реестр фоновых прогонов (`process_id` + журнал, результат приходит уведомлением) |
| `ssh_copy` | `host`, `user` (**обязателен** — как у `ssh_exec`), `port`, `key_id` — как у `ssh_exec`; `direction` (обязателен: `upload`/`download`), `local` (обязателен: путь **относительно** рабочего каталога сессии), `remote` (обязателен: путь на удалённом хосте — абсолютный или относительно домашнего каталога), `recursive` (необязателен — `sftp -R`), `timeout` (необязателен, **в секундах**, 1…600; по умолчанию 120) | `sftp` (клиент) + `bash` (обёртка доставки batch) | Локальный путь — внутри периметра сессии (containment как у файловых тулов); `local` — путь файла проекта, поэтому к нему применяются file-правила (`external_directory`/`protected_paths`), а `remote` локальным путём не считается; транспорт — **sftp batch** по stdin клиента (`sftp -b -`): batch собирается только из проверенных значений, свободного текста в нём нет (запрещены управляющие символы, кавычки, обратные слэши, glob-символы и ведущий дефис) |
| `ssh_tunnel` | `host`, `user` (**обязателен** — как у `ssh_exec`), `port` (порт подключения к ssh-хосту; по умолчанию 22), `key_id` — как у `ssh_exec`; `direction` (обязателен: `local` — слушать здесь и пробрасывать через ssh-хост (`-L`), `remote` — просить ssh-хост слушать и пробрасывать обратно (`-R`)), `listen_port` (обязателен, 1…65535), `target_host` (обязателен для `local`; для `remote` — по умолчанию `127.0.0.1`), `target_port` (обязателен, 1…65535), `timeout` (необязателен, **в секундах**, 1…86 400; по умолчанию 86 400 — сутки; «без таймаута» больше нет) | `ssh` (клиент) | Слушающий сокет — **всегда `127.0.0.1`** (жёстко, без параметра: `0.0.0.0` открыл бы проброс наружу); политикой портов проверяется **целевой** порт (`target_port`), а не порт подключения к ssh; **SOCKS-проброс (`-D`) не поддерживается** — у него нет целевого порта, то есть нечего проверять политикой; туннель **всегда фоновый**: возвращает `process_id` + путь журнала и живёт до `process_stop` |

**Deny не останавливает ход** (ADR-070 §2.9.1, обновлено 2026-10-29): решение permission-слоя `deny` — ролевое (`matchedRule: 'role.unavailable'`), отказ пользователя (ask→deny) или запрет политики — возвращается модели обычным `tool_result` с причиной; следующая LLM-итерация запускается, и модель может выбрать другой инструмент или ответить текстом. Защита от зацикливания — doom-loop (одинаковые легальные вызовы), лимит шагов/итераций (`AgentDefinition.maxSteps`; `session.max_iterations` — только шаги пайплайнов) и счётчик одинаковых deny-вызовов (5 подряд → ход завершается). `session.role_tool_blocked` — только фоллбек-текст, если модель так и не дала содержательного ответа (статус `stopped`). **Doom-loop не срабатывает для наблюдения и ввода** (`DOOM_LOOP_EXEMPT_TOOLS`): `terminal_list`, `terminal_read`, `terminal_snapshot`, `terminal_write`, `terminal_signal`, `process_list`, `list_sessions`. Их повтор — не зацикливание: агент смотрит список/экран/вывод (мониторинг, ожидание результата в TUI), нажимает клавиши (tmux-префикс, стрелки, макросы) или повторяет сигнал (`INT`/`QUIT`/`TSTP` — «ещё раз прервать», «приостановить») — прерывать такой ход нельзя. Под защитой остаются **мутации** терминала: `terminal_run`, `terminal_open`, `terminal_close` — одинаковый вызов подряд считается циклом.

## Терминалы (ADR-132)

Тулы `terminal_*` дают агенту доступ к **интерактивным терминалам** (PTY) того же
контура, что и HTTP-роуты `/api/v2/terminals*`: тот же сервис на процесс
(`engine/terminal/service.ts`), тот же реестр живых терминалов, тот же аудит
(`terminal.open`/`terminal.input`/`terminal.close` — только метаданные, ADR-136).

- **Capability `terminal`** — отдельная от `shell`: терминал — доменный ресурс
  инстанса (реестр в памяти процесса + PTY на точке исполнения), а не
  примитив ядра. Группа правил — `terminal` (ключ совпадает со значением
  capability, поэтому правило `permission.rules.terminal` работает и по именам
  встроенных тулов, и по capability плагинного тула); группа отключаема
  админом через `tools.disabled`.
- **Plan-режим:** чтение (`terminal_list`, `terminal_read`,
  `terminal_snapshot`) **разрешено**,
  мутации (`terminal_open`, `terminal_write`, `terminal_signal`,
  `terminal_close`) и **запуск команд** (`terminal_run` — оба режима) —
  **заблокированы** (`isPlanBlockedTool`): план ничего не исполняет.
- **Доступность — по мастер-выключателю инстанса** `terminal.enabled`
  (env `SYNTH_TERMINAL_ENABLED` > runtime-«Терминалы» > `config.yaml` >
  default `true`). Выключено → тулы недоступны модели с причиной `policy`
  (`computeToolAvailability`, seam `getTerminalEnabled`), а не «deny в момент
  вызова». Отдельно: терминалу нужен **PTY** у точки исполнения — нет PTY →
  причина `dependency` (`RuntimeDeps.pty`), как у отсутствующей программы.
- **Скоуп — проект сессии.** Видны только терминалы проекта текущей сессии;
  чужой терминал выглядит как отсутствующий (`terminal.tool.not_found`).
  Терминалы проекта видны **все** (в т.ч. привязанные к другим сессиям) —
  признак `own` в списке помечает только те, что привязаны к текущей сессии.
- **Что в терминале — факт, а не догадка (протокол исполнителя 9).**
  `PtyHandle.inspect()` отдаёт `PtyForeground` (`shellPid`, `foregroundPgid`,
  `command`, `isShell`). По нему `terminal_list` показывает `foreground=<имя>`
  (если команда известна), `terminal_run` решает, можно ли запускать обёрнутую
  команду, а `terminal_write`/`terminal_run` — применять ли политику путей
  (внутри ssh/контейнера — нет). Нет пробы (старый исполнитель, не Linux) —
  прежние эвристики по выводу, политика строгая. Классификация —
  `engine/terminal/foreground-class.ts`, разбор — «Полноэкранные приложения и
  занятый терминал».
- **Обрамление вывода.** Весь вывод терминала, который возвращается модели,
  оборачивается в `[CONTENT …]` … `[CONTENT END]`
  (`engine/terminal/output.ts`): без обрамления модель не отличает «вывод
  терминала» от текста самого тула. Хвостовые пустые строки обрезаются,
  `\r\n` нормализуется в `\n` — **только** в возвращаемом тексте (буфер
  терминала хранит поток как есть: он — источник истины для UI/xterm.js).
  **Метаданные — атрибутами в открывающем маркере** (`[CONTENT key=value …]`);
  закрывающий маркер **не меняется** (`[CONTENT END]`). Значения атрибутов
  санитизируются: без переводов строк, пробелов и `]`, кап 120 символов;
  атрибут без значения не выводится. Таблица атрибутов — ниже.
- **У тулов без вывода (`terminal_open`, `terminal_write`, `terminal_signal`,
  `terminal_list`, `terminal_close`) маркера нет:** метаданные — в `metadata`
  ответа тула (`terminal_id`, `status`, `bytes`, `count`, `terminals[]`,
  `signal`, `interrupt` и т.д.), текст ответа — обычный (без `[CONTENT …]`).
- **`terminal_open` не идемпотентен.** Каждый вызов открывает **новый** терминал
  (новый PTY, свой буфер вывода): два открытия одного каталога дают два
  независимых терминала. Размеры по умолчанию — **80×24**, если `cols`/`rows`
  не заданы.
- **`strip_ansi` — что именно вырезается.** Кроме CSI (цвета/позиционирование)
  вырезаются: **OSC-строки целиком** (до BEL или ST — заголовки окон,
  гиперссылки, служебные OSC), **backspace** (`X\b` → удалить
  символ; `\b` в начале — ничего), **одиночный `\r`** (не часть `\r\n`);
  «широкие» вставки пробелов (подряд **больше 40**) схлопываются в один
  пробел. Цель — читаемый вывод. Строка-маркер запуска (`@@srn-…@@`) в буфер
  не попадает вовсе (вырезается сервисом, см. ниже) — `strip_ansi` для неё не
  нужен.
- **Таймаут `terminal_run` (режим с ожиданием) по умолчанию не убивает
  команду.** Команда продолжает выполняться в PTY; терминал остаётся
  **занятым** этим запуском (следующий `terminal_run` в нём — отказ
  `terminal.tool.run_busy`). Ответ тула это говорит прямо: `metadata.still_running
  = true`, `metadata.run_id` и подсказка «команда продолжает выполняться;
  терминал занят; чтобы остановить — пошлите Ctrl+C через `terminal_write`».
  С `kill_on_timeout: true` по таймауту сервис сам шлёт Ctrl+C (SIGINT) и
  **освобождает** терминал: статус остаётся `timeout`, но `still_running` нет и
  следующий запуск проходит. Когда команда доиграет сама, терминал
  освободится (уведомление о завершении при этом одно).
- **Реестр терминалов после рестарта ядра восстанавливается из снимков** —
  **не живые терминалы**: PTY умер вместе с процессом, поэтому запись
  поднимается со статусом `exited` и признаком `restored: true` (хвост вывода
  сохранён). Восстанавливаются только снимки моложе `terminal.idleMs`
  (2 суток), старые удаляются; при `terminal.autoRestore = false` не
  восстанавливается ничего.

| Тул | Параметры | Capability | Plan | Ограничения |
|---|---|---|---|---|
| `terminal_list` | `session_id?` (только терминалы этой сессии), `include_exited?` (по умолчанию — только живые) | `terminal` (read) | разрешён | Вывод — строки `key=value`: `id`, `cwd`, `shell`, `status`, `can_write`, `session_id`, `own`, `size`, `foreground` (если известно — имя foreground-процесса PTY, протокол 9: `sleep`, `ssh`, `vim`). `own=true|false` — привязан ли терминал к **текущей** сессии (`record.sessionId === ctx.sessionId`; терминал без сессии — `false`); терминалы проекта видны все, `own` помечает только свои. Те же признаки — в `metadata.terminals[]` (`own`, `foreground` — `null`, если факта нет) |
| `terminal_open` | `cols?` (по умолчанию 80, 1…1000), `rows?` (по умолчанию 24, 1…1000), `session_id?` (привязка; по умолчанию — текущая сессия), `title?` | `terminal` (write) | **запрещён** | Каталог вычисляет сервер; **параметра `cwd` нет** (см. правило ниже). **Каждый вызов открывает новый терминал — идемпотентности нет:** два открытия одного каталога дают два независимых PTY со своим выводом (совпадающие `cwd`/`shell` схлопываются только у **одновременных** незавершённых открытий). Размеры по умолчанию — **80×24**, если `cols`/`rows` не заданы |
| `terminal_read` | `terminal_id`, `since?` (только фрагменты с `seq > since`), `tail?` (последние N строк, 1…5000), `history?` (по умолчанию `false`), `strip_ansi?` (по умолчанию `false`) | `terminal` (read) | разрешён | Кап **32 КиБ** текста (хвост обрезается, `metadata.truncated`); **ANSI по умолчанию сохраняется** (цвета/позиционирование значимы), `strip_ansi: true` вырезает escape-последовательности (CSI/OSC целиком, backspace, одиночный `\r`) и схлопывает «широкие» вставки пробелов (>40 подряд → один пробел); `tail` отбрасывает завершающий пустой элемент (`'a\nb\nc\nd\n'` + `tail: 2` → `'c\nd'`); `history: true` — **весь доступный ring buffer** (кап тот же, `metadata.truncated`/`metadata.dropped_bytes`), `since`/`tail` при этом игнорируются; пустой буфер → `terminal.tool.history_empty` |
| `terminal_snapshot` | `terminal_id`, `cols?` (20…300; по умолчанию — ширина терминала), `rows?` (5…100; по умолчанию — высота терминала), `scrollback?` (0…500, по умолчанию `0`) | `terminal` (read) | разрешён | **Видимый экран**, а не поток: буфер прогоняется через headless-эмулятор xterm (`@xterm/headless`) и возвращается сетка `cols × rows` — как `tmux capture-pane -p`. Нужен для TUI (`htop`, `top`, `nvtop`, `tmux`, редакторы): перерисовка управляющими последовательностями в потоке нечитаема. ANSI-цвета **отбрасываются** (только содержимое ячеек), хвостовые пробелы обрезаны по правому краю; хвостовые пустые строки обрезаются, полностью пустой экран → `terminal.tool.snapshot_empty`. `scrollback` — ёмкость буфера эмулятора (история), в снимок всё равно попадает **видимый** экран. Работает и для `exited` (экран последнего вывода). `metadata`: `terminal_id`, `status`, `cols`, `rows`, `cursor {x,y}`, `lines`, `has_content` |
| `terminal_write` | `terminal_id`, `data` (нажатые клавиши; **может быть пустой**), `enter?` (по умолчанию `false` — без Enter), `delay_ms?` (пауза **перед** отправкой, 0…2000 мс; по умолчанию `0`) | `terminal` (write) | **запрещён** | С `enter: true` строка проходит **тот же чекер, что у `execute_shell`** (`checkShellCommand`): запрещённая политикой команда в терминал не уходит; требующая подтверждения (`ask`) — тоже (тул не умеет спрашивать пользователя: для таких команд — `execute_shell`). **Исключение — в фокусе удалённая оболочка** (`ssh`/`docker exec`/`kubectl exec`, факт протокола 9): политика локальных путей не применяется, команда идёт внутрь удалённой машины/контейнера, ответ несёт `metadata.remote_shell = true`. **Enter — CR (`\r`), а не LF:** терминальная line discipline и raw-режим (tmux-промпт, `less`, REPL) подтверждают ввод именно по CR; хвостовые `\r`/`\n` из `data` срезаются перед добавлением одного CR. **Пустой `data`:** с `enter: true` — отправляется чистый Enter (`\r`), команда пустая и shell-guard её **не** проверяет; без `enter` — отказ валидации (отправлять нечего). **Поведение по умолчанию не меняется:** ввод уходит сразу, результата команда не ждёт и автоматически не возвращает. **`delay_ms`** — пауза перед отправкой (тул остаётся синхронным по результату, `metadata.delay_ms` — при заданном значении): нужна интерактивным диалогам, где `:` и текст нельзя склеивать в один кадр. **Диалоги TUI (например tmux command-prompt) — только по шагам:** prefix → `:` (с `delay_ms ≈ 50`) → текст → отдельный `\r`, каждый шаг своим вызовом; tmux разбирает кадр целиком в старом режиме, поэтому склеенный `":" + текст` теряется — см. «Рецепт: ввод в диалог TUI» |
| `terminal_signal` | `terminal_id`, `signal` (`INT`/`QUIT`/`TSTP`) | `terminal` (write) | **запрещён** | Управляющий сигнал терминала: `INT` → `^C` (`0x03`, SIGINT), `QUIT` → `^\` (`0x1c`, SIGQUIT), `TSTP` → `^Z` (`0x1a`, SIGTSTP). Байт пишется в PTY как нажатие клавиши, затем **активный запуск терминала завершается** сервисом (`interruptRun`) как `done` с кодом `128+signum` (130/131/147) — иначе маркер запуска не придёт и терминал залип бы в `run_busy`. `metadata`: `terminal_id`, `signal`, `interrupt` (код завершения либо `null`, если активного запуска не было). `SIGTERM`/`SIGKILL` отдельной команды через PTY не выражаются (жёстко — `terminal_close`) |
| `terminal_run` | `terminal_id`, `command`, `background?` (по умолчанию `false`), `timeout?` (**в секундах**: foreground — по умолчанию 30, 1…600; background — по умолчанию 86 400, 1…86 400), `kill_on_timeout?` (по умолчанию `false`), `strip_ansi?` | `terminal` (write) | **запрещён** | **Один тул — два режима** (как `execute_shell`/`task`). `background: false` — **с ожиданием завершения**: команда проходит тот же shell-guard, что и `terminal_write` с `enter: true`; по завершении возвращает вывод в обрамлении `[CONTENT …]`…`[CONTENT END]` + код возврата (`metadata.exit_code`). **По таймауту команда по умолчанию НЕ убивается:** она продолжает выполняться в PTY, терминал остаётся занятым (следующий запуск — `terminal.tool.run_busy`), а ответ говорит об этом прямо — `metadata.still_running = true`, `metadata.run_id` и подсказка «остановить — Ctrl+C через `terminal_write`». `kill_on_timeout: true` — по таймауту сервис шлёт Ctrl+C и освобождает терминал (статус `timeout`, `still_running` нет). `background: true` — **без ожидания**: тул возвращает `run_id` сразу, а результат приходит **сообщением в чат** (как у фоновых шелл-процессов, ADR-113) — `role: USER`, автор `Process`, `metadata.type='background_run_result'`, `terminal_id`/`run_id`/`state`/`exit_code`/`command`/`started_at`/`finished_at`/`duration_ms`; текст — заголовок + вывод в обрамлении `[CONTENT …]`…`[CONTENT END]` (хвост ≤ 32 КиБ). Таймаут → `state: 'timeout'` (+ `still_running: true` без `kill_on_timeout`), выход терминала → `state: 'exited'` (частичный вывод). Терминал без привязки к сессии — уведомления нет (только лог). **Один активный запуск на терминал:** если запуск уже идёт — отказ `terminal.tool.run_busy` (в обоих режимах). **Эхо служебной обёртки и строка-маркер вырезаются из ответа ВСЕГДА** (`removeRunWrapper` по nonce и тексту обёртки) — **в том числе когда эхо перенесено на две строки**: при длинном prompt оболочки (локальный zsh) введённая строка не влезает в ширину терминала, и PTY рвёт её в произвольном месте (даже внутри `@@srn-<nonce>`); очистка допускает пробельный участок между символами команды и снимает всю логическую строку (prompt-остаток + обёртку), не оставляя пустой строки. `strip_ansi` управляет только ANSI-последовательностями и условием их удаления не является. **Полноэкранное приложение (tmux/vim/less/htop/top/mc/watch) или чужая команда (sleep/make/npm) в терминале — запуск запрещён:** отказ `terminal.tool.foreground_app` с `metadata.code = 'TERMINAL_FOREGROUND_APP'` (+ `metadata.foreground` — имя процесса) либо `terminal.tool.foreground_busy` с `TERMINAL_FOREGROUND_BUSY`; сервис проверяет **факт** `PtyHandle.inspect` (протокол 9), у старого исполнителя — эвристику по выводу (альтернативный экран и перерисовка), **до** записи в PTY. В TUI работают `terminal_write` + `terminal_snapshot` или отдельный терминал; в занятом терминале — ждут/Ctrl+C; см. «Полноэкранные приложения (tmux/vim/less/top/htop/watch) и занятый терминал». **Внутри ssh/контейнера** (`ssh`, `docker/podman exec`, `kubectl exec`) политика путей **не применяется** — команда идёт на удалённую машину, локальные пути там не значимы (ответ несёт `metadata.remote_shell = true`) |
| `terminal_close` | `terminal_id` | `terminal` (write) | **запрещён** | Оболочка завершается, запись удаляется из реестра; активный запуск команды при этом завершается статусом `exited` |

### Формат маркера `[CONTENT …]`

Вывод терминала, который возвращается модели, обрамляется маркерами:
открывающий — **с атрибутами** (метаданные), закрывающий — всегда
`[CONTENT END]`:

```text
[CONTENT key=value key2=value2]
…вывод…
[CONTENT END]
```

Значения атрибутов **санитизируются**: без переводов строк, пробелов и `]`,
кап 120 символов; атрибут без значения не выводится. Без атрибутов маркер
прежний — `[CONTENT]`.

| Атрибут | Значение | Где встречается |
|---|---|---|
| `terminal` | id терминала (`term_…`) | `terminal_read`, `terminal_snapshot`, `terminal_run` (оба режима) |
| `status` | статус терминала (`running`/`exited`/…) | `terminal_read`, `terminal_snapshot` |
| `status` | статус запуска (`done`/`timeout`/`exited`/…) | `terminal_run` (с ожиданием и уведомление о фоновом запуске) |
| `seq` | диапазон номеров фрагментов вывода: `first..last` | `terminal_read` |
| `bytes` | объём возвращённого вывода, байт | `terminal_read` |
| `history` | `true` — прочитан весь буфер | `terminal_read` (`history: true`) |
| `total_bytes` | объём вывода в буфере, байт | `terminal_read` (`history: true`) |
| `dropped_bytes` | сколько байт вытеснено из буфера | `terminal_read` (`history: true`) |
| `stripped` | `true` — ANSI-последовательности вырезаны | `terminal_read` (`strip_ansi: true`) |
| `tail` | сколько последних строк отдано | `terminal_read` (`tail: N`; в режиме `history` хвост игнорируется — атрибута нет) |
| `size` | размер экрана рендера: `colsxrows` | `terminal_snapshot` |
| `cursor` | позиция курсора на экране: `row,col` (0-based) | `terminal_snapshot` |
| `run` | id запуска (`run_…`) | `terminal_run` (оба режима) |
| `exit` | код возврата команды | `terminal_run` (когда известен) |
| `timeout` | срок ожидания, **секунды** | `terminal_run` (при таймауте) |
| `still_running` | `true` — команда продолжает выполняться (таймаут её **не** убивает) | `terminal_run` (при таймауте) |

Примеры:

```text
[CONTENT terminal=term_1 status=running seq=1..2 bytes=12 history=true total_bytes=13 dropped_bytes=0]
first
second
[CONTENT END]

[CONTENT terminal=term_1 run=run_1 status=done exit=0]
file1
file2
[CONTENT END]

[CONTENT terminal=term_1 run=run_1 status=timeout timeout=30 still_running=true]
partial
[CONTENT END]

[CONTENT terminal=term_1 status=running size=120x40 cursor=12,7]
  PID USER      PR  NI    VIRT    RES  %CPU  %MEM     TIME+ COMMAND
 1234 app      20   0  512.3m  98.1m  12.3   2.4   0:04.11 node
[CONTENT END]
```

### Экран вместо потока (`terminal_snapshot`)

`terminal_read` отдаёт **поток** — то, что PTY выплюнул по байтам. Для обычных
команд это правильно, но полноэкранные TUI-программы (`htop`, `nvtop`, `tmux`,
`vim`, `less`) не «печатают» картинку, а **перерисовывают экран** управляющими
последовательностями (курсор вверх, очистка строки, альтернативный буфер).
Склеенный поток такой программы — километры мусора, в котором не видно
текущего состояния.

`terminal_snapshot` считает то, что человек **видит**: весь доступный буфер
скармливается headless-эмулятору xterm (`@xterm/headless`, тот же движок, что и
у вкладки терминала в UI), после чего читается сетка `cols × rows`. Это
аналог `tmux capture-pane -p`. В текст попадает только содержимое ячеек —
цвета, атрибуты и позиционирование отбрасываются, поэтому ответ читается
моделью как обычный текст.

| Параметр | По умолчанию | Смысл |
|---|---|---|
| `terminal_id` | — | id терминала (`term_…`) |
| `cols` | размер терминала | ширина окна рендера, 20…300 |
| `rows` | размер терминала | высота окна рендера, 5…100 |
| `scrollback` | `0` | ёмкость буфера прокрутки эмулятора, 0…500 (история; в снимок попадает только видимый экран) |

Примеры:

```text
# htop: последний кадр, а не поток перерисовок
terminal_write { terminal_id: "term_1", data: "htop", enter: true }
terminal_snapshot { terminal_id: "term_1" }

# tmux: снять экран панели после перерисовки
terminal_write { terminal_id: "term_1", data: "tmux attach", enter: true }
terminal_snapshot { terminal_id: "term_1", cols: 120, rows: 40 }

# меньше окно — только часть экрана (как при уменьшении терминала)
terminal_snapshot { terminal_id: "term_1", rows: 10 }
```

Пустой экран (программа ещё ничего не нарисовала или экран очищен) — отдельный
текст `terminal.tool.snapshot_empty`, а не обрамление с пустым телом.

У `terminal_open`, `terminal_write`, `terminal_signal`, `terminal_list`,
`terminal_close` вывода нет — **маркера тоже нет**: их метаданные лежат в
`metadata` ответа тула (текст ответа — обычный, без `[CONTENT …]`).

### Полноэкранные приложения (tmux/vim/less/top/htop/watch) и занятый терминал

**Что в терминале — определяется по процессу PTY, а не по выводу.** Сервис
спрашивает `PtyHandle.inspect()` (`engine/execution/ports/execution-port.ts`,
протокол исполнителя 9): ядро ОС отдаёт факт — `shellPid`, `foregroundPgid`,
имя foreground-процесса (`command`) и `isShell`. Классификация — данные в
`engine/terminal/foreground-class.ts` (имена сравниваются без пути, в нижнем
регистре и без аргументов):

- **`FULL_SCREEN_COMMANDS`** — `vi`, `vim`, `nvim`, `nano`, `emacs`, `less`,
  `more`, `most`, `man`, `top`, `htop`, `btop`, `nvtop`, `mc`, `tmux`,
  `screen`, `watch`, `fzf`. TUI перехватывает ввод и перерисовывает экран:
  команда ушла бы внутрь приложения, а маркер не выполнился бы.
- **`REMOTE_SHELL_COMMANDS`** — `ssh`, `mosh`, `sshpass`, `sftp`, `telnet`,
  `docker`, `podman`, `nerdctl`, `kubectl`, `minikube`, `oc`. Это **не** TUI:
  запуск разрешён (см. ниже про пути).

Если в фокусе полноэкранное приложение — `terminal_run` там **не работает**:
сервис отказывает **до** записи в PTY: `isError: true`, текст
`terminal.tool.foreground_app`, `metadata.code = 'TERMINAL_FOREGROUND_APP'`,
`metadata.terminal_id`, `metadata.foreground` (имя процесса). Отказ одинаков в
обоих режимах — `background: true` проверку не обходит; **обхода (`force`)
нет**.

Если в фокусе **обычная команда** (`sleep`, `make`, `npm test`, …) — терминал
**занят**: ввод ушёл бы в stdin чужого процесса. Новый отказ —
`terminal.tool.foreground_busy`, `metadata.code = 'TERMINAL_FOREGROUND_BUSY'`,
`metadata.terminal_id`, `metadata.foreground`. Правильный ход: дождаться
завершения, прервать (`terminal_signal {signal:"INT"}` / `terminal_write` с
`^C`) или открыть отдельный терминал.

**Разница `TERMINAL_FOREGROUND_APP` и `TERMINAL_FOREGROUND_BUSY`:**

| Код | Что в фокусе | Что делать |
|---|---|---|
| `TERMINAL_FOREGROUND_APP` | полноэкранное приложение (`vim`, `less`, `htop`, `tmux`) | работать **клавишами** и снимком экрана: `terminal_write` + `terminal_snapshot`; либо отдельный терминал |
| `TERMINAL_FOREGROUND_BUSY` | обычная программа (`sleep`, `make`, `npm`) | **ждать** завершения, прервать Ctrl+C (`terminal_signal INT`) или открыть отдельный терминал — клавиши здесь тоже ушли бы в чужой stdin |

**Fallback: у старого исполнителя пробы нет.** `inspect` — необязательный
метод контракта: если его нет (исполнитель протокола < 9) или проба вернула
`null` (нет `/proc`, ошибка чтения, не Linux), сервис работает по **прежней
эвристике** по буферу вывода:

- **альтернативный экран** — включённый и **не выключенный**
  `ESC [ ? 1049 h` (tmux), `?1047h` / `?47h` (vim, less): последнее `h` позже
  последнего `l` (или `l` не было вовсе);
- **перерисовка экрана** — в хвосте вывода (последние **256** символов) не
  меньше **3** последовательностей курсорной адресации `ESC [ r ; c H`. Так
  работают `top`, `htop`, `nvtop`, `mc`, `watch`: альтернативный экран они не
  включают, зато рисуют картинку построчно. Совпадения до последней очистки
  экрана (`ESC[2J`) не считаются — она стирает нарисованное;
- **очистка экрана + перерисовка** — `ESC[2J` в хвосте и не меньше **3**
  `ESC[r;cH` после неё.

Окно узкое (256 символов) намеренно: последний кадр TUI — это 1–2 КБ, и широкое
окно продолжало видеть его после выхода из `vim`/`htop`/`watch` — флаг
«полноэкранное приложение» залипал до следующего вывода. Промпт оболочки с
одной-двумя адресациями в окне перерисовкой не считается. На fallback-пути
отказа `TERMINAL_FOREGROUND_BUSY` **нет** (эвристика не знает имени процесса и
не отличает TUI от обычной команды).

**Пути внутри ssh/контейнера.** Если в фокусе удалённая оболочка
(`ssh`/`docker exec`/`kubectl exec`), `terminal_run` и `terminal_write` с
`enter: true` **не применяют локальную политику путей** (`checkShellCommand`):
команда исполняется на удалённой машине/в контейнере, где локальные пути
недоступны и не значимы. Это осознанное сужение guardrail'а (ADR-136: shell —
произвольный код, политика — не граница безопасности), а не дыра: без
исключения любая команда с абсолютным путём получала бы отказ на локальной
проверке, хотя внутри контейнера путь корректен. Ответ несёт
`metadata.remote_shell = true`. На fallback-пути (пробы нет) политика
**строгая** — как раньше.

**Внимание: TUI внутри ssh локально не виден.** Проба видит только процесс
`ssh` — что там запущено (vim, htop, tmux на той стороне), локально неизвестно.
Поэтому в ssh-сессии маркер запуска может не сработать, если удалённая сторона
открыла полноэкранное приложение: `terminal_run` не откажет
(`TERMINAL_FOREGROUND_APP` не сработает), но вывод будет нечитаемым. Для TUI
**внутри** ssh по-прежнему нужен `terminal_snapshot` (и работа клавишами) — он
рендерит поток в видимый экран.

**Что делать.**

- работать **вводом и экраном**: `terminal_write` (клавиши) +
  `terminal_snapshot` (что сейчас на экране) — рецепт для tmux ниже;
- либо открыть **отдельный терминал** (`terminal_open`) и запускать команду в
  нём: новый PTY полноэкранного приложения не содержит.

Отдельный терминал предпочтителен, когда нужен именно **результат** команды
(код возврата и вывод в `[CONTENT …]`): в TUI `terminal_run` не поможет.

### Рецепт: ввод в диалог TUI (tmux command-prompt)

Штатный способ набрать что-то в приглашении мультиплексора — **по шагам**,
каждый шаг отдельным вызовом `terminal_write`; `:` и текст разносятся паузой
`delay_ms`:

```text
1. terminal_write { terminal_id: "term_1", data: "\u0002" }                    # prefix (C-b по умолчанию)
2. terminal_write { terminal_id: "term_1", data: ":", delay_ms: 50 }           # открыть command-prompt
3. terminal_write { terminal_id: "term_1", data: "new-window", delay_ms: 50 }  # текст команды
4. terminal_write { terminal_id: "term_1", data: "", enter: true }             # отдельный CR — выполнить
   terminal_snapshot { terminal_id: "term_1" }                                 # проверить, что получилось
```

**Почему нельзя склеить в один вызов.** tmux разбирает **весь** пришедший кадр
до того, как переключиться в режим command-prompt: если `:` и текст пришли
одним чанком (`"\u0002:new-window\r"`), текст обрабатывается ещё в старом
режиме (как команды префикса) и теряется. Отправка по шагам (при необходимости
с паузой `delay_ms`) даёт приложению обработать каждый кадр в нужном режиме.

Перед вводом в промпт можно нажать Ctrl+U (`\u0015`) — очистить строку.

**Правило «нет `cwd` — нет открытия».** Рабочий каталог терминала вычисляет
сервер: `session.worktree.directory` (ADR-114) → `project.workspace` (ADR-075).
Параметра `cwd` у тулов **нет** — иначе терминал уехал бы за периметр проекта.
У сессии без проекта терминалы недоступны вовсе (`terminal.tool.project_required`):
терминал — ресурс проекта.

**Режимы `terminal_run` — матрица.** Один тул, два режима (как `execute_shell`
и `task`); отдельного тула `terminal_run_background` больше нет.

| | `background: false` (по умолчанию) | `background: true` |
|---|---|---|
| Что делает тул | запускает команду и **ждёт** завершения | запускает команду и **возвращает управление сразу** |
| Что возвращает тул | вывод в обрамлении `[CONTENT …]`…`[CONTENT END]` + код возврата (`metadata.exit_code`, `metadata.status`) | `run_id` терминального запуска + подсказка (`metadata.run_id`, `metadata.status: 'running'`, `metadata.background: true`) |
| Где приходит результат | в ответе тула | **сообщением в чат** (`metadata.type='background_run_result'`, `kind='terminal'` **без** маркера `terminal_context`, автор `Process`) — доставляет сервис терминалов (`onRunFinished`), а не тул; в UI это фоновый процесс (карточка `execute_shell`), а не «Содержимое терминала» (карточка `terminal_read` — та только у контекста из `POST /prompt`, `metadata.terminal_context: true`) |
| `timeout` | срок ожидания **в секундах** (foreground: по умолчанию 30, 1…600; background: по умолчанию 86 400, 1…86 400); по истечении — **команда не убивается**: она продолжает выполняться в PTY, терминал остаётся занятым (следующий запуск — `run_busy`), ответ несёт `metadata.still_running: true` + `metadata.run_id` и подсказку «остановить — Ctrl+C через `terminal_write`» (если не задан `kill_on_timeout`) | **watchdog** фонового запуска (дефолт — сутки; «без лимита» больше нет). Сработавший watchdog — тот же статус `timeout` (без `kill_on_timeout` команда не убита) |
| `kill_on_timeout` | `true` — по таймауту сервис шлёт Ctrl+C (SIGINT) и **освобождает** терминал: статус `timeout`, `still_running` нет; `false`/не задан — прежнее поведение (команда остаётся работать, терминал занят) | то же (watchdog фонового запуска тоже может погасить команду) |
| `strip_ansi` | вырезает ANSI из вывода в ответе; эхо обёртки и маркер вырезаются **всегда** (флагом не управляются) | не влияет: вывод доставляет сервис терминалов |
| План-режим | **запрещён** | **запрещён** |
| Занятый терминал | отказ `terminal.tool.run_busy` | отказ `terminal.tool.run_busy` |
| Полноэкранное приложение в терминале (tmux/vim/less/top/htop/watch) | отказ `terminal.tool.foreground_app` (`metadata.code = 'TERMINAL_FOREGROUND_APP'`) | тот же отказ — режим проверку не обходит |

`terminal_write` — **дефолтный способ работать с терминалом без ожидания**:
он отправляет ввод и **не ждёт** результата (результат смотрится через
`terminal_read`). `terminal_run` с `background: true` — запуск команды, чей
результат **должен вернуться в чат** (уведомлением).

**Примеры вызовов.**

```text
terminal_list {}                                  → список терминалов проекта (own — свои сессии)
terminal_open { cols: 120, rows: 40 }             → открыть терминал (id в ответе; каждый вызов — новый)
terminal_write { terminal_id: "term_…", data: "npm test", enter: true }
terminal_write { terminal_id: "term_…", data: "", enter: true } → чистый Enter (пустая команда)
terminal_write { terminal_id: "term_…", data: ":", delay_ms: 50 } → пауза 50 мс, затем ":" (tmux-промпт)
terminal_signal { terminal_id: "term_…", signal: "INT" }  → ^C: прервать команду, освободить терминал
terminal_signal { terminal_id: "term_…", signal: "TSTP" } → ^Z: приостановить (SIGTSTP)
terminal_read  { terminal_id: "term_…", tail: 20 } → последние 20 строк вывода
terminal_read  { terminal_id: "term_…", since: 42, strip_ansi: true }
terminal_read  { terminal_id: "term_…", history: true } → вся история вывода
terminal_run   { terminal_id: "term_…", command: "npm test", timeout: 60 }
terminal_run   { terminal_id: "term_…", command: "npm test", timeout: 60, kill_on_timeout: true }
terminal_run   { terminal_id: "term_…", command: "npm test", background: true }
terminal_run   { terminal_id: "term_…", command: "npm test", background: true, timeout: 600 }
terminal_close { terminal_id: "term_…" }
```

### Сигналы и остановка команды

Терминал — не `kill(2)`: сигнал уходит **байтом в поток PTY**, и решение
принимает line discipline (или сама программа в raw-режиме). Поэтому
выразимы ровно три управляющих байта:

| `signal` | Байт | Смысл | Код завершения запуска |
|---|---|---|---|
| `INT` | `^C` (`0x03`, ETX) | SIGINT — прервать текущую команду/строку | 130 (`128+2`) |
| `QUIT` | `^\` (`0x1c`, FS) | SIGQUIT — прервать и снять дамп (где включён) | 131 (`128+3`) |
| `TSTP` | `^Z` (`0x1a`, SUB) | SIGTSTP — приостановить (job control) | 147 (`128+19`) |

**Почему `SIGTERM`/`SIGKILL` не выразить.** У байта в PTY нет pid: это
нажатие клавиши, а не сигнал процессу. `kill -TERM <pid>` — это уже команда
внутри оболочки (и pid надо знать), а `kill -9`/группа процессов вообще не
прокидываются: PTY не даёт адресовать конкретный процесс. Нужен **жёсткий**
обрыв — `terminal_close` (закрывает PTY: `SIGTERM` группе → `SIGKILL`).

**Зачем тул завершает запуск сам.** После `^C` (`^Z`, `^\`) строка-маркер
запуска (`printf … @@srn-…`) уже не выполняется — маркер не придёт, и
запуск остался бы активным навсегда (`run_busy` на любой следующий
`terminal_run`). Поэтому `terminal_signal` сразу после записи байта зовёт
`TerminalService.interruptRun(terminalId, 128+signum)`: запуск получает
`done`/код и `stillRunning: false`, терминал свободен. Если активного запуска
не было, `metadata.interrupt = null`.

**Остановка команды — три способа.** `terminal_signal {signal:"INT"}` —
явный Ctrl+C; `terminal_write {data:"\u0003"}` — тот же ETX через ввод (сервис
распознаёт его сам); `terminal_run {kill_on_timeout:true}` — автоматический
Ctrl+C по истечении `timeout`. «Стоп» хода агента команду в PTY **не**
гасит — это делает только один из этих путей.

**Ввод с `enter` — под тем же shell-guard'ом, что `execute_shell`**
(`protected-paths.json`, `external_directory`, `deniedCommandPrefixes`; ADR-029/ADR-136).
Отказ понятен модели: запрещённая команда не отправляется в терминал, а ответ
(`terminal.tool.command_denied` / `terminal.tool.command_requires_approval`)
объясняет причину и предлагает `execute_shell` для команд, требующих
подтверждения пользователем.

**Как определяется «команда завершилась».** Команда уходит в интерактивную
оболочку, поэтому код возврата из неё самой не достать. После команды сервис
отправляет **текстовый** маркер (`engine/terminal/runs.ts`,
`buildRunMarkerCommand`):

```text
printf '\n\033[2K@@srn-<nonce>:%s@@\033[2K\r' "$?"
```

В потоке остаётся строка `@@srn-<nonce>:<код>@@` — маркер **текстовый**, не
escape-последовательность. `printf` печатает её и сразу стирает с экрана
(`\033[2K` до и после), поэтому глазами её не видно. `printf` — builtin любой
POSIX-оболочки; `"$?"` — код возврата **предыдущей** команды (строка-обёртка
идёт **отдельной строкой** после команды, поэтому `$?` ещё не изменился);
`<nonce>` — случайный идентификатор запуска (чужой маркер наш запуск не
завершит).

**Почему маркер текстовый, а не OSC.** Раньше это была OSC-последовательность
(`ESC ] 7770 ; synth-run ; … BEL`), рассчитанная на «невидимость». В PTY, где
работает мультиплексор (tmux, в том числе tmux под ssh), OSC перехватывает
**сам мультиплексор** и наружу — в наш буфер — **не пропускает**: код возврата
не приходил, запуск висел до таймаута, а терминал оставался занятым
(`run_busy`). Текстовая строка проходит через любой мультиплексор.

Маркер считается маркером, только если он **начинает строку** (эхо команды
`printf '…@@srn-…'` начинается с `printf` — ложных срабатываний нет) и
заканчивается `@@`; код — целое (в т.ч. отрицательное) или пусто. Сервис ловит
маркер в потоке PTY и **вырезает его до записи в кольцевой буфер**
(`scanRunMarkers`): ни `terminal_read`, ни `terminal_snapshot`, ни ответ модели
маркера не видят. **Эхо строки-обёртки** (оболочка печатает `printf …` при
наборе) в буфере остаётся, а из **результата запуска** снимается очисткой
`cleanRunOutput` → `removeRunWrapper` — по тексту обёртки (с допуском шума
между символами — пробелы, `\r`/`ESC[K` перерисовки и повтор символа, потому что
PTY переносит длинную строку по ширине терминала, а zsh на узком терминале её
перерисовывает)
и по nonce вырезаются и строка-обёртка, и маркер, и их обрывки. **Инлайн-ответ
`terminal_run` чистится так же всегда:** `formatRunResult` вызывает
`removeRunWrapper(run.output, run.wrapperCommand, run.nonce)` независимо от
`strip_ansi`; флаг `strip_ansi` управляет **только** ANSI-последовательностями.

**Реестр запусков** — в памяти процесса (`engine/terminal/runs.ts`): не больше
одного активного запуска на терминал (`run_busy`), вывод запуска ограничен
1 МиБ (хвост сохраняется), в реестре не больше 32 записей, закрытие терминала
завершает его запуск статусом `exited`. **Watchdog запуска** (таймаут): в
режиме с ожиданием срок жёсткий (`timeout` — секунды, по умолчанию 30 с, потолок 600 с); в фоновом
режиме — необязательный: не задан — срок `0`, и таймер **не ставится вовсе**
(запуск без лимита: завершает только маркер команды или закрытие терминала).
**Таймаут не гасит команду:** она продолжает выполняться в PTY, поэтому
терминал остаётся занятым этим запуском (следующий запуск — `run_busy`), а
когда команда доиграет — маркер придёт и терминал освободится (уведомление о
завершении при этом одно — на запуск). Уведомление сессии
собирает **точка сборки** (`server/app/deps.ts`, `backend/app/deps.ts`) — тем же
нотификатором, что у фоновых шелл-процессов
(`createBackgroundParentNotifier`): ровно одна копия (steer при активном ходе,
иначе очередь + автоход). Вывод уведомления — **тот же очищенный вид**, что у
инлайн-ответа: `cleanRunOutput` (`stripTerminalAnsi` → `removeRunWrapper` →
`normalizeTerminalOutput`) — без ANSI, без эха служебной строки-обёртки
(`printf … @@srn-…`) и без самого маркера (`@@srn-<nonce>:<код>@@`), без
хвостовых пустых строк; читать `terminal_read` после
фонового запуска не нужно.

### Примечания по отчёту тестировщика

- **(F) Shell-политика `terminal_run` — guardrail, а не граница (ADR-136).**
  Команда проверяется **по локальной строке** тем же чекером, что
  `execute_shell`, — до отправки в PTY. Команда, набранная **внутри** ssh-сессии
  (или иного удалённого шелла), локально не проверяется: политика видит только
  строку, уходящую в терминал. Это осознанно — shell есть произвольный код.
  **Исключение сделано явным:** если в фокусе PTY удалённая оболочка
  (`ssh`/`mosh`/`docker exec`/`kubectl exec` …, факт `PtyHandle.inspect`,
  протокол 9), `terminal_run` и `terminal_write` с `enter: true` **не
  применяют** локальную политику путей: команда исполняется на удалённой
  машине/в контейнере, где локальные пути не существуют и не значимы, а
  локальная проверка давала бы ложные отказы. Ответ несёт
  `metadata.remote_shell = true`. У старого исполнителя (пробы нет) политика
  **строгая** — как раньше.
- **(H) Эхо обёртки `terminal_run` снимается и при переносе строки.**
  На локальном zsh длинный prompt + команда-обёртка не влезают в ширину
  терминала, и PTY рвёт эхо на две строки (перенос может попасть в любое место,
  включая середину `@@srn-<nonce>`); на ssh prompt короче, поэтому там дефект не
  проявлялся. На **узком** терминале (например, `cols=40`) zsh ещё и
  **перерисовывает** перенесённую строку: внутрь команды попадают `\r`, `ESC[K`
  и дубль символа (`…@@srn-…a0 \r ESC[K 6\r6:%s…`), а эхо встречается дважды —
  эхо набранных строк и перерисовка у приглашения. Очистка (`removeRunWrapper`)
  больше не сравнивает строку целиком: она строит шаблон из текста обёртки с
  допуском служебного шума между символами и **повтора символа** через шум, и
  снимает **все** такие логические строки — prompt-остаток и саму команду, — а
  перевод строки после эха тоже входит в совпадение, поэтому пустой строки и
  «голого» prompt (`%`) в выводе не остаётся. Чужой nonce не трогается:
  совпасть с обёрткой может только её собственное эхо.
- **(I) `cols`/`rows` в `terminal_snapshot` — эмуляция другого экрана.**
  Размеры меняют **рендер** (как ресайз окна в эмуляторе), а не сам PTY: для
  чтения TUI лучше **не** задавать их и брать экран в реальном размере
  терминала — иначе переносы строк в эмуляции не совпадут с тем, что видит
  пользователь.
- **(C) `:` и текст в одном чанке ломают tmux command-prompt — из-за разбора
  кадра, а не DA-ответов.** Предыдущая формулировка (виноваты ответы на
  DA-запросы) была неточной: tmux разбирает **весь** пришедший кадр до того,
  как переключиться в режим command-prompt, поэтому `:` и текст, отправленные
  одним вызовом `terminal_write` (`"\u0002:new-window\r"`), попадают в старый
  режим и теряются. Отправляйте **по шагам** — prefix → `:` → текст → отдельный
  `\r`, при необходимости с `delay_ms ≈ 50` (рецепт — «Рецепт: ввод в диалог
  TUI (tmux command-prompt)» выше). Перед вводом в промпт можно нажать Ctrl+U
  (`\u0015`) — очистить строку.

### Доступность по типу исполнения

Терминалы работают там, где у точки исполнения есть PTY.

| Точка исполнения | Терминалы |
|---|---|
| inline (standalone/dev) | да (PTY в процессе control plane; оболочка пользователя) |
| remote `core`/`dev`/`devops`/`full` | да (протокол ≥ 8, `features.pty`; по умолчанию zsh + OMZ + тема `synth`, bash доступен) |
| remote `browser`/`browser-full` | **нет** (`SYNTH_EXECUTOR_PTY=0`: браузерный пул — Chromium/Playwright; `POST /terminals` → 503 `TERMINAL_UNAVAILABLE`, reason `pty_unsupported`) |
| старый исполнитель (protocol ≤ 7) | нет (тот же 503) |

`terminal_*` на неподдерживающем профиле завершаются понятной ошибкой, а не 500.

## Скрипты проекта (ADR-126 §5)

Скрипт — **декларация** (markdown + frontmatter), а не исполняемый файл: интерпретатор
и аргументы — данные декларации, сам исполняемый файл остаётся обычным файлом
репозитория. Реестр: `{project.workspace}/.synth/scripts` (project) > `{dataDir}/scripts`
(instance) > `config.scripts.paths` (приоритет first-wins); проектные каталоги проходят
**тот же trust-гейт**, что скиллы и команды (ADR-126 §9) — недоверенный каталог виден в
реестре (`available: false`), но не запускается. Формат frontmatter — в
[`docs/CONFIGURATION.md`](./CONFIGURATION.md) §«Скрипты проекта».

| Тул | Параметры | Результат |
|---|---|---|
| `script_list` | нет | Реестр скриптов: `name`, `description`, `origin` (`project`/`instance`/`config`), `available` (`false` — каталог недоверенный), подсказка по аргументам (`argument_hint`). Скрипты, запрещённые правилом прав, **не показываются** |
| `script_run` | `name` (обязателен — из `script_list`), `arguments?` (строка; разбирается лексером скриптов — без shell и без подстановок) | `run_id`, `process_id`, `log_path` — запуск **асинхронный** (фоновый процесс), `metadata.status = 'script_started'` |

- **Единственный путь исполнения — общий реестр фоновых прогонов (ADR-113).**
  `script_run` не заводит отдельного пути: процесс стартует через
  `ProcessService`/`ExecutionPort.spawnBackground`, лог пишется в blob-хранилище
  (`processes/<runId>.log`), события — `process.started`/`process.exited`. Лог читается
  тулом `process_logs`, остановка — `process_stop`; карточка прогона — во вкладке
  «Фоновые процессы» (HTTP-контур — [`docs/API_V2.md`](./API_V2.md) §5.39).
- **Права — `permission.rules.script`** (allow/deny/ask + glob по имени, как у `skill`):
  `deny` **скрывает** скрипт из списка (и для агента, и для человека) и блокирует запуск;
  `ask` спрашивает только агента — человек инициировал действие сам, спрашивать его не о чем.
- **Plan-режим:** `script_list` разрешён, `script_run` **заблокирован**
  (`isPlanBlockedTool`) — план ничего не исполняет.
- **Аудит** (`security.commandAudit`, ADR-136): запись `script.run` — только метаданные
  (имя скрипта, cwd, число аргументов, origin); сами аргументы не пишутся.
- **`!name args` в сообщении** — тот же запуск, но **без хода LLM**: резолвится в ядре
  (ранняя фаза оркестратора, рядом с `/`-командами и `$`-скиллами), ответ — локальное
  эфемерное сообщение. Подробности — [`docs/API_V2.md`](./API_V2.md) §5.5.1.

## Песочный запуск (`sandbox_exec`, ADR-135)

`sandbox_exec` — **разовый** запуск команд в отдельном профиле исполнения: адрес пула выдаёт
provisioner по ключу с классом `sandbox` (`session:<id>:sandbox:<profile>`), то есть это **другой
пул** — свой образ и свой набор программ, а не рабочий каталог сессии. Постоянной браузерной/
песочной сессии у тула нет (браузерный класс и MCP — следующий слайс ADR-135).

| Параметр | Описание |
|---|---|
| `profile` | имя профиля исполнения из каталога инстанса (обязателен) |
| `commands` | 1..5 shell-команд (bash); выполняются **последовательно**, работа останавливается на первой ошибке |
| `cwd` | рабочий каталог команд (абсолютный или относительный от рабочего каталога сессии; по умолчанию — рабочий каталог) |
| `timeout` | таймаут **одной** команды, **в секундах**, 1..600 (по умолчанию 120) |

**Группа прав — `shell`** (та же, что у `execute_shell`): правило `permission.rules.shell`,
ask/deny пользователя и режимы работают как обычно; отдельного правила для песочницы нет.
В **plan-режиме тул блокируется целиком** (`isPlanBlockedTool`): план ничего не исполняет, а у
`sandbox_exec` нет read-only-эвристики `execute_shell`. `cwd` входит в файловые параметры тула
(`TOOL_PATH_PARAMS.sandbox_exec = ['cwd']`), поэтому `external_directory`/`protected_paths`
применяются к нему как к `execute_shell`.

**Чем отличается от `execute_shell`:**

- **другой профиль/образ и отдельный пул** — ключ пула включает класс `sandbox`, поэтому команда
  не попадает в пул обычных команд области (и наоборот);
- **нет shell-guard/protected-paths** — это проверки `execute_shell` против **локальной** файловой
  системы control plane; здесь команда уходит в другой образ/пул, и локальный анализ ничего не
  доказывал бы. Периметр `cwd` проверяется **лексически** (внутри рабочего каталога сессии или
  корня проекта), реальный containment делает исполнитель пула;
- **только синхронный запуск**: ни `background`, ни detach-перевод в фон, ни секретов SSH-агента
  (`ssh.mode='agent'`) у тула нет;
- **нет роутера — нет тула**: без `execution.mode=remote` с провайдером пулов тул возвращает
  понятный отказ («Sandbox execution is unavailable…»), а не исполняется локально (иначе
  «песочная» команда пошла бы в процессе control plane).

Лимиты — те же, что у порта исполнения: `maxOutputBytes` = `DEFAULT_MAX_OUTPUT_BYTES` (10 МиБ на
команду), таймаут — на команду. Отчёт по каждой команде: заголовок `[sandbox:<profile>] $ <cmd>`,
stdout, при наличии — `[stderr]`, строка `(exit <code>)`; при ошибке — `Error: <message>` и
`isError: true`. Метаданные: `{profile, commands, cwd, exit_codes}` (коды в порядке выполненных
команд; `-1` — ошибка без кода выхода). Аудит и отдельная проверка песочного профиля — ADR-136
(ещё не реализован).

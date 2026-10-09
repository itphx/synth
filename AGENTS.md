# Synth — архитектурные соглашения

> Здесь только то, что нужно постоянно; подробности — в `docs/`, `docs/arch_decisions/`, `.opencode/skills/`; трогаешь подсистему — сначала таблица «Куда смотреть (триггеры)».

## Язык

Все сообщения, коммиты и документация — **на русском**. Не коммитить без явной просьбы пользователя.

## Инварианты (не нарушать)

1. План — в `project.plan`, todo — в `session.todos`; состояние менять только инструментами `plan_*`/`todo_*`, не файлами (AD-039).
2. Хранилище — только через `FileStore` (JSON + атомарная запись tmp→rename); писать в `$SYNTH_DATA_DIR` в обход API/FileStore нельзя (AD-005). Исключение: фикс бага самого хранилища / миграция схемы.
3. Любой LLM-вызов — через `GatewayProvider` (guard, обфускация, rate limit, аудит); провайдера напрямую не дёргать (AD-036).
4. Движки stateless: история и состояние — на бэкенде; движок получает историю + новое сообщение + контекст (AD-022).
5. Permissions и режимы — только через permission-слой (`plan`/`act`/`yolo`, `allow`/`deny`/`ask`); не хардкодить проверки в тулах (AD-025/AD-028/AD-029).
6. Транспорт UI — EventHub + TransportClient (`/ws/events`) с фоллбеком на SSE; новых каналов не плодить (AD-008/AD-009/AD-024).
7. Гибрид: id удалённых сущностей — `remote:<uuid>`, маршрутизация по полю `origin`; id не смешивать (AD-042).
8. Проект — контейнер (сессии, файлы, контекст); `projectId` опционален — сессия может жить без проекта (AD-014/AD-040).
9. Ошибки LLM — через `classifyLlmError`/`isLlmErrorRecoverable`; строки движка — через ключи `shared/i18n` (AD-041).
10. Конфиг — приоритет CLI-флаги > `SYNTH_*` env > config.yaml > defaults; читать только через `@itphx/synth-shared/config` (AD-023).
11. Состояние агента передаётся через Tool Use, а не JSON-блоком в ответе модели (AD-039).
12. Прототип `~/dev/aic/t11` — **read-only**: сначала смотрим, как сделано там; решения конечного продукта могут отличаться.
13. Коммит — только по явной просьбе пользователя. Новые зависимости/инструменты — только с разрешения.
14. Секреты (токены, ключи, пароли) — не коммитить; секреты живут в `secrets/` вне git-репозитория `synth/`.
15. AGENTS.md (корневой и пакетные) держать в актуальном состоянии: изменил поведение пакета/процесс/окружение — обнови соответствующий файл; правки инструкций согласовывать с пользователем; процедура — скилл `synth-agents-md`.
16. Создание сессии — только через единый funnel `RequestSessionService` → `EventRouter` (явный запрос — `direct`, внешнее событие — через Router); `SessionManager.createSession` — materialization-примитив (fork/import/материализация события), для прямых запросов его не вызывать (AD-089).

## Прототип

`~/dev/aic/t11` (t11). Код **не менять** — только читать. Локально: бэкенд `:5100`, UI `:5101`, ключ аутентификации `your-secret-api-key`. При новой функциональности сначала исследовать, как это сделано в прототипе; решения конечного продукта могут отличаться.

## Карта репозитория

Монорепозиторий `synth/` (pnpm workspaces), единый стек TypeScript. Подробности по пакету — в `packages/<pkg>/AGENTS.md` (есть у `core`, `backend`, `ui`, `shared`; у тонких `runner` и `synth` — нет).

```text
synth/
├── packages/
│   ├── shared/    @itphx/synth-shared   # Типы, Zod-схемы, протоколы, конфигурация
│   ├── core/      @itphx/synth-core     # Ядро: сессии, очередь, LLM, MCP, FileStore, API v2 (Hono), CLI
│   ├── backend/   @itphx/synth-backend  # Hono API Hub: OIDC, RBAC, Runner Registry, LLM Proxy
│   ├── ui/        @itphx/synth-ui       # React 19 SPA + админка (Vite)
│   ├── runner/    @itphx/synth-runner   # Gateway: адаптеры opencode/cline, LLM Proxy (in-process из core)
│   └── synth/     @itphx/synth          # Публикуемая CLI-обёртка (bin: synth)
├── pnpm-workspace.yaml   tsconfig.base.json   eslint.config.js   .prettierrc
docs/                  # Документация (см. «Документация»)
docs/arch_decisions/   # AD (см. индекс)
.opencode/skills/      # Скиллы (synth-dev, synth-release, synth-hybrid, ...)
tmp/                   # Временные файлы. Использовать его, а не /tmp в корне ФС. Не коммитится
```

Все 6 пакетов публикуются в npm; `@itphx/synth` — тонкая CLI-обёртка над core/ui/shared: не бандлит core в `cli.js` (external) и не копирует ассеты — всё резолвится из npm-зависимостей (AD-038).

### Слои зависимостей

```text
@itphx/synth-shared  ←  контракты + межупаковочная инфраструктура, без бизнес-логики
       ↑
@itphx/synth-core    ←  импортирует shared, содержит всю общую логику
       ↑
┌──────┴──────┐
@itphx/synth-backend │ @itphx/synth-ui     ←  импортируют core
@itphx/synth-runner (in-process)     ←  опционально импортируется в core
       ↑
@itphx/synth   ←  тонкая CLI-обёртка: core + ui + shared (npm-потребители)
```

**Переиспользуемые роуты.** Общая логика HTTP-роутов живёт в core-фабриках (`createSettingsRoutes`, `createDictionaryRoutes`, `createProviderRoutes`, `createModelRoutes`, `createSessionRoutes`, `createProjectRoutes`, `createFsRoutes`, `createMessageRoutes`, `createQueueRoutes`, `createAgentRoutes`, `createMcpRoutes`); backend монтирует их и добавляет только RBAC/rate-limit/специфику через `opts` (guard'ы, `messages` для i18n, хуки). Дублировать хендлеры в backend нельзя.

## Команды

Из корня `synth/`:

```bash
./scripts/dev.sh                    # backend (:5000) + UI (:5002)
./scripts/dev.sh backend | ui | core | all
./scripts/standalone.sh             # standalone из собранных npm-пакетов (см. DEVELOPMENT.md)

pnpm install                # установка зависимостей
pnpm build                  # сборка всех пакетов
pnpm typecheck              # проверка типов
pnpm lint                   # ESLint
pnpm test                   # Vitest
pnpm clean                  # очистка dist/
```

Сборка core копирует `prompts/` и `definitions/*.json` в `dist/` — это **fallback для Docker**; источник истины промптов — `packages/core/prompts` (публикуется в npm через `files`), дубликатов ассетов нет (AD-038). Логи dev-запуска: `tmp/backend.log`, `tmp/ui.log`, `tmp/core.log`.

## Порты

| Сервис | Порт | Env var |
|--------|------|---------|
| synth-backend | 5000 | `SYNTH_PORT` |
| synth-ui | 5002 | `VITE_PORT` |
| synth-core | 4300 | `SYNTH_CORE_PORT` |
| synth-runner | 5200 | `SYNTH_RUNNER_PORT` |
| LLM Proxy (runner) | 9090 | — |
| opencode (движок) | 4100 | — |
| cline (движок) | 4200 | — |

## Окружение

### Запуск

`./scripts/dev.sh [backend|ui|core|all]` из `synth/` (или `./synth/scripts/dev.sh` из корня проекта). Скрипт ставит: `SYNTH_AUTH_DEBUG=true` (debug-аутентификация), `SYNTH_DATA_DIR` (по умолчанию `<repo>/../data`; переопределяется env), `SYNTH_PORT`/`SYNTH_CORE_PORT`/`VITE_PORT`, а также `SYNTH_CONFIG=packages/backend/config.yaml` (только если файл существует) — поэтому `mcp.servers` из backend-конфига подхватываются в dev; `loadConfig` учитывает `SYNTH_CONFIG` (AD-023). Подробности — [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md).

### Данные

Runtime-данные (сессии, проекты, провайдеры, модели) — в `$SYNTH_DATA_DIR` (env `SYNTH_DATA_DIR` или `storage.dataDir` в config.yaml; дефолт `/var/synth/data`). Провайдеры — JSON в `$SYNTH_DATA_DIR/providers/`, модели — в `$SYNTH_DATA_DIR/models/`; добавить провайдера/модель = создать JSON-файл (или через API). Атомарная запись: `.tmp.{uuid}` → `rename()`. Основные dev-провайдеры (`itphx`, `ollama`) — в [docs/LLM_PROVIDERS.md](./docs/LLM_PROVIDERS.md).

```text
$SYNTH_DATA_DIR/ → sessions/ projects/ providers/ models/ agents/ context/ auth/(sessions,states,profiles) secrets/(master.key, api-key, ssh-keys/)
```

**Локальный home** (`--home <dir>` / env `SYNTH_HOME`, AD-079) — базовый каталог локального инстанса с плоской раскладкой `<home>/{config.yaml, data/, profiles.json, credentials.json}`. Приоритет путей: явные флаги (`--data-dir`/`--config`/`--profiles`/`--credentials`) > `--home` > `SYNTH_HOME` > XDG-дефолты (`~/.config/synth`, `~/.local/share/synth`). Без home поведение прежнее; разные home → независимые инстансы (standalone и hybrid одновременно) и герметичный тестовый запуск.

**Ротация мастер-ключа** секретов at-rest (SSH-ключи агентов, AD-076): `synth secrets rotate` (`--data-dir`, `--config`, `--old-key`/`--old-key-file`, `--new-key`/`--new-key-file`, `--dry-run`, `--yes`). Без `--yes` (и без `--dry-run`) — отказ; при ключе из env/`config.security.secretKey` его нужно обновить и там (файл игнорируется при старте).

### Аутентификация

Все API (кроме `GET /health`) требуют аутентификации, иначе 401. Роли: `ADMIN`, `USER`, `LEAD`, `AUDITOR`; middleware `requireAuth`, `requirePermission` (первый в цепочке после CORS/logging).

| Режим | Где | Когда | Механизм |
|-------|-----|-------|----------|
| Debug | backend | `SYNTH_AUTH_DEBUG=true` | тестовые ключи (ниже) |
| API Key | backend | прод без OIDC | `SYNTH_API_KEY` → ADMIN |
| OIDC | backend | прод с Keycloak | JWT + cookie `user_session` |
| Local | core | `synth serve` (`--api-key`/`SYNTH_API_KEY`/`core.apiKey`; иначе авто-ключ в `{dataDir}/secrets/api-key`; host `127.0.0.1`) | один ключ → ADMIN (в гибриде — роли с сервера) |

### Тестовые пользователи (debug)

Базовый URL: `http://localhost:5000/api/v2`, заголовок `Authorization: Bearer <ключ>`.

| Пользователь | Ключ | Роли |
|-------------|------|------|
| admin | admin-key-123 | ADMIN |
| developer | user-key-456 | USER |
| lead | lead-key-789 | LEAD |
| auditor | auditor-key-012 | AUDITOR |

### Runtime-настройки (API)

| Метод/путь | Назначение |
|---|---|
| `PATCH /api/v2/sessions/:id` `{ mode }` | Режим сессии: `plan` / `act` / `yolo` |
| `GET/PUT /api/v2/settings/workspace` | Рабочий каталог по умолчанию (runtime override, `settings.json`) |
| `GET/PUT/DELETE /api/v2/settings/workspace-policy` | Политика абсолютного workspace вне `workspacesRoot` (`confirm`/`deny`; managed — read-only `deny`) |
| `GET/PUT /api/v2/settings/mcp` | Доступность MCP-инструментов по режимам (plan/act) |
| `GET/PUT/DELETE /api/v2/settings/skills` | Instance-wide скиллы: мастер-отключение (`disabled`) и дефолт новых проектов (`disabledForNewProjects`), `policy` |
| `GET/PUT /api/v2/settings/tools-policy` | Политика встроенных инструментов (`consistency`/`available`/`auto`) |
| `GET/PUT /api/v2/settings/mcp-policy` | Политика MCP-инструментов (`consistency`/`available`/`auto`) |
| `GET/PUT /api/v2/settings/tools-disabled` | Instance-wide отключение встроенных инструментов (группы/тулы; `runtime` неотключаем) |
| `GET/PUT/DELETE /api/v2/settings/default-agent` | Агент по умолчанию для новых сессий (fallback `assistant`; UI — раздел «Агенты») |
| `GET/PUT /api/v2/mcp/registry` | Реестр MCP-серверов (`enabled` — мастер-флаг, `enabledByDefault` — дефолт новых проектов; stdio — только ADMIN) |
| `GET/PUT /api/v2/projects/:id/{mcp,skills}` и `GET/PUT /api/v2/sessions/:id/{mcp,skills}` | Уровни/скоуп MCP и скиллов (`enabled` — hard-gate, `defaultOn` — дефолт новых сессий; в сессии — снапшот) |
| `POST /api/v2/mcp/probe` | Проверка MCP-сервера без регистрации инструментов |
| `POST /api/v2/events` | Приём внешнего события (ingest: `requireAuth` либо API-ключ привязки `Authorization: Bearer synth_evt_…` без пользовательских кред; rate limit) |
| `GET/POST/DELETE /api/v2/events/bindings` | Биндинги событий источник→сессия (чтение — `requireAuth`, мутации — LEAD/ADMIN) |
| `GET/POST /api/v2/events/bindings/:id/keys`, `DELETE /api/v2/events/bindings/:id/keys/:keyId` | API-ключи привязки (чтение/создание/удаление — LEAD/ADMIN; секрет отдаётся один раз, at-rest — sha256-хеш) |
| `GET/POST /api/v2/events/routes`, `DELETE /api/v2/events/routes/:id` | Правила маршрутизации событий (`match` → `target`; чтение — `requireAuth`, мутации — LEAD/ADMIN) |
| `GET /api/v2/events/journal` | Журнал решений Router (последние записи, `limit`; использование ключа — с `keyId`) |
| `GET/POST/DELETE /api/v2/schedules`, `POST /api/v2/schedules/:id/run`, `GET /api/v2/schedules/:id/jobs` | Расписания-источник `cron` (AD-051): CRUD + force-запуск + Job-история (чтение — `requireAuth`, мутации/`run` — ADMIN; `run` под rate limit) |

## Процесс разработки

### Стадии

Переход — только после критерия и явной команды пользователя (или молчаливого согласия).

1. **Investigate** — прочитать затронутые файлы, найти паттерны, при необходимости сверить прототип, задать вопросы. Не править код, не запускать сервер. *Критерий:* сформулированы файлы под правку и почему.
2. **Plan** — атомарный todo-список, оценка влияния на другие части, подтверждение пользователя. *Критерий:* пользователь подтвердил план (или сказал «приступай»).
3. **Implement** — строго по плану, минимальными правками, в код-стиле проекта. *Критерий:* `pnpm build` из `synth/` без ошибок.
4. **Verify** — по порядку: `pnpm typecheck` → `pnpm lint` → `pnpm test`; затем `./scripts/dev.sh backend` + curl затронутых эндпоинтов; затем `./scripts/dev.sh` (backend+UI) и визуальная проверка UI в браузере. Не ставить новые инструменты, не писать сложные bash-скрипты, не гонять LLM без просьбы, не писать в JSON-хранилище вручную (провайдер/модель — через API, сообщение — `POST /sessions/:id/prompt`). *Критерий:* typecheck+lint+test зелёные, эндпоинты отвечают ожидаемым кодом/форматом.
5. **Document** — обновить затронутые `AGENTS.md` (корневой и пакетные), если изменилось окружение/процессы/поведение пакета; неочевидные решения зафиксировать в задаче; правки инструкций согласовать с пользователем (скилл `synth-agents-md`). *Критерий:* готово к следующей сессии.

### Роутинг задач по агентам

| Тип задачи | Агент | Пример промпта |
|---|---|---|
| **Bug fix** | `@fixer` | «Почини баг: при логине с неверным паролем падает 500 вместо 401» |
| **Тестирование / QA** | `@tester` | «Проверь что модуль auth не сломан после изменений», «Прогони smoke-сценарии через Playwright» |
| **Исследование / консультация** | `@researcher` | «Как устроена авторизация?», «Найди все места где используется Redis» |

Агенты уже настроены — не дублируй их инструкции, просто передавай задачу.

### Типичные ошибки

1. Кодить без исследования — приводит к переделкам.
2. Автоматизация ради автоматизации — скрипт на 100 строк вместо 3 строк curl и визуальной проверки.
3. Ставить зависимости для тестирования — всё настроено; чего не хватает — сказать пользователю.
4. Запускать сервер вне `dev.sh` — порты и env уже настроены, свой способ не изобретать.
5. Писать в JSON-хранилище вручную — только через API (исключения: баг самого хранилища, миграция схемы).
6. Смешивать стадии — нельзя одновременно исследовать, кодить и тестировать.

### Тех. долг

Известные архитектурные долги — не блокируют работу, закрываются отдельными задачами. Запись ведётся здесь; при закрытии пункт удаляется; детали задач и закрытые пункты — `.opencode/tasks/log.md`.

Актуальных задокументированных долгов нет.

### Unit-тесты

Vitest:

```bash
cd synth && pnpm test
cd synth/packages/core && pnpm test -- --run src/engine/tools/task.test.ts
```

## Соглашения по коду

### Именование (TypeScript, strict)

| Элемент | Стиль | Пример |
|---------|-------|--------|
| Файлы | `kebab-case.ts` | `session-manager.ts` |
| Классы/Интерфейсы/Типы | `PascalCase` | `SessionManager`, `interface SessionStore` |
| Функции | `camelCase` | `getSession()` |
| Константы | `UPPER_SNAKE_CASE` | `MAX_RETRIES = 3` |
| Приватные методы | `_camelCase` | `_internalMethod()` |
| API маршруты | `kebab-case` | `/api/v2/sessions` |

### Порядок импортов

```typescript
// 1. Node.js builtins
import { readFile } from 'node:fs/promises';

// 2. Внешние библиотеки
import { Hono } from 'hono';

// 3. @itphx/synth-shared
import { type Session } from '@itphx/synth-shared';

// 4. Локальные модули
import { SessionStorage } from '../storage/sessions.js';
```

### Коммиты

```bash
git commit -m "feat: добавлен эндпоинт для списка провайдеров"
git commit -m "fix: исправлена обработка пустых сессий"
git commit -m "refactor: упрощён ChatOrchestrator"
git commit -m "docs: обновлён AGENTS.md"
git commit -m "test: добавлены тесты для SessionStore"
```

## Рабочий каталог и инструменты

Рабочий каталог для file/shell/git-тулов по умолчанию:

```text
env SYNTH_DEFAULT_WORKSPACE > config storage.defaultWorkspace > {DATA}/workspaces/default
```

- Runtime override: `PUT /api/v2/settings/workspace` → `{dataDir}/settings.json` (атомарно, переживает рестарт).
- Резолвинг `_resolveWorkingDir`: `project.workspace` → defaultWorkingDir; каталог проектного workspace создаётся автоматически (`mkdir -p`).
- Каталог `project.workspace` (AD-075): managed — авто-имя `slugify(name)`+суффикс под `workspacesRoot`, смена workspace — владелец/LEAD/ADMIN; standalone — нормализация/создание + ручной выбор через FS-диалог. Путь вне `workspacesRoot` — по политике `storage.workspaceOutsideRoot` / `/api/v2/settings/workspace-policy` (`confirm` в standalone, `deny` в managed — read-only).
- Тулы `plan_enter`, `plan_exit`, `get_project_info`, `list_repos` жёстко привязаны к `project.workspace`/сессии — path-параметры не принимают.
- Тулы `project_update`/`project_workspace_set`/`project_repo_clone|init|add|fetch|remove` работают с проектом сессии (подставить id/path другого проекта агент не может); смена workspace идёт через общий provisioning (`engine/workspace-provision.ts`) с политикой `workspaceOutsideRoot` — той же, что у HTTP-роута.
- Гейт `workspace` (AD-075): file/shell/git-тулы доступны только при заданном `project.workspace`; иначе остаются в промпте, но permission-слой отклоняет их с причиной `workspace` (`engine/permission/availability.ts`, `isWorkspaceDependentTool`), а модели уходит схлопнутая подсказка. Относительные пути — только внутри `project.workspace`. После `project_create`/`project_attach`/`project_workspace_set` оркестратор перечитывает готовность workspace в том же ходе и разблокирует тулы.
- Git-тулы (AD-076) принимают необязательный `repo_path` — относительный путь внутри `project.workspace` (containment; абсолютный/`..` → `git.repo_path_invalid`); `list_repos` отдаёт записи реестра `project.repos` (`destination`/`name`/`url`/`type`/`sshKeyId`/`lastFetch` + git-детект). SSH-ключи per-agent хранятся зашифрованными (`secrets/ssh-keys/`), мастер-ключ — `SYNTH_SECRET_KEY`/`security.secretKey`/`secrets/master.key`.

| Группа | Тулы |
|---|---|
| Файлы (чтение) | `read_file`, `list_directory`, `glob` |
| Файлы (запись) | `write_file`, `edit_file`, `create_directory`, `delete_file` |
| Поиск | `grep_files`, `glob` |
| Shell | `execute_shell` |
| Git | `git_status`, `git_diff`, `git_log`, `git_commit`, `git_push`, `git_pull`, `git_checkout`, `git_branch_list`, `git_show`, `git_blame`, `git_stash` |
| План/ToDo | `plan_enter`, `plan_exit`, `plan_read`, `plan_list`, `plan_write`, `todo_write`, `todo_list`, `todo_add`, `todo_update`, `todo_delete` |
| Проект | `get_project_info`, `list_repos`, `project_create`, `project_attach`, `project_update`, `project_workspace_set`, `project_repo_clone`, `project_repo_init`, `project_repo_add`, `project_repo_fetch`, `project_repo_remove` |
| Лог/Инварианты | `project_log_write`, `project_log_read`, `project_invariants_read`, `project_invariants_write` |
| Веб | `web_fetch`, `web_search` (DuckDuckGo, при anti-bot — fallback на Bing) |
| Задачи | `task`, `classify_conversation`, `read_session_reference` |
| Профиль | `profile_update` (capability `user` — выдан только Агенту `assistant`; онбординг владельца сессии: `display_name`/`email`/`phone`/`notes`, завершение интервью — `ProfileData.interviewCompleted`) |
| Скиллы | `skill` (AD-046: загрузка тела `SKILL.md` по имени + supporting-файлы; глобально отключается через `tools.disabled`) |

Доступность групп — в `ToolCapability` (`@itphx/synth-shared`); группа `user` (тул `profile_update`, только Агент `assistant`) отключаемая — админ может снять её через `tools.disabled`; MCP-тулы регистрируются как `{serverName}_{toolName}`, подчиняются режимам (AD-029) и выбираются **per-session** — в промпт идут только тулы активных серверов сессии. Слои разделены: `tools` — встроенные, `mcp.tools`/`mcp.servers`/`mcp.status` — MCP (всегда `volatile`) (AD-071).

**Онбординг-интервью.** Блок `[INTERVIEW]` (`prompts/system/INTERVIEW.{lang}.md`) включается только в **первое сообщение сессии от пользователя** и при **незаполненном** профиле: флаг `interviewEligible` вычисляет оркестратор (`_interviewEligible` — первое «разговорное» сообщение, не `Scheduler`/системное, **и** `profile_update` доступен текущему агенту — capability `user` и тул не отключён админом; иначе fail-closed), `ContextBuilder` дополнительно проверяет `ProfileData.interviewCompleted`; `session.settings.showInterview` — мастер-выключатель. Агент проводит интервью и сохраняет ответы тулом `profile_update`. Статус — отдельное поле `ProfileData.interviewCompleted` (legacy-метка `[ИНТЕРВЬЮ]` в `notes` бэкфиллится в `FileProfileStore` при чтении).

## Внешние события и хуки

- **Хуки (AD-030).** `HookBus` (`engine/hooks/hook-bus.ts`) — ядровый in-process примитив, отдельный от session-`EventBus`: `on/off/emit/emitAsync`, priority, `sync` (pre, blockable/patch) и `async` (post, fire-and-forget + timeout 5s), флаг `builtin`. Эмиты жизненного цикла: `pre_tool_use` (sync, блокирует исполнение), `post_tool_use` (только для реально исполненных), `plan_approved`, `permission_denied`, `agent_spawned/completed/failed`, `session_start`/`session_end` (в т.ч. `session_end` при архивации).
- **Внешние события (AD-089).** `engine/events/`: `EventRouter` (порядок `allowedSources` → dedup → явный `EventBinding` → `RouteRuleProvider` → фоллбек по `events.defaultMode`: `bound` → `drop no_route`, `ephemeral` → временная сессия; решения журналируются), `RequestSessionService` (единый funnel создания сессии; explicit → `direct` + hook `session_requested`, внешнее → hook `external_event` → Router; резолвинг `agentTemplate` через `AgentRegistry`, политика `unknownAgentTemplate` `drop`/`default-agent`), `EventIngress` (ingest/нормализация), `RouteRuleProvider` (seam; `ProjectRuleProvider` — правила `match` → `target`), `EventDelivery` (`run`/`defer`). Хранилища: `EventBindingStore` (`{dataDir}/events/bindings.json`), `EventJournalStore` (`{dataDir}/events/journal.jsonl`), `RouteRuleStore` (`{dataDir}/events/routes.json`), `EventApiKeyStore` (`{dataDir}/events/api-keys.json`).
- **API-ключи привязок (AD-089/AD-052, первый срез).** Несколько ключей на `EventBinding`; секрет `synth_evt_<base64url>` хранится только как sha256-хеш, plaintext отдаётся один раз при создании, в списке — `prefix`; каскад при удалении привязки; задел AD-052 — `expiresAt`/`revokedAt`, `revoke()`, `EventKeyCredential` (`keyId`/`bindingId`, задел `scopes`/`principalId`). `POST /api/v2/events` с `Authorization: Bearer <binding-key>` аутентифицирует без пользовательских кред (source/чат из привязки), использование пишется в журнал (`keyId`/`principalId`). Разделение моделей: **binding-key** (жёстко привязан к source/чату привязки) vs **service-key** (общий ключ инстанса/тенанта со scope — AD-086/AD-052, нет). Ключи — **инстанс-локальные** (не переносятся publish/fork, AD-081). RBAC (managed): мутации bindings/routes/keys — `requirePermission('ADMIN','LEAD')`, чтение ключей — LEAD/ADMIN; раздел «События» — в **пользовательской части** (просмотр всем ролям, создание — LEAD/ADMIN), журнал **дублируется** в «Логи и аудит».
- **Единый funnel.** Создание сессии — только через `RequestSessionService` (инвариант 16); внешние события входят только через Router; `forkSession`/backend `/import`/`remote/transfer.ts`/`chat.ts` — materialization, не request.
- **Ephemeral TTL.** `Session.expiresAt`/`archivedAt`; `sessions/ephemeral.ts` (`parseTtl` `30s|15m|24h|7d`, `startEphemeralSweeper`, sweep 60 c, unref); `listSessions`/`listActiveSessions` по умолчанию исключают архив.
- **Источник cron (AD-051, минимальный срез).** `engine/scheduler/`: `SchedulerService` (тикер `unref`, без catch-up, идемпотентный `dedupKey = cron:<id>:<минута>`, `runNow`), `SchedulerRuleProvider` (cron-событие → `bound`/`queue`/`ephemeral` по `Schedule.target`), `cron.ts` (5 полей, UTC) + `duration.ts`; `ScheduleStore` (`{dataDir}/schedules.json`). Планировщик не создаёт сессии сам — публикует `{source:'cron', type:'schedule_fired'}` через `EventIngress`. Сообщение: `author='Scheduler'`, чистый текст задания, `metadata.scheduler/schedule_name`; в LLM — user-реплика `{Scheduler}: <текст>`; в UI — центрированный `Notice variant="scheduler"` («Планировщик · <имя задания>»). Описание Scheduler — системный блок `scheduler` из `prompts/system/SCHEDULER.{lang}.md`, включается в сессиях с включённым расписанием. На ходу, инициированном планировщиком (`metadata.scheduler === true`), дополнительно идёт **volatile**-блок `scheduler.turn` (`prompts/system/SCHEDULER_TURN.{lang}.md`) — пояснение модели, что текущее сообщение автоматическое и человек в этом ходе не участвует. Job-история (`{dataDir}/scheduler/jobs.jsonl`, retention `scheduler.jobRetentionDays`), catch-up (`catchUp: skip|once`) и force-запуск (`POST /:id/run`, уникальный dedup-ключ) — реализованы; пайплайны (AD-059) и размещение в гибриде — нет. **Мульти-инстанс** (leader election + атомарный dedup-claim + межпроцессная сериализация `ScheduleStore`) — реализованы семы и file-based реализации, default OFF; K8s Lease/PG advisory lock — будущее.
- **Конфиг.** Секция `events` (`enabled`, `defaultMode`, `ephemeralTtl`, `journalRetentionDays`, `allowedSources`, `dedupStore`, `unknownAgentTemplate`), секция `scheduler` (`enabled`, `tickSec`, `catchUp`, `jobRetentionDays`, `leaderElection`, `crossProcessLocks`). **i18n:** `event.*`, `hook.blocked`. **Мульти-инстанс:** семы и file-based реализации (`DedupStore`, `SchedulerLeader`, `FileMutex`) с флагами `events.dedupStore: memory|file`, `scheduler.leaderElection: none|file`, `scheduler.crossProcessLocks` — по умолчанию **OFF** (поведение single-process не меняется; K8s Lease/PG advisory lock — будущее, AD-051).
- **API.** `POST /api/v2/events` (ingest: `requireAuth` либо API-ключ привязки при `Authorization: Bearer synth_evt_…`; rate limit на оба пути), `GET/POST/DELETE /api/v2/events/bindings` (+ `GET/POST /api/v2/events/bindings/:id/keys`, `DELETE /api/v2/events/bindings/:id/keys/:keyId`), `GET/POST /api/v2/events/routes` + `DELETE /api/v2/events/routes/:id`, `GET /api/v2/events/journal` (в core — единый `requireAuth`; managed: чтение bindings/routes/journal — `requireAuth`, мутации bindings/routes/keys и чтение keys — `requirePermission('ADMIN','LEAD')`), `GET/POST/DELETE /api/v2/schedules` + `POST /api/v2/schedules/:id/run` (ADMIN + rate limit) + `GET /api/v2/schedules/:id/jobs` (Job-история); SSE `GET /api/v2/events` сохранён. UI — раздел «События» в пользовательской части (просмотр всем ролям, создание — LEAD/ADMIN; bindings + ключи + журнал; журнал дублируется в «Логи и аудит»), вкладка правой панели «Шедулер» (CRUD, force-запуск, Job-история, рекомендация оптимизации контекста).

## UI-конвенции

Панель «Сессия» в правой панели показывает план (`planContent`) и ToDo (`todos`); обновляется по WS-событиям `plan.approved`/`todos.updated` (полный refresh с сервера).

Мутирующие тулы ядра публикуют `fs.changed` (`engine/fs-change.ts`): UI обновляет дерево Files, открытые редакторы и Git-вкладку с debounce; read-only тулы события не шлют. Файловые события несут `op` (`write`/`delete`/`mkdir`) — дерево перечитывает только родительские каталоги (точная инвалидация `refreshDirs`/`fileRevisions`/`deletedFiles`), редактор переключается в состояние «файл удалён» (`file.deletedOnDisk`). Перенос из shell (`execute_shell` с `mv`/`git mv`) приходит как `op:'move'` с `from`/`to`: транспорт **синхронно до debounce** вызывает `filesStore.remapPath` (перемап дерева, раскрытия, ревизий, пометок и черновиков) и `useUIStore.remapFileTabs`, и только затем `scheduleRefresh` — открытые вкладки переезжают без потери несохранённых правок. Межпроектный перенос файлов/каталогов в UI идёт серверным `/fs/move` с `targetProjectId` (не read/write/delete-хаком). Перенос сессии между проектами (`session.moved`, в т.ч. `project_create`/`project_attach` агентом) обновляет `project_id` в сторе, список проектов и дерево Files.

Вкладки Files/Git левой панели — контекст-ориентированные: закреплённый блок «Текущий проект» (по активному центр-табу — сессия/файл/коммит, хук `useActiveProject`) + сворачиваемые «Другие проекты (N)»; тумблер «Только текущий проект» (`ProjectScopeToggle`, persist `onlyActiveProject`) в шапке тулбара. Подробности — [packages/ui/AGENTS.md](./packages/ui/AGENTS.md).

Перенос/переименование файла или каталога в UI (`filesStore.moveEntry`, включая диалог переноса, same-project DnD и межпроектный DnD через серверный `/fs/move` с `targetProjectId`) перемапливает поддерево: ключи `treesByProject`/`expandedDirs`/`fileRevisions`/`deletedFiles`/`draftContents` переезжают на новый префикс (в кэше листингов `entry.path` переписывается), а открытые вкладки viewer/editor — прозрачно (`useUIStore.remapFileTabs`), сохраняя несохранённые черновики (`draftContents`, runtime-only) при переключении вкладок и переносе между проектами. При ремапе вкладок коллизия id (новый id занят чужой вкладкой) разрешается в пользу перемапленной вкладки — чужая удаляется. Диалог переноса подгружает все каталоги workspace рекурсивно (`maxDepth` 10; fallback — загруженные ветки), закрытие грязной вкладки подтверждается (`file.unsavedChanges`) и очищает её черновик.

### Иконки и цвета проектов и сессий

Канонические ключи — реестры `PROJECT_ICON_KEYS` (37) / `PROJECT_COLOR_KEYS` (16, палитра темы `a1..a16`) в `shared/types` (включая дефолтные `folder`/`chat`/`cpu`); на записи значения валидируются (невалидное → 400 `VALIDATION_ERROR`), при чтении невалидные значения сбрасываются (`normalizeIconKey`/`normalizeColorKey`), `null`/`undefined` — сброс. В UI — общий пикер `EntityIconPicker` (только ключи реестра и палитра CSS-переменных, без загружаемых картинок) и инлайн-вывод `<Icon>` в дереве, табах, шапке и панелях. У закрытых сессий (нет таба и не активны) иконка серая, у открытых — цвет сессии. Подробности — [packages/ui/AGENTS.md](./packages/ui/AGENTS.md).

### Мобильный адаптив + PWA

Единый адаптивный UI, три зоны: **телефон ≤768px / планшет 769–1199px / десктоп ≥1200px** (десктоп не меняется). Детекция `matchMedia` + классы на `<html>`: `device-phone/tablet/desktop`, `pointer-coarse` (хуки `useDevice()`/`useMediaQuery`, `lib/device.ts`); мобильный CSS гейтится этими классами.

- На телефоне/планшете чат на весь экран, левая/правая панели — оверлей-дроверы (`components/layout/MobileDrawer.tsx`) из мобильного хедера, `ResizeHandle` скрыт, нижней навигации нет.
- Touch-first: hover-действия доступны (CSS под `html.pointer-coarse`), таргеты ≥40px, нативный скролл, DnD в деревьях отключён.
- `window.confirm` → `ConfirmDialog`; для zustand — `lib/confirm.ts` + `stores/confirmStore.ts` (рендер в `App`). Модалки/админка на телефоне — скролл-табы на всю ширину.
- Клавиатура: `useKeyboardInset` (visualViewport → `--kb-inset` → `padding-bottom` композера); Enter на таче — перенос строки, на fine-pointer — отправка; IME учтён.
- PWA (ручной app-shell, без vite-plugin-pwa): `public/manifest.webmanifest` (standalone, theme `#09090b`), `public/sw.js` (кэш шела; `/api,/ws,/auth,/admin,/health` не кэшируются, навигация network-first → офлайн-заглушка), иконки в `public/icons/`, меты в `index.html`; `usePwaInstall`/`PwaInstallButton`; регистрация SW только в prod.
- Обновление: баннер `PwaUpdatePrompt` (вне `AuthGate`) — по ожидающему SW или расхождению версии с публичным `GET /api/v2/health`; проверка при монтировании, раз в 30 мин, при возврате в приложение (`visibilitychange`) и на первом действии после простоя >1 ч. SW регистрируется по стабильному `/sw.js` (`updateViaCache: 'none'`), версия в имени кэша подставляется при сборке — браузер сам видит новую версию.
- Раздача: `docker/nginx-ui.conf` и `packages/core/src/server/app.ts` — MIME `.webmanifest` + no-cache для sw/manifest.
- Фикс логина: в гибриде (standalone-core, `/hybrid/status` enabled=true) поле «Сервер» показывается всегда (смена адреса при протухшем токене), предзаполняется lastServer/backendUrl, варианты — knownServers; на managed-бэкенде поле скрыто. Enter в «Логин» → фокус на «Пароль».

Подробности — [AD-044](./docs/arch_decisions/ad-044-mobile-adaptive-ui-pwa.md).

## Среды и деплой

| Среда | Что это | Как разворачивается |
|---|---|---|
| **dev** | локальная отладка | `./scripts/dev.sh` |
| **test** | внутренний тестовый, `https://synth.k3s.itphx.loc` | Fleet (`synth-deploy`), образы собираются локально и пушатся в `git.itphx.ru` |
| **preprod** | `https://synth-release.k3s.itphx.loc`, проверка развёртывания | публикуемый Helm-чарт (GitVerse), релизные образы `gitverse.ru` |
| **prod** | у нас отсутствует — разворачивают клиенты сами | публикуемый Helm-чарт (self-host) |

Правило: текущие изменения — **dev**; проверка перед релизом — **test** (Fleet); релиз — push master → сборка пакетов → **preprod**.

### K3s (test)

Test-инстанс — K3s (Rancher Fleet), namespace `synth`; код деплоя — отдельный репозиторий `synth-deploy/` (`https://git.itphx.ru/itphx/synth-deploy.git`, ветка `main`, подробности — `synth-deploy/README.md`). Адреса: UI `https://synth.k3s.itphx.loc`, Keycloak issuer `https://keycloak.itphx.loc/realms/synth` (клиент `synth`, confidential), backend в кластере `synth-backend:5000`. Доступ: `kubectl` (контекст `local`), `kubectl -n synth get pods`, `kubectl -n synth logs deploy/synth-backend`. Учётные данные Keycloak — [docs/KEYCLOAK.md](./docs/KEYCLOAK.md); секреты (в т.ч. client secret `SYNTH_OIDC_CLIENT_SECRET` в SealedSecret `synth-secrets`) — в `secrets/` вне git-репозитория `synth/`. Скилл — `synth-k3s-deploy`.

### GitVerse CI — особенности

1. **`actions/setup-node@v4`** — не использовать; вместо него `npm install -g pnpm@latest`.
2. **`${{ env.VAR }}`** — не работает, резолвится в Go-строку `%!t(string=...)`; значения хардкодить.
3. **`${...}` в inline bash** — GitVerse парсит как Go-шаблон, скрипт падает; сложный bash выносить в отдельный файл (см. `scripts/changelog.sh`).
4. **`${GITHUB_REF_NAME}`** — синтаксис GitHub; в GitVerse: `echo "${{ gitverse.ref }}" | sed 's|refs/tags/v||'`.
5. Версия Node.js в раннере — 22 (предустановлена).
6. **Префикс `GITVERSE_` запрещён** в именах секретов; использовать `GV_`.

Порядок сборки в CI: `pnpm install --frozen-lockfile` → `pnpm --filter @itphx/synth-shared build` (обязательно перед typecheck) → `pnpm --filter @itphx/synth-core build` (нужно backend и runner) → `pnpm typecheck` → `pnpm lint` → `pnpm test`. Без сборки shared/core typecheck не найдёт типы.

Workflow-файлы `.gitverse/workflows/{ci,release}.yaml`; секреты `NPM_TOKEN` (npmjs.org) и `GV_TOKEN` (единый GitVerse: API, Docker/npm registry, git push). Локальная проверка перед пушем: `pnpm typecheck && pnpm lint && pnpm test`. Публикация (npm в 6 пакетов, Docker/Helm, релиз, токены npm 2026, `scripts/build.sh`/`publish.sh`/`version-bump.sh`) — [docs/PUBLISHING.md](./docs/PUBLISHING.md) и скиллы `synth-build-publish`, `synth-release`.

## Индекс архитектурных решений

| AD | Суть | Статус | Файл |
|----|------|--------|------|
| AD-005 | JSON-файлы как хранилище (атомарная запись tmp + rename) | ✅ Реализовано | [ad-005](./docs/arch_decisions/ad-005-json-storage.md) |
| AD-008 | WebSocket для real-time событий | ✅ Реализовано | [ad-008](./docs/arch_decisions/ad-008-websocket-events.md) |
| AD-009 | SessionEventBus — шина событий сессии | ✅ Реализовано | [ad-009](./docs/arch_decisions/ad-009-session-event-bus.md) |
| AD-014 | Проект как контейнер (сессии, файлы, контекст) | ✅ Реализовано | [ad-014](./docs/arch_decisions/ad-014-project-container.md) |
| AD-017 | Собственный API-контракт (API v2 на Hono) | ✅ Реализовано | [ad-017](./docs/arch_decisions/ad-017-api-v2-hono.md) |
| AD-018 | Выбор AI-движка на уровне сессии | ⚠️ Частично (поле/плумбинг; адаптеры движков не реализованы) | [ad-018](./docs/arch_decisions/ad-018-session-engine-selection.md) |
| AD-019 | React 19 SPA с нуля | ✅ Реализовано | [ad-019](./docs/arch_decisions/ad-019-react-spa.md) |
| AD-022 | Единый TypeScript стек + Runner-архитектура (мост к движкам: локальный/облачный K8s pod; движки stateless) | ✅ Реализовано | [ad-022](./docs/arch_decisions/ad-022-typescript-stack-runner.md) |
| AD-023 | Единая система конфигурации (`@itphx/synth-shared/config`) | ✅ Реализовано | [ad-023](./docs/arch_decisions/ad-023-configuration.md) |
| AD-024 | Единый транспорт: EventHub (backend) + TransportClient (UI) | ✅ Реализовано | [ad-024](./docs/arch_decisions/ad-024-eventhub-transport.md) |
| AD-025 | Plan/Act как глобальный permission toggle (не отдельные агенты) | ✅ Реализовано | [ad-025](./docs/arch_decisions/ad-025-plan-act-toggle.md) |
| AD-026 | Режимы контекста саб-агента: none / inherit / summary / last_n | ✅ Реализовано | [ad-026](./docs/arch_decisions/ad-026-subagent-context-modes.md) |
| AD-028 | Строгость цикла Plan→Build: auto / strict / off | ✅ Реализовано | [ad-028](./docs/arch_decisions/ad-028-plan-build-strictness.md) |
| AD-029 | Гранулярные permissions: allow/deny/ask per tool + file patterns | ✅ Реализовано | [ad-029](./docs/arch_decisions/ad-029-granular-permissions.md) |
| AD-030 | Hooks для событий агента (pre/post tool use, session, plan, spawn); закреплён фундаментом для внешних событий (AD-089) и интеграций (AD-051/052/086/087) | ⚠️ Частично (hook-шина + эмиты жизненного цикла; Plugin SDK/загрузка плагинов — нет) | [ad-030](./docs/arch_decisions/ad-030-hooks-agent-events.md) |
| AD-031 | Verification синт (аналог VerificationAgent из Claude Code) | ⏳ Не реализовано | [ad-031](./docs/arch_decisions/ad-031-verification-agent.md) |
| AD-032 | Миграция хранения истории на PostgreSQL (логическая модель уже в JSON — AD-005/AD-033) | ⏳ Не реализовано | [ad-032](./docs/arch_decisions/ad-032-history-storage-postgresql.md) |
| AD-033 | Ветвление сессий, наследование контекста и межсессионное слияние | ✅ Реализовано | [ad-033](./docs/arch_decisions/ad-033-session-branching-merge.md) |
| AD-034 | Routing между моделями (content + confidence + cost) | ✅ Реализовано | [ad-034](./docs/arch_decisions/ad-034-model-routing.md) |
| AD-035 | Micro-model first: дешёвый слой перед LLM (правила/embedding) | ✅ Реализовано | [ad-035](./docs/arch_decisions/ad-035-micro-model-first.md) |
| AD-036 | LLM Gateway: независимый слой безопасности (guard + обфускация + rate limit + аудит) | ✅ Реализовано | [ad-036](./docs/arch_decisions/ad-036-llm-gateway.md) |
| AD-037 | Security step перед коммитом: git pre-commit hook + маркер-хеш | ⏳ Не реализовано | [ad-037](./docs/arch_decisions/ad-037-commit-security-step.md) |
| AD-038 | Монорепо как набор публикуемых npm-пакетов (6 пакетов, pnpm publish, тонкая CLI-обёртка) | ✅ Реализовано | [ad-038](./docs/arch_decisions/ad-038-npm-packages.md) |
| AD-039 | План — в проекте, todo — в сессии; состояние — через инструменты (Tool Use, без JSON-блока), замена TSM | ✅ Реализовано | [ad-039](./docs/arch_decisions/ad-039-plan-in-project.md) |
| AD-040 | Сессии без проекта: контекст, подсказка, перенос между проектами | ✅ Реализовано | [ad-040](./docs/arch_decisions/ad-040-sessions-without-project.md) |
| AD-041 | Таксономия ошибок LLM + контракт локализации строк движка (`shared/i18n`) | ✅ Реализовано | [ad-041](./docs/arch_decisions/ad-041-llm-error-taxonomy.md) |
| AD-042 | Гибридный режим: локальный core + сервер (агрегация миров, LLM Proxy, RemoteEventBridge, publish/fork) | ✅ Реализовано | [ad-042](./docs/arch_decisions/ad-042-hybrid-mode.md) |
| AD-043 | Единая идентичность гибрида: вход в UI без Keycloak (runtime, ROPC, дискавери oidc-meta) | ✅ Реализовано | [ad-043](./docs/arch_decisions/ad-043-unified-identity-login.md) |
| AD-044 | Адаптивный мобильный UI + PWA (три зоны, дроверы, touch-first, ручной app-shell) | ✅ Реализовано | [ad-044](./docs/arch_decisions/ad-044-mobile-adaptive-ui-pwa.md) |
| AD-045 | Профили серверов и лёгкий runtime-вход в гибриде (единый dataDir, profiles.json, logout = забыть токен + revoke, ConnectionWatcher) | ✅ Реализовано | [ad-045](./docs/arch_decisions/ad-045-hybrid-server-profiles.md) |
| AD-046 | Скиллы и slash-команды: формат SKILL.md, discovery, progressive disclosure, core-тул skill, команды/bundles, scope-API, UI (настройки/панели/статистика/`/`-автокомплит) | ✅ Фаза 1; ✅ Фаза 2 (core+API+CLI, UI); ✅ Фаза 3 (trust-гейт команд, inline shell, `skills.urls` read-only, внешние каталоги, builtin `skill-creator`); ⏳ остаток — backend-админка каталога (AD-068) | [ad-046](./docs/arch_decisions/ad-046-skills-and-slash-commands.md) |
| AD-047 | Память Synth (Gbrain + композиция): storage backbone, RAG по памяти и коду/докам, компрессия tool output, 4-layer retrieval, Obsidian bridge | ⏳ Не реализовано | [ad-047](./docs/arch_decisions/ad-047-memory-gbrain.md) |
| AD-048 | Self-help скиллы и admin-MCP: dogfooding-развёртывание, runbook-скиллы, read-only status-MCP, deploy-тулы, гейтинг ADMIN | ⏳ Не реализовано | [ad-048](./docs/arch_decisions/ad-048-self-help-skills-admin-mcp.md) |
| AD-049 | Git worktrees: тулы `git_worktree_*`, per-session cwd на базе worktree, детект secondary worktree, UI | ⏳ Не реализовано | [ad-049](./docs/arch_decisions/ad-049-git-worktrees.md) |
| AD-050 | Внешние движки (opencode/cline) — Runner: EngineManager, адаптеры, WS-канал backend↔runner, LLM Proxy :9090, маршрутизация по `Session.engine` | ⏳ Не реализовано | [ad-050](./docs/arch_decisions/ad-050-external-engines-runner.md) |
| AD-051 | Шедулер и пайплайны (облегчённый n8n): `SchedulerService`, cron/interval-источник `schedule_fired` через Router (AD-089), API/UI расписаний; Job-история, catch-up, force-run — да; пайплайны (AD-059) и гибрид-размещение — нет | ⚠️ Частично | [ad-051](./docs/arch_decisions/ad-051-scheduler-pipelines.md) |
| AD-052 | Публичная API-платформа: per-service ключи со скоупами/тенантами, OpenAPI-спека, SDK, webhooks | ⚠️ Частично (API-ключи привязок событий — первый срез, AD-089; service-key/OpenAPI/SDK/webhooks — нет) | [ad-052](./docs/arch_decisions/ad-052-public-api-platform.md) |
| AD-053 | CLI и TUI: паритет публикуемого и dev-CLI, CLI как клиент API v2, TUI | ⏳ Не реализовано | [ad-053](./docs/arch_decisions/ad-053-cli-tui.md) |
| AD-054 | Kanban-доска, backlog, управление проектами: интерактивная доска поверх `project.plan`, глобальный backlog, assignee/WIP-лимиты | ⏳ Не реализовано | [ad-054](./docs/arch_decisions/ad-054-kanban-backlog.md) |
| AD-055 | Обмен между инстансами Synth: идемпотентный upsert/дельта-синхронизация, peer-auth, обмен памятью, live-сессии | ⏳ Не реализовано | [ad-055](./docs/arch_decisions/ad-055-instance-exchange.md) |
| AD-056 | MCP-сервер Synth и скиллы для внешних агентов: MCP над API v2, auth, права, форматы конфигов клиентов | ⏳ Не реализовано | [ad-056](./docs/arch_decisions/ad-056-synth-mcp-server.md) |
| AD-057 | Loop Engine и Loop Design Wizard: `/design-loop`, Verification Rubric, LoopRunner, 40 шаблонов, termination guards | ⏳ Не реализовано | [ad-057](./docs/arch_decisions/ad-057-loop-engine.md) |
| AD-058 | Служебные агенты и консилиум (Council): panel/consensus/debate/verifier/judge, Council Gate; включает AD-031 | ⏳ Не реализовано | [ad-058](./docs/arch_decisions/ad-058-service-agents-council.md) |
| AD-059 | Pipeline Automation: цепочки loops, передача артефактов между шагами, rollback/exit-стратегия, HITL, мониторинг-дашборд | ⏳ Не реализовано | [ad-059](./docs/arch_decisions/ad-059-pipeline-automation.md) |
| AD-060 | Мультиконтурная архитектура (Contour Bridge): шлюз между контурами, транспорт Kafka/RabbitMQ, обезличивание, аудит | ⏳ Не реализовано | [ad-060](./docs/arch_decisions/ad-060-multi-contour-bridge.md) |
| AD-061 | Многослойная безопасность LLM: сканеры промптов/вывода, лимиты (токены/итерации/время), HITL, аудит сессий, неизменяемость аудита | ⏳ Не реализовано | [ad-061](./docs/arch_decisions/ad-061-llm-security-layers.md) |
| AD-062 | Умная оптимизация контекста: тул `archive_context`, авто-суммаризация по лимиту, приоритизация, стратегии aggressive/moderate/off | ⏳ Не реализовано | [ad-062](./docs/arch_decisions/ad-062-context-optimization.md) |
| AD-063 | Обучение пользователя и метрики: Pre-PR Understanding Check, анализ сессий, рекомендации, дашборд метрик без рейтингов | ⏳ Не реализовано | [ad-063](./docs/arch_decisions/ad-063-user-learning-metrics.md) |
| AD-064 | Встроенные в UI браузер и терминал: PTY/WS-терминал, webview/iframe-браузер, синхронизация с агентом | ⏳ Не реализовано | [ad-064](./docs/arch_decisions/ad-064-ui-browser-terminal.md) |
| AD-065 | Просмотр документации, планов и ToDo в UI: docs-браузер, редактор плана/todo, связи, внешний vault (Obsidian Bridge) | ⏳ Не реализовано | [ad-065](./docs/arch_decisions/ad-065-ui-docs-plan-todo.md) |
| AD-066 | Скиллы и гайдлайны оформления документации: doc-стандарты, шаблоны, авто-проверка соответствия (docs-lint) | ⏳ Не реализовано | [ad-066](./docs/arch_decisions/ad-066-doc-style-skills.md) |
| AD-067 | «Впитывание» организационных гайдлайнов → дефолты инстанса: ingestion, scope (instance/org/team/project), версионирование/аудит | ⏳ Не реализовано | [ad-067](./docs/arch_decisions/ad-067-org-guidelines-defaults.md) |
| AD-068 | Реестр и каталог скиллов и агентов: индекс, trust/guard, install-policy, agent-packs | ⏳ Не реализовано | [ad-068](./docs/arch_decisions/ad-068-skills-agents-registry.md) |
| AD-069 | Проектные инструкции (AGENTS.md) и /init: discovery, merged chain git root→cwd, lazy-догрузка, threat-scan, install-tree guard | ✅ Реализовано (Ф1–Ф3: resolver/composer, sources/URL/trust/guard, lazy/саб-агенты/событие/API/UI, `/init` + скилл `synth-agents-md`) | [ad-069](./docs/arch_decisions/ad-069-project-instructions-agents-md.md) |
| AD-070 | SystemPromptComposer: тиры stable/context/volatile, идемпотентная пересборка, CachePolicy, статистика usage, per-agent promptStates, манифест промпта | ✅ Реализовано | [ad-070](./docs/arch_decisions/ad-070-system-prompt-composer.md) |
| AD-071 | MCP: уровни system/project/session, единый реестр, разделение слоёв tools/mcp.tools, блоки mcp.servers/mcp.status, политики tools.policy (встроенные) и mcp.policy (MCP), admin-отключение встроенных инструментов | ✅ Реализовано | [ad-071](./docs/arch_decisions/ad-071-mcp-servers-prompt.md) |
| AD-072 | Settings UI Kit: стандартная панель настроек (один вертикальный скролл, фиксированная шапка, центрирование max-w-3xl, контракт черновика, контролы) | ✅ Реализовано | [ad-072](./docs/arch_decisions/ad-072-settings-ui-kit.md) |
| AD-073 | Целостность клиента в гибридном режиме: клиент недоверенный, enforcement на сервере; сигналы целостности (подписи, DPoP/mTLS) — опционально | ⏳ Не реализовано | [ad-073](./docs/arch_decisions/ad-073-client-integrity-hybrid.md) |
| AD-074 | Скрытие вместо удаления (soft-delete): проекты/сессии/сообщения скрываются, исключаются из LLM-контекста, read-only режим для ADMIN/AUDITOR, restore/purge — ADMIN | ⏳ Не реализовано | [ad-074](./docs/arch_decisions/ad-074-soft-delete-retention.md) |
| AD-075 | Окружение проекта: рабочий каталог (автосоздание managed / выбор для standalone; политика `workspaceOutsideRoot`; FS-паритет core↔backend); тулы `project_workspace_set`/`project_update`, общий `engine/workspace-provision.ts` | ✅ Реализовано | [ad-075](./docs/arch_decisions/ad-075-project-workspace-provisioning.md) |
| AD-076 | Реестр git-репозиториев (несколько на проект) и SSH-ключи per-agent (шифрование at-rest, `repo_path`, паритет core↔backend); тулы `project_repo_clone\|init\|add\|fetch\|remove` | ✅ Реализовано | [ad-076](./docs/arch_decisions/ad-076-git-repo-registry-ssh.md) |
| AD-077 | Инструментальное окружение исполнения: managed — thin backend + сервис-executor (общий volume для workspace; S3 — целевое хранилище); реализуется после AD-032 (PostgreSQL) | ⏳ Не реализовано | [ad-077](./docs/arch_decisions/ad-077-runtime-toolchain.md) |
| AD-078 | Авто-отключение инструментов при отсутствии внешней зависимости (детект git/rg/sh, `unavailable(dependency)`, пояснение модели) | ✅ Реализовано | [ad-078](./docs/arch_decisions/ad-078-runtime-dependency-availability.md) |
| AD-079 | Локальный home-каталог (`--home`/`SYNTH_HOME`): плоская раскладка config/data/profiles/credentials, приоритеты путей, независимые инстансы standalone и hybrid | ✅ Реализовано | [ad-079](./docs/arch_decisions/ad-079-local-home-independent-instances.md) |
| AD-080 | Управляемый гибрид: режимы-полюса (режим — параметр запуска, без runtime-переключения), standalone=ADMIN / hybrid=роли сервера, «Установить локально» | ⏳ Не реализовано | [ad-080](./docs/arch_decisions/ad-080-managed-hybrid-modes.md) |
| AD-081 | Политики гибрида и защита от утечек: серверные политики (forbidden/remote-only/full; publish/fork allow\|deny\|approval), явные эндпоинты переноса, discovery, аудит, панель «Гибрид» | ⏳ Не реализовано | [ad-081](./docs/arch_decisions/ad-081-hybrid-policy-leak-protection.md) |
| AD-082 | Flavor-образы с toolchain (`slim`/`core`/`dev`/`devops`/`browser`/`full`; alpine + debian) для local containerized и managed single-instance (промежуточный шаг до AD-077) | ⏳ Не реализовано | [ad-082](./docs/arch_decisions/ad-082-full-images-deployment.md) |
| AD-083 | Кастомизация инстанса и брендинг: приветственное окно (+повторный вызов), конфиг брендинга (название/лого-подпись/ватермарка), серверная выдача; на потом — locked settings (блокировка настроек даже для ADMIN инстанса) | ⏳ Не реализовано | [ad-083](./docs/arch_decisions/ad-083-instance-customization-branding.md) |
| AD-084 | Decision-модели (Clef/Clef-Flash) в маршрутизации и быстрых ответах: класс decision-моделей (Jev/SystemOne-совместимый API), Clef-Flash в micro/быстрых ответах, Clef на эскалацию/мультимодальность, через GatewayProvider, политики local/remote | ⏳ Не реализовано | [ad-084](./docs/arch_decisions/ad-084-decision-models-clef.md) |
| AD-085 | Мультимодальный ввод (звук, изображения, видео): типы `Part`, blob-хранилище вложений, маппинг в форматы провайдеров, предобработка (ASR/OCR/кадры), UI-композер | ⏳ Не реализовано | [ad-085](./docs/arch_decisions/ad-085-multimodal-input.md) |
| AD-086 | Расширяемость Synth: плагины, editions, вклад в mainline и внешние сервисы-надстройки: Extension API, каталог editions, contribution flow, add-ons (первый случай — Telegram gateway) | ⏳ Не реализовано | [ad-086](./docs/arch_decisions/ad-086-extensibility-plugins-editions.md) |
| AD-087 | Gateway для подключения к мессенджерам | ⛔ Поглощён AD-086 | [ad-087](./docs/arch_decisions/ad-087-messenger-gateway-merged.md) |
| AD-088 | Работа через HTTP-прокси: единый egress-слой, `no_proxy`/исключения, доверенные CA, аутентификация Basic/NTLM/Negotiate (Kerberos) | ⏳ Не реализовано | [ad-088](./docs/arch_decisions/ad-088-http-proxy.md) |
| AD-089 | Synth как платформа внешних событий и автоматизации: сущности Event/Binding/Router, приём внешних событий на hook-шине, `session.requested` — тоже событие | ⚠️ Частично (ядро Event/Binding/Router, единый funnel, API, UI, источник AD-051 (cron), API-ключи привязок — первый срез AD-052; AD-086 — нет) | [ad-089](./docs/arch_decisions/ad-089-external-events-automation.md) |

Правило: реализованные AD переносятся в `./docs/arch_decisions/` (в AGENTS.md остаётся строка таблицы + ссылка).

## Куда смотреть (триггеры)

| Трогаешь | Читай |
|---|---|
| пользовательская документация / портал | https://docs.synth.itphx.ru/ |
| документация (портал и dev-доки) | скилл `synth-docs` |
| storage / JSON / FileStore | [AD-005](./docs/arch_decisions/ad-005-json-storage.md) |
| события / WS / SSE | [AD-008](./docs/arch_decisions/ad-008-websocket-events.md), [AD-009](./docs/arch_decisions/ad-009-session-event-bus.md), [AD-024](./docs/arch_decisions/ad-024-eventhub-transport.md) |
| проект / сессии / ветвление / merge | [AD-014](./docs/arch_decisions/ad-014-project-container.md), [AD-033](./docs/arch_decisions/ad-033-session-branching-merge.md), [AD-040](./docs/arch_decisions/ad-040-sessions-without-project.md) |
| API v2 / Hono | [AD-017](./docs/arch_decisions/ad-017-api-v2-hono.md), [docs/API_V2.md](./docs/API_V2.md) |
| движки / engine | [AD-018](./docs/arch_decisions/ad-018-session-engine-selection.md), [AD-022](./docs/arch_decisions/ad-022-typescript-stack-runner.md) |
| UI / React / PWA | [AD-019](./docs/arch_decisions/ad-019-react-spa.md), [AD-044](./docs/arch_decisions/ad-044-mobile-adaptive-ui-pwa.md), [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) |
| саб-агенты / контекст | [AD-026](./docs/arch_decisions/ad-026-subagent-context-modes.md), [AD-033](./docs/arch_decisions/ad-033-session-branching-merge.md) |
| permissions / plan-act | [AD-025](./docs/arch_decisions/ad-025-plan-act-toggle.md), [AD-028](./docs/arch_decisions/ad-028-plan-build-strictness.md), [AD-029](./docs/arch_decisions/ad-029-granular-permissions.md) |
| конфиг | [AD-023](./docs/arch_decisions/ad-023-configuration.md), [docs/CONFIGURATION.md](./docs/CONFIGURATION.md) |
| routing / микро-слой | [AD-034](./docs/arch_decisions/ad-034-model-routing.md), [AD-035](./docs/arch_decisions/ad-035-micro-model-first.md), [AD-084](./docs/arch_decisions/ad-084-decision-models-clef.md), [docs/ROUTING.md](./docs/ROUTING.md) |
| безопасность / gateway | [AD-036](./docs/arch_decisions/ad-036-llm-gateway.md) |
| безопасность клиента / целостность / аттестация гибрида | [AD-073](./docs/arch_decisions/ad-073-client-integrity-hybrid.md) |
| soft-delete / скрытие / retention / аудит-режим | [AD-074](./docs/arch_decisions/ad-074-soft-delete-retention.md) |
| workspace / рабочий каталог / окружение проекта | [AD-075](./docs/arch_decisions/ad-075-project-workspace-provisioning.md) |
| git-репозитории / SSH-ключи | [AD-076](./docs/arch_decisions/ad-076-git-repo-registry-ssh.md) |
| инструменты / образы / тулчейн / executor | [AD-077](./docs/arch_decisions/ad-077-runtime-toolchain.md), [AD-078](./docs/arch_decisions/ad-078-runtime-dependency-availability.md), [AD-082](./docs/arch_decisions/ad-082-full-images-deployment.md) |
| план / todo | [AD-039](./docs/arch_decisions/ad-039-plan-in-project.md) |
| ошибки LLM / i18n | [AD-041](./docs/arch_decisions/ad-041-llm-error-taxonomy.md) |
| гибрид | [AD-042](./docs/arch_decisions/ad-042-hybrid-mode.md), [AD-043](./docs/arch_decisions/ad-043-unified-identity-login.md), [AD-045](./docs/arch_decisions/ad-045-hybrid-server-profiles.md), [AD-080](./docs/arch_decisions/ad-080-managed-hybrid-modes.md), [AD-081](./docs/arch_decisions/ad-081-hybrid-policy-leak-protection.md), [docs/HYBRID.md](./docs/HYBRID.md), скилл `synth-hybrid` |
| локальный home / пути / независимые инстансы | [AD-079](./docs/arch_decisions/ad-079-local-home-independent-instances.md), [AD-023](./docs/arch_decisions/ad-023-configuration.md), [AD-045](./docs/arch_decisions/ad-045-hybrid-server-profiles.md) |
| OIDC / Keycloak / RBAC | [docs/KEYCLOAK.md](./docs/KEYCLOAK.md) |
| npm / Docker / Helm / релиз | [AD-038](./docs/arch_decisions/ad-038-npm-packages.md), [docs/PUBLISHING.md](./docs/PUBLISHING.md), скиллы `synth-build-publish`, `synth-release` |
| CI GitVerse | `.gitverse/workflows/*`, скилл `synth-release` |
| K3s / test | скилл `synth-k3s-deploy` |
| dev-окружение | [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md), скилл `synth-dev` |
| MCP GitVerse | скилл `synth-gitverse-mcp` |
| API-тесты | скилл `synth-api-testing` |
| скиллы / команды | [AD-046](./docs/arch_decisions/ad-046-skills-and-slash-commands.md) |
| реестр скиллов / агентов | [AD-068](./docs/arch_decisions/ad-068-skills-agents-registry.md) |
| инструкции AGENTS.md | [AD-069](./docs/arch_decisions/ad-069-project-instructions-agents-md.md), скилл `synth-agents-md` |
| промпт / prompt-cache / статистика токенов / debug промпта | [AD-070](./docs/arch_decisions/ad-070-system-prompt-composer.md), [AD-036](./docs/arch_decisions/ad-036-llm-gateway.md), [AD-041](./docs/arch_decisions/ad-041-llm-error-taxonomy.md) |
| MCP / MCP-серверы / инструменты в промпте | [AD-071](./docs/arch_decisions/ad-071-mcp-servers-prompt.md), [AD-029](./docs/arch_decisions/ad-029-granular-permissions.md), [AD-068](./docs/arch_decisions/ad-068-skills-agents-registry.md) |
| настройки / settings UI kit | [AD-072](./docs/arch_decisions/ad-072-settings-ui-kit.md), [packages/ui/AGENTS.md](./packages/ui/AGENTS.md) |
| кастомизация / брендинг / онбординг | [AD-083](./docs/arch_decisions/ad-083-instance-customization-branding.md), [packages/ui/AGENTS.md](./packages/ui/AGENTS.md) |
| блокировка настроек (locked settings) | [AD-083](./docs/arch_decisions/ad-083-instance-customization-branding.md), [AD-073](./docs/arch_decisions/ad-073-client-integrity-hybrid.md), [AD-080](./docs/arch_decisions/ad-080-managed-hybrid-modes.md), [AD-081](./docs/arch_decisions/ad-081-hybrid-policy-leak-protection.md) |
| внешние события / хуки / роутинг / сессии | [AD-089](./docs/arch_decisions/ad-089-external-events-automation.md), [AD-030](./docs/arch_decisions/ad-030-hooks-agent-events.md), [AD-033](./docs/arch_decisions/ad-033-session-branching-merge.md) |
| мессенджеры / шлюзы | [AD-086](./docs/arch_decisions/ad-086-extensibility-plugins-editions.md), [AD-087](./docs/arch_decisions/ad-087-messenger-gateway-merged.md) (⛔ поглощён AD-086) |
| шедулер / пайплайны | [AD-051](./docs/arch_decisions/ad-051-scheduler-pipelines.md), [AD-059](./docs/arch_decisions/ad-059-pipeline-automation.md), [AD-057](./docs/arch_decisions/ad-057-loop-engine.md) |
| публичный API / webhooks | [AD-052](./docs/arch_decisions/ad-052-public-api-platform.md), [AD-089](./docs/arch_decisions/ad-089-external-events-automation.md) |
| MCP-сервер Synth | [AD-056](./docs/arch_decisions/ad-056-synth-mcp-server.md), [AD-048](./docs/arch_decisions/ad-048-self-help-skills-admin-mcp.md) |
| внешние add-on сервисы / плагины / editions | [AD-086](./docs/arch_decisions/ad-086-extensibility-plugins-editions.md), [AD-030](./docs/arch_decisions/ad-030-hooks-agent-events.md) |
| прокси / egress | [AD-088](./docs/arch_decisions/ad-088-http-proxy.md) |
| мультимодальный ввод | [AD-085](./docs/arch_decisions/ad-085-multimodal-input.md) |
| память | [AD-047](./docs/arch_decisions/ad-047-memory-gbrain.md), [AD-062](./docs/arch_decisions/ad-062-context-optimization.md) |
| CLI / TUI | [AD-053](./docs/arch_decisions/ad-053-cli-tui.md) |
| Kanban / backlog | [AD-054](./docs/arch_decisions/ad-054-kanban-backlog.md), [AD-065](./docs/arch_decisions/ad-065-ui-docs-plan-todo.md) |
| иконки/цвета проекта и сессии | [packages/ui/AGENTS.md](./packages/ui/AGENTS.md), [packages/shared/AGENTS.md](./packages/shared/AGENTS.md) |

## Документация

Разделение аудиторий: **пользовательская документация** — канонический источник на портале
[docs.synth.itphx.ru](https://docs.synth.itphx.ru/) (RU по умолчанию, EN — `/en/`; быстрый старт,
провайдеры, гибрид, администрирование, CLI/FAQ), в репозитории не дублируется; **документация для
разработчиков** — в `docs/` репозитория и в `AGENTS.md` (этот файл, архитектурные соглашения и AD).

| Файл | Назначение |
|------|------------|
| `AGENTS.md` | Архитектурные соглашения (этот файл) |
| [docs/API_V2.md](./docs/API_V2.md) | Справочник API v2 (эндпоинты, RBAC, ошибки, транспорт) |
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | Обзор архитектуры |
| [docs/CONFIGURATION.md](./docs/CONFIGURATION.md) | Конфигурация |
| [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md) | Dev-окружение, скрипты |
| [docs/HYBRID.md](./docs/HYBRID.md) | Гибридный режим: требования, архитектура, статус |
| [docs/KEYCLOAK.md](./docs/KEYCLOAK.md) | Учётки/настройки Keycloak |
| [docs/LLM_PROVIDERS.md](./docs/LLM_PROVIDERS.md) | Провайдеры LLM для разработки |
| [docs/PUBLISHING.md](./docs/PUBLISHING.md) | Сборка, публикация npm, Docker, Helm, релиз |
| [docs/QUICKSTART.md](./docs/QUICKSTART.md) | Быстрый старт |
| [docs/ROUTING.md](./docs/ROUTING.md) | Routing и микро-слой |
| [docs/TROUBLESHOOTING.md](./docs/TROUBLESHOOTING.md) | Диагностика проблем |
| [docs/arch_decisions/README.md](./docs/arch_decisions/README.md) | Каталог AD |

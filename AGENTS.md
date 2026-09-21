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

## Команды

Из корня `synth/`:

```bash
./scripts/dev.sh                    # backend (:5000) + UI (:5002)
./scripts/dev.sh backend | ui | core | all

pnpm install                # установка зависимостей
pnpm build                  # сборка всех пакетов
pnpm typecheck              # проверка типов
pnpm lint                   # ESLint
pnpm test                   # Vitest
pnpm clean                  # очистка dist/
```

Сборка core копирует `prompts/` и `definitions/*.json` в `dist/` (backend — `definitions/`) — это **fallback для Docker**; источник истины промптов — `packages/core/prompts` (публикуется в npm через `files`), дубликатов ассетов нет (AD-038). Логи dev-запуска: `tmp/backend.log`, `tmp/ui.log`, `tmp/core.log`.

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

`./scripts/dev.sh [backend|ui|core|all]` из `synth/` (или `./synth/scripts/dev.sh` из корня проекта). Скрипт ставит: `SYNTH_AUTH_DEBUG=true` (debug-аутентификация), `SYNTH_DATA_DIR=/home/eof/dev/Synth/data`, `SYNTH_PORT`/`SYNTH_CORE_PORT`/`VITE_PORT`, а также `SYNTH_CONFIG=packages/backend/config.yaml` (только если файл существует) — поэтому `mcp.servers` из backend-конфига подхватываются в dev; `loadConfig` учитывает `SYNTH_CONFIG` (AD-023). Подробности — [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md).

### Данные

Runtime-данные (сессии, проекты, провайдеры, модели) — в `$SYNTH_DATA_DIR` (env `SYNTH_DATA_DIR` или `storage.dataDir` в config.yaml; дефолт `/var/synth/data`). Провайдеры — JSON в `$SYNTH_DATA_DIR/providers/`, модели — в `$SYNTH_DATA_DIR/models/`; добавить провайдера/модель = создать JSON-файл (или через API). Атомарная запись: `.tmp.{uuid}` → `rename()`. Основные dev-провайдеры (`itphx`, `ollama`) — в [docs/LLM_PROVIDERS.md](./docs/LLM_PROVIDERS.md).

```text
$SYNTH_DATA_DIR/ → sessions/ projects/ providers/ models/ agents/ context/ auth/(sessions,states,profiles)
```

### Аутентификация

Все API (кроме `GET /health`) требуют аутентификации, иначе 401. Роли: `ADMIN`, `USER`, `LEAD`, `AUDITOR`; middleware `requireAuth`, `requirePermission` (первый в цепочке после CORS/logging).

| Режим | Где | Когда | Механизм |
|-------|-----|-------|----------|
| Debug | backend | `SYNTH_AUTH_DEBUG=true` | тестовые ключи (ниже) |
| API Key | backend | прод без OIDC | `SYNTH_API_KEY` → ADMIN |
| OIDC | backend | прод с Keycloak | JWT + cookie `user_session` |
| Local | core | `synth serve --api-key` | один ключ → USER |

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
| `GET/PUT /api/v2/settings/mcp` | Доступность MCP-инструментов по режимам (plan/act) |
| `GET/PUT /api/v2/settings/tools-policy` | Политика встроенных инструментов (`consistency`/`available`/`auto`) |
| `GET/PUT /api/v2/settings/mcp-policy` | Политика MCP-инструментов (`consistency`/`available`/`auto`) |
| `GET/PUT /api/v2/settings/tools-disabled` | Instance-wide отключение встроенных инструментов (группы/тулы; `runtime` неотключаем) |
| `GET/PUT /api/v2/mcp/registry` | Реестр MCP-серверов (stdio — только ADMIN) |
| `GET/PUT /api/v2/projects/:id/mcp` и `GET/PUT /api/v2/sessions/:id/mcp` | Уровни/скоуп MCP |
| `POST /api/v2/mcp/probe` | Проверка MCP-сервера без регистрации инструментов |

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
- Резолвинг `_resolveWorkingDir`: `project.workspace` → defaultWorkingDir.
- Тулы `plan_enter`, `plan_exit`, `get_project_info`, `list_repos` жёстко привязаны к `project.workspace`/сессии — path-параметры не принимают.

| Группа | Тулы |
|---|---|
| Файлы (чтение) | `read_file`, `list_directory`, `glob` |
| Файлы (запись) | `write_file`, `edit_file`, `create_directory`, `delete_file` |
| Поиск | `grep_files`, `glob` |
| Shell | `execute_shell` |
| Git | `git_status`, `git_diff`, `git_log`, `git_commit`, `git_push`, `git_pull`, `git_checkout`, `git_branch_list`, `git_show`, `git_blame`, `git_stash` |
| План/ToDo | `plan_enter`, `plan_exit`, `plan_read`, `plan_list`, `plan_write`, `todo_write`, `todo_list`, `todo_add`, `todo_update`, `todo_delete` |
| Проект | `get_project_info`, `list_repos`, `project_create`, `project_attach` |
| Лог/Инварианты | `project_log_write`, `project_log_read`, `project_invariants_read`, `project_invariants_write` |
| Веб | `web_fetch`, `web_search` (DuckDuckGo, при anti-bot — fallback на Bing) |
| Задачи | `task`, `classify_conversation`, `read_session_reference` |

Доступность групп — в `ToolCapability` (`@itphx/synth-shared`); MCP-тулы регистрируются как `{serverName}_{toolName}`, подчиняются режимам (AD-029) и выбираются **per-session** — в промпт идут только тулы активных серверов сессии. Слои разделены: `tools` — встроенные, `mcp.tools`/`mcp.servers`/`mcp.status` — MCP (всегда `volatile`) (AD-071).

## UI-конвенции

Панель «Сессия» в правой панели показывает план (`planContent`) и ToDo (`todos`); обновляется по WS-событиям `plan.approved`/`todos.updated` (полный refresh с сервера).

### Мобильный адаптив + PWA

Единый адаптивный UI, три зоны: **телефон ≤768px / планшет 769–1199px / десктоп ≥1200px** (десктоп не меняется). Детекция `matchMedia` + классы на `<html>`: `device-phone/tablet/desktop`, `pointer-coarse` (хуки `useDevice()`/`useMediaQuery`, `lib/device.ts`); мобильный CSS гейтится этими классами.

- На телефоне/планшете чат на весь экран, левая/правая панели — оверлей-дроверы (`components/layout/MobileDrawer.tsx`) из мобильного хедера, `ResizeHandle` скрыт, нижней навигации нет.
- Touch-first: hover-действия доступны (CSS под `html.pointer-coarse`), таргеты ≥40px, нативный скролл, DnD в деревьях отключён.
- `window.confirm` → `ConfirmDialog`; для zustand — `lib/confirm.ts` + `stores/confirmStore.ts` (рендер в `App`). Модалки/админка на телефоне — скролл-табы на всю ширину.
- Клавиатура: `useKeyboardInset` (visualViewport → `--kb-inset` → `padding-bottom` композера); Enter на таче — перенос строки, на fine-pointer — отправка; IME учтён.
- PWA (ручной app-shell, без vite-plugin-pwa): `public/manifest.webmanifest` (standalone, theme `#09090b`), `public/sw.js` (кэш шела; `/api,/ws,/auth,/admin,/health` не кэшируются, навигация network-first → офлайн-заглушка), иконки в `public/icons/`, меты в `index.html`; `usePwaInstall`/`PwaInstallButton`; регистрация SW только в prod.
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
| AD-030 | Hooks для событий агента (pre/post tool use, session, plan, spawn) | ⏳ Не реализовано | [ad-030](./docs/arch_decisions/ad-030-hooks-agent-events.md) |
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
| AD-046 | Скиллы и slash-команды: формат SKILL.md, discovery, progressive disclosure, core-тул skill, bundles | ⏳ Не реализовано | [ad-046](./docs/arch_decisions/ad-046-skills-and-slash-commands.md) |
| AD-068 | Реестр и каталог скиллов и агентов: индекс, trust/guard, install-policy, agent-packs | ⏳ Не реализовано | [ad-068](./docs/arch_decisions/ad-068-skills-agents-registry.md) |
| AD-069 | Проектные инструкции (AGENTS.md) и /init: discovery, merged chain git root→cwd, lazy-догрузка, threat-scan, install-tree guard | ⏳ Не реализовано | [ad-069](./docs/arch_decisions/ad-069-project-instructions-agents-md.md) |
| AD-070 | SystemPromptComposer: тиры stable/context/volatile, идемпотентная пересборка, CachePolicy, статистика usage, per-agent promptStates, манифест промпта | ✅ Реализовано | [ad-070](./docs/arch_decisions/ad-070-system-prompt-composer.md) |
| AD-071 | MCP: уровни system/project/session, единый реестр, разделение слоёв tools/mcp.tools, блоки mcp.servers/mcp.status, политики tools.policy (встроенные) и mcp.policy (MCP), admin-отключение встроенных инструментов | ✅ Реализовано | [ad-071](./docs/arch_decisions/ad-071-mcp-servers-prompt.md) |
| AD-072 | Settings UI Kit: стандартная панель настроек (один вертикальный скролл, фиксированная шапка, центрирование max-w-3xl, контракт черновика, контролы) | ✅ Реализовано | [ad-072](./docs/arch_decisions/ad-072-settings-ui-kit.md) |

Правило: реализованные AD переносятся в `./docs/arch_decisions/` (в AGENTS.md остаётся строка таблицы + ссылка).

## Куда смотреть (триггеры)

| Трогаешь | Читай |
|---|---|
| storage / JSON / FileStore | [AD-005](./docs/arch_decisions/ad-005-json-storage.md) |
| события / WS / SSE | [AD-008](./docs/arch_decisions/ad-008-websocket-events.md), [AD-009](./docs/arch_decisions/ad-009-session-event-bus.md), [AD-024](./docs/arch_decisions/ad-024-eventhub-transport.md) |
| проект / сессии / ветвление / merge | [AD-014](./docs/arch_decisions/ad-014-project-container.md), [AD-033](./docs/arch_decisions/ad-033-session-branching-merge.md), [AD-040](./docs/arch_decisions/ad-040-sessions-without-project.md) |
| API v2 / Hono | [AD-017](./docs/arch_decisions/ad-017-api-v2-hono.md), [docs/API_V2.md](./docs/API_V2.md) |
| движки / engine | [AD-018](./docs/arch_decisions/ad-018-session-engine-selection.md), [AD-022](./docs/arch_decisions/ad-022-typescript-stack-runner.md) |
| UI / React / PWA | [AD-019](./docs/arch_decisions/ad-019-react-spa.md), [AD-044](./docs/arch_decisions/ad-044-mobile-adaptive-ui-pwa.md), [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) |
| саб-агенты / контекст | [AD-026](./docs/arch_decisions/ad-026-subagent-context-modes.md), [AD-033](./docs/arch_decisions/ad-033-session-branching-merge.md) |
| permissions / plan-act | [AD-025](./docs/arch_decisions/ad-025-plan-act-toggle.md), [AD-028](./docs/arch_decisions/ad-028-plan-build-strictness.md), [AD-029](./docs/arch_decisions/ad-029-granular-permissions.md) |
| конфиг | [AD-023](./docs/arch_decisions/ad-023-configuration.md), [docs/CONFIGURATION.md](./docs/CONFIGURATION.md) |
| routing / микро-слой | [AD-034](./docs/arch_decisions/ad-034-model-routing.md), [AD-035](./docs/arch_decisions/ad-035-micro-model-first.md), [docs/ROUTING.md](./docs/ROUTING.md) |
| безопасность / gateway | [AD-036](./docs/arch_decisions/ad-036-llm-gateway.md) |
| план / todo | [AD-039](./docs/arch_decisions/ad-039-plan-in-project.md) |
| ошибки LLM / i18n | [AD-041](./docs/arch_decisions/ad-041-llm-error-taxonomy.md) |
| гибрид | [AD-042](./docs/arch_decisions/ad-042-hybrid-mode.md), [AD-043](./docs/arch_decisions/ad-043-unified-identity-login.md), [AD-045](./docs/arch_decisions/ad-045-hybrid-server-profiles.md), [docs/HYBRID.md](./docs/HYBRID.md), скилл `synth-hybrid` |
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

## Документация

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

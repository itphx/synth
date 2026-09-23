# AD-075: Окружение проекта: рабочий каталог (создание и выбор)

> **Статус:** ⏳ Не реализовано
> **Источник:** согласовано 2026-09-23 (обсуждение проблем эксплуатации managed-Synth)

**Решение:** `project.workspace` остаётся настраиваемым параметром, но **семантика его инициализации и допустимый диапазон путей зависят от режима развёртывания**. Пользователь managed-инстанса не должен упираться в «каталог не найден»: рабочая директория проекта создаётся автоматически; там, где развёртывание локальное, доступен и ручной выбор по файловой системе.

## Решение

| Режим | Кто владеет ФС | Инициализация workspace | Диапазон путей |
|---|---|---|---|
| **Managed / remote-проект** | backend | Автосоздание в предопределённом месте под `workspacesRoot` (схема имени — открытый вопрос). Пользователь путь **не выбирает**, только видит | Строго внутри `workspacesRoot` |
| **Standalone / локальный проект в гибриде** | локальный core | По умолчанию авто (`{dataDir}/workspaces/<…>`); доступен режим **ручного выбора/создания** через FS-диалог | Допускается произвольный абсолютный путь |
| **Сессия без проекта** | — | Работает в default workspace (AD-040); диалог доступен при создании/привязке проекта | — |

Единая семантика:

- **Managed** — `workspace` обязан быть относительным путём (или абсолютным внутри `workspacesRoot`); при create/PUT каталог создаётся (`mkdir -p`), а не только валидируется. Ошибка 422 «каталог не найден» уходит.
- **Standalone** — `workspace` может быть любым абсолютным путём на хосте. Защита: аутентификация (AD-029/036), `protected-paths`, явное подтверждение пользователя для путей вне «безопасного» корня.
- **Единый резолвер** `_resolveWorkingDir` (AD-014) дополняется защитным `mkdir` и для проектного workspace, а не только для дефолтного: к моменту работы инструмента каталог гарантированно существует.

**FS-диалог выбора/создания каталога.** Навигация по дереву, создание нового каталога, выбор текущего. Для remote-проекта диалог работает **против backend** (`/fs/workspace-root*`); для standalone — **против локального core**. Это одна UI-компонента с разным источником данных.

## Что уже есть

| Факт | Где |
|---|---|
| Backend уже имеет `GET /fs/workspace-root`, `GET /fs/workspace-root/browse`, `POST /fs/workspace-root/mkdir` | `packages/backend/src/routes/fs.ts:~390-440`; UI их **не вызывает** |
| Core `createFsRoutes` берёт корень `workspacesRoot || process.cwd()`; `/workspace-root*` и резолва `project.workspace` для локальных проектов нет | `packages/core/src/server/routes/fs.ts:~40` |
| Managed backend валидирует существование каталога → 422 | `packages/backend/src/routes/projects.ts:~47-68,193-198` |
| Core принимает любой путь без `mkdir` | `packages/core/src/server/routes/projects.ts:~153-157` |
| Дефолтный workspace создаётся автоматически | `packages/shared/src/config/resolve.ts:~175-180`; `packages/core/src/server/app.ts:~614-616` |
| Проектный workspace **нигде** не создаётся | `packages/core/src/engine/orchestrator.ts:~1093-1117` (`mkdir` только для дефолта) |
| UI: кнопка «Сохранить» → `PUT /projects/:id`, workspace только текстовое поле | `packages/ui/src/components/panels/ProjectTab.tsx:~216-236` |
| Workspace не задаётся при создании; remote-проекты получают `workspace = null` | `packages/ui/src/components/panels/CreateProjectPopover.tsx:~43-88` |
| Авто-`mkdir` есть только в hybrid transfer/publish/fork | `packages/core/src/remote/transfer.ts:~304-431` |

## Дельта

1. **Выровнять core ↔ backend по FS.** Добавить `/workspace-root*` в core `createFsRoutes`; в core-роуте проектов — резолв `project.workspace` для локальных проектов (сейчас отсутствует).
2. **Авто-`mkdir` на create/PUT/настройках/`project_create`** и **защитно** в `_resolveWorkingDir` — единая точка гарантии существования каталога.
3. **Guard для FS-browse по всей ФС.** Для standalone — просмотр/создание вне `workspacesRoot` только с проверкой auth, `protected-paths` и явным подтверждением; для managed — запрет выхода из `workspacesRoot`.
4. **UI-диалог выбора/создания каталога** — переиспользовать Dialog/Settings UI Kit (AD-072) и паттерн `OriginSelector`; источник данных (backend vs core) переключается по режиму.
5. **I18n-ключи** диалога и ошибок (AD-041).
6. **Remote-проекты получают workspace** — при создании и в UI; диалог против backend.

## Открытые вопросы

- **Схема авто-имени** managed-workspace: `slug(name)` / имя / `id` / `id-slug`? Устойчивость при переименовании и коллизиях.
- **Где настраивать auto/manual**: config `storage.*` vs runtime settings (`PUT /api/v2/settings/workspace`).
- **Поведение диалога вне «безопасного» корня**: предупреждение, подтверждение, или полный запрет для некоторых ролей.
- **Сессия без проекта**: доступ к FS-диалогу через меню проекта или отдельная точка входа.

## Зависимости

- **AD-014** — `project.workspace` и резолвинг в `_resolveWorkingDir`.
- **AD-023** — конфиг (`workspacesRoot`, `storage.*`).
- **AD-029** — permissions и подтверждения.
- **AD-040** — сессии без проекта и `project.attach`.
- **AD-042/AD-045** — гибрид: работа против backend, профили серверов.
- **D4 / AD-049** (Git worktrees) — **согласовать `_resolveWorkingDir`**: per-session cwd/worktree не должен конфликтовать с AD-075.

## Связи

- [AD-014](./ad-014-project-container.md) «Проект как контейнер».
- [AD-076](./ad-076-git-repo-registry-ssh.md) «Реестр git-репозиториев и доступ (SSH)» — клон выполняется в подкаталог **внутри** `project.workspace`.
- [AD-077](./ad-077-runtime-toolchain.md) «Инструментальное окружение исполнения» — `mkdir`/`git`/`python` должны существовать в целевом окружении.
- [AD-072](./ad-072-settings-ui-kit.md) — UI-конвенции диалога.

## Порядок реализации

1. **Единый резолвер**: `mkdir` для проектного workspace; выравнивание core-роута проектов (резолв + сохранение).
2. **FS-паритет**: `/workspace-root*` в core, guard и режимы managed/standalone.
3. **Автосоздание**: create/PUT/`project_create`/transfer создают каталог; backend перестаёт отдавать 422 на отсутствующий.
4. **UI-диалог** выбора/создания + i18n; передача workspace при создании проекта, в т.ч. remote.
5. Тесты: unit (резолвер, guard), сквозной curl create/update, визуальная проверка диалога.

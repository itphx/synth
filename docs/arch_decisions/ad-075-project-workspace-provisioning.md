# AD-075: Окружение проекта: рабочий каталог (создание и выбор)

> **Статус:** ✅ Реализовано (2026-09-24)
> **Источник:** согласовано 2026-09-23 (обсуждение проблем эксплуатации managed-Synth)
> **Реализация:** 2026-09-24; решения и фактическое поведение — в разделе «Реализация»; сопутствующий дефект D5 закрыт (см. «Известные остатки»).

**Решение:** `project.workspace` остаётся настраиваемым параметром, но **семантика его инициализации и допустимый диапазон путей зависят от режима развёртывания**. Пользователь managed-инстанса не должен упираться в «каталог не найден»: рабочая директория проекта создаётся автоматически; там, где развёртывание локальное, доступен и ручной выбор по файловой системе.

## Решение

| Режим | Кто владеет ФС | Инициализация workspace | Диапазон путей |
|---|---|---|---|
| **Managed / remote-проект** | backend | Автосоздание в предопределённом месте под `workspacesRoot` (схема имени — `slugify(name)` + суффикс `-2/-3…`, см. «Реализация»). Пользователь путь **не выбирает**, только видит | Строго внутри `workspacesRoot` |
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

## Реализация (2026-09-24)

Реализовано в `@itphx/synth-shared`, `@itphx/synth-core`, `@itphx/synth-backend`, `@itphx/synth-ui`
(ветка `feat/ad-075-workspace-provisioning`). Ниже — принятые решения и фактическое поведение.

### 1. Managed (backend)

- **Автосоздание**: `POST/PUT /api/v2/projects` создают каталог `workspace` (`mkdir -p`); ошибка 422 «каталог не найден» убрана.
- **Нормализация пути** (`WorkspaceResolver.validateWorkspacePath`, `packages/backend/src/lib/workspace-resolver.ts`):
  - относительный путь — внутри `workspacesRoot`, сохраняется как есть;
  - абсолютный внутри `workspacesRoot` — нормализуется в относительный;
  - абсолютный вне root (или traversal `..` за root) → `403 WORKSPACE_OUTSIDE_ROOT_DENIED`;
  - пустой путь / сам корень → `400 VALIDATION_ERROR`.
- **Авто-имя** (пустой `workspace`): `slugifyWorkspaceName(name)` (`packages/shared/src/utils/workspace.ts`) — строчная латиница/цифры, разделитель `-`, обрезка до 64 символов, пустой результат → `project`; уникализация `uniqueWorkspaceName` → `base`, при коллизии `base-2`, `base-3`, … Учитываются `workspace` существующих проектов и подкаталоги `workspacesRoot`; имя занимается атомарным `mkdir` без `recursive` (параллельные POST не получают общий каталог).
- **RBAC смены workspace** (`PUT /api/v2/projects/:id`): владелец проекта, `LEAD` или `ADMIN`; иначе `403 FORBIDDEN`. Проверка выполняется до мутаций. *(Остальные поля проекта — см. D5.)*
- Коды: `400 VALIDATION_ERROR`, `403 WORKSPACE_OUTSIDE_ROOT_DENIED`, `403 FORBIDDEN`, `422 WORKSPACE_CREATE_FAILED`.

### 2. Политика путей вне `workspacesRoot`

- **API**: `GET/PUT/DELETE /api/v2/settings/workspace-policy`, тело `{outsideRoot:'confirm'|'deny'}`, персист в `{dataDir}/settings.json`, live-применение без рестарта.
- **Приоритет**: runtime (`settings.json`) > env `SYNTH_WORKSPACE_OUTSIDE_ROOT` > `config.storage.workspaceOutsideRoot` > дефолт по режиму (резолвер `resolveWorkspaceOutsideRootPolicy`).
- **Дефолты**: standalone/core — `confirm`; managed (backend) — `deny`.
- **Managed — read-only**: `GET` отдаёт `readOnly: true` с эффективным `deny`; `PUT`/`DELETE` → `403 WORKSPACE_POLICY_READ_ONLY`.

### 3. Core / standalone

- `_resolveWorkingDir` (`engine/orchestrator.ts`) и тул `project_create` (`engine/tools/project-manage.ts`) создают каталог проектного `workspace` (как и для дефолтного): относительный — от `workspacesRoot`, абсолютный — как есть.
- `createProjectRoutes` (`core/src/server/routes/projects.ts`) нормализует, создаёт каталог и проверяет политику: абсолютный вне root — `deny` → `403 WORKSPACE_OUTSIDE_ROOT_DENIED`, `confirm` без флага `confirmOutsideRoot` → `409 WORKSPACE_OUTSIDE_ROOT_CONFIRM_REQUIRED`, с флагом → сохраняется; относительный → `mkdir -p`. Ошибка создания каталога → `422 WORKSPACE_CREATE_FAILED`.
- RBAC в standalone нет (`requireAuth`), как и для остальных core-роутов.

### 4. FS-паритет core ↔ backend

- В core добавлены `GET /api/v2/fs/workspace-root`, `GET /api/v2/fs/workspace-root/browse`, `POST /api/v2/fs/workspace-root/mkdir` (паритет с backend); параметр `includeHidden` поддержан.
- Пути: абсолютный внутри root работает; вне root — по политике (`confirm`: browse разрешён, mkdir требует `confirmOutsideRoot`; `deny` → `403 WORKSPACE_OUTSIDE_ROOT_DENIED`); traversal `..` → `403 PATH_TRAVERSAL`; protected-paths учитываются (`403 PROTECTED_PATH_DENIED`).
- `mkdir` существующего каталога/файла → `409 ALREADY_EXISTS` (паритет core ↔ backend).

### 5. UI

- `DirectoryPickerDialog` — выбор/создание каталога; источник данных (backend vs core) определяется режимом развёртывания.
- Managed/remote — поле workspace read-only с пояснением; standalone — ручной выбор.
- Обработка `409 WORKSPACE_OUTSIDE_ROOT_CONFIRM_REQUIRED` → подтверждение → повтор с `confirmOutsideRoot`; `403` — ошибка.
- `WorkspacePolicySection` — контрол политики (в managed — read-only `deny`).
- i18n-ключи `workspace.*` (en + ru, AD-041).

### 6. Побочно исправлено

- Backend стал применять runtime-override `settings/workspace` и `resolveDefaultWorkspace`, а также передавать `defaultWorkingDir` в оркестратор — иначе сессия без проекта получала бы `{dataDir}/workspaces/default` мимо override.

### 7. Тесты

- shared 122, core 2043, backend 350, ui 750; `typecheck` и `lint` (0 errors) — зелёные.

## Решено (ранее открытые вопросы)

- **Схема авто-имени** — `slugify(name)` + суффикс `-2/-3…` (см. «Реализация §1»); устойчивость к коллизиям — атомарный `mkdir` + учёт существующих каталогов и проектов.
- **Где настраивать auto/manual** — по режиму развёртывания: managed — автоматически (явный путь валидируется); standalone — авто по умолчанию + ручной выбор через FS-диалог.
- **Поведение вне «безопасного» корня** — настройка `storage.workspaceOutsideRoot` / `settings/workspace-policy` с дефолтами: standalone `confirm` (подтверждение), managed `deny` (жёсткий запрет, read-only).
- **Сессия без проекта** — работает в default workspace (`{dataDir}/workspaces/default` или runtime `settings/workspace`); `project.workspace` при этом не участвует.

## Известные остатки

- **D5 (горизонтальная авторизация projects) — ✅ реализовано 2026-09-24** (вне объёма AD-075, отдельной задачей; `packages/backend/src/routes/projects.ts`, хелперы `canManageProject`/`canEditProjectContent`; тесты `projects.test.ts`, +7 кейсов). Матрица прав (backend; проверки до мутаций, иначе `403 FORBIDDEN`):
  - `PUT /api/v2/projects/:id`: смена `workspace` — owner / LEAD / ADMIN; изменение контентных полей (`name`, `description`, `current_task`, `invariants`, `icon`, `color`, `repos`, `plan`) — owner / EDITOR / LEAD / ADMIN; VIEWER и посторонний → `403`.
  - `DELETE /api/v2/projects/:id`: только owner / LEAD / ADMIN; EDITOR / VIEWER / посторонний → `403`.

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

## Порядок реализации (выполнено 2026-09-24)

1. ✅ **Единый резолвер**: `mkdir` для проектного workspace; выравнивание core-роута проектов (резолв + сохранение).
2. ✅ **FS-паритет**: `/workspace-root*` в core, guard и режимы managed/standalone.
3. ✅ **Автосоздание**: create/PUT/`project_create`/transfer создают каталог; backend перестаёт отдавать 422 на отсутствующий.
4. ✅ **UI-диалог** выбора/создания + i18n; передача workspace при создании проекта, в т.ч. remote.
5. ✅ Тесты: unit (резолвер, guard), сквозной curl create/update, визуальная проверка диалога.

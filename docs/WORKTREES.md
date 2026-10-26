# Git worktrees — устройство и контракт (Spec)

> **Назначение:** «как устроено, точно и полно» — модель записи, хранение, привязка сессии, containment,
> HTTP-контур, события, lifecycle, ограничения, UI и матрица тестов (класс **Spec** по
> [ARCH_DECISIONS.md](./ARCH_DECISIONS.md) §1). Решение — в
> [ADR-114](./arch_decisions/adr-114-git-worktrees.md); исходное предложение —
> [PROP-049](./arch_decisions/prop-049-git-worktrees.md); рабочий каталог и его политика —
> [ADR-075](./arch_decisions/adr-075-project-workspace-provisioning.md); реестр репозиториев и
> `repo_path` — [ADR-076](./arch_decisions/adr-076-git-repo-registry-ssh.md); исполнение команд —
> [docs/EXECUTION.md](./EXECUTION.md).
>
> **Статус документа:** контракт зафиксирован (ADR-114, 2026-10-26) и **реализован**
> (этап 1.4): порт `WorktreeRepository` + три backend'а, сервис worktrees (§2.4), привязка
> сессии с персистентностью (§3.4), резолв per-session cwd с fail-closed (§3.1–§3.3),
> тулы `git_worktree_*`, HTTP-контур (§5) и событие `worktree.updated` (§6), **UI** (§9) и
> **вызов sweep'а при старте** (§7.4). HTTP-часть вынесена в справочник API
> ([docs/API_V2.md](./API_V2.md) §5.40). Документ описывает устройство подсистемы; разделы
> «Статус в коде» в ADR-114 и этот блок статуса обновляются по мере реализации.

---

## 1. Модель данных

### 1.1. Запись `WorktreeRecord`

```json
{
  "id": "wkt_3f6c1a2b-9d4e-4f0a-8b7c-1e2d3c4b5a69",
  "projectId": "prj_7a1b...",
  "repoPath": "repos/app",
  "slug": "feature-refactor",
  "directory": "/var/synth/workspaces/.worktrees/prj_7a1b/feature-refactor",
  "branch": "feature/refactor",
  "baseRef": "main",
  "status": "created",
  "createdBy": "usr_42",
  "createdAt": "2026-10-26T09:12:03.114Z",
  "updatedAt": "2026-10-26T09:12:03.114Z",
  "setupScriptRun": true
}
```

| Поле | Тип | Смысл |
|---|---|---|
| `id` | `wkt_<uuid>` | идентификатор записи; ключ документа в PostgreSQL и в списке UI |
| `projectId` | `string` | проект-владелец записи (обязателен) |
| `repoPath` | `string?` | репозиторий проекта относительно `project.workspace` (как `repo_path` в ADR-076); отсутствует — репозиторий в корне workspace |
| `name` | `string` | человекочитаемое имя каталога (slug) внутри `.worktrees/<projectId>/`; в записи и в HTTP-теле — поле `name` |
| `directory` | `string` | абсолютный путь каталога worktree на диске |
| `branch` | `string` | ветка worktree (detached-состояние, `HEAD`, сервис не создаёт) |
| `baseRef` | `string?` | база ветки при создании (`main`/`master`/SHA) — входной параметр `from`, в записи не хранится |
| `status` | `created \| attached \| detached \| removed` | состояние записи — **вычисляется** сервисом, в записи не хранится (в сводке списка — `attachedSessionId`/`dirty`/`exists`, §5) |
| `createdBy` | `string?` | пользователь, создавший запись (аудит, не авторизация) |
| `createdAt` / `updatedAt` | ISO-8601 | `createdAt` **иммутабельно**; `updatedAt` ставит вызывающий (порт не подставляет «сейчас») |
| `setupScriptRun` | `boolean` | выполнялся ли `project.worktreeSetupScript` — в записи не хранится; итог операции — в ответе (`setup`, §7.6) |

> **Факт по коду (этап 1.4).** Запись, которую сегодня хранит порт, — **финальная форма**:
> `id`, `projectId`, `repoPath?`, `directory`, `branch`, `name` (slug каталога), `strategy`
> (`git`), `createdAt`, `updatedAt`, `createdBy?` — итого **девять полей плюс два необязательных**.
> Отличия от таблицы выше (их закрывает сервис, §2.4):
> - имя каталога в записи — **`name`**, а не `slug` (в HTTP-теле — тоже `name`);
> - полей жизненного цикла (`baseRef`, `status`, `setupScriptRun`) в записи **нет**: состояние
>   **вычисляется** сервисом (привязанная сессия — `attachedSessionId` в сводке, «грязное»
>   состояние — `dirty`, наличие каталога — `exists`), база ветки (`from`) — входной параметр
>   создания, признак выполнения startup-скрипта — результат операции (`setup` в ответе);
> - стратегия записи — **`strategy: 'git'`** (задел на другие стратегии, ADR-114 §5).

### 1.2. Инварианты

1. `id` уникален в пределах инстанса; формат `wkt_<uuid>`.
2. `name` соответствует `^[a-z0-9][a-z0-9._-]{0,63}$` (предел — 64 символа); уникален **в
   пределах проекта** — коллизия разрешается детерминированным суффиксом `-2`, `-3`, … (до 20
   попыток, дальше — `WORKTREE_PATH_EXISTS`); `..`, `/`, абсолютные пути и пробелы запрещены.
3. `directory` — абсолютный путь, **строго** внутри `{workspacesRoot}/.worktrees/<projectId>/`;
   по построению (корень — `join(workspacesRoot, '.worktrees', projectId)`, имя — slug);
   симлинк-aware проверка — на уровне containment'а file/shell/git-тулов (§4).
4. `branch` непустая, без пробелов, без `..` и без символов `~`, `^`, `:`, `?`, `*`, `[`, `\`
   (`isValidWorktreeBranch`); detached-состояния (`HEAD`) сервис не создаёт — всегда создаётся
   или переиспользуется ветка.
5. `repoPath` — относительный путь внутри `project.workspace` (либо отсутствует); абсолютный путь и `..`
   запрещены — как `repo_path` в ADR-076.
6. Состояние записи **вычисляется**, а не хранится: привязанная сессия — `attachedSessionId` в
   сводке списка, каталог на месте — `exists`, незакоммиченные изменения — `dirty`. Сама запись
   переживает исчезновение каталога (её чистит `prune`/sweep, §7.3–§7.4).
7. `createdAt` не меняется никогда; `updatedAt` — только вперёд.

### 1.3. Привязка сессии

```ts
Session.worktree?: {
  worktreeId: string;
  projectId: string;
  repoPath?: string;
  directory: string;
  branch: string;
};
```

Поле **аддитивное** (ADR-089/ADR-075 — сессии, созданные до ADR-114, его не имеют, и работают как
прежде). Значение — снимок на момент привязки: `directory` и `branch` копируются из записи, чтобы
резолв cwd не требовал чтения порта на каждом ходу; актуальность записи проверяется при операциях
(удаление/перенос).

> **Форма в API и в хранилище.** Внутри ядра привязка — объект `SessionWorktree` (camelCase, как
> выше). В **ответах API** (`GET`/`PATCH /api/v2/sessions/:id`) и в **форме хранения** сессии
> (файловый стор, PostgreSQL) поле сериализуется в **snake_case**:
> `{ worktree_id, project_id, repo_path, directory, branch }`; у сессии без привязки — `null`.
> `repo_path` — `null`, если репозиторий в корне workspace.

---

## 2. Хранение

### 2.1. Порт

`WorktreeRepository` (ADR-096) — доменный порт в `packages/core/src/storage/ports/`:

| Метод | Смысл |
|---|---|
| `save(record)` | upsert по `id` (полная перезапись записи; `createdAt` иммутабельно, `updatedAt` — из записи) |
| `get(id)` | запись по `id`; отсутствующая — `null` |
| `list(filter?: { projectId?: string })` | записи (свежие первыми по `createdAt`, тайбрейкер `id`); фильтр — по «И» |
| `delete(id)` | удаление записи; отсутствие — не ошибка (идемпотентно) |
| `deleteByProject(projectId)` | удаление всех записей проекта; возвращает число удалённых (prune/снятие проекта) |

### 2.2. Реализации

| Backend | Файл/таблица | Детали |
|---|---|---|
| Файловый (default) | `{dataDir}/worktrees.json` | JSON-коллекция (`{ "schemaVersion": 1, "worktrees": [...] }`) — тот же слой, что `{dataDir}/questions.json` (ADR-112): атомарная запись tmp→rename (ADR-005), каталог создаётся при первой записи; отсутствие файла — пустой репозиторий, повреждённый JSON — понятная ошибка, а не тихий пустой список |
| In-memory | `packages/core/src/storage/memory/` | герметичные тесты; тот же контракт, что у файловой реализации |
| PostgreSQL | таблица `documents`, `kind='worktree'` | **существующий** generic-слой `documents(kind, key, value jsonb)`: `kind` — свободный текст (CHECK-ограничений нет), поэтому **новая миграция не требуется** — расширяется лишь список `kind` в драйвере |

> **Факт по коду:** таблица `documents` заведена миграцией `001-init` (`packages/storage-postgres/src/migrations/001-init.ts`)
> как `PRIMARY KEY (kind, key)`; драйвер использует её через `createDocumentPort`
> (`packages/storage-postgres/src/ports/principals-documents.ts`) для `providers`/`models`/`agents`
> и напрямую — для worktree'ов (`packages/storage-postgres/src/ports/worktrees.ts`, ключ — `id`
> записи, значение — запись целиком). Для **записей** worktree миграция `023` не нужна; для
> **привязки сессии** — нужна (`023_session_worktree`, §3.4).

### 2.3. Контрактный suite

`packages/core/src/storage/contract/worktree-repository.contract.ts` — обязателен, как для любого порта
(ADR-096): upsert по `id`, неизменность `createdAt`, фильтр по `projectId`, идемпотентность `delete`,
`deleteByProject` (число и фактическое удаление), пустой репозиторий на чистом backend'е, «редкая»
запись (без необязательных полей) читается без потерь. Прогон против живой БД — тот же гейт
`SYNTH_TEST_POSTGRES_DSN`. Подключён к трём прогонам: `contract/file.test.ts`,
`contract/memory.test.ts`, `contract/postgres.test.ts`.

### 2.4. Сервис worktree'ов (слой поведения)

`WorktreeService` (`packages/core/src/engine/worktree/service.ts`) — единственное место, где живёт
поведение вокруг записи: git-операции, lifecycle, детект secondary worktree, startup-скрипт.

| Ответственность | Как сделано |
|---|---|
| Исполнение git | **только через порт** `ExecutionPort` (`git/exec.ts`, ADR-077): argv без shell, `requires: ['git']`; в remote-режиме команды уходят исполнителю |
| Запись инвентаря | **только через порт** `WorktreeRepository` (ADR-096) — сервис не пишет в `{dataDir}/worktrees.json` напрямую |
| Корень каталогов | `{workspacesRoot}/.worktrees/<projectId>` (`rootFor`); имя каталога — slug, коллизия → суффикс `-2`, `-3`, … (до 20 попыток) |
| Создание | `git worktree add` (с `-b <branch> <from>`, если база задана и существует; база не найдена → `WORKTREE_GIT_FAILED`, fail-closed) → запись → startup-скрипт (§7.6) |
| Удаление | проверка привязки сессии → проверка «грязности» → `git worktree remove` (+ `--force`) → `git worktree prune` → удаление записи |
| Prune | удаление **только** записей без каталога + `git worktree prune` (каталоги без записей не трогаются) |
| Детект secondary | `git rev-parse --git-common-dir` / `--git-dir` / `--show-toplevel`; ошибка git → `isSecondary: false` (ход не ломается) |

Сервис **не знает** про транспорт и про сессии: об изменении инвентаря он сообщает вызывающему
через `onUpdated(projectId, { worktreeId?, action })` (событие публикует тот, кто знает про шину,
ADR-024), а привязанную сессию получает через хук `resolveAttachedSession(worktreeId)`.

---

## 3. Привязка сессии и резолв cwd

### 3.1. Приоритет `_resolveWorkingDir`

| # | Источник | Условие | Поведение |
|---|---|---|---|
| 1 | `session.worktree.directory` | у сессии есть привязка **и** каталог существует | рабочий каталог сессии = каталог worktree |
| 2 | `project.workspace` | проект есть, workspace задан | прежнее поведение (ADR-075) |
| 3 | `defaultWorkingDir` | ни проектного workspace, ни привязки | `env SYNTH_DEFAULT_WORKSPACE` > `config storage.defaultWorkspace` > `{DATA}/workspaces/default` |

### 3.2. Исчезнувший каталог — fail-closed

Если у сессии есть привязка, но `session.worktree.directory` на диске отсутствует:

- ход **не** стартует с подменой каталога — резолв возвращает ошибку с i18n-ключом
  (`worktree.directory_missing`), модель получает текст через `shared/i18n` (ADR-041);
- тихий фоллбек в `project.workspace` **запрещён**: он переносил бы правки сессии в чужое дерево и
  создавал бы расхождение между «каталогом сессии» и тем, что агент видит в промпте;
- запись в реестре при этом остаётся (её чистит `prune`/sweep, §7.4).

### 3.3. Наследование саб-агентами

Саб-агент, созданный тулом `task` (ADR-111), **наследует привязку родителя**: резолв рабочего
каталога дочерней сессии читает привязку родителя (по `parentId`). Наследование **одноуровневое**
(читается ровно одна сессия-родитель, без рекурсии) и **наследуется, а не копируется**: поле
`session.worktree` в дочерней сессии не появляется — ребёнок может получить собственную привязку
позже (тогда она и станет приоритетной). Наследование означает «тот же рабочий каталог», а не
«свой worktree»: отдельный worktree саб-агенту не выдаётся — это осознанно (иначе каждый
саб-агент плодил бы ветки и каталоги). Фоновая сессия (ADR-111) наследует так же.

### 3.4. Где хранится привязка

В самой сессии (`Session.worktree`) — переживает рестарт и не зависит от доступности порта при
чтении. Сериализация привязки **реализована**:

- файловый стор сессий (`SerializedSession`, `packages/core/src/storage/file-store.ts`) — поле
  `worktree` в **snake_case** (`worktree_id`/`project_id`/`repo_path`/`directory`/`branch`);
- PostgreSQL — колонка `sessions.worktree jsonb`, **миграция `023_session_worktree`**
  (`packages/storage-postgres/src/migrations/023-session-worktree.ts`); миграция идемпотентна
  (`IF NOT EXISTS`).

При переносе сессии в другой проект (`project_attach`/`project_create`, ADR-014) привязка
**снимается**: worktree принадлежит проекту, и чужая привязка дала бы сессии каталог вне её
проекта. Снятие видно в событии `session.moved` (`worktree_detached: true`) и в ответе тула
(`worktree_detached` в metadata); при смене проекта через `PATCH /api/v2/sessions/:id` — в
событии `worktree.updated` с `action: 'detached'`.

---

## 4. Containment

### 4.1. Что разрешено

| Операция | База отсчёта | Правило |
|---|---|---|
| file-тулы (`read_file`, `write_file`, `list_directory`, `glob`, …) | каталог worktree | относительные пути — только внутри; абсолютные — как сейчас, с проверкой `protected-paths` |
| `execute_shell` | каталог worktree | `cwd` команды — каталог worktree (или его подкаталог) |
| git-тулы | каталог worktree | `repo_path` — только `.` или пусто |
| `repo_path` внутри worktree | каталог worktree | `.`/пусто — корень worktree; абсолютный путь или `..` → ошибка `git.repo_path_invalid` (ADR-076) |

### 4.2. Что запрещено

- Выход за пределы каталога worktree через `..`, абсолютный путь или симлинк наружу — fail-closed
  (существующая логика `isInsideReal`/`resolveRealPath`, ADR-075/ADR-077).
- Политика `workspaceOutsideRoot` (ADR-075) к worktrees **не применяется**: их корень внутри
  `workspacesRoot` по построению, исключений и подтверждений не требуется.
- В remote-режиме исполнитель проверяет `cwd` дополнительно (ADR-077, `resolveContainedCwd`): каталог
  worktree обязан лежать внутри `SYNTH_EXECUTOR_WORKSPACE`; иначе — `cwd_outside_workspace`. Отсюда
  требование к split-деплою: `workspacesRoot` и корень исполнителя — **один и тот же** каталог (общий
  RWX-том, ADR-077).

### 4.3. Коды ошибок

| Код | Где | Когда |
|---|---|---|
| `git.repo_path_invalid` | git-тулы | `repo_path` — абсолютный путь или `..` внутри worktree |
| `worktree.directory_missing` | резолв cwd | каталог привязанного worktree исчез (fail-closed) |
| `WORKTREE_NOT_FOUND` | HTTP/тулы | записи нет (или она чужого проекта) |
| `WORKTREE_DIRTY` | HTTP `DELETE` | есть незакоммиченные изменения, нужен `force` (в теле ответа — `error.forceRequired: true`) |
| `WORKTREE_BUSY` | HTTP `DELETE` | запись привязана к живой сессии |
| `WORKTREE_GIT_FAILED` | HTTP/тулы | команда git завершилась ошибкой (в т.ч. несуществующая база ветки) |
| `WORKTREE_NOT_A_REPO` | HTTP | указанный путь не git-репозиторий или у проекта нет рабочего каталога |
| `WORKTREE_PATH_EXISTS` | HTTP | свободного имени каталога не нашлось (20 попыток) |
| `WORKTREE_BRANCH_INVALID` / `WORKTREE_NAME_INVALID` | тулы | недопустимая ветка/имя — по HTTP **недостижимы** (валидация тела даёт `400 VALIDATION_ERROR`), живут в `metadata.worktree_error` ответа тула |

---

## 5. HTTP API

Все маршруты — под префиксом `/api/v2`. Доступ к проекту проверяется **на границе** (инвариант 16):
внутри обработчиков проверок доступа нет.

| Метод | Путь | Тело | Ответ |
|---|---|---|---|
| `GET` | `/api/v2/projects/:id/worktrees` | — | `200 { worktrees: WorktreeSummary[] }` |
| `POST` | `/api/v2/projects/:id/worktrees` | `{ branch?, name?, repoPath?, from? }` (`worktreeCreateSchema`) | `201 { worktree: WorktreeRecord, setup?: { ok, exitCode?, error? } }` |
| `DELETE` | `/api/v2/projects/:id/worktrees/:wid?force=true` | — (тело не читается) | `204` (пусто) |
| `POST` | `/api/v2/projects/:id/worktrees/prune` | отсутствует/пустое; непустое — строгая схема | `200 { recordsRemoved: number, gitPruned: boolean }` |
| `PATCH` | `/api/v2/sessions/:id` | `{ worktreeId: string \| null }` | `200` — обновлённая сессия |

**Записи в ответах — camelCase** (`id`, `projectId`, `repoPath?`, `directory`, `branch`, `name`,
`strategy`, `createdAt`, `updatedAt`, `createdBy?`); сводка списка добавляет **вычисляемые** поля
`attachedSessionId?`, `dirty?`, `exists?` (в порт они не пишутся, §1.1). Поле `setup` в ответе
`POST` присутствует **только** если у проекта задан `worktreeSetupScript` (§7.6).

**Привязка сессии** — наоборот, в **snake_case** (§1.3): `GET /api/v2/sessions/:id` отдаёт поле
`worktree` (`{ worktree_id, project_id, repo_path, directory, branch }` или `null`).

> **Имена полей HTTP-тела** (реализовано, схемы в `packages/shared/src/types/worktree.ts`): имя
> каталога — **`name`** (не `slug`), база ветки — **`from`** (не `baseRef`). Валидация: `name` —
> slug `^[a-z0-9][a-z0-9._-]{0,63}$`, `branch` — без пробелов/`..`/`~`/`^`/`:`/`?`/`*`/`[`/`\`,
> `repoPath` — относительный путь без `..`. Тело prune — **строгая** схема: лишнее поле →
> `400 VALIDATION_ERROR` (пустое тело — успех).

### 5.1. Права

| Операция | Право |
|---|---|
| `GET` (список) | право **чтения** проекта: владелец, любой участник, `LEAD`, `ADMIN` |
| `POST`/`DELETE`/`prune` | право **изменения содержимого** проекта: `OWNER`, `EDITOR`, `LEAD`, `ADMIN` (инвариант 21 — `VIEWER` только читает и получает 403) |
| `PATCH /api/v2/sessions/:id` | доступ к сессии по правилам prefix-guard'а (`server/session-access-guard.ts`): владелец, `ADMIN`/`LEAD`, участник проекта с правом изменения содержимого; чужая сессия — 404, а не 403 |

Матрица доступа (владелец / `EDITOR` / `VIEWER` / `ADMIN` / `LEAD` / посторонний) — тест
`packages/backend/src/routes/worktree-access-matrix.test.ts`: проверяет production-модуль и снимает
перечень маршрутов со **смонтированного** приложения (появился `:id`-маршрут — тест красный).

### 5.2. Коды ответов

| Код | Когда |
|---|---|
| `200` | список, prune, успешный `PATCH` сессии |
| `201` | создан worktree |
| `204` | worktree удалён (тело пустое) |
| `400` `VALIDATION_ERROR` | невалидное тело (`name`/`branch`/`repoPath`/`from`), лишнее поле в теле prune; `worktreeId` — не строка и не `null`; у сессии нет проекта; сервис привязки недоступен в этом инстансе |
| `400` `WORKTREE_NOT_A_REPO` | путь не git-репозиторий или у проекта нет рабочего каталога |
| `403` `FORBIDDEN` | нет права изменения содержимого проекта (`VIEWER`) |
| `404` `NOT_FOUND` | нет проекта или сессии |
| `404` `WORKTREE_NOT_FOUND` | записи worktree нет (или она чужого проекта — факт существования не выдаётся) |
| `409` `WORKTREE_DIRTY` | удаление с незакоммиченными изменениями без `force` (в теле — `error.forceRequired: true`) |
| `409` `WORKTREE_BUSY` | удаление worktree, привязанного к живой сессии |
| `409` `WORKTREE_GIT_FAILED` | команда git завершилась ошибкой (в т.ч. база ветки не найдена) |
| `409` `WORKTREE_PATH_EXISTS` | не нашлось свободного имени каталога |
| `409` `WORKTREE_DIRECTORY_MISSING` | привязка к worktree, у которого нет каталога на диске (`PATCH /api/v2/sessions/:id`) |

Машинные коды `WORKTREE_BRANCH_INVALID`/`WORKTREE_NAME_INVALID` **по HTTP недостижимы**: тело
валидируется Zod-схемой (`400 VALIDATION_ERROR`). Они живут в `metadata.worktree_error` ответов
тулов `git_worktree_*`.

Привязка сессии резолвится **под локом сессии** (`SessionManager.withLock`): запись ищется в
проекте сессии **после** возможного переноса сессии в другой проект — иначе параллельный перенос
привязал бы worktree прежнего проекта.

> **HTTP-часть вынесена в справочник API:** [docs/API_V2.md](./API_V2.md) §5.40 — права,
> коды ответов и событие `worktree.updated`. Полный контракт подсистемы — здесь (§5),
> решение — [ADR-114](./arch_decisions/adr-114-git-worktrees.md).

---

## 6. События

Событие публикуется в **существующей** шине (ADR-024) — новых транспортных каналов не заводим.

| Тип | Канал | Данные |
|---|---|---|
| `worktree.updated` | каналы **всех сессий проекта** (инвентарь — ресурс проекта, а не одной сессии) | `{ project_id, worktree_id?, action }`, где `action` ∈ `created \| removed \| pruned \| attached \| detached` |

Payload — в **snake_case** (как остальные события шины): `project_id` — проект-владелец инвентаря,
`worktree_id` — конкретная запись (нет — для prune/sweep), `action` — что произошло. Минимальный
контракт события — `{ project_id }`: по нему UI перечитывает инвентарь проекта и **инвалидирует
дерево Files** (структура каталогов изменилась). `action` позволяет отличить создание от
удаления/привязки, не читая инвентарь.

Публикация ограничена **200 сессиями** проекта (`WORKTREE_EVENT_MAX_SESSIONS`): событие — сигнал
«перечитай инвентарь», а не поток данных, поэтому перебор каналов не должен блокировать публикацию
в проекте с тысячами сессий.

Создание и удаление worktree меняют файлы на диске, поэтому дополнительно публикуется
`fs.changed { scope: 'all' }` (существующий механизм ADR-089/ADR-024) — так дерево Files и открытые
редакторы перечитывают рабочее дерево.

Действия и их источники:

| `action` | Когда |
|---|---|
| `created` | создан worktree (`POST /api/v2/projects/:id/worktrees`, тул `git_worktree_create`) |
| `removed` | worktree удалён (`DELETE …`, тул `git_worktree_remove`) |
| `pruned` | вычищены записи без каталога (`POST …/prune`, тул `git_worktree_prune`) |
| `attached` | сессия привязана к worktree (`PATCH /api/v2/sessions/:id { worktreeId }`) |
| `detached` | привязка снята (тот же `PATCH` с `worktreeId: null`; перенос сессии в другой проект) |

---

## 7. Lifecycle и retention

### 7.1. Состояния

```
created ──привязка сессии──▶ attached ──отвязка──▶ detached
   │                            │                    │
   └──────────удаление──────────┴────────────────────┘
                        ▼
                     removed (запись удалена)
```

- **created** — запись создана, каталог на месте (`git worktree add` завершился успешно).
- **attached** — на запись ссылается хотя бы одна живая сессия.
- **detached** — привязок нет, каталог на месте.
- **removed** — каталог снят (`git worktree remove`), запись удалена.

> Состояния — **концептуальные**: отдельного поля `status` в записи нет (§1.2), их вычисляет
> сервис — по привязанной сессии (`attachedSessionId` в сводке списка) и наличию каталога (`exists`).

### 7.2. Удаление

- Есть **незакоммиченные изменения** → `409 WORKTREE_DIRTY`: нужен явный `?force=true`
  (`git worktree remove --force`). Молчаливая потеря изменений недопустима; в теле ответа —
  `error.forceRequired: true`.
- Запись **привязана к живой сессии** → `409 WORKTREE_BUSY` (даже с `force`): сначала отвязать
  сессию (`PATCH /api/v2/sessions/:id { worktreeId: null }`).
- Ошибка git → `409 WORKTREE_GIT_FAILED` (текст git — в сообщении).
- Иначе → `204`, запись удаляется, каталог снимается.

### 7.3. Prune

`POST /api/v2/projects/:id/worktrees/prune` — удаляет **только записи, у которых каталога уже нет**
(запись осиротела: каталог удалили вручную, `git worktree prune` убрал его). Выполняется
`git worktree prune` (чистка метаданных в общем `.git`) и удаление соответствующих записей.
Ответ — `{ recordsRemoved: number, gitPruned: boolean }`; `gitPruned: false` — репозиторий
недоступен (записи всё равно вычищены). Каталоги без записей не трогаются: worktree, созданный
вручную внутри `.worktrees/<projectId>/`, — собственность пользователя.

### 7.4. Sweep на старте

Сервис умеет вычищать осиротевшие записи (`sweepOrphans()`): записи, чей каталог отсутствует,
удаляются (иначе UI показывал бы несуществующие worktree, а удаление — падало бы с «нет каталога»);
живые записи не трогаются, sweep **не** удаляет каталоги — только записи.

**Вызов подключён при старте процесса** (ADR-114 §7.4): общий хук
`startWorktreeSweeper(service)` (`packages/core/src/engine/worktree/sweep.ts`) вызывается из
`packages/core/src/server/app/deps.ts` (standalone) и `packages/backend/src/app/deps.ts`
(managed) — сразу после сборки `WorktreeService` и порта инвентаря.

Характер запуска — **фоновый, best-effort**:

- старт процесса **не блокируется** (обещание sweep'а не ожидается);
- ошибка sweep **не роняет старт** — уходит в лог (`warning`, без стектрейсов и секретов);
- в деградированном режиме хранилища (ADR-098) сервиса worktree'ов нет — вычищать нечего,
  хук не вызывается.

Sweep одноразовый: повторный запуск в том же процессе не нужен (достаточно `prune` проекта,
§7.3, и ручного вызова).

### 7.5. Автоудаления при архивации сессии — нет

Worktree переживает сессию: архивирование, закрытие или удаление сессии **не** удаляет worktree (и каталог,
и ветку). Чистка — только явным действием (`DELETE`) или `prune`. Причина: worktree часто переиспользуется
следующей сессией того же проекта, а необратимое удаление ветки/каталога — пользовательское решение.

### 7.6. Startup-скрипт проекта

Опциональный `project.worktreeSetupScript` — команда, выполняемая **один раз при создании
worktree** (по образцу opencode). Исполнение — через `ExecutionPort` (ADR-077); в remote-режиме
команда уходит исполнителю. Аргументы/шелл — по конфигурации проекта.

| Параметр | Значение |
|---|---|
| Рабочий каталог | каталог созданного worktree |
| Окружение | `SYNTH_WORKTREE_BASE` — **корень worktree'ов проекта** (`{workspacesRoot}/.worktrees/<projectId>`); `SYNTH_WORKTREE_PATH` — каталог нового worktree |
| Таймаут | 5 минут |
| Вывод | пишется в лог порта исполнения; итог — в ответе операции (`setup.ok`/`setup.exitCode`/`setup.error`) |
| Повтор | скрипт выполняется только в операции создания; для новой записи — снова |

Сбой скрипта **не** удаляет созданный worktree: ошибка уходит в лог и в ответ операции
(`setup.ok = false`), запись остаётся.

---

## 8. Ограничения: что worktree НЕ изолирует

1. **Общий `.git`.** Worktree — вторичная рабочая копия: refs, hooks, конфиг, индексы и **stash**
   общие с основным репозиторием. `git stash` одного пользователя виден другому; хук `pre-commit`
   (PROP-037) должен работать в каждом worktree (общий hook — выполняется везде, но проверки и конфиг —
   на проект).
2. **Ветка занята в другом worktree.** `git checkout` такой ветки **падает** — это защита git'а, а не
   Synth. Обход — отдельная ветка или `git worktree move`.
3. **Ignored-файлы не копируются.** `.env`, `node_modules`, артефакты сборки в новом worktree
   отсутствуют: их готовит `project.worktreeSetupScript` (§7.6).
4. **Worktree — не граница безопасности.** Два участника одного проекта, работающие в разных worktree,
   всё равно делят refs и hooks. Изоляция секретов остаётся на уровне политики workspace (ADR-075) и
   per-agent SSH-ключей (ADR-076).
5. **Требования к git.** `git worktree` — начиная с git 2.5; в remote-режиме важна версия git в
   окружении исполнителя (ADR-077).
6. **Один репозиторий — одна основная копия.** Основная копия остаётся в `project.workspace`; worktree —
   производная. Основная копия не удаляется вместе с worktree.

---

## 9. UI-поведение

> ✅ **Реализовано** (этап 1.4, коммит `f216b01b`). Ниже — фактическое поведение UI; контракт
> API — §5 и [docs/API_V2.md](./API_V2.md) §5.40.

Инвентарь, привязка и индикатор живут в **правой панели** (не в модалке настроек): раздел
«Worktrees» — в вкладке «Проект» (`components/panels/ProjectTab.tsx`,
`data-testid="project-worktrees"`), селектор рабочего каталога — в вкладке «Сессия»
(`components/panels/SessionSettingsTab.tsx`, `data-testid="session-worktree-select"`), индикатор —
в шапке (`components/layout/Header.tsx`).

### 9.1. Инвентарь (вкладка «Проект»)

| Элемент | Поведение |
|---|---|
| Список | имя каталога, ветка (моноширинный бейдж), бейджи состояния: «изменения» (`dirty`), «нет каталога» (`exists === false`), «привязан» (есть привязанная сессия); в раскрытой строке — имя привязанной сессии |
| Создание | форма «Ветка» + «Имя каталога» (оба необязательны — сервер подберёт свои); `POST /api/v2/projects/:id/worktrees` |
| Привязка | «Привязать» / «Отвязать» — привязка **текущей** сессии к записи (`PATCH /api/v2/sessions/:id { worktreeId }`) |
| Очистка | «Очистить» → prune: удаляются записи без каталога + `git worktree prune` (`POST …/worktrees/prune`), с подтверждением |
| Удаление | «Удалить» → `DELETE …/worktrees/:wid`; **двухшаговое подтверждение** (ниже) |

Пустые состояния и ошибки показаны текстом (`worktrees.empty`, `worktrees.loadError`); действия
подтверждаются через `confirm()` (`lib/confirm.ts` + `ConfirmDialog`), а не `window.confirm`.

### 9.2. Двухшаговое подтверждение при `forceRequired`

Удаление грязного worktree (есть незакоммиченные изменения) требует явного `force`
(ADR-114 §7.2), поэтому UI делает **два шага**:

1. первый `confirm` — «Удалить worktree?»; запрос уходит **без** `force`;
2. сервер отвечает `409 WORKTREE_DIRTY` с признаком `error.forceRequired: true` (домен
   `lib/api/worktrees.ts` его не глотает, а пробрасывает);
3. второй `confirm` — «удалить вместе с незакоммиченными изменениями?»; только после согласия
   запрос повторяется с `?force=true`.

Отказ на любом шаге ничего не удаляет.

### 9.3. Селектор «Рабочий каталог» (вкладка «Сессия»)

Список: «Каталог проекта» (привязки нет — рабочий каталог = `project.workspace`, ADR-075) и
worktree'ы проекта (`<имя> · <ветка>`). Смена значения → `PATCH /api/v2/sessions/:id
{ worktreeId }`; ответ — обновлённая сессия, стор обновляет снимок привязки
(`session.worktree`, snake_case), поэтому шапка показывает актуальный worktree без
дополнительного запроса. Сессия без проекта — текст «в проекте нет worktree'ов» (привязка
недоступна). Инвентарь перечитывается при монтировании селектора.

### 9.4. Индикатор в шапке

Пока у активной сессии есть привязка, в шапке — бейдж «worktree: `<имя>` · `<ветка>`»
(desktop и mobile). Имя берётся из инвентаря проекта по `worktree_id`; если записи ещё нет в
загруженном инвентаре — **фоллбэк** на имя каталога на диске. Клик по бейджу открывает правую
панель на вкладке «Проект» (на телефоне — дровер панели).

### 9.5. Дерево Files

Каталог `.worktrees` **скрыт всегда** — и при `showHidden` (`stores/filesStore.ts`,
`ALWAYS_HIDDEN_ENTRIES`): вторичные копии репозитория — служебные каталоги, а не содержимое
рабочего дерева проекта. Правило действует и при перечитывании дерева по `fs.changed`.

### 9.6. Live-обновление

| Событие | Реакция UI |
|---|---|
| `worktree.updated` | инвентарь проекта перечитывается (`worktreesStore.refresh`) — событие это сигнал «перечитай», а не поток данных |
| `fs.changed` | область инвалидации **пробрасывается** в `filesStore.scheduleRefresh` (`scope`/`paths`/`workspace_changed`/`op`): жёсткий `scope: 'all'` здесь ломал бы учёт `fileRevisions`/`deletedFiles` (регресс закрыт тестом) |

### 9.7. Мобильный вариант

Без DnD (ADR-044): селектор и переключение — обычным списком/диалогом, touch-таргеты ≥ 40 px.
Правило — CSS `.worktrees-panel` (`packages/ui/src/styles/index.css`): кнопки, поля и `select`
секции worktree'ов не ниже `--control-height-touch` в зонах телефон/планшет и при
coarse-указателе.

> **Индикатор secondary worktree** (ADR-114 §6, §8) в UI **не выводится**: определение
> «вторичная копия» требует `git rev-parse --git-common-dir` на стороне сервера, а в UI есть
> только снимок привязки. Честная граница — работа с общим `.git` описана в §8 и в подсказке
> панели; автоматического определения secondary worktree в UI нет.

---

## 10. Матрица тестов

### 10.1. Счастливый путь

1. Создание worktree (`POST`) → `201`, запись в реестре, каталог на диске, ветка создана.
2. Список (`GET`) → запись видна; фильтр по проекту отсекает чужие.
3. Привязка сессии → `PATCH /api/v2/sessions/:id { worktreeId }` → рабочий каталог сессии = каталог
   worktree (проверка через резолв cwd).
4. Саб-агент (`task`) наследует привязку.
5. Отвязка → в сводке пропадает `attachedSessionId`, событие `worktree.updated { action: 'detached' }`.
6. Удаление → `204`, каталога нет, записи нет.
7. `prune` удаляет запись без каталога и не трогает живые.
8. Startup-скрипт выполняется при создании, получает `SYNTH_WORKTREE_BASE` (корень worktree'ов
   проекта) и `SYNTH_WORKTREE_PATH` (каталог worktree), его вывод — в логе; сбой не удаляет запись.
9. Remote-режим: команда уходит исполнителю, `cwd` — каталог worktree (ADR-077, контрактный suite порта).

### 10.2. Негативная матрица

| Сценарий | Ожидание |
|---|---|
| `name` (slug) с `..`, `/`, пробелами, абсолютным путём | `400 VALIDATION_ERROR` |
| `name` длиннее 64 символов или с недопустимыми символами | `400 VALIDATION_ERROR` |
| `branch` с пробелами, `..` или запрещёнными символами (`~^:?*[\`) | `400 VALIDATION_ERROR` |
| `repoPath` абсолютный или с `..` | `400 VALIDATION_ERROR` |
| Лишнее поле в теле prune | `400 VALIDATION_ERROR` |
| `worktreeId` — не строка и не `null` | `400 VALIDATION_ERROR` |
| Привязка к worktree, у которого нет каталога | `409 WORKTREE_DIRECTORY_MISSING` |
| Дубль имени в проекте | имя разрешается суффиксом `-2`; исчерпание попыток → `409 WORKTREE_PATH_EXISTS` |
| Ветка уже занята в другом worktree | `409 WORKTREE_GIT_FAILED` (текст git'а) |
| Удаление с незакоммиченными изменениями без `force` | `409 WORKTREE_DIRTY` (+ `error.forceRequired: true`) |
| То же с `?force=true` | `204` |
| Удаление worktree, привязанного к живой сессии | `409 WORKTREE_BUSY` |
| `repo_path` = абсолютный путь или `..` внутри worktree | `git.repo_path_invalid` |
| Каталог привязанного worktree удалён вручную | резолв cwd → fail-closed `worktree.directory_missing`, **без** фоллбэка в `project.workspace` |
| Выход за каталог worktree через `..`/симлинк | fail-closed (существующая логика containment) |
| Права: `VIEWER` на `POST`/`DELETE`/`prune` | `403 FORBIDDEN` |
| Права: `VIEWER` на `GET` | `200` (только чтение) |
| Права: посторонний (не участник проекта) на `GET`/`POST` | `403 FORBIDDEN` (существование не выдаётся) |
| IDOR: `worktreeId` чужого проекта в `DELETE` | `404 WORKTREE_NOT_FOUND` |
| IDOR: `worktreeId` чужого проекта в `PATCH /api/v2/sessions/:id` | `404 WORKTREE_NOT_FOUND` |
| IDOR: `sessionId` чужой сессии в `PATCH` | `404 NOT_FOUND` (prefix-guard сессий) |
| `plan`-режим: `git_worktree_create`/`remove`/`prune` | deny (группа `git_write`, ADR-029); `git_worktree_list` — allow |
| Порядок маршрутов: `POST /worktrees/prune` vs `DELETE /worktrees/:wid` | статический сегмент `prune` объявлен раньше параметрического (методы разные — конфликта нет) |
| Контракт порта: file / memory / PostgreSQL | одинаковая семантика (upsert, фильтры, идемпотентность) |

---

## Связи

- [ADR-005](./arch_decisions/adr-005-json-storage.md), [ADR-014](./arch_decisions/adr-014-project-container.md),
  [ADR-024](./arch_decisions/adr-024-eventhub-transport.md), [ADR-029](./arch_decisions/adr-029-granular-permissions.md),
  [ADR-044](./arch_decisions/adr-044-mobile-adaptive-ui-pwa.md), [ADR-075](./arch_decisions/adr-075-project-workspace-provisioning.md),
  [ADR-076](./arch_decisions/adr-076-git-repo-registry-ssh.md), [ADR-077](./arch_decisions/adr-077-runtime-toolchain.md),
  [ADR-096](./arch_decisions/adr-096-storage-layer.md), [ADR-111](./arch_decisions/adr-111-background-subagent-sessions.md),
  [PROP-037](./arch_decisions/prop-037-commit-security-step.md),
  [PROP-049](./arch_decisions/prop-049-git-worktrees.md), [ADR-114](./arch_decisions/adr-114-git-worktrees.md).

## История

- 2026-10-26 — документ создан вместе с [ADR-114](./arch_decisions/adr-114-git-worktrees.md): модель
  записи и порт, привязка сессии и приоритет резолва cwd, containment, HTTP-контур, событие
  `worktree.updated`, lifecycle (удаление/`force`, `prune`, sweep, startup-скрипт), ограничения
  (общий `.git`, ignored-файлы, «worktree — не граница безопасности»), UI-поведение и матрица тестов.
- 2026-10-26 — этап 1.4.1a (контракт и хранение): реализованы тип `WorktreeRecord` + Zod-схемы
  (`worktreeRecordSchema`/`worktreeCreateSchema`/`worktreePruneSchema`), порт
  `WorktreeRepository` (`save`/`get`/`list`/`delete`/`deleteByProject`), файловая
  (`{dataDir}/worktrees.json`), in-memory и PostgreSQL (`documents`, `kind='worktree'`, без новой
  миграции) реализации и контрактный suite (file/memory/PG). Уточнены имена полей: `name`
  (вместо `slug`), `from` (вместо `baseRef`), `strategy`; добавлен `deleteByProject`; сортировка
  списка — по `createdAt`. Поля жизненного цикла (`baseRef`/`status`/`setupScriptRun`) — с сервисом.
- 2026-10-26 — этап 1.4 (поведение): реализованы сервис worktrees (`engine/worktree/service.ts`: git-операции через `ExecutionPort`, lifecycle, детект secondary, startup-скрипт), привязка сессии с персистентностью (файловый стор + миграция PG `023_session_worktree`), резолв per-session cwd (fail-closed, наследование саб-агентом), тулы `git_worktree_list|create|remove|prune`, HTTP-контур (`/api/v2/projects/:id/worktrees*`, `PATCH /api/v2/sessions/:id { worktreeId }`), событие `worktree.updated` + `fs.changed`, матрица доступа. Уточнены контракты: сводка списка — camelCase с вычисляемыми `attachedSessionId`/`dirty`/`exists`, привязка сессии и payload события — snake_case, `prune` → `{ recordsRemoved, gitPruned }`, коды ошибок — `WORKTREE_*` (вместо `FORCE_REQUIRED`/`CONFLICT`), `SYNTH_WORKTREE_BASE` — корень worktree'ов проекта. Остаток — UI (§9) и вызов sweep'а на старте (§7.4).
- 2026-10-26 — этап 1.4 (закрытие): реализован **UI** (§9 переписан по факту: инвентарь в
  правой панели, селектор рабочего каталога, индикатор в шапке, скрытие `.worktrees` в дереве
  Files, двухшаговое подтверждение при `forceRequired`, мобильный вариант, реакция на
  `worktree.updated`/`fs.changed`) и **вызов sweep'а при старте** (§7.4 — общий хук
  `startWorktreeSweeper`, фоново и без падения старта, в core и backend). HTTP-часть вынесена в
  [docs/API_V2.md](./API_V2.md) §5.40; §5 больше не отмечает отставание спеки API.

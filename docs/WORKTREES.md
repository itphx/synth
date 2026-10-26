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
> **Статус документа:** контракт зафиксирован (ADR-114, 2026-10-26); **реализовано хранение**
> (этап 1.4.1a): тип `WorktreeRecord` + Zod, порт `WorktreeRepository`, файловая/in-memory/
> PostgreSQL-реализации и контрактный suite. **Поведения ещё нет**: сервис worktrees, резолв
> `session.worktree.directory` в `_resolveWorkingDir`, тулы `git_worktree_*`, HTTP-роуты, событие
> `worktree.updated` и UI — следующие шаги. Документ описывает целевое устройство; разделы
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
| `slug` | `string` | человекочитаемое имя каталога внутри `.worktrees/<projectId>/` |
| `directory` | `string` | абсолютный путь каталога worktree на диске |
| `branch` | `string` | ветка (`HEAD` — detached-состояние) |
| `baseRef` | `string?` | база ветки при создании (`main`/`master`/SHA) |
| `status` | `created \| attached \| detached \| removed` | состояние записи (см. §7) |
| `createdBy` | `string?` | пользователь, создавший запись (аудит, не авторизация) |
| `createdAt` / `updatedAt` | ISO-8601 | `createdAt` **иммутабельно**; `updatedAt` ставит вызывающий (порт не подставляет «сейчас») |
| `setupScriptRun` | `boolean` | выполнялся ли `project.worktreeSetupScript` для этой записи |

> **Что реализовано на шаге 1.4.1a (контракт хранения).** Запись, которую сегодня хранит порт:
> `id`, `projectId`, `repoPath?`, `directory`, `branch`, `name` (slug каталога), `strategy`
> (`git`), `createdAt`, `updatedAt`, `createdBy?` — итого **девять полей плюс два необязательных**.
> Отличия от таблицы выше (их закрывает сервис и тулы — шаг 1.4.2):
> - имя каталога в записи — **`name`**, а не `slug` (в HTTP-теле — тоже `name`);
> - поля жизненного цикла (`baseRef`, `status`, `setupScriptRun`) в записи **пока отсутствуют** —
>   они появляются вместе с сервисом (`status` — вычисляемое состояние, `baseRef` — база ветки,
>     `setupScriptRun` — признак выполнения startup-скрипта);
> - стратегия записи — **`strategy: 'git'`** (задел на другие стратегии, ADR-114 §5).

### 1.2. Инварианты

1. `id` уникален в пределах инстанса; формат `wkt_<uuid>`.
2. `slug` соответствует `^[a-z0-9][a-z0-9-]{0,63}$`; уникален **в пределах проекта**; `..`, `/`,
   абсолютные пути и пробелы запрещены.
3. `directory` — абсолютный путь, **строго** внутри `{workspacesRoot}/.worktrees/<projectId>/`; проверка
   — лексическая **и** symlink-aware (по образцу `isInsideReal`/`resolveRealPath`, ADR-075/ADR-077).
4. `branch` проходит `git check-ref-format`; допускается `HEAD` (detached).
5. `repoPath` — относительный путь внутри `project.workspace` (либо отсутствует); абсолютный путь и `..`
   запрещены — как `repo_path` в ADR-076.
6. `status` соответствует фактическому состоянию: `attached` — есть хотя бы одна живая привязка сессии,
   `detached` — привязок нет, каталог на месте, `removed` — запись удалена (в списке не хранится).
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
> записи, значение — запись целиком). Миграция `023` не нужна.

### 2.3. Контрактный suite

`packages/core/src/storage/contract/worktree-repository.contract.ts` — обязателен, как для любого порта
(ADR-096): upsert по `id`, неизменность `createdAt`, фильтр по `projectId`, идемпотентность `delete`,
`deleteByProject` (число и фактическое удаление), пустой репозиторий на чистом backend'е, «редкая»
запись (без необязательных полей) читается без потерь. Прогон против живой БД — тот же гейт
`SYNTH_TEST_POSTGRES_DSN`. Подключён к трём прогонам: `contract/file.test.ts`,
`contract/memory.test.ts`, `contract/postgres.test.ts`.

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

Саб-агент, созданный тулом `task` (ADR-111), **наследует привязку родителя**: в дочерней сессии
`session.worktree` = привязка родителя (тот же `worktreeId`, тот же каталог). Наследование означает
«тот же рабочий каталог», а не «свой worktree»: отдельный worktree саб-агенту не выдаётся — это
осознанно (иначе каждый саб-агент плодил бы ветки и каталоги). Фоновая сессия (ADR-111) наследует так же.

### 3.4. Где хранится привязка

В самой сессии (`Session.worktree`) — переживает рестарт и не зависит от доступности порта при чтении.
При переносе сессии в другой проект (`project_attach`, ADR-014) привязка **снимается**: worktree
принадлежит проекту, и чужая привязка дала бы сессии каталог вне её проекта.

> **Остаток реализации (важно).** Поле `Session.worktree` добавлено в контракт (`shared`,
> шаг 1.4.1a), но его **сериализация** в портах сессий — ещё нет: файловый стор
> (`SerializedSession`) и PostgreSQL-драйвер перечисляют поля явно, поэтому привязка пока
> **не переживает рестарт**. Пункт обязателен для шага сервиса/тулов: без него резолв cwd после
> рестарта молча ушёл бы в `project.workspace` — ровно тот сценарий, который ADR-114 запрещает.

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
| `worktree.not_found` | HTTP/тулы | записи нет (или она чужого проекта) |
| `FORCE_REQUIRED` | HTTP `DELETE` | есть незакоммиченные изменения, нужен `force` |
| `WORKTREE_BUSY` | HTTP `DELETE` | запись привязана к живой сессии |

---

## 5. HTTP API

Все маршруты — под префиксом `/api/v2`. Доступ к проекту проверяется **на границе** (инвариант 16):
внутри обработчиков проверок доступа нет.

| Метод | Путь | Тело | Ответ |
|---|---|---|---|
| `GET` | `/api/v2/projects/:id/worktrees` | — | `200 { worktrees: WorktreeRecord[] }` |
| `POST` | `/api/v2/projects/:id/worktrees` | `{ name?, branch?, repoPath?, from? }` (`worktreeCreateSchema`) | `201 { worktree: WorktreeRecord }` |
| `DELETE` | `/api/v2/projects/:id/worktrees/:wid` | `{ force?: boolean }` (или query `?force=true`) | `204` (пусто) |
| `POST` | `/api/v2/projects/:id/worktrees/prune` | — (`worktreePruneSchema`: параметров нет) | `200 { removed: string[] }` (id удалённых записей) |
| `PATCH` | `/api/v2/sessions/:id` | `{ worktreeId: string \| null }` | `200` — обновлённая сессия |

> **Имена полей HTTP-тела** (реализовано на шаге 1.4.1a, схема `worktreeCreateSchema` в
> `packages/shared/src/types/worktree.ts`): имя каталога — **`name`** (не `slug`), база ветки —
> **`from`** (не `baseRef`). Валидация: `name` — slug `^[a-z0-9][a-z0-9._-]{0,63}$`, `branch` —
> без пробелов/`..`/`~`/`^`/`:`/`?`/`*`/`[`/`\`, `repoPath` — относительный путь без `..`.

### 5.1. Права

| Операция | Право |
|---|---|
| `GET` (список) | право **чтения** проекта: владелец, любой участник, `LEAD`, `ADMIN` |
| `POST`/`DELETE`/`prune` | право **изменения содержимого** проекта: `OWNER`, `EDITOR`, `LEAD`, `ADMIN` (инвариант 21 — `VIEWER` только читает и получает 403) |
| `PATCH /api/v2/sessions/:id` | доступ к сессии по правилам prefix-guard'а (`server/session-access-guard.ts`): владелец, `ADMIN`/`LEAD`, участник проекта с правом изменения содержимого; чужая сессия — 404, а не 403 |

### 5.2. Коды ответов

| Код | Когда |
|---|---|
| `200` | список, prune, успешный `PATCH` сессии |
| `201` | создан worktree |
| `204` | worktree удалён (тело пустое) |
| `400` `VALIDATION_ERROR` | невалидный `slug`/`branch`/`repoPath`, неизвестное тело |
| `403` `FORBIDDEN` | нет права изменения содержимого проекта (`VIEWER`) |
| `404` `NOT_FOUND` | нет проекта, записи или сессии; запись чужого проекта — тоже 404 (факт существования не выдаётся) |
| `409` `FORCE_REQUIRED` | удаление с незакоммиченными изменениями без `force` |
| `409` `WORKTREE_BUSY` | удаление worktree, привязанного к живой сессии |
| `409` `CONFLICT` | каталог/ветка уже существует (slug занят, ветка уже занята в другом worktree) |

Ответы на `POST`/`GET` содержат **схему записи** `WorktreeRecord` (§1.1) — тот же контракт, что и в
UI, и в тулах.

> При реализации те же эндпоинты описываются в `docs/API_V2.md` (§5.x — раздел проектных
> ресурсов); здесь — полный контракт, чтобы спека API и ADR не расходились.

---

## 6. События

Событие публикуется в **существующей** шине (ADR-024) — новых транспортных каналов не заводим.

| Тип | Канал | Данные |
|---|---|---|
| `worktree.updated` | канал действующей сессии (как `project.updated`, ADR-014) | `{ projectId, worktreeId?, action }`, где `action` ∈ `created \| removed \| pruned \| attached \| detached` |

Минимальный контракт события — `{ projectId }`: по нему UI перечитывает инвентарь проекта и **инвалидирует
дерево Files** (структура каталогов изменилась). Дополнительные поля — для точечного обновления строки
инвентаря.

Создание и удаление worktree меняют файлы на диске, поэтому дополнительно публикуется
`fs.changed { scope: 'all' }` (существующий механизм ADR-089/ADR-024) — так дерево Files и открытые
редакторы перечитывают рабочее дерево.

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

### 7.2. Удаление

- Есть **незакоммиченные изменения** → `409 FORCE_REQUIRED`: нужен явный `force: true`
  (`git worktree remove --force`). Молчаливая потеря изменений недопустима.
- Запись **привязана к живой сессии** → `409 WORKTREE_BUSY`: сначала отвязать сессию
  (`PATCH /api/v2/sessions/:id { worktreeId: null }`).
- Иначе → `204`, запись удаляется, каталог снимается.

### 7.3. Prune

`POST /api/v2/projects/:id/worktrees/prune` — удаляет **только записи, у которых каталога уже нет**
(запись осиротела: каталог удалили вручную, `git worktree prune` убрал его). Выполняется
`git worktree prune` (чистка метаданных в общем `.git`) и удаление соответствующих записей. Ответ —
`{ removed: string[] }`.

### 7.4. Sweep на старте

При старте инстанса выполняется sweep осиротевших записей: записи, чей каталог отсутствует, удаляются
(иначе UI показывал бы несуществующие worktree, а удаление — падало бы с «нет каталога»). Живые записи не
трогаются; sweep **не** удаляет каталоги — только записи.

### 7.5. Автоудаления при архивации сессии — нет

Worktree переживает сессию: архивирование, закрытие или удаление сессии **не** удаляет worktree (и каталог,
и ветку). Чистка — только явным действием (`DELETE`) или `prune`. Причина: worktree часто переиспользуется
следующей сессией того же проекта, а необратимое удаление ветки/каталога — пользовательское решение.

### 7.6. Startup-скрипт проекта

Опциональный `project.worktreeSetupScript` — команда, выполняемая **один раз** после создания worktree
(по образцу opencode). Исполнение — через `ExecutionPort` (ADR-077), argv/шелл по конфигурации проекта.

| Параметр | Значение |
|---|---|
| Рабочий каталог | каталог worktree |
| Окружение | `SYNTH_WORKTREE_BASE` — каталог основного репозитория; `SYNTH_WORKTREE_PATH` — каталог worktree |
| Таймаут | ограничение команды (как у прочих команд через порт) |
| Вывод | пишется в лог команды; итог — в ответе тула/операции |
| Повтор | не выполняется повторно для той же записи (признак `setupScriptRun`) |

Сбой скрипта **не** удаляет созданный worktree: ошибка уходит в лог и в ответ операции, запись остаётся.

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

| Точка входа | Поведение |
|---|---|
| Настройки проекта → «Worktrees» | инвентарь проекта (как «Workspaces» в opencode): slug, ветка, статус, число привязанных сессий; действия — создать, удалить (с подтверждением `force`), prune |
| Создание сессии | селектор worktree проекта (если инвентарь непуст); по умолчанию — основной каталог проекта |
| Шапка сессии | текущий worktree + **индикатор secondary worktree** (бейдж: каталог — вторичная копия, общий `.git`) |
| Дерево Files | каталог `.worktrees` **скрыт** — исключение на сервере (даже при `includeHidden=true`), плюс исключение из поиска/глоба по файлам |
| Переключение | смена привязки сессии — `PATCH /api/v2/sessions/:id { worktreeId }`; UI перечитывает дерево по событию `worktree.updated` |

Мобильный вариант (ADR-044): без DnD — селектор и переключение списком/диалогом, touch-таргеты ≥ 40 px.

---

## 10. Матрица тестов

### 10.1. Счастливый путь

1. Создание worktree (`POST`) → `201`, запись в реестре, каталог на диске, ветка создана.
2. Список (`GET`) → запись видна; фильтр по проекту отсекает чужие.
3. Привязка сессии → `PATCH /api/v2/sessions/:id { worktreeId }` → рабочий каталог сессии = каталог
   worktree (проверка через резолв cwd).
4. Саб-агент (`task`) наследует привязку.
5. Отвязка → `status` записи `detached`.
6. Удаление → `204`, каталога нет, записи нет.
7. `prune` удаляет запись без каталога и не трогает живые.
8. Sweep на старте удаляет осиротевшую запись.
9. Startup-скрипт выполняется один раз, получает `SYNTH_WORKTREE_BASE`/`SYNTH_WORKTREE_PATH`, его вывод
   в логе; повторный вызов не выполняет.
10. Remote-режим: команда уходит исполнителю, `cwd` — каталог worktree (ADR-077, контрактный suite порта).

### 10.2. Негативная матрица

| Сценарий | Ожидание |
|---|---|
| `slug` с `..`, `/`, пробелами, абсолютным путём | `400 VALIDATION_ERROR` |
| `slug` длиннее 64 символов или с недопустимыми символами | `400 VALIDATION_ERROR` |
| `branch`, не проходящая `git check-ref-format` | `400 VALIDATION_ERROR` |
| `repoPath` абсолютный или с `..` | `400 VALIDATION_ERROR` |
| Дубль `slug` в проекте | `409 CONFLICT` |
| Ветка уже занята в другом worktree | `409 CONFLICT` (ошибка git'а) |
| Удаление с незакоммиченными изменениями без `force` | `409 FORCE_REQUIRED` |
| То же с `force: true` | `204` |
| Удаление worktree, привязанного к живой сессии | `409 WORKTREE_BUSY` |
| `repo_path` = абсолютный путь или `..` внутри worktree | `git.repo_path_invalid` |
| Каталог привязанного worktree удалён вручную | резолв cwd → fail-closed `worktree.directory_missing`, **без** фоллбэка в `project.workspace` |
| Выход за каталог worktree через `..`/симлинк | fail-closed (существующая логика containment) |
| `.worktrees` в дереве Files | отсутствует (даже при `includeHidden=true`) и в выдаче поиска |
| Права: `VIEWER` на `POST`/`DELETE` | `403 FORBIDDEN` |
| Права: `VIEWER` на `GET` | `200` (только чтение) |
| Права: посторонний (не участник проекта) на `GET`/`POST` | `404`/`403` по правилам проекта (существование не выдаётся) |
| IDOR: `worktreeId` чужого проекта в `DELETE` | `404 NOT_FOUND` |
| IDOR: `sessionId` чужой сессии в `PATCH` | `404 NOT_FOUND` (prefix-guard сессий) |
| `plan`-режим: `git_worktree_create`/`remove`/`prune` | deny (группа `git_write`, ADR-029); `git_worktree_list` — allow |
| Порядок маршрутов: `POST /worktrees/prune` vs `DELETE /worktrees/:wid` | статический сегмент `prune` объявлен раньше параметрического |
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

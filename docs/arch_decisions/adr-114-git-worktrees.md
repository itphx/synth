# ADR-114: Git worktrees — per-session рабочий каталог

> **Статус:** ⚠️ Частично — решение принято 2026-10-26; **реализовано хранение** (тип `WorktreeRecord`,
> порт `WorktreeRepository` и три backend'а — файл/память/PostgreSQL, контрактный suite), **остаток —
> поведение** (в коде нет ни тулов `git_worktree_*`, ни HTTP-контура, ни привязки сессии к worktree).
> **Дата:** 2026-10-26
> **Связано:** [ADR-014](./adr-014-project-container.md) (проект как контейнер сессий),
> [ADR-029](./adr-029-granular-permissions.md) (группы правил permission-слоя),
> [ADR-075](./adr-075-project-workspace-provisioning.md) (рабочий каталог и политика `workspaceOutsideRoot`),
> [ADR-076](./adr-076-git-repo-registry-ssh.md) (реестр репозиториев, `repo_path`, SSH-ключи),
> [ADR-096](./adr-096-storage-layer.md) (порты слоя хранения),
> [ADR-077](./adr-077-runtime-toolchain.md) (исполнение команд через `ExecutionPort`, исполнитель),
> [PROP-049](./prop-049-git-worktrees.md) (исходное предложение),
> [PROP-037](./prop-037-commit-security-step.md) (security-step перед коммитом — должен работать в каждом worktree);
> дополнительно: [ADR-024](./adr-024-eventhub-transport.md) (транспорт событий),
> [ADR-005](./adr-005-json-storage.md) (атомарная запись), [ADR-044](./adr-044-mobile-adaptive-ui-pwa.md) (мобильный UI).
> Спецификация подсистемы — [docs/WORKTREES.md](../WORKTREES.md).

## Контекст

Один проект — один `project.workspace` и один git-репозиторий на диске. Параллельная работа нескольких
сессий (или саб-агентов) над одним репозиторием конфликтует по рабочим файлам и индексу: правки одной
сессии видны другой, `git checkout` переключает ветку под ногами соседней сессии, а `_resolveWorkingDir`
(ADR-075) знает только `project.workspace` → `defaultWorkingDir` — своего каталога у сессии нет.
`git worktree` даёт каждой сессии изолированный рабочий каталог с общей историей, но в Synth его нет:
вхождений `worktree` в `packages/**` — **0**. Разделить «рабочий каталог» и «репозиторий» нужно ещё и
потому, что сегодня каталог сессии = каталог проекта, а это разные сущности.

## Решение

1. **Корень worktrees — внутри корня workspace:** `{workspacesRoot}/.worktrees/<projectId>/<slug>`.
   Причина: `cwd` команд исполнителя ограничен корнем его workspace (`SYNTH_EXECUTOR_WORKSPACE`,
   `resolveContainedCwd`, ADR-077), а политика `workspaceOutsideRoot` (ADR-075) не должна получать
   исключений. Следствие для split-режима: `workspacesRoot` и корень исполнителя обязаны указывать на
   один и тот же каталог (общий RWX-том) — иначе worktree-каталоги окажутся вне containment'а
   (`cwd_outside_workspace`). Каталог `.worktrees` **скрывается** из дерева Files и из поиска по файлам;
   в git-статус проекта он не попадает (репозиторий лежит в `project.workspace`, worktree — вне его; если
   корни совпадают — `.worktrees/` добавляется в `.gitignore` проекта).
2. **Инвентарь — доменный порт.** `WorktreeRepository` (ADR-096) и запись `WorktreeRecord`; файл
   `{dataDir}/worktrees.json` (атомарная запись tmp→rename, ADR-005), в-памяти и PostgreSQL — через
   существующий generic `DocumentRepository<T>` (таблица `documents`, `kind='worktree'`), **без новой
   миграции**. Контрактный suite порта обязателен, как для любого порта.
3. **Привязка сессии — аддитивное поле** `Session.worktree?: { worktreeId, projectId, repoPath?, directory, branch }`.
   Приоритет `_resolveWorkingDir`: `session.worktree.directory` → `project.workspace` → `defaultWorkingDir`.
   Саб-агенты **наследуют** привязку родителя. Исчезнувший каталог worktree — **fail-closed** с
   i18n-сообщением, а не тихий фоллбек в `project.workspace`: молчаливая подмена каталога переносила бы
   правки сессии в чужое дерево.
4. **Containment считается от каталога сессии.** File/shell/git-тулы и `repo_path` резолвятся от
   worktree-каталога; `repo_path` внутри worktree допускается только `.`/пусто, абсолютный путь или `..` —
   ошибка `git.repo_path_invalid` (как сейчас, ADR-076). Политика `workspaceOutsideRoot` к worktrees не
   применяется — их корень внутри `workspacesRoot` по построению.
5. **Тулы** `git_worktree_list` (чтение), `git_worktree_create`, `git_worktree_remove`,
   `git_worktree_prune` — через существующий слой git (`gitExec`/`GitService`, ADR-077: argv через
   `ExecutionPort`, `requires: ['git']`), capability `git_read`/`git_write`, подчиняются permission-слою
   (ADR-029): в `plan`-режиме мутации запрещены. Валидация: `git check-ref-format` для ветки,
   уникальность каталога в пределах проекта, запрет `..` в slug.
6. **Детект secondary worktree** (`git rev-parse --git-common-dir` / `--show-toplevel`) и честное
   предупреждение в промпте: общий `.git` (refs, hooks, **stash**, конфиг), `git checkout` ветки, занятой
   в другом worktree, падает; ignored-файлы (`.env` и т.п.) в новый worktree **не** копируются.
7. **Lifecycle.** Удаление при незакоммиченных изменениях → `forceRequired` (409, требуется явный `force`);
   при активной привязке сессии — отказ 409; `prune` — только записи без каталога; на старте — sweep
   осиротевших записей; **автоудаления при архивации сессии нет**; опциональный
   `project.worktreeSetupScript` выполняется один раз после создания worktree (через `ExecutionPort`, env
   `SYNTH_WORKTREE_BASE`/`SYNTH_WORKTREE_PATH`, таймаут, вывод в лог) — по образцу opencode.
8. **API.** `GET/POST /api/v2/projects/:id/worktrees`, `DELETE /api/v2/projects/:id/worktrees/:wid`,
   `POST /api/v2/projects/:id/worktrees/prune`; привязка — `PATCH /api/v2/sessions/:id` (`worktreeId`).
   Права: чтение — право чтения проекта, запись — право изменения содержимого (`canEditProjectContent`;
   инвариант 21: `VIEWER` только читает). Событие — `worktree.updated { projectId }` в существующей шине
   (ADR-024), по нему UI инвалидирует дерево Files.
9. **UI.** Инвентарь worktrees в настройках проекта (как «Workspaces» в opencode), селектор worktree для
   новой сессии и в шапке сессии, индикатор secondary worktree, скрытие `.worktrees` в дереве Files,
   мобильный вариант без DnD (ADR-044).
10. **Ограничение честно: worktree — не граница безопасности** между пользователями одного проекта
    (общий `.git`, refs, hooks). Изоляция секретов остаётся на уровне политики workspace и ADR-076.

## Последствия и границы

- **Правило каталога общее для всех** — «рабочий каталог сессии = каталог worktree, если привязка есть».
  Это меняет смысл `repo_path` внутри worktree (только `.`), поэтому правило проверяется в одном месте
  (резолв `repo_path`), а не в каждом туле.
- **Worktree не изолирует состояние git.** Stash, refs, hooks и конфиг общие: `git stash` одного
  пользователя виден другому. Изоляция — только по рабочим файлам.
- **Секреты в `.env` не переезжают** в новый worktree: ignored-файлы не копируются — их готовит
  `project.worktreeSetupScript`.
- **Ветку нельзя занять дважды**: `git checkout` чужой ветки в другом worktree падает — это защита git'а,
  а не Synth.
- **Каталог worktree — зона выката**: удалённый каталог = потерянные незакоммиченные изменения, поэтому
  удаление требует явного `force`.

## Статус в коде

**Частично реализовано** (этап 1 roadmap 0.13 — блок 1.4.1a: контракт и хранение;
поведение — следующий шаг).

Реализовано:

- типы в `shared` (`packages/shared/src/types/worktree.ts`): `WorktreeRecord`,
  `WorktreeCreateInput`, `WorktreeSummary`, `SessionWorktree` + Zod-схемы
  (`worktreeRecordSchema`/`worktreeCreateSchema`/`worktreePruneSchema`); аддитивные поля
  `Session.worktree` и `Project.worktreeSetupScript`;
- порт `WorktreeRepository` (`core/src/storage/ports/worktree-repository.ts`) и три
  реализации: файловая (`{dataDir}/worktrees.json`), in-memory
  (`core/src/storage/memory/worktrees.ts`) и PostgreSQL (generic-таблица `documents`,
  `kind='worktree'`, **без новой миграции** — `packages/storage-postgres/src/ports/worktrees.ts`);
- контрактный suite порта (`core/src/storage/contract/worktree-repository.contract.ts`) —
  file/memory/PG.

Не реализовано (поведение): `_resolveWorkingDir` (`core/src/engine/orchestrator.ts`) знает только
`project.workspace` → `defaultWorkingDir`; git-тулы принимают `repo_path` относительно `project.workspace`
(`core/src/engine/tools/git.ts`); сервис worktrees; резолв `session.worktree.directory` в
`_resolveWorkingDir` и наследование привязки саб-агентами; тулы `git_worktree_*` и их правила
permission-слоя; HTTP-роуты (`/api/v2/projects/:id/worktrees*`, `PATCH /api/v2/sessions/:id` с
`worktreeId`); событие `worktree.updated`; UI (инвентарь в настройках проекта, селектор, индикатор,
скрытие `.worktrees`).

## Связи

- [ADR-005](./adr-005-json-storage.md), [ADR-014](./adr-014-project-container.md),
  [ADR-024](./adr-024-eventhub-transport.md), [ADR-029](./adr-029-granular-permissions.md),
  [ADR-044](./adr-044-mobile-adaptive-ui-pwa.md), [ADR-075](./adr-075-project-workspace-provisioning.md),
  [ADR-076](./adr-076-git-repo-registry-ssh.md), [ADR-077](./adr-077-runtime-toolchain.md),
  [ADR-096](./adr-096-storage-layer.md), [PROP-037](./prop-037-commit-security-step.md),
  [PROP-049](./prop-049-git-worktrees.md).

## История

- 2026-10-26 — решение принято (PROP-049 → ADR-114): корень worktrees внутри корня workspace,
  инвентарь доменным портом `WorktreeRepository`, привязка сессии аддитивным полем `Session.worktree`,
  containment от каталога сессии, тулы `git_worktree_*` через порт исполнения, HTTP-контур и событие
  `worktree.updated`, UI и честное ограничение «worktree — не граница безопасности».
- 2026-10-26 — этап 1.4.1a: реализованы контракт и хранение — тип `WorktreeRecord` (+ Zod),
  порт `WorktreeRepository`, файловая/in-memory/PostgreSQL-реализации и контрактный suite;
  поведение (сервис, тулы, резолв cwd, HTTP, событие, UI) — остаток.

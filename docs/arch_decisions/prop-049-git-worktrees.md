# PROP-049: Git worktrees

> ⚠️ **Принято как [ADR-114](./adr-114-git-worktrees.md) (2026-10-26).** Файл оставлен как история: правило каталога — файлы не удаляются (см. [ARCH_DECISIONS.md](../ARCH_DECISIONS.md) §3 «Формат ADR: заморозка на одну страницу»).

> **Статус:** ✅ Принято (ADR-114) — Git worktrees: тулы `git_worktree_*`, per-session cwd на базе worktree, детект secondary worktree, UI
> **Решение до:** 2026-11-14
> **Дата:** 2026-09-16
> **Источник:** перенесено из `AD-DRAFTS.md` (D4, идея 4 + Obsidian `Фичи.md`).
> **Связано:** [ADR-014](./adr-014-project-container.md), [ADR-029](./adr-029-granular-permissions.md),
> [PROP-037](./prop-037-commit-security-step.md), [ADR-044](./adr-044-mobile-adaptive-ui-pwa.md),
> [ADR-075](./adr-075-project-workspace-provisioning.md), [ADR-076](./adr-076-git-repo-registry-ssh.md),
> [ADR-114](./adr-114-git-worktrees.md) (принятое решение), [docs/WORKTREES.md](../../WORKTREES.md) (спецификация).

**Решение:** добавить поддержку `git worktree` как first-class возможности Synth: инструменты
`git_worktree_*` (add/list/remove/…), **per-session рабочий каталог (cwd)** на базе worktree, детект
secondary worktree и UI для отображения/переключения.

## Контекст

### Что уже есть

- `git worktree` в коде Synth **нет** (0 вхождений в `packages/**`).
- Рабочий каталог жёстко завязан на `project.workspace`: `_resolveWorkingDir` резолвит
  `project.workspace` → defaultWorkingDir (ADR-075). Git-инструменты работают с этим каталогом и принимают
  необязательный `repo_path` (containment внутри `project.workspace`, ADR-076).
- В мёртвом архиве `archive/synth-frontend` есть UI-заготовки (`WorktreeSectionContent.tsx`) — это
  OpenCode-слой (ADR-019), не переносится.

### Проблема

Один проект = один `project.workspace` и один git-репозиторий на диске. Параллельная работа нескольких
сессий/агентов над одним репозиторием конфликтует по файлам и индексу. `git worktree` даёт каждой сессии
изолированный рабочий каталог с общей историей, но Synth его не умеет: нет инструментов, нет per-session cwd,
нет UI.

## Детали

### Инструменты

- `git_worktree_add` / `git_worktree_list` / `git_worktree_remove` (+ при необходимости `move`/`prune`).
- Инструменты подчиняются permission-слою (ADR-029), containments — внутри `project.workspace`/worktree-корня;
  аргументы ветки/пути валидируются.

### Per-session рабочий каталог

- Сессия (или саб-агент) может быть привязана к своему worktree; file/shell/git-тулы сессии резолвят cwd в
  него. Требуется совместить это с `_resolveWorkingDir`, который сегодня знает только `project.workspace`.
- Определять, является ли каталог secondary worktree (через `git rev-parse --git-common-dir` /
  `--show-toplevel`), и корректно вести себя при операциях, затрагивающих общий `.git`.

### UI

- Отображение worktree проекта, переключение активного worktree сессии, индикатор secondary worktree.
- Учесть мобильный UI (ADR-044): DnD на тач-устройствах отключён — нужна touch-альтернатива.

### Безопасность и git-guard

- PROP-037 (security-step перед коммитом + git pre-commit hook) должен устанавливаться/работать **в каждом
  worktree** (общий `.git` — hook общий, но проверки/конфиг — на проект).

## Статус реализации в коде

**Не реализовано.**

Проверено точечным grep по `packages/**` (исключая `dist/`, `node_modules/`):

- Вхождений `worktree` — **нет**.
- Рабочий каталог резолвится через `project.workspace` → defaultWorkingDir; git-тулы используют
  `repo_path` (ADR-076), но per-session cwd/worktree отсутствует.

## Открытые вопросы

- per-session workspace vs единственный `project.workspace` — как совместить с `_resolveWorkingDir`?
- Изоляция permissions/секретов между worktree?
- Автоудаление worktree при закрытии сессии?

## Связи

- [ADR-014](./adr-014-project-container.md) «Проект как контейнер» — проект/сессии, к которым привязывается worktree.
- [ADR-075](./adr-075-project-workspace-provisioning.md) «Окружение проекта» — `project.workspace` и `_resolveWorkingDir`.
- [ADR-076](./adr-076-git-repo-registry-ssh.md) «Реестр git-репозиториев и SSH-ключи» — репозитории проекта, `repo_path`.
- [ADR-029](./adr-029-granular-permissions.md) «Гранулярные permissions» — права на worktree-инструменты.
- [PROP-037](./prop-037-commit-security-step.md) «Security step перед коммитом» — git-guard в каждом worktree.
- [ADR-044](./adr-044-mobile-adaptive-ui-pwa.md) «Мобильный UI + PWA» — touch-альтернатива переключению worktree.
- Смежные черновики: D19/PROP-064 (встроенный терминал), D20/PROP-065 (просмотр доков/планов).

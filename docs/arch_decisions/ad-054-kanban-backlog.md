# AD-054: Kanban-доска, backlog, управление проектами

> **Статус:** 🧩 Предложение — Kanban-доска поверх `project.plan` + глобальный backlog, assignee/WIP-лимиты
> **Решение до:** 2026-11-14
> **Дата:** 2026-09-16
> **Источник:** перенесено из `AD-DRAFTS.md` (D9, идея 9 + Roadmap «Kanban/Backlog», Obsidian `Фичи.md`).
> **Связано:** [AD-039](./ad-039-plan-in-project.md), [AD-033](./ad-033-session-branching-merge.md),
> [AD-044](./ad-044-mobile-adaptive-ui-pwa.md), [AD-065](./ad-065-ui-docs-plan-todo.md),
> [AD-051](./ad-051-scheduler-pipelines.md), [AD-040](./ad-040-sessions-without-project.md).

**Решение:** сделать **интерактивную Kanban-доску** поверх `project.plan` и **глобальный backlog вне проекта**:

- доска с drag & drop и inline-edit колонок/карточек (на базе `project.plan`);
- backlog — задачи вне конкретного проекта, с приоритизацией (**urgency/importance** или **MoSCoW**);
- назначение на агентов (**assignee**), **WIP-лимиты**, **fast-add**;
- превращение задачи в запрос к агенту.

## Контекст

### Что уже есть

- Модель `project.plan` (колонки, зависимости, приоритеты) + инструменты `plan_*`/`todo_*` (AD-039).
- UI-блок плана — **read-only**: `packages/ui/src/components/panels/ProjectTab.tsx` (`ProjectPlanBlock`
  только рендерит колонки/карточки).
- Роут плана: core-фабрика `packages/core/src/server/routes/projects.ts` принимает `plan` как
  `z.unknown()` (`planFieldSchema`) и **пишет** его в проект; backend монтирует core-фабрику.
- В прототипе t11 `.cline/kanban` пуст (`~/dev/aic/t11/.cline/kanban`).

> **Поправка к черновику (устарело):** в D9 сказано, что backend принимает `plan` как `z.unknown()`
> (`packages/backend/src/routes/projects.ts:18`), а core-роут плана **не пишет** (0 вхождений). На момент
> переноса в код это **не так**: схема `planFieldSchema = z.unknown()` и запись `plan` живут в **core**-фабрике
> (`packages/core/src/server/routes/projects.ts`), а backend — тонкая обёртка. Фактическое состояние — ниже.

### Проблема

Агент умеет вести план/ToDo, но человек не может управлять ими из UI: доска read-only, нет backlog вне проекта,
нет назначения на агентов/WIP-лимитов. Планирование и приоритизация остаются «в голове» пользователя и в
промптах агента, а не в интерфейсе.

## Детали

### Интерактивная доска

- Drag & drop карточек между колонками, inline-edit, fast-add; синхронизация с `project.plan` через API/WS
  (`plan.approved`, `todos.updated`).
- Правки отражаются в модели плана, которую видит агент ([AD-039](./ad-039-plan-in-project.md)).

### Backlog

- Глобальный backlog вне проекта (или per-user — открытый вопрос): задачи без привязки к проекту/сессии.
- Приоритизация: **urgency/importance** или **MoSCoW**; WIP-лимиты колонок.

### Назначение и запуск

- **Assignee** (агент/пользователь); превращение карточки в запрос к агенту (запуск сессии/промпта).
- Связь с шедулером ([AD-051](./ad-051-scheduler-pipelines.md)) — запуск задачи по расписанию/событию.

### Модель данных

- Расширять `project.plan` или вводить отдельную сущность `Task`? (открытый вопрос).
- Хранение — JSON/FileStore (AD-005) до PostgreSQL (AD-032).

### Мобильный UI

- На тач-устройствах DnD отключён ([AD-044](./ad-044-mobile-adaptive-ui-pwa.md)) — нужна touch-альтернатива
  (кнопки/меню перемещения).

## Статус реализации в коде

**Не реализовано.**

Проверено точечным grep по `packages/**` (исключая `dist/`, `node_modules/`):

- `ProjectPlanBlock` в `packages/ui/src/components/panels/ProjectTab.tsx` — read-only рендер (без DnD/inline-edit).
- `planFieldSchema = z.unknown()` и запись `project.plan` — в **core**-роуте
  `packages/core/src/server/routes/projects.ts` (backend проектов — обёртка над core-фабрикой).
- Отдельной сущности `Task`/backlog, assignee, WIP-лимитов, fast-add и связи с шедулером — нет.

> Пути/строки из черновика (`backend/src/routes/projects.ts:18`) устарели — логика плана перенесена в
> core-фабрику.

## Открытые вопросы

- Расширять `project.plan` или отдельная сущность `Task`?
- Backlog — глобальный или per-user?
- Хранить в JSON до AD-032?
- Как организовать touch-альтернативу DnD на мобильных ([AD-044](./ad-044-mobile-adaptive-ui-pwa.md))?

## Связи

- [AD-039](./ad-039-plan-in-project.md) «План в проекте, todo в сессии» — модель доски.
- [AD-033](./ad-033-session-branching-merge.md) «Ветвление сессий и слияние» — межсессионный контекст задач.
- [AD-040](./ad-040-sessions-without-project.md) «Сессии без проекта» — backlog вне проекта.
- [AD-065](./ad-065-ui-docs-plan-todo.md) «Просмотр документации, планов и ToDo в UI» — общий слой viewer/доска (D20).
- [AD-051](./ad-051-scheduler-pipelines.md) «Шедулер и пайплайны» — запуск задач по расписанию/событию.
- [AD-044](./ad-044-mobile-adaptive-ui-pwa.md) «Мобильный UI + PWA» — touch-альтернатива drag & drop.
- Смежные: D18/AD-063 (метрики/обучение — данные из задач), AD-005/AD-032 (хранение).

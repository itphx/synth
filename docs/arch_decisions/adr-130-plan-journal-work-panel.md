# ADR-130: Рабочая панель плана, ToDo, журнала и инвариантов

> **Статус:** ✅ Реализовано
> **Дата:** 2026-11-08
> **Источник:** PROP-054 (принят 2026-11-08)
> **Связано:** [ADR-039](./adr-039-plan-in-project.md), [ADR-014](./adr-014-project-container.md),
> [ADR-024](./adr-024-eventhub-transport.md), [ADR-044](./adr-044-mobile-adaptive-ui-pwa.md),
> [ADR-075](./adr-075-project-workspace-provisioning.md), [ADR-089](./adr-089-external-events-automation.md),
> [ADR-118](./adr-118-message-stream-v2.md), [ADR-096](./adr-096-storage-layer.md).

## Контекст

План проекта и ToDo в правой панели были read-only: план обрезался (`max-h-48`), колонки шли
вертикально, журнал и инварианты не редактировались, Markdown не поддерживался. HTTP-правка плана
шла целым `PUT /projects/:id` (`z.unknown()`), у ToDo HTTP-контура не было; события плана/журнала не
обновляли открытую панель.

## Решение

1. **UI.** Места вкладок не меняются: план/журнал/инварианты — «Проект», ToDo — «Сессия». Общий
   визуальный язык `TaskGroup`/`TaskRow`; в панели — компактные группы с раскрытием, plain-превью и
   «показать ещё»; полный рабочий контур — модальное окно `WorkModal` (доска, ToDo, журнал,
   инварианты, статистика).
2. **Markdown.** `plan.description`, `todo.content`, `journal.text`, `invariants` — Markdown;
   заголовки/статусы/приоритеты — структурные поля. Рендер — существующий `MarkdownContent`
   (`marked` + `DOMPurify`), plain-превью — `markdownToPlain`; редактор — вкладки
   «Редактор/Превью»; лимиты `invariants` 64 КиБ, `journal` 16 КиБ, `plan.description` 16 КиБ,
   `todo.content` 4 КиБ. В промпт модели Markdown встраивается с отступами продолжения.
3. **API.** Точечные эндпоинты плана (items/columns/order), ToDo (CRUD/order/clear), журнала
   (page/CRUD), инвариантов (get/put); zod-схемы в `@itphx/synth-shared`; `plan.version` →
   `409 PLAN_VERSION_CONFLICT` (UI — refetch + тост); `log` удалён из `GET /projects/:id`,
   единственный источник — страница `/log` (breaking; обновлены SDK/portable/fork). Для
   `remote:`-проектов/сессий запросы форвардятся на удалённый backend (RBAC/валидация — там).
4. **События.** `plan.updated` — во все сессии проекта (`{project_id, version}`);
   `project.updated {kind:'log'|'invariants'}`; `todos.updated` — в канал сессии. UI перечитывает
   деталь проекта, а не список; `loadProjects` не затирает открытую деталь.
5. **Инструменты.** `plan_write` + колонки/порядок; `todo_reorder`/`todo_clear`;
   `project_log_update`/`project_log_delete`; лимиты; многострочный Markdown.
6. **Границы.** Backlog, assignee и отдельная `Task` — вне решения (остаются в исходном видении
   PROP-054); publish проекта журнал не переносит (только портативный архив); авто-лента журнала
   не делается.

## Альтернативы

- Правка плана целым `PUT /projects/:id` — отвергнута: нет валидации, контроля версии и точечных правок.
- Канбан только в панели — отвергнута: узкая ширина и вложенный скролл.
- Авто-лента журнала вместо ручного — отложена (ручной журнал — решение владельца).
- Немедленный backlog/assignee/Task — отложено (scope 2026-11-07).

## Реализация

- **Core:** `engine/{plan,todo,project}`, `server/routes/project-plan|project-log|session-todos`,
  `serializeProjectArchive`, `remote/{client,transfer}`; события в каналы сессий проекта.
- **UI:** `components/panels/work/*`, `ProjectTab`, `SessionSettingsTab`, `projectLogStore`,
  `transportStore`, `projectsStore`.
- **SDK/docs:** новые типы/методы, `docs/API_V2.md` (RU/EN), `docs/TOOLS.md`, пакетные `AGENTS.md`.
- **Проверка:** `pnpm build`, `pnpm typecheck`, `pnpm lint`; тесты core/UI/backend/shared/sdk/executor/
  plugin-memory/storage-postgres; визуальная проверка dev (панель, доска, журнал, инварианты, ToDo).

## Последствия

- `log` больше не приходит в детали проекта — breaking change для клиентов; SDK/portable/fork обновлены.
- Новые контракты API и события закреплены тестами; RBAC — `canEditProjectContent` / write-доступ к сессии.
- Markdown-лимиты ограничивают размер промпта и ответа; инварианты — 64 КиБ.
- Publish проекта журнал не переносит; для полного переноса — портативный архив (ADR-091).

## История

- 2026-11-08 — принят из PROP-054; реализовано (волны 1–2) и remote-форвард.

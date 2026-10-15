# AD-065: Просмотр документации, планов и ToDo в UI

> **Статус:** 🧩 Предложение — Просмотр документации, планов и ToDo в UI: docs-браузер, редактор плана/todo, внешний vault
> **Решение до:** 2026-11-14
> **Дата:** 2026-09-16
> **Источник:** перенесено из `AD-DRAFTS.md` (D20, «Просмотр документации, планов и ToDo в UI (масштабно)»;
> идея пользователя 2026-09-16 + `Фичи.md` (Заметки)); состояние проверено по `packages/ui/`.
> **Связано:** [AD-019](./ad-019-react-spa.md), [AD-024](./ad-024-eventhub-transport.md),
> [AD-044](./ad-044-mobile-adaptive-ui-pwa.md), [AD-039](./ad-039-plan-in-project.md),
> [AD-014](./ad-014-project-container.md), [AD-054](./ad-054-kanban-backlog.md),
> [AD-047](./ad-047-memory-gbrain.md), [AD-069](./ad-069-project-instructions-agents-md.md).

**Решение:** сделать в UI **полноценный просмотр и навигацию** по документации проекта, планам
(`project.plan`) и ToDo сессий — не только read-only блоки, а:

- **Docs-браузер** — дерево, поиск, рендер документации проекта (`README`, `docs/`, AD,
  `AGENTS.md`, при желании — внешний vault Obsidian);
- **Редактор плана и ToDo** — правка из UI (сейчас состояние меняет только агент через инструменты);
- **Связи** — навигация `план ↔ todo ↔ сессия ↔ документ`;
- **Поиск** (в перспективе — RAG, [AD-047](./ad-047-memory-gbrain.md)).

## Контекст

### Что уже есть

- **Рендер markdown в чате** — `packages/ui/src/components/chat/MarkdownContent.tsx`.
- **План** — `packages/ui/src/components/panels/ProjectTab.tsx` (`PlanSection` → `ProjectPlanBlock`):
  колонки плана (`ProjectPlan`) рендерятся **read-only** (нет инлайн-редактирования плана).
- **ToDo** — `packages/ui/src/components/panels/SessionSettingsTab.tsx` (`Section sessionTab.todos.title`
  → `SessionTodosBlock`): список с статусами (`pending`/`in_progress`/`completed`/`cancelled`) и
  приоритетами (`high`/`medium`/`low`), **read-only**.
- **Обновление по WS** — `packages/ui/src/stores/transportStore.ts` обрабатывает `plan.approved`,
  `plan.updated`, `todos.updated` (полный refresh сессии с сервера).
- **Модель состояния** — `project.plan` и `session.todos`, менять только тулами `plan_*`/`todo_*`
  ([AD-039](./ad-039-plan-in-project.md), инвариант №11).
- **Проектные инструкции** — `AGENTS.md` и `/init` уже реализованы ([AD-069](./ad-069-project-instructions-agents-md.md)),
  есть `GET /api/v2/context/instructions` и событие `context.instructions_loaded`.

### Чего нет

- Отдельного **docs-браузера** нет (поиск `DocsBrowser`/`DocViewer`/`DocumentationViewer` — 0 вхождений).
- **Редактирования плана/todo из UI** нет — только просмотр.
- Связей/навигации между планом, todo, сессиями и документами нет.
- Полнотекстового поиска (RAG) нет.

## Детали

### 1. Docs-браузер

- Источник документов: репозиторий (`README`, `docs/`, AD) и/или внешний vault (Obsidian Bridge,
  [AD-047](./ad-047-memory-gbrain.md)). Требует договорённости о приоритете.
- Дерево + рендер (переиспользовать `MarkdownContent`), переходы по относительным ссылкам
  (в т. ч. на другие AD/`AGENTS.md`).
- Согласовать с панелями Files/Git левой панели и с контекст-ориентированными вкладками
  ([packages/ui/AGENTS.md](../../packages/ui/AGENTS.md)).

### 2. Редактирование плана и ToDo

- Сейчас состояние — только через инструменты агента. UI-редактирование должно идти через **API**
  (не прямое изменение JSON), с permissions ([AD-029](./ad-029-granular-permissions.md)) и публикацией
  тех же WS-событий (`plan.updated`/`todos.updated`), чтобы агент и UI не расходились.
- Нужны core-роуты записи плана/todo (сейчас план в backend принимается как `z.unknown()`;
  проверка D9 — требует перепроверки перед реализацией).
- Интерактивность (drag&drop колонок/карточек, inline-edit) пересекается с Kanban-доской
  ([AD-054](./ad-054-kanban-backlog.md)) — общий слой.

### 3. Связи и навигация

- Из плана — к задаче/сессии/документу; из документа — к плану/сессии.
- Связь с backlog ([AD-054](./ad-054-kanban-backlog.md)).

### 4. Поиск

- Первый этап — простой поиск по файлам/плану. Полнотекстовый/RAG — по мере готовности памяти
  ([AD-047](./ad-047-memory-gbrain.md)).

## Статус реализации в коде

**Не реализовано (в объёме AD); простой просмотр — есть.** Проверено по репозиторию
(`packages/**`, без `dist/`/`node_modules/`):

- `packages/ui/src/components/chat/MarkdownContent.tsx` — рендер markdown (используется в чате).
- `packages/ui/src/components/panels/ProjectTab.tsx` — `PlanSection`/`ProjectPlanBlock`; план
  рендерится по колонкам без редактирования.
- `packages/ui/src/components/panels/SessionSettingsTab.tsx` — `SessionTodosBlock`, todo со статусами
  и приоритетами, без редактирования.
- `packages/ui/src/stores/transportStore.ts` — обработка `plan.approved`/`plan.updated`/`todos.updated`.
- Отдельного docs-браузера нет; редактирования плана/todo из UI нет; связей план↔todo↔документ нет.
- Смежное и уже реализованное: `AGENTS.md`/`/init` и `GET /api/v2/context/instructions`
  ([AD-069](./ad-069-project-instructions-agents-md.md)) — можно переиспользовать как источник
  «проектных инструкций» для viewer.

## Открытые вопросы

- Источник доков — репозиторий или внешний vault Obsidian (или оба)? Приоритет?
- Редактирование из UI vs только агент? Если да — через какие роуты и с какими правами?
- Нужен ли полнотекстовый поиск (RAG) сразу или отдельным этапом?
- Как соотносится с Kanban-доской ([AD-054](./ad-054-kanban-backlog.md)) — один компонент или разные?
- Где рендерится документация — центр-таб, левая панель, отдельная вкладка?
- Как учитывать мобильный UI ([AD-044](./ad-044-mobile-adaptive-ui-pwa.md))?

## Связи

- [AD-019](./ad-019-react-spa.md) «React 19 SPA» — архитектура UI.
- [AD-024](./ad-024-eventhub-transport.md) «EventHub + TransportClient» — WS-события плана/todo.
- [AD-044](./ad-044-mobile-adaptive-ui-pwa.md) «Мобильный UI + PWA» — адаптив viewer.
- [AD-039](./ad-039-plan-in-project.md) «План — в проекте, todo — в сессии» — модель состояния.
- [AD-014](./ad-014-project-container.md) «Проект как контейнер» — источник документов проекта.
- [AD-054](./ad-054-kanban-backlog.md) «Kanban-доска, backlog» — интерактивная доска поверх плана;
  общий слой с viewer/редактором.
- [AD-047](./ad-047-memory-gbrain.md) «Память Synth / Obsidian Bridge» — внешний vault и RAG-поиск.
- [AD-069](./ad-069-project-instructions-agents-md.md) «Проектные инструкции (AGENTS.md)» — источник
  проектных инструкций для viewer.
- [AD-029](./ad-029-granular-permissions.md) «Гранулярные permissions» — права на правку из UI.
- [packages/ui/AGENTS.md](../../packages/ui/AGENTS.md) — панели, вкладки, Files/Git, конвенции.

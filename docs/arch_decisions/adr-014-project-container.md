# ADR-014: Проект как контейнер

> **Статус:** ✅ Реализовано
> **Источник:** перенесено из AGENTS.md (исторический ADR-014 прототипа переписан под as-built TS-стек)

**Решение:** `Project` — хранимая сущность-контейнер, группирующая сессии, файлы/рабочий каталог, инварианты, лог работ, статусные сообщения и план. Сессии ссылаются на проект через `session.projectId`; проект владеет общими для группы данными.

**Контекст:** прототип (ADR-014 в `archive/AGENTS_OLD.md`) ввёл `Project` как JSON-сущность с модульной структурой (`core/project/`: models, storage, manager), API `/api/projects` и admin-страницей. Обоснование — проекты нужны как контейнеры для группировки сессий, файлов, инвариантов и истории статусных сообщений. В TS-стеке модель сохранена и расширена: план переехал из сессии в проект (ADR-039), появился workspace и конфигурация репозиториев.

**Модель (as-built):**

```ts
interface Project {
  id: string;
  name: string;
  ownerId: string;
  members: Record<string, ProjectRole>;
  description: string;
  currentTask: string;
  invariants: string;               // инварианты проекта (project_invariants_*)
  icon?: string;
  color?: string;
  workspace?: string;               // рабочий каталог проекта (приоритетный для file/shell/git)
  repos?: GitRepoConfig[];          // репозитории проекта (list_repos, guard)
  statusMessages: StatusMessage[];  // история для status bar (info/warning/error/stream)
  plan?: ProjectPlan;               // kanban-план проекта (ADR-039)
  log?: ProjectLogEntry[];          // лог работ (project_log_write)
  createdAt: string;
  updatedAt: string;
}
```

**Состав контейнера:**

| Элемент | Реализация |
|---|---|
| Сессии | `session.projectId`; фильтр `GET /api/v2/sessions?projectId=`; перенос между проектами (`project_create`/`project_attach`, ADR-040) |
| Файлы / workspace | `project.workspace` — резолвится первым в `_resolveWorkingDir`; file/shell/git-инструменты работают в нём |
| Контекст | инварианты, лог работ, план проекта попадают в system prompt (ADR-039) |
| План | `project.plan` (kanban: колонки + пункты + зависимости) |
| Репозитории | `project.repos`, `list_repos`; guard безопасности ставится по ним (PROP-037 — не реализовано) |

**Реализация (as-built):**

| Компонент | Файл | Назначение |
|---|---|---|
| Тип `Project` | `packages/shared/src/types/index.ts` | модель проекта и вложенных сущностей (`ProjectPlan`, `StatusMessage`, `ProjectLogEntry`) |
| `ProjectStore` | `packages/core/src/storage/project-store.ts` | JSON-хранилище `projects/{id}.json` (атомарная запись, ADR-005) |
| Роуты проектов | `packages/core/src/server/routes/projects.ts`, `packages/backend/src/routes/projects.ts` | `GET/POST /api/v2/projects`, `GET/PUT/DELETE /api/v2/projects/:id` |
| Перенос/копия | `packages/core/src/server/routes/project-transfer.ts`, `packages/core/src/remote/transfer.ts` | publish/fork проекта с сессиями и файлами (гибрид, ADR-042) |
| Проектные инструменты | `packages/core/src/engine/tools/` | `get_project_info`, `list_repos`, `project_log_*`, `project_invariants_*`, `plan_*` |

**Связь:** ADR-039 (план — в проекте), ADR-040 (сессии без проекта / перенос между проектами), ADR-042 (publish/fork проекта).

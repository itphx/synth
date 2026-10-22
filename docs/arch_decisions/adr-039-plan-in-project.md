# ADR-039: План — в проекте, todo — в сессии, состояние через инструменты (замена TSM)

> **Статус:** ✅ Реализовано
> **Источник:** перенесено из AGENTS.md

**Решение:** вместо TSM-протокола прототипа (JSON-блок статуса + парсинг текста + отдельные промпты по состояниям) — модель, в которой:

- **План принадлежит проекту**, **todo — сессии**.
- Состояние/режим, план и todo управляются **инструментами** (`plan_*`, `todo_*`, переключение режима), а не JSON-блоком в ответе модели.
- Инструкции (когда планировать, как декомпозировать задачу в todo, когда предложить завести проект) — в системном промпте: роль агента + mode-промпты + контекстный блок сессии. Отдельного слоя TSM-промптов нет.

**Контекст:** AD-002 (собственная TSM) не оправдал себя в прототипе: валидация переходов была мёртвым кодом, JSON-блок хрупко парсился (regex, построчный fallback, видимый JSON в streaming), `next_state` отбрасывался. Тот же результат достигается надёжнее: режим (plan/act/yolo) — глобальный permission toggle (ADR-025), план и todo — структурированные данные под управлением инструментов.

**Модель данных:**

```ts
// Проект владеет планом (kanban-основа)
interface ProjectPlan {
  version: number;
  updatedAt: string;
  columns: PlanColumn[];   // колонки доски
  items: PlanItem[];       // пункты плана
}
interface PlanColumn { id: string; name: string; order: number; wipLimit?: number }
interface PlanItem {
  id: string; title: string; description?: string;
  columnId: string; priority: 'high' | 'medium' | 'low'; order: number;
  dependsOn: PlanDependency[]; tags?: string[];
  createdAt: string; updatedAt: string;
}
interface PlanDependency { projectId?: string; itemId: string; relation: 'blocked_by' | 'blocks' | 'relates_to' }

// Сессия владеет todo
interface TodoItem {
  id: string; content: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  priority: 'high' | 'medium' | 'low';
  planItemId?: string;   // связь с пунктом плана проекта
}
```

**Хранение:** план — поле `project.plan` (JSON проекта), todo — поле `session.todos` (JSON сессии). **Без файлов `.synth/` в workspace** — данные живут в самих сущностях (атомарная запись ADR-005; слабая привязка к ФС, упрощённая миграция на БД, ADR-096). `planContent`/`planPath` из сессии — удаляются.

**Инструменты:**
- `plan_*` — работа с планом проекта: `plan_read`/`plan_list`, `plan_write` (создание/редактирование пунктов, перемещение по колонкам, зависимости), `plan_export` (markdown-представление).
- `todo_*` — работа с todo сессии: `todo_list`, `todo_add`, `todo_update` (статус/порядок/`planItemId`), `todo_delete`, `todo_export`.
- `plan_enter` / `plan_exit` — **только** переключение режима сессии (plan ↔ act), без записи файлов. План пишется отдельным `plan_write`; `plan_exit` завершает планирование (событие `plan.approved` — сигнал «план зафиксирован»).
- В system prompt: блок `[APPROVED PLAN]` собирается из `project.plan`, блок todo — из сессии; контекстный блок сессии сообщает наличие/отсутствие проекта и рабочий каталог.

**Переопределяет:** ADR-027 (план хранится в проекте, не на диске; в system prompt — из `project.plan`). **Отменяет AD-002:** TSM-слой (`TsmState`, `updateTsmState`, категория `tsm` в конфиге) удаляется.

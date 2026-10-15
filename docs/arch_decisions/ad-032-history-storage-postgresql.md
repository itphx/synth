# AD-032: Хранение истории сессий

> **Статус:** 🧩 Предложение — Хранение истории сессий в PostgreSQL — замена JSON-слоя хранения (AD-005)
> **Решение до:** 2026-11-14
> **Дата:** 2026-09-17
> **Парные документы:**
> - [AD-005](./ad-005-json-storage.md) «JSON-файлы как хранилище» — текущий физический уровень (атомарная запись через tmp-файл + rename), который заменяется на PostgreSQL;
> - [AD-033](./ad-033-session-branching-merge.md) «Ветвление сессий и межсессионное слияние» — потребитель `parent_id` / `branch_point` / `origin`, опирается на логическую модель;
> - [AD-026](./ad-026-subagent-context-modes.md) «Режимы контекста саб-агента» — `summary`-режим, для которого выделяется сущность `context_snapshot`;
> - [AD-017](./ad-017-api-v2-hono.md) «Собственный API-контракт (API v2 на Hono)» — API-слой, читающий историю из нового хранилища.

## Решение

Переход физического хранилища истории с JSON-файлов ([AD-005](./ad-005-json-storage.md)) на **PostgreSQL** с нормализованной схемой «сессия → сообщения → части» (миграции, схема БД).

---

## Контекст

Claude Code хранит историю в плоских JSONL-файлах (`~/.claude/transcripts/{sessionId}.jsonl`), саб-агенты — в sidechain. Это просто, но не даёт parent-child связей и запросов между сессиями. OpenCode использует нормализованную модель с parent_id — лучшая основа для командной работы.

---

## Детали

### Логическая модель

```
Сессия (id, parent_id, project_id, agent, title, ...)
  │
  ├── parent_id → Сессия (parent-child дерево)
  ├── project.plan → kanban-план (AD-039; ранее plan_path)
  ├── branch_point → точка развилки для дочерних веток
  │
  └─1:N──→ Сообщение (id, session_id, seq, role, content, origin, source_msg_id, ...)
              │
              ├── seq — порядковый номер, уникален внутри сессии
              ├── origin: local | inherited | merged | crosspost
              ├── source_msg_id → Сообщение (откуда пришло)
              │
              └─1:N──→ Часть (id, message_id, type, data)
                          ├── type: text | tool_use | tool_result | reasoning
                          └── data — содержимое блока
```

### Ключевые сущности

| Сущность | Назначение |
|---|---|
| **Сессия** | Контейнер диалога. Имеет `parent_id` — дерево сессий. Хранит `agent`, `branch_point` |
| **Сообщение** | Одна реплика (user/assistant/tool/system). Имеет `seq` — порядок внутри сессии. Имеет `origin` — откуда пришло |
| **Часть (part)** | Блок контента внутри сообщения: text, tool_use, tool_result, reasoning. Одно сообщение → много частей |
| **context_snapshot** | Сжатый контекст для summary-режима саб-агентов. Создаётся через отдельный LLM-вызов |

### Origin tracking — отслеживание происхождения сообщения

| origin | Как попало в сессию | source_msg_id |
|---|---|---|
| `local` | Создано в этой сессии (дефолт) | NULL |
| `inherited` | Унаследовано от родительской сессии (ветвление) | ID оригинального сообщения |
| `merged` | Скопировано из другой сессии пользователем (smart paste) | ID оригинального сообщения |
| `crosspost` | Существует в нескольких сессиях одновременно | Синхронизировано |

### Физический уровень (не реализовано)

- Целевое хранилище: **PostgreSQL** (нормализованная схема). Идём сразу в PostgreSQL — SQLite как промежуточный вариант не используется.
- Логическая модель уже живёт в JSON-схеме ([AD-005](./ad-005-json-storage.md)) и используется ветвлением/merge ([AD-033](./ad-033-session-branching-merge.md)); миграция затрагивает только физический слой — схему БД и перенос данных.
- Сущность `context_snapshot` (сжатый контекст для `summary`-режима) пока не выделена — `summary` реализован через `ContextOptimizer.summarize()` с кэшем ([AD-026](./ad-026-subagent-context-modes.md)).

---

## Статус реализации в коде

**Физический PostgreSQL-уровень не реализован, кода нет.** Логическая модель реализована в JSON-схеме (проверено по репозиторию).

Проверено (grep по `packages/**`, исключая `dist/` и `node_modules/`; `package.json` пакетов):

- **PostgreSQL отсутствует:** в `packages/*/package.json` нет зависимостей `pg`, `postgres`, `prisma`, `drizzle`, `better-sqlite3`; SQL (`CREATE TABLE`, `INSERT INTO`, `SELECT … FROM`) в исходниках не встречается; каталогов миграций (`packages/*/migrations`) нет.
- **Логическая модель реализована в JSON-схеме:**
  - `MessageOrigin = 'local' | 'inherited' | 'merged' | 'crosspost'`, `seq`, `sourceMsgId` — `packages/shared/src/types/index.ts:45–67`;
  - `parentId`, `branchPoint` — `packages/shared/src/types/index.ts:207` (сессия), `:241–242`;
  - сериализация/десериализация в `FileStore` (`obfuscation_map`, `session_origin`, `seq`, `origin`, `source_msg_id`, `parent_id`, `branch_point`) — `packages/core/src/storage/file-store.ts:28–30, 63–64, 135–137, 205–207, 241–247, 307–313`.
- **`context_snapshot` как сущность не выделен:** `summary` реализован через `ContextOptimizer.summarize()` — `packages/core/src/engine/context/optimizer.ts:226` (стрим — `:274`).
- Поля `plan_path` в модели нет — план живёт в `project.plan` (AD-039).

# ADR-017: Собственный API-контракт (API v2 на Hono)

> **Статус:** ✅ Реализовано
> **Источник:** перенесено из AGENTS.md (исторический ADR-017 прототипа переписан под as-built TS-стек)

**Решение:** Synth определяет собственный HTTP-контракт — **API v2** — и не использует SDK сторонних движков (`@opencode-ai/sdk` и т.п.) как интерфейс UI. Контракт описан общими типами и Zod-схемами в `@itphx/synth-shared`, реализован на Hono. Внутренние движки подключаются на уровне бэкенда/раннера через адаптеры, а не через общий SDK.

**Контекст:** исторический ADR-017 (`archive/AGENTS_OLD.md`) зафиксировал отказ от `@opencode-ai/sdk` и переход на собственные эндпоинты и типы данных. В TS-стеке (ADR-022) это реализовано: Hono-приложение и в ядре (`@itphx/synth-core`, standalone), и в хабе (`@itphx/synth-backend`), с единым базовым путём `/api/v2` и общими моделями ответов/ошибок.

**Базовый путь:** `/api/v2`. В standalone-core и managed-backend используются одни и те же пути, форматы и типы (совместимое подмножество). Актуальный справочник эндпоинтов, RBAC и ошибок — [`docs/API_V2.md`](./../API_V2.md).

**Ключевые группы эндпоинтов:**

| Группа | Путь | Где |
|---|---|---|
| Health | `GET /health` (без auth) | core, backend |
| Сессии | `/api/v2/sessions`, `/sessions/:id`, `/prompt`, `/abort`, `/summarize`, `/events`, `/status` | core, backend |
| Сообщения | `/api/v2/sessions/:id/messages`, `/api/v2/messages/:sessionId/:index` | core, backend |
| Проекты | `/api/v2/projects`, `/:id`, перенос/экспорт | core, backend |
| Провайдеры/модели | `/api/v2/providers`, `/api/v2/models` | core, backend |
| Агенты | `/api/v2/agents` | core, backend |
| Очередь | `/api/v2/queue/:sessionId/clear\|return\|resume` | core, backend |
| ФС | `/api/v2/fs`, `/fs/read`, `/fs/write`, `/fs/upload`, `/fs/download`, `/fs/mkdir`, `/fs/move` | core |
| MCP | `/api/v2/mcp` | core, backend |
| Settings | `/api/v2/settings/workspace`, `/api/v2/settings/mcp` | core |
| Гибрид | `/api/v2/hybrid/status` | core |
| Auth/RBAC/Admin | `/auth/*`, `/admin/*`, `/users/*` | backend |
| LLM Proxy | `/api/v2/llm/chat/completions` | backend |

**События:** WS `WS /ws/events` (ADR-008/ADR-024) — типизированный поток `BusEvent` из общего контракта.

**Реализация (as-built):**

| Компонент | Файл | Назначение |
|---|---|---|
| Hono-приложение core | `packages/core/src/server/app.ts` | монтирует роуты под `/api/v2/*`, auth-middleware, WS `/ws/events` |
| Роуты core | `packages/core/src/server/routes/*.ts` | sessions, projects, providers, models, agents, fs, queue, messages, settings, mcp, hybrid, dictionaries, updates |
| Hono-приложение backend | `packages/backend/src/app.ts` | API Hub: OIDC, RBAC, sessions/projects/providers/models/mcp/queue, LLM Proxy, WS `/ws/events` |
| Роуты backend | `packages/backend/src/routes/*.ts` | auth, sessions, projects, providers, models, agents, mcp, queue, messages, llm, logs, audit, users, gateway-patterns |
| Контракты | `packages/shared/src/types/index.ts`, `packages/shared/src/schemas/index.ts` | общие типы и Zod-схемы запросов/ответов |

**Связь:** ADR-018 (движки подключаются адаптерами за контрактом), ADR-022 (TS-стек), ADR-024 (WS-события).

# PROP-056: MCP-сервер Synth и скиллы для внешних агентов

> **Статус:** 🧩 Предложение — MCP-сервер Synth для внешних агентов: MCP над API v2, auth, права, форматы конфигов клиентов
> **Решение до:** 2026-11-14
> **Дата:** 2026-10-08
> **Источник:** перенесено из `AD-DRAFTS.md` (D11; черновик 2026-09-16); Roadmap, идея 11; прототип
> `~/dev/aic/t11` (`synth-mcp-tools`, `synth-mcp-git`) — только чтение.
> **Связано:** [ADR-017](./adr-017-api-v2-hono.md), [ADR-024](./adr-024-eventhub-transport.md),
> [ADR-029](./adr-029-granular-permissions.md), [ADR-036](./adr-036-llm-gateway.md),
> [ADR-046](./adr-046-skills-and-slash-commands.md), [PROP-048](./prop-048-self-help-skills-admin-mcp.md),
> [ADR-052](./adr-052-public-api-platform.md), [ADR-089](./adr-089-external-events-automation.md).

**Решение:** отдать возможности Synth **внешним агентам** (opencode, hermes, Claude Code и др.) через
**MCP-сервер Synth** над API v2. Этапами: сначала **read-only** (сессии/проекты/статус), затем
**write/prompt**. С MCP-сервером поставляются **скиллы для внешних агентов** — инструкции, объясняющие
внешнему агенту, как работать с Synth. Обязательны: аутентификация, соблюдение прав
([ADR-029](./adr-029-granular-permissions.md)) и готовые форматы конфигов клиентов.

Сегодня Synth — **только MCP-клиент** (потребляет чужие MCP-серверы); PROP-056 добавляет обратное
направление. Это дополняет [ADR-089](./adr-089-external-events-automation.md): PROP-056 — «внешний агент
вызывает Synth» (MCP-инструменты), ADR-089 — «внешние события запускают Synth» (роутер событий/automation).

## Контекст

- MCP-клиент уже полноценный: stdio и Streamable HTTP транспорты, префикс тулов `{serverName}_{toolName}`,
  capability `ToolCapability.MCP`, реестр и scope-уровни system/project/session
  ([ADR-071](./adr-071-mcp-servers-prompt.md), `packages/core/src/engine/mcp/`).
- API v2 — единый внутренний контракт `@itphx/synth-core`/backend
  ([ADR-017](./adr-017-api-v2-hono.md), `docs/API_V2.md`); по нему уже можно читать сессии/проекты и
  отправлять `POST /sessions/:id/prompt`.
- Права и режимы — permission-слой ([ADR-025](./adr-025-plan-act-toggle.md),
  [ADR-029](./adr-029-granular-permissions.md)); внешний агент должен получать **урезанный** набор.
- Безопасность LLM — Gateway ([ADR-036](./adr-036-llm-gateway.md)): обфускация, аудит, rate limit.
- В прототипе t11 есть образцы: stdio MCP-серверы `~/dev/aic/t11/synth-mcp-tools`,
  `~/dev/aic/t11/synth-mcp-git` и внешний web-tool-сервер `synth-mcp/`.

## Детали

### 1. MCP-сервер над API v2

- **Транспорт:** stdio (для локальных клиентов, как в t11) и/или HTTP (Streamable HTTP) для удалённых.
- **Тулы:** тонкая обёртка над эндпоинтами API v2 — не дублировать бизнес-логику (инвариант
  переиспользуемых роутов). Реализация — отдельный слой, мапящий MCP-tool → HTTP-вызов.
- **Ресурсы/prompts MCP:** по возможности отдавать сущности (сессии, проекты, план) как MCP resources.

### 2. Этапность read-only → write

| Этап | Что доступно | Почему так |
|---|---|---|
| **1. Read-only** | список/чтение сессий и проектов, план/ToDo, статус, аудит (по правам) | безопасный старт, без мутаций и LLM-трат |
| **2. Write/prompt** | создание сессии/сообщения, `POST /sessions/:id/prompt`, правки плана | требует прав, rate limit и аудита |

### 3. Аутентификация и права

- Внешний агент идентифицируется своим **токеном/ключом**; доступ — по ролям
  (`ADMIN`/`USER`/`LEAD`/`AUDITOR`) и permission-слою.
- Тулы MCP-сервера должны подчиняться тому же permission-слою, а не хардкодить проверки
  ([ADR-029](./adr-029-granular-permissions.md)).
- Скоупинг: какие тулы/сущности безопасно отдавать внешнему агенту; read-only первым этапом.
- Все LLM-вызовы, инициированные через MCP, идут через Gateway
  ([ADR-036](./adr-036-llm-gateway.md)).

### 4. Скиллы для внешних агентов

Вместе с MCP-сервером Synth поставляет **скиллы** ([ADR-046](./adr-046-skills-and-slash-commands.md)) —
инструкции внешнему агенту о том, как пользоваться MCP-инструментами Synth (типовые сценарии,
ограничения, best practices). Это отдельный слой от скиллов самого Synth.

### 5. Форматы конфигов клиентов

Готовые сниппеты конфигурации MCP-сервера Synth для популярных клиентов (opencode, Claude Code,
hermes и т.п.) — с подключением stdio/HTTP и передачей токена.

### 6. Связь с self-help / admin-MCP

[PROP-048](./prop-048-self-help-skills-admin-mcp.md) описывает read-only status-MCP и deploy-тулы для
администрирования Synth. PROP-056 — общий контракт MCP-сервера; admin-MCP — его гейтинговый частный
случай (ADMIN).

## Статус реализации в коде

**Не реализовано.** Проверено по репозиторию (grep по `packages/**`, исключая `dist/` и `node_modules/`):

- MCP существует **только как клиент**: `packages/core/src/engine/mcp/` — `client.ts`
  (`StdioClientTransport`, `StreamableHTTPClientTransport`), `manager.ts`, `scope.ts`, `settings.ts`,
  `network-policy.ts`; роут `POST /api/v2/mcp/probe` (`packages/core/src/server/routes/mcp.ts`).
- MCP-сервера Synth (эндпоинт, отдающий тулы наружу) нет; SDK MCP-сервера в зависимостях не используется.
- Механизм скиллов ([ADR-046](./adr-046-skills-and-slash-commands.md)) в коде есть
  (`packages/core/src/engine/skills/`), но поставки скиллов для **внешних** агентов нет.
- API v2 ([ADR-017](./adr-017-api-v2-hono.md)) служит базой, но публичный контур/токены внешних
  потребителей не оформлены ([ADR-052](./adr-052-public-api-platform.md)).

## Открытые вопросы

- Транспорт: stdio, HTTP или оба?
- Скоупинг токенов и подмножество тулов, безопасное для внешнего агента?
- Read-only первым этапом — согласовано; какой минимальный набор тулов в него входит?
- Как оформлять скиллы/конфиги клиентов (единый формат vs per-client)?
- Как MCP-сервер соотносится с публичной API-платформой
  ([ADR-052](./adr-052-public-api-platform.md)) — один контур доступа или разные?

## Связи

- [ADR-017](./adr-017-api-v2-hono.md) «API v2 на Hono» — контракт, поверх которого строится MCP-сервер.
- [ADR-024](./adr-024-eventhub-transport.md) «EventHub + TransportClient» — события сессий для
  live-режима внешнего клиента.
- [ADR-029](./adr-029-granular-permissions.md) «Гранулярные permissions» — права внешнего агента.
- [ADR-036](./adr-036-llm-gateway.md) «LLM Gateway» — безопасность LLM-вызовов через MCP.
- [ADR-046](./adr-046-skills-and-slash-commands.md) «Скиллы и slash-команды» — формат скиллов для
  внешних агентов.
- [PROP-048](./prop-048-self-help-skills-admin-mcp.md) «Self-help скиллы и admin-MCP» — admin-частный
  случай MCP-сервера.
- [ADR-052](./adr-052-public-api-platform.md) «Публичная API-платформа» — токены/скоупы внешних
  потребителей.
- [ADR-089](./adr-089-external-events-automation.md) «Внешние события и автоматизация» — обратное
  направление (внешнее событие → Synth).
- [docs/API_V2.md](../API_V2.md) — справочник эндпоинтов.

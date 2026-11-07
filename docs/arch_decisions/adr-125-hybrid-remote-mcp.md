# ADR-125: Серверные MCP-серверы в локальных сессиях гибрида — relay и tools

> **Статус:** ✅ Реализовано
> **Источник:** PROP-125
> **Дата:** 2026-11-07
> **Связано:** [ADR-042](./adr-042-hybrid-mode.md), [ADR-043](./adr-043-unified-identity-login.md), [ADR-045](./adr-045-hybrid-server-profiles.md), [ADR-052](./adr-052-public-api-platform.md), [ADR-071](./adr-071-mcp-servers-prompt.md), [ADR-077](./adr-077-runtime-toolchain.md), [ADR-099](./adr-099-egress-tls-trust.md), [ADR-105](./adr-105-external-credentials.md), [ADR-115](./adr-115-multimodal-input.md)

## Контекст

Локальный core гибрида видел только свои `config.mcpServers`: серверный реестр MCP живёт в
backend, а `/api/v2/mcp` не входит в проксируемые префиксы — локальная сессия не видела ни одного
серверного MCP-сервера, хотя LLM для неё уже централизован. Переносить конфиг/секреты/URL на
клиент нельзя: `credentialId` живёт на сервере, приватные адреса/CA/mTLS/прокси из локальной сети
недостижимы, а прямой egress core к MCP-URL — новый SSRF-вектор с машины пользователя.

## Решение

1. **Хост — backend.** Контракт: `GET /api/v2/mcp/remote/servers`, `GET /api/v2/mcp/remote/tools?server=`,
   `POST /api/v2/mcp/remote/call` (режим `tools`) и `POST /api/v2/mcp/relay/:name` (stateless
   Streamable HTTP, режим `relay`). Релей монтирует только backend; локальный инстанс такого
   маршрута не имеет.
2. **Core.** `RemoteMcpSource` (discovery: TTL 120 с, retry 15 с) + `RemoteBackendMcpClient`
   (`tools`) и relay-клиент (`McpClient` на `/api/v2/mcp/relay/:name`) — обе ветки одной поверхности
   `McpClientLike`. В `McpManager` — **третий вид runtime-записей** (рядом с локальным реестром и
   серверами исполнителя): не персистятся, не редактируются, коллизия имён решается в пользу
   локального сервера.
3. **Режим доставки — `remoteMode` в записи реестра:** `auto|relay|tools` (дефолт `auto`:
   `http`/`sse` → `relay`, `stdio` → `tools`). Неудачный relay — **всегда** деградация в `tools` с
   причиной в статусе (в т.ч. при явном `remoteMode:'relay'`), без отказа и «тихого» исчезновения.
4. **Скоуп — как у удалённых сессий:** системный мастер → `project.mcp.enabled` → сессионный
   снимок `mcpDefaultOn`/`mcpDisabledServers`; executor-обхода проекта для серверных записей нет.
   Существующие проекты получают серверные `enabledByDefault` авто-сидом (идемпотентно, маркер
   `project.mcp.remoteSeeded`, публикуется `project.updated`); новые проекты — сид из
   `enabledByDefault` (локальные + серверные).
5. **Секреты, TLS, SSRF и сетевая политика — на сервере** (ADR-099/ADR-105/ADR-071 §2.3.1). Локальный
   core не ходит к upstream MCP и не видит секретов. Авторизация — `requireAuth`; для service-key —
   scope `mcp:invoke` (семейство `mcp:*`). Дополнительных аудитов, квот и approval нет.
6. **stdio-серверы разрешены как в managed:** создаёт только ADMIN, исполняются на сервере.
7. **Оффлайн/сбой:** серверы остаются в выдаче `GET /sessions/:id/mcp` со `status:'error'` и
   причиной (`error`), причина — и в блоке `mcp.status` промпта; тулы не предлагаются до
   реконнекта.
8. **Признак фичи — `features.remoteMcp` в `GET /api/v2/meta`** (аддитивно, только backend): у
   старого backend признака нет → фича молча выключена (fail-closed).

## Ограничения

- Relay **stateless** и отдаёт JSON: нет progress/elicitation/resources/prompts и server-initiated
  уведомлений; `GET`/`DELETE` `/relay/:name` → `405 MCP_RELAY_SESSIONLESS`.
- Режим `tools` — без стриминга; смена `remoteMode` применяется на следующем подключении.
- Авто-сид legacy-проектов смотрит на снимок `knownServers` на момент коннекта.

## Альтернативы

- **A. Синхронизация конфигурации серверных MCP в локальный core** — отклонено: секреты не
  переносятся, SSRF с клиента, недостижимые приватные адреса/CA/mTLS/прокси, устаревший конфиг.
- **D. Прямое подключение локального core к MCP-URL с выдачей токенов** — отклонено: утечка
  секретов на клиент, SSRF с ноутбука, невоспроизводимая сеть.
- **B. Relay протокола** и **C. Tool-level proxy** — приняты оба (см. `remoteMode`).

## Последствия

- **Плюсы:** паритет локальных и удалённых сессий по MCP; секреты и сеть не покидают сервер; один
  путь вызова и регистрации тулов (`McpClientLike` + `McpManager`), без второго permission-контура.
- **Риски:** двойной хоп задержки (клиент → backend → MCP); relay сложнее tools (SSE/таймауты/отмена);
  в режиме `tools` нет streaming/progress/elicitation; при офлайне состав устаревает до реконнекта;
  коллизии имён локального и серверного реестров (приоритет локального + явное предупреждение).

## Статус в коде

| Что | Где |
|---|---|
| Контракт `tools` (servers/tools/call) + авторизация | `packages/backend/src/routes/mcp-remote.ts`, монтаж — `packages/backend/src/routes/mcp.ts` |
| Relay-фабрика (stateless, JSON), монтаж в backend | `packages/core/src/server/routes/mcp-relay.ts` (экспорт в `packages/core/src/index.ts`) |
| Клиент `tools` поверх backend-контракта | `packages/core/src/engine/mcp/remote-backend-mcp-client.ts` |
| Источник состава, режим `auto`/`relay`/`tools`, деградация | `packages/core/src/engine/mcp/remote-mcp-source.ts` |
| Runtime-записи `McpManager` (третий вид), причины ошибок | `packages/core/src/engine/mcp/manager.ts` |
| Авто-сид проектов (`remoteSeeded`) | `packages/core/src/server/app/remote-mcp-seed.ts` |
| Проводка connect/disconnect, признак `features.remoteMcp` | `packages/core/src/server/app/hybrid-remote.ts`, `packages/core/src/server/routes/meta.ts` |
| Контракты (`remoteMode`, `source`/`error`, `remoteSeeded`, scope, `features`) | `packages/shared/src/types/{mcp,project,service-keys,message-stream}.ts` |
| UI: бейдж «серверный», причина, колонка источника, выбор режима | `packages/ui/src/components/panels/{ProjectTab,SessionSettingsTab,StatsTab}.tsx`, `packages/ui/src/components/settings/{McpSettings.tsx,useMcpRegistryEditor.ts}` |

## История

- 2026-11-07 — ADR-125 принят из PROP-125 после реализации (T1–T5).

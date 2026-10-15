# ADR-089: Synth как платформа внешних событий и автоматизации

> **Статус:** ⚠️ Частично — ядро Event/Binding/Router, единый funnel, API/UI, источник cron ([ADR-051](./adr-051-scheduler-pipelines.md)), API-ключи привязок, runtime-настройки «События», decision-маршрутизация ([ADR-084](./adr-084-decision-models-clef.md), opt-in), auto-bind, идентичности профиля + claim-flow, права внешних отправителей (fail-closed), надёжный Stop; остаток — Plugin SDK ([PROP-090](./prop-090-extension-api.md)), пайплайны ([PROP-059](./prop-059-pipeline-automation.md)), остаток [ADR-087](./adr-087-gateways.md) (HA/второй канал), стриминг ответа наружу.
> **Дата:** 2026-10-08 (as-built вынесено в spec — 2026-10-15).
> **Парные документы (as-built):** [ARCHITECTURE.md](../ARCHITECTURE.md) «Внешние события и хуки» · [API_V2.md](../API_V2.md) §5.5/§5.14.1/§5.21/§5.26 · [CONFIGURATION.md](../CONFIGURATION.md) (`events`) · `packages/{core,backend,shared}/AGENTS.md`.
> **Связано:** [ADR-030](./adr-030-hooks-agent-events.md) (фундамент hook-шины), [ADR-034](./adr-034-model-routing.md)/[ADR-035](./adr-035-micro-model-first.md) (слой решения), [ADR-033](./adr-033-session-branching-merge.md) (создание/ветвление сессий), [ADR-026](./adr-026-subagent-context-modes.md) (контекст саб-агента), [ADR-051](./adr-051-scheduler-pipelines.md), [ADR-052](./adr-052-public-api-platform.md) (service-key/webhooks), [ADR-087](./adr-087-gateways.md) (Gateway), [ADR-086](./adr-086-extensibility-plugins-editions.md) (Add-on), [ADR-029](./adr-029-granular-permissions.md), [ADR-036](./adr-036-llm-gateway.md), [ADR-071](./adr-071-mcp-servers-prompt.md), [ADR-042](./adr-042-hybrid-mode.md)/[ADR-045](./adr-045-hybrid-server-profiles.md), [PROP-056](./prop-056-synth-mcp-server.md), [PROP-085](./prop-085-multimodal-input.md), [PROP-088](./prop-088-http-proxy.md).

## Контекст

Synth инициировался только пользователем из UI/CLI (`POST /sessions/:id/prompt`) — внешние системы (мессенджеры, CI, планировщик) не могли разбудить агента, а продукт позиционируется как **платформа автоматизации**: вход должен быть событийным («событие снаружи → действие агента внутри»). Кирпичи уже были (шина событий сессии [ADR-009](./adr-009-session-event-bus.md) + транспорт [ADR-008](./adr-008-websocket-events.md)/[ADR-024](./adr-024-eventhub-transport.md), MCP-клиент [ADR-071](./adr-071-mcp-servers-prompt.md), API v2 [ADR-017](./adr-017-api-v2-hono.md), гибрид [ADR-042](./adr-042-hybrid-mode.md)); не хватало роутера внешних событий, сущностей `Event`/`Binding`/`Router`, hook-шины ([ADR-030](./adr-030-hooks-agent-events.md)) и публичного приёма webhook'ов.

## Решение

Synth — **агентный рантайм для внешних событий**: событие нормализуется в `Event`, проходит **Router** и превращается в работу сессии (агент/скиллы/права); результат может уйти обратно во внешний сервис.

- **Сущности и Router.** `SynthEvent`/`EventBinding`/`RouteDecision` (`shared/types/events.ts`); `EventBinding` — внешний адрес → сессия/шаблон (`mode: bound|ephemeral|queue`), `RouteDecision` — `bound`/`ephemeral`/`queue`/`drop`/`bind`. Порядок `EventRouter.decide`: `allowedSources` → dedup → явный `EventBinding` → `RouteRuleProvider` (правила; при `events.decisionRouting` — decision-шаг, fail-safe) → фоллбек `defaultMode` (`bound` → `drop no_route` с аудитом; `ephemeral` → сессия с TTL). Все решения журналируются, дроп фиксируется с причиной — событие не теряется молча.
- **Единый funnel создания сессии (инвариант 15).** Только через `RequestSessionService` → `EventRouter` (явный запрос — `direct`; внешнее — через Router); `SessionManager.createSession` — materialization-примитив (fork/import/материализация). `session.requested` — тоже событие, поэтому права/шаблон/привязка/аудит/дедуп едины для UI/CLI/агента/внешнего сервиса.
- **Владелец — человек, а не чат.** `chatKey` — **routing** (привязки/правила/auto-bind), `principalId` — **ownership и attribution**; владелец — человек-отправитель (резолвер внешней идентичности), поэтому Telegram-сессии видны в его списке, а не у машинного аккаунта шлюза.
- **Auto-bind.** Фоллбек Router при `events.autoBind` закрепляет чат/тред без привязки за новой постоянной сессией (`{kind:'bind'}`); влияет **только** на фоллбек (явная привязка/правила/decision приоритетнее). Защита от мусорных сессий: флаг off по умолчанию + `allowedSources` + per-key rate limit.
- **Права внешнего отправителя (fail-closed).** База — роли **профиля** Synth отправителя; `identity.roles` (allowlist шлюза) только **сужают** (пересечение), не повышают; несопознанный — прав Synth не имеет. Считает `resolveEffectiveRoles`; роли уходят в ход (`metadata.effective_roles`) для аудита/attribution. **Role-оси в permission-слое нет — by design:** роли = доступность **эндпоинтов** (HTTP, `requirePermission`), внутри сессии тулы/разрешения одинаковы для всех ([ADR-029](./adr-029-granular-permissions.md)); машинный доступ интеграций сужается scoped **service-key** ([ADR-052](./adr-052-public-api-platform.md)), не ролями отправителя.
- **Идентичности, ключи, «Стоп».** Идентичности — в профиле (`ProfileData.identities[]`, ключ `provider:externalId`), привязка только через **claim-flow** (одноразовый код), прямой линковки чужого id нет. API-ключи привязок: несколько на `EventBinding`, секрет — sha256 at-rest (plaintext один раз), per-key rate limit (`events.keyRateLimitPerMinute`) → 429, инстанс-локальные (не переносятся publish/fork). Надёжный «Стоп»: `POST /api/v2/sessions/:id/abort` — персистентный флаг `SessionStatus.cancelRequested`, работает и без живого стрима (очередь/backoff/между итерациями).
- **Слои и границы.** Шлюз (Gateway, [ADR-087](./adr-087-gateways.md)) — тонкий транспорт (нормализует вход `POST /api/v2/events`, доставляет выход); маршрутизацию/сессии решает ядро. HA и мультитенантность — свойство класса Gateway, не контракта событий. Прикладная логика канала живёт вне Synth (эталон — `synth-media`: потребитель API/webhook и провайдер MCP). Безопасность: маппинг на профиль ([ADR-043](./adr-043-unified-identity-login.md)), дедуп по `dedupKey`, секреты at-rest ([ADR-076](./adr-076-git-repo-registry-ssh.md)), guard LLM Gateway ([ADR-036](./adr-036-llm-gateway.md)), аудит решений, гибридные политики — [PROP-080](./prop-080-managed-hybrid-modes.md)/[PROP-081](./prop-081-hybrid-policy-leak-protection.md).

## Альтернативы

- **Отдельный путь запуска сессий для внешних событий** — отклонён: единый funnel (инвариант 15) даёт единые права/шаблон/аудит/дедуп независимо от инициатора.
- **Владелец-чат / машинный аккаунт шлюза** — отклонён: сессии выпадали бы из `listSessions` человека; чат определяет routing, владелец — человек.
- **Роль-ось в permission-слое по `identity.roles`** — отклонён: повышала бы права отправителя; роли = доступность эндпоинтов, сужение только пересечением.
- **Прямая линковка внешнего id (`POST /identities`)** — отклонён: подстановка чужого id → угон идентичности; только claim-flow.
- **Дедup только in-memory** — default (`file` — `events.dedupStore`, для мульти-инстанса); **мультитенантный Router** (на проект/организацию) — открытый вопрос, не выбран.

## Последствия

- (+) Внешние системы запускают агента событием; правила, права, аудит и дедуп едины для всех инициаторов.
- (+) Внешние отправители больше не действуют с правами машинного аккаунта шлюза (fail-closed).
- (−) `autoBind` может плодить сессии — контур защиты: флаг off, `allowedSources`, per-key rate limit.
- Остаток/вне объёма: Plugin SDK ([PROP-090](./prop-090-extension-api.md)), пайплайны ([PROP-059](./prop-059-pipeline-automation.md)), HA/второй канал [ADR-087](./adr-087-gateways.md), стриминг ответа наружу (edit-in-place/typing).

## Статус реализации

⚠️ Частично: реализованы ядро Event/Binding/Router, единый funnel, API/UI, источник cron, ключи привязок, runtime-настройки «События», retention журнала, decision-маршрутизация (opt-in), auto-bind, идентичности + claim-flow, права внешних отправителей, надёжный Stop. As-built — [ARCHITECTURE.md](../ARCHITECTURE.md) «Внешние события и хуки», [API_V2.md](../API_V2.md) §5.5/§5.14.1/§5.21/§5.26, [CONFIGURATION.md](../CONFIGURATION.md) (`events`), `packages/{core,backend,shared}/AGENTS.md`.

**Открытые вопросы.** Транспорт приёма для не-Telegram источников (webhook/long-polling/pull); мультитенантность (один Router на инстанс vs проект); гранулярность `bound` (чат/тред/топик/ветка) и миграция при переносе сессии; стриминг наружу. Для Telegram закрыто: long-polling (один потребитель на бота → `409 Conflict`; HA — leader election) — [ADR-087](./adr-087-gateways.md) §4.

## История

- 2026-10-15 — сжатие до одной страницы: as-built вынесено в spec ([ARCHITECTURE.md](../ARCHITECTURE.md), [API_V2.md](../API_V2.md), [CONFIGURATION.md](../CONFIGURATION.md), `packages/{core,backend,shared}/AGENTS.md`).
- 2026-10-13 — синхронизация статусов: ADR-052 закрыт целиком (этапы I–IV), Telegram-шлюз реализован.
- 2026-10-12 — зафиксирована граница с gateway-слоем; auto-bind; LLM-дефолты событийных сессий и default-agent.

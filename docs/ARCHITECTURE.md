# Архитектура Synth

> [!NOTE]
> Пользовательские сценарии развёртывания (локально, Docker, Kubernetes, гибрид) —
> в портале документации: https://docs.synth.itphx.ru/deploy/local/.

## Компоненты

Synth состоит из шести пакетов в монорепозитории:

| Пакет | Назначение | Стек |
|-------|-----------|------|
| **@itphx/synth-shared** | Типы, интерфейсы, Zod-схемы, протоколы, конфигурация | TypeScript |
| **@itphx/synth-core** | Автономный движок: сессии, очередь, LLM-провайдеры, CLI, HTTP API v2 | TypeScript, Hono |
| **@itphx/synth-backend** | API Hub: OIDC, Runner Registry, LLM Proxy, RBAC, SessionEventBus | TypeScript, Hono |
| **@itphx/synth-ui** | React 19 SPA + админка (рендеринг по ролям) | TypeScript, React 19, Vite |
| **@itphx/synth-sdk** | Типизированный клиент публичного API (ADR-052): обёртка над public-OpenAPI (`events`/`sessions`/`schedules`/`llm`) | TypeScript, ESM |
| **@itphx/synth** | Публикуемая тонкая CLI-обёртка (`bin: synth`) над core/ui/shared (ADR-038). Не бандлит core, не копирует ассеты | TypeScript, commander |

Публичный HTTP-контракт описан **public-OpenAPI**-спекой (28 операций интеграционного ядра,
`packages/core/src/server/openapi/public-openapi.ts`, отдаётся `GET /api/v2/openapi.json`); SDK её
потребляет — единый клиентский слой поверх публичного API.

## Архитектурная схема

```mermaid
flowchart TB
    subgraph UI["Web-интерфейс"]
        synth_ui["@itphx/synth-ui — React SPA"]
    end

    subgraph Server["Серверная часть"]
        synth_backend["@itphx/synth-backend — Hono API Hub"]
        synth_core["@itphx/synth-core — автономный движок"]
    end

    subgraph CLI["Публикуемый CLI"]
        synth_cli["@itphx/synth — тонкая обёртка (bin: synth)"]
    end

    subgraph LLM["LLM-провайдеры"]
        ollama["Ollama (локально)"]
        openai["OpenAI API"]
        anthropic["Anthropic API"]
        providers["Любой OpenAI-совместимый"]
    end

    subgraph PublicClients["Публичные клиенты (ADR-052)"]
        synth_sdk["@itphx/synth-sdk — клиент публичного API"]
    end

    subgraph Integrations["Интеграции"]
        event_sources["Внешние источники событий"]
        webhook_targets["HTTP-подписчики (webhooks)"]
    end

    synth_ui -->|HTTP + WebSocket| synth_backend
    synth_ui -->|HTTP API v2| synth_core

    synth_cli -->|serve/chat/config| synth_core

    synth_core --> ollama
    synth_core --> openai
    synth_core --> anthropic
    synth_core --> providers

    event_sources -->|POST /api/v2/events| synth_core
    synth_core -->|webhooks: HTTP + HMAC-SHA256| webhook_targets

    synth_sdk -->|service-key / HTTP API v2| synth_core
    synth_sdk -->|HTTP API v2| synth_backend
```

## Сценарии развёртывания

### Облачный (командная работа)

```
synth-ui (браузеры сотрудников) ←→ synth-backend (:5000)
```

- Единый источник правды для сессий и истории
- Коллаборация: несколько пользователей в одной сессии
- Централизованный аудит всех LLM-запросов
- RBAC: роли ADMIN, USER, LEAD, AUDITOR
- API-ключи провайдеров хранятся только на бэкенде

### Локальный (один разработчик)

```
synth-ui (localhost) ←→ synth-core (:4300)
```

- Одна команда: `synth serve --api-key <key>`
- Прямой доступ к файловой системе
- Не требует бэкенда, Keycloak, Kubernetes

### Локальный + внешние движки (планируется)

Внешние движки (opencode/cline) через встроенный Runner-мост — **не реализовано**
(план: ADR-018, PROP-050). В ядре остаётся плумбинг: флаг `serve --runner` и секция
конфига `runner`, но адаптеров движков и маршрутизации нет; фактическое исполнение
идёт собственным движком `synth`.

### Гибридный (локально + корпоративный сервер)

Реализовано (требования и статус — [HYBRID.md](HYBRID.md)).

Сценарий: пользователь запускает `synth serve` на своей машине и подключает его
к корпоративному серверу (`synth serve --connect https://synth.k3s.itphx.loc`).
Локальный core становится **агрегатором двух миров**: локальные и удалённые
(backend) проекты/сессии доступны из одного локального UI. Удалённые сессии
исполняются сервером, локальные — локальным движком, но их LLM-запросы идут
через **LLM Proxy** на сервере (централизованные ключи, модели и аудит, ADR-036).

```mermaid
flowchart LR
    subgraph User["Машина пользователя"]
        UI["@itphx/synth-ui (localhost)"]
        Core["@itphx/synth-core (serve :4300)"]
        WorldLocal["Локальный мир: проекты/сессии/файлы"]
        RemoteClient["RemoteBackendClient (/api/v2/*)"]
        EventBridge["RemoteEventBridge (SSE)"]
        UI --> Core
        Core --> WorldLocal
        Core --> RemoteClient
        Core --> EventBridge
    end
    subgraph Server["Корпоративный сервер (K3s)"]
        Backend["@itphx/synth-backend (:5000)"]
        OIDC["OIDC / Keycloak (device flow)"]
        LLMProxy["LLM Proxy: POST /api/v2/llm/chat/completions"]
        Gateway["Gateway ADR-036 (аудит, обфускация, rate limit)"]
        Providers["Центральные провайдеры (ключи на сервере)"]
        RemoteSessions["Удалённые сессии (ChatOrchestrator)"]
        SSE["События: GET /api/v2/events (SSE)"]
    end
    RemoteClient -->|HTTPS /api/v2/*| Backend
    EventBridge -->|SSE| SSE
    Core -->|LLM-запросы локальных сессий| LLMProxy
    Backend --> OIDC
    LLMProxy --> Gateway
    Gateway --> Providers
    Backend --> RemoteSessions
```

Ключевые элементы:

- **Агрегация миров:** у каждой сущности поле `origin: 'local'|'remote'`,
  удалённые id — `remote:<uuid>` (исключают коллизии UUID между мирами); списки
  проектов/сессий объединяются, запросы маршрутизируются по миру.
- **RemoteBackendClient** (`packages/core/src/remote/client.ts`) — HTTP-клиент
  к `/api/v2/*` сервера: auth (OIDC device flow / API-ключ), таймауты, ретраи,
  ошибки «сервер недоступен».
- **RemoteEventBridge** (`packages/core/src/remote/event-bridge.ts`) — транслирует
  SSE сервера в локальный EventBus; события удалённых сессий переписываются в
  `remote:<id>` и доходят до UI.
- **LLM Proxy** (`packages/backend/src/routes/llm.ts`) — OpenAI-совместимый
  `POST /api/v2/llm/chat/completions`; прогоняет запросы через Gateway (ADR-036).
  При `remote.llm: server` локальные провайдеры запрещены полностью.
- **publish / fork** (`packages/core/src/remote/transfer.ts`) —
  `synth project publish <id> --remote` (локальный проект → сервер) и
  `synth project fork <id> --remote` (удалённый проект → локально); переносят
  проект + сессии + файлы (backend: `GET /sessions/:id/export`,
  `POST /sessions/import`).
- **Статус и offline:** `GET /api/v2/hybrid/status` →
  `{ enabled, connected, backendUrl, user }`; при недоступности сервера локальный
  мир работает, явные remote-операции возвращают 502 OFFLINE.

## Ключевые решения (AD)

Полный индекс архитектурных решений (AD) со статусами — в корневом
[AGENTS.md](../AGENTS.md), раздел «Индекс архитектурных решений».

## Структура монорепозитория

```
synth/
├── pnpm-workspace.yaml       # pnpm workspaces
├── tsconfig.base.json        # общий конфиг TypeScript
├── eslint.config.js          # линтер
├── .prettierrc               # форматтер
├── scripts/                  # dev.sh, build.sh, standalone.sh, hybrid.sh, publish*.sh, version-bump.sh, changelog.sh, …
└── packages/
    ├── shared/   → @itphx/synth-shared
    ├── core/     → @itphx/synth-core
    ├── backend/  → @itphx/synth-backend
    ├── ui/       → @itphx/synth-ui
    ├── sdk/      → @itphx/synth-sdk (клиент публичного API, ADR-052)
    └── synth/    → @itphx/synth (тонкая CLI-обёртка, bin: synth)
```

## Модель «Runner» (планируется)

Мост между бэкендом и внешними движками (opencode/cline) — **не реализован**
(план: ADR-018, PROP-050). Задуманный раннер поднимает LLM Proxy и маршрутизирует
запросы в выбранный движок; движки stateless (история — на бэкенде).

## Stateless модель движка

История сообщений — на бэкенде. Движок получает на вход:

- Историю сообщений
- Новое сообщение от пользователя
- Контекст (system prompt, проект, статус)

Это обеспечивает:

- Коллаборацию (несколько пользователей в одной сессии)
- Переключение движка без потери контекста
- Перезапуск движка без потери истории
- Очередь сообщений на бэкенде, доставка по одной

## Внешние события и хуки

Ядро ADR-030 (min) + ADR-089: события агента и внешние события идут через общую
hook-шину, а создание сессий сведено в один funnel.

- **`HookBus`** (`engine/hooks/hook-bus.ts`) — шина хуков жизненного цикла агента
  (`session_requested`, `external_event`, …); async-хуки с таймаутом
  (`HOOK_ASYNC_TIMEOUT_MS`), результат может заблокировать событие (`blocked`/`reason`).
  Это фундамент; Plugin SDK и загрузка плагинов (PROP-090) не реализованы.
- **`EventRouter`** (`engine/events/event-router.ts`) — чистое решение по событию
  плюс запись в журнал. Порядок `decide`: `allowedSources` (не в списке → `drop`) →
  dedup по `dedupKey` (ленивый кэш из журнала) → явный `EventBinding` по
  `threadKey`/`chatKey` → зарегистрированные `RouteRuleProvider` (первый непустой) →
  фоллбек `drop no_route`. Все дропы «аудируемые» — событие не теряется молча.
- **`EventBinding`** (`bound | ephemeral | queue`) связывает внешний адрес
  (`source` + `chatKey`/`threadKey`) с сессией/шаблоном; хранится в
  `EventBindingStore`, решения — в `EventJournalStore` (журнал, ADR-005).
- **API-ключи привязок** (`EventApiKeyStore`, `{dataDir}/events/api-keys.json`, ADR-089/ADR-052) —
  первый срез публичного API: обязательная уникальная (глобально) метка `label` +
  `description`/`expiresAt`/`rateLimitPerMinute`, мягкий отзыв (`revoke`); секрет
  `synth_evt_<base64url>` хранится только как sha256-хеш,
  наружу отдаётся один раз; приём `POST /api/v2/events` по `Authorization: Bearer <binding-key>`
  аутентифицирует без пользовательских кред (source/чат из привязки), использование пишется
  в журнал (`keyId`); per-key rate limit — лимит ключа либо глобальный `events.keyRateLimitPerMinute`
  (`KeyRateLimiter`, 429); ключи — инстанс-локальные (не переносятся publish/fork).
- **Service-key** (`ServiceApiKeyStore`, `{dataDir}/service-keys.json`, ADR-052 этап I) — независимый
  от binding-key scoped-ключ инстанса для внешних сервисов: секрет `synth_svc_<base64url>` (at-rest
  sha256), обязательная уникальная `label`, `roles`/`scopes`/`allowedProjects` (проектная проекция)/
  срок/лимит; аутентифицирует машину в синтетического пользователя, `scopes` ограничивают эндпоинты
  (`requireScope`, `packages/core/src/server/service-scope.ts`), проекция — sessions/events/schedules.
  Эндпоинты CRUD и scopes — `docs/API_V2.md` §5.28/§1.
- **`RequestSessionService`** (`engine/events/request-session.ts`) — единый funnel
  создания сессии: `request` (явное создание из UI/CLI/агента, эмит
  `session_requested`) и `handleEvent` (`external_event` → `decide` → материализация
  `deliver` → `record`). Через него идёт и `POST /api/v2/sessions`; внешний контракт
  эндпоинта не изменился.
- **`EventIngress`** (`engine/events/ingest.ts`) — точка приёма: нормализует вход в
  `SynthEvent` (id `evt_<uuid>`, дефолтный dedup-ключ) и передаёт в funnel.
- **Webhooks** (`WebhookStore` + `WebhookService`, ADR-052 этап II) — **исходящий** мост,
  обратный контур к входящим событиям: `WebhookService` подписывается на все события шины
  (`eventBus.subscribeAll`), фильтрует их паттернами подписки (`matchWebhookEvent`) и шлёт
  подписчикам HTTP-POST с HMAC-SHA256-подписью; retry/backoff с джиттером, дедуп по
  (подписка + событие), таймаут, журнал доставок (`{dataDir}/webhooks/deliveries.jsonl`) и
  SSRF-политика (`engine/webhooks/network.ts` поверх `engine/mcp/network-policy.ts`). Эндпоинты и
  формат подписи — `docs/API_V2.md` §5.29; конфиг — `docs/CONFIGURATION.md` (секция `webhooks`).
- **Ephemeral-сессии** для внешних событий получают `expiresAt` из `ttl`
  (`config.events.ephemeralTtl`, default `24h`); очистка — `startEphemeralSweeper`.
  Режим `queue` доставляется как `defer` (сообщение в очередь без старта процессора).

Цепочка:

```text
внешнее событие → EventIngress (SynthEvent) → RequestSessionService
  → HookBus (external_event) → EventRouter.decide → материализация
  → сессия (bound/ephemeral/queue) → deliver → журнал/UI-событие
```

API-эндпоинты и RBAC — `docs/API_V2.md` §5.26; конфиг — `docs/CONFIGURATION.md`
(секция `events`). Источники/интеграции: шедулер ADR-051 (cron), API-ключи привязок, service-key
со scopes/проектной проекцией, webhooks, public-OpenAPI (28 операций, `GET /api/v2/openapi.json`)
и SDK `@itphx/synth-sdk` — **ADR-052 закрыт целиком (этапы I–IV: включая перевод Telegram-шлюза
на scoped service-key)**; первый add-on — Telegram-шлюз (`addons/synth-gateway-telegram`) —
реализован; не реализованы плагины (Plugin SDK, PROP-090) и пайплайны (PROP-059).

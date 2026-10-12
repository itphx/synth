# synth-backend (@itphx/synth-backend)

> Локальные правила пакета. Общее — корневой `AGENTS.md`; спецификация эндпоинтов — `docs/API_V2.md`.

## Роль и границы

- Hono API Hub: единое дерево `/api/v2/*` поверх ядра `@itphx/synth-core` (AD-017, AD-022).
- LLM-вызовы сам не считает и провайдеров не реализует: хранит конфиги провайдеров/моделей и отдаёт их ядру.
- Движки не поднимает и их процессами не управляет.
- HTML не рендерит: UI и админка — в другом пакете (`synth-ui`).
- Движки stateless: история и состояние живут на бэкенде (через core), не в движке (AD-022).

## Что из core, что локально

Бэкенд — композиция: ядро даёт логику, backend — транспорт, auth и точки монтирования.

Из `@itphx/synth-core` (импорты в `src/app.ts`):

| Из core | Зачем |
|---|---|
| `FileStore`, `SessionManager` | сессии и история |
| `EventBus` | шина событий сессии (backend надстраивает `EventHub`) |
| `RequestSessionService`, `EventRouter`, `EventIngress`, `EventBindingStore`, `EventJournalStore`, `RouteRuleStore`, `EventApiKeyStore`, `ProjectRuleProvider`, `eventToMessage`, `startEventJournalPruner` | единый funnel создания сессии, приём внешних событий, API-ключи привязок, правила маршрутизации и retention-очистка журнала (AD-089/AD-052) |
| `ScheduleStore`, `SchedulerRuleProvider`, `SchedulerService`, `createSchedulerRoutes` | расписания планировщика (AD-051 срез / AD-089) |
| `QueueProcessorManager`, `enqueueUserMessage` | очередь сообщений |
| `ContextConfig`, `ContextBuilder`, `ContextOptimizer` | контекст и его оптимизация |
| `ChatOrchestrator` | оркестрация LLM, tools, permissions |
| `McpManager`, `McpRegistryStore` | MCP-серверы: менеджер + единый реестр (AD-071) |
| `RuntimeSettingsStore`, `createSettingsRoutes` | эндпоинты `/api/v2/settings` (workspace/mcp) |
| `DictionaryStore`, `createDictionaryRoutes` | эндпоинты `/api/v2/dictionaries` |
| `FileProfileStore` | профили пользователей (seed test-users при debug) |
| `AuditLogger`, `RateLimiter`, `GatewayProvider`, `SecretPatternStore`, `ProtectedPathsStore` | LLM Gateway (AD-036) |
| `SSHKeyStore` | SSH-ключи агентов, шифрование at-rest (AD-076) |
| `createGitRoutes`, `createSshKeyRoutes`, `createAgentSshKeyRoutes` | git-реестр и SSH-ключи (AD-076) |
| `createFsRoutes`, `resolveProjectWorkspace` | FS-роуты, project-aware workspace (AD-075) |
| `detectRuntimeDeps` | детект внешних бинарников (`git`/`rg`/`sh`) при старте → `runtimeDeps` оркестратора (AD-078) |

Локально только:

- `src/app.ts` — фабрика `createBackendApp()`; `src/main.ts` — listen и graceful shutdown.
- `src/routes/*` — Hono-роутеры; `src/auth/*` — middleware и OIDC; `src/events/hub.ts` — `EventHub`.
- `src/lib/*` — `app-config` (конфиг), `defaults-store` (умолчания оформления), `i18n`.
- `src/middleware/rate-limiter.ts` — единственный middleware пакета.

Своей реализации сессий, очереди, проектов, провайдеров и контекста в backend нет — это core.

**Фабрика `createBackendApp(opts)`:**

- на время построения подменяет `process.env` (`SYNTH_DATA_DIR`, `SYNTH_AUTH_DEBUG`, `SYNTH_API_KEY`, `SYNTH_PORT`, `SYNTH_PROVIDER_*`) и восстанавливает после;
- порядок сборки: конфиг → CORS → `attachUser` → stores → orchestrator → `eventHub` → монтирование роутов;
- возвращает handle: `app`, `config`, `auth`, `eventBus`, `eventHub`, `sessionManager`, `projectStore`, `orchestrator`, `queueManager`, `settingsStore`, `listen`;
- `listen(port = 0)` поднимает HTTP-сервер и `/ws/events`, возвращает фактический порт (0 — эфемерный для тестов).

**Хранилище (core-классы, AD-005):**

- `JsonStore<T>` (из `@itphx/synth-core`) — `<dataDir>/<subdir>/<key>.json`; атомарная запись через shared `atomicWrite` (tmp → rename) + per-key `AsyncLock`; ключ проверяется от `..` и `\`; `list()` собирает вложенные ключи (`provider/model`).
- `ProjectStore` (из `@itphx/synth-core`) — `<dataDir>/projects/<id>.json`; один `AsyncLock` на все проекты; `create()` инициализирует план, лог и владельца.
- Своих копий хранилищ в backend нет — используются core-классы (единый источник истины).
- Прямой доступ роутеров к `$SYNTH_DATA_DIR` в обход stores запрещён.

## Правила эндпоинта

- Всё API — единое дерево `/api/v2/*`; админка отличается правами, не путём.
- Роутер — фабрика `createXxxRoutes(...)`, монтируется в `src/app.ts` через `app.route(...)`. Новый роутер = фабрика + одна строка в `app.ts`.
- RBAC — только через `AuthKit`: `getCurrentUser`, `attachUser`, `requireAuth`, `requireAdmin`, `requirePermission(...roles)` (`src/auth/middleware.ts`). Проверок ролей внутри роутеров не хардкодить.
- `attachUser` вешается глобально (`app.use('*', ...)`) до роутов и просто кладёт `c.set('user')`; `requireAuth` возвращает 401, `requireAdmin`/`requirePermission` — 403.
- Формат ошибки — `{ error: { code, message } }`; встречающиеся коды: `VALIDATION_ERROR`, `NOT_FOUND`, `UNAUTHORIZED`, `FORBIDDEN`, `BAD_REQUEST`, `RATE_LIMITED`, `INTERNAL_ERROR`. Исключение: FS и git отдают shared-форму `{ error: { error, code } }` (`FsError`).
- Общий 404 — `app.notFound` в `src/app.ts`; тексты — через `t()`.
- Rate limiter (`createRateLimiter(max, windowMs)`; in-memory, ключ — `Authorization` или `x-forwarded-for`) вешается на публичные мутации: `prompt`, `spa-login`, `providers/:name/test`, `models/fetch`, LLM-прокси.
- Вход валидируется Zod-схемами из `@itphx/synth-shared` (образец — `src/routes/models.ts`).
- Порядок регистрации важен: статические сегменты объявляй раньше параметрических (в `routes/agents.ts` `/all` зарегистрирован до `/:id`).
- Часть admin-роутов живёт в `src/main.ts`, а не в `app.ts` (`POST /admin/shutdown`, заглушка `GET /admin/sessions/blocked`), т.к. требует server/graceful shutdown.
- CORS — динамический: explicit `SYNTH_CORS_ORIGIN` → белый список `synth.server.allowedOrigins` → разрешить всё.

## Монтирование роутов (`src/app.ts`)

| Префикс | Источник |
|---|---|
| `/auth` | local `routes/auth.ts` (логин, сессии, профиль, avatar) |
| `/api/v2/projects` | `routes/projects.ts` — обёртка над core `createProjectRoutes` (RBAC-хуки owner/EDITOR/LEAD/ADMIN, managed-provisioning, `/stats`, `/:id/mcp`) + `createProjectAccess` для git-роутов |
| `/api/v2/messages`, `/queue` | `routes/{messages,queue}.ts` — обёртки над core `createMessageRoutes`/`createQueueRoutes` (i18n, `onMessagesChanged` = `recalc-can-summarize`) |
| `/api/v2/agents` | `routes/agents.ts` — обёртка над core `createAgentRoutes` (guards: `GET /` = `requireAuth`, `/all`+мутации = `requireAdmin`) |
| `/api/v2/mcp` | core `createMcpRoutes` (`/probe`) + backend `routes/mcp-registry.ts` (legacy `/servers*`, `/session/:id`, `/registry*`, AD-071) |
| `/api/v2/context`, `/users` | local `routes/*` |
| `/api/v2/fs` | core `createFsRoutes` (AD-075): managed opts — `requireProjectId`, `deny`, `getProjectWorkspace` (`resolveProjectWorkspace`, strict) |
| `/api/v2/git` | core `createGitRoutes` (T4): `authorizeProject` = `canEditProjectContent` (owner/EDITOR/LEAD/ADMIN), read (`scan/log/commit`) — `requireAuth` |
| `/api/v2/ssh-keys`, `/api/v2/agents/:agentId/ssh-keys` | core `createSshKeyRoutes` / `createAgentSshKeyRoutes`: чтение — `requireAuth`, запись — `requireAdmin` (AD-076). В гибриде nested-путь проксируется core на backend (`REMOTE_PROXY_PATTERNS`) |
| `/api/v2/sessions` | `routes/sessions.ts` — обёртка над core `createSessionRoutes` (создание — единый funnel `RequestSessionService`, AD-089) + backend-only (MCP-скоуп, secrets, export/import, debug, optimization, notes) |
| `/api/v2/providers` | `routes/providers.ts` — обёртка над core `createProviderRoutes` + `fetch-icon` |
| `/api/v2/models` | `routes/models.ts` — обёртка над core `createModelRoutes` (RBAC + rate limit на `fetch`) |
| `/api/v2/settings` | core `createSettingsRoutes` (`llm-gateway`/`security`/`tools-policy`/`mcp-policy`/`tools-disabled`/`default-agent`/`workspace-policy`; `GET/PUT/DELETE /settings/events` — runtime-настройки «События» (AD-089), мутации под `eventsWriteGuard` = `requirePermission('ADMIN')`) |
| `/api/v2/dictionaries` | core `createDictionaryRoutes` (writeGuard = `requireAdmin`) |
| `/api/v2/audit`, `/logs`, `/gateway` | local (LLM Gateway: аудит, логи, regex-паттерны) |
| `/api/v2/llm` | local `routes/llm.ts` (LLM Proxy) |
| `/api/v2/admin/debug` | local `routes/debug.ts` |
| `/api/v2/events` | core `createEventRoutes`: `POST /` — ingest (`ingestPreGuard` = rate limit 120/мин до выбора способа аутентификации; API-ключ привязки через `resolveApiKeySecret`/`touchApiKey`, иначе `ingestGuard = requireAuth`; per-key rate limit — свой `rateLimitPerMinute` либо `getKeyRateLimitPerMinute()` → 429; `isEnabled()` — мастер-выключатель → 503), `/bindings` и `/routes` — CRUD (чтение `requireAuth`; мутации и чтение ключей — `writeGuard`/`keyReadGuard` = `requirePermission('ADMIN','LEAD')`; правила валидируют сессию/`agentTemplate` через `sessionExists`/`resolveAgentTemplate`), `/bindings/:id/keys` — CRUD API-ключей (`POST` создание + `PATCH` метаданных + `POST .../revoke` + `DELETE`), `GET /journal`; `GET /` — inline SSE-хендлер (AD-089). i18n-ключи: `errors.validation.invalidEventKey`, `errors.validation.invalidEventKeyUpdate`, `errors.notFound.eventKey`, `errors.conflict.eventKeyLabel`, `errors.rateLimited.eventKey`, `errors.unavailable.eventsDisabled` |
| `/api/v2/schedules` | core `createSchedulerRoutes` (AD-051 срез / AD-089): чтение — `requireAuth`, мутации — `requireAdmin`; `POST /:id/run` — `requireAdmin` + rate limit (10/60 c, `runMiddleware`), `GET /:id/jobs` — Job-история (AD-051); `SchedulerRuleProvider` на `eventRouter`, `SchedulerService.start()` по `scheduler.enabled` |
| `/health`, `/api/v2/health` | публичные, без auth |
| `/api/v2/i18n/current`, `/api/v2/i18n/translations/ru\|en` | inline в `app.ts` |

`/api/v2/{providers,models,sessions,projects,messages,queue,agents}` — тонкие обёртки над core-фабриками; `/api/v2/{fs,git,ssh-keys,settings,dictionaries}` — прямое монтирование core-фабрик с RBAC/спецификой в `opts`: общая логика в core, backend добавляет `requireAdmin`/`requirePermission`/`authorizeProject`, rate limiter и backend-only роуты (например, `models/fetch` — rate limit, `providers/fetch-icon`, `mcp-registry`). Дублировать хендлеры core нельзя.

## Аутентификация

- Порядок в `getCurrentUser`: cookie `user_session` → debug test-users (по `Authorization`) → OIDC JWT (если `oidc.enabled`) → единый API-key (`SYNTH_API_KEY`, роль ADMIN, вне debug/OIDC).
- Cookie-сессии — in-memory (`Map`), переживают только процесс; срок — `sessionMaxAgeMinutes`.
- Логин/логаут/сессия и **профиль** — под `/auth/*`: `/auth/profile`, `/auth/profile/preferences`, `/auth/profile/avatar`.
- Debug-ключи и `SYNTH_AUTH_DEBUG` описаны в корневом `AGENTS.md` — не дублировать; сами ключи задаёт `buildAuthConfig` в `src/lib/app-config.ts`.
- `requireAdmin`/`requirePermission` читают `c.get('user')`, поэтому сначала должен отработать глобальный `attachUser`.

## Транспорт событий

- Единственный WS-канал — `/ws/events` (upgrade в `src/app.ts`); один клиент на пользователя, автоподписка на все его сессии.
- SSE-фоллбек — `GET /api/v2/events` (`auth.requireAuth`, keepalive раз в 30 c).
- `EventHub` (`src/events/hub.ts`) — диспетчер подписок поверх core-`EventBus`; новых транспортных каналов не плодить (AD-008/009/024).
- Новую сессию подписывай через `eventHub.subscribeToSession(...)`, а не сырым `eventBus.subscribe`.
- Сессии, создаваемые events-funnel'ом (`RequestSessionService`: external `ephemeral`/`bind`, explicit из тула `task`), `app.ts` подписывает автоматически через `deps.onSessionMaterialized` → `eventHub.subscribeToSession(owner, sessionId)` — клиент, подключённый до создания сессии, получает её события. Владелец сессии — по `events.identityMap` (`identity.chatKey`/`principalId`), затем per-event (пользователь/владелец ключа привязки), `identity.principalId`, `resolveOwnerId`; `onEventsChange` прокидывает `identityMap` в funnel live.

## LLM Proxy

- Единственный LLM-эндпоинт backend — `POST /api/v2/llm/chat/completions` (OpenAI-совместимый), роутер `src/routes/llm.ts`.
- Реализован на ядре: `GatewayProvider` + `ProviderFactory` + `AuditLogger`/`RateLimiter`/`SecretPatternStore`. Любой LLM-вызов — только через Gateway (AD-036); провайдера напрямую не инстанцировать.
- Один `AuditLogger` и один payload-лог шарятся между оркестратором и чтением (`/api/v2/audit`, `/api/v2/logs/llm`) — не создавай вторые.
- Runtime-тумблеры Gateway/security из UI применяются на живой оркестратор через колбэки `onLlmGatewayChange`/`onSecurityChange` в `app.ts`.

## Конфигурация и i18n

- Единственная точка входа конфига — `loadBackendConfig()` (`src/lib/app-config.ts`) → shared `loadConfig`; возвращает `{ synth, dataDir, workspacesRoot, port, auth }`.
- `buildAuthConfig` читает `SYNTH_AUTH_DEBUG`, `SYNTH_API_KEY`, `SYNTH_OIDC_*`, `SYNTH_SESSION_MAX_AGE`, `SYNTH_TEST_*_KEY`; тестовые пользователи — только при debug.
- `SYNTH_PROVIDER_*_API_KEY|URL|MODEL|TYPE` синхронизируются в `JsonStore` провайдеров/моделей при старте (`syncProvidersFromEnv`).
- `packages/backend/config.yaml` содержит только `mcp.servers`; остальной конфиг ищется каскадно (`findConfigPath`). В dev `dev.sh` задаёт `SYNTH_CONFIG` на этот файл (если он существует), поэтому `mcp.servers` подхватываются; `loadConfig` учитывает `SYNTH_CONFIG` (AD-023).
- При старте `mcp.servers` из config сидируются в `McpRegistryStore` — единственный источник истины MCP (AD-071). Legacy-роуты `/api/v2/mcp/servers*` и `/mcp/session/:id` — тонкие адаптеры над реестром; собственного хранилища MCP-конфига (`YamlMcpConfigStore`/`McpConfigStore`) в backend больше нет.
- Сообщения ошибок — через `t()` из `src/lib/i18n.js`; язык `/api/v2/i18n/current` определяется по `Accept-Language` (inline в `app.ts`).

## Тесты и запуск

- Тесты: `pnpm --filter @itphx/synth-backend test` (скрипт `vitest run`, `packages/backend/vitest.config.ts`).
- Юнит-тесты роутеров поднимают Hono с mock-`AuthKit`; сквозные — `createBackendApp()` in-process (см. `src/integration/hybrid.integration.test.ts`).
- `createBackendApp` сам изолирует env (dataDir, debug auth, ключи, провайдеры) — в тестах не выставляй env вручную поверх.
- Dev-запуск: `./scripts/dev.sh backend` (порт и env — в корневом `AGENTS.md`).
- Сборка пакета: `tsc -p tsconfig.build.json` (`package.json`); системные дефиниции агентов берутся из `@itphx/synth-core`, собственных ассетов у backend нет.

## Чего не делать

- Не создавать модули, дублирующие core (сессии, очередь, провайдеры, контекст, оркестратор) — импортировать из `@itphx/synth-core`.
- Не дёргать LLM/SDK мимо core-шного `GatewayProvider`.
- Не плодить транспортные каналы — `EventHub` + `GET /api/v2/events`.
- Не хардкодить проверки прав вне `requireAuth`/`requireAdmin`/`requirePermission`.
- Не писать в `$SYNTH_DATA_DIR` в обход `FileStore`/`JsonStore`/`ProjectStore` (AD-005).
- Не держать состояние сессий в памяти backend — источник истины на диске через core.
- Не редактировать `packages/backend/config.yaml` ради настроек, кроме MCP: остальной конфиг идёт через `loadBackendConfig`.
- Не добавлять роут в обход `createXxxRoutes` + `app.route(...)` — иначе он потеряется при переиспользовании core-фабрик.
- Не дублировать хендлеры core-роутов в backend: `providers`/`models`/`sessions`/`projects`/`messages`/`queue`/`agents`/`fs`/`settings`/`dictionaries` — тонкие обёртки над core-фабриками, здесь остаются только RBAC, rate limit, i18n (`messages`), хуки и backend-only роуты.

## Куда смотреть

| Тема | Документ |
|---|---|
| Полная спека API по коду | `docs/API_V2.md` |
| Архитектура | `docs/ARCHITECTURE.md` |
| Конфигурация | `docs/CONFIGURATION.md`, AD-023 |
| OIDC / Keycloak | `docs/KEYCLOAK.md` |
| API v2 / Hono | AD-017 |
| Движки и runner-стек | AD-022 |
| Транспорт EventHub + TransportClient | AD-024 |
| LLM Gateway | AD-036 |
| Гибрид | AD-042, `docs/HYBRID.md` |

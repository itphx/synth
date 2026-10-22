# synth-backend (@itphx/synth-backend)

> Локальные правила пакета. Общее — корневой `AGENTS.md`; спецификация эндпоинтов — `docs/API_V2.md`.

## Роль и границы

- Hono API Hub: единое дерево `/api/v2/*` поверх ядра `@itphx/synth-core` (ADR-017, ADR-022).
- LLM-вызовы сам не считает и провайдеров не реализует: хранит конфиги провайдеров/моделей и отдаёт их ядру.
- Движки не поднимает и их процессами не управляет.
- HTML не рендерит: UI и админка — в другом пакете (`synth-ui`).
- Движки stateless: история и состояние живут на бэкенде (через core), не в движке (ADR-022).

## Что из core, что локально

Бэкенд — композиция: ядро даёт логику, backend — транспорт, auth и точки монтирования.

Из `@itphx/synth-core` (импорты в `src/app/deps.ts`):

| Из core | Зачем |
|---|---|
| `FileStore`, `SessionManager` | сессии и история |
| `EventBus` | шина событий сессии (backend надстраивает `EventHub`) |
| `RequestSessionService`, `EventRouter`, `EventIngress`, `EventBindingStore`, `EventJournalStore`, `RouteRuleStore`, `EventApiKeyStore`, `IdentityClaimStore`, `ProjectRuleProvider`, `eventToMessage`, `startEventJournalPruner` | единый funnel создания сессии, приём внешних событий, API-ключи привязок, одноразовые claim-коды идентичностей, правила маршрутизации и retention-очистка журнала (ADR-089/ADR-052) |
| `ServiceApiKeyStore`, `createServiceKeyRoutes`, `requireScope`, `checkServiceProjectProjection`, `getServiceCredential` | scoped service-key (ADR-052 этап I): реестр ключей, CRUD-роуты, scope-гейт и проектная проекция |
| `WebhookStore`, `WebhookDeliveryStore`, `WebhookService`, `startWebhookDeliveryPruner`, `createWebhookRoutes` | исходящие webhooks (ADR-052 этап II): реестр подписок, журнал доставок, движок над `EventBus.subscribeAll`, retention-очистка и CRUD-роуты |
| `createMaintenanceRoutes` | admin-API обслуживания инстанса (ADR-091/ADR-092): status/doctor/migrations/backups/restore/restart (restart — graceful exit 75, см. `configureRestart` в `main.ts`) |
| `AnalyticsService`, `createAnalyticsRoutes` | отчёты аналитики (ADR-102): чтение суточных роллапов; RBAC через opts (`resolveElevated`/`resolveAuditor`/`resolveUserId`), i18n — `messages` |
| `createProjectPortableRoutes` | HTTP-перенос проекта (ADR-091 §6): `GET /api/v2/projects/:id/export`, `POST /api/v2/projects/import` |
| `ScheduleStore`, `SchedulerRuleProvider`, `SchedulerService`, `createSchedulerRoutes` | расписания планировщика (ADR-051 срез / ADR-089) |
| `QueueProcessorManager`, `enqueueUserMessage` | очередь сообщений |
| `ContextConfig`, `ContextBuilder`, `ContextOptimizer` | контекст и его оптимизация |
| `ChatOrchestrator` | оркестрация LLM, tools, permissions |
| `McpManager`, `McpRegistryStore` | MCP-серверы: менеджер + единый реестр (ADR-071) |
| `RuntimeSettingsStore`, `createSettingsRoutes` | эндпоинты `/api/v2/settings` (workspace/mcp) |
| `DictionaryStore`, `createDictionaryRoutes` | эндпоинты `/api/v2/dictionaries` |
| `FileProfileStore` | профили пользователей (seed test-users при debug) |
| `AuditLogger`, `RateLimiter`, `GatewayProvider`, `SecretPatternStore`, `ProtectedPathsStore` | LLM Gateway (ADR-036) |
| `SSHKeyStore` | SSH-ключи агентов, шифрование at-rest (ADR-076) |
| `createGitRoutes`, `createSshKeyRoutes`, `createAgentSshKeyRoutes` | git-реестр и SSH-ключи (ADR-076) |
| `createFsRoutes`, `resolveProjectWorkspace` | FS-роуты, project-aware workspace (ADR-075) |
| `PipelineEngine`, `createToolStepExecutor`, `createScriptStepExecutor`, `createHumanStepExecutor`, `createAgentStepExecutor`, `createPipelineExitHandler`, `buildPipelineStepContext`, `checkPipelineToolPermission` | движок пайплайнов (ADR-101) — второй движок рядом с оркестратором: цикл прогона, исполнители видов шага (`agent`/`script`/`tool`/`human`), контекст шага, permission-обёртка, обработчики выходов (`session`/`file`/`gateway`/`none`) |
| `createPipelineProjectRoutes`, `createPipelinesRoutes`, `createPacksRoutes` | HTTP-контур пайплайнов: пайплайны проекта + прогоны + шаблоны инстанса (ADR-101, Э6), legacy-контур «декларация + учёт» (ADR-100) и реестр пакетов расширений (ADR-086 §5) |
| `createPipelineMetrics` | коллектор метрик `synth_pipeline_*` (ADR-094/ADR-101) |
| `detectRuntimeDeps` | детект внешних бинарников (`git`/`rg`/`sh`) при старте → `runtimeDeps` оркестратора (ADR-078) |

Локально только:

- `src/app.ts` — фабрика `createBackendApp()` (фасад-композиция, ADR-095 шаг 4b) + модули `src/app/*`: `deps.ts` (сборка зависимостей: хранилища, оркестратор, событийное ядро/шедулер/webhooks, live-аксессоры), `mount-routes.ts` (весь порядок монтирования роутов), `listen.ts` (HTTP `listen` + WS `/ws/events`), `sse-events.ts` (`GET /api/v2/events`), `bootstrap.ts` (сид debug-профилей); `src/main.ts` — listen, `configureRestart` (ADR-092 п. 7: `resolveRestartMode` из `SYNTH_RESTART_MODE`, graceful shutdown → exit 75) и graceful shutdown.
- `src/routes/*` — Hono-роутеры; `src/auth/*` — middleware, OIDC и scope-гейты service-key
  (`service-scope.ts`: `scopeGuard`/`serviceProjectProjection`); `src/events/hub.ts` — `EventHub`.
- `src/lib/*` — `app-config` (конфиг), `defaults-store` (умолчания оформления), `i18n`.
- `src/middleware/rate-limiter.ts` — единственный middleware пакета.

Своей реализации сессий, очереди, проектов, провайдеров и контекста в backend нет — это core.

**Фабрика `createBackendApp(opts)`:**

- на время построения подменяет `process.env` (`SYNTH_DATA_DIR`, `SYNTH_AUTH_DEBUG`, `SYNTH_API_KEY`, `SYNTH_PORT`, `SYNTH_PROVIDER_*`) и восстанавливает после;
- порядок сборки: конфиг → CORS → `attachUser` → stores → orchestrator → `eventHub` → монтирование роутов;
- возвращает handle: `app`, `config`, `auth`, `eventBus`, `eventHub`, `sessionManager`, `projectStore`, `orchestrator`, `queueManager`, `settingsStore`, `webhookStore`, `webhookService`, `listen` (+ stop-функции `stopScheduler`/`stopEphemeralSweeper`/`stopEventJournalPruner`/`stopWebhookService`/`stopWebhookDeliveryPruner`);
- `listen(port = 0)` поднимает HTTP-сервер и `/ws/events`, возвращает фактический порт (0 — эфемерный для тестов).

**Хранилище (единый слой хранения, ADR-096):**

- `createBackendStorage(config)` (`src/app/deps.ts`) — **async** (`await`): собирает **единственный `StorageContext`** (доменные порты) через `createStorageContextAsync` по `storage.backend` (`file`|`memory`|`postgres`; env `SYNTH_STORAGE_BACKEND`, fail-closed на неизвестном явном значении) и делает это **до `auth`** — реестр `serviceKeys` нужен резолверу ключа, `mcpRegistry` — сидированию instance-серверов; `createBackendDeps` (тоже async) переиспользует тот же инстанс. backend **не конструирует стораджи напрямую** (ни новых классов, ни «россыпи» в роутах). Первым шагом функция вызывает `initTlsTrust({ security: config.synth.security }, process.env)` (ADR-099) — глобальный TLS/CA-dispatcher ставится **до** сборки хранилища/PG, дискавери OIDC и сида провайдеров; битый/отсутствующий CA — fail-closed (старт падает, не тихий фоллбэк).
- `JsonStore<T>` (из `@itphx/synth-core`, порт `DocumentRepository<T>`) — `<dataDir>/<subdir>/<key>.json`; атомарная запись через shared `atomicWrite` (tmp → rename) + per-key `AsyncLock`; ключ проверяется от `..` и `\`; `list()` собирает вложенные ключи (`provider/model`).
- `ProjectStore` (из `@itphx/synth-core`, порт `ProjectRepository`) — `<dataDir>/projects/<id>.json`; один `AsyncLock` на все проекты; `create()` инициализирует план, лог и владельца.
- `DefaultsStore` (порт `DefaultsRepository`) — теперь в core (`storage/defaults-store.ts`); в backend — реэкспорт (`src/lib/defaults-store.ts`) для прежних импортов.
- Своих реализаций стораджей в backend нет — используются порты/файловые реализации из core (единый источник истины).
- Прямой доступ роутеров к `$SYNTH_DATA_DIR` в обход порта запрещён.

**Деградированный режим хранилища (ADR-098).** При недоступности выбранного backend'а (напр. PostgreSQL) хранилище поднимается на файловом фоллбеке **строго read-only**: в `app.ts` после auth-роутов вешается `createStorageDegradedGuard` (из core `server/storage-degraded.js`): не-`ADMIN` → `503 STORAGE_DEGRADED` (доступ только администраторам), мутирующий метод (POST/PUT/PATCH/DELETE) вне allowlist → `503 STORAGE_DEGRADED_READONLY` (исключение — `/api/v2/maintenance` для ремонта); `GET`/диагностика проходят. Диагностика — `createStorageStatusRoutes` (`GET /api/v2/storage/status`: probe соединения + `recovery.restartRequired`, авто-возврата нет); `/health` и `/api/v2/health` отдают `status: 'degraded'` + блок `storage` (аддитивно к `{status, version, time}`) и `startedAt` (ISO старта процесса — общий с `GET/POST /api/v2/maintenance/restart`, ADR-092: UI ждёт смены после рестарта). Фоновые писатели (миграции, сид провайдеров, шедулер, webhooks, прунеры) в деградации отключаются — иначе split-brain.

**Наблюдаемость (ADR-094).** `createBackendApp` (`src/app.ts`):

- **Health/readiness** — core-фабрика `createHealthRoutes({ getStorageDegraded, getReadiness })`: `/health` и `/api/v2/health` (liveness, в деградации `status:'degraded'`), `/ready` — `200` после завершения композиции, `503` только старт/fail-closed; деградация хранилища readiness **не** снимает.
- **`/metrics`** монтируется в `app.ts` **до auth** (core `createMetricsRoutes`), вне `/api/v2`; `metricsEnabled = backendConfig.synth.metrics.enabled`, при `false` middleware не ставится и роут отдаёт 404, токен — `resolveMetricsToken(backendConfig.dataDir)`. HTTP-middleware `createHttpMetricsMiddleware` и `registerProcessMetrics` — тоже только при включении.
- **Админ-раздел «Метрики»** — core-фабрика `createMetricsSettingsRoutes` монтируется в `mount-routes.ts` на `/api/v2/settings` (`metrics`/`metrics/status`/`metrics/token`); `readGuard`/`writeGuard` = `requirePermission('ADMIN')`, deps — `settingsStore`, `dataDir`, `configEnabled` (`config.synth.metrics.enabled`), `runningEnabled`/реестр/readiness/backend/version из `ctx.metrics`. Runtime `enabled` применяется **после рестарта**, токен (write-only, файл `0600`) — сразу; env-токен → 409.
- **Доменные коллекторы** строятся в `createBackendDeps(..., metricsEnabled ? metrics : undefined)` (core `deps.ts`): bus/сессии/хранилище/decision/journal/**pipelines** (`synth_pipeline_*` — движок пайплайнов, ADR-101/ADR-094); LLM-прокси получает `onCall: createLlmCallRecorder(deps.metrics)` (`src/routes/llm.ts`), сессионные вызовы учитываются `GatewayProvider` при переданной опции `metrics` у `ChatOrchestrator`.
- **Остановка** — `handle.stopMetrics()` (процессные + доменные коллекторы) на graceful shutdown; `main.ts` до закрытия сервера ставит `setSynthReady(handle.metrics, 0)`, чтобы скрейп в момент остановки видел `synth_ready 0`.

Runbook и каталог метрик — `docs/OBSERVABILITY.md`; конфиг — `docs/CONFIGURATION.md` §«Наблюдаемость».

## Правила эндпоинта

- Всё API — единое дерево `/api/v2/*`; админка отличается правами, не путём.
- Роутер — фабрика `createXxxRoutes(...)`, монтируется в `src/app/mount-routes.ts` через `app.route(...)`. Новый роутер = фабрика + одна строка в `mount-routes.ts`.
- RBAC — только через `AuthKit`: `getCurrentUser`, `attachUser`, `requireAuth`, `requireAdmin`, `requirePermission(...roles)` (`src/auth/middleware.ts`). Проверок ролей внутри роутеров не хардкодить.
- `attachUser` вешается глобально (`app.use('*', ...)`) до роутов и просто кладёт `c.set('user')`. Семантика HTTP у guard'ов: нет аутентификации → **401 `UNAUTHORIZED`**; аутентифицирован, но роли/права не хватает → **403 `FORBIDDEN`** (`requireAuth` — только 401; `requireAdmin`/`requirePermission` — 401 без пользователя, 403 без нужной роли).
- Формат ошибки — `{ error: { code, message } }`; встречающиеся коды: `VALIDATION_ERROR`, `NOT_FOUND`, `UNAUTHORIZED`, `FORBIDDEN`, `BAD_REQUEST`, `RATE_LIMITED`, `INTERNAL_ERROR`. Исключение: FS и git отдают shared-форму `{ error: { error, code } }` (`FsError`).
- Общий 404 — `app.notFound` в `src/app.ts`; тексты — через `t()`.
- Rate limiter (`createRateLimiter(max, windowMs)`; in-memory, ключ — `Authorization` или `x-forwarded-for`) вешается на публичные мутации: `prompt`, `spa-login`, `providers/:name/test`, `models/fetch`, LLM-прокси.
- Вход валидируется Zod-схемами из `@itphx/synth-shared` (образец — `src/routes/models.ts`).
- Порядок регистрации важен: статические сегменты объявляй раньше параметрических (в `routes/agents.ts` `/all` зарегистрирован до `/:id`).
- Часть admin-роутов живёт в `src/main.ts`, а не в `app.ts`/`app/mount-routes.ts` (`POST /admin/shutdown`, заглушка `GET /admin/sessions/blocked`), т.к. требует server/graceful shutdown.
- CORS — динамический: explicit `SYNTH_CORS_ORIGIN` → белый список `synth.server.allowedOrigins` → разрешить всё.

## Монтирование роутов (`src/app/mount-routes.ts`)

| Префикс | Источник |
|---|---|
| `/auth` | local `routes/auth.ts` (логин, сессии, профиль, avatar) |
| `/api/v2/projects` | `routes/projects.ts` — обёртка над core `createProjectRoutes` (RBAC-хуки owner/EDITOR/LEAD/ADMIN + read `canRead` owner/член/LEAD/ADMIN, `resolveElevated` — LEAD/ADMIN видят все, managed-provisioning, `/stats`, `/:id/mcp`) + `createProjectAccess` для git-роутов; портативный перенос проекта (ADR-091 §6, core `createProjectPortableRoutes`): `GET /:id/export` (право чтения проекта), `POST /import` (любая роль; `mergeInto` — право редактирования), `messages` — i18n, владелец новых сущностей — текущий пользователь |
| `/api/v2/messages`, `/queue` | `routes/{messages,queue}.ts` — обёртки над core `createMessageRoutes`/`createQueueRoutes` (i18n, `onMessagesChanged` = `recalc-can-summarize`) |
| `/api/v2/agents` | `routes/agents.ts` — обёртка над core `createAgentRoutes` (guards: `GET /` = `requireAuth`, `/all`+мутации = `requireAdmin`) |
| `/api/v2/mcp` | core `createMcpRoutes` (`/probe`) + backend `routes/mcp-registry.ts` (legacy `/servers*`, `/session/:id`, `/registry*`, ADR-071; запись — ADMIN или service-key со scope `addons:install`) |
| `/api/v2/context`, `/users` | local `routes/*`; `/users` — чтение (список/детали) под `requireAdminOrScope('users:read')`, `GET /:id` отдаёт `identities` профиля (snake_case, ADR-089), мутации — `requireAdmin` |
| `/api/v2/fs` | core `createFsRoutes` (ADR-075): managed opts — `requireProjectId`, `deny`, `getProjectWorkspace` (`resolveProjectWorkspace`, strict) |
| `/api/v2/git` | core `createGitRoutes` (T4): `authorizeProject` = `canEditProjectContent` (owner/EDITOR/LEAD/ADMIN) — write-эндпоинты (`init/clone/register/remove/fetch`); `authorizeRead` = `canReadProject` (owner/участник/LEAD/ADMIN) — read (`scan/log/commit`). Проверка — граничный guard core-фабрики (ADR-089, инвариант 16) |
| `/api/v2/ssh-keys`, `/api/v2/agents/:agentId/ssh-keys` | core `createSshKeyRoutes` / `createAgentSshKeyRoutes`: чтение — `requireAuth`, запись — `requireAdmin` (ADR-076). В гибриде nested-путь проксируется core на backend (`REMOTE_PROXY_PATTERNS`) |
| `/api/v2/sessions` | `routes/sessions.ts` — обёртка над core `createSessionRoutes` (создание — единый funnel `RequestSessionService`, ADR-089; видимость — `resolveElevated` LEAD/ADMIN, `resolveMemberProjectIds` — проектные сессии участникам). **Доступ по id — единый prefix-guard** `createSessionAccessGuard` (`packages/core/src/server/session-access-guard.ts`): правило приходит из `createSessionAccessPredicate` фабрики, `read`/`write` выводится из HTTP-метода, `canAccess` — владелец|ADMIN, elevated — ADMIN/LEAD, `resolveCanAccessExtra` — роль в проекте (GET — `canReadProject`, мутация — `canEditProjectContent`); тот же предикат — у `messages`/`queue`. Дублирующих проверок в хендлерах нет. Матрица — `routes/session-idor-matrix.test.ts`. Backend-only под тем же guard: MCP-скоуп, secrets, export/import, debug, optimization, notes. `GET /:id/export` зарегистрирован ПОСЛЕ prefix-guard'а (доступ решает guard, в обработчике проверок нет); привилегию карты обфускации решает route-level guard core `createSessionExportGuard` (полный экспорт — владелец\|ADMIN\|AUDITOR, остальным читателям — очищенный ответ) |
| `/api/v2/messages`, `/api/v2/queue` | `routes/messages.ts` / `routes/queue.ts` — обёртки над core-фабриками с тем же `canAccess`/`resolveCanAccessExtra` (guard на `/:sessionId`, RBAC-wiring общий с sessions) |
| `/api/v2/providers` | `routes/providers.ts` — обёртка над core `createProviderRoutes` + `fetch-icon` (favicon тянется через `fetchWithEgressGuard` — единое доверие TLS/CA + SSRF-политика, ADR-099) |
| `/api/v2/models` | `routes/models.ts` — обёртка над core `createModelRoutes` (RBAC + rate limit на `fetch`) |
| `/api/v2/settings` | core `createSettingsRoutes` (`llm-gateway`/`security`/`tools-policy`/`mcp-policy`/`tools-disabled`/`default-agent`/`workspace-policy`; `GET/PUT/DELETE /settings/events` — runtime-настройки «События» (ADR-089), мутации под `eventsWriteGuard` = `requirePermission('ADMIN')`) + core `createMetricsSettingsRoutes` (ADR-094: `GET/PUT/DELETE /settings/metrics`, `GET /settings/metrics/status`, `PUT/DELETE /settings/metrics/token`; reading/mutations — `requirePermission('ADMIN')`) |
| `/api/v2/me` | core `createIdentityRoutes` (ADR-089): `GET /identities` — внешние идентичности текущего пользователя, `DELETE /identities/:provider/:externalId` — отвязка только своих (404 если нет), `POST /identities/claim` `{code}` — подтверждение владения идентичностью по одноразовому коду (201 `{identity}`; 400 `VALIDATION_ERROR` / 401 `UNAUTHORIZED` (профиль не определён) / 404 `NOT_FOUND` / 409 `CONFLICT`); `resolveProfileId` — id профиля по `username` аутентифицированного пользователя из AuthKit (НЕ OIDC `sub`), `claimStore` (`IdentityClaimStore`), `messages` — i18n. Прямой линковки нет — только claim-flow |
| `/api/v2/dictionaries` | core `createDictionaryRoutes` (writeGuard = `requireAdmin`) |
| `/api/v2/audit`, `/logs`, `/gateway` | local (LLM Gateway: аудит, логи, regex-паттерны) |
| `/api/v2/llm` | local `routes/llm.ts` (LLM Proxy) |
| `/api/v2/admin/debug` | local `routes/debug.ts` |
| `/api/v2/events` | core `createEventRoutes`: `POST /` — ingest (`ingestPreGuard` = rate limit 120/мин до выбора способа аутентификации; API-ключ привязки через `resolveApiKeySecret`/`touchApiKey`, иначе `ingestGuard = requireAuth`; per-key rate limit — свой `rateLimitPerMinute` либо `getKeyRateLimitPerMinute()` → 429; `isEnabled()` — мастер-выключатель → 503; ответ `201 {event, decision, sessionId}` + опциональное `identityHint {code, expiresAt}` — неизвестный отправитель, ADR-089 claim-flow), `/bindings` и `/routes` — CRUD (чтение `requireAuth`; мутации и чтение ключей — `writeGuard`/`keyReadGuard` = `requirePermission('ADMIN','LEAD')`; правила валидируют сессию/`agentTemplate` через `sessionExists`/`resolveAgentTemplate`; ADR-052 — `scopeGuard`/`serviceProjectProjection`), `/bindings/:id/keys` — CRUD API-ключей (`POST` создание + `PATCH` метаданных + `POST .../revoke` + `DELETE`), `GET /journal`; `GET /` — inline SSE-хендлер (ADR-089). i18n-ключи: `errors.validation.invalidEventKey`, `errors.validation.invalidEventKeyUpdate`, `errors.notFound.eventKey`, `errors.conflict.eventKeyLabel`, `errors.rateLimited.eventKey`, `errors.unavailable.eventsDisabled` |
| `/api/v2/schedules` | core `createSchedulerRoutes` (ADR-051 срез / ADR-089): чтение — `requireAuth`, мутации — `requireAdmin`; `POST /:id/run` — `requireAdmin` + rate limit (10/60 c, `runMiddleware`), `GET /:id/jobs` — Job-история (ADR-051); ADR-052 — `scopeGuard`/`serviceProjectProjection`; `SchedulerRuleProvider` на `eventRouter`, `SchedulerService.start()` по `scheduler.enabled` |
| `/api/v2/service-keys` | core `createServiceKeyRoutes` (ADR-052 этап I): CRUD scoped-ключей инстанса, `writeGuard`/`readGuard` = `requirePermission('ADMIN')`, `messages` — i18n, `resolveUserId` — id из `attachUser`; store `ServiceApiKeyStore` (`{dataDir}/service-keys.json`) |
| `/api/v2/webhooks` | core `createWebhookRoutes` (ADR-052 этап II): CRUD подписок исходящих webhooks + журнал доставок + тест, `writeGuard`/`readGuard` = `requirePermission('ADMIN')` (webhook может утекать данные на произвольный URL), `messages` — i18n, `resolveUserId` — id из `attachUser`, `isEnabled` — мастер `webhooks.enabled` (→ 503 на мутации/тест), `allowPrivateTargets` — SSRF-политика; store `WebhookStore` (`{dataDir}/webhooks/subscriptions.json`), журнал `WebhookDeliveryStore` (`{dataDir}/webhooks/deliveries.jsonl`), движок `WebhookService` над `EventBus.subscribeAll` |
| `/api/v2/maintenance` | core `createMaintenanceRoutes` (ADR-091/ADR-092): admin-API обслуживания инстанса — status/doctor/migrations/backups/restore/audit; `writeGuard`/`readGuard` = `requirePermission('ADMIN')` (архивы могут содержать секреты), `messages` — i18n, `maxUploadBytes` — лимит загрузки архива; восстановление — офлайн (планируется, применяется при следующем старте); `audit` — журнал обслуживания (порт `StorageContext.maintenanceAudit`, ADR-096), `GET`/`DELETE` |
| `/api/v2/analytics` | core `createAnalyticsRoutes` (ADR-102, только чтение): `GET /summary`, `/usage`, `/activity`, `/decision`, `/prompt`, `/export`; RBAC — `resolveElevated` = ADMIN/LEAD (сквозной обзор), `resolveAuditor` = AUDITOR (чтение всех отчётов), `resolveUserId` — id из `attachUser`: обычному USER `summary`/`decision` → 403, `usage`/`activity`/`prompt` принудительно фильтруются по его оси `user`; `messages` — i18n (`errors.validation.invalidAnalytics*`, `errors.forbidden.analytics`) |
| `/api/v2/projects/:id/pipelines*`, `/api/v2/pipeline-runs*`, `/api/v2/pipeline-templates*` | core `createPipelineProjectRoutes` (ADR-101, Э6): пайплайны проекта (черновик/публикация/удаление), прогоны (список, заголовок + журнал, HITL `resume`, отмена `cancel`), шаблоны инстанца (список + `instantiate`). RBAC — **по правилам проекта** (ADR-089 §5.5/§5.8): чтение — `canReadProject` (владелец/участник/`LEAD`/`ADMIN`), запись — `canEditProjectContent` (`OWNER`/`EDITOR`/`LEAD`/`ADMIN`; `VIEWER` читает, но не мутирует — инвариант 21); шаблоны — `requirePermission('ADMIN')`, инстанцирование — плюс право изменения целевого проекта. Проверка — граничные guard'ы фабрики (`projectGuard`/`runGuard`), в обработчиках проверок нет (инвариант 16); ADR-052 — `scopeGuard`/`serviceProjectProjection` (мутации — scope `automation:install` или роль ADMIN ключа). i18n-ключи: `errors.notFound.pipeline`/`pipelineRun`/`pipelineTemplate`, `errors.validation.invalidPipelineBody`/`invalidPipelineSpec`/`projectIdRequired`, `errors.conflict.pipelineNotPublished`/`pipelineInvalidState`/`pipelineNothingToPublish`/`pipelineRunFinished`/`pipelineTemplateUnsupported`, `auth.forbidden` |
| `/api/v2/pipelines` | core `createPipelinesRoutes` (ADR-100/ADR-051): legacy-контур «декларация + учёт» — определения инстанса и экземпляры; чтение — `requirePermission('ADMIN')` (реестр инстанса), ручной запуск — `requireAdminRoleOrScope('automation:install')`. ⚠️ **Устаревает (ADR-100)** — legacy-контур остаётся рабочим; UI переведён на модель движка пайплайнов (ADR-101 §5.35) |
| `/api/v2/packs` | core `createPacksRoutes` (ADR-086 §5): реестр установок пакетов расширений (`synth.pack`); чтение — `requirePermission('ADMIN')`, установка — `requireAdminRoleOrScope('automation:install')`, одобрение и снятие — только ADMIN |
| `/api/v2/plugins*` | core `createPluginsRoutes` (PROP-090 Ф5б-2): список/деталь, `install`, `approve`, `enable`, `disable`, `DELETE`, `update` (501); чтение — `requirePermission('ADMIN')`, установка/активация — `requireAdminRoleOrScope('addons:install')`, **approve и DELETE — только ADMIN**; `localInstall: false` (установка с локального пути → 403 `LOCAL_INSTALL_DISABLED`). Тест-перепись — `routes/plugins-rbac-matrix.test.ts` |
| `/api/v2/settings/plugins` | core `createPluginSettingsRoutes` (PROP-090): runtime-override политики плагинов (`enabled`/`executionEnabled`/`runtimeInstall`/`trustFloor`/`scan`/allow-deny/бюджеты), `restartRequired: true`; чтение и запись — ADMIN |
| `/health`, `/api/v2/health`, `/ready` | публичные, без auth (ADR-094: `/ready` — readiness, 200/503) |
| `/metrics` | core `createMetricsRoutes` в `app.ts` до auth, **вне** `/api/v2`: off by default (`metrics.enabled` → 404), опциональный bearer (401) |
| `/api/v2/i18n/current`, `/api/v2/i18n/translations/ru\|en` | inline в `src/app/mount-routes.ts` |

`/api/v2/{providers,models,sessions,projects,messages,queue,agents}` — тонкие обёртки над core-фабриками; `/api/v2/{fs,git,ssh-keys,settings,dictionaries}` — прямое монтирование core-фабрик с RBAC/спецификой в `opts`: общая логика в core, backend добавляет `requireAdmin`/`requirePermission`/`authorizeProject`, rate limiter и backend-only роуты (например, `models/fetch` — rate limit, `providers/fetch-icon`, `mcp-registry`). Дублировать хендлеры core нельзя.

## Аутентификация

- Порядок в `getCurrentUser`: service-key (`synth_svc_…`, ADR-052 — синтетический пользователь `{id:'service:<keyId>', roles}` + `scopes`/`allowedProjects`) → cookie `user_session` → debug test-users (по `Authorization`) → OIDC JWT (если `oidc.enabled`) → единый API-key (`SYNTH_API_KEY`, роль ADMIN, вне debug/OIDC). Резолвер ключа — `config.resolveServiceKey` (`ServiceApiKeyStore.resolveBySecret` + `touch`), неизвестный/отозванный/истёкший → 401.
- OIDC (`src/auth/oidc.ts`, ADR-099): дискавери, обмен кода/пароля и чтение JWKS идут через `egressFetch` (единое доверие TLS/CA), а `createRemoteJWKSet` получает **явный** транспорт `customFetch: (url, init) => egressFetch(url, init)` — не зависит от глобального состояния dispatcher.
- Scope-гейты service-key (`scopeGuard`/`serviceProjectProjection`, `src/auth/service-scope.ts`) работают поверх `requireAuth`/`requirePermission`: ограничивают только service-key (`403 SCOPE_REQUIRED`/`PROJECT_FORBIDDEN`), для интерактивных кред — no-op.
- Комбинированные guard'ы `src/auth/guards.ts` (ADR-052/O1): `requireAdminOrScope(...scopes)` — service-key требует scope (`403 SCOPE_REQUIRED`), интерактив — роль ADMIN (нет аутентификации → `401 UNAUTHORIZED`, аутентифицирован без ADMIN → `403 FORBIDDEN`); роуты `/mcp/servers*` PUT/DELETE/test, запись скиллов, чтение user-API. `requireScopeForServiceKey(...scopes)` — service-key требует scope, интерактив без изменений (`POST /mcp/registry`).
- Cookie-сессии — in-memory (`Map`), переживают только процесс; срок — `sessionMaxAgeMinutes`.
- Логин/логаут/сессия и **профиль** — под `/auth/*`: `/auth/profile`, `/auth/profile/preferences`, `/auth/profile/avatar`.
- Debug-ключи и `SYNTH_AUTH_DEBUG` описаны в корневом `AGENTS.md` — не дублировать; сами ключи задаёт `buildAuthConfig` в `src/lib/app-config.ts`.
- `requireAdmin`/`requirePermission` читают `c.get('user')`, поэтому сначала должен отработать глобальный `attachUser`.

## Транспорт событий

- Единственный WS-канал — `/ws/events` (upgrade в `src/app/listen.ts`); один клиент на пользователя, автоподписка на все его сессии.
- SSE-фоллбек — `GET /api/v2/events` (`auth.requireAuth`, keepalive раз в 30 c).
- `EventHub` (`src/events/hub.ts`) — диспетчер подписок поверх core-`EventBus`; новых транспортных каналов не плодить (ADR-008/009/024).
- **Watch-all клиенты (ADR-052).** `EventClient.allSessions` — клиент получает события **всех** сессий через глобальную подписку `eventBus.subscribeAll` (паритет со standalone-core), а не только своих по `listSessions({ userId })`. Так подключаются SSE/WS при аутентификации **service-key** (`service:<keyId>` владельцем сессий не является) и для «сквозного обзора» (`ADMIN`/`LEAD`, ADR-089). Для обычного USER поведение прежнее (только свои сессии). Без этого SSE-подписчик на service-key получал `0` подписок и не видел `stream.done` (ответы не доставлялись).
- **Webhooks (ADR-052 этап II).** Движок `WebhookService` подписывается на **ту же** шину `eventBus` (`subscribeAll`), что обслуживает сессии и глобальный SSE `GET /api/v2/events`: `subscribeAll` — глобальная подписка core-`EventBus`, доступная на общем инстансе, поэтому отдельный мост не нужен. Движок фильтрует события по паттернам подписок, шлёт HMAC-подписанные POST и пишет журнал; `webhooks.enabled: false` (дефолт) глушит диспетчеризацию. Retention — `startWebhookDeliveryPruner`; остановка — `stopWebhookService`/`stopWebhookDeliveryPruner` на shutdown.
- Новую сессию подписывай через `eventHub.subscribeToSession(...)`, а не сырым `eventBus.subscribe`.
- **Прогоны пайплайнов (ADR-101).** События `pipeline.run.*` публикуются в **инстансный канал** шины (`EventBus.publishInstance`, `INSTANCE_EVENT_CHANNEL`) — прогон не сессия. Их видят **watch-all клиенты** `EventHub` (те же, что получают события всех сессий: `ADMIN`/`LEAD` и service-key) и движок исходящих webhooks; обычный `USER` per-session событий прогонов не получает. Новых транспортных каналов не заводим (ADR-024/ADR-089, инвариант 6).
- Сессии, создаваемые events-funnel'ом (`RequestSessionService`: external `ephemeral`/`bind`, explicit из тула `task`), `src/app/deps.ts` подписывает автоматически через `deps.onSessionMaterialized` → `eventHub.subscribeToSession(owner, sessionId)` — клиент, подключённый до создания сессии, получает её события. Владелец сессии — по `deps.resolveExternalIdentity` (`createExternalIdentityResolver`: override `identityMap` по `identity.principalId`/`chatKey` → профиль `identities` по `principalId`), затем `events.identityMap` (фоллбек-совместимость), затем per-event (пользователь/владелец ключа привязки), `resolveOwnerId`. Резолвер читает `identityMap` геттером (`() => effectiveEventsSettings.identityMap`), поэтому `onEventsChange` применяет runtime-настройку live, без рестарта.
- **Права внешнего отправителя (ADR-089 этап 5).** Funnel считает эффективные роли отправителя (`resolveEffectiveRoles`: база — роли профиля, `identity.roles` только сужают, несопознанный → без прав/fail-closed) и передаёт `EventDeliveryContext {roles, linked}` в `deliver`; backend-`deliver` кладёт их в `metadata` хода (`effective_roles`/`identity_linked`) — аудит/attribution. `match`/RBAC backend (`requirePermission`) определяется **аутентификацией запроса** (service-account шлюза); роль-оси в permission-слое **нет by design** (роли = доступность эндпоинтов). Практический эффект: права машинного аккаунта шлюза больше не «раздаются» произвольным внешним отправителям; машинный доступ сужается scoped **service-key** (ADR-052).

## LLM Proxy

- Единственный LLM-эндпоинт backend — `POST /api/v2/llm/chat/completions` (OpenAI-совместимый), роутер `src/routes/llm.ts`.
- ADR-052: на прокси навешан `scopeGuard('llm:chat')` — service-key без `llm:chat` → `403 SCOPE_REQUIRED` (проектной проекции у прокси нет).
- Реализован на ядре: `GatewayProvider` + `ProviderFactory` + `AuditLogger`/`RateLimiter`/`SecretPatternStore`. Любой LLM-вызов — только через Gateway (ADR-036); провайдера напрямую не инстанцировать.
- ADR-094: прокси передаёт `onCall: createLlmCallRecorder(deps.metrics)` в `GatewayProvider` (при `metrics.enabled`) — единственная точка `synth_llm_*`; не считать LLM-вызовы в обход Gateway.
- Один `AuditLogger` и один payload-лог шарятся между оркестратором и чтением (`/api/v2/audit`, `/api/v2/logs/llm`) — не создавай вторые.
- Runtime-тумблеры Gateway/security из UI применяются на живой оркестратор через колбэки `onLlmGatewayChange`/`onSecurityChange` в `src/app/deps.ts`.

## Конфигурация и i18n

- Единственная точка входа конфига — `loadBackendConfig()` (`src/lib/app-config.ts`) → shared `loadConfig`; возвращает `{ synth, dataDir, workspacesRoot, port, auth }`.
- `buildAuthConfig` читает `SYNTH_AUTH_DEBUG`, `SYNTH_API_KEY`, `SYNTH_OIDC_*`, `SYNTH_SESSION_MAX_AGE`, `SYNTH_TEST_*_KEY`; тестовые пользователи — только при debug.
- `SYNTH_PROVIDER_*_API_KEY|URL|MODEL|TYPE|NUM_CTX` синхронизируются в `JsonStore` провайдеров/моделей при старте (`syncProvidersFromEnv`). `NUM_CTX` (целое > 0) задаёт `ProviderConfig.numCtx` — размер контекста провайдера (`num_ctx` Ollama); приоритет над `ModelConfig.contextWindow`.
- `packages/backend/config.yaml` содержит только `mcp.servers`; остальной конфиг ищется каскадно (`findConfigPath`). В dev `dev.sh` задаёт `SYNTH_CONFIG` на этот файл (если он существует), поэтому `mcp.servers` подхватываются; `loadConfig` учитывает `SYNTH_CONFIG` (ADR-023).
- При старте `mcp.servers` из config сидируются в `McpRegistryStore` — единственный источник истины MCP (ADR-071). Legacy-роуты `/api/v2/mcp/servers*` и `/mcp/session/:id` — тонкие адаптеры над реестром; собственного хранилища MCP-конфига (`YamlMcpConfigStore`/`McpConfigStore`) в backend больше нет.
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
- Не писать в `$SYNTH_DATA_DIR` в обход порта слоя хранения (`FileStore`/`JsonStore`/`ProjectStore`; ADR-096/ADR-005).
- Не держать состояние сессий в памяти backend — источник истины на диске через core.
- Не редактировать `packages/backend/config.yaml` ради настроек, кроме MCP: остальной конфиг идёт через `loadBackendConfig`.
- Не добавлять роут в обход `createXxxRoutes` + `app.route(...)` — иначе он потеряется при переиспользовании core-фабрик.
- Не дублировать хендлеры core-роутов в backend: `providers`/`models`/`sessions`/`projects`/`messages`/`queue`/`agents`/`fs`/`settings`/`dictionaries` — тонкие обёртки над core-фабриками, здесь остаются только RBAC, rate limit, i18n (`messages`), хуки и backend-only роуты.

## Куда смотреть

| Тема | Документ |
|---|---|
| Полная спека API по коду | `docs/API_V2.md` |
| Архитектура | `docs/ARCHITECTURE.md` |
| Конфигурация | `docs/CONFIGURATION.md`, ADR-023 |
| OIDC / Keycloak | `docs/KEYCLOAK.md` |
| API v2 / Hono | ADR-017 |
| Движки и runner-стек | ADR-022 |
| Транспорт EventHub + TransportClient | ADR-024 |
| LLM Gateway | ADR-036 |
| Гибрид | ADR-042, `docs/HYBRID.md` |

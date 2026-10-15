# ADR-052: Публичная API-платформа Synth

> **Статус:** ✅ Реализовано — **этапы I–IV закрыты (2026-10-13)**: этап I (service-key + scopes +
> проектная проекция `allowedProjects` + API/UI + spike public-OpenAPI), этап II (webhooks),
> этап III (public-OpenAPI 28 операций + SDK `@itphx/synth-sdk`), этап IV (перевод
> мессенджер-шлюза на scoped service-key; по итогам живого прогона — фикс доставки событий).
> Ранее был реализован первый срез — API-ключи привязок событий (binding-key, ADR-089).
> **Дата:** 2026-09-16 (план зафиксирован 2026-10-13; этапы I–IV закрыты 2026-10-13)
> **Источник:** перенесено из `AD-DRAFTS.md` (D7, идея 7).
> **Связано:** [ADR-017](./adr-017-api-v2-hono.md), [ADR-036](./adr-036-llm-gateway.md),
> [ADR-023](./adr-023-configuration.md), [ADR-089](./adr-089-external-events-automation.md),
> [ADR-086](./adr-086-extensibility-plugins-editions.md), [PROP-055](./prop-055-instance-exchange.md).

**Решение:** превратить API v2 из внутреннего контракта в **публичную API-платформу Synth**:

- per-service **API-ключи** (**service-key**) со **скоупами** (`scopes`) и **проектной проекцией** (`allowedProjects`);
- публичная **OpenAPI**-спецификация — **только public-спека** (интеграционное ядро, см. §«OpenAPI — только public»);
- **SDK** — отдельный публикуемый пакет `@itphx/synth-sdk`;
- **webhooks** (исходящие события);
- **tenants исключены** из ADR-052 (обоснование — §«Почему без tenants»).

> **Договорённость (2026-10-13):** модель платформы — **scopes + проектная проекция ключа**.
> Классическая SaaS-сущность мультиарендности в Synth не вводится (обоснование — §«Почему без tenants»);
> если когда-либо появится реальная мульти-организация в одном инстансе — это отдельный AD
> (рядом с PROP-055/PROP-080), не ADR-052.

## Контекст

### Что уже есть

- API v2 (core + backend) на Hono ([ADR-017](./adr-017-api-v2-hono.md)); RBAC; rate-limit;
  Gateway ([ADR-036](./adr-036-llm-gateway.md)).
- OpenAI-совместимый LLM Proxy: `POST /api/v2/llm/chat/completions`
  (`packages/backend/src/routes/llm.ts`) — уже пригоден как публичный LLM-эндпоинт.
- Аутентификация: единый `SYNTH_API_KEY` → роль **ADMIN** (backend, `packages/backend/src/app.ts`),
  debug-ключи, OIDC ([ADR-043](./adr-043-unified-identity-login.md)).
- **Первый срез (реализовано, ADR-089):** API-ключи **привязок событий** (binding-key) —
  `EventApiKeyStore` (`{dataDir}/events/api-keys.json`), эндпоинты
  `GET/POST /api/v2/events/bindings/:id/keys`, `PATCH .../keys/:keyId`,
  `POST .../keys/:keyId/revoke`, `DELETE .../keys/:keyId`; ключ с обязательной уникальной
  `label`, `description?`, `expiresAt?`, `rateLimitPerMinute?`, мягким отзывом (`revokedAt`);
  приём `POST /api/v2/events` по `Authorization: Bearer synth_evt_…` (машинная аутентификация
  без пользовательских кред, source/чат из привязки); секрет — только sha256-хеш, наружу
  один раз при создании. per-key rate limit: лимит ключа, иначе глобальный дефолт
  `events.keyRateLimitPerMinute` (`KeyRateLimiter`, 429). Задел: `EventKeyCredential`
  (`keyId`/`bindingId`/`rateLimitPerMinute`, `scopes`/`principalId`). См. [ADR-089](./adr-089-external-events-automation.md).
- **Этап I (реализовано, 2026-10-13):** **service-key** — независимый ключ инстанса со `scopes` и
  проектной проекцией `allowedProjects` (`ServiceApiKeyStore`, `{dataDir}/service-keys.json`,
  секрет `synth_svc_…`), CRUD `GET/POST/PATCH/DELETE /api/v2/service-keys` (+ `/:id/revoke`),
  middleware `requireScope`/`checkProjectAccess`, UI-раздел «Сервисные ключи»; **spike public-OpenAPI**
  (`@hono/zod-openapi@0.19.x`, совместим с zod v3) на 3 events-эндпоинтах + `GET /api/v2/openapi.json`
  + единый `publicErrorSchema`. См. §«Статус реализации в коде».
- **Этап II (реализовано, 2026-10-13):** **webhooks** — подписки на исходящие события
  (`WebhookStore`, `{dataDir}/webhooks/subscriptions.json`; журнал `{dataDir}/webhooks/deliveries.jsonl`),
  доставка над `EventBus.subscribeAll`, HMAC-SHA256-подпись, retry/backoff, дедуп, SSRF-политика,
  API `GET/POST /api/v2/webhooks` (+ `/:id`, `/:id/regenerate|revoke|test`, `/:id/deliveries`), UI-раздел.
  См. §«Статус реализации в коде».
- **Этап III (реализовано, 2026-10-13):** **public-OpenAPI** интеграционного ядра —
  **28 операций** (events 13, sessions 8, schedules 6, llm 1) через `@hono/zod-openapi@0.19.x`
  (`createPublicOpenApiApp`/`getPublicOpenApiDocument`,
  `packages/core/src/server/openapi/public-openapi.ts`), именованные модели `components.schemas`,
  единый формат ошибок `publicErrorSchema`; выдача `GET /api/v2/openapi.json` (за `requireAuth`) —
  **и** публикуемый **SDK** `@itphx/synth-sdk` (`packages/sdk`). См. §«Статус реализации в коде».

### Проблема

API v2 спроектирован как внутренний контракт для UI/CLI/гибрида. Для внешних сервисов он не годится
напрямую: единый `SYNTH_API_KEY` даёт роль ADMIN, нет гранулярных скоупов, нет публичной
OpenAPI-спеки, SDK и механизма исходящих уведомлений (webhooks). Без этого нельзя безопасно открыть платформу
внешним потребителям.

## Детали

### Почему без tenants

Сущность «тенант» попала в ADR-052 из классического SaaS-шаблона публичной платформы, но **не соответствует
модели Synth**:

- модель развёртывания — **self-host** (prod = один клиент = один инстанс, `AGENTS.md` §«Среды и деплой»);
  граница изоляции данных — уже **инстанс**;
- внутри инстанса группировка ресурсов — уже **проект** (`Project.ownerId` + `Project.members`, [ADR-014](./adr-014-project-container.md));
- третья сущность (tenant) дублировала бы либо инстанс, либо проект. В коде понятия tenant/org нет вовсе
  (подтверждено grep по `packages/**`).
- NB: в [ADR-086](./adr-086-extensibility-plugins-editions.md) слово «тенант» означает другое — разные
  **инстансы** в таблице маршрутов шлюза (`{synthUrl, creds, tenant}`), а не изоляцию внутри инстанса;
  не путать.

Вместо tenants — **scopes + проектная проекция ключа** (см. ниже). Если когда-либо появится реальная
мульти-организация в одном инстансе — это отдельный AD (рядом с [PROP-055](./prop-055-instance-exchange.md)/[PROP-080](./prop-080-managed-hybrid-modes.md)),
не ADR-052.

### Service-key

Отдельная сущность, **независимая** от binding-key [ADR-089](./adr-089-external-events-automation.md):

- новый `ServiceApiKeyStore` (`{dataDir}/service-keys.json`), префикс секрета `synth_svc_`,
  хранение — sha256-хеш at-rest (по образцу `EventApiKeyStore`), plaintext — один раз при создании
  (в списке — `prefix`);
- **binding-key (ADR-089) не трогаем** — он адресуется парой `(bindingId, keyId)` и обслуживает
  `POST /events`; service-key — независимый store;
- ключ аутентифицирует машину в синтетического пользователя (совместимость с `requireAuth`),
  но конкретные роуты дополнительно требуют **scope** (см. §«Scopes»);
- поля ключа: `id` (`svk_<uuid>`), `label` (уникальная глобально, регистронезависимо),
  `description?`, `roles: GlobalRole[]` (роли синтетического пользователя; дефолт — `USER`),
  `scopes: string[]`, `allowedProjects?: string[]` (проектная проекция; пусто — политика инстанса),
  `rateLimitPerMinute?`, `expiresAt?`, `revokedAt?`, `createdBy`, `createdAt`, `lastUsedAt?`, `prefix`.

### Scopes

Enforcement — middleware `requireScope(...)` **рядом** с `requirePermission` (не перегрузка
permission-слоя тулов: тот роль-оси не имеет by design — роли = доступность эндпоинтов, внутри сессии
набор тулов одинаков для всех). Для интерактивных кред (OIDC/debug/API-key/локальный ключ) scope-гейт —
no-op: ограничиваются только service-key.

**Итоговый каталог** (`SERVICE_SCOPES`; ✅ зафиксирован на этапе I):

точечные — `events:ingest`, `events:watch`, `bindings:read`, `bindings:write`, `keys:read`,
`keys:write`, `routes:read`, `routes:write`, `sessions:create`, `sessions:read`, `sessions:prompt`,
`schedules:read`, `schedules:write`, `llm:chat`.

**Wildcard-семейства** (`SERVICE_SCOPE_FAMILIES`, матчер `hasServiceScope`): `events:*`,
`bindings:*`, `keys:*`, `routes:*`, `sessions:*`, `schedules:*`. Wildcard покрывает любые
`<family>:<x>` этого семейства, но не соседние семейства и не запрос `<family>:*` точным скоупом.
**Глобального `*` нет** — намеренно (не «ADMIN через один скоуп»). `llm:chat` — единственный скоуп
вне семейств (роуты без проектного измерения).

### Проектная проекция ключа

- `allowedProjects?: string[]` ограничивает ключ подмножеством проектов инстанса — проекция
  группировки ресурсов, уже существующей в Synth ([ADR-014](./adr-014-project-container.md)),
  вместо отдельной сущности мультиарендности.
- Пустой/отсутствующий список — ключ действует по политике инстанса (по умолчанию — все проекты,
  доступные синтетическому пользователю ключа).
- Проекция применяется в роутах, адресующих проект/сессию (sessions, events/bindings, schedules);
  для роутов без проектного измерения (`llm:chat`) она не ограничивает.

### OpenAPI — только public

- **Не** полный internal-контракт: публикуется **только public-спека** — курируемое подмножество
  (**интеграционное ядро**). Причина: публикация = обязательство (заморозка контракта, deprecation,
  версионирование); публиковать fs/audit/admin/sessions secrets нельзя (это и приглашение, и
  схлопывание scopes в ADMIN); полная спека неоднозначна (core-фабрики монтируются и в core:
  standalone без RBAC, и в backend: RBAC; двойной формат ошибок).
- Автогенерация из **`@hono/zod-openapi`**.
- **Public-контракт = интеграционное ядро:** `events` (ingest/watch), `bindings`,
  `sessions` (create/read/prompt), `schedules`, LLM proxy (`POST /api/v2/llm/chat/completions`).
  Публичная спека покрывает **28 операций** (events 13, sessions 8, schedules 6, llm 1) —
  курируемое подмножество (internal sessions-роуты шире публичного среза).
- Формат ошибок неоднороден внутри (`{error:{code,message}}` vs `FsError {error:{error,code}}`).
  Для публичных роутов закреплён единый `publicErrorSchema` (`{error:{code,message}}`) —
  этап III обернул всё публичное ядро.

### SDK

Отдельный публикуемый пакет **`@itphx/synth-sdk`** (по образцу `runner`/`synth`), поверх public-спеки.
Источник типов — `@itphx/synth-shared` (browser-safe subpath'ы; `shared/config` тянуть нельзя — Node-only).
Реализован (этап III, часть 2): `createSynthClient` + namespaces `events`/`sessions`/`schedules`/`llm`,
`SynthApiError`; ESM-only, runtime-agnostic (глобальный `fetch`), см. §«Статус реализации в коде».

### Webhooks

Реализовано (этап II):

- Доставка встраивается над `EventBus.subscribeAll` (как глобальный SSE-хаб): каждый `BusEvent`
  фильтруется паттернами подписок, подписывается и отправляется подписчикам.
- Retry/backoff — экспоненциальный с джиттером (`computeBackoffMs`; ориентир — `queue/processor.ts` /
  `remote/event-bridge.ts`), таймаут одного запроса, дедуп по (подписка + событие).
- Подпись — HMAC-SHA256 (per-subscription secret `whsec_<base64url>`); секрет **шифруется at-rest**
  (AES-256-GCM, мастер-ключ, `security/crypto.ts`) и выдаётся один раз — sha256-хеш, как у API-ключей,
  не годится (HMAC требует исходный секрет). Формат заголовков — §«Формат подписи webhooks».
- Защита от SSRF — `engine/webhooks/network.ts` (`evaluateWebhookTarget`) поверх
  `engine/mcp/network-policy.ts`: обязательный `https` + запрет private/loopback (кроме
  `webhooks.allowPrivateTargets` для dev).
- `HookBus.emitAsync` (fire-and-forget, timeout 5s) как транспорт **не** используется.

### Формат подписи webhooks (закреплено, этап II)

- Заголовки доставки: `X-Synth-Event` (тип события), `X-Synth-Delivery` (id доставки),
  `X-Synth-Signature` (подпись).
- Значение подписи: `t=<unix>,v1=<hex hmac_sha256(secret, "<t>.<rawBody>")>` — HMAC-SHA256 от строки
  `"<timestamp>.<rawBody>"` (`signature.ts`: `buildSignatureHeader`/`computeWebhookSignature`).
- Анти-replay: получатель сверяет `t` с текущим временем в окне **300 c**
  (`WEBHOOK_SIGNATURE_TOLERANCE_SEC`) и проверяет подпись по **сырому телу** (до парсинга JSON);
  сравнение — constant-time (`timingSafeEqual`, `parseSignatureHeader`/`verifyWebhookSignature`).
- Версия схемы подписи — `v1` (`WEBHOOK_SIGNATURE_VERSION`).
- Signing-секрет подписки — `whsec_<base64url>` (`WEBHOOK_SECRET_PREFIX`); **шифруется at-rest**
  (AES-256-GCM, мастер-ключ), наружу отдаётся один раз при создании/ротации (в списке — `secretPrefix`).

### Квоты и биллинг (позже)

- Возможные квоты/биллинг — отдельный слой поверх rate-limit; пока не решено.

## План реализации (этапы I–IV)

Переход между этапами — только с остановкой и явным подтверждением.

### Этап I — service-key + scopes + spike OpenAPI — ✅ закрыт (service-key/scopes/проекция + spike OpenAPI)

- ✅ `ServiceApiKeyStore` + типы/схемы (`ServiceApiKey`, create/update, `scopes`/`allowedProjects`)
  в `@itphx/synth-shared`.
- ✅ CRUD-роуты service-ключей (managed: ADMIN; core: `requireAuth`), аутентификация по `synth_svc_*`,
  middleware `requireScope`.
- ✅ Проектная проекция `allowedProjects` в применяемых роутах (sessions / events-bindings / schedules).
- ✅ **Spike `@hono/zod-openapi`** — выполнен: выбран `@hono/zod-openapi@0.19.x` (совместим с zod v3;
  1.x требует zod v4 — отдельная миграция), сгенерирована public-спека на 3 events-эндпоинтах,
  добавлены `GET /api/v2/openapi.json` и `publicErrorSchema` (единый формат ошибок публичных роутов).
- Критерий: service-key со scopes работает (✅); spike подтвердил подход к OpenAPI (✅).

### Этап II — webhooks — ✅ закрыт (2026-10-13)

(независим от I и III): модель подписки, store, доставка над `EventBus`, подпись, retry/backoff,
дедуп, SSRF-политика, API/UI — реализованы.

### Этап III — OpenAPI public + SDK — ✅ закрыт (28 операций + SDK, 2026-10-13)

Обёртка интеграционного ядра в `@hono/zod-openapi` (**28 операций**: events 13, sessions 8,
schedules 6, llm 1), генерация public-спеки, выдача `/openapi.json` (+ docs) и публикуемый
пакет `@itphx/synth-sdk` поверх спеки — реализованы. См. §«Статус реализации в коде».

### Этап IV — перевод шлюза на service-key — ✅ закрыт (2026-10-13)

`synth-gateway-telegram` переведён с broad-`SYNTH_API_KEY`/OIDC-аккаунта на **scoped service-key**:
новый режим аутентификации `service-key` с приоритетом `service-key → oidc → api-key → none`
(`SYNTH_SERVICE_KEY`/`--service-key`/`secrets/synth_service_key`); требуемые scopes —
`events:ingest`, `events:watch`, `bindings:read`, `bindings:write`, `sessions:create`,
`sessions:read` (+ роль `LEAD` для мутаций bindings). Живой прогон (dev) выявил и закрыл
сопутствующий дефект доставки: глобальный SSE-хаб backend подписывал клиента только на свои
сессии (`listSessions({userId})`), из-за чего service-key (синтетический пользователь
`service:<keyId>`, сессиями не владеет) не получал `stream.done` и ответы не уходили в мессенджер —
добавлен режим watch-all (глобальная подписка `eventBus.subscribeAll`, паритет со standalone-core)
для service-key и elevated (ADMIN/LEAD).

## Статус реализации в коде

**✅ Реализовано.** Закрыты **этап I** — service-key + scopes + проектная проекция + API/UI +
spike public-OpenAPI (`@hono/zod-openapi@0.19.x`); **этап II** — webhooks; **этап III** —
public-OpenAPI (28 операций) + SDK `@itphx/synth-sdk`; **этап IV** — перевод мессенджер-шлюза
`synth-gateway-telegram` на scoped service-key (+ фикс доставки событий: watch-all для
service-key/elevated); а также первый срез **ADR-089** — API-ключи привязок событий (binding-key).
Все этапы закрыты 2026-10-13.

### Этап I — service-key (реализовано)

- **Тип `ServiceApiKey`** (`packages/shared/src/types/service-keys.ts`, re-export из `types/index.ts`):
  `id`=`svk_<uuid>`, `label` (обязательна, уникальна глобально по инстансу, регистронезависимо),
  `description?`, `roles: GlobalRole[]`, `scopes: string[]`, `allowedProjects?: string[]`,
  `rateLimitPerMinute?`, `expiresAt?`, `revokedAt?`, `createdBy`, `createdAt`, `lastUsedAt?`, `prefix`;
  `ServiceApiKeyCreated` (+ `key` — plaintext единожды). Zod — `serviceApiKeySchema`/
  `serviceApiKeyCreateSchema`/`serviceApiKeyUpdateSchema` (`shared/schemas`).
- **Секрет** `synth_svc_<base64url>` — plaintext один раз при создании, at-rest только sha256-хеш
  (`ServiceApiKeyStore`, `packages/core/src/storage/service-api-key-store.ts`, `{dataDir}/service-keys.json`,
  атомарная запись ADR-005, `schemaVersion` — модель PG-ready PROP-032).
- **Scopes** — каталог `SERVICE_SCOPES` + `SERVICE_SCOPE_FAMILIES`, матчер `hasServiceScope`
  (wildcard-семейства, глобального `*` нет). Enforcement — `requireScope`
  (`packages/core/src/server/service-scope.ts`); backend-обёртки `scopeGuard`/`projectGuard`
  (`packages/backend/src/auth/service-scope.ts`) с локализованными 403 `SCOPE_REQUIRED`/`PROJECT_FORBIDDEN`.
  Для интерактивных кред (нет service-key в контексте) гейты — no-op.
- **Проектная проекция** `allowedProjects` (`isProjectAllowed`/`checkProjectAccess`): sessions /
  events-bindings / schedules; пусто/отсутствует — политика инстанса.
- **Аутентификация:** `Authorization: Bearer synth_svc_…` → синтетический пользователь
  `{ id: 'service:<keyId>', roles: key.roles }` + `ServiceKeyCredential` (scopes/`allowedProjects`/лимит)
  в контексте; revoked/expired/unknown → 401 (`packages/backend/src/auth/middleware.ts`,
  `packages/core/src/auth/local.ts`). Роли ключа совместимы с `requirePermission`, scopes — точечный гейт.
- **API** (единая фабрика `createServiceKeyRoutes`, `packages/core/src/server/routes/service-keys.ts`):
  `GET/POST /api/v2/service-keys`, `GET/PATCH/DELETE /api/v2/service-keys/:id`,
  `POST /api/v2/service-keys/:id/revoke`; RBAC: managed — ADMIN, core — `requireAuth`; store
  `{dataDir}/service-keys.json`. В managed — per-key rate limit `rateLimitPerMinute` (глобальный
  middleware `KeyRateLimiter` → 429 `RATE_LIMITED`). Scope-гейты — на `POST /api/v2/llm/chat/completions`
  (`llm:chat`) и роутах events/sessions/schedules.
- **UI** — админ-раздел «Сервисные ключи» (`packages/ui/src/components/settings/ServiceKeysSettings.tsx`):
  однократный показ секрета + curl, мульти-селекты ролей/scopes/проектов, revoke/delete,
  read-only для не-ADMIN.

### Этап I — spike public-OpenAPI (реализовано)

- **Зависимость** `@hono/zod-openapi@^0.19.10` (`packages/core/package.json`): совместима с zod v3
  (1.x требует zod v4 — отдельная миграция, вне этапа I).
- **Публичный контракт** — `createPublicOpenApiApp`/`getPublicOpenApiDocument`
  (`packages/core/src/server/openapi/public-openapi.ts`): `OpenAPIHono` + `createRoute` на **трёх
  боевых events-эндпоинтах** (`POST /events`, `GET /events/bindings`, `POST /events/bindings`) по
  реальным Zod-схемам `@itphx/synth-shared`; генерация OpenAPI 3.1 (`servers: [{url:'/api/v2'}]`).
  Хендлеры spike — заглушки с валидными примерами: цель — подтвердить совместимость `createRoute`
  с нашими Zod-схемами и вывести документ (массовая обёртка ядра — этап III, закрыт: 28 операций, см. ниже).
- **Единый формат ошибок** `publicErrorSchema` — `{error:{code,message}}` (коды `VALIDATION_ERROR`,
  `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `RATE_LIMITED`, `UNAVAILABLE`, `INTERNAL_ERROR`).
- **Выдача** — `GET /api/v2/openapi.json` (core и backend; за `requireAuth`).

### Этап II — webhooks (реализовано)

- **Модель подписки** `WebhookSubscription` (`packages/shared/src/types/webhooks.ts`, re-export из `types`):
  `id`=`whk_<uuid>`, обязательная уникальная глобально `label`, `description?`, `url`, `events: string[]`
  (паттерны exact/`prefix.*`; пусто — `DEFAULT_WEBHOOK_EVENT_PATTERNS`), `enabled`, `secretPrefix`,
  `createdBy`/`createdAt`, `lastDeliveryAt?`/`lastStatus?`, `disabledAt?`; `WebhookSubscriptionCreated`
  (+ `secret` — plaintext единожды). Журнал — `WebhookDelivery` (`whd_<uuid>`/`subscriptionId`/`eventType`/
  `status`/`attempts`/`responseStatus?`/`error?`/`createdAt`/`completedAt?`). Zod — `webhookSubscriptionSchema`/
  `webhookSubscriptionCreateSchema`/`webhookSubscriptionUpdateSchema`/`webhookSubscriptionCreatedSchema`/
  `webhookDeliverySchema`/`webhookEventPatternSchema`/`webhookUrlSchema`; матчер `matchWebhookEvent`,
  валидатор `isWebhookEventPattern`, префикс `WEBHOOK_SECRET_PREFIX` (`whsec_`).
- **Store** — `WebhookStore` (`packages/core/src/storage/webhook-store.ts`,
  `{dataDir}/webhooks/subscriptions.json`, атомарная запись ADR-005, `schemaVersion`): signing-секрет
  `whsec_<base64url>` **шифруется at-rest** AES-256-GCM мастер-ключом (HMAC требует исходный секрет —
  sha256-хеш, как у API-ключей, не годится), `create`/`regenerateSecret` отдают plaintext один раз;
  мягкое отключение (`setEnabled`/`disabledAt`), `touchDelivery`; `WebhookConflictError` → 409.
- **Журнал доставок** — `WebhookDeliveryStore` (`packages/core/src/storage/webhook-delivery-store.ts`,
  `{dataDir}/webhooks/deliveries.jsonl`, append-only); retention — `startWebhookDeliveryPruner`
  (`engine/webhooks/prune.ts`, prune на старте и каждые 6 ч, `deliveryRetentionDays <= 0` — без ограничения).
- **Движок доставки** — `WebhookService` (`packages/core/src/engine/webhooks/service.ts`): подписка на
  `EventBus.subscribeAll` (`start`/`stop`), фильтр `matchWebhookEvent`, HMAC-подпись, retry/backoff
  (экспоненциальный с джиттером, `computeBackoffMs`), таймаут запроса, дедуп по (подписка + событие),
  запись в журнал, `deliverTest` (синтетическое `webhook.test`). Мастер-выключатель — `webhooks.enabled`.
- **Подпись** — `signature.ts` (`buildSignatureHeader`/`computeWebhookSignature`/`verifyWebhookSignature`,
  окно 300 c); формат — §«Формат подписи webhooks».
- **SSRF** — `network.ts` (`evaluateWebhookTarget`) поверх `engine/mcp/network-policy.ts`: `https` +
  запрет private/loopback (кроме `webhooks.allowPrivateTargets`); проверка и на создании/обновлении
  (роуты), и defense-in-depth перед каждой доставкой.
- **API** — единая фабрика `createWebhookRoutes` (`packages/core/src/server/routes/webhooks.ts`):
  `GET/POST /api/v2/webhooks`, `GET/PATCH/DELETE /api/v2/webhooks/:id`,
  `POST /api/v2/webhooks/:id/regenerate|revoke|test`, `GET /api/v2/webhooks/:id/deliveries`; RBAC
  managed — ADMIN, core — `requireAuth`; мастер-выключатель `webhooks.enabled: false` → 503 на
  мутации/тест; конфликт метки → 409, невалидный/запрещённый URL → 400.
- **UI** — раздел управления webhooks-подписками
  (`packages/ui/src/components/settings/WebhooksSettings.tsx`): однократный показ signing-секрета,
  журнал доставок, тестовая доставка.

### Этап III — public-OpenAPI + SDK (реализовано)

- **Публичная OpenAPI 3.1-спека** — `createPublicOpenApiApp`/`getPublicOpenApiDocument`
  (`packages/core/src/server/openapi/public-openapi.ts`): **28 операций** через `createRoute` —
  events 13 (`POST /events`, журнал, bindings + keys, routes), sessions 8 (list/create/get/patch/
  delete/status/prompt/messages), schedules 6 (CRUD + run/jobs), llm 1 (`POST /llm/chat/completions`).
- **Именованные модели `components.schemas`** (`.openapi('Name')` поверх Zod-схем `@itphx/synth-shared`):
  `SynthEvent`, `EventBinding`/`EventBindingInput`, `EventBindingApiKey*`, `EventRouteRule*`,
  `Session`/`SessionCreate`/`SessionPatch`, `Schedule*`, `ChatCompletionsRequest/Response` и др.
  (обёртка `.openapi()` возвращает новую инстанцию, shared-схемы не мутируются).
- **Единый формат ошибок** — `publicErrorSchema` (`{error:{code,message}}`) на всех публичных ответах
  400/401/403/404/409/429/500/503; security-схема `bearerAuth` (service-key `synth_svc_…`),
  `servers: [{url:'/api/v2'}]`.
- **Выдача** — `GET /api/v2/openapi.json` (core и backend; за `requireAuth`).
- **SDK `@itphx/synth-sdk`** — публикуемый пакет `packages/sdk` (ADR-052 этап III, часть 2):
  `createSynthClient(options)` / `SynthClient`; auth-заголовок с приоритетом **serviceKey → apiKey → token**,
  базовый путь `/api/v2`; namespaces `events` (ingest/journal/bindings/keys/routes), `sessions`
  (CRUD + prompt/messages/status), `schedules` (CRUD + run/jobs), `llm` (`chatCompletions`); ошибки —
  `SynthApiError` (`{status,code,message,body?}`), сетевые сбои → `status:0`/`NETWORK_ERROR`.
  Runtime-agnostic (глобальный `fetch`, инъекция для тестов), ESM-only, зависимость только от
  `@itphx/synth-shared` (browser-safe subpath'ы). Публичные типы DTO, отсутствующие в shared
  (`SerializedSession`, контракт LLM-прокси), — локально в `src/types.ts`.

### Первый срез ADR-089 — binding-key (реализовано ранее)

- `EventApiKeyStore` (`packages/core/src/storage/event-api-key-store.ts`, `{dataDir}/events/api-keys.json`):
  несколько ключей на `EventBinding`, секрет `synth_evt_<base64url>` → sha256-хеш at-rest,
  plaintext наружу один раз (`create`), в списке `prefix`; обязательная уникальная (глобально
  по инстансу) `label`, `description?`, `expiresAt?`, `rateLimitPerMinute?`, `revokedAt?`;
  legacy-backfill `name`→`label`; каскад `removeByBinding`; задел — `EventKeyCredential`
  (`packages/core/src/engine/events/credential.ts`).
- Эндпоинты `GET/POST /api/v2/events/bindings/:id/keys`, `PATCH .../keys/:keyId`,
  `POST .../keys/:keyId/revoke`, `DELETE .../keys/:keyId` (core-фабрика `createEventRoutes`);
  приём `POST /api/v2/events` по `Authorization: Bearer <binding-key>` — без пользовательских
  кред, source/чат из привязки; использование пишется в журнал (`keyId`/`principalId`).
- **Per-key rate limit** — `KeyRateLimiter` (`packages/core/src/engine/events/key-rate-limiter.ts`,
  in-memory fixed-window 60 c по `keyId`): лимит ключа `rateLimitPerMinute`, иначе глобальный
  дефолт `events.keyRateLimitPerMinute` (0 — без лимита); превышение → 429 `RATE_LIMITED`.
  Мастер-рубильник `events.enabled` → 503 `UNAVAILABLE`.
- RBAC: мутации bindings/routes/keys — LEAD/ADMIN, чтение ключей — LEAD/ADMIN.

Остаток по плану отсутствует — **этапы I–IV закрыты**. Возможные улучшения (вне объёма) — ниже.

Проверено точечным grep по `packages/**` (исключая `dist/`, `node_modules/`):

- API v2, RBAC, rate-limit, Gateway — реализованы; OpenAI-совместимый прокси присутствует
  (`packages/backend/src/routes/llm.ts`).
- Единый `SYNTH_API_KEY` → роль ADMIN подтверждён (`packages/backend/src/app.ts`).
- service-key: `ServiceApiKeyStore`/`ServiceApiKey`/`createServiceKeyRoutes`/`requireScope` присутствуют.
- public-OpenAPI: зависимость `@hono/zod-openapi@^0.19.10` присутствует; `createPublicOpenApiApp`/
  `getPublicOpenApiDocument`/`publicErrorSchema` — `packages/core/src/server/openapi/public-openapi.ts`
  (28 операций, именованные `components.schemas`); `GET /api/v2/openapi.json` смонтирован в core и
  backend (за `requireAuth`).
- SDK: пакет `packages/sdk` (`@itphx/synth-sdk`) — `createSynthClient`/`SynthClient`/`SynthApiError`,
  namespaces events/sessions/schedules/llm; зависимость `@itphx/synth-shared`.
- webhooks: `WebhookStore`/`WebhookDeliveryStore`/`WebhookService`/`createWebhookRoutes`/
  `evaluateWebhookTarget` присутствуют; store/journal — `{dataDir}/webhooks/*`.

## Заделы и возможные улучшения (вне объёма)

- **Интерактивный docs-UI для публичной спеки — не реализован (сознательно).** Требование к возможной
  реализации: полностью **self-hosted** — HTML, все UI-ассеты и сама спека отдаются с origin инстанса,
  **без внешних сетевых запросов** (закрытый контур / air-gap). Рассматривался
  `@scalar/hono-api-reference` (MIT) — **отвергнут**: его мидлварь отдаёт HTML, который подгружает
  JS-бандл Scalar с CDN (`jsdelivr`/`unpkg`) и потенциально внешние шрифты → неконтролируемый egress
  и неработоспособность в закрытом контуре. Кандидат на будущее — `swagger-ui-dist` (Apache-2.0;
  ассеты вендорятся локально — эталон для air-gap) либо `redoc` standalone (с явным глушением
  внешних шрифтов). Спека (`GET /api/v2/openapi.json`) уже доступна для внешнего тулинга/SDK-генерации.
- **Квоты/биллинг** — отдельный слой поверх rate-limit; пока не решено (позже).
- **Версионирование публичной спеки** (этап III): как менять контракт без слома потребителей
  (deprecation-политика); выделение public-подмножества зафиксировано — 28 операций интеграционного ядра.
- Формат подписи webhooks — закреплён (§«Формат подписи webhooks»); размещение store, дедуп и
  SSRF-политика реализованы в этапе II.

## Связи

- [ADR-017](./adr-017-api-v2-hono.md) «API v2 на Hono» — база платформы.
- [ADR-036](./adr-036-llm-gateway.md) «LLM Gateway» — guard/аудит/rate limit для внешнего трафика.
- [ADR-023](./adr-023-configuration.md) «Конфигурация» — настройки платформы и ключей.
- [ADR-089](./adr-089-external-events-automation.md) «Внешние события и автоматизация» — родственный
  контур: входящие события и Router; webhooks (этап II) — исходящая доставка над `EventBus.subscribeAll`;
  public-OpenAPI (28 операций) и SDK (этап III) публикуют этот же контур (events/bindings/routes);
  первый (реализованный) срез ADR-052 — API-ключи привязок (binding-key).
- [ADR-086](./adr-086-extensibility-plugins-editions.md) «Расширяемость: плагины, editions» — точки расширения;
  scoped service-key — целевой способ аутентификации add-on'ов (первый кейс — Telegram gateway).
- [PROP-055](./prop-055-instance-exchange.md) «Обмен между инстансами» — родственный внешний контур (server-to-server).
- [PROP-080](./prop-080-managed-hybrid-modes.md) — режимы managed-гибрида; сюда же сместится тема
  реальной мульти-организации, если понадобится (не ADR-052).
- Смежные: [ADR-043](./adr-043-unified-identity-login.md) (идентичность),
  [ADR-087](./adr-087-gateways.md) «Gateway мессенджеров» (отдельный интеграционный слой,
  не дублировать публичный API).

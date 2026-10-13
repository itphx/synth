# AD-052: Публичная API-платформа Synth

> **Статус:** ⚠️ Частично реализовано — **этап I закрыт** (service-key + scopes + проектная проекция
> `allowedProjects` + API/UI); остаток — этапы II–IV (webhooks, public-OpenAPI/SDK, перевод шлюза).
> Ранее был реализован первый срез — API-ключи привязок событий (binding-key, AD-089).
> **Дата:** 2026-09-16 (план зафиксирован 2026-10-13; этап I закрыт 2026-10-13)
> **Источник:** перенесено из `AD-DRAFTS.md` (D7, идея 7).
> **Связано:** [AD-017](./ad-017-api-v2-hono.md), [AD-036](./ad-036-llm-gateway.md),
> [AD-023](./ad-023-configuration.md), [AD-089](./ad-089-external-events-automation.md),
> [AD-086](./ad-086-extensibility-plugins-editions.md), [AD-055](./ad-055-instance-exchange.md).

**Решение:** превратить API v2 из внутреннего контракта в **публичную API-платформу Synth**:

- per-service **API-ключи** (**service-key**) со **скоупами** (`scopes`) и **проектной проекцией** (`allowedProjects`);
- публичная **OpenAPI**-спецификация — **только public-спека** (интеграционное ядро, см. §«OpenAPI — только public»);
- **SDK** — отдельный публикуемый пакет `@itphx/synth-sdk`;
- **webhooks** (исходящие события);
- **tenants исключены** из AD-052 (обоснование — §«Почему без tenants»).

> **Договорённость (2026-10-13):** модель платформы — **scopes + проектная проекция ключа**.
> Классическая SaaS-сущность мультиарендности в Synth не вводится (обоснование — §«Почему без tenants»);
> если когда-либо появится реальная мульти-организация в одном инстансе — это отдельный AD
> (рядом с AD-055/AD-080), не AD-052.

## Контекст

### Что уже есть

- API v2 (core + backend) на Hono ([AD-017](./ad-017-api-v2-hono.md)); RBAC; rate-limit;
  Gateway ([AD-036](./ad-036-llm-gateway.md)).
- OpenAI-совместимый LLM Proxy: `POST /api/v2/llm/chat/completions`
  (`packages/backend/src/routes/llm.ts`) — уже пригоден как публичный LLM-эндпоинт.
- Аутентификация: единый `SYNTH_API_KEY` → роль **ADMIN** (backend, `packages/backend/src/app.ts`),
  debug-ключи, OIDC ([AD-043](./ad-043-unified-identity-login.md)).
- **Первый срез (реализовано, AD-089):** API-ключи **привязок событий** (binding-key) —
  `EventApiKeyStore` (`{dataDir}/events/api-keys.json`), эндпоинты
  `GET/POST /api/v2/events/bindings/:id/keys`, `PATCH .../keys/:keyId`,
  `POST .../keys/:keyId/revoke`, `DELETE .../keys/:keyId`; ключ с обязательной уникальной
  `label`, `description?`, `expiresAt?`, `rateLimitPerMinute?`, мягким отзывом (`revokedAt`);
  приём `POST /api/v2/events` по `Authorization: Bearer synth_evt_…` (машинная аутентификация
  без пользовательских кред, source/чат из привязки); секрет — только sha256-хеш, наружу
  один раз при создании. per-key rate limit: лимит ключа, иначе глобальный дефолт
  `events.keyRateLimitPerMinute` (`KeyRateLimiter`, 429). Задел: `EventKeyCredential`
  (`keyId`/`bindingId`/`rateLimitPerMinute`, `scopes`/`principalId`). См. [AD-089](./ad-089-external-events-automation.md).
- **Этап I (реализовано, 2026-10-13):** **service-key** — независимый ключ инстанса со `scopes` и
  проектной проекцией `allowedProjects` (`ServiceApiKeyStore`, `{dataDir}/service-keys.json`,
  секрет `synth_svc_…`), CRUD `GET/POST/PATCH/DELETE /api/v2/service-keys` (+ `/:id/revoke`),
  middleware `requireScope`/`checkProjectAccess`, UI-раздел «Сервисные ключи». См. §«Статус реализации в коде».

### Проблема

API v2 спроектирован как внутренний контракт для UI/CLI/гибрида. Для внешних сервисов он не годится
напрямую: единый `SYNTH_API_KEY` даёт роль ADMIN, нет гранулярных скоупов, нет публичной
OpenAPI-спеки, SDK и механизма исходящих уведомлений (webhooks). Без этого нельзя безопасно открыть платформу
внешним потребителям.

## Детали

### Почему без tenants

Сущность «тенант» попала в AD-052 из классического SaaS-шаблона публичной платформы, но **не соответствует
модели Synth**:

- модель развёртывания — **self-host** (prod = один клиент = один инстанс, `AGENTS.md` §«Среды и деплой»);
  граница изоляции данных — уже **инстанс**;
- внутри инстанса группировка ресурсов — уже **проект** (`Project.ownerId` + `Project.members`, [AD-014](./ad-014-project-container.md));
- третья сущность (tenant) дублировала бы либо инстанс, либо проект. В коде понятия tenant/org нет вовсе
  (подтверждено grep по `packages/**`).
- NB: в [AD-086](./ad-086-extensibility-plugins-editions.md) слово «тенант» означает другое — разные
  **инстансы** в таблице маршрутов шлюза (`{synthUrl, creds, tenant}`), а не изоляцию внутри инстанса;
  не путать.

Вместо tenants — **scopes + проектная проекция ключа** (см. ниже). Если когда-либо появится реальная
мульти-организация в одном инстансе — это отдельный AD (рядом с [AD-055](./ad-055-instance-exchange.md)/[AD-080](./ad-080-managed-hybrid-modes.md)),
не AD-052.

### Service-key

Отдельная сущность, **независимая** от binding-key [AD-089](./ad-089-external-events-automation.md):

- новый `ServiceApiKeyStore` (`{dataDir}/service-keys.json`), префикс секрета `synth_svc_`,
  хранение — sha256-хеш at-rest (по образцу `EventApiKeyStore`), plaintext — один раз при создании
  (в списке — `prefix`);
- **binding-key (AD-089) не трогаем** — он адресуется парой `(bindingId, keyId)` и обслуживает
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
  группировки ресурсов, уже существующей в Synth ([AD-014](./ad-014-project-container.md)),
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
  Точечно ~42 хендлера (events 13, sessions 22, schedules 6, llm 1).
- Риск: формат ошибок неоднороден (`{error:{code,message}}` vs `FsError {error:{error,code}}`) —
  в этапе I закрепить единый формат для публичных роутов.

### SDK

Отдельный публикуемый пакет **`@itphx/synth-sdk`** (по образцу `runner`/`synth`), поверх public-спеки.
Источник типов — `@itphx/synth-shared` (browser-safe subpath'ы; `shared/config` тянуть нельзя — Node-only).

### Webhooks

- Механизма сейчас нет (`EventDelivery` доставляет только внутрь сессии; `EventBus.subscribeAll` — in-process).
- Встраивать над `EventBus.subscribeAll`/журналом (`EventJournalStore`); retry/backoff по образцу
  `queue/processor.ts` / `remote/event-bridge.ts`.
- Подпись — HMAC-SHA256 (per-subscription secret, образец хеширования — `EventApiKeyStore`),
  секреты подписи at-rest; защита от SSRF по образцу `engine/mcp/network-policy.ts`.
- `HookBus.emitAsync` (fire-and-forget, timeout 5s) как транспорт **не** использовать — только как
  возможный триггер.

### Квоты и биллинг (позже)

- Возможные квоты/биллинг — отдельный слой поверх rate-limit; пока не решено.

## План реализации (этапы I–IV)

Переход между этапами — только с остановкой и явным подтверждением.

### Этап I — service-key + scopes + spike OpenAPI — ✅ закрыт (service-key/scopes/проекция; spike — нет)

- ✅ `ServiceApiKeyStore` + типы/схемы (`ServiceApiKey`, create/update, `scopes`/`allowedProjects`)
  в `@itphx/synth-shared`.
- ✅ CRUD-роуты service-ключей (managed: ADMIN; core: `requireAuth`), аутентификация по `synth_svc_*`,
  middleware `requireScope`.
- ✅ Проектная проекция `allowedProjects` в применяемых роутах (sessions / events-bindings / schedules).
- ❌ **Spike `@hono/zod-openapi`** (2–3 эндпоинта из `events` + генерация спеки, единый формат ошибок
  публичных роутов) — **не выполнялся**; отложен к этапу III (в репозитории нет зависимости `@hono/zod-openapi`).
- Критерий: service-key со scopes работает (✅); spike подтвердил/опроверг подход к OpenAPI (не выполнялся).

### Этап II — webhooks

(независим от I и III): модель подписки, store, доставка над `EventBus`, подпись, retry/backoff,
дедуп, SSRF-политика, API/UI.

### Этап III — OpenAPI public + SDK

Обёртка ~42 хендлеров ядра в `@hono/zod-openapi`, генерация public-спеки, публикация
`/openapi.json` (+ docs), пакет `@itphx/synth-sdk` поверх спеки.

### Этап IV — перевод шлюза на service-key

`synth-gateway-telegram` переводится с broad-`SYNTH_API_KEY`/OIDC-аккаунта на **scoped service-key**
(реальный кейс) + (при необходимости) расширение public-поверхности.

## Статус реализации в коде

**⚠️ Частично реализовано.** Закрыты: **этап I — service-key + scopes + проектная проекция + API/UI**
(2026-10-13) и первый срез **AD-089** — API-ключи привязок событий (binding-key).
Не реализованы: этапы **II–IV** — webhooks, public-OpenAPI (`@hono/zod-openapi`) + `@itphx/synth-sdk`,
перевод шлюза. Spike `@hono/zod-openapi` в рамках этапа I не выполнялся.

### Этап I — service-key (реализовано)

- **Тип `ServiceApiKey`** (`packages/shared/src/types/service-keys.ts`, re-export из `types/index.ts`):
  `id`=`svk_<uuid>`, `label` (обязательна, уникальна глобально по инстансу, регистронезависимо),
  `description?`, `roles: GlobalRole[]`, `scopes: string[]`, `allowedProjects?: string[]`,
  `rateLimitPerMinute?`, `expiresAt?`, `revokedAt?`, `createdBy`, `createdAt`, `lastUsedAt?`, `prefix`;
  `ServiceApiKeyCreated` (+ `key` — plaintext единожды). Zod — `serviceApiKeySchema`/
  `serviceApiKeyCreateSchema`/`serviceApiKeyUpdateSchema` (`shared/schemas`).
- **Секрет** `synth_svc_<base64url>` — plaintext один раз при создании, at-rest только sha256-хеш
  (`ServiceApiKeyStore`, `packages/core/src/storage/service-api-key-store.ts`, `{dataDir}/service-keys.json`,
  атомарная запись AD-005, `schemaVersion` — модель PG-ready AD-032).
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

### Первый срез AD-089 — binding-key (реализовано ранее)

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

Осталось (этапы II–IV, см. §«План реализации»):

- **webhooks** — исходящие события (этап II);
- публичная **OpenAPI**-спека (только public) и **SDK** (`@itphx/synth-sdk`) — этап III;
- перевод мессенджер-шлюза на scoped service-key — этап IV.

Проверено точечным grep по `packages/**` (исключая `dist/`, `node_modules/`):

- API v2, RBAC, rate-limit, Gateway — реализованы; OpenAI-совместимый прокси присутствует
  (`packages/backend/src/routes/llm.ts`).
- Единый `SYNTH_API_KEY` → роль ADMIN подтверждён (`packages/backend/src/app.ts`).
- service-key: `ServiceApiKeyStore`/`ServiceApiKey`/`createServiceKeyRoutes`/`requireScope` присутствуют;
  зависимости `@hono/zod-openapi` нет (spike не выполнялся).

## Открытые вопросы

- Квоты/биллинг — отдельный слой поверх rate-limit; пока не решено (позже).
- **Формат заголовков подписи webhooks:** имена/состав заголовков (`X-Synth-Signature` и т.п.),
  схема HMAC-SHA256, окно timestamp, версия подписи.
- OpenAPI: как именно выделять public-подмножество (~42 хендлера) при сохранении паритета
  core↔backend; версионирование спеки; единый формат ошибок публичных роутов.
- Webhooks — исходящие события над `EventBus.subscribeAll`/журналом ([AD-089](./ad-089-external-events-automation.md)):
  размещение store, дедуп, SSRF-политика.

## Связи

- [AD-017](./ad-017-api-v2-hono.md) «API v2 на Hono» — база платформы.
- [AD-036](./ad-036-llm-gateway.md) «LLM Gateway» — guard/аудит/rate limit для внешнего трафика.
- [AD-023](./ad-023-configuration.md) «Конфигурация» — настройки платформы и ключей.
- [AD-089](./ad-089-external-events-automation.md) «Внешние события и автоматизация» — транспорт webhooks;
  первый (реализованный) срез AD-052 — API-ключи привязок (binding-key).
- [AD-086](./ad-086-extensibility-plugins-editions.md) «Расширяемость: плагины, editions» — точки расширения;
  scoped service-key — целевой способ аутентификации add-on'ов (первый кейс — Telegram gateway).
- [AD-055](./ad-055-instance-exchange.md) «Обмен между инстансами» — родственный внешний контур (server-to-server).
- [AD-080](./ad-080-managed-hybrid-modes.md) — режимы managed-гибрида; сюда же сместится тема
  реальной мульти-организации, если понадобится (не AD-052).
- Смежные: [AD-043](./ad-043-unified-identity-login.md) (идентичность),
  [AD-087](./ad-087-messenger-gateway-merged.md) «Gateway мессенджеров» (отдельный интеграционный слой,
  не дублировать публичный API).

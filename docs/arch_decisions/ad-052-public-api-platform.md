# AD-052: Публичная API-платформа Synth

> **Статус:** ⚠️ Частично реализовано (первый срез — API-ключи привязок событий, AD-089; остальное — проект)
> **Дата:** 2026-09-16
> **Источник:** перенесено из `AD-DRAFTS.md` (D7, идея 7).
> **Связано:** [AD-017](./ad-017-api-v2-hono.md), [AD-036](./ad-036-llm-gateway.md),
> [AD-023](./ad-023-configuration.md), [AD-089](./ad-089-external-events-automation.md),
> [AD-086](./ad-086-extensibility-plugins-editions.md), [AD-055](./ad-055-instance-exchange.md).

**Решение:** превратить API v2 из внутреннего контракта в **публичную API-платформу Synth**:

- per-service **API-ключи** со **скоупами** и **тенантами**;
- публичная **OpenAPI**-спецификация;
- **SDK**;
- **webhooks** (исходящие события).

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
  `GET/POST /api/v2/events/bindings/:id/keys`, `DELETE /api/v2/events/bindings/:id/keys/:keyId`;
  приём `POST /api/v2/events` по `Authorization: Bearer synth_evt_…` (машинная аутентификация
  без пользовательских кред, source/чат из привязки); секрет — только sha256-хеш, наружу
  один раз при создании. Задел: `expiresAt`/`revokedAt`, `revoke()`, `EventKeyCredential`
  (`keyId`/`bindingId`, `scopes`/`principalId`). См. [AD-089](./ad-089-external-events-automation.md).

### Проблема

API v2 спроектирован как внутренний контракт для UI/CLI/гибрида. Для внешних сервисов он не годится
напрямую: единый `SYNTH_API_KEY` даёт роль ADMIN, нет гранулярных скоупов, нет тенантов, нет публичной
OpenAPI-спеки, SDK и механизма исходящих уведомлений (webhooks). Без этого нельзя безопасно открыть платформу
внешним потребителям.

## Детали

### Ключи, скоупы, тенанты

- Модель per-service ключей (не один общий): привязка к сервису/интеграции, набор скоупов (какие роуты/действия
  разрешены), тенант (изоляция данных).
- Права — через существующий permission-слой/RBAC, а не хардкод в хендлерах.
- Секреты ключей — at-rest (по образцу секретов [AD-076](./ad-076-git-repo-registry-ssh.md)); не логировать.

### OpenAPI и SDK

- Генерация публичной OpenAPI-спеки из реализованных роутов (core-фабрики + backend).
- SDK (минимум — TypeScript) поверх спеки.

### Webhooks

- Исходящие события платформы — через единый событийный роутер **[AD-089](./ad-089-external-events-automation.md)**;
  доставка опирается на точки расширения **[AD-086](./ad-086-extensibility-plugins-editions.md)**.
- Подписи запросов, retry, дедуп, секреты подписи.

### Квоты и биллинг (позже)

- Возможные квоты/биллинг — отдельный слой поверх rate-limit; пока не решено.

## Статус реализации в коде

**Частично реализовано — первый срез: API-ключи привязок (binding-key) в AD-089.**

Реализовано (AD-089):

- `EventApiKeyStore` (`packages/core/src/storage/event-api-key-store.ts`, `{dataDir}/events/api-keys.json`):
  несколько ключей на `EventBinding`, секрет `synth_evt_<base64url>` → sha256-хеш at-rest,
  plaintext наружу один раз (`create`), в списке `prefix`; каскад `removeByBinding`;
  задел — `expiresAt`/`revokedAt`, `revoke()`, `EventKeyCredential`
  (`packages/core/src/engine/events/credential.ts`).
- Эндпоинты `GET/POST /api/v2/events/bindings/:id/keys`, `DELETE .../keys/:keyId`
  (core-фабрика `createEventRoutes`); приём `POST /api/v2/events` по
  `Authorization: Bearer <binding-key>` — без пользовательских кред, source/чат из привязки;
  использование пишется в журнал (`keyId`/`principalId`).
- RBAC: мутации bindings/routes/keys — LEAD/ADMIN, чтение ключей — LEAD/ADMIN.

Осталось:

- **service-key** — общий ключ инстанса/тенанта со scope (для мессенджер-шлюзов, AD-086);
- `scopes`/`tenants`, изоляция данных;
- публичная **OpenAPI**-спека, **SDK**, исходящие **webhooks**;
- per-key rate limit, UI срока действия/отзыва и HTTP-эндпоинт `revoke`.

Проверено точечным grep по `packages/**` (исключая `dist/`, `node_modules/`):

- API v2, RBAC, rate-limit, Gateway — реализованы; OpenAI-совместимый прокси присутствует
  (`packages/backend/src/routes/llm.ts`).
- Единый `SYNTH_API_KEY` → роль ADMIN подтверждён (`packages/backend/src/app.ts`).

## Открытые вопросы

- Квоты/биллинг?
- Мультитенантность и изоляция данных?
- Webhooks — исходящие события через EventHub/роутер [AD-089](./ad-089-external-events-automation.md)?
- Формат и владелец OpenAPI-спеки: автогенерация из кода или ручной источник истины?

## Связи

- [AD-017](./ad-017-api-v2-hono.md) «API v2 на Hono» — база платформы.
- [AD-036](./ad-036-llm-gateway.md) «LLM Gateway» — guard/аудит/rate limit для внешнего трафика.
- [AD-023](./ad-023-configuration.md) «Конфигурация» — настройки платформы и ключей.
- [AD-089](./ad-089-external-events-automation.md) «Внешние события и автоматизация» — транспорт webhooks;
  первый (реализованный) срез AD-052 — API-ключи привязок (binding-key).
- [AD-086](./ad-086-extensibility-plugins-editions.md) «Расширяемость: плагины, editions» — точки расширения.
- [AD-055](./ad-055-instance-exchange.md) «Обмен между инстансами» — родственный внешний контур (server-to-server).
- Смежные: [AD-043](./ad-043-unified-identity-login.md) (идентичность),
  [AD-087](./ad-087-messenger-gateway-merged.md) «Gateway мессенджеров» (отдельный интеграционный слой,
  не дублировать публичный API).

# AD-052: Публичная API-платформа Synth

> **Статус:** ⏳ Не реализовано (проект)
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

**Не реализовано.**

Проверено точечным grep по `packages/**` (исключая `dist/`, `node_modules/`):

- API v2, RBAC, rate-limit, Gateway — реализованы; OpenAI-совместимый прокси присутствует
  (`packages/backend/src/routes/llm.ts`).
- Единый `SYNTH_API_KEY` → роль ADMIN подтверждён (`packages/backend/src/app.ts`).
- Per-service ключей/скоупов/тенантов, OpenAPI-спеки, SDK и webhooks — нет.

## Открытые вопросы

- Квоты/биллинг?
- Мультитенантность и изоляция данных?
- Webhooks — исходящие события через EventHub/роутер [AD-089](./ad-089-external-events-automation.md)?
- Формат и владелец OpenAPI-спеки: автогенерация из кода или ручной источник истины?

## Связи

- [AD-017](./ad-017-api-v2-hono.md) «API v2 на Hono» — база платформы.
- [AD-036](./ad-036-llm-gateway.md) «LLM Gateway» — guard/аудит/rate limit для внешнего трафика.
- [AD-023](./ad-023-configuration.md) «Конфигурация» — настройки платформы и ключей.
- [AD-089](./ad-089-external-events-automation.md) «Внешние события и автоматизация» — транспорт webhooks.
- [AD-086](./ad-086-extensibility-plugins-editions.md) «Расширяемость: плагины, editions» — точки расширения.
- [AD-055](./ad-055-instance-exchange.md) «Обмен между инстансами» — родственный внешний контур (server-to-server).
- Смежные: [AD-043](./ad-043-unified-identity-login.md) (идентичность),
  [AD-087](./ad-087-messenger-gateway-merged.md) «Gateway мессенджеров» (отдельный интеграционный слой,
  не дублировать публичный API).

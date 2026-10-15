# ADR-052: Публичная API-платформа Synth

> **Статус:** ✅ Реализовано — этапы I–IV закрыты 2026-10-13.
> **Дата:** 2026-09-16 (этапы I–IV — 2026-10-13; сжатие до одной страницы — 2026-10-15).
> **Источник:** перенесено из `AD-DRAFTS.md` (D7, идея 7).
> **Парные документы (as-built):** [API_V2.md](../API_V2.md) §1/§5.28–§5.30 · [CONFIGURATION.md](../CONFIGURATION.md) (`webhooks`, `security.bootstrapServiceKeys`) · [ARCHITECTURE.md](../ARCHITECTURE.md) «Внешние события и хуки» · `packages/{core,backend}/AGENTS.md`.
> **Связано:** [ADR-017](./adr-017-api-v2-hono.md), [ADR-036](./adr-036-llm-gateway.md), [ADR-089](./adr-089-external-events-automation.md), [ADR-086](./adr-086-extensibility-plugins-editions.md), [ADR-087](./adr-087-gateways.md), [PROP-055](./prop-055-instance-exchange.md).

## Контекст

API v2 ([ADR-017](./adr-017-api-v2-hono.md)) — внутренний контракт (UI/CLI/гибрид): единый `SYNTH_API_KEY`
даёт `ADMIN`, нет гранулярных скоупов, публичной OpenAPI-спеки, SDK и исходящих уведомлений — безопасно
открыть платформу внешним потребителям (шлюзы и т.п.) нельзя. Входящий контур внешних событий
([ADR-089](./adr-089-external-events-automation.md), первый срез — binding-key) реализован ранее.

## Решение

- **Per-service service-key вместо tenants.** Машинный доступ внешних сервисов — независимый от binding-key
  scoped-ключ инстанса: `scopes` (точечный гейт поверх RBAC) + **проектная проекция** `allowedProjects`
  (подмножество существующих проектов, [ADR-014](./adr-014-project-container.md)), а не новая сущность мультиарендности.
- **Scopes.** Каталог точечных скоупов + wildcard-семейства; глобального `*` нет (не «ADMIN через один скоуп»).
  Гейт `requireScope` — рядом с `requirePermission`, не перегрузка permission-слоя тулов (роль-оси внутри
  сессии нет, [ADR-029](./adr-029-granular-permissions.md)); для интерактивных кред — no-op.
- **Проектная проекция.** `allowedProjects` ограничивает ключ подмножеством проектов инстанса; применяется
  в роутах с проектным измерением (sessions/events-bindings/schedules), пусто — политика инстанса.
- **OpenAPI — только public.** Публикуется курируемое подмножество (интеграционное ядро: events/sessions/
  schedules/llm), не полный internal-контракт: публикация = обязательство (заморозка, deprecation), а
  fs/audit/admin/секреты наружу нельзя. Автогенерация — `@hono/zod-openapi` 0.19.x (совместим с zod v3;
  1.x требует zod v4 — отдельная миграция); `GET /api/v2/openapi.json` за `requireAuth`.
- **SDK.** Отдельный публикуемый пакет `@itphx/synth-sdk` — типизированный клиент над public-спекой.
- **Webhooks (HMAC).** Исходящая доставка — подписки на события шины (`EventBus.subscribeAll`), HTTP-POST
  с подписью **HMAC-SHA256** per-subscription секретом (`whsec_…`, шифруется at-rest), retry/backoff, дедуп,
  SSRF-политика; формат подписи — [API_V2.md](../API_V2.md) §5.29.
- **Tenants исключены.** Self-host: изоляция = **инстанс**, группировка внутри — **проект**; третья сущность
  дублировала бы одну из них. Реальная мульти-организация в инстансе — отдельный AD (рядом с
  [PROP-055](./prop-055-instance-exchange.md)/[PROP-080](./prop-080-managed-hybrid-modes.md)), не ADR-052.

## Альтернативы

- **SaaS-tenant** — отклонён: дублирует инстанс/проект, не соответствует self-host.
- **Перегрузка permission-слоя ролями** — отклонён: роли = доступность эндпоинтов; роль-оси в сессии нет ([ADR-029](./adr-029-granular-permissions.md)).
- **Полная internal-OpenAPI** — отклонён: неоднозначна (core-фабрики монтируются и с RBAC, и без; двойной формат ошибок) и публикует лишнее.
- **`HookBus.emitAsync` как транспорт webhooks** — отклонён: нет retry/backoff, дедупа и подписи.

## Последствия

- (+) Внешние потребители получают scoped-доступ без раздачи `ADMIN`; контракт зафиксирован public-спекой и SDK.
- (−) Публичная спека — обязательство: смена контракта требует deprecation-политики; версионирование спеки и квоты/биллинг — вне объёма.
- Вне объёма: интерактивный docs-UI для спеки — требование air-gap (только self-hosted ассеты); `@scalar/hono-api-reference` отвергнут (внешний CDN-бандл).

## Статус реализации

✅ Реализовано (этапы I–IV, 2026-10-13): service-key + scopes + `allowedProjects` + API/UI + spike OpenAPI →
webhooks → public-OpenAPI (28 операций) + SDK → перевод Telegram-шлюза на scoped service-key (+ фикс
доставки: watch-all для service-key/elevated). As-built — [API_V2.md](../API_V2.md) §1/§5.28–§5.30,
[CONFIGURATION.md](../CONFIGURATION.md), `packages/{core,backend}/AGENTS.md`.

## История

- 2026-10-15 — сжатие до одной страницы: as-built вынесено в spec ([API_V2.md](../API_V2.md), [CONFIGURATION.md](../CONFIGURATION.md), [ARCHITECTURE.md](../ARCHITECTURE.md)).

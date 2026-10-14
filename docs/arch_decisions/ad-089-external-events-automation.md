# AD-089: Synth как платформа внешних событий и автоматизации

> **Статус:** ⚠️ Частично реализовано (ядро Event/Binding/Router, единый funnel, API/UI, источник cron (AD-051), API-ключи привязок — label/лимит/revoke + per-key rate limit, retention журнала, runtime-настройки «События», decision-маршрутизация (AD-084, opt-in), auto-bind; [AD-052](./ad-052-public-api-platform.md) — ✅ этапы I–IV: binding-key, service-key + scopes + `allowedProjects`, webhooks, public-OpenAPI + SDK `@itphx/synth-sdk`, перевод шлюза; первый add-on — Telegram-шлюз ([AD-086](./ad-086-extensibility-plugins-editions.md)) — реализован; остаток — Plugin SDK ([AD-090](./ad-090-extension-api.md)), пайплайны ([AD-059](./ad-059-pipeline-automation.md)), остаток AD-086 (HA/второй канал) и стриминг ответа наружу)
> **Дата:** 2026-10-08
> **Обновлено:** 2026-10-13 — синхронизация статусов: [AD-052](./ad-052-public-api-platform.md)
> закрыт целиком (этапы I–IV), первый add-on (`addons/synth-gateway-telegram`) реализован; остаток
> пересобран — Plugin SDK ([AD-090](./ad-090-extension-api.md)), пайплайны ([AD-059](./ad-059-pipeline-automation.md)),
> остаток AD-086 (HA/второй канал) и стриминг ответа наружу.
> **Обновлено:** 2026-10-12 — зафиксирована граница с add-on-слоем: шлюз (Telegram) — тонкий транспорт
> (normalize→events, events→send), состояние инстанс-локальное; топология/HA/мультитенантность — свойство
> слоя add-on ([AD-086](./ad-086-extensibility-plugins-editions.md), раздел «Первый частный случай — Telegram gateway»);
> для Telegram транспорт приёма — long-polling (webhook отложен), ограничение «один потребитель на бота» (`409 Conflict`).
> Ранее тем же днём: добавлен раздел «Auto-bind» (`events.autoBind`/`events.autoBindAgentTemplate`,
> новое решение Router `{ kind: 'bind' }` и цель правила `{ mode: 'bind' }`); статус и разделы
> приведены к реализованному коду (ядро Event/Binding/Router, правила маршрутизации,
> decision-маршрутизация (AD-084), API-ключи привязок, retention журнала, runtime-настройки «События»).
> Тем же днём: funnel проставляет дефолтные `provider`/`model` инстанса
> (`deps.resolveLlmDefaults`, `llm.defaultProvider`/`llm.defaultModel`) сессиям `ephemeral`/`bind` —
> см. «LLM-дефолты (provider/model)».
> **Связано:** [AD-030](./ad-030-hooks-agent-events.md) «Hooks для событий агента» (фундамент),
> [AD-034](./ad-034-model-routing.md) «Routing между моделями», [AD-035](./ad-035-micro-model-first.md) «Micro-model first»,
> [AD-084](./ad-084-decision-models-clef.md) «Decision-модели» (decision-маршрутизация событий),
> [AD-036](./ad-036-llm-gateway.md) «LLM Gateway», [AD-051](./ad-051-scheduler-pipelines.md) «Шедулер и пайплайны»,
> [AD-052](./ad-052-public-api-platform.md) «Публичная API-платформа», [AD-056](./ad-056-synth-mcp-server.md) «MCP-сервер Synth»,
> [AD-086](./ad-086-extensibility-plugins-editions.md) «Расширяемость и внешние сервисы-надстройки»,
> [AD-087](./ad-087-messenger-gateway-merged.md) «Gateway для мессенджеров» (поглощён AD-086),
> [AD-026](./ad-026-subagent-context-modes.md) «Контекст саб-агента», [AD-033](./ad-033-session-branching-merge.md) «Ветвление сессий»,
> [AD-029](./ad-029-granular-permissions.md) «Гранулярные permissions», [AD-042](./ad-042-hybrid-mode.md) «Гибридный режим»,
> [AD-045](./ad-045-hybrid-server-profiles.md) «Профили серверов гибрида».

**Решение:** Synth — не только чат с агентом, а **агентный рантайм для внешних событий**. Любое событие
(сообщение мессенджера, HTTP-webhook, кнопка в UI внешнего сервиса, cron-таймер, событие CI) нормализуется
во внутреннюю сущность `Event`, проходит через **Router** и превращается в работу **сессии Synth** с нужным
агентом, скиллами и правами; результат действия может быть отдан обратно во внешний сервис (в т.ч. через
вызовы внешних MCP-серверов).

Единая цепочка:

```
внешнее событие → нормализация (Event) → маршрутизация (Router/Binding)
                → сессия Synth (агент + скиллы + права) → действие (тулы, внешние MCP)
                → (опционально) ответ/событие обратно во внешний сервис
```

## Контекст

### Зачем

Сегодня Synth инициируется **только пользователем из UI/CLI**: `POST /sessions/:id/prompt`. Внешние системы
(Synth-медиа, Telegram-бот, CI, планировщик) либо говорят с Synth как с MCP-сервером, либо вообще не могут
разбудить агента. Продукт позиционируется как **платформа автоматизации**, поэтому вход должен быть
событийным: «событие снаружи → действие агента внутри», а не «человек руками открыл сессию».

### Что уже есть

- **Шина событий сессии** ([AD-009](./ad-009-session-event-bus.md)) и **транспорт** ([AD-008](./ad-008-websocket-events.md),
  [AD-024](./ad-024-eventhub-transport.md)) — доставка событий до UI, но инициатива всегда внутри;
- **MCP-клиент** ([AD-071](./ad-071-mcp-servers-prompt.md)) — Synth умеет **дёргать** внешние MCP-инструменты;
- **API v2** ([AD-017](./ad-017-api-v2-hono.md)) — HTTP-вход и база публичного API ([AD-052](./ad-052-public-api-platform.md) — ✅ реализован);
- **Гибрид** ([AD-042](./ad-042-hybrid-mode.md)/[AD-045](./ad-045-hybrid-server-profiles.md)) — событие может прийти
  как в локальный standalone, так и на managed-бэкенд;
- **Демонстратор** — `synth-media`: внешний сервис с Telegram-MCP и ботом уже работает как потребитель
  прикладного API и провайдер MCP-инструментов.

### Чего не было на момент решения

_(на 2026-10-08; актуальное состояние — в разделе «Статус реализации в коде»)_

- Хуков и Plugin SDK ([AD-030](./ad-030-hooks-agent-events.md)) — не реализованы;
- роутера внешних событий, сущностей `Event`/`Binding`/`Router`;
- шедулера ([AD-051](./ad-051-scheduler-pipelines.md)) и публичного API приёма webhook'ов ([AD-052](./ad-052-public-api-platform.md));
- внешних add-on сервисов как класса ([AD-086](./ad-086-extensibility-plugins-editions.md)) — за исключением
  самодельного `synth-media`.

## Детали

### Новые сущности

**`Event`** — нормализованное внешнее событие. Приводится к общему виду на входе, до всякой маршрутизации;
источник-специфика живёт в `payload`.

```typescript
interface SynthEvent {
  id: string;              // evt_<uuid>, уникален в пределах инстанса
  source: string;          // 'telegram' | 'synth-media' | 'webhook' | 'cron' | 'ci' | 'ui'
  type: string;            // 'message' | 'callback' | 'webhook' | 'schedule' | 'ci_event' | 'session.requested'
  payload: unknown;        // нормализованное тело: текст, ссылки на вложения (AD-085), метаданные
  identity: {              // от/для кого событие
    principalId?: string;  // внешний идентификатор пользователя
    chatKey?: string;      // 'chat:<source>:<chatId>'
    threadKey?: string;    // 'thread:<source>:<chatId>:<threadId>'
    roles?: string[];      // потолок прав отправителя: СУЖАЮТ роли профиля (не повышают); AD-029
  };
  dedupKey: string;        // стабильный ключ идемпотентности
  ts: string;              // ISO-8601
}
```

**`Binding`** — устойчивая привязка внешнего адреса к сессии/шаблону.

```typescript
interface EventBinding {
  id: string;
  source: string;          // 'telegram' | 'synth-media' | ...
  chatKey?: string;        // привязка на чат
  threadKey?: string;      // привязка на тред/топик (приоритетнее чата)
  sessionId?: string;      // конкретная постоянная сессия (mode='bound')
  mode: 'bound' | 'ephemeral' | 'queue';
  agentTemplate?: string;  // шаблон агента/скилла для создания/настройки сессии (AD-046)
  project?: string;        // projectId — контейнер сессии (AD-014)
}
```

**`Router`** — слой разрешения события в сессию (или в отложенную обработку/дроп). Роутер — ядровый слой;
hook-шина ([AD-030](./ad-030-hooks-agent-events.md)) — точка расширения для внешних событий; решения — на
[AD-034](./ad-034-model-routing.md)/[AD-035](./ad-035-micro-model-first.md) и туле `classify_conversation`.

```typescript
type RouteDecision =
  | { kind: 'bound'; sessionId: string }
  | { kind: 'ephemeral'; agentTemplate: string; ttl: string; project?: string }
  | { kind: 'queue'; owner: string; reason: string }
  | { kind: 'drop'; reason: string; audited: true }
  | { kind: 'bind'; agentTemplate: string; project?: string }; // auto-bind (см. ниже)
```

**`EventBindingApiKey`** — API-ключ приёма событий, привязанный к `EventBinding`
(AD-089/AD-052, первый срез). На привязку может быть несколько ключей; секрет
`synth_evt_<base64url>` хранится только как `sha256`-хеш (`{dataDir}/events/api-keys.json`),
наружу отдаётся единственный раз при создании, в списке — `prefix` (видимый префикс).
Поля: `id` (`eak_<uuid>`), `bindingId`, `label` (обязательная метка, **уникальная глобально
по инстансу**, регистронезависимо), `description?`, `rateLimitPerMinute?` (лимит запросов/мин,
`0` — без лимита), `createdBy`, `createdAt`, `lastUsedAt?`, `prefix`, `expiresAt?`/`revokedAt?`
(истёкший/отозванный ключ не резолвится). Ключ создаётся, обновляется (`PATCH`: метка/описание/
срок/лимит; `null` — сброс), мягко отзывается (`POST .../revoke`, идемпотентно) и удаляется;
`createdBy` — владелец. Приём по ключу — машинная аутентификация без пользовательских кред
(`EventKeyCredential`: `keyId`/`bindingId`/`rateLimitPerMinute`, задел `scopes`/`principalId`):
событие форсированно маршрутизируется в привязку (source/чат берутся из неё), использование
пишется в журнал (`keyId`/`principalId`). Лимит ключа — свой `rateLimitPerMinute`, иначе
глобальный дефолт `events.keyRateLimitPerMinute`; превышение → `429 RATE_LIMITED`. Ключи —
**инстанс-локальные секреты**: в publish/fork и межмировой обмен не входят (AD-042/AD-081).

### Порядок маршрутизации

0. **Фильтр `allowedSources`** — источник не в списке `events.allowedSources` → `drop` (в журнал).
1. **Дедуп** по `dedupKey` — повторный event не проходит дальше.
2. **Явный `Binding`** (чат / тред / топик → сессия). Самый сильный сигнал: если для `chatKey`/`threadKey`
   есть запись — событие уходит в привязанную сессию без классификации.
3. **Правила проекта** (источник / канал / отправитель / метка / ключевые слова) → **шаблон агента + режим**.
   Правила конфигурируемы (проект/инстанс), комбинируются; лёгкая проверка — micro-слой
   ([AD-035](./ad-035-micro-model-first.md)) и `classify_conversation`. При промахе правил и флаге
   `events.decisionRouting` — decision-шаг `DecisionRuleProvider` ([AD-084](./ad-084-decision-models-clef.md)),
   fail-safe.
4. **Политика режима** решает, как материализовать сессию:
   - `bound` — постоянная сессия на диалог (переписка: контекст копится, история не теряется);
   - `ephemeral` — сессия на событие с TTL и авто-архивом (разовые триггеры: webhook, CI, кнопка);
   - `queue` — не запускать сразу, отложить владельцу (уведомление + элемент в очереди,
     переиспользование `QueueProcessorManager`, `packages/core/src/queue/processor.ts`).
5. **Фоллбек** — дефолтный агент / очередь / **дроп с аудитом** (`drop` всегда фиксируется, чтобы не терять
   события молча).

**Значение по умолчанию:** конфиг-дефолт `defaultMode: 'bound'` — переписка — `bound`, разовые
триггеры — `ephemeral`. `queue` и `drop` — осознанные политики, а не дефолт.

### Auto-bind (закрепление чата/треда за сессией)

**Суть.** Третий способ появления `EventBinding` — **по решению Router**. Первый —
вручную через API/UI; второй — внешним сервисом через API (binding-key форсирует
привязку). Auto-bind нужен для переписок, у которых ещё нет привязки: первое
сообщение чата (Telegram/мессенджер) закрепляется за новой постоянной сессией —
дальнейшие сообщения этого чата попадают в неё как явный `binding`.

**Конфиг** (`events.*`, runtime через `GET/PUT/DELETE /api/v2/settings/events`):

| Поле | Назначение | По умолчанию |
|------|-----------|--------------|
| `events.autoBind` | Фоллбек Router: если у события есть `identity.chatKey` **или** `identity.threadKey`, закрепить его за новой сессией (`EventBinding mode='bound'`) вместо `defaultMode` | `false` |
| `events.autoBindAgentTemplate` | Шаблон агента auto-bind-сессий (резолвится через `AgentRegistry`; пусто — агент по умолчанию; неизвестный → политика `unknownAgentTemplate`) | `''` |

**Новый вид решения.** Дискриминант `RouteDecision` расширен вариантом
`{ kind: 'bind'; agentTemplate: string; project?: string }` (мета — `confidence`/`signals`).
Auto-bind-решение несёт диагностический сигнал `signals: ['auto-bind']` — он попадает
в ответ `POST /api/v2/events` и в запись журнала (как `confidence`/`signals`
decision-маршрутизации).

**Новая цель правила.** `EventRouteTarget` расширен вариантом
`{ mode: 'bind'; agentTemplate?: string; project?: string }` — декларативное правило
может явно закрепить внешний адрес за сессией (это ортогонально флагу `autoBind`).

**Поведение (материализация).** Для `kind: 'bind'` `RequestSessionService`:
- если для `{source, chatKey|threadKey}` уже существует `EventBinding` (повтор или
  гонка одновременных событий одного чата) — **переиспользует** его сессию и доставляет
  событие, ничего не создавая;
- иначе создаёт **постоянную** сессию (как `ephemeral`, но **без `expiresAt`**;
  `agentTemplate` резолвится тем же `_resolveAgent`), затем создаёт
  `EventBinding { source, chatKey?, threadKey?, sessionId, mode: 'bound', agentTemplate?, project? }`
  через `EventBindingStore` (`{dataDir}/events/bindings.json`);
- доставляет событие режимом `run` и возвращает сессию.

**Требование идентичности.** Auto-bind-фоллбек срабатывает только при наличии
`identity.chatKey` **или** `identity.threadKey`. Без ключа поведение прежнее —
`defaultMode` (`ephemeral` / `drop no_route`).

**«Влияет только на фоллбек».** `autoBind` проверяется **исключительно** в
шаге 5 `EventRouter.decide`. Явный `EventBinding` (шаг 3), декларативные правила и
decision-маршрутизация (шаг 4) сохраняют своё поведение и приоритет.

**Риски.**
- **Мусорные сессии.** При `autoBind: true` любой чат с ключом создаёт постоянную
  сессию. Контур защиты: флаг по умолчанию **выключен**; `events.allowedSources`
  ограничивает источники; API-ключ привязки и per-key rate limit
  (`events.keyRateLimitPerMinute`) ограничивают поток; цели правил позволяют
  заранее направить известные чаты иначе (правило приоритетнее фоллбека).
- **Ошибка шаблона.** Неизвестный `autoBindAgentTemplate` при политике
  `unknownAgentTemplate: 'drop'` не создаёт сессию (fail-safe, `agent_not_found` в журнале).

**Владелец и доставка.** Сессии, материализуемые внешним событием (`ephemeral`/`bind`),
получают владельца по приоритету: **`deps.resolveExternalIdentity`**
(`createExternalIdentityResolver`: резолвинг внешнего отправителя `identity.principalId` →
пользователь инстанса; сначала override `events.identityMap` по `identity.principalId`, затем
`identity.chatKey`, иначе — привязка в профиле `ProfileData.identities[]` по паре
`provider:externalId`; чат-fallback внутри резолвера) → **`events.identityMap`**
(фоллбек-совместимость: при подключённом резолвере карта уже проверена им первой) → per-event
владелец (аутентифицированный пользователь запроса либо создатель API-ключа привязки
`credential.ownerId`) → `resolveOwnerId`
(standalone — `local`, паритет с `POST /api/v2/sessions`). Разделение ролей: **чат (`chatKey`) —
routing** (привязки/правила/auto-bind), **человек (`principalId`) — ownership и attribution**;
`identity.principalId` — внешний идентификатор (`tg:<id>`), **не** id пользователя инстанса
(как владелец не подставляется). В группе `chatKey` = группа, поэтому владельцем становится
автор, а не чат. Так сессии не выпадают из `listSessions({ userId })` и UI-списка — человек видит
свои Telegram-сессии, а не машинный аккаунт шлюза. Карта `events.identityMap` задаётся в config
и переопределяется runtime (`GET/PUT/DELETE /api/v2/settings/events`); это **ручной override**
поверх основного источника — привязок в профиле.

**Attribution (автор сообщения).** `eventToMessage` для **всех** внешних источников кладёт в
`metadata` `principal_id`/`chat_key`/`thread_key` (если заданы), а `author` выводит из
`payload.from` без обращения к профилю: `from.username` → `@username`; иначе `firstName lastName`;
иначе `identity.principalId` (напр. `tg:123`). Cron-ветка не меняется (`author='Scheduler'`).
Для источников без `from`/`principalId` `author` не задаётся (прежнее поведение). Автор доходит
до LLM тем же путём, что и `Scheduler`: `ChatOrchestrator._sessionMessagesToLlm` рендерит
«чужое» user-сообщение как `{author}: <content>` (`withAttribution`, `orchestrator.ts`), поэтому
разные люди в одной сессии различимы и для модели, и в UI (сообщение видно в сессии).

**Права внешнего отправителя (этап 5).** Проблема: `identity.roles` (роль из allowlist шлюза,
напр. `['ADMIN']`) ядром ранее не читалась, поэтому права определяла **аутентификация запроса** —
в dev шлюз ходит admin-ключом, в managed — service-account с `USER`+`LEAD`. То есть любой, кого
пустил allowlist **шлюза**, действовал с правами **машинного аккаунта шлюза**.

Решение (fail-closed): **база прав — роли профиля Synth** отправителя, а `identity.roles` могут
только **сузить** их (пересечение), но **не повысить**. Отправитель, не сопознанный с профилем,
прав Synth не имеет (действует только «транспортное» участие: сессия/чат создаются, но
привилегированные операции недоступны).

- Резолвер `resolveEffectiveRoles(profileRoles, identityRoles)` (`engine/events/identity-roles.ts`):
  `profileRoles === null` (нет профиля/идентичности) → `{roles: [], linked: false}`;
  иначе база — роли профиля (нормализация к верхнему регистру, дедуп), при заданных
  непустых `identity.roles` — пересечение (`{roles, linked: true}`); пустое пересечение →
  `{roles: [], linked: true}` (сужение до нуля, но человек сопознан).
- Профильные роли приходят из `createExternalIdentityResolver` (`roles` профиля; ветка override
  `identityMap` ролей не знает → `[]` при `linked: true`).
- Funnel (`RequestSessionService.handleEvent`) считает эффективные роли **от самого отправителя**
  (`principalId`, не от владельца) и передаёт их в `deliver` расширенным контекстом
  `EventDeliveryContext {roles, linked}`; `deliver` (core/backend) кладёт их в `metadata` хода
  (`effective_roles`/`identity_linked`) — для аудита/attribution и роутинга.
- **Роли = доступность эндпоинтов (by design):** глобальные роли (`ADMIN`/`LEAD`/…) применяются на
  HTTP-уровне (`requirePermission`); внутри сессии набор тулов/разрешений одинаков для всех и
  определяется режимом, capabilities агента, MCP/скиллами. Роль-оси в permission-слое
  (`PermissionEvaluator`, AD-029) **нет и не планируется** — эффективные роли доставляются в ход
  для аудита/attribution, а машинный доступ интеграций сужается scoped **service-key** (AD-052,
  `scopes` + `allowedProjects`), не ролями отправителя. Права машинного аккаунта шлюза перестали
  «раздаваться» внешним отправителям (сопознанный с `USER` видит только пользовательские права,
  сужение работает, несопознанный — без прав).
- Правило для шлюзов: роль в `GATEWAY_ALLOWLIST` — **потолок** (сужает права профиля), а не
  дарование; не задавать роль / задавать максимальную — не ограничивать. Локальные команды
  шлюза (`/bind`/`/unbind`/`/new`) по-прежнему гейтятся allowlist-ролью (`BINDING_COMMANDS`) —
  это авторизация **шлюза**, не прав Synth.

**Доставка событий подписчикам.** Funnel уведомляет хаб о материализованной сессии
(`RequestSessionService` → `deps.onSessionMaterialized`) **до** доставки в неё события;
backend связывает колбэк с `EventHub.subscribeToSession(ownerId, sessionId)`, поэтому
WS/SSE-клиенты владельца, подключённые **до** создания сессии (в т.ч. events-funnel,
auto-bind/ephemeral), получают её события — иначе `[EventBus] publish … 0 subscribers — EVENT LOST`.
В standalone глобальный SSE-хаб `GET /api/v2/events` подписывается на **все** события шины
(`subscribeAll`) и покрывает сессии, созданные после подключения; в managed backend подписка —
per-session (RBAC-скоуп), поэтому владелец материализуемой сессии подписывается явно.

**LLM-дефолты (provider/model).** Сессии, материализуемые funnel'ом (`ephemeral`/`bind`, а также
явный `request`), при отсутствии **явных** `settings.provider`/`settings.model` заполняются
дефолтами инстанса через инъектируемый `deps.resolveLlmDefaults` — паритет с сессией без явной
модели: standalone core передаёт `llm.defaultProvider`/`llm.defaultModel` (`StandaloneConfig.llmDefaults`),
managed backend — `synth.llm` того же конфига. Явно заданные значения приоритетнее; поля
добираются **по отдельности** (задан только `provider` — `model` берётся из дефолта); резолвер не
задан или дефолты пусты — прежнее поведение (поля остаются незаданными). Без этого сессия
внешнего события (напр. Telegram-шлюз) не могла ответить, пока модель не проставят вручную
(`PATCH /api/v2/sessions/:id`), — оркестратор не резолвил провайдера при пустом
`session.settings.provider`.

**Дефолтный агент событийных сессий.** Сессии, материализуемые funnel'ом (`ephemeral`/auto-bind
`bind`), при пустом `decision.agentTemplate` создавались без `settings.agentRole` — оркестратор
берёт `effectiveAgentRole` из `session.settings.agentRole`, поэтому assistant-сообщение не получало
`agent`/`agentRole` и UI не рисовал бейдж агента. Порядок резолвинга (`_resolveSessionAgent`):
`_resolveAgent(agentTemplate)` → **`deps.resolveDefaultAgent`** (агент по умолчанию инстанса).
Явный шаблон приоритетнее; неизвестный шаблон при `unknownAgentTemplate: 'drop'` по-прежнему даёт
исключение `agent_not_found` (дефолт его **не** маскирует); резолвер не задан — прежнее поведение
(`agentRole` не проставляется). Проводка: core `createStandaloneApp` и backend `createBackendApp`
передают `getDefaultAgentId` (значение раздела «Агенты», поверх `DEFAULT_AGENT_ID`).

**Переустановка владельца при доставке (re-owner).** Владелец сессии из внешнего события
фиксировался только при **материализации**, поэтому Telegram-сессия, созданная до линковки
идентичности (claim-flow), оставалась за машинным аккаунтом шлюза (`service:<keyId>`, AD-052) или
без владельца — и не была видна человеку в UI. `RequestSessionService._maybeReassignOwner`
вызывается в ветках доставки в **существующую** сессию (`decision kind='bound'` и `kind='bind'`
с найденной привязкой) **до** `_deliver`: человек-отправитель резолвится тем же резолвером, что и
при создании (`deps.resolveExternalIdentity`); если текущий владелец пуст **или** машинный
(`service:*`), он переустанавливается на человека, сессия сохраняется и вызывается
`deps.onSessionMaterialized` (подписка хаба на сессию — чтобы ответы дошли до клиента нового
владельца). «Чужая человеческая» сессия **не** переустанавливается (в общем чате автором мог быть
другой человек — защита от угона); `null`/ошибка резолвера — fail-safe (владельца не трогаем,
событие всё равно доставляется).

### Командные сессии и видимость (список/доступ)

**Одна сессия на чат/тред.** Привязка (`EventBinding`) и auto-bind закрепляют внешний
адрес (`chatKey`/`threadKey`) за **одной** постоянной сессией — все сообщения чата/треда
попадают в неё (`routing`), поэтому групповая переписка ведётся в общей сессии.
**Владелец сессии — автор привязки** (человек, `principalId`), а не чат (см. «Владелец и
доставка» выше); владелец определяет ownership/UI-список, чат — только маршрутизацию.

**Видимость — участникам проекта.** Сессия, привязанная к проекту (`session.projectId`),
видна **владельцу проекта и любому участнику** (`project.members`, любая роль) — командная
работа поверх одной сессии. Личные сессии (без проекта) видны только владельцу; сессии без
владельца (legacy) видно всем (паритет с `canAccessSession`). `ADMIN`/`LEAD` — сквозной
обзор в списках (`GET /api/v2/sessions`, `GET /api/v2/projects`). Доступ по id
(`GET /sessions/:id/status|prompt|stats`, `POST /sessions/:id/prompt` и т.п.) — владелец
**или** участник проекта сессии, а также `ADMIN`/`LEAD`; `VIEWER` проекта читает сессию, но
не получает прав редактирования (`manage`/`edit` проекта не расширяются). Единый хелпер —
`server/session-visibility.ts` (`isSessionVisible`), сканы — `FileStore.listForUserScope`;
полные правила по ролям/типам сессий и проектов — в [docs/API_V2.md](../../docs/API_V2.md)
(§5.5 Sessions, §5.8 Projects).

### Создание сессии — тоже событие

Создание сессии оформляется как событие `session.requested` и обрабатывается **тем же роутером**, а не
отдельным путём. Инициировать его может как владелец (UI/CLI), так и агент (например, sub-agent,
[AD-033](./ad-033-session-branching-merge.md)) или внешний сервис. Это даёт единые правила: права,
шаблон агента, привязка, аудит и дедуп применяются независимо от того, кто попросил сессию.

### Переиспользование существующих кирпичей

| Задача | На чём строим |
|---|---|
| Решение «что за событие и в какую сессию» | [AD-034](./ad-034-model-routing.md) + [AD-035](./ad-035-micro-model-first.md) + тул `classify_conversation` |
| Создание и ветвление сессий | [AD-033](./ad-033-session-branching-merge.md) (parent_id, наследование, merge) |
| Контекст саб-агента | [AD-026](./ad-026-subagent-context-modes.md) (none / inherit / summary / last_n) |
| Агенты, скиллы, шаблоны | [AD-046](./ad-046-skills-and-slash-commands.md) и [AD-068](./ad-068-skills-agents-registry.md) |
| Права и режимы | [AD-029](./ad-029-granular-permissions.md) (allow/deny/ask), [AD-025](./ad-025-plan-act-toggle.md) |
| Безопасность вызовов LLM | [AD-036](./ad-036-llm-gateway.md) (guard, обфускация секретов/PII, rate limit, аудит) |
| Доставка событий | [AD-008](./ad-008-websocket-events.md)/[AD-009](./ad-009-session-event-bus.md)/[AD-024](./ad-024-eventhub-transport.md) |

### Слои и границы (не дублировать)

| Слой / сосед | AD | Что делает | Что не дублируем |
|---|---|---|---|
| Публичный API и приём webhook'ов | [AD-017](./ad-017-api-v2-hono.md) → [AD-052](./ad-052-public-api-platform.md) | ingress-точка: HTTP-запросы, подписи, rate limit | бизнес-маршрутизацию событий |
| MCP-сервер Synth | [AD-056](./ad-056-synth-mcp-server.md) | Synth как MCP-сервер для внешних агентов | поток «событие → сессия» (AD-089) |
| MCP-клиент | [AD-071](./ad-071-mcp-servers-prompt.md) | Synth дёргает внешние MCP-инструменты (действие) | приём входящих событий |
| Hooks / Plugin SDK | [AD-030](./ad-030-hooks-agent-events.md) | hook-шина и точки расширения | Router как потребитель шины |
| Scheduler / пайплайны | [AD-051](./ad-051-scheduler-pipelines.md) | cron/timer-события — источник `Event` | отдельный путь запуска сессий |
| Gateway / add-on шаблон | [AD-086](./ad-086-extensibility-plugins-editions.md) | как оформляется внешний сервис (репозиторий, образы, транспорт приёма) | конкретные источники событий |
| HTTP-прокси / egress | [AD-088](./ad-088-http-proxy.md) | исходящие соединения внешних коннекторов | маршрутизацию |

**Шлюз остаётся тонким транспортом.** Add-on (напр. Telegram-шлюз) только нормализует вход
(`normalize` → `POST /api/v2/events`) и доставляет выход (`GET /api/v2/events` → `sendMessage`);
он ничего не решает про маршрутизацию/сессии — это ядро ([AD-089](./ad-089-external-events-automation.md)).
Состояние шлюза — **инстанс-локальное** (`offset`/дедуп/привязки чатов на PVC), а **HA (leader election) и
мультитенантность — свойство слоя add-on** ([AD-086](./ad-086-extensibility-plugins-editions.md)), а не
контракта событий: ядру не важно, один бот или несколько тенантов за шлюзом.

### Роль `synth-media`

`synth-media` — внешний сервис-демонстратор (уже существует как отдельный репозиторий). Его роль
**двусторонняя**:

- **(а) Потребитель** API/webhook Synth: может инициировать события наравне с Telegram (публикация,
  ревью, идея из инбокса) — то есть выступает источником `Event`;
- **(б) Провайдер** MCP-сервера, который Synth дёргает: инструменты публикации/рендера/уведомлений —
  это «действие» после маршрутизации.

`synth-media` показывает, что прикладная логика канала живёт **вне Synth**, а Synth предоставляет
событийный вход и агентный рантайм.

### Безопасность, идемпотентность, аудит

- **Идентичность** — маппинг внешнего пользователя на профиль/RBAC ([AD-029](./ad-029-granular-permissions.md),
  [AD-043](./ad-043-unified-identity-login.md)); неизвестный отправитель не получает прав по умолчанию.
- **Дедуп** — по `dedupKey` (повторный webhook/пересланное сообщение не создаёт дубль).
- **Секреты** ботов/токенов — at-rest по модели [AD-076](./ad-076-git-repo-registry-ssh.md) (мастер-ключ),
  не логируются.
- **Ключи приёма** ([AD-052](./ad-052-public-api-platform.md), первый срез): модель целиком — в `EventBindingApiKey`
  выше. Неверный/отозванный/истёкший ключ → 401; использование пишется в журнал (`keyId`).
  Ключи — инстанс-локальные (не переносятся publish/fork, [AD-042](./ad-042-hybrid-mode.md)/[AD-081](./ad-081-hybrid-policy-leak-protection.md)).
- **Guard** — весь контент события проходит обфускацию перед LLM ([AD-036](./ad-036-llm-gateway.md));
  вложения — по [AD-085](./ad-085-multimodal-input.md).
- **Аудит** — все решения роутера (`bound`/`ephemeral`/`queue`/`bind`/`drop`) фиксируются; дроп — с причиной.
- **Политики гибрида** — какие источники и действия разрешены на managed-бэкенде, регулируют
  [AD-080](./ad-080-managed-hybrid-modes.md)/[AD-081](./ad-081-hybrid-policy-leak-protection.md).

## Статус реализации в коде

**Реализовано частично — ядро AD-089.**

- **Сущности и Router:** `SynthEvent`/`EventBinding`/`RouteDecision`/`SessionRequest` (shared), `EventRouter`
  (`engine/events/event-router.ts` — `allowedSources` → dedup → `EventBinding` → `RouteRuleProvider` →
  фоллбек по `events.defaultMode` (`bound` → `drop no_route`, `ephemeral` → временная сессия);
  журналирование решений), `RequestSessionService` (единый funnel: explicit → `direct`, внешнее → Router),
  `EventIngress` (ingest/нормализация), `RouteRuleProvider`/`EventDelivery` (seam/доставка).
- **Правила маршрутизации:** `EventRouteRule`/`EventRouteMatch`/`EventRouteTarget` (shared, Zod
  `eventRouteRuleInputSchema`/`eventRouteRuleUpsertSchema`), `RouteRuleStore` (`{dataDir}/events/routes.json`),
  `ProjectRuleProvider` (`engine/events/project-rule-provider.ts`, `name='project-rules'`) — матч по
  `source`/`type`/ключам идентичности/`label`/`keywords`, первый по `priority` выигрывает; `decisionFromTarget`
  (`target-decision.ts`) — единый маппинг цели в решение. Валидация на записи: `bound`/`queue` — сессия
  существует, `ephemeral` — `agentTemplate` резолвится в enabled-агента.
- **Decision-маршрутизация ([AD-084](./ad-084-decision-models-clef.md)):** `DecisionRuleProvider`
  (`engine/events/decision-rule-provider.ts`, `name='decision-rules'`) — decision-шаг после
  `ProjectRuleProvider` при флаге `events.decisionRouting` (default off, opt-in); при ошибке/низкой
  уверенности/пустом списке агентов возвращает `null` (fail-safe → Router идёт дальше по `defaultMode`).
  Регистрация — `server/app.ts` (core) и `backend/src/app.ts` (паритет). Решение несёт `confidence`/`signals`
  (`RouteDecision`) — попадают в ответ `POST /api/v2/events` и в журнал; успешный выбор логируется
  (`[DECISION] … agent/confidence/latency/model`), промахи — с latency.
- **Auto-bind:** флаг `events.autoBind` + `events.autoBindAgentTemplate` (`EventRouterConfig.autoBind`/
  `autoBindAgentTemplate`); фоллбек `EventRouter.decide` возвращает `{ kind: 'bind', signals: ['auto-bind'] }`
  при наличии `identity.chatKey|threadKey`; материализацию `kind: 'bind'` (постоянная сессия без `expiresAt`
  + `EventBinding mode='bound'`, переиспользование существующей привязки) выполняет `RequestSessionService`
  (`deps.bindingStore`); цель правила — `EventRouteTarget { mode: 'bind' }` (`decisionFromTarget`).
- **Резолвинг `agentTemplate`:** `RequestSessionService.resolveAgentTemplate` через `AgentRegistry`
  (`agent.enabled ? agent.id : null`); неизвестный шаблон — `unknownAgentTemplate` (`drop`/`default-agent`).
- **Агент по умолчанию для событийных сессий:** `_resolveSessionAgent` (`request-session.ts`) при
  пустом/нерезолвленном шаблоне берёт агент по умолчанию инстанса через `deps.resolveDefaultAgent`
  (проводка — core `createStandaloneApp`/backend `createBackendApp`: `getDefaultAgentId`); явный
  шаблон приоритетнее, `unknownAgentTemplate: 'drop'` → по-прежнему `agent_not_found`, без резолвера —
  прежнее поведение (`settings.agentRole` не проставляется).
- **Переустановка владельца при доставке (`_maybeReassignOwner`):** при доставке в существующую сессию
  (`kind: 'bound'`, `kind: 'bind'` с найденной привязкой) человек-отправитель резолвится
  `deps.resolveExternalIdentity`; если владелец пуст или машинный (`service:<keyId>`), он
  переустанавливается на человека, сессия сохраняется и вызывается `deps.onSessionMaterialized`
  (подписка хаба); «чужая человеческая» сессия не трогается (защита от угона), несопознанный
  отправитель/ошибка резолвера — fail-safe.
- **Надёжный «Стоп» (общий механизм сессий, не специфичен AD-089):** `POST /api/v2/sessions/:id/abort`
  ставит персистентный `SessionStatus.cancelRequested` (+`cancelRequestedAt`, AD-005) под локом —
  работает, когда `currentStream`/cancel-token отсутствуют (очередь/backoff/между итерациями); при живом
  стриме — graceful `orchestrator.cancel`, затем `QueueProcessorManager.requestStop` (сброс
  `pendingMessages`/`blocked`/флага, `stream.cancelled` один раз); процессора нет — флаг снимается
  (нет ложной отмены следующего запуска). Оркестратор проверяет флаг (`isCancelRequested`) на верхней
  границе `while (toolIteration < maxIterations)`. Детали — [docs/API_V2.md §5.5](../../docs/API_V2.md).
- **Идентичности профиля (AD-089, этап 3):** `ExternalIdentity` (`provider`/`externalId`/`username?`/
  `displayName?`/`linkedAt`/`linkedBy?`) в `ProfileData.identities[]` (хранилище — `FileProfileStore`,
  snake_case: `external_id`/`display_name`/`linked_at`/`linked_by`; legacy без поля → `[]`); методы
  `findProfileByExternalId`/`linkIdentity`/`unlinkIdentity` (инвариант уникальности пары
  `provider:externalId`, конфликт → `null`); хелперы `buildPrincipalId`/`parsePrincipalId` (shared).
  Резолвер `createExternalIdentityResolver` (`engine/events/external-identity.ts`) в `RequestSessionService`
  (`deps.resolveExternalIdentity`): override `identityMap` → профиль; профильная ветка возвращает `roles`
  профиля. API `/api/v2/me/identities` (`GET`/`DELETE`),
  UI — секция «Идентичности» в `ProfileSettings`. Claim-flow — следующий этап.
- **Права внешнего отправителя (AD-089, этап 5):** `resolveEffectiveRoles` (`engine/events/identity-roles.ts`) —
  база — роли профиля (`createExternalIdentityResolver` → `roles`), `identity.roles` только **сужают**
  (пересечение; нормализация к верхнему регистру), несопознанный (`profileRoles === null`) → `[]`/`linked:false`
  (fail-closed). `RequestSessionService.handleEvent` (`_resolveDeliveryContext`) считает роли **от самого
  отправителя** и передаёт `EventDeliveryContext {roles, linked}` в `deliver`; core/backend `deliver` пишет
  `metadata.effective_roles`/`identity_linked` в ход. **Роль-оси в permission-слое (`PermissionEvaluator`, AD-029)
  нет — by design:** роли = доступность **эндпоинтов** (HTTP), внутри сессии тулы/разрешения одинаковы для всех.
  Роли доставляются в ход для аудита/attribution; машинный доступ сужается scoped **service-key** (AD-052).
  Практический эффект: права машинного аккаунта шлюза не раздаются внешним отправителям.
- **Хранилища:** `EventBindingStore` (`{dataDir}/events/bindings.json`), `EventJournalStore` (`{dataDir}/events/journal.jsonl`),
  `RouteRuleStore` (`{dataDir}/events/routes.json`), `EventApiKeyStore` (`{dataDir}/events/api-keys.json`, AD-052-первый срез;
  `schemaVersion`, sha256-хеш секрета) (AD-005); ephemeral TTL — `Session.expiresAt`/`archivedAt` + `startEphemeralSweeper`.
- **API-ключи привязок (AD-089/AD-052, первый срез):** полное описание модели — `EventBindingApiKey` выше.
  Эндпоинты `GET/POST /api/v2/events/bindings/:id/keys`, `PATCH .../keys/:keyId` (метка/описание/срок/лимит;
  `null` — сброс), `POST .../keys/:keyId/revoke` (идемпотентно), `DELETE .../keys/:keyId`; `EventApiKeyStore`
  (`{dataDir}/events/api-keys.json`, `schemaVersion`, sha256-хеш секрета), legacy-backfill `name`→`label` при
  чтении, дубль `label` → 409 `CONFLICT`, каскад `removeByBinding` при удалении привязки. Приём
  `POST /api/v2/events` по `Authorization: Bearer <binding-key>` аутентифицирует без пользовательских кред
  (source/чат из привязки, тело `eventKeyIngestSchema` — `source` опционален), использование пишется в журнал
  (`keyId`/`principalId`); `EventKeyCredential` (`keyId`/`bindingId`/`rateLimitPerMinute`, задел `scopes`/`principalId`).
- **Per-key rate limit (AD-089/AD-052):** `KeyRateLimiter` (`engine/events/key-rate-limiter.ts`) —
  in-memory fixed-window 60 c по `keyId`; лимит ключа `rateLimitPerMinute`, иначе глобальный дефолт
  `events.keyRateLimitPerMinute` (0 — без лимита); превышение → `429 RATE_LIMITED`.
- **Мастер-выключатель:** `events.enabled` — при `false` приём `POST /api/v2/events` → `503 UNAVAILABLE`
  (проверяется до аутентификации; live-значение).
- **Retention журнала:** `EventJournalStore.prune(retentionDays)` + pruner `startEventJournalPruner`
  (`engine/events/journal-prune.ts`) — prune на старте и периодически (default 6 ч, `unref`); `journalRetentionDays <= 0`
  — без ограничения; останавливается на graceful shutdown (`stopEventJournalPruner`).
- **Runtime-настройки «События»:** `RuntimeSettings.events` + `mergeEventsConfig` (`storage/runtime-settings.ts`);
  API `GET/PUT/DELETE /api/v2/settings/events` (`enabled`, `defaultMode`, `ephemeralTtl`, `journalRetentionDays`,
  `allowedSources`, `unknownAgentTemplate`, `keyRateLimitPerMinute`, `decisionRouting`, `autoBind`,
  `autoBindAgentTemplate`); live-применение — `EventRouter.updateConfig`/
  `RequestSessionService.updateConfig` (мутации — `eventsWriteGuard`: ADMIN в managed, в core — `requireAuth`).
- **API:** `POST /api/v2/events` (ingest; fallback — `requireAuth`, иначе API-ключ привязки; rate limit на оба пути),
  `GET/POST/DELETE /api/v2/events/bindings` (+ key-эндпоинты выше), `GET/POST /api/v2/events/routes`,
  `DELETE /api/v2/events/routes/:id`, `GET /api/v2/events/journal`; SSE `GET /api/v2/events` сохранён.
  RBAC (managed): мутации bindings/routes/keys — `requirePermission('ADMIN','LEAD')`, чтение ключей — LEAD/ADMIN,
  остальное чтение — `requireAuth` (`writeGuard`/`keyReadGuard`/`ingestPreGuard` в `createEventRoutes`, AD-089).
  `GET/PUT/DELETE /api/v2/settings/events` — под `eventsWriteGuard` (ADMIN).
- **UI:** раздел «События» перенесён в **пользовательскую часть** (просмотр всем ролям, создание — LEAD/ADMIN);
  ключи привязки — первоклассной секцией внутри карточки привязки (создание/редактирование/отзыв, статусы,
  `label`/описание/срок/лимит); админ-секция «Параметры событий» (`eventsConfig`) — глобальные runtime-настройки;
  журнал остаётся в разделе и **дублируется** в «Логи и аудит». Детали — `packages/ui/AGENTS.md`.
- **Единый funnel:** создание сессии — только через `RequestSessionService` (инвариант 16);
  `forkSession`/backend `/import`/`remote/transfer.ts`/`chat.ts` — materialization.
- **Источник событий — cron (AD-051, минимальный срез):** `SchedulerService` + `SchedulerRuleProvider`
  публикуют `{source:'cron', type:'schedule_fired'}` через `EventIngress`; `ScheduleStore`/API `/api/v2/schedules`/UI-вкладка «Шедулер».
  Сообщения авторизуются системным пользователем `Scheduler` (описание — `prompts/system/SCHEDULER.{lang}.md`, AD-051).
- **Хуки (AD-030, min):** `HookBus` + эмиты жизненного цикла (`pre/post_tool_use`, `session_requested`, `external_event`, …).

**Не реализовано (остаток):**

- **Plugin SDK и загрузка плагинов** ([AD-030](./ad-030-hooks-agent-events.md); спецификация —
  [AD-090](./ad-090-extension-api.md)) — нет (hook-шина и эмиты жизненного цикла реализованы);
- **пайплайны** (цепочки шагов, [AD-059](./ad-059-pipeline-automation.md)) — нет;
- **стриминг ответа наружу** (edit-in-place / typing-indicator) — нет;
- **остаток [AD-086](./ad-086-extensibility-plugins-editions.md) как AD** — HA через leader election,
  webhook-транспорт и второй канал — нет; **мультитенантность реализована** («несколько ботов → несколько
  сред», `tenants.json`; первый add-on — Telegram-шлюз).

**Закрыто реализацией:** источник [AD-052](./ad-052-public-api-platform.md) — ✅ **этапы I–IV**:
binding-key (первый срез); service-key (общий ключ инстанса со `scopes` + проектной проекцией
`allowedProjects`); исходящие webhooks; public-OpenAPI + SDK `@itphx/synth-sdk`; перевод
мессенджер-шлюза на scoped service-key. Ключи — **инстанс-локальные секреты**: не переносятся
publish/fork и межмировой обмен ([AD-042](./ad-042-hybrid-mode.md)/[AD-081](./ad-081-hybrid-policy-leak-protection.md)).
Источник [AD-086](./ad-086-extensibility-plugins-editions.md) — первый add-on (**Telegram-шлюз**,
`addons/synth-gateway-telegram`): long-polling → `POST /api/v2/events` + обратный watcher событий.
**LLM-классификация правил маршрутизации — закрыта** decision-шагом `DecisionRuleProvider`
([AD-084](./ad-084-decision-models-clef.md)): включается `events.decisionRouting` (default off),
fail-safe; отдельный резерв через micro-слой [AD-034](./ad-034-model-routing.md)/[AD-035](./ad-035-micro-model-first.md)
не требуется.

**Переиспользуемые кирпичи:** сводная таблица — в разделе «Детали» («Переиспользование существующих кирпичей» выше).

## Открытые вопросы

- **Транспорт приёма:** webhook vs long-polling vs исходящий pull — что дефолт для каждого источника?
  **Для Telegram — закрыто на уровне реализованного шлюза:** дефолт — **long-polling** (`getUpdates`);
  **webhook** — отложенная альтернатива (stateless HTTP за ingress). Принципиальное ограничение Telegram:
  `getUpdates` допускает **одного** потребителя на бота — второй поллер получает **`409 Conflict`**, поэтому
  шлюз сейчас singleton (`replicaCount: 1` + `strategy: Recreate`), а HA — только через leader election
  (K8s Lease, hot standby). Топология, HA и мультитенантность шлюза — [AD-086](./ad-086-extensibility-plugins-editions.md),
  раздел «Первый частный случай — Telegram gateway». **Для остальных источников вопрос открыт.**
- **Модель идентичности (закрыта — этап 4):** внешние идентичности хранятся в
  **профиле** (`ProfileData.identities[]`; ключ — `provider` + `externalId` — числовой id
  источника, `username`/`displayName` — display-кэш, не ключ; `linkedAt`/`linkedBy` — аудит
  привязки). Резолвинг внешнего отправителя (`identity.principalId` → пользователь инстанса) —
  через `createExternalIdentityResolver` (профиль по паре `provider:externalId`); override — карта
  `events.identityMap` (`principalId` предпочтительно, `chat:…` — фоллбек). API:
  `GET/DELETE /api/v2/me/identities` (свои) + **`POST /api/v2/me/identities/claim`** — привязка
  только через **claim-flow** (подтверждение владения id); прямой привязки произвольного чужого
  id нет. **Claim-flow:** при приёме события от неизвестного отправителя (`resolveExternalIdentity`
  → `null`, задан `identity.principalId`) ядро выпускает **одноразовый** код
  (`IdentityClaimStore`, `{dataDir}/events/identity-claims.json`) со сроком жизни по умолчанию
  **10 минут**, алфавит base32 **без неоднозначных символов** (`0/O/1/I` исключены; 32 символа,
  6 знаков ≈ 2^30 — перебор нецелесообразен), формат `XXX-XXX` (регистронезависимый ввод).
  `provider`/`externalId` кода берутся из **серверной** записи (тело `POST /claim` их не задаёт —
  подстановка чужого id исключена); `consume` помечает `consumedAt` (повтор → 404) и валидирует
  пару. Код возвращается ingest'ом в опциональном поле `identityHint` ответа `POST /events`
  и доставляется отправителю шлюзом **только в приватном чате** (решение: в приватном чате
  `chatKey` соответствует самому человеку, код скрыт от третьих лиц; в группе/канале код
  увидят все участники и могли бы «угнать» привязку — поэтому в публичном чате код не
  показывается и истекает по TTL). На инстансе линковка включается на стороне шлюза:
  `GATEWAY_UNKNOWN_ACTION=hint` (дефолт `register` коды не показывает). Остаточный
  теоретический вектор — перехват кода в приватном чате (компрометация аккаунта/чата
  отправителя); снижается коротким TTL и одноразовостью. `IdentityClaimStore` —
  **инстанс-локальный** (как API-ключи привязок): не переносится publish/fork
  (AD-042/AD-081).
- **Мультитенантность:** один Router на инстанс vs на проект/организацию; изоляция событий.
- **Гранулярность `bound`:** чат / тред / топик / ветка диалога — и как мигрирует при переносе сессии
  между проектами ([AD-040](./ad-040-sessions-without-project.md))?
- **Стриминг ответа наружу:** edit-in-place / typing-indicator — на стороне источника или Synth?

Ряд вопросов закрыт реализацией — см. «Статус реализации в коде».

## Связи

- [AD-030](./ad-030-hooks-agent-events.md) — hook-шина и точки расширения (Plugin SDK — не реализован);
  Router — ядровый слой, эмитит `external_event`/`session_requested`.
- [AD-034](./ad-034-model-routing.md), [AD-035](./ad-035-micro-model-first.md) — слой решения (классификация события/интента).
- [AD-033](./ad-033-session-branching-merge.md) — создание/ветвление сессий под событие.
- [AD-026](./ad-026-subagent-context-modes.md) — режимы контекста при запуске агента.
- [AD-029](./ad-029-granular-permissions.md), [AD-036](./ad-036-llm-gateway.md) — права и безопасность.
- [AD-051](./ad-051-scheduler-pipelines.md) — cron/timer-источники и событийные триггеры.
- [AD-052](./ad-052-public-api-platform.md) — ingress webhook'ов и публичный API; ✅ реализован
  (этапы I–IV): API-ключи привязок (binding-key) — первый срез; service-key + scopes + проектная
  проекция `allowedProjects`; webhooks; public-OpenAPI + SDK `@itphx/synth-sdk`; перевод
  мессенджер-шлюза на scoped service-key.
- [AD-056](./ad-056-synth-mcp-server.md) — Synth как MCP-сервер (обратное направление).
- [AD-071](./ad-071-mcp-servers-prompt.md) — вызов внешних MCP как действие.
- [AD-086](./ad-086-extensibility-plugins-editions.md) — внешние сервисы-надстройки и общий шаблон gateway.
- [AD-087](./ad-087-messenger-gateway-merged.md) — мессенджер-шлюз (поглощён AD-086) как частный источник событий.
- [AD-042](./ad-042-hybrid-mode.md), [AD-045](./ad-045-hybrid-server-profiles.md) — локальный/удалённый приём событий.
- [AD-080](./ad-080-managed-hybrid-modes.md), [AD-081](./ad-081-hybrid-policy-leak-protection.md) — политики и защита от утечек.
- [AD-085](./ad-085-multimodal-input.md) — вложения из событий.
- [AD-088](./ad-088-http-proxy.md) — egress внешних коннекторов.
- `synth-media` — внешний сервис-демонстратор (потребитель API/webhook и провайдер MCP).

# AD-089: Synth как платформа внешних событий и автоматизации

> **Статус:** ⚠️ Частично реализовано (ядро Event/Binding/Router, единый funnel, API/UI, источник cron (AD-051); AD-052/086 — нет)
> **Дата:** 2026-10-08
> **Связано:** [AD-030](./ad-030-hooks-agent-events.md) «Hooks для событий агента» (фундамент),
> [AD-034](./ad-034-model-routing.md) «Routing между моделями», [AD-035](./ad-035-micro-model-first.md) «Micro-model first»,
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
- **API v2** ([AD-017](./ad-017-api-v2-hono.md)) — HTTP-вход, база будущего публичного API ([AD-052](./ad-052-public-api-platform.md));
- **Гибрид** ([AD-042](./ad-042-hybrid-mode.md)/[AD-045](./ad-045-hybrid-server-profiles.md)) — событие может прийти
  как в локальный standalone, так и на managed-бэкенд;
- **Демонстратор** — `synth-media`: внешний сервис с Telegram-MCP и ботом уже работает как потребитель
  прикладного API и провайдер MCP-инструментов.

### Чего нет

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
    roles?: string[];      // маппинг на RBAC (AD-029), identity — AD-043
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

**`Router`** — слой разрешения события в сессию (или в отложенную обработку/дроп). Реализуется поверх
hook-шины [AD-030](./ad-030-hooks-agent-events.md), решения — на [AD-034](./ad-034-model-routing.md)/
[AD-035](./ad-035-micro-model-first.md) и туле `classify_conversation`.

```typescript
type RouteDecision =
  | { kind: 'bound'; sessionId: string }
  | { kind: 'ephemeral'; agentTemplate: string; ttl: string }
  | { kind: 'queue'; owner: string; reason: string }
  | { kind: 'drop'; reason: string; audited: true };
```

### Порядок маршрутизации

1. **Явный `Binding`** (чат / тред / топик → сессия). Самый сильный сигнал: если для `chatKey`/`threadKey`
   есть запись — событие уходит в привязанную сессию без классификации.
2. **Правила проекта** (источник / канал / отправитель / метка / ключевые слова) → **шаблон агента + режим**.
   Правила конфигурируемы (проект/инстанс), комбинируются; лёгкая проверка — micro-слой
   ([AD-035](./ad-035-micro-model-first.md)) и `classify_conversation`.
3. **Политика режима** решает, как материализовать сессию:
   - `bound` — постоянная сессия на диалог (переписка: контекст копится, история не теряется);
   - `ephemeral` — сессия на событие с TTL и авто-архивом (разовые триггеры: webhook, CI, кнопка);
   - `queue` — не запускать сразу, отложить владельцу (уведомление + элемент в очереди,
     переиспользование `QueueProcessorManager`, `packages/core/src/queue/processor.ts`).
4. **Фоллбек** — дефолтный агент / очередь / **дроп с аудитом** (`drop` всегда фиксируется, чтобы не терять
   события молча).

**Значение по умолчанию (гибрид):** переписка — `bound`, разовые триггеры — `ephemeral`. `queue` и `drop` —
осознанные политики, а не дефолт.

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
| Gateway / add-on шаблон | [AD-086](./ad-086-extensibility-plugins-editions.md) | как оформляется внешний сервис (репозиторий, образы, webhook) | конкретные источники событий |
| HTTP-прокси / egress | [AD-088](./ad-088-http-proxy.md) | исходящие соединения внешних коннекторов | маршрутизацию |

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
- **Guard** — весь контент события проходит обфускацию перед LLM ([AD-036](./ad-036-llm-gateway.md));
  вложения — по [AD-085](./ad-085-multimodal-input.md).
- **Аудит** — все решения роутера (`bound`/`ephemeral`/`queue`/`drop`) фиксируются; дроп — с причиной.
- **Политики гибрида** — какие источники и действия разрешены на managed-бэкенде, регулируют
  [AD-080](./ad-080-managed-hybrid-modes.md)/[AD-081](./ad-081-hybrid-policy-leak-protection.md).

## Статус реализации в коде

**Реализовано частично — ядро AD-089.**

- **Сущности и Router:** `SynthEvent`/`EventBinding`/`RouteDecision`/`SessionRequest` (shared), `EventRouter`
  (`engine/events/event-router.ts` — `allowedSources` → dedup → `EventBinding` → `RouteRuleProvider` → `drop no_route`,
  журналирование решений), `RequestSessionService` (единый funnel: explicit → `direct`, внешнее → Router),
  `EventIngress` (ingest/нормализация), `RouteRuleProvider`/`EventDelivery` (seam/доставка).
- **Хранилища:** `EventBindingStore` (`{dataDir}/events/bindings.json`), `EventJournalStore` (`{dataDir}/events/journal.jsonl`)
  (AD-005); ephemeral TTL — `Session.expiresAt`/`archivedAt` + `startEphemeralSweeper`.
- **API:** `POST /api/v2/events` (ingest), `GET/POST/DELETE /api/v2/events/bindings`, `GET /api/v2/events/journal`;
  SSE `GET /api/v2/events` сохранён. RBAC: ingest — `requireAuth` + rate limit, мутации биндингов — ADMIN.
- **UI:** админ-раздел «События» (bindings + журнал).
- **Единый funnel:** создание сессии — только через `RequestSessionService` (инвариант 16);
  `forkSession`/backend `/import`/`remote/transfer.ts`/`chat.ts` — materialization.
- **Источник событий — cron (AD-051, минимальный срез):** `SchedulerService` + `SchedulerRuleProvider`
  публикуют `{source:'cron', type:'schedule_fired'}` через `EventIngress`; `ScheduleStore`/API `/api/v2/schedules`/UI-вкладка «Шедулер».
- **Хуки (AD-030, min):** `HookBus` + эмиты жизненного цикла (`pre/post_tool_use`, `session_requested`, `external_event`, …).

**Не реализовано (остаток):**

- Источники AD-052 (публичный API/ключи/webhooks) и AD-086 (add-on + Telegram gateway → `message_received`);
- Plugin SDK и загрузка плагинов ([AD-030](./ad-030-hooks-agent-events.md));
- развилки v1: `queue` (defer без старта процессора), `agentTemplate` → `settings.agentRole` (резолвинг через AgentRegistry — задел);
- Job-история/catch-up/пайплайны ([AD-051](./ad-051-scheduler-pipelines.md) → [AD-059](./ad-059-pipeline-automation.md)).

**Переиспользуемые кирпичи:**

- [AD-034](./ad-034-model-routing.md) и [AD-035](./ad-035-micro-model-first.md) — микро-каскад (`engine/router/micro/`); тул `classify_conversation`.
- Ветвление/наследование сессий ([AD-033](./ad-033-session-branching-merge.md)) и очередь (`QueueProcessorManager`, `queue/processor.ts`).
- MCP-клиент ([AD-071](./ad-071-mcp-servers-prompt.md)) и API v2 ([AD-017](./ad-017-api-v2-hono.md)).
- Внешний демонстратор `synth-media` (Telegram-MCP + бот).

## Открытые вопросы

- **Транспорт приёма:** webhook vs long-polling vs исходящий pull — что дефолт для каждого источника?
- **Модель идентичности:** собственная таблица маппинга внешних id ↔ профили или внешний IdP
  ([AD-043](./ad-043-unified-identity-login.md))?
- **Хранение `Binding`/`Event`:** где (FileStore [AD-005](./ad-005-json-storage.md) / PostgreSQL [AD-032](./ad-032-history-storage-postgresql.md))
  и как долго хранить журнал событий (retention, [AD-074](./ad-074-soft-delete-retention.md))?
- **`ephemeral` TTL:** кто закрывает/архивирует сессию, как считается простой, что с недописанными ответами?
- **Мультитенантность:** один Router на инстанс vs на проект/организацию; изоляция событий.
- **Гранулярность `bound`:** чат / тред / топик / ветка диалога — и как мигрирует при переносе сессии
  между проектами ([AD-040](./ad-040-sessions-without-project.md))?
- **Стриминг ответа наружу:** edit-in-place / typing-indicator — на стороне источника или Synth?
- **Отношение к [AD-030](./ad-030-hooks-agent-events.md):** Router — плагин на hook-шине или ядровый слой?
- **Отношение к [AD-051](./ad-051-scheduler-pipelines.md):** cron — частный источник `Event` или
  отдельный пайплайн-движок со своей моделью?

## Связи

- [AD-030](./ad-030-hooks-agent-events.md) — **фундамент**: hook-шина и Plugin SDK, на которых строится Router;
  события уровня интеграций `external_event`/`message_received`/`callback`.
- [AD-034](./ad-034-model-routing.md), [AD-035](./ad-035-micro-model-first.md) — слой решения (классификация события/интента).
- [AD-033](./ad-033-session-branching-merge.md) — создание/ветвление сессий под событие.
- [AD-026](./ad-026-subagent-context-modes.md) — режимы контекста при запуске агента.
- [AD-029](./ad-029-granular-permissions.md), [AD-036](./ad-036-llm-gateway.md) — права и безопасность.
- [AD-051](./ad-051-scheduler-pipelines.md) — cron/timer-источники и событийные триггеры.
- [AD-052](./ad-052-public-api-platform.md) — ingress webhook'ов и публичный API.
- [AD-056](./ad-056-synth-mcp-server.md) — Synth как MCP-сервер (обратное направление).
- [AD-071](./ad-071-mcp-servers-prompt.md) — вызов внешних MCP как действие.
- [AD-086](./ad-086-extensibility-plugins-editions.md) — внешние сервисы-надстройки и общий шаблон gateway.
- [AD-087](./ad-087-messenger-gateway-merged.md) — мессенджер-шлюз (поглощён AD-086) как частный источник событий.
- [AD-042](./ad-042-hybrid-mode.md), [AD-045](./ad-045-hybrid-server-profiles.md) — локальный/удалённый приём событий.
- [AD-080](./ad-080-managed-hybrid-modes.md), [AD-081](./ad-081-hybrid-policy-leak-protection.md) — политики и защита от утечек.
- [AD-085](./ad-085-multimodal-input.md) — вложения из событий.
- [AD-088](./ad-088-http-proxy.md) — egress внешних коннекторов.
- `synth-media` — внешний сервис-демонстратор (потребитель API/webhook и провайдер MCP).

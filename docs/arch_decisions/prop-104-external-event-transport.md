# PROP-104: Внешний транспорт событий: публикация между репликами control plane

> **Статус:** 🧩 Предложение — внешний транспорт событий (pub/sub) для нескольких реплик control plane; sticky-сессии — промежуточная мера
> **Решение до:** 2026-11-14
> **Дата:** 2026-10-22
> **Источник:** 2026-10-22 (аудит готовности Synth к backend.replicaCount > 1)
> **Связано:** ADR-009, ADR-024, ADR-089, ADR-101, ADR-077

**Решение:** доменная шина событий ([ADR-009](./adr-009-session-event-bus.md)) остаётся **интерфейсом** домена, но её **доставка** выносится во внешний транспорт публикации/подписки (pub/sub), чтобы реплики control plane видели события друг друга. Локальная (in-process) доставка сохраняется как **быстрый путь** (событие уходит локальным подписчикам синхронно, без round-trip) и как **fallback** при недоступности транспорта. Транспорт — реализация за портом (образец портов: [ADR-096](./adr-096-storage-layer.md), [ADR-077](./adr-077-runtime-toolchain.md)); конкретный backend выбирается по критериям раздела «Открытые вопросы», рабочая гипотеза — `LISTEN/NOTIFY` PostgreSQL (хранилище при >1 реплике всё равно обязательно, [ADR-097](./adr-097-storage-provider-class.md)). Sticky-сессии (`sessionAffinity: ClientIP`) — **промежуточная** мера: они убирают симптом для части сценариев, но не решают блокер.

## Решение

### Что пересекает границу реплики

| Категория | Что уезжает | Куда | Комментарий |
|---|---|---|---|
| События сессии | `stream.*`, `message.*`, `session.*`, `permission.*`, `question.*`, `plan.approved`, `todos.updated`, `fs.changed`, `subagent.*` | шина реплики, у которой есть подписчик на эту сессию | ADR-009; типы — `packages/shared/src/types/bus-events.ts` |
| Инстансный канал | `pipeline.run.*`, `pipeline.completed` | глобальные подписчики реплики | ADR-101: `INSTANCE_EVENT_CHANNEL = 'instance'` (`packages/core/src/events/bus.ts:16`), публикация — `packages/core/src/engine/pipelines/engine.ts:1109` |
| События для исходящих webhooks | те же события инстанса | движок `WebhookService` в **любой** реплике | ADR-052 этап II: движок подписан на `eventBus.subscribeAll` (`packages/core/src/engine/webhooks/service.ts:123`) — сегодня он видит только события своего процесса |
| Сигналы для аддонов-шлюзов | события сессии + `session.created` | SSE `/api/v2/events` клиента-шлюза | ADR-087/ADR-103: шлюз подписан глобально (`packages/backend/src/app/sse-events.ts:27-57`) |
| Гибридный мост | `remote:<id>`-события удалённых сессий | локальная шина standalone | `packages/core/src/remote/event-bridge.ts:227` — это **вход** в локальную шину, наружу не уезжает |

### Что НЕ должно уезжать (остаётся локальным by design)

- **Локальные хуки `HookBus`** (ADR-030) — `pre_tool_use`/`post_tool_use`/`permission_denied`/… — это точки расширения **внутри** процесса: их обработчики — функции, они не сериализуются, а `pre_tool_use` умеет **блокировать** вызов (`packages/core/src/engine/hooks/hook-bus.ts:58-59`). Синхронная блокирующая семантика через сеть не переносится: либо блокирующий хук остаётся локальным, либо хуки становятся асинхронными (отдельная задача, не здесь).
- **Process-local счётчики и кэши**: `decisionMetrics` — process-wide синглтон в памяти (`packages/core/src/engine/router/decision-metrics.ts:48-54`, `packages/core/src/engine/router/decision-metrics.ts:113`); in-memory rate limit'ы (`packages/core/src/engine/events/key-rate-limiter.ts:6-10`, `packages/backend/src/middleware/rate-limiter.ts:15`); in-memory дедуп-`Set` (`packages/core/src/engine/events/dedup-store.ts:22-34`).
- **Процесс-глобальные singleton'ы**: TLS/CA-диспетчер, пул PG, MCP-менеджер, шедулер. Их нельзя переинициализировать «на лету» (инвариант 24 корневого `AGENTS.md`) — значит, транспорт событий не должен быть их частью: он либо создаётся при старте процесса, либо переживает рестарт через общее хранилище.

### Транспорт: варианты и сравнение

| Вариант | Что уже есть в репозитории | Сложность | Эксплуатационная нагрузка | Отказоустойчивость | Ограничения |
|---|---|---|---|---|---|
| **PostgreSQL `LISTEN/NOTIFY`** | PG — обязательная предпосылка >1 реплики (ADR-096/ADR-097); advisory-локи уже используются (`packages/storage-postgres/src/locks.ts:60-61`, `packages/storage-postgres/src/locks.ts:92`, `packages/storage-postgres/src/locks.ts:172`); `pg` уже в `optionalDependencies` драйвера (`packages/storage-postgres/package.json`); `LISTEN/NOTIFY` в коде **не применяется** | низкая: отдельное соединение с `LISTEN` + `NOTIFY` в publish-пути | новая инфраструктура не нужна; каждый `NOTIFY` — запись в WAL + рассылка **всем** слушателям канала (фильтрации в PG нет) | **at-most-once**: подписчик, отключившийся в момент публикации, событие не получит; переподключение — потеря | payload **< 8000 байт** по умолчанию (документация PostgreSQL 17, `NOTIFY`); доставка транзакционная (событие уходит только после коммита); `LISTEN` занимает сессию; один кластер PG = один предел масштабирования; payload попадает в **WAL** (см. «Сигнал или payload») |
| **Таблица-«outbox» + polling** | схема и порты уже есть (`packages/storage-postgres/src/migrations/001-init.ts:277-291` — `event_journal`; `packages/storage-postgres/src/migrations/001-init.ts:305-308` — `dedup`); контракт портов — образец (ADR-096) | средняя: своя таблица, курсор, retention | постоянный polling — нагрузка на БД, задержка = интервал опроса | **at-least-once** (очередь в таблице), переживает переподключение | задержка не «мгновенная» (секунды), свой retention, дубликаты на стороне подписчика |
| **Redis pub/sub** | в репозитории **нет** (только `redis-cli` в dev-образе как клиент; `storage.backend=redis` — fail-closed, `packages/shared/src/config/resolve.ts`) | средняя: новая зависимость + новая инфраструктура + TLS/пароли (ADR-099) | отдельный сервис в кластере | at-most-once, без персистентности | новая точка отказа и новая сущность в чарте/компосе; для self-host'а — лишняя зависимость |
| **NATS / NATS JetStream** | в репозитории **нет** | высокая: новая инфраструктура, свой конфиг, TLS | отдельный сервис | core NATS — at-most-once; JetStream — at-least-once с персистентностью | избыточно для текущего объёма; оправдано, когда >1 инстанс и/или межконтурный обмен |
| **Внешний брокер (Kafka/RabbitMQ)** | [PROP-060](./prop-060-multi-contour-bridge.md) — vision: транспорт между контурами Kafka/RabbitMQ, конкретный выбор открыт | очень высокая | отдельный кластер + операционная модель | at-least-once | scope другого документа (межконтурный обмен), не межрепличная доставка внутри одного инстанса |

**Рабочая гипотеза — `LISTEN/NOTIFY` PostgreSQL**, потому что: (1) при >1 реплики PG всё равно обязателен, т.е. новая инфраструктура не появляется; (2) в драйвере уже есть механика координации на advisory-локах и отработанная схема; (3) семантика «живых» событий (стриминг, `stream.chunk`) **не требует** долговечности — персистентная запись ответа живёт в хранилище сессий, а не в шине; (4) отказоустойчивость at-most-once тут приемлема **только если** потеря live-события не ломает пользовательский сценарий (см. критерии в «Открытые вопросы»).

**Чего гипотеза не закрывает:** (а) 8 КБ payload — `stream.chunk` с большим текстом требует либо схлопывания, либо «сигнального» режима (см. ниже); (б) отсутствие фильтрации — каждая реплика получает **все** события, фильтровать надо на своей стороне (значит, сериализация лишних событий в каждой реплике); (в) попадание payload в WAL PG — пользовательский текст не должен попадать в канал целиком.

#### «Сигнал» или «payload»

Ключевое решение границы: **в транспорт уезжает сигнал, а не содержимое.**

- Для **персистентных** событий (`message.added`, `session.created`, `plan.approved`, `todos.updated`) в канал уходит `{ v, id, origin, ts, sessionId, type }` — детали подписчик читает из общего хранилища (сессии/сообщения — там же, где они и лежат). Это снимает и лимит payload, и утечку пользовательского текста в WAL/бэкапы PG.
- Для **эфемерных** live-событий (`stream.chunk`, `stream.usage`) содержимое передать нужно — оно нигде не сохраняется. Здесь лимит 8 КБ применяется явно: чанк длиннее → либо разбить, либо схлопнуть (это решение открытое, см. «Открытые вопросы»).
- Правило по умолчанию: **payload наружу не выходит**, пока это явно не разрешено для конкретного типа события.

### Семантика доставки

| Аспект | Решение |
|---|---|
| Базовый режим транспорта | **at-most-once** (PG `NOTIFY`, Redis pub/sub, NATS core): подписчик может не получить событие, если был отключён |
| Повышенный режим | **at-least-once** через буфер в PG (outbox-таблица) — включается флагом, когда событие критично (см. ниже) |
| Идемпотентность | на стороне **подписчика**: ключ `origin+id` (где `origin` — id реплики-издателя). Механизм дедупа уже есть в портах: `DedupRepository.tryClaim` — в PG это атомарный `INSERT INTO dedup (key) VALUES ($1) ON CONFLICT (key) DO NOTHING RETURNING key` (`packages/storage-postgres/src/ports/events-journal.ts:267-286`), в core — `MemoryDedupStore`/`FileDedupStore` (`packages/core/src/engine/events/dedup-store.ts:22-34`, `packages/core/src/engine/events/dedup-store.ts:48-72`) |
| Собственное событие | издатель не доставляет событие **себе** обратно в локальную шину: локальная рассылка уже сделана; из транспорта событие с `origin = свой id` игнорируется (иначе двойная доставка в UI) |
| Порядок | в пределах одной сессии порядок сохраняется (публикация из одного процесса последовательна); **между** сессиями порядок не гарантируется — это допустимо (UI разделяет потоки по сессии) |
| Недоступность транспорта | три режима (по умолчанию — «мягкий»): (1) **fail-soft** — локальная доставка работает, межрепличная теряется, растёт счётчик потерь и метрика транспорта; (2) **буфер в PG** — критичные события пишутся в outbox и доставляются при восстановлении; (3) **fail-closed** — для событий, потеря которых означает рассинхронизацию состояния (например, `session.created` без авто-подписки владельца) — публикация поднимает ошибку вызывающего. Выбор режима — по типу события, а не глобально |
| Переподключение | транспорт переподключается с backoff; после переподключения — окно потери (at-most-once) либо докачка из буфера (at-least-once) |

### Совместимость с текущей архитектурой

- **`EventBus` остаётся интерфейсом** (ADR-009): `publish`/`publishInstance`/`subscribe`/`subscribeAll` не меняются по сигнатуре; добавляется **второй выход** — публикация в транспорт. Локальная рассылка остаётся первой и по-прежнему синхронной (ADR-009: «все подписчики этой сессии получают его независимо от того, кто инициировал действие»).
- **`EventHub`/SSE/WS (ADR-024, ADR-089) — не меняются**: managed-хаб (`packages/backend/src/events/hub.ts:27-34`), SSE `GET /api/v2/events` (`packages/backend/src/app/sse-events.ts:22-57`), standalone WS `/ws/events` (`packages/core/src/server/app/ws-events.ts:160`, `packages/core/src/server/app/ws-events.ts:238`, `packages/core/src/server/app/ws-events.ts:248`, `packages/core/src/server/app/ws-events.ts:263`) продолжают подписываться на **шину**, а не на транспорт. Транспорт — ниже по стеку, домен о нём не знает (тот же принцип, что порт хранилища в ADR-096).
- **`TransportClient` на UI — не меняется**: WS `/ws/events` + фоллбек на SSE (`packages/ui/src/lib/api/transport.ts:23`, `packages/ui/src/lib/api/transport.ts:129`, `packages/ui/src/lib/api/transport.ts:200`). Клиент не знает, сколько реплик за балансировщиком.
- **Авто-подписка по `session.created`** (инвариант 18 корневого `AGENTS.md`, общий шов `packages/core/src/events/child-session.ts`) — работает и между репликами: событие о создании сессии приходит в реплику, где живёт клиент.
- **Порядок внедрения**: (1) порт транспорта + реализация `local` (поведение не меняется); (2) feature flag `events.transport.mode` (`local` — дефолт); (3) включение `pg` на тестовом инстансе, затем на production по репликам; (4) снятие sticky-сессий.

### Промежуточная мера: sticky-сессии

Sticky-сессии (`backend.service.sessionAffinity: ClientIP` на Service backend'а) — **не решение**, а смягчение:

| Что покрывает | Что не покрывает |
|---|---|
| WS/SSE-соединение клиента остаётся на том же под'е, где произошло событие — типичный случай «ответ виден в UI» | **NAT и балансировщики**: клиент за корпоративным NAT или мобильным оператором может получить другой IP — привязка слетает |
| | **WS и prompt на разных репликах**: HTTP-запрос `POST /sessions/:id/prompt` может попасть на под B, а WS-клиент — на под A; событие `stream.*` публикуется в шине под B и до под A не доходит |
| | **События не от сессии клиента**: `pipeline.run.*` (инстансный канал), события для webhooks, авто-подписка по `session.created` — привязка по IP их не покрывает вовсе |
| | **Смена IP у клиента** (мобильная сеть, Wi-Fi → LTE) — новое соединение уходит на другой под |
| | **Watch-all клиенты** (service-key, `ADMIN`/`LEAD`) — у них нет «своей» сессии, привязка по IP не помогает |

Плюс sticky-сессии **маскируют** проблему: при их включении «теряются» только события, порождённые не той репликой, — то есть отладка в проде становится невоспроизводимой. Поэтому sticky-сессии — только до включения внешнего транспорта.

### Побочные выгоды (и что из этого НЕ решается транспортом)

| Проблема | Решается транспортом? | Чем решается |
|---|---|---|
| `stream.*`/`message.*` не доходят между репликами | **да** — это основная цель | внешний транспорт |
| `pipeline.run.*` (инстансный канал ADR-101) не видны в других репликах | **да** | внешний транспорт |
| Движок исходящих webhooks не видит события других реплик | **да** | внешний транспорт (+ идемпотентность доставки, уже есть дедуп по подписке+событию в движке) |
| Live-применение runtime-настроек — только в процессе, получившем запрос (`onEventsChange`/`onDecisionChange`, `packages/core/src/server/routes/settings.ts:1974`, `packages/core/src/server/routes/settings.ts:2014`, сборка — `packages/backend/src/app/deps.ts:1037-1061`) | **нет** | отдельный канал рассылки конфигурации (или периодический pull из общего `settings`) — **PROP-105** (координация и общее состояние) |
| Rate limit'ы per-ключевые и HTTP — in-memory на реплику (`packages/core/src/engine/events/key-rate-limiter.ts:6-10`, `packages/backend/src/middleware/rate-limiter.ts:15`) | **нет** | общий счётчик в PG/Redis — **PROP-105**; в коде это уже отмечено: «Лемитер — per-процесс …; для мульти-инстанса потребуется внешний store (K8s/PG), как и для dedup» (`packages/core/src/engine/events/key-rate-limiter.ts:6-7`) |
| `decisionMetrics` — счётчики в памяти процесса (`packages/core/src/engine/router/decision-metrics.ts:113`) | **нет** | сбор/агрегация по репликам (ADR-094 + ADR-102) — **PROP-105** |
| `HookBus` — in-process (`packages/core/src/engine/hooks/hook-bus.ts:58-59`) | **нет** | **by design** (см. «Что НЕ должно уезжать») |
| Файловые порты (FS/workspace) на общем томе | **нет** | **PROP-106** (файловые порты в SQL) |
| Лидер-выбор шедулера | уже решается | advisory-локи PG (`packages/storage-postgres/src/locks.ts:172`) |

### Наблюдаемость (контракт ADR-094)

Метрики — с префиксом `synth_`, лейблы **только** из фиксированного перечня ADR-094, `session_id`/`user_id`/id прогонов в лейблах нет (ADR-094 §5). Вид транспорта кодируется существующим лейблом `backend` (`local`|`pg`):

| Метрика | Тип | Лейблы | Смысл |
|---|---|---|---|
| `synth_event_transport_published_total` | counter | `backend`, `outcome` | публикации в транспорт (`ok`/`error`/`dropped`) |
| `synth_event_transport_received_total` | counter | `backend`, `outcome` | приём из транспорта (`ok`/`duplicate`/`filtered`/`own`) |
| `synth_event_transport_dropped_total` | counter | `backend`, `outcome` | потери: `transport_unavailable`, `payload_too_large`, `buffer_full` |
| `synth_event_transport_lag_seconds` | histogram | — | задержка доставки (от `ts` в сигнале до приёма) |
| `synth_event_transport_backlog` | gauge | — | размер буфера (при at-least-once) |
| `synth_event_transport_connected` | gauge | `backend` | 1 — транспорт подключён, 0 — нет |

Существующие счётчики событий (`synth_events_ingested_total{source,outcome}`, `synth_event_decisions_total{kind}` — `packages/core/src/metrics/collectors/events.ts:23-33`) и метрики шины (`synth_turns_total{outcome}`, `synth_active_streams` — `packages/core/src/metrics/collectors/bus.ts:42-60`) **не меняются**: транспорт добавляется к ним, а не заменяет.

Алерт-идеи: `synth_event_transport_connected == 0` дольше N минут; рост `synth_event_transport_dropped_total{outcome="transport_unavailable"}`; рост `synth_event_transport_lag_seconds` p95.

## Что уже есть

| Факт | Где |
|---|---|
| Шина событий — **in-process**: `EventBus` держит `_subscribers` (по `sessionId`) и `_globalSubscribers` в памяти процесса | `packages/core/src/events/bus.ts:22-24` |
| Публикация — синхронный обход подписчиков в памяти; исключение обработчика глушится; без подписчиков — предупреждение «EVENT LOST» | `packages/core/src/events/bus.ts:89-117` |
| Инстансный канал ADR-101 — та же шина: `publishInstance` → `INSTANCE_EVENT_CHANNEL = 'instance'` | `packages/core/src/events/bus.ts:16`, `packages/core/src/events/bus.ts:71-73` |
| SSE-хелпер шины (`sseEventStream`) — обёртка над локальной подпиской | `packages/core/src/events/bus.ts:132-169` |
| Managed-хаб `EventHub` подписывается на **локальную** шину: per-session — `eventBus.subscribe`, watch-all — `eventBus.subscribeAll` | `packages/backend/src/events/hub.ts:31-34`, `packages/backend/src/events/hub.ts:117`, `packages/backend/src/events/hub.ts:136` |
| `EventBus` и `EventHub` создаются **в одном процессе** (`new EventBus()` → `new EventHub(eventBus, …)`) — общая шина на процесс | `packages/backend/src/app/deps.ts:285`, `packages/backend/src/app/deps.ts:672` |
| Standalone-core: та же шина, отдельный инстанс `EventBus` | `packages/core/src/server/app/deps.ts:316` |
| SSE-хаб backend `GET /api/v2/events` — регистрация клиента в том же `EventHub` | `packages/backend/src/app/sse-events.ts:22-57` |
| Standalone WS `/ws/events` — подписки на тот же `EventBus` (per-session, `subscribeAll`, инстансный канал) | `packages/core/src/server/app/ws-events.ts:160`, `packages/core/src/server/app/ws-events.ts:238`, `packages/core/src/server/app/ws-events.ts:248`, `packages/core/src/server/app/ws-events.ts:263` |
| UI-клиент: `TransportClient` — WS `/ws/events` + фоллбек на SSE | `packages/ui/src/lib/api/transport.ts:23`, `packages/ui/src/lib/api/transport.ts:129`, `packages/ui/src/lib/api/transport.ts:200` |
| Лемитер API-ключей событий — **in-memory**, per-процесс; в коде прямо отмечено, что для мульти-инстанса нужен внешний store | `packages/core/src/engine/events/key-rate-limiter.ts:6-10` |
| Лемиты событий создаются per-процесс: в роутах событий и в приложении backend (service-key) | `packages/core/src/server/routes/events.ts:191`, `packages/backend/src/app.ts:270` |
| Rate limiter backend — in-memory `Map` по `Authorization`/`x-forwarded-for` | `packages/backend/src/middleware/rate-limiter.ts:15` |
| `HookBus` — in-process: `_handlers` в памяти процесса | `packages/core/src/engine/hooks/hook-bus.ts:58-59` |
| Live-применение runtime-настроек — колбэк, который срабатывает **в процессе, получившем запрос** | `packages/core/src/server/routes/settings.ts:1974`, `packages/core/src/server/routes/settings.ts:2014`, `packages/backend/src/app/deps.ts:1041-1060` |
| Метрики decision-слоя — process-wide синглтон в памяти | `packages/core/src/engine/router/decision-metrics.ts:48-54`, `packages/core/src/engine/router/decision-metrics.ts:113` |
| Дедуп в PG — атомарный claim `INSERT … ON CONFLICT (key) DO NOTHING RETURNING key` | `packages/storage-postgres/src/ports/events-journal.ts:267-286` |
| Дедуп в core — `MemoryDedupStore` (in-process `Set`) и `FileDedupStore` (файл-маркер на общем `dataDir`) | `packages/core/src/engine/events/dedup-store.ts:22-34`, `packages/core/src/engine/events/dedup-store.ts:48-72` |
| Координация в PG — session-level advisory-локи (`pg_try_advisory_lock`): `PgMutex` и `PgLeader` | `packages/storage-postgres/src/locks.ts:60-61`, `packages/storage-postgres/src/locks.ts:92`, `packages/storage-postgres/src/locks.ts:172` |
| PG-драйвер — опциональный пакет; `pg` в `optionalDependencies`; `LISTEN/NOTIFY` в репозитории **не используется** (проверено поиском по `packages/*/src`) | `packages/storage-postgres/package.json` |
| Таблицы `event_journal` и `dedup` уже есть в схеме PG (паттерн «таблица-очередь» освоен) | `packages/storage-postgres/src/migrations/001-init.ts:277-291`, `packages/storage-postgres/src/migrations/001-init.ts:305-308` |
| Redis/NATS/Kafka в коде Synth **нет** (только `redis-cli` в dev-образе как клиент; `storage.backend=redis` — fail-closed) | `packages/shared/src/config/resolve.ts:283-296` (проверено поиском по `packages/*/src`) |
| В чарте: `backend.replicaCount: 1`; sticky-сессии — опция `backend.service.sessionAffinity` (по умолчанию `None`), рендер в Service | `charts/synth/values.yaml:16`, `charts/synth/values.yaml:38-42`, `charts/synth/templates/backend-service.yaml:10-18` |
| Метрики событий по контракту ADR-094: `synth_events_ingested_total{source,outcome}`, `synth_event_decisions_total{kind}` | `packages/core/src/metrics/collectors/events.ts:23-33` |
| Метрики шины: `synth_turns_total{outcome}`, `synth_active_streams` | `packages/core/src/metrics/collectors/bus.ts:42-60` |
| Движок исходящих webhooks подписан на `eventBus.subscribeAll` — то есть на локальную шину процесса | `packages/core/src/engine/webhooks/service.ts:123` |
| Публикация событий пайплайна в инстансный канал | `packages/core/src/engine/pipelines/engine.ts:1109` |
| Гибридный мост публикует события удалённых сессий в **локальную** шину (`remote:<id>`) | `packages/core/src/remote/event-bridge.ts:227` |
| Драйвер PG — единственная точка подключения к БД; `pg` подключается лениво, `LISTEN` потребовал бы отдельного соединения | `packages/storage-postgres/src/pool.ts:44-60` |

## Дельта

1. **Порт `EventTransport`** — `publish(event): void`, `subscribe(handler): () => void`, `close(): Promise<void>`, `status(): { connected, since? }`. Образец — порты слоя хранения (ADR-096) и порт исполнения (ADR-077); контрактный suite обязателен (`packages/core/src/storage/contract/index.ts`, `packages/core/src/execution/contract/`).
2. **Реализация `InProcessEventTransport`** — обёртка над текущей шиной; поведение не меняется, используется по умолчанию.
3. **Реализация `PgNotifyEventTransport`** — `LISTEN` на выделенном соединении (`pg` уже доступен в драйвере), `NOTIFY` в publish-пути, reconnect с backoff, ограничение payload (8 КБ) с явной обработкой.
4. **Второй выход шины** — `EventBus.publish`/`publishInstance` доставляют локально **и** публикуют в транспорт; события с пометкой `localOnly` в транспорт не уходят.
5. **Формат сигнала** — `{ v, id, origin, ts, sessionId, type, payload? }`; `id` — уникальный id события, `origin` — id реплики-издателя (для дедупа и отбрасывания «своих»).
6. **Дедуп на подписчике** — по `origin+id` через существующий порт `DedupRepository` (`packages/storage-postgres/src/ports/events-journal.ts:267-286`) либо локальный кэш с TTL, если дедуп по событию не нужен.
7. **Режимы недоступности** — fail-soft (по умолчанию) / буфер в PG (at-least-once для критичных типов) / fail-closed (для событий, потеря которых означает рассинхронизацию состояния); выбор — по типу события, конфигурируемо.
8. **Секция `events.transport` в конфиге** — `mode` (`local`|`pg`), `channel`, `buffer` (включение outbox), `payloadMode` (`signal`|`full` по типам событий); env `SYNTH_EVENT_TRANSPORT_*`; **fail-closed** на неизвестном `mode` (образец — `packages/shared/src/config/resolve.ts:283-296`); применяется **при старте** процесса (транспорт — процесс-глобальный, инвариант 24).
9. **Feature flag** — `events.transport.mode = local` по умолчанию; включение `pg` по репликам (canary), затем целиком; откат — возврат к `local` + рестарт.
10. **Метрики** — `synth_event_transport_*` (см. «Наблюдаемость»), коллектор в `packages/core/src/metrics/collectors/`.
11. **Снятие sticky-сессий** — после того как транспорт покрывает доставку WS/SSE между репликами; `backend.service.sessionAffinity` остаётся в чарте как escape-hatch (по умолчанию `None`).
12. **Вне объёма этого документа** — общие rate limit'ы, live-применение runtime-настроек во всех репликах, агрегация process-local метрик (`decisionMetrics`): это **PROP-105** (координация и общее состояние); файловые порты в SQL — **PROP-106**.

## Открытые вопросы

**Закрыто (в этой редакции):**

- **Граница доставки** — уезжают события сессии, инстансный канал ADR-101, сигналы для webhooks и шлюзов; **не** уезжают локальные хуки и process-local счётчики.
- **`EventBus` остаётся интерфейсом**; `EventHub`/SSE/WS/`TransportClient` не меняются (ADR-009/ADR-024/ADR-089).
- **Sticky-сессии — промежуточная мера**, не решение; их пределы зафиксированы таблицей выше.
- **Дедуп — на стороне подписчика**, ключ `origin+id`, механизм переиспользует существующий порт дедупа.

**Открыто (нужны данные/решение владельца):**

- **Выбор транспорта.** Гипотеза — `LISTEN/NOTIFY` PG. Критерии выбора, которые нужно закрыть замером: (а) **частота и объём** межрепличного трафика (событий/сек на реплику и средний размер сигнала) — от этого зависит, переживёт ли PG канал; (б) **допустимая потеря live-события**: если «потерять `stream.chunk` = сломанный ответ в UI» недопустимо, нужен at-least-once (outbox), а он тянет задержку и свою схему; (в) **нужна ли фильтрация на стороне транспорта** (канал на сессию — много каналов, или один канал + локальная фильтрация — дёшево, но лишняя сериализация в каждой реплике); (г) **нагрузка на WAL** — если payload'ы едут целиком, они попадают в WAL и бэкапы PG (см. «Сигнал или payload»); (д) **потолок одного кластера PG** как предел масштабирования control plane.
- **Payload `stream.chunk` длиннее 8 КБ** — схлопывать, разбивать на части или передавать «сигнал + доставка по требованию»? (У PG `NOTIFY` payload по умолчанию должен быть **короче 8000 байт**.)
- **Идентификация реплики (`origin`)** — hostname+pid (сменяется при рестарте), UUID при старте (требует персистентного выделения) или id пода/контейнера? От этого зависит корректность дедупа после рестарта реплики.
- **Кто доставляет webhooks** — реплика, в которой произошло событие (тогда не нужна общая подписка), или любая реплика (тогда нужна идемпотентность доставки по подписке+событию — она уже есть в движке webhooks).
- **Порядок доставки между сессиями** — достаточно ли «внутри сессии сохраняется»? Нужен ли глобальный порядок (например, для `fs.changed`)?
- **Буфер (outbox) в PG** — если выбирается at-least-once: отдельная таблица или переиспользование `event_journal` (он про **решения роутера**, не про доставку)? Нужен ли retention и кто его чистит?
- **Транспорт в standalone-режиме** (`synth serve`) — там одна реплика; транспорт не поднимается вовсе (`mode: local`) или поднимается «на всякий случай»? Предпочтительно — не поднимать.
- **Гибрид** — публикуют ли локальные события standalone-core наружу (в удалённый backend) через тот же транспорт, или гибрид остаётся на своём SSE-мосте (`packages/core/src/remote/event-bridge.ts`)? Иначе можно получить петлю публикаций.
- **Границы доверия** — транспорт внутри кластера или между контурами? Если между — нужны TLS/аутентификация по ADR-099 и, возможно, шифрование payload'а.
- **Совместимость версий** — реплики разных версий в период раскатки: формат сигнала версионируется (`v` в сигнале), неизвестные поля игнорируются, неизвестные типы событий — отбрасываются.

## Зависимости

- **ADR-009** — SessionEventBus: интерфейс шины, который остаётся; канал `instance` (ADR-101) живёт в ней же.
- **ADR-024** — единый транспорт UI (EventHub + TransportClient): граница «домен ↔ клиент» не меняется.
- **ADR-089** — внешние события: funnel, дедуп, журнал, ключи привязок; live-применение runtime-настроек (остаётся локальным — см. PROP-105).
- **ADR-101** — пайплайны: инстансный канал `pipeline.run.*` — то, что должно пересекать границу реплики.
- **ADR-077** — порт исполнения и пул исполнителей: образец порта и контрактного suite; раздел про sticky-сессии/внешний транспорт.
- **ADR-096/ADR-097** — слой хранения и PG-драйвер: предпосылка >1 реплики (общее хранилище), образец портов; историческое предложение о PostgreSQL как втором backend хранения поглощено ADR-096/ADR-097 (документ удалён).
- **ADR-094** — контракт наблюдаемости: имена `synth_*`, фиксированный перечень лейблов, запрет `session_id`/`user_id` в лейблах.
- **ADR-099** — единый egress-слой: если транспорт выходит за пределы кластера — TLS/CA, прокси, адресная политика.
- **ADR-030** — hook-шина: остаётся in-process (осознанное исключение из границы доставки).
- **ADR-052** — webhooks и service-key: движок webhooks подписан на глобальный поток шины — выигрывает от межрепличной доставки.
- **PROP-105** — координация и общее состояние: общие rate limit'ы, live-применение настроек, агрегация process-local метрик.
- **PROP-106** — файловые порты в SQL: общий доступ к рабочему каталогу/файлам проекта между репликами.

## Связи

- [ADR-009](./adr-009-session-event-bus.md) «SessionEventBus — шина событий сессии» — интерфейс, который остаётся.
- [ADR-024](./adr-024-eventhub-transport.md) «Транспорт (EventHub + TransportClient)» — граница до клиента не меняется.
- [ADR-089](./adr-089-external-events-automation.md) «Synth как платформа внешних событий и автоматизации» — приём внешних событий, дедуп, журнал.
- [ADR-101](./adr-101-pipeline-engine.md) «Pipeline Engine» — инстансный канал `pipeline.run.*`.
- [ADR-077](./adr-077-runtime-toolchain.md) «Инструментальное окружение исполнения (toolchain и executor)» — образец порта; sticky-сессии как промежуточная мера.
- [ADR-096](./adr-096-storage-layer.md) «Единый слой хранения» и [ADR-097](./adr-097-storage-provider-class.md) «Класс расширения «хранилище»» — предпосылка и образец портов/контрактного suite.
- [ADR-094](./adr-094-observability-metrics.md) «Наблюдаемость — Prometheus-метрики, liveness/readiness» — контракт имён и лейблов.
- [ADR-099](./adr-099-egress-tls-trust.md) «Единый egress-слой» — доверие, если транспорт выходит за пределы кластера.
- [ADR-030](./adr-030-hooks-agent-events.md) «Хуки для событий агента» — локальная шина хуков, исключение из границы доставки.
- [ADR-052](./adr-052-public-api-platform.md) «Публичная API-платформа» — webhooks и service-key, получающие межрепличные события.
- [ADR-087](./adr-087-gateways.md) «Шлюзы (gateways)» и [ADR-103](./adr-103-gateway-core-channel-contract.md) «Ядро шлюзов и контракт канала» — аддоны-шлюзы как потребители межрепличных событий.
- [PROP-060](./prop-060-multi-contour-bridge.md) «Мультиконтурная архитектура (Contour Bridge)» — внешний брокер (Kafka/RabbitMQ) как vision для **межконтурного** обмена; здесь — межрепличная доставка внутри одного инстанса.
- [docs/OBSERVABILITY.md](../OBSERVABILITY.md) — каталог метрик и runbook.
- [docs/CONFIGURATION.md](../CONFIGURATION.md) — секция `events` и место новой секции `events.transport`.
- [docs/MAINTENANCE.md](../MAINTENANCE.md) — диагностика транспорта при деградации.
- [docs/TROUBLESHOOTING.md](../TROUBLESHOOTING.md) — «события не приходят в UI» (реплики, транспорт).

## Порядок реализации

| Шаг | Содержание | Зависимость от PG | Признак готовности |
|---|---|---|---|
| **1** | Порт `EventTransport` + `InProcessEventTransport` + контрактный suite; поведение не меняется | нет | контрактный suite зелёный, `events.transport.mode=local` по умолчанию |
| **2** | Секция `events.transport` в конфиге (`mode`, `channel`, `buffer`, `payloadMode`), env `SYNTH_EVENT_TRANSPORT_*`, fail-closed на неизвестном `mode`; статус транспорта в диагностике (`/health`, `/ready`) | нет | `synth serve` и backend поднимаются с обоими значениями `mode` |
| **3** | `PgNotifyEventTransport`: `LISTEN`/`NOTIFY`, reconnect с backoff, ограничение payload, отбрасывание «своих» событий по `origin` | да (ADR-097) | два процесса на одной БД видят события друг друга (интеграционный тест) |
| **4** | Миграция шины: второй выход в транспорт, `localOnly`-события, дедуп на подписчике по `origin+id` через порт дедупа | да | доставка между репликами end-to-end; локальная доставка без дублей |
| **5** | Переключение под флагом: canary-реплика → все реплики; откат — `mode=local` + рестарт | да | стресс-сценарий «клиент на реплике B, prompt на реплике A» отдаёт стрим |
| **6** | Метрики `synth_event_transport_*` + алерты + runbook (`docs/OBSERVABILITY.md`, `docs/TROUBLESHOOTING.md`) | нет | метрики видны в `/metrics`, алерт срабатывает при обрыве транспорта |
| **7** | Снятие sticky-сессий: `backend.service.sessionAffinity: None` по умолчанию, `ClientIP` — только как escape-hatch | да | при `replicaCount > 1` и `sessionAffinity: None` события доходят до клиента |
| **8** | Общие rate limit'ы, live-применение runtime-настроек во всех репликах, агрегация process-local метрик | да | вне этого документа — **PROP-105** |

Шаги 1–2 не требуют PG и идут первыми; шаги 3–5 — первый, где PostgreSQL обязателен (он и так обязателен для >1 реплики). Шаг 7 снимается **только** после подтверждения шага 5 в проде.

## История

- 2026-10-22 — создано по итогам аудита готовности Synth к `backend.replicaCount > 1`: главный блокер — in-process шина событий (`packages/core/src/events/bus.ts:22-24`, `packages/backend/src/events/hub.ts:31-34`); зафиксированы граница доставки, сравнение транспортов (рабочая гипотеза — `LISTEN/NOTIFY` PostgreSQL), семантика (at-most-once + дедуп на подписчике), sticky-сессии как промежуточная мера, план внедрения по шагам.

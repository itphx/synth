# PROP-105: Координация в нескольких репликах: сессии, очередь, общее состояние

> **Статус:** 🧩 Предложение — межпроцессная координация control plane: claim-семантика очереди, блокировки сессий, общее состояние и лимиты
> **Решение до:** 2026-11-14
> **Дата:** 2026-10-22
> **Источник:** 2026-10-22 (аудит готовности Synth к backend.replicaCount > 1)
> **Связано:** ADR-075, ADR-089, ADR-094, ADR-097, ADR-077

**Решение:** при нескольких репликах control plane (`backend.replicaCount > 1`) координация переходит из процесса в **общее хранилище**: очередь сессий получает **claim-семантику** (по образцу уже существующих в репозитории `tryClaim` дедупа и advisory-локов PostgreSQL), блокировка сессии становится **межпроцессной**, rate limit'ы и live runtime-настройки — **общими**, а process-local состояние явно классифицируется: что обязано быть общим, что законно локально. Ключевой принцип — **источник истины один** (общий storage backend, ADR-096/ADR-097), а координация строится на **уже имеющихся примитивах** (`StorageContext.locks`, `DedupRepository.tryClaim`, `pg_advisory_xact_lock`), без новых транспортных каналов (инвариант 6) и без обязательной зависимости от Redis. Общий принцип дедупа — «atomic claim возвращает `true` ровно один раз, даже между процессами» — уже зафиксирован контрактом порта (`packages/core/src/storage/ports/dedup-repository.ts:5-7`), и именно его предлагается распространить на очередь сообщений.

Предложение не меняет модель «движки stateless» (ADR-022) и не вводит распределённых транзакций: речь о mutex'ах, claim'ах и общих счётчиках.

## Что уже есть

| Факт | Где |
|---|---|
| Очередь сообщений — **поле в записи сессии** (`pendingMessages`), отдельной таблицы/порта очереди нет | `packages/core/src/sessions/manager.ts:141`, `packages/core/src/storage/ports/session-repository.ts:23-96` |
| Порт `SessionRepository` **не имеет** методов `consume`/`tryClaim`/`ack` — только `save`/`appendMessage`/`updateMessage`/`load`/`list` | `packages/core/src/storage/ports/session-repository.ts:23-96` |
| `addPendingMessage` — read-modify-write всей записи сессии (`store.save(session)` = полная замена истории) под `withLock` | `packages/core/src/sessions/manager.ts:579-593` |
| `SessionManager.withLock` — **in-process**: `Map<string, Promise<void>>` на процесс | `packages/core/src/sessions/manager.ts:91`, `packages/core/src/sessions/manager.ts:106-120` |
| Процессор очереди — **per-process** `Map` в `QueueProcessorManager`; один процессор на сессию на процесс | `packages/core/src/queue/processor.ts:579-618` (`_processors` — `:580`) |
| `enqueueUserMessage` → `addPendingMessage` → `processorManager.createProcessor(...)` — обработчик поднимает **тот** процесс, куда попал запрос | `packages/core/src/queue/processor.ts:678-726` (вызов `createProcessor` — `:723`) |
| Глубина очереди ограничена 5 сообщениями на сессию | `packages/core/src/queue/processor.ts:11` (`MAX_PENDING = 5`) |
| Обработчик берёт **голову** очереди (`pendingMessages[0]`) и в Phase 1 под `withLock` ставит `status.blocked`/`currentStream` и пушит сообщение в историю | `packages/core/src/queue/processor.ts:287`, `packages/core/src/queue/processor.ts:297-323` |
| **Дедупликация по `stream_id` уже есть**: если сообщение с тем же `stream_id` уже в истории — повторно не пушится (защита от дубля при resume) | `packages/core/src/queue/processor.ts:309-318`, `packages/core/src/server/routes/queue.ts:259-262` |
| Ручное «оживление» залипшей очереди — `POST /:sessionId/queue/resume`: снимает `blocked`, пересоздаёт процессор **в том под'е, куда попал запрос** | `packages/core/src/server/routes/queue.ts:221-280` (`forceReleaseLock` — `:244`, `createProcessor` — `:275`) |
| `cleanupStaleLocks` (снятие устаревших `blocked` по таймауту 15 мин) существует, но **фонового свипера нет** — вызывается только из теста | `packages/core/src/sessions/manager.ts:398-419` (вызовы: только `packages/core/src/sessions/manager.ts` и `packages/core/src/sessions/manager.test.ts:342`) |
| Per-session сериализация **записи** в PG — транзакционный `pg_advisory_xact_lock(hashtext(session_id)::bigint)`; покрывает только точку записи, не доменный read-modify-write | `packages/storage-postgres/src/ports/sessions.ts:682-685`, `packages/storage-postgres/src/ports/sessions.ts:366-385` |
| PG-координация публикуется через `StorageContext.locks`: `PgMutex` (session-level `pg_try_advisory_lock`) и `PgLeader` (удерживаемый advisory-лок) | `packages/storage-postgres/src/locks.ts:92-144`, `packages/storage-postgres/src/locks.ts:172-237`, `packages/storage-postgres/src/locks.ts:243-261` |
| Имена advisory-ключей namespaced-ятся префиксом `synth:` → 64-битный детерминированный хеш; ключи разных подсистем не пересекаются | `packages/storage-postgres/src/locks.ts:38-39`, `packages/storage-postgres/src/locks.ts:56-58` |
| `PgMutex.withLock` — **fail-open**: по истечении таймаута `warn` + выполнение `fn` **без** лока; при недоступной БД — ошибка наружу | `packages/storage-postgres/src/locks.ts:108-143` (fail-open — `:129-135`) |
| Контракт мьютекса — одна операция `withLock(fn)`; file-реализация `FileMutex`, PG-реализация `PgMutex` | `packages/core/src/storage/mutex.ts:26-32`, `packages/core/src/storage/storage-context.ts:148-159` |
| Дедуп внешних событий в PG — атомарный claim `INSERT INTO dedup (key) VALUES ($1) ON CONFLICT (key) DO NOTHING RETURNING key` | `packages/storage-postgres/src/ports/events-journal.ts:272-285`, `packages/storage-postgres/src/ports/events-journal.ts:305-308` (DDL `dedup`) |
| Контракт дедупа: «два конкурентных `tryClaim` с одним ключом возвращают `true` ровно один раз (даже между процессами)» | `packages/core/src/storage/ports/dedup-repository.ts:1-15` |
| Файловый claim — `open(path, 'wx')`, `EEXIST` → `false`, прочие ошибки → fail-open (`true`) | `packages/core/src/engine/events/dedup-store.ts:48-72` |
| Прецедент условного upsert в PG — `INSERT … ON CONFLICT (…) DO UPDATE` (роллапы аналитики) | `packages/storage-postgres/src/ports/analytics.ts:196-198`, `packages/storage-postgres/src/ports/analytics.ts:225-227` |
| `pending_messages` в PG — **одна jsonb-колонка** (`jsonb NOT NULL DEFAULT '[]'`), не отдельные строки | `packages/storage-postgres/src/migrations/001-init.ts:40` |
| Миграции схемы — под advisory-локом `synth:migrate:<schema>` | `packages/storage-postgres/src/migrate.ts:134` |
| Лидер шедулера по умолчанию — `AlwaysLeader` (`leaderElection: 'none'`), т.е. **каждый процесс считает себя лидером**; `FileLeader` годится только на общем FS | `packages/shared/src/config/defaults.ts:176`, `packages/core/src/engine/scheduler/leader.ts:19-25`, `packages/core/src/engine/scheduler/leader.ts:40-62` |
| `scheduler.leaderElection: postgres` подключает `PgLeader`; без `storage.backend=postgres` — предупреждение и откат на `AlwaysLeader` | `packages/core/src/server/app/deps.ts:922-948`, `packages/backend/src/app/deps.ts:883-909` |
| `scheduler.crossProcessLocks` — default `false`; под PG неактуален (записи `schedules` — атомарные SQL-мутации) | `packages/shared/src/config/defaults.ts:177`, `docs/CONFIGURATION.md:1254` |
| Rate limit событийного API-ключа — **in-memory** fixed-window 60 с; в шапке модуля прямо сказано: «пер-процесс (single-instance приём событий); для мульти-инстанса потребуется внешний store (K8s/PG)» | `packages/core/src/engine/events/key-rate-limiter.ts:1-30` |
| Rate limit service-key — тот же `KeyRateLimiter`, in-memory | `packages/backend/src/app.ts:268-276` |
| HTTP rate limit backend — **in-memory** `Map` + `setInterval` на очистку; ключ — `Authorization`/`x-forwarded-for` | `packages/backend/src/middleware/rate-limiter.ts:10-47` |
| Live runtime-настройки: **значение** живёт в общем сторе, **колбэк** — per-process (`onEventsChange`/`onDecisionChange` вызываются только в том процессе, где пришёл `PUT /settings/*`) | `packages/core/src/server/routes/settings.ts:345-349`, `packages/core/src/server/routes/settings.ts:1974`, `packages/core/src/server/routes/settings.ts:2014` |
| Managed-разборка live-настроек — `live.setEvents(effective)`/`live.setDecision(effective)`, т.е. процесс-локальный аксессор | `packages/backend/src/app/mount-routes.ts:802-811`; standalone — `packages/core/src/server/app/mount-routes.ts:441-463` |
| Decision-метрики — **process-wide синглтон** в памяти (`calls`/`handled`/`fallback`/`escalated`) | `packages/core/src/engine/router/decision-metrics.ts:48-113` (синглтон — `:113`) |
| Кэш URL-инструкций — `{dataDir}/instructions-cache/<hash>` (на PVC реплики — свой) | `packages/core/src/engine/context/instructions.ts:11`, `packages/core/src/engine/context/instructions.ts:181`, `packages/core/src/engine/context/instructions.ts:1085` |
| Кэш discovery скиллов — in-memory `Map` подписей каталогов (`mtime`/`size`), ленивая инвалидация | `packages/core/src/engine/skills/watcher.ts:14-49` |
| `HookBus` — **in-process** шина хуков (ядровый примитив, не распределённая) | `packages/core/src/engine/hooks/hook-bus.ts:49`, `packages/core/src/engine/hooks/hook-bus.ts:58` |
| Реестр агентов — общее значение (стор) + per-process реестр: `registerStoredAgents` подтягивает агентов из стора при старте | `packages/core/src/engine/agents/index.ts:135` |
| Метрики очереди: `synth_queue_pending` (сумма `pendingMessages`, фон 15 с), `synth_sessions_active` | `packages/core/src/metrics/collectors/sessions.ts:26-32`, `docs/OBSERVABILITY.md:172-173` |
| Чарт: `backend.replicaCount: 1` с комментарием «Хранилище JSON-файлы → НЕ масштабируется, всегда 1 реплика»; sticky-сессии описаны как «шина событий in-process» | `charts/synth/values.yaml:11`, `charts/synth/values.yaml:16`, `charts/synth/values.yaml:38-42` |
| В `session_id`/`user_id` в лейблах метрик запрещено (контракт ADR-094) | `AGENTS.md` (инвариант 25), `docs/OBSERVABILITY.md` §«Кардинальность» |

## Классификация состояния

Правило: **значение, влияющее на результат для пользователя, — общее; кэш, ускоряющий чтение, — локальный; счётчик процесса — локальный** (суммируется на скрейпе).

| Состояние | Где живёт сейчас | Обязано ли быть общим | Чем обеспечивается (предлагается) |
|---|---|---|---|
| Очередь сообщений `pendingMessages` | jsonb-колонка записи сессии (`packages/storage-postgres/src/migrations/001-init.ts:40`), запись — `packages/core/src/sessions/manager.ts:579-593` | **да** | claim-таблица (см. «Claim-семантика очереди») + advisory-лок сессии |
| Право обработки сообщения | **нет** (обработчик = «кто встал первым в под'е») | **да** | `queue_claims` — атомарный claim, TTL + продление |
| Флаг «сессия занята» (`status.blocked`/`blockedAt`) | запись сессии (общее значение) | **да** | общий флаг + TTL-резюм (не полагаться на один под) |
| Доменная блокировка сессии (`SessionManager.withLock`) | in-process `Map` (`packages/core/src/sessions/manager.ts:91`) | **да** | `StorageContext.locks.createMutex({name:'session/<id>'})` → `PgMutex`; нужен **fail-closed**-вариант |
| Сериализация записи в БД | `pg_advisory_xact_lock` (`packages/storage-postgres/src/ports/sessions.ts:682-685`) | уже да | менять не нужно — она про точку записи, а не про RMW |
| Rate limit событийного ключа | in-memory (`packages/core/src/engine/events/key-rate-limiter.ts:9-30`) | **да** | общий счётчик окна в PG (шаг 6) |
| Rate limit service-key | in-memory (`packages/backend/src/app.ts:268-276`) | **да** | тот же общий счётчик |
| HTTP rate limit backend | in-memory (`packages/backend/src/middleware/rate-limiter.ts:10-47`) | **да** | тот же общий счётчик |
| Значение live runtime-настроек | общий стор (`settings`/PG) | **да** (уже) | без изменений; проблема — только в доставке |
| Доставка live-настроек в реплики | per-process колбэк (`packages/backend/src/app/mount-routes.ts:802-811`) | **да** | push-канал (PROP-104) + фоллбэк «перечитывать геттером» |
| Decision-метрики | in-memory синглтон (`packages/core/src/engine/router/decision-metrics.ts:113`) | **нет** | локально; сумма по репликам на скрейпе |
| Кэш URL-инструкций | `{dataDir}/instructions-cache` (`packages/core/src/engine/context/instructions.ts:1085`) | **нет** | локальный кэш с TTL; расхождение с источником безопасно |
| Кэш discovery скиллов | in-memory подписи (`packages/core/src/engine/skills/watcher.ts:14-49`) | **нет** | локально; инвалидация по подписи `mtime/size` |
| `HookBus` | in-process (`packages/core/src/engine/hooks/hook-bus.ts:49-58`) | **нет** | локально by design (ADR-030 — ядровый примитив) |
| Лидер шедулера | `AlwaysLeader` по умолчанию (`packages/shared/src/config/defaults.ts:176`) | **да** (ровно один тикер) | `scheduler.leaderElection: postgres` → `PgLeader` — **одна строка конфига** |
| Дедуп внешних событий | `PgDedupRepository.tryClaim` (`packages/storage-postgres/src/ports/events-journal.ts:279-285`) | уже да | готово; **образец** для очереди |
| Реестр агентов | общее значение + per-process реестр (`packages/core/src/engine/agents/index.ts:135`) | значение — да | готово; per-process кэш безопасен |
| Миграции схемы | advisory-лок `synth:migrate:<schema>` (`packages/storage-postgres/src/migrate.ts:134`) | уже да | готово |
| Шина событий и подписки клиентов | in-process на реплику | **нет** (доставка — да) | sticky-сессии (`charts/synth/values.yaml:38-42`) + PROP-104 |

## Claim-семантика очереди

**Проблема.** Очередь — это список в общей записи сессии, а «кто её разбирает» — состояние процесса. Отсюда два разных отказа при нескольких репликах:

- **(а) «Залипание».** Реплика A подняла процессор и упала. `pendingMessages` остались в БД; у реплики B процессора для этой сессии нет (`createProcessor` вызывается только на пути enqueue/resume — `packages/core/src/queue/processor.ts:723`, `packages/core/src/server/routes/queue.ts:275`). Сообщение ждёт ручного `POST /:sessionId/queue/resume`; этот запрос **создаёт процессор в том под'е, куда попал** (`packages/core/src/server/routes/queue.ts:275`), то есть разбор требует ручного вмешательства и привязан к конкретному под'у — сам по себе он «лечит» сессию, но только если запрос дойдёт до любой живой реплики, а гарантии, что зависшая сессия вообще получит запрос, нет.
- **(б) «Дубль/потеря».** `addPendingMessage` — read-modify-write всей записи сессии (`packages/core/src/sessions/manager.ts:579-593`) под in-process локом (`packages/core/src/sessions/manager.ts:106-120`). Между репликами лок не действует: две одновременные постановки перетирают друг друга (потеря), а два обработчика одной головы — двойной ход.

**Предлагаемый механизм — claim-таблица, по образцу `dedup`.** Новая таблица (миграция `006`, рядом с `dedup` — `packages/storage-postgres/src/migrations/001-init.ts:305-308`):

```sql
CREATE TABLE queue_claims (
  session_id text NOT NULL,
  message_id text NOT NULL,
  owner      text NOT NULL,      -- id реплики-владельца
  claimed_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (session_id, message_id)
);
```

Claim — **условный upsert** (тот же класс SQL, что уже применён в роллапах аналитики, `packages/storage-postgres/src/ports/analytics.ts:196-198`): строка вставлена/перебита, только если прежний claim **протух**:

```sql
INSERT INTO queue_claims (session_id, message_id, owner, expires_at)
VALUES ($1, $2, $3, now() + $4::interval)
ON CONFLICT (session_id, message_id) DO UPDATE
  SET owner = EXCLUDED.owner, claimed_at = now(), expires_at = EXCLUDED.expires_at
  WHERE queue_claims.expires_at < now()
RETURNING message_id;
```

`RETURNING` пуст → claim занят живым владельцем → **не обрабатывать**. Порт расширяется двумя методами (по образцу `DedupRepository.tryClaim`, `packages/core/src/storage/ports/dedup-repository.ts:10-15`):

- `claimPendingMessage(sessionId, messageId, owner, ttlMs) → boolean` — атомарный захват;
- `renewPendingMessage(sessionId, messageId, owner, ttlMs) → boolean` — продление во время длинного хода (`UPDATE … WHERE owner = $owner`).

**Что происходит при падении реплики, державшей сообщение.** Claim протухает по TTL (`expires_at`), и любая реплика может его перебить условным upsert'ом — то есть **протухание само заменяет ручной resume**: отдельного «механизма возобновления» не требуется, достаточно фонового сборщика, который ищет протухшие claims и поднимает обработчик (по образцу `startEventJournalPruner`/`startEphemeralSweeper` — периодический таймер с `unref`).

**Как не допустить двойной обработки.**

1. **Claim** — ровно один выигрывает (атомарность БД).
2. **Продление** — `renew` во время хода; TTL заведомо больше типичного хода, но не бесконечен.
3. **Идемпотентность записи в историю** — уже есть: Phase 1 не пушит сообщение повторно, если `metadata.stream_id` уже встречается в `s.messages` (`packages/core/src/queue/processor.ts:309-318`). Значит перезабор протухшего claim'а **не** даст второго user-сообщения в истории. Это готовая дедупликация, её надо лишь сохранить при переносе очереди.
4. **Идемпотентность терминальной записи хода** — открытый вопрос (см. «Открытые вопросы»): `appendMessage`/`updateMessage` точечны, но **не** идемпотентны по `stream_id`; если падение произошло уже после старта LLM, повторный обработчик может дописать второй assistant-ответ.

**Почему не «лидер-лок на сессию».** Advisory-лок на `sessionId` (`PgMutex`) защищает от двух реплик, но **не даёт прогресса**: пока живой реплика держит лок, сообщение лежит; после её падения лок снимается (session-level лок держится соединением — `packages/storage-postgres/src/locks.ts:14-17`), и следующая реплика подхватит. Это рабочий вариант, но он **блокирующий** и плохо переносится на file-backend. Claim-семантика лучше: она (1) не требует удерживать соединение, (2) имеет естественный TTL, (3) переносится на файловый backend по образцу `FileDedupStore` (`packages/core/src/engine/events/dedup-store.ts:60-72`), (4) даёт наблюдаемый счётчик «кто держал/перебил claim».

**Совместимость с file-backend.** `FileDedupStore` уже даёт межпроцессный claim на общем FS. Для файлового хранилища claim-таблица может быть файловыми маркерами (`{dataDir}/queue/claims/<hash>`) — но file-backend по определению single-replica (`charts/synth/values.yaml:11`), поэтому файловая реализация claim'а — **опциональна** и нужна только для нескольких процессов на одном хосте (например, `synth serve` + CLI).

## Межпроцессная блокировка сессии

Три варианта:

| Вариант | Механика | Плюсы | Минусы |
|---|---|---|---|
| **A. Advisory-лок в PG на `sessionId`** | `StorageContext.locks.createMutex({ name: 'session/<id>' })` → `PgMutex` (`packages/storage-postgres/src/locks.ts:92-144`) | инфраструктура уже есть; переиспользует namespaced-ключи `synth:`; работает между хостами | `PgMutex.withLock` — **fail-open** по таймауту (`packages/storage-postgres/src/locks.ts:129-135`): для критичного RMW это неприемлемо — нужен fail-closed-режим; удерживает соединение пула (риск `poolMax`) |
| **B. Claim-колонка в БД** | колонка в записи сессии (`claimed_by`/`claimed_at`) + условный `UPDATE … WHERE` | не держит соединение; TTL в той же строке; атомарно | правка `sessions` = горячая строка; логика «кто держит» смешивается с данными сессии; нужен ещё и advisory-лок для RMW |
| **C. Optimistic locking по версии сессии** | счётчик `version` + `UPDATE … WHERE version = $expected`; при конфликте — повтор | нет блокировок; соединение пула не удерживается; естественно для оптимистичного домена | требует переписывания всех read-modify-write (сейчас их десятки через `withLock` → `store.save`); конфликты при активной сессии часты → ретраи |

**Предлагается: A как основа + B как дополнение, C — отложено.** Обоснование: A — минимальная дельта (инфраструктура `StorageLocks` уже в `StorageContext`, ADR-097), а fail-open поведение `PgMutex` нужно сделать **настраиваемым** (`failOpen: false` для критичных участков) — это изменение одного класса, не архитектуры. B (claim-таблица) нужна отдельно для очереди (§ «Claim-семантика очереди»), потому что там нужен TTL и владелец, а не взаимное исключение. C не выбирается: переписывание всех `withLock`-участков домена — большой риск при неопределённой выгоде; остаётся открытым вопросом на случай, если fail-closed-лок окажется дорогим.

**Правило совместимости.** `SessionManager.withLock` остаётся тем же швом для домена; меняется только реализация: `file`/`memory` — нынешний `Map` (поведение прежнее), `postgres` — `StorageContext.locks.createMutex`. Тогда файловый/однорепличный сценарий не меняется вообще, а multi-replica включается backend'ом хранилища.

## Общие лимиты и live-настройки

**Где хранить счётчики rate limit'ов.** Предпочтение — **таблица в том же PG** (без новой инфраструктуры), по образцу `dedup`:

```sql
CREATE TABLE rate_limit_windows (
  scope      text NOT NULL,     -- 'event_key' | 'service_key' | 'http'
  key_hash   text NOT NULL,     -- sha256 от идентификатора (не сырой ключ)
  window_start timestamptz NOT NULL,
  count      int NOT NULL,
  PRIMARY KEY (scope, key_hash, window_start)
);
```

Инкремент атомарен: `INSERT … ON CONFLICT (scope, key_hash, window_start) DO UPDATE SET count = rate_limit_windows.count + 1`; решение «пропустить» — по текущему значению `count` в той же транзакции (`RETURNING count`). Окно — 60 с, как сейчас (`packages/core/src/engine/events/key-rate-limiter.ts:12`). Альтернатива — Redis: **не предлагается** как обязательная (новый обязательный компонент в развёртывании), но допускается как внешний `RateLimitStore`, если оператору нужен общий лимит между разными инстансами (не репликами одного инстанса).

**Эффективный лимит.** Сегодня фактический лимит = `N × заданный` (N реплик × in-memory окно на реплику). С общим счётчиком лимит становится **ровно заданным** для инстанса. Это изменение наблюдаемого поведения — его надо зафиксировать в `docs/API_V2.md`/рунибуке.

**Доставка live-настроек во все реплики.** Значение уже общее (`settings` в общем сторе), но *применение* — per-process (`packages/backend/src/app/mount-routes.ts:802-811`). Два уровня решения:

1. **Минимальный (без нового транспорта):** читать эффективное значение **геттером** из общего стора на каждый use, а не из process-local аксессора. Сейчас `createExternalIdentityResolver` уже умеет «читать актуальное значение» через геттер (`packages/backend/AGENTS.md`, раздел «Транспорт событий») — это готовый образец. Цена — поход в БД на каждое использование (с кэшем + TTL).
2. **Полный:** push-уведомление о смене настройки во все реплики — это **PROP-104** («Внешний транспорт событий: публикация между репликами control plane»); здесь только фиксируем пересечение: общие лимиты и live-настройки едут на нём.

**Что не делаем.** Не вводим отдельный канал конфигурации «поверх» шины событий (инвариант 6: транспорт UI — EventHub + TransportClient, новых каналов не плодить) и не полагаемся на WS-подписку как на обязательный канал доставки (WS-соединение клиента и реплики могут различаться).

## Что остаётся локальным by design

Локальным остаётся всё, что **не влияет на результат** и может быть восстановлено:

- **Кэш URL-инструкций** (`{dataDir}/instructions-cache`, `packages/core/src/engine/context/instructions.ts:1085`) — на каждой реплике свой; расхождение с источником безопасно (следующий запрос с обновлённым TTL перечитает).
- **Кэш discovery скиллов** (`packages/core/src/engine/skills/watcher.ts:14-49`) — инвалидация по подписи `mtime/size`; на реплике без общего PVC подпись всегда «старая» → пересканирование (безопасно, дороже).
- **Decision-метрики** (`packages/core/src/engine/router/decision-metrics.ts:113`) — счётчики процесса; Prometheus складывает series реплик.
- **`HookBus`** (`packages/core/src/engine/hooks/hook-bus.ts:49-58`) — ядровый in-process примитив (ADR-030); распределённость хуков — отдельная задача (Plugin SDK, PROP-090).
- **Per-process реестр агентов** — значение общее, кэш локальный (`packages/core/src/engine/agents/index.ts:135`).
- **Кольцевой буфер стрима** (`packages/core/src/queue/processor.ts:36`, `:562-573`) — буфер последних чанков для переподключения; локальный по определению.
- **Счётчики HTTP-метрик** процесса (`synth_process_*`) — ADR-094.

**Правило, которое предлагается зафиксировать:** *локальный кэш обязан быть безопасен при расхождении с источником истины* — то есть (1) иметь TTL/версию, по которой видно, что данные устарели; (2) не быть единственным носителем невоспроизводимого состояния; (3) при расхождении **источник истины выигрывает** (кеш перечитывается, а не «мирит» с хранилищем). Для существующих кэшей это выполняется: инструкции — TTL-кэш URL'ов, скиллы — подпись `mtime/size`.

## Наблюдаемость

По контракту ADR-094: имена `synth_*`, лейблы — из конечных множеств, `session_id`/`user_id`/сырые пути **запрещены**. Нужно заметить три явления:

| Явление | Метрика (предлагается) | Лейблы |
|---|---|---|
| Сообщение «залипло» (claim протух, никто не забрал) | `synth_queue_stuck_messages` (gauge) | — |
| Claim взят / занят / перебит по TTL / дубль | `synth_queue_claims_total` (counter) | `outcome` (`claimed`/`busy`/`expired`/`duplicate`) |
| Время удержания claim | `synth_queue_claim_seconds` (histogram) | — |
| Ручное/автоматическое оживление очереди | `synth_queue_resumes_total` (counter) | `reason` (`manual`/`ttl`/`startup`) |
| Двойная обработка (второй claim того же сообщения) | `synth_queue_duplicate_processing_total` (counter) | — |
| Advisory-локи: захват/таймаут/ошибка | `synth_coordination_locks_total` (counter) | `kind` (`session`/`scheduler`/`migrations`), `outcome` (`acquired`/`timeout`/`error`) |
| Кто лидер шедулера | `synth_coordination_leader_info` (gauge) | `component` (`scheduler`) — значение 1 у лидера, 0 у остальных |
| Rate limit сработал | `synth_ratelimit_hits_total` (counter) | `scope` (`event_key`/`service_key`/`http`) |
| Эффективный (общий) лимит | `synth_ratelimit_limit` (gauge) | `scope` |

Существующая `synth_queue_pending` (`packages/core/src/metrics/collectors/sessions.ts:29-32`) остаётся и показывает **сумму** `pendingMessages`; в multi-replica это сумма по всем сессиям — интерпретировать надо вместе с `synth_queue_stuck_messages` (в норме pending ≈ stuck ≈ 0).

**Алерт-минимум** (в стиле `docs/OBSERVABILITY.md` §«Алерты и SLO-минимум»): `synth_queue_stuck_messages > 0` дольше 5 минут — warning (очередь не разбирается ни одной репликой); рост `synth_queue_duplicate_processing_total` — warning (двойная обработка = рассинхронизация claim'ов).

## Дельта

1. **Claim-семантика очереди** — новый порт (расширение `SessionRepository` или отдельный `QueueClaimRepository` в `packages/core/src/storage/ports/`): `claim`/`renew`/`release` + контрактный suite (обязателен для любой реализации — ADR-096).
2. **Реализация claim в PG** — таблица `queue_claims` (миграция `006`) + порт драйвера; по образцу `PgDedupRepository.tryClaim` (`packages/storage-postgres/src/ports/events-journal.ts:272-285`) и условного upsert роллапов (`packages/storage-postgres/src/ports/analytics.ts:196-198`).
3. **Файловая реализация claim** — по образцу `FileDedupStore` (`packages/core/src/engine/events/dedup-store.ts:60-72`); нужна для нескольких процессов на одном хосте, не для multi-replica.
4. **Межпроцессная блокировка сессии** — `SessionManager.withLock` переводится на `StorageContext.locks.createMutex` (PG) / `FileMutex` (file); для PG нужен **fail-closed**-режим вместо текущего fail-open (`packages/storage-postgres/src/locks.ts:129-135`) — как настраиваемая опция `MutexFactoryOptions`/`LockOptions`.
5. **Общие rate limit'ы** — порт `RateLimitStore` (`check(scope, key, limit)`) + реализация в PG (таблица `rate_limit_windows`) и файловая (в-memory — file-backend, single-replica); подключить в трёх местах: событийный ключ (`packages/core/src/engine/events/key-rate-limiter.ts`), service-key (`packages/backend/src/app.ts:268-276`), HTTP (`packages/backend/src/middleware/rate-limiter.ts`).
6. **Доставка live-настроек** — чтение эффективного значения геттером из общего стора (минимальный вариант) + push через **PROP-104** (полный).
7. **TTL-резюм очереди** — фоновый сборщик протухших claim'ов (по образцу `startEventJournalPruner`/`startEphemeralSweeper`), поднимающий обработчик; это заменяет ручной `POST /:sessionId/queue/resume` как основной путь.
8. **Наблюдаемость** — коллектор `synth_queue_*`/`synth_coordination_*`/`synth_ratelimit_*` (ADR-094) + алерты в `docs/OBSERVABILITY.md`.
9. **Идемпотентность терминальной записи хода** — защита от второго assistant-ответа после перезабора протухшего claim'а (см. «Открытые вопросы»).
10. **Чарт и конфиг** — документировать `backend.replicaCount > 1` как допустимое значение **только** при `storage.backend=postgres` + `scheduler.leaderElection=postgres`; sticky-сессии (`service.sessionAffinity`) — обязательны, пока шина событий in-process.
11. **Runbook** — раздел в `docs/MAINTENANCE.md` (диагностика «залипшей» очереди и «двойной обработки») и в `docs/CONFIGURATION.md` (новые секции/ключи).

## Открытые вопросы

- **Идемпотентность терминальной записи хода.** Если реплика упала уже после старта LLM, перезабор протухшего claim'а запустит ход заново. Защита от второго assistant-сообщения: (а) хранить терминальный результат хода по `stream_id` и переиспользовать его при перезаборе (нужна новая таблица/колонка «результаты ходов»); (б) считать, что падение внутри хода — редкий случай и ограничиться идемпотентностью user-сообщения (она уже есть). Требует решения владельца: (а) дороже, но корректно.
- **TTL по умолчанию и его верхняя граница.** Claim должен пережить падение реплики, но не блокировать очередь слишком долго. Значение зависит от типичной длины хода (LLM + tool-цикл) и должно быть **продлеваемым** (`renew`); конкретное значение и поведение при отсутствии `renew` — к решению.
- **Fail-open или fail-closed для `PgMutex` в домене.** Текущий `PgMutex` по таймауту выполняет функцию **без лока** (`packages/storage-postgres/src/locks.ts:129-135`) — это паритет с `FileMutex` и осознанный компромисс «доступность важнее сериализации». Для read-modify-write сессии это риск потери/дубля. Нужен ли режим fail-closed (или ретрай с ошибкой) для критичных участков — и как он сочетается с «деградация хранилища» (ADR-098).
- **Где живут общие rate limit'ы.** Таблица в PG (предложение) или внешний store (Redis)? Для реплик одного инстанса достаточно PG; для нескольких инстансов нужен внешний store. Отдельно решить, показывается ли пользователю «эффективный лимит инстанса» (сегодня — N × заданный).
- **Кто владелец claim'а.** Идентификатор реплики (`hostname/pid/uuid`) — простой, но при переезде пода тот же hostname может получить старый claim (лечится TTL). Нужен ли устойчивый id инстанса в конфиге.
- **Порядок обработки очереди при нескольких репликах.** FIFO по `pendingMessages` сохраняется (claim на конкретное сообщение), но «кто заберёт следующее» — гонка. Достаточно ли «кто первый», или нужен явный порядок выдачи (монотонный курсор по `seq`).
- **Поведение при `storage.backend=file` и `replicaCount > 1`.** Сейчас это запрещено комментарием в чарте (`charts/synth/values.yaml:11`). Оставляем запрет (fail-closed при старте) или предупреждаем и продолжаем?
- **Дедуп внешних событий на file-backend.** Под PG дедуп атомарен (`PgDedupRepository`), под file — `MemoryDedupStore` по умолчанию (`packages/core/src/storage/storage-context.ts:532`), то есть между процессами не работает. Для single-replica это нормально; нужно ли явно закрепить это правило в документации.

## Зависимости

- **ADR-097** — предпосылка: без `storage.backend=postgres` (общего хранилища) нескольких реплик быть не может; здесь — межпроцессная координация поверх него.
- **ADR-096** — образец портов и контрактного suite: новый порт claim'ов и общих лимитов обязан иметь контрактный suite и memory-реализацию.
- **ADR-089** — внешние события, dedup-семантика, live-настройки раздела «События» (`onEventsChange` — точка live-применения).
- **ADR-094** — контракт наблюдаемости: имена `synth_*`, запрет `session_id` в лейблах, каталог метрик.
- **ADR-075** — workspace проекта: на multi-replica рабочий каталог должен быть общим (иначе правки файлов из разных реплик не сойдутся) — это отдельное требование к развёртыванию, здесь только отмечается.
- **ADR-077** — исполнение команд: `execution.mode=remote` отделяет control plane от исполнителей, но **не** решает координацию control plane между собой.
- **ADR-051** — шедулер и лидерство: `PgLeader` — готовый образец «ровно один владелец».
- **ADR-023** — приоритет конфигурации (`CLI > env > config.yaml > defaults`) для новых ключей координации.
- **ADR-052** — service-key: per-key rate limit (`rateLimitPerMinute`) — один из переносимых на общий счётчик лимитов.
- **ADR-098** — деградированный режим хранилища: в деградации (файловый read-only фоллбек) координация не работает — фоновые писатели отключаются, чтобы не было split-brain.

## Связи

- [ADR-075](./adr-075-project-workspace-provisioning.md) «Окружение проекта: рабочий каталог (создание и выбор)» — общий workspace как условие multi-replica.
- [ADR-089](./adr-089-external-events-automation.md) «Synth как платформа внешних событий и автоматизации» — dedup-claim, live-настройки событий, ключи привязок.
- [ADR-094](./adr-094-observability-metrics.md) «Наблюдаемость — Prometheus-метрики, liveness/readiness и эксплуатационные алерты» — контракт имён метрик и кардинальности.
- [ADR-097](./adr-097-storage-provider-class.md) «Класс расширения «хранилище» (storage)» — `StorageContext.locks`, `PgMutex`/`PgLeader`, порты драйвера.
- [ADR-077](./adr-077-runtime-toolchain.md) «Инструментальное окружение исполнения (toolchain и executor)» — разделение control plane и исполнителей (не заменяет координацию реплик).
- [ADR-051](./adr-051-scheduler-pipelines.md) «Шедулер и пайплайны» — лидерство тикера, `PgLeader`.
- [ADR-096](./adr-096-storage-layer.md) «Единый слой хранения — доменные порты с взаимозаменяемыми backend'ами» — порты и контрактный suite.
- Историческое предложение о PostgreSQL как втором backend хранения (документ удалён, поглощён ADR-096/ADR-097/ADR-098) — его волны дали `PgMutex`/`PgLeader` и дедуп-claim, на которых стоит это предложение.
- [PROP-104](./prop-104-external-event-transport.md) «Внешний транспорт событий: публикация между репликами control plane» — общие rate limit'ы и доставка live-настроек в реплики едут на нём; здесь только фиксируется пересечение.
- [PROP-106](./prop-106-file-ports-to-sql.md) «Файловые порты инстанса в SQL: единое состояние при нескольких репликах» — если FS/package-bound порты (`skills`/`contextFiles`/`blobs`, `packages/storage-postgres/AGENTS.md`) переезжают в SQL, часть «process-local» кэшей (инструкции, discovery) получает общий источник истины — уточнить границу.
- [docs/OBSERVABILITY.md](../OBSERVABILITY.md) — каталог метрик и алерты.
- [docs/CONFIGURATION.md](../CONFIGURATION.md) — `scheduler.leaderElection`, `events.dedupStore`, `storage.backend`.
- [docs/MAINTENANCE.md](../MAINTENANCE.md) — runbook обслуживания (место для диагностики очереди).

## Порядок реализации

Нумерация — от дешёвого к дорогому; каждый шаг самодостаточен и обратим.

| Шаг | Содержание | Стоимость | Претензия |
|---|---|---|---|
| **1** | **Конфиг**: `storage.backend: postgres` + `scheduler.leaderElection: postgres` — ровно один тикер шедулера во всём инстансе; вторая реплика не дублирует cron-события. Предупреждение «без advisory-локов → AlwaysLeader» уже есть (`packages/core/src/server/app/deps.ts:924-929`) | **1 строка конфига** | минимальная, проверяется сразу |
| **2** | **Документация ограничения**: в чарте и `docs/CONFIGURATION.md` зафиксировать, что `backend.replicaCount > 1` допустим только при `storage.backend=postgres`; sticky-сессии обязательны (шина событий in-process, `charts/synth/values.yaml:38-42`) | документация | снимает риск «подняли 2 реплики и сломали» |
| **3** | **Наблюдаемость (до изменений)**: `synth_queue_claims_total`, `synth_queue_stuck_messages`, `synth_coordination_locks_total`, `synth_ratelimit_hits_total` — чтобы зафиксировать текущее (нулевое) поведение и иметь базу сравнения | средняя | даёт baseline до семантических изменений |
| **4** | **Общие rate limit'ы** — порт `RateLimitStore` + реализация PG + подключение в трёх местах (событийный ключ, service-key, HTTP) | средняя | эффект виден сразу: лимит перестаёт умножаться на N |
| **5** | **Межпроцессная блокировка сессии** — `withLock` через `StorageContext.locks`; fail-closed-режим для критичных участков | средняя–большая | убирает потерю/дубль при `addPendingMessage` и других RMW |
| **6** | **Claim-семантика очереди** — порт + контрактный suite + реализация PG (таблица `queue_claims`) + файловая реализация + перенос обработчика на claim | **большая** | главный блокер multi-replica |
| **7** | **TTL-резюм очереди** — фоновый сборщик протухших claim'ов; ручной `POST /:sessionId/queue/resume` остаётся как ручной инструмент | средняя (после 6) | убирает «залипание» без ручного вмешательства |
| **8** | **Идемпотентность терминальной записи хода** — результат хода по `stream_id` (решение открытого вопроса) | большая | закрывает последний сценарий двойной обработки |
| **9** | **Доставка live-настроек** — минимальный вариант (геттер из общего стора) + полный через PROP-104 | средняя | зависит от PROP-104 для полноты |
| **10** | **Runbook и алерты** — `docs/MAINTENANCE.md` (диагностика очереди), `docs/OBSERVABILITY.md` (метрики и алерты), `docs/CONFIGURATION.md` (новые ключи) | документация | замыкает эксплуатацию |

Шаги **1–4** не требуют изменений в очереди и дают основную часть эффекта (нет дублей cron'а, лимиты общие, наблюдаемость есть). Шаги **5–8** — блокеры «честного» multi-replica: без них при двух репликах возможны потеря/дубль сообщения и «залипание» очереди.

## История

- 2026-10-22 — создано по итогам аудита готовности Synth к `backend.replicaCount > 1`: классификация состояния, claim-семантика очереди, межпроцессная блокировка сессии, общие лимиты и live-настройки, локальное by design, порядок внедрения.

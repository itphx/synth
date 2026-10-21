# ADR-051: Шедулер и пайплайны (облегчённый n8n)

> **Статус:** ⚠️ Частично — реализованы минимальный срез (cron/interval-источник `schedule_fired` через ADR-089, идентичность сообщений `Scheduler`), Job-история (`JobStore`), catch-up (`skip`/`once`), force-запуск (rate limit) и мульти-инстанс (`events.dedupStore`, `scheduler.leaderElection` — `none`/`file`/`postgres`, `scheduler.crossProcessLocks`; default OFF), в т.ч. PG advisory-lock лидер-выбор (PROP-032); **пайплайны реализованы как декларация + учёт прогона** (объект, экземпляры, гейты через события, артефакт = payload события — [ADR-100](./adr-100-extension-packs-pipelines.md)); **движок пайплайна принят как решение [ADR-101](./adr-101-pipeline-engine.md)** (**реализован**, этапы Э1–Э7 закрыты 2026-10-21), Loop Engine (PROP-057) — вне объёма, rollback/exit-стратегия и мониторинг-дашборд (PROP-059), размещение в гибриде, K8s Lease и разные dataDir на реплику — нет
> **Дата:** 2026-09-16
> **Обновлено:** 2026-10-21 — **движок пайплайна ([ADR-101](./adr-101-pipeline-engine.md)) реализован** (этапы Э1–Э7 закрыты); ADR-051 остаётся владельцем шедулера и запуска по расписанию (источник запуска `schedule` для пайплайна).
> **Обновлено:** 2026-10-21 — **движок пайплайна принят как [ADR-101](./adr-101-pipeline-engine.md)** («пайплайн как второй движок»); ADR-051 остаётся владельцем шедулера и запуска по расписанию (источник запуска `schedule` для пайплайна), остаток ADR-051 — размещение в гибриде, K8s Lease и разные dataDir на реплику.
> **Обновлено:** 2026-10-20 — **пайплайны в ядре реализованы** (декларация в пакете расширения, экземпляры, триггер/гейты по событиям, артефакт = payload события) — вынесено в [ADR-100](./adr-100-extension-packs-pipelines.md); этот AD остаётся владельцем шедулера и запуска по расписанию.
> **Источник:** перенесено из `AD-DRAFTS.md` (D6, идея 6 + Roadmap Фаза 2; прототип
> `~/dev/aic/t11/synth/app/scheduler.py`).
> **Связано:** [ADR-030](./adr-030-hooks-agent-events.md), [ADR-017](./adr-017-api-v2-hono.md),
> [ADR-042](./adr-042-hybrid-mode.md), [ADR-089](./adr-089-external-events-automation.md),
> [ADR-100](./adr-100-extension-packs-pipelines.md),
> [ADR-101](./adr-101-pipeline-engine.md),
> [PROP-059](./prop-059-pipeline-automation.md), [PROP-057](./prop-057-loop-engine.md).

**Решение:** ввести `SchedulerService` — планировщик запуска промптов и циклов по расписанию:

- cron-парсер + воркер (`node-cron` / `croner`);
- сущности **Schedule** и **Job**, CRUD-API;
- UI для управления правилами;
- конфигурация в `config.yaml`.

Запуск выполняется **событиями через событийный роутер** ([ADR-089](./adr-089-external-events-automation.md)):
шедулер не дёргает исполнителей напрямую, а публикует события, которые маршрутизируются к подписчикам.
Далее — **Pipeline** ([PROP-059](./prop-059-pipeline-automation.md)) как композиция шагов.

## Контекст

### Исходное состояние (до реализации среза)

- Вкладка «Шедулер» (`RightPanel.tsx`) была заглушкой; cron-кода и зависимостей `node-cron`/`croner` не было.
- `packages/core/src/queue/` (`processor.ts`) — это **очередь сообщений**, не шедулер.
- В прототипе t11 — полноценный `~/dev/aic/t11/synth/app/scheduler.py` (croniter, API, catch-up).

### Проблема

Периодические задачи (обновление индексов, проверки, запуск циклов по расписанию, регулярные промпты)
сегодня можно инициировать только вручную. Нет модели расписаний, их персистентности, API и UI. Это также
фундамент для автоматизации пайплайнов (D14/PROP-059) и для событийно-ориентированной автоматизации
(ADR-089/ADR-030).

## Детали

### Сущности и хранение

- `Schedule`: cron-выражение / интервал, часовой пояс, включён/выключен, политика catch-up, target.
- `Job`: конкретный запуск (снимок target, статус, результат/ошибка, время старта/финиша, история).
- Персистентность — JSON/FileStore (ADR-005), переход на PostgreSQL — PROP-032.

### Воркер

- Cron-парсер + воркер; обработка **catch-up** после простоя процесса; ограничение параллельных запусков;
  защита от наложения (одна задача в один момент — один запуск).

### API и UI

- CRUD-API в стиле API v2 ([ADR-017](./adr-017-api-v2-hono.md)), переиспользуемая core-фабрика роутов.
- UI-интерфейс правил (заменить placeholder в `RightPanel.tsx`); список запусков/история.
- В гибриде — уточнить, где живёт планирование (сервер vs локальный core, [ADR-042](./adr-042-hybrid-mode.md)).

### События и пайплайны

- Триггер запускает промпт/цикл, публикуя событие в роутер ([ADR-089](./adr-089-external-events-automation.md));
  (позже) — по событиям хуков [ADR-030](./adr-030-hooks-agent-events.md).
- Pipeline (D14/PROP-059) — следующая ступень: расписание запускает цепочку шагов, а не одиночный промпт.

## Статус реализации в коде

**Реализован минимальный срез** (cron/interval-источник событий через ADR-089),
без внешних зависимостей — собственный mini-cron-парсер вместо `node-cron`.
Job-история, catch-up и принудительный (force) запуск с rate limit добавлены.

Что есть:

- **shared**: типы `Schedule`/`ScheduleInput`/`ScheduleTarget`/`ScheduleJob`/
  `ScheduleJobTrigger`/`ScheduleRunStatus` (`types/schedules.ts`),
  Zod-схемы `scheduleTargetSchema`/`scheduleInputSchema`/`scheduleSchema`,
  конфиг-секция `scheduler` (`enabled`/`tickSec`/`catchUp`/`jobRetentionDays`).
- **core, парсеры** (`engine/scheduler/`): `nextCronDate`/`isValidCron`
  (5 полей, UTC, токены `*`/`n`/`a-b`/`a,b`/`*` со шагом/`a-b/шаг`),
  `parseDurationMs`/`isValidDuration` (`30s|15m|1h|24h`), `nextRunAt`.
- **core, хранилище**: `ScheduleStore` (`{dataDir}/schedules.json`, атомарная
  запись, `schemaVersion`, CRUD + `markRun`); `JobStore`
  (`{dataDir}/scheduler/jobs.jsonl`, append-only JSONL под `AsyncLock`, `list`
  по `scheduleId`/`limit`, `prune` по retention — по образцу `EventJournalStore`).
- **core, маршрутизация**: `SchedulerRuleProvider` (`RouteRuleProvider`) —
  cron-событие → `bound`/`queue`/`ephemeral`/`drop` по расписанию.
- **core, сервис**: `SchedulerService` (тикер с `unref`, in-flight guard по
  `scheduleId` + флаг `_busy` на тик, catch-up на старте, Job-история, force-run),
  публикует `{source:'cron', type:'schedule_fired'}` через `EventIngress`;
  `startScheduler`.
- **core, API**: `createSchedulerRoutes` (`/api/v2/schedules`, CRUD + `POST /:id/run`
  + `GET /:id/jobs`; опции `runGuard`/`runMiddleware`), сшивка в
  `server/app.ts`/`main.ts` (standalone).
- **backend, API/RBAC**: та же `createSchedulerRoutes` смонтирована в
  `packages/backend/src/app.ts` — чтение `requireAuth`, мутации и `POST /:id/run`
  — `requireAdmin`, `run` дополнительно под rate limit (10/60 c, `runMiddleware`);
  `SchedulerRuleProvider` зарегистрирован на `eventRouter`,
  `SchedulerService.start()` — по `scheduler.enabled`, `stopScheduler` на
  graceful shutdown (`src/main.ts`); тесты — `packages/backend/src/routes/schedules.test.ts`.
- **UI**: вкладка «Шедулер» — CRUD расписаний, быстрый toggle, force-запуск,
  раскрываемый блок «История запусков» (ленивая загрузка `GET /:id/jobs` с кэшем,
  статус/время/триггер/длительность/`decision`·`reason`/`sessionId`/ошибка) и
  рекомендация включить оптимизацию контекста с переходом на вкладку «Контекст».
- **конфиг**: `scheduler.enabled`/`scheduler.tickSec`/`scheduler.catchUp`/
  `scheduler.jobRetentionDays` (`docs/CONFIGURATION.md`).

Что осталось (следующие задачи):

- **Пайплайны** — база реализована (декларация + учёт прогона, [ADR-100](./adr-100-extension-packs-pipelines.md));
  остаток — собственный **движок шагов** (loop'и, верификация, termination guards —
  [PROP-057](./prop-057-loop-engine.md)), rollback/exit-стратегия и мониторинг-дашборд
  ([PROP-059](./prop-059-pipeline-automation.md)), автоматическое закрытие шага по факту окончания хода.
- Где живёт планировщик в гибриде (сервер vs локальный core, ADR-042).
- **Мульти-инстанс/идемпотентность** — см. раздел «Технический долг» ниже.

### Пайплайны в ядре (реализовано, ADR-100)

Пайплайн в ядре — это **декларация + учёт состояния прогона**, а не отдельный движок шагов.
Подробное решение — [ADR-100](./adr-100-extension-packs-pipelines.md); здесь — что важно для
шедулера и маршрутизации:

- **Объект.** Порт `PipelineRepository` (`packages/core/src/storage/ports/pipeline-repository.ts`):
  определения (`PipelineDefinitionRecord` — шаги, `onError`, `maxAttempts`, `ttl`, провенанс
  `installedBy`) и **экземпляры** (`PipelineInstanceRecord` — статус
  `pending|running|waiting|done|failed|cancelled`, состояния шагов, `currentStep`, `attempts`);
  файлы — `{dataDir}/pipelines/definitions.json` и `{dataDir}/pipelines/instances.json`.
  Определения **ставит установщик пакета расширения** (`POST /api/v2/packs`) — в обход проверки
  целостности манифеста `synth.pack` их не создать.
- **API.** `GET /api/v2/pipelines` (определения), `GET /api/v2/pipelines/:id`,
  `GET /api/v2/pipelines/instances` (фильтры `pipelineId`/`status`/`limit`),
  `GET /api/v2/pipelines/instances/:id`, `POST /api/v2/pipelines/:id/instances` (ручной запуск;
  scope `automation:install`).
- **Семантика автомата.** Первый шаг с `waitsFor` — **триггер**: совпавшее событие создаёт
  экземпляр. Последующие шаги с `waitsFor` — **гейты**: событие означает «предыдущий шаг завершён
  и подтверждён человеком» — автомат продвигается в существующем экземпляре.
- **Артефакт между шагами = payload события** (например `{draftId}`): payload сохраняется в
  артефакте шага и в `trigger.payload`; следующий шаг получает его оттуда.
- **Учёт ведёт funnel** (ADR-089): решение Router'а несёт `pipeline: {id, step}`, трекер
  (`engine/events/pipeline-tracker.ts`) создаёт/продвигает экземпляр; шаг закрывается при
  следующем событии пайплайна (хука «ход завершён» на уровне funnel нет — ограничение зафиксировано
  в коде).
- **Что не реализовано:** собственный движок шагов (PROP-057), rollback/exit-стратегия и
  мониторинг-дашборд (PROP-059), автоматическое закрытие шага по факту окончания хода.

### Job-история, catch-up и force-запуск

- **Job.** Каждое срабатывание (`cron` — тик, `manual` — `POST /:id/run`,
  `catchup` — догоняющее) пишется в append-only JSONL `{dataDir}/scheduler/jobs.jsonl`
  (`JobStore`): снимок `target`, `status` (`ok`/`error`/`skipped`), `startedAt`/
  `finishedAt`/`durationMs`, `dedupKey`, `decision` и `reason` маршрутизации
  (`drop no_route`, `busy`, `missed`), `sessionId` и `error`. Retention —
  `scheduler.jobRetentionDays` (по умолчанию 30): `prune` на старте сервиса
  (best-effort). Читается через `GET /api/v2/schedules/:id/jobs` (`?limit`, max 200).
- **Catch-up.** На старте расписание с `nextRunAt` в прошлом обрабатывается по
  `schedule.catchUp` (`skip` — Job `skipped`/`reason:'missed'` + пересчёт; `once` —
  одно догоняющее срабатывание `trigger:'catchup'`); дефолт — `scheduler.catchUp`.
  Ограничение наложения: in-flight guard по `scheduleId` (второй запуск → Job
  `skipped`/`reason:'busy'` без публикации события).
- **Force-run.** `POST /api/v2/schedules/:id/run` вызывает `SchedulerService.runNow`
  (всегда `force`, в т.ч. для выключенного расписания): уникальный dedup-ключ
  `cron:<id>:manual:<ISO>` → событие уходит в Router. В managed backend — ADMIN
  + rate limit 10/60 c (`runMiddleware`).

Проверено: `pnpm typecheck` (6/6), `pnpm lint` (0 errors), `pnpm test` (все
зелёные), новые тесты — cron/duration/store/scheduler/route-provider/routes
(core) и RBAC/wiring роутов (backend).

## Идентичность сообщений планировщика (системный пользователь Scheduler)

**Проблема.** Сообщение, доставляемое планировщиком в сессию, создавалось как обычное
`user`-сообщение **без `author`**. В сессии с заданным `userId` оркестратор
(`ChatOrchestrator._sessionMessagesToLlm`, `withAttribution`) трактовал его как «чужое» и
отдавал модели как `[anonymous]: <текст>` — агент не понимал, что это плановое задание и от кого оно.

**Решение (вариант A).** Сообщения источника `cron`:

- **Контент — чистый текст задания** (без служебных префиксов); `Message.author = 'Scheduler'`,
  `metadata = { source:'cron', scheduler:true, schedule_id, schedule_name }`. В LLM-контексте
  сообщение остаётся user-репликой и получает атрибуцию `{Scheduler}: <текст задания>`
  (`_sessionMessagesToLlm`).
- **Описание «кто такой Scheduler»** — статический **системный prompt-блок** `scheduler`
  (tier `context`, order 16, `provenance: prompts/system/SCHEDULER`) из ассета
  `packages/core/prompts/system/SCHEDULER.{ru,en}.md` (`ContextConfig.getSchedulerNotice`),
  собирается `SystemPromptComposer`. Включается **в сессиях с включённым расписанием**: есть
  scheduler-сообщение в истории **или** на сессию нацелено включённое расписание (bound/queue) —
  резолвер `ScheduleStore.hasEnabledTargetFor(sessionId)` через `OrchestratorOptions.isSchedulerActive`.
  При `session.settings.systemPrompt` override блок не добавляется.
- **UI** — центрированный служебный блок `Notice variant="scheduler"` (как сводка/отладка):
  иконка `calendar-schedule`, подпись **«Планировщик · <имя задания>»** (`schedule_name`),
  время, тело = текст задания; действия — полный набор как у user-сообщения
  (копировать/закрепить/удалить/повторить/ветка/отладка). Признак в UI — `metadata.scheduler === true`
  (`ChatMessage`), `MessageHeader.resolveAuthor()` для обычных user-сообщений не менялся.
- **Пояснение на ходу планировщика** — отдельный **volatile**-блок `scheduler.turn`
  (tier `volatile`, order 40, `provenance: prompts/system/SCHEDULER_TURN`) из ассета
  `packages/core/prompts/system/SCHEDULER_TURN.{ru,en}.md` (`ContextConfig.getSchedulerTurnNotice`).
  Добавляется **только когда текущий ход инициирован планировщиком** (`metadata.scheduler === true`;
  флаг `schedulerCurrentTurn` оркестратора), при `systemPrompt`-override — нет. Текст: текущее
  сообщение — автоматическое задание (`Scheduler`), человек в этом ходе не участвует.

**Статус:** ✅ реализовано (core + backend + UI, тесты; проверено dev-smoke: сообщение
имеет `author='Scheduler'` и чистый контент, блок `scheduler` есть в манифесте промпта
нацеленной сессии и отсутствует у сессии без расписания; в браузере рендерится
`group "Планировщик · Тест"` с полным набором действий).

## Технический долг: мульти-инстанс, синхронизация и идемпотентность

**Проблема.** Планировщик рассчитан на **один активный процесс-владелец**: тикер
`SchedulerService` и хранилища `ScheduleStore`/`EventJournalStore` локальны, а их `AsyncLock`
— внутрипроцессный. При нескольких репликах backend с общим `dataDir` каждая крутит свой тикер
и в одну и ту же минуту генерирует событие с **одинаковым** `dedupKey`
(`cron:<id>:<минута>`); дедуп в `EventRouter` — in-memory `Set`, инициализируемый **один раз**
из `journal.jsonl` и не обновляемый по чужим записям, поэтому **все реплики проходят** →
дубли сессий/сообщений, а по журналу — N записей. Дополнительно: конкурентные `markRun` теряют
`nextRunAt` (last-write-wins), а при **разных** dataDir на реплику расписания и журналы
расходятся. Сейчас в чартах `backend.replicaCount: 1` (и `charts/synth`, и `synth-deploy`),
поэтому на текущем деплое проблемы нет.

**Решение (реализовано в виде сем + file-based, default OFF):**
1. **Семы — `DedupStore`** (`engine/events/dedup-store.ts`): `EventRouter` больше не держит
   `Set` сам, а спрашивает `tryClaim(dedupKey)` / `seed(keys)`. Реализации:
   `MemoryDedupStore` (текущее поведение single-process) и `FileDedupStore`
   (атомарный `open(path,'wx')` на `{dataDir}/events/dedup/<sha256(key)>`).
   `decide` claim'ит ключ; `record` дублирует claim best-effort (путь «hook заблокировал
   до decide»). Режим — `events.dedupStore: memory|file` (default `memory`).
2. **Leader election — `SchedulerLeader`** (`engine/scheduler/leader.ts`): `AlwaysLeader`
   (default, поведение single-process) и `FileLeader` (file-мьютекс
   `{dataDir}/scheduler/leader.lock`, stale `3×tick`); `SchedulerService.start()` стартует
   тикер только у лидера, `tick()` — heartbeat, `stop()` — release. Режим —
   `scheduler.leaderElection: none|file|postgres` (default `none`). `postgres`
   (PROP-032) — `PgLeader` драйвера `@itphx/synth-storage-postgres`: session-level
   advisory-lock на удерживаемом соединении; доступен при `storage.backend=postgres`,
   потеря соединения явно снимает лидерство (heartbeat не нужен).
3. **Межпроцессная сериализация мутаций `ScheduleStore`** — `FileMutex`
   (`storage/file-mutex.ts`, `mkdir`-лок + stale takeover) поверх in-process `AsyncLock`;
   read-modify-write `create/update/remove/markRun/setNextRun` не теряет `nextRunAt`.
   Режим — `scheduler.crossProcessLocks: boolean` (default `false`). При
   `storage.backend=postgres` мьютекс не нужен: мутации `schedules` — атомарные
   одиночные `INSERT/UPDATE/DELETE`, файловый лок не создаётся (`Mutex`-шов —
   `PgMutex` при необходимости, PROP-032).

Все три флага по умолчанию **OFF** — поведение single-process (`replicaCount: 1`) не меняется.
File-based реализация рассчитана на **общий `dataDir` на одном хосте/FS** и **не** решает
задачу для разных dataDir/хостов.

**Статус:** ✅ реализованы семы `DedupStore`/`SchedulerLeader` и file-based `FileDedupStore`/
`FileLeader`/`FileMutex` (default OFF, тесты); PROP-032: PG advisory-lock лидер-выбор
(`PgLeader`) и мьютекс (`PgMutex`) при `storage.backend=postgres`. ⏳ Остаётся будущим:
K8s `Lease` (`coordination.k8s.io`), отдельный Deployment планировщика (`replicas: 1`),
Postgres unique-index/`FOR UPDATE`-семы при нескольких репликах (частично закрыто PG
advisory-локом), а также решение для разных dataDir на реплику.
Связано с открытым вопросом «где живёт планировщик в гибриде» (ADR-042).

## Открытые вопросы

- Где живёт планировщик в гибриде — на сервере или локально ([ADR-042](./adr-042-hybrid-mode.md))?

Ряд вопросов (библиотека парсера, catch-up, персистентность) закрыт реализацией — см. «Статус реализации в коде».

## Связи

- [ADR-089](./adr-089-external-events-automation.md) «Внешние события и автоматизация» — событийный роутер,
  через который шедулер «стреляет» запусками (D6 → ADR-089).
- [ADR-030](./adr-030-hooks-agent-events.md) «Hooks для событий агента» — событийные триггеры и фундамент.
- [PROP-059](./prop-059-pipeline-automation.md) «Pipeline Automation» — композиция шагов поверх шедулера (D14).
- [ADR-100](./adr-100-extension-packs-pipelines.md) «Пакет расширения и пайплайн в ядре» — объект пайплайна, экземпляры, триггер/гейты, артефакт = payload события; установка пакета расширения как источник определений.
- [PROP-057](./prop-057-loop-engine.md) «Loop Engine» — исполняемая единица, запускаемая по расписанию (D12).
- [ADR-017](./adr-017-api-v2-hono.md) «API v2» — CRUD-роуты расписаний.
- [ADR-042](./adr-042-hybrid-mode.md) «Гибридный режим» — размещение планировщика.
- [PROP-054](./prop-054-kanban-backlog.md) «Kanban-доска, backlog» — задачи как цель запуска по расписанию (D9).

## Обновлено (2026-10-21)

- **Движок пайплайна принят как решение [ADR-101](./adr-101-pipeline-engine.md)** — «пайплайн как второй
  движок» рядом с оркестратором. Разделение владельцев: **ADR-051** — шедулер и запуск по расписанию
  (для пайплайна это триггер `kind: schedule`); **ADR-100** — поставка расширений (`synth.pack`);
  **ADR-101** — движок, контракты, версии, переходы, журнал прогона, выход, привязка к проекту.
  Loop Engine ([PROP-057](./prop-057-loop-engine.md)) — вне объёма ADR-101.
- Указание «остаток — движок шагов (PROP-057)» в теле этого AD **устарело**: движок — это ADR-101,
  а PROP-057 остаётся отдельным предложением (loop'и, верификация, termination guards).
- Остаток именно ADR-051 не изменился: размещение в гибриде, K8s Lease и разные `dataDir` на реплику.
  Формат пайплайнов — [docs/PIPELINES.md](../PIPELINES.md).
- **Движок пайплайна реализован** ([ADR-101](./adr-101-pipeline-engine.md); этапы Э1–Э7 закрыты 2026-10-21):
  пайплайн — второй движок (проектная привязка, версии, переходы, журнал, выход), UI переведён на
  новый контур (Э7). Запись выше о том, что движок «реализуется по этапам Э1–Э7», больше не актуальна.

## История

- 2026-10-21 — движок пайплайна ([ADR-101](./adr-101-pipeline-engine.md)) реализован (Э1–Э7 закрыты); остаток ADR-051 прежний.
- 2026-10-21 — движок пайплайна принят как [ADR-101](./adr-101-pipeline-engine.md); ADR-051 остаётся владельцем шедулера.
- 2026-10-20 — пайплайны: база реализована (декларация + экземпляры + гейты по событиям), решение вынесено в [ADR-100](./adr-100-extension-packs-pipelines.md); остаток — движок шагов (PROP-057) и rollback/дашборд (PROP-059).
- 2026-10-12 — добавлены мульти-инстанс-механизмы: семы (`DedupStore`), выбор лидера (`SchedulerLeader`), межпроцессная сериализация `ScheduleStore` (`FileMutex`).
- 2026-10-02 — добавлены Job-история, catch-up и force-запуск.

# AD-051: Шедулер и пайплайны (облегчённый n8n)

> **Статус:** ⚠️ Частично — реализован минимальный срез (cron/interval-источник событий через AD-089, идентичность сообщений `Scheduler`); Job-история, catch-up, пайплайны — нет; мульти-инстанс/идемпотентность — тех.долг.
> **Дата:** 2026-09-16
> **Источник:** перенесено из `AD-DRAFTS.md` (D6, идея 6 + Roadmap Фаза 2; прототип
> `~/dev/aic/t11/synth/app/scheduler.py`).
> **Связано:** [AD-030](./ad-030-hooks-agent-events.md), [AD-017](./ad-017-api-v2-hono.md),
> [AD-042](./ad-042-hybrid-mode.md), [AD-089](./ad-089-external-events-automation.md),
> [AD-059](./ad-059-pipeline-automation.md), [AD-057](./ad-057-loop-engine.md).

**Решение:** ввести `SchedulerService` — планировщик запуска промптов и циклов по расписанию:

- cron-парсер + воркер (`node-cron` / `croner`);
- сущности **Schedule** и **Job**, CRUD-API;
- UI для управления правилами;
- конфигурация в `config.yaml`.

Запуск выполняется **событиями через событийный роутер** ([AD-089](./ad-089-external-events-automation.md)):
шедулер не дёргает исполнителей напрямую, а публикует события, которые маршрутизируются к подписчикам.
Далее — **Pipeline** ([AD-059](./ad-059-pipeline-automation.md)) как композиция шагов.

## Контекст

### Исходное состояние (до реализации среза)

- Вкладка «Шедулер» (`RightPanel.tsx`) была заглушкой; cron-кода и зависимостей `node-cron`/`croner` не было.
- `packages/core/src/queue/` (`processor.ts`) — это **очередь сообщений**, не шедулер.
- В прототипе t11 — полноценный `~/dev/aic/t11/synth/app/scheduler.py` (croniter, API, catch-up).

### Проблема

Периодические задачи (обновление индексов, проверки, запуск циклов по расписанию, регулярные промпты)
сегодня можно инициировать только вручную. Нет модели расписаний, их персистентности, API и UI. Это также
фундамент для автоматизации пайплайнов (D14/AD-059) и для событийно-ориентированной автоматизации
(AD-089/AD-030).

## Детали

### Сущности и хранение

- `Schedule`: cron-выражение / интервал, часовой пояс, включён/выключен, политика catch-up, target.
- `Job`: конкретный запуск (снимок target, статус, результат/ошибка, время старта/финиша, история).
- Персистентность — JSON/FileStore (AD-005) до перехода на PostgreSQL (AD-032) — открытый вопрос.

### Воркер

- Cron-парсер + воркер; обработка **catch-up** после простоя процесса; ограничение параллельных запусков;
  защита от наложения (одна задача в один момент — один запуск).

### API и UI

- CRUD-API в стиле API v2 ([AD-017](./ad-017-api-v2-hono.md)), переиспользуемая core-фабрика роутов.
- UI-интерфейс правил (заменить placeholder в `RightPanel.tsx`); список запусков/история.
- В гибриде — уточнить, где живёт планирование (сервер vs локальный core, [AD-042](./ad-042-hybrid-mode.md)).

### События и пайплайны

- Триггер запускает промпт/цикл, публикуя событие в роутер ([AD-089](./ad-089-external-events-automation.md));
  (позже) — по событиям хуков [AD-030](./ad-030-hooks-agent-events.md).
- Pipeline (D14/AD-059) — следующая ступень: расписание запускает цепочку шагов, а не одиночный промпт.

## Статус реализации в коде

**Реализован минимальный срез** (cron/interval-источник событий через AD-089),
без внешних зависимостей — собственный mini-cron-парсер вместо `node-cron`.

Что есть:

- **shared**: типы `Schedule`/`ScheduleInput`/`ScheduleTarget` (`types/schedules.ts`),
  Zod-схемы `scheduleTargetSchema`/`scheduleInputSchema`/`scheduleSchema`,
  конфиг-секция `scheduler` (`enabled`/`tickSec`).
- **core, парсеры** (`engine/scheduler/`): `nextCronDate`/`isValidCron`
  (5 полей, UTC, токены `*`/`n`/`a-b`/`a,b`/`*` со шагом/`a-b/шаг`),
  `parseDurationMs`/`isValidDuration` (`30s|15m|1h|24h`), `nextRunAt`.
- **core, хранилище**: `ScheduleStore` (`{dataDir}/schedules.json`, атомарная
  запись, `schemaVersion`, CRUD + `markRun`).
- **core, маршрутизация**: `SchedulerRuleProvider` (`RouteRuleProvider`) —
  cron-событие → `bound`/`queue`/`ephemeral`/`drop` по расписанию.
- **core, сервис**: `SchedulerService` (тикер с `unref`, guard от наложения, без
  catch-up), публикует `{source:'cron', type:'schedule_fired'}` через
  `EventIngress`; `startScheduler`.
- **core, API**: `createSchedulerRoutes` (`/api/v2/schedules`, 5 эндпоинтов),
  сшивка в `server/app.ts`/`main.ts` (standalone).
- **backend, API/RBAC**: та же `createSchedulerRoutes` смонтирована в
  `packages/backend/src/app.ts` — чтение `requireAuth`, мутации и `POST /:id/run`
  — `requireAdmin`; `SchedulerRuleProvider` зарегистрирован на `eventRouter`,
  `SchedulerService.start()` — по `scheduler.enabled`, `stopScheduler` на
  graceful shutdown (`src/main.ts`); тесты — `packages/backend/src/routes/schedules.test.ts`.
- **конфиг**: `scheduler.enabled`/`scheduler.tickSec` (`docs/CONFIGURATION.md`).

Что осталось (следующие задачи):

- Сущность **Job** и история запусков (снимок target, результат/ошибка,
  старт/финиш), retention.
- **Catch-up** после простоя процесса и лимит параллельных запусков.
- UI-интерфейс правил и истории (замена placeholder в `RightPanel.tsx`) — сама вкладка уже рабочая, остаётся история Job'ов.
- Rate limit на принудительный запуск (`POST /:id/run`) — в core-фабрике нет
  отдельного guard'а под `run` (только общий `writeGuard`).
- **Пайплайны** (AD-059) — композиция шагов поверх расписаний.
- Где живёт планировщик в гибриде (сервер vs локальный core, AD-042).
- **Мульти-инстанс/идемпотентность** — см. раздел «Технический долг» ниже.

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

**Решение (план):**
1. **Один владелец-лидер** — leader election: K8s `Lease` (`coordination.k8s.io`), либо
   отдельный Deployment планировщика с `replicas: 1`, либо `scheduler.enabled:false` на
   не-лидере; после AD-032 — Postgres advisory lock. `SchedulerService` стартует только у лидера.
2. **Атомарный claim** — сделать дедуп авторитетным и общим: интерфейс
   `DedupStore.tryClaim(dedupKey): Promise<boolean>` (Postgres unique-index / Redis `SET NX` /
   `open(O_CREAT|O_EXCL)` на shared FS) вместо advisory-`Set` в `EventRouter`;
   `SchedulerService` публикует событие только при выигранном claim.
3. **Межпроцессная сериализация мутаций** `ScheduleStore` (advisory lock / CAS по версии),
   чтобы не терять `nextRunAt`.

**Статус:** ⏳ не реализовано (зафиксировано как тех.долг; вернуться при масштабировании
backend / после AD-032). Связано с открытым вопросом «где живёт планировщик в гибриде» (AD-042).

## Открытые вопросы

- Библиотека: `node-cron` vs `croner`?
- Catch-up после простоя процесса?
- Персистентность расписаний (JSON vs PostgreSQL)?
- Где живёт планировщик в гибриде — на сервере или локально ([AD-042](./ad-042-hybrid-mode.md))?

## Связи

- [AD-089](./ad-089-external-events-automation.md) «Внешние события и автоматизация» — событийный роутер,
  через который шедулер «стреляет» запусками (D6 → AD-089).
- [AD-030](./ad-030-hooks-agent-events.md) «Hooks для событий агента» — событийные триггеры и фундамент.
- [AD-059](./ad-059-pipeline-automation.md) «Pipeline Automation» — композиция шагов поверх шедулера (D14).
- [AD-057](./ad-057-loop-engine.md) «Loop Engine» — исполняемая единица, запускаемая по расписанию (D12).
- [AD-017](./ad-017-api-v2-hono.md) «API v2» — CRUD-роуты расписаний.
- [AD-042](./ad-042-hybrid-mode.md) «Гибридный режим» — размещение планировщика.
- [AD-054](./ad-054-kanban-backlog.md) «Kanban-доска, backlog» — задачи как цель запуска по расписанию (D9).

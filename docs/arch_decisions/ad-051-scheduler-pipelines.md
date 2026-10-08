# AD-051: Шедулер и пайплайны (облегчённый n8n)

> **Статус:** ⚠️ Частично — реализован минимальный срез (cron/interval-источник событий через AD-089); Job-история, catch-up, UI и пайплайны — нет.
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

### Что уже есть

- UI-заглушка вкладки «Шедулер»: `packages/ui/src/components/panels/RightPanel.tsx`
  (`{ id: 'scheduler', icon: 'calendar-schedule', labelKey: 'rightPanel.tab.scheduler' }` + placeholder),
  i18n `rightPanel.scheduler.placeholder` («Шедулер — в разработке») в `packages/ui/src/lib/i18n/messages/`.
- Кода/cron в Synth нет; зависимостей `node-cron`/`croner` в пакетах нет.
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
- UI-интерфейс правил и истории (замена placeholder в `RightPanel.tsx`).
- Rate limit на принудительный запуск (`POST /:id/run`) — в core-фабрике нет
  отдельного guard'а под `run` (только общий `writeGuard`).
- **Пайплайны** (AD-059) — композиция шагов поверх расписаний.
- Где живёт планировщик в гибриде (сервер vs локальный core, AD-042).

Проверено: `pnpm typecheck` (6/6), `pnpm lint` (0 errors), `pnpm test` (все
зелёные), новые тесты — cron/duration/store/scheduler/route-provider/routes
(core) и RBAC/wiring роутов (backend).

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

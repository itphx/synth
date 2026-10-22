# ADR-102: Аналитика и отчётность инстанса — суточные роллапы и отчётный контур

> **Статус:** ⚠️ Частично — реализованы порт `AnalyticsRollupRepository`, сборщик `AnalyticsRecorder`, API `GET /api/v2/analytics/*` (summary/usage/activity/decision/prompt/export), дериваты и экспорт CSV/JSON, backfill `synth analytics rebuild`; остаток — бюджеты, лимиты и алерты, отдельная отчётность по промптам/решениям.
> **Дата:** 2026-10-18
> **Связано:** [ADR-005](./adr-005-json-storage.md), [ADR-030](./adr-030-hooks-agent-events.md), [ADR-036](./adr-036-llm-gateway.md), [ADR-052](./adr-052-public-api-platform.md), [ADR-070](./adr-070-system-prompt-composer.md), [ADR-072](./adr-072-settings-ui-kit.md), [ADR-084](./adr-084-decision-models-clef.md), [ADR-091](./adr-091-backup-restore-transfer.md), [ADR-092](./adr-092-instance-lifecycle-maintenance.md), [ADR-094](./adr-094-observability-metrics.md), [ADR-096](./adr-096-storage-layer.md)/[ADR-097](./adr-097-storage-provider-class.md), [PROP-063](./prop-063-user-learning-metrics.md), [PROP-074](./prop-074-soft-delete-retention.md); детали и формат — [docs/ANALYTICS.md](../ANALYTICS.md) (Spec).

## Контекст

Аудит расхода токенов у платформы уже есть, но **отчётности по пользователю/проекту/модели** не было: агрегаты
существовали «в моменте» (per-session `computeSessionStats`, стоимость в `metadata.cost_usd` сообщения) и
«по одной сессии», а исторического, срезного и выгружаемого отчёта не было. Ставить на это отдельный внешний BI
нельзя — самохостящийся инстанс должен давать отчёт сам. Считать отчёт «на лету» из сообщений и аудита
дорого: O(история) на каждый запрос.

## Решение

1. **Пред-агрегированные суточные роллапы (UTC)** — отчёт как **производное чтение**, а не пересчёт истории.
   Единица роллапа — сутки в UTC (не TZ инстанса).
2. **Порт `AnalyticsRollupRepository`** в слое хранения (ADR-096): единственная точка доступа домена к
   роллапам; файловая (`FileStore`/`JsonStore`, ADR-005), in-memory и PostgreSQL-реализации обязаны проходить
   контрактный suite. Прямой записи в `$SYNTH_DATA_DIR` в обход порта нет (инвариант 2).
3. **Четыре семейства роллапов:** `usage` (токены и стоимость по осям `day, userId, projectId, model, agentRole`),
   `activity` (`day, userId, projectId`; сессии/сообщения/тулы/ошибки), `decision` (`day, provider, model`; персистентная
   замена in-memory снимка decision-метрик), `prompt` (`day, model, agentRole`; производные от `usage`).
4. **Сбор — best-effort.** Запись идемпотентным upsert по ключу `(family, day, dimensions)` с инкрементом на
   существующих швах (стоимость/usage, запись сообщения, жизненный цикл сессии и тула, сборка промпта, решение).
   Ошибка порта **не ломает ход** сессии; в деградированном режиме хранилища запись выключена.
5. **Дериваты считаются на чтении** (`cache_hit_rate`, `output_tps`, итоги по валютам) — в хранилище лежат
   **сырые счётчики**.
6. **Экспорт — server-side, только данные:** CSV (RFC 4180 + BOM UTF-8) и JSON; `Content-Disposition: attachment`.
   Строка отчёта сервером не сочиняется → i18n в отчёте не дублируется. XLSX и серверный PDF — вне объёма
   (PDF закрывает печать браузера; новых зависимостей не вводим — инвариант 12).
7. **API только для чтения:** `GET /api/v2/analytics/{summary,usage,activity,decision,prompt,export}`
   (core-фабрика `createAnalyticsRoutes`; backend монтирует и добавляет RBAC). **Разграничение ролей:**
   `ADMIN`/`LEAD` — сквозной обзор, `AUDITOR` — чтение, `USER` — свои строки (`summary`/`decision` → 403).
8. **Backfill** — `synth analytics rebuild [--from <date>] [--dry-run|--yes]`: идемпотентная пересборка роллапов
   из истории (стоимость/токены из сообщений и журнала LLM Gateway, ADR-036). Без `--yes` и без `--dry-run` —
   отказ (паттерн ADR-091/ADR-092).
9. **Retention** — `analytics.retentionDays` (по умолчанию 400), чистка по образцу `startEventJournalPruner`.
   Роллапы агрегированы: ни текста сообщений, ни промптов, ни ключей, ни PII в значениях (ADR-094 — низкая
   кардинальность).
10. **Лимиты, квоты и алерты — вне объёма:** это отдельное решение, а не следствие роллапов.

## Альтернативы

- **Считать отчёт «на лету» из сообщений и аудита** — отклонено: O(история) на каждый запрос, растёт с объёмом
  данных и упирается в PG/FS при интерактивном UI; роллапы переносят цену на запись (там значение уже под рукой).
- **Только внешний BI по журналу** — отклонено как замена: самохостящийся инстанс должен давать отчёт сам.
- **Серверный PDF/XLSX** — отложено: тянет зависимости/рендерер (инвариант 12); браузерная печать и CSV/JSON
  закрывают спрос.
- **Пятое семейство «стоимость по пользователю» как отдельная сущность** — отклонено: это проекция `usage` по
  оси `user` на чтении.
- **Хранить дериваты (cache-hit, tps, итоги)** — отклонено: дублирование денормализованного значения расходится с
  сырым счётчиком.

## Последствия

- **Новый порт** → контрактный suite и все backend'ы (file/memory/postgres) обязаны его реализовать; добавление
  роллапа в PG-драйвер — миграция схемы (ADR-092/ADR-096).
- **Рост записи.** Каждое сообщение/ход добавляет upsert; на файловом backend это отдельная запись — на горячих
  инстансах стоит держать в буфере/инкрементить на уровне сообщения (троттлинг, как у `publishLiveUsage`).
- **Миграция decision-метрик** из in-memory в персистентное семейство `decision` — поведенчески совместима (снимок
  остаётся), но появляется история.
- **Новый CLI-контур** `synth analytics rebuild` — идемпотентность обязана быть проверена (повторный прогон не
  удваивает счётчики).
- **Отчёты по стоимости** становятся основой для будущих лимитов/квот и алертов (вне объёма) — роллапы сразу
  проектируются под эти оси.
- **Приватность.** Отчёт не содержит текста/промптов/PII; при добавлении новых измерений — правило низкой
  кардинальности в силе.

## Статус в коде

- **Порт:** `packages/core/src/storage/ports/analytics-rollup-repository.ts` (`increment`/`set`/`query`/`prune`/`clear`);
  реализации — файловая (`packages/core/src/storage/analytics-rollup-store.ts`, `{dataDir}/analytics/rollups.json`),
  in-memory (`packages/core/src/storage/memory/analytics-rollup.ts`), PostgreSQL
  (`packages/storage-postgres/src/ports/analytics.ts`, таблица `analytics_rollups`, миграция 003); контрактный
  suite — `packages/core/src/storage/contract/analytics.ts`.
- **Контракты и конфиг:** типы и Zod — `packages/shared/src/types/analytics.ts`, `packages/shared/src/schemas/index.ts`
  (`AnalyticsFamily`/`AnalyticsDimension`/`AnalyticsRollupBucket`/`AnalyticsReport`); секция `analytics.retentionDays`
  (default 400, env `SYNTH_ANALYTICS_RETENTION_DAYS`) — `packages/shared/src/config/types.ts`.
- **Сбор и сервис:** `packages/core/src/analytics/` — `recorder.ts` (`AnalyticsRecorder` — сборщик всех четырёх
  семейств, best-effort), `hooks.ts` (швы записи `activity`), `service.ts` (дериваты на чтении), `derive.ts`,
  `export.ts` (CSV/JSON), `prune.ts` (retention), `rebuild.ts`/`rebuild-command.ts` (backfill).
- **API и UI:** `packages/core/src/server/routes/analytics.ts` (`createAnalyticsRoutes` — `summary`/`usage`/`activity`/
  `decision`/`prompt`/`export`, только чтение; монтирование в core и backend с RBAC); UI — ленивый
  `packages/ui/src/components/analytics/AnalyticsModal.tsx` (вкладки «Расход и стоимость»/«Активность»/«Decision»/
  «Кэш и эффективность», пресеты периода, фильтры, CSV/JSON, печать браузера через `AnalyticsPrintReport.tsx`);
  домен API — `packages/ui/src/lib/api/analytics.ts`.
- **CLI:** `synth analytics rebuild [--from <date>] [--dry-run|--yes]` — `packages/synth/src/cli.ts`.
- **Остаток:** лимиты, квоты и алерты (отдельное решение); часовые роллапы; service-key scope `analytics:read`;
  серверная шабонизация HTML→PDF; взаимодействие с soft-delete/retention сообщений (PROP-074); фильтр по `provider`
  в API; пересборка `decision` при появлении постоянного источника истории.

## Связи

- [ADR-005](./adr-005-json-storage.md) — атомарная запись/JSON-хранилище: как роллапы ложатся на файловый backend.
- [ADR-030](./adr-030-hooks-agent-events.md) — хук-шина как шов записи `activity` (session/tool lifecycle).
- [ADR-036](./adr-036-llm-gateway.md) — журнал LLM Gateway: источник бэкфилла и родственный контур аудита.
- [ADR-052](./adr-052-public-api-platform.md) — service-key/scopes: возможный `analytics:read` в будущем.
- [ADR-070](./adr-070-system-prompt-composer.md) — статистика usage и тиры промпта (основа семейства `prompt`).
- [ADR-072](./adr-072-settings-ui-kit.md) — контракт панелей настроек/UI-кита для раздела «Аналитика».
- [ADR-084](./adr-084-decision-models-clef.md) — decision-метрики, переносимые в персистентное семейство `decision`.
- [ADR-091](./adr-091-backup-restore-transfer.md) / [ADR-092](./adr-092-instance-lifecycle-maintenance.md) — паттерн CLI-команд
  (`--dry-run`/`--yes`), миграции схемы под порт.
- [ADR-094](./adr-094-observability-metrics.md) — эксплуатационные метрики (низкая кардинальность): соседний, не
  пересекающийся контур.
- [ADR-096](./adr-096-storage-layer.md) / [ADR-097](./adr-097-storage-provider-class.md) — доменный порт и БД-реализация.
- [PROP-063](./prop-063-user-learning-metrics.md) — метрики без рейтингов: согласование приватности отчёта.
- [PROP-074](./prop-074-soft-delete-retention.md) — взаимодействие со скрытием/retention сообщений.
- [docs/ANALYTICS.md](../ANALYTICS.md) — Spec: оси атрибуции, семейства отчётов, выводы, экспорт, backfill, retention.

## История

- 2026-10-18 — **реализованы волны 1–2.** Волна 1: shared-типы/Zod, конфиг `analytics.retentionDays` (400), порт
  `AnalyticsRollupRepository` (file/memory/PG + миграция 003 + контрактный suite), сборщики четырёх семейств на
  существующих швах (best-effort, в деградации выключены), `AnalyticsService` с дериватами на чтении,
  `createAnalyticsRoutes` (summary/usage/activity/decision/prompt/export, RBAC), `synth analytics rebuild`
  (идемпотентный `set`-бэкфилл `usage`/`activity`), docs. Волна 2: ленивый `AnalyticsModal` (4 вкладки, пресеты,
  фильтры, CSV/JSON, печать браузера), входы из меню пользователя и правой панели; `DashboardPanel` не заменялся.
- 2026-10-18 — документ создан: зафиксированы порт `AnalyticsRollupRepository`, четыре семейства роллапов, швы
  записи, фабрика `createAnalyticsRoutes`, UI-отчёт (волна 2), форматы CSV/JSON + печать браузера, RBAC,
  retention/приватность, PG-реализация, бэкфилл `synth analytics rebuild` и волны 1–2.
- 2026-10-22 — принято решение: предложение повышено до ADR (детали вынесены в [docs/ANALYTICS.md](../ANALYTICS.md));
  остаток — лимиты/квоты/алерты.

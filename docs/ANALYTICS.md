# Аналитика и отчётность инстанса — формат и устройство (Spec)

> **Назначение:** «как устроено, точно и полно» — оси атрибуции, семейства отчётов, швы записи, выводы,
> экспорт, backfill, retention (класс **Spec** по [ARCH_DECISIONS.md](./ARCH_DECISIONS.md) §1). Решение — в
> [ADR-102](./arch_decisions/adr-102-analytics-reports.md) (суточные роллапы и отчётный контур); порты
> хранилища — [ADR-096](./arch_decisions/adr-096-storage-layer.md)/[ADR-097](./arch_decisions/adr-097-storage-provider-class.md);
> API — [docs/API_V2.md](./API_V2.md) §5.32; конфигурация — [docs/CONFIGURATION.md](./CONFIGURATION.md)
> §«Аналитика и отчётность».
>
> **Статус документа:** волны 1 (данные/API/CLI/PG/docs) и 2 (UI) — **реализованы**; вне объёма — лимиты,
> квоты, алерты, часовые роллапы, service-key scope `analytics:read`, серверный PDF/XLSX.

---

## 1. Реализация и остатки

### 1.1. Волна 1 (данные/API/CLI/PG/docs) — реализована

- Общие типы и Zod — `packages/shared/src/types/analytics.ts`, `packages/shared/src/schemas/index.ts`
  (`AnalyticsFamily`, `AnalyticsDimension`, `AnalyticsRollupBucket`, `AnalyticsRollupQuery`,
  `AnalyticsRollupRow`, `AnalyticsReport`, `AnalyticsExportFormat`, `AnalyticsSummary`).
- Конфиг `analytics.retentionDays` (default 400, env `SYNTH_ANALYTICS_RETENTION_DAYS`) —
  `packages/shared/src/config/types.ts`, `defaults.ts`, `env-overrides.ts`.
- Порт `AnalyticsRollupRepository` — `packages/core/src/storage/ports/analytics-rollup-repository.ts`:
  `increment` (идемпотентный upsert по ключу `(family, day, dimensions)` с суммированием мер и
  `costByCurrency`), `set` (точная перезапись), `query` (фильтры + агрегация по `groupBy`), `prune`,
  `clear`.
- Реализации: файловая (`packages/core/src/storage/analytics-rollup-store.ts`,
  `{dataDir}/analytics/rollups.json`), in-memory (`packages/core/src/storage/memory/analytics-rollup.ts`),
  PostgreSQL (`packages/storage-postgres/src/ports/analytics.ts`, таблица `analytics_rollups`, миграция 003,
  `ON CONFLICT … DO UPDATE` с инкрементом).
- Контрактный suite — `packages/core/src/storage/contract/analytics.ts` (прогон против живой БД гейтится env
  `SYNTH_TEST_POSTGRES_DSN`).
- Сборщики — `packages/core/src/analytics/`: `recorder.ts` (`AnalyticsRecorder` — сбор всех четырёх семейств
  на существующих швах, best-effort), `hooks.ts` (жизненный цикл сессии/тула → `activity`).
- Сервис и дериваты — `packages/core/src/analytics/service.ts`, `derive.ts` (дериваты считаются **на чтении**).
- Экспорт — `packages/core/src/analytics/export.ts` (CSV — RFC 4180 + BOM, JSON — сам `AnalyticsReport`).
- Retention — `packages/core/src/analytics/prune.ts` (прунер — на старте и каждые 6 ч).
- Роуты — `packages/core/src/server/routes/analytics.ts` (`createAnalyticsRoutes`), монтирование в core и
  backend с RBAC.
- CLI — `synth analytics rebuild` (`packages/core/src/analytics/rebuild.ts`, `rebuild-command.ts`,
  `packages/synth/src/cli.ts`).

### 1.2. Волна 2 (UI) — реализована

- Ленивый `AnalyticsModal` — `packages/ui/src/components/analytics/AnalyticsModal.tsx`: вкладки
  «Расход и стоимость» / «Активность» / «Decision» / «Кэш и эффективность»; пресеты периода `7d`/`30d`/`90d`/
  `custom` (`analytics-range.ts`), селекты user/project/model/agent; CSV/JSON и печать браузера
  (`AnalyticsPrintReport.tsx` + `analytics-print.css`); таблица с сортировкой (`AnalyticsTable.tsx`).
- API-домен — `packages/ui/src/lib/api/analytics.ts` (пути и query, разбор ответа).
- Входы — меню пользователя (`packages/ui/src/components/auth/QuickSettingsPopup.tsx`) и правая панель
  (`packages/ui/src/components/layout/AnalyticsButton.tsx`, `stores/useUIStore.ts`).
- `DashboardPanel` **не заменялся** — это счётчики инстанса, а не отчётность.

### 1.3. Осознанные отклонения от первоначального текста

- **Меры — snake_case** (`input_tokens`, `sessions_created`, …), а не camelCase: паритет с
  `packages/core/src/sessions/stats.ts` и сырыми счётчиками сообщений.
- **Ось `provider`** оставлена в реестре измерений и пишется семейством `decision`; проводка `usage` её
  сейчас не передаёт (ось опциональна), поэтому в отчётах `usage` она не наполняется. Фильтра `provider` в
  query нет.
- **`prompt` — проекция `usage` на чтении**, а не отдельная запись: своих мер нет, дефолтная группировка —
  `model,agent`; дериваты применяются к обоим семействам.
- **`activity`** пишется только по осям `user`/`project` (`day` — поле бакета); `agent` в её осях не участвует.
- **Бэкфилл:** `decision` не пересобирается (история метрик не хранится), `prompt` пересобирать нечего; ключи
  без источника не удаляются (их убирает retention); журнал Gateway — только положительная добавка к сообщениям;
  запись в `maintenance.jsonl` команда не делает.
- **RBAC:** обычному пользователю `summary`/`decision` (и экспорт `decision`) → 403; `usage`/`activity`/`prompt` —
  принудительный фильтр по его `userId`; `AUDITOR` — чтение всех отчётов; отдельного scope `analytics:read` нет.
- **Экспорт:** CSV — RFC 4180 + BOM + строка `TOTAL` при непустой группировке; JSON — сам `AnalyticsReport`;
  серверных PDF/XLSX нет, PDF — печать браузера.
- **Retention** настраивается (`analytics.retentionDays`), а не фиксированные ~400 суток; прунер — на старте и
  каждые 6 ч. Запись best-effort и в деградированном режиме хранилища выключена.

### 1.4. Вне scope / остатки

Лимиты, квоты и алерты (отдельное решение); часовые роллапы; service-key scope `analytics:read`; серверная
шаблонизация HTML→PDF; взаимодействие с soft-delete/retention сообщений (PROP-074); фильтр по `provider` в
API; пересборка `decision` при появлении постоянного источника истории.

---

## 2. Оси атрибуции

Роллап — **бакет** по ключу `(family, day, dimensions)`, где `dimensions` — отсортированный набор измерений.
Единица времени — **сутки UTC** (`YYYY-MM-DD`), не TZ инстанса.

| Семейство | Оси | Меры |
|---|---|---|
| `usage` | `day`, `userId`, `projectId`, `model`, `agentRole` | токены in/out/cache, стоимость по валютам (`costByCurrency`), вызовы |
| `activity` | `day`, `userId`, `projectId` | `sessions_created`, `sessions_archived`, `messages_user`, `messages_assistant`, `messages_tool`, `tool_calls`, `errors`, `aborts`, `turns` |
| `decision` | `day`, `provider`, `model` | `calls`, `handled`, `fallback`, `escalated`, `attempts`, `rejected` |
| `prompt` | `day`, `model`, `agentRole` | производные от `usage` (`cache_hit_rate`, доля reasoning-токенов, `output_tps`) — отдельной записи не требуют |

Измерения, введённые в реестре: `day`, `user`, `project`, `model`, `agent`, `provider` (см.
`AnalyticsDimension` в `packages/shared/src/types/analytics.ts`).

**Осознанно не вводим:** `session` и `provider` как оси семейства `usage` — детализация до сессии/провайдера
множит кардинальность бакетов (одна сессия × сутки), а `provider` однозначно выводится из конфига модели;
сессионный срез берётся из `GET /api/v2/sessions/:id/stats` (ADR-070) и gateway-аудита, а не из роллапов.

**Кардинальность.** Оси `project`/`user` — низкоразмерные по построению (проекты и пользователи инстанса);
лейблы `session_id`/`user_id` в метриках запрещены (ADR-094), но в **значениях бакетов** измерения `userId`/
`projectId` — часть ключа, а не лейбл.

---

## 3. Швы записи

Роллап инкрементируется там, где значение уже известно; отдельного источника истины нет.

| Семейство | Шов | Код |
|---|---|---|
| `usage` | `computeMessageCost`, `publishLiveUsage` (событие `stream.usage`, троттлинг ~300 мс), `aggregateSubagentStats` | `packages/core/src/engine/orchestrator/usage.ts`, `packages/core/src/engine/orchestrator.ts` |
| `activity` | запись сообщения и жизненный цикл сессии/тула — через хук-шину (ADR-030) | `packages/core/src/analytics/hooks.ts`, `packages/core/src/engine/hooks/hook-bus.ts` |
| `decision` | персист decision-метрик (ADR-084) | `packages/core/src/engine/router/decision-metrics.ts`, `packages/core/src/engine/events/decision-rule-provider.ts` |
| `prompt` | сборка промпта и usage провайдера (ADR-070) | `packages/core/src/engine/context/composer.ts`, `packages/core/src/engine/orchestrator/usage.ts` |

**Запись — идемпотентный upsert по ключу** `(family, day, dimensions)` с инкрементом (ADR-102 §3). Ошибка
порта **не ломает ход** сессии — сбор best-effort. В деградированном режиме хранилища (ADR-098) запись
выключена.

**Типизация событий.** Швы приходят через `HookBus`; оси атрибуции (`user`/`project`) и признаки
«сессия архивирована, а не удалена» передаются в полях хука (`packages/shared/src/types/hooks.ts`).

---

## 4. Семейства отчётов и выводы

### 4.1. API (только чтение)

```text
GET /api/v2/analytics/summary?from&to
GET /api/v2/analytics/usage?from&to&groupBy=day|user|project|model|agent&userId&projectId
GET /api/v2/analytics/activity?...
GET /api/v2/analytics/decision?...
GET /api/v2/analytics/prompt?...
GET /api/v2/analytics/export?report=usage|activity|decision|prompt&format=csv|json&...
```

Мутирующих ручек нет. Контракт — [docs/API_V2.md](./API_V2.md) §5.32.

### 4.2. Фабрика роутов

`createAnalyticsRoutes` — core-фабрика (паттерн `create*Routes`; backend монтирует и добавляет только RBAC/
специфику — переиспользуемые роуты, `AGENTS.md` §«Слои зависимостей»). Файлы:
`packages/core/src/server/routes/analytics.ts`, монтирование — `packages/core/src/server/app/mount-routes.ts` и
`packages/backend/src/app/mount-routes.ts`.

### 4.3. RBAC

| Роль | `summary` / `decision` | `usage` / `activity` / `prompt` | `export` |
|---|---|---|---|
| `ADMIN`, `LEAD` | сквозной обзор | сквозной обзор | сквозной экспорт |
| `AUDITOR` | чтение | чтение | чтение |
| `USER` | **403** (`errors.forbidden.analytics`) | принудительный фильтр по своей оси `user` | фильтр по своей оси `user`; экспорт `decision` → 403 |

Экспорт приравнен к чтению (мутаций нет, отдельного права не требует). Service-key scope `analytics:read`
(ADR-052) **не вводится** — не расширять поверхность раньше спроса.

### 4.4. Выводы (дериваты)

Дериваты считаются сервисом **на чтении** (`packages/core/src/analytics/derive.ts`): `cache_hit_rate`,
`output_tps`, итоги по валютам, средние и доли. В хранилище — сырые счётчики; дублировать денормализованные
значения нельзя (расходится с сырым счётчиком).

---

## 5. Экспорт

- **Server-side, только данные.** Строка отчёта **не сочиняется сервером** → i18n в отчёте не дублируется
  (заголовки и форматирование делает клиент).
- **CSV** — RFC 4180 + BOM UTF-8; строка `TOTAL` при непустой группировке.
- **JSON** — сам `AnalyticsReport` (сырые счётчики).
- Отдача — `Content-Disposition: attachment`.
- **XLSX и серверный PDF — вне scope:** тянет зависимости/рендерер (инвариант 12); PDF закрывает печать
  браузера (`AnalyticsPrintReport.tsx`).

Реализация — `packages/core/src/analytics/export.ts`; UI-кнопки CSV/JSON — `AnalyticsModal.tsx`.

---

## 6. Backfill: `synth analytics rebuild`

```bash
synth analytics rebuild [--from <date>] [--dry-run|--yes]
```

- **Идемпотентно:** повторный прогон не удваивает счётчики (бэкфилл пишет `set`, а не `increment`).
- **Источники:** стоимость/токены из `metadata.cost_usd`/`cost_currency` сообщений и из JSONL
  `{dataDir}/audit/llm-gateway.jsonl` (ADR-036). Политика: **сообщения — истина, журнал Gateway — только
  положительная добавка** (при расхождении сумм побеждают сообщения).
- **Что не пересобирается:** `decision` (истории метрик нет), `prompt` (пересобирать нечего). Ключи без
  источника не удаляются — их убирает retention.
- **Запись в `maintenance.jsonl` команда не делает.**
- Без `--yes` и без `--dry-run` — **отказ** (паттерн ADR-091/ADR-092).

Реализация — `packages/core/src/analytics/rebuild.ts`, `rebuild-command.ts`; runbook — [docs/MAINTENANCE.md](./MAINTENANCE.md).

---

## 7. Retention и приватность

- **Окно хранения** — `analytics.retentionDays` (default **400**; `<= 0` — без ограничения); env
  `SYNTH_ANALYTICS_RETENTION_DAYS`. Прунер — `packages/core/src/analytics/prune.ts`, по образцу
  `startEventJournalPruner` (на старте и каждые 6 ч).
- **Приватность.** Роллапы агрегированы: **нет** текста сообщений, содержимого промптов, ключей и PII в
  значениях. При добавлении новых измерений — правило низкой кардинальности в силе (ADR-094).
- **Отчёт без рейтингов** — согласовано с [PROP-063](./arch_decisions/prop-063-user-learning-metrics.md).
- **Взаимодействие со скрытием/retention сообщений** — [PROP-074](./arch_decisions/prop-074-soft-delete-retention.md)
  (вне объёма).

---

## 8. Открытые вопросы

**Закрыты реализацией волн 1–2.** Вопросы 1, 2, 4, 5 закрыты: сутки UTC и настраиваемое окно
(`analytics.retentionDays`); сообщения — истина, журнал Gateway — только положительная добавка; на PG —
`ON CONFLICT … DO UPDATE` без advisory-локов; scope `analytics:read` не вводился. Вопрос 3 — частично: бэкфилл
идемпотентен (`set`), живая запись — инкремент по сообщению, отдельного дедупа нет. Вопрос 6 остаётся
открытым: сейчас PDF — печать браузера, серверной шаблонизации нет.

1. **Окно и гранулярность.** Сутки UTC зафиксированы; нужны ли часовые роллапы (дороже по объёму) или суточных
   достаточно для UI-дашборда? Окно хранения — фиксированные ~400 суток или настройка в конфиге? — *окно
   настраивается (`analytics.retentionDays`), часовые роллапы не вводились*.
2. **Бэкфилл-источник.** Считать ли источником только сообщения (`metadata.cost_usd`) или дополнительно парсить
   `audit/llm-gateway.jsonl` — и что делать при расхождении сумм? — *закрыто: сообщения — истина, журнал —
   положительная добавка*.
3. **Идемпотентность записи.** Хватит ли upsert-инкремента, или нужен «умный» пересчёт при повторной обработке
   того же сообщения (риск двойного счёта при ретрае)? — *частично: бэкфилл идемпотентен (`set`), живая запись —
   инкремент по сообщению*.
4. **Мульти-инстанс/PG.** На PG роллапы — конкурентные upsert'ы; достаточно ли `ON CONFLICT` без advisory-lock
   (ср. `StorageContext.locks`)? — *закрыто: достаточно*.
5. **Service-key scope.** Вводить ли `analytics:read` сразу для внешних отчётов или ждать спроса? — *не вводим*.
6. **Печатный отчёт.** Браузерная печать достаточна, или нужна серверная шаблонизация (HTML→PDF)? — *открыто*.

---

## Связи

- [ADR-102](./arch_decisions/adr-102-analytics-reports.md) «Аналитика и отчётность инстанса» — решение.
- [ADR-005](./arch_decisions/adr-005-json-storage.md) — атомарная запись/JSON-хранилище.
- [ADR-030](./arch_decisions/adr-030-hooks-agent-events.md) — хук-шина как шов записи `activity`.
- [ADR-036](./arch_decisions/adr-036-llm-gateway.md) — журнал LLM Gateway: источник бэкфилла.
- [ADR-052](./arch_decisions/adr-052-public-api-platform.md) — service-key/scopes (возможный `analytics:read`).
- [ADR-070](./arch_decisions/adr-070-system-prompt-composer.md) — статистика usage (основа семейства `prompt`).
- [ADR-072](./arch_decisions/adr-072-settings-ui-kit.md) — контракт панелей настроек/UI-кита.
- [ADR-084](./arch_decisions/adr-084-decision-models-clef.md) — decision-метрики (семейство `decision`).
- [ADR-091](./arch_decisions/adr-091-backup-restore-transfer.md) / [ADR-092](./arch_decisions/adr-092-instance-lifecycle-maintenance.md) —
  паттерн CLI-команд и миграции схемы.
- [ADR-094](./arch_decisions/adr-094-observability-metrics.md) — эксплуатационные метрики (соседний контур).
- [ADR-096](./arch_decisions/adr-096-storage-layer.md) / [ADR-097](./arch_decisions/adr-097-storage-provider-class.md) —
  доменный порт и БД-реализация.
- [PROP-063](./arch_decisions/prop-063-user-learning-metrics.md) — метрики без рейтингов.
- [PROP-074](./arch_decisions/prop-074-soft-delete-retention.md) — скрытие/retention сообщений.
- [docs/API_V2.md](./API_V2.md) §5.32 — HTTP-контракт.
- [docs/CONFIGURATION.md](./CONFIGURATION.md) — секция `analytics`.
- [docs/MAINTENANCE.md](./MAINTENANCE.md) — runbook `synth analytics rebuild`.

## История

- 2026-10-22 — документ создан: детали вынесены из [ADR-102](./arch_decisions/adr-102-analytics-reports.md)
  в spec-дом (реализация и остатки, оси атрибуции, швы записи, семейства отчётов и выводы, экспорт, backfill,
  retention и приватность, открытые вопросы).

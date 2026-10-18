# PROP-102: Аналитика и отчётность инстанса

> **Статус:** 🧩 Предложение — ввести пред-агрегированные роллапы и отчётный контур (API + UI) поверх уже существующих счётчиков usage/стоимости; лимиты и алерты — отдельно
> **Реализация:** волна 1 (данные/API/CLI/PG/docs) и волна 2 (UI) реализованы; лимиты, квоты, алерты и серверный PDF/XLSX остаются вне scope (см. «Реализация и остатки»)
> **Решение до:** 2026-11-14
> **Дата:** 2026-10-18
> **Класс:** предложение ([ARCH_DECISIONS.md](../ARCH_DECISIONS.md) §1–2): решения нет — есть гипотеза, швы записи и поэтапный план; канонический статус-токен остаётся `🧩 Предложение` (проверяется `scripts/adr-check.mjs`), фактическое состояние волн 1–2 — ниже.
> **Связано:** [ADR-005](./adr-005-json-storage.md), [ADR-030](./adr-030-hooks-agent-events.md), [ADR-036](./adr-036-llm-gateway.md), [ADR-052](./adr-052-public-api-platform.md), [ADR-070](./adr-070-system-prompt-composer.md), [ADR-072](./adr-072-settings-ui-kit.md), [ADR-084](./adr-084-decision-models-clef.md), [ADR-091](./adr-091-backup-restore-transfer.md), [ADR-092](./adr-092-instance-lifecycle-maintenance.md), [ADR-096](./adr-096-storage-layer.md), [ADR-097](./adr-097-storage-provider-class.md), [PROP-032](./prop-032-history-storage-postgresql.md), [PROP-063](./prop-063-user-learning-metrics.md), [ADR-094](./adr-094-observability-metrics.md).

## Контекст

Первый реальный вопрос финансов при внедрении: «кто и сколько потратил, и как поставить лимит». Аудит по токенам у платформы уже есть — не хватает **отчётности по пользователю/проекту/модели** (лимиты и алерты — предмет отдельного предложения). Это пункт 4 «Уровня 1» в `ROADMAP_NEXT.md`; PROP закрывает только **отчётную** его часть.

Сегодня данные **уже собираются**, но не образуют отчёта:

- **Per-session агрегаты.** `computeSessionStats(session, deps)` (`packages/core/src/sessions/stats.ts`) считает разбивку по агентам/пользователям/сабагентам, `cost_by_currency`, `cache_hit_rate`, `output_tps`; рекурсия саб-агентов через тул `task` ограничена `MAX_SUBAGENT_DEPTH = 5`. Роут — `GET /api/v2/sessions/:id/stats` (`packages/core/src/server/routes/sessions.ts`, scope `sessions:read`). Это **периметр одной сессии**: сквозного среза «за период по всем сессиям» нет.
- **Запись usage/стоимости.** `computeMessageCost`, `resolveMessageModel`, `estimateUsage`, `publishLiveUsage` (событие `stream.usage`, троттлинг ~300 мс), `aggregateSubagentStats` (`packages/core/src/engine/orchestrator/usage.ts`); стоимость лежит в `metadata.cost_usd`/`cost_currency` сообщения (контракт — ADR-070 §2.6). Это **шов, куда можно встроить инкремент роллапа**.
- **Журнал LLM Gateway.** `AuditLogger`/`AuditEntry`/`readAuditLog` (`packages/core/src/engine/gateway/audit-logger.ts`) пишет JSONL `{dataDir}/audit/llm-gateway.jsonl` с полями `ts/type/sessionId/userId/provider/model/tokensIn/tokensOut/costUsd/reason` (ADR-036). Годится как **источник бэкфилла**, но это журнал запросов, а не агрегат.
- **Две разные фабрики `createAuditRoutes`.** Core (`packages/core/src/server/routes/audit.ts`) отдаёт `GET /api/v2/audit/security` и `/egress` на портах `SecurityAuditRepository`/`EgressRequestLogRepository` (guard `readGuard ?? requireAuth`, лимит ≤1000); backend (`packages/backend/src/routes/audit.ts`) отдаёт `GET /api/v2/audit` по LLM Gateway (RBAC ADMIN/AUDITOR, фильтры `userId`/`sessionId`/`since`/`until`, лимит 100/500) и `POST /api/v2/audit/revealed`. **Отчётности по стоимости здесь нет** — есть просмотр записей.
- **Decision-метрики — in-memory.** `decisionMetrics` (`packages/core/src/engine/router/decision-metrics.ts`, ADR-084) — процесс-глобальный синглтон со снимком `calls/handled/fallback/escalated/attempts/rejected/by_model`; **не персистится** (теряется при рестарте, нет истории) → мотив отдельного семейства `decision`.
- **UI-дашборд — заглушка.** `packages/ui/src/components/admin/DashboardPanel.tsx` показывает 4 счётчика (sessions/projects/users/version) через `synthApi.getSessions/getProjects/getUsers` — без периода, без стоимости, без детализации.
- **Слой хранения (ADR-096).** Домен работает через доменные порты `packages/core/src/storage/ports/*`; контракт — suite `packages/core/src/storage/contract/*`; опциональный драйвер БД — `@itphx/synth-storage-postgres` (`src/ports`, `src/schema.ts`, `src/migrations`, ADR-097/PROP-032). Новое хранилище вводится **как порт**, а не прямой записью в `$SYNTH_DATA_DIR` (инвариант 2).

Итог: агрегаты есть «в моменте» и «по одной сессии»; **исторического, срезного и выгружаемого отчёта нет**. Ставить на это отдельный внешний BI нельзя — самохостящийся инстанс должен давать отчёт сам.

## Решение

Ввести **контур аналитики и отчётности** на базе **пред-агрегированных суточных роллапов**; отчёт — производное чтение, а не пересчёт истории на каждый запрос.

1. **Порт `AnalyticsRollupRepository`** — новый доменный порт слоя хранения (ADR-096): upsert/инкремент роллапа и чтение срезов/серий с фильтрами. Единственная точка доступа к роллапам для домена; файловая (`FileStore`/`JsonStore`, ADR-005) и in-memory-реализации обязаны проходить контрактный suite. Прямой записи в `$SYNTH_DATA_DIR` в обход порта нет (инвариант 2).
2. **Семейства роллапов** — четыре, с собственными измерениями и мерами. **Единица роллапа — сутки в UTC** (принято; не TZ инстанса):
   - `usage` — токены (in/out/cache) и стоимость по осям `day, userId, projectId, model, agentRole`; сырые счётчики. `session` и `provider` как оси **не вводим**: детализация до сессии/провайдера множит кардинальность бакетов (одна сессия × сутки), а `provider` однозначно выводится из конфига модели; при необходимости сессионный срез берётся из `GET /api/v2/sessions/:id/stats` (ADR-070) и gateway-аудита, а не из роллапов;
   - `activity` — по осям `day, userId, projectId`; меры `sessionsCreated`, `sessionsArchived`, `messagesUser`, `messagesAssistant`, `messagesTool`, `toolCalls`, `errors`, `aborts`, `turns` (`agent` в осях не участвует);
   - `decision` — метрики decision-слоя (ADR-084) как **персистентная** замена in-memory снимка; оси `day, provider, model`, меры `calls, handled, fallback, escalated, attempts, rejected` (модель — уже ось, `by_model` мерой не дублируется);
   - `prompt` — оси `day, model, agentRole`; меры производные от `usage` (`cacheHitRate`, доля reasoning-токенов, output tps) — отдельной записи не требуют.
   Хранилище держит **сырые счётчики**; дериваты (`cache_hit_rate`, `output_tps`, итоги по валютам) считает сервис **на чтении**.
3. **Швы записи** — роллап инкрементируется там, где значение уже известно: `computeMessageCost`/`publishLiveUsage`/`aggregateSubagentStats` (`usage`), запись сообщения и жизненный цикл сессии/тула (`activity`, через hook-шину ADR-030), персист decision-метрик (`decision`), сборка промпта и usage провайдера (`prompt`). Запись — **идемпотентный upsert по ключу** `(family, day, dimensions)` с инкрементом; отдельного источника истины не заводим.
4. **API `createAnalyticsRoutes`** — core-фабрика (паттерн `create*Routes`; backend монтирует и добавляет только RBAC/специфику — переиспользуемые роуты, `AGENTS.md` §«Слои зависимостей»). Поверхность — **только чтение**, явные роуты:
   ```text
   GET /api/v2/analytics/summary?from&to
   GET /api/v2/analytics/usage?from&to&groupBy=day|user|project|model|agent&userId&projectId
   GET /api/v2/analytics/activity?...
   GET /api/v2/analytics/decision?...
   GET /api/v2/analytics/prompt?...
   GET /api/v2/analytics/export?report=usage|activity|decision|prompt&format=csv|json&...
   ```
   Мутирующих ручек нет.
5. **UI-отчёт (волна 2)** — **отдельное лениво монтируемое модальное окно `AnalyticsModal`** по образцу `LogsModal` (`packages/ui/src/App.tsx`), а не раздел админ-«Панели»; `DashboardPanel.tsx` **не трогаем и не заменяем**. Вкладки: **Расход и стоимость · Активность · Decision · Кэш и эффективность**. Фильтры: пресеты `7d`/`30d`/`90d`/`custom` + селекты user/project/model/agent. Кнопки **CSV**, **JSON** и «Сформировать отчёт» (печать браузера → PDF). Вход — **меню пользователя и кнопка в правой панели**.
6. **Форматы экспорта** — server-side и **только данные**: **CSV** (RFC 4180, BOM UTF-8) и **JSON** (сырые счётчики), отдача с `Content-Disposition: attachment`. Строки отчёта сервер **не сочиняет** → **i18n в отчёте не дублируется** (заголовки и форматирование делает клиент). **XLSX и серверный PDF — вне scope** (браузерная печать закрывает PDF; новых зависимостей не вводим без отдельного решения — инвариант 12).
7. **RBAC** — личные данные (свои сессии) — владельцу; сквозной обзор — `LEAD`/`ADMIN`; `AUDITOR` — чтение. Инстанс-широкие отчёты — `LEAD`/`ADMIN`. **Экспорт приравнен к чтению** (мутаций нет, отдельного права не требует). На будущее — service-key scope `analytics:read` (ADR-052), сейчас **не вводим** (не расширять поверхность раньше спроса).
8. **Retention и приватность** — роллапы агрегированы: **нет** текста сообщений, содержимого промптов, ключей и PII в значениях (принцип ADR-094: низкая кардинальность). Окно хранения — секция **`analytics.retentionDays`** (config, default **400**), чистка по образцу `startEventJournalPruner`. Дериваты не персистятся; отчёт «без рейтингов» (созвучно PROP-063). Взаимодействие с soft-delete/аудитом — PROP-074.
9. **PG-реализация** — в драйвере `@itphx/synth-storage-postgres` (ADR-097/PROP-032): таблица роллапов с PK по ключу и `ON CONFLICT … DO UPDATE` с инкрементом; на файловом backend — JSON/append-под портом. Контрактный suite (`packages/core/src/storage/contract/*`) расширяется семейством analytics (прогон против живой БД — `SYNTH_TEST_POSTGRES_DSN`).
10. **Бэкфилл** — `synth analytics rebuild [--from <date>] [--dry-run|--yes]`: идемпотентная пересборка роллапов из истории (стоимость/токены из `metadata.cost_usd`/`cost_currency` сообщений и из JSONL `{dataDir}/audit/llm-gateway.jsonl`, ADR-036). Без `--yes` (и без `--dry-run`) — **отказ** (паттерн ADR-091/ADR-092). Команда — по той же логике «сначала бэкфилл, потом чтение».
11. **Волны** — **волна 1:** PROP + shared-типы (+ Zod) + порт `AnalyticsRollupRepository` (memory + file + PG-драйвер + контрактный suite) + сборщики **всех четырёх** семейств (`usage`/`activity`/`decision`/`prompt`) на существующих швах + `AnalyticsService` + `createAnalyticsRoutes` (включая export CSV/JSON) + монтирование в core и backend с RBAC + `synth analytics rebuild` + docs + верификация; **волна 2:** только UI `AnalyticsModal` + i18n ru/en + входы (меню пользователя, правая панель) + печатный отчёт.

## Реализация и остатки

**Волна 1 (данные/API/CLI/PG/docs) — реализована.** Общие типы и Zod
(`packages/shared/src/types/analytics.ts`, `schemas/index.ts`), конфиг
`analytics.retentionDays` (default 400, env `SYNTH_ANALYTICS_RETENTION_DAYS`), порт
`AnalyticsRollupRepository` (`storage/ports/analytics-rollup-repository.ts`) с
файловой (`{dataDir}/analytics/rollups.json`), in-memory и PostgreSQL
(`analytics_rollups`, миграция 003) реализациями и контрактным suite
(`storage/contract/analytics.ts`); сборщики `analytics/{recorder,hooks,prune}.ts`,
сервис/дериваты/экспорт `analytics/{service,derive,export}.ts`, роуты
`server/routes/analytics.ts` (монтирование в core и backend с RBAC), CLI
`synth analytics rebuild` (`analytics/{rebuild,rebuild-command}.ts`) и документация
(API/CONFIGURATION/MAINTENANCE/AGENTS).

**Волна 2 (UI) — реализована.** Ленивый `AnalyticsModal`
(`packages/ui/src/components/analytics/*`), API-домен `lib/api/analytics.ts`,
входы — меню пользователя и правая панель; вкладки «Расход и стоимость»,
«Активность», «Decision», «Кэш и эффективность»; CSV/JSON и печать браузера
(`AnalyticsPrintReport` + `analytics-print.css`); `DashboardPanel` не заменялся.

**Осознанные отклонения от первоначального текста.**

- **Меры — snake_case** (`input_tokens`, `sessions_created`, …), а не camelCase из
  §2: паритет с `sessions/stats.ts` и сырыми счётчиками сообщений.
- **Ось `provider`** оставлена в реестре измерений и пишется семейством `decision`;
  проводка `usage` её сейчас не передаёт (ось опциональна), поэтому в отчётах
  `usage` она не наполняется. Фильтра `provider` в query нет.
- **`prompt` — проекция `usage` на чтении**, а не отдельная запись: своих мер нет,
  дефолтная группировка — `model,agent`; дериваты применяются к обоим семействам.
- **`activity`** пишется только по осям `user`/`project` (`day` — поле бакета), как и
  предполагалось; `agent` в её осях не участвует.
- **Бэкфилл:** `decision` не пересобирается (история метрик не хранится),
  `prompt` пересобирать нечего; ключи без источника не удаляются (их убирает
  retention); журнал Gateway — только положительная добавка к сообщениям; запись в
  `maintenance.jsonl` команда не делает.
- **RBAC:** обычному пользователю `summary`/`decision` (и экспорт `decision`) → 403,
  `usage`/`activity`/`prompt` — принудительный фильтр по его `userId`; `AUDITOR` —
  чтение всех отчётов; отдельного scope `analytics:read` нет.
- **Экспорт:** CSV — RFC 4180 + BOM + строка `TOTAL` при непустой группировке;
  JSON — сам `AnalyticsReport`; серверных PDF/XLSX нет, PDF — печать браузера.
- **Retention** настраивается (`analytics.retentionDays`), а не фиксированные ~400
  суток; прунер — на старте и каждые 6 ч. Запись best-effort и в деградированном
  режиме хранилища выключена.

**Вне scope / остатки.** Лимиты, квоты и алерты (отдельное предложение); часовые
роллапы; service-key scope `analytics:read`; серверная шаблонизация HTML→PDF;
взаимодействие с soft-delete/retention сообщений (PROP-074); фильтр по `provider` в
API; пересборка `decision` при появлении постоянного источника истории.

## Альтернативы

- **Считать отчёт «на лету» из сообщений и аудита** — не берём: O(история) на каждый запрос, растёт с объёмом данных и упирается в PG/FS при интерактивном UI; роллапы переносят цену на запись (там значение уже под рукой).
- **Только внешний BI по журналу** — не берём как замену: самохостящийся инстанс должен давать отчёт сам; внешний экспорт (syslog/CEF/SIEM) — отдельная тема и не противоречит роллапам.
- **Серверный PDF/XLSX** — отложено: тянет зависимости/рендерер (инвариант 12); браузерная печать и CSV/JSON закрывают спрос волн 1–2.
- **Пятое семейство «стоимость по пользователю» как отдельная сущность** — не нужно: это проекция `usage` по оси `user` на чтении.
- **Хранить дериваты (cache-hit, tps, итоги)** — не нужно: дублирование денормализованного значения расходится с сырым счётчиком; дериваты считаются сервисом.

## Последствия

- **Новый порт** → контрактный suite и все backend'ы (file/memory/postgres) обязаны его реализовать; добавление роллапа в PG-драйвер — миграция схемы (ADR-092/ADR-096).
- **Рост записи.** Каждое сообщение/ход добавляет upsert; на файловом backend это отдельная запись — на горячих инстансах стоит держать в буфере/инкрементить на уровне сообщения (троттлинг, как у `publishLiveUsage`).
- **Миграция decision-метрик** из in-memory в персистентное `decision`-семейство — поведенчески совместима (снимок остаётся), но появляется история.
- **Новый CLI-контур** `synth analytics rebuild` — идемпотентность обязана быть проверена (повторный прогон не удваивает счётчики).
- **Отчёты по стоимости** становятся основой для будущих лимитов/квот и алертов (вне scope) — роллапы сразу проектируются под эти оси.
- **Приватность.** Отчёт не содержит текста/промптов/PII; при добавлении новых измерений — правило низкой кардинальности в силе.

## Открытые вопросы

**Статус после волн 1–2.** Вопросы 1, 2, 4, 5 закрыты реализацией: сутки UTC и
настраиваемое окно (`analytics.retentionDays`); сообщения — истина, журнал Gateway —
только положительная добавка; на PG — `ON CONFLICT … DO UPDATE` без advisory-локов;
scope `analytics:read` не вводился. Вопрос 3 — частично: бэкфилл идемпотентен
(`set`), живая запись — инкремент по сообщению, отдельного дедупа нет. Вопрос 6
остаётся открытым: сейчас PDF — печать браузера, серверной шаблонизации нет.

1. **Окно и гранулярность.** Сутки UTC зафиксированы; нужны ли часовые роллапы (дороже по объёму) или суточных достаточно для UI-дашборда? Окно хранения — фиксированные ~400 суток или настройка в конфиге?
2. **Бэкфилл-источник.** Считать ли источником только сообщения (`metadata.cost_usd`) или дополнительно парсить `audit/llm-gateway.jsonl` — и что делать при расхождении сумм?
3. **Идемпотентность записи.** Хватит ли upsert-инкремента, или нужен «умный» пересчёт при повторной обработке того же сообщения (риск двойного счёта при ретрае)?
4. **Мульти-инстанс/PG.** На PG роллапы — конкурентные upsert'ы; достаточно ли `ON CONFLICT` без advisory-lock (ср. `StorageContext.locks`)?
5. **Service-key scope.** Вводить ли `analytics:read` сразу для внешних отчётов или ждать спроса (сейчас — нет)?
6. **Печатный отчёт.** Браузерная печать достаточна, или нужна серверная шаблонизация (HTML→PDF) в волне 3?

## Связи

- [ADR-005](./adr-005-json-storage.md) — атомарная запись/JSON-хранилище: как роллапы ложатся на файловый backend.
- [ADR-030](./adr-030-hooks-agent-events.md) — хук-шина как шов записи `activity` (session/tool lifecycle).
- [ADR-036](./adr-036-llm-gateway.md) — журнал LLM Gateway: источник бэкфилла и родственный контур аудита.
- [ADR-052](./adr-052-public-api-platform.md) — service-key/scopes: возможный `analytics:read` в будущем.
- [ADR-070](./adr-070-system-prompt-composer.md) — статистика usage и тиры промпта (основа семейства `prompt`).
- [ADR-072](./adr-072-settings-ui-kit.md) — контракт панелей настроек/UI-кита для раздела «Аналитика».
- [ADR-084](./adr-084-decision-models-clef.md) — decision-метрики, переносимые в персистентное семейство `decision`.
- [ADR-091](./adr-091-backup-restore-transfer.md) / [ADR-092](./adr-092-instance-lifecycle-maintenance.md) — паттерн CLI-команд (`--dry-run`/`--yes`), миграции схемы под порт.
- [ADR-096](./adr-096-storage-layer.md) / [ADR-097](./adr-097-storage-provider-class.md), [PROP-032](./prop-032-history-storage-postgresql.md) — доменный порт и БД-реализация.
- [ADR-094](./adr-094-observability-metrics.md) — эксплуатационные метрики (низкая кардинальность): соседний, не пересекающийся контур.
- [PROP-063](./prop-063-user-learning-metrics.md) — метрики без рейтингов: согласование приватности отчёта.

## История

- 2026-10-18 — **реализованы волны 1–2.** Волна 1: shared-типы/Zod, конфиг
  `analytics.retentionDays` (400), порт `AnalyticsRollupRepository` (file/memory/PG +
  миграция 003 + контрактный suite), сборщики четырёх семейств на существующих швах
  (best-effort, в деградации выключены), `AnalyticsService` с дериватами на чтении,
  `createAnalyticsRoutes` (summary/usage/activity/decision/prompt/export, RBAC),
  `synth analytics rebuild` (идемпотентный `set`-бэкфилл `usage`/`activity`), docs.
  Волна 2: ленивый `AnalyticsModal` (4 вкладки, пресеты, фильтры, CSV/JSON,
  печать браузера), входы из меню пользователя и правой панели; `DashboardPanel` не
  заменялся. Уточнены отклонения: меры snake_case, `prompt` — проекция `usage`,
  `decision` не пересобирается, retention настраиваемый (+env), USER → 403 на
  `summary`/`decision`; лимиты/квоты/алерты, часовые роллапы, `analytics:read` и
  серверный PDF/XLSX — вне scope. Канонический статус-токен оставлен `🧩 Предложение`.
- 2026-10-18 — документ создан: зафиксированы порт `AnalyticsRollupRepository`, четыре семейства роллапов, швы записи, фабрика `createAnalyticsRoutes`, UI-отчёт (волна 2), форматы CSV/JSON + печать браузера, RBAC, retention/приватность, PG-реализация, бэкфилл `synth analytics rebuild` и волны 1–2.

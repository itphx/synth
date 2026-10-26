# @itphx/synth-storage-postgres

> Точечные правила пакета. Общие инварианты, команды и стиль — в корневом
> [AGENTS.md](../../AGENTS.md); класс расширения и форма поставки —
> [ADR-097](../../docs/arch_decisions/adr-097-storage-provider-class.md),
> [ADR-097](../../docs/arch_decisions/adr-097-storage-provider-class.md);
> единый слой хранения — [ADR-096](../../docs/arch_decisions/adr-096-storage-layer.md).

## Роль и границы

Опциональный in-tree драйвер **слоя хранения** (класс расширения `storage`,
ADR-097): реализация доменных портов `StorageContext` (`packages/core/src/storage/ports/*`)
поверх PostgreSQL. Второй (selectable) backend — не замена файлового
(`file` остаётся дефолтом standalone/локального home, ADR-005).

- Публичная функция — `createPostgresStorage(config): Promise<StorageContext>`
  (форма — ADR-096 §«Решение»). Как и `createStorageContext`, она **не** создаёт
  модульных синглтонов: каждый вызов возвращает собранный контекст.
- `@itphx/synth-shared` — **обычная зависимость** (`dependencies`): доменные типы
  и утилиты (`Session`/`Message`/`Project`/`ProfileData`, `generateId`/`nowISO`,
  `normalizeIconKey`/`normalizeColorKey`, `makeTextPart`/`buildContentFromParts`,
  реестры/константы `SKILL_NAME_*`, `MCP_REGISTRY_SCHEMA_VERSION`, `GlobalRole`)
  импортируются **статически**. Цикла нет: `shared → driver`.
- **Синхронные данные core — инъекция, а не обход `exports`-карты.** Sync-геттеры
  портов (`secretPatterns`/`protectedPaths`/`dictionaries`) работают на горячем
  пути и не могут ждать I/O или ленивый `import()`. Core собирает эти значения у
  себя (`DEFAULT_PATTERNS`, `definitions/protected-paths.json`, системный
  `DictionaryStore`) в `packages/core/src/storage/storage-context.ts` и передаёт
  драйверу в конфиге (поле `coreSync` → `PortDeps.coreSync`); при прямом вызове
  `createPostgresStorage` (контрактный suite, внешний потребитель) тот же набор
  собирается ленивым `import('@itphx/synth-core')` в `ports/core-sync.ts`.
  `createRequire`/`import.meta.resolve`-трюки и зависимость от версии Node
  запрещены.
- `@itphx/synth-core` — **`peerDependencies` + `devDependencies`**. Импорт типов
  портов/`StorageContext` — только `import type`. Это разрывает цикл core ↔ драйвер:
  core держит драйвер в `optionalDependencies` и подключает его динамическим
  `import()` по `storage.backend === 'postgres'`, бандлить драйвер в `cli.js` нельзя.
  Цикл **намеренный** и разрешён `ignoreWorkspaceCycles: true` в корневом
  `pnpm-workspace.yaml` (pnpm ≥12 иначе роняет рекурсивные `pnpm typecheck`/`lint`/`test`
  с `ERR_PNPM_TASK_CYCLE`; между задачами зависимостей нет).
  **Осознанное исключение** (волна 3a): FS/package-bound порты (`skills`,
  `contextFiles`, `blobs`) отдаются **файловыми реализациями** `core`
  (`createFileStorage`), поэтому `storage-context.ts` импортирует `core` рантаймом.
  Импорт core — только за файловыми портами; порты БД тянутся core'ом динамически
  (`import()` по строке), статической зависимости core от драйвера нет. Runtime-хелперы
  core (доменные ошибки, крипто) в остальных портах грузятся **ленивым**
  `import()` внутри async-методов.
- `pg` — **`optionalDependencies`**: отсутствие драйвера не ломает импорт модуля
  (`pool.ts` подключает его лениво, `import()` внутри функции), а standalone/локальный
  home не тянут БД. Типы — `@types/pg` в `devDependencies`.

## Текущий статус

Волна **3a — инфраструктура драйвера** (готова): пул/подключение, схема БД и
миграции, сборка контекста. Волна **3b — порты** (готова): все доменные порты
`StorageContext` реализованы и проходят контрактный suite
(`packages/core/src/storage/contract/postgres.test.ts` → 145/145 против
живого PostgreSQL 17). Проводка домена — через `storage.backend = postgres`.

**Текущий статус (сводно).** Реализованы: 40 из 40 доменных портов (группы
`ports/*`; включая `analyticsRollups` — ADR-102 и `projectPipelines`/`pipelineRuns` —
ADR-101, SQL-реализация поверх `pipeline_specs`/`pipeline_versions`/`pipeline_runs`/
`pipeline_run_events`, а также `pluginAudit` — ADR-090 и `pluginLock` — PROP-068 §4.4 /
ADR-090), лёгкие выборки `@future-backend` (в т.ч. `listLight`/`loadLight` — метаданные
сессий без истории, `ports/sessions.ts`), точечная запись сообщений `appendMessage`/`updateMessage`
(одна строка `messages` в транзакции под per-session advisory-локом; `save` остаётся полной заменой
истории для импорта/ветвления), координация на session-level
advisory-локах (`PgMutex`/`PgLeader`, `StorageContext.locks`), обслуживание
(`health`-probe, `schemaMigrations` (plan/apply), `purgeSchema` — `--purge-db`),
перенос данных между backend'ами (`synth storage migrate`) и деградированный
режим (надстройка core, ADR-098). **Остаток:** `kind:"storage"` в едином
манифесте расширений (ADR-097) и установка сторонних драйверов-хранилищ
(сейчас in-tree-драйвер из коробки).

**Порт инвентаря worktree'ов** (`WorktreeRepository`, ADR-114) — **реализован**:
`ports/worktrees.ts`, generic-таблица `documents` (`kind='worktree'`, ключ — `id`
записи, значение — запись целиком); **новая миграция не нужна** (`kind` — свободный
текст без CHECK-ограничений). Семантика — как у файловой/в-памяти реализаций:
upsert с неизменным `createdAt`, `list` — «свежие первыми» по `createdAt`
(сортировка в драйвере, объём коллекции мал), `delete` идемпотентно,
`deleteByProject` — `DELETE … RETURNING` (число удалённых). Контрактный suite —
`storage/contract/worktree-repository.contract.ts` (file/memory/PG).

**Порт внешних доступов** (`ExternalCredentialRepository`, ADR-105 Ф1) — **реализован**:
`ports/external-credentials.ts`, таблица `external_credentials` (миграция `011`),
колонки `secret_enc`/`refresh_enc` (готовый токен `enc:v1:…`); шифрование — только
core-хелперами `encryptSecret`/`decryptSecret` через ленивый `import()`
(как у SSH-ключей), наружу отдаются только метаданные с маской (`toExternalCredentialMeta`).
Контрактный suite — `storage/contract/external-credential-repository.contract.ts`
(file/memory/PG).

- **Подключение (`pool.ts`).** `createPostgresConnection(config)` → `PostgresConnection`
  с ленивым `pg.Pool` (модуль `pg` не required на импорте). Дефолты: `poolMax=10`
  (session-advisory-локи держат соединения), `statement_timeout=15s`,
  `idle_in_transaction_session_timeout=60s`, `application_name=synth`; схема —
  первая в `search_path`. Публичные примитивы: `query`, `withTransaction(fn)`,
  `withAdvisoryLock(key, fn)` (session-level, выделенное соединение),
  `tryAdvisoryLock(key, fn)`, `acquireHeldClient()` (выделенное соединение,
  удерживаемое вызывающим, + `onError`-детект разрыва — для долгоживущих
  advisory-локов). Сырые ошибки `pg` маппятся в доменные классы
  (`mapPgError`): `23505` → `PostgresUniqueViolationError`, `42P01` →
  `PostgresUndefinedTableError`, `55P03` → `PostgresLockTimeoutError`, сетевые
  (класс `08`/`57P0x`/`ECONNREFUSED`/…) → `PostgresConnectionError`, прочее →
  `PostgresQueryError`. Пароль — отдельным полем (`password`), в `config.yaml` не хранится (инвариант 13).
- **Схема и миграции (`migrations/*`, `migrate.ts`).** Свой контур версионирования
  (НЕ `meta.json`/ADR-092): таблица `synth_schema_migrations(version int PK, id text,
  applied_at timestamptz)` в схеме драйвера. SQL-миграции — **inline TS-строки**
  (`src/migrations/001-init.ts`, `002-egress-audit.ts`, `003-analytics-rollups.ts`,
  `004-pipeline-engine.ts`, `005-pipeline-provenance.ts`, `006-plugin-audit.ts`,
  `007-plugin-lock.ts`, `008-plugin-audit-scan.ts`, `009-plugin-lock-previous.ts`,
  `010-plugin-lock-mode.ts`, `011-session-steer-inbox.ts`, `012-external-credentials.ts`,
  `014-session-mode-by-principal.ts`, `015-authority.ts`) — `tsc` эмитит их в `dist`, шаги копирования SQL не нужны.
  Миграции **006–009** — слой плагинов (PROP-090): `006_plugin_audit` (таблица `plugin_audit`,
  `seq bigserial` — порядок «свежие первыми»), `007_plugin_lock` (таблица `plugin_lock`, PK — имя
  плагина; upsert — `ON CONFLICT`; `installed_at` при перезаписи сохраняется),
  `008_plugin_audit_scan` (`ALTER TABLE plugin_audit ADD COLUMN IF NOT EXISTS scan_performed boolean /
  scan_findings integer` — Ф2). `009_plugin_lock_previous` (долги Д2) — колонка `previous jsonb` (ступень отката версии в lock).
  `010_plugin_lock_mode` — колонка `mode` в `plugin_lock` (PROP-090 §«Managed deploy-time»).
  `012_external_credentials` — таблица `external_credentials` (ADR-105 Ф1: владелец/статус/срок/отзыв
  и колонки `secret_enc`/`refresh_enc` с готовым `enc:v1:…`). `014_session_mode_by_principal` —
  колонка `mode_by_principal jsonb` в `sessions` (ADR-106 Ф4: режим хода по принципалу).
  `015_authority` — таблицы Authority-слоя (ADR-106 Ф0/Ф1): `authority_policy` (одна строка
  `id='instance'`, документ политики — `jsonb`) и `authority_decisions` (append-only,
  `seq bigserial` — порядок «свежие первыми»; индексы по `action`/`effect`/`source`).
  Все идемпотентны.
  `runMigrations(conn, { schema })`: `CREATE SCHEMA IF NOT EXISTS` → advisory-лок
  (`synth:migrate:<schema>`) → применение по возрастанию версии (каждая миграция —
  в транзакции с записью версии). **Fail-closed**, если версия в БД **больше**
  ожидаемой (`STORAGE_POSTGRES_SCHEMA_TOO_NEW`). `migrate:false` (DBA-режим) —
  `assertSchemaCurrent` без применения: схема отстаёт/отсутствует →
  `STORAGE_POSTGRES_SCHEMA_OUTDATED`. `readSchemaVersion` — текущая версия.
- **Координация (`locks.ts`, ADR-097 волна 4).** `PgMutex implements Mutex` и
  `PgLeader implements SchedulerLeader` (типы — `@itphx/synth-core`, только
  `import type`) поверх session-level advisory-локов на выделенном соединении;
  ключ — детерминированный 64-битный хеш namespaced-имени (`synth:` + имя,
  `advisoryLockKeyToBigInt`), не пересекается с ключом миграций
  (`synth:migrate:<schema>`). `withLock` — ретраи `pg_try_advisory_lock` до
  `timeoutMs`, по истечении `warn` + выполнение без лока (паритет с `FileMutex`);
  при **недоступной БД** — понятная ошибка (не зависание). `PgLeader` держит
  соединение всё время лидерства (`touch()` — no-op), при разрыве соединения
  явно снимает лидерство (лог). Публикуется через `StorageContext.locks`
  (`createPostgresLocks`): core подставляет `PgMutex`/`PgLeader` при
  `storage.backend=postgres` (`scheduler.leaderElection: postgres`, лок миграций).
  **Риск пула:** удерживаемое соединение не возвращается в пул — держите не больше
  одного на процесс; `poolMax` по умолчанию 10 (`pool.ts`).
- **Сборка контекста (`storage-context.ts` + `src/ports/*`).** Порты разложены по
  восьми независимым файлам-группам (по одному владельцу-агенту на файл, волна
  реализации правит их параллельно и без конфликтов); каждая группа экспортирует
  одну фабрику, возвращающую свою часть `StorageContext`:
  - `ports/sessions.ts` → `buildSessionPorts(deps)` → `sessions`;
  - `ports/principals.ts` → `buildPrincipalPorts(deps)` → `projects`/`profiles`/
    `settings`/`defaults`/`providers`/`models`/`agents`;
  - `ports/events.ts` → `buildEventPorts(deps)` → `eventBindings`/`eventRoutes`/
    `eventApiKeys`/`eventJournal`/`identityClaims`/`dedup`/`schedules`/`jobs`/
    `webhooks`/`webhookDeliveries`;
  - `ports/content.ts` → `buildContentPorts(deps)` → `serviceKeys`/`sshKeys`/
    `mcpRegistry`/`skillBundles`/`dictionaries`/`secretPatterns`/`protectedPaths`/
    `maintenanceAudit`;
  - `ports/audit.ts` → `buildAuditPorts(deps)` → `securityAudit`/`egressRequests`;
  - `ports/analytics.ts` → `buildAnalyticsPorts(deps)` → `analyticsRollups`
    (ADR-102: таблица `analytics_rollups`, миграция 003 — PK
    `(family, day, dimensions)`, атомарный `INSERT … ON CONFLICT … DO UPDATE`
    с суммированием `jsonb`-мер без advisory-локов).
  - `ports/pipelines.ts` → `buildPipelinePorts(deps)` → `projectPipelines`/`pipelineRuns`
    (ADR-101: таблицы `pipeline_specs`/`pipeline_versions`/`pipeline_runs`/
    `pipeline_run_events`, миграция 004 — миграций данных нет, схема версионируется
    как обычно; `installed_by` добавлен миграцией 005, идемпотентной).
  - журнал аудита плагинов `pluginAudit` — **внутри** `ports/audit.ts`
    (`buildAuditPorts(deps)`; SQL-часть — `ports/plugin-audit.ts`, ADR-090: таблица
    `plugin_audit`, миграция 006; поля скана `scan_performed`/`scan_findings` — миграция 008).
  - `ports/plugin-lock.ts` → `buildPluginLockPorts(deps)` → `pluginLock`
    (PROP-068 §4.4 / ADR-090: таблица `plugin_lock`, миграция 007; ключ — имя
    плагина, `save` — upsert с сохранением `installed_at`, `list` — `ORDER BY name ASC`).
  - `ports/external-credentials.ts` → `buildExternalCredentialPorts(deps)` →
    `externalCredentials` (ADR-105 Ф1: таблица `external_credentials`, миграция 012;
    `secret_enc`/`refresh_enc` — готовый `enc:v1:…`; шифрование только core-хелперами
    через ленивый `import()`, как у SSH-ключей в `content.ts`).
  - `ports/authority.ts` → `buildAuthorityPorts(deps)` → `authorityPolicy`/
    `authorityDecisions` (ADR-106 Ф0/Ф1: таблицы `authority_policy` (одна строка
    `id='instance'`, документ — `jsonb`; upsert `ON CONFLICT`) и `authority_decisions`
    (append-only, `seq bigserial`; выборка «свежие первыми» с фильтрами
    `action`/`effect`/`source` и `limit`). Валидация документа — схема
    `authorityPolicySchema` из shared; невалидный документ читается как **отсутствие
    политики** (fail-closed на оси «user»).
  - `ports/worktrees.ts` → `buildWorktreePorts(deps)` → `worktrees` (ADR-114:
    generic-таблица `documents`, `kind='worktree'`, ключ — `id` записи; **без новой
    миграции**; `createdAt` при перезаписи не меняется — `jsonb_set` по сохранённому
    значению).

  Общий тип зависимостей — `PortDeps` (`ports/deps.ts`): `connection` (живой
  `PostgresConnection`), `dataDir`, `secretKey?`, `env?`, `systemDictionariesDir?`,
  `contextUserDataDir?`. `buildPostgresStorageContext` собирает контекст как
  `{ kind:'postgres', ...buildSessionPorts, ...buildPrincipalPorts,
  ...buildEventPorts, ...buildContentPorts, ...buildAuditPorts, ...buildAnalyticsPorts,
  ...buildAuthorityPorts, ...buildExternalCredentialPorts, ...buildPipelinePorts,
  skills/contextFiles/blobs, pipelines, packs, close }`;
  `skills`/`contextFiles`/`blobs` — **файловые** реализации `createFileStorage`
  (FS/package-bound, см. исключение выше); `pipelines`/`packs` (ADR-100/ADR-086 §5) —
  тоже **файловые** (SQL-реализации этих портов в драйвере пока нет). `ports/stub.ts`
  (`notImplementedPort`) оставлен как исторический экспорт, но портами не используется.
- **Схема — источник истины.** Ранее правили `001-init` **на месте** (схема была
  нигде не развёрнута); сейчас схема версионируется миграциями `001-init` →
  `002-egress-audit` → `003-analytics-rollups`. Выравнивание по домену:
  - **FK без референсной целостности сняты** (каскад — в коде, как в файловой
    реализации): `event_api_keys.binding_id` (чистит `removeByBinding`) и
    `webhook_deliveries.subscription_id` (чистит `webhooks.remove` в транзакции).
    Колонки и индексы по ним оставлены; «заглушки-родители»
    (`_ensureBinding`/`_ensureSubscription`) убраны.
  - `event_journal` — колонки `identity jsonb`/`dedup_key text`/`error text`/
    `principal_id text`; `list()` собирает `EventJournalEntry` из колонок (полная
    запись в `payload` больше не хранится).
  - `identity_claims` — колонки `chat_key text`/`principal_id text NOT NULL`;
    `principalId` персистится напрямую (не склейкой `provider:external_id`).
  - `profiles.interview_completed` — **nullable** (без `NOT NULL DEFAULT false`):
    отличаем «поле отсутствует (legacy)» от «явный false»; чтение воспроизводит
    `??`-семантику `FileProfileStore._deserialize` + backfill метки `[ИНТЕРВЬЮ]`
    (время завершения legacy — `updated_at`).
  - `messages` — **суррогатный** `message_uid bigserial PRIMARY KEY`: доменный
    `id` сообщения **не уникален** в пределах сессии (legacy-дубликаты допустимы),
    поэтому `id` — обычная колонка `text NOT NULL` с индексом `(session_id, id)`;
    `UNIQUE (session_id, seq)` сохранён как страховка порядка. `seq` —
    **позиционный**: драйвер нормализует его при записи по порядку массива
    (`1..n`), чтение — `ORDER BY session_id, seq, created_at, id` (детерминированный
    тайбрейкер для legacy-строк). Запись сообщений и child-таблиц в `save` — **полная
    замена в транзакции** (`DELETE … WHERE session_id` + массовый `INSERT` по
    чанкам); upsert по `id` для сообщений убран (он молча схлопывал дубликаты).
    Точечная запись (`appendMessage`/`updateMessage`) меняет одну строку `messages`
    (`INSERT … RETURNING *` / `UPDATE … WHERE message_uid`, транзакция + advisory-лок)
    и `sessions.updated_at`, не трогая остальную историю.
  - `session_references` — суррогатный `id text PK` + `ordinal int NOT NULL`
    (индекс `(session_id, ordinal)`); **дубликаты одной `ref_session_id`
    разрешены** (разные диапазоны), `addReference` — append, `getReferences` —
    `ORDER BY ordinal`, `removeReference` удаляет **все** совпадения
    (паритет с file/memory).
  - `ssh_keys` — `UNIQUE INDEX (lower(name))`: код делает предпроверку, БД
    гарантирует инвариант и закрывает гонку.
  - `projects` — нормализация `icon`/`color` **при чтении**
    (`normalizeIconKey`/`normalizeColorKey`), паритет с `ProjectStore.load`.
  - `pipeline_specs`/`pipeline_versions`/`pipeline_runs`/`pipeline_run_events` (ADR-101,
    миграция 004) — FK нет: удаление пайплайна чистит его версии **в коде** (паритет
    с файловой реализацией), прогоны удалению пайплайна не подвержены вовсе;
    `pipeline_versions` — иммутабельные снимки опубликованных спецификаций, ключ
    `(pipeline_id, version)`; `pipeline_runs.spec` — **снимок** спецификации на момент
    запуска (прогон самодостаточен и переживает удаление пайплайна);
    `pipeline_run_events.seq bigserial` — порядок добавления в журнал (append-only);
    провенанс установки — колонка `pipeline_specs.installed_by jsonb` (`{pack, version}`,
    nullable), добавлена **идемпотентной** миграцией 005.
- **Жизненный цикл соединения.** `createPostgresStorage` применяет/проверяет схему,
  удерживает соединение в `StorageContext` (`close?()` закрывает пул, **дождавшись**
  фонового прогрева кэшей `content`, зарегистрированного через опциональный
  `PortDeps.trackBackground`) и **не** закрывает пул сам — ресурсы освобождает домен
  на graceful shutdown. Контрактный
  suite `dispose` не вызывает, поэтому прогон чистит ресурсы в `afterEach`
  (`ctx.close()` + `DROP SCHEMA … CASCADE` + tmp-каталог).
- **DDL.** Все таблицы/индексы заведены сразу (`001_init`): `sessions` (jsonb-поля +
  partial/`updated_at DESC`-индексы), `messages` (нормализованные, суррогатный
  `message_uid bigserial PK`, `UNIQUE(session_id,seq)`, индекс `(session_id,id)`,
  `GIN(content gin_trgm_ops)` через `CREATE EXTENSION IF NOT EXISTS pg_trgm`),
  child-таблицы (`session_references`/`checkpoints`/`sticky_notes`), `projects`/
  `project_members`, `profiles`/`profile_identities`, `settings`/`token_ratios`/
  `migration_markers`, `documents`, события (`event_*`/`identity_claims`/`dedup`),
  `schedules`/`jobs`, `webhooks`/`webhook_deliveries` (`secret_enc bytea`), `ssh_keys`/
  `ssh_key_agents`, `service_keys`, `mcp_registry`, `skill_bundles`, `maintenance_audit`.
  Все времена — `timestamptz`; FK — только внутри инстанса (по `user_id`/`owner_id` FK нет);
  FK событийно-зависимых таблиц, мешавшие паритету, сняты — см. «Схема — источник истины».

## TLS соединения с PostgreSQL (ADR-099 × ADR-097)

Единый источник доверия — `security.tls` (ADR-099); драйвер **не** читает конфиг
сам, а получает уже собранные `ssl`-опции `pg` из shared-хелпера
`buildPostgresSslOptions` (резолверы `resolveTlsConfig`/`resolveTlsTrust`, см.
`packages/shared/AGENTS.md`). В `pool.ts` (`createPostgresConnection`):

- `storage.postgres.sslmode` (`disable` | `require` | `verify-full`; алиас
  `verify-ca` → `verify-full` с warn) — режим TLS; при `require`/`verify-full`
  CA и клиентский серт (mTLS) берутся из `security.tls` (`caFile`/`caPem`/
  `certFile`/`keyFile`). **Fail-closed:** `verify-full` без сконфигурированного CA
  бросает ошибку — никакого тихого `rejectUnauthorized:false`. Не задан — прежнее
  поведение (legacy-поле `ssl` либо без TLS), чтобы не ломать dev-сервер без TLS.
- **TLS-параметры в DSN запрещены** (`findDsnTlsParams`/`DSN_TLS_PARAMS`):
  `sslmode`/`sslrootcert`/`sslcert`/`sslkey`/… в `storage.postgres.dsn` отвергаются
  с внятной ошибкой. Причина — в `pg`: он накладывает распарсенный
  `connectionString` **поверх** явного конфига (`Object.assign({}, config,
  parse(connectionString))`), поэтому `sslmode` из DSN молча перекрывает
  переданный `ssl`-объект — вплоть до отключения TLS. Политика доверия задаётся
  только `storage.postgres.sslmode` + `security.tls`.

Позиционная нумерация `seq` (`UNIQUE(session_id, seq)`, нормализация `1..n` при
записи) — см. «Схема — источник истины» выше (не дублируется).

## Известные расхождения / ограничения

- **Sync-геттеры — процесс-локальный кэш.** `secretPatterns`/`protectedPaths`/
  `dictionaries` читаются синхронно из памяти; override прогревается из БД
  best-effort при сборке контекста и поддерживается **write-through** при
  мутациях. Правки override **другим процессом/инстансом** видны только после
  рестарта (кэш не инвалидируется по БД); короткое окно сразу после старта может
  отдать системный дефолт до завершения прогрева. Override хранится в
  `settings(key text PK, value jsonb)` — это соответствует замыслу порта
  («секции — в ключ-значение сторе»).
- **Retention `dedup` не реализован**: в порту `DedupRepository` нет метода
  prune (`seed` — no-op, durable-бэкенд хранит ключи сам), поэтому таблица
  `dedup` растёт без очистки.
- **Жизненный цикл `pg_trgm` при по-тестовой схеме** (воспроизведено на живом
  PostgreSQL 17 в контейнере `postgres:17-alpine`): миграция `001_init` делает
  `CREATE EXTENSION IF NOT EXISTS pg_trgm`, и при `search_path = <тестовая схема>`
  расширение создаётся **внутри** неё. Контрактный suite чистит состояние через
  `DROP SCHEMA … CASCADE` — это роняет расширение, следующая тестовая схема
  создаёт его заново, а закэшированный lookup опкласса `gin_trgm_ops` указывает на
  удалённый oid → падение с
  `operator class "gin_trgm_ops" does not exist for access method "gin"`
  (воспроизводится **без** кода слоя плагинов — это не регрессия Ф1/Ф2).
  **Обход:** расширение создаётся один раз **вне** тестовой схемы —
  `CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA public;` в базе прогона; тогда
  `DROP SCHEMA … CASCADE` его не трогает, а `search_path = <схема>, public`
  находит опкласс. С этим обходом весь контрактный suite core проходит против
  живой БД: 145/145 (в т.ч. `PG → PluginLockRepository` — 10/10,
  `PG → PluginAuditRepository` — 7/7, `PG → ExternalCredentialRepository` — 13/13).

## Критерий приёмки

Драйвер считается готовым, когда:

1. проходит контрактный suite `packages/core/src/storage/contract/*`
   («паспорт порта»; эталон семантики — memory-backend, ADR-096);
2. поддержаны эффективные выборки для методов `@future-backend` (лёгкие листинги
   без `messages`, фильтры/пагинация, транзакционные `consume`/`tryClaim`,
   уникальность `label`, prune по `ORDER BY`);
3. подключение работает через `storage.backend = postgres` без правок домена и
   роутов.

Границы этапа: maintenance (миграции/бэкап/restore), секреты в `dataDir` и
«ФС-периметр вне портов» (контент скиллов, промпты, аватары, audit `*.jsonl`,
workspace) остаются file-специфичными ([ADR-091](../../docs/arch_decisions/adr-091-backup-restore-transfer.md)/[ADR-092](../../docs/arch_decisions/adr-092-instance-lifecycle-maintenance.md)).

## Тесты и сборка

- Тесты колокейт: `src/**/*.test.ts` (Vitest); `pnpm --filter @itphx/synth-storage-postgres test`.
- **Интеграционный smoke-тест** (`src/postgres.integration.test.ts`) гейтится env
  `SYNTH_TEST_POSTGRES_DSN`: без него — `describe.skip`. С DSN — прогон против
  dev-Postgres: каждый тест создаёт **уникальную схему** (`synth_test_<random>`) +
  миграции, `afterEach` — `DROP SCHEMA … CASCADE`. Проверяет подключение,
  применение/идемпотентность миграций, fail-closed «версия новее», сборка
  контекста (реализованные порты отвечают, FS/package-bound — файловые).
  **Контрактный прогон портов** живёт в core — `packages/core/src/storage/contract/postgres.test.ts`
  (тот же гейт `SYNTH_TEST_POSTGRES_DSN`, уникальная схема на каждый `make()`,
  `vi.setConfig({ testTimeout: 30000 })` — миграции под параллельной нагрузкой):
  проходят **все** блоки контрактного suite (36 портов; `AnalyticsRollupRepository` — 11 блоков,
  `PluginLockRepository` — 10 блоков, `PluginAuditRepository` — 7 блоков,
  `ExternalCredentialRepository` — 13 блоков).
  Пример: `SYNTH_TEST_POSTGRES_DSN="postgres://synth:<pw>@127.0.0.1:5432/synth_test" pnpm --filter @itphx/synth-storage-postgres test`.
- Сборка: `pnpm --filter @itphx/synth-storage-postgres build` (`tsc -p tsconfig.build.json`);
  порядок релизной сборки — `shared → core → storage-postgres → ui → sdk → synth`
  (`scripts/build.sh`, `build:release`), публикации — `scripts/publish*.sh`.

## Чего не делать

- Не импортировать `pg` на верхнем уровне модуля (только ленивый `import()` внутри функции).
- Не тянуть core рантаймом **кроме** файловых FS/package-bound портов
  (`createFileStorage` в `storage-context.ts`) — типы и прочее только `import type`.
- Не добавлять собственных точек сборки хранения мимо `StorageContext`/портов (ADR-096).
- Не дублировать `local home`/файловые пути: драйвер получает `dataDir` из общего `StorageContextConfig`.
- Не хранить SQL-миграции как внешние ассеты — только inline TS-строки
  (`files: ["dist"]` публикуется без шага копирования).

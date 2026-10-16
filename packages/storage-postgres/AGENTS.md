# @itphx/synth-storage-postgres

> Точечные правила пакета. Общие инварианты, команды и стиль — в корневом
> [AGENTS.md](../../AGENTS.md); класс расширения и форма поставки —
> [ADR-097](../../docs/arch_decisions/adr-097-storage-provider-class.md),
> [PROP-032](../../docs/arch_decisions/prop-032-history-storage-postgresql.md);
> единый слой хранения — [ADR-096](../../docs/arch_decisions/adr-096-storage-layer.md).

## Роль и границы

Опциональный in-tree драйвер **слоя хранения** (класс расширения `storage`,
ADR-097): реализация доменных портов `StorageContext` (`packages/core/src/storage/ports/*`)
поверх PostgreSQL. Второй (selectable) backend — не замена файлового
(`file` остаётся дефолтом standalone/локального home, ADR-005).

- Публичная функция — `createPostgresStorage(config): Promise<StorageContext>`
  (форма — PROP-032 §«Решение»). Как и `createStorageContext`, она **не** создаёт
  модульных синглтонов: каждый вызов возвращает собранный контекст.
- `@itphx/synth-core` — **`peerDependencies` + `devDependencies`**. Импорт типов
  портов/`StorageContext` — только `import type`. Это разрывает цикл core ↔ драйвер:
  core держит драйвер в `optionalDependencies` и подключает его динамическим
  `import()` по `storage.backend === 'postgres'`, бандлить драйвер в `cli.js` нельзя.
  **Осознанное исключение** (волна 3a): FS/package-bound порты (`skills`,
  `contextFiles`, `blobs`) отдаются **файловыми реализациями** `core`
  (`createFileStorage`), поэтому `storage-context.ts` импортирует `core` рантаймом.
  Импорт core — только за файловыми портами; порты БД тянутся core'ом динамически
  (`import()` по строке), статической зависимости core от драйвера нет.
- `pg` — **`optionalDependencies`**: отсутствие драйвера не ломает импорт модуля
  (`pool.ts` подключает его лениво, `import()` внутри функции), а standalone/локальный
  home не тянут БД. Типы — `@types/pg` в `devDependencies`.

## Текущий статус

Волна **3a — инфраструктура драйвера** (готова): пул/подключение, схема БД и
миграции, сборка контекста. Реализация доменных портов — следующая волна.

- **Подключение (`pool.ts`).** `createPostgresConnection(config)` → `PostgresConnection`
  с ленивым `pg.Pool` (модуль `pg` не required на импорте). Дефолты: `poolMax=10`
  (session-advisory-локи держат соединения), `statement_timeout=15s`,
  `idle_in_transaction_session_timeout=60s`, `application_name=synth`; схема —
  первая в `search_path`. Публичные примитивы: `query`, `withTransaction(fn)`,
  `withAdvisoryLock(key, fn)` (session-level, выделенное соединение),
  `tryAdvisoryLock(key, fn)`. Сырые ошибки `pg` маппятся в доменные классы
  (`mapPgError`): `23505` → `PostgresUniqueViolationError`, `42P01` →
  `PostgresUndefinedTableError`, `55P03` → `PostgresLockTimeoutError`, сетевые
  (класс `08`/`57P0x`/`ECONNREFUSED`/…) → `PostgresConnectionError`, прочее →
  `PostgresQueryError`. Пароль — отдельным полем (`password`), в `config.yaml` не хранится (инвариант 13).
- **Схема и миграции (`migrations/*`, `migrate.ts`).** Свой контур версионирования
  (НЕ `meta.json`/ADR-092): таблица `synth_schema_migrations(version int PK, id text,
  applied_at timestamptz)` в схеме драйвера. SQL-миграции — **inline TS-строки**
  (`src/migrations/001-init.ts`) — `tsc` эмитит их в `dist`, шаги копирования SQL не нужны.
  `runMigrations(conn, { schema })`: `CREATE SCHEMA IF NOT EXISTS` → advisory-лок
  (`synth:migrate:<schema>`) → применение по возрастанию версии (каждая миграция —
  в транзакции с записью версии). **Fail-closed**, если версия в БД **больше**
  ожидаемой (`STORAGE_POSTGRES_SCHEMA_TOO_NEW`). `migrate:false` (DBA-режим) —
  `assertSchemaCurrent` без применения: схема отстаёт/отсутствует →
  `STORAGE_POSTGRES_SCHEMA_OUTDATED`. `readSchemaVersion` — текущая версия.
- **Сборка контекста (`storage-context.ts`).** `buildPostgresStorageContext`:
  `skills`/`contextFiles`/`blobs` — **файловые** реализации
  (`createFileStorage`, FS/package-bound, см. исключение выше), остальные порты —
  заглушки `notImplementedPort(name)`, бросающие `PostgresStorageNotImplementedError`
  с именем порта. `createPostgresStorage` применяет/проверяет схему и возвращает
  контекст (в волне 3a соединение закрывается — порты ещё заглушки; следующая волна
  удержит его в PG-реализациях).
- **DDL.** Все таблицы/индексы заведены сразу (`001_init`): `sessions` (jsonb-поля +
  partial/`updated_at DESC`-индексы), `messages` (нормализованные, `UNIQUE(session_id,seq)`,
  `GIN(content gin_trgm_ops)` через `CREATE EXTENSION IF NOT EXISTS pg_trgm`),
  child-таблицы (`session_references`/`checkpoints`/`sticky_notes`), `projects`/
  `project_members`, `profiles`/`profile_identities`, `settings`/`token_ratios`/
  `migration_markers`, `documents`, события (`event_*`/`identity_claims`/`dedup`),
  `schedules`/`jobs`, `webhooks`/`webhook_deliveries` (`secret_enc bytea`), `ssh_keys`/
  `ssh_key_agents`, `service_keys`, `mcp_registry`, `skill_bundles`, `maintenance_audit`.
  Все времена — `timestamptz`; FK — только внутри инстанса (по `user_id`/`owner_id` FK нет).

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
  применение/идемпотентность миграций, fail-closed «версия новее». Полный контрактный
  suite портов (`packages/core/src/storage/contract/*`) подключается следующей волной.
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

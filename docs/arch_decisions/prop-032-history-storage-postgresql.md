# PROP-032: Второй вариант хранения — БД (PostgreSQL) за единым слоем

> **Статус:** 🧩 Предложение — реализуется поэтапно: волны 1–5 в коде (конфиг, драйвер, все 27 портов, `listLight`, БД-локи, CI-гейт, обслуживание, перенос, деградированный режим), см. «Статус реализации в коде»; остаток — CA/TLS и документы. Токен `⚠️ Частично` — только для ADR ([ARCH_DECISIONS.md](../ARCH_DECISIONS.md) §4), поэтому у предложения он не ставится; принятие в ADR, когда остаток закроется.
> **Решение до:** 2026-11-14
> **Дата:** 2026-09-17
> **Парные документы:**
> - [ADR-097](./adr-097-storage-provider-class.md) «Класс расширения «хранилище» (storage)» — драйвер БД как **in-tree опциональный пакет из коробки**; контракт класса — порты + контрактный suite;
> - [ADR-096](./adr-096-storage-layer.md) «Единый слой хранения — доменные порты с взаимозаменяемыми backend'ами» — **предпосылка выполнена**: порты, контрактный suite и `StorageContext` уже есть;
> - [ADR-098](./adr-098-storage-degraded-recovery.md) «Деградированный режим и восстановление хранилища» — поведение при недоступности БД (fail-closed/деградация, read-only, восстановление);
> - [ADR-005](./adr-005-json-storage.md) «JSON-файлы как хранилище» — текущий (и остающийся дефолтным) файловый backend;
> - [ADR-033](./adr-033-session-branching-merge.md) «Ветвление сессий и межсессионное слияние» — потребитель `parent_id`/`branch_point`/`origin`, опирается на логическую модель;
> - [ADR-026](./adr-026-subagent-context-modes.md) «Режимы контекста саб-агента» — `summary`-режим (сущность `context_snapshot`);
> - [ADR-017](./adr-017-api-v2-hono.md) «Собственный API-контракт (API v2 на Hono)» — API-слой, читающий историю через порты;
> - [PROP-077](./prop-077-runtime-toolchain.md), [PROP-085](./prop-085-multimodal-input.md) — зависят от этого шага.

## Решение

Ввести **второй (selectable) backend за портами [ADR-096](./adr-096-storage-layer.md)** — не замену
файлового хранения, а альтернативу для инсталляций с требованиями **масштаба, мульти-процесса и сети**
(managed/кластер, несколько реплик, большие объёмы истории). Standalone и локальный home остаются на
файлах ([ADR-005](./adr-005-json-storage.md)) без внешних зависимостей.

Реализация БД = **реализация существующих портов** (`storage/ports/*`) + **прогон того же контрактного
suite** (`storage/contract/*`), плюс эффективные выборки для методов, помеченных `@future-backend`:
«лёгкие» листинги без `messages`, фильтры/пагинация, транзакционный `consume`/`tryClaim`, уникальность
`label`, prune по `ORDER BY`. Переключение инсталляции — `storage.backend` (добавляется значение `postgres`
рядом с `file`/`memory`).

**Форма поставки (in-tree драйвер).** PostgreSQL-драйвер поставляется из коробки **отдельным опциональным
npm-пакетом** `@itphx/synth-storage-postgres` (реэкспорт `createPostgresStorage(config): Promise<StorageContext>`),
подключаемым из асинхронного каскада `createStorageContextAsync`/`buildStorageContext` **динамическим `import()`** по `storage.backend === 'postgres'`; зависимость
`pg` — **optional** (standalone/локальный home не тянут БД). Критерий приёмки — прохождение suite
`packages/core/src/storage/contract/*` («паспорт порта»). Класс расширения — [ADR-097](./adr-097-storage-provider-class.md).

`context_snapshot` (сжатый контекст для `summary`-режима) остаётся за рамками среза: `summary` реализован
через `ContextOptimizer.summarize()` с кэшем ([ADR-026](./adr-026-subagent-context-modes.md)).

---

## Контекст

История сегодня лежит в JSON-файлах ([ADR-005](./adr-005-json-storage.md)): каждый файл пишется атомарно
(tmp→rename), но **сквозной транзакции между сущностями нет**, межпроцессной блокировки записи нет.
Для одного узла (десятки–сотни сессий) этого достаточно; для managed/сетевого контура и горизонтального
масштабирования — нет. При этом логическая модель (сессия → сообщение → часть, `parent_id`, `seq`,
`origin`) уже живёт в JSON-схеме и используется ветвлением/merge — БД затрагивает **только физический
слой**, а не доменную модель.

## Логическая модель

```
Сессия (id, parent_id, project_id, agent, title, ...)
  │
  ├── parent_id → Сессия (parent-child дерево)
  ├── project.plan → kanban-план (ADR-039)
  ├── branch_point → точка развилки для дочерних веток
  │
  └─1:N──→ Сообщение (id, session_id, seq, role, content, origin, source_msg_id, ...)
              ├── seq — порядковый номер, уникален внутри сессии
              ├── origin: local | inherited | merged | crosspost
              └─1:N──→ Часть (id, message_id, type, data)
                          └── type: text | tool_use | tool_result | reasoning
```

| Сущность | Назначение |
|---|---|
| **Сессия** | Контейнер диалога; `parent_id` — дерево сессий, хранит `agent`, `branch_point` |
| **Сообщение** | Одна реплика (user/assistant/tool/system); `seq` — порядок, `origin` — происхождение |
| **Часть (part)** | Блок контента внутри сообщения: text, tool_use, tool_result, reasoning |
| **context_snapshot** | Сжатый контекст для `summary`-режима (пока не выделен — см. «Решение») |

### Origin tracking

| origin | Как попало в сессию | source_msg_id |
|---|---|---|
| `local` | Создано в этой сессии (дефолт) | NULL |
| `inherited` | Унаследовано от родительской сессии (ветвление) | ID оригинального сообщения |
| `merged` | Скопировано из другой сессии пользователем (smart paste) | ID оригинального сообщения |
| `crosspost` | Существует в нескольких сессиях одновременно | Синхронизировано |

## Альтернативы (выбор СУБД)

БД — это **второй backend за портом**: допустимы любые backend'ы, реализующие порты и проходящие
контрактный suite (в т.ч. SQLite/libSQL — валидный локальный вариант). Смена целевой СУБД в рамках
managed-контура — не правка этого предложения, а отдельное решение.

- **PostgreSQL** — дефолт: полный SQL/DML, `WITH RECURSIVE` под дерево сессий, зрелые ORM/миграции,
  PITR/WAL. Упомянут целевым в [ADR-005](./adr-005-json-storage.md).
- **YDB** — распределённая SQL-СУБД (нативные распределённые ACID-транзакции), рассматривается всерьёз
  как альтернатива при требованиях распределённости/мульти-ДЦ или если заказчик стандартизирован на YDB;
  не дефолт из-за меньшей зрелости экосистемы (ORM/миграции) и большего порога эксплуатации.
- **SQLite и встроенные (libSQL, DuckDB, bbolt)** — нулевая внешняя зависимость, идеальны для standalone,
  но не покрывают сетевой доступ, распределённость и транзакции между процессами; серверный
  многопользовательский и managed-контур — нет. Валидный локальный backend за портом (файловый дефолт не
  отменяют).
- **Документные (MongoDB, CouchDB)** — гибкая схема, но нет нормализованных связей «сессия → сообщение →
  часть»; `parent_id`/`seq`/дедуп эмулируются; PITR слабее/дороже.

### Матрица сравнения (PostgreSQL vs YDB)

| Критерий | PostgreSQL | YDB |
|---|---|---|
| SQL/DML-совместимость и переносимость запросов | Полный SQL; `JOIN`, `WITH RECURSIVE`; стандартные драйверы (`pg`) | YQL — SQL-подобный диалект; часть PostgreSQL-синтаксиса не переносится |
| K8s-оператор / эксплуатация | Зрелые операторы (CloudNativePG, Zalando, Patroni) | `ydb-operator`; практики меньше, топология сложнее |
| Managed-варианты | Практически во всех облаках и on-prem-платформах | В первую очередь Yandex Cloud; вне него — self-host |
| HA / распределённость | Репликация/Patroni; шардинг — отдельными решениями | Нативные распределённые ACID-транзакции и горизонтальная масштабируемость |
| Бэкапы / PITR | WAL + PITR, `pg_basebackup`, pgBackRest | Средства YDB; PITR — да, инструментов/практик меньше |
| Зрелость экосистемы (ORM/миграции) | Максимальная (Prisma/Drizzle/Kysely, `node-postgres`) | Заметно уже; часто «ручной» SQL |
| Стоимость эксплуатации | Ниже: кадры/компетенции доступны | Выше порог; выгода — на масштабе/мульти-ДЦ |
| Соответствие RU-enterprise требованиям | Широко принят, есть реестры и отечественные дистрибутивы | В реестре отечественного ПО, предпочтителен на Yandex-технологиях |

### Вывод и критерии пересмотра

- **PostgreSQL — дефолт** для managed/сетевого контура: максимальная зрелость, минимальный opex, PITR.
- **YDB пересматривается**, если выполнено хотя бы одно: (1) требования **распределённости/мульти-ДЦ**;
  (2) **заказчик стандартизирован на YDB**; (3) объём/нагрузка выходят за пределы удобного шардинга
  PostgreSQL для целевой инсталляции.
- До этих условий выбор — PostgreSQL; standalone/локальный home остаётся на файлах.

## Статус реализации в коде

Реализовано (волны 1–5): драйвер `@itphx/synth-storage-postgres` в дереве, конфиг, все доменные порты поверх SQL, БД-локи, контур обслуживания, перенос данных и деградированный режим.

- **Единый слой — сделан** ([ADR-096](./adr-096-storage-layer.md)): доменные порты (`storage/ports/*`, 27), in-memory и файловые реализации, контрактный suite, `StorageContext` + `createFileStorage`/`createMemoryStorage`/`createStorageContext` и **async-каскад** `createStorageContextAsync`/`buildStorageContext`, конфиг `storage.backend` (`file`|`memory`|`postgres`, env `SYNTH_STORAGE_BACKEND`, **fail-closed** на неизвестном явном значении).
- **Конфиг (волна 2).** Секция `storage.postgres` (`dsn`/`host`/`port`/`database`/`user`/`schema`/`ssl`/`poolMax`) + env `SYNTH_POSTGRES_*`; пароль — только env `SYNTH_POSTGRES_PASSWORD`/файл `{dataDir}/secrets/postgres-password` (инвариант 13). Задел деградации — `storage.degradedMode`/`storage.fallbackDir` (+ env `SYNTH_DEGRADED_MODE`/`SYNTH_STORAGE_FALLBACK_DIR`). Резолверы — `resolvePostgresConfig`/`resolvePostgresPassword`/`resolveDegradedMode`/`resolveStorageFallbackDir` (`@itphx/synth-shared/config`); `PostgresStorageConfig` в `shared/config/types.ts`.
- **Драйвер (волна 3).** `@itphx/synth-storage-postgres`: пул/подключение (`pg` — optional, ленивый `import()`), своя схема БД и инлайн-SQL-миграции (`synth_schema_migrations`, **fail-closed** «схема новее» — `STORAGE_POSTGRES_SCHEMA_TOO_NEW`), **все 27 портов** `StorageContext` реализованы и проходят контрактный suite (27/27 против живой БД); `StorageContext.{health?,close?,schemaMigrations?,purgeSchema?,locks?,degraded?}`. Core подключает драйвер динамическим `import()` (`POSTGRES_DRIVER_PACKAGE`) через async-каскад; домен (`deps.ts` core/backend, CLI/обслуживание) вызывает async-фабрику.
- **Эффективные выборки (волна 3b).** `@future-backend`-методы: «лёгкие» листинги без `messages` (`listLight`), фильтры/пагинация, транзакционные `consume`/`tryClaim`, уникальность `label`, prune по `ORDER BY`. Позиционный `seq` сообщений (`UNIQUE(session_id, seq)`), суррогатные ключи — детали в `packages/storage-postgres/AGENTS.md`.
- **Координация (волна 4).** `PgMutex`/`PgLeader` поверх PG advisory-локов → `StorageContext.locks`; scheduler `leaderElection: postgres`, лок миграций драйвера.
- **Обслуживание (волна 5а).** `synth migrate` применяет/выравнивает SQL-схему драйвера; `doctor` — `db-connection`/`db-schema` (файловые проверки помечаются `неприменимо`); `backup` — манифест `storageBackend` (данных БД в архиве каталога нет — `pg_dump`/PITR); `uninstall --purge-db` (fail-closed, требует `--purge` и `--yes`).
- **Перенос данных (волна 5б).** `synth storage migrate --to file|postgres` — идемпотентно, только через доменные порты; честные ограничения (секреты-хеши/шифр перевыпускаются; `schedules`/`webhooks`/`sshKeys`/`mcpRegistry` — новые `id`; `dedup` не переносится; `skills`/`contextFiles`/`blobs` остаются файловыми) — `packages/core/src/maintenance/storage-migrate.ts`.
- **Деградированный режим (волна 5в).** [ADR-098](./adr-098-storage-degraded-recovery.md): матрица `fail-closed`/деградация, файловый `fallbackDir`, ADMIN-only + строгий read-only, `/health` → `degraded`, `GET /api/v2/storage/status`, встроенный скилл `synth-storage-recovery`.
- **Контрактный suite против живой БД** гейтится env `SYNTH_TEST_POSTGRES_DSN` (задача `test-postgres` в CI, `scripts/ci-postgres.sh`); smoke и suite — `packages/storage-postgres/src/postgres.integration.test.ts` и `packages/core/src/storage/contract/postgres.test.ts`.
- **Логическая модель** (`MessageOrigin`, `seq`, `sourceMsgId`, `parent_id`, `branch_point`) сохраняется при переходе на БД.

### Остаток (не реализовано)

1. **CA/TLS-настройки** соединения сверх `storage.postgres.ssl` (кастомные CA, mTLS/клиентские сертификаты).
2. **Авто-возврат к БД без рестарта** и DB-aware `/ready`-проба/метрики ([ADR-098](./adr-098-storage-degraded-recovery.md), [ADR-094](./adr-094-observability-metrics.md)).
3. **Документы**: эксплуатационный runbook БД-backend'а готов ([docs/MAINTENANCE.md](../MAINTENANCE.md)); портал `docs.synth.itphx.ru` — отдельно.
4. **`kind: "storage"` в манифесте `synth.pack`** и установка сторонних драйверов — остаток [ADR-097](./adr-097-storage-provider-class.md).

## Связи

- [ADR-096](./adr-096-storage-layer.md), [ADR-097](./adr-097-storage-provider-class.md), [ADR-098](./adr-098-storage-degraded-recovery.md), [ADR-005](./adr-005-json-storage.md), [ADR-033](./adr-033-session-branching-merge.md), [ADR-026](./adr-026-subagent-context-modes.md), [ADR-017](./adr-017-api-v2-hono.md), [PROP-077](./prop-077-runtime-toolchain.md), [PROP-085](./prop-085-multimodal-input.md).
- **PROP-077 и PROP-085 по-прежнему зависят от этого шага:** инструментальное окружение исполнения
  (thin backend + executor, общий volume, S3) и мультимодальные вложения планируются поверх БД-слоя.

## История

- 2026-10-16 — переформулировано как **второй (selectable) backend за портами ADR-096** (не замена файлов); предпосылка (единый слой + контрактный suite) выполнена.
- 2026-10-16 — зафиксирована форма поставки: in-tree опциональный пакет `@itphx/synth-storage-postgres` + динамический `import()`; класс «хранилище» — [ADR-097](./adr-097-storage-provider-class.md).
- 2026-10-16 — волны 2–5 реализованы (конфиг, драйвер и все 27 портов, `listLight`, БД-локи, CI-гейт, обслуживание, перенос данных, деградированный режим — [ADR-098](./adr-098-storage-degraded-recovery.md)); остаток — CA/TLS и документы.

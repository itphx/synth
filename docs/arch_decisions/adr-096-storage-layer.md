# ADR-096: Единый слой хранения — доменные порты с взаимозаменяемыми backend'ами

> **Статус:** ✅ Реализовано
> **Дата:** 2026-10-16
> **Связано:** [ADR-005](./adr-005-json-storage.md), [ADR-095](./adr-095-god-object-decomposition.md), [PROP-032](./prop-032-history-storage-postgresql.md), [PROP-077](./prop-077-runtime-toolchain.md); [docs/ARCH_DECISIONS.md](../ARCH_DECISIONS.md).

## Контекст

Хранение было захардкожено в домене: `FileStore`/`JsonStore` и ~20 конкретных стораджей (`ProjectStore`,
`FileProfileStore`, `RuntimeSettingsStore`, `EventBindingStore`, `WebhookStore`, `ServiceApiKeyStore`,
`ScheduleStore`, …) собирались россыпью в composition root (`server/app/deps.ts`, `backend/app/deps.ts`) и
протекали конкретными классами в роуты и движок. Смена **физического уровня** (например, переход на
PostgreSQL, PROP-032) без шва означала бы ревизию всех call-sites: домен знал бы о файлах, путях и
атомарной записи, а «второй вариант хранения» стал бы переписыванием всего, что читает/пишет данные.

При этом standalone-инсталляция должна остаться работоспособной **без внешних зависимостей** — файловый
backend с JSON + атомарной записью ([ADR-005](./adr-005-json-storage.md)) никуда не уходит.

## Решение

Ввести **единый слой хранения** — доменные порты с взаимозаменяемыми backend'ами:

1. **Порты — доменные, а не generic-KV** (`storage/ports/*`, 26). Порт выражает то, что домен реально
   делает: видимость сессий (`listForUser`/`listForUserScope`), поиск, «лёгкие» листинги без `messages`,
   уникальность метки (`label`), append-журналы, резолвинг секрета. Методы под эффективные выборки SQL
   помечены `@future-backend` (файловая реализация вправе сканировать). Универсальный `get/put/list` не
   выражает этих операций — и потому не выбран.
2. **Реализации за одним контрактом:** файловая (default; standalone и локальный home; JSON + атомарная
   запись tmp→rename, ADR-005), in-memory (`storage/memory/*`; герметичные тесты без ФС, эталон
   семантики), БД (следующий шаг — [PROP-032](./prop-032-history-storage-postgresql.md)).
3. **Единая точка сборки — `StorageContext`** (`storage/storage-context.ts`): `createFileStorage`/
   `createMemoryStorage`/`createStorageContext`. Выбор backend'а — `storage.backend` (`file`|`memory`;
   env `SYNTH_STORAGE_BACKEND`). Домен получает порты из одного места, а не собирает конкретные классы.
4. **Контрактный suite — «паспорт» порта** (`storage/contract/*`): ключевые операции и инварианты
   (удаление отсутствующего — не ошибка; пустой список — `[]`; порядок сортировки; уникальность `label`),
   **обязательные для любой** реализации.
5. **Конфиг-словари** (провайдеры/модели/агенты) — порт `DocumentRepository<T>`: здесь домен и есть
   «ключ → JSON-документ», generic-порт оправдан.

## Альтернативы

- **Generic-KV (`get/put/list`)** — отклонён: не выражает SQL-эффективно видимость, поиск, пагинацию и
  «лёгкие» листинги; вернул бы эти запросы в домен.
- **Оставить конкретные классы, переписать домен при появлении БД** — отклонён: дороже, без тестового
  «паспорта» и без возможности прогонять семантику вне файловой системы.
- **SQLite как единственный backend** — отклонён: не покрывает managed/сетевой/мульти-процессный контур
  (БД как второй backend за портом при этом валидна).
- **Сразу БД** — отклонён: не проходит по инварианту «standalone без внешних зависимостей».

## Последствия

- (+) Замена backend = реализация портов + прогон того же контрактного suite; домен не знает о ФС.
- (+) In-memory backend даёт герметичные тесты и эталон семантики; файловая реализация помечена
  `implements` портов — поведение не менялось (только типизация).
- (−) **Не весь периметр за портами:** `BlobStore` определён и реализован (`FileBlobStore`), но
  `SkillStore`/`ContextConfig` (содержимое скиллов и файлы промптов/словарей), аватары (backend-роут) и
  URL-кэши инструкций пока ходят в ФС напрямую; audit-логи (`audit/*.jsonl`) и workspace-файлы — вне слоя.
- (−) `security/rotate.ts` — **намеренное исключение** (one-shot по явному `dataDir`, не доменный поток).
- (−) Синхронные геттеры (`SecretPatternRepository`/`ProtectedPathsRepository`/`DictionaryRepository`/
  `ContextFileRepository` — горячий путь) для БД-реализации потребуют синхронного кэша над хранилищем.

## Статус в коде

Модули слоя:

- `storage/ports/*` — доменные порты (27) + barrel `index.ts`; `DocumentRepository<T>` — конфиг-словари.
- `storage/memory/*` — in-memory реализации (сессии, проекты, профили, события, секреты, контент, …).
- `storage/contract/*` — контрактный suite («паспорт» порта); `file`- и `memory`-реализации, а также драйвер `postgres` (`storage/contract/postgres.test.ts`, гейт env `SYNTH_TEST_POSTGRES_DSN`) прогоняются им.
- `storage/storage-context.ts` — `StorageContext` (в т.ч. опциональные `close?`/`locks?`/`health?`/`schemaMigrations?`/`purgeSchema?`/`degraded?`) + `createFileStorage`/`createMemoryStorage`/`createStorageContext` и **async-каскад** `createStorageContextAsync`/`buildStorageContext`; деградация — [ADR-098](./adr-098-storage-degraded-recovery.md).
- `storage/file-blob-store.ts` — `FileBlobStore` (порт `BlobStore`); `storage/defaults-store.ts` —
  `DefaultsStore` (перенесён в core; backend оставляет реэкспорт).
- **Драйвер БД** — опциональный in-tree пакет `@itphx/synth-storage-postgres` (`peer-dep` core, `pg` — optional, ленивый `import()`): реализует все 27 портов поверх SQL ([ADR-097](./adr-097-storage-provider-class.md)/[PROP-032](./prop-032-history-storage-postgresql.md)).

Точки сборки (composition root): `packages/core/src/server/app/deps.ts` → `createStandaloneStorage`
(строится до `auth` — реестр `serviceKeys` нужен резолверу ключа); `packages/backend/src/app/deps.ts` →
`createBackendStorage`. Конфиг `storage.backend` (`file`|`memory`|`postgres`) + env `SYNTH_STORAGE_BACKEND`.

Тесты: `storage/storage-context.test.ts`, `storage/contract/*.test.ts`, `storage/memory/*.test.ts`.

## История

- 2026-10-16 — решение принято; единый слой хранения введён (порты, файловая/memory-реализации, контрактный suite, `StorageContext`).
- 2026-10-16 — добавлен второй backend: драйвер `postgres` (все 27 портов), async-каскад сборки (`createStorageContextAsync`/`buildStorageContext`) и деградированный режим ([ADR-097](./adr-097-storage-provider-class.md)/[ADR-098](./adr-098-storage-degraded-recovery.md), PROP-032).

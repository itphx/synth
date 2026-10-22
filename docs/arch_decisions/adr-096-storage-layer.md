# ADR-096: Единый слой хранения — доменные порты с взаимозаменяемыми backend'ами

> **Статус:** ✅ Реализовано
> **Дата:** 2026-10-16
> **Обновлено:** 2026-10-22 — добавлен порт `PluginAuditRepository` (PROP-090 §9, журнал аудита
> плагинов); счётчик портов приведён к факту (37).
> **Связано:** [ADR-005](./adr-005-json-storage.md), [ADR-095](./adr-095-god-object-decomposition.md), [ADR-097](./adr-097-storage-provider-class.md), [ADR-077](./adr-077-runtime-toolchain.md); [docs/ARCH_DECISIONS.md](../ARCH_DECISIONS.md).

## Контекст

Хранение было захардкожено в домене: `FileStore`/`JsonStore` и ~20 конкретных стораджей (`ProjectStore`,
`FileProfileStore`, `RuntimeSettingsStore`, `EventBindingStore`, `WebhookStore`, `ServiceApiKeyStore`,
`ScheduleStore`, …) собирались россыпью в composition root (`server/app/deps.ts`, `backend/app/deps.ts`) и
протекали конкретными классами в роуты и движок. Смена **физического уровня** (например, переход на
PostgreSQL, ADR-097) без шва означала бы ревизию всех call-sites: домен знал бы о файлах, путях и
атомарной записи, а «второй вариант хранения» стал бы переписыванием всего, что читает/пишет данные.

При этом standalone-инсталляция должна остаться работоспособной **без внешних зависимостей** — файловый
backend с JSON + атомарной записью ([ADR-005](./adr-005-json-storage.md)) никуда не уходит.

## Решение

Ввести **единый слой хранения** — доменные порты с взаимозаменяемыми backend'ами:

1. **Порты — доменные, а не generic-KV** (`storage/ports/*`, 37). Порт выражает то, что домен реально
   делает: видимость сессий (`listForUser`/`listForUserScope`), поиск, «лёгкие» листинги без `messages`,
   уникальность метки (`label`), append-журналы, резолвинг секрета. Методы под эффективные выборки SQL
   помечены `@future-backend` (файловая реализация вправе сканировать). Универсальный `get/put/list` не
   выражает этих операций — и потому не выбран.
2. **Реализации за одним контрактом:** файловая (default; standalone и локальный home; JSON + атомарная
   запись tmp→rename, ADR-005), in-memory (`storage/memory/*`; герметичные тесты без ФС, эталон
   семантики), БД (следующий шаг — [ADR-097](./adr-097-storage-provider-class.md)).
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

- `storage/ports/*` — доменные порты (37) + barrel `index.ts`; `DocumentRepository<T>` — конфиг-словари
  (`providers`/`models`/`agents` — три поля из одного файла).
- `storage/memory/*` — in-memory реализации (сессии, проекты, профили, события, секреты, контент, …).
- `storage/contract/*` — контрактный suite («паспорт» порта); `file`- и `memory`-реализации, а также драйвер `postgres` (`storage/contract/postgres.test.ts`, гейт env `SYNTH_TEST_POSTGRES_DSN`) прогоняются им.
- `storage/storage-context.ts` — `StorageContext` (в т.ч. опциональные `close?`/`locks?`/`health?`/`schemaMigrations?`/`purgeSchema?`/`degraded?`) + `createFileStorage`/`createMemoryStorage`/`createStorageContext` и **async-каскад** `createStorageContextAsync`/`buildStorageContext`; деградация — [ADR-098](./adr-098-storage-degraded-recovery.md).
- `storage/file-blob-store.ts` — `FileBlobStore` (порт `BlobStore`); `storage/defaults-store.ts` —
  `DefaultsStore` (перенесён в core; backend оставляет реэкспорт).
- `storage/ports/plugin-audit-repository.ts` — порт `PluginAuditRepository` (PROP-090 §9): журнал
  аудита плагинов, append-only (`append`/`list` «свежие первыми» с фильтрами
  `plugin`/`action`/`outcome`/`limit`/`clear`). **Отдельный** порт: `SECURITY_AUDIT_SCOPES` не
  расширяется — семантика «событие расширения» ≠ «изменение политики». Реализации: файл
  (`storage/file-plugin-audit-store.ts`, JSONL `{dataDir}/audit/plugins.jsonl`), память
  (`storage/memory/plugin-audit.ts`), PostgreSQL (`packages/storage-postgres/src/ports/plugin-audit.ts`,
  таблица `plugin_audit`, миграция `006-plugin-audit.ts`); контрактный suite —
  `storage/contract/plugin-audit-repository.contract.ts`, прогон на живой БД —
  `storage/contract/postgres.test.ts` (ADR-097). Подключение — `StorageContext.pluginAudit`.
- **Драйвер БД** — опциональный in-tree пакет `@itphx/synth-storage-postgres` (`peer-dep` core, `pg` — optional, ленивый `import()`): реализует все 37 портов поверх SQL ([ADR-097](./adr-097-storage-provider-class.md)).

Точки сборки (composition root): `packages/core/src/server/app/deps.ts` → `createStandaloneStorage`
(строится до `auth` — реестр `serviceKeys` нужен резолверу ключа); `packages/backend/src/app/deps.ts` →
`createBackendStorage`. Конфиг `storage.backend` (`file`|`memory`|`postgres`) + env `SYNTH_STORAGE_BACKEND`.

Тесты: `storage/storage-context.test.ts`, `storage/contract/*.test.ts`, `storage/memory/*.test.ts`.

- **CA/TLS к соединению с БД** — единый источник доверия — секция `security.tls` + `storage.postgres.sslmode`
  ([ADR-099](./adr-099-egress-tls-trust.md)): TLS-параметры в DSN запрещены, `pg.Pool` собирается через
  `buildPoolConfig` (`packages/storage-postgres/src/pool.ts`), per-host профиль БД — в mappings ADR-099.
- **Документы** — эксплуатационный runbook БД-backend'а готов ([docs/MAINTENANCE.md](../MAINTENANCE.md));
  страницы портала `docs.synth.itphx.ru` — отдельно (вне репозитория).

## Открытые вопросы

- **Авто-возврат к БД без рестарта** и DB-aware `/ready`-проба/метрики — [ADR-098](./adr-098-storage-degraded-recovery.md)
  (возврат — рестартом; проба и метрики — [ADR-094](./adr-094-observability-metrics.md)).
- **`kind: "storage"` в манифесте `synth.pack` и установка сторонних драйверов** — [ADR-097](./adr-097-storage-provider-class.md)
  (класс расширения; реестр/trust/install — [PROP-068](./prop-068-skills-agents-registry.md)).
- **Страницы портала** по БД-backend'у — отдельно от репозитория.

## История

- 2026-10-16 — решение принято; единый слой хранения введён (порты, файловая/memory-реализации, контрактный suite, `StorageContext`).
- 2026-10-16 — добавлен второй backend: драйвер `postgres` (все 27 портов), async-каскад сборки (`createStorageContextAsync`/`buildStorageContext`) и деградированный режим ([ADR-097](./adr-097-storage-provider-class.md)/[ADR-098](./adr-098-storage-degraded-recovery.md)).
- 2026-10-22 — материал предложения «второй вариант хранения — БД за единым слоем» перенесён сюда и в ADR-097/ADR-098; остаток (CA/TLS к БД — закрыт ADR-099; авто-возврат — ADR-098; документы — runbook/портал) зафиксирован выше.
- 2026-10-22 — добавлен порт `PluginAuditRepository` (PROP-090 §9: журнал аудита плагинов — файл/память/PostgreSQL, контрактный suite + прогон на живой БД); счётчик портов приведён к факту — 37.

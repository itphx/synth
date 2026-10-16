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
- `@itphx/synth-core` — **`peerDependencies` + `devDependencies`**, импорт только
  `import type` (типы портов/`StorageContext`). Это разрывает цикл
  core ↔ драйвер: core держит драйвер в `optionalDependencies` и подключает его
  динамическим `import()` по `storage.backend === 'postgres'`, бандлить драйвер в
  `cli.js` нельзя.
- `pg` — **`optionalDependencies`**: отсутствие драйвера не ломает импорт модуля
  (он подключается лениво, внутри `createPostgresStorage`), а standalone/локальный
  home не тянут БД. Типы — `@types/pg` в `devDependencies` (для реализации портов).

## Текущий статус

Пакет — **скелет** (волна 2b): форма поставки, типы конфига и классы ошибок.
`createPostgresStorage` валидирует конфиг (`connectionString` либо
`pool.host` + `pool.database`), лениво проверяет наличие `pg` и завершается
`PostgresStorageNotImplementedError`. Реализация портов, SQL-схема и миграции —
следующая волна.

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
- Сборка: `pnpm --filter @itphx/synth-storage-postgres build` (`tsc -p tsconfig.build.json`);
  порядок релизной сборки — `shared → core → storage-postgres → ui → sdk → synth`
  (`scripts/build.sh`, `build:release`), публикации — `scripts/publish*.sh`.

## Чего не делать

- Не импортировать `pg` на верхнем уровне модуля (только ленивый `import()` внутри функции).
- Не тянуть core рантаймом (`import` без `type`) — только `import type`.
- Не добавлять собственных точек сборки хранения мимо `StorageContext`/портов (ADR-096).
- Не дублировать `local home`/файловые пути: драйвер получает `dataDir` из общего `StorageContextConfig`.

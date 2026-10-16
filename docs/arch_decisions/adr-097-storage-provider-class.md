# ADR-097: Класс расширения «хранилище» (storage) — контракт портов, драйверы из коробки

> **Статус:** ⚠️ Частично — класс `storage` выделен, контракт класса (доменные порты + suite) и драйверы `file`/`memory` есть; БД-драйвер `postgres`, `kind: "storage"` в манифесте и установка сторонних драйверов — нет
> **Дата:** 2026-10-16
> **Связано:** [ADR-096](./adr-096-storage-layer.md), [ADR-086](./adr-086-extensibility-plugins-editions.md), [ADR-005](./adr-005-json-storage.md), [ADR-023](./adr-023-configuration.md), [ADR-038](./adr-038-npm-packages.md), [ADR-091](./adr-091-backup-restore-transfer.md), [ADR-092](./adr-092-instance-lifecycle-maintenance.md), [PROP-032](./prop-032-history-storage-postgresql.md), [PROP-090](./prop-090-extension-api.md), [PROP-068](./prop-068-skills-agents-registry.md).

## Контекст

[ADR-096](./adr-096-storage-layer.md) ввёл единый слой хранения: доменные порты (`storage/ports/*`, 26),
контрактный suite («паспорт порта», `storage/contract/*`) и точку сборки `StorageContext`
(`storage.backend` = `file`|`memory`). Драйверы `file`/`memory` живут in-tree.

Следующий шаг — БД ([PROP-032](./prop-032-history-storage-postgresql.md), PostgreSQL) — по форме поставки не
укладывается ни в один существующий класс расширений [ADR-086](./adr-086-extensibility-plugins-editions.md):
это не Plugin, не Gateway/Add-on/контент-пак, а **подмена физического backend'а под портами**.

**Почему это не Plugin ([PROP-090](./prop-090-extension-api.md)):** у плагина нет storage-фацета — плагин
**потребитель** портов, а не их реализация; иное время загрузки (`StorageContext` собирается в composition
root **до** auth/EventHub, плагин — позже); sync-сборка (`createStorageContext`) против асинхронного пула БД;
singleton-слой хранения против disposer-модели плагина.

## Решение

Ввести **класс расширения «хранилище» (`storage`)** наряду с Plugin / Gateway / Add-on / контент-паком
([ADR-086](./adr-086-extensibility-plugins-editions.md)):

1. **Контракт класса** = доменные порты (`storage/ports/*`) + контрактный suite (`storage/contract/*`).
   Критерий приёмки **любого** драйвера — прохождение suite (эталон семантики — `memory`).
2. **Драйверы из коробки:** `file` (default; [ADR-005](./adr-005-json-storage.md)) и `memory` — уже in-tree,
   без внешних зависимостей (standalone/локальный home не тянут БД).
3. **БД-драйвер — опциональный in-tree npm-пакет** (рабочее имя `@itphx/synth-storage-postgres`),
   подключаемый из `createStorageContext` **динамическим `import()`** по `storage.backend === 'postgres'`;
   `pg` — **optional dependency**. Форма поставки — [PROP-032](./prop-032-history-storage-postgresql.md) §«Решение».
4. **Выбор драйвера** — стандартно через `storage.backend` (`file`|`memory`|`postgres`; env
   `SYNTH_STORAGE_BACKEND`), приоритеты конфига — [ADR-023](./adr-023-configuration.md).
5. **Манифест `synth.pack`** получает `kind: "storage"` (для инспекции/реестра/trust); установка сторонних
   драйверов — будущее. Реестр/trust/install-policy наследуют единую инфраструктуру [PROP-068](./prop-068-skills-agents-registry.md).

## Альтернативы

- **Storage как Plugin по [PROP-090](./prop-090-extension-api.md)** — отклонён: у Plugin нет storage-фацета;
  другое время загрузки (composition root до auth/EventHub), sync vs async-пул, singleton vs disposer (см. «Контекст»).
- **Отдельный класс + свой ранний загрузчик/lifecycle** — принят **как форма** (класс и ранняя точка сборки),
  но первый драйвер — in-tree, без отдельного загрузчика сторонних драйверов.
- **Только встроенный драйвер без класса** — отклонён: класс нужен для `kind: "storage"`, реестра/trust и
  сценария сторонних драйверов; без него БД-драйвер — неявный хардкод.

## Последствия

- (+) Драйвер слоя хранения — заменяемая единица с явным критерием приёмки (suite); домен о ФС не знает.
- (+) Standalone/локальный home остаются на `file` без внешних зависимостей (`pg` — optional).
- (−) Класс = «второй набор» lifecycle-точек (ранняя сборка до auth) — нельзя смешивать с Plugin-загрузкой.
- (−) Часть слоя и периметра остаётся file-специфичной/гибридной (maintenance, секреты, ФС-периметр) — см. ниже.

## Статус реализации в коде

- **Есть:** порты (26) + suite + `file`/`memory` + `StorageContext` ([ADR-096](./adr-096-storage-layer.md));
  `StorageBackendKind = 'file' | 'memory'`, `storageConfigSchema.backend: z.enum(['file','memory'])`,
  `resolveStorageBackend` (env `SYNTH_STORAGE_BACKEND` > config > `'file'`).
- **Нет:** `postgres`-драйвер, `kind: "storage"` в манифесте, установка сторонних драйверов.
- **Границы/хардкоды:** `createStorageContext('file', …)` игнорирует `storage.backend` в
  `packages/core/src/main.ts`, `maintenance/migrate.ts`, `server/routes/maintenance.ts`; при невалидном
  `storage.backend` — тихий фоллбэк на `file` (нужен fail-closed). Maintenance (миграции `meta.json`/`schemaVersion`,
  `backup`/`restore`, `master.key`, `ssh-keys/`) — FS-центрично; ФС-периметр вне портов (контент скиллов, промпты,
  аватары, audit `*.jsonl`, workspace) — по [ADR-091](./adr-091-backup-restore-transfer.md)/[ADR-092](./adr-092-instance-lifecycle-maintenance.md).

## История

- 2026-10-16 — ADR заведён: класс «хранилище» выделен из класса Plugin; PostgreSQL — in-tree драйвер из коробки ([PROP-032](./prop-032-history-storage-postgresql.md)).

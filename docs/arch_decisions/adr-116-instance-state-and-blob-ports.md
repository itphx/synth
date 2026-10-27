# ADR-116: Состояние инстанса в SQL и blob-порты на томе

> **Статус:** ⚠️ Частично — решение принято 2026-10-27 и **реализовано** (четыре порта в SQL,
> `blob_refs`, смена корня blob-хранилища, опция блоб-тома с RWX-валидацией); остаток — онлайн-бэкап БД
> и живая миграция, см. «Статус в коде».
> **Дата:** 2026-10-27
> **Принято из:** [PROP-106](./prop-106-file-ports-to-sql.md) (исходная гипотеза; файл остаётся как история).
> **Связано:** [ADR-096](./adr-096-storage-layer.md) (доменные порты и контрактный suite),
> [ADR-097](./adr-097-storage-provider-class.md) (драйвер PostgreSQL),
> [ADR-115](./adr-115-multimodal-input.md) (первый новый потребитель blob-порта — вложения сообщений),
> [ADR-098](./adr-098-storage-degraded-recovery.md) (деградированный режим),
> [ADR-005](./adr-005-json-storage.md) (файловая семантика записи),
> [ADR-046](./adr-046-skills-and-slash-commands.md) (instance-скиллы),
> [ADR-069](./adr-069-project-instructions-agents-md.md) (промпты/инструкции),
> [ADR-075](./adr-075-project-workspace-provisioning.md) (workspace проекта — не состояние инстанса),
> [ADR-077](./adr-077-runtime-toolchain.md) (исполнитель, общий RWX-том workspace — прецедент),
> [ADR-086](./adr-086-extensibility-plugins-editions.md) / [ADR-100](./adr-100-extension-packs-pipelines.md)
> (пакеты расширений и legacy-пайплайны),
> [ADR-091](./adr-091-backup-restore-transfer.md) / [ADR-092](./adr-092-instance-lifecycle-maintenance.md)
> (бэкап/восстановление/миграции),
> [ADR-101](./adr-101-pipeline-engine.md) (артефакты прогонов),
> [ADR-094](./adr-094-observability-metrics.md) (метрики).

## Контекст

Ключевой инвариант: **реплика control plane — не владелец состояния**. Всё, что меняет поведение инстанса
для всех пользователей (реестр установленных пакетов, instance-скиллы, ролевые и пользовательские промпты,
legacy-определения пайплайнов), должно лежать в общем хранилище с транзакциями, а не в каталоге конкретной
реплики.

Сегодня слой хранения (ADR-096) разделён надвое (цифры на 2026-10-27):

- **42 порта** из 47 реализованы в PostgreSQL поверх SQL — это и есть общее состояние инстанса;
- **5 портов** в драйвере PostgreSQL подменены файловыми реализациями core (`skills`, `contextFiles`,
  `blobs`, `pipelines` (legacy), `packs`), лежат в `{dataDir}` и при `backend.replicaCount > 1`
  расходятся между репликами.

Четыре из них — не случайный хвост: ровно те, чьё состояние пишет **установщик пакета расширения**
(ADR-086/ADR-100) одной операцией (реестр установок, legacy-определения, метаданные скиллов, ролевые
промпты). Порознь они не переводятся: реестр в SQL без артефактов даёт «пакет установлен, а артефактов нет»
— поэтому перевод идёт **группой**.

Пятый, `blobs`, — бинарная подложка. Соблазн перевести и его в БД (`bytea`) есть, но он неверен:
содержимое — write-once неизменяемые объекты (вложения сообщений по ADR-115, артефакты прогонов, дерево
скиллов, логи процессов); `bytea` тянет WAL/TOAST и размер `pg_dump`, а бэкап инстанса при
`storage.backend=postgres` и без того не содержит данных БД (ADR-097 в манифесте `synth backup`), то есть
перенос байтов в БД сделал бы `pg_dump`/PITR обязательным условием сохранности вложений. При деградации
хранилища (ADR-098) сервис поднимается read-only на ФС — файловые вложения в этот момент остаются
читаемыми, байты в БД были бы недоступны.

## Решение

1. **В SQL переводятся четыре порта**: `packs`, `pipelines` (legacy), `skills` (метаданные; содержимое —
   в `blobs`), `contextFiles` (пользовательская часть; системные промпты образа остаются на ФС).
2. **`blobs` в SQL не переводится** — остаётся файловым **по конструкции** (байты на томе).
3. **В БД заводится учёт ссылок** — порт `blobRefs` (`blob_path`, `owner_kind`, `owner_id`): дедуп по
   содержимому и детерминированный GC. Файловая и PostgreSQL-реализации — по правилам ADR-096, с
   контрактным блоком.
4. **Том.** По умолчанию — **один** том (`backend.persistence`, `{dataDir}`), блобы — в `{dataDir}/blobs`
   (существующий root `BlobStore`). Отдельный блоб-том — **опция** чарта. При `backend.replicaCount > 1`
   том с блобами обязан быть `ReadWriteMany` — это ограничение деплоя, а не кода.
5. **Миграции** — одна релизная серия (`025_*`; `024_blob_refs` — из ADR-115): `pack_installations`, `pipeline_definitions`,
   `pipeline_instances`, `instance_skills`, `context_files`, `blob_refs`. Повторной миграции по вложениям
   не будет: порт и место метаданных финальны, байты при смене тома/деплоя не переезжают.
6. **`synth storage migrate`** переносит четыре порта (file ↔ postgres), идемпотентно, по доменным
   методам. `blobs` не переносится **никогда** — байты не меняют backend.

## Что переводится

| Порт | Куда | Что снимается |
|---|---|---|
| `packs` | SQL (`pack_installations`) | расхождение реестра установок между репликами; потерянное «снятие пакета» на одной реплике |
| `pipelines` (legacy ADR-100) | SQL (`pipeline_definitions`, `pipeline_instances`) | расхождение legacy-определений/экземпляров; несогласованность с `packs` при снятии пакета |
| `skills` | SQL (`instance_skills`) + содержимое в `blobs` | расхождение instance-скиллов и supporting-файлов; поломка ленивой инвалидации кэша по `mtime`/`size` между репликами |
| `contextFiles` (пользовательская часть) | SQL (`context_files`) | расхождение ролей и пользовательских промптов; агент, поставленный пакетом, на другой реплике не резолвится |

Что **не** переводится и остаётся на ФС осознанно: `blobs` (байты), системные промпты пакета
(`{packageRoot}/prompts` — часть образа), `workspaces/` (пользовательское содержимое, ADR-075),
`secrets/` (инвариант 13), `audit/*.jsonl`, `meta.json`, `backups/`.

## Схема БД

```sql
-- 025_*
CREATE TABLE pack_installations (
  name text PRIMARY KEY,            -- UNIQUE(name)
  version text NOT NULL,
  kind text NOT NULL,
  status text NOT NULL,
  manifest jsonb,
  files jsonb,                      -- содержимое файлов пакета (нужно для отложенной установки)
  installed_by text,
  installed_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE TABLE pipeline_definitions (...);  -- legacy ADR-100 (upsert по id)
CREATE TABLE pipeline_instances  (...);   -- legacy ADR-100 (фильтры pipelineId/status)
CREATE TABLE instance_skills (
  name text PRIMARY KEY,
  frontmatter jsonb,
  updated_at timestamptz NOT NULL
);
CREATE TABLE context_files (
  category text NOT NULL,           -- user | roles
  filename text NOT NULL,
  content text NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (category, filename)
);
CREATE TABLE blob_refs (
  blob_path  text NOT NULL,
  owner_kind text NOT NULL,         -- message | pipeline-run | skill | process
  owner_id   text NOT NULL,
  PRIMARY KEY (blob_path, owner_kind, owner_id)
);
CREATE INDEX blob_refs_owner_idx ON blob_refs (owner_kind, owner_id);
```

`blob_refs` не имеет FK на таблицу блобов — блобов в БД нет; существование объекта проверяет порт.

## Порядок реализации

1. **Том.** Один том по умолчанию (блобы в `{dataDir}/blobs`); отдельный блоб-том — опция чарта
   (второй PVC / `existingClaim` / `accessMode`); при `replicaCount > 1` — обязательный `RWX` на томе с
   блобами. Кода не требует.
2. **Инвентаризация и замеры.** Карта «порт → потребители → объём» для четырёх переводимых портов плюс
   объём `blobs` (логи процессов; будущие вложения/артефакты). Ни одного потребителя мимо порта.
3. **`packs` + legacy `pipelines` → SQL** (миграция `025_*`), сборка контекста переключается на SQL,
   контрактные блоки перестают быть «file-backed».
4. **`blobRefs`** — порт (file/memory/postgres) + контракт; ссылки пишутся при появлении/удалении
   вложений, артефактов, скиллов; GC удаляет объект, когда ссылок не осталось.
5. **`skills` → SQL** (`instance_skills` + содержимое в `blobs`); из `SkillRepository` убираются
   `root()`/`skillDir()`, `engine/skills/{service,loader,discovery}.ts` читают содержимое через blob-порт.
6. **`contextFiles` (пользовательская часть) → SQL**; системная часть остаётся на ФС; синхронные геттеры —
   из процесс-локального кэша по сигнатуре версии.
7. **Миграция данных** (`synth storage migrate`): четыре порта, оба направления, идемпотентно; `blobs` не
   участвует.
8. **Сужение рантайм-импорта core в драйвере**: вместо `createFileStorage` — только `FileBlobStore`
   (порт `blobs` остаётся файловым).

## Последствия и границы

- **Хорошо:** состояние инстанса единое при `replicaCount > 1`; установка/снятие пакета согласованы с
  реестром; снимается расхождение скиллов/ролей; `pg_dump` не раздувается от медиа; при падении БД
  вложения остаются читаемыми (ADR-098); `PROP-105` (claim-семантика очереди) перестаёт упираться в
  файловые порты.
- **Цена:** появляется вторая процедура бэкапа (ФС-периметр + БД) — фиксируется в runbook; NFS-том для
  блобов при мультиреплике (профиль холодных данных, а не горячих: сессии/события/настройки уже в SQL).
- **Границы:** `workspaces/`, `secrets/`, `audit/*.jsonl`, `meta.json`, `backups/` остаются файловыми
  всегда. Код плагинов (`plugin/installed`, карантин) и instance-команды (`commands/*.md`) в этот объём
  **не входят** — их судьба решается в 2b.1 (общий том под `plugin/` или установка per-replica).
- `blobs` не участвует в `synth storage migrate` ни при каких условиях.

## Статус в коде

**Реализовано (2026-10-27):**

- `blob_refs` — порт (file/memory/PG) + миграция `024_blob_refs`; `blobs` остаётся файловым, корень
  `{dataDir}/blobs` (+ one-time перенос логов `processes/`, реестр фоновых прогонов не переносится);
- `packs` и legacy `pipelines` — SQL (`025_packs_pipelines`): `pack_installations`,
  `pipeline_definitions`, `pipeline_instances`; установка/снятие пакета согласованы с реестром;
- `skills` — `026_instance_skills` (метаданные) + содержимое в `blobs` (`skills/<name>/…`);
  `SkillRepository` больше не отдаёт путей (`listFiles`), домен (discovery/loader/service/watcher)
  читает через порт, подпись кэша — «имя + размер SKILL.md»;
- `contextFiles` (пользовательская часть) — `027_context_files`; синхронные геттеры читают
  процесс-локальный кэш, инвалидация по `max(updated_at)` с TTL 5 с; системные промпты образа — ФС;
- `synth storage migrate` переносит `packs`, legacy `pipelines`, `skills` (целиком через порт),
  `contextFiles` — в обе стороны; `blobs` не переносится никогда;
- драйвер PostgreSQL больше не собирает файловый контекст: рантайм-импорт core сужен до
  `FileBlobStore` + `prepareBlobRoot`/`blobRootPath` и `ContextConfig` (системные промпты);
- чарт: `backend.blobs.enabled` (отдельный PVC/`existingClaim`, mount `<dataDir>/blobs`),
  `fail` при `replicaCount > 1` без `ReadWriteMany` на томе с блобами;
- контрактный suite гоняет `packs`/`pipelines`/`skills`/`contextFiles` на живом PostgreSQL
  (в CI — задача `test-postgres`).

**Остаток:**

- `synth backup` по-прежнему снимает файловый периметр отдельно от БД: согласованный онлайн-срез
  (PITR/дамп в тот же момент) — остаток ADR-091, не решён этим ADR;
- вне объёма и остаются файловыми: `commands/*.md`, код плагинов (`plugin/installed`, карантин,
  approvals), `secrets/`, `workspaces/`, `audit/*.jsonl`, `meta.json`, `backups/`, кэши;
- retention артефактов прогонов не введён (`removeRun` есть, вызывать негде — удаления прогонов нет);
- `packs.files` хранится в `jsonb`; отдельная таблица `pack_files` не заводилась;
- живая миграция «на лету» (переключение портов без остановки) не сделана.

## Открытые вопросы

1. `packs.files` — оставить `jsonb` (сейчас) или вынести в `pack_files` при росте пакетов?
2. Нужен ли режим миграции без простоя (двойное чтение) и какой приоритет при расхождении?
3. Retention артефактов прогонов: TTL по возрасту прогона или явная очистка админом?

## Открытые вопросы

1. `contextFiles`: граница ФС/БД — предлагается «системные промпты образа на ФС, пользовательские в БД».
2. Инвалидация кэша `contextFiles` — TTL, сигнатура версии в БД или событие?
3. `packs.files` — `jsonb` (TOAST) или отдельная таблица `pack_files`?
4. GC и `blob_refs`: удалять сразу при потере последней ссылки, с отсрочкой или только sweep? Кто владельцы
   ссылок для логов (свой retention) и артефактов (retention прогонов)?
5. Чарт: имя опции отдельного блоб-тома и должна ли схема падать при `replicaCount > 1` с `RWO` на томе
   с блобами.
6. Миграция без простоя: нужен ли режим «на лету» и какой приоритет при двойном чтении четырёх портов.

## История

- 2026-10-27 — принято как ADR-116 из [PROP-106](./prop-106-file-ports-to-sql.md). Ключевые решения:
  байты `blobs` остаются на томе (в БД только `blob_refs`); в SQL идут четыре порта; том один по умолчанию,
  отдельный — опция, `RWX` обязателен при `replicaCount > 1`; инвентарь пересчитан (47 портов, 5 файловых).
- 2026-10-22 — зафиксирована проблема (PROP-106): 5 портов остаются файловыми даже под PostgreSQL.

# PROP-106: Файловые порты инстанса в SQL: единое состояние при нескольких репликах

> **Статус:** 🧩 Предложение — перевод оставшихся файловых портов инстанса в SQL (packs, skills, blobs, contextFiles); общий RWX-том — промежуточная мера
> **Решение до:** 2026-11-14
> **Дата:** 2026-10-22
> **Источник:** 2026-10-22 (аудит готовности Synth к backend.replicaCount > 1)
> **Связано:** ADR-046, ADR-069, ADR-086, ADR-096, ADR-097, ADR-100, ADR-101

**Решение:** файловые порты слоя хранения, которые остаются файловыми даже под PostgreSQL
(`packs`, `pipelines` (legacy), `skills`, `contextFiles`, `blobs`), переводятся в SQL, чтобы состояние
инстанса было единым независимо от числа реплик control plane. Перевод `data`-тома на общий RWX — промежуточная
мера: она закрывает расхождение состояния ценой общей ФС вместо транзакций, но не переносит состояние в SQL и
не решает вопрос на будущее.

## Решение

Ключевой инвариант: **реплика control plane — не владелец состояния**. Всё, что меняет поведение инстанса
для всех пользователей (реестр установленных пакетов расширений, instance-скиллы, ролевые промпты и
пользовательские промпты, определения пайплайнов), должно лежать в общем хранилище с транзакциями, а не в
каталоге конкретной реплики.

Сегодня слой хранения (ADR-096) разделён надвое:

- **31 порт** из 36 реализован в PostgreSQL поверх SQL — это и есть общее состояние инстанса;
- **5 портов** в драйвере PostgreSQL подменены файловыми реализациями core — они лежат в `{dataDir}` и при
  `backend.replicaCount > 1` расходятся между репликами.

Пять «оставшихся» портов — это не случайный хвост: ровно те, чьё состояние пишет **установщик пакета
расширения** (ADR-086/ADR-100) одной операцией — реестр установок, legacy-определения пайплайнов, дерево
скиллов и ролевые промпты. Порознь они не переводятся: перенос реестра в SQL без переноса артефактов даёт
худший вариант — «реестр говорит, что пакет установлен, а файлов на диске нет». Поэтому перевод идёт
**группой**.

Что переводится:

| Порты | Куда | Что снимается |
|---|---|---|
| `packs` | SQL (`pack_installations`) | расхождение реестра установок между репликами; потерянное «снятие пакета» на одной реплике |
| `pipelines` (legacy ADR-100) | SQL (`pipeline_definitions`, `pipeline_instances`) | расхождение legacy-определений/экземпляров; несогласованность с `packs` при снятии пакета |
| `skills` | SQL (`instance_skills` + содержимое в `blobs`) | расхождение instance-скиллов и supporting-файлов; поломка ленивой инвалидации кэша по mtime/size между репликами |
| `contextFiles` | SQL (пользовательская часть: `{dataDir}/context/user`, `{dataDir}/context/roles`) | расхождение ролей и пользовательских промптов; агент, поставленный пакетом, на другой реплике не резолвится |
| `blobs` | SQL (`blobs`) | подложка для `skills` (дерево скиллов по замыслу порта уезжает в `BlobStore`) |

Что **не** переводится и остаётся на ФС осознанно:

- **системные промпты пакета** (`{packageRoot}/prompts`) — часть образа, одинакова на всех репликах, read-only;
  переносить в БД нечего;
- **`workspaces/`** — рабочие каталоги проектов (ADR-075), пользовательское содержимое, а не состояние инстанса;
  в split-режиме это общий RWX-том исполнителя (ADR-077);
- **`secrets/`** — мастер-ключ, ключи сервисов, токен метрик (инвариант 13, ADR-076): файловые по политике;
- **`audit/llm-gateway.jsonl`** — журнал LLM Gateway вне портов (в БД есть отдельный порт `securityAudit`);
- **`meta.json`** — версия схемы файлового периметра (ADR-092); у PostgreSQL свой контур версионирования схемы;
- **`backups/`** — архивы бэкапов.

## Что уже есть

| Факт | Где |
|---|---|
| В `StorageContext` — **36 портов** (не 34: `DocumentRepository<T>` используется трижды — `providers`/`models`/`agents`) | `packages/core/src/storage/storage-context.ts:279-325` |
| Файлов-описаний портов — **34** (`packages/core/src/storage/ports/*` без `index.ts` и `collection-limit.ts`) — отсюда «34 порта» в документации | `packages/core/src/storage/ports/` (34 файла) |
| В драйвере PostgreSQL **5 портов остаются файловыми**: `skills`, `contextFiles`, `blobs`, `pipelines` (legacy), `packs` | `packages/storage-postgres/src/storage-context.ts:160-170` |
| Файловые порты подключаются через `createFileStorage` — это **рантайм-импорт core** в драйвере (сознательное исключение, разрывающее цикл core ↔ драйвер) | `packages/storage-postgres/src/storage-context.ts:32`, `:71-79` |
| Остальные **31 порт** реализованы поверх SQL семью группами: `sessions`/`principals`/`events`/`content`/`audit`/`analytics`/`pipelines` | `packages/storage-postgres/src/ports/{sessions,principals,events,content,audit,analytics,pipelines}.ts` |
| `packs` — один JSON-файл `{dataDir}/packs.json`, ключ записи — имя пакета, блокировка — `AsyncLock` **в процессе** | `packages/core/src/storage/file-pack-store.ts:19`, `:32`, `:26` |
| `pipelines` (legacy) — `{dataDir}/pipelines/definitions.json` + `{dataDir}/pipelines/instances.json` | `packages/core/src/storage/file-pipeline-store.ts:27-28`, `:40-51` |
| `skills` — дерево файлов `{dataDir}/skills/<name>/SKILL.md` (+ supporting-файлы) | `packages/core/src/storage/skill-store.ts:32`, `:43`, `:49` |
| `contextFiles` — слияние **системной** части (`{packageRoot}/prompts`, часть образа) и **пользовательской** (`{dataDir}/context/{user,roles}`) | `packages/core/src/storage/storage-context.ts:492`, `:535-538`; `packages/core/src/engine/context/config.ts:62-64`, `:108-199` |
| `blobs` — `FileBlobStore({ root: dataDir })`; **потребителей в домене нет** (порт зарезервирован под дерево скиллов) | `packages/core/src/storage/storage-context.ts:544`; единственные упоминания — сборка контекста и контракт |
| Порт `SkillRepository` отдаёт **ФС-пути** (`root()`, `skillDir()`) — домен читает `SKILL.md` и supporting-файлы прямо с диска | `packages/core/src/storage/ports/skill-repository.ts:9-16`; `packages/core/src/engine/skills/service.ts:230`, `:251`; `packages/core/src/engine/skills/loader.ts:16-37` |
| Порт `ContextFileRepository` — **синхронные** геттеры (сборка промпта на горячем пути) + `systemPromptsDir` в интерфейсе | `packages/core/src/storage/ports/context-file-repository.ts:15-18` |
| Установщик пакета пишет **артефакты в FS-порты** (скиллы → `skills`, роли → `contextFiles`), а **реестр** — в порт `packs`; операция не транзакционна | `packages/core/src/server/routes/packs.ts:485-529` (скиллы), `:609-640` (роли), `:889`, `:919`, `:960`, `:1031` (реестр) |
| Снятие пакета удаляет legacy-определение пайплайна — то есть `packs` и legacy `pipelines` связаны | `packages/core/src/server/routes/packs.ts:1019-1020` |
| `synth storage migrate` **не переносит** `blobs`/`skills`/`contextFiles` — «файловые в обоих backend'ах»; `packs`/legacy `pipelines` в списке переносимых тоже нет | `packages/core/src/maintenance/storage-migrate.ts:11-24` |
| Координация в БД — session-level advisory-локи (`PgMutex`/`PgLeader`), публикуются через `StorageContext.locks` | `packages/storage-postgres/src/locks.ts:243-261`; `packages/storage-postgres/src/storage-context.ts:147` |
| Managed PVC `data` — `accessMode: ReadWriteOnce` → **на реплику свой том** | `charts/synth/values.yaml:51`; `charts/synth/templates/backend-pvc.yaml:16-17` |
| `keepOnUninstall` по умолчанию `false`; PVC переживает `helm uninstall` только при явном включении (аннотация обязана быть в манифесте релиза) | `charts/synth/values.yaml:56`; `charts/synth/templates/backend-pvc.yaml:9-13` |
| `backend.replicaCount` по умолчанию `1`; sticky-сессии (`sessionAffinity`) закрывают только WS-шину | `charts/synth/values.yaml:16`, `:38-42` |
| В кластере есть RWX-класс `nfs-rwx` (provisioner `nfs.csi.k8s.io`) — он уже используется под общий workspace исполнителя | `charts/synth/README.md:667-671`; `charts/synth/values.yaml:309-313` |
| Контрактный suite: **34 блока** на PostgreSQL, из них 5 помечены «file-backed» | `packages/core/src/storage/contract/postgres.test.ts:164-219` (отметки «file-backed» — `:189`, `:200`, `:204`, `:208`, `:209`) |
| Схема БД версионируется своим контуром; последняя миграция — `005_pipeline_provenance` | `packages/storage-postgres/src/migrations/index.ts:30-34` |
| `synth backup`/`synth restore` покрывают **только файловый периметр**; данных БД в архиве нет (бэкап БД — средствами СУБД) | `docs/MAINTENANCE.md:114-116`, `:353-359` |
| В живом кластере `/var/synth/data` содержит `packs.json` (32 КБ), `pipelines/`, `skills/`, `agents/`, `context/`, `providers/`, `models/`, `projects/`, `sessions/` — файловый backend на per-replica томе | по данным аудита от 2026-10-22 (в репозитории не проверяется) |

## Инвентаризация портов

Полный список — `packages/core/src/storage/ports/*` (34 файла-описания → 36 портов в `StorageContext`).
Ниже — срез по месту реализации в драйвере PostgreSQL и по тому, что теряется при файловой реализации.
Приоритет: **1** — переводится в рамках одной группы (см. «Порядок реализации»), **2** — переводится как
подложка для группы 1, **—** — уже в SQL, действий не требует.

| Порт | Где реализован | Что теряется при файловой реализации | Приоритет |
|---|---|---|---|
| `packs` | файл: `{dataDir}/packs.json` (`file-pack-store.ts:32`) | Реестр установок расходится между репликами: админ на реплике A видит пакет, на реплике B — нет. `DELETE /packs/:name` на A не снимает на B. Уникальность имени пакета держит только `AsyncLock` в процессе (`file-pack-store.ts:26`) — между репликами не защищена. | **1** |
| `pipelines` (legacy ADR-100) | файл: `{dataDir}/pipelines/{definitions,instances}.json` (`file-pipeline-store.ts:40-51`) | Legacy-определения и экземпляры расходятся; снятие пакета удаляет определение только на одной реплике (`packs.ts:1019-1020`); нет транзакции с `packs`. | **1** |
| `skills` | файл: дерево `{dataDir}/skills/<name>/` (`skill-store.ts:43`) | Instance-скиллы и supporting-файлы расходятся; ленивая инвалидация кэша по сигнатуре `id:floor(mtimeMs):size` (`engine/file-signature.ts`) между репликами не работает — реплика не видит правку соседки. | **1** |
| `contextFiles` | файл: `{dataDir}/context/{user,roles}` + промпты образа (`storage-context.ts:492`, `config.ts:62-64`) | Пользовательские роли и промпты расходятся; ролевой промпт агента, поставленного пакетом, на другой реплике отсутствует → агент не резолвится в Router (`agentTemplate → null`, сессия не создаётся). | **1** |
| `blobs` | файл: `FileBlobStore({ root: dataDir })` (`storage-context.ts:544`) | Потребителей нет — расхождения не видно. Но это **единственная** подложка, к которой порт `skills` может уехать по собственному замыслу (`skill-repository.ts:9-10`). | **2** |
| `skillBundles` | SQL: `skill_bundles` | — | — |
| `mcpRegistry` | SQL: `mcp_registry` | — | — |
| `sshKeys` | SQL: `ssh_keys` | — | — |
| `serviceKeys` | SQL: `service_keys` | — | — |
| `sessions` | SQL: `sessions`/`messages`/`session_references`/`checkpoints`/`sticky_notes` | — | — |
| `projects` | SQL: `projects`/`project_members` | — | — |
| `profiles` | SQL: `profiles`/`profile_identities` | — | — |
| `settings` | SQL: `settings`/`token_ratios`/`migration_markers` | — | — |
| `defaults` | SQL: `settings` | — | — |
| `secretPatterns` | SQL: `settings` (write-through + прогрев) | Кэш синхронных геттеров — процесс-локальный: правка соседней реплики видна только после рестарта (`packages/storage-postgres/AGENTS.md` §«Известные расхождения») | — |
| `protectedPaths` | SQL: `settings` | То же ограничение кэша | — |
| `dictionaries` | SQL: `settings` | То же ограничение кэша | — |
| `providers` / `models` / `agents` | SQL: `documents` (`createDocumentPort`, `principals.ts:51-53`) | — | — |
| `eventBindings` / `eventRoutes` / `eventApiKeys` | SQL: `event_bindings`/`event_routes`/`event_api_keys` | — | — |
| `eventJournal` / `identityClaims` / `dedup` | SQL: `event_journal`/`identity_claims`/`dedup` | Retention `dedup` не реализован — таблица растёт (`packages/storage-postgres/AGENTS.md`) | — |
| `schedules` / `jobs` | SQL: `schedules`/`jobs` | — | — |
| `webhooks` / `webhookDeliveries` | SQL: `webhooks`/`webhook_deliveries` | — | — |
| `maintenanceAudit` | SQL: `maintenance_audit` | — | — |
| `securityAudit` / `egressRequests` | SQL: `security_audit`/`egress_requests` | — | — |
| `analyticsRollups` | SQL: `analytics_rollups` | — | — |
| `projectPipelines` | SQL: `pipeline_specs`/`pipeline_versions` | — | — |
| `pipelineRuns` | SQL: `pipeline_runs`/`pipeline_run_events` | — | — |

Итого: **5 портов** требуют перевода, **31** уже в SQL, из них у трёх (`secretPatterns`, `protectedPaths`,
`dictionaries`) остаётся ограничение процесс-локального кэша синхронных геттеров — оно не связано с
файловыми портами, но при нескольких репликах тоже даёт «правка видна не сразу».

## Почему файловые порты плохи именно при нескольких репликах

1. **Расхождение состояния.** Реплика A и реплика B читают и пишут разные файлы. Пользователь видит разные
   списки пакетов/скиллов/ролей в зависимости от того, на какой под попал его запрос; админ, снявший пакет,
   увидит, что на половине инстанса пакет ещё «установлен». Обратная ситуация опаснее: агент, поставленный
   пакетом, на реплике A резолвится (есть ролевой промпт в `contextFiles`), а на реплике B — нет
   (`agentTemplate → null`, сессия не создаётся), и это выглядит как «мистический» сбой маршрутизации.

2. **Нет транзакций и claim-семантики.** Файловая реализация `packs` защищена `AsyncLock` **внутри процесса**
   (`file-pack-store.ts:26`) — это не межпроцессная и не межрепличная блокировка. Операция «установить пакет»
   пишет артефакты (скиллы, роли) и только потом пишет реестр — при обрыве между шагами реестр и файловая
   часть расходятся **внутри одного инстанса** (`packs.ts:485-529` → `:889`). Claim-семантика очереди
   (обсуждается в PROP-105) на файловом порте не выражается вовсе.

3. **Несовместимость с `StorageContext.locks`.** Advisory-локи БД (`PgMutex`/`PgLeader`,
   `packages/storage-postgres/src/locks.ts:243-261`) защищают SQL-порты и файловые локи миграций. Файловые
   порты под advisory-лок не попадают — «транзакция» файлового порта и «транзакция» SQL-порта не могут
   быть одной.

4. **Свой бэкап/восстановление/миграции.** `synth backup` снимает файловый периметр и **не содержит данных
   БД** (`docs/MAINTENANCE.md:114-116`); `synth restore` БД не трогает (`:357-359`); `synth storage migrate`
   не переносит `blobs`/`skills`/`contextFiles` и не переносит `packs`/legacy `pipelines`
   (`storage-migrate.ts:11-24`). Пока часть состояния — в файлах, часть — в БД, восстановление инстанса
   требует **двух** независимых процедур и не даёт согласованного среза.

5. **Поведение при `helm uninstall` и `keepOnUninstall`.** PVC `data` по умолчанию удаляется при
   `helm uninstall` (`charts/synth/values.yaml:56`), а при `keepOnUninstall: true` переживает снятие релиза
   (аннотация обязана быть в манифесте — `backend-pvc.yaml:9-13`). Данные БД при этом по умолчанию **не**
   удаляются (`uninstall --purge-db` — только по явному флагу, `docs/MAINTENANCE.md:360`). Смешанная модель
   «часть в томе, часть в БД, части — с разным TTL» плохо предсказуема при откате релиза.

6. **Разный backend — разное поведение.** Тот же инстанс на `storage.backend=file` и на
   `storage.backend=postgres` сегодня даёт разный ответ на вопрос «где лежит реестр пакетов» (ADR-005 vs
   ADR-097). Для нескольких реплик это превращается в «состояние зависит от того, какой backend выбран и на
   каком поде попал запрос».

## Промежуточная мера — общий RWX-том `data`

**Что даёт.** Один PVC с `accessMode: ReadWriteMany` вместо `ReadWriteOnce`
(`charts/synth/values.yaml:51` → `ReadWriteMany`) монтируется во все реплики. Все пять файловых портов
начинают видеть одно и то же состояние; расхождение между репликами исчезает **без изменений в коде**;
исчезает и вторая проблема managed-режима — второй под не может смонтировать RWO-том (`backend-pvc.yaml:16-17`).
Класс `nfs-rwx` в кластере уже есть и уже используется под общий workspace исполнителя
(`charts/synth/README.md:667-671`).

**Чего не даёт.**

- **Это не транзакции.** Файловая семантика: атомарная запись — это tmp→rename в пределах одной ФС
  (ADR-005), а не атомарность набора записей. «Установить пакет» по-прежнему может оставить артефакты без
  записи в реестре.
- **Нет claim-семантики.** Файловый лок (`FileMutex` — mkdir-лок) умеет только «встать в очередь», но не
  выражает «я забрал эту задачу» в смысле PROP-105.
- **«Hot data» на NFS.** Каталог данных инстанса — это то, что backend читает и пишет на каждом запросе
  (сессии, события, настройки). В перспективе перевода в SQL это самая горячая часть; NFS для неё — заметно
  дороже и капризнее локального тома (locking, кэш атрибутов, `fsync`).
- **Свой бэкап.** RWX-том — это ФС: снятие согласованного среза с работающим инстансом по-прежнему не
  гарантировано (`--live` полноты не гарантирует — `docs/MAINTENANCE.md:356`).
- **Это не решает вопрос на будущее.** RWX убирает симптом (расхождение), но не меняет модель: состояние
  инстанса по-прежнему не имеет транзакций, схемы, миграций и не попадает в `pg_dump`/PITR. Масштабирование
  control plane всё равно упрётся в файловые порты.

**Совместимость с целевым состоянием.** RWX — **промежуточная** мера, а не тупик:

- на RWX работают те же пять портов; при переводе в SQL данные снимаются с RWX **через порты**
  (`synth storage migrate` — идемпотентный перенос по доменным методам, `storage-migrate.ts:4-9`),
  а не копированием файлов;
- после перевода в SQL файловая часть `{dataDir}` на RWX-томе остаётся только для **вне-портового** периметра
  (`workspaces/`, `secrets/`, `audit/*.jsonl`, `meta.json`, `backups/`) — то, что переводить не нужно;
- двойного источника истины не возникает: в каждый момент времени либо порт читается из SQL (истина в БД),
  либо — из файла (истина на томе), но не оба сразу; переключение — миграция с откатом (см. «Обратная
  совместимость»).

## Дельта

| Что | Сегодня | Стало |
|---|---|---|
| Реестр пакетов расширений | JSON на томе реплики; видно только «свою» реплику | Таблица `pack_installations` в БД; `UNIQUE(name)`, `upsert` в транзакции, `installed_by`/`manifest`/`files` — `jsonb` |
| Legacy-определения пайплайнов | JSON на томе реплики | `pipeline_definitions`/`pipeline_instances` в БД; снятие пакета — в одной транзакции с записью реестра |
| Instance-скиллы | Дерево файлов на томе реплики | Таблица `instance_skills` (метаданные + frontmatter) + содержимое в `blobs`; порт `SkillRepository` теряет `root()`/`skillDir()` — файловые пути уходят из интерфейса |
| Роли и пользовательские промпты | `{dataDir}/context/{roles,user}` на томе реплики | Таблица `context_files` в БД; **системная** часть (промпты образа) остаётся на ФС и читается как раньше; геттеры — из кэша, обновляемого по сигнатуре версии |
| `BlobStore` | `FileBlobStore` на томе реплики | `PostgresBlobStore` (`path` PK + `data bytea` + `size`/`updated_at`) |
| Установка пакета | Артефакты на ФС, потом запись в реестр — без транзакции | Одна транзакция БД: реестр + определения пайплайнов + артефакты (скиллы/роли) записываются согласованно |
| Снятие пакета | Удаление на одной реплике | Одна транзакция: реестр + артефакты + порождённые правила маршрутизации |
| `synth storage migrate` | Не переносит `skills`/`contextFiles`/`blobs` | Переносит все 5 портов (file ↔ postgres) — общий путь миграции RWX → SQL |
| `synth backup` | Файловый периметр; данных БД нет | Файловый периметр + данные БД (отдельным шагом — `pg_dump`/PITR, см. ADR-091/092) |

**Оценка объёма.**

| Часть | Оценка |
|---|---|
| Новые SQL-реализации в `packages/storage-postgres/src/ports/` | 4–5 модулей, ориентир — существующий `ports/pipelines.ts` (427 строк) для пары портов; реализация `packs`/`legacy pipelines` — порядка 300–400 строк на оба, `skills`+`blobs` — 250–350, `contextFiles` — 200–300 (из-за слияния с системной частью) |
| Миграция схемы БД | одна новая миграция `006_*` (таблицы `pack_installations`, `pipeline_definitions`, `pipeline_instances`, `instance_skills`, `context_files`, `blobs`) либо две, если `packs`/`pipelines` идут раньше `skills`/`contextFiles` |
| Правка портов в core | `SkillRepository` — убрать `root()`/`skillDir()` (2 метода) + правки в `engine/skills/{service,loader}.ts` и `engine/skills/discovery.ts` (чтение `SKILL.md`/supporting-файлов перестаёт быть FS-операцией) |
| Правка домена | `engine/skills/service.ts` (`collectSupportingFiles(this._store.skillDir(name))` — `:230`, `instanceDir` — `:251`), `engine/context/config.ts` (639 строк — чтение FS → чтение кэша+БД) |
| Правка драйвера | `storage-context.ts:160-170` — заменить 5 файловых портов на SQL; снять рантайм-импорт `createFileStorage` (`storage-context.ts:32`, `:71-79`) — **это снимает сознательное исключение «драйвер тянет core рантаймом»** и возвращает цикл core ↔ драйвер к чистой схеме «core → драйвер, драйвер → core только типами» |
| Тесты | контрактный suite: 5 существующих блоков перестают быть «file-backed» (`contract/postgres.test.ts:189`, `:200`, `:204`, `:208`, `:209`); для `packs`/`legacy pipelines` контракт уже есть (`contract/pack-repository.contract.ts`, `contract/pipeline-repository.contract.ts`) — домен не меняется |

**Риски для `storage-postgres`.** Новые таблицы и индексы (уникальность `pack_installations.name`,
`instance_skills.name`, `context_files(category, filename)`); новая миграция в собственном контуре
версионирования (`migrations/index.ts:30-34`, следующий номер — `006`); риск «схема в БД новее ожидаемой»
(`STORAGE_POSTGRES_SCHEMA_TOO_NEW`, fail-closed) — при откате релиза с новой миграцией старый драйвер
не поднимется, это **штатное** поведение, но его надо держать в голове при раскатке.

**Риски для контрактного suite.** Каждая реализация обязана пройти общий suite
(`packages/core/src/storage/contract/*` — «паспорт» порта, эталон — memory-backend). Для новых SQL-портов
это значит: (а) контрактные блоки уже существуют и должны начать проверять SQL-реализацию, а не файловую
(достаточно снять пометку «file-backed»); (б) `describeSkillRepository` и `describeContextFileRepository`
проверяют поведение, а не ФС-детали, — но после снятия `root()`/`skillDir()` из порта контрактные блоки
должны быть переписаны под новый интерфейс (иначе они не сойдутся с портом); (в) контракт для `blobs`
уже есть (`contract/misc.ts` — round-trip, рекурсивный `list`, containment) и переносится без изменений.

## Порядок реализации

1. **Промежуточная мера: общий RWX-том `data`.** `backend.persistence.accessMode: ReadWriteMany` +
   класс `nfs-rwx` (`charts/synth/values.yaml:51`). Ни строчки доменного кода. Снимает расхождение и
   «второй под Pending» разом; попутно появляется рабочая площадка для проверки перевода. Проверка:
   `kubectl -n synth get pvc` показывает один claim с `ReadWriteMany`, все поды монтируют его в
   `/var/synth/data`; расхождение реестра пакетов между репликами исчезает.
2. **Инвентаризация и замеры.** Зафиксировать фактические размеры и карту использования пяти портов
   (кто читает/пишет, какие файлы, сколько занимает `packs.json`/`skills/`/`context/`). Проверка: таблица
   «порт → потребители → объём» в задаче; ни одного потребителя мимо порта.
3. **Перевод группы 1: `packs` + legacy `pipelines`.** SQL-реализации в драйвере + миграция `006`;
   сборка контекста переключается с `file.packs`/`file.pipelines` на SQL
   (`packages/storage-postgres/src/storage-context.ts:169-170`); контрактные блоки `packs`/`pipelines`
   перестают быть «file-backed» (`contract/postgres.test.ts:208-209`). Проверка: контрактный suite на живой
   PostgreSQL (`SYNTH_TEST_POSTGRES_DSN`) зелёный; `synth storage migrate --to postgres` переносит реестр.
4. **Перевод группы 2: `blobs` + `skills`.** Сначала SQL-реализация `BlobStore` (таблица `blobs`) — она же
   подложка для дерева скиллов; затем `skills`: `instance_skills` (метаданные) + содержимое в `blobs`;
   **переработать порт** — убрать `root()`/`skillDir()` (`ports/skill-repository.ts:14-16`), перевести
   `engine/skills/{service,loader}.ts` и `discovery.ts` с чтения ФС на чтение содержимого из порта.
   Проверка: контракт `describeSkillRepository` переписан под новый интерфейс и зелёный на file/memory/PG;
   `GET /api/v2/skills` показывает те же данные.
5. **Перевод группы 3: `contextFiles` (пользовательская часть).** Таблица `context_files`; **системная**
   часть (промпты образа) остаётся на ФС и читается как раньше; геттеры порта — из процесс-локального кэша,
   обновляемого по сигнатуре версии (по образу `filesSignature`/`dirsSignature`,
   `packages/core/src/engine/file-signature.ts`). Проверка: ролевой промпт, записанный на реплике A,
   виден на реплике B; сборка системного промпта не изменилась (golden-снимки).
6. **Миграция данных.** `synth storage migrate --to postgres` переносит все пять портов (идемпотентно,
   по доменным методам — `storage-migrate.ts:4-9`); список «что переносится» в шапке модуля обновляется
   (`storage-migrate.ts:11-24`); добавляется обратное направление (postgres → file) для отката.
   Проверка: прогон на копии боевого `dataDir` — счётчики `copied`/`skipped` совпадают с ожидаемыми,
   повторный прогон даёт `skipped` (идемпотентность).
7. **Снятие RWX-зависимости.** После перевода всех пяти портов файловый периметр `{dataDir}` ограничен
   вне-портовыми вещами (`workspaces/`, `secrets/`, `audit/*.jsonl`, `meta.json`, `backups/`); том `data`
   возвращается к `ReadWriteOnce`, если он больше не общий. Одновременно: снять рантайм-импорт core из
   драйвера (`storage-context.ts:32`, `:71-79`) — сознательное исключение «FS/package-bound порты тянут core
   рантаймом» больше не нужно, и цикл core ↔ драйвер возвращается к чистой схеме. Проверка: в драйвере не
   осталось статических/рантайм-импортов core (кроме `import type`); `pnpm --filter @itphx/synth-storage-postgres build`
   и `pnpm test` зелёные.

### Обратная совместимость

- **Существующие инстансы** (`storage.backend=file`): файлы продолжают работать как раньше — файловые
  реализации остаются в core и выбираются по-прежнему; перевод меняет только **драйвер PostgreSQL**
  (`storage-context.ts:160-170`), то есть затрагивает инстансы с `storage.backend=postgres`. Файловый backend
  standalone/local home (ADR-005, ADR-079) не трогаем — это его штатный режим.
- **Миграция данных** — только через порты (`synth storage migrate`), идемпотентно, с отчётом по сущностям.
- **Что с `data`-томом в итоге:** он не исчезает, а **сжимается по назначению**: `workspaces/`, `secrets/`,
  `audit/*.jsonl`, `meta.json`, `backups/` остаются файловыми всегда; `accessMode` тома можно вернуть к
  `ReadWriteOnce`, если общий том больше не нужен.
- **Откат:** пока в БД нет новых таблиц (шаги 1–2) — откат свободный. После шага 3 откат требует либо
  обратного переноса (`migrate --to file`), либо сохранения БД как есть; схема «новее ожидаемой»
  (`STORAGE_POSTGRES_SCHEMA_TOO_NEW`) блокирует старт старого драйвера — это fail-closed, штатное поведение.
- **Стыковка с PROP-105** (координация в нескольких репликах): claim-семантика очереди требует, чтобы
  «взял задачу» было атомарным и наблюдаемым — файловый порт этого не даёт, SQL-порт даёт. Поэтому шаги
  3–5 — предусловие для полноценной claim-семантики (шаг 1 снимает только симптом).
- **Стыковка с PROP-104** (внешний транспорт событий): доставка внешнего события в сессию опирается на
  `eventBindings`/`eventRoutes`/`eventJournal` — они уже в SQL, поэтому файловые порты на неё не влияют;
  влияние косвенное — через `packs`/`skills`/`contextFiles` (агент, чей ролевой промпт или скилл не виден
  на реплике, не отработает).

## Открытые вопросы

1. **Форма `skills` в SQL.** Вариант A — своя таблица `instance_skills` (метаданные + frontmatter + тело),
   supporting-файлы — отдельными строками. Вариант B — единое дерево в `blobs` (по замыслу порта:
   «дерево скиллов переводится на `BlobStore`, а path-методы уходят из порта»,
   `ports/skill-repository.ts:9-10`). Нужен выбор владельца: B честнее по отношению к замыслу, A проще.
2. **`contextFiles`: где граница ФС и БД.** Предлагается: системные промпты (часть образа, одинаковы на всех
   репликах) — всегда ФС; пользовательские override (`{dataDir}/context/{user,roles}`) — БД. Подтвердить.
3. **Синхронные геттеры `contextFiles`.** Порт синхронный (сборка промпта на горячем пути), SQL-чтение
   асинхронно → нужен кэш в процессе. Как часто он инвалидируется: по TTL, по сигнатуре версии в БД
   (как `secretPatterns`/`protectedPaths` сейчас — процесс-локальный кэш, см. «Известные расхождения»
   в `packages/storage-postgres/AGENTS.md`) или по событию?
4. **Размер `packs.files`.** Порт хранит содержимое файлов пакета целиком (`ports/pack-repository.ts:56-65`),
   в JSONB это может быть крупно (TOAST). Отдельная таблица `pack_files` или оставить в `jsonb`?
5. **Будет ли RWX долговременным.** Если PROP-104/PROP-105 потребуют общего тома не только для `data`, но и
   для workspace/секретов — RWX перестаёт быть «промежуточной мерой» и становится частью целевой схемы.
   Нужно решение до шага 7.
6. **Миграция без простоя.** `synth storage migrate` требует остановки инстанса? Сейчас перенос идемпотентен
   и по доменным методам, но «живая» миграция (backend работает, порты переключаются) — не описана.
   Нужен ли режим «миграция на лету» с двойным чтением?
7. **Кто истина при расхождении RWX и SQL** во время миграции (шаг 6)? Пока порт один — расхождения нет;
   если миграция пойдёт «на лету», нужен явный приоритет (read-old/write-new и т. п.).

## Зависимости

- [PROP-105](./prop-105-multi-replica-coordination.md) (координация в нескольких репликах: claim-семантика
  очереди, общие лимиты, live-настройки) — основной потребитель результата: без SQL-портов claim-семантика не
  выражается. Файловые порты — прямой блокер.
- [PROP-104](./prop-104-external-event-transport.md) (внешний транспорт событий) — событийные порты уже в SQL;
  зависимость косвенная (через `packs`/`skills`/`contextFiles`).
- **Историческое предложение** о PostgreSQL как альтернативном backend хранения (документ удалён,
  поглощён ADR-096/ADR-097) — историческая основа: ADR-096/097 выросли из него; текущий остаток —
  «онлайн-консистентный бэкап/PITR» (ADR-091/092), он же ограничивает промежуточную меру RWX.
- **ADR-077** (исполнитель) — готовый прецедент RWX-тома в чарте (`executor.workspace`, `charts/synth/values.yaml:289-313`)
  и готовый чарт-паттерн «RWX обязателен, иначе — свой claim» (`charts/synth/templates/executor-pvc.yaml:7-10`).
- **ADR-096/ADR-097** — рамка: доменные порты, контрактный suite, драйвер.
- **ADR-091/ADR-092** — бэкап/восстановление/миграции схемы: после перевода файловый периметр и данные БД
  разъезжаются, если не закрыть онлайн-бэкап БД.

## Связи

- [ADR-046](./adr-046-skills-and-slash-commands.md) — скиллы (instance-скиллы, формат `SKILL.md`).
- [ADR-069](./adr-069-project-instructions-agents-md.md) — проектные инструкции и файловый периметр промптов.
- [ADR-077](./adr-077-runtime-toolchain.md) — исполнитель, общий RWX-том workspace, split-топология.
- [ADR-086](./adr-086-extensibility-plugins-editions.md) — пакеты расширений `synth.pack`, реестр установок.
- [ADR-091](./adr-091-backup-restore-transfer.md) / [ADR-092](./adr-092-instance-lifecycle-maintenance.md) —
  бэкап, восстановление, миграции схемы, `uninstall --purge-db`.
- [ADR-096](./adr-096-storage-layer.md) — единый слой хранения: доменные порты, контрактный suite.
- [ADR-097](./adr-097-storage-provider-class.md) — класс расширения «хранилище», драйвер PostgreSQL.
- [ADR-100](./adr-100-extension-packs-pipelines.md) — пакет расширения и legacy-пайплайны (`{dataDir}/pipelines/*.json`).
- [ADR-101](./adr-101-pipeline-engine.md) — движок пайплайнов: порты `projectPipelines`/`pipelineRuns` **уже в SQL** —
  образец того, как должен выглядеть перевод.
- Связанные предложения: [PROP-104](./prop-104-external-event-transport.md) (внешний транспорт событий),
  [PROP-105](./prop-105-multi-replica-coordination.md) (координация в нескольких репликах);
  историческое предложение о PostgreSQL как backend хранения — поглощено ADR-096/ADR-097.

## История

- 2026-10-22 — документ создан по итогам аудита готовности Synth к `backend.replicaCount > 1`: зафиксировано,
  что 5 портов (`packs`, legacy `pipelines`, `skills`, `contextFiles`, `blobs`) остаются файловыми даже под
  PostgreSQL; общий RWX-том `data` — промежуточная мера; целевое состояние — перевод этих портов в SQL.

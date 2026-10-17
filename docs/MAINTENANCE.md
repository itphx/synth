# Synth — runbook эксплуатации инстанса

> **Класс документа:** Runbook ([ARCH_DECISIONS.md](./ARCH_DECISIONS.md) §1) — пошаговые процедуры с
> ожидаемым результатом. Это не справка команд: назначение и описание флагов — в `--help` и
> [ADR-091](./arch_decisions/adr-091-backup-restore-transfer.md)/[ADR-092](./arch_decisions/adr-092-instance-lifecycle-maintenance.md).
> Разработка/окружение — [DEVELOPMENT.md](./DEVELOPMENT.md); конфиг — [CONFIGURATION.md](./CONFIGURATION.md).

Решения-основания: [ADR-079](./arch_decisions/adr-079-local-home-independent-instances.md) (локальный
home), [ADR-076](./arch_decisions/adr-076-git-repo-registry-ssh.md) (мастер-ключ, `secrets rotate`),
[ADR-096](./arch_decisions/adr-096-storage-layer.md) (слой хранения), [ADR-091](./arch_decisions/adr-091-backup-restore-transfer.md)
(бэкап/восстановление), [ADR-092](./arch_decisions/adr-092-instance-lifecycle-maintenance.md)
(миграции/обновление/удаление).

Общие команды ниже даны для CLI `synth`; в dev-пакете доступны те же команды у `node dist/main.js`
(`packages/core`). Параметры пути (`--data-dir`/`--config`/`--home`) у всех команд ниже едины.

## Первичная настройка инстанса

**Цель:** получить запускающийся инстанс с каталогом данных, ключами, провайдером/моделью и рабочим
каталогом; ожидаемый результат — `synth doctor` без `fail`, сервис отвечает на `GET /health`.

1. **Каталог данных.** Выберите способ раскладки:
   - отдельный каталог: `--data-dir <path>` или `SYNTH_DATA_DIR`;
   - локальный home (плоская раскладка `{home}/{config.yaml, data/, profiles.json, credentials.json}`):
     `--home <dir>` или `SYNTH_HOME`.
   Приоритет: явные флаги (`--data-dir`/`--config`/`--profiles`/`--credentials`) > `--home` >
   `SYNTH_HOME` > XDG-дефолты ([ADR-079](./arch_decisions/adr-079-local-home-independent-instances.md),
   [ADR-023](./arch_decisions/adr-023-configuration.md)). *Ожидаемо:* каталог данных создаётся при старте.
2. **Мастер-ключ секретов at-rest.** Задайте `SYNTH_SECRET_KEY` (env) или `security.secretKey` (config);
   без них ключ создаётся автоматически в `{dataDir}/secrets/master.key` (`0600`, каталог `0700`) при
   первом запуске. *Ожидаемо:* при наличии зашифрованных SSH-ключей мастер-ключ присутствует, иначе
   `doctor` даст `fail` (см. ниже).
3. **Ротация мастер-ключа** (плановое мероприятие): `synth secrets rotate --yes` (плюс `--old-key*`/
   `--new-key*` при внешнем ключе); сначала прогоните `--dry-run`. Без `--yes` (и без `--dry-run`) —
   отказ. **Перед ротацией сделайте бэкап** (см. «Бэкап»). *Ожидаемо:* «перешифровано N, пропущено M»;
   при ключе из env/config — обновите его и там (файл при старте игнорируется).
4. **Провайдеры и модели.** Добавьте провайдера/модель через API или создайте JSON в
   `{dataDir}/providers/`, `{dataDir}/models/`. *Ожидаемо:* `synth doctor` — проверка «Провайдеры и модели»
   без `warn`; примеры dev-провайдеров — [LLM_PROVIDERS.md](./LLM_PROVIDERS.md).
5. **Workspace.** Рабочий каталог по умолчанию: env `SYNTH_DEFAULT_WORKSPACE` > `storage.defaultWorkspace`
   > `{DATA}/workspaces/default`; runtime-override — `PUT /api/v2/settings/workspace` (`settings.json`,
   переживает рестарт). Каталог проекта провижнится автоматически (managed) или выбирается вручную
   (standalone); политика абсолютного пути вне `workspacesRoot` — `confirm`/`deny`.
6. **Первый вход и роли.** Standalone — один API-ключ (`--api-key`/`SYNTH_API_KEY`/`core.apiKey`, иначе
   автогенерация в `{dataDir}/secrets/api-key`) → роль ADMIN. Managed — OIDC/Keycloak (учётки и настройки —
   [KEYCLOAK.md](./KEYCLOAK.md)) либо `SYNTH_API_KEY`. Роли: `ADMIN`, `USER`, `LEAD`, `AUDITOR`.
   *Ожидаемо:* аутентифицированный запрос к `GET /api/v2/sessions` отвечает 200, без кред — 401. Правило
   единое для всех guard'ов: без аутентификации — 401 `UNAUTHORIZED` (в т.ч. на ADMIN-роутах); 403 `FORBIDDEN` —
   только у аутентифицированного пользователя без нужной роли.

## Проверка и диагностика

**Цель:** убедиться, что инстанс здоров; ожидаемый результат — `synth doctor` с кодом выхода 0.

1. Запустите `synth doctor` (`--data-dir`/`--home` при необходимости). Для машинной обработки — `--json`.
2. **Коды выхода:** `0` — все проверки без `fail`; `1` — есть хотя бы одна `fail`.
3. **Что считать fail:** `data-dir` (нет доступа на запись), `schema` (`too-new` — данные новее версии
   пакета), `master-key` (есть зашифрованные SSH-ключи, но мастер-ключ отсутствует/битый),
   `data-integrity` (битый JSON сессий/проектов). `warn` — повод разобраться, но не блокер: `schema`
   (`pending` → `synth migrate`), `secrets-permissions` (не `0700`/`0600`), `locks` (возможен стухший лок),
   `providers` (нет провайдера/модели). При `storage.backend=postgres` файловые проверки данных помечаются
   `skipped` («неприменимо (backend=postgres)»), а вместо них идут `db-connection`/`db-schema` (реальная
   проба БД + версия схемы драйвера); ошибка пробы → `fail` (см. «PostgreSQL как backend хранения»).
4. Проверки преимущественно read-only; единственная запись — пробный файл `{dataDir}/.doctor-probe`
   (создать → удалить) для проверки доступа.
5. Прочее: логи dev-запуска — `tmp/*.log`; типовые проблемы — [TROUBLESHOOTING.md](./TROUBLESHOOTING.md).

## Бэкап

**Цель:** получить проверяемый архив каталога данных; ожидаемый результат — файл `*.tar.gz` с
`manifest.json` и контрольной суммой, права `0600`.

1. **Сначала остановите сервис** (offline — режим по умолчанию, даёт согласованный срез между
   сущностями). Снятие с работающего сервиса — `--live`: команда предупредит, что срез **не
   транзакционный** (каждый файл валиден, но межсущностная согласованность не гарантируется).
2. Снимите архив: `synth backup --out /backup/` (каталог или файл; по умолчанию — текущий каталог).
   Исключаются по умолчанию: `backups/`, `tmp/`, `logs/`, `.doctor-probe`, `*.lock`, `workspaces/`
   (без `--with-workspace`), `secrets/` (без `--with-secrets`). При `storage.backend=postgres` архив
   **не содержит данных БД** (сессии/проекты/настройки) — он снимает только файловый периметр, в манифест
   пишется `storageBackend: postgres`; данные БД бэкапьте средствами СУБД (`pg_dump`/PITR — см.
   «PostgreSQL как backend хранения»).
3. **Секреты.** `--with-secrets` включает `secrets/` — архив становится **секретом сам по себе**:
   храните `0600` вне публичных мест; без мастер-ключа часть данных нерасшифровываема, но и бэкап
   **без** него не восстановит зашифрованные SSH-ключи.
4. **Шифрование архива (`--encrypt`).** `synth backup --encrypt` зашифровывает архив внешним ключом
   оператора → `<archive>.tar.gz.enc` (AES-256-GCM, потоково) и рядом кладёт плейнтекст-sidecar
   `<archive>.tar.gz.enc.meta.json` (только сводка: версии, время, флаги, число записей — **без путей
   и хешей**). Ключ — **внешний, отдельный от инстанса** (мастер-ключ нельзя: архив может содержать
   `secrets/`) и **хранится отдельно от архива**. Источник ключа: `--key-file <path>` >
   env `SYNTH_BACKUP_KEY_FILE` > env `SYNTH_BACKUP_KEY`; ключ — 32 байта в base64 или 64 hex-символа,
   иначе команда завершается ошибкой. Ключ не попадает ни в вывод, ни в аудит-журнал.
   *Ожидаемо:* в каталоге `--out` — пара `.tar.gz.enc` + `.enc.meta.json`, права `0600`.
5. **Куда класть архив:** на другой носитель/в сторедж, не рядом с самим каталогом данных (каталог
   `backups/` внутри `dataDir` — это страховочные копии, а не целевое хранилище бэкапов).
6. **Рекомендуемый прод-подход — снапшот ФС** перед тем как полагаться только на `tar`: PVC snapshot
   (K8s), LVM/ZFS snapshot, `tar` с остановкой на окно обслуживания. Это единственный способ получить
   по-настоящему согласованный срез при больших объёмах.
7. *Ожидаемо:* команда печатает путь архива, размер, число записей, флаги секретов/workspace,
   шифрования и контрольную сумму.

## Восстановление

**Цель:** вернуть каталог данных из архива; ожидаемый результат — `synth doctor` после восстановления
без `fail`.

1. **Остановите сервис** — восстановление перезаписывает каталог данных.
2. Предпросмотр: `synth restore <archive> --dry-run` — проверяются манифест/формат/версия схемы/
   контрольные суммы, печатается план (в т.ч. список удаляемых элементов) **без записи**.
3. Применение: `synth restore <archive> --yes`. Без `--dry-run` и без `--yes` — отказ.
   Если схема в архиве старше — команда напомнит про `synth migrate`.
   **Зашифрованный архив** (`*.tar.gz.enc`) восстанавливается **только через CLI** и требует ключ:
   `synth restore <archive>.tar.gz.enc --key-file <path>` (или env `SYNTH_BACKUP_KEY`/
   `SYNTH_BACKUP_KEY_FILE`). Архив временно расшифровывается в `{dataDir}/tmp/…` (права `0600`), затем
   идёт обычный путь восстановления; временный плейнтекст удаляется на **любом** пути выхода — при
   успехе, в `--dry-run` и при ошибке (неверный ключ, повреждённый архив, сбой восстановления).
   Через API/UI такой архив
   восстановить нельзя — ключ серверу недоступен (API вернёт 400 с пояснением). Без ключа или с
   неверным ключом — понятная ошибка и код выхода 1.
4. **Возврат к снимку.** Восстановление возвращает каталог данных к состоянию архива: перед
   распаковкой удаляются **все** элементы верхнего уровня, которых нет в архиве (данные, появившиеся
   после бэкапа, и повреждённые файлы), а файлы, изменённые после снимка, заменяются архивными.
   **Сохраняются `backups/`** (только что созданная страховочная копия) **и `workspaces/`**.
   `workspaces/` не входит в бэкап по умолчанию и при восстановлении **сохраняется** (иначе
   потеряли бы рабочие файлы проектов, которых в архиве нет); полный откат с файлами — только
   бэкап, снятый с `--with-workspace` (тогда `workspaces/` заменяется архивным).
5. **Страховочная копия** текущих данных создаётся автоматически перед записью (при непустом `dataDir`)
   в `{dataDir}/backups/synth-pre-restore-<stamp>.tar.gz` — она исключена из архивов бэкапа.
   `--no-safety-copy` отключает страховку (**рискованно**: откат восстановления станет невозможен —
   команда предупредит об этом в stderr).
6. **Обязательно** прогоните `synth doctor` после восстановления; при схеме старше — `synth migrate`.
7. *Ожидаемо:* «Очистка каталога данных: удалено элементов — N», «`backups/` сохранён»,
   «`workspaces/` сохранён (в архиве отсутствует)» (если бэкап без `--with-workspace`),
   «Восстановлено файлов: N», строка про удалённые лишние файлы, путь страховочной копии,
   напоминания про `doctor`/`migrate`.

## Перенос проекта между инстансами

**Цель:** перенести проект (сессии/сообщения/план/todo, опционально рабочие файлы) на другой
инстанс Synth; ожидаемый результат — на целевом инстансе появился новый проект с новыми id и
без секретов.

Контур — `synth project export|import` ([ADR-091 §6](./arch_decisions/adr-091-backup-restore-transfer.md),
реализация — `projects/portable.ts`). Это **не** снимок каталога данных (`backup`/`restore`):
переносятся данные одного проекта, и на целевом инстансе создаётся **новый** проект.

1. **Экспорт.** `synth project export <projectId> [--out <file|dir>] [--with-workspace]` — собирает
   архив `<name>.synth-project.tar.gz` с `manifest.json`, `project.json` и `sessions/<id>.json`
   по каждой **локальной** сессии (сессии `origin: remote` пропускаются с предупреждением).
   `--out` — файл или каталог (каталог — архив кладётся внутрь под именем по умолчанию).
   `--with-workspace` добавляет рабочий каталог проекта (`workspace/**`; служебные
   `node_modules`/`.git`/`.synth` исключаются). *Ожидаемо:* путь архива, число сессий/записей,
   размер и флаг workspace; архив `0600`.
2. **Секретов в архиве нет.** `secrets/`, ключи, credentials, токены, API-ключи не попадают —
   их переносят отдельно или создают заново на целевом инстансе.
3. **Предпросмотр.** `synth project import <archive> --dry-run` — валидирует манифест/формат/
   контрольные суммы и печатает план (проект-источник, целевой проект, число сессий/сообщений,
   workspace) **без записи**.
4. **Импорт.** `synth project import <archive> --yes` — создаёт **новый** проект и **новые** сессии
   (materialization, не `session.requested`, ADR-089/инвариант 15; `status` сессий сбрасывается в
   безопасное). Без `--dry-run` и без `--yes` — отказ. Флаги: `--name <name>` — имя нового проекта
   (по умолчанию — из архива; при коллизии имён авто-имя получает суффикс, а явное `--name` даёт
   ошибку `project-name-conflict`); `--merge-into <projectId>` — импортировать сессии в существующий
   проект (новый проект не создаётся); `--with-workspace` — распаковать `workspace/**` в каталог
   проекта (при отсутствии workspace — авто-имя через provisioning, ADR-075). *Ожидаемо:* новый
   `projectId`, число сессий/сообщений, статус workspace и **маппинг старый id → новый id**.
5. **Что не переносится.** Секреты, ключи/токены, привязки событий (ADR-089), расписания,
   service-key/webhook-секреты, project-scope `skills` — инстанс-локальные сущности.
   Импортированные сессии принадлежат локальному пользователю (`local`).
6. **Аудит** ([ADR-092](./arch_decisions/adr-092-instance-lifecycle-maintenance.md)): успех
   фиксируется в `{dataDir}/audit/maintenance.jsonl` как `export.created` (детали `projectId`,
   `sessions`, `workspace`, `bytes`) и `import.applied` (детали `projectId`, `from`, `sessions`,
   опц. `mergeInto`); в `--dry-run` аудит не пишется.

**Через HTTP API и UI** (те же операции, роуты `/api/v2/projects/:id/export` и
`/api/v2/projects/import`; спека — [API_V2.md](./API_V2.md) §5.8.1). Managed: скачивание —
право чтения проекта (owner/участник/`LEAD`/`ADMIN`), импорт в существующий проект
(`mergeInto`) — право редактирования; `confirm` для импорта **не** требуется (операция
не деструктивна):

```bash
# Скачать портативный экспорт проекта (owner/участник/LEAD/ADMIN).
curl -OJ 'http://localhost:5000/api/v2/projects/<PROJECT_ID>/export' \
  -H 'Authorization: Bearer <TOKEN>'
# С рабочим каталогом проекта (workspace/**):
curl -OJ 'http://localhost:5000/api/v2/projects/<PROJECT_ID>/export?withWorkspace=true' \
  -H 'Authorization: Bearer <TOKEN>'

# Импортировать архив в новый проект (multipart; имя — опционально).
curl -X POST 'http://localhost:5000/api/v2/projects/import' \
  -H 'Authorization: Bearer <TOKEN>' \
  -F 'file=@<name>.synth-project.tar.gz' -F 'name=Imported project' -F 'withWorkspace=true'
# Импортировать сессии в существующий проект (нужно право редактирования):
curl -X POST 'http://localhost:5000/api/v2/projects/import' \
  -H 'Authorization: Bearer <TOKEN>' \
  -F 'file=@<name>.synth-project.tar.gz' -F 'mergeInto=<PROJECT_ID>'
```

Ответ импорта — `201 {projectId, sessionsImported, messagesImported, workspaceRestored,
idMap}` (маппинг старый id → новый id). Лимит загрузки архива — `storage.maxUploadBytes`
(по умолчанию 100 МиБ; превышение → `413 PAYLOAD_TOO_LARGE`). Процедуры, секреты и аудит —
как в CLI-контуре выше.

## Миграции схемы

**Цель:** привести данные к текущей версии схемы; ожидаемый результат — `meta.json` с актуальным
`schemaVersion`, `synth doctor` без `fail`/`warn` по `schema`.

1. **Автоматика на старте.** При запуске инстанса, если `{dataDir}/meta.json` отстаёт, автоматически
   создаётся **страховочная копия** в `{dataDir}/backups/synth-pre-migrate-<stamp>.tar.gz`, затем
   pending-миграции применяются под межпроцессным локом. Без копии миграции **не выполняются**
   (fail-closed).
2. **Вручную:** `synth migrate --dry-run` (план), затем `synth migrate --yes` (применение). Без
   `--dry-run` и без `--yes` — отказ.
3. **Данные новее версии.** Если `meta.schemaVersion` **больше** ожидаемого — старт и `synth migrate`
   отказываются («обновите Synth»): понижение версии не мигрирует данные назад. **Обновите пакет**, а не
   данные (см. «Обновление и откат»).
4. Идемпотентность: повторный запуск ничего не ломает (миграции с маркером — no-op).
5. *Ожидаемо:* печать текущей/ожидаемой версии, списка применённых миграций и числа обновлённых записей.

## PostgreSQL как backend хранения (`storage.backend=postgres`)

**Цель:** эксплуатировать инстанс с БД-backend'ом ([ADR-096](./arch_decisions/adr-096-storage-layer.md),
[ADR-097](./arch_decisions/adr-097-storage-provider-class.md), [PROP-032](./arch_decisions/prop-032-history-storage-postgresql.md));
ожидаемый результат — `synth doctor` без `fail` по `db-connection`/`db-schema`, сервис отвечает на `GET /health`
со `status: healthy`. Конфиг — [CONFIGURATION.md](./CONFIGURATION.md) («PostgreSQL»); драйвер и схема БД —
`packages/storage-postgres/AGENTS.md`.

Включается значением `storage.backend: postgres` (env `SYNTH_STORAGE_BACKEND`); параметры — секция
`storage.postgres` + env `SYNTH_POSTGRES_*`, пароль — env `SYNTH_POSTGRES_PASSWORD` или файл
`{dataDir}/secrets/postgres-password` (в `config.yaml` не хранится). Драйвер подключается core динамически;
драйвер `pg` и пакет `@itphx/synth-storage-postgres` входят в комплект `@itphx/synth`.

1. **Схема БД — отдельно от `meta.json`.** У драйвера **свой** контур версионирования: таблица
   `synth_schema_migrations` в схеме драйвера, миграции — инлайн-SQL. Это не `meta.json`/`synth migrate`
   из ADR-092 (тот контур — про файловый периметр). Схема применяется при сборке контекста (режим `apply`);
   режим DBA — `assert` (только проверка, без применения); `skip` — только подключение (диагностика/CLI,
   управляющие миграциями сами).
2. **`synth migrate`.** На `backend=postgres` команда применяет/выравнивает **SQL-схему драйвера**
   (создание схемы, применение миграций по возрастанию версии под advisory-локом). **Fail-closed**, если
   версия схемы в БД **новее** ожидаемой (`STORAGE_POSTGRES_SCHEMA_TOO_NEW`) — старт/миграция отказываются
   («обновите Synth»), назад данные не мигрируются. Если схема **отстаёт** — `STORAGE_POSTGRES_SCHEMA_OUTDATED`
   (лечится применением миграций). *Ожидаемо:* схема на актуальной версии; повторный прогон — no-op.
3. **`synth doctor`.** При `backend=postgres` файловые проверки данных помечаются `skipped`
   («неприменимо (backend=postgres)»), добавляются `db-connection` (реальная проба: latency/ошибка) и
   `db-schema` (текущая vs ожидаемая версия). Ошибка/исключение пробы → `fail`. Прочие проверки
   (`master-key`, `secrets-permissions`, `locks` — файлового периметра) сохраняются.
4. **`synth backup`.** Архив снимает **каталог данных** (файловый периметр); **данных БД в нём нет** —
   в манифест пишется `storageBackend: postgres` и выводится предупреждение о неполноте архива. Данные БД
   бэкапьте средствами СУБД: `pg_dump`/`pg_basebackup`/pgBackRest, PITR по WAL. Для согласованного среза
   останавливайте сервис (или используйте снапшот тома); `--live` полноты БД не гарантирует.
5. **`synth restore`.** Восстанавливает каталог данных (файловый периметр) — БД это **не** трогает.
   Порядок: остановить сервис → восстановить БД (`pg_restore`/PITR) → при необходимости `synth restore` для
   файлового периметра → `synth doctor`. Если схема БД отстаёт — `synth migrate`.
6. **`synth uninstall --purge-db`.** По умолчанию данные **БД не удаляются** (команда об этом сообщает).
   Удаление схемы БД — только явным `--purge-db`, который осмыслен **только** при `storage.backend=postgres`
   (иначе — ошибка, fail-closed) и требует `--purge` и `--yes`; выполняется `DROP SCHEMA … CASCADE`
   (необратимо).

### Деградированный режим (БД недоступна)

**Цель:** понять, что сервис работает в аварийном режиме, и вернуть его в норму
([ADR-098](./arch_decisions/adr-098-storage-degraded-recovery.md)).

- **Как выглядит.** Если выбран `postgres`, а БД недоступна на старте, при `storage.degradedMode: fallback-file`
  (дефолт) сервис поднимается на **файловом фоллбеке** в `storage.fallbackDir` (отдельный каталог, не `dataDir`).
  В логе — блок `[storage] ⚠️ PostgreSQL недоступен …` с причиной и каталогом фоллбека.
- **Что доступно.** Строгий **read-only**: `GET`/диагностика/ремонтные операции (maintenance doctor/backup/export):
  мутации (`POST/PUT/PATCH/DELETE`) → `503 STORAGE_DEGRADED_READONLY`; не-администраторы → `503 STORAGE_DEGRADED`.
  Реестр тулов отдаёт только безопасные (`skill`, `web_fetch`, `web_search`).
- **Диагностика.** `GET /health` → `status: degraded` + блок `storage.{backend,fallbackDir,reason,since}`;
  `GET /api/v2/storage/status` — проба исходного backend'а (`recovery.connection.ok`) и признак
  `recovery.restartRequired: true`; `synth doctor` (проверки БД); лог сервера.
- **Как выходить.** Авто-возврата к БД **нет** (контекст хранения замкнут в deps, живая подмена рискованна):
  устраните причину (сеть/креды/схема — `synth migrate`), подтвердите пробу
  (`GET /api/v2/storage/status` → `connection.ok: true`) и **перезапустите сервис**. Не копируйте данные из
  файлового фоллбека в БД вручную — фоллбек диагностический, его содержимое не переносится.
- **Fail-closed.** Ошибки конфигурации/кред, отсутствие зависимости (`pg`), незагружаемый драйвер и «схема
  новее» фоллбеком **не** маскируются — старт останавливается (независимо от `degradedMode`).
- **Скилл `synth-storage-recovery`.** Встроенный скилл-рунбук (`/storage-recovery`): диагностика, классификация
  причины, лечение, что доступно в деградации, возврат в норму. Доступен и в норме, и в аварийном режиме.

## Перенос данных между backend'ами (`synth storage migrate`)

**Цель:** перевести инстанс между физическими backend'ами хранения (`file` ↔ `postgres`)
идемпотентно, через доменные порты ([ADR-096](./arch_decisions/adr-096-storage-layer.md)),
не потеряв данные и сохранив возможность отката. Ожидаемый результат — данные перенесены
(счётчики `copied`/`skipped` сходятся с периметром источника), сервис стартует на целевом
backend'е (`GET /health` → `healthy`, `synth doctor` без `fail`), новые записи идут в цель, а
файловые данные остаются **вторым уровнем отката**.

```bash
synth storage migrate --to postgres [--dry-run|--yes]                       # file → postgres
synth storage migrate --to file --target-data-dir <path> [--dry-run|--yes]  # postgres → file (откат)
```

Копирование идёт **только через доменные порты** (`StorageContext`): сущность читается доменным
методом источника и пишется методом цели, перед записью наличие проверяется по стабильному
id/ключу/метке — повторный прогон ничего не дублирует. Без `--dry-run` и без `--yes` — отказ.
Успех/провал пишутся в `{dataDir}/audit/maintenance.jsonl` (`migrate.applied`/`migrate.failed`,
[ADR-092](./arch_decisions/adr-092-instance-lifecycle-maintenance.md)); `--dry-run` аудит не пишет.

Описание флагов — в `--help`; параметры БД и `storage.degradedMode` — [CONFIGURATION.md](./CONFIGURATION.md)
(§«Backend хранения», §«PostgreSQL», §«Деградированный режим»); контракт и схема драйвера —
`packages/storage-postgres/AGENTS.md`. Dev-специфика (контейнер PostgreSQL, креды, бэкапы) —
[DEVELOPMENT.md](./DEVELOPMENT.md).

### Предусловия

1. **Целевая БД доступна.** Для `--to postgres` — сервер БД поднят, база и роль созданы,
   драйвер `@itphx/synth-storage-postgres` и `pg` установлены (входят в комплект `@itphx/synth`).
   Схему БД создаёт сама команда (режим `apply`).
2. **Цель адресуется через env, а не через `config.storage`.** Параметры БД-цели задайте
   переменными окружения — `SYNTH_POSTGRES_HOST`/`_PORT`/`_DATABASE`/`_USER`/`_PASSWORD`
   (или `SYNTH_POSTGRES_DSN`); **пароль** — только env `SYNTH_POSTGRES_PASSWORD` либо файл
   `{dataDir}/secrets/postgres-password` (в `config.yaml` не хранится, инвариант 13).
   Пока перенос не завершён, секцию `storage.backend` в конфиге менять **не нужно** — иначе
   изменится и источник.
3. **`SYNTH_STORAGE_BACKEND` при вызове не выставлять.** Источник резолвится из конфига/env
   (`resolveStorageBackend`), цель задаётся **только** флагом `--to`. Если источник и цель
   совпадут, команда откажет: «источник и цель совпадают … цель задаётся `--to`».
4. **Остановить сервис** (offline-перенос): параллельная запись в файлы разъедется с БД.
   Контейнер/сервер PostgreSQL останавливать **не нужно**.
5. **Снять бэкап** файлового периметра (см. «Порядок») — это страховка и второй уровень отката.
6. **Файловые данные не удалять** — до подтверждённой сверки и работы на БД они остаются
   полноценным откатом.

### Порядок переноса

1. **Остановите сервис** и дождитесь освобождения портов. В dev это процессная группа `dev.sh`
   (см. [DEVELOPMENT.md](./DEVELOPMENT.md)); в managed — штатная остановка пода/юнита.
   *Ожидаемо:* сервис не пишет, порты свободны.
2. **Бэкап файлового периметра.** `synth backup --out <dataDir>/backups --data-dir <dataDir>`.
   Архив — с `manifest.json` (в нём `backend: file`), числом записей и `sha256`. Каталог
   `backups/` **не** удаляйте; файлы `sessions/`/`projects/` в `{dataDir}` не трогайте.
   *Ожидаемо:* путь архива, размер, число записей, контрольная сумма.
3. **Dry-run.** `synth storage migrate --to postgres --data-dir <dataDir> --dry-run` — печатает
   счётчики `copied`/`skipped` по сущностям **без записи**. Сверьте ключевые числа (`sessions`,
   `projects`, сообщения) с файловым периметром **до** применения.
4. **Применить.** Тот же вызов с `--yes`: `synth storage migrate --to postgres --data-dir <dataDir> --yes`.
   *Ожидаемо:* отчёт `copied`/`skipped` по сущностям и предупреждения о перевыпуске секретов и
   новых id (см. «Ограничения и fail-closed»).

### Сверка результата (вне отчёта команды)

Проверьте перенос **независимо** от собственного отчёта команды:

```bash
# 1) Объёмы в БД (значения — пример; сверьте со своим периметром).
psql "host=127.0.0.1 port=5432 dbname=<db> user=<user>" -c \
  'select (select count(*) from sessions) sessions, (select count(*) from messages) messages, (select count(*) from projects) projects;'

# 2) Doctor на целевом backend'е: файловые проверки данных помечаются
#    skipped («неприменимо (backend=postgres)»), добавлены db-connection/db-schema.
SYNTH_STORAGE_BACKEND=postgres synth doctor --json
```

*Ожидаемо:* в БД — таблицы схемы драйвера, счётчики совпадают с dry-run/периметром; `doctor` →
`ok: true`, `db-connection: ok`, `db-schema: ok`, файловые проверки `skipped`.

> **Известное наблюдение.** `synth doctor` в режиме `postgres` может печатать предупреждения
> прогрева портов (`прогрев порта '…' не удался: пул недоступен`) при общем `ok: true` и
> `db-connection: ok`. На работоспособность это не влияет — пул поднимается к моменту реальной
> пробы; предупреждение ожидаемо.

### Закрепление режима

1. Пропишите целевой backend в конфиг инстанса (для dev — `packages/backend/config.yaml`, файл
   untracked/gitignored; пароль в нём **не** хранится):

   ```yaml
   storage:
     backend: postgres
     postgres: { host: 127.0.0.1, port: 5432, database: synth, user: synth }
   ```

2. **Рекомендуется `storage.degradedMode: halt`** для БД-режима: при `fallback-file` (дефолт)
   сервис **молча** поднимется на файловом фоллбеке и данные разъедутся (см. ниже). Смена
   режима — стартовая настройка, применяется при рестарте.

### Верификация после старта

1. **Health.** `GET /health` → `healthy` (не `degraded`).
2. **Логи.** В `tmp/backend.log`/`tmp/core.log` (dev) нет блока `[storage] ⚠️ PostgreSQL недоступен …`.
3. **Объёмы по API.** `GET /api/v2/sessions` / `GET /api/v2/projects` отдают ожидаемые числа.
   *Ожидаемо (пример):* список сессий может быть **меньше** числа строк в БД, если часть сессий
   архивирована (`archivedAt`/`expiresAt`) — `listSessions` по умолчанию исключает архив. Это норма,
   а не потеря.
4. **Запись действительно в БД.** Выполните **безопасную мутацию** (например,
   `PUT /api/v2/settings/workspace` с текущим значением) → 2xx; запись видна в БД, а `mtime`
   файлов `{dataDir}/settings.json` и `{dataDir}/sessions/*` **не** меняется.

### Откат

- **Возврат к файлам без переноса БД→файл.** Уберите секцию `storage` (или `storage.backend`)
  из конфига → рестарт → снова файловый backend. Данные в `{dataDir}` не тронуты (перенос их
  **не** удаляет), поэтому файловое состояние остаётся рабочим.
- **Перенос изменений из БД обратно.** Возможен, но в **свежий** каталог, чтобы не смешивать:
  `synth storage migrate --to file --target-data-dir <пустой каталог> --data-dir <dataDir> --yes`.
  Если целевой каталог уже содержит данные, команда предупредит, что существующие записи
  **не перезаписываются** (пропускаются). Затем укажите файловый backend/`--data-dir` и
  перезапустите сервис.
- **Полный откат через бэкап** — `synth restore` (см. «Восстановление»); для БД-режима данные БД
  восстанавливаются средствами СУБД (`pg_restore`/PITR), а `synth restore` — только файловый периметр.

### Ограничения и fail-closed

**Что переносится:** `sessions` (с `messages`/`references`/`checkpoints`/`stickyNotes`), `projects`
(с `members`), `profiles`, `settings`, `defaults`, `providers`/`models`/`agents`, события
(`eventBindings`/`eventRoutes`/`eventApiKeys`/`eventJournal`/`identityClaims`), `schedules`/`jobs`,
`webhooks`/`webhookDeliveries`, `sshKeys`, `serviceKeys`, `mcpRegistry`, `skillBundles`, `maintenanceAudit`.

**Что НЕ переносится (честные ограничения):**

- **секреты, хранящиеся только хешем/шифром, перевыпускаются** — `eventApiKeys`, `serviceKeys` (sha256),
  signing-секреты `webhooks` (шифр): создаётся **новая** запись с **новым** секретом (метаданные
  сохраняются), о чём выводится предупреждение;
- `schedules`/`webhooks`/`sshKeys`/`mcpRegistry` получают **новые `id`** (порт `create`/`add` их
  генерирует; привязки по id переезжают как есть);
- `identityClaims` и `dedup` — транзиентные/инстанс-локальные (окно идемпотентности событий живёт
  минуты) — не переносятся;
- `skills`/`contextFiles`/`blobs` — **файловые в обоих backend'ах** (драйвер `postgres` отдаёт их
  файловыми реализациями core) — переезжать нечему;
- файловый периметр вне портов — `skills/`, `skill-bundles/`, `context/`, `audit/*.jsonl`, `meta.json`,
  `workspaces/`, `secrets/` (`master.key`, `postgres-password`, `ssh-keys/`), `auth/`, `gateway/`,
  `security/` — остаётся файловым по конструкции (ожидаемо, не потеря данных); копируется/переносится
  отдельно ([ADR-091](./arch_decisions/adr-091-backup-restore-transfer.md)/[ADR-092](./arch_decisions/adr-092-instance-lifecycle-maintenance.md)).

**Fail-closed (перенос отменяется с ошибкой — данные не пишутся):**

- **цель недоступна** — сборка целевого контекста ушла в файловый фоллбек (`target.kind ≠ --to`):
  команда откажет, чтобы не записать данные в чужой каталог (`fallbackDir`) с отчётом об успехе;
- **схема БД новее драйвера** (`STORAGE_POSTGRES_SCHEMA_TOO_NEW`) — «обновите Synth», назад данные
  не мигрируются;
- **нет драйвера/`pg`** (`STORAGE_BACKEND_UNAVAILABLE`/`…DEPENDENCY_MISSING`) — команда/старт
  останавливаются (деградация не маскирует отсутствие зависимости);
- ошибка конфигурации/кред (`STORAGE_POSTGRES_CONFIG_INVALID`), в т.ч. TLS-параметры в DSN
  ([CONFIGURATION.md](./CONFIGURATION.md) §«TLS соединения с PostgreSQL»).

### Деградированный режим — проверьте настройку до переключения

`storage.degradedMode` по умолчанию — `fallback-file`: если БД окажется недоступна на старте,
сервис **молча** поднимется на файловом фоллбеке в `{dataDir}/fallback` (строгий read-only) и
данные разъедутся с БД. Авто-возврата к БД **нет** — только рестарт после восстановления
соединения. Для БД-режима рекомендуется `storage.degradedMode: halt` (старт с внятной ошибкой
вместо тихого фоллбека); порядок действий в аварии — раздел «Деградированный режим (БД недоступна)»
выше и встроенный скилл `synth-storage-recovery`.

## Миграция хранилища в Kubernetes (K3s/Fleet)

**Цель:** перевести managed-инстанс (Helm-релиз в K3s/Fleet, файловый backend на PVC) на
PostgreSQL, не потеряв данные и сохранив рабочий откат. Общая механика переноса — что копируется,
что перевыпускается, какие ошибки fail-closed — в разделе «Перенос данных между backend'ами
(`synth storage migrate`)» выше; здесь только managed-специфика: как это делается Job'ами на PVC,
как переключается режим в чарте, как чистится PVC и как откатываться. Процесс проверен на
test-инстансе 2026-10-17 (итог: `healthy`, `doctor` без `fail`, счётчики сошлись, освобождено ~14 МБ).

Значения ниже — фактические для test-среды; для другой среды подставьте свои (хост/база/роль,
релиз, PVC, namespace).

| Компонент | Значение (test) |
|---|---|
| Кластер / namespace | K3s (Rancher Fleet), `synth` |
| Релиз / чарт | `synth-test`, чарт `synth` из приватного Helm-реестра Gitea |
| PVC | `synth-backend-data` → `/var/synth/data` (RWO, одна нода) |
| Целевая БД | `box.itphx.loc:5432`, база `synth_test`, роль `synth` (PostgreSQL 15) |
| Секрет с паролем | `synth-secrets` (SealedSecret), ключ `SYNTH_POSTGRES_PASSWORD` |

### Предусловия

1. **Кластер достукивается до БД.** Проверьте TCP из пода, а не «с машины админа»:

   ```bash
   kubectl -n synth exec deploy/synth-backend -- node -e "
   const net = require('node:net');
   const s = net.connect(5432, 'box.itphx.loc', () => { console.log('TCP OK'); s.end(); });
   s.on('error', (e) => { console.error('TCP FAIL', e.message); process.exit(1); });"
   ```

   *Ожидаемо:* `TCP OK`. Если нет — сначала сеть/фаервол/`NetworkPolicy`, миграцию не начинать.
2. **Роль умеет логиниться.** `NOLOGIN` даёт `FATAL: для роли "synth" вход запрещён` — это **не**
   «неверный пароль»: пароль проверяется позже, поэтому сообщения разные. Симптом «неверный пароль»
   при заведомо верном пароле — повод проверить именно `LOGIN`/`pg_hba`, а не перевыпускать пароль.
3. **База создана и пуста** — либо уже содержит схему драйвера нужной версии (`synth_schema_migrations`).
   Схему создаёт сама команда (режим `apply`); «схема новее драйвера» — fail-closed (см. выше).
4. **Пароль — только в Secret** (инвариант 13), не в `values.yaml` и не в аргументах Job'а. Если
   SealedSecret перезапечатывался (добавлялся третий ключ), **после применения сверьте sha256
   остальных ключей** (OIDC-секрет, ключ провайдера) со значениями **до** перезапечатывания:
   утилита не должна была их изменить, иначе сломается вход в UI. Пример сверки:

   ```bash
   kubectl -n synth get secret synth-secrets -o jsonpath='{.data.SYNTH_OIDC_CLIENT_SECRET}' \
     | base64 -d | sha256sum
   ```

5. **Драйвер есть в образе.** Проверяется резолвингом из каталога core (см. «Артефакты и деплой»).
6. **Снят бэкап** (см. «Бэкап») — это страховка и второй уровень отката.

### Артефакты и деплой

Для test-среды используется процедура «X.Y.Z-N»: версия приложения не бампается, перезаписывается
тег образа, версия чарта автоинкрементится (`0.10.3` → `0.10.3-2`). Собирает и публикует
`synth-deploy`:

```bash
cd synth-deploy
GITEA_USER=<user> GITEA_TOKEN=<token> ./scripts/build-and-publish.sh --app-version 0.10.3 --dry-run
GITEA_USER=<user> GITEA_TOKEN=<token> ./scripts/build-and-publish.sh --app-version 0.10.3
```

- Скрипт обновляет **только строки с маркером `# sync:`** в `test/values.yaml` (пиннинги образа и
  версии чарта) — остальной текст файлов не трогается.
- Публикуются **оба** чарта (`synth` и `synth-gateway-telegram`), даже если менялся только `test/`.
- Реестр Gitea регенерирует `index.yaml` с задержкой: если чарта «нет», повторите запрос через
  30–60 с, а не пересобирайте.
- **Без бампа версии откат образа дорогой:** старый digest после перезаписи тега из реестра не
  тянется. Откат — только пересборка из предыдущего коммита `synth` (или re-tag+push из локального
  кэша). Для «настоящих» релизов поэтому и нужен бамп версии.

**Проверка драйвера в образе.** `pnpm deploy` кладёт опциональные зависимости в `.pnpm`, поэтому
`ls /app/node_modules/@itphx/` даёт **ложноотрицательный** результат. Единственная надёжная проверка —
резолвинг из каталога core:

```bash
docker run --rm --entrypoint sh git.itphx.ru/itphx/synth-backend:0.10.3 -c \
  'cd /app/node_modules/@itphx/synth-core && node --input-type=module -e "await import(\"@itphx/synth-storage-postgres\")"'
```

*Ожидаемо:* пустой вывод, код возврата 0. `ERR_MODULE_NOT_FOUND` — драйвера в образе нет,
переключение режима даст fail-closed на старте.

**Обязательный `rollout restart`.** В чарте нет checksum-аннотации пода, поэтому при **неизменном
теге** `helm upgrade` поды не перекатывает. Сверяйте `imageID` до и после:

```bash
kubectl -n synth get pod -l app.kubernetes.io/name=synth-backend -o jsonpath='{..imageID}{"\n"}'
kubectl -n synth rollout restart deploy/synth-backend
kubectl -n synth rollout status deploy/synth-backend
```

### Бэкап

PVC — `ReadWriteOnce`, поэтому архив снимается при **остановленном** backend: иначе получится
несогласованный срез.

1. Остановите backend и дождитесь удаления пода:

   ```bash
   kubectl -n synth scale deploy/synth-backend --replicas=0
   kubectl -n synth wait --for=delete pod -l app.kubernetes.io/name=synth-backend --timeout=120s
   ```

2. Job с образом backend, тем же PVC и `restartPolicy: Never`:

   ```yaml
   ---
   # Бэкап файлового периметра Synth на PVC перед миграцией storage backend file → postgres.
   # Запускается при остановленном backend (deploy/synth-backend --replicas=0), т.к. PVC
   # synth-backend-data — ReadWriteOnce и архив должен быть консистентным.
   # Пароль БД не нужен: команда работает только с файловым dataDir.
   apiVersion: batch/v1
   kind: Job
   metadata:
     name: synth-backup-0-10-3
     namespace: synth
     labels:
       app.kubernetes.io/name: synth
       app.kubernetes.io/component: maintenance
       app.kubernetes.io/instance: synth-test
   spec:
     backoffLimit: 0
     ttlSecondsAfterFinished: 3600
     template:
       metadata:
         labels:
           app.kubernetes.io/name: synth
           app.kubernetes.io/component: maintenance
           app.kubernetes.io/instance: synth-test
       spec:
         restartPolicy: Never
         imagePullSecrets:
           - name: git.itphx.ru
         securityContext:
           runAsUser: 1000
           runAsNonRoot: true
           fsGroup: 1000
         containers:
           - name: backup
             image: git.itphx.ru/itphx/synth-backend:0.10.3
             imagePullPolicy: Always
             command:
               - node
               - /app/node_modules/@itphx/synth-core/dist/main.js
               - backup
               - --out
               - /var/synth/data/backups
               - --data-dir
               - /var/synth/data
             resources:
               requests:
                 cpu: 100m
                 memory: 128Mi
               limits:
                 cpu: "1"
                 memory: 512Mi
             volumeMounts:
               - name: data
                 mountPath: /var/synth/data
         volumes:
           - name: data
             persistentVolumeClaim:
               claimName: synth-backend-data
   ```

3. Запустите и дождитесь завершения:

   ```bash
   kubectl -n synth apply -f job-backup.yaml
   kubectl -n synth wait --for=condition=complete job/synth-backup-0-10-3 --timeout=10m
   kubectl -n synth logs job/synth-backup-0-10-3
   ```

4. Заберите архив и сверьте контрольную сумму. Копию оставьте **и** на PVC (`backups/`), и локально:

   ```bash
   POD="$(kubectl -n synth get pod -l job-name=synth-backup-0-10-3 \
     -o jsonpath='{.items[0].metadata.name}')"
   kubectl -n synth cp "$POD:/var/synth/data/backups/<archive>.tar.gz" ./<archive>.tar.gz
   sha256sum ./<archive>.tar.gz
   ```

*Ожидаемо:* путь архива, размер, число записей и `sha256` в логе совпадают с локальной копией.

### Миграция

Job — тот же образ и PVC, но с env-адресацией **цели** и `SYNTH_STORAGE_BACKEND=file`. Источник
обязательно `file`: цель задаётся **только** флагом `--to`, иначе команда откажет («источник и цель
совпадают»). Пароль — через `valueFrom.secretKeyRef`, в аргументах и логах его нет.

Сначала dry-run (только счётчики `copied`/`skipped`, без записи):

```yaml
---
# Миграция файлового хранилища Synth (PVC synth-backend-data) в PostgreSQL (box.itphx.loc/synth_test).
# Источник — file (SYNTH_STORAGE_BACKEND=file), цель — флаг --to postgres.
# Пароль БД берётся только из Secret synth-secrets/SYNTH_POSTGRES_PASSWORD (valueFrom) —
# в аргументах и логах его нет. Запускать при остановленном backend (PVC ReadWriteOnce).
# Первый прогон — с --dry-run (только счётчики copied/skipped), затем тот же Job с --yes.
apiVersion: batch/v1
kind: Job
metadata:
  name: synth-migrate-pg
  namespace: synth
  labels:
    app.kubernetes.io/name: synth
    app.kubernetes.io/component: maintenance
    app.kubernetes.io/instance: synth-test
spec:
  backoffLimit: 0
  ttlSecondsAfterFinished: 3600
  template:
    metadata:
      labels:
        app.kubernetes.io/name: synth
        app.kubernetes.io/component: maintenance
        app.kubernetes.io/instance: synth-test
    spec:
      restartPolicy: Never
      imagePullSecrets:
        - name: git.itphx.ru
      securityContext:
        runAsUser: 1000
        runAsNonRoot: true
        fsGroup: 1000
      containers:
        - name: migrate
          image: git.itphx.ru/itphx/synth-backend:0.10.3
          imagePullPolicy: Always
          command:
            - node
            - /app/node_modules/@itphx/synth-core/dist/main.js
            - storage
            - migrate
            - --to
            - postgres
            - --data-dir
            - /var/synth/data
            - --dry-run
          env:
            - name: SYNTH_STORAGE_BACKEND
              value: file
            - name: SYNTH_POSTGRES_HOST
              value: box.itphx.loc
            - name: SYNTH_POSTGRES_PORT
              value: "5432"
            - name: SYNTH_POSTGRES_DATABASE
              value: synth_test
            - name: SYNTH_POSTGRES_USER
              value: synth
            - name: SYNTH_POSTGRES_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: synth-secrets
                  key: SYNTH_POSTGRES_PASSWORD
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: "1"
              memory: 1Gi
          volumeMounts:
            - name: data
              mountPath: /var/synth/data
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: synth-backend-data
```

Запуск и сверка dry-run:

```bash
kubectl -n synth apply -f job-migrate.yaml
kubectl -n synth wait --for=condition=complete job/synth-migrate-pg --timeout=15m
kubectl -n synth logs job/synth-migrate-pg
```

*Ожидаемо (пример test):* `sessions: 18`, `projects: 6`, `providers: 3`, `models: 583`,
`serviceKeys: 2`, `итого: скопировано 650, пропущено 16`; в конце — «изменения не записаны».
Ключевые числа сверьте с файловым периметром **до** применения.

Применение — тот же манифест с двумя отличиями:

```text
metadata.name:  synth-migrate-pg-apply                 (было synth-migrate-pg)
command:        … --data-dir /var/synth/data --yes     (было … --dry-run)
```

Повторный перенос идемпотентен: уже существующие записи пропускаются. **Первый прогон может упасть
по таймауту холодного пула** — см. «Грабли», п. 1; это лечится повтором, а не правкой манифеста.

Сверка результата (независимо от отчёта команды):

```bash
psql "host=box.itphx.loc port=5432 dbname=synth_test user=synth" -c \
  'select (select count(*) from sessions) sessions, (select count(*) from messages) messages, (select count(*) from projects) projects;'
psql "host=box.itphx.loc port=5432 dbname=synth_test user=synth" -c \
  'select version from synth_schema_migrations order by version;'
```

*Ожидаемо (пример test):* `18 / 405 / 6`; таблиц схемы драйвера — 30, `version = 1`.

### Переключение режима

В `synth-deploy/test/values.yaml` добавьте секцию (пароля здесь **нет** — он в Secret):

```yaml
storage:
  backend: postgres
  degradedMode: halt
  postgres:
    host: box.itphx.loc   # пример test-среды — подставьте свой
    port: 5432
    database: synth_test
    user: synth
```

`halt` выбран осознанно (то же решение принято в dev): при `fallback-file` сервис **молча**
поднимется на файловом фоллбеке и данные разъедутся — при БД-режиме честнее остановиться. Смена
значений в `values.yaml` меняет шаблон пода, поэтому Fleet перекатит под автоматически; если
менялся только тег образа — `rollout restart` обязателен (см. выше).

### Верификация

1. **Health.** `GET /health` → `healthy` (не `degraded`).

   ```bash
   kubectl -n synth exec deploy/synth-backend -- \
     node -e "fetch('http://127.0.0.1:5000/health').then(r=>r.text()).then(console.log)"
   ```

2. **Логи.** В логах backend нет блока `[storage] ⚠️ PostgreSQL недоступен …`:

   ```bash
   kubectl -n synth logs deploy/synth-backend | grep -F '[storage]'
   ```

3. **Doctor.** Файловые проверки данных — `skipped` («неприменимо (backend=postgres)»), добавлены
   `db-connection`/`db-schema`:

   ```bash
   kubectl -n synth exec deploy/synth-backend -- \
     node /app/node_modules/@itphx/synth-core/dist/main.js doctor --json --data-dir /var/synth/data
   ```

   *Ожидаемо:* `ok: true`, `db-connection: ok`, `db-schema: ok`.

4. **Соединения реально есть.** `select count(*) from pg_stat_activity where datname='synth_test'` > 0.
5. **Пишет именно в БД.** `mtime` файлов на PVC (`settings.json`, `sessions/*`) **не меняется**, а
   записи видны в БД — например, обновляется `last_used_at` у используемого service-key:

   ```sql
   select label, last_used_at from service_keys order by last_used_at desc nulls last;
   ```

6. **Шлюз.** В логах `synth-gateway-telegram` тенант `test` — `up`, ошибок авторизации нет.

### Service-key: дефект миграции и восстановление

**Симптом.** После переключения все внешние потребители получают **401** — в нашем случае это
Telegram-шлюз (service-key `telegram-gateway`), плюс мог пострадать installer-ключ.

**Причина.** `copyServiceKeys` в `packages/core/src/maintenance/storage-migrate.ts` пересоздаёт
ключи через `dst.serviceKeys.create(...)` и **не переносит `hash`/`prefix`** — создаётся новая
запись с новым секретом (то же в `copyEventApiKeys` для ключей привязок событий). Предупреждение
команды («секреты перевыпущены») формально верное, но фактически ломает уже настроенных клиентов.

**Восстановление возможно, пока цел файловый стор.** At-rest хранится sha256, а не plaintext,
поэтому для проверки токена достаточно вернуть исходный `hash`; plaintext потребителя не нужен.
Исходные значения лежат в `/var/synth/data/service-keys.json` (поле `hash`, рядом `prefix`):

```bash
kubectl -n synth exec deploy/synth-backend -- cat /var/synth/data/service-keys.json
```

```sql
update service_keys
   set secret_hash = '<hash из файла>', prefix = '<prefix из файла>'
 where label = '<label>';
```

(`prefix` — информационное поле «первые символы + `…`»; восстанавливается для консистентности
выдачи, на проверку не влияет. Для ключей привязок — аналогично `event_api_keys`.)

Затем перезапустите потребителей:

```bash
kubectl -n synth rollout restart deploy/synth-backend deploy/synth-gateway-telegram
```

**Проверка.** sha256 реального токена должен совпасть с `secret_hash`, а запрос этим ключом — дать 200:

```bash
printf '%s' '<token потребителя>' | sha256sum
curl -s -o /dev/null -w '%{http_code}\n' https://synth.k3s.itphx.loc/api/v2/sessions \
  -H 'Authorization: Bearer <token потребителя>'
```

**Известное ограничение (нужен фикс в коде).** Порта `ServiceKeyRepository`/`EventApiKeyRepository`
не хватает метода импорта с готовым хэшем, поэтому «правильный» перенос сейчас невозможен, а
восстановление из файлового стора — обходной путь. **После чистки PVC восстановить нельзя** —
останется только перевыпуск ключей потребителям. Пока дефект не исправлен, чистку PVC делайте
только после того, как убедились, что все потребители работают на восстановленных ключах.

### Чистка PVC (после подтверждённой работы)

Файловый периметр остаётся вторым уровнем отката, поэтому чистить его можно **только** после
верификации выше (и лучше — после нескольких дней работы на БД).

Удаляются данные, которые теперь живут в БД:

```bash
kubectl -n synth exec deploy/synth-backend -- sh -lc '
  cd /var/synth/data &&
  rm -rf sessions projects models providers mcp events auth/profiles secrets/ssh-keys \
         service-keys.json settings.json audit/maintenance.jsonl'
```

> **До чистки** проверьте потребителей ключей привязок событий: их `secret_hash` лежит в
> `events/api-keys.json`, и после удаления каталога восстановить его будет нечем (только перевыпуск).
> Порядок тот же, что для service-key (см. выше), — сначала `update event_api_keys …`, затем чистка.

**Остаются (by design):**

| Путь | Почему |
|---|---|
| `skills/` | discovery скиллов идёт с ФС и в БД-режиме (файловая реализация core) |
| `workspaces/` | рабочие каталоги проектов, не данные хранилища |
| `backups/` | архивы, в т.ч. снятый перед миграцией |
| `secrets/master.key` | мастер-ключ at-rest (SSH-ключи и пр.) |
| `secrets/postgres-password` | файловый вариант пароля БД (если используется) |
| `meta.json` | версия схемы файлового периметра |

*Ожидаемо (пример test):* каталог данных сокращается с ~16,4 МБ до ~2,2 МБ.

### Откат

Порядок — от дешёвого к дорогому, **до чистки PVC** любой из шагов возвращает рабочее состояние:

1. **Вернуть файловый backend.** Уберите секцию `storage` из `test/values.yaml` → push → Fleet
   применит `file`. Файловые данные целы (миграция их не удаляет), сервис поднимется на них.
2. **Откатить релиз Helm.** Если после переключения менялись и другие параметры:

   ```bash
   helm -n synth history synth-test
   helm -n synth rollback synth-test <rev>
   ```

   Учтите: rollback вернёт и значения (включая отсутствие `storage`), но **не** пересоберёт образ.
3. **Откатить образ.** Только пересборкой из предыдущего коммита `synth` (старый digest после
   перезаписи тега недоступен) — см. «Артефакты и деплой».

После чистки PVC шаг 1 не спасает: остаётся только `synth backup`-архив или `pg_dump` БД.

### Грабли

| Симптом | Причина | Что делать |
|---|---|---|
| `Connection terminated due to connection timeout` на первом прогоне миграции | Холодный старт пула: TCP до БД 8 мс, одиночный `pg.Client` — 101 мс, а первый `connect` пула успевает истечь; повтор проходит за 7–11 с | Повторить Job. Сеть ни при чём — проверяйте её отдельно (п. 1 «Предусловий»). При `degradedMode: halt` такие таймауты дают отказ старта — учитывайте при cold start |
| `ls /app/node_modules/@itphx/` не показывает драйвер | `pnpm deploy` раскладывает опциональные зависимости в `.pnpm` | Проверять импортом из каталога core (см. «Артефакты и деплой») |
| `helm upgrade` «прошёл», поды старые | Нет checksum-аннотации; при неизменном теге шаблон пода не меняется | `rollout restart` + сверка `imageID` до/после |
| Откат образа «не тянется» | Тег перезаписан, старый digest удалён из реестра | Пересборка из предыдущего коммита; для релизов — бамп версии |
| Чарта нет в реестре сразу после публикации | Gitea регенерирует `index.yaml` с задержкой | Повторить запрос через 30–60 с |
| Неожиданно обновился чужой чарт | Скрипт публикует оба чарта (`synth`, `synth-gateway-telegram`) | Ожидаемо; проверяйте оба после публикации |
| `FATAL: для роли "…" вход запрещён` | У роли `NOLOGIN`, пароль ещё не проверялся | `ALTER ROLE … LOGIN`, затем повторить; не путать с неверным паролем |
| После перезапечатывания SealedSecret не работает вход | Утилита изменила посторонние ключи | Сверить sha256 OIDC-секрета и ключа провайдера с значениями **до**, при расхождении — откатить SealedSecret |
| `apply` Job'а падает «field is immutable» | Job с тем же именем уже существует | `kubectl -n synth delete job <name>` перед повтором |
| Внешние потребители получают 401 после переключения | Дефект `copyServiceKeys`/`copyEventApiKeys` (не переносятся `hash`/`prefix`) | Восстановить `secret_hash` из файлового стора (см. «Service-key») |

## Удаление инстанса

**Цель:** осознанно удалить инстанс; по умолчанию данные **сохраняются**.

1. `synth uninstall` — печатает сводку каталога данных (размер, сессии/проекты, `secrets/`/`master.key`,
   версия схемы, число страховочных копий) и **ничего не удаляет**.
2. `synth uninstall --dry-run` — то же, плюс «было бы удалено».
3. `synth uninstall --purge --yes` — удаляет каталог данных рекурсивно (необратимо). Без `--yes` —
   отказ. Перед удалением предупреждает: **мастер-ключ** внутри каталога → зашифрованные SSH-ключи
   невосстановимы; **страховочные копии** в `backups/` тоже будут удалены.
4. **`storage.backend=postgres`.** По умолчанию `--purge` удаляет только файловый периметр — данные БД
   (сессии/проекты/настройки) **не** затрагиваются. Удаление схемы БД — только явным
   `synth uninstall --purge --purge-db --yes` (`DROP SCHEMA … CASCADE`, необратимо). `--purge-db` без
   `--purge`/`--yes` или при `backend≠postgres` — ошибка (fail-closed).
5. **Локальный home** ([ADR-079](./arch_decisions/adr-079-local-home-independent-instances.md)): после
   `--purge` команда перечисляет остающиеся `{home}/config.yaml`, `profiles.json`, `credentials.json` —
   удалите их вручную при необходимости.
6. **Helm/K8s.** `helm uninstall synth -n synth` при `persistence.keepOnUninstall: false` (дефолт чарта)
   **удалит PVC** с данными. Если данные нужны — выставьте `keepOnUninstall: true` заранее (позднее
   `kubectl annotate` живого PVC не помогает: Helm смотрит манифест релиза). Удаление инстанса — это
   также очистка PVC, Secret (`synth-secrets`, signing-ключи), образов и namespace.
7. Аудит-событие `uninstall.purge` фиксируется в `{dataDir}/audit/maintenance.jsonl` (ADR-092); при
   `--purge` запись удаляется вместе с каталогом данных — для сохранности аудита вне инстанса нужен
   внешний audit-sink (остаток [ADR-092](./arch_decisions/adr-092-instance-lifecycle-maintenance.md)).

## Обновление и откат

**Цель:** обновить пакет `@itphx/synth` до новой версии или осознанно откатиться на более старую;
ожидаемый результат — инстанс стартует на целевой версии без ошибок совместимости схемы, `synth doctor`
без `fail`.

Команда работает с **глобально установленным** пакетом (`npm install -g @itphx/synth`); в dev-репозитории
то же доступно как `node packages/core/dist/main.js update …`.

1. **Перед обновлением — бэкап** (см. «Бэкап»): после обновления миграция может изменить данные
   необратимо.
2. **Проверка.** `synth update` — печатает текущую и целевую (последнюю известную по `latest`) версию, тип
   операции (обновление/откат/без изменений) и подсказку, что делать; `--json` — машиночитаемо.
3. **Предпросмотр.** `synth update --dry-run [--to <version>]` — печатает план (`npm install -g
   @itphx/synth@<version>`, «сейчас → станет», тип операции) и **ничего не устанавливает** (аудита тоже нет).
4. **Обновление.** `synth update --apply` — установка последней версии; без `--yes` запрашивается
   подтверждение `[y/N]`.
5. **Откат (standalone, npm).** `synth update --to <prev> --apply` — установка конкретной версии. `--to`
   валидируется (semver `X.Y.Z`, префикс `v` допустим) и обязан **существовать в реестре npm**, иначе —
   ошибка с кодом выхода 1. Если целевая версия ниже текущей, операция помечается как **откат**, и в
   приглашении явно пишется «ОТКАТ на более старую версию». `--to` **без** `--apply` ничего не
   устанавливает — только сообщает команду для установки.
6. **Правило понижения:** **понижение версии не мигрирует данные назад.** Откат данных = только
   `synth restore` из бэкапа, снятого до обновления; сама версия пакета откатывается отдельно
   (`synth update --to <prev> --apply`, для K8s — `helm rollback <release> <revision>`).
7. **Порядок «понижение версии + восстановление данных»:** остановить сервис → вернуть версию пакета →
   `synth restore <archive> --yes` → `synth doctor`. Если схема архива старше пакета (`doctor` покажет
   `schema: pending`), примените `synth migrate --yes` (или просто запустите инстанс — авто-миграция на
   старте со страховочной копией).
8. **K8s (managed):** обновление — публикуемым Helm-чартом (новый тег образа); откат —
   `helm rollback <release> <revision>`; при необходимости восстановите данные из бэкапа
   ([PUBLISHING.md](./PUBLISHING.md)).
9. **После успеха** команда напоминает про **перезапуск инстанса** (миграции схемы данных применятся на
   старте автоматически) и про `synth doctor`.
10. **Аудит** ([ADR-092](./arch_decisions/adr-092-instance-lifecycle-maintenance.md)): успех пишется в
    `{dataDir}/audit/maintenance.jsonl` как `update.applied`/`rollback.applied` (`details: {from, to}`);
    провал/ошибка установки или несуществующая версия — `update.failed` с `error`.
11. *Ожидаемо:* после обновления — старт без ошибок совместимости схемы, `synth doctor` без `fail`;
    страховочная копия перед авто-миграцией — в `{dataDir}/backups/`.

## Обслуживание из UI

**Цель:** выполнить эксплуатационные операции без CLI; доступно только роли ADMIN.

Раздел живёт в **Настройки → «Обслуживание»** (админ-категория `maintenance`, видна только
роли `ADMIN`; компонент —
`packages/ui/src/components/settings/MaintenanceSettings.tsx`). UI лишь прячет раздел —
**защита на сервере**: в managed роуты под `requirePermission('ADMIN')`, в standalone-core —
`requireAuth`. Ожидаемый результат — статус/бэкапы/восстановление управляются мышью, а сама
операция восстановления требует перезапуска инстанса.

1. **Состояние инстанса.** Показывает версию Synth, каталог данных, версию схемы и сводку
   `synth doctor` (`ok`/`fail`/`warn`). Кнопка «Проверить» перезапускает `synth doctor` и
   перечитывает статус; ниже — список проверок с подсказками. *Ожидаемо:* зелёная сводка при
   отсутствии `fail`; проверки `warn` — повод разобраться, но не блокер.
2. **Схема данных.** Текущая/ожидаемая версия, применённые миграции, список pending. Кнопка
   «Применить миграции» (с подтверждением) вызывает `POST /maintenance/migrations/apply`
   `{confirm:true}`; перед записью создаётся **обязательная страховочная копия** (fail-closed).
   *Ожидаемо:* тост «применено N», в списке больше нет pending. Если данные новее пакета —
   ошибка 409 `SCHEMA_TOO_NEW` («обновите Synth»), а не откат.
3. **Бэкапы.** Чекбоксы `secrets`/`workspace`/`live` и кнопка «Создать» — снятие архива каталога
   данных (см. «Бэкап»). Список архивов: имя, бейджи `secrets`/`workspace`, дата/размер/версия
   схемы/версия инстанса/число записей; на карточке — **скачивание** (`*.tar.gz`) и **удаление**
   (с подтверждением). Из UI создаётся **только незашифрованный** архив (ключ шифрования живёт у
   оператора и серверу недоступен); зашифрованные архивы (`encrypted: true`) показываются с бейджем
   **«зашифрован»**, а их скачивание и восстановление в UI **отключены** («доступно только через
   CLI») — удаление при этом доступно. *Ожидаемо:* созданный архив появляется в списке; скачивание
   отдаёт gzip.
4. **Восстановление.** Выберите архив из списка **или** загрузите файл `*.tar.gz` с устройства →
   «Проверить» (валидация: манифест/формат/версия схемы/контрольные суммы; при успехе показывается
   манифест) → «Запланировать» (с подтверждением). **Восстановление применится при следующем
   запуске инстанса, а не сейчас.** Пока запрос отложен, показывается плашка с архивом/датой и
   кнопкой «Отменить». *Ожидаемо:* плашка «запланировано» и признак «применится при следующем
   старте»; после перезапуска инстанса — данные из архива.
5. **Журнал обслуживания.** История операций жизненного цикла (бэкап/восстановление/миграции):
   время, операция, статус-бейдж (`ok`/`failed`/`scheduled`), автор и краткая сводка деталей.
   Записи «свежие первыми»; кнопка «Обновить» перечитывает журнал, «Очистить журнал» (с
   подтверждением) удаляет все записи. *Ожидаемо:* после создания бэкапа в журнале появляется
   запись `backup.created`; журнал помогает разобрать «что, когда и кем» менялось на инстансе.

## Обслуживание по API

**Цель:** те же операции из скриптов/пайплайнов. Полная спека — [API_V2.md](./API_V2.md) §5.31.
RBAC: managed (backend) — только `ADMIN`; core (standalone) — `requireAuth`. Токен в примерах —
плейсхолдер `<ADMIN_TOKEN>`; сами секреты в документации не приводятся.

| Метод/путь | Назначение |
|---|---|
| `GET /api/v2/maintenance/status` | Сводный статус (схема/бэкапы/pending/doctor) |
| `GET /api/v2/maintenance/doctor` | Полный `synth doctor` |
| `GET /api/v2/maintenance/migrations` | Состояние схемы данных |
| `POST /api/v2/maintenance/migrations/apply` | Применить миграции (`{confirm:true}`) |
| `GET /api/v2/maintenance/backups` | Список архивов |
| `POST /api/v2/maintenance/backups` | Создать архив |
| `GET /api/v2/maintenance/backups/:name/download` | Скачать архив |
| `DELETE /api/v2/maintenance/backups/:name` | Удалить архив |
| `POST /api/v2/maintenance/restore/validate` | Проверить архив (JSON или multipart) |
| `GET /api/v2/maintenance/restore` | Отложенный запрос на восстановление |
| `POST /api/v2/maintenance/restore` | Запланировать восстановление (`{confirm:true}`) |
| `DELETE /api/v2/maintenance/restore` | Отменить отложенный запрос |
| `GET /api/v2/maintenance/audit` | Журнал обслуживания (`limit`, `op`) |
| `DELETE /api/v2/maintenance/audit` | Очистить журнал (`{confirm:true}`) |

Примеры:

```bash
# Статус и полный synth doctor.
curl http://localhost:5000/api/v2/maintenance/status -H 'Authorization: Bearer <ADMIN_TOKEN>'
curl http://localhost:5000/api/v2/maintenance/doctor  -H 'Authorization: Bearer <ADMIN_TOKEN>'

# Создать архив (без секретов/workspaces) и скачать.
curl -X POST http://localhost:5000/api/v2/maintenance/backups \
  -H 'Authorization: Bearer <ADMIN_TOKEN>' -H 'Content-Type: application/json' \
  -d '{"withSecrets":false,"withWorkspace":false,"live":false}'
curl -OJ http://localhost:5000/api/v2/maintenance/backups/<name>.tar.gz/download \
  -H 'Authorization: Bearer <ADMIN_TOKEN>'

# Проверить архив из backups/ и запланировать восстановление (применится при следующем старте).
curl -X POST http://localhost:5000/api/v2/maintenance/restore/validate \
  -H 'Authorization: Bearer <ADMIN_TOKEN>' -H 'Content-Type: application/json' \
  -d '{"archive":"synth-backup-<instanceVersion>-<stamp>.tar.gz"}'
curl -X POST http://localhost:5000/api/v2/maintenance/restore \
  -H 'Authorization: Bearer <ADMIN_TOKEN>' -H 'Content-Type: application/json' \
  -d '{"archive":"synth-backup-<instanceVersion>-<stamp>.tar.gz","confirm":true}'

# Загрузить архив из файла и проверить (multipart).
curl -X POST http://localhost:5000/api/v2/maintenance/restore/validate \
  -H 'Authorization: Bearer <ADMIN_TOKEN>' -F 'file=@./synth-backup.tar.gz'

# Отменить отложенное восстановление.
curl -X DELETE http://localhost:5000/api/v2/maintenance/restore \
  -H 'Authorization: Bearer <ADMIN_TOKEN>'

# Прочитать журнал обслуживания (последние 5 записей; «свежие первыми»).
curl 'http://localhost:5000/api/v2/maintenance/audit?limit=5' \
  -H 'Authorization: Bearer <ADMIN_TOKEN>'
```

**Правила безопасности.**

- **Восстановление — офлайн-операция.** `POST /restore` только планирует его; применение — при
  следующем старте инстанса (`appliesOnNextStart: true`, `applyPendingRestore` до миграций). Под
  живым процессом каталог данных не вычищается — не ждите немедленного эффекта.
- **Managed — только ADMIN.** И чтение, и мутации под `requirePermission('ADMIN')`; в
  standalone-core — `requireAuth`. Токены/ключи — секреты, в примерах только плейсхолдеры.
- **Архив с секретами — сам секрет.** `--with-secrets`/`withSecrets:true` включает `secrets/`
  (в т.ч. `master.key`); такой архив храните `0600` вне публичных мест. Без мастер-ключа
  зашифрованные SSH-ключи из архива невосстановимы.
- **Шифрование — только CLI.** `POST /backups` опцию `encrypt` **не поддерживает** (ключ серверу
  недоступен); зашифрованные `*.tar.gz.enc` видны в `GET /backups` и скачиваются/удаляются по API,
  но `POST /restore` по ним отвечает 400 `VALIDATION_ERROR` («расшифровка доступна только через
  CLI»).
- **Деструктивность.** Применение миграций и планирование восстановления требуют `confirm: true`;
  восстановление возвращает каталог к снимку (`backups/` и `workspaces/` без `--with-workspace`
  сохраняются); страховочная копия создаётся автоматически (`safetyCopy:false`/`--no-safety-copy`
  отключают — рискованно).

## История

- 2026-10-16 — краткое описание `synth storage migrate` развёрнуто в runbook «Перенос данных между backend'ами»: цель, предусловия (env-адресация цели, запрет `SYNTH_STORAGE_BACKEND` при вызове, останов сервиса), порядок (бэкап → dry-run → apply), независимая сверка (`psql`/`doctor`), закрепление режима, верификация после старта (в т.ч. проверка записи в БД), откат, ограничения/fail-closed и предупреждение о `storage.degradedMode`; проверено на живом dev-переносе (2026-10-16).
- 2026-10-16 — добавлен раздел «PostgreSQL как backend хранения» ([PROP-032](./arch_decisions/prop-032-history-storage-postgresql.md)/[ADR-098](./arch_decisions/adr-098-storage-degraded-recovery.md)): схема драйвера и `synth migrate`, db-проверки `doctor`, бэкап/restore (данных БД в архиве нет — `pg_dump`/PITR), `uninstall --purge-db`, деградированный режим и скилл `synth-storage-recovery`, перенос данных `synth storage migrate` с честными ограничениями.
- 2026-10-16 — runbook создан (первичная настройка, диагностика, бэкап/восстановление, миграции, удаление, обновление/откат).
- 2026-10-16 — добавлены разделы «Обслуживание из UI» (Настройки → «Обслуживание», ADMIN) и «Обслуживание по API» (admin-API `/api/v2/maintenance/*`, [API_V2.md](./API_V2.md) §5.31); восстановление — офлайн (`appliesOnNextStart`, отложенный запрос применяется при старте).
- 2026-10-16 — добавлен журнал обслуживания (`GET/DELETE /api/v2/maintenance/audit`, ADR-092): история операций жизненного цикла, видна в разделе «Обслуживание» и по API.
- 2026-10-16 — добавлено шифрование архива бэкапа (ADR-091): `synth backup --encrypt` (внешний ключ `--key-file`/`SYNTH_BACKUP_KEY[_FILE]`, формат `<archive>.tar.gz.enc` + sidecar `.enc.meta.json`), восстановление `.enc` только через CLI (`synth restore <archive>.enc`); в UI зашифрованные архивы помечаются и исключены из скачивания/восстановления.
- 2026-10-16 — добавлен раздел «Перенос проекта между инстансами» (`synth project export|import`, ADR-091 §6): архив без секретов, materialization с новыми id, `--merge-into`/`--dry-run`/`--yes`/`--with-workspace`, маппинг id.
- 2026-10-16 — перенос проекта доступен по HTTP API (роуты `GET /api/v2/projects/:id/export` и `POST /api/v2/projects/import`, [API_V2.md](./API_V2.md) §5.8.1): скачивание архива и импорт multipart; `confirm` не требуется.
- 2026-10-17 — добавлен раздел «Миграция хранилища в Kubernetes (K3s/Fleet)»: предусловия (TCP из namespace, `NOLOGIN` ≠ неверный пароль, сверка sha256 ключей SealedSecret), артефакты/деплой без бампа версии (проверка драйвера в образе резолвингом, обязательный `rollout restart`), бэкап и миграция Job'ами на PVC (`job-backup`/`job-migrate`/`job-migrate-apply`), переключение режима в `values.yaml` с `degradedMode: halt`, верификация, дефект `copyServiceKeys`/`copyEventApiKeys` (не переносятся `hash`/`prefix`) и восстановление из файлового стора, чистка PVC, откат и грабли; проверено на test-инстансе (2026-10-17).

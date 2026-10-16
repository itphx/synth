# ADR-092: Обслуживание инстанса — версия схемы данных, миграции и удаление

> **Статус:** ⚠️ Частично — MVP реализован (`meta.json`, реестр миграций, авто-миграции, `synth migrate`, `synth uninstall`); остаток — `synth update --to`, аудит-события, мульти-инстанс-локи.
> **Дата:** 2026-10-16
> **Связано:** [ADR-005](./adr-005-json-storage.md), [PROP-032](./prop-032-history-storage-postgresql.md), [ADR-038](./adr-038-npm-packages.md), [ADR-076](./adr-076-git-repo-registry-ssh.md), [ADR-079](./adr-079-local-home-independent-instances.md), [ADR-051](./adr-051-scheduler-pipelines.md), [ADR-091](./adr-091-backup-restore-transfer.md); процедуры — [docs/MAINTENANCE.md](../MAINTENANCE.md).

## Контекст

Эксплуатационного контура не было: не существовало глобальной версии схемы данных (только точечные `schemaVersion` отдельных стораджей и разовая маркер-миграция `session-scope-snapshots-v1`), план отката и удаление за собой не были описаны, а `helm uninstall` при `backend.persistence.keepOnUninstall: false` (дефолт чарта) удаляет PVC с данными — это не документировалось как риск.

## Решение

Замкнуть жизненный цикл: **обновление → миграция → (при неудаче) откат → удаление**.

1. **Версия схемы данных.** `{dataDir}/meta.json`: `schemaVersion` / `instanceVersion` / `migrations` / `updatedAt`; отсутствие файла = `schemaVersion = 0` (существующие инсталляции). Запись атомарная (tmp→rename).
2. **Реестр миграций** (`storage/instance-meta.ts`): `id` / `toVersion` / `description` / `run`; `SCHEMA_VERSION` = max `toVersion`; идемпотентно (маркер внутри миграции). Разовая миграция `session-scope-snapshots-v1` переведена на общий реестр.
3. **Guard совместимости на старте** (паритет standalone-core и managed-backend): `meta.schemaVersion > SCHEMA_VERSION` → **отказ старта** («данные новее версии; обновите Synth»). Правило: **понижение версии не мигрирует данные назад** — откат данных только `synth restore` из бэкапа ([ADR-091](./adr-091-backup-restore-transfer.md)).
4. **Авто-миграции при старте** (`applyStartupMigrations`): guard → **обязательная страховочная копия** (fail-closed: без копии не мигрируем, `{dataDir}/backups/synth-pre-migrate-<stamp>.tar.gz`) → pending-миграции под межпроцессным локом `{dataDir}/migrate` (`FileMutex`, heartbeat). Вручную: `synth migrate --dry-run` (план) / `synth migrate --yes` (без `--dry-run` и без `--yes` — отказ).
5. **`synth uninstall [--purge|--dry-run|--yes]`** — по умолчанию данные **сохраняются** (сводка: размер, сессии/проекты, `secrets/`/`master.key`, версия схемы, число копий); `--purge` требует `--yes` и предупреждает об утрате мастер-ключа и страховочных копий; для локального home ([ADR-079](./adr-079-local-home-independent-instances.md)) перечисляет остающиеся `config.yaml`/`profiles.json`/`credentials.json`.

**Обновление и откат:**

| Операция | Команда | Замечание |
|---|---|---|
| Проверить | `synth update` | показывает current/latest |
| Обновить | `synth update --apply [--to <version>]` | без `--to` — последняя стабильная из известных, не слепой `latest` |
| Откат (standalone, npm) | `synth update --to <prev> --apply` | downgrade пакета |
| Откат (K8s) | `helm rollback <release> <revision>` | + при необходимости restore данных из бэкапа ([ADR-091](./adr-091-backup-restore-transfer.md)) |
| Совместимость | — | понижение версии не мигрирует данные назад; откат данных = только restore из бэкапа |

**Безопасность.** Перед обновлением — бэкап: после обновления миграция может изменить данные необратимо. Миграция/откат/purge — привилегированные операции: подтверждение (`--yes`), `--dry-run`, страховочная копия перед изменяющими шагами; секретов в логах нет (при purge — предупреждение об утрате мастер-ключа). Процедуры и оговорка про `helm` — [docs/MAINTENANCE.md](../MAINTENANCE.md).

## Альтернативы

- **Версия схемы — только константа пакета (без `meta.json`)** — отклонён: факт применения миграций всё равно нужно персистить; `meta.json` фиксирует и версию, и журнал.
- **Снапшот только затрагиваемых файлов** — отклонён: полный архив ([ADR-091](./adr-091-backup-restore-transfer.md)) проще и надёжнее, а объёмы ещё невелики.
- **Автоматический откат данных при понижении версии** — отклонён: необратимо и рискованно; откат данных — только restore из бэкапа.
- **Удалять данные при `uninstall` по умолчанию** — отклонён: деструктивно; данные сохраняются, `--purge` должен быть явным.

## Последствия

- (+) Версионированная схема данных и идемпотентные миграции; несовместимость «данные новее пакета» ловится на старте, а не в рантайме.
- (+) Необратимые шаги защищены страховочной копией (fail-closed) и подтверждением; `uninstall` не удаляет данные без явного `--purge`.
- (−) Авто-миграция меняет данные на старте (под копией и локом) — нужна дисциплина «бэкап перед обновлением».
- (−) Мульти-инстанс-сериализация — file-based (`FileMutex` на общем `dataDir`); для разных хостов нужен K8s Lease/PG advisory lock.

## Остаток

- `synth update --to <version>` (обновление/откат пакета) — **не реализовано** (см. таблицу выше);
- аудит-события `maintenance.migrate`/`maintenance.rollback`/`uninstall.purge`;
- публикация runbook на портале `docs.synth.itphx.ru` (dev-вариант — [docs/MAINTENANCE.md](../MAINTENANCE.md));
- K8s Lease / PG advisory lock для мульти-инстанса (после [PROP-032](./prop-032-history-storage-postgresql.md)).

## История

- 2026-10-16 — PROP-092 принят как ADR-092 (MVP реализован; остаток вынесен) (коммиты ветки feat/storage-seam).

# PROP-091: Бэкап, восстановление и перенос данных

> **Статус:** 🧩 Предложение — Бэкап/восстановление/перенос данных: `synth backup`/`restore`, портативный экспорт/импорт проекта
> **Решение до:** 2026-11-14
> **Дата:** 2026-10-15
> **Парные документы:**
> - [ADR-005](./adr-005-json-storage.md) «JSON-файлы как хранилище» — текущий физический уровень (атомарная запись tmp→rename) и предмет бэкапа;
> - [PROP-032](./prop-032-history-storage-postgresql.md) «Хранение истории на PostgreSQL» — долгосрочный путь к онлайн-консистентному бэкапу и PITR;
> - [ADR-036](./adr-036-llm-gateway.md) / [ADR-076](./adr-076-git-repo-registry-ssh.md) — секреты at-rest (мастер-ключ, SSH-ключи, ключи service/binding, signing-секреты вебхуков);
> - [ADR-042](./adr-042-hybrid-mode.md) «Гибридный режим» — `publish`/`fork` как перенос проекта между мирами;
> - [PROP-055](./prop-055-instance-exchange.md) «Обмен между инстансами» — будущий канал синхронизации, опирается на портативный формат экспорта;
> - [PROP-074](./prop-074-soft-delete-retention.md) «Скрытие вместо удаления» — hidden/purge сущности и их место в бэкапе;
> - [ADR-079](./adr-079-local-home-independent-instances.md) «Локальный home» — раскладка путей локального инстанса;
> - [PROP-092](./prop-092-instance-lifecycle-maintenance.md) «Обслуживание инстанса» — миграции/обновление/откат/uninstall, часть общего эксплуатационного контура;
> - [PROP-048](./prop-048-self-help-skills-admin-mcp.md) «Self-help скиллы» — автоматизация эксплуатации (setup/verify/backup/restore) через локальный Synth.

## Решение

Ввести **единый контур жизненного цикла данных** инстанса:

1. **`synth backup`** — снимает архив каталога данных (`$SYNTH_DATA_DIR`) в `tar.gz` с **манифестом** (версия схемы, версия Synth, время, список файлов, контрольная сумма) и опциональным шифрованием.
2. **`synth restore --yes`** — проверяет архив (манифест, версия схемы, контрольная сумма), делает страховочную копию текущих данных и восстанавливает; без `--yes` и без `--dry-run` — отказ (по образцу `synth secrets rotate`).
3. **Портативный экспорт/импорт данных** — проект целиком (проект + сессии + файлы + план + реестр репозиториев) в переносимый бандл, **без секретов**; переиспользует `remote/transfer.ts` и существующие `GET /sessions/:id/export` / `POST /sessions/import`.
4. **Эксплуатационный гайд** — бэкап/восстановление каталога данных, мастер-ключа, PVC/K8s; снапшот-подход для онлайн-режима.
5. **Первичная настройка (bootstrap-гайд)** — пошаговый setup инстанса «с нуля»: данные (`dataDir`/`--home`), ключи (мастер-ключ и его ротация), провайдеры/модели, workspace, первый вход (аутентификация/роли).
6. **`synth doctor` / проверка (verify)** — health инстанса, целостность данных, доступность мастер-ключа и секретов, провайдеры/модели, write-доступ к `dataDir`, состояние миграций. После `restore` проверка (verify) **обязательна** и входит в сценарий восстановления.

MVP — **пункты 1, 2, 4, 5, 6** (CLI + документация): backup/restore + первичная настройка + `synth doctor`. Портативный экспорт (3) — второй этап. Онлайн-консистентный бэкап и PITR — после [PROP-032](./prop-032-history-storage-postgresql.md).

---

## Контекст

Сегодня восстановление после сбоя держится целиком на ручном копировании каталога, и это нигде не описано:

- **Нет ни одной команды backup/restore.** В CLI есть только `secrets rotate` ([ADR-076](./adr-076-git-repo-registry-ssh.md)); в доках — единственная фраза «сделайте бэкап данных» перед ротацией ключа (`docs/ru/admin/configuration.md`).
- **Нет манифеста и версионирования бэкапа** — нельзя понять, из какой версии снят архив и совместим ли он для восстановления.
- **Секреты at-rest лежат вместе с данными** и без них часть данных нечитаема: `secrets/master.key` расшифровывает SSH-ключи агентов и signing-секреты вебхуков; `secrets/api-key`, `service-keys.json`, `events/api-keys.json` — хеши (переносимые), но мастер-ключ обязателен. Бэкап данных **без** мастер-ключа = расшифровки не будет; бэкап **с** ним = архив становится секретом.
- **Экспорт/импорт есть точечно:** `GET /api/v2/sessions/:id/export` и `POST /api/v2/sessions/import` (internal-формат), CLI `synth publish` / `synth fork` (проект + сессии + файлы) — но только в гибридном режиме; «портативного» экспорта проекта для standalone нет.
- **Консистентность.** Файловое хранилище ([ADR-005](./adr-005-json-storage.md)) пишет каждый файл атомарно (tmp→rename), поэтому **отдельные** файлы консистентны, но **сквозной транзакции между сущностями нет** (например, сессия и проект обновляются разными записями). In-process `AsyncLock` — только внутри процесса, межпроцессной блокировки записи нет.

## Детали

### Что попадает в бэкап

| Класс | Путь в `$SYNTH_DATA_DIR` | В бэкап | Замечание |
|---|---|---|---|
| Сессии | `sessions/` | ✅ | история, план, todo |
| Проекты | `projects/` | ✅ | включая `workspace` — по желанию (`--with-workspace`) |
| Провайдеры/модели/агенты | `providers/`, `models/`, `agents/`, `context/` | ✅ | |
| Профили | `auth/` (sessions, states, profiles) | ✅ | |
| События/расписания/вебхуки | `events/`, `schedules.json`, `webhooks/` | ✅ | |
| Ключи | `service-keys.json` | ✅ | at-rest sha256 — переносимо |
| **Секреты** | `secrets/` (`master.key`, `api-key`, `ssh-keys/`) | ⚠️ опционально | `--with-secrets`; без мастер-ключа часть данных нерасшифровываема |
| Runtime-мусор | `workspaces/`, `tmp/`, `logs/` | ❌ по умолчанию | workspace — по флагу, остальное — нет |

### Модель бэкапа

- Формат: `synth-backup-<instanceVersion>-<YYYYMMDD-HHmmss>.tar.gz` + `manifest.json` внутри (схема/версия/список/хеш).
- **Offline (по умолчанию):** перед снятием — предупреждение; корректный вариант — при остановленном сервисе или в read-only, чтобы поймать межфайловую согласованность.
- **Онлайн (best-effort, `--live`):** предупреждает о возможной несогласованности между сущностями (каждый файл валиден, но срез — не транзакционный).
- Рекомендуемый прод-подход — **снапшот ФС**: PVC snapshot (K8s), LVM/ZFS snapshot, или `tar` с остановкой на окно.
- Шифрование: `--encrypt` (age/gpg, ключ передаётся пользователем) — для архивов с секретами; файл — `0600`.

### Портативный экспорт/импорт (этап 2)

- Формат: `synth-project-<slug>-<version>.zip` — `project.json`, `sessions/*.json`, `plan`, `repos[]` (без SSH-ключей), `workspace/` (опционально).
- Операции: `synth project export <id>` / `synth project import <file>`; HTTP-вариант под scope `sessions:create` (managed).
- Импорт — **materialization** (не `session.requested`), паритет с `POST /sessions/import` (инвариант 15, [ADR-089](./adr-089-external-events-automation.md)).
- Совместимость: манифест с версией схемы; неизвестная старшая версия → отказ, младшая → миграция.

### API для managed (этап 3, опционально)

- `GET /api/v2/admin/backup` (stream `tar.gz`) и `POST /api/v2/admin/restore` — только `ADMIN`, с аудитом. Для managed-инстанса; восстановление — офлайн-операция.

## Безопасность

- Архив с секретами — **секрет сам по себе**: предупреждение, `0600`, рекомендация `--encrypt`, запрет складывать в публичные места.
- Restore — только ADMIN/владелец инстанса; `--dry-run` печатает план без записи; перед записью — автоматическая страховочная копия.
- События аудита: `backup.created`, `restore.started/completed`, `export.project`, `import.project`.
- Портативный экспорт по умолчанию **без секретов** (нет мастер-ключа, нет SSH-ключей, нет plaintext-ключей). Ключи service/binding не переносятся (инстанс-локальные, [PROP-081](./prop-081-hybrid-policy-leak-protection.md)).

## Объём MVP и этапы

1. **MVP (контур «поднять → проверить → забэкапить → восстановить»):**
   - `synth backup` / `synth restore` (offline + `--live` предупреждение, `--with-secrets`, `--dry-run`/`--yes`, манифест);
   - **первичная настройка** — bootstrap-гайд (данные/ключи/провайдеры/workspace/первый вход);
   - **`synth doctor`** — health, целостность данных, доступность ключей/мастера, провайдеры, write-доступ к `dataDir`, состояние миграций; проверка после `restore` обязательна;
   - руководства (runbook): «Первичная настройка», «Проверка и диагностика», «Бэкап и восстановление» + guidance по PVC/snapshot. ~3–5 дней.
2. Портативный экспорт/импорт проекта (standalone + HTTP) + руководство «Перенос проекта». ~3–5 дней.
3. Admin API backup/restore для managed + шифрование. ~2–3 дня.
4. Онлайн-консистентный/инкрементальный бэкап — после [PROP-032](./prop-032-history-storage-postgresql.md).

## Утилиты и руководства

Эксплуатационный контур — единый набор команд `synth` + страницы-руководства (runbook) портала:

| Область | Утилита | Руководство (runbook) |
|---|---|---|
| Первичная настройка | `synth serve` / `synth init` (`dataDir`/`--home`, ключи, провайдеры, workspace, первый вход) | «Первичная настройка инстанса» (setup) |
| Проверка | `synth doctor` (health, целостность данных, ключи/мастер, провайдеры, write-доступ к `dataDir`, миграции) | «Проверка и диагностика» (verify) |
| Бэкап | `synth backup` | «Бэкап и восстановление» → «Бэкап» |
| Восстановление | `synth restore --yes` + обязательный `synth doctor` после | «Бэкап и восстановление» → «Восстановление» |
| Экспорт/импорт | `synth project export` / `synth project import` | «Перенос проекта» (export/import) |
| Миграции | `synth migrate` ([PROP-092](./prop-092-instance-lifecycle-maintenance.md)) | «Обслуживание инстанса» → «Миграции» |

- Руководства — **класс Runbook** ([docs/ARCH_DECISIONS.md](../ARCH_DECISIONS.md) §1): пошаговые процедуры с
  проверками и ожидаемым результатом, а не справка «что делает команда».
- Миграции, обновление/откат и удаление (`synth migrate`, `synth update --to`, `synth uninstall`) детально —
  [PROP-092](./prop-092-instance-lifecycle-maintenance.md); здесь — только место в общем контуре и правило
  «бэкап перед необратимым шагом».
- Автоматизация этих же шагов через локальный Synth (ops-скиллы: setup/verify/backup/restore/export/migrate) —
  [PROP-048](./prop-048-self-help-skills-admin-mcp.md).
- Сквозной сценарий проверяется целиком: **setup → verify → backup → restore → verify → migrate** (после
  `restore` — обязательный `doctor`).

## Реализация (MVP)

MVP реализован по решению владельца; формальное принятие (перевод в ADR) — за владельцем.

Сделано в коде (`packages/core/src/maintenance/*`):

- **`synth backup`** (`backup.ts`) — `--out` (файл или каталог), `--with-secrets`, `--with-workspace`,
  `--live` (предупреждение о нетранзакционном срезе); архив `0600`, имя
  `synth-backup-<instanceVersion>-<YYYYMMDD-HHmmss>.tar.gz`.
- **Манифест + контрольная сумма** (`archive.ts` + `BackupManifest`): `manifest.json` внутри архива
  (tool/formatVersion/`schemaVersion` из `meta.json`/`instanceVersion`/`createdAt`/флаги/исключения/
  записи с sha256/`contentChecksum`); **свой потоковый tar.gz** (ustar) без внешних зависимостей; при
  разборе отвергаются абсолютные пути и `..` (`ArchivePathError`).
- **`synth restore <archive>`** (`restore.ts`) — строгий порядок: манифест → формат → версия схемы
  (`>` `SCHEMA_VERSION` → отказ) → контрольные суммы → `--dry-run` → `--yes` (без него отказ) →
  страховочная копия → извлечение; `--no-safety-copy` отключает копию.
- **`synth doctor`** (`doctor.ts`) — `--json`; проверки `data-dir` (write-доступ пробным файлом
  `.doctor-probe`), `schema`, `master-key`, `secrets-permissions`, `data-integrity`, `providers`,
  `locks`, `version`; exit 1 при любом `fail`. После `restore` — обязателен.
- **Страховочные копии** — в единый каталог `{dataDir}/backups/` (`safetyCopyPath`, `pre-restore`/
  `pre-migrate`), исключённый из архивов бэкапа (не бэкапится рекурсивно).

Остаток: портативный экспорт/импорт проекта (`synth project export|import`), admin-API для managed,
шифрование `--encrypt`, онлайн-консистентный/инкрементальный бэкап (после [PROP-032](./prop-032-history-storage-postgresql.md)).

## Открытые вопросы

1. Формат манифеста: свой или совместимость с чем-то внешним (velero/Restic)?
2. Шифрование — встроенное (age) или полагаемся на инструмент пользователя (gpg/tar+openssl)?
3. Workspace проектов: включать в бэкап по умолчанию или только по флагу (объём может быть огромным)?
4. Нужен ли «safe mode» (сервис в read-only) как отдельный режим для консистентного онлайн-бэкапа?

## Связи

- [ADR-005](./adr-005-json-storage.md), [PROP-032](./prop-032-history-storage-postgresql.md), [ADR-042](./adr-042-hybrid-mode.md), [PROP-055](./prop-055-instance-exchange.md), [PROP-074](./prop-074-soft-delete-retention.md), [ADR-076](./adr-076-git-repo-registry-ssh.md), [ADR-079](./adr-079-local-home-independent-instances.md), [PROP-092](./prop-092-instance-lifecycle-maintenance.md), [PROP-048](./prop-048-self-help-skills-admin-mcp.md).

## Порядок реализации

MVP CLI (backup/restore + первичная настройка + `synth doctor`) + доки → портативный экспорт → admin API/шифрование → онлайн-консистентность (после PROP-032). Первый шаг даёт максимум пользы при низком риске и не зависит от PostgreSQL; миграции/обновление/откат — в [PROP-092](./prop-092-instance-lifecycle-maintenance.md), автоматизация скиллами — в [PROP-048](./prop-048-self-help-skills-admin-mcp.md).

# ADR-092: Обслуживание инстанса — версия схемы данных, миграции и удаление

> **Статус:** ⚠️ Частично — MVP реализован (`meta.json`, реестр миграций, авто-миграции, `synth migrate`, `synth update`/`--to` (обновление и откат), `synth uninstall`, аудит-журнал обслуживания, **graceful restart из UI**); миграции и перезапуск доступны через admin-API/UI (`/api/v2/maintenance`, раздел «Обслуживание»); остаток — публикация runbook на портале, мульти-инстанс-локи.
> **Дата:** 2026-10-16
> **Связано:** [ADR-005](./adr-005-json-storage.md), [PROP-032](./prop-032-history-storage-postgresql.md), [ADR-038](./adr-038-npm-packages.md), [ADR-076](./adr-076-git-repo-registry-ssh.md), [ADR-079](./adr-079-local-home-independent-instances.md), [ADR-051](./adr-051-scheduler-pipelines.md), [ADR-091](./adr-091-backup-restore-transfer.md); процедуры — [docs/MAINTENANCE.md](../MAINTENANCE.md).

## Контекст

Эксплуатационного контура не было: не существовало глобальной версии схемы данных (только точечные `schemaVersion` отдельных стораджей и разовая маркер-миграция `session-scope-snapshots-v1`), план отката и удаление за собой не были описаны, а `helm uninstall` при `backend.persistence.keepOnUninstall: false` (дефолт чарта) удаляет PVC с данными — это не документировалось как риск.

## Решение

Замкнуть жизненный цикл: **обновление → миграция → (при неудаче) откат → перезапуск → удаление**.

1. **Версия схемы данных.** `{dataDir}/meta.json`: `schemaVersion` / `instanceVersion` / `migrations` / `updatedAt`; отсутствие файла = `schemaVersion = 0` (существующие инсталляции). Запись атомарная (tmp→rename).
2. **Реестр миграций** (`storage/instance-meta.ts`): `id` / `toVersion` / `description` / `run`; `SCHEMA_VERSION` = max `toVersion`; идемпотентно (маркер внутри миграции). Разовая миграция `session-scope-snapshots-v1` переведена на общий реестр.
3. **Guard совместимости на старте** (паритет standalone-core и managed-backend): `meta.schemaVersion > SCHEMA_VERSION` → **отказ старта** («данные новее версии; обновите Synth»). Правило: **понижение версии не мигрирует данные назад** — откат данных только `synth restore` из бэкапа ([ADR-091](./adr-091-backup-restore-transfer.md)).
4. **Авто-миграции при старте** (`applyStartupMigrations`): guard → **обязательная страховочная копия** (fail-closed: без копии не мигрируем, `{dataDir}/backups/synth-pre-migrate-<stamp>.tar.gz`) → pending-миграции под межпроцессным локом `{dataDir}/migrate` (`FileMutex`, heartbeat). Вручную: `synth migrate --dry-run` (план) / `synth migrate --yes` (без `--dry-run` и без `--yes` — отказ).
5. **`synth uninstall [--purge|--dry-run|--yes]`** — по умолчанию данные **сохраняются** (сводка: размер, сессии/проекты, `secrets/`/`master.key`, версия схемы, число копий); `--purge` требует `--yes` и предупреждает об утрате мастер-ключа и страховочных копий; для локального home ([ADR-079](./adr-079-local-home-independent-instances.md)) перечисляет остающиеся `config.yaml`/`profiles.json`/`credentials.json`.
6. **`synth update [--apply] [--to <version>] [--dry-run] [--yes] [--json]`** — проверка/обновление/**откат** пакета `@itphx/synth` (тело — `maintenance/update.ts`, паритет dev-CLI и публичного CLI, PROP-053): без `--apply` — только проверка; `--dry-run` — план без установки; `--to` валидируется (semver, наличие в реестре npm) и при версии ниже текущей помечается как откат («ОТКАТ» в приглашении). Аудит — `update.applied`/`rollback.applied`/`update.failed` (см. «Аудит» ниже).

7. **Перезапуск инстанса из UI — graceful shutdown с exit code 75.** «Перезапуск» не выполняется внутри процесса (нельзя надёжно переинициализировать глобальные singleton'ы: undici-dispatcher, пул PG, MCP-клиенты, шедулер) — процесс **завершается штатно** с кодом **75** (`EX_TEMPFAIL`), а поднимает его заново внешний супервизор. Контракт:
   - `POST /api/v2/maintenance/restart {confirm:true}` (ADMIN; core — `requireAuth`) → **202** `{status:'restarting', restartId, mode, startedAt}`; `confirm` не передан → 400; режим `disabled` → **409 `RESTART_UNSUPPORTED`**; повторный вызов до фактического выхода **идемпотентен** (тот же `restartId`, 202); аудит `restart.requested` (status `scheduled`, `details:{mode, restartId}`) пишется **до** инициации;
   - `GET /api/v2/maintenance/restart` → `{supported, mode, reason?, startedAt, version}`; `supported:false` — UI показывает «недоступно» без кнопки;
   - `startedAt` — ISO-метка старта процесса, **та же** в `GET /health` и `GET /api/v2/health` (аддитивное поле), поэтому UI после рестарта ждёт её изменения (опрос health до 90 с), а не «успешного ответа»;
   - режимы — `SYNTH_RESTART_MODE=disabled|process|supervisor` (default `disabled`; CLI `synth serve --restart-mode` **приоритетнее** env, неизвестное значение → `disabled` + warn — fail-safe). `process` — выход 75, перезапуск супервизором (K8s Deployment `restartPolicy: Always`, Docker `restart: unless-stopped`, systemd `Restart=on-failure`, pm2); `supervisor` — то же, но локальный `scripts/dev.sh` сам поднимает процесс (dev-режим);
   - **multi-replica:** endpoint перезапускает **только** pod, обработавший запрос; остальные реплики продолжают работать (соединения, попавшие на перезапускаемый pod, прерываются). Перезапуск всего Deployment — `kubectl rollout restart deployment/...` (или `helm rollback`);
   - UI — «Обслуживание → Перезапуск»: статус режима и предупреждение, подтверждение (активные стримы будут прерваны), оверлей «перезапускается», опрос health до нового `startedAt`, затем reload;
   - deploy-дефолты: Helm — `backend.restartMode: process` (+ env), Docker Compose — `restart: unless-stopped` + `SYNTH_RESTART_MODE=process`, `dev.sh` — `supervisor`; bare `synth serve` — `disabled` (нужен systemd `Restart=on-failure` или явный `--restart-mode process`).

**Обновление и откат:**

| Операция | Команда | Замечание |
|---|---|---|
| Проверить | `synth update` | показывает current/target и тип операции (`--json` — машиночитаемо) |
| Предпросмотр | `synth update --dry-run [--to <version>]` | печатает план, ничего не устанавливает |
| Обновить | `synth update --apply [--to <version>]` | без `--to` — последняя по `latest`; **реализовано** |
| Откат (standalone, npm) | `synth update --to <prev> --apply` | downgrade пакета; в приглашении — «ОТКАТ»; **реализовано** |
| Откат (K8s) | `helm rollback <release> <revision>` | + при необходимости restore данных из бэкапа ([ADR-091](./adr-091-backup-restore-transfer.md)) |
| Совместимость | — | понижение версии не мигрирует данные назад; откат данных = только restore из бэкапа |

**Аудит.** Операции обслуживания фиксируются best-effort в `{dataDir}/audit/maintenance.jsonl` (порт `MaintenanceAuditRepository`, ADR-096): `backup.created`/`restore.scheduled|applied`/`migrate.applied`/`update.applied`/`rollback.applied`/`restart.requested`/`uninstall.purge`, при неудаче — `*.failed`.

**Безопасность.** Перед обновлением — бэкап: после обновления миграция может изменить данные необратимо. Миграция/откат/purge/перезапуск — привилегированные операции: подтверждение (`--yes` / `confirm:true`), `--dry-run`, страховочная копия перед изменяющими шагами; секретов в логах нет (при purge — предупреждение об утрате мастер-ключа). Перезапуск прерывает активные стримы и in-flight запросы — UI предупреждает об этом до подтверждения; `restartId` и автор пишутся в аудит. Процедуры и оговорка про `helm` — [docs/MAINTENANCE.md](../MAINTENANCE.md).

## Альтернативы

- **Версия схемы — только константа пакета (без `meta.json`)** — отклонён: факт применения миграций всё равно нужно персистить; `meta.json` фиксирует и версию, и журнал.
- **Снапшот только затрагиваемых файлов** — отклонён: полный архив ([ADR-091](./adr-091-backup-restore-transfer.md)) проще и надёжнее, а объёмы ещё невелики.
- **Автоматический откат данных при понижении версии** — отклонён: необратимо и рискованно; откат данных — только restore из бэкапа.
- **Удалять данные при `uninstall` по умолчанию** — отклонён: деструктивно; данные сохраняются, `--purge` должен быть явным.
- **Перезапуск «внутри процесса» (пересоздать зависимости без выхода)** — отклонён: процесс-глобальные singleton'ы (undici-dispatcher/TLS, пул PG, MCP-клиенты, шедулер, EventHub) переинициализировать безопасно нельзя — получаются «наполовину старые» подсистемы и утечки сокетов; принят graceful shutdown с **exit 75** и перезапуск супервизором (п. 7).
- **Собственный supervisor-процесс в проде** — отклонён: дублирует K8s/Docker/systemd и усложняет логи/сигналы; `supervisor`-режим оставлен только для локального `scripts/dev.sh`.

## Последствия

- (+) Версионированная схема данных и идемпотентные миграции; несовместимость «данные новее пакета» ловится на старте, а не в рантайме.
- (+) Необратимые шаги защищены страховочной копией (fail-closed) и подтверждением; `uninstall` не удаляет данные без явного `--purge`.
- (+) Перезапуск из UI без доступа к кластеру/хосту: один и тот же контракт работает в K8s/Docker/systemd/dev; `startedAt` в health делает рестарт наблюдаемым, аудит `restart.requested` — атрибутируемым.
- (−) Перезапуск = короткий простой и обрыв активных стримов; в multi-replica он локальный (перезапускает только один pod) — для всего Deployment нужен rollout.
- (−) Авто-миграция меняет данные на старте (под копией и локом) — нужна дисциплина «бэкап перед обновлением».
- (−) Мульти-инстанс-сериализация — file-based (`FileMutex` на общем `dataDir`); для разных хостов нужен K8s Lease/PG advisory lock.

## Остаток

- публикация runbook на портале `docs.synth.itphx.ru` (dev-вариант — [docs/MAINTENANCE.md](../MAINTENANCE.md));
- внешний audit-sink и запись аудита обслуживания вне инстанса (`uninstall --purge` удаляет запись вместе с каталогом);
- K8s Lease / PG advisory lock для мульти-инстанса (после [PROP-032](./prop-032-history-storage-postgresql.md)).

## История

- 2026-10-16 — PROP-092 принят как ADR-092 (MVP реализован; остаток вынесен) (коммиты ветки feat/storage-seam).
- 2026-10-16 — миграции/бэкапы/doctor/restore выведены в admin-API (`/api/v2/maintenance`) и UI-раздел «Обслуживание» (ADMIN); применение миграций — под страховочной копией (fail-closed), восстановление — офлайн (ветка feat/storage-seam).
- 2026-10-16 — `synth update [--apply] [--to <version>] [--dry-run] [--yes] [--json]` реализован в core (`maintenance/update.ts`) и добавлен в публикуемый CLI (паритет PROP-053); аудит `update.applied`/`rollback.applied`/`update.failed` (ветка feat/storage-seam).
- 2026-10-18 — перезапуск инстанса из UI (`POST/GET /api/v2/maintenance/restart`, п. 7): graceful shutdown с exit **75**, режимы `SYNTH_RESTART_MODE=disabled|process|supervisor` (+ `synth serve --restart-mode`), идемпотентность, аудит `restart.requested`, `startedAt` в `/health`; дефолты деплоя — Helm `backend.restartMode: process`, Compose `restart: unless-stopped`, `dev.sh` — supervisor; UI-раздел «Обслуживание → Перезапуск» с опросом health.

# ADR-098: Деградированный режим и восстановление хранилища

> **Статус:** ⚠️ Частично — реализовано: матрица fail-closed/деградация, файловый `fallbackDir`, ADMIN-only + строгий read-only, `/health` → `degraded` + `GET /api/v2/storage/status`, встроенный скилл `synth-storage-recovery`, диагностика (`doctor`); остаток: авто-возврат к БД без рестарта, `/ready` и DB-aware probes ([ADR-094](./adr-094-observability-metrics.md))
> **Дата:** 2026-10-16
> **Связано:** [ADR-097](./adr-097-storage-provider-class.md), [ADR-096](./adr-096-storage-layer.md), [ADR-091](./adr-091-backup-restore-transfer.md), [ADR-092](./adr-092-instance-lifecycle-maintenance.md), [ADR-094](./adr-094-observability-metrics.md); процедуры — [docs/MAINTENANCE.md](../MAINTENANCE.md), конфиг — [docs/CONFIGURATION.md](../CONFIGURATION.md).

## Контекст

Второй backend хранения — PostgreSQL (драйвер — [ADR-097](./adr-097-storage-provider-class.md)) — вносит **внешнюю зависимость**: в отличие от файлового default'а, БД может быть недоступна на старте (сеть, креды, схема, перегрузка). Голый отказ старта лишает администратора даже диагностики, а **тихий** уход на пустое файловое хранилище маскирует проблему развёртывания («все данные исчезли» вместо внятной ошибки). Нужен явный, предсказуемый контракт поведения при недоступности backend'а.

## Решение

Ввести **деградированный режим** и жёсткую матрицу `fail-closed`/деградации для сборки контекста хранения ([ADR-096](./adr-096-storage-layer.md)).

1. **Политика при недоступности БД** — `storage.degradedMode` (env `SYNTH_DEGRADED_MODE` > config > `fallback-file`; резолвер `resolveDegradedMode`):
   - `fallback-file` (default) — сервис поднимается на **файловом фоллбеке** в `storage.fallbackDir` (env `SYNTH_STORAGE_FALLBACK_DIR` > config > `{dataDir}/fallback`; **отдельный** от `dataDir` каталог — чтобы не смешивать с реальными данными);
   - `halt` — старт останавливается с внятной ошибкой (`StorageUnavailableError`/`STORAGE_UNAVAILABLE`).
2. **Строгий read-only + ADMIN-only.** В деградации: мутирующие методы (`POST/PUT/PATCH/DELETE`) → `503 STORAGE_DEGRADED_READONLY`, не-администраторы → `503 STORAGE_DEGRADED`; разрешены чтение, диагностика и ремонтные операции. Единый guard — `createStorageDegradedGuard` (`@itphx/synth-core/server/storage-degraded.js`), переиспользуется standalone-core и managed-backend (без дублей).
3. **Диагностика.** `/health` (и `/api/v2/health`) отдаёт `status: 'degraded'` + блок `storage.{backend,fallbackDir,reason,since}` (аддитивно к `{status,version,time}`); `GET /api/v2/storage/status` пробит исходный backend и сообщает `recovery.{connection,restartRequired:true,autoRecovery:false}`; `synth doctor` показывает `db-connection`/`db-schema` (файловые проверки — `неприменимо`).
4. **Авто-возврата нет.** `StorageContext` замкнут в deps (живая подмена backend'а рискованна — split-brain/гонки): возврат — после устранения причины и **рестарта** сервиса.
5. **Скилл `synth-storage-recovery`** — встроенный (`builtin.ts`) read-only рунбук (`/storage-recovery`): диагностика, классификация причины (сеть/креды/схема/ёмкость), лечение, что доступно в деградации, возврат в норму.
6. **Данные фоллбека не переносятся** в БД: он диагностический (созданные в нём записи остаются в отдельном каталоге).

### Матрица ошибок (`fail-closed` vs деградация)

Политика деградации применяется **только к отказу БД**. Ошибки конфигурации/зависимостей и «схема новее» — **fail-closed** (фоллбек запрещён независимо от `degradedMode`): иначе опечатка в конфиге выглядела бы как пустое хранилище.

| Тип ошибки (класс / код) | Поведение | Обоснование |
|---|---|---|
| `PostgresStorageConfigError` (`STORAGE_POSTGRES_CONFIG_INVALID`) | fail-closed | неверный конфиг/креды/схема — опечатка, а не отказ БД |
| `PostgresStorageDependencyError` (`…DEPENDENCY_MISSING`) | fail-closed | нет модуля `pg` — проблема развёртывания, не отказ БД |
| `StorageBackendUnavailableError` (`STORAGE_BACKEND_UNAVAILABLE`) | fail-closed | не загрузился пакет-драйвер — то же |
| `PostgresStorageSchemaError` (`…SCHEMA_TOO_NEW`) | fail-closed | БД новее драйвера (откат версии) — нельзя молча стартовать на пустом фоллбеке |
| `PostgresConnectionError` (сеть/класс `08`/`57P0x`) | деградация (`fallback-file`) | БД недоступна по сети — штатный сценарий фоллбека |
| auth-ошибка сервера (`28P01`/`28000`/`42501` → `QueryError`) | деградация | сервер ответил «доступ запрещён» — отказ БД, не конфиг |
| `PostgresStorageSchemaError` (`…SCHEMA_OUTDATED`) | деградация | схема отстаёт — данные в БД есть, лечится `synth migrate` |
| прочие runtime-ошибки (`QueryError`/`LockTimeoutError`) | деградация | сбой выполнения в БД; доступ к read-only диагностике нужнее простоя |

При `degradedMode='halt'` любой из «деградационных» классов даёт `StorageUnavailableError` вместо фоллбека.

## Альтернативы

- **Всегда отказывать в старте при недоступной БД** — отклонён: администратор теряет диагностику, а транзиентный сетевой сбой роняет сервис.
- **Тихо подниматься на файловом хранилище в `dataDir`** — отклонён: маскирует сбой и создаёт split-brain (записи уходят в файлы рядом с реальными данными).
- **Живой авто-возврат к БД при восстановлении соединения** — отклонён осознанно: подмена backend'а в замкнутом `StorageContext` гонкоопасна; возврат — рестарт.
- **Фоллбек на ошибки конфигурации/зависимостей** — отклонён: маскировал бы проблему развёртывания пустым хранилищем.

## Последствия

- (+) Понятный контракт: диагностируемый read-only вместо падения или молчаливой потери данных; матрица проверяема тестами.
- (+) Единый guard и диагностический эндпоинт для standalone и managed.
- (−) Деградация — «полурабочий» режим (только чтение, только администраторы) → нужна дисциплина «устрани причину и перезапусти».
- (−) Авто-восстановление отсутствует; `/ready`-проба и автоматические алерты — отдельный шаг ([ADR-094](./adr-094-observability-metrics.md)).

## Статус в коде

- **Политика/фоллбек:** `createStorageContextWithDegradation`/`createPostgresStorageWithFallback` (`packages/core/src/storage/storage-context.ts:693`), матрица `FAIL_CLOSED_STORAGE_CODES`/`FAIL_CLOSED_STORAGE_NAMES` (`storage-context.ts:627`/`:635`), `probePostgresBackend` (`storage-context.ts:764`).
- **Состояние для оси доступности тулов:** `packages/core/src/engine/permission/storage-state.ts` (`setStorageDegradedState`/`isStorageDegraded`), публикуется из `createStorageContextAsync` (`storage-context.ts:792`).
- **HTTP-слой:** `packages/core/src/server/storage-degraded.ts` (`createStorageDegradedGuard`, `createStorageStatusRoutes`, `storageHealthFields`); `packages/core/src/server/routes/health.ts`; монтирование — `packages/backend/src/app.ts:236`.
- **Конфиг:** `storage.degradedMode`/`storage.fallbackDir` + резолверы `resolveDegradedMode`/`resolveStorageFallbackDir` (`packages/shared/src/config/resolve.ts`).
- **Скилл:** `SYNTH_STORAGE_RECOVERY_NAME`/`buildSynthStorageRecoveryMeta` (`packages/core/src/engine/skills/builtin.ts:32`/`:226`).
- **Тесты:** `storage/storage-context.degraded.test.ts`, `engine/permission/storage-degraded.test.ts`, `server/storage-degraded.test.ts`.

## История

- 2026-10-16 — ADR заведён: деградированный режим при отказе PostgreSQL, матрица fail-closed/деградации, read-only ADMIN-only, диагностика и скилл восстановления (волна 5 БД-backend'а).

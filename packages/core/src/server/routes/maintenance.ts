// ADR-091/ADR-092: admin-API обслуживания инстанса (backup/restore/doctor/migrate).
//
// Единая фабрика для core (standalone) и backend (managed): RBAC задаётся
// `opts.readGuard`/`opts.writeGuard` (core-дефолт — `requireAuth`), локализация —
// `opts.messages`. Слой — тонкий: вся работа живёт в сервисном слое
// (`maintenance/service.ts`, `maintenance/doctor.ts`, `maintenance/startup.ts`).
//
// Ключевая семантика: **восстановление — офлайн-операция**. `POST /restore` не
// выполняет восстановление сразу, а лишь планирует его
// (`{dataDir}/maintenance/restore-request.json`); применение — при следующем
// старте инстанса (`applyPendingRestore`). Под живым процессом каталог данных не
// вычищается.
//
// Безопасность: никаких абсолютных путей от клиента — имя архива это только
// basename `*.tar.gz` (`isSafeBackupName`); архивы ищутся строго в
// `{dataDir}/backups/` и `{dataDir}/backups/uploads/`. Секреты и содержимое
// архивов не логируются; ошибки — в едином формате `{ error: { code, message } }`.
import { createReadStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { basename, join, resolve } from 'node:path';
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { createMiddleware } from 'hono/factory';
import { DEFAULT_MAX_UPLOAD_BYTES } from '@itphx/synth-shared';
import type { MaintenanceAuditEntry, MaintenanceAuditOp } from '@itphx/synth-shared';
import type { MaintenanceAuditRepository } from '../../storage/ports/index.js';
import type {
  StorageBackendKind,
  StorageHealth,
  StorageSchemaMigrationResult,
} from '../../storage/storage-context.js';
import { checkInstanceCompatibility, InstanceDataTooNewError } from '../../storage/instance-meta.js';
import { createStorageContextAsync } from '../../storage/storage-context.js';
import { SessionManager } from '../../sessions/manager.js';
import { createBackup } from '../../maintenance/backup.js';
import { recordMaintenanceAudit } from '../../maintenance/audit.js';
import { runDoctor } from '../../maintenance/doctor.js';
import { getRestartStatus, requestRestart } from '../restart.js';
import { applyStartupMigrations } from '../../maintenance/startup.js';
import {
  cancelPendingRestore,
  deleteBackup,
  ENCRYPTED_ARCHIVE_SUFFIX,
  ENCRYPTED_RESTORE_PROBLEM,
  getMaintenanceStatus,
  getPendingRestore,
  isSafeBackupName,
  listBackups,
  scheduleRestore,
  stageUploadedArchive,
  validateRestoreArchive,
  type MaintenanceBackupInfo,
} from '../../maintenance/service.js';

/** Тип middleware, совпадающий с core/backend AuthKit (оба на `createMiddleware`). */
type Middleware = ReturnType<typeof createMiddleware>;

/** Минимальный auth-контракт фабрики (структурно совместим с core/backend AuthKit). */
export interface MaintenanceRoutesAuth {
  requireAuth: Middleware;
}

/**
 * ADR-091/ADR-092: зависимости admin-API обслуживания. Только каталог данных и
 * (опционально) материалы для `doctor`/шифрования секретов; никаких стораджей —
 * миграции собирают слой хранения сами, как CLI (`runMigrateCommand`).
 */
export interface MaintenanceRoutesDeps {
  /** Каталог данных инстанса (`$SYNTH_DATA_DIR`). */
  dataDir: string;
  /** ADR-076: мастер-ключ секретов at-rest (env > config > файл) — для `doctor`. */
  secretKey?: string;
  /** Окружение процесса — источник `SYNTH_SECRET_KEY` для `doctor`. */
  env?: NodeJS.ProcessEnv;
  /**
   * Переопределение версии в ответе `GET /status` (диагностика/тесты);
   * по умолчанию — `SYNTH_VERSION`.
   */
  version?: string;
  /**
   * ADR-092: аудит-журнал обслуживания — доменный порт слоя хранения
   * (`StorageContext.maintenanceAudit`, ADR-096). Не передан — `GET /audit`
   * отдаёт пустой список, `DELETE /audit` — `{ cleared: 0 }` (не 500).
   */
  audit?: MaintenanceAuditRepository;
  /**
   * ADR-096: физический backend хранения (`storage.backend`; по умолчанию
   * `file`). При `postgres` `doctor`/`migrations`/`backups` работают с БД.
   */
  storageBackend?: StorageBackendKind;
  /** ADR-097: read-only проба БД (`postgres`) — соединение + версия схемы. */
  dbHealth?: () => Promise<StorageHealth>;
  /**
   * ADR-097: миграции схемы БД (`postgres`) — план/применение. Не задано —
   * используется файловый контур `meta.json` (ADR-092).
   */
  schemaMigrations?: (opts?: { dryRun?: boolean }) => Promise<StorageSchemaMigrationResult>;
}

/** Локализуемые сообщения: backend передаёт t(), core — русские литералы. */
export interface MaintenanceRouteMessages {
  invalidBody: (c: Context) => string;
  confirmRequired: (c: Context) => string;
  backupNotFound: (c: Context) => string;
  invalidBackupName: (c: Context) => string;
  payloadTooLarge: (c: Context) => string;
  invalidArchive: (c: Context) => string;
  schemaTooNew: (c: Context) => string;
  invalidAuditLimit: (c: Context) => string;
  invalidAuditOp: (c: Context) => string;
  /** ADR-091: восстановление зашифрованного `.enc` через API недоступно. */
  encryptedRestore: (c: Context) => string;
  /** Restart: режим `disabled` — рестарт с этого инстанса недоступен. */
  restartUnsupported: (c: Context) => string;
}

export interface MaintenanceRoutesOptions {
  messages?: Partial<MaintenanceRouteMessages>;
  /** Guard на мутации (POST/DELETE); по умолчанию — `requireAuth` (core). */
  writeGuard?: Middleware;
  /** Guard на чтение (GET); по умолчанию — `requireAuth` (core). */
  readGuard?: Middleware;
  /** Лимит загрузки архива (`POST /restore/validate`), байты. Дефолт — `DEFAULT_MAX_UPLOAD_BYTES`. */
  maxUploadBytes?: number;
  /** userId инициатора (аудит/`requestedBy`). Core — 'local'; backend — id из `attachUser`. */
  resolveUserId?: (c: Context) => string;
}

const DEFAULT_MESSAGES: MaintenanceRouteMessages = {
  invalidBody: () => 'Некорректное тело запроса обслуживания',
  confirmRequired: () => 'Требуется подтверждение (confirm: true)',
  backupNotFound: () => 'Архив не найден',
  invalidBackupName: () => 'Некорректное имя архива',
  payloadTooLarge: () => 'Архив превышает допустимый размер',
  invalidArchive: () => 'Архив не прошёл проверку',
  schemaTooNew: () => 'Данные новее версии Synth; обновите Synth',
  invalidAuditLimit: () => 'Некорректное значение limit (целое 1..500)',
  invalidAuditOp: () => 'Неизвестная операция журнала обслуживания',
  encryptedRestore: () => ENCRYPTED_RESTORE_PROBLEM,
  restartUnsupported: () =>
    'Рестарт недоступен: инстанс запущен без супервизора (SYNTH_RESTART_MODE=disabled)',
};

/** Дефолтный и максимальный размер страницы аудит-журнала (`GET /audit`). */
const DEFAULT_AUDIT_LIMIT = 50;
const MAX_AUDIT_LIMIT = 500;

/**
 * ADR-092: известные виды операций аудит-журнала (валидация query `op`).
 * `satisfies` держит список синхронным с типом `MaintenanceAuditOp`.
 */
const MAINTENANCE_AUDIT_OPS = [
  'backup.created',
  'backup.failed',
  'backup.deleted',
  'restore.scheduled',
  'restore.cancelled',
  'restore.applied',
  'restore.failed',
  'migrate.applied',
  'migrate.failed',
  'update.applied',
  'rollback.applied',
  'update.failed',
  'uninstall.purge',
  'export.created',
  'import.applied',
  'restart.requested',
] as const satisfies readonly MaintenanceAuditOp[];

/** Каталог архивов инстанса (`{dataDir}/backups/`). */
function _backupsDir(dataDir: string): string {
  return join(resolve(dataDir), 'backups');
}

/** Каталог загруженных из UI архивов (`{dataDir}/backups/uploads/`). */
function _uploadsDir(dataDir: string): string {
  return join(_backupsDir(dataDir), 'uploads');
}

/**
 * Ищет файл архива по basename строго внутри `{dataDir}/backups/` и
 * `{dataDir}/backups/uploads/`. Имя уже проверено `isSafeBackupName`, поэтому
 * `join` не может выйти за пределы каталогов.
 */
async function _findBackupPath(dataDir: string, name: string): Promise<string | null> {
  for (const dir of [_backupsDir(dataDir), _uploadsDir(dataDir)]) {
    const target = join(dir, name);
    try {
      const info = await stat(target);
      if (info.isFile()) return target;
    } catch {
      // Нет файла — проверяем следующий каталог.
    }
  }
  return null;
}

/** Публичная сводка по созданному архиву (без содержимого). */
function _toBackupInfo(
  path: string,
  manifest: {
    createdAt: string;
    schemaVersion: number;
    instanceVersion: string;
    withSecrets: boolean;
    withWorkspace: boolean;
    storageBackend?: string;
    entries: unknown[];
  },
  bytes: number,
): MaintenanceBackupInfo {
  return {
    name: basename(path),
    path: resolve(path),
    bytes,
    createdAt: manifest.createdAt,
    schemaVersion: manifest.schemaVersion,
    instanceVersion: manifest.instanceVersion,
    withSecrets: manifest.withSecrets === true,
    withWorkspace: manifest.withWorkspace === true,
    ...(manifest.storageBackend ? { storageBackend: manifest.storageBackend } : {}),
    entries: Array.isArray(manifest.entries) ? manifest.entries.length : 0,
  };
}

/**
 * Admin-API обслуживания инстанса (ADR-091/ADR-092).
 *
 * | Метод/путь | Назначение | Guard |
 * |---|---|---|
 * | `GET /status` | сводный статус (схема/бэкапы/`pending`/doctor) | read |
 * | `GET /doctor` | полный `synth doctor` | read |
 * | `GET /migrations` | `{current, expected, applied, pending}` | read |
 * | `POST /migrations/apply` | применить миграции (`{confirm:true}`) | write |
 * | `GET /backups` | список архивов | read |
 * | `POST /backups` | создать архив (`{withSecrets?, withWorkspace?, live?}`) | write |
 * | `GET /backups/:name/download` | скачать архив | read |
 * | `DELETE /backups/:name` | удалить архив | write |
 * | `POST /restore/validate` | проверить архив (multipart `file` или `{archive}`) | write |
 * | `GET /restore` | отложенный запрос на восстановление | read |
 * | `POST /restore` | спланировать восстановление (`{archive, confirm:true}`) | write |
 * | `DELETE /restore` | отменить отложенный запрос | write |
 * | `GET /restart` | статус graceful restart (`supported`/`mode`/`reason`/`startedAt`) | read |
 * | `POST /restart` | graceful restart (`{confirm:true}`) → 202; `disabled` → 409 | write |
 * | `GET /audit` | журнал обслуживания (`limit`, `op`) | read |
 * | `DELETE /audit` | очистить журнал (`{confirm:true}`) | write |
 *
 * `POST /restore` **не выполняет** восстановление: оно применится при следующем
 * запуске инстанса. `POST /migrations/apply` на данных новее `SCHEMA_VERSION`
 * отдаёт `409 CONFLICT` с кодом `SCHEMA_TOO_NEW`. Аудит-журнал (ADR-092) —
 * append-only, «свежие первыми»; при отсутствии порта `audit` роуты отдают
 * пустой результат, а не 500.
 */
export function createMaintenanceRoutes(
  auth: MaintenanceRoutesAuth,
  deps: MaintenanceRoutesDeps,
  opts: MaintenanceRoutesOptions = {},
): Hono {
  const app = new Hono();
  const messages: MaintenanceRouteMessages = { ...DEFAULT_MESSAGES, ...opts.messages };
  const readGuard: Middleware = opts.readGuard ?? auth.requireAuth;
  const writeGuard: Middleware = opts.writeGuard ?? auth.requireAuth;
  const maxUploadBytes = opts.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
  const dataDir = resolve(deps.dataDir);

  const invalidBody = (c: Context) =>
    c.json({ error: { code: 'VALIDATION_ERROR', message: messages.invalidBody(c) } }, 400);
  const confirmRequired = (c: Context) =>
    c.json({ error: { code: 'VALIDATION_ERROR', message: messages.confirmRequired(c) } }, 400);
  const invalidName = (c: Context) =>
    c.json({ error: { code: 'VALIDATION_ERROR', message: messages.invalidBackupName(c) } }, 400);
  const notFound = (c: Context) =>
    c.json({ error: { code: 'NOT_FOUND', message: messages.backupNotFound(c) } }, 404);
  const invalidArchive = (c: Context) =>
    c.json({ error: { code: 'VALIDATION_ERROR', message: messages.invalidArchive(c) } }, 400);
  const payloadTooLarge = (c: Context) =>
    c.json({ error: { code: 'PAYLOAD_TOO_LARGE', message: messages.payloadTooLarge(c) } }, 413);
  const invalidAuditLimit = (c: Context) =>
    c.json({ error: { code: 'VALIDATION_ERROR', message: messages.invalidAuditLimit(c) } }, 400);
  const invalidAuditOp = (c: Context) =>
    c.json({ error: { code: 'VALIDATION_ERROR', message: messages.invalidAuditOp(c) } }, 400);

  /** userId инициатора, если резолвится (для `requestedBy`); иначе `undefined`. */
  const userId = (c: Context): string | undefined => {
    if (opts.resolveUserId) return opts.resolveUserId(c);
    const user = c.get('user' as never) as { id?: unknown } | undefined;
    return typeof user?.id === 'string' && user.id ? user.id : undefined;
  };

  // GET /api/v2/maintenance/status — сводный статус инстанса.
  app.get('/status', readGuard, async (c) => {
    const status = await getMaintenanceStatus({
      dataDir,
      secretKey: deps.secretKey,
      env: deps.env,
      storageBackend: deps.storageBackend,
      dbHealth: deps.dbHealth,
    });
    return c.json(deps.version ? { ...status, version: deps.version } : status);
  });

  // GET /api/v2/maintenance/doctor — полный прогон проверок.
  app.get('/doctor', readGuard, async (c) => {
    const result = await runDoctor({
      dataDir,
      secretKey: deps.secretKey,
      env: deps.env,
      storageBackend: deps.storageBackend,
      dbHealth: deps.dbHealth,
    });
    return c.json(result);
  });

  // GET /api/v2/maintenance/migrations — состояние схемы данных (ADR-092).
  // ADR-097: при backend=postgres — состояние SQL-схемы БД (read-only план).
  app.get('/migrations', readGuard, async (c) => {
    if (deps.storageBackend === 'postgres' && deps.schemaMigrations) {
      const plan = await deps.schemaMigrations({ dryRun: true });
      return c.json({
        backend: 'postgres',
        current: plan.current ?? 0,
        expected: plan.expected,
        applied: [] as string[],
        pending: plan.pending.map((version) => ({
          id: `postgres:${version}`,
          toVersion: version,
          description: 'SQL-миграция схемы БД (postgres)',
        })),
      });
    }
    const compatibility = await checkInstanceCompatibility(dataDir);
    return c.json({
      backend: deps.storageBackend ?? 'file',
      current: compatibility.currentVersion,
      expected: compatibility.expectedVersion,
      applied: compatibility.meta?.migrations ?? [],
      pending: compatibility.pending.map((migration) => ({
        id: migration.id,
        toVersion: migration.toVersion,
        description: migration.description,
      })),
    });
  });

  // POST /api/v2/maintenance/migrations/apply — применение pending-миграций.
  // Тело `{ confirm: true }` обязательно (необратимая операция). Перед записью
  // создаётся обязательная страховочная копия (ADR-092, fail-closed), миграции
  // идут под межпроцессным локом — переиспользуется `applyStartupMigrations`.
  app.post('/migrations/apply', writeGuard, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if ((body as { confirm?: unknown }).confirm !== true) return confirmRequired(c);

    // ADR-097: backend=postgres — мигрируется SQL-схема БД (контур драйвера).
    if (deps.storageBackend === 'postgres' && deps.schemaMigrations) {
      try {
        const result = await deps.schemaMigrations({ dryRun: false });
        return c.json({
          backend: 'postgres',
          applied: result.applied,
          version: result.current ?? result.expected,
        });
      } catch (err) {
        if ((err as { code?: unknown })?.code === 'STORAGE_POSTGRES_SCHEMA_TOO_NEW') {
          return c.json({ error: { code: 'SCHEMA_TOO_NEW', message: messages.schemaTooNew(c) } }, 409);
        }
        throw err;
      }
    }

    const storage = await createStorageContextAsync('file', {
      dataDir,
      secretKey: deps.secretKey,
      env: deps.env,
    });
    try {
      const result = await applyStartupMigrations({
        dataDir,
        settingsStore: storage.settings,
        sessionManager: new SessionManager(storage.sessions),
        projectStore: storage.projects,
        audit: deps.audit,
        actor: userId(c),
      });
      return c.json(result);
    } catch (err) {
      if (err instanceof InstanceDataTooNewError) {
        return c.json({ error: { code: 'SCHEMA_TOO_NEW', message: messages.schemaTooNew(c) } }, 409);
      }
      throw err;
    }
  });

  // GET /api/v2/maintenance/backups — список архивов инстанса.
  app.get('/backups', readGuard, async (c) => {
    const backups = await listBackups(dataDir);
    return c.json({ backups });
  });

  // POST /api/v2/maintenance/backups — снять архив каталога данных.
  app.post('/backups', writeGuard, async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      withSecrets?: unknown;
      withWorkspace?: unknown;
      live?: unknown;
    };
    const dir = _backupsDir(dataDir);
    await mkdir(dir, { recursive: true });
    // `out` — каталог: `createBackup` положит туда файл с дефолтным именем.
    // Архив в `{dataDir}/backups/` (каталог исключён из самих бэкапов — ADR-092).
    const result = await createBackup({
      dataDir,
      out: dir,
      withSecrets: body.withSecrets === true,
      withWorkspace: body.withWorkspace === true,
      live: body.live === true,
      ...(deps.storageBackend ? { storageBackend: deps.storageBackend } : {}),
      audit: deps.audit,
      actor: userId(c),
    });
    return c.json(_toBackupInfo(result.path, result.manifest, result.bytes), 200);
  });

  // GET /api/v2/maintenance/backups/:name/download — стриминг архива.
  app.get('/backups/:name/download', readGuard, async (c) => {
    const name = c.req.param('name');
    if (!isSafeBackupName(name)) return invalidName(c);
    const target = await _findBackupPath(dataDir, name);
    if (!target) return notFound(c);

    const info = await stat(target);
    const fileStream = createReadStream(target);
    const webStream = Readable.toWeb(fileStream) as ReadableStream;
    return new Response(webStream, {
      status: 200,
      headers: {
        'Content-Type': 'application/gzip',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(basename(target))}"`,
        'Content-Length': String(info.size),
      },
    });
  });

  // DELETE /api/v2/maintenance/backups/:name — удаление архива.
  app.delete('/backups/:name', writeGuard, async (c) => {
    const name = c.req.param('name');
    if (!isSafeBackupName(name)) return invalidName(c);
    const removed = await deleteBackup(dataDir, name, { audit: deps.audit, actor: userId(c) });
    if (!removed) return notFound(c);
    return c.body(null, 204);
  });

  // POST /api/v2/maintenance/restore/validate — проверка архива.
  // Принимает multipart `file` (загрузка) ИЛИ JSON `{ archive: name }`.
  app.post('/restore/validate', writeGuard, async (c) => {
    const contentType = c.req.header('content-type') ?? '';

    if (contentType.includes('multipart/form-data')) {
      // DoS-защита (паритет с `fs.ts`): заявленный `content-length` → размер
      // `File` → фактический размер прочитанных байт (chunked/лживый заголовок).
      const declaredLength = Number.parseInt(c.req.header('content-length') ?? '', 10);
      if (Number.isFinite(declaredLength) && declaredLength > maxUploadBytes) {
        return payloadTooLarge(c);
      }

      const formData = await c.req.formData();
      const rawField = formData.get('file');
      const uploadField = Array.isArray(rawField) ? rawField[0] : rawField;
      if (!uploadField || typeof uploadField === 'string') {
        return invalidBody(c);
      }
      const declaredFileSize = (uploadField as { size?: unknown }).size;
      if (typeof declaredFileSize === 'number' && declaredFileSize > maxUploadBytes) {
        return payloadTooLarge(c);
      }

      let data: ArrayBuffer;
      if (typeof (uploadField as { arrayBuffer?: unknown }).arrayBuffer === 'function') {
        data = await (uploadField as File).arrayBuffer();
      } else {
        return invalidBody(c);
      }
      if (data.byteLength > maxUploadBytes) return payloadTooLarge(c);

      const fileName = (uploadField as { name?: string }).name || 'upload.tar.gz';
      const staged = await stageUploadedArchive(dataDir, fileName, Buffer.from(data));
      const validation = await validateRestoreArchive({ dataDir, archive: staged });
      return c.json({ ...validation, staged: basename(staged) });
    }

    const body = (await c.req.json().catch(() => ({}))) as { archive?: unknown };
    const name = typeof body.archive === 'string' ? body.archive : '';
    if (!name || !isSafeBackupName(name)) return invalidName(c);
    const target = await _findBackupPath(dataDir, name);
    if (!target) return notFound(c);
    const validation = await validateRestoreArchive({ dataDir, archive: target });
    return c.json(validation);
  });

  // GET /api/v2/maintenance/restore — отложенный запрос на восстановление.
  app.get('/restore', readGuard, async (c) => {
    const pending = await getPendingRestore(dataDir);
    return c.json({ pending });
  });

  // POST /api/v2/maintenance/restore — спланировать восстановление.
  // НЕ выполняет восстановление: оно применится при следующем запуске
  // (`applyPendingRestore`). Под живым процессом данные не вычищаются.
  app.post('/restore', writeGuard, async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      archive?: unknown;
      confirm?: unknown;
      safetyCopy?: unknown;
    };
    if (body.confirm !== true) return confirmRequired(c);

    const name = typeof body.archive === 'string' ? body.archive : '';
    if (!name || !isSafeBackupName(name)) return invalidName(c);
    const target = await _findBackupPath(dataDir, name);
    if (!target) return notFound(c);
    // ADR-091: зашифрованный архив восстанавливается только через CLI (ключ
    // серверу недоступен) — 400 с понятной причиной, не 500.
    if (target.endsWith(ENCRYPTED_ARCHIVE_SUFFIX)) {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: messages.encryptedRestore(c) } },
        400,
      );
    }

    try {
      const pending = await scheduleRestore({
        dataDir,
        archive: target,
        requestedBy: userId(c),
        safetyCopy: body.safetyCopy !== false,
        audit: deps.audit,
      });
      return c.json({ pending, appliesOnNextStart: true }, 201);
    } catch {
      // Архив не прошёл проверку (`scheduleRestore` валидирует перед записью).
      return invalidArchive(c);
    }
  });

  // DELETE /api/v2/maintenance/restore — отмена отложенного запроса.
  app.delete('/restore', writeGuard, async (c) => {
    const cancelled = await cancelPendingRestore(dataDir, deps.audit);
    return c.json({ cancelled });
  });

  // GET /api/v2/maintenance/restart — статус graceful restart.
  // `supported:false` (режим `disabled`) — UI показывает «недоступно» без кнопки.
  app.get('/restart', readGuard, (c) => c.json(getRestartStatus()));

  // POST /api/v2/maintenance/restart — graceful restart инстанса.
  // Тело `{confirm:true}` обязательно (активные стримы будут прерваны). Процесс
  // завершается с кодом 75 (`EX_TEMPFAIL`), перезапуск — супервизором
  // (K8s/Docker/systemd) или `dev.sh` (режим `supervisor`). Аудит
  // `restart.requested` (status `scheduled`) пишется до инициации; повторный
  // вызов идемпотентен — тот же `restartId` и 202.
  app.post('/restart', writeGuard, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if ((body as { confirm?: unknown }).confirm !== true) return confirmRequired(c);

    const status = getRestartStatus();
    if (!status.supported) {
      return c.json(
        {
          error: {
            code: 'RESTART_UNSUPPORTED',
            message: messages.restartUnsupported(c),
          },
        },
        409,
      );
    }

    const outcome = await requestRestart({
      beforeRequest: (restartId, mode) =>
        recordMaintenanceAudit(deps.audit, {
          op: 'restart.requested',
          status: 'scheduled',
          ...(userId(c) !== undefined ? { actor: userId(c) } : {}),
          details: { mode, restartId },
        }),
    });

    if (!outcome.accepted) {
      return c.json(
        {
          error: {
            code: 'RESTART_UNSUPPORTED',
            message: messages.restartUnsupported(c),
          },
        },
        409,
      );
    }

    return c.json(
      {
        status: 'restarting',
        restartId: outcome.restartId,
        mode: outcome.mode,
        startedAt: status.startedAt,
      },
      202,
    );
  });

  // GET /api/v2/maintenance/audit — журнал обслуживания инстанса (ADR-092).
  // «Свежие первыми»; query `limit` (целое 1..500, дефолт 50) и `op` (вид
  // операции). Порт не передан — пустой список (не 500).
  app.get('/audit', readGuard, async (c) => {
    const rawLimit = c.req.query('limit');
    let limit = DEFAULT_AUDIT_LIMIT;
    if (rawLimit !== undefined && rawLimit !== '') {
      const parsed = Number(rawLimit);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_AUDIT_LIMIT) {
        return invalidAuditLimit(c);
      }
      limit = parsed;
    }

    const rawOp = c.req.query('op');
    if (rawOp !== undefined && rawOp !== '' && !(MAINTENANCE_AUDIT_OPS as readonly string[]).includes(rawOp)) {
      return invalidAuditOp(c);
    }

    if (!deps.audit) return c.json({ entries: [] as MaintenanceAuditEntry[] });
    const entries = await deps.audit.list(rawOp ? { limit, op: rawOp as MaintenanceAuditOp } : { limit });
    return c.json({ entries });
  });

  // DELETE /api/v2/maintenance/audit — полная очистка журнала (`{confirm:true}`).
  app.delete('/audit', writeGuard, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if ((body as { confirm?: unknown }).confirm !== true) return confirmRequired(c);
    if (!deps.audit) return c.json({ cleared: 0 });
    const cleared = await deps.audit.clear();
    return c.json({ cleared });
  });

  return app;
}

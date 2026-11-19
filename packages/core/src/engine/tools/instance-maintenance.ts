/**
 * Обслуживание инстанса из чата: `synth_maintenance_*`, `synth_backup_*`,
 * `synth_restore_*`, `synth_restart_request`.
 *
 * ## Зачем
 *
 * Обслуживание инстанса (статус/`doctor`/бэкапы/восстановление/рестарт/журнал)
 * было доступно только через HTTP (`createMaintenanceRoutes`), admin-UI и CLI
 * `synth backup|restore|doctor`. Агент-хранитель инстанса (`keeper`) не мог ни
 * посмотреть состояние, ни снять архив, ни запланировать восстановление — он
 * объяснял человеку, куда идти и что нажимать.
 *
 * ## Границы (паритет с HTTP-роутами `createMaintenanceRoutes`)
 *
 * - источник данных тот же: сервисный слой `maintenance/*` (`getMaintenanceStatus`,
 *   `listBackups`, `createBackup`, `scheduleRestore`, `cancelPendingRestore`,
 *   `runDoctor`) и `server/restart.ts` (`getRestartStatus`/`requestRestart`);
 *   логика роутов не дублируется, а переиспользуется по семантике;
 * - восстановление — **офлайн-операция**: `synth_restore_request` ничего не
 *   восстанавливает, а пишет запрос (`{dataDir}/maintenance/restore-request.json`),
 *   который применяется при следующем старте инстанса. Под живым процессом
 *   каталог данных не вычищается;
 * - архивы ищутся строго в `{dataDir}/backups/` и `{dataDir}/backups/uploads/`,
 *   имя — только basename (`isSafeBackupName`); абсолютные пути от модели не
 *   принимаются. Содержимое архивов не читается, секреты не печатаются:
 *   `withSecrets` в отчётах — только флаг;
 * - права: чтения (`synth_maintenance_status|doctor`,
 *   `synth_backup_list`, `synth_maintenance_audit`) — любому агенту с
 *   capability `instance`; записи (`synth_backup_create`,
 *   `synth_restore_request|cancel`, `synth_restart_request`) — **только ADMIN**
 *   (`isInstanceAdmin`: роль `ADMIN` либо локальный владелец standalone —
 *   паритет с локальным API-ключом);
 * - в plan-режиме доступны только чтения: write-имена заблокированы
 *   permission-слоем (`INSTANCE_WRITE_TOOLS` → `isPlanBlockedTool`), а не
 *   проверкой внутри execute (ADR-025/ADR-029);
 * - ошибки — `ToolResult` с понятным кодом (`maintenance.confirm_required`,
 *   `maintenance.invalid_archive`, `maintenance.not_found`,
 *   `maintenance.backup.failed`, `maintenance.restore.failed`,
 *   `maintenance.restart_unsupported`), не исключение;
 * - тексты — через ключи `shared/i18n` (ADR-041): `content` — en-текст для
 *   модели, `metadata.i18n` — шаблон и параметры для UI.
 */
import { basename, join, resolve } from 'node:path';
import { z } from 'zod';
import { SYNTH_VERSION, ToolCapability } from '@itphx/synth-shared';
import type {
  MaintenanceAuditOp,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '@itphx/synth-shared';
import type { MaintenanceAuditRepository } from '../../storage/ports/maintenance-audit-repository.js';
import type {
  StorageBackendKind,
  StorageHealth,
  StorageSchemaMigrationResult,
} from '../../storage/storage-context.js';
import { createBackup, formatBackupStamp } from '../../maintenance/backup.js';
import { resolveBackupKey } from '../../maintenance/backup-crypto.js';
import { recordMaintenanceAudit } from '../../maintenance/audit.js';
import { runDoctor } from '../../maintenance/doctor.js';
import {
  cancelPendingRestore,
  getMaintenanceStatus,
  isSafeBackupName,
  listBackups,
  sanitizeBackupName,
  scheduleRestore,
  validateRestoreArchive,
  type MaintenanceBackupInfo,
  type MaintenanceStatus,
} from '../../maintenance/service.js';
import { getRestartStatus, requestRestart } from '../../server/restart.js';
import { isAborted, abortedResult } from './abort.js';
import { t as sm, i18n as i18nMeta } from '../system-messages.js';
import { argErrorResult } from './arg-error.js';
import { isInstanceAdmin, principalOf } from './instance-auth.js';

/**
 * Зависимости тулов из `ToolContext.extra` (упаковка — оркестратор).
 *
 * Совпадает по смыслу с `MaintenanceRoutesDeps` HTTP-фабрики: тулы не создают
 * сервисов и контекстов хранения сами.
 */
export interface MaintenanceToolsDeps {
  /** Каталог данных инстанса (`$SYNTH_DATA_DIR`). */
  dataDir: string;
  /** ADR-076: мастер-ключ секретов at-rest (env > config > файл) — для `doctor`. */
  secretKey?: string;
  /** Окружение процесса — источник `SYNTH_SECRET_KEY` для `doctor`. */
  env?: NodeJS.ProcessEnv;
  /**
   * ADR-092: аудит-журнал обслуживания — доменный порт слоя хранения
   * (`StorageContext.maintenanceAudit`). Не задан — запись операций не ведётся
   * (best-effort), `synth_maintenance_audit` отдаёт пустой список.
   */
  audit?: MaintenanceAuditRepository;
  /** ADR-096: физический backend хранения (`storage.backend`; по умолчанию `file`). */
  storageBackend?: StorageBackendKind;
  /** ADR-097: read-only проба БД (`postgres`) — соединение + версия схемы. */
  dbHealth?: () => Promise<StorageHealth>;
  /**
   * ADR-097: миграции схемы БД (`postgres`) — план (`dryRun`). Используется
   * статусом: файловое представление схемы на `postgres` вводило бы в заблуждение.
   */
  schemaMigrations?: (opts?: { dryRun?: boolean }) => Promise<StorageSchemaMigrationResult>;
}

/** Поля `extra`, которые читают тулы обслуживания. */
export interface InstanceMaintenanceExtra {
  maintenance?: MaintenanceToolsDeps;
}

/** Расширение архива бэкапа (`createBackup` пишет именно его). */
const ARCHIVE_SUFFIX = '.tar.gz';
/** Дефолт и потолок выдачи `synth_backup_list`. */
const DEFAULT_BACKUP_LIST_LIMIT = 20;
const MAX_BACKUP_LIST_LIMIT = 200;
/** Дефолт и потолок выдачи `synth_maintenance_audit`. */
const DEFAULT_AUDIT_LIMIT = 50;
const MAX_AUDIT_LIMIT = 1000;

/**
 * ADR-092: виды операций аудит-журнала обслуживания (валидация `op`).
 * `satisfies` держит список внутри типа `MaintenanceAuditOp` (как у HTTP-роута).
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
  'update.checked',
  'rollback.applied',
  'update.failed',
  'uninstall.purge',
  'export.created',
  'import.applied',
  'restart.requested',
] as const satisfies readonly MaintenanceAuditOp[];

function getExtra(ctx: ToolContext): InstanceMaintenanceExtra {
  return (ctx.extra ?? {}) as InstanceMaintenanceExtra;
}

function fail(key: Parameters<typeof sm>[0], params?: Record<string, string>): ToolResult {
  return {
    content: sm(key, params),
    isError: true,
    metadata: { i18n: i18nMeta(key, params) },
  };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Зависимости тула: нет прокладки — понятная ошибка, а не исключение. */
function maintenanceDeps(ctx: ToolContext, toolName: string): MaintenanceToolsDeps | ToolResult {
  const maintenance = getExtra(ctx).maintenance;
  if (!maintenance?.dataDir) return fail('maintenance.deps_unavailable', { tool: toolName });
  return maintenance;
}

function isResult(value: unknown): value is ToolResult {
  return typeof value === 'object' && value !== null && (value as { isError?: unknown }).isError === true;
}

/** Проверка ADMIN для write-тулов: отказ — `ToolResult`, не исключение. */
function requireAdmin(ctx: ToolContext): ToolResult | null {
  return isInstanceAdmin(ctx) ? null : fail('maintenance.forbidden');
}

/** Инициатор операции для аудита/`requestedBy` (`local` в standalone). */
function actorOf(ctx: ToolContext): string | undefined {
  return principalOf(ctx)?.userId;
}

/** Каталог архивов инстанса (`{dataDir}/backups/`). */
function backupsDir(dataDir: string): string {
  return join(resolve(dataDir), 'backups');
}

/**
 * Ищет архив по basename (паритет с HTTP-роутом `POST /restore`): источник —
 * `listBackups` (каталог `{dataDir}/backups/` + `uploads/`), а не собственный
 * `node:fs`/`stat` — тулы не читают ФС в обход сервисного слоя (PROP-135: в
 * `engine/tools/*` `node:fs` запрещён guard-тестом `fs-tools-no-node-fs`).
 * Имя уже проверено `isSafeBackupName` — за пределы каталогов не выйти.
 */
async function findArchive(
  dataDir: string,
  name: string,
): Promise<MaintenanceBackupInfo | null> {
  const archives = await listBackups(dataDir);
  return archives.find((archive) => archive.name === name) ?? null;
}

/**
 * Имя нового архива: явное имя санитизируется (`sanitizeBackupName` — basename +
 * `A-Za-z0-9._-` + `.tar.gz`), по умолчанию — то же имя, что у `synth backup`.
 * Существующий архив **не перезаписывается**: при коллизии добавляется суффикс
 * `-1`, `-2`, … (проверка — по списку архивов инстанса, без `node:fs`).
 */
function archiveName(raw: string | undefined, taken: ReadonlySet<string>, now: Date): string {
  const base = raw
    ? sanitizeBackupName(raw)
    : sanitizeBackupName(`synth-backup-${SYNTH_VERSION}-${formatBackupStamp(now)}`);
  const stem = base.slice(0, -ARCHIVE_SUFFIX.length).replace(/[.]+$/, '') || 'backup';
  for (let i = 0; ; i += 1) {
    const name = i === 0 ? `${stem}${ARCHIVE_SUFFIX}` : `${stem}-${i}${ARCHIVE_SUFFIX}`;
    if (!taken.has(name)) return name;
  }
}

/**
 * Состояние схемы данных для статуса. На `postgres` файловый `meta.json`
 * показывает не то, что реально в БД, поэтому берётся план миграций драйвера
 * (паритет с `GET /api/v2/maintenance/migrations`); ошибка пробы — файловый вид.
 */
async function schemaBlock(
  deps: MaintenanceToolsDeps,
  status: MaintenanceStatus,
): Promise<MaintenanceStatus['schema'] & { backend: string }> {
  const backend = deps.storageBackend ?? 'file';
  if (backend === 'postgres' && deps.schemaMigrations) {
    try {
      const plan = await deps.schemaMigrations({ dryRun: true });
      return {
        backend,
        current: plan.current ?? 0,
        expected: plan.expected,
        applied: [],
        pending: plan.pending.map((version) => ({
          id: `postgres:${version}`,
          toVersion: version,
          description: 'SQL schema migration (postgres)',
        })),
      };
    } catch {
      // Проба БД не удалась — показываем файловое представление, не падаем.
    }
  }
  return { backend, ...status.schema };
}

export const synthMaintenanceStatusTool: ToolDefinition = {
  name: 'synth_maintenance_status',
  description:
    'Instance maintenance status (read-only): package version, data directory, data schema '
    + '(current/expected/pending migrations), number of backup archives, pending restore request '
    + 'and a summary of the synth doctor checks. Use synth_maintenance_doctor for the full check list '
    + 'and synth_backup_list for the archives.',
  parameters: z.object({}),
  capabilities: [ToolCapability.INSTANCE],
  async execute(_args, ctx) {
    if (isAborted(ctx)) return abortedResult(this.name);
    const deps = maintenanceDeps(ctx, this.name);
    if (isResult(deps)) return deps;

    let status: MaintenanceStatus;
    try {
      status = await getMaintenanceStatus({
        dataDir: deps.dataDir,
        ...(deps.secretKey !== undefined ? { secretKey: deps.secretKey } : {}),
        ...(deps.env !== undefined ? { env: deps.env } : {}),
        ...(deps.storageBackend !== undefined ? { storageBackend: deps.storageBackend } : {}),
        ...(deps.dbHealth !== undefined ? { dbHealth: deps.dbHealth } : {}),
      });
    } catch (err) {
      return fail('maintenance.read_failed', { op: this.name, error: errorText(err) });
    }

    const info = {
      version: status.version,
      dataDir: status.dataDir,
      schema: await schemaBlock(deps, status),
      backups: status.backups.length,
      pendingRestore: status.pendingRestore,
      doctor: status.doctor,
    };
    const json = JSON.stringify(info);
    return {
      content: sm('maintenance.status', { json }),
      metadata: { ...info, i18n: i18nMeta('maintenance.status', { json }) },
    };
  },
};

export const synthMaintenanceDoctorTool: ToolDefinition = {
  name: 'synth_maintenance_doctor',
  description:
    'Run the full instance health check (read-only, same checks as "synth doctor"): data directory, '
    + 'data schema, master key, secrets permissions, data integrity, providers/models, file locks and '
    + 'versions (plus the database probe when storage.backend=postgres). Returns {ok, checks[]} where '
    + 'each check has id, title, status (ok|warn|fail|skipped), detail and hint.',
  parameters: z.object({}),
  capabilities: [ToolCapability.INSTANCE],
  async execute(_args, ctx) {
    if (isAborted(ctx)) return abortedResult(this.name);
    const deps = maintenanceDeps(ctx, this.name);
    if (isResult(deps)) return deps;

    let result;
    try {
      result = await runDoctor({
        dataDir: deps.dataDir,
        ...(deps.secretKey !== undefined ? { secretKey: deps.secretKey } : {}),
        ...(deps.env !== undefined ? { env: deps.env } : {}),
        ...(deps.storageBackend !== undefined ? { storageBackend: deps.storageBackend } : {}),
        ...(deps.dbHealth !== undefined ? { dbHealth: deps.dbHealth } : {}),
      });
    } catch (err) {
      return fail('maintenance.read_failed', { op: this.name, error: errorText(err) });
    }

    const failCount = result.checks.filter((check) => check.status === 'fail').length;
    const warn = result.checks.filter((check) => check.status === 'warn').length;
    const skipped = result.checks.filter((check) => check.status === 'skipped').length;
    const summary = result.ok ? 'ok' : 'problems found';
    const metadata = {
      ok: result.ok,
      dataDir: result.dataDir,
      version: result.version,
      warn,
      fail: failCount,
      skipped,
      checks: result.checks,
    };
    const json = JSON.stringify(result.checks);
    const params = {
      summary,
      warn: String(warn),
      fail: String(failCount),
      skipped: String(skipped),
      json,
    };
    return {
      content: sm('maintenance.doctor', params),
      metadata: { ...metadata, i18n: i18nMeta('maintenance.doctor', params) },
    };
  },
};

const backupListSchema = z.object({
  limit: z.number().int().min(1).max(MAX_BACKUP_LIST_LIMIT).optional()
    .describe(`Return at most N archives, newest first (default ${DEFAULT_BACKUP_LIST_LIMIT})`),
});

export const synthBackupListTool: ToolDefinition = {
  name: 'synth_backup_list',
  description:
    'List the instance backup archives (read-only), newest first: name, bytes, createdAt and the '
    + 'encrypted flag for every archive in {dataDir}/backups (including uploads/). Archive contents '
    + 'are not read; a broken or foreign file is skipped instead of failing the list.',
  parameters: backupListSchema,
  capabilities: [ToolCapability.INSTANCE],
  async execute(args, ctx) {
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) return argErrorResult(this.name, parsed.error.issues);
    const params = parsed.data as { limit?: number };

    const deps = maintenanceDeps(ctx, this.name);
    if (isResult(deps)) return deps;

    let archives;
    try {
      archives = await listBackups(deps.dataDir);
    } catch (err) {
      return fail('maintenance.read_failed', { op: this.name, error: errorText(err) });
    }

    const limit = params.limit ?? DEFAULT_BACKUP_LIST_LIMIT;
    const backups = archives.slice(0, limit).map((archive) => ({
      name: archive.name,
      bytes: archive.bytes,
      createdAt: archive.createdAt,
      encrypted: archive.encrypted === true,
    }));
    const json = JSON.stringify(backups);
    return {
      content: sm('maintenance.backup.list', { count: String(backups.length), json }),
      metadata: {
        count: backups.length,
        total: archives.length,
        backups,
        i18n: i18nMeta('maintenance.backup.list', { count: String(backups.length), json }),
      },
    };
  },
};

const backupCreateSchema = z.object({
  name: z.string().optional()
    .describe('Archive file name (a plain basename; sanitized to *.tar.gz, never overwrites an existing archive)'),
  with_secrets: z.boolean().optional()
    .describe('Include secrets/ into the archive (default false — such an archive is a secret itself)'),
  with_workspace: z.boolean().optional().describe('Include workspaces/ into the archive (default false)'),
  live: z.boolean().optional()
    .describe('Take the archive from the running service (each file is valid, but the snapshot is not transactional)'),
  encrypt: z.boolean().optional()
    .describe('Encrypt the archive with an external operator key (the result is *.tar.gz.enc)'),
  key_file: z.string().optional()
    .describe('Path to the encryption key file (used with encrypt; SYNTH_BACKUP_KEY_FILE/SYNTH_BACKUP_KEY are the fallback)'),
});

export const synthBackupCreateTool: ToolDefinition = {
  name: 'synth_backup_create',
  description:
    'Create a backup archive of the instance data directory (write, ADMIN only) — the same operation as '
    + '"synth backup" / POST /api/v2/maintenance/backups. By default secrets/ is NOT included '
    + '(with_secrets: true puts secrets into the archive: it becomes a secret). The archive lands in '
    + '{dataDir}/backups with mode 0600; the answer reports name, bytes, createdAt, entries and the '
    + 'withSecrets/withWorkspace/encrypted flags — archive contents are never returned. '
    + 'Restoring is a separate offline step: synth_restore_request.',
  parameters: backupCreateSchema,
  capabilities: [ToolCapability.INSTANCE],
  async execute(args, ctx) {
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) return argErrorResult(this.name, parsed.error.issues);
    const params = parsed.data as {
      name?: string;
      with_secrets?: boolean;
      with_workspace?: boolean;
      live?: boolean;
      encrypt?: boolean;
      key_file?: string;
    };

    const denied = requireAdmin(ctx);
    if (denied) return denied;

    const deps = maintenanceDeps(ctx, this.name);
    if (isResult(deps)) return deps;

    const dir = backupsDir(deps.dataDir);
    const now = new Date();
    // Имя и коллизии — по списку архивов инстанса (без `node:fs`): существующий
    // архив не перезаписывается.
    const taken = new Set((await listBackups(deps.dataDir)).map((archive) => archive.name));
    const out = join(dir, archiveName(params.name, taken, now));

    // Ключ шифрования резолвится до записи: при ошибке плейнтекст-архива не остаётся.
    let encryptKey: Buffer | undefined;
    if (params.encrypt) {
      try {
        encryptKey = await resolveBackupKey({
          ...(params.key_file !== undefined ? { keyFile: params.key_file } : {}),
          ...(deps.env !== undefined ? { env: deps.env } : {}),
        });
      } catch (err) {
        return fail('maintenance.backup.failed', { error: errorText(err) });
      }
    }

    let result;
    try {
      result = await createBackup({
        dataDir: deps.dataDir,
        out,
        // `now` — тот же момент, что в имени файла (иначе `createdAt` и имя
        // расходятся на границе секунды).
        now,
        withSecrets: params.with_secrets === true,
        withWorkspace: params.with_workspace === true,
        live: params.live === true,
        ...(params.encrypt ? { encrypt: true } : {}),
        ...(encryptKey !== undefined ? { encryptKey } : {}),
        ...(deps.storageBackend !== undefined ? { storageBackend: deps.storageBackend } : {}),
        ...(deps.audit !== undefined ? { audit: deps.audit } : {}),
        ...(actorOf(ctx) !== undefined ? { actor: actorOf(ctx) } : {}),
      });
    } catch (err) {
      return fail('maintenance.backup.failed', { error: errorText(err) });
    }

    const info = {
      name: basename(result.path),
      path: resolve(result.path),
      bytes: result.bytes,
      createdAt: result.manifest.createdAt,
      withSecrets: result.manifest.withSecrets === true,
      withWorkspace: result.manifest.withWorkspace === true,
      encrypted: result.encrypted,
      entries: result.manifest.entries.length,
    };
    const textParams = {
      name: info.name,
      bytes: String(info.bytes),
      secrets: String(info.withSecrets),
      workspace: String(info.withWorkspace),
      encrypted: String(info.encrypted),
      entries: String(info.entries),
    };
    return {
      content: sm('maintenance.backup.created', textParams),
      metadata: { ...info, i18n: i18nMeta('maintenance.backup.created', textParams) },
    };
  },
};

const restoreRequestSchema = z.object({
  archive: z.string().min(1)
    .describe('Archive name from synth_backup_list (a plain basename inside {dataDir}/backups)'),
  with_workspace: z.boolean().optional()
    .describe('Expected workspace content of the archive (used only for a warning: restore applies exactly what the archive contains)'),
  confirm: z.boolean().optional()
    .describe('Must be true: the request changes the data directory on the next instance start'),
});

export const synthRestoreRequestTool: ToolDefinition = {
  name: 'synth_restore_request',
  description:
    'Schedule a restore of an instance backup (write, ADMIN only) — same semantics as '
    + 'POST /api/v2/maintenance/restore. This does NOT restore anything now: the request is written to '
    + '{dataDir}/maintenance/restore-request.json and applied on the next instance start (the running '
    + 'process never wipes the data directory). The archive is validated first (manifest, checksums, '
    + 'schema compatibility) and must live in {dataDir}/backups. Encrypted archives (*.tar.gz.enc) cannot '
    + 'be restored this way — only via the CLI, the key is not available to the server. Requires confirm: true.',
  parameters: restoreRequestSchema,
  capabilities: [ToolCapability.INSTANCE],
  async execute(args, ctx) {
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) return argErrorResult(this.name, parsed.error.issues);
    const params = parsed.data as { archive: string; with_workspace?: boolean; confirm?: boolean };

    const denied = requireAdmin(ctx);
    if (denied) return denied;
    if (params.confirm !== true) return fail('maintenance.confirm_required');

    const deps = maintenanceDeps(ctx, this.name);
    if (isResult(deps)) return deps;

    const name = params.archive.trim();
    if (!isSafeBackupName(name)) {
      return fail('maintenance.invalid_archive', { archive: name, reason: 'not a safe archive name (*.tar.gz)' });
    }
    const archive = await findArchive(deps.dataDir, name);
    if (!archive) return fail('maintenance.not_found', { target: 'archive', name });

    const validation = await validateRestoreArchive({ dataDir: deps.dataDir, archive: archive.path });
    if (!validation.ok) {
      return fail('maintenance.invalid_archive', {
        archive: name,
        reason: validation.problem ?? 'unknown validation error',
      });
    }

    // `with_workspace` — ожидание вызывающего, а не параметр восстановления:
    // применяется ровно то, что лежит в архиве. Расхождение — предупреждение.
    const warnings: string[] = [];
    const archiveWorkspace = validation.manifest?.withWorkspace === true;
    if (params.with_workspace !== undefined && params.with_workspace !== archiveWorkspace) {
      warnings.push(sm('maintenance.restore.workspace_mismatch', { workspace: String(archiveWorkspace) }));
    }

    let pending;
    try {
      pending = await scheduleRestore({
        dataDir: deps.dataDir,
        archive: archive.path,
        ...(actorOf(ctx) !== undefined ? { requestedBy: actorOf(ctx) } : {}),
        ...(deps.audit !== undefined ? { audit: deps.audit } : {}),
      });
    } catch (err) {
      return fail('maintenance.restore.failed', { error: errorText(err) });
    }

    const textParams = { archive: name, warnings: warnings.length > 0 ? warnings.join('; ') : '—' };
    return {
      content: sm('maintenance.restore.scheduled', textParams),
      metadata: {
        pending,
        appliesOnNextStart: true,
        warnings,
        i18n: i18nMeta('maintenance.restore.scheduled', textParams),
      },
    };
  },
};

export const synthRestoreCancelTool: ToolDefinition = {
  name: 'synth_restore_cancel',
  description:
    'Cancel the pending restore request of the instance (write, ADMIN only) — same semantics as '
    + 'DELETE /api/v2/maintenance/restore. Nothing to cancel is reported as maintenance.not_found. '
    + 'The data directory itself is not touched (restore is an offline operation).',
  parameters: z.object({}),
  capabilities: [ToolCapability.INSTANCE],
  async execute(_args, ctx) {
    if (isAborted(ctx)) return abortedResult(this.name);
    const denied = requireAdmin(ctx);
    if (denied) return denied;

    const deps = maintenanceDeps(ctx, this.name);
    if (isResult(deps)) return deps;

    let cancelled: boolean;
    try {
      cancelled = await cancelPendingRestore(deps.dataDir, deps.audit);
    } catch (err) {
      return fail('maintenance.restore.failed', { error: errorText(err) });
    }
    // Отменять нечего — это не ошибка (состояние уже желаемое), но модель
    // должна видеть разницу между «отменил» и «запроса не было».
    if (!cancelled) {
      return {
        content: sm('maintenance.restore.none'),
        metadata: { cancelled: false, i18n: i18nMeta('maintenance.restore.none') },
      };
    }

    return {
      content: sm('maintenance.restore.cancelled'),
      metadata: { cancelled: true, i18n: i18nMeta('maintenance.restore.cancelled') },
    };
  },
};

const restartSchema = z.object({
  confirm: z.boolean().optional()
    .describe('Must be true: the current turn and all active streams are interrupted'),
  reason: z.string().optional().describe('Why the instance is restarted (recorded in the maintenance journal)'),
});

export const synthRestartRequestTool: ToolDefinition = {
  name: 'synth_restart_request',
  description:
    'Request a graceful instance restart (write, ADMIN only) — same semantics as '
    + 'POST /api/v2/maintenance/restart. The process exits with code 75 and is started again by the '
    + 'supervisor (systemd/k8s/docker or scripts/dev.sh); the settings applied at startup (TLS, proxy, '
    + 'metrics, storage, MCP) take effect after it. WARNING: the current turn and all active streams are '
    + 'interrupted — report to the user BEFORE calling this tool. Mode disabled on the instance is '
    + 'reported as maintenance.restart_unsupported. Requires confirm: true.',
  parameters: restartSchema,
  capabilities: [ToolCapability.INSTANCE],
  async execute(args, ctx) {
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) return argErrorResult(this.name, parsed.error.issues);
    const params = parsed.data as { confirm?: boolean; reason?: string };

    const denied = requireAdmin(ctx);
    if (denied) return denied;
    if (params.confirm !== true) return fail('maintenance.confirm_required');

    const deps = maintenanceDeps(ctx, this.name);
    if (isResult(deps)) return deps;

    const status = getRestartStatus();
    if (!status.supported) {
      return fail('maintenance.restart_unsupported', {
        mode: status.mode,
        reason: status.reason ?? 'restart mode is disabled',
      });
    }

    let outcome;
    try {
      outcome = await requestRestart({
        // ADR-092: аудит `restart.requested` — до инициации shutdown (как у роута).
        beforeRequest: async (restartId, mode) => {
          await recordMaintenanceAudit(deps.audit, {
            op: 'restart.requested',
            status: 'scheduled',
            ...(actorOf(ctx) !== undefined ? { actor: actorOf(ctx) } : {}),
            details: {
              mode,
              restartId,
              source: 'agent',
              ...(params.reason ? { reason: params.reason } : {}),
            },
          });
        },
      });
    } catch (err) {
      return fail('maintenance.restart.failed', { error: errorText(err) });
    }
    if (!outcome.accepted) {
      return fail('maintenance.restart_unsupported', {
        mode: outcome.mode,
        reason: outcome.reason ?? 'restart is not accepted by the instance',
      });
    }

    const textParams = { mode: outcome.mode, restartId: outcome.restartId ?? '—' };
    return {
      content: sm('maintenance.restart.requested', textParams),
      metadata: {
        status: 'restarting',
        restartId: outcome.restartId ?? null,
        mode: outcome.mode,
        alreadyRequested: outcome.alreadyRequested === true,
        startedAt: status.startedAt,
        turnInterrupted: true,
        i18n: i18nMeta('maintenance.restart.requested', textParams),
      },
    };
  },
};

const auditSchema = z.object({
  limit: z.number().int().min(1).max(MAX_AUDIT_LIMIT).optional()
    .describe(`Return at most N entries, newest first (default ${DEFAULT_AUDIT_LIMIT})`),
  op: z.enum(MAINTENANCE_AUDIT_OPS).optional().describe('Filter by the maintenance operation kind'),
});

export const synthMaintenanceAuditTool: ToolDefinition = {
  name: 'synth_maintenance_audit',
  description:
    'List the instance maintenance journal (read-only, ADR-092), newest first: what lifecycle operation '
    + '(backup/restore/migrate/update/rollback/uninstall/export/import/restart) happened, when, by whom and '
    + 'with what result. Optional op filter and limit (1..1000, default 50). No audit port configured — '
    + 'an empty list is returned.',
  parameters: auditSchema,
  capabilities: [ToolCapability.INSTANCE],
  async execute(args, ctx) {
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) return argErrorResult(this.name, parsed.error.issues);
    const params = parsed.data as { limit?: number; op?: MaintenanceAuditOp };

    const deps = maintenanceDeps(ctx, this.name);
    if (isResult(deps)) return deps;

    const limit = params.limit ?? DEFAULT_AUDIT_LIMIT;
    if (!deps.audit) {
      const json = '[]';
      return {
        content: sm('maintenance.audit.list', { count: '0', json }),
        metadata: {
          count: 0,
          available: false,
          entries: [],
          i18n: i18nMeta('maintenance.audit.list', { count: '0', json }),
        },
      };
    }

    let entries;
    try {
      entries = await deps.audit.list(params.op ? { limit, op: params.op } : { limit });
    } catch (err) {
      return fail('maintenance.read_failed', { op: this.name, error: errorText(err) });
    }

    const json = JSON.stringify(entries);
    return {
      content: sm('maintenance.audit.list', { count: String(entries.length), json }),
      metadata: {
        count: entries.length,
        available: true,
        entries,
        i18n: i18nMeta('maintenance.audit.list', { count: String(entries.length), json }),
      },
    };
  },
};

/** Все тулы обслуживания инстанса (регистрация — `engine/tools/index.ts`). */
export const maintenanceTools: ToolDefinition[] = [
  synthMaintenanceStatusTool,
  synthMaintenanceDoctorTool,
  synthBackupListTool,
  synthBackupCreateTool,
  synthRestoreRequestTool,
  synthRestoreCancelTool,
  synthRestartRequestTool,
  synthMaintenanceAuditTool,
];

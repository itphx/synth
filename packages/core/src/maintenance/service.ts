// ADR-091/ADR-092: сервисный слой обслуживания инстанса — переиспользуемые
// операции для admin-API/UI (backup/restore/doctor/migrate).
//
// Чистые функции над каталогом данных: без HTTP; запись — только в операционные
// каталоги обслуживания (`{dataDir}/backups/`, `{dataDir}/maintenance/`), не в
// доменные данные инстанса. Восстановление — офлайн-операция: под живым
// процессом каталог данных не вычищается, запрос на восстановление применяется
// при следующем старте (`applyPendingRestore`, ADR-091/ADR-092).
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { atomicWrite, SYNTH_VERSION } from '@itphx/synth-shared';
import { checkInstanceCompatibility } from '../storage/instance-meta.js';
import { runDoctor } from './doctor.js';
import {
  assertArchiveSchemaCompatible,
  readBackupManifest,
  verifyBackupArchive,
} from './restore.js';

/** Каталог бэкапов/страховочных копий (ADR-091). */
const BACKUPS_DIR = 'backups';
/** Каталог загруженных из UI архивов (внутри `backups/`). */
const UPLOADS_DIR = 'uploads';
/** Транзиентные файлы обслуживания (запрос на восстановление и т.п.). */
const MAINTENANCE_DIR = 'maintenance';
/** Файл отложенного запроса на восстановление (ADR-091). */
const RESTORE_REQUEST_FILE = 'restore-request.json';
/** Расширение архива бэкапа. */
const ARCHIVE_SUFFIX = '.tar.gz';

/** Метаданные архива бэкапа для admin-UI (ADR-091). */
export interface MaintenanceBackupInfo {
  /** Имя файла архива (basename). */
  name: string;
  /** Абсолютный путь к архиву. */
  path: string;
  /** Размер файла в байтах. */
  bytes: number;
  /** Время снятия (`manifest.createdAt`). */
  createdAt: string;
  /** Версия схемы данных в архиве. */
  schemaVersion: number;
  /** `SYNTH_VERSION` в архиве. */
  instanceVersion: string;
  /** Архив содержит `secrets/`. */
  withSecrets: boolean;
  /** Архив содержит `workspaces/`. */
  withWorkspace: boolean;
  /** Число записей в манифесте. */
  entries: number;
}

/** Отложенный запрос на восстановление (ADR-091): применяется при старте. */
export interface PendingRestoreRequest {
  /** Абсолютный путь к архиву (только внутри `{dataDir}/backups/`). */
  archive: string;
  /** Кто запросил (для аудита; необязательно). */
  requestedBy?: string;
  /** ISO-метка запроса. */
  requestedAt: string;
  /** Создать страховочную копию перед восстановлением. */
  safetyCopy: boolean;
}

/** Сводный статус обслуживания инстанса для admin-UI (ADR-091/ADR-092). */
export interface MaintenanceStatus {
  /** `SYNTH_VERSION` запущенного пакета. */
  version: string;
  /** Каталог данных инстанса. */
  dataDir: string;
  /** Состояние схемы данных (ADR-092). */
  schema: {
    /** Текущая версия (`meta.json`, нет — 0). */
    current: number;
    /** Ожидаемая версия (`SCHEMA_VERSION`). */
    expected: number;
    /** Применённые id миграций. */
    applied: string[];
    /** Ожидающие миграции. */
    pending: Array<{ id: string; toVersion: number; description: string }>;
  };
  /** Доступные архивы бэкапа. */
  backups: MaintenanceBackupInfo[];
  /** Отложенный запрос на восстановление. */
  pendingRestore: PendingRestoreRequest | null;
  /** Сводка `synth doctor` (`ok` — нет `fail`). */
  doctor: { ok: boolean; fail: number; warn: number };
}

/** Публичный снимок манифеста архива (без записей). */
export interface RestoreArchiveManifest {
  schemaVersion: number;
  instanceVersion: string;
  withSecrets: boolean;
  withWorkspace: boolean;
  entries: number;
  createdAt: string;
}

/** Каталог бэкапов инстанса (создаётся по необходимости). */
function _backupsDir(dataDir: string): string {
  return join(resolve(dataDir), BACKUPS_DIR);
}

/** Каталог загруженных архивов (`{dataDir}/backups/uploads`). */
function _uploadsDir(dataDir: string): string {
  return join(_backupsDir(dataDir), UPLOADS_DIR);
}

/** Путь к файлу отложенного запроса на восстановление. */
function _restoreRequestPath(dataDir: string): string {
  return join(resolve(dataDir), MAINTENANCE_DIR, RESTORE_REQUEST_FILE);
}

/**
 * Проверяет владение архивом (ADR-091): путь лежит внутри `{dataDir}/backups/`
 * (с учётом `uploads/`). Абсолютные пути от клиента вне этого каталога —
 * отказ (ни архив, ни запрос на восстановление чужого файла не принимаем).
 *
 * @throws Error если путь вне каталога бэкапов инстанса.
 */
function _ownedArchivePath(dataDir: string, archive: string): string {
  const backups = _backupsDir(dataDir);
  const target = resolve(archive);
  if (target !== backups && !target.startsWith(backups + sep)) {
    throw new Error(
      `Архив должен находиться в каталоге бэкапов инстанса (${backups}).`,
    );
  }
  return target;
}

/** Имя — безопасный basename архива (`*.tar.gz`, без слэшей/`..`). */
export function isSafeBackupName(name: string): boolean {
  if (!name || name === '.' || name === '..') return false;
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) return false;
  if (name !== basename(name)) return false;
  return name.endsWith(ARCHIVE_SUFFIX);
}

/**
 * Санитизирует имя загруженного архива (ADR-091): basename, разрешённые
 * символы (`A-Za-z0-9._-`), гарантированное расширение `.tar.gz`.
 */
export function sanitizeBackupName(raw: string): string {
  const cleaned = basename(raw).replace(/[^A-Za-z0-9._-]/g, '_');
  let name = cleaned.endsWith(ARCHIVE_SUFFIX) ? cleaned : `${cleaned}${ARCHIVE_SUFFIX}`;
  const stem = name.slice(0, -ARCHIVE_SUFFIX.length).replace(/[.]+$/, '');
  if (!stem || stem === '.' || stem === '..') name = `upload${ARCHIVE_SUFFIX}`;
  return name;
}

/** Уникализирует имя в каталоге (`stem-1.tar.gz`, `stem-2.tar.gz`, …). */
async function _uniqueName(dir: string, name: string): Promise<string> {
  const stem = name.slice(0, -ARCHIVE_SUFFIX.length);
  let candidate = name;
  for (let i = 1; ; i += 1) {
    try {
      await stat(join(dir, candidate));
    } catch {
      return candidate;
    }
    candidate = `${stem}-${i}${ARCHIVE_SUFFIX}`;
  }
}

/** Читает метаданные одного архива; битый/чужой файл → `null` (не падаем). */
async function _readBackupInfo(filePath: string): Promise<MaintenanceBackupInfo | null> {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return null;
    const manifest = await readBackupManifest(filePath);
    return {
      name: basename(filePath),
      path: resolve(filePath),
      bytes: info.size,
      createdAt: manifest.createdAt,
      schemaVersion: manifest.schemaVersion,
      instanceVersion: manifest.instanceVersion,
      withSecrets: manifest.withSecrets === true,
      withWorkspace: manifest.withWorkspace === true,
      entries: Array.isArray(manifest.entries) ? manifest.entries.length : 0,
    };
  } catch {
    return null;
  }
}

/** Список `*.tar.gz` в каталоге (каталога нет → пусто). */
async function _listArchiveFiles(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  return entries.filter((name) => name.endsWith(ARCHIVE_SUFFIX)).map((name) => join(dir, name));
}

/**
 * Список архивов инстанса (ADR-091): `{dataDir}/backups/*.tar.gz` и
 * `{dataDir}/backups/uploads/*.tar.gz`. Метаданные — из манифеста; битый или
 * чужой файл пропускается (список не рушится). Порядок — по `createdAt` (свежие
 * сверху).
 */
export async function listBackups(dataDir: string): Promise<MaintenanceBackupInfo[]> {
  const files = [
    ...(await _listArchiveFiles(_backupsDir(dataDir))),
    ...(await _listArchiveFiles(_uploadsDir(dataDir))),
  ];
  const infos: MaintenanceBackupInfo[] = [];
  for (const file of files) {
    const info = await _readBackupInfo(file);
    if (info) infos.push(info);
  }
  infos.sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  return infos;
}

/**
 * Удаляет архив по имени (ADR-091). Имя валидируется (`basename`, расширение
 * `.tar.gz`, без слэшей/`..`); поиск — только в `{dataDir}/backups/` и
 * `{dataDir}/backups/uploads/`.
 *
 * @returns `true` — файл был и удалён; `false` — небезопасное имя или файла нет.
 */
export async function deleteBackup(dataDir: string, name: string): Promise<boolean> {
  if (!isSafeBackupName(name)) return false;
  for (const dir of [_backupsDir(dataDir), _uploadsDir(dataDir)]) {
    const target = join(dir, name);
    try {
      const info = await stat(target);
      if (!info.isFile()) continue;
    } catch {
      continue;
    }
    await rm(target, { force: true });
    return true;
  }
  return false;
}

/**
 * Раскладывает загруженный из UI архив в `{dataDir}/backups/uploads/`
 * (ADR-091): имя санитизируется (basename, разрешённые символы, `.tar.gz`) и
 * уникализируется при коллизии. Файл — `0600` (архив может содержать секреты).
 *
 * @returns абсолютный путь размещённого архива.
 */
export async function stageUploadedArchive(
  dataDir: string,
  fileName: string,
  data: Buffer | string,
): Promise<string> {
  const dir = _uploadsDir(dataDir);
  await mkdir(dir, { recursive: true });
  const name = await _uniqueName(dir, sanitizeBackupName(fileName));
  const target = join(dir, name);
  await writeFile(target, data, { mode: 0o600 });
  return target;
}

/** Публичный снимок манифеста (без записей). */
function _toManifestInfo(manifest: {
  schemaVersion: number;
  instanceVersion: string;
  withSecrets: boolean;
  withWorkspace: boolean;
  entries: unknown[];
  createdAt: string;
}): RestoreArchiveManifest {
  return {
    schemaVersion: manifest.schemaVersion,
    instanceVersion: manifest.instanceVersion,
    withSecrets: manifest.withSecrets === true,
    withWorkspace: manifest.withWorkspace === true,
    entries: Array.isArray(manifest.entries) ? manifest.entries.length : 0,
    createdAt: manifest.createdAt,
  };
}

/**
 * Проверяет архив восстановления (ADR-091/ADR-092) — переиспользует общую
 * логику `restoreBackup` (`restore.ts`): манифест → формат → версия схемы →
 * контрольные суммы. Ничего не пишет. Архив обязан лежать в
 * `{dataDir}/backups/` (с учётом `uploads/`).
 *
 * @returns `{ok:true, manifest}` или `{ok:false, problem}` (не бросает).
 */
export async function validateRestoreArchive(opts: {
  dataDir: string;
  archive: string;
}): Promise<{ ok: boolean; problem?: string; manifest?: RestoreArchiveManifest }> {
  try {
    const target = _ownedArchivePath(opts.dataDir, opts.archive);
    const info = await stat(target);
    if (!info.isFile()) throw new Error('Архив не найден.');
    const manifest = await readBackupManifest(target);
    assertArchiveSchemaCompatible(manifest);
    await verifyBackupArchive(target, manifest);
    return { ok: true, manifest: _toManifestInfo(manifest) };
  } catch (err) {
    return { ok: false, problem: err instanceof Error ? err.message : String(err) };
  }
}

/** Разбирает содержимое `restore-request.json`; форма неверна → `null`. */
function _parseRestoreRequest(value: unknown): PendingRestoreRequest | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.archive !== 'string' || raw.archive.length === 0) return null;
  if (typeof raw.requestedAt !== 'string') return null;
  const request: PendingRestoreRequest = {
    archive: raw.archive,
    requestedAt: raw.requestedAt,
    safetyCopy: raw.safetyCopy !== false,
  };
  if (typeof raw.requestedBy === 'string' && raw.requestedBy.length > 0) {
    request.requestedBy = raw.requestedBy;
  }
  return request;
}

/** Атомарно пишет запрос на восстановление (ADR-091). */
async function _writeRestoreRequest(dataDir: string, request: PendingRestoreRequest): Promise<void> {
  const path = _restoreRequestPath(dataDir);
  await mkdir(join(resolve(dataDir), MAINTENANCE_DIR), { recursive: true });
  await atomicWrite(
    (p, d) => writeFile(p, d, 'utf-8'),
    (o, n) => rename(o, n),
    path,
    JSON.stringify(request, null, 2),
  );
}

/**
 * Планирует отложенное восстановление (ADR-091): архив проверяется
 * (`validateRestoreArchive`) и обязан лежать в `{dataDir}/backups/`; запрос
 * пишется в `{dataDir}/maintenance/restore-request.json` (атомарно) и
 * применяется при следующем старте (`applyPendingRestore`). Под живым процессом
 * каталог данных не вычищается.
 *
 * @throws Error если архив отсутствует/невалиден/вне каталога бэкапов.
 */
export async function scheduleRestore(opts: {
  dataDir: string;
  archive: string;
  requestedBy?: string;
  safetyCopy?: boolean;
}): Promise<PendingRestoreRequest> {
  const target = _ownedArchivePath(opts.dataDir, opts.archive);
  const validation = await validateRestoreArchive({ dataDir: opts.dataDir, archive: target });
  if (!validation.ok) {
    throw new Error(`Архив не прошёл проверку: ${validation.problem ?? 'неизвестная ошибка'}`);
  }
  const request: PendingRestoreRequest = {
    archive: target,
    requestedAt: new Date().toISOString(),
    safetyCopy: opts.safetyCopy !== false,
  };
  if (opts.requestedBy) request.requestedBy = opts.requestedBy;
  await _writeRestoreRequest(opts.dataDir, request);
  return request;
}

/**
 * Читает отложенный запрос на восстановление (ADR-091). Файла нет или форма
 * неверна → `null` (не бросает).
 */
export async function getPendingRestore(dataDir: string): Promise<PendingRestoreRequest | null> {
  try {
    const raw = await readFile(_restoreRequestPath(dataDir), 'utf-8');
    return _parseRestoreRequest(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * Отменяет отложенный запрос на восстановление (ADR-091).
 *
 * @returns `true` — запрос был и удалён; `false` — запроса нет.
 */
export async function cancelPendingRestore(dataDir: string): Promise<boolean> {
  const path = _restoreRequestPath(dataDir);
  try {
    await stat(path);
  } catch {
    return false;
  }
  await rm(path, { force: true });
  return true;
}

/**
 * Сводный статус обслуживания инстанса (ADR-091/ADR-092) для admin-API/UI:
 * схема данных + доступные бэкапы + отложенный запрос + сводка `synth doctor`.
 * Read-only (doctor пишет лишь пробный файл `.doctor-probe`).
 */
export async function getMaintenanceStatus(opts: {
  dataDir: string;
  secretKey?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<MaintenanceStatus> {
  const dataDir = resolve(opts.dataDir);
  const compatibility = await checkInstanceCompatibility(dataDir);
  const [backups, pendingRestore, doctor] = await Promise.all([
    listBackups(dataDir),
    getPendingRestore(dataDir),
    runDoctor({ dataDir, secretKey: opts.secretKey, env: opts.env }),
  ]);

  return {
    version: SYNTH_VERSION,
    dataDir,
    schema: {
      current: compatibility.currentVersion,
      expected: compatibility.expectedVersion,
      applied: compatibility.meta?.migrations ?? [],
      pending: compatibility.pending.map((migration) => ({
        id: migration.id,
        toVersion: migration.toVersion,
        description: migration.description,
      })),
    },
    backups,
    pendingRestore,
    doctor: {
      ok: doctor.ok,
      fail: doctor.checks.filter((check) => check.status === 'fail').length,
      warn: doctor.checks.filter((check) => check.status === 'warn').length,
    },
  };
}

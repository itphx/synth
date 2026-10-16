// ADR-091: `synth backup` — архив каталога данных (`$SYNTH_DATA_DIR`) в tar.gz
// с манифестом (версия схемы/пакета, время, список файлов, контрольная сумма),
// опциональными секретами и опциональными рабочими каталогами.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { SYNTH_VERSION } from '@itphx/synth-shared';
import { readInstanceMeta } from '../storage/instance-meta.js';
import type { MaintenanceAuditRepository } from '../storage/ports/maintenance-audit-repository.js';
import type { StorageBackendKind } from '../storage/storage-context.js';
import {
  listFilesForArchive,
  writeTarGz,
  type ArchiveEntryMeta,
  type ArchiveSource,
} from './archive.js';
import { recordMaintenanceAudit } from './audit.js';
import {
  BackupEncryptionError,
  buildEncryptedMeta,
  encryptedArchivePath,
  encryptedMetaPath,
  encryptArchiveToFile,
  resolveBackupKey,
} from './backup-crypto.js';

/** Манифест архива backup (ADR-091). */
export interface BackupManifest {
  tool: 'synth-backup';
  formatVersion: 1;
  /** Версия схемы данных из `meta.json` (нет — 0). */
  schemaVersion: number;
  /** `SYNTH_VERSION` на момент снятия. */
  instanceVersion: string;
  createdAt: string;
  withSecrets: boolean;
  withWorkspace: boolean;
  /**
   * PROP-032: физический backend хранения на момент снятия. `postgres` —
   * архив каталога данных **не содержит** данных БД (сессии/проекты/настройки/
   * секреты-в-БД); для полного бэкапа нужен `pg_dump`/PITR.
   */
  storageBackend?: StorageBackendKind;
  /** Применённые исключения (паттерны). */
  excluded: string[];
  /** Записи архива (без `manifest.json`). */
  entries: ArchiveEntryMeta[];
  /** sha256 от join(sha256 файлов, '\n'). */
  contentChecksum: string;
  dataDir: string;
}

/** Опции `createBackup` (ADR-091). */
export interface CreateBackupOptions {
  dataDir: string;
  /** Путь к архиву; каталог — положить файл внутрь. По умолчанию — текущий каталог. */
  out?: string;
  /** Включить `secrets/` (архив становится секретом). */
  withSecrets?: boolean;
  /** Включить `workspaces/`. */
  withWorkspace?: boolean;
  /**
   * PROP-032: физический backend хранения — пишется в манифест
   * (`storageBackend`) и включает предупреждение о неполноте архива при
   * `postgres` (данные БД в архив каталога не попадают).
   */
  storageBackend?: StorageBackendKind;
  /** Снятие с работающего сервиса (`--live`): срез не транзакционный. */
  live?: boolean;
  /**
   * ADR-091: зашифровать архив внешним ключом оператора → `<archive>.tar.gz.enc`
   * (+ sidecar `*.enc.meta.json`). Требует `encryptKey`.
   */
  encrypt?: boolean;
  /**
   * ADR-091: 32-байтовый внешний ключ шифрования; обязателен при `encrypt`.
   * Не логируется; резолвится CLI (`resolveBackupKey`) из `--key-file`/env.
   */
  encryptKey?: Buffer;
  /** Момент времени (для имени файла и `createdAt`); по умолчанию — текущий. */
  now?: Date;
  /** Канал вывода (по умолчанию — тихий). */
  log?: (msg: string) => void;
  /** ADR-092: аудит-журнал обслуживания (best-effort; ошибка записи не ломает бэкап). */
  audit?: MaintenanceAuditRepository;
  /** ADR-092: инициатор операции (`'cli'` | `userId`). */
  actor?: string;
}

/** Опции CLI-команды `synth backup` (ADR-091). */
export interface BackupCommandOptions extends CreateBackupOptions {
  /** Канал ошибок (по умолчанию `console.error`). */
  error?: (msg: string) => void;
  /** ADR-091: путь к файлу с ключом шифрования (иначе env-резолв ключа). */
  keyFile?: string;
  /** Окружение для env-резолва ключа шифрования (по умолчанию — `process.env`). */
  env?: NodeJS.ProcessEnv;
}

/** Строит метку времени `YYYYMMDD-HHmmss` (локальное время). */
export function formatBackupStamp(date: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  );
}

/** Вид страховочной копии (ADR-092): перед миграцией или перед восстановлением. */
export type SafetyCopyKind = 'pre-migrate' | 'pre-restore';

/**
 * Путь страховочной копии в едином каталоге `{dataDir}/backups/` (ADR-092):
 * `synth-<kind>-<YYYYMMDD-HHmmss>.tar.gz`. Каталог `backups/` исключён из
 * архивов бэкапа по умолчанию, поэтому копии не попадают в бэкап рекурсивно.
 */
export function safetyCopyPath(dataDir: string, kind: SafetyCopyKind, now: Date = new Date()): string {
  return join(resolve(dataDir), 'backups', `synth-${kind}-${formatBackupStamp(now)}.tar.gz`);
}

/** Строит набор исключений (паттерны + предикат) по флагам. */
function _buildExclusions(opts: { withSecrets: boolean; withWorkspace: boolean }): {
  patterns: string[];
  predicate: (relPath: string, isDir: boolean) => boolean;
} {
  // ADR-091/ADR-092: транзиентное состояние обслуживания (`backups/`,
  // `maintenance/` — запросы на восстановление, `tmp/`, `logs/`) в архив не
  // попадает: копии не бэкапятся рекурсивно, а вложенный запрос на
  // восстановление архива смысла не имеет.
  const patterns = ['backups/', 'tmp/', 'logs/', 'maintenance/', '.doctor-probe', '*.lock'];
  if (!opts.withWorkspace) patterns.push('workspaces/');
  if (!opts.withSecrets) patterns.push('secrets/');

  const predicate = (relPath: string, _isDir: boolean): boolean => {
    const top = relPath.split('/')[0];
    if (top === 'backups' || top === 'tmp' || top === 'logs' || top === 'maintenance') return true;
    if (relPath === '.doctor-probe') return true;
    if (relPath.endsWith('.lock')) return true;
    if (!opts.withWorkspace && top === 'workspaces') return true;
    if (!opts.withSecrets && top === 'secrets') return true;
    return false;
  };

  return { patterns, predicate };
}

/** sha256 файла потоково. */
function _hashFile(absPath: string): Promise<string> {
  return new Promise<string>((resolveHash, reject) => {
    const hash = createHash('sha256');
    const rs = createReadStream(absPath);
    rs.on('error', reject);
    rs.on('end', () => resolveHash(hash.digest('hex')));
    rs.on('data', (chunk) => hash.update(chunk));
  });
}

/** Контрольная сумма содержимого: sha256 от join(sha256 файлов, '\n'). */
export function computeContentChecksum(entries: ArchiveEntryMeta[]): string {
  const hashes = entries
    .filter((entry) => entry.type === 'file' && typeof entry.sha256 === 'string')
    .map((entry) => entry.sha256 as string);
  return createHash('sha256').update(hashes.join('\n')).digest('hex');
}

/** Резолвит итоговый путь архива (каталог → имя по умолчанию внутри). */
async function _resolveOutPath(out: string | undefined, defaultName: string): Promise<string> {
  if (!out) return resolve(defaultName);
  const abs = resolve(out);
  try {
    if ((await stat(abs)).isDirectory()) return join(abs, defaultName);
  } catch {
    // Путь не существует — трактуем как файл.
  }
  return abs;
}

/**
 * Результат снятия архива бэкапа (ADR-091): путь итогового файла (для `encrypt` —
 * `.tar.gz.enc`), манифест и размер; `encrypted` — был ли применён `--encrypt`.
 */
export interface CreateBackupResult {
  path: string;
  manifest: BackupManifest;
  bytes: number;
  encrypted: boolean;
}

/**
 * Создаёт архив каталога данных (ADR-091).
 *
 * Исключения по умолчанию: `backups/` (страховочные копии — не бэкапятся
 * рекурсивно), `maintenance/` (транзиентные запросы обслуживания, ADR-091/092),
 * `workspaces/` (без `--with-workspace`), `tmp/`, `logs/`, `.doctor-probe`,
 * `*.lock`; `secrets/` — без `--with-secrets`.
 * Файл архива — `0600`.
 */
async function _createBackup(opts: CreateBackupOptions): Promise<CreateBackupResult> {
  const log = opts.log ?? ((): void => {});
  const now = opts.now ?? new Date();
  const dataDir = resolve(opts.dataDir);
  const withSecrets = !!opts.withSecrets;
  const withWorkspace = !!opts.withWorkspace;
  const live = !!opts.live;

  const meta = await readInstanceMeta(dataDir);
  const schemaVersion = meta?.schemaVersion ?? 0;
  const instanceVersion = SYNTH_VERSION;

  const defaultName = `synth-backup-${instanceVersion}-${formatBackupStamp(now)}.tar.gz`;
  const outPath = await _resolveOutPath(opts.out, defaultName);

  const { patterns, predicate } = _buildExclusions({ withSecrets, withWorkspace });
  const sources: ArchiveSource[] = await listFilesForArchive(dataDir, { exclude: predicate });

  // Предварительный расчёт записей: манифест пишется в архив последним, поэтому
  // его содержимое (с хешами) должно быть известно до записи.
  const entries: ArchiveEntryMeta[] = [];
  for (const source of sources) {
    if (source.type === 'dir') {
      entries.push({ path: source.path, type: 'dir', size: 0, mode: source.mode });
      continue;
    }
    const info = await stat(source.absPath);
    entries.push({
      path: source.path,
      type: 'file',
      size: info.size,
      mode: source.mode,
      sha256: await _hashFile(source.absPath),
    });
  }

  const manifest: BackupManifest = {
    tool: 'synth-backup',
    formatVersion: 1,
    schemaVersion,
    instanceVersion,
    createdAt: now.toISOString(),
    withSecrets,
    withWorkspace,
    ...(opts.storageBackend ? { storageBackend: opts.storageBackend } : {}),
    excluded: patterns,
    entries,
    contentChecksum: computeContentChecksum(entries),
    dataDir,
  };

  if (live) {
    log(
      'Предупреждение: --live — снятие с работающего сервиса; каждый файл валиден, но срез не транзакционный (возможна межсущностная несогласованность).',
    );
  } else {
    log(
      'Предупреждение: корректный бэкап снимается при остановленном сервисе (или из read-only-снапшота).',
    );
  }
  if (withSecrets) {
    log('Предупреждение: архив содержит секреты; храните его как секрет (0600, вне публичных мест).');
  }
  if (opts.storageBackend === 'postgres') {
    log(
      'Предупреждение: backend=postgres — архив каталога данных НЕ содержит сессий, проектов, ' +
        'настроек и секретов, хранящихся в БД. Для полного бэкапа данных используйте pg_dump ' +
        '(например: pg_dump -Fc -f synth.dump <db>) и восстановление через pg_restore/PITR; ' +
        'этот архив покрывает только файловый периметр (secrets/…, workspaces/…, meta.json, backups/…).',
    );
  }

  await mkdir(dirname(outPath), { recursive: true });
  await writeTarGz(outPath, sources, {
    extraFile: {
      path: 'manifest.json',
      content: Buffer.from(JSON.stringify(manifest, null, 2), 'utf-8'),
    },
  });
  await chmod(outPath, 0o600);

  // ADR-091: шифрование архива внешним ключом оператора. Плейнтекст-архив
  // удаляется; рядом кладётся sidecar-метаданные (без путей/хешей).
  if (opts.encrypt) {
    if (!opts.encryptKey) {
      throw new BackupEncryptionError('Не задан ключ шифрования бэкапа');
    }
    const encPath = encryptedArchivePath(outPath);
    await encryptArchiveToFile(outPath, encPath, opts.encryptKey);
    await chmod(encPath, 0o600);
    await rm(outPath, { force: true });
    await writeFile(
      encryptedMetaPath(encPath),
      Buffer.from(JSON.stringify(buildEncryptedMeta(manifest), null, 2), 'utf-8'),
      { mode: 0o600 },
    );
    await chmod(encryptedMetaPath(encPath), 0o600);
    const encBytes = (await stat(encPath)).size;
    return { path: encPath, manifest, bytes: encBytes, encrypted: true };
  }

  const bytes = (await stat(outPath)).size;
  return { path: outPath, manifest, bytes, encrypted: false };
}

/**
 * Создаёт архив каталога данных (ADR-091) и best-effort фиксирует событие в
 * аудит-журнале обслуживания (ADR-092): `backup.created` при успехе,
 * `backup.failed` при ошибке. Ошибка аудит-порта не ломает бэкап.
 */
export async function createBackup(opts: CreateBackupOptions): Promise<CreateBackupResult> {
  try {
    const result = await _createBackup(opts);
    await recordMaintenanceAudit(opts.audit, {
      op: 'backup.created',
      status: 'ok',
      actor: opts.actor,
      details: {
        name: basename(result.path),
        bytes: result.bytes,
        entries: result.manifest.entries.length,
        withSecrets: result.manifest.withSecrets,
        withWorkspace: result.manifest.withWorkspace,
        live: !!opts.live,
        encrypted: result.encrypted,
        ...(result.manifest.storageBackend ? { storageBackend: result.manifest.storageBackend } : {}),
        dataDir: resolve(opts.dataDir),
      },
    });
    return result;
  } catch (err) {
    await recordMaintenanceAudit(opts.audit, {
      op: 'backup.failed',
      status: 'failed',
      actor: opts.actor,
      details: { dataDir: resolve(opts.dataDir) },
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/**
 * Тело CLI-команды `synth backup` (ADR-091): снимает архив и печатает сводку.
 *
 * @returns код выхода процесса (0 — успех, 1 — ошибка).
 */
export async function runBackupCommand(opts: BackupCommandOptions): Promise<number> {
  const log = opts.log ?? ((msg: string) => console.log(msg));
  const error = opts.error ?? ((msg: string) => console.error(msg));
  try {
    // ADR-091: `--encrypt` требует внешний ключ (--key-file/env); значение ключа
    // не логируется. Резолв до записи → нет плейнтекст-архива при ошибке ключа.
    const encryptKey = opts.encrypt
      ? await resolveBackupKey({ keyFile: opts.keyFile, env: opts.env })
      : undefined;
    const result = await createBackup({
      ...opts,
      ...(encryptKey !== undefined ? { encryptKey } : {}),
      log,
      actor: opts.actor ?? 'cli',
    });
    log(`Бэкап создан: ${result.path}`);
    log(`  размер: ${result.bytes} Б`);
    log(`  записей: ${result.manifest.entries.length}`);
    log(`  секреты: ${result.manifest.withSecrets ? 'да' : 'нет'}`);
    log(`  workspace: ${result.manifest.withWorkspace ? 'да' : 'нет'}`);
    if (result.manifest.storageBackend) {
      log(`  backend: ${result.manifest.storageBackend}`);
    }
    log(`  шифрование: ${result.encrypted ? 'да' : 'нет'}`);
    log(`  контрольная сумма: ${result.manifest.contentChecksum}`);
    return 0;
  } catch (err) {
    error(`Ошибка бэкапа: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

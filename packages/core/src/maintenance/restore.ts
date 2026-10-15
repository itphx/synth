// PROP-091: `synth restore` — восстановление каталога данных из архива backup.
// Строгий порядок: манифест → формат → версия схемы → контрольные суммы →
// dry-run → подтверждение (`--yes`) → страховочная копия → извлечение.
import { createHash } from 'node:crypto';
import { chmod, mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { SCHEMA_VERSION } from '../storage/instance-meta.js';
import { ArchivePathError, readFileFromTarGz, readTarGz } from './archive.js';
import {
  computeContentChecksum,
  createBackup,
  formatBackupStamp,
  type BackupManifest,
} from './backup.js';

/** Расхождение контрольной суммы файла при проверке архива (PROP-091). */
export class BackupChecksumError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(`Контрольная сумма не совпадает: ${path}`);
    this.name = 'BackupChecksumError';
    this.path = path;
  }
}

/** Опции `restoreBackup` (PROP-091). */
export interface RestoreOptions {
  /** Путь к архиву backup. */
  archive: string;
  /** Каталог данных (цель восстановления). */
  dataDir: string;
  /** Предпросмотр: проверить архив и показать план без записи. */
  dryRun?: boolean;
  /** Создать страховочную копию текущих данных (по умолчанию — да). */
  safetyCopy?: boolean;
  /** Канал вывода (по умолчанию — тихий). */
  log?: (msg: string) => void;
}

/** Опции CLI-команды `synth restore` (PROP-091). */
export interface RestoreCommandOptions extends RestoreOptions {
  /** Подтверждение перезаписи данных (обязательно без `--dry-run`). */
  yes?: boolean;
  /** Отключить страховочную копию (`--no-safety-copy`). */
  noSafetyCopy?: boolean;
  /** Канал ошибок (по умолчанию `console.error`). */
  error?: (msg: string) => void;
}

/** Читает и валидирует манифест архива. */
async function _readManifest(archive: string): Promise<BackupManifest> {
  const buffer = await readFileFromTarGz(archive, 'manifest.json');
  if (!buffer) {
    throw new Error('Архив не содержит manifest.json — это не бэкап Synth.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(buffer.toString('utf-8'));
  } catch {
    throw new Error('manifest.json невалиден (не JSON).');
  }
  const manifest = parsed as BackupManifest;
  if (!manifest || manifest.tool !== 'synth-backup') {
    throw new Error('Архив не является бэкапом Synth (неверный tool в манифесте).');
  }
  if (typeof manifest.formatVersion !== 'number' || manifest.formatVersion > 1) {
    throw new Error(`Неподдерживаемая версия формата архива: ${String(manifest.formatVersion)}.`);
  }
  if (!Array.isArray(manifest.entries)) {
    throw new Error('manifest.json невалиден: отсутствует список записей.');
  }
  return manifest;
}

/** Проверяет контрольные суммы манифеста и содержимого архива (до любой записи). */
async function _verifyArchive(archive: string, manifest: BackupManifest): Promise<void> {
  const recomputed = computeContentChecksum(manifest.entries);
  if (recomputed !== manifest.contentChecksum) {
    throw new Error('Контрольная сумма манифеста (contentChecksum) не совпадает с его записями.');
  }

  const expected = new Map<string, string>();
  for (const entry of manifest.entries) {
    if (entry.type === 'file' && typeof entry.sha256 === 'string') {
      expected.set(entry.path, entry.sha256);
    }
  }

  const seen = new Set<string>();
  try {
    await readTarGz(archive, (entry) => {
      if (entry.type !== 'file' || entry.path === 'manifest.json') return;
      const want = expected.get(entry.path);
      if (!want) return;
      const got = createHash('sha256').update(entry.content).digest('hex');
      if (got !== want) throw new BackupChecksumError(entry.path);
      seen.add(entry.path);
    });
  } catch (err) {
    if (err instanceof BackupChecksumError || err instanceof ArchivePathError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Проверка контрольной суммы архива не удалась: ${msg}`);
  }

  for (const path of expected.keys()) {
    if (!seen.has(path)) throw new BackupChecksumError(path);
  }
}

/** Каталог не пуст (нет каталога/ошибка → `false`). */
async function _dirNotEmpty(dir: string): Promise<boolean> {
  try {
    return (await readdir(dir)).length > 0;
  } catch {
    return false;
  }
}

/** Путь назначения внутри `dataDir` (containment). */
function _safeTarget(dataDir: string, relPath: string): string {
  const target = resolve(dataDir, relPath);
  if (target !== dataDir && !target.startsWith(dataDir + sep)) {
    throw new ArchivePathError(relPath);
  }
  return target;
}

/**
 * Восстанавливает каталог данных из архива backup (PROP-091).
 *
 * Без `--dry-run` (и без подтверждения на уровне CLI) перезаписывает данные;
 * перед записью при непустом `dataDir` создаётся страховочная копия.
 *
 * @throws Error если архив невалиден, из более новой схемы или повреждён.
 */
export async function restoreBackup(opts: RestoreOptions): Promise<{
  restored: number;
  safetyCopyPath?: string;
  manifest: BackupManifest;
}> {
  const log = opts.log ?? ((): void => {});
  const archive = resolve(opts.archive);
  const dataDir = resolve(opts.dataDir);
  const dryRun = !!opts.dryRun;
  const safetyCopy = opts.safetyCopy !== false;

  // 1–2. Манифест и формат.
  const manifest = await _readManifest(archive);

  // 3. Версия схемы.
  if (manifest.schemaVersion > SCHEMA_VERSION) {
    throw new Error(
      `Архив из более новой версии Synth (схема ${manifest.schemaVersion} > ${SCHEMA_VERSION}); обновите Synth.`,
    );
  }
  const schemaOlder = manifest.schemaVersion < SCHEMA_VERSION;
  const fileCount = manifest.entries.filter((entry) => entry.type === 'file').length;

  // 4. Контрольные суммы — до любой записи.
  await _verifyArchive(archive, manifest);

  // 5. Предпросмотр.
  if (dryRun) {
    log(`[dry-run] Восстановление из ${archive} в ${dataDir}`);
    log(`  схема архива: ${manifest.schemaVersion} (текущая ${SCHEMA_VERSION})`);
    log(`  версия пакета в архиве: ${manifest.instanceVersion}`);
    log(`  секреты: ${manifest.withSecrets ? 'да' : 'нет'}`);
    log(`  файлов к восстановлению: ${fileCount}`);
    if (schemaOlder) log('  предупреждение: схема старше — после восстановления выполните `synth migrate`');
    log('  (dry-run: изменения не записаны)');
    return { restored: fileCount, manifest };
  }

  // 7. Страховочная копия текущих данных (до перезаписи).
  let safetyCopyPath: string | undefined;
  if (safetyCopy && (await _dirNotEmpty(dataDir))) {
    const parent = dirname(dataDir);
    const out = join(parent, `synth-pre-restore-${formatBackupStamp(new Date())}.tar.gz`);
    const copy = await createBackup({ dataDir, out, withSecrets: true });
    safetyCopyPath = copy.path;
    log(`Страховочная копия: ${copy.path}`);
  }

  // 8. Извлечение (перезапись; каталоги — mkdir -p, права — из записи).
  await mkdir(dataDir, { recursive: true });
  let restored = 0;
  await readTarGz(archive, async (entry) => {
    if (entry.path === 'manifest.json') return;
    const target = _safeTarget(dataDir, entry.path);
    const isSecret = entry.path === 'secrets' || entry.path.startsWith('secrets/');
    if (entry.type === 'dir') {
      await mkdir(target, { recursive: true });
      const dirMode = entry.mode & 0o777;
      if (dirMode > 0) await chmod(target, dirMode);
      return;
    }
    await mkdir(dirname(target), { recursive: true });
    const baseMode = entry.mode & 0o777;
    const mode = isSecret ? Math.max(baseMode, 0o600) : baseMode || 0o600;
    await writeFile(target, entry.content, { mode });
    await chmod(target, mode);
    restored += 1;
  });

  // 9. Итог.
  log(`Восстановлено файлов: ${restored}`);
  if (safetyCopyPath) log(`  страховочная копия: ${safetyCopyPath}`);
  log('Напоминание: выполните `synth doctor` (проверка после восстановления).');
  if (schemaOlder) log('Напоминание: схема старше — выполните `synth migrate`.');

  return { restored, safetyCopyPath, manifest };
}

/**
 * Тело CLI-команды `synth restore` (PROP-091). Без `--dry-run` и без `--yes` —
 * отказ («перезапись данных»). Проверка архива выполняется всегда.
 *
 * @returns код выхода процесса (0 — успех, 1 — отказ/ошибка).
 */
export async function runRestoreCommand(opts: RestoreCommandOptions): Promise<number> {
  const log = opts.log ?? ((msg: string) => console.log(msg));
  const error = opts.error ?? ((msg: string) => console.error(msg));
  const dryRun = !!opts.dryRun;

  if (!dryRun && !opts.yes) {
    error(
      'Ошибка: восстановление перезаписывает данные. Используйте --dry-run для проверки или --yes для применения.',
    );
    return 1;
  }

  try {
    await restoreBackup({
      archive: opts.archive,
      dataDir: opts.dataDir,
      dryRun,
      safetyCopy: !opts.noSafetyCopy,
      log,
    });
    return 0;
  } catch (err) {
    error(`Ошибка восстановления: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

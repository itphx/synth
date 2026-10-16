// ADR-091: `synth restore` — восстановление каталога данных из архива backup.
// Строгий порядок: манифест → формат → версия схемы → контрольные суммы →
// dry-run → подтверждение (`--yes`) → страховочная копия → очистка цели →
// извлечение. Восстановление — возврат к снимку: данные, появившиеся после
// бэкапа и отсутствующие в архиве, удаляются.
import { createHash } from 'node:crypto';
import { chmod, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { SCHEMA_VERSION } from '../storage/instance-meta.js';
import type { MaintenanceAuditRepository } from '../storage/ports/maintenance-audit-repository.js';
import { ArchivePathError, readFileFromTarGz, readTarGz } from './archive.js';
import {
  computeContentChecksum,
  createBackup,
  safetyCopyPath,
  type BackupManifest,
} from './backup.js';
import { recordMaintenanceAudit } from './audit.js';

/** Расхождение контрольной суммы файла при проверке архива (ADR-091). */
export class BackupChecksumError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(`Контрольная сумма не совпадает: ${path}`);
    this.name = 'BackupChecksumError';
    this.path = path;
  }
}

/** Каталог страховочных копий — сохраняется при возврате к снимку (ADR-092). */
const BACKUPS_DIR = 'backups';

/**
 * Каталог рабочих файлов проектов. В бэкап по умолчанию не входит
 * (`workspaces/` исключается без `--with-workspace`), поэтому при восстановлении
 * такого архива его нельзя удалять — иначе рабочие файлы проектов потерялись бы
 * безвозвратно (ADR-091).
 */
const WORKSPACES_DIR = 'workspaces';

/** Опции `restoreBackup` (ADR-091). */
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
  /** Канал предупреждений (по умолчанию — тихий; CLI передаёт stderr). */
  warn?: (msg: string) => void;
  /** ADR-092: аудит-журнал обслуживания (best-effort; ошибка записи не ломает операцию). */
  audit?: MaintenanceAuditRepository;
  /** ADR-092: инициатор операции (`'cli'` | `userId`). */
  actor?: string;
}

/** Опции CLI-команды `synth restore` (ADR-091). */
export interface RestoreCommandOptions extends RestoreOptions {
  /** Подтверждение перезаписи данных (обязательно без `--dry-run`). */
  yes?: boolean;
  /** Отключить страховочную копию (`--no-safety-copy`). */
  noSafetyCopy?: boolean;
  /** Канал ошибок (по умолчанию `console.error`). */
  error?: (msg: string) => void;
}

/**
 * Читает и валидирует манифест архива (ADR-091). Общий хелпер для
 * `restoreBackup` и сервисного слоя (`validateRestoreArchive`, ADR-091/092) —
 * без дублирования проверок формата.
 */
export async function readBackupManifest(archive: string): Promise<BackupManifest> {
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

/**
 * Проверяет контрольные суммы манифеста и содержимого архива (до любой записи).
 * Общий хелпер для `restoreBackup` и сервисного слоя (ADR-091/092).
 */
export async function verifyBackupArchive(
  archive: string,
  manifest: BackupManifest,
): Promise<void> {
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

/**
 * Guard совместимости схемы архива (ADR-092): архив из более новой схемы, чем
 * `SCHEMA_VERSION`, восстанавливать нельзя — понижение версии не мигрирует назад.
 * Общий хелпер для `restoreBackup` и сервисного слоя (ADR-091/092).
 *
 * @throws Error если `manifest.schemaVersion > SCHEMA_VERSION`.
 */
export function assertArchiveSchemaCompatible(manifest: BackupManifest): void {
  if (manifest.schemaVersion > SCHEMA_VERSION) {
    throw new Error(
      `Архив из более новой версии Synth (схема ${manifest.schemaVersion} > ${SCHEMA_VERSION}); обновите Synth.`,
    );
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

/** Элементы верхнего уровня каталога (каталога нет → пустой список). */
async function _listTopLevel(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

/**
 * Содержит ли архив записи под `workspaces/` (файл/каталог `workspaces` или
 * его поддерево). Только такой архив вправе заменить `workspaces/` при
 * восстановлении; иначе каталог сохраняется (ADR-091) — бэкап без
 * `--with-workspace` его не содержит, и восстановить было бы нечего.
 */
function _archiveContainsWorkspaces(manifest: BackupManifest): boolean {
  return manifest.entries.some(
    (entry) => entry.path === WORKSPACES_DIR || entry.path.startsWith(`${WORKSPACES_DIR}/`),
  );
}

/**
 * Возврат к снимку: удаляет **все** элементы верхнего уровня в `dir`, кроме
 * перечисленных в `keep` (`backups/` — страховочная копия; `workspaces/`, если
 * архив его не содержит). Каталог отсутствует — просто создаётся. Ошибки
 * удаления не глотаются (`rm` с `force` игнорирует лишь ENOENT).
 */
async function _resetDataDir(
  dir: string,
  keep: ReadonlySet<string>,
): Promise<{ removed: number; names: string[] }> {
  const names = (await _listTopLevel(dir)).filter((name) => !keep.has(name));
  await mkdir(dir, { recursive: true });
  for (const name of names) {
    await rm(join(dir, name), { recursive: true, force: true });
  }
  return { removed: names.length, names };
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
 * Восстанавливает каталог данных из архива backup (ADR-091).
 *
 * Восстановление — **возврат к снимку**: перед распаковкой все элементы верхнего
 * уровня в `dataDir` удаляются (данные, появившиеся после бэкапа и отсутствующие
 * в архиве, а также повреждённые файлы), кроме `backups/` — только что созданной
 * страховочной копии — и `workspaces/`, если архив его **не** содержит: `workspaces/`
 * не входит в бэкап по умолчанию (без `--with-workspace`) и при восстановлении
 * сохраняется, иначе рабочие файлы проектов потерялись бы безвозвратно. Архив,
 * снятый с `--with-workspace`, `workspaces/` заменяет (обычная семантика снимка).
 * Страховочная копия создаётся автоматически; её можно
 * отключить `--no-safety-copy` (`safetyCopy: false`) — тогда откат восстановления
 * невозможен, и об этом выводится предупреждение в канал `warn`.
 *
 * Без `--dry-run` (и без подтверждения на уровне CLI) перезаписывает данные;
 * в `--dry-run` план (в т.ч. список удаляемых/сохраняемых элементов) печатается
 * без записи.
 *
 * @throws Error если архив невалиден, из более новой схемы или повреждён.
 */
export async function restoreBackup(opts: RestoreOptions): Promise<{
  restored: number;
  removed: number;
  safetyCopyPath?: string;
  manifest: BackupManifest;
}> {
  try {
    const result = await _restoreBackup(opts);
    // Предпросмотр не меняет данные — событие не фиксируется.
    if (!opts.dryRun) {
      await recordMaintenanceAudit(opts.audit, {
        op: 'restore.applied',
        status: 'ok',
        actor: opts.actor,
        details: {
          archive: resolve(opts.archive),
          restored: result.restored,
          removed: result.removed,
          ...(result.safetyCopyPath !== undefined ? { safetyCopy: result.safetyCopyPath } : {}),
          removedWorkspaces: _archiveContainsWorkspaces(result.manifest),
        },
      });
    }
    return result;
  } catch (err) {
    await recordMaintenanceAudit(opts.audit, {
      op: 'restore.failed',
      status: 'failed',
      actor: opts.actor,
      details: { archive: resolve(opts.archive), dataDir: resolve(opts.dataDir) },
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/**
 * Внутренняя реализация восстановления (без аудита); вызывается из
 * `restoreBackup`, которая фиксирует событие `restore.applied`/`restore.failed`.
 */
async function _restoreBackup(opts: RestoreOptions): Promise<{
  restored: number;
  removed: number;
  safetyCopyPath?: string;
  manifest: BackupManifest;
}> {
  const log = opts.log ?? ((): void => {});
  const warn = opts.warn ?? ((): void => {});
  const archive = resolve(opts.archive);
  const dataDir = resolve(opts.dataDir);
  const dryRun = !!opts.dryRun;
  const safetyCopy = opts.safetyCopy !== false;

  // 1–2. Манифест и формат.
  const manifest = await readBackupManifest(archive);

  // 3. Версия схемы.
  assertArchiveSchemaCompatible(manifest);
  const schemaOlder = manifest.schemaVersion < SCHEMA_VERSION;
  const fileCount = manifest.entries.filter((entry) => entry.type === 'file').length;

  // 4. Контрольные суммы — до любой записи.
  await verifyBackupArchive(archive, manifest);

  // Сохраняемые элементы верхнего уровня: `backups/` всегда + `workspaces/`,
  // если архив его не содержит (бэкап без `--with-workspace`) — иначе потеряли
  // бы рабочие файлы проектов, которых в архиве нет.
  const keepWorkspaces = !_archiveContainsWorkspaces(manifest);
  const keep = new Set<string>([BACKUPS_DIR]);
  if (keepWorkspaces) keep.add(WORKSPACES_DIR);

  // 5. Предпросмотр.
  if (dryRun) {
    const stale = (await _listTopLevel(dataDir)).filter((name) => !keep.has(name));
    log(`[dry-run] Восстановление из ${archive} в ${dataDir}`);
    log(`  схема архива: ${manifest.schemaVersion} (текущая ${SCHEMA_VERSION})`);
    log(`  версия пакета в архиве: ${manifest.instanceVersion}`);
    log(`  секреты: ${manifest.withSecrets ? 'да' : 'нет'}`);
    log(`  файлов к восстановлению: ${fileCount}`);
    log(
      stale.length === 0
        ? '  очистка каталога: удалять нечего'
        : `  очистка каталога: будет удалено элементов — ${stale.length} (${stale.join(', ')})`,
    );
    log(`  ${BACKUPS_DIR}/ сохраняется (страховочная копия)`);
    if (keepWorkspaces) log(`  ${WORKSPACES_DIR}/ сохранён (в архиве отсутствует)`);
    if (schemaOlder) log('  предупреждение: схема старше — после восстановления выполните `synth migrate`');
    log('  (dry-run: изменения не записаны)');
    return { restored: fileCount, removed: 0, manifest };
  }

  // 7. Страховочная копия текущих данных (до перезаписи) — в единый каталог
  // `{dataDir}/backups/` (ADR-092), исключённый из архивов бэкапа.
  let safetyPath: string | undefined;
  if (safetyCopy && (await _dirNotEmpty(dataDir))) {
    const out = safetyCopyPath(dataDir, 'pre-restore');
    const copy = await createBackup({ dataDir, out, withSecrets: true });
    safetyPath = copy.path;
    log(`Страховочная копия: ${copy.path}`);
  }
  if (!safetyCopy) {
    warn(
      'Предупреждение: --no-safety-copy — страховочная копия не создана; откат восстановления невозможен.',
    );
  }

  // 8. Очистка цели (возврат к снимку): удаляются все элементы верхнего уровня,
  // кроме `backups/` (страховочная копия) и `workspaces/`, если его нет в архиве;
  // повреждённые/лишние файлы не переживут restore.
  const reset = await _resetDataDir(dataDir, keep);
  log(`Очистка каталога данных: удалено элементов — ${reset.removed}`);
  if (reset.removed > 0) log(`  удалено: ${reset.names.join(', ')}`);
  log(`  ${BACKUPS_DIR}/ сохранён (страховочная копия)`);
  if (keepWorkspaces) log(`  ${WORKSPACES_DIR}/ сохранён (в архиве отсутствует)`);

  // 9. Извлечение (перезапись; каталоги — mkdir -p, права — из записи).
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

  // 10. Итог.
  log(`Восстановлено файлов: ${restored}`);
  log(`  удалено лишних файлов/каталогов: ${reset.removed}`);
  if (keepWorkspaces) log(`  ${WORKSPACES_DIR}/ сохранён (в архиве отсутствует)`);
  if (safetyPath) log(`  страховочная копия: ${safetyPath}`);
  log('Напоминание: выполните `synth doctor` (проверка после восстановления).');
  if (schemaOlder) log('Напоминание: схема старше — выполните `synth migrate`.');

  return { restored, removed: reset.removed, safetyCopyPath: safetyPath, manifest };
}

/**
 * Тело CLI-команды `synth restore` (ADR-091). Без `--dry-run` и без `--yes` —
 * отказ («перезапись данных»). Проверка архива выполняется всегда. Восстановление
 * возвращает каталог к снимку (лишние файлы удаляются; `backups/` сохраняется,
 * `workspaces/` — если его нет в архиве);
 * при `--no-safety-copy` откат невозможен — предупреждение идёт в stderr.
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
      warn: error,
      audit: opts.audit,
      actor: opts.actor ?? 'cli',
    });
    return 0;
  } catch (err) {
    error(`Ошибка восстановления: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

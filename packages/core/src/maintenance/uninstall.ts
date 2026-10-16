// ADR-092: `synth uninstall` — осознанное удаление инстанса.
//
// По умолчанию данные **сохраняются** (печатается сводка, что осталось и где);
// `--purge` удаляет каталог данных (требует `--yes`), `--dry-run` показывает
// план без записи. Для локального home (ADR-079) после удаления сообщаем, что
// `{home}/config.yaml`/`profiles.json`/`credentials.json` остаются.
//
// Аудит-событие `uninstall.purge` фиксируется до удаления каталога (ADR-092);
// при `--purge` запись журнала удаляется вместе с каталогом — внешний audit-sink
// остаётся остатком ADR-092.
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { readInstanceMeta } from '../storage/instance-meta.js';
import type { MaintenanceAuditRepository } from '../storage/ports/maintenance-audit-repository.js';
import { masterKeyFilePath } from '../security/crypto.js';
import { recordMaintenanceAudit } from './audit.js';

/** Опции CLI-команды `synth uninstall` (ADR-092). */
export interface UninstallCommandOptions {
  /** Каталог данных инстанса (резолвится CLI: `--data-dir`/`--home`/config). */
  dataDir: string;
  /** Локальный home-каталог (ADR-079): его файлы перечисляются после удаления. */
  home?: string;
  /** Удалить каталог данных (необратимо; требует `--yes`). */
  purge?: boolean;
  /** Показать план без удаления. */
  dryRun?: boolean;
  /** Подтверждение необратимого удаления. */
  yes?: boolean;
  /** Канал вывода (по умолчанию `console.log`). */
  log?: (msg: string) => void;
  /** Канал ошибок (по умолчанию `console.error`). */
  error?: (msg: string) => void;
  /** ADR-092: аудит-журнал обслуживания (best-effort). */
  audit?: MaintenanceAuditRepository;
}

/** Сводка каталога данных (ADR-092): что сохраняется/будет удалено. */
export interface UninstallSummary {
  dataDir: string;
  /** Каталог данных существует. */
  exists: boolean;
  /** Суммарный размер файлов дерева (байт). */
  bytes: number;
  /** Число сессий (`{dataDir}/sessions/*.json`). */
  sessions: number;
  /** Число проектов (`{dataDir}/projects/*.json`). */
  projects: number;
  /** Каталог `secrets/` присутствует. */
  hasSecretsDir: boolean;
  /** Мастер-ключ `secrets/master.key` присутствует в удаляемом каталоге. */
  hasMasterKey: boolean;
  /** Есть `meta.json`. */
  hasMeta: boolean;
  /** Версия схемы из `meta.json` (нет — 0). */
  schemaVersion: number;
  /** Число страховочных копий в `backups/`. */
  safetyCopies: number;
}

/** Человекочитаемый размер (КиБ/МиБ/ГиБ). */
function _humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  const units = ['КиБ', 'МиБ', 'ГиБ', 'ТиБ'];
  let value = bytes / 1024;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  return `${value.toFixed(1)} ${units[idx]}`;
}

/** Рекурсивный размер файлов дерева (симлинки/ошибки пропускаются). */
async function _dirSize(dir: string): Promise<number> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await _dirSize(full);
    } else if (entry.isFile()) {
      try {
        total += (await stat(full)).size;
      } catch {
        // Файл исчез между readdir и stat — не считаем.
      }
    }
  }
  return total;
}

/** Число `.json`-файлов верхнего уровня (нет каталога → 0). */
async function _countJson(dir: string): Promise<number> {
  try {
    return (await readdir(dir)).filter((name) => name.endsWith('.json') && !name.startsWith('.')).length;
  } catch {
    return 0;
  }
}

/** Число архивов `*.tar.gz` в каталоге (нет каталога → 0). */
async function _countArchives(dir: string): Promise<number> {
  try {
    return (await readdir(dir)).filter((name) => name.endsWith('.tar.gz')).length;
  } catch {
    return 0;
  }
}

/** Файл/каталог существует. */
async function _exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Собирает сводку каталога данных (ADR-092). */
export async function collectUninstallSummary(dataDir: string): Promise<UninstallSummary> {
  const meta = await readInstanceMeta(dataDir);
  return {
    dataDir,
    exists: await _exists(dataDir),
    bytes: await _dirSize(dataDir),
    sessions: await _countJson(join(dataDir, 'sessions')),
    projects: await _countJson(join(dataDir, 'projects')),
    hasSecretsDir: await _exists(join(dataDir, 'secrets')),
    hasMasterKey: await _exists(masterKeyFilePath(dataDir)),
    hasMeta: meta !== null,
    schemaVersion: meta?.schemaVersion ?? 0,
    safetyCopies: await _countArchives(join(dataDir, 'backups')),
  };
}

/** Рендерит сводку (по строке на факт). */
function _renderSummary(summary: UninstallSummary): string[] {
  return [
    `Каталог данных: ${summary.dataDir}${summary.exists ? '' : ' (не найден)'}`,
    `  размер на диске: ${_humanBytes(summary.bytes)}`,
    `  сессий: ${summary.sessions}, проектов: ${summary.projects}`,
    `  secrets/: ${summary.hasSecretsDir ? 'есть' : 'нет'}${summary.hasMasterKey ? ' (master.key)' : ''}`,
    `  версия схемы: ${summary.hasMeta ? summary.schemaVersion : 'нет meta.json (0)'}`,
    `  страховочных копий в backups/: ${summary.safetyCopies}`,
  ];
}

/**
 * Тело CLI-команды `synth uninstall` (ADR-092).
 *
 * @returns код выхода процесса (0 — успех/dry-run, 1 — отказ/ошибка).
 */
export async function runUninstallCommand(opts: UninstallCommandOptions): Promise<number> {
  const log = opts.log ?? ((msg: string) => console.log(msg));
  const error = opts.error ?? ((msg: string) => console.error(msg));
  const home = opts.home;
  const purge = !!opts.purge;
  const dryRun = !!opts.dryRun;
  const dataDir = opts.dataDir;

  const summary = await collectUninstallSummary(dataDir);

  log(`Synth uninstall${dryRun ? ' [dry-run]' : ''}: ${purge ? 'удаление каталога данных (--purge)' : 'данные сохраняются'}`);
  for (const line of _renderSummary(summary)) log(line);

  // Без --purge: данные остаются. Явная подсказка, как удалить.
  if (!purge) {
    log('');
    log('Данные не удалены; удалить — --purge (необратимо, требует --yes).');
    if (dryRun) log('(dry-run: изменения не записаны)');
    return 0;
  }

  // --dry-run: показать, что было бы удалено, ничего не удалять.
  if (dryRun) {
    log('');
    log(`[dry-run] Было бы удалено: ${dataDir} (полностью, рекурсивно)`);
    log('(dry-run: изменения не записаны)');
    return 0;
  }

  // --purge без --yes — отказ (необратимо).
  if (!opts.yes) {
    error('Ошибка: удаление данных необратимо; используйте --dry-run для просмотра или --yes.');
    return 1;
  }

  // Предупреждения перед необратимым удалением.
  if (summary.hasMasterKey) {
    log('');
    log(
      '⚠️ Мастер-ключ secrets/master.key находится в удаляемом каталоге: без него ' +
        'зашифрованные SSH-ключи невосстановимы. Если они нужны — сохраните мастер-ключ вне каталога.',
    );
  }
  if (summary.safetyCopies > 0) {
    log(
      `⚠️ Страховочные копии в backups/ (${summary.safetyCopies}) тоже будут удалены. ` +
        'Если они нужны — скопируйте их заранее.',
    );
  }

  // ADR-092: аудит-событие фиксируется ДО удаления каталога — журнал лежит
  // внутри удаляемого дерева (`{dataDir}/audit/maintenance.jsonl`).
  await recordMaintenanceAudit(opts.audit, {
    op: 'uninstall.purge',
    status: 'ok',
    actor: 'cli',
    details: {
      dataDir,
      sessions: summary.sessions,
      projects: summary.projects,
      sizeBytes: summary.bytes,
    },
  });
  log('');
  log(`Аудит-событие uninstall.purge записано в ${join(dataDir, 'audit', 'maintenance.jsonl')}`);
  log(
    '⚠️ При --purge запись журнала удаляется вместе с каталогом данных; для сохранности ' +
      'аудита вне инстанса нужен внешний audit-sink (остаток ADR-092).',
  );

  try {
    await rm(dataDir, { recursive: true, force: true });
  } catch (err) {
    error(`Ошибка удаления ${dataDir}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  log('');
  log(`Каталог данных удалён: ${dataDir}`);

  // Локальный home (ADR-079): config/profiles/credentials остаются.
  if (home) {
    const candidates = ['config.yaml', 'profiles.json', 'credentials.json'];
    const present: string[] = [];
    for (const name of candidates) {
      const path = join(home, name);
      if (await _exists(path)) present.push(path);
    }
    log('');
    if (present.length > 0) {
      log(`Локальный home (${home}): следующие файлы остаются — удалить вручную при необходимости:`);
      for (const path of present) log(`  ${path}`);
    } else {
      log(`Локальный home (${home}): файлы config/profiles/credentials отсутствуют.`);
    }
  }

  return 0;
}

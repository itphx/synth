// ADR-092: тело CLI-команды `synth migrate` — переиспользуется dev-CLI
// (`packages/core/src/main.ts`) и публичным `synth` (`packages/synth/src/cli.ts`).
import {
  MIGRATIONS,
  checkInstanceCompatibility,
  runMigrations,
} from '../storage/instance-meta.js';
import type { MaintenanceAuditRepository } from '../storage/ports/maintenance-audit-repository.js';
import { createStorageContextAsync, type StorageContext } from '../storage/storage-context.js';
import { SessionManager } from '../sessions/manager.js';
import { recordMaintenanceAudit } from './audit.js';

/** Опции команды `synth migrate`. */
export interface MigrateCommandOptions {
  dataDir: string;
  /** Предпросмотр: показать план, ничего не писать. */
  dryRun?: boolean;
  /** Подтверждение необратимой миграции (обязательно без `--dry-run`). */
  yes?: boolean;
  /** Канал вывода (по умолчанию `console.log`). */
  log?: (msg: string) => void;
  /** Канал ошибок (по умолчанию `console.error`). */
  error?: (msg: string) => void;
  /** ADR-092: аудит-журнал обслуживания (best-effort). */
  audit?: MaintenanceAuditRepository;
  /**
   * PROP-032: готовый контекст хранения (иначе собирается `file`-контекст) —
   * чтобы миграции работали на выбранном backend (напр. `postgres`).
   */
  storage?: StorageContext;
}

/**
 * Выполняет `synth migrate`: без `--dry-run` и без `--yes` — отказ; `--dry-run` —
 * план; иначе применяет pending-миграции и пишет `{dataDir}/meta.json`.
 *
 * @returns код выхода процесса (0 — успех, 1 — отказ/ошибка).
 */
export async function runMigrateCommand(opts: MigrateCommandOptions): Promise<number> {
  const { dataDir, dryRun = false, yes = false } = opts;
  const log = opts.log ?? ((msg: string) => console.log(msg));
  const error = opts.error ?? ((msg: string) => console.error(msg));

  if (!dryRun && !yes) {
    error(
      'Ошибка: миграция изменяет данные необратимо. Используйте --dry-run для предпросмотра или --yes для применения.',
    );
    return 1;
  }

  const compatibility = await checkInstanceCompatibility(dataDir);
  log(`${dryRun ? '[dry-run] ' : ''}Миграция схемы данных (${dataDir})`);
  log(`  текущая версия схемы: ${compatibility.currentVersion}`);
  log(`  ожидаемая версия: ${compatibility.expectedVersion}`);

  if (compatibility.status === 'too-new') {
    error(
      `Ошибка: данные новее версии Synth (схема ${compatibility.currentVersion} > ${compatibility.expectedVersion}); обновите Synth.`,
    );
    return 1;
  }

  if (compatibility.pending.length === 0) {
    log('  нечего применять');
    return 0;
  }

  if (dryRun) {
    log(`  план (${compatibility.pending.length}):`);
    for (const migration of compatibility.pending) {
      log(`    - ${migration.id} (v${migration.toVersion}): ${migration.description}`);
    }
    log('  (dry-run: изменения не записаны)');
    return 0;
  }

  // Дефолтные зависимости данных инстанса: сессии/проекты/маркеры миграций.
  // PROP-032: готовый контекст (любой backend) либо дефолтный `file`-контекст.
  const storage = opts.storage ?? (await createStorageContextAsync('file', { dataDir }));
  const deps = {
    settingsStore: storage.settings,
    sessionManager: new SessionManager(storage.sessions),
    projectStore: storage.projects,
  };

  try {
    const result = await runMigrations({ dataDir, deps, log: (msg) => log(`  ${msg}`) });
    log(`  применено миграций: ${result.applied.length}`);
    for (const id of result.applied) {
      const migration = MIGRATIONS.find((m) => m.id === id);
      log(`    - ${id}${migration ? `: ${migration.description}` : ''}`);
    }
    log(`  обновлённых записей: ${result.updated}`);
    if (result.applied.length > 0) {
      await recordMaintenanceAudit(opts.audit, {
        op: 'migrate.applied',
        status: 'ok',
        actor: 'cli',
        details: {
          from: compatibility.currentVersion,
          to: compatibility.expectedVersion,
          applied: result.applied,
          trigger: 'cli',
        },
      });
    }
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordMaintenanceAudit(opts.audit, {
      op: 'migrate.failed',
      status: 'failed',
      actor: 'cli',
      details: { dataDir, trigger: 'cli' },
      error: message,
    });
    error(`Ошибка миграции: ${message}`);
    return 1;
  }
}

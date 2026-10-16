/**
 * ADR-092 (остаток): аудит-журнал обслуживания инстанса.
 *
 * Append-only журнал операций жизненного цикла (`synth backup`/`restore`/
 * `migrate`/`update`/`rollback`/`uninstall`, экспорт/импорт) — «что, когда и
 * кем» менялось в инстансе. Журнал не является частью доменных данных: его
 * события лишь фиксируют факт операции и её итог. Хранилище — доменный порт
 * `MaintenanceAuditRepository` (ADR-096), файловая реализация —
 * `{dataDir}/audit/maintenance.jsonl`.
 */

/** ADR-092: вид операции обслуживания инстанса. */
export type MaintenanceAuditOp =
  | 'backup.created'
  | 'backup.failed'
  | 'restore.scheduled'
  | 'restore.cancelled'
  | 'restore.applied'
  | 'restore.failed'
  | 'migrate.applied'
  | 'migrate.failed'
  | 'update.applied'
  | 'rollback.applied'
  | 'update.failed'
  | 'uninstall.purge'
  | 'export.created'
  | 'import.applied';

/** ADR-092: итог операции обслуживания. */
export type MaintenanceAuditStatus = 'ok' | 'failed' | 'scheduled';

/**
 * ADR-092: одна запись аудит-журнала обслуживания инстанса.
 *
 * Пишется best-effort (ошибка записи не ломает операцию). `id` формирует
 * вызывающий (`ma_<uuid>`), `ts` — ISO-8601. `actor` — инициатор (`userId` при
 * API/UI, `'cli'` при командной строке, `'startup'` при применении на старте).
 */
export interface MaintenanceAuditEntry {
  /** `ma_<uuid>`, уникален в пределах инстанса. */
  id: string;
  /** Метка события, ISO-8601. */
  ts: string;
  /** Вид операции обслуживания. */
  op: MaintenanceAuditOp;
  /** Итог операции. */
  status: MaintenanceAuditStatus;
  /** Инициатор: `userId` (API/UI) | `'cli'` | `'startup'`. */
  actor?: string;
  /** Версия пакета (`SYNTH_VERSION`) на момент операции. */
  version?: string;
  /** Детали операции (поля зависят от `op`). */
  details?: Record<string, unknown>;
  /** Текст ошибки при `status === 'failed'`. */
  error?: string;
}

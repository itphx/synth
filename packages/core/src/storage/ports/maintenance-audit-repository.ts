import type { MaintenanceAuditEntry, MaintenanceAuditOp } from '@itphx/synth-shared';

/** Опции выборки записей аудит-журнала обслуживания (ADR-092). */
export interface MaintenanceAuditListOptions {
  /** Вернуть последние N записей (самые новые). */
  limit?: number;
  /** Фильтр по виду операции. */
  op?: MaintenanceAuditOp;
}

/**
 * Порт append-only аудит-журнала обслуживания инстанса (ADR-092, реализация —
 * `MaintenanceAuditStore`).
 *
 * Записи неизменяемы, `id`/`ts` формирует вызывающий. `list` отдаёт записи
 * «свежие первыми» (новые → старые).
 */
export interface MaintenanceAuditRepository {
  /** Дозапись одного события журнала. */
  append(entry: MaintenanceAuditEntry): Promise<void>;
  /**
   * Записи «свежие первыми» (новые → старые); фильтр `op`, `limit` — последние N.
   * @future-backend — `WHERE op = ? ORDER BY ts DESC LIMIT ?`.
   */
  list(opts?: MaintenanceAuditListOptions): Promise<MaintenanceAuditEntry[]>;
  /** Полная очистка журнала; число удалённых записей. */
  clear(): Promise<number>;
}

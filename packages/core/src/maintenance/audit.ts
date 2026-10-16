// ADR-092 (остаток): запись аудит-событий обслуживания инстанса.
//
// Все операции жизненного цикла (`backup`/`restore`/`migrate`/`uninstall`)
// фиксируются в append-only журнале best-effort: ошибка аудит-порта никогда не
// ломает саму операцию (только `console.warn`). Порт — `MaintenanceAuditRepository`
// (ADR-096); `id`/`ts` формирует эта обёртка (`ma_<uuid>`), `version` —
// `SYNTH_VERSION`.
import { SYNTH_VERSION, generateId } from '@itphx/synth-shared';
import type { MaintenanceAuditOp, MaintenanceAuditStatus } from '@itphx/synth-shared';
import type { MaintenanceAuditRepository } from '../storage/ports/maintenance-audit-repository.js';

/** Поля аудит-события, которые заполняет вызывающая операция. */
export interface MaintenanceAuditRecord {
  op: MaintenanceAuditOp;
  status: MaintenanceAuditStatus;
  /** Инициатор: `userId` (API/UI) | `'cli'` | `'startup'`. */
  actor?: string;
  /** Детали операции (поля зависят от `op`). */
  details?: Record<string, unknown>;
  /** Текст ошибки при `status === 'failed'`. */
  error?: string;
}

/**
 * Записывает событие обслуживания best-effort: если порт не передан или запись
 * упала — предупреждение в `console.warn`, операция продолжается. Никогда не
 * бросает.
 */
export async function recordMaintenanceAudit(
  audit: MaintenanceAuditRepository | undefined,
  record: MaintenanceAuditRecord,
): Promise<void> {
  if (!audit) return;
  try {
    await audit.append({
      id: `ma_${generateId()}`,
      ts: new Date().toISOString(),
      op: record.op,
      status: record.status,
      ...(record.actor !== undefined ? { actor: record.actor } : {}),
      version: SYNTH_VERSION,
      ...(record.details !== undefined ? { details: record.details } : {}),
      ...(record.error !== undefined ? { error: record.error } : {}),
    });
  } catch (err) {
    console.warn(
      `[maintenance-audit] не удалось записать событие ${record.op}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

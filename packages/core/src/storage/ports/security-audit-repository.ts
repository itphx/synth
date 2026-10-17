import type { SecurityAuditEntry, SecurityAuditScope } from '@itphx/synth-shared';

/** Опции выборки записей аудита security-политик. */
export interface SecurityAuditListOptions {
  /** Вернуть последние N записей (самые новые). */
  limit?: number;
  /** Фильтр по скоупу политики (`tools`/`webhooks`/`mcp`). */
  scope?: SecurityAuditScope;
}

/**
 * Порт append-only аудита изменений egress/security-политик.
 *
 * Отдельный журнал от аудита обслуживания (ADR-092): записи неизменяемы,
 * `id`/`ts` формирует вызывающий; `list` отдаёт «свежие первыми». Запись —
 * best-effort: ошибка не ломает операцию изменения политики.
 */
export interface SecurityAuditRepository {
  /** Дозапись одного события. */
  append(entry: SecurityAuditEntry): Promise<void>;
  /** Записи «свежие первыми»; фильтр по `scope`, `limit` — последние N. */
  list(opts?: SecurityAuditListOptions): Promise<SecurityAuditEntry[]>;
  /** Полная очистка журнала; число удалённых записей. */
  clear(): Promise<number>;
}

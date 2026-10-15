import type { EventJournalEntry } from '../event-journal-store.js';

/**
 * Порт append-only журнала обработанных внешних событий и решений Router
 * (ADR-089, реализация — `EventJournalStore`).
 */
export interface EventJournalRepository {
  record(entry: EventJournalEntry): Promise<void>;
  /**
   * Записи в порядке добавления (старые → новые); `limit` — последние N.
   * @future-backend — выборка с `ORDER BY ts DESC LIMIT`.
   */
  list(limit?: number): Promise<EventJournalEntry[]>;
  /** Retention-очистка записей старше `retentionDays`; число удалённых. */
  prune(retentionDays: number): Promise<number>;
}

import type { EgressRequestLogEntry, EgressRequestScope, EgressRequestStatus } from '@itphx/synth-shared';

/** Опции выборки журнала внешних запросов. */
export interface EgressRequestLogListOptions {
  /** Вернуть последние N записей (самые новые). */
  limit?: number;
  /** Фильтр по источнику (`web_fetch`/`web_search`/…). */
  scope?: EgressRequestScope;
  /** Фильтр по статусу (`allowed`/`blocked`/`error`). */
  status?: EgressRequestStatus;
}

/**
 * Порт append-only журнала внешних запросов (egress).
 *
 * Пишется на каждый проверяемый исходящий запрос; тела/заголовки не сохраняются,
 * `url` — без query/userinfo. `prune(days)` удаляет записи старше срока хранения
 * (`0`/отрицательное — не чистить).
 */
export interface EgressRequestLogRepository {
  append(entry: EgressRequestLogEntry): Promise<void>;
  /** Записи «свежие первыми»; фильтры `scope`/`status`, `limit` — последние N. */
  list(opts?: EgressRequestLogListOptions): Promise<EgressRequestLogEntry[]>;
  /** Удалить записи старше `days`; число удалённых. */
  prune(days: number): Promise<number>;
  /** Полная очистка журнала; число удалённых записей. */
  clear(): Promise<number>;
}

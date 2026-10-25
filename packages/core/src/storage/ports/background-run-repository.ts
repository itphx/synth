import type {
  BackgroundRunFilter,
  BackgroundRunRecord,
  BackgroundRunStatus,
} from '@itphx/synth-shared';

/**
 * Порт единого реестра фоновых прогонов (этап 1 roadmap 0.13 — блок 1.2;
 * PROP-096 — фоновые саб-агенты, PROP-097 — фоновые шелл-процессы).
 *
 * Реестр персистентный: UI и родитель читают состояние прогона из записи,
 * а не из «живого» канала, — прогон переживает реконнект UI и рестарт сервиса.
 *
 * Семантика (общая для всех backend'ов):
 * - `save` — upsert по `id` (полная перезапись записи): `startedAt` иммутабельно
 *   (начало прогона не меняется), `updatedAt` ставит **вызывающий** (сервис) —
 *   порт не подставляет «сейчас», иначе retention-очистка по метке записи
 *   теряла бы смысл;
 * - `list` — «свежие первыми» (`startedAt` убыв., тайбрейкер `id`), фильтры —
 *   по «И», `limit` — общий потолок коллекции;
 * - `remove` — удалить запись; отсутствующая — `false` (не ошибка);
 * - `prune` — удаляет **только терминальные** статусы (`completed`/`failed`/
 *   `cancelled`/`orphaned`; `running` — не терминальный), метка которых строго
 *   старше отсечки.
 */
export interface BackgroundRunRepository {
  /** Upsert по `id` (создание или перезапись). */
  save(record: BackgroundRunRecord): Promise<void>;
  /** Запись по `id`; отсутствующая — `null`. */
  get(id: string): Promise<BackgroundRunRecord | null>;
  /**
   * Список прогонов (свежие первыми); фильтры — по «И».
   * @future-backend — `WHERE kind = ? AND status = ? ORDER BY started_at DESC LIMIT ?`.
   */
  list(filter?: BackgroundRunFilter): Promise<BackgroundRunRecord[]>;
  /** Удалить запись; отсутствующая — `false` (не ошибка). */
  remove(id: string): Promise<boolean>;
  /**
   * Retention-очистка: удалить записи терминальных статусов старше `before`;
   * число удалённых. `statuses` — подмножество терминальных (по умолчанию —
   * все терминальные); нетерминальный статус в списке игнорируется.
   */
  prune(before: string, statuses?: BackgroundRunStatus[]): Promise<number>;
}

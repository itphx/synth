import type { QuestionRecord, QuestionStatus } from '@itphx/synth-shared';

/**
 * Порт персистентных вопросов пользователю (этап 1 roadmap 0.13 — блок 1.3).
 *
 * Вопрос — **персистентная запись**: она переживает реконнект UI и рестарт
 * сервиса, поэтому ответ приходит по `id` вопроса, а не «по каналу».
 *
 * Семантика (общая для всех backend'ов):
 * - `save` — upsert по `id` (полная перезапись записи): `createdAt` иммутабельно,
 *   `updatedAt` ставит **вызывающий** (сервис) — порт не подставляет «сейчас»,
 *   иначе retention-очистка по метке записи теряла бы смысл;
 * - `list` — «свежие первыми» (`createdAt` убыв., тайбрейкер `id`), фильтры —
 *   по «И», `limit` — общий потолок коллекции (дефолт 100, максимум 1000);
 * - `prune` — удаляет **только терминальные** записи (`answered`/`cancelled`),
 *   метка которых строго старше отсечки.
 */
export interface QuestionRepository {
  /** Upsert по `id` (создание или перезапись). */
  save(record: QuestionRecord): Promise<void>;
  /** Запись по `id`; отсутствующая — `null`. */
  get(id: string): Promise<QuestionRecord | null>;
  /**
   * Список вопросов (свежие первыми); фильтры — по «И».
   * @future-backend — `WHERE session_id = ? AND status = ? ORDER BY created_at DESC LIMIT ?`.
   */
  list(filter?: {
    sessionId?: string;
    status?: QuestionStatus;
    limit?: number;
  }): Promise<QuestionRecord[]>;
  /** Retention-очистка: удалить терминальные записи старше `before`; число удалённых. */
  prune(before: string): Promise<number>;
}

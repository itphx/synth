/**
 * Порт источника дедупа событий по стабильному `dedupKey` (ADR-051/ADR-089).
 *
 * Реализации: `MemoryDedupStore` (in-process) и `FileDedupStore` (файловый
 * межпроцессный claim). Инвариант любой реализации: два конкурентных `tryClaim`
 * с одним ключом возвращают `true` ровно один раз (даже между процессами);
 * файловая — fail-open при ошибке, отличной от «ключ занят».
 * @future-backend — `INSERT … ON CONFLICT DO NOTHING` (атомарный claim в БД).
 */
export interface DedupRepository {
  /** Атомарный claim ключа: true — ключ наш (впервые), false — уже занят. */
  tryClaim(key: string): Promise<boolean>;
  /** Предзаполнить кэш ключами (например, из журнала при старте). */
  seed(keys: Iterable<string>): void;
}

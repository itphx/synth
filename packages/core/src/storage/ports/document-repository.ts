/**
 * Порт «ключ → JSON-документ» (PROP-032, шаг W2.4).
 *
 * Домен здесь — сам документ: провайдеры, модели, определения агентов хранятся
 * как отдельные JSON-документы под ключом (`provider`, `provider/model`).
 * Поэтому generic-порт не «KV вместо домена», а сам домен: документ целиком
 * читается/пишется/удаляется по ключу, `list()` возвращает все документы.
 *
 * Реализации:
 *   - файловая (`JsonStore`) — `<dataDir>/<subdir>/<key>.json`, атомарная запись
 *     tmp→rename (ADR-005), вложенные ключи (`provider/model`) — подкаталоги;
 *   - in-memory (`MemoryDocumentRepository`) — `Map`, без ФС.
 */
export interface DocumentRepository<T> {
  /** Читает документ по ключу; отсутствующий/битый — `null`. */
  load(key: string): Promise<T | null>;
  /** Пишет документ (перезапись), ключ валидируется (запрет `..`/`\`). */
  save(key: string, value: T): Promise<void>;
  /** Удаляет документ; отсутствие — не ошибка (идемпотентно). */
  delete(key: string): Promise<void>;
  /** Существует ли валидный документ по ключу. */
  exists(key: string): Promise<boolean>;
  /** Все документы (включая вложенные ключи). */
  list(): Promise<T[]>;
}

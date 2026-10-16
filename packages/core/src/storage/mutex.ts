/**
 * ADR-051/ADR-089/PROP-032: контракт межпроцессного мьютекса.
 *
 * Абстракция отделяет потребителей координации (`ScheduleStore`, лидер-выбор
 * планировщика, лок миграций) от конкретного backend'а:
 *   - `file` — `FileMutex` (каталог-лок через `mkdir` + stale takeover);
 *   - `postgres` — `PgMutex` драйвера (`@itphx/synth-storage-postgres`) поверх
 *     session-level `pg_advisory_lock` на выделенном соединении.
 *
 * Единственная операция, нужная потребителям, — `withLock`: попытка захвата с
 * ретраями до `timeoutMs`, выполнение `fn` под локом, освобождение в `finally`.
 * Семантика таймаута едина для реализаций: по истечении — `warn` и выполнение
 * **без** лока (осознанный fail-open, доступность важнее сериализации).
 */

/** Опции выполнения под локом. */
export interface LockOptions {
  /**
   * Пока `fn` выполняется, периодически продлевать лок (актуально для файлового
   * backend, где лок «протухает» без heartbeat). Advisory-лок БД держится
   * соединением и heartbeat не требует — опция игнорируется.
   */
  heartbeat?: boolean;
}

/**
 * Межпроцессный мьютекс: `withLock` выполняет `fn` под локом; при недоступности
 * лока операция всё равно выполняется (fail-open) — см. шапку модуля.
 */
export interface Mutex {
  withLock<T>(fn: () => Promise<T>, opts?: LockOptions): Promise<T>;
}

/**
 * Опции создания мьютекса через `StorageContext.locks.createMutex`.
 * `name` — namespaced-имя лока (`scheduler/schedules`, `startup-migrate`, …):
 * file-backend превращает его в путь, PG — в 64-битный advisory-ключ с префиксом
 * `synth:`.
 */
export interface MutexFactoryOptions {
  /** Namespaced-имя лока (без префикса `synth:`). */
  name: string;
  /** Общий таймаут захвата, мс (по умолчанию 5_000). */
  timeoutMs?: number;
  /** Пауза между попытками захвата, мс (по умолчанию 25). */
  retryMs?: number;
  /** Порог устаревания, мс (file-backend; PG игнорирует). */
  staleMs?: number;
}

/**
 * Опции создания лидер-выбора через `StorageContext.locks.createLeader`.
 * `name` — namespaced-имя лока; `tickMs` — период тика планировщика (для
 * file-backend: `staleMs = 3 × tickMs`; PG игнорирует).
 */
export interface LeaderFactoryOptions {
  /** Namespaced-имя лока (без префикса `synth:`). */
  name: string;
  /** Период тика планировщика, мс (file-backend: расчёт `staleMs`). */
  tickMs?: number;
  /** Явный `staleMs` (file-backend; PG игнорирует). */
  staleMs?: number;
}

/**
 * Порт lock-файла плагинов (PROP-068 §4.4 / ADR-090, ADR-096).
 *
 * `plugins.lock.json` — **источник истины** для update/uninstall: по записи
 * известны источник, pin (`ref`), content-hash, уровень доверия и вердикт
 * скана. Без lock нельзя ни обновить, ни корректно снять установку.
 *
 * Идентификатор записи — **имя плагина** (уникально в инстансе): по нему идёт
 * upsert и удаление. Формат записи — `PluginLockEntry`
 * (`@itphx/synth-shared`), здесь он не дублируется.
 *
 * Файловая реализация — `FilePluginLockStore`
 * (`packages/core/src/storage/file-plugin-lock-store.ts`; путь задаётся
 * раскладкой `<home>/plugin/plugins.lock.json` или `{dataDir}/plugin/…`),
 * in-memory — `MemoryPluginLockRepository`
 * (`packages/core/src/storage/memory/plugin-lock.ts`), БД — драйвер
 * `@itphx/synth-storage-postgres` (ADR-097).
 */
import type { PluginLockEntry } from '@itphx/synth-shared';

/**
 * Порт lock-файла плагинов (слой хранения, ADR-096).
 */
export interface PluginLockRepository {
  /** Upsert записи по имени плагина (существующая обновляется). */
  save(entry: PluginLockEntry): Promise<void>;
  /** Запись по имени плагина (`null` — не установлен). */
  get(name: string): Promise<PluginLockEntry | null>;
  /** Все записи (детерминированный порядок — по имени). */
  list(): Promise<PluginLockEntry[]>;
  /** Снятие записи (`true` — удалено, `false` — не было). */
  delete(name: string): Promise<boolean>;
}

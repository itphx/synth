/**
 * Порт журнала аудита плагинов (PROP-090 §9, ADR-096).
 *
 * Журнал — append-only: активация/деактивация расширения фиксируется как
 * событие («кто, что, с каким доверием/сканом/hash, чем кончилось»). Это
 * **отдельный** порт, а не расширение `SECURITY_AUDIT_SCOPES`
 * (`packages/shared/src/types/egress.ts`): security-аудит — про изменения
 * политик, журнал плагинов — про события расширений.
 *
 * Файловая реализация — `FilePluginAuditStore`
 * (`packages/core/src/storage/file-plugin-audit-store.ts`, JSONL
 * `{dataDir}/audit/plugins.jsonl`), in-memory — `MemoryPluginAuditRepository`
 * (`packages/core/src/storage/memory/plugin-audit.ts`), БД — драйвер
 * `@itphx/synth-storage-postgres` (ADR-097).
 */
import type {
  PluginAuditAction,
  PluginAuditEntry,
  PluginAuditOutcome,
} from '@itphx/synth-shared';

/** Опции выборки записей журнала аудита плагинов. */
export interface PluginAuditListOptions {
  /** Вернуть последние N записей (самые новые). */
  limit?: number;
  /** Фильтр по имени плагина. */
  plugin?: string;
  /** Фильтр по виду операции. */
  action?: PluginAuditAction;
  /** Фильтр по исходу операции. */
  outcome?: PluginAuditOutcome;
}

/**
 * Порт append-only журнала аудита плагинов.
 *
 * Записи неизменяемы, `id`/`ts` формирует вызывающий (`pa_<uuid>`).
 * `list` отдаёт записи «свежие первыми» (новые → старые).
 */
export interface PluginAuditRepository {
  /** Дозапись одного события журнала. */
  append(entry: PluginAuditEntry): Promise<void>;
  /**
   * Записи «свежие первыми» (новые → старые); фильтры `plugin`/`action`/
   * `outcome`, `limit` — последние N.
   * @future-backend — `WHERE plugin = ? AND action = ? ORDER BY seq DESC LIMIT ?`.
   */
  list(opts?: PluginAuditListOptions): Promise<PluginAuditEntry[]>;
  /** Полная очистка журнала; число удалённых записей. */
  clear(): Promise<number>;
}

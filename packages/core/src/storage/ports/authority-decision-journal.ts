/**
 * ADR-106 Ф1: порт append-only журнала решений Authority-слоя (ADR-096).
 *
 * Журнал фиксирует каждое посчитанное решение («кто, что, над чем, чем
 * кончилось»). Это **отдельный** порт, а не расширение `SECURITY_AUDIT_SCOPES`:
 * security-аудит — про изменения политик, журнал решений — про решения о
 * правах (ADR-106 §«Инварианты модели», п. 8).
 *
 * Файловая реализация — `packages/core/src/storage/file-authority-decision-journal.ts`
 * (JSONL `{dataDir}/audit/authority.jsonl`), in-memory —
 * `packages/core/src/storage/memory/authority-decision-journal.ts`.
 */
import type { AuthorityDecisionEntry } from '@itphx/synth-shared';

/** Опции выборки записей журнала решений. */
export interface AuthorityDecisionListOptions {
  /** Вернуть последние N записей (самые новые). */
  limit?: number;
  /** Фильтр по действию. */
  action?: string;
  /** Фильтр по эффекту (`allow`/`ask`/`deny`). */
  effect?: 'allow' | 'ask' | 'deny';
  /** Фильтр по оси, давшей решение (`user`/`agent`/`session`/`pack`/`instance`). */
  source?: string;
}

/**
 * Порт append-only журнала решений Authority-слоя.
 *
 * Записи неизменяемы; `id`/`ts` формирует вызывающий (`ad_<uuid>`).
 * `list` отдаёт записи «свежие первыми» (новые → старые) — как журнал аудита
 * плагинов (ADR-090).
 */
export interface AuthorityDecisionJournal {
  /** Дозапись одного решения. */
  append(entry: AuthorityDecisionEntry): Promise<void>;
  /**
   * Решения «свежие первыми»; фильтры `action`/`effect`/`source`, `limit` —
   * последние N.
   * @future-backend — `WHERE action = ? AND effect = ? ORDER BY seq DESC LIMIT ?`.
   */
  list(opts?: AuthorityDecisionListOptions): Promise<AuthorityDecisionEntry[]>;
  /** Полная очистка журнала; число удалённых записей. */
  clear(): Promise<number>;
}

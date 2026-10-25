/**
 * In-memory реализация порта **вопросов пользователю** (ADR-096, второй
 * backend за единым слоем хранения; этап 1 roadmap 0.13 — блок 1.3).
 *
 * Чистая реализация без модулей ФС (`fs`/`path`): состояние — в `Map`
 * процесса. Семантика повторяет файловую реализацию
 * (`FileQuestionStore`): upsert по `id` (`createdAt` сохраняется,
 * `updatedAt` монотонно обновляется), детерминированный порядок списка
 * («свежие первыми»), фильтры по «И», `prune` — только терминальные записи
 * старше отсечки.
 *
 * Возвращаемые записи — копии (`structuredClone`), как в остальных
 * memory-портах: мутация результата не влияет на стор.
 */

import type { QuestionRecord, QuestionStatus } from '@itphx/synth-shared';
import type { QuestionRepository } from '../ports/question-repository.js';
import { resolveCollectionLimit } from '../ports/collection-limit.js';
import { resolveCreatedAt } from '../record-timestamps.js';
import { isOlderThan, parseCutoffMs } from '../retention.js';

/**
 * Порт вопросов пользователю поверх `Map` (реализация — `FileQuestionStore`).
 */
export class MemoryQuestionRepository implements QuestionRepository {
  private readonly _questions = new Map<string, QuestionRecord>();

  async save(record: QuestionRecord): Promise<void> {
    const stored = this._questions.get(record.id);
    this._questions.set(record.id, {
      ...structuredClone(record),
      // `createdAt` иммутабельно; `updatedAt` ставит вызывающий (сервис).
      createdAt: resolveCreatedAt(stored?.createdAt, record.createdAt),
      updatedAt: record.updatedAt,
    });
  }

  async get(id: string): Promise<QuestionRecord | null> {
    const record = this._questions.get(id);
    return record ? structuredClone(record) : null;
  }

  async list(filter?: {
    sessionId?: string;
    status?: QuestionStatus;
    limit?: number;
  }): Promise<QuestionRecord[]> {
    const filtered = [...this._questions.values()].filter((r) => matches(r, filter));
    // Свежие первыми (`createdAt` убыв.), тайбрейкер — `id`.
    const sorted = [...filtered].sort(byCreatedAtDesc);
    return sorted
      .slice(0, resolveCollectionLimit(filter?.limit))
      .map((r) => structuredClone(r));
  }

  async prune(before: string): Promise<number> {
    const cutoff = parseCutoffMs(before);
    if (cutoff === null) return 0;
    let removed = 0;
    for (const [id, record] of [...this._questions.entries()]) {
      if (!isPrunable(record, cutoff)) continue;
      this._questions.delete(id);
      removed += 1;
    }
    return removed;
  }
}

/** Терминальный ли статус вопроса (запись можно чистить). */
function isTerminalStatus(status: QuestionStatus): boolean {
  return status === 'answered' || status === 'cancelled';
}

/** Подлежит ли вопрос очистке: терминальный и строго старше отсечки. */
function isPrunable(record: QuestionRecord, cutoffMs: number): boolean {
  return isTerminalStatus(record.status) && isOlderThan(record.updatedAt, cutoffMs);
}

/** Совпадает ли вопрос с фильтрами выборки (все условия — по «И»). */
function matches(
  record: QuestionRecord,
  filter: { sessionId?: string; status?: QuestionStatus } | undefined,
): boolean {
  if (!filter) return true;
  if (filter.sessionId !== undefined && record.sessionId !== filter.sessionId) return false;
  if (filter.status !== undefined && record.status !== filter.status) return false;
  return true;
}

/** Сортировка «свежие первыми» (`createdAt` убыв.), тайбрейкер — `id`. */
function byCreatedAtDesc(a: QuestionRecord, b: QuestionRecord): number {
  const diff = Date.parse(b.createdAt) - Date.parse(a.createdAt);
  if (diff !== 0 && !Number.isNaN(diff)) return diff;
  return a.id.localeCompare(b.id);
}

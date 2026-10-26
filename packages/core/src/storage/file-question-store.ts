import { join } from 'node:path';
import { AsyncLock } from '@itphx/synth-shared';
import type { QuestionRecord, QuestionStatus } from '@itphx/synth-shared';
import type { QuestionRepository } from './ports/question-repository.js';
import { readCollectionFile, writeCollectionFile } from './json-collection-file.js';
import { resolveCollectionLimit } from './ports/collection-limit.js';
import { resolveCreatedAt } from './record-timestamps.js';
import { isOlderThan, parseCutoffMs } from './retention.js';

export interface FileQuestionStoreConfig {
  dataDir: string;
}

/** Ключ массива вопросов внутри JSON-файла. */
const QUESTIONS_KEY = 'questions';

/**
 * Файловая реализация порта вопросов пользователю (ADR-096 — слой хранения;
 * ADR-005 — JSON + атомарная запись tmp→rename; этап 1 roadmap 0.13 — блок 1.3).
 *
 * Физическое расположение: `{dataDir}/questions.json`.
 *
 * Каталог создаётся при первой записи; отсутствие файла — пустой репозиторий
 * (не ошибка). Повреждённый JSON — понятная ошибка, а не тихий пустой список
 * (`readCollectionFile`).
 *
 * Семантика повторяет in-memory реализацию (`MemoryQuestionRepository`):
 * upsert по `id` (`createdAt` сохраняется, `updatedAt` монотонно обновляется),
 * список «свежие первыми» с фильтрами по «И», `prune` — только терминальные
 * записи старше отсечки.
 */
export class FileQuestionStore implements QuestionRepository {
  private readonly _lock = new AsyncLock();

  constructor(private readonly _config: FileQuestionStoreConfig) {}

  /** Путь файла вопросов (`{dataDir}/questions.json`). */
  path(): string {
    return join(this._config.dataDir, 'questions.json');
  }

  async save(record: QuestionRecord): Promise<void> {
    await this._lock.acquire();
    try {
      const records = await this._read();
      const index = records.findIndex((r) => r.id === record.id);
      const stored = index === -1 ? undefined : records[index];
      const next: QuestionRecord = {
        ...record,
        // `createdAt` иммутабельно; `updatedAt` ставит вызывающий (сервис) —
        // порт не подставляет «сейчас», иначе retention-очистка по метке
        // записи теряла бы смысл.
        createdAt: resolveCreatedAt(stored?.createdAt, record.createdAt),
        updatedAt: record.updatedAt,
      };
      if (index === -1) records.push(next);
      else records[index] = next;
      await this._write(records);
    } finally {
      this._lock.release();
    }
  }

  async get(id: string): Promise<QuestionRecord | null> {
    const records = await this._read();
    return records.find((r) => r.id === id) ?? null;
  }

  async list(filter?: {
    sessionId?: string;
    status?: QuestionStatus;
    limit?: number;
  }): Promise<QuestionRecord[]> {
    const records = await this._read();
    const filtered = records.filter((r) => matches(r, filter));
    // Свежие первыми (`createdAt` убыв.), тайбрейкер — `id`.
    const sorted = [...filtered].sort(byCreatedAtDesc);
    return sorted.slice(0, resolveCollectionLimit(filter?.limit));
  }

  async prune(before: string): Promise<number> {
    const cutoff = parseCutoffMs(before);
    if (cutoff === null) return 0;
    await this._lock.acquire();
    try {
      const records = await this._read();
      if (records.length === 0) return 0;
      const kept = records.filter((r) => !isPrunable(r, cutoff));
      const removed = records.length - kept.length;
      if (removed === 0) return 0;
      await this._write(kept);
      return removed;
    } finally {
      this._lock.release();
    }
  }

  private async _read(): Promise<QuestionRecord[]> {
    return readCollectionFile<QuestionRecord>(this.path(), QUESTIONS_KEY, 'файл вопросов');
  }

  private async _write(records: QuestionRecord[]): Promise<void> {
    await writeCollectionFile(this.path(), QUESTIONS_KEY, records);
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

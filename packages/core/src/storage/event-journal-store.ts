import { appendFile, readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { SynthEvent, RouteDecision } from '@itphx/synth-shared';
import { AsyncLock, atomicWrite } from '@itphx/synth-shared';

/** AD-089: запись журнала обработки внешнего события (локальный тип core). */
export interface EventJournalEntry {
  /** ISO-8601. */
  ts: string;
  event: SynthEvent;
  /** Результат роутинга, если он был вычислен. */
  decision?: RouteDecision;
  /** Ошибка обработки, если была. */
  error?: string;
  /** AD-089/AD-052: id API-ключа привязки (аудит использования ключа). */
  keyId?: string;
  /** AD-089/AD-052: идентичность отправителя (аудит использования ключа). */
  principalId?: string;
}

export interface EventJournalStoreConfig {
  dataDir: string;
}

/**
 * AD-089: журнал обработанных внешних событий и решений Router.
 *
 * Append-only JSONL `{dataDir}/events/journal.jsonl` (одна строка = одна запись,
 * как в аудите LLM Gateway — `AuditLogger`/`payload-logger.ts`). Append защищён
 * общим `AsyncLock`, чтобы конкурирующие `record` не перемешивали строки.
 * Формат `prune` — атомарная перезапись (tmp→rename, AD-005).
 */
export class EventJournalStore {
  private _lock = new AsyncLock();

  constructor(private _config: EventJournalStoreConfig) {}

  private _filePath(): string {
    return join(this._config.dataDir, 'events', 'journal.jsonl');
  }

  /** Дозапись одной строки JSON + `\n`. Порядок строк — по времени добавления. */
  async record(entry: EventJournalEntry): Promise<void> {
    await this._lock.acquire();
    try {
      const path = this._filePath();
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, `${JSON.stringify(entry)}\n`, { encoding: 'utf8' });
    } finally {
      this._lock.release();
    }
  }

  /**
   * Читает журнал в порядке добавления (старые → новые). `limit` возвращает
   * последние N записей (самые новые). Нет файла — `[]`; повреждённые строки
   * пропускаются с `console.warn`.
   */
  async list(limit?: number): Promise<EventJournalEntry[]> {
    const entries = await this._readAll();
    if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return entries;
    return entries.slice(-Math.floor(limit));
  }

  /**
   * Удаляет записи старше `retentionDays` дней (по `entry.ts`); возвращает
   * число удалённых. Записи с непарсящимся `ts` сохраняются. Перезапись —
   * атомарная; при отсутствии удалений файл не трогается.
   */
  async prune(retentionDays: number): Promise<number> {
    await this._lock.acquire();
    try {
      const entries = await this._readAll();
      if (entries.length === 0) return 0;

      const days = Number.isFinite(retentionDays) ? retentionDays : 0;
      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
      const kept = entries.filter((e) => {
        const t = Date.parse(e.ts);
        return Number.isNaN(t) ? true : t >= cutoff;
      });
      const removed = entries.length - kept.length;
      if (removed === 0) return 0;

      const path = this._filePath();
      await mkdir(dirname(path), { recursive: true });
      const data = kept.length > 0 ? `${kept.map((e) => JSON.stringify(e)).join('\n')}\n` : '';
      await atomicWrite(
        (p, d) => writeFile(p, d, 'utf-8'),
        (o, n) => rename(o, n),
        path,
        data,
      );
      return removed;
    } finally {
      this._lock.release();
    }
  }

  private async _readAll(): Promise<EventJournalEntry[]> {
    let raw: string;
    try {
      raw = await readFile(this._filePath(), 'utf8');
    } catch {
      return [];
    }

    const entries: EventJournalEntry[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed) as EventJournalEntry);
      } catch (e) {
        console.warn(`[EventJournalStore] повреждённая строка журнала пропущена: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return entries;
  }
}

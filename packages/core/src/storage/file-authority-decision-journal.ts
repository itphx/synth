import { appendFile, readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { AuthorityDecisionEntry } from '@itphx/synth-shared';
import { AsyncLock, atomicWrite } from '@itphx/synth-shared';
import type {
  AuthorityDecisionJournal,
  AuthorityDecisionListOptions,
} from './ports/authority-decision-journal.js';

export interface FileAuthorityDecisionJournalConfig {
  dataDir: string;
}

/**
 * PROP-108 Ф1: журнал решений Authority-слоя — append-only JSONL
 * `{dataDir}/audit/authority.jsonl` (одна строка = одна запись; образец —
 * `SecurityAuditStore`/`FilePluginAuditStore`).
 *
 * Запись необратима: `append` только дописывает, `clear` перезаписывает файл
 * атомарно (tmp→rename, ADR-005). Append защищён `AsyncLock`, чтобы
 * конкурирующие записи не перемешивали строки.
 *
 * Секретов и сырых путей в записи нет (PROP-108 §«Инварианты модели», п. 8) —
 * нормализация цели выполняется на стороне вызывающего (shadow-слой).
 */
export class FileAuthorityDecisionJournal implements AuthorityDecisionJournal {
  private _lock = new AsyncLock();

  constructor(private _config: FileAuthorityDecisionJournalConfig) {}

  private _filePath(): string {
    return join(this._config.dataDir, 'audit', 'authority.jsonl');
  }

  /** Дозапись одного решения + `\n`; каталог создаётся по необходимости. */
  async append(entry: AuthorityDecisionEntry): Promise<void> {
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
   * Читает журнал «свежими первыми». Фильтры — `action`/`effect`/`source`,
   * `limit` — последние N записей. Нет файла — `[]`; повреждённые строки
   * пропускаются с `console.warn`.
   */
  async list(opts: AuthorityDecisionListOptions = {}): Promise<AuthorityDecisionEntry[]> {
    let entries = (await this._readAll()).reverse();
    if (opts.action !== undefined) {
      entries = entries.filter((entry) => entry.action === opts.action);
    }
    if (opts.effect !== undefined) {
      entries = entries.filter((entry) => entry.effect === opts.effect);
    }
    if (opts.source !== undefined) {
      entries = entries.filter((entry) => entry.source === opts.source);
    }
    const { limit } = opts;
    if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return entries;
    return entries.slice(0, Math.floor(limit));
  }

  /**
   * Полная очистка журнала (атомарная перезапись tmp→rename, ADR-005);
   * возвращает число удалённых записей. Файла нет — `0`, файл не создаётся.
   */
  async clear(): Promise<number> {
    await this._lock.acquire();
    try {
      const entries = await this._readAll();
      if (entries.length === 0) return 0;
      const path = this._filePath();
      await mkdir(dirname(path), { recursive: true });
      await atomicWrite(
        (p, d) => writeFile(p, d, 'utf-8'),
        (o, n) => rename(o, n),
        path,
        '',
      );
      return entries.length;
    } finally {
      this._lock.release();
    }
  }

  private async _readAll(): Promise<AuthorityDecisionEntry[]> {
    let raw: string;
    try {
      raw = await readFile(this._filePath(), 'utf8');
    } catch {
      return [];
    }

    const entries: AuthorityDecisionEntry[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed) as AuthorityDecisionEntry);
      } catch (e) {
        console.warn(
          `[FileAuthorityDecisionJournal] повреждённая строка журнала решений пропущена: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    return entries;
  }
}

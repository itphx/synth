import { appendFile, readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { EgressRequestLogEntry } from '@itphx/synth-shared';
import { AsyncLock, atomicWrite } from '@itphx/synth-shared';
import type {
  EgressRequestLogListOptions,
  EgressRequestLogRepository,
} from './ports/egress-request-log-repository.js';

export interface EgressRequestLogStoreConfig {
  dataDir: string;
}

/**
 * Append-only журнал внешних запросов.
 *
 * JSONL `{dataDir}/audit/egress.jsonl` (одна строка = запись, тела/заголовки
 * не сохраняются). Append под `AsyncLock`; `list` — «свежие первыми»;
 * `prune(days)` удаляет записи старше `days` (0 — не чистить); `clear` —
 * атомарная перезапись (tmp→rename, ADR-005).
 */
export class EgressRequestLogStore implements EgressRequestLogRepository {
  private _lock = new AsyncLock();

  constructor(private _config: EgressRequestLogStoreConfig) {}

  private _filePath(): string {
    return join(this._config.dataDir, 'audit', 'egress.jsonl');
  }

  async append(entry: EgressRequestLogEntry): Promise<void> {
    await this._lock.acquire();
    try {
      const path = this._filePath();
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, `${JSON.stringify(entry)}\n`, { encoding: 'utf8' });
    } finally {
      this._lock.release();
    }
  }

  async list(opts: EgressRequestLogListOptions = {}): Promise<EgressRequestLogEntry[]> {
    let entries = (await this._readAll()).reverse();
    if (opts.scope !== undefined) entries = entries.filter((entry) => entry.scope === opts.scope);
    if (opts.status !== undefined) entries = entries.filter((entry) => entry.status === opts.status);
    const { limit } = opts;
    if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return entries;
    return entries.slice(0, Math.floor(limit));
  }

  async prune(days: number): Promise<number> {
    if (!Number.isFinite(days) || days <= 0) return 0;
    await this._lock.acquire();
    try {
      const entries = await this._readAll();
      if (entries.length === 0) return 0;
      const cutoff = Date.now() - days * 24 * 3600_000;
      const kept = entries.filter((entry) => {
        const ts = Date.parse(entry.ts);
        return Number.isFinite(ts) && ts >= cutoff;
      });
      const removed = entries.length - kept.length;
      if (removed === 0) return 0;
      const path = this._filePath();
      await mkdir(dirname(path), { recursive: true });
      const body = kept.map((entry) => `${JSON.stringify(entry)}\n`).join('');
      await atomicWrite(
        (p, d) => writeFile(p, d, 'utf-8'),
        (o, n) => rename(o, n),
        path,
        body,
      );
      return removed;
    } finally {
      this._lock.release();
    }
  }

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

  private async _readAll(): Promise<EgressRequestLogEntry[]> {
    let raw: string;
    try {
      raw = await readFile(this._filePath(), 'utf8');
    } catch {
      return [];
    }
    const entries: EgressRequestLogEntry[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed) as EgressRequestLogEntry);
      } catch (e) {
        console.warn(
          `[EgressRequestLogStore] повреждённая строка журнала пропущена: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    return entries;
  }
}

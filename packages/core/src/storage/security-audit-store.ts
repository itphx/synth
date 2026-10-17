import { appendFile, readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { SecurityAuditEntry } from '@itphx/synth-shared';
import { AsyncLock, atomicWrite } from '@itphx/synth-shared';
import type {
  SecurityAuditListOptions,
  SecurityAuditRepository,
} from './ports/security-audit-repository.js';

export interface SecurityAuditStoreConfig {
  dataDir: string;
}

/**
 * Append-only аудит изменений security/egress-политик.
 *
 * JSONL `{dataDir}/audit/security.jsonl` (одна строка = запись). Append под
 * `AsyncLock`; `list` — «свежие первыми»; `clear` — атомарная перезапись
 * (tmp→rename, ADR-005). `id`/`ts` формирует вызывающий.
 */
export class SecurityAuditStore implements SecurityAuditRepository {
  private _lock = new AsyncLock();

  constructor(private _config: SecurityAuditStoreConfig) {}

  private _filePath(): string {
    return join(this._config.dataDir, 'audit', 'security.jsonl');
  }

  async append(entry: SecurityAuditEntry): Promise<void> {
    await this._lock.acquire();
    try {
      const path = this._filePath();
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, `${JSON.stringify(entry)}\n`, { encoding: 'utf8' });
    } finally {
      this._lock.release();
    }
  }

  async list(opts: SecurityAuditListOptions = {}): Promise<SecurityAuditEntry[]> {
    let entries = (await this._readAll()).reverse();
    if (opts.scope !== undefined) entries = entries.filter((entry) => entry.scope === opts.scope);
    const { limit } = opts;
    if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return entries;
    return entries.slice(0, Math.floor(limit));
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

  private async _readAll(): Promise<SecurityAuditEntry[]> {
    let raw: string;
    try {
      raw = await readFile(this._filePath(), 'utf8');
    } catch {
      return [];
    }
    const entries: SecurityAuditEntry[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed) as SecurityAuditEntry);
      } catch (e) {
        console.warn(
          `[SecurityAuditStore] повреждённая строка аудита пропущена: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    return entries;
  }
}

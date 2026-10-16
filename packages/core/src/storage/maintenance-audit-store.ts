import { appendFile, readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { MaintenanceAuditEntry } from '@itphx/synth-shared';
import { AsyncLock, atomicWrite } from '@itphx/synth-shared';
import type {
  MaintenanceAuditListOptions,
  MaintenanceAuditRepository,
} from './ports/maintenance-audit-repository.js';

export interface MaintenanceAuditStoreConfig {
  dataDir: string;
}

/**
 * ADR-092: аудит-журнал обслуживания инстанса.
 *
 * Append-only JSONL `{dataDir}/audit/maintenance.jsonl` (одна строка = одна
 * запись, образец — `JobStore`; каталог `audit/` уже используется LLM-аудитом).
 * Append защищён `AsyncLock`, чтобы конкурирующие записи не перемешивали строки.
 * `list` отдаёт записи «свежими первыми» (новые → старые); `clear` атомарно
 * (tmp→rename, ADR-005) опустошает файл. `id`/`ts` формирует вызывающий
 * (`ma_<uuid>`).
 */
export class MaintenanceAuditStore implements MaintenanceAuditRepository {
  private _lock = new AsyncLock();

  constructor(private _config: MaintenanceAuditStoreConfig) {}

  private _filePath(): string {
    return join(this._config.dataDir, 'audit', 'maintenance.jsonl');
  }

  /** Дозапись одного события + `\n`; каталог создаётся по необходимости. */
  async append(entry: MaintenanceAuditEntry): Promise<void> {
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
   * Читает журнал «свежими первыми» (новые → старые). Фильтрует по `op`,
   * `limit` возвращает последние N записей. Нет файла — `[]`; повреждённые
   * строки пропускаются с `console.warn`.
   */
  async list(opts: MaintenanceAuditListOptions = {}): Promise<MaintenanceAuditEntry[]> {
    // Файл append-only: порядок строк — по времени добавления, поэтому
    // «свежие первыми» — это разворот порядка чтения.
    let entries = (await this._readAll()).reverse();
    if (opts.op !== undefined) {
      entries = entries.filter((entry) => entry.op === opts.op);
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

  private async _readAll(): Promise<MaintenanceAuditEntry[]> {
    let raw: string;
    try {
      raw = await readFile(this._filePath(), 'utf8');
    } catch {
      return [];
    }

    const entries: MaintenanceAuditEntry[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed) as MaintenanceAuditEntry);
      } catch (e) {
        console.warn(
          `[MaintenanceAuditStore] повреждённая строка журнала обслуживания пропущена: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    return entries;
  }
}

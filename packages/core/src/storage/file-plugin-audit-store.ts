import { appendFile, readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { PluginAuditEntry } from '@itphx/synth-shared';
import { AsyncLock, atomicWrite } from '@itphx/synth-shared';
import type {
  PluginAuditListOptions,
  PluginAuditRepository,
} from './ports/plugin-audit-repository.js';

export interface FilePluginAuditStoreConfig {
  dataDir: string;
}

/**
 * PROP-090 §9: журнал аудита плагинов — append-only JSONL
 * `{dataDir}/audit/plugins.jsonl` (одна строка = одна запись; образец —
 * `MaintenanceAuditStore`, ADR-092; каталог `audit/` уже используется
 * LLM/security-аудитом).
 *
 * Append защищён `AsyncLock`, чтобы конкурирующие записи не перемешивали
 * строки. `list` отдаёт записи «свежими первыми» (новые → старые); `clear`
 * атомарно (tmp→rename, ADR-005) опустошает файл. `id`/`ts` формирует
 * вызывающий (`pa_<uuid>`).
 */
export class FilePluginAuditStore implements PluginAuditRepository {
  private _lock = new AsyncLock();

  constructor(private _config: FilePluginAuditStoreConfig) {}

  private _filePath(): string {
    return join(this._config.dataDir, 'audit', 'plugins.jsonl');
  }

  /** Дозапись одного события + `\n`; каталог создаётся по необходимости. */
  async append(entry: PluginAuditEntry): Promise<void> {
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
   * Читает журнал «свежими первыми». Фильтрует по `plugin`/`action`/`outcome`,
   * `limit` возвращает последние N записей. Нет файла — `[]`; повреждённые
   * строки пропускаются с `console.warn`.
   */
  async list(opts: PluginAuditListOptions = {}): Promise<PluginAuditEntry[]> {
    // Файл append-only: порядок строк — по времени добавления, поэтому
    // «свежие первыми» — это разворот порядка чтения.
    let entries = (await this._readAll()).reverse();
    if (opts.plugin !== undefined) {
      entries = entries.filter((entry) => entry.plugin === opts.plugin);
    }
    if (opts.action !== undefined) {
      entries = entries.filter((entry) => entry.action === opts.action);
    }
    if (opts.outcome !== undefined) {
      entries = entries.filter((entry) => entry.outcome === opts.outcome);
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

  private async _readAll(): Promise<PluginAuditEntry[]> {
    let raw: string;
    try {
      raw = await readFile(this._filePath(), 'utf8');
    } catch {
      return [];
    }

    const entries: PluginAuditEntry[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed) as PluginAuditEntry);
      } catch (e) {
        console.warn(
          `[FilePluginAuditStore] повреждённая строка журнала плагинов пропущена: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    return entries;
  }
}

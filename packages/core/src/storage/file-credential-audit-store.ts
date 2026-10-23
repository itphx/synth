import { appendFile, readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { ExternalCredentialAuditEntry } from '@itphx/synth-shared';
import { AsyncLock, atomicWrite } from '@itphx/synth-shared';
import type {
  CredentialAuditListOptions,
  CredentialAuditRepository,
} from './ports/credential-audit-repository.js';

export interface FileCredentialAuditStoreConfig {
  dataDir: string;
}

/**
 * ADR-105 (Ф4): журнал операций со слоем доступов — append-only JSONL
 * `{dataDir}/audit/credentials.jsonl` (одна строка = одна запись; образец —
 * `FilePluginAuditStore`, ADR-090; каталог `audit/` уже используется
 * LLM/security/maintenance-аудитом).
 *
 * Append защищён `AsyncLock`, чтобы конкурирующие записи не перемешивали
 * строки. `list` отдаёт записи «свежими первыми» (новые → старые); `clear`
 * атомарно (tmp→rename, ADR-005) опустошает файл. `id`/`ts` формирует
 * вызывающий (`ca_<uuid>`).
 *
 * **Секретов в файле нет**: значения токенов, `secretEnc`/`refreshEnc` и
 * сырые пути в журнал не пишутся (ADR-105 §7).
 */
export class FileCredentialAuditStore implements CredentialAuditRepository {
  private _lock = new AsyncLock();

  constructor(private _config: FileCredentialAuditStoreConfig) {}

  private _filePath(): string {
    return join(this._config.dataDir, 'audit', 'credentials.jsonl');
  }

  /** Дозапись одного события + `\n`; каталог создаётся по необходимости. */
  async append(entry: ExternalCredentialAuditEntry): Promise<void> {
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
   * Читает журнал «свежими первыми». Фильтрует по `credentialId`/`provider`/
   * `op`/`outcome`, `limit` возвращает последние N записей. Нет файла — `[]`;
   * повреждённые строки пропускаются с `console.warn`.
   */
  async list(opts: CredentialAuditListOptions = {}): Promise<ExternalCredentialAuditEntry[]> {
    // Файл append-only: порядок строк — по времени добавления, поэтому
    // «свежие первыми» — это разворот порядка чтения.
    let entries = (await this._readAll()).reverse();
    if (opts.credentialId !== undefined) {
      entries = entries.filter((entry) => entry.credentialId === opts.credentialId);
    }
    if (opts.provider !== undefined) {
      entries = entries.filter((entry) => entry.provider === opts.provider);
    }
    if (opts.op !== undefined) {
      entries = entries.filter((entry) => entry.op === opts.op);
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

  private async _readAll(): Promise<ExternalCredentialAuditEntry[]> {
    let raw: string;
    try {
      raw = await readFile(this._filePath(), 'utf8');
    } catch {
      return [];
    }

    const entries: ExternalCredentialAuditEntry[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed) as ExternalCredentialAuditEntry);
      } catch (e) {
        console.warn(
          `[FileCredentialAuditStore] повреждённая строка журнала доступов пропущена: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    return entries;
  }
}

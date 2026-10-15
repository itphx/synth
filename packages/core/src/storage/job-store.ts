import { appendFile, readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { ScheduleJob } from '@itphx/synth-shared';
import { AsyncLock, atomicWrite } from '@itphx/synth-shared';

export interface JobStoreConfig {
  dataDir: string;
}

export interface JobListOptions {
  /** Фильтр по расписанию-источнику. */
  scheduleId?: string;
  /** Вернуть последние N записей (самые новые). */
  limit?: number;
}

/**
 * ADR-051: история срабатываний расписаний планировщика.
 *
 * Append-only JSONL `{dataDir}/scheduler/jobs.jsonl` (одна строка = один Job,
 * образец — `EventJournalStore`). Append защищён `AsyncLock`, чтобы
 * конкурирующие записи не перемешивали строки. Retention — `prune`
 * (атомарная перезапись tmp→rename, ADR-005); `id` формирует вызывающий
 * (`job_<uuid>`).
 */
export class JobStore {
  private _lock = new AsyncLock();

  constructor(private _config: JobStoreConfig) {}

  private _filePath(): string {
    return join(this._config.dataDir, 'scheduler', 'jobs.jsonl');
  }

  /** Дозапись одного Job + `\n`. Порядок строк — по времени добавления. */
  async append(job: ScheduleJob): Promise<void> {
    await this._lock.acquire();
    try {
      const path = this._filePath();
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, `${JSON.stringify(job)}\n`, { encoding: 'utf8' });
    } finally {
      this._lock.release();
    }
  }

  /**
   * Читает историю в порядке добавления (старые → новые). Фильтрует по
   * `scheduleId`, `limit` возвращает последние N записей. Нет файла — `[]`;
   * повреждённые строки пропускаются с `console.warn`.
   */
  async list(opts: JobListOptions = {}): Promise<ScheduleJob[]> {
    let jobs = await this._readAll();
    if (opts.scheduleId !== undefined) {
      jobs = jobs.filter((job) => job.scheduleId === opts.scheduleId);
    }
    const { limit } = opts;
    if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return jobs;
    return jobs.slice(-Math.floor(limit));
  }

  /**
   * Удаляет записи старше `retentionDays` дней (по `startedAt`); возвращает
   * число удалённых. Записи с непарсящейся датой сохраняются. Перезапись —
   * атомарная; при отсутствии удалений файл не трогается.
   */
  async prune(retentionDays: number): Promise<number> {
    await this._lock.acquire();
    try {
      const jobs = await this._readAll();
      if (jobs.length === 0) return 0;

      const days = Number.isFinite(retentionDays) ? retentionDays : 0;
      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
      const kept = jobs.filter((job) => {
        const t = Date.parse(job.startedAt);
        return Number.isNaN(t) ? true : t >= cutoff;
      });
      const removed = jobs.length - kept.length;
      if (removed === 0) return 0;

      const path = this._filePath();
      await mkdir(dirname(path), { recursive: true });
      const data = kept.length > 0 ? `${kept.map((j) => JSON.stringify(j)).join('\n')}\n` : '';
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

  private async _readAll(): Promise<ScheduleJob[]> {
    let raw: string;
    try {
      raw = await readFile(this._filePath(), 'utf8');
    } catch {
      return [];
    }

    const jobs: ScheduleJob[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        jobs.push(JSON.parse(trimmed) as ScheduleJob);
      } catch (e) {
        console.warn(
          `[JobStore] повреждённая строка истории Jobs пропущена: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    return jobs;
  }
}

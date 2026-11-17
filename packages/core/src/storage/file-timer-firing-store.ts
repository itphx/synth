import { appendFile, readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { AsyncLock, atomicWrite } from '@itphx/synth-shared';
import type { TimerFiring } from '@itphx/synth-shared';
import type { TimerFiringRepository } from './ports/timer-repository.js';

export interface FileTimerFiringStoreConfig {
  dataDir: string;
}

/**
 * Файловая реализация порта истории срабатываний таймеров (PROP-141, Часть B;
 * ADR-096 — слой хранения).
 *
 * Физическое расположение: `{dataDir}/timers/firings.jsonl` — append-only
 * JSONL (одна строка = одно срабатывание), образец — `JobStore`
 * (история запусков планировщика, ADR-051).
 *
 * Семантика:
 * - `append` — дозапись одной строки под `AsyncLock` (конкурентные записи не
 *   перемешивают строки);
 * - `list` — записи таймера **в порядке добавления** (старые → новые),
 *   `limit` — последние N;
 * - `prune` — удалить записи **строго старше** отсечки (`firedAt < before`),
 *   перезапись атомарная (tmp→rename, ADR-005); при отсутствии удалений файл
 *   не трогается.
 */
export class FileTimerFiringStore implements TimerFiringRepository {
  private readonly _lock = new AsyncLock();

  constructor(private readonly _config: FileTimerFiringStoreConfig) {}

  /** Путь файла истории срабатываний (`{dataDir}/timers/firings.jsonl`). */
  path(): string {
    return join(this._config.dataDir, 'timers', 'firings.jsonl');
  }

  async append(firing: TimerFiring): Promise<void> {
    await this._lock.acquire();
    try {
      const path = this.path();
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, `${JSON.stringify(firing)}\n`, { encoding: 'utf8' });
    } finally {
      this._lock.release();
    }
  }

  async list(timerId: string, limit?: number): Promise<TimerFiring[]> {
    const firings = (await this._readAll()).filter((f) => f.timerId === timerId);
    if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return firings;
    return firings.slice(-Math.floor(limit));
  }

  async prune(before: string): Promise<number> {
    const cutoff = Date.parse(before);
    if (Number.isNaN(cutoff)) return 0;
    await this._lock.acquire();
    try {
      const firings = await this._readAll();
      if (firings.length === 0) return 0;
      const kept = firings.filter((f) => {
        const t = Date.parse(f.firedAt);
        // Записи с непарсящейся датой сохраняются (fail-soft, как у Job-истории).
        return Number.isNaN(t) ? true : t >= cutoff;
      });
      const removed = firings.length - kept.length;
      if (removed === 0) return 0;

      const path = this.path();
      await mkdir(dirname(path), { recursive: true });
      const data = kept.length > 0 ? `${kept.map((f) => JSON.stringify(f)).join('\n')}\n` : '';
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

  private async _readAll(): Promise<TimerFiring[]> {
    let raw: string;
    try {
      raw = await readFile(this.path(), 'utf8');
    } catch {
      return [];
    }

    const firings: TimerFiring[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        firings.push(JSON.parse(trimmed) as TimerFiring);
      } catch (e) {
        console.warn(
          `[FileTimerFiringStore] повреждённая строка истории срабатываний пропущена: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    }
    return firings;
  }
}

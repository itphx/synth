import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { AsyncLock } from '@itphx/synth-shared';
import type {
  PipelineRunEventListOptions,
  PipelineRunEventRecord,
  PipelineRunFilter,
  PipelineRunRecord,
  PipelineRunRepository,
} from './ports/pipeline-run-repository.js';
import { resolveCollectionLimit } from './ports/collection-limit.js';
import { readCollectionFile, writeCollectionFile } from './json-collection-file.js';
import { resolveCreatedAt, resolveUpdatedAt } from './record-timestamps.js';

export interface FilePipelineRunStoreConfig {
  dataDir: string;
}

/** Ключ массива прогонов внутри JSON-файла. */
const RUNS_KEY = 'runs';

/**
 * ADR-101: файловая реализация порта прогонов пайплайнов и журнала выполнения
 * (ADR-096 — слой хранения; ADR-005 — JSON + атомарная запись tmp→rename).
 *
 * Физическое расположение:
 * - заголовки прогонов — `{dataDir}/pipelines/runs.json` (JSON-коллекция);
 * - журнал событий — `{dataDir}/pipelines/run-events.jsonl` (append-only,
 *   образец — `EventJournalStore`/`JobStore`).
 *
 * Журнал **неизменяем**: `appendEvent` только добавляет строку, правки
 * ранее записанных событий нет. Порядок чтения — хронологический (по `ts`),
 * при равных `ts` — по порядку добавления.
 *
 * Legacy-хранилище ADR-100 (`{dataDir}/pipelines/instances.json`) **не
 * трогается и не смешивается** с этими файлами.
 */
export class FilePipelineRunStore implements PipelineRunRepository {
  private readonly _lock = new AsyncLock();

  constructor(private readonly _config: FilePipelineRunStoreConfig) {}

  /** Каталог пайплайнов (`{dataDir}/pipelines`). */
  root(): string {
    return join(this._config.dataDir, 'pipelines');
  }

  /** Путь файла заголовков прогонов. */
  runsPath(): string {
    return join(this.root(), `${RUNS_KEY}.json`);
  }

  /** Путь файла журнала событий прогона (append-only JSONL). */
  eventsPath(): string {
    return join(this.root(), 'run-events.jsonl');
  }

  async saveRun(rec: PipelineRunRecord): Promise<void> {
    await this._lock.acquire();
    try {
      const runs = await this._readRuns();
      const index = runs.findIndex((r) => r.id === rec.id);
      const stored = index === -1 ? undefined : runs[index];
      const record: PipelineRunRecord = {
        ...rec,
        // `createdAt` иммутабельно, `updatedAt` монотонно обновляется.
        createdAt: resolveCreatedAt(stored?.createdAt, rec.createdAt),
        updatedAt: resolveUpdatedAt(stored?.updatedAt, rec.updatedAt),
      };
      if (index === -1) {
        runs.push(record);
      } else {
        runs[index] = record;
      }
      await this._writeRuns(runs);
    } finally {
      this._lock.release();
    }
  }

  async getRun(id: string): Promise<PipelineRunRecord | null> {
    const runs = await this._readRuns();
    return runs.find((r) => r.id === id) ?? null;
  }

  async listRuns(filter?: PipelineRunFilter): Promise<PipelineRunRecord[]> {
    const runs = await this._readRuns();
    const filtered = runs.filter(
      (r) =>
        (filter?.pipelineId === undefined || r.pipelineId === filter.pipelineId) &&
        (filter?.projectId === undefined || r.projectId === filter.projectId) &&
        (filter?.status === undefined || r.status === filter.status),
    );
    // Свежие первыми (`createdAt` убыв.), тайбрейкер — `id` (детерминированно).
    const sorted = [...filtered].sort((a, b) => {
      const diff = Date.parse(b.createdAt) - Date.parse(a.createdAt);
      if (diff !== 0 && !Number.isNaN(diff)) return diff;
      return a.id.localeCompare(b.id);
    });
    return sorted.slice(0, resolveCollectionLimit(filter?.limit));
  }

  async appendEvent(ev: PipelineRunEventRecord): Promise<void> {
    await this._lock.acquire();
    try {
      const path = this.eventsPath();
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, `${JSON.stringify(ev)}\n`, { encoding: 'utf8' });
    } finally {
      this._lock.release();
    }
  }

  async listEvents(
    runId: string,
    opts?: PipelineRunEventListOptions,
  ): Promise<PipelineRunEventRecord[]> {
    const events = (await this._readAllEvents())
      .filter((e) => e.event.runId === runId)
      .sort((a, b) => {
        const diff = tsMs(a.event.ts) - tsMs(b.event.ts);
        if (diff !== 0) return diff;
        // При равных `ts` — порядок добавления.
        return a.index - b.index;
      })
      .map((e) => e.event);
    const limit = opts?.limit;
    if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return events;
    return events.slice(-Math.floor(limit));
  }

  private async _readRuns(): Promise<PipelineRunRecord[]> {
    return readCollectionFile<PipelineRunRecord>(
      this.runsPath(),
      RUNS_KEY,
      'файл прогонов пайплайнов',
    );
  }

  private async _writeRuns(runs: PipelineRunRecord[]): Promise<void> {
    await writeCollectionFile(this.runsPath(), RUNS_KEY, runs);
  }

  /** Все события журнала в порядке добавления (с индексом строки — тайбрейкер). */
  private async _readAllEvents(): Promise<Array<{ event: PipelineRunEventRecord; index: number }>> {
    let raw: string;
    try {
      raw = await readFile(this.eventsPath(), 'utf8');
    } catch {
      return [];
    }

    const events: Array<{ event: PipelineRunEventRecord; index: number }> = [];
    let index = 0;
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        events.push({ event: JSON.parse(trimmed) as PipelineRunEventRecord, index });
        index += 1;
      } catch (e) {
        console.warn(
          `[FilePipelineRunStore] повреждённая строка журнала прогона пропущена: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    }
    return events;
  }
}

/** Время события в мс (`NaN` → 0 — неразобранная метка не ломает порядок). */
function tsMs(ts: string): number {
  const parsed = Date.parse(ts);
  return Number.isNaN(parsed) ? 0 : parsed;
}

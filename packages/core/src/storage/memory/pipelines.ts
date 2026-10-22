/**
 * In-memory реализации портов **движка пайплайнов** (ADR-101): спецификации
 * (черновик + опубликованные версии), прогоны и журнал выполнения
 * (ADR-096, второй backend за единым слоем хранения).
 *
 * Чистая реализация без модулей ФС (`fs`/`path`): состояние — в `Map`/массиве
 * процесса. Семантика повторяет файловую реализацию (`FileProjectPipelineStore`,
 * `FilePipelineRunStore`): upsert по `id` (`createdAt` сохраняется, `updatedAt`
 * монотонно обновляется), детерминированный порядок списков, выборка прогонов
 * «свежие первыми», append-only журнал событий.
 *
 * Возвращаемые записи — копии (`structuredClone`), как в остальных memory-портах.
 */

import { normalizeIconKey } from '@itphx/synth-shared';
import type {
  PipelineFilter,
  PipelineRecord,
  PipelineRunEventListOptions,
  PipelineRunEventRecord,
  PipelineRunFilter,
  PipelineRunRecord,
  PipelineRunRepository,
  PipelineVersionRecord,
  ProjectPipelineRepository,
} from '../ports/index.js';
import { resolveCollectionLimit } from '../ports/collection-limit.js';
import { resolveCreatedAt, resolveUpdatedAt } from '../record-timestamps.js';

/**
 * Порт спецификаций пайплайнов поверх `Map` (ADR-101; реализация —
 * `FileProjectPipelineStore`).
 */
export class MemoryProjectPipelineRepository implements ProjectPipelineRepository {
  private readonly _pipelines = new Map<string, PipelineRecord>();
  /** Версии — по составному ключу `${pipelineId}@${version}`. */
  private readonly _versions = new Map<string, PipelineVersionRecord>();

  async savePipeline(rec: PipelineRecord): Promise<void> {
    const stored = this._pipelines.get(rec.id);
    this._pipelines.set(rec.id, {
      ...structuredClone(rec),
      createdAt: resolveCreatedAt(stored?.createdAt, rec.createdAt),
      updatedAt: resolveUpdatedAt(stored?.updatedAt, rec.updatedAt),
    });
  }

  async getPipeline(id: string): Promise<PipelineRecord | null> {
    const record = this._pipelines.get(id);
    return record ? normalizePipeline(structuredClone(record)) : null;
  }

  async listPipelines(filter?: PipelineFilter): Promise<PipelineRecord[]> {
    return [...this._pipelines.values()]
      .filter(
        (p) =>
          (filter?.scope === undefined || p.scope === filter.scope) &&
          (filter?.projectId === undefined || p.projectId === filter.projectId),
      )
      .map((p) => normalizePipeline(structuredClone(p)))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async deletePipeline(id: string): Promise<boolean> {
    const deleted = this._pipelines.delete(id);
    if (!deleted) return false;
    // Версии пайплайна удаляются каскадом; прогоны живут в отдельном порту и
    // не трогаются (прогон самодостаточен).
    for (const [key, version] of [...this._versions.entries()]) {
      if (version.pipelineId === id) this._versions.delete(key);
    }
    return true;
  }

  async saveVersion(rec: PipelineVersionRecord): Promise<void> {
    this._versions.set(versionKey(rec.pipelineId, rec.version), structuredClone(rec));
  }

  async getVersion(pipelineId: string, version: number): Promise<PipelineVersionRecord | null> {
    const record = this._versions.get(versionKey(pipelineId, version));
    return record ? structuredClone(record) : null;
  }

  async listVersions(pipelineId: string): Promise<PipelineVersionRecord[]> {
    return [...this._versions.values()]
      .filter((v) => v.pipelineId === pipelineId)
      .map((v) => structuredClone(v))
      .sort((a, b) => a.version - b.version);
  }
}

/**
 * Порт прогонов пайплайнов и журнала выполнения поверх `Map`/массива
 * (ADR-101; реализация — `FilePipelineRunStore`).
 */
export class MemoryPipelineRunRepository implements PipelineRunRepository {
  private readonly _runs = new Map<string, PipelineRunRecord>();
  /** Журнал событий — append-only (только добавление). */
  private readonly _events: PipelineRunEventRecord[] = [];

  async saveRun(rec: PipelineRunRecord): Promise<void> {
    const stored = this._runs.get(rec.id);
    this._runs.set(rec.id, {
      ...structuredClone(rec),
      createdAt: resolveCreatedAt(stored?.createdAt, rec.createdAt),
      updatedAt: resolveUpdatedAt(stored?.updatedAt, rec.updatedAt),
    });
  }

  async getRun(id: string): Promise<PipelineRunRecord | null> {
    const record = this._runs.get(id);
    return record ? structuredClone(record) : null;
  }

  async listRuns(filter?: PipelineRunFilter): Promise<PipelineRunRecord[]> {
    const filtered = [...this._runs.values()].filter(
      (r) =>
        (filter?.pipelineId === undefined || r.pipelineId === filter.pipelineId) &&
        (filter?.projectId === undefined || r.projectId === filter.projectId) &&
        (filter?.status === undefined || r.status === filter.status),
    );
    // Свежие первыми (`createdAt` убыв.), тайбрейкер — `id`.
    const sorted = [...filtered].sort((a, b) => {
      const diff = Date.parse(b.createdAt) - Date.parse(a.createdAt);
      if (diff !== 0 && !Number.isNaN(diff)) return diff;
      return a.id.localeCompare(b.id);
    });
    return sorted.slice(0, resolveCollectionLimit(filter?.limit)).map((r) => structuredClone(r));
  }

  async appendEvent(ev: PipelineRunEventRecord): Promise<void> {
    // Append-only: журнал неизменяем, только добавление.
    this._events.push(structuredClone(ev));
  }

  async listEvents(
    runId: string,
    opts?: PipelineRunEventListOptions,
  ): Promise<PipelineRunEventRecord[]> {
    const events = this._events
      .map((event, index) => ({ event, index }))
      .filter((e) => e.event.runId === runId)
      .sort((a, b) => {
        const diff = tsMs(a.event.ts) - tsMs(b.event.ts);
        if (diff !== 0) return diff;
        // При равных `ts` — порядок добавления.
        return a.index - b.index;
      })
      .map((e) => structuredClone(e.event));
    const limit = opts?.limit;
    if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return events;
    return events.slice(-Math.floor(limit));
  }
}

/** Составной ключ версии (`pipelineId@version`). */
function versionKey(pipelineId: string, version: number): string {
  return `${pipelineId}@${version}`;
}

/** Нормализация метаданных при чтении (канонический ключ иконки). */
function normalizePipeline(rec: PipelineRecord): PipelineRecord {
  return { ...rec, icon: normalizeIconKey(rec.icon) };
}

/** Время события в мс (`NaN` → 0 — неразобранная метка не ломает порядок). */
function tsMs(ts: string): number {
  const parsed = Date.parse(ts);
  return Number.isNaN(parsed) ? 0 : parsed;
}

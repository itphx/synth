import { join } from 'node:path';
import { AsyncLock, normalizeIconKey } from '@itphx/synth-shared';
import type {
  PipelineFilter,
  PipelineRecord,
  PipelineVersionRecord,
  ProjectPipelineRepository,
} from './ports/project-pipeline-repository.js';
import { readCollectionFile, writeCollectionFile } from './json-collection-file.js';
import { resolveCreatedAt, resolveUpdatedAt } from './record-timestamps.js';

export interface FileProjectPipelineStoreConfig {
  dataDir: string;
}

/** Ключ массива пайплайнов внутри JSON-файла. */
const PIPELINES_KEY = 'pipelines';
/** Ключ массива опубликованных версий внутри JSON-файла. */
const VERSIONS_KEY = 'versions';

/**
 * ADR-101: файловая реализация порта спецификаций пайплайнов
 * (ADR-096 — слой хранения; ADR-005 — JSON + атомарная запись tmp→rename).
 *
 * Физическое расположение:
 * - спецификации (черновики) — `{dataDir}/pipelines/pipelines.json`;
 * - опубликованные версии — `{dataDir}/pipelines/versions.json`.
 *
 * Каталог создаётся при первой записи; отсутствие файла — пустой репозиторий
 * (не ошибка). Повреждённый JSON — понятная ошибка, а не тихий пустой список
 * (`readCollectionFile`).
 *
 * Legacy-хранилище ADR-100 (`{dataDir}/pipelines/definitions.json` и
 * `instances.json`) **не трогается и не смешивается** с этими файлами: там
 * «декларация + учёт прогона», здесь — спецификация `PipelineSpec` с
 * версионированием (ADR-101).
 */
export class FileProjectPipelineStore implements ProjectPipelineRepository {
  private readonly _lock = new AsyncLock();

  constructor(private readonly _config: FileProjectPipelineStoreConfig) {}

  /** Каталог пайплайнов (`{dataDir}/pipelines`). */
  root(): string {
    return join(this._config.dataDir, 'pipelines');
  }

  /** Путь файла спецификаций (черновиков). */
  pipelinesPath(): string {
    return join(this.root(), `${PIPELINES_KEY}.json`);
  }

  /** Путь файла опубликованных версий. */
  versionsPath(): string {
    return join(this.root(), `${VERSIONS_KEY}.json`);
  }

  async savePipeline(rec: PipelineRecord): Promise<void> {
    await this._lock.acquire();
    try {
      const pipelines = await this._readPipelines();
      const index = pipelines.findIndex((p) => p.id === rec.id);
      const stored = index === -1 ? undefined : pipelines[index];
      const record: PipelineRecord = {
        ...rec,
        // `createdAt` иммутабельно, `updatedAt` монотонно обновляется.
        createdAt: resolveCreatedAt(stored?.createdAt, rec.createdAt),
        updatedAt: resolveUpdatedAt(stored?.updatedAt, rec.updatedAt),
      };
      if (index === -1) {
        pipelines.push(record);
      } else {
        pipelines[index] = record;
      }
      await this._writePipelines(pipelines);
    } finally {
      this._lock.release();
    }
  }

  async getPipeline(id: string): Promise<PipelineRecord | null> {
    const pipelines = await this._readPipelines();
    const found = pipelines.find((p) => p.id === id);
    return found ? normalizePipeline(found) : null;
  }

  async listPipelines(filter?: PipelineFilter): Promise<PipelineRecord[]> {
    const pipelines = await this._readPipelines();
    const filtered = pipelines.filter(
      (p) =>
        (filter?.scope === undefined || p.scope === filter.scope) &&
        (filter?.projectId === undefined || p.projectId === filter.projectId),
    );
    // Детерминированный порядок — по `id`.
    return [...filtered].sort((a, b) => a.id.localeCompare(b.id)).map(normalizePipeline);
  }

  async deletePipeline(id: string): Promise<boolean> {
    await this._lock.acquire();
    try {
      const pipelines = await this._readPipelines();
      const next = pipelines.filter((p) => p.id !== id);
      if (next.length === pipelines.length) return false;

      // Версии пайплайна удаляются каскадом; прогоны **не** трогаются — прогон
      // самодостаточен (несёт снимок спецификации).
      const versions = await this._readVersions();
      const nextVersions = versions.filter((v) => v.pipelineId !== id);

      await this._writePipelines(next);
      if (nextVersions.length !== versions.length) {
        await this._writeVersions(nextVersions);
      }
      return true;
    } finally {
      this._lock.release();
    }
  }

  async saveVersion(rec: PipelineVersionRecord): Promise<void> {
    await this._lock.acquire();
    try {
      const versions = await this._readVersions();
      const index = versions.findIndex((v) => v.pipelineId === rec.pipelineId && v.version === rec.version);
      if (index === -1) {
        versions.push(rec);
      } else {
        versions[index] = rec;
      }
      await this._writeVersions(versions);
    } finally {
      this._lock.release();
    }
  }

  async getVersion(pipelineId: string, version: number): Promise<PipelineVersionRecord | null> {
    const versions = await this._readVersions();
    return versions.find((v) => v.pipelineId === pipelineId && v.version === version) ?? null;
  }

  async listVersions(pipelineId: string): Promise<PipelineVersionRecord[]> {
    const versions = await this._readVersions();
    return versions
      .filter((v) => v.pipelineId === pipelineId)
      .sort((a, b) => a.version - b.version);
  }

  private async _readPipelines(): Promise<PipelineRecord[]> {
    return readCollectionFile<PipelineRecord>(
      this.pipelinesPath(),
      PIPELINES_KEY,
      'файл спецификаций пайплайнов',
    );
  }

  private async _writePipelines(pipelines: PipelineRecord[]): Promise<void> {
    await writeCollectionFile(this.pipelinesPath(), PIPELINES_KEY, pipelines);
  }

  private async _readVersions(): Promise<PipelineVersionRecord[]> {
    return readCollectionFile<PipelineVersionRecord>(
      this.versionsPath(),
      VERSIONS_KEY,
      'файл опубликованных версий пайплайнов',
    );
  }

  private async _writeVersions(versions: PipelineVersionRecord[]): Promise<void> {
    await writeCollectionFile(this.versionsPath(), VERSIONS_KEY, versions);
  }
}

/**
 * Нормализация метаданных при чтении (как у `ProjectStore.load`): неканонический
 * ключ иконки → `undefined` (в памяти всегда только канонические значения).
 */
function normalizePipeline(rec: PipelineRecord): PipelineRecord {
  return { ...rec, icon: normalizeIconKey(rec.icon) };
}

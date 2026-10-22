import { join } from 'node:path';
import { AsyncLock } from '@itphx/synth-shared';
import type {
  PipelineDefinitionRecord,
  PipelineInstanceFilter,
  PipelineInstanceRecord,
  PipelineRepository,
} from './ports/pipeline-repository.js';
import { resolvePipelineInstanceLimit } from './ports/pipeline-repository.js';
import { readCollectionFile, writeCollectionFile } from './json-collection-file.js';
import { resolveCreatedAt, resolveUpdatedAt } from './record-timestamps.js';

export interface FilePipelineStoreConfig {
  dataDir: string;
}

/** Ключ массива определений внутри JSON-файла. */
const DEFINITIONS_KEY = 'definitions';
/** Ключ массива экземпляров внутри JSON-файла. */
const INSTANCES_KEY = 'instances';

/**
 * ADR-051/ADR-100: файловая реализация порта пайплайнов (ADR-096 — слой
 * хранения; ADR-005 — JSON + атомарная запись tmp→rename).
 *
 * Физическое расположение:
 * - определения — `{dataDir}/pipelines/definitions.json`;
 * - экземпляры — `{dataDir}/pipelines/instances.json`.
 *
 * Каталог создаётся при первой записи; отсутствие файла — пустой репозиторий
 * (не ошибка). Повреждённый JSON — понятная ошибка, а не тихий пустой список
 * (`readCollectionFile`).
 */
export class FilePipelineStore implements PipelineRepository {
  private readonly _lock = new AsyncLock();

  constructor(private readonly _config: FilePipelineStoreConfig) {}

  /** Каталог пайплайнов (`{dataDir}/pipelines`). */
  root(): string {
    return join(this._config.dataDir, 'pipelines');
  }

  /** Путь файла определений. */
  definitionsPath(): string {
    return join(this.root(), `${DEFINITIONS_KEY}.json`);
  }

  /** Путь файла экземпляров. */
  instancesPath(): string {
    return join(this.root(), `${INSTANCES_KEY}.json`);
  }

  async saveDefinition(def: PipelineDefinitionRecord): Promise<void> {
    await this._lock.acquire();
    try {
      const definitions = await this._readDefinitions();
      const index = definitions.findIndex((d) => d.id === def.id);
      const stored = index === -1 ? undefined : definitions[index];
      const record: PipelineDefinitionRecord = {
        ...def,
        // `createdAt` иммутабельно, `updatedAt` монотонно обновляется.
        createdAt: resolveCreatedAt(stored?.createdAt, def.createdAt),
        updatedAt: resolveUpdatedAt(stored?.updatedAt, def.updatedAt),
      };
      if (index === -1) {
        definitions.push(record);
      } else {
        definitions[index] = record;
      }
      await this._writeDefinitions(definitions);
    } finally {
      this._lock.release();
    }
  }

  async getDefinition(id: string): Promise<PipelineDefinitionRecord | null> {
    const definitions = await this._readDefinitions();
    return definitions.find((d) => d.id === id) ?? null;
  }

  async listDefinitions(): Promise<PipelineDefinitionRecord[]> {
    const definitions = await this._readDefinitions();
    // Детерминированный порядок — по `id`.
    return [...definitions].sort((a, b) => a.id.localeCompare(b.id));
  }

  async deleteDefinition(id: string): Promise<boolean> {
    await this._lock.acquire();
    try {
      const definitions = await this._readDefinitions();
      const next = definitions.filter((d) => d.id !== id);
      if (next.length === definitions.length) return false;
      await this._writeDefinitions(next);
      return true;
    } finally {
      this._lock.release();
    }
  }

  async saveInstance(instance: PipelineInstanceRecord): Promise<void> {
    await this._lock.acquire();
    try {
      const instances = await this._readInstances();
      const index = instances.findIndex((i) => i.id === instance.id);
      const stored = index === -1 ? undefined : instances[index];
      const record: PipelineInstanceRecord = {
        ...instance,
        createdAt: resolveCreatedAt(stored?.createdAt, instance.createdAt),
        updatedAt: resolveUpdatedAt(stored?.updatedAt, instance.updatedAt),
      };
      if (index === -1) {
        instances.push(record);
      } else {
        instances[index] = record;
      }
      await this._writeInstances(instances);
    } finally {
      this._lock.release();
    }
  }

  async getInstance(id: string): Promise<PipelineInstanceRecord | null> {
    const instances = await this._readInstances();
    return instances.find((i) => i.id === id) ?? null;
  }

  async listInstances(filter?: PipelineInstanceFilter): Promise<PipelineInstanceRecord[]> {
    const instances = await this._readInstances();
    const filtered = instances.filter(
      (i) =>
        (filter?.pipelineId === undefined || i.pipelineId === filter.pipelineId) &&
        (filter?.status === undefined || i.status === filter.status),
    );
    // Свежие первыми (`createdAt` убыв.), тайбрейкер — `id` (детерминированно).
    const sorted = [...filtered].sort((a, b) => {
      const diff = Date.parse(b.createdAt) - Date.parse(a.createdAt);
      if (diff !== 0 && !Number.isNaN(diff)) return diff;
      return a.id.localeCompare(b.id);
    });
    return sorted.slice(0, resolvePipelineInstanceLimit(filter?.limit));
  }

  private async _readDefinitions(): Promise<PipelineDefinitionRecord[]> {
    return readCollectionFile<PipelineDefinitionRecord>(
      this.definitionsPath(),
      DEFINITIONS_KEY,
      'файл определений пайплайнов',
    );
  }

  private async _writeDefinitions(definitions: PipelineDefinitionRecord[]): Promise<void> {
    await writeCollectionFile(this.definitionsPath(), DEFINITIONS_KEY, definitions);
  }

  private async _readInstances(): Promise<PipelineInstanceRecord[]> {
    return readCollectionFile<PipelineInstanceRecord>(
      this.instancesPath(),
      INSTANCES_KEY,
      'файл экземпляров пайплайнов',
    );
  }

  private async _writeInstances(instances: PipelineInstanceRecord[]): Promise<void> {
    await writeCollectionFile(this.instancesPath(), INSTANCES_KEY, instances);
  }
}

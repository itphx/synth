/**
 * М2: менеджер индексов памяти — жизненный цикл корпуса (движок ванильного RAG).
 *
 * Индекс — построенный корпус для retrieval: чанки документов с векторами
 * эмбеддингов. Модель и правила — docs/MEMORY.md §5.2 (поколения,
 * фингерпринт, состояния) и §2.3 (решения М2).
 *
 * Ключевые свойства:
 * - **поколения**: сборка пишет новое поколение (`generation + 1`) через
 *   `replaceChunks` (атомарная замена поколения) и переключает индекс одной
 *   записью `saveIndex({state:'ready', generation})`; **старое поколение
 *   удаляется только после переключения** — до этого поиск продолжает видеть
 *   прежний корпус;
 * - **фоновая сборка**: `create`/`rebuild` возвращают запись сразу, сборка
 *   идёт в фоне, состояние меняется на `ready`/`failed` через `saveIndex`;
 * - **фингерпринт** (`model` + `dimension` + `chunkerVersion`): расхождение с
 *   текущей конфигурацией делает индекс `stale` — «тихо похожим» вектор быть
 *   не может (docs/MEMORY.md §5.2). Проверяется **при чтении статуса**,
 *   авто-перестройки нет;
 * - **ошибка сборки не роняет процесс**: индекс переходит в `failed` с
 *   текстом ошибки, предыдущее поколение остаётся доступным для поиска.
 *
 * Данные — через порты `facade.memory.indexes` (ядро владеет данными памяти,
 * ADR-096/ADR-107); плагин не пишет в `$SYNTH_DATA_DIR` мимо порта.
 */
import { createHash, randomUUID } from 'node:crypto';

import type {
  MemoryChunkRecord,
  MemoryFactRecord,
  MemoryIndexFingerprint,
  MemoryIndexRecord,
  MemoryIndexRepository,
  MemoryIndexScope,
  MemoryIndexState,
  PluginFacade,
} from '@itphx/synth-core';

import { IndexBusyError, IndexNotFoundError, MemoryUnavailableError } from '../errors.js';
import type { MemoryPluginSettings } from '../settings.js';
import { CHUNKER_VERSION, chunkText } from './chunker.js';
import { collectTextFiles } from './corpus.js';
import { embedTexts } from './embedder.js';

/** Провайдер памяти, которому принадлежат индексы плагина. */
export const INDEX_PROVIDER_ID = 'plugin:synth-plugin-memory';

/** Дефолтное имя индекса проекта. */
export const DEFAULT_INDEX_NAME = 'project';

/**
 * Дефолтное имя инстансного (общего на инстанс) индекса.
 *
 * Отличается от имени проектного: в списке индексов видно, что корпус общий.
 */
export const DEFAULT_INSTANCE_INDEX_NAME = 'instance';

/** Идентификатор модели эмбеддингов, когда модель не задана явно. */
export const DEFAULT_EMBEDDING_MODEL = 'instance-default';

/** Текст «пробы» размерности вектора (нужен, чтобы узнать текущую размерность). */
const DIMENSION_PROBE_TEXT = 'synth memory dimension probe';

/** Виды источника корпуса (М2). */
export type IndexSourceKind = 'files' | 'facts';

/** Источник корпуса индекса. */
export interface IndexSourceSpec {
  /** Вид источника: файлы рабочего каталога или факты памяти. */
  kind: IndexSourceKind;
  /** Фильтр источника (glob для файлов — не используется в М2). */
  filter?: string;
}

/** Статус индекса: запись порта + эффективное состояние. */
export interface IndexStatus {
  /** Запись индекса (как в порту). */
  index: MemoryIndexRecord;
  /** Эффективное состояние (с учётом расхождения фингерпринта). */
  state: MemoryIndexState;
  /** Фингерпринт индекса разошёлся с текущей конфигурацией. */
  stale: boolean;
}

/** Вход создания индекса. */
export interface CreateIndexInput {
  /** Имя индекса (по умолчанию — `project`/`instance` — по области видимости). */
  name?: string;
  /** Источник корпуса (по умолчанию — файлы рабочего каталога). */
  source?: IndexSourceSpec;
  /**
   * Область видимости индекса (по умолчанию — `project`).
   *
   * - `project` — индекс виден только проекту `projectId`;
   * - `instance` — общий на инстанс: виден всем сессиям и проектам, а
   *   `projectId` (если задан) — **источник корпуса** (`files`), не владелец.
   */
  scope?: MemoryIndexScope;
  /** Проект-владелец индекса (для `scope:'instance'` — источник корпуса). */
  projectId?: string;
  /** Рабочий каталог (источник `files`). */
  workingDir?: string;
}

/** Вход пересборки индекса. */
export interface RebuildIndexInput {
  /** Повторить сборку, даже если она уже идёт. */
  force?: boolean;
  /** Рабочий каталог (источник `files`). */
  workingDir?: string;
}

/** Зависимости менеджера индексов. */
export interface IndexManagerDeps {
  /** Фасад плагина (порты памяти + эмбеддинги + настройки). */
  facade: PluginFacade;
  /**
   * Активные факты — источник `facts`.
   *
   * `allProjects` — **все** активные факты инстанса (инстансный индекс);
   * без флага — факты проекта (`projectId`) и факты без проекта.
   */
  listFacts: (opts: {
    status?: 'active';
    projectId?: string;
    allProjects?: boolean;
  }) => Promise<MemoryFactRecord[]>;
  /** Настройки плагина (нормализованные). */
  settings: () => MemoryPluginSettings;
}

/** Документ корпуса (до нарезки). */
interface SourceDocument {
  /** Идентификатор документа (путь файла или id факта). */
  documentId: string;
  /** Текст документа. */
  text: string;
  /** Метаданные документа (для чанка). */
  metadata: Record<string, unknown>;
  /** Документ не режется (факт — это уже единица памяти). */
  whole?: boolean;
}

/** Чанк корпуса (до эмбеддинга). */
interface SourceChunk {
  documentId: string;
  ordinal: number;
  text: string;
  metadata: Record<string, unknown>;
}

/**
 * Хэш входа эмбеддинга: `model|dimension|chunkerVersion|text`.
 *
 * По нему вектор переиспользуется при пересборке, пока фингерпринт не
 * изменился (docs/MEMORY.md §5.2).
 */
export function embeddingInputHash(
  model: string,
  dimension: number,
  text: string,
): string {
  return createHash('sha256')
    .update(`${model}|${dimension}|${CHUNKER_VERSION}|${text}`)
    .digest('hex');
}

/** Текст ошибки (из любого исключения). */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Менеджер индексов памяти.
 *
 * Единственный владелец жизненного цикла корпуса: создание, пересборка,
 * удаление, статус. Поиск — в `engine/search.ts` (тот же слой движка).
 */
export class IndexManager {
  private readonly _deps: IndexManagerDeps;
  /** Фоновые сборки (для ожидания в тестах и в статусе). */
  private readonly _pending = new Set<Promise<void>>();
  /** Кэш «пробы» размерности вектора. */
  private _probe: { model: string; dimension: number; at: number } | null = null;

  constructor(deps: IndexManagerDeps) {
    this._deps = deps;
  }

  /** Доступен ли сервис памяти в этом инстансе (фича-детект). */
  get available(): boolean {
    return this._deps.facade.memory !== undefined;
  }

  /** Идёт ли сейчас фоновая сборка. */
  get building(): boolean {
    return this._pending.size > 0;
  }

  /** Порт индексов (бросает, если сервис памяти недоступен). */
  private _indexes(): MemoryIndexRepository {
    const memory = this._deps.facade.memory;
    if (!memory) throw new MemoryUnavailableError();
    return memory.indexes;
  }

  /** Модель эмбеддингов из настроек плагина. */
  private _model(): string {
    return this._deps.settings().embeddingModel || DEFAULT_EMBEDDING_MODEL;
  }

  /**
   * Текущий фингерпринт конфигурации.
   *
   * Размерность узнаётся «пробой» (один эмбеддинг короткого текста): модель
   * инстанса может смениться за спиной (конфиг `plugins.embeddingModel` пуст →
   * `instance-default`), и тогда размерность вектора меняется — индекс должен
   * стать `stale`, а не «похожим». Проба кэшируется на `dimensionProbeTtlMs`.
   */
  async currentFingerprint(): Promise<MemoryIndexFingerprint> {
    const model = this._model();
    const ttl = this._deps.settings().dimensionProbeTtlMs;
    const now = Date.now();
    const cached = this._probe;
    if (cached && cached.model === model && ttl > 0 && now - cached.at < ttl) {
      return { model, dimension: cached.dimension, chunkerVersion: CHUNKER_VERSION };
    }
    let dimension = 0;
    try {
      const embedded = await embedTexts(this._deps.facade, [DIMENSION_PROBE_TEXT]);
      dimension = embedded.dimension;
      this._probe = { model, dimension, at: now };
    } catch {
      // Эмбеддинги не сконфигурированы/недоступны: размерность неизвестна —
      // stale по размерности не проверяем (модель проверяется всегда).
      dimension = 0;
    }
    return { model, dimension, chunkerVersion: CHUNKER_VERSION };
  }

  /**
   * Эффективное состояние индекса.
   *
   * `stale`, если фингерпринт индекса разошёлся с текущей конфигурацией
   * (модель, размерность или версия чанкера). Авто-перестройки нет.
   */
  async resolveStatus(index: MemoryIndexRecord): Promise<IndexStatus> {
    const current = await this.currentFingerprint();
    const fingerprint = index.fingerprint;
    const stale =
      fingerprint.chunkerVersion !== current.chunkerVersion ||
      fingerprint.model !== current.model ||
      (current.dimension > 0 &&
        fingerprint.dimension > 0 &&
        fingerprint.dimension !== current.dimension);
    return {
      index,
      state: stale ? 'stale' : index.state,
      stale,
    };
  }

  /** Индексы (записи порта) по фильтру. */
  async listIndexes(query?: { projectId?: string }): Promise<MemoryIndexRecord[]> {
    const indexes = this._indexes();
    return indexes.listIndexes({
      ...(query?.projectId ? { projectId: query.projectId } : {}),
    });
  }

  /** Статусы индексов по фильтру (с вычислением `stale`). */
  async statuses(query?: { projectId?: string }): Promise<IndexStatus[]> {
    const records = await this.listIndexes(query);
    const statuses: IndexStatus[] = [];
    for (const record of records) statuses.push(await this.resolveStatus(record));
    return statuses;
  }

  /** Индекс по id (запись порта) или `null`. */
  async getIndex(id: string): Promise<MemoryIndexRecord | null> {
    return this._indexes().getIndex(id);
  }

  /** Статус индекса по id или `null`. */
  async getStatus(id: string): Promise<IndexStatus | null> {
    const record = await this.getIndex(id);
    if (!record) return null;
    return this.resolveStatus(record);
  }

  /**
   * Создать индекс и **запустить фоновую сборку**.
   *
   * Возвращает запись сразу (состояние `building`) — сборка продолжается в
   * фоне, итоговое состояние — `ready`/`failed` (через `saveIndex`).
   */
  async createIndex(input: CreateIndexInput): Promise<IndexStatus> {
    const indexes = this._indexes();
    const now = new Date().toISOString();
    const source = input.source ?? { kind: 'files' as IndexSourceKind };
    const scope: MemoryIndexScope = input.scope ?? 'project';
    const index: MemoryIndexRecord = {
      id: `idx_${randomUUID()}`,
      // Namespace навязывает хост (ADR-107) — значение игнорируется.
      namespace: '',
      name: input.name?.trim() || defaultIndexName(scope),
      providerId: INDEX_PROVIDER_ID,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      scope,
      source: {
        kind: source.kind,
        ...(source.filter ? { filter: source.filter } : {}),
      },
      state: 'building',
      generation: 0,
      fingerprint: { model: this._model(), dimension: 0, chunkerVersion: CHUNKER_VERSION },
      stats: { documents: 0, chunks: 0, updatedAt: now },
      createdAt: now,
      updatedAt: now,
    };
    await indexes.saveIndex(index);
    this._track(
      this._build(index, { targetGeneration: 1, previousGeneration: 0, workingDir: input.workingDir }),
    );
    return { index, state: 'building', stale: false };
  }

  /**
   * Пересобрать индекс (фоновая сборка нового поколения).
   *
   * Новое поколение = `current + 1`; предыдущее удаляется **после**
   * переключения на новое. Индекс в состоянии `building` без `force` —
   * отказ (`IndexBusyError`).
   *
   * Область видимости (`scope`) при пересборке **не меняется** — запись
   * копируется целиком (`...current`).
   */
  async rebuildIndex(id: string, input: RebuildIndexInput = {}): Promise<IndexStatus> {
    const indexes = this._indexes();
    const current = await indexes.getIndex(id);
    if (!current) throw new IndexNotFoundError();
    if (current.state === 'building' && !input.force) throw new IndexBusyError();

    const target = current.generation + 1;
    const building: MemoryIndexRecord = {
      ...current,
      state: 'building',
      generation: target,
      error: undefined,
      updatedAt: new Date().toISOString(),
    };
    await indexes.saveIndex(building);
    this._track(
      this._build(building, {
        targetGeneration: target,
        previousGeneration: current.generation,
        workingDir: input.workingDir,
      }),
    );
    return { index: building, state: 'building', stale: false };
  }

  /** Удалить индекс (каскад чанков — порт). */
  async deleteIndex(id: string): Promise<boolean> {
    return this._indexes().deleteIndex(id);
  }

  /** Дождаться окончания фоновых сборок (тесты, портал). */
  async whenIdle(): Promise<void> {
    while (this._pending.size > 0) {
      await Promise.all([...this._pending]);
    }
  }

  /** Зарегистрировать фоновую задачу (ошибки не должны ронять процесс). */
  private _track(work: Promise<void>): void {
    const tracked = work.catch(() => undefined);
    this._pending.add(tracked);
    void tracked.then(() => {
      this._pending.delete(tracked);
    });
  }

  /**
   * Сборка корпуса: документы → чанки → эмбеддинги → запись поколения.
   *
   * Ошибка (в т.ч. `plugin.embedding_not_configured`) → индекс `failed` с
   * текстом ошибки; прежнее поколение остаётся доступным для поиска.
   */
  private async _build(
    index: MemoryIndexRecord,
    options: { targetGeneration: number; previousGeneration: number; workingDir?: string },
  ): Promise<void> {
    const indexes = this._indexes();
    try {
      const documents = await this._collectDocuments(index, options.workingDir);
      const chunks = this._chunkDocuments(documents);
      const embedded = await embedTexts(
        this._deps.facade,
        chunks.map((chunk) => chunk.text),
      );
      const model = this._model();
      const dimension = embedded.dimension;

      const records: MemoryChunkRecord[] = chunks.map((chunk, position) => ({
        indexId: index.id,
        generation: options.targetGeneration,
        id: `${chunk.documentId}#${chunk.ordinal}`,
        documentId: chunk.documentId,
        ordinal: chunk.ordinal,
        text: chunk.text,
        vector: embedded.vectors[position],
        embeddingInputHash: embeddingInputHash(model, dimension, chunk.text),
        metadata: chunk.metadata,
      }));

      // Индекс могли удалить, пока шла сборка — тогда ничего не пишем
      // (иначе `saveIndex` воскресил бы удалённую запись).
      if (!(await indexes.getIndex(index.id))) return;

      await indexes.replaceChunks(index.id, options.targetGeneration, records);

      const now = new Date().toISOString();
      await indexes.saveIndex({
        ...index,
        state: 'ready',
        generation: options.targetGeneration,
        fingerprint: { model, dimension, chunkerVersion: CHUNKER_VERSION },
        stats: { documents: documents.length, chunks: records.length, updatedAt: now },
        error: undefined,
        updatedAt: now,
      });

      // Старое поколение удаляется только после переключения на новое.
      if (
        options.previousGeneration > 0 &&
        options.previousGeneration !== options.targetGeneration
      ) {
        await indexes.deleteChunks(index.id, options.previousGeneration);
      }
    } catch (err) {
      const now = new Date().toISOString();
      await indexes.saveIndex({
        ...index,
        state: 'failed',
        // Прежнее поколение остаётся доступным для поиска.
        generation: options.previousGeneration,
        error: errorMessage(err),
        updatedAt: now,
      });
    }
  }

  /** Документы корпуса по источнику индекса. */
  private async _collectDocuments(
    index: MemoryIndexRecord,
    workingDir?: string,
  ): Promise<SourceDocument[]> {
    if (index.source.kind === 'facts') {
      // Инстансный индекс по фактам — корпус **всего** инстанса (все
      // активные факты, независимо от проекта). Проектный — факты проекта
      // (и факты без проекта) — как раньше.
      const facts =
        index.scope === 'instance'
          ? await this._deps.listFacts({ status: 'active', allProjects: true })
          : await this._deps.listFacts({
              status: 'active',
              ...(index.projectId ? { projectId: index.projectId } : {}),
            });
      return facts.map((fact) => ({
        documentId: fact.id,
        text: fact.text,
        metadata: { factId: fact.id, kind: fact.kind },
        whole: true,
      }));
    }

    const settings = this._deps.settings();
    const files = await collectTextFiles(workingDir ?? '', {
      maxFileBytes: settings.maxFileBytes,
      exclude: settings.exclude,
      ...(index.source.filter ? { include: index.source.filter } : {}),
    });
    return files.map((file) => ({
      documentId: file.path,
      text: file.text,
      metadata: { path: file.path },
    }));
  }

  /** Нарезка документов на чанки (факты — целиком). */
  private _chunkDocuments(documents: readonly SourceDocument[]): SourceChunk[] {
    const settings = this._deps.settings();
    const chunks: SourceChunk[] = [];
    for (const document of documents) {
      if (document.whole) {
        chunks.push({
          documentId: document.documentId,
          ordinal: 0,
          text: document.text,
          metadata: { ...document.metadata },
        });
        continue;
      }
      const pieces = chunkText(document.text, {
        chunkChars: settings.chunkChars,
        chunkOverlap: settings.chunkOverlap,
      });
      for (const piece of pieces) {
        chunks.push({
          documentId: document.documentId,
          ordinal: piece.ordinal,
          text: piece.text,
          metadata: {
            ...document.metadata,
            startLine: piece.startLine,
            endLine: piece.endLine,
          },
        });
      }
    }
    return chunks;
  }
}

/**
 * Имя индекса по умолчанию — по области видимости.
 *
 * Проектный индекс — `project`, инстансный (общий) — `instance`: в списке
 * видно, что корпус общий.
 */
function defaultIndexName(scope: MemoryIndexScope): string {
  return scope === 'instance' ? DEFAULT_INSTANCE_INDEX_NAME : DEFAULT_INDEX_NAME;
}

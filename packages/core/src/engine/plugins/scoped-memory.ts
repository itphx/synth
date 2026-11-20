/**
 * ADR-090 / PROP-047 §2.1 (предпосылка A): **scoped-доступ плагина к памяти**.
 *
 * Ядро владеет данными памяти (порты `MemoryFactRepository`/
 * `MemoryIndexRepository`, ADR-096), плагин — логикой памяти (PROP-047 §3).
 * Но порт обслуживает **несколько независимых поставщиков** памяти: запись
 * всегда принадлежит namespace'у. Поэтому плагину нельзя отдать «сырой» порт —
 * иначе он увидит и запишет чужие записи.
 *
 * Здесь — тонкая обёртка над портами: **только фильтрация и штамповка
 * namespace**, никакой бизнес-логики памяти (retrieval, консолидация,
 * эмбеддинги — в плагине).
 *
 * Правила (fail-closed, без утечки существования):
 * - namespace плагина — `plugin:<имя плагина>`; **навязан хостом**, плагин его
 *   не выбирает и не может подменить: `save`/`saveIndex` перезаписывают
 *   `namespace` своим (входное значение игнорируется);
 * - `get`/`getIndex` — запись чужого namespace выглядит как «не найдена»
 *   (`null`), а не как отказ (403) и не как «существует, но чужой»;
 * - `list`/`count`/`listIndexes` — namespace **подставляется принудительно**,
 *   входной `namespace` в запросе игнорируется (иначе плагин прочитал бы
 *   чужое);
 * - `delete`/`supersede`/`setState`/`deleteIndex` — только для записей своего
 *   namespace; иначе — «не найдено» (`false`), как у порта; у `supersede`
 *   проверяются **оба** id (заменяемый факт и новая версия) — иначе плагин
 *   проставил бы `supersededBy` на чужой факт (кросс-namespace ссылка);
 * - `replaceChunks`/`listChunks`/`deleteChunks`/`countChunks` — только для
 *   индексов своего namespace; чужой индекс даёт пустой результат (`0`/`[]`),
 *   а не исключение с чужими данными.
 *
 * Нарушение namespace **не выражается исключением**: наружу уходит только
 * «не найдено» — иначе по коду ответа можно было бы отличить «чужой id» от
 * «несуществующий» и перебором id выяснить содержимое чужой памяти.
 *
 * ## Событие шины `memory.updated` (инвариант 27 `AGENTS.md`)
 *
 * Обёртка — **единственный chokepoint записи плагина в память** (плагин ходит в
 * порты только через неё), поэтому публикация события посажена именно здесь:
 * каждая успешная мутация факта или индекса публикует `memory.updated` в
 * инстансный канал (шов — `events/memory-events.ts`). Иначе факт, записанный
 * агентом в чате (`memory_write`), и индекс, изменённый плагином, не доходили
 * бы до UI: раздел «Память» держит снимок до перезагрузки страницы.
 *
 * Правила:
 * - публикация — **после** успешной записи: `delete`/`supersede`, вернувшие
 *   `false` (чужой namespace, нет записи), молчат;
 * - в payload — только область, вид мутации и id записи: **ни текста факта, ни
 *   эмбеддингов, ни корпуса индекса** (docs/MEMORY.md §10, инвариант 13);
 * - шина не задана — публикации нет (тесты, сторонние потребители): поведение
 *   прежнее.
 */
import type {
  MemoryFactQuery,
  MemoryFactRecord,
  MemoryFactRepository,
} from '../../storage/ports/memory-fact-repository.js';
import type {
  MemoryChunkRecord,
  MemoryIndexQuery,
  MemoryIndexRecord,
  MemoryIndexRepository,
  MemoryIndexState,
} from '../../storage/ports/memory-index-repository.js';
import {
  publishMemoryUpdated,
  type InstanceEventPublisherLike,
} from '../../events/memory-events.js';

/**
 * Префикс namespace'а плагина в памяти.
 *
 * Тот же формат, что у provenance плагинных блоков промпта
 * (`plugin:<имя плагина>`, `engine/plugins/plugin-host.ts`) — по нему видно,
 * чьей памятью является запись.
 */
export const PLUGIN_MEMORY_NAMESPACE_PREFIX = 'plugin:';

/**
 * Namespace памяти плагина: `plugin:<имя плагина>`.
 *
 * Имя плагина — полное (`my-plugin`), не короткое (`my` из
 * `plugin_<ns>_<tool>`): namespace разделяет **поставщиков памяти**, а не
 * тулы, и должен однозначно указывать на плагина.
 */
export function pluginMemoryNamespace(pluginName: string): string {
  return `${PLUGIN_MEMORY_NAMESPACE_PREFIX}${pluginName}`;
}

/**
 * Порты памяти инстанса, которые хост отдаёт фасаду (PROP-047 §2.1).
 *
 * Хост отдаёт плагину **не эти порты**, а scoped-обёртку поверх них
 * ({@link createScopedMemory}).
 */
export interface PluginMemoryPorts {
  /** Порт фактов памяти. */
  facts: MemoryFactRepository;
  /** Порт индексов памяти и их чанков. */
  indexes: MemoryIndexRepository;
}

/**
 * Scoped-обёртка над портом фактов: только свой namespace.
 *
 * Фильтрация и штамповка — без бизнес-логики: upsert/`createdAt`/`updatedAt`
 * считает сам порт.
 */
function scopedFacts(
  pluginName: string,
  facts: MemoryFactRepository,
  bus: InstanceEventPublisherLike | undefined | null,
): MemoryFactRepository {
  const namespace = pluginMemoryNamespace(pluginName);

  /** Запись принадлежит namespace'у плагина? */
  const owned = async (id: string): Promise<MemoryFactRecord | null> => {
    const fact = await facts.get(id);
    if (!fact || fact.namespace !== namespace) return null;
    return fact;
  };

  return {
    async save(fact: MemoryFactRecord): Promise<void> {
      // Namespace навязан хостом: входное значение игнорируется, запись не
      // может утечь в чужой namespace.
      await facts.save({ ...fact, namespace });
      // Первая версия — новая запись, дальше `save` правит существующую
      // (upsert по id: исправление версией, отзыв, метаданные канона при
      // консолидации).
      publishMemoryUpdated(bus, {
        scope: 'facts',
        action: fact.version <= 1 ? 'create' : 'update',
        id: fact.id,
      });
    },
    async get(id: string): Promise<MemoryFactRecord | null> {
      return owned(id);
    },
    async list(query?: MemoryFactQuery): Promise<MemoryFactRecord[]> {
      // Namespace подставляется принудительно: фильтр из запроса игнорируется.
      return facts.list({ ...(query ?? {}), namespace });
    },
    async count(query?: MemoryFactQuery): Promise<number> {
      return facts.count({ ...(query ?? {}), namespace });
    },
    async delete(id: string): Promise<boolean> {
      if (!(await owned(id))) return false;
      const deleted = await facts.delete(id);
      if (deleted) publishMemoryUpdated(bus, { scope: 'facts', action: 'delete', id });
      return deleted;
    },
    async supersede(id: string, nextId: string): Promise<boolean> {
      // Проверяются **оба** id: и заменяемый факт, и новая версия. Иначе
      // плагин проставил бы `supersededBy` на чужой факт — кросс-namespace
      // ссылка, которую потом прочитает портал/консолидация.
      if (!(await owned(id))) return false;
      if (!(await owned(nextId))) return false;
      const superseded = await facts.supersede(id, nextId);
      if (superseded) publishMemoryUpdated(bus, { scope: 'facts', action: 'update', id });
      return superseded;
    },
  };
}

/**
 * Scoped-обёртка над портом индексов: только свой namespace.
 *
 * Проверка владения индексом — по `getIndex`: чужой индекс не виден, поэтому
 * операции с его чанками дают пустой результат.
 */
function scopedIndexes(
  pluginName: string,
  indexes: MemoryIndexRepository,
  bus: InstanceEventPublisherLike | undefined | null,
): MemoryIndexRepository {
  const namespace = pluginMemoryNamespace(pluginName);

  /** Индекс принадлежит namespace'у плагина? */
  const owns = async (indexId: string): Promise<boolean> => {
    const index = await indexes.getIndex(indexId);
    return index !== null && index.namespace === namespace;
  };

  return {
    async saveIndex(index: MemoryIndexRecord): Promise<void> {
      // Запись уже существует — это правка/пересборка, иначе создание.
      const existing = await indexes.getIndex(index.id);
      await indexes.saveIndex({ ...index, namespace });
      publishMemoryUpdated(bus, {
        scope: 'indexes',
        action: existing ? 'update' : 'create',
        id: index.id,
      });
    },
    async getIndex(id: string): Promise<MemoryIndexRecord | null> {
      const index = await indexes.getIndex(id);
      if (!index || index.namespace !== namespace) return null;
      return index;
    },
    async listIndexes(query?: MemoryIndexQuery): Promise<MemoryIndexRecord[]> {
      return indexes.listIndexes({ ...(query ?? {}), namespace });
    },
    async deleteIndex(id: string): Promise<boolean> {
      if (!(await owns(id))) return false;
      const deleted = await indexes.deleteIndex(id);
      if (deleted) publishMemoryUpdated(bus, { scope: 'indexes', action: 'delete', id });
      return deleted;
    },
    async setState(id: string, state: MemoryIndexState, error?: string): Promise<boolean> {
      if (!(await owns(id))) return false;
      const saved = await indexes.setState(id, state, error);
      if (saved) publishMemoryUpdated(bus, { scope: 'indexes', action: 'update', id });
      return saved;
    },
    async replaceChunks(
      indexId: string,
      generation: number,
      chunks: readonly MemoryChunkRecord[],
    ): Promise<number> {
      if (!(await owns(indexId))) return 0;
      return indexes.replaceChunks(indexId, generation, chunks);
    },
    async listChunks(
      indexId: string,
      opts?: { generation?: number; documentId?: string; limit?: number; offset?: number },
    ): Promise<MemoryChunkRecord[]> {
      if (!(await owns(indexId))) return [];
      return indexes.listChunks(indexId, opts);
    },
    async deleteChunks(indexId: string, generation?: number): Promise<number> {
      if (!(await owns(indexId))) return 0;
      return indexes.deleteChunks(indexId, generation);
    },
    async countChunks(indexId: string, generation?: number): Promise<number> {
      if (!(await owns(indexId))) return 0;
      return indexes.countChunks(indexId, generation);
    },
  };
}

/**
 * Scoped-доступ к памяти для конкретного плагина (PROP-047 §2.1).
 *
 * Хост создаёт обёртку **на плагин** (namespace навязывается здесь) и кладёт
 * её в фасад (`facade.memory`). Плагин получает те же методы порта, но видит
 * только свою память.
 *
 * `bus` — шина инстанса для `memory.updated` (инвариант 27): каждая успешная
 * запись в память публикует событие — иначе мутация плагина или агента не
 * доходит до второго клиента. Не задана — публикации нет (тесты, сторонние
 * потребители; поведение прежнее).
 */
export function createScopedMemory(
  pluginName: string,
  ports: PluginMemoryPorts,
  bus?: InstanceEventPublisherLike | null,
): PluginMemoryPorts {
  return {
    facts: scopedFacts(pluginName, ports.facts, bus),
    indexes: scopedIndexes(pluginName, ports.indexes, bus),
  };
}

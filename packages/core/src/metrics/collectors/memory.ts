/**
 * ADR-094: метрики подсистемы памяти (`synth_memory_*`).
 *
 * Ядро владеет данными памяти (порты `MemoryFactRepository`/
 * `MemoryIndexRepository`, ADR-096), плагин — логикой (PROP-047 §3). Поэтому
 * серии метрик регистрируются **в ядре**: плагин своей реестровой метрики не
 * заводит (ADR-094: наблюдаемость — контракт ядра).
 *
 * Три серии:
 * - `synth_memory_facts{status}` — число фактов в namespace плагина памяти по
 *   статусам (`candidate`/`active`/`superseded`/`retracted`);
 * - `synth_memory_indexes{status}` — число индексов по состояниям
 *   (`building`/`ready`/`stale`/`failed`);
 * - `synth_memory_index_chunks{status}` — суммарное число чанков по индексам
 *   в каждом состоянии (актуальное поколение корпуса).
 *
 * Правила:
 * - **кардинальность ограничена**: лейбл только `status` с фиксированным
 *   набором значений; `namespace`/`project_id`/`session_id` в лейблах нет
 *   (ADR-094 п. 5);
 * - **пересчёт на скрейпе** (коллектор `registry.addCollector`): значения
 *   снимаются из портов при рендере `/metrics`;
 * - **порта нет — серий нет**: без порта значения не публикуются (нули-обманки
 *   не показываем — «память недоступна» ≠ «в памяти ноль фактов»);
 * - ошибка порта не ломает скрейп (метрики — наблюдательность, а не данные).
 */
import type { MemoryFactRepository, MemoryFactStatus } from '../../storage/ports/memory-fact-repository.js';
import type { MemoryIndexRepository, MemoryIndexState } from '../../storage/ports/memory-index-repository.js';
import { MEMORY_NAMESPACE } from '../../engine/plugins/memory-namespace.js';
import type { MetricsRegistry } from '../registry.js';

/** Имя метрики числа фактов памяти (по статусам). */
export const MEMORY_FACTS_METRIC = 'synth_memory_facts';

/** Имя метрики числа индексов памяти (по состояниям). */
export const MEMORY_INDEXES_METRIC = 'synth_memory_indexes';

/** Имя метрики объёма корпуса индексов памяти (чанки по состояниям индексов). */
export const MEMORY_INDEX_CHUNKS_METRIC = 'synth_memory_index_chunks';

/**
 * Потолок выборки индексов при пересчёте (максимум порта — 1000 записей,
 * `resolveCollectionLimit`): больше индексов на инстанс не бывает, поэтому
 * выборка полная.
 */
export const MEMORY_INDEX_LIST_LIMIT = 1000;

/** Статусы факта — полный набор значений лейбла `status`. */
export const MEMORY_METRIC_FACT_STATUSES: readonly MemoryFactStatus[] = [
  'candidate',
  'active',
  'superseded',
  'retracted',
];

/** Состояния индекса — полный набор значений лейбла `status`. */
export const MEMORY_METRIC_INDEX_STATES: readonly MemoryIndexState[] = [
  'building',
  'ready',
  'stale',
  'failed',
];

/** Источники данных коллектора (порты слоя хранения, ADR-096). */
export interface MemoryMetricsSources {
  /** Порт фактов памяти (нет — серия фактов не публикуется). */
  facts?: MemoryFactRepository;
  /** Порт индексов памяти (нет — серия индексов не публикуется). */
  indexes?: MemoryIndexRepository;
  /** Namespace, который считаем (по умолчанию — namespace плагина памяти). */
  namespace?: string;
}

/**
 * Зарегистрировать метрики памяти и пересчитывать их на скрейпе.
 *
 * Возвращает функцию остановки; вызывающий складывает её в
 * `stopMetricsCollectors` (graceful shutdown).
 */
export function startMemoryMetrics(
  registry: MetricsRegistry,
  sources: MemoryMetricsSources,
): () => void {
  const namespace = sources.namespace ?? MEMORY_NAMESPACE;

  const factsGauge = registry.gauge(
    MEMORY_FACTS_METRIC,
    'Number of memory facts in the plugin memory namespace by status.',
    ['status'],
  );
  const indexesGauge = registry.gauge(
    MEMORY_INDEXES_METRIC,
    'Number of memory indexes in the plugin memory namespace by state.',
    ['status'],
  );
  const indexChunksGauge = registry.gauge(
    MEMORY_INDEX_CHUNKS_METRIC,
    'Number of memory index chunks in the plugin memory namespace by index state.',
    ['status'],
  );

  let stopped = false;
  let inFlight = false;

  /** Пересчёт: значения снимаются из портов и публикуются в реестре. */
  const refresh = async (): Promise<void> => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const facts = sources.facts;
      if (facts) {
        for (const status of MEMORY_METRIC_FACT_STATUSES) {
          const value = await facts.count({ namespace, status });
          factsGauge.set({ status }, value);
        }
      }

      const indexes = sources.indexes;
      if (indexes) {
        // В порту индексов нет `count` — состояния считаются по выборке
        // (индексов на инстанс единицы, выборка полная).
        const list = await indexes.listIndexes({ namespace, limit: MEMORY_INDEX_LIST_LIMIT });
        const counts: Record<MemoryIndexState, number> = {
          building: 0,
          ready: 0,
          stale: 0,
          failed: 0,
        };
        const chunkCounts: Record<MemoryIndexState, number> = {
          building: 0,
          ready: 0,
          stale: 0,
          failed: 0,
        };
        for (const index of list) {
          if (index.state in counts) counts[index.state] += 1;
          // Объём корпуса — чанки **актуального поколения** индекса; индекс
          // без поколения (`generation = 0`) ещё не собран — чанков нет.
          const generation = index.generation;
          if (!Number.isFinite(generation) || generation <= 0) continue;
          try {
            const chunks = await indexes.countChunks(index.id, generation);
            if (index.state in chunkCounts) chunkCounts[index.state] += chunks;
          } catch {
            // Ошибка по одному индексу — индекс пропускаем, остальные считаем
            // (скрейп метрик не ломаем).
          }
        }
        for (const state of MEMORY_METRIC_INDEX_STATES) {
          indexesGauge.set({ status: state }, counts[state]);
          indexChunksGauge.set({ status: state }, chunkCounts[state]);
        }
      }
    } catch {
      // Ошибка порта не должна ломать скрейп метрик.
    } finally {
      inFlight = false;
    }
  };

  // Пересчёт на скрейпе: коллектор реестра вызывается перед рендером.
  const removeCollector = registry.addCollector(() => {
    void refresh();
  });
  // Первый пересчёт — сразу, чтобы первый скрейп уже видел значения.
  void refresh();

  return () => {
    if (stopped) return;
    stopped = true;
    removeCollector();
  };
}

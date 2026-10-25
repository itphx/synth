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
 * Плюс **телеметрия контекста и recall** (ADR-107, `createMemoryTelemetry`):
 * - `synth_memory_context_injected_total{block,status}` — сколько блоков
 *   памяти (факты/recall) фактически ушло в промпт хода;
 * - `synth_memory_context_chars{block}` — объём такого блока (символы);
 * - `synth_memory_recall_queries_total{kind,outcome}` — recall-запросы по
 *   виду (`recall`/`search`) и исходу (`hit`/`empty`/`unavailable`/`error`);
 * - `synth_memory_recall_hits{kind}` — число найденных фрагментов;
 * - `synth_memory_recall_duration_seconds{kind}` — длительность recall-запроса.
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

/** Имя метрики инъекции блока памяти в промпт хода (по блоку и статусу). */
export const MEMORY_CONTEXT_INJECTED_METRIC = 'synth_memory_context_injected_total';

/** Имя метрики объёма блока памяти, ушедшего в промпт хода (символы). */
export const MEMORY_CONTEXT_CHARS_METRIC = 'synth_memory_context_chars';

/** Имя метрики recall-запросов памяти (по виду и исходу). */
export const MEMORY_RECALL_QUERIES_METRIC = 'synth_memory_recall_queries_total';

/** Имя метрики числа найденных фрагментов recall. */
export const MEMORY_RECALL_HITS_METRIC = 'synth_memory_recall_hits';

/** Имя метрики длительности recall-запроса (секунды). */
export const MEMORY_RECALL_DURATION_METRIC = 'synth_memory_recall_duration_seconds';

/**
 * Корзины гистограммы объёма блока памяти (символы).
 *
 * Бюджет блока промпта — 4 000 символов (`plugins.promptBlockMaxChars`),
 * поэтому верхняя корзина 16 000 покрывает блок, снятый с ограничением.
 */
export const MEMORY_CONTEXT_CHARS_BUCKETS: readonly number[] = [
  50, 200, 500, 1000, 2000, 4000, 8000, 16000,
];

/**
 * Корзины гистограммы числа найденных фрагментов recall.
 *
 * Ноль — валидное значение (recall ничего не нашёл), но реестр метрик
 * отбрасывает неположительные границы (`normalizeBuckets` требует `b > 0`),
 * поэтому фактическая первая корзина — `le="1"`.
 */
export const MEMORY_RECALL_HITS_BUCKETS: readonly number[] = [0, 1, 2, 3, 5, 10, 20, 50];

/** Корзины гистограммы длительности recall-запроса (секунды). */
export const MEMORY_RECALL_DURATION_BUCKETS: readonly number[] = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5,
];

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

// ── Телеметрия контекста памяти и recall (ADR-107) ─────────────────────

/** Блок памяти в промпте (конечный набор значений лейбла `block`). */
export type MemoryContextBlockLabel = 'facts' | 'recall' | 'other';

/** Статус блока памяти в промпте (конечный набор значений лейбла `status`). */
export type MemoryContextStatusLabel =
  | 'loaded'
  | 'truncated'
  | 'empty'
  | 'blocked'
  | 'suppressed'
  | 'other';

/** Вид recall-запроса (конечный набор значений лейбла `kind`). */
export type MemoryRecallKindLabel = 'recall' | 'search' | 'other';

/** Исход recall-запроса (конечный набор значений лейбла `outcome`). */
export type MemoryRecallOutcomeLabel = 'hit' | 'empty' | 'unavailable' | 'error' | 'other';

const CONTEXT_BLOCKS: readonly string[] = ['facts', 'recall'];
const CONTEXT_STATUSES: readonly string[] = [
  'loaded',
  'truncated',
  'empty',
  'blocked',
  'suppressed',
];
const RECALL_KINDS: readonly string[] = ['recall', 'search'];
const RECALL_OUTCOMES: readonly string[] = ['hit', 'empty', 'unavailable', 'error'];

/** Приведение значения к конечному набору: неизвестное → `other`. */
function normalize(value: string | undefined, allowed: readonly string[]): string {
  if (!value) return 'other';
  return allowed.includes(value) ? value : 'other';
}

/** Нормализация имени блока памяти. */
export function normalizeMemoryContextBlock(value: string | undefined): MemoryContextBlockLabel {
  return normalize(value, CONTEXT_BLOCKS) as MemoryContextBlockLabel;
}

/** Нормализация статуса блока памяти. */
export function normalizeMemoryContextStatus(value: string | undefined): MemoryContextStatusLabel {
  return normalize(value, CONTEXT_STATUSES) as MemoryContextStatusLabel;
}

/** Нормализация вида recall-запроса. */
export function normalizeMemoryRecallKind(value: string | undefined): MemoryRecallKindLabel {
  return normalize(value, RECALL_KINDS) as MemoryRecallKindLabel;
}

/** Нормализация исхода recall-запроса. */
export function normalizeMemoryRecallOutcome(value: string | undefined): MemoryRecallOutcomeLabel {
  return normalize(value, RECALL_OUTCOMES) as MemoryRecallOutcomeLabel;
}

/**
 * Телеметрия памяти: что ушло в промпт хода и как отработал recall.
 *
 * Вызывается из двух мест:
 * - ход сессии (`onMemoryContext` оркестратора → блоки памяти в промпте);
 * - фасад плагина (`facade.memoryTelemetry` → recall/search-запросы плагина).
 */
export interface MemoryTelemetryRecorder {
  /**
   * Блоки памяти, ушедшие в промпт хода (по одному на блок).
   *
   * `block` — `facts`/`recall`, `status` — статус манифеста промпта,
   * `chars` — объём блока в символах.
   */
  recordContext(
    entries: readonly { block: 'facts' | 'recall'; status: string; chars: number }[],
  ): void;
  /**
   * Recall-запрос плагина памяти.
   *
   * `kind` — вид запроса (`recall`/`search`), `outcome` — исход
   * (`hit`/`empty`/`unavailable`/`error`), `hits` — число найденных
   * фрагментов, `durationMs` — длительность в миллисекундах.
   */
  recordRecall(input: {
    kind: 'recall' | 'search';
    outcome: 'hit' | 'empty' | 'unavailable' | 'error';
    hits: number;
    durationMs: number;
  }): void;
}

/**
 * Создать телеметрию памяти поверх реестра метрик (ADR-094).
 *
 * Реестра нет (`metrics.enabled=false`) — возвращается no-op: телеметрия
 * памяти не должна ломать ход и не должна требовать включённых метрик.
 * Ошибка записи не влияет на вызывающего (метрики — наблюдательность).
 */
export function createMemoryTelemetry(registry: MetricsRegistry): MemoryTelemetryRecorder {
  const reg = registry as MetricsRegistry | undefined;
  if (!reg) {
    return {
      recordContext: () => undefined,
      recordRecall: () => undefined,
    };
  }

  const contextInjected = reg.counter(
    MEMORY_CONTEXT_INJECTED_METRIC,
    'Total number of memory blocks injected into the prompt of a turn, by block and status.',
    ['block', 'status'],
  );
  const contextChars = reg.histogram(
    MEMORY_CONTEXT_CHARS_METRIC,
    'Characters of memory blocks injected into the prompt of a turn, by block.',
    ['block'],
    MEMORY_CONTEXT_CHARS_BUCKETS,
  );
  const recallQueries = reg.counter(
    MEMORY_RECALL_QUERIES_METRIC,
    'Total number of memory recall queries by kind and outcome.',
    ['kind', 'outcome'],
  );
  const recallHits = reg.histogram(
    MEMORY_RECALL_HITS_METRIC,
    'Number of memory fragments found by a recall query, by kind.',
    ['kind'],
    MEMORY_RECALL_HITS_BUCKETS,
  );
  const recallDuration = reg.histogram(
    MEMORY_RECALL_DURATION_METRIC,
    'Duration of memory recall queries in seconds, by kind.',
    ['kind'],
    MEMORY_RECALL_DURATION_BUCKETS,
  );

  return {
    recordContext(entries) {
      for (const entry of entries) {
        try {
          const block = normalizeMemoryContextBlock(entry.block);
          const status = normalizeMemoryContextStatus(entry.status);
          contextInjected.inc({ block, status });
          contextChars.observe({ block }, Math.max(0, entry.chars));
        } catch {
          // Ошибка метрик не влияет на ход.
        }
      }
    },
    recordRecall(input) {
      try {
        const kind = normalizeMemoryRecallKind(input.kind);
        const outcome = normalizeMemoryRecallOutcome(input.outcome);
        recallQueries.inc({ kind, outcome });
        recallHits.observe({ kind }, Math.max(0, input.hits));
        recallDuration.observe({ kind }, Math.max(0, input.durationMs) / 1000);
      } catch {
        // Ошибка метрик не влияет на ход.
      }
    },
  };
}

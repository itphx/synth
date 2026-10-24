/**
 * М2: гибридный поиск по индексу (keyword + вектор + RRF).
 *
 * Два независимых арма (docs/MEMORY.md §2.3):
 * - **keyword** — доля токенов запроса, найденных в чанке (`keywordScore`,
 *   общий с блоком recall и тулом `memory_search`);
 * - **вектор** — cosine между вектором запроса и вектором чанка.
 *
 * Списки сливаются **RRF** (reciprocal rank fusion, `k = 60`): сумма
 * `1/(k + rank)` по обоим спискам. RRF не требует сопоставимости шкал
 * скоринга — поэтому keyword (0..1) и cosine (-1..1) можно смешивать.
 *
 * Деградации (ход не падает):
 * - вектора у чанков нет → только keyword (`readiness: 'degraded'`);
 * - эмбеддинг запроса не удался → только keyword (ошибка **не** пробрасывается:
 *     поиск не должен ронять ход из-за провайдера эмбеддингов).
 */
import type { MemoryChunkRecord, MemoryIndexRecord, PluginFacade } from '@itphx/synth-core';

import { keywordScore } from '../scoring.js';
import { embedTexts } from './embedder.js';

/** Готовность памяти к выдаче (совпадает с `MemoryReadiness` из docs/MEMORY.md). */
export type MemorySearchReadiness = 'ready' | 'degraded' | 'stale' | 'unavailable';

/** Дефолт числа результатов поиска. */
export const DEFAULT_SEARCH_TOP_K = 5;

/** Дефолт числа просматриваемых чанков за поиск. */
export const DEFAULT_SEARCH_MAX_CHUNKS = 2000;

/** Константа RRF (сглаживание ранга). */
export const DEFAULT_RRF_K = 60;

/** Найденный фрагмент корпуса. */
export interface SearchItem {
  /** Текст чанка. */
  text: string;
  /** Итоговый score (RRF, нормированный в 0..1). */
  score: number;
  /** id индекса-источника. */
  indexId: string;
  /** Поколение корпуса, из которого взят чанк. */
  generation: number;
  /** id чанка (уникален в пределах индекса и поколения). */
  chunkId: string;
  /** id документа (путь файла или id факта). */
  documentId: string;
  /** Метаданные чанка (путь/диапазон строк/id факта). */
  metadata: Record<string, unknown>;
}

/** Результат поиска по индексу. */
export interface SearchOutcome {
  /** Фрагменты (отсортированы по убыванию score). */
  items: SearchItem[];
  /** Готовность выдачи. */
  readiness: MemorySearchReadiness;
}

/** Запись ранжированного списка (вход RRF). */
export interface RankedEntry {
  /** Ключ элемента (уникальный в пределах списка). */
  key: string;
  /** Исходный скор элемента (для отладки/сведения). */
  score?: number;
}

/** Элемент после слияния списков. */
export interface FusedEntry {
  key: string;
  /** RRF-скор (сумма `1/(k + rank)`). */
  score: number;
}

/**
 * Косинусная близость векторов.
 *
 * Нулевые векторы → 0 (иначе деление на ноль); разная длина → 0.
 */
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (!a || !b || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    dot += left * right;
    normA += left * left;
    normB += right * right;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Reciprocal rank fusion: слияние нескольких ранжированных списков.
 *
 * `score = Σ 1/(k + rank)`, где `rank` — позиция в списке (с 1). Порядок
 * результата детерминирован: при равных скорах — по ключу.
 */
export function reciprocalRankFusion(
  lists: readonly (readonly RankedEntry[])[],
  k: number = DEFAULT_RRF_K,
): FusedEntry[] {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((entry, index) => {
      const rank = index + 1;
      scores.set(entry.key, (scores.get(entry.key) ?? 0) + 1 / (k + rank));
    });
  }
  const fused = [...scores.entries()].map(([key, score]) => ({ key, score }));
  fused.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.key.localeCompare(b.key);
  });
  return fused;
}

/** Параметры поиска по индексу. */
export interface IndexSearchOptions {
  /** Сколько результатов вернуть. */
  topK?: number;
  /** Сколько чанков просмотреть (лимит порта — 1000). */
  maxChunks?: number;
  /** Предзагруженная запись индекса (иначе — чтение из порта). */
  index?: MemoryIndexRecord | null;
  /** Поколение корпуса для поиска (по умолчанию — текущее поколение индекса). */
  generation?: number;
  /** Эффективное состояние индекса (`stale` — модель/размерность изменились). */
  stale?: boolean;
}

/**
 * Поиск по индексу: keyword + вектор → RRF → top-K.
 *
 * Индекса нет → `readiness: 'unavailable'` (пустой выдачи, без исключения).
 */
export async function searchIndex(
  facade: PluginFacade,
  indexId: string,
  query: string,
  options: IndexSearchOptions = {},
): Promise<SearchOutcome> {
  const memory = facade.memory;
  if (!memory) return { items: [], readiness: 'unavailable' };

  const index = options.index ?? (await memory.indexes.getIndex(indexId));
  if (!index) return { items: [], readiness: 'unavailable' };

  const generation = options.generation ?? index.generation;
  const maxChunks = options.maxChunks ?? DEFAULT_SEARCH_MAX_CHUNKS;
  const topK = options.topK ?? DEFAULT_SEARCH_TOP_K;

  const chunks = await memory.indexes.listChunks(indexId, { generation, limit: maxChunks });

  const withVector = chunks.filter((chunk) => (chunk.vector?.length ?? 0) > 0);
  let queryVector: number[] | null = null;
  if (withVector.length > 0) {
    try {
      const embedded = await embedTexts(facade, [query]);
      queryVector = embedded.vectors[0] ?? null;
    } catch {
      // Эмбеддинг запроса не удался — деградация на keyword (ход не падает).
      queryVector = null;
    }
  }

  const keywordList = rankKeyword(query, chunks);
  const vectorList = queryVector ? rankVector(queryVector, chunks) : [];

  const fused = reciprocalRankFusion([keywordList, vectorList]);
  const byKey = new Map<string, MemoryChunkRecord>(chunks.map((chunk) => [chunk.id, chunk]));
  const maxScore = fused.reduce((max, entry) => Math.max(max, entry.score), 0);

  const items: SearchItem[] = [];
  for (const entry of fused.slice(0, topK)) {
    const chunk = byKey.get(entry.key);
    if (!chunk) continue;
    items.push({
      text: chunk.text,
      score: maxScore > 0 ? entry.score / maxScore : 0,
      indexId: index.id,
      generation: chunk.generation,
      chunkId: chunk.id,
      documentId: chunk.documentId,
      metadata: { ...(chunk.metadata ?? {}) },
    });
  }

  return { items, readiness: readinessOf(index, options.stale === true, queryVector !== null) };
}

/**
 * Готовность выдачи.
 *
 * - `stale` — фингерпринт индекса разошёлся с конфигурацией (вызывающий
 *   вычислил и передал `stale`);
 * - `degraded` — векторный арм не отработал (у чанков нет векторов или
 *   эмбеддинг запроса не удался) либо последняя сборка провалилась;
 * - `ready` — корпус готов и векторный арм отработал;
 * - `unavailable` — индекса нет.
 */
function readinessOf(
  index: MemoryIndexRecord,
  stale: boolean,
  vectorArmUsed: boolean,
): MemorySearchReadiness {
  if (stale) return 'stale';
  if (index.state === 'failed') return 'degraded';
  if (!vectorArmUsed) return 'degraded';
  return 'ready';
}

/** Keyword-ранжирование чанков (только с ненулевым скором). */
function rankKeyword(query: string, chunks: readonly MemoryChunkRecord[]): RankedEntry[] {
  const scored = chunks
    .map((chunk) => ({ key: chunk.id, score: keywordScore(query, chunk.text) }))
    .filter((entry) => entry.score > 0);
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.key.localeCompare(b.key);
  });
  return scored;
}

/** Векторное ранжирование чанков (только с вектором). */
function rankVector(
  queryVector: readonly number[],
  chunks: readonly MemoryChunkRecord[],
): RankedEntry[] {
  const scored = chunks
    .filter((chunk) => (chunk.vector?.length ?? 0) > 0)
    .map((chunk) => ({ key: chunk.id, score: cosine(queryVector, chunk.vector ?? []) }));
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.key.localeCompare(b.key);
  });
  return scored;
}

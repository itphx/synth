/**
 * М2: эмбеддер — обёртка над `facade.embed` (ADR-107).
 *
 * Эмбеддинги — **только** через сервис фасада: хост сам оборачивает вызов в
 * `GatewayProvider` (guard, обфускация, rate-limit, аудит, embedding-фаза
 * фильтров `llmFilters`) — инвариант 3 (ADR-036). Плагин провайдера не дёргает.
 *
 * Политика вызова (лимиты фасада: 64 текста / 8 000 символов в тексте /
 * 64 000 символов суммарно за вызов):
 * - батч — не более {@link EMBED_BATCH_SIZE} текстов;
 * - текст длиннее {@link EMBED_MAX_CHARS} — обрезается (лимит фасада 8 000,
 *   берём с запасом);
 * - суммарный объём батча — не более {@link EMBED_MAX_TOTAL_CHARS}.
 *
 * Ошибки фасада **не глотаются**: `plugin.embedding_not_configured` должен
 * дойти до вызывающего (сборка индекса → `state: 'failed'`, а не «индекс
 * без векторов»).
 */
import type { PluginFacade } from '@itphx/synth-core';

/** Максимум текстов за один вызов эмбеддингов (лимит фасада — 64). */
export const EMBED_BATCH_SIZE = 32;

/** Максимум символов в одном тексте эмбеддинга (лимит фасада — 8 000). */
export const EMBED_MAX_CHARS = 7000;

/** Максимум символов суммарно за один вызов эмбеддингов (лимит фасада — 64 000). */
export const EMBED_MAX_TOTAL_CHARS = 64_000;

/** Результат эмбеддинга батча. */
export interface EmbedOutcome {
  /** Векторы (по одному на текст, в том же порядке). */
  vectors: number[][];
  /** Размерность вектора (0 — векторов нет). */
  dimension: number;
}

/** Обрезать текст до лимита эмбеддинга. */
export function truncateForEmbed(text: string): string {
  const value = text ?? '';
  return value.length > EMBED_MAX_CHARS ? value.slice(0, EMBED_MAX_CHARS) : value;
}

/**
 * Разбить тексты на батчи: не более {@link EMBED_BATCH_SIZE} текстов и не
 * более {@link EMBED_MAX_TOTAL_CHARS} символов суммарно.
 */
export function splitBatches(texts: readonly string[]): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let currentChars = 0;
  for (const text of texts) {
    const length = text.length;
    const exceedsChars = current.length > 0 && currentChars + length > EMBED_MAX_TOTAL_CHARS;
    if (current.length >= EMBED_BATCH_SIZE || exceedsChars) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(text);
    currentChars += length;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * Векторизовать тексты через `facade.embed`.
 *
 * Пустой вход → пустой результат (без обращения к фасаду).
 * Ошибка фасада пробрасывается как есть (см. заголовок модуля).
 */
export async function embedTexts(
  facade: PluginFacade,
  texts: readonly string[],
): Promise<EmbedOutcome> {
  if (texts.length === 0) return { vectors: [], dimension: 0 };
  const prepared = texts.map((text) => truncateForEmbed(text));
  const vectors: number[][] = [];
  for (const batch of splitBatches(prepared)) {
    const batchVectors = await facade.embed(batch);
    for (const vector of batchVectors) vectors.push(vector);
  }
  return { vectors, dimension: vectors[0]?.length ?? 0 };
}

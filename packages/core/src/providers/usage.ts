/**
 * AD-070 §2.3: нормализация usage и статистика prompt-cache.
 */

/**
 * Cache hit rate — доля кэшированных входных токенов:
 * `cacheReadTokens / inputTokens`. При `inputTokens === 0` (нет входных
 * токенов) возвращает 0, а не NaN/Infinity.
 */
export function computeCacheHitRate(
  cacheReadTokens: number | undefined,
  inputTokens: number | undefined,
): number {
  const input = inputTokens || 0;
  if (input <= 0) return 0;
  return (cacheReadTokens || 0) / input;
}

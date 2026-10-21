/**
 * Общий помощник портов слоя хранения: потолок выборки коллекции
 * (ADR-096 — слой хранения).
 *
 * Правило одинаково для всех backend'ов: дефолт — 100 записей, потолок — 1000;
 * значение выше потолка **обрезается**, не отбрасывается; нечисловое или
 * неположительное значение — дефолт.
 *
 * Legacy-порт `PipelineRepository` (ADR-051/PROP-059) держит собственный
 * эквивалент (`resolvePipelineInstanceLimit`) и не переписывается — новые
 * порты движка пайплайнов (ADR-101) пользуются этим общим хелпером.
 */

/** Дефолтный потолок выборки (без явного `limit`). */
export const COLLECTION_LIMIT_DEFAULT = 100;

/** Абсолютный потолок выборки (`limit` выше — обрезается). */
export const COLLECTION_LIMIT_MAX = 1000;

/**
 * Привести `limit` к допустимому виду: дефолт 100, потолок 1000.
 * Нечисловое/неположительное значение — дефолт.
 */
export function resolveCollectionLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) {
    return COLLECTION_LIMIT_DEFAULT;
  }
  return Math.min(Math.floor(limit), COLLECTION_LIMIT_MAX);
}

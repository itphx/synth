/**
 * PROP-068 §4.1 / PROP-090 §9: уровни доверия расширений — **единственный**
 * перечень в пакете `@itphx/synth-shared`.
 *
 * Модуль выделен отдельно, чтобы перечень не зависел от модулей, которые сами
 * от него зависят: `types/catalog.ts` (карточка записи каталога) и
 * `types/pack.ts` (манифест `synth.pack`) используют один и тот же список, а
 * `catalog.ts` импортирует схемы из `pack.ts` — прямой импорт наоборот дал бы
 * цикл (использование `const` на этапе инициализации модуля).
 *
 * Иерархия (от старшего к младшему): `builtin` → `verified` → `trusted` →
 * `community`. Уровень `agent-created` (PROP-090 §9) в каталоге расширений не
 * используется — записи каталога публикуются из репозиториев (PROP-068 §4.1).
 *
 * Модуль browser-safe (`zod` + локальные типы).
 */
import { z } from 'zod';

/** Уровни доверия (PROP-068 §4.1). */
export const CATALOG_TRUST_LEVELS = ['builtin', 'verified', 'trusted', 'community'] as const;
export type CatalogTrustLevel = (typeof CATALOG_TRUST_LEVELS)[number];
export const catalogTrustLevelSchema = z.enum(CATALOG_TRUST_LEVELS);

/**
 * Позиция уровня в иерархии доверия (0 — старший). Используется для
 * сравнения «не выше порога» (PROP-090 §9: trust-floor плагина = `trusted`).
 */
export function trustLevelRank(level: CatalogTrustLevel): number {
  return CATALOG_TRUST_LEVELS.indexOf(level);
}

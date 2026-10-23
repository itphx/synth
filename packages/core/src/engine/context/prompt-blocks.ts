/**
 * ADR-070 §2.1/§3.1: базовые типы блоков системного промпта и детерминированная
 * сборка. `ContextBuilder` отдаёт «сырые» блоки, а сортировка по тирам
 * (`stable` → `context` → `volatile`) и склейка живут здесь — это задел под
 * будущий `SystemPromptComposer`.
 */

import type { PromptManifestStatus, PromptTier } from '@itphx/synth-shared';

export type { PromptTier };

export interface PromptBlock {
  key: string; // 'role' | 'additional' | 'profile' | 'project.info' | 'interview' | 'participants' | 'sticky' | 'summary'
  tier: PromptTier;
  order: number; // порядок внутри тира
  content: string; // '' — блок не отправляется
  provenance?: string;
  /**
   * ADR-070 §2.5: явный статус манифеста (например, `truncated` у проектных
   * инструкций ADR-069). Не задан — выводится из `content` (`empty`/`loaded`).
   */
  status?: PromptManifestStatus;
  /**
   * Источник блока. `provider` — блок от провайдера точки `promptBlocks`
   * (ADR-090); не задан — встроенный блок Composer'а.
   *
   * Нужен для инвалидации состояния промпта: блоки провайдеров лежат вне
   * тира `stable`, поэтому смена их содержимого не видна `isPrefixUnchanged`
   * — трек ведётся отдельно (по образцу блока `instructions`, ADR-069 §11).
   */
  source?: 'builtin' | 'provider';
}

const TIER_ORDER: Record<PromptTier, number> = {
  stable: 0,
  context: 1,
  volatile: 2,
};

/**
 * Сортирует блоки по тирам (stable → context → volatile), затем по `order`.
 * Возвращает новый массив, исходный не мутирует.
 */
export function sortPromptBlocks(blocks: PromptBlock[]): PromptBlock[] {
  return [...blocks].sort((a, b) => {
    const byTier = TIER_ORDER[a.tier] - TIER_ORDER[b.tier];
    return byTier !== 0 ? byTier : a.order - b.order;
  });
}

/**
 * Склеивает блоки в строку, пропуская пустые (`content === ''`).
 */
export function joinPromptBlocks(blocks: PromptBlock[], separator = '\n\n'): string {
  return blocks
    .filter((block) => block.content !== '')
    .map((block) => block.content)
    .join(separator);
}

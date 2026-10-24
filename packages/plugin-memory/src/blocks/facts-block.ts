/**
 * М1: блок «факты памяти» (точка `promptBlocks`, тир `context`).
 *
 * Устойчивые утверждения с провенансом — то, что агент должен помнить между
 * ходами (docs/MEMORY.md §4.1). Блок **детерминирован**: одинаковый вход →
 * одинаковый текст (иначе дрожит prompt-cache, ADR-070).
 *
 * Скоуп: задан проект сессии → факты этого проекта **и** общие (без проекта);
 * не задан → только факты **без** проекта. Чужие проекты в блок не попадают.
 * Правило — то же, что у тула `memory_search` (docs/MEMORY.md §3).
 */
import type { PromptBlockProvider } from '@itphx/synth-shared';

import { formatFactLine, type MemoryProviderLite } from '../provider.js';

/** Ключ блока (совпадает с `provides.promptBlocks[]` манифеста). */
export const FACTS_BLOCK_KEY = 'plugin.synth-plugin-memory.facts';
/** Подпись блока в манифесте промпта. */
export const FACTS_BLOCK_TITLE = 'Факты памяти';
/** Заголовок секции в тексте блока. */
export const FACTS_BLOCK_HEADER = '[MEMORY: project facts]';

/**
 * Провайдер блока «факты памяти».
 *
 * Сервис памяти недоступен (`facade.memory === undefined`) → блок пуст
 * (`null`): это фича-детект, а не ошибка активации.
 */
export function createFactsBlock(provider: MemoryProviderLite): PromptBlockProvider {
  return {
    key: FACTS_BLOCK_KEY,
    tier: 'context',
    order: 100,
    title: FACTS_BLOCK_TITLE,
    async load(ctx) {
      if (!provider.available) return null;
      const scope = ctx.projectId ? { projectId: ctx.projectId } : {};
      const candidates = await provider.candidates(scope);
      const facts = provider.selectFacts(candidates);
      if (facts.length === 0) return null;
      return [FACTS_BLOCK_HEADER, ...facts.map(formatFactLine)].join('\n');
    },
  };
}

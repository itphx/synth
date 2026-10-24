/**
 * М1: блок «recall по вопросу хода» (точка `promptBlocks`, тир `volatile`).
 *
 * Retrieval по текущему вопросу: keyword-скоринг (М2 добавит вектор через
 * `facade.embed`, ADR-107), порог `minScore`, top `recallLimit`.
 *
 * Блок появляется **только** при непустом `ctx.query`: у шага пайплайна и
 * саб-агента вопроса хода нет, вспоминать нечего (docs/MEMORY.md §7).
 */
import type { PromptBlockProvider } from '@itphx/synth-shared';

import { formatFactLine, type MemoryProviderLite } from '../provider.js';

/** Ключ блока (совпадает с `provides.promptBlocks[]` манифеста). */
export const RECALL_BLOCK_KEY = 'plugin.synth-plugin-memory.recall';
/** Подпись блока в манифесте промпта. */
export const RECALL_BLOCK_TITLE = 'Воспоминание по вопросу хода';
/** Заголовок секции в тексте блока. */
export const RECALL_BLOCK_HEADER = '[MEMORY: recall for this turn]';

/**
 * Провайдер блока «recall по вопросу хода».
 *
 * Факты, уже попавшие в блок «project facts», не дублируются: блок выбирает
 * их тем же правилом (уверенность → свежесть → id), поэтому результат не
 * зависит от порядка загрузки блоков композером.
 */
export function createRecallBlock(provider: MemoryProviderLite): PromptBlockProvider {
  return {
    key: RECALL_BLOCK_KEY,
    tier: 'volatile',
    order: 110,
    title: RECALL_BLOCK_TITLE,
    async load(ctx) {
      if (!provider.available) return null;
      const query = ctx.query?.trim();
      if (!query) return null;
      const scope = ctx.projectId ? { projectId: ctx.projectId } : {};
      const candidates = await provider.candidates(scope);
      const inFacts = new Set(provider.selectFacts(candidates).map((fact) => fact.id));
      const hits = await provider.recall(candidates, query, inFacts);
      if (hits.length === 0) return null;
      return [RECALL_BLOCK_HEADER, ...hits.map(formatFactLine)].join('\n');
    },
  };
}

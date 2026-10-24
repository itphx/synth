/**
 * М1 + М2: блок «recall по вопросу хода» (точка `promptBlocks`, тир `volatile`).
 *
 * Retrieval по текущему вопросу. Два пути (docs/MEMORY.md §2.3):
 * - **индекс проекта готов** (состояние `ready` или `stale`) → гибридный
 *   поиск по корпусу (keyword + вектор + RRF, `engine/search.ts`);
 * - индекса нет → keyword-скоринг по фактам (поведение М1).
 *
 * Блок появляется **только** при непустом `ctx.query`: у шага пайплайна и
 * саб-агента вопроса хода нет, вспоминать нечего (docs/MEMORY.md §7).
 *
 * Детерминированность обязательна (ADR-070, граница prompt-cache): один и тот
 * же вход → один и тот же текст блока.
 */
import type { PromptBlockProvider } from '@itphx/synth-shared';

import type { SearchItem } from '../engine/search.js';
import { formatFactLine, type MemoryProviderLite } from '../provider.js';

/** Ключ блока (совпадает с `provides.promptBlocks[]` манифеста). */
export const RECALL_BLOCK_KEY = 'plugin.synth-plugin-memory.recall';
/** Подпись блока в манифесте промпта. */
export const RECALL_BLOCK_TITLE = 'Воспоминание по вопросу хода';
/** Заголовок секции в тексте блока. */
export const RECALL_BLOCK_HEADER = '[MEMORY: recall for this turn]';
/**
 * Пометка устаревшего индекса.
 *
 * Индекс `stale` (сменилась модель/размерность эмбеддинга) — вектора
 * «похожи», но не те же: секция не выдаётся как «пусто», а помечается
 * (docs/MEMORY.md §4.1).
 */
export const RECALL_STALE_NOTICE = '[MEMORY: index stale, rebuild pending]';

/**
 * Строка найденного фрагмента корпуса: текст + источник + score.
 *
 * Источник — путь файла или id факта; диапазон строк — когда известен.
 */
export function formatRecallItem(item: SearchItem): string {
  const metadata = item.metadata ?? {};
  const path = typeof metadata.path === 'string' ? metadata.path : undefined;
  const factId = typeof metadata.factId === 'string' ? metadata.factId : undefined;
  const source = path ?? factId ?? item.documentId;
  const startLine = typeof metadata.startLine === 'number' ? metadata.startLine : undefined;
  const endLine = typeof metadata.endLine === 'number' ? metadata.endLine : undefined;
  const range =
    startLine !== undefined && endLine !== undefined ? `, ${startLine}-${endLine}` : '';
  return `- ${item.text} (src: ${source}${range}, score ${item.score.toFixed(2)})`;
}

/**
 * Провайдер блока «recall по вопросу хода».
 *
 * Факты, уже попавшие в блок «project facts», не дублируются: блок выбирает
 * их тем же правилом (уверенность → свежесть → id), поэтому результат не
 * зависит от порядка загрузки блоков композером. Для фрагментов индекса
 * дедуп — по `factId` в метаданных (источник `facts`).
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
      const { recallLimit } = provider.settings();

      // Индекс проекта (готовый или устаревший) — гибридный recall.
      const index = await provider.projectIndex(ctx.projectId);
      if (index) {
        const found = await provider.searchIndex(index.index.id, query, {
          topK: recallLimit,
        });
        const lines = found.items
          .filter((item) => !isFactInFacts(item, inFacts))
          .map((item) => formatRecallItem(item));
        const notice = index.state === 'stale' ? [RECALL_STALE_NOTICE] : [];
        if (lines.length > 0) return [RECALL_BLOCK_HEADER, ...notice, ...lines].join('\n');
        if (notice.length > 0) return [RECALL_BLOCK_HEADER, ...notice].join('\n');
      }

      // Индекса нет — keyword-recall по фактам (поведение М1).
      const hits = await provider.recall(candidates, query, inFacts);
      if (hits.length === 0) return null;
      return [RECALL_BLOCK_HEADER, ...hits.map(formatFactLine)].join('\n');
    },
  };
}

/** Фрагмент индекса — это уже показанный в блоке фактов? */
function isFactInFacts(item: SearchItem, inFacts: ReadonlySet<string>): boolean {
  const factId = item.metadata?.factId;
  return typeof factId === 'string' && inFacts.has(factId);
}

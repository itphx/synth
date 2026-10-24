/**
 * М1: in-tree плагин памяти Synth (`synth-plugin-memory`).
 *
 * Точки расширения (ADR-090): `promptBlocks` (2 блока) и `tools` (3 тула).
 * Данные — через `facade.memory` (ADR-107): ядро владеет фактами, плагин —
 * логикой памяти (PROP-047, docs/MEMORY.md).
 *
 * Состав (М1):
 * - `blocks/facts-block.ts` — устойчивые факты в контексте хода (tier
 *   `context`, order 100);
 * - `blocks/recall-block.ts` — retrieval по вопросу хода (tier `volatile`,
 *   order 110);
 * - `tools/search.ts` / `tools/write.ts` / `tools/forget.ts` — поиск, запись и
 *   отзыв факта;
 * - `provider.ts` — единственное место плагина, которое ходит в хранилище;
 * - `scoring.ts` — детерминированный keyword-скоринг (вектор — М2).
 */
import type { PluginFacade } from '@itphx/synth-core';

import { createFactsBlock } from './blocks/facts-block.js';
import { createRecallBlock } from './blocks/recall-block.js';
import { MemoryProviderLite } from './provider.js';
import { createMemoryForgetTool } from './tools/forget.js';
import { createMemorySearchTool } from './tools/search.js';
import { createMemoryWriteTool } from './tools/write.js';

/**
 * Точка входа плагина: хост вызывает `apply(facade)` после `import()` бандла.
 *
 * Регистрация не бросает: сервис памяти может быть недоступен
 * (`facade.memory === undefined`) — тогда блоки пусты, а тулы отвечают
 * понятной ошибкой (фича-детект, а не отказ активации).
 */
export function apply(facade: PluginFacade): void {
  const provider = new MemoryProviderLite(facade);

  facade.registerPromptBlock(createFactsBlock(provider));
  facade.registerPromptBlock(createRecallBlock(provider));

  facade.registerTool(createMemorySearchTool(provider));
  facade.registerTool(createMemoryWriteTool(provider));
  facade.registerTool(createMemoryForgetTool(provider));
}

export default { apply };

export { createFactsBlock, FACTS_BLOCK_KEY, FACTS_BLOCK_TITLE } from './blocks/facts-block.js';
export { createRecallBlock, RECALL_BLOCK_KEY, RECALL_BLOCK_TITLE } from './blocks/recall-block.js';
export {
  DEFAULT_FACTS_LIMIT,
  DEFAULT_MIN_SCORE,
  DEFAULT_RECALL_LIMIT,
  FactNotFoundError,
  MemoryProviderLite,
  MemoryUnavailableError,
  SupersedeTextRequiredError,
  formatFactDate,
  formatFactLine,
  formatFactLineWithMeta,
} from './provider.js';
export { keywordScore, tokenize } from './scoring.js';
export { createMemorySearchTool, MEMORY_SEARCH_TOOL_NAME } from './tools/search.js';
export { createMemoryWriteTool, MEMORY_WRITE_TOOL_NAME } from './tools/write.js';
export { createMemoryForgetTool, MEMORY_FORGET_TOOL_NAME } from './tools/forget.js';

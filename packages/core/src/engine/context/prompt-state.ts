/**
 * AD-070 §2.4/§2.7 (Ф2-часть 2): состояние системного промпта per-agent и
 * предсказание/валидация prompt-cache.
 *
 * Состояние (`PromptState`) хранится в сессии (`session.promptStates`) и
 * пересобирается только при смене generation: первый ход (`init`), изменение
 * закреплённого префикса (`generation-change`) или `systemPrompt`-override
 * (`override`). На обычном сообщении выполняется только сравнение хэшей.
 */

import { createHash } from 'node:crypto';
import { nowISO, type PromptBlockState, type PromptState } from '@itphx/synth-shared';
import type { PromptBlock } from './prompt-blocks.js';

export type PromptStateReason = PromptState['reason'];

/** Ключ сессии без выбранного агента (AD-070 §2.4). */
export const DEFAULT_AGENT_KEY = '__default__';

/** `agentKey` = agentRole либо `__default__` для сессии без агента. */
export function agentKeyOf(agentRole?: string): string {
  return agentRole || DEFAULT_AGENT_KEY;
}

/** sha256 в hex. */
export function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Минимальный срез результата `compose()`, нужный для состояния промпта. */
export interface ComposedPromptLike {
  system: string;
  stablePrefix: string;
  blocks: PromptBlock[];
}

/**
 * Собирает новое состояние промпта: инкремент generation, хэши стабильного
 * префикса, полного system и каждого блока.
 */
export function buildPromptState(
  composed: ComposedPromptLike,
  prev: PromptState | null,
  reason: PromptStateReason,
): PromptState {
  const blocks: PromptBlockState[] = composed.blocks.map((block) => ({
    key: block.key,
    hash: hashText(block.content),
    chars: block.content.length,
  }));

  return {
    generation: prev ? prev.generation + 1 : 1,
    staticPrefixHash: hashText(composed.stablePrefix),
    staticPrefix: composed.stablePrefix,
    systemHash: hashText(composed.system),
    blocks,
    reason,
    updatedAt: nowISO(),
  };
}

/**
 * true, если закреплённый префикс побайтово не изменился с прошлого состояния
 * (совпадают и хэш, и сами байты).
 */
export function isPrefixUnchanged(
  prev: PromptState | null,
  composed: ComposedPromptLike,
): boolean {
  return (
    !!prev
    && prev.staticPrefixHash === hashText(composed.stablePrefix)
    && prev.staticPrefix === composed.stablePrefix
  );
}

/** Предсказание cache hit по сохранённому состоянию. */
export function computeExpected(
  prev: PromptState | null,
  composed: ComposedPromptLike,
): 'hit' | 'miss' {
  return isPrefixUnchanged(prev, composed) ? 'hit' : 'miss';
}

/**
 * Валидация предсказания по факту: при ожидании hit должны быть cached-токены,
 * при miss — их быть не должно.
 */
export function validateExpected(expected: 'hit' | 'miss', cachedTokens: number): boolean {
  return expected === 'hit' ? cachedTokens > 0 : cachedTokens === 0;
}

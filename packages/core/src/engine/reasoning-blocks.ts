/**
 * Anthropic thinking: перенос блоков размышлений между `Message.parts`,
 * LLM-контрактом (`LLMMessage.reasoningBlocks`) и историей.
 *
 * Подпись thinking-блока валидна только для своего текста, поэтому при
 * нескольких блоках за ход одна `reasoningSignature` на сообщение не работает —
 * блоки хранятся частями (`Part` с `type: 'reasoning'` и `metadata`), а в
 * LLM-контракт уходят массивом `reasoningBlocks`.
 */
import type { LLMReasoningBlock, Message, Part } from '@itphx/synth-shared';
import { generateId } from '@itphx/synth-shared';

/** Блок размышлений в форме, достаточной для части сообщения. */
export interface ReasoningBlockLike {
  text: string;
  /** Подпись thinking-блока. */
  signature?: string;
  /** Opaque-данные `redacted_thinking` (текста нет). */
  redacted?: string;
}

/**
 * Блоки истории → `reasoningBlocks` LLM-контракта.
 * `redacted`-блок идёт без текста — провайдер реплеит его `redacted_thinking`.
 */
export function toLlmReasoningBlocks(
  blocks: readonly ReasoningBlockLike[] | undefined,
): LLMReasoningBlock[] | undefined {
  if (!blocks || blocks.length === 0) return undefined;
  const mapped: LLMReasoningBlock[] = [];
  for (const block of blocks) {
    if (typeof block.redacted === 'string' && block.redacted) {
      mapped.push({ text: '', redactedData: block.redacted });
      continue;
    }
    const text = block.text ?? '';
    if (!text && block.signature === undefined) continue;
    mapped.push({
      text,
      ...(block.signature !== undefined ? { signature: block.signature } : {}),
    });
  }
  return mapped.length > 0 ? mapped : undefined;
}

/**
 * Блоки размышлений → части сообщения (`type: 'reasoning'`).
 * Текст остаётся в `data` (UI/учёт токенов), подпись/redacted — в `metadata`.
 */
export function makeReasoningParts(
  blocks: readonly ReasoningBlockLike[] | undefined,
): Part[] {
  const parts: Part[] = [];
  for (const block of blocks ?? []) {
    if (typeof block.redacted === 'string' && block.redacted) {
      parts.push({
        id: generateId(),
        type: 'reasoning',
        data: '',
        metadata: { redacted: block.redacted },
      });
      continue;
    }
    const text = block.text ?? '';
    if (!text && block.signature === undefined) continue;
    parts.push({
      id: generateId(),
      type: 'reasoning',
      data: text,
      ...(block.signature !== undefined ? { metadata: { signature: block.signature } } : {}),
    });
  }
  return parts;
}

/**
 * Части сообщения → блоки размышлений (в порядке частей).
 * `undefined` — reasoning-частей нет (legacy/сообщение без размышлений).
 */
export function reasoningBlocksFromParts(
  parts: readonly Part[] | undefined,
): ReasoningBlockLike[] | undefined {
  if (!parts || parts.length === 0) return undefined;
  const blocks: ReasoningBlockLike[] = [];
  for (const part of parts) {
    if (!part || part.type !== 'reasoning') continue;
    const text = typeof part.data === 'string' ? part.data : String(part.data ?? '');
    const redacted = part.metadata?.redacted;
    if (typeof redacted === 'string' && redacted) {
      blocks.push({ text: '', redacted });
      continue;
    }
    const signature = part.metadata?.signature;
    blocks.push({
      text,
      ...(typeof signature === 'string' ? { signature } : {}),
    });
  }
  return blocks.length > 0 ? blocks : undefined;
}

/**
 * Блоки размышлений сообщения: из частей (новый формат), иначе — fallback на
 * legacy-поля `reasoning` + `reasoningSignature`/`reasoningRedacted`.
 */
export function reasoningBlocksOfMessage(msg: Message): ReasoningBlockLike[] | undefined {
  const fromParts = reasoningBlocksFromParts(msg.parts);
  if (fromParts) return fromParts;

  const redacted = msg.reasoningRedacted ?? [];
  const hasSignature = typeof msg.reasoningSignature === 'string';
  const text = msg.reasoning ?? '';
  if (redacted.length === 0 && !hasSignature && !text) return undefined;

  const blocks: ReasoningBlockLike[] = [];
  for (const data of redacted) {
    if (typeof data === 'string' && data) blocks.push({ text: '', redacted: data });
  }
  if (text || hasSignature) {
    blocks.push({
      text,
      ...(hasSignature ? { signature: msg.reasoningSignature } : {}),
    });
  }
  return blocks.length > 0 ? blocks : undefined;
}

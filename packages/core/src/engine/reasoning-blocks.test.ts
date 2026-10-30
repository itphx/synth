/**
 * Тесты шва `reasoning-blocks` (ADR-117): перенос блоков размышлений между
 * частями сообщения, LLM-контрактом и legacy-полями.
 *
 * Проверяется главное свойство мульти-блочного ответа Anthropic: подпись
 * принадлежит **своему** блоку, поэтому перенос идёт по блокам, а не одним
 * полем на сообщение.
 */
import { describe, it, expect } from 'vitest';
import { MessageRole } from '@itphx/synth-shared';
import type { Message, Part } from '@itphx/synth-shared';
import {
  makeReasoningParts,
  reasoningBlocksFromParts,
  reasoningBlocksOfMessage,
  toLlmReasoningBlocks,
} from './reasoning-blocks.js';

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: 'm1',
    role: MessageRole.ASSISTANT,
    seq: 1,
    origin: 'local',
    parts: [],
    content: 'ответ',
    createdAt: '2026-01-01T00:00:00.000Z',
    disabled: false,
    pinned: false,
    hidden: false,
    ...overrides,
  } as Message;
}

describe('toLlmReasoningBlocks', () => {
  it('переносит подписи блоков по порядку и redacted отдельными элементами', () => {
    expect(toLlmReasoningBlocks([
      { text: '', redacted: 'opaque-1' },
      { text: 'блок A', signature: 'sig-a' },
      { text: 'блок B', signature: 'sig-b' },
    ])).toEqual([
      { text: '', redactedData: 'opaque-1' },
      { text: 'блок A', signature: 'sig-a' },
      { text: 'блок B', signature: 'sig-b' },
    ]);
  });

  it('пустая подпись валидна (RouterAI/qwen) — блок не теряется', () => {
    expect(toLlmReasoningBlocks([{ text: 'блок', signature: '' }]))
      .toEqual([{ text: 'блок', signature: '' }]);
  });

  it('пустой список и блоки без текста и подписи → undefined', () => {
    expect(toLlmReasoningBlocks(undefined)).toBeUndefined();
    expect(toLlmReasoningBlocks([])).toBeUndefined();
    expect(toLlmReasoningBlocks([{ text: '' }])).toBeUndefined();
  });
});

describe('makeReasoningParts / reasoningBlocksFromParts', () => {
  it('round-trip: текст в data, подпись и redacted — в metadata', () => {
    const parts = makeReasoningParts([
      { text: 'блок A', signature: 'sig-a' },
      { text: '', redacted: 'opaque-1' },
    ]);

    expect(parts.map((part) => part.type)).toEqual(['reasoning', 'reasoning']);
    expect(parts.map((part) => part.data)).toEqual(['блок A', '']);
    expect(parts.map((part) => part.metadata)).toEqual([
      { signature: 'sig-a' },
      { redacted: 'opaque-1' },
    ]);

    expect(reasoningBlocksFromParts(parts)).toEqual([
      { text: 'блок A', signature: 'sig-a' },
      { text: '', redacted: 'opaque-1' },
    ]);
  });

  it('части без размышлений и пустые → undefined', () => {
    expect(reasoningBlocksFromParts(undefined)).toBeUndefined();
    expect(reasoningBlocksFromParts([])).toBeUndefined();
    expect(reasoningBlocksFromParts([{ id: 'p1', type: 'text', data: 'текст' }])).toBeUndefined();
  });

  it('часть без подписи (legacy) читается как блок без signature', () => {
    const parts: Part[] = [{ id: 'p1', type: 'reasoning', data: 'старый блок' }];
    expect(reasoningBlocksFromParts(parts)).toEqual([{ text: 'старый блок' }]);
  });
});

describe('reasoningBlocksOfMessage', () => {
  it('приоритет у частей: legacy-поля не дублируются', () => {
    const msg = message({
      parts: [
        { id: 'p1', type: 'reasoning', data: 'блок A', metadata: { signature: 'sig-a' } },
        { id: 'p2', type: 'reasoning', data: 'блок B', metadata: { signature: 'sig-b' } },
      ],
      reasoning: 'блок A',
      reasoningSignature: 'sig-a',
      reasoningRedacted: ['opaque-legacy'],
    });

    expect(reasoningBlocksOfMessage(msg)).toEqual([
      { text: 'блок A', signature: 'sig-a' },
      { text: 'блок B', signature: 'sig-b' },
    ]);
  });

  it('fallback на legacy-поля: redacted → thinking (порядок как у провайдера)', () => {
    const msg = message({
      reasoning: 'старый блок',
      reasoningSignature: 'sig-old',
      reasoningRedacted: ['opaque-old'],
    });

    expect(reasoningBlocksOfMessage(msg)).toEqual([
      { text: '', redacted: 'opaque-old' },
      { text: 'старый блок', signature: 'sig-old' },
    ]);
  });

  it('без размышлений → undefined', () => {
    expect(reasoningBlocksOfMessage(message())).toBeUndefined();
  });
});

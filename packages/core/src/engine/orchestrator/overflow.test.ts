import { describe, it, expect } from 'vitest';
import type { LLMMessage } from '../../providers/base.js';
import {
  buildOverflowRetryMessages,
  hasValidToolPairs,
  overflowCheckpointMessage,
} from './overflow.js';

function llm(role: string, content: string, patch: Partial<LLMMessage> = {}): LLMMessage {
  return {
    id: '',
    role,
    content,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    disabled: false,
    pinned: false,
    branchId: '',
    ...patch,
  } as LLMMessage;
}

describe('overflowCheckpointMessage', () => {
  it('содержит маркер, резюме и оговорку про более ранние резюме', () => {
    const msg = overflowCheckpointMessage('итог');
    expect(msg.role).toBe('user');
    expect(msg.content).toContain('[CONTEXT CHECKPOINT]');
    expect(msg.content).toContain('итог');
    expect(msg.content).toContain('заменяет более ранние резюме');
  });
});

describe('buildOverflowRetryMessages', () => {
  it('чекпоинт + хвост; пересечение хвоста и текущего хода схлопывается', () => {
    const tail = [llm('user', 'u1'), llm('assistant', 'a1'), llm('user', 'u2')];
    const currentTurn = [llm('user', 'u2'), llm('assistant', 'a2')];
    const result = buildOverflowRetryMessages({ summary: 's', tail, currentTurn });
    expect(result).not.toBeNull();
    expect(result!.map((m) => m.content)).toEqual([
      expect.stringContaining('[CONTEXT CHECKPOINT]'),
      'u1',
      'a1',
      'u2',
      'a2',
    ]);
  });

  it('сохраняет tool-пары: assistant(tool_use) → tool-результат', () => {
    const toolUse = [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }];
    const tail = [
      llm('user', 'u1'),
      llm('assistant', 'call', { toolUse }),
      llm('tool', 'result', { toolCallId: 'c1' }),
    ];
    const result = buildOverflowRetryMessages({ summary: 's', tail, currentTurn: [] });
    expect(result).not.toBeNull();
    const roles = result!.slice(1).map((m) => m.role);
    expect(roles).toEqual(['user', 'assistant', 'tool']);
    expect(hasValidToolPairs(result!.slice(1))).toBe(true);
  });

  it('разорванные tool-пары → null (повтор запрещён)', () => {
    const currentTurn = [llm('tool', 'result', { toolCallId: 'c1' })];
    expect(buildOverflowRetryMessages({ summary: 's', tail: [], currentTurn })).toBeNull();
  });

  it('пустое резюме → null', () => {
    expect(buildOverflowRetryMessages({ summary: '  ', tail: [], currentTurn: [] })).toBeNull();
  });
});

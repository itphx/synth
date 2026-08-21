import { describe, it, expect } from 'vitest';
import { OllamaProvider } from './ollama.js';
import type { LLMMessage } from './base.js';

const baseParams = {
  url: 'http://omn.example.test/api/chat',
  apiKey: 'key',
  model: 'qwen3.8:27b',
  timeout: 30,
};

// Доступ к приватным методам для юнит-проверки.
type OllamaPrivate = {
  _formatMessages(messages: LLMMessage[]): Array<Record<string, unknown>>;
  _parseResponse(data: Record<string, unknown>): { toolCalls?: Record<string, unknown>[] };
};

function makeMessage(overrides: Partial<LLMMessage> = {}): LLMMessage {
  return {
    id: 'm1',
    role: 'assistant',
    content: '',
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    disabled: false,
    pinned: false,
    branchId: 'b1',
    ...overrides,
  };
}

const STRING_ARGS = '{"category": "research"}';

describe('OllamaProvider — нормализация function.arguments', () => {
  const provider = new OllamaProvider(baseParams) as unknown as OllamaPrivate;

  function firstToolCall(formatted: Array<Record<string, unknown>>): Record<string, unknown> {
    const tc = (formatted[0]!.tool_calls as Record<string, unknown>[])[0]!;
    return tc;
  }

  it('_formatMessages: arguments-строка превращается в объект', () => {
    const formatted = provider._formatMessages([
      makeMessage({
        toolUse: [
          {
            index: 0,
            id: 'call_1',
            type: 'function',
            function: { name: 'classify_conversation', arguments: STRING_ARGS },
          },
        ],
      }),
    ]);
    const tc = firstToolCall(formatted);
    const fn = tc.function as Record<string, unknown>;
    expect(fn.arguments).toEqual({ category: 'research' });
    expect(fn.name).toBe('classify_conversation');
    expect(tc.id).toBe('call_1');
    expect(tc.index).toBe(0);
  });

  it('_formatMessages: уже объект не трогается', () => {
    const argsObj = { query: 'тест' };
    const formatted = provider._formatMessages([
      makeMessage({
        toolUse: [
          {
            id: 'call_2',
            type: 'function',
            function: { name: 'web_search', arguments: argsObj },
          },
        ],
      }),
    ]);
    const fn = firstToolCall(formatted).function as Record<string, unknown>;
    expect(fn.arguments).toBe(argsObj);
  });

  it('_formatMessages: невалидная JSON-строка остаётся строкой (не роняем запрос)', () => {
    const bad = '{не json';
    const formatted = provider._formatMessages([
      makeMessage({
        toolUse: [
          {
            id: 'call_3',
            type: 'function',
            function: { name: 'tool', arguments: bad },
          },
        ],
      }),
    ]);
    const fn = firstToolCall(formatted).function as Record<string, unknown>;
    expect(fn.arguments).toBe(bad);
  });

  it('_formatMessages: отсутствие arguments не ломает отправку', () => {
    const formatted = provider._formatMessages([
      makeMessage({
        toolUse: [
          { id: 'call_4', type: 'function', function: { name: 'noop' } },
        ],
      }),
    ]);
    const tc = firstToolCall(formatted);
    expect((tc.function as Record<string, unknown>).name).toBe('noop');
    expect((tc.function as Record<string, unknown>).arguments).toBeUndefined();
  });

  it('_parseResponse: arguments-строка из ответа превращается в объект', () => {
    const resp = provider._parseResponse({
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            index: 0,
            id: 'call_5',
            type: 'function',
            function: { name: 'classify_conversation', arguments: STRING_ARGS },
          },
        ],
      },
    });
    const fn = resp.toolCalls![0]!.function as Record<string, unknown>;
    expect(fn.arguments).toEqual({ category: 'research' });
  });

  it('_parseResponse: невалидная строка остаётся строкой (fallback)', () => {
    const bad = 'не json';
    const resp = provider._parseResponse({
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_6',
            type: 'function',
            function: { name: 'tool', arguments: bad },
          },
        ],
      },
    });
    const fn = resp.toolCalls![0]!.function as Record<string, unknown>;
    expect(fn.arguments).toBe(bad);
  });
});

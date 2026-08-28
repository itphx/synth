import { describe, it, expect } from 'vitest';
import { OpenAIProvider } from './openai.js';
import type { LLMMessage } from './base.js';

const baseParams = {
  url: 'http://api.test.example/v1/chat/completions',
  apiKey: 'key',
  model: 'deepseek-v4-flash',
  timeout: 30,
};

// Доступ к приватным методам для юнит-проверки.
type OpenAIPrivate = {
  _formatMessages(messages: LLMMessage[], systemPrompt?: string): Array<Record<string, unknown>>;
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

describe('OpenAIProvider — нормализация function.arguments и reasoning_content', () => {
  const provider = new OpenAIProvider(baseParams) as unknown as OpenAIPrivate;

  function firstToolCall(formatted: Array<Record<string, unknown>>): Record<string, unknown> {
    return (formatted[0]!.tool_calls as Record<string, unknown>[])[0]!;
  }

  it('_formatMessages: arguments-объект сериализуется в JSON-строку', () => {
    const formatted = provider._formatMessages([
      makeMessage({
        toolUse: [
          {
            index: 0,
            id: 'call_1',
            type: 'function',
            function: { name: 'execute_shell', arguments: { command: 'pwd' } },
          },
        ],
      }),
    ]);
    const fn = firstToolCall(formatted).function as Record<string, unknown>;
    expect(fn.arguments).toBe('{"command":"pwd"}');
    expect(fn.name).toBe('execute_shell');
    expect(firstToolCall(formatted).id).toBe('call_1');
    expect(firstToolCall(formatted).index).toBe(0);
  });

  it('_formatMessages: arguments-строка не трогается', () => {
    const argsStr = '{"command":"pwd"}';
    const formatted = provider._formatMessages([
      makeMessage({
        toolUse: [
          {
            id: 'call_2',
            type: 'function',
            function: { name: 'execute_shell', arguments: argsStr },
          },
        ],
      }),
    ]);
    const fn = firstToolCall(formatted).function as Record<string, unknown>;
    expect(fn.arguments).toBe(argsStr);
  });

  it('_formatMessages: отсутствие arguments не роняет запрос', () => {
    const formatted = provider._formatMessages([
      makeMessage({
        toolUse: [
          { id: 'call_3', type: 'function', function: { name: 'noop' } },
        ],
      }),
    ]);
    const tc = firstToolCall(formatted);
    expect((tc.function as Record<string, unknown>).name).toBe('noop');
    expect((tc.function as Record<string, unknown>).arguments).toBeUndefined();
  });

  it('_formatMessages: assistant с reasoning → reasoning_content; без reasoning → нет', () => {
    const withReasoning = provider._formatMessages([
      makeMessage({ role: 'assistant', reasoning: 'подумал и решил' }),
    ]);
    expect(withReasoning[0]!.reasoning_content).toBe('подумал и решил');

    const withoutReasoning = provider._formatMessages([
      makeMessage({ role: 'assistant' }),
    ]);
    expect(withoutReasoning[0]!.reasoning_content).toBeUndefined();
  });
});

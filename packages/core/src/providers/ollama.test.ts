import { describe, it, expect, vi, afterEach } from 'vitest';
import { OllamaProvider } from './ollama.js';
import { ProviderFactory, type LLMMessage, type SystemPromptPayload } from './base.js';
import './index.js';
import type { TokenUsage, LLMChunk } from '@itphx/synth-shared';

const baseParams = {
  url: 'http://omn.example.test/api/chat',
  apiKey: 'key',
  model: 'qwen3.8:27b',
  timeout: 30,
};

// Доступ к приватным методам для юнит-проверки.
type OllamaPrivate = {
  _formatMessages(messages: LLMMessage[]): Array<Record<string, unknown>>;
  _parseResponse(data: Record<string, unknown>): { toolCalls?: Record<string, unknown>[]; usage: TokenUsage };
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

describe('OllamaProvider — system prompt payload (ADR-070 §2.2)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('chat: system prompt уходит первым сообщением role=system, а не body.system', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: { content: 'ok' } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OllamaProvider(baseParams);
    const payload: SystemPromptPayload = { text: 'system text', cacheKey: 'sess-1' };
    await provider.chat([makeMessage()], payload);

    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
    // /api/chat игнорирует top-level system — поле быть не должно.
    expect(body.system).toBeUndefined();
    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages[0]).toEqual({ role: 'system', content: 'system text' });
  });

  it('chatAsync: system prompt уходит первым сообщением role=system, а не body.system', async () => {
    const lines = [JSON.stringify({ message: { content: 'ok' }, done: true })].join('\n') + '\n';
    const fetchMock = vi.fn().mockResolvedValue(new Response(lines, {
      status: 200,
      headers: { 'Content-Type': 'application/x-ndjson' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OllamaProvider(baseParams);
    const payload: SystemPromptPayload = { text: 'system text', cacheKey: 'sess-1' };
    // Полностью вычитываем генератор, чтобы fetch гарантированно выполнился.
    const chunks: LLMChunk[] = [];
    for await (const c of provider.chatAsync([makeMessage()], payload)) chunks.push(c);
    expect(chunks.length).toBeGreaterThan(0);

    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
    expect(body.system).toBeUndefined();
    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages[0]).toEqual({ role: 'system', content: 'system text' });
  });

  it('chat: без системного промпта сообщение role=system не добавляется', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: { content: 'ok' } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OllamaProvider(baseParams);
    await provider.chat([makeMessage()]);

    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages.some((m) => m.role === 'system')).toBe(false);
  });
});

describe('OllamaProvider — usage (ADR-070 §2.3)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('_parseResponse: cache-поля = 0, total = input + output', () => {
    const provider = new OllamaProvider(baseParams) as unknown as OllamaPrivate;
    const resp = provider._parseResponse({
      message: { content: 'ok' },
      prompt_eval_count: 12,
      eval_count: 3,
    });
    expect(resp.usage).toMatchObject({
      inputTokens: 12,
      outputTokens: 3,
      totalTokens: 15,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  it('chatAsync: usage в чанке актуален (накопление до yield, не отстаёт)', async () => {
    // prompt_eval_count/eval_count приходят в том же чанке, что и content.
    // Накопление должно происходить ДО yield — иначе чанк несёт предыдущее
    // (устаревшее) значение.
    const lines = [
      JSON.stringify({ message: { content: 'a' }, done: false, prompt_eval_count: 5, eval_count: 1 }),
      JSON.stringify({ message: { content: 'b' }, done: false, prompt_eval_count: 3, eval_count: 2 }),
      JSON.stringify({ message: { content: '' }, done: true, prompt_eval_count: 0, eval_count: 0 }),
    ].join('\n') + '\n';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(lines, {
      status: 200,
      headers: { 'Content-Type': 'application/x-ndjson' },
    })));

    const provider = new OllamaProvider(baseParams);
    const chunks: LLMChunk[] = [];
    // Снимаем значения usage в момент yield: провайдер мутирует объект
    // running total in place, поэтому ссылка после полного прохода уже финальна.
    const seen: Array<{ inputTokens: number; outputTokens: number; totalTokens: number }> = [];
    for await (const c of provider.chatAsync([makeMessage()])) {
      chunks.push(c);
      if (c.usage) seen.push({ ...c.usage });
    }

    // Первый чанк уже несёт 5/1 (running total), а не 0/0.
    expect(seen[0]).toMatchObject({ inputTokens: 5, outputTokens: 1, totalTokens: 6 });
    // Второй — накопленные 8/3.
    expect(seen[1]).toMatchObject({ inputTokens: 8, outputTokens: 3, totalTokens: 11 });
  });

  it('chatAsync: cache-поля = 0 в финальном чанке', async () => {
    const lines = [
      JSON.stringify({ message: { content: 'ok' }, done: false }),
      JSON.stringify({ message: { content: '' }, done: true, prompt_eval_count: 12, eval_count: 3 }),
    ].join('\n') + '\n';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(lines, {
      status: 200,
      headers: { 'Content-Type': 'application/x-ndjson' },
    })));

    const provider = new OllamaProvider(baseParams);
    const chunks: LLMChunk[] = [];
    for await (const c of provider.chatAsync([makeMessage()])) chunks.push(c);

    const final = chunks.find((c) => c.isFinal)!;
    expect(final.usage).toMatchObject({
      inputTokens: 12,
      outputTokens: 3,
      totalTokens: 15,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });
});

describe('OllamaProvider — форматирование tool_use/tool_result', () => {
  const provider = new OllamaProvider(baseParams) as unknown as OllamaPrivate;

  it('assistant(tool_use) + tool(tool_result): tool-сообщение присутствует, tool_call_id совпадает', () => {
    const formatted = provider._formatMessages([
      makeMessage({
        role: 'assistant',
        content: '',
        toolUse: [
          { id: 'call_1', type: 'function', function: { name: 'web_search', arguments: '{"query":"x"}' } },
        ],
      }),
      makeMessage({ role: 'tool', content: 'Paris', toolCallId: 'call_1' }),
    ]);

    expect(formatted[0]!.role).toBe('assistant');
    expect(formatted[1]).toMatchObject({
      role: 'tool',
      content: 'Paris',
      tool_call_id: 'call_1',
    });
  });

  it('несколько tool_result подряд → отдельные tool-сообщения', () => {
    const formatted = provider._formatMessages([
      makeMessage({
        role: 'assistant',
        content: '',
        toolUse: [
          { id: 'call_a', type: 'function', function: { name: 'a', arguments: '{}' } },
          { id: 'call_b', type: 'function', function: { name: 'b', arguments: '{}' } },
        ],
      }),
      makeMessage({ role: 'tool', content: 'res-a', toolCallId: 'call_a' }),
      makeMessage({ role: 'tool', content: 'res-b', toolCallId: 'call_b' }),
    ]);

    const toolMessages = formatted.filter((m) => m.role === 'tool');
    expect(toolMessages).toHaveLength(2);
    expect(toolMessages.map((m) => m.tool_call_id)).toEqual(['call_a', 'call_b']);
  });

  it('arguments-строка превращается в объект (Ollama требует object)', () => {
    const formatted = provider._formatMessages([
      makeMessage({
        role: 'assistant',
        content: '',
        toolUse: [
          { id: 'call_s', type: 'function', function: { name: 'web_search', arguments: '{"query":"x"}' } },
        ],
      }),
    ]);
    const fn = (formatted[0]!.tool_calls as Record<string, unknown>[])[0]!.function as Record<string, unknown>;
    expect(fn.arguments).toEqual({ query: 'x' });
  });
});

describe('OllamaProvider — num_ctx (numCtx)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function okResponse(): Response {
    return new Response(JSON.stringify({ message: { content: 'ok' } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  it('chat: numCtx → body.options.num_ctx (нативный путь /api/chat)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OllamaProvider({ ...baseParams, numCtx: 8192 });
    await provider.chat([makeMessage()]);

    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
    expect(body.options).toEqual({ num_ctx: 8192 });
  });

  it('chatAsync: numCtx → body.options.num_ctx', async () => {
    const lines = [JSON.stringify({ message: { content: 'ok' }, done: true })].join('\n') + '\n';
    const fetchMock = vi.fn().mockResolvedValue(new Response(lines, {
      status: 200,
      headers: { 'Content-Type': 'application/x-ndjson' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OllamaProvider({ ...baseParams, numCtx: 4096 });
    const chunks: LLMChunk[] = [];
    for await (const c of provider.chatAsync([makeMessage()])) chunks.push(c);
    expect(chunks.length).toBeGreaterThan(0);

    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
    expect(body.options).toEqual({ num_ctx: 4096 });
  });

  it('chat: без numCtx (0/undefined) options не добавляется', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OllamaProvider({ ...baseParams, numCtx: 0 });
    await provider.chat([makeMessage()]);

    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
    expect(body.options).toBeUndefined();
  });

  it('chat: /v1-URL нормализуется фабрикой в нативный /api/chat, num_ctx в теле', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', fetchMock);

    // Старый `/v1`-конфиг: фабрика снимает суффикс и работает нативно.
    const provider = ProviderFactory.create('ollama', {
      url: 'http://omn.example.test/v1',
      apiKey: '',
      model: 'qwen3.8:27b',
      numCtx: 2048,
    });
    expect(provider).toBeInstanceOf(OllamaProvider);
    expect(provider.url).toBe('http://omn.example.test/api/chat');

    await provider.chat([makeMessage()]);

    // Запрос уходит на нативный эндпоинт — там `options` (num_ctx) имеет эффект.
    expect(fetchMock.mock.calls[0]![0]).toBe('http://omn.example.test/api/chat');
    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
    expect(body.options).toEqual({ num_ctx: 2048 });
  });
});

describe('OllamaProvider — listModelsDetailed (метаданные и fallback контекста)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function jsonResponse(payload: unknown): Response {
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  it('/api/tags: окно, размер, параметры, квантизация, capabilities', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: unknown) => {
      if (String(url).endsWith('/api/tags')) {
        return Promise.resolve(jsonResponse({
          models: [{
            name: 'qwen3:8b',
            size: 5_000_000_000,
            details: {
              context_length: 32768,
              parameter_size: '8.2B',
              quantization_level: 'Q4_K_M',
            },
            capabilities: ['completion', 'tools'],
          }],
        }));
      }
      return Promise.reject(new Error(`unexpected request: ${String(url)}`));
    }));

    const provider = new OllamaProvider(baseParams);
    const models = await provider.listModelsDetailed();

    expect(models).toEqual([{
      id: 'qwen3:8b',
      contextWindow: 32768,
      parameterSize: '8.2B',
      quantization: 'Q4_K_M',
      sizeBytes: 5_000_000_000,
      capabilities: ['completion', 'tools'],
    }]);
  });

  it('fallback POST /api/show: model_info["<arch>.context_length"]', async () => {
    const fetchMock = vi.fn().mockImplementation((url: unknown) => {
      if (String(url).endsWith('/api/tags')) {
        return Promise.resolve(jsonResponse({
          models: [{ name: 'llama3:8b', size: 4_000_000_000, details: { parameter_size: '8B' } }],
        }));
      }
      if (String(url).endsWith('/api/show')) {
        return Promise.resolve(jsonResponse({
          model_info: { 'general.architecture': 'llama', 'llama.context_length': 8192 },
        }));
      }
      return Promise.reject(new Error(`unexpected request: ${String(url)}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OllamaProvider(baseParams);
    const models = await provider.listModelsDetailed();

    expect(models[0]).toMatchObject({
      id: 'llama3:8b',
      contextWindow: 8192,
      parameterSize: '8B',
      sizeBytes: 4_000_000_000,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/show'),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('ошибка /api/show не роняет синк: модель остаётся без окна', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: unknown) => {
      if (String(url).endsWith('/api/tags')) {
        return Promise.resolve(jsonResponse({ models: [{ name: 'broken:1b' }] }));
      }
      return Promise.resolve(new Response('boom', { status: 500 }));
    }));

    const provider = new OllamaProvider(baseParams);
    const models = await provider.listModelsDetailed();
    expect(models).toEqual([{ id: 'broken:1b' }]);
  });

  it('fallback /api/show: пробы идут параллельно батчами, порядок моделей сохранён', async () => {
    const modelCount = 8;
    let inFlight = 0;
    let maxInFlight = 0;

    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: unknown) => {
      if (String(url).endsWith('/api/tags')) {
        return Promise.resolve(jsonResponse({
          models: Array.from({ length: modelCount }, (_, i) => ({ name: `qwen3:${i}b` })),
        }));
      }
      if (String(url).endsWith('/api/show')) {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        return new Promise<Response>((resolve) => {
          setTimeout(() => {
            inFlight -= 1;
            resolve(jsonResponse({
              model_info: { 'general.architecture': 'qwen3', 'qwen3.context_length': 4096 },
            }));
          }, 5);
        });
      }
      return Promise.reject(new Error(`unexpected request: ${String(url)}`));
    }));

    const provider = new OllamaProvider(baseParams);
    const models = await provider.listModelsDetailed();

    // Порядок моделей сохранён, окна проставлены всем (индексы не перепутаны).
    expect(models.map((m) => m.id)).toEqual(
      Array.from({ length: modelCount }, (_, i) => `qwen3:${i}b`),
    );
    expect(models.map((m) => m.contextWindow)).toEqual(
      Array.from({ length: modelCount }, () => 4096),
    );
    // Больше одного запроса одновременно, но не больше размера батча.
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(6);
  });

  it('fallback /api/show: не более MAX_CONTEXT_PROBES (50) проб', async () => {
    const total = 60;
    let showCalls = 0;

    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: unknown) => {
      if (String(url).endsWith('/api/tags')) {
        return Promise.resolve(jsonResponse({
          models: Array.from({ length: total }, (_, i) => ({ name: `m${i}` })),
        }));
      }
      if (String(url).endsWith('/api/show')) {
        showCalls += 1;
        return Promise.resolve(jsonResponse({
          model_info: { 'general.architecture': 'llama', 'llama.context_length': 2048 },
        }));
      }
      return Promise.reject(new Error(`unexpected request: ${String(url)}`));
    }));

    const provider = new OllamaProvider(baseParams);
    const models = await provider.listModelsDetailed();

    expect(showCalls).toBe(50);
    expect(models).toHaveLength(total);
    expect(models[49]!.contextWindow).toBe(2048);
    expect(models[50]!.contextWindow).toBeUndefined();
  });

  it('сетевой сбой fetch не оставляет активный таймер (try/finally)', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));

    const provider = new OllamaProvider(baseParams);
    await expect(provider.listModelsDetailed()).resolves.toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ошибка /api/show не оставляет активный таймер (try/finally)', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: unknown) => {
      if (String(url).endsWith('/api/tags')) {
        return Promise.resolve(jsonResponse({ models: [{ name: 'm1' }] }));
      }
      return Promise.reject(new Error('network'));
    }));

    const provider = new OllamaProvider(baseParams);
    await expect(provider.listModelsDetailed()).resolves.toEqual([{ id: 'm1' }]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('OllamaProvider — вложения (ADR-115)', () => {
  const provider = new OllamaProvider(baseParams) as unknown as OllamaPrivate;
  const imageAttachment = { mime: 'image/jpeg', name: 'photo.jpg', base64: 'iVBORw0KGgo=' };
  const audioAttachment = { mime: 'audio/ogg', name: 'voice.oga', base64: 'T2dnUw==' };

  it('изображение → массив base64 в поле images (без data-URI)', () => {
    const formatted = provider._formatMessages([
      makeMessage({
        role: 'user',
        content: 'что на фото?',
        attachments: [imageAttachment],
      }),
    ]);

    expect(formatted[0]!.images).toEqual(['iVBORw0KGgo=']);
    expect(formatted[0]!.content).toBe('что на фото?');
  });

  it('несколько изображений сохраняют порядок', () => {
    const formatted = provider._formatMessages([
      makeMessage({
        role: 'user',
        content: 'сравни',
        attachments: [
          imageAttachment,
          { mime: 'image/png', base64: 'iVBORw0KGgo=' },
        ],
      }),
    ]);

    expect(formatted[0]!.images).toEqual(['iVBORw0KGgo=', 'iVBORw0KGgo=']);
  });

  it('аудио не кодируется (модель без audio capability)', () => {
    const formatted = provider._formatMessages([
      makeMessage({
        role: 'user',
        content: 'послушай',
        attachments: [audioAttachment],
      }),
    ]);

    expect(formatted[0]!.images).toBeUndefined();
    expect(formatted[0]!.content).toBe('послушай');
  });

  it('без вложений поле images не появляется', () => {
    const formatted = provider._formatMessages([
      makeMessage({ role: 'user', content: 'просто текст' }),
    ]);

    expect(formatted[0]!.images).toBeUndefined();
  });
});

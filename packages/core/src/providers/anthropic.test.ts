/**
 * ADR-070 §2.2 (Ф2-часть 1): Anthropic prompt-cache — `body.system` массивом,
 * `cache_control: {type:'ephemeral'}` на границе stable-префикса, конце system,
 * последнем tool-дефинишене и последнем user text-part. Бюджет ≤4 breakpoint'а.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { AnthropicProvider } from './anthropic.js';
import { ChatOrchestrator } from '../engine/orchestrator.js';
import type { LLMMessage, SystemPromptPayload } from './base.js';
import type { LLMChunk } from '@itphx/synth-shared';
import { generateId, makeTextPart, MessageRole, nowISO, type Message } from '@itphx/synth-shared';

const baseParams = {
  url: 'http://api.anthropic.test/v1/messages',
  apiKey: 'key',
  model: 'claude-test',
  timeout: 30,
};

function makeMessage(overrides: Partial<LLMMessage> = {}): LLMMessage {
  return {
    id: 'm1',
    role: 'user',
    content: 'hi',
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    disabled: false,
    pinned: false,
    branchId: 'b1',
    ...overrides,
  };
}

function okResponse(): Response {
  return new Response(JSON.stringify({ content: [], usage: {} }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeTools(): Record<string, unknown>[] {
  return [
    { type: 'function', function: { name: 'read_file', description: '', parameters: {} } },
    { type: 'function', function: { name: 'write_file', description: '', parameters: {} } },
  ];
}

function readBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const init = fetchMock.mock.calls[0]![1] as { body: string };
  return JSON.parse(init.body) as Record<string, unknown>;
}

function countCacheControls(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + countCacheControls(item), 0);
  if (value && typeof value === 'object') {
    let count = 0;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'cache_control') count++;
      else count += countCacheControls(child);
    }
    return count;
  }
  return 0;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AnthropicProvider — prompt-cache (ADR-070 §2.2)', () => {
  it('stablePrefix: system — два блока, breakpoints на stable/end, tools и message', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', fetchMock);

    const provider = new AnthropicProvider(baseParams);
    const stable = 'STABLE PREFIX';
    const payload: SystemPromptPayload = {
      text: `${stable}\n\ncontext`,
      stablePrefix: stable,
      cacheKey: 'sess-1',
      cachePolicy: 'auto',
    };

    await provider.chat([makeMessage()], payload, makeTools());
    const body = readBody(fetchMock);

    const system = body.system as Array<Record<string, unknown>>;
    expect(system).toHaveLength(2);
    expect(system[0]).toMatchObject({ type: 'text', text: stable, cache_control: { type: 'ephemeral' } });
    expect(system[1]).toMatchObject({ type: 'text', text: '\n\ncontext', cache_control: { type: 'ephemeral' } });

    const tools = body.tools as Array<Record<string, unknown>>;
    expect(tools[tools.length - 1]!.cache_control).toEqual({ type: 'ephemeral' });
    expect(tools[0]!.cache_control).toBeUndefined();

    const messages = body.messages as Array<Record<string, unknown>>;
    const lastUserContent = messages[messages.length - 1]!.content as Array<Record<string, unknown>>;
    expect(lastUserContent[0]!.cache_control).toEqual({ type: 'ephemeral' });

    // Ровно 4 breakpoint'а: 2 system + tools + message.
    expect(countCacheControls(body)).toBe(4);
  });

  it('ADR-071: stableToolCount — брейкпоинт на последнем встроенном, MCP не кэшируется', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', fetchMock);

    const provider = new AnthropicProvider(baseParams);
    const payload: SystemPromptPayload = {
      text: 'sys',
      stablePrefix: 'sys',
      cacheKey: 'sess-1',
      cachePolicy: 'auto',
      stableToolCount: 2,
    };
    const tools = [
      ...makeTools(),
      { type: 'function', function: { name: 'srv_search', description: '', parameters: {} } },
    ];

    await provider.chat([makeMessage()], payload, tools);
    const body = readBody(fetchMock);

    const sent = body.tools as Array<Record<string, unknown>>;
    expect(sent).toHaveLength(3);
    expect(sent[0]!.cache_control).toBeUndefined();
    // Последний встроенный (индекс 1) — граница stable-слоя.
    expect(sent[1]!.cache_control).toEqual({ type: 'ephemeral' });
    // MCP после границы не кэшируется.
    expect(sent[2]!.cache_control).toBeUndefined();
  });

  it('ADR-071: stableToolCount=0 (только MCP) — tools-брейкпоинт не ставится', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', fetchMock);

    const provider = new AnthropicProvider(baseParams);
    const payload: SystemPromptPayload = {
      text: 'sys',
      stablePrefix: 'sys',
      cacheKey: 'sess-1',
      cachePolicy: 'auto',
      stableToolCount: 0,
    };
    const tools = [
      { type: 'function', function: { name: 'srv_search', description: '', parameters: {} } },
    ];

    await provider.chat([makeMessage()], payload, tools);
    const body = readBody(fetchMock);

    const sent = body.tools as Array<Record<string, unknown>>;
    expect(sent[0]!.cache_control).toBeUndefined();
    expect(countCacheControls(body)).toBe(2); // system.stable + system.end
  });

  it('без stablePrefix (строка): один system-блок с cache_control при auto', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', fetchMock);

    const provider = new AnthropicProvider(baseParams);
    await provider.chat([makeMessage()], 'system text');
    const body = readBody(fetchMock);

    const system = body.system as Array<Record<string, unknown>>;
    expect(system).toHaveLength(1);
    expect(system[0]).toMatchObject({ type: 'text', text: 'system text', cache_control: { type: 'ephemeral' } });
  });

  it('cachePolicy none: ни одного cache_control, system без маркеров', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', fetchMock);

    const provider = new AnthropicProvider(baseParams);
    const stable = 'STABLE PREFIX';
    const payload: SystemPromptPayload = {
      text: `${stable}\n\ncontext`,
      stablePrefix: stable,
      cacheKey: 'sess-1',
      cachePolicy: 'none',
    };

    await provider.chat([makeMessage()], payload, makeTools());
    const body = readBody(fetchMock);

    const system = body.system as Array<Record<string, unknown>>;
    expect(system).toHaveLength(2);
    expect(system[0]!.cache_control).toBeUndefined();
    expect(system[1]!.cache_control).toBeUndefined();
    const tools = body.tools as Array<Record<string, unknown>>;
    expect(tools[tools.length - 1]!.cache_control).toBeUndefined();
    const messages = body.messages as Array<Record<string, unknown>>;
    const lastUserContent = messages[messages.length - 1]!.content as Array<Record<string, unknown>>;
    expect(lastUserContent[0]!.cache_control).toBeUndefined();
    expect(countCacheControls(body)).toBe(0);
  });

  it('stablePrefix не является префиксом text → один system-блок', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', fetchMock);

    const provider = new AnthropicProvider(baseParams);
    const payload: SystemPromptPayload = {
      text: 'actual text',
      stablePrefix: 'другой префикс',
      cacheKey: 'sess-1',
      cachePolicy: 'auto',
    };

    await provider.chat([makeMessage()], payload);
    const body = readBody(fetchMock);

    const system = body.system as Array<Record<string, unknown>>;
    expect(system).toHaveLength(1);
    expect(system[0]).toMatchObject({ type: 'text', text: 'actual text', cache_control: { type: 'ephemeral' } });
  });
});

describe('AnthropicProvider — usage (ADR-070 §2.3)', () => {
  it('non-stream: inputTokens = input_tokens + cacheRead + cacheWrite', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      content: [{ type: 'text', text: 'ok' }],
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 20,
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new AnthropicProvider(baseParams);
    const resp = await provider.chat([makeMessage()]);

    expect(resp.usage).toMatchObject({
      inputTokens: 60,
      outputTokens: 5,
      totalTokens: 65,
      cacheReadTokens: 30,
      cacheWriteTokens: 20,
    });
  });

  it('stream: message_start input/cache + message_delta output', async () => {
    const sse = [
      `event: message_start\ndata: ${JSON.stringify({
        type: 'message_start',
        message: {
          usage: {
            input_tokens: 10,
            output_tokens: 1,
            cache_read_input_tokens: 30,
            cache_creation_input_tokens: 20,
          },
        },
      })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'ok' },
      })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({
        type: 'message_delta',
        usage: { output_tokens: 7 },
      })}\n\n`,
      `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
    ].join('');
    const fetchMock = vi.fn().mockResolvedValue(new Response(sse, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new AnthropicProvider(baseParams);
    const chunks: LLMChunk[] = [];
    for await (const c of provider.chatAsync([makeMessage()])) chunks.push(c);

    const final = chunks.find((c) => c.isFinal)!;
    expect(final.usage).toMatchObject({
      inputTokens: 60,
      outputTokens: 7,
      totalTokens: 67,
      cacheReadTokens: 30,
      cacheWriteTokens: 20,
    });
  });
});

// Доступ к приватным методам для юнит-проверки.
type AnthropicPrivate = {
  _formatMessages(messages: LLMMessage[]): Array<Record<string, unknown>>;
};

describe('AnthropicProvider — форматирование tool_use/tool_result (регресс)', () => {
  const provider = new AnthropicProvider(baseParams) as unknown as AnthropicPrivate;

  function toolUseMessage(id: string): LLMMessage {
    return makeMessage({
      role: 'assistant',
      content: '',
      toolUse: [
        { id, type: 'function', function: { name: 'web_search', arguments: '{"query":"capital"}' } },
      ],
    });
  }

  function parts(msg: Record<string, unknown>): Array<Record<string, unknown>> {
    return msg.content as Array<Record<string, unknown>>;
  }

  function hasToolResult(messages: Array<Record<string, unknown>>): boolean {
    return messages.some((m) => parts(m).some((p) => p.type === 'tool_result'));
  }

  it('assistant(tool_use) + tool(tool_result): tool_result присутствует, tool_use_id совпадает', () => {
    const formatted = provider._formatMessages([
      makeMessage({ role: 'user', content: 'проверь' }),
      toolUseMessage('toolu_1'),
      makeMessage({ role: 'tool', content: 'Paris', toolCallId: 'toolu_1' }),
    ]);

    expect(formatted.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    const toolParts = parts(formatted[2]!);
    expect(toolParts).toHaveLength(1);
    expect(toolParts[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'toolu_1',
      content: 'Paris',
    });
  });

  it('регресс: tool_result не пропускается из-за assistant.tool_use', () => {
    const formatted = provider._formatMessages([
      toolUseMessage('toolu_x'),
      makeMessage({ role: 'tool', content: 'result', toolCallId: 'toolu_x' }),
    ]);

    expect(hasToolResult(formatted)).toBe(true);
    const assistantParts = parts(formatted[0]!);
    expect(assistantParts.some((p) => p.type === 'tool_use' && p.id === 'toolu_x')).toBe(true);
  });

  it('несколько tool_result подряд → один user-блок с несколькими tool_result', () => {
    const formatted = provider._formatMessages([
      makeMessage({
        role: 'assistant',
        content: '',
        toolUse: [
          { id: 'toolu_a', type: 'function', function: { name: 'a', arguments: '{}' } },
          { id: 'toolu_b', type: 'function', function: { name: 'b', arguments: '{}' } },
        ],
      }),
      makeMessage({ role: 'tool', content: 'res-a', toolCallId: 'toolu_a' }),
      makeMessage({ role: 'tool', content: 'res-b', toolCallId: 'toolu_b' }),
    ]);

    expect(formatted).toHaveLength(2);
    expect(formatted[1]!.role).toBe('user');
    const toolParts = parts(formatted[1]!);
    expect(toolParts).toHaveLength(2);
    expect(toolParts.map((p) => p.tool_use_id)).toEqual(['toolu_a', 'toolu_b']);
  });

  it('дубликат tool_result с тем же tool_call_id отбрасывается', () => {
    const formatted = provider._formatMessages([
      toolUseMessage('toolu_dup'),
      makeMessage({ role: 'tool', content: 'first', toolCallId: 'toolu_dup' }),
      makeMessage({ role: 'tool', content: 'second', toolCallId: 'toolu_dup' }),
    ]);

    const toolResultParts = formatted.flatMap((m) => parts(m)).filter((p) => p.type === 'tool_result');
    expect(toolResultParts).toHaveLength(1);
    expect(toolResultParts[0]!.content).toBe('first');
  });

  it('arguments строкой → input объектом; объект — как есть; невалидная строка → {}', () => {
    const formatted = provider._formatMessages([
      makeMessage({
        role: 'assistant',
        content: '',
        toolUse: [{ id: 't1', type: 'function', function: { name: 'a', arguments: '{"query":"x"}' } }],
      }),
      makeMessage({
        role: 'assistant',
        content: '',
        toolUse: [{ id: 't2', type: 'function', function: { name: 'b', arguments: { query: 'y' } } }],
      }),
      makeMessage({
        role: 'assistant',
        content: '',
        toolUse: [{ id: 't3', type: 'function', function: { name: 'c', arguments: '{bad json' } }],
      }),
    ]);

    const inputs = formatted.map((m) => parts(m)[0]!.input);
    expect(inputs[0]).toEqual({ query: 'x' });
    expect(inputs[1]).toEqual({ query: 'y' });
    expect(inputs[2]).toEqual({});
  });
});

describe('AnthropicProvider — пары tool_use/tool_result из _sessionMessagesToLlm (регресс агентов)', () => {
  const provider = new AnthropicProvider(baseParams) as unknown as AnthropicPrivate;

  function makeMsg(overrides: Partial<Message> & Pick<Message, 'role'>): Message {
    return {
      id: generateId(),
      seq: 0,
      origin: 'local',
      parts: [makeTextPart(overrides.content ?? '')],
      content: '',
      createdAt: nowISO(),
      disabled: false,
      pinned: false,
      hidden: false,
      ...overrides,
    };
  }

  it('смена агента: у каждого tool_result есть парный tool_use, осиротевших нет', () => {
    const messages: Message[] = [
      makeMsg({ role: MessageRole.USER, content: 'Прочитай файл', author: 'user' }),
      makeMsg({
        role: MessageRole.ASSISTANT,
        content: 'Читаю файл',
        agentRole: 'agentA',
        toolCalls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
      }),
      makeMsg({ role: MessageRole.TOOL, content: 'содержимое', agentRole: 'agentA', toolCallId: 'call_1' }),
      makeMsg({ role: MessageRole.ASSISTANT, content: 'Готово', agentRole: 'developer' }),
    ];

    const llm = ChatOrchestrator._sessionMessagesToLlm(messages, 'developer', 'user');
    const formatted = provider._formatMessages(llm);

    const allParts = formatted.flatMap((m) => m.content as Array<Record<string, unknown>>);
    const toolUseIds = new Set(
      allParts.filter((p) => p.type === 'tool_use').map((p) => p.id),
    );
    const toolResults = allParts.filter((p) => p.type === 'tool_result');

    expect(toolResults).toHaveLength(1);
    for (const tr of toolResults) {
      expect(toolUseIds.has(tr.tool_use_id as string)).toBe(true);
    }
  });
});

describe('AnthropicProvider — ошибки прокси (ADR-041)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('chat: HTTP 200 с {type:error} → бросает ошибку, а не пустой ответ', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      type: 'error',
      error: { type: 'invalid_request_error', message: 'Can only get item pairs from a mapping.' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new AnthropicProvider(baseParams);
    await expect(provider.chat([makeMessage()])).rejects.toThrow('Can only get item pairs from a mapping.');
  });

  it('chatAsync: data-чанк {code,message} → бросает ошибку, а не пустой финал', async () => {
    const sse = `data: ${JSON.stringify({
      code: 'InvalidParameter',
      message: 'Can only get item pairs from a mapping.',
      request_id: 'r1',
    })}\n\n`;
    const fetchMock = vi.fn().mockResolvedValue(new Response(sse, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new AnthropicProvider(baseParams);
    const collect = async (): Promise<LLMChunk[]> => {
      const out: LLMChunk[] = [];
      for await (const c of provider.chatAsync([makeMessage()])) out.push(c);
      return out;
    };
    await expect(collect()).rejects.toThrow('Can only get item pairs from a mapping.');
  });
});

describe('AnthropicProvider — listModelsDetailed', () => {
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

  it('официальный Anthropic: max_input_tokens/max_tokens/display_name', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      data: [{
        type: 'model',
        id: 'claude-sonnet-4',
        display_name: 'Claude Sonnet 4',
        max_input_tokens: 200000,
        max_tokens: 8192,
      }],
    })));

    const provider = new AnthropicProvider(baseParams);
    const models = await provider.listModelsDetailed();

    expect(models).toEqual([{
      id: 'claude-sonnet-4',
      name: 'Claude Sonnet 4',
      contextWindow: 200000,
      maxOutputTokens: 8192,
    }]);
  });

  it('nullable-поля не попадают в результат', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      data: [{ id: 'claude-bare', display_name: null, max_input_tokens: null, max_tokens: null }],
    })));

    const provider = new AnthropicProvider(baseParams);
    const models = await provider.listModelsDetailed();

    expect(models).toEqual([{ id: 'claude-bare' }]);
  });

  it('RouterAI-каталог на /v1/models: context_length + pricing (в т.ч. cache)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      data: [{
        id: 'anthropic/claude-sonnet-4',
        name: 'Claude Sonnet 4',
        context_length: 200000,
        pricing: {
          prompt: '0.000003',
          completion: '0.000015',
          input_cache_read: '0.0000003',
          input_cache_write: '0.00000375',
        },
      }],
    })));

    const provider = new AnthropicProvider(baseParams);
    const models = await provider.listModelsDetailed();

    expect(models[0]).toEqual({
      id: 'anthropic/claude-sonnet-4',
      name: 'Claude Sonnet 4',
      contextWindow: 200000,
      priceUnit: 'token',
      inputPrice: 3,
      outputPrice: 15,
      cacheReadPrice: 0.3,
      cacheWritePrice: 3.75,
    });
  });

  it('сетевой сбой → []', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));

    const provider = new AnthropicProvider(baseParams);
    await expect(provider.listModelsDetailed()).resolves.toEqual([]);
  });

  it('RouterAI: architecture.input_modalities → модальности модели', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      data: [
        {
          id: 'minimax/minimax-m3.1-flash',
          name: 'MiniMax M3.1 Flash',
          context_length: 1000000,
          architecture: {
            modality: 'text+image+video->text',
            input_modalities: ['text', 'image', 'video'],
          },
        },
        { id: 'minimax/minimax-m2.7', architecture: { modality: 'text->text' } },
      ],
    })));

    const provider = new AnthropicProvider(baseParams);
    const models = await provider.listModelsDetailed();

    expect(models[0]).toMatchObject({
      id: 'minimax/minimax-m3.1-flash',
      modalities: ['text', 'image', 'video'],
    });
    // Только текст — модальность задана каталогом явно.
    expect(models[1]).toMatchObject({ id: 'minimax/minimax-m2.7', modalities: ['text'] });
  });

  it('сетевой сбой не оставляет активный таймер (try/finally)', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));

    const provider = new AnthropicProvider(baseParams);
    await expect(provider.listModelsDetailed()).resolves.toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('AnthropicProvider — вложения (ADR-115)', () => {
  type AnthropicPrivate = {
    _formatMessages(messages: LLMMessage[]): Array<Record<string, unknown>>;
  };

  const imageAttachment = { mime: 'image/png', name: 'photo.png', base64: 'iVBORw0KGgo=' };
  const pdfAttachment = { mime: 'application/pdf', base64: 'JVBERi0=' };
  const audioAttachment = { mime: 'audio/wav', base64: 'UklGRg==' };

  function providerWithModel(model: string): AnthropicPrivate {
    return new AnthropicProvider({ ...baseParams, model }) as unknown as AnthropicPrivate;
  }

  function providerWithUrl(url: string): AnthropicPrivate {
    return new AnthropicProvider({ ...baseParams, url }) as unknown as AnthropicPrivate;
  }

  it('изображение → image-блок с base64-source', () => {
    const formatted = providerWithModel('claude-sonnet-4-20250514')._formatMessages([
      makeMessage({ content: 'что на фото?', attachments: [imageAttachment] }),
    ]);

    expect(formatted[0]!.content).toEqual([
      { type: 'text', text: 'что на фото?' },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' },
      },
    ]);
  });

  it('PDF → document-блок с media_type application/pdf', () => {
    const formatted = providerWithModel('claude-sonnet-4-20250514')._formatMessages([
      makeMessage({ content: 'разбери документ', attachments: [pdfAttachment] }),
    ]);

    expect(formatted[0]!.content).toEqual([
      { type: 'text', text: 'разбери документ' },
      {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' },
      },
    ]);
  });

  it('аудио не кодируется — официальный API Anthropic его не принимает', () => {
    const formatted = providerWithModel('claude-sonnet-4-20250514')._formatMessages([
      makeMessage({ content: 'послушай', attachments: [audioAttachment] }),
    ]);

    expect(formatted[0]!.content).toEqual([{ type: 'text', text: 'послушай' }]);
  });

  it('аудио wav у RouterAI → audio-блок; ogg не отправляется (не декодируется)', () => {
    const formatted = providerWithUrl('https://routerai.ru/api/v1/messages')._formatMessages([
      makeMessage({
        content: 'послушай',
        attachments: [
          audioAttachment,
          { mime: 'audio/ogg', base64: 'T2dnUw==' },
        ],
      }),
    ]);

    // ogg RouterAI возвращает 200, но модель аудио не слышит (проверено на
    // живом API) — такой файл должен идти через aux-модель, а не нативно.
    expect(formatted[0]!.content).toEqual([
      { type: 'text', text: 'послушай' },
      {
        type: 'audio',
        source: { type: 'base64', media_type: 'audio/wav', data: 'UklGRg==' },
      },
    ]);
  });

  it('картинка у модели вне справочника → image-блок (провайдер не фильтрует)', () => {
    // Регрессия: `minimax/minimax-m3.1-flash` (RouterAI, тип anthropic) —
    // vision-модель, которой нет в справочнике; второй фильтр по
    // `resolveModelModalities` отбрасывал её вложения.
    const formatted = providerWithModel('minimax/minimax-m3.1-flash')._formatMessages([
      makeMessage({ content: 'что на фото?', attachments: [imageAttachment] }),
    ]);

    expect(formatted[0]!.content).toEqual([
      { type: 'text', text: 'что на фото?' },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' },
      },
    ]);
  });

  it('текстовое сообщение без вложений — прежний [{type:text}]', () => {
    const formatted = providerWithModel('claude-sonnet-4-20250514')._formatMessages([
      makeMessage({ content: 'просто текст' }),
    ]);

    expect(formatted[0]!.content).toEqual([{ type: 'text', text: 'просто текст' }]);
  });
});

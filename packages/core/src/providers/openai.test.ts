import { describe, it, expect, vi, afterEach } from 'vitest';
import { OpenAIProvider } from './openai.js';
import type { LLMMessage, SystemPromptPayload } from './base.js';
import type { LLMChunk } from '@itphx/synth-shared';
import type { ModelCompatibility } from '@itphx/synth-shared';

const baseParams = {
  url: 'http://api.test.example/v1/chat/completions',
  apiKey: 'key',
  model: 'deepseek-v4-flash',
  timeout: 30,
};

/** Провайдер вне DeepSeek-эвристики: `reasoning_content` не требуется. */
const plainParams = {
  url: 'http://api.plain.example/v1/chat/completions',
  apiKey: 'key',
  model: 'gpt-4o',
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

  it('_formatMessages: assistant с reasoning → reasoning_content; без reasoning → нет (обычный провайдер)', () => {
    const plain = new OpenAIProvider(plainParams) as unknown as OpenAIPrivate;
    const withReasoning = plain._formatMessages([
      makeMessage({ role: 'assistant', reasoning: 'подумал и решил' }),
    ]);
    expect(withReasoning[0]!.reasoning_content).toBe('подумал и решил');

    const withoutReasoning = plain._formatMessages([
      makeMessage({ role: 'assistant' }),
    ]);
    expect(withoutReasoning[0]!.reasoning_content).toBeUndefined();
  });

  it('_formatMessages: DeepSeek требует reasoning_content всегда — пустой строкой', () => {
    // Модель `...deepseek...` (эвристика по имени модели).
    const byModel = provider._formatMessages([makeMessage({ role: 'assistant' })]);
    expect(byModel[0]!.reasoning_content).toBe('');

    // Явный тип/имя провайдера `deepseek` на недефолтном URL/модели.
    const byType = new OpenAIProvider({
      ...plainParams,
      type: 'deepseek',
      name: 'deepseek',
      model: 'chat',
    }) as unknown as OpenAIPrivate;
    expect(byType._formatMessages([makeMessage({ role: 'assistant' })])[0]!.reasoning_content).toBe('');

    // URL `api.deepseek.com`.
    const byUrl = new OpenAIProvider({
      ...plainParams,
      url: 'https://api.deepseek.com/v1/chat/completions',
    }) as unknown as OpenAIPrivate;
    expect(byUrl._formatMessages([makeMessage({ role: 'assistant' })])[0]!.reasoning_content).toBe('');

    // Явный `requiresReasoning: true` — сильнее эвристики (недефолтный провайдер).
    const explicit = new OpenAIProvider({ ...plainParams, requiresReasoning: true }) as unknown as OpenAIPrivate;
    expect(explicit._formatMessages([makeMessage({ role: 'assistant' })])[0]!.reasoning_content).toBe('');
  });

  it('_formatMessages: requiresReasoning=false сильнее deepseek-эвристики', () => {
    const disabled = new OpenAIProvider({ ...baseParams, requiresReasoning: false }) as unknown as OpenAIPrivate;
    const formatted = disabled._formatMessages([makeMessage({ role: 'assistant' })]);
    expect(formatted[0]!.reasoning_content).toBeUndefined();
  });

  it('_formatMessages: синтетический assistant-префилл шага-лимита получает reasoning_content="" (регресс 400 DeepSeek)', async () => {
    const { maxStepsAssistantMessage } = await import('../engine/llm/max-steps.js');
    const formatted = provider._formatMessages([maxStepsAssistantMessage('report text only')]);
    expect(formatted[0]!.role).toBe('assistant');
    expect(formatted[0]!.reasoning_content).toBe('');
  });
});

describe('OpenAIProvider — prompt_cache_key (ADR-070 §2.2)', () => {
  function okResponse(): Response {
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: {} }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('auto + cacheKey → prompt_cache_key в теле, system берётся из payload.text', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', fetchMock);

    // Обычный провайдер (не DeepSeek): assistant без reasoning не получает
    // `reasoning_content` — проверяем только cache-поле.
    const provider = new OpenAIProvider(plainParams);
    const payload: SystemPromptPayload = { text: 'sys', cacheKey: 'sess-1', cachePolicy: 'auto' };
    await provider.chat([makeMessage()], payload);

    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
    expect(body.prompt_cache_key).toBe('sess-1');
    expect(body.messages).toEqual([
      { role: 'system', content: [{ type: 'text', text: 'sys' }] },
      { role: 'assistant', content: '' },
    ]);
  });

  it('cachePolicy none → prompt_cache_key отсутствует', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenAIProvider(baseParams);
    const payload: SystemPromptPayload = { text: 'sys', cacheKey: 'sess-1', cachePolicy: 'none' };
    await provider.chat([makeMessage()], payload);

    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
    expect(body.prompt_cache_key).toBeUndefined();
  });

  it('строка без cacheKey → prompt_cache_key отсутствует (обратная совместимость)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenAIProvider(baseParams);
    await provider.chat([makeMessage()], 'sys');

    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
    expect(body.prompt_cache_key).toBeUndefined();
  });
});

describe('OpenAIProvider — usage (ADR-070 §2.3)', () => {
  function sseResponse(events: string[]): Response {
    return new Response(events.map((e) => `data: ${e}\n\n`).join(''), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('chatAsync: stream_options.include_usage и cached_tokens → cacheReadTokens', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse([
      JSON.stringify({ choices: [{ index: 0, delta: { content: 'ok' } }] }),
      JSON.stringify({
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 10,
          total_tokens: 110,
          prompt_tokens_details: { cached_tokens: 40 },
          completion_tokens_details: { reasoning_tokens: 3 },
        },
      }),
      '[DONE]',
    ]));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenAIProvider(baseParams);
    const chunks: LLMChunk[] = [];
    for await (const c of provider.chatAsync([makeMessage()])) chunks.push(c);

    const final = chunks.find((c) => c.isFinal)!;
    expect(final.usage).toMatchObject({
      inputTokens: 100,
      outputTokens: 10,
      totalTokens: 110,
      cacheReadTokens: 40,
      cacheWriteTokens: 0,
      reasoningTokens: 3,
    });

    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it('chat (non-stream): cached_tokens → cacheReadTokens; nonCached вычисляется', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: 'ok' } }],
      usage: {
        prompt_tokens: 200,
        completion_tokens: 20,
        total_tokens: 220,
        prompt_tokens_details: { cached_tokens: 150 },
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenAIProvider(baseParams);
    const resp = await provider.chat([makeMessage()]);

    expect(resp.usage).toMatchObject({
      inputTokens: 200,
      outputTokens: 20,
      totalTokens: 220,
      cacheReadTokens: 150,
      cacheWriteTokens: 0,
    });
    // Инвариант: nonCached + cacheRead + cacheWrite = input.
    const nonCached =
      resp.usage.inputTokens - (resp.usage.cacheReadTokens ?? 0) - (resp.usage.cacheWriteTokens ?? 0);
    expect(nonCached).toBe(50);
  });
});

describe('OpenAIProvider — reasoning (reasoning_content + reasoning)', () => {
  function sseResponse(events: string[]): Response {
    return new Response(events.map((e) => `data: ${e}\n\n`).join(''), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('chatAsync: delta.reasoning (RouterAI/OpenRouter) → растущий reasoning, финал непустой', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
      JSON.stringify({ choices: [{ index: 0, delta: { content: '', role: 'assistant', reasoning: '' } }] }),
      JSON.stringify({ choices: [{ index: 0, delta: { content: '', reasoning: 'Thinking' } }] }),
      JSON.stringify({ choices: [{ index: 0, delta: { content: '', reasoning: ' Process' } }] }),
      JSON.stringify({ choices: [{ index: 0, delta: { content: 'Answer' } }] }),
      JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
      '[DONE]',
    ])));

    const provider = new OpenAIProvider(baseParams);
    const chunks: LLMChunk[] = [];
    for await (const c of provider.chatAsync([makeMessage()])) chunks.push(c);

    // Пустой reasoning:'' не создаёт reasoning-чанк (первый чанк пропущен).
    const reasoningChunks = chunks.filter((c) => !c.isFinal && c.content === '');
    expect(reasoningChunks.map((c) => c.reasoning)).toEqual(['Thinking', 'Thinking Process']);

    const final = chunks.find((c) => c.isFinal)!;
    expect(final.reasoning).toBe('Thinking Process');
    expect(final.content).toBe('Answer');
  });

  it('chatAsync: delta.reasoning_content (DeepSeek) — регресс, фильтр . и .\\n работает', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
      JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: 'Step 1' } }] }),
      JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: '.' } }] }),
      JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: '.\n' } }] }),
      JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: 'Step 2' } }] }),
      JSON.stringify({ choices: [{ index: 0, delta: { content: 'Done' } }] }),
      JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
      '[DONE]',
    ])));

    const provider = new OpenAIProvider(baseParams);
    const chunks: LLMChunk[] = [];
    for await (const c of provider.chatAsync([makeMessage()])) chunks.push(c);

    const reasoningChunks = chunks.filter((c) => !c.isFinal && c.content === '');
    expect(reasoningChunks.map((c) => c.reasoning)).toEqual(['Step 1', 'Step 1Step 2']);

    const final = chunks.find((c) => c.isFinal)!;
    expect(final.reasoning).toBe('Step 1Step 2');
  });

  it('chatAsync: пустой reasoning:"" не создаёт reasoning-чанк', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
      JSON.stringify({ choices: [{ index: 0, delta: { content: '', reasoning: '' } }] }),
      JSON.stringify({ choices: [{ index: 0, delta: { content: 'hi' } }] }),
      JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
      '[DONE]',
    ])));

    const provider = new OpenAIProvider(baseParams);
    const chunks: LLMChunk[] = [];
    for await (const c of provider.chatAsync([makeMessage()])) chunks.push(c);

    expect(chunks.some((c) => c.reasoning !== undefined)).toBe(false);
    expect(chunks.find((c) => c.isFinal)!.reasoning).toBeUndefined();
  });

  it('chatAsync: приоритет reasoning_content над reasoning в одном delta', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
      JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: 'RC', reasoning: 'R' } }] }),
      JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
      '[DONE]',
    ])));

    const provider = new OpenAIProvider(baseParams);
    const chunks: LLMChunk[] = [];
    for await (const c of provider.chatAsync([makeMessage()])) chunks.push(c);

    expect(chunks.find((c) => c.isFinal)!.reasoning).toBe('RC');
  });

  it('chatAsync: точка в delta.reasoning (RouterAI) НЕ фильтруется (quirk только для reasoning_content)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
      JSON.stringify({ choices: [{ index: 0, delta: { reasoning: '.' } }] }),
      JSON.stringify({ choices: [{ index: 0, delta: { reasoning: ' next' } }] }),
      JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
      '[DONE]',
    ])));

    const provider = new OpenAIProvider(baseParams);
    const chunks: LLMChunk[] = [];
    for await (const c of provider.chatAsync([makeMessage()])) chunks.push(c);

    expect(chunks.find((c) => c.isFinal)!.reasoning).toBe('. next');
  });

  it('chat (non-stream): message.reasoning → response.reasoning', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: 'ok', reasoning: 'deep thought' } }],
      usage: {},
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));

    const provider = new OpenAIProvider(baseParams);
    const resp = await provider.chat([makeMessage()]);

    expect(resp.reasoning).toBe('deep thought');
    expect(resp.content).toBe('ok');
  });

  it('chat (non-stream): message.reasoning_content (DeepSeek) — регресс', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: 'ok', reasoning_content: 'step by step' } }],
      usage: {},
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));

    const provider = new OpenAIProvider(baseParams);
    const resp = await provider.chat([makeMessage()]);

    expect(resp.reasoning).toBe('step by step');
  });
});

describe('OpenAIProvider — форматирование tool_use/tool_result', () => {
  const provider = new OpenAIProvider(baseParams) as unknown as OpenAIPrivate;

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

  it('несколько tool_result подряд → отдельные tool-сообщения (OpenAI-формат)', () => {
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

  it('arguments-строка остаётся строкой (OpenAI требует string)', () => {
    const argsStr = '{"query":"x"}';
    const formatted = provider._formatMessages([
      makeMessage({
        role: 'assistant',
        content: '',
        toolUse: [{ id: 'call_s', type: 'function', function: { name: 'web_search', arguments: argsStr } }],
      }),
    ]);
    const fn = (formatted[0]!.tool_calls as Record<string, unknown>[])[0]!.function as Record<string, unknown>;
    expect(fn.arguments).toBe(argsStr);
  });
});

describe('OpenAIProvider — listModelsDetailed', () => {
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

  it('RouterAI-подобный ответ: context_length + pricing (строки) → окно и цены за 1M', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      data: [
        {
          id: 'openai/gpt-4o',
          name: 'GPT-4o',
          context_length: '128000',
          pricing: { prompt: '0.0000025', completion: '0.00001' },
        },
      ],
    })));

    const provider = new OpenAIProvider(baseParams);
    const models = await provider.listModelsDetailed();

    expect(models).toEqual([{
      id: 'openai/gpt-4o',
      name: 'GPT-4o',
      contextWindow: 128000,
      priceUnit: 'token',
      inputPrice: 2.5,
      outputPrice: 10,
    }]);
  });

  it('pricing_units: non-token тариф не попадает в цены', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      data: [{
        id: 'model-x',
        context_length: 8192,
        pricing: { prompt: '0.000001', completion: '0.000002', request: '0.02' },
        pricing_units: { prompt: 'token', completion: 'request', request: 'request' },
      }],
    })));

    const provider = new OpenAIProvider(baseParams);
    const models = await provider.listModelsDetailed();

    expect(models[0]).toEqual({
      id: 'model-x',
      contextWindow: 8192,
      priceUnit: 'token',
      inputPrice: 1,
    });
    expect(models[0]).not.toHaveProperty('outputPrice');
  });

  it('ответ без полей → только id', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ data: [{ id: 'plain-model' }] })));

    const provider = new OpenAIProvider(baseParams);
    const models = await provider.listModelsDetailed();

    expect(models).toEqual([{ id: 'plain-model' }]);
  });

  it('architecture: input_modalities и modality → модальности модели', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      data: [
        {
          id: 'deepseek/deepseek-v4.1-flash',
          architecture: { modality: 'text+image->text', input_modalities: ['text', 'image'] },
        },
        { id: 'legacy/vision', architecture: { modality: 'text+image+file->text' } },
        { id: 'text-only', architecture: { input_modalities: ['text'] } },
        { id: 'no-architecture' },
      ],
    })));

    const provider = new OpenAIProvider(baseParams);
    const models = await provider.listModelsDetailed();

    expect(models[0]).toMatchObject({ id: 'deepseek/deepseek-v4.1-flash', modalities: ['text', 'image'] });
    // `file` у OpenAI-совместимых каталогов — документы (pdf).
    expect(models[1]).toMatchObject({ modalities: ['text', 'image', 'pdf'] });
    expect(models[2]).toMatchObject({ modalities: ['text'] });
    // Ничего не распознано — поле не задаётся (действует справочник).
    expect(models[3]).not.toHaveProperty('modalities');
  });

  it('не падает при отсутствии data[]', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({})));

    const provider = new OpenAIProvider(baseParams);
    await expect(provider.listModelsDetailed()).resolves.toEqual([]);
  });

  it('сетевой сбой → []', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));

    const provider = new OpenAIProvider(baseParams);
    await expect(provider.listModelsDetailed()).resolves.toEqual([]);
  });

  it('сетевой сбой не оставляет активный таймер (try/finally)', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));

    const provider = new OpenAIProvider(baseParams);
    await expect(provider.listModelsDetailed()).resolves.toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('невалидный JSON не оставляет активный таймер (try/finally)', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not-json', { status: 200 })));

    const provider = new OpenAIProvider(baseParams);
    await expect(provider.listModelsDetailed()).resolves.toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('OpenAIProvider — вложения (ADR-115)', () => {
  type OpenAIPrivate = {
    _formatMessages(messages: LLMMessage[], systemPrompt?: string): Array<Record<string, unknown>>;
  };

  const imageAttachment = { mime: 'image/png', name: 'photo.png', base64: 'iVBORw0KGgo=' };
  const wavAttachment = { mime: 'audio/wav', base64: 'UklGRg==' };
  const mp3Attachment = { mime: 'audio/mpeg', base64: 'T2dnUw==' };
  const oggAttachment = { mime: 'audio/ogg', base64: 'T2dnUw==' };
  const pdfAttachment = { mime: 'application/pdf', base64: 'JVBERi0=' };
  const videoAttachment = { mime: 'video/mp4', base64: 'AAAAIGZ0eXA=' };
  const namedPdfAttachment = { mime: 'application/pdf', name: 'plan.pdf', base64: 'JVBERi0=' };

  function providerWithModel(model: string): OpenAIPrivate {
    return new OpenAIProvider({ ...baseParams, model }) as unknown as OpenAIPrivate;
  }

  function providerWithUrl(url: string): OpenAIPrivate {
    return new OpenAIProvider({ ...baseParams, url }) as unknown as OpenAIPrivate;
  }

  /** Провайдер с явной capability (ADR-117) — данные, а не host-проверка. */
  function providerWithCompatibility(compatibility: ModelCompatibility): OpenAIPrivate {
    return new OpenAIProvider({ ...baseParams, compatibility }) as unknown as OpenAIPrivate;
  }

  it('изображение у vision-модели → content массивом: text + image_url', () => {
    const formatted = providerWithModel('gpt-4o')._formatMessages([
      makeMessage({ role: 'user', content: 'что на фото?', attachments: [imageAttachment] }),
    ]);

    expect(formatted[0]!.content).toEqual([
      { type: 'text', text: 'что на фото?' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
    ]);
  });

  it('аудио wav у audio-модели → input_audio format=wav', () => {
    const formatted = providerWithModel('gpt-4o-audio-preview')._formatMessages([
      makeMessage({ role: 'user', content: 'расшифруй', attachments: [wavAttachment] }),
    ]);

    expect(formatted[0]!.content).toEqual([
      { type: 'text', text: 'расшифруй' },
      { type: 'input_audio', input_audio: { data: 'UklGRg==', format: 'wav' } },
    ]);
  });

  it('ogg у RouterAI → input_audio format=ogg (расширение; голос Telegram)', () => {
    const formatted = providerWithUrl('https://routerai.ru/api/v1/chat/completions')._formatMessages([
      makeMessage({ role: 'user', content: 'расшифруй', attachments: [oggAttachment] }),
    ]);

    expect(formatted[0]!.content).toEqual([
      { type: 'text', text: 'расшифруй' },
      { type: 'input_audio', input_audio: { data: 'T2dnUw==', format: 'ogg' } },
    ]);
  });

  it('ogg у обычного OpenAI-провайдера → аудио не отправляется', () => {
    const formatted = providerWithModel('gpt-4o-audio-preview')._formatMessages([
      makeMessage({ role: 'user', content: 'расшифруй', attachments: [oggAttachment] }),
    ]);

    expect(formatted[0]!.content).toBe('расшифруй');
  });

  it('явная capability nativeAudioFormats:[\'wav\'] → уходит только wav', () => {
    const formatted = providerWithCompatibility({ nativeAudioFormats: ['wav'] })._formatMessages([
      makeMessage({
        role: 'user',
        content: 'расшифруй',
        attachments: [wavAttachment, mp3Attachment, oggAttachment],
      }),
    ]);

    expect(formatted[0]!.content).toEqual([
      { type: 'text', text: 'расшифруй' },
      { type: 'input_audio', input_audio: { data: 'UklGRg==', format: 'wav' } },
    ]);
  });

  it('явный пустой список nativeAudioFormats → аудио не уходит ничего', () => {
    const formatted = providerWithCompatibility({ nativeAudioFormats: [] })._formatMessages([
      makeMessage({
        role: 'user',
        content: 'расшифруй',
        attachments: [wavAttachment, mp3Attachment, oggAttachment],
      }),
    ]);

    expect(formatted[0]!.content).toBe('расшифруй');
  });

  it('провайдер не фильтрует по справочнику: аудио кодируется и у модели без audio', () => {
    // Модальности отфильтрованы выше (гидратация по конфигу модели); второй
    // фильтр по справочнику отбрасывал валидные вложения — его больше нет.
    const formatted = providerWithModel('gpt-4o')._formatMessages([
      makeMessage({ role: 'user', content: 'текст', attachments: [wavAttachment] }),
    ]);

    expect(formatted[0]!.content).toEqual([
      { type: 'text', text: 'текст' },
      { type: 'input_audio', input_audio: { data: 'UklGRg==', format: 'wav' } },
    ]);
  });

  it('картинка у модели вне справочника → image_url (не отбрасывается)', () => {
    const formatted = providerWithModel('minimax/minimax-m3.1-flash')._formatMessages([
      makeMessage({ role: 'user', content: 'что на фото?', attachments: [imageAttachment] }),
    ]);

    expect(formatted[0]!.content).toEqual([
      { type: 'text', text: 'что на фото?' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
    ]);
  });

  it('видео у RouterAI → video_url (data-URL), модель видит/слышит ролик', () => {
    const formatted = providerWithUrl('https://routerai.ru/api/v1/chat/completions')._formatMessages([
      makeMessage({ role: 'user', content: 'что на видео?', attachments: [videoAttachment] }),
    ]);

    expect(formatted[0]!.content).toEqual([
      { type: 'text', text: 'что на видео?' },
      {
        type: 'video_url',
        video_url: { url: 'data:video/mp4;base64,AAAAIGZ0eXA=' },
      },
    ]);
  });

  it('видео у обычного OpenAI → не отправляется (нет video_url)', () => {
    const formatted = providerWithModel('gpt-4o')._formatMessages([
      makeMessage({ role: 'user', content: 'что на видео?', attachments: [videoAttachment] }),
    ]);

    expect(formatted[0]!.content).toBe('что на видео?');
  });

  it('явная capability supportsNativeVideo:true → блок video_url уходит (данные, не хост)', () => {
    const formatted = providerWithCompatibility({ supportsNativeVideo: true })._formatMessages([
      makeMessage({ role: 'user', content: 'что на видео?', attachments: [videoAttachment] }),
    ]);

    expect(formatted[0]!.content).toEqual([
      { type: 'text', text: 'что на видео?' },
      {
        type: 'video_url',
        video_url: { url: 'data:video/mp4;base64,AAAAIGZ0eXA=' },
      },
    ]);
  });

  it('явная capability supportsNativeVideo:false → video_url не уходит даже у RouterAI-хоста', () => {
    const disabled = new OpenAIProvider({
      ...baseParams,
      url: 'https://routerai.ru/api/v1/chat/completions',
      compatibility: { supportsNativeVideo: false },
    }) as unknown as OpenAIPrivate;
    const formatted = disabled._formatMessages([
      makeMessage({ role: 'user', content: 'что на видео?', attachments: [videoAttachment] }),
    ]);

    expect(formatted[0]!.content).toBe('что на видео?');
  });

  it('PDF → file-блок с data-URL (RouterAI принимает документ только так)', () => {
    const formatted = providerWithModel('gpt-4o')._formatMessages([
      makeMessage({ role: 'user', content: 'документ', attachments: [pdfAttachment] }),
    ]);

    expect(formatted[0]!.content).toEqual([
      { type: 'text', text: 'документ' },
      {
        type: 'file',
        file: { filename: 'document.pdf', file_data: 'data:application/pdf;base64,JVBERi0=' },
      },
    ]);
  });

  it('PDF с именем → filename берётся из вложения', () => {
    const formatted = providerWithModel('gpt-4o')._formatMessages([
      makeMessage({ role: 'user', content: 'план', attachments: [namedPdfAttachment] }),
    ]);

    expect(formatted[0]!.content).toEqual([
      { type: 'text', text: 'план' },
      {
        type: 'file',
        file: { filename: 'plan.pdf', file_data: 'data:application/pdf;base64,JVBERi0=' },
      },
    ]);
  });

  it('имя PDF санитайзится: кавычки и переводы строк убираются', () => {
    const formatted = providerWithModel('gpt-4o')._formatMessages([
      makeMessage({
        role: 'user',
        content: 'документ',
        attachments: [{ mime: 'application/pdf', name: 'pl"an\\\n.pdf', base64: 'JVBERi0=' }],
      }),
    ]);

    const part = (formatted[0]!.content as Array<Record<string, unknown>>)[1]!;
    expect((part.file as Record<string, unknown>).filename).toBe('plan.pdf');
  });

  it('имя PDF из одних запрещённых символов → document.pdf', () => {
    const formatted = providerWithModel('gpt-4o')._formatMessages([
      makeMessage({
        role: 'user',
        content: 'документ',
        attachments: [{ mime: 'application/pdf', name: '"\\\r\n', base64: 'JVBERi0=' }],
      }),
    ]);

    const part = (formatted[0]!.content as Array<Record<string, unknown>>)[1]!;
    expect((part.file as Record<string, unknown>).filename).toBe('document.pdf');
  });

  it('текстовое сообщение без вложений остаётся строкой', () => {
    const formatted = providerWithModel('gpt-4o')._formatMessages([
      makeMessage({ role: 'user', content: 'просто текст' }),
    ]);

    expect(formatted[0]!.content).toBe('просто текст');
  });
});

describe('OpenAIProvider — tool_choice на шаге (лимит шагов)', () => {
  function sseResponse(): Response {
    // `finish_reason` обязателен: без него стрим считается недописанным
    // (`compatibility.requireFinishReason`, ADR-117).
    const finish = JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    return new Response(`data: ${finish}\n\ndata: [DONE]\n\n`, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  }

  function makeTools(): Record<string, unknown>[] {
    return [
      { type: 'function', function: { name: 'read_file', description: '', parameters: {} } },
    ];
  }

  /** Прокрутить стрим до конца (тело чанков здесь не проверяется). */
  async function drain(gen: AsyncGenerator<LLMChunk>): Promise<LLMChunk[]> {
    const chunks: LLMChunk[] = [];
    for await (const chunk of gen) chunks.push(chunk);
    return chunks;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("chatAsync: options.toolChoice='none' + tools → tool_choice: 'none' в теле, tools остаются", async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse());
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenAIProvider(baseParams);
    const tools = makeTools();
    await drain(provider.chatAsync([makeMessage()], undefined, tools, undefined, undefined, {
      toolChoice: 'none',
    }));

    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
    expect(body.tool_choice).toBe('none');
    // Инструменты остаются в запросе — кэшированный префикс провайдера сохраняется.
    expect(body.tools).toEqual(tools);
  });

  it('chatAsync: без опции поля tool_choice нет (обратная совместимость)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse());
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenAIProvider(baseParams);
    await drain(provider.chatAsync([makeMessage()], undefined, makeTools()));

    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
    expect(body.tool_choice).toBeUndefined();
    expect(body.tools).toBeDefined();
  });

  it('chatAsync: без tools tool_choice не отправляется даже при заданной опции', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse());
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenAIProvider(baseParams);
    await drain(provider.chatAsync([makeMessage()], undefined, undefined, undefined, undefined, {
      toolChoice: 'none',
    }));

    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
    expect(body.tool_choice).toBeUndefined();
    expect(body.tools).toBeUndefined();
  });
});

describe('OpenAIProvider — compatibility (слой opencode)', () => {
  type OpenAIPrivate = {
    _formatMessages(messages: LLMMessage[], systemPrompt?: string): Array<Record<string, unknown>>;
  };

  function sseResponse(events: string[]): Response {
    return new Response(events.map((e) => `data: ${e}\n\n`).join(''), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  }

  async function drain(gen: AsyncIterable<LLMChunk>): Promise<LLMChunk[]> {
    const out: LLMChunk[] = [];
    for await (const chunk of gen) out.push(chunk);
    return out;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reasoningField: reasoning / reasoning_text / кастом; по умолчанию reasoning_content', () => {
    for (const field of ['reasoning', 'reasoning_text', 'custom_reasoning']) {
      const provider = new OpenAIProvider({
        ...plainParams,
        compatibility: { reasoningField: field },
      }) as unknown as OpenAIPrivate;
      const formatted = provider._formatMessages([makeMessage({ role: 'assistant', reasoning: 'думал' })]);
      expect(formatted[0]![field]).toBe('думал');
      expect(formatted[0]!.reasoning_content).toBeUndefined();
    }
    const defaultProvider = new OpenAIProvider(plainParams) as unknown as OpenAIPrivate;
    expect(
      defaultProvider._formatMessages([makeMessage({ role: 'assistant', reasoning: 'думал' })])[0]!.reasoning_content,
    ).toBe('думал');
  });

  it('requireReasoning: явный true у недефолтного провайдера', () => {
    const provider = new OpenAIProvider({
      ...plainParams,
      compatibility: { requireReasoning: true },
    }) as unknown as OpenAIPrivate;
    expect(provider._formatMessages([makeMessage({ role: 'assistant' })])[0]!.reasoning_content).toBe('');
  });

  it('requireReasoning=false сильнее deepseek-эвристики и в форме compatibility', () => {
    const provider = new OpenAIProvider({
      ...baseParams,
      compatibility: { requireReasoning: false },
    }) as unknown as OpenAIPrivate;
    expect(provider._formatMessages([makeMessage({ role: 'assistant' })])[0]!.reasoning_content).toBeUndefined();
  });

  it('maxTokensField: дефолт max_tokens, max_completion_tokens только явно', async () => {
    const fetchDefault = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: 'ok' } }], usage: {},
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchDefault);
    const defaultProvider = new OpenAIProvider({ ...plainParams, maxTokens: 100 });
    await defaultProvider.chat([makeMessage()]);
    const defaultBody = JSON.parse(fetchDefault.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
    expect(defaultBody.max_tokens).toBe(100);
    expect(defaultBody.max_completion_tokens).toBeUndefined();

    vi.unstubAllGlobals();
    const fetchCompat = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: 'ok' } }], usage: {},
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchCompat);
    const compatProvider = new OpenAIProvider({
      ...plainParams,
      maxTokens: 100,
      compatibility: { maxTokensField: 'max_completion_tokens' },
    });
    await compatProvider.chat([makeMessage()]);
    const compatBody = JSON.parse(fetchCompat.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
    expect(compatBody.max_completion_tokens).toBe(100);
    expect(compatBody.max_tokens).toBeUndefined();
  });

  it('requireAssistantAfterTool: вставка «Done.» перед user после tool-результата, пары не рвутся', () => {
    const provider = new OpenAIProvider({
      ...plainParams,
      compatibility: { requireAssistantAfterTool: true },
    }) as unknown as OpenAIPrivate;
    const formatted = provider._formatMessages([
      makeMessage({
        role: 'assistant',
        toolUse: [{ id: 'call_1', type: 'function', function: { name: 'noop', arguments: '{}' } }],
      }),
      makeMessage({ role: 'tool', toolCallId: 'call_1', content: 'result' }),
      makeMessage({ role: 'user', content: 'next' }),
    ]);
    expect(formatted.map((m) => m.role)).toEqual(['assistant', 'tool', 'assistant', 'user']);
    expect(formatted[1]!.tool_call_id).toBe('call_1');
    expect(formatted[2]).toEqual({ role: 'assistant', content: 'Done.' });
    expect(formatted[3]!.content).toBe('next');
  });

  it('requireAssistantAfterTool: история на tool-результате замыкается assistant-турном', () => {
    const provider = new OpenAIProvider({
      ...plainParams,
      compatibility: { requireAssistantAfterTool: true },
    }) as unknown as OpenAIPrivate;
    const formatted = provider._formatMessages([
      makeMessage({
        role: 'assistant',
        toolUse: [{ id: 'call_1', type: 'function', function: { name: 'noop', arguments: '{}' } }],
      }),
      makeMessage({ role: 'tool', toolCallId: 'call_1', content: 'result' }),
    ]);
    expect(formatted.at(-1)).toEqual({ role: 'assistant', content: 'Done.' });
  });

  it('requireAssistantAfterTool: mistral-эвристика включает вставку без явного compatibility', () => {
    const provider = new OpenAIProvider({
      ...plainParams,
      model: 'mistral-large-latest',
    }) as unknown as OpenAIPrivate;
    const formatted = provider._formatMessages([
      makeMessage({ role: 'tool', toolCallId: 'call_1', content: 'result' }),
      makeMessage({ role: 'user', content: 'next' }),
    ]);
    expect(formatted.map((m) => m.role)).toEqual(['tool', 'assistant', 'user']);

    const nonMistral = new OpenAIProvider(plainParams) as unknown as OpenAIPrivate;
    expect(nonMistral._formatMessages([
      makeMessage({ role: 'tool', toolCallId: 'call_1', content: 'result' }),
      makeMessage({ role: 'user', content: 'next' }),
    ]).map((m) => m.role)).toEqual(['tool', 'user']);
  });

  it('streamUsage: по умолчанию include_usage; false — без stream_options, usage всё равно парсится', async () => {
    const events = [
      JSON.stringify({ choices: [{ index: 0, delta: { content: 'ok' } }] }),
      JSON.stringify({
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      }),
      '[DONE]',
    ];
    const fetchDefault = vi.fn().mockResolvedValue(sseResponse(events));
    vi.stubGlobal('fetch', fetchDefault);
    const defaultProvider = new OpenAIProvider(plainParams);
    await drain(defaultProvider.chatAsync([makeMessage()]));
    const defaultBody = JSON.parse(fetchDefault.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
    expect(defaultBody.stream_options).toEqual({ include_usage: true });

    vi.unstubAllGlobals();
    const fetchDisabled = vi.fn().mockResolvedValue(sseResponse(events));
    vi.stubGlobal('fetch', fetchDisabled);
    const disabledProvider = new OpenAIProvider({
      ...plainParams,
      compatibility: { streamUsage: false },
    });
    const chunks = await drain(disabledProvider.chatAsync([makeMessage()]));
    const disabledBody = JSON.parse(fetchDisabled.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
    expect(disabledBody.stream_options).toBeUndefined();
    // Без stream_options usage приходит в финальном чанке (эндпоинт прислал) — парсинг не сломан.
    expect(chunks.find((c) => c.isFinal)!.usage!.totalTokens).toBe(7);
  });
});

describe('OpenAIProvider — cacheFormat: inline-маркеры cache_control (ADR-117)', () => {
  type OpenAIPrivate = {
    _formatMessages(messages: LLMMessage[], systemPrompt?: string): Array<Record<string, unknown>>;
    _applyPromptCacheKey(
      body: Record<string, unknown>,
      systemPrompt?: SystemPromptPayload,
      compatibility?: Record<string, unknown>,
    ): void;
    _applyInlineCacheMarkers(
      body: Record<string, unknown>,
      systemPrompt?: SystemPromptPayload,
      compatibility?: Record<string, unknown>,
    ): void;
  };

  function okResponse(): Response {
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: {} }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  function makeTools(count = 2): Record<string, unknown>[] {
    return Array.from({ length: count }, (_, i) => ({
      type: 'function',
      function: { name: `tool_${i}`, description: '', parameters: {} },
    }));
  }

  const chatMessages: LLMMessage[] = [
    makeMessage({ role: 'user', content: 'привет' }),
    makeMessage({ role: 'assistant', content: 'здравствуй' }),
    makeMessage({ role: 'user', content: 'ещё вопрос' }),
  ];

  /** Сколько `cache_control`-маркеров в теле (tools + части контента). */
  function countMarkers(body: Record<string, unknown>): number {
    let count = 0;
    const tools = body.tools as Array<Record<string, unknown>> | undefined;
    for (const tool of tools ?? []) if (tool.cache_control !== undefined) count += 1;
    for (const message of body.messages as Array<Record<string, unknown>>) {
      const content = message.content;
      if (!Array.isArray(content)) continue;
      for (const part of content as Array<Record<string, unknown>>) {
        if (part.cache_control !== undefined) count += 1;
      }
    }
    return count;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function sendChat(
    compatibility: Record<string, unknown> | undefined,
    payload: SystemPromptPayload | undefined = { text: 'sys', cacheKey: 'sess-1', cachePolicy: 'auto' },
  ): Promise<Record<string, unknown>> {
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OpenAIProvider({
      ...plainParams,
      ...(compatibility ? { compatibility: compatibility as never } : {}),
    });
    await provider.chat(chatMessages, payload, makeTools());
    return JSON.parse(fetchMock.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
  }

  it('anthropic: маркеры на последнем tool, system и границе последнего сообщения; prompt_cache_key нет', async () => {
    const body = await sendChat({ cacheFormat: 'anthropic' });
    const tools = body.tools as Array<Record<string, unknown>>;
    const messages = body.messages as Array<Record<string, unknown>>;

    // tools: маркер ровно на последнем дефинишне (AUTO-набор).
    expect(tools[0]!.cache_control).toBeUndefined();
    expect(tools[tools.length - 1]!.cache_control).toEqual({ type: 'ephemeral' });

    // system: контент — массив частей с маркером (как в opencode AUTO).
    const system = messages[0]!;
    expect(system.role).toBe('system');
    expect((system.content as Array<Record<string, unknown>>)[0]).toEqual({
      type: 'text',
      text: 'sys',
      cache_control: { type: 'ephemeral' },
    });

    // граница последнего сообщения (tail: 1) — строковый контент развёрнут в часть.
    const last = messages[messages.length - 1]!;
    expect(last.role).toBe('user');
    expect(last.content).toEqual([
      { type: 'text', text: 'ещё вопрос', cache_control: { type: 'ephemeral' } },
    ]);

    // Механизмы не смешиваются: inline-маркеры вместо ключа.
    expect(body.prompt_cache_key).toBeUndefined();
    expect(countMarkers(body)).toBe(3);
    expect(countMarkers(body)).toBeLessThanOrEqual(4);
  });

  it('alibaba: system + граница последнего сообщения, маркера на tools нет; prompt_cache_key нет', async () => {
    const body = await sendChat({ cacheFormat: 'alibaba' });
    const tools = body.tools as Array<Record<string, unknown>>;
    const messages = body.messages as Array<Record<string, unknown>>;

    for (const tool of tools) expect(tool.cache_control).toBeUndefined();
    expect((messages[0]!.content as Array<Record<string, unknown>>)[0]!.cache_control).toEqual({
      type: 'ephemeral',
    });
    expect(messages[messages.length - 1]!.content).toEqual([
      { type: 'text', text: 'ещё вопрос', cache_control: { type: 'ephemeral' } },
    ]);
    expect(body.prompt_cache_key).toBeUndefined();
    expect(countMarkers(body)).toBe(2);
  });

  it('без cacheFormat: прежнее поведение — только prompt_cache_key, маркеров нет', async () => {
    const body = await sendChat(undefined);
    expect(body.prompt_cache_key).toBe('sess-1');
    expect(countMarkers(body)).toBe(0);
    // system-контент остаётся прежним (без cache_control).
    expect((body.messages as Array<Record<string, unknown>>)[0]!.content).toEqual([
      { type: 'text', text: 'sys' },
    ]);
  });

  it('cachePolicy none + cacheFormat: ни маркеров, ни prompt_cache_key', async () => {
    const body = await sendChat({ cacheFormat: 'anthropic' }, { text: 'sys', cacheKey: 'sess-1', cachePolicy: 'none' });
    expect(countMarkers(body)).toBe(0);
    expect(body.prompt_cache_key).toBeUndefined();
  });

  it('уже стоящие маркеры не дублируются и учитываются в бюджете (≤4)', async () => {
    const provider = new OpenAIProvider({
      ...plainParams,
      compatibility: { cacheFormat: 'anthropic' } as never,
    }) as unknown as OpenAIPrivate;
    const tools = makeTools();
    tools[tools.length - 1]!.cache_control = { type: 'ephemeral' };
    const body: Record<string, unknown> = {
      tools,
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }] },
        { role: 'user', content: [{ type: 'text', text: 'q', cache_control: { type: 'ephemeral' } }] },
        // Ещё один маркер — бюджет (4) исчерпан до запуска политики.
        { role: 'assistant', content: [{ type: 'text', text: 'a', cache_control: { type: 'ephemeral' } }] },
      ],
    };
    provider._applyInlineCacheMarkers(body, undefined, { cacheFormat: 'anthropic' });
    expect(countMarkers(body)).toBe(4);
    // Дубликатов нет: инструменты и system сохранили по одному маркеру.
    expect(tools[tools.length - 1]!.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('бюджет считает system из двух частей: последний блок тоже маркируется, лимит не превышен', () => {
    const provider = new OpenAIProvider({
      ...plainParams,
      compatibility: { cacheFormat: 'anthropic' } as never,
    }) as unknown as OpenAIPrivate;
    const body: Record<string, unknown> = {
      tools: makeTools(),
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'stable' }, { type: 'text', text: 'rest' }] },
        { role: 'user', content: 'q' },
      ],
    };
    provider._applyInlineCacheMarkers(body, undefined, { cacheFormat: 'anthropic' });
    const systemParts = (body.messages as Array<Record<string, unknown>>)[0]!.content as Array<Record<string, unknown>>;
    expect(systemParts[0]!.cache_control).toEqual({ type: 'ephemeral' });
    expect(systemParts[1]!.cache_control).toEqual({ type: 'ephemeral' });
    expect(countMarkers(body)).toBe(4);
  });

  it('пустой system не ломает политику: маркер только на tools и последнем сообщении', () => {
    const provider = new OpenAIProvider({
      ...plainParams,
      compatibility: { cacheFormat: 'anthropic' } as never,
    }) as unknown as OpenAIPrivate;
    const body: Record<string, unknown> = {
      tools: makeTools(),
      messages: [{ role: 'user', content: 'q' }],
    };
    provider._applyInlineCacheMarkers(body, undefined, { cacheFormat: 'anthropic' });
    expect(countMarkers(body)).toBe(2);
  });

  it('последнее сообщение без текста (tool-result) — маркер на последней части', () => {
    const provider = new OpenAIProvider({
      ...plainParams,
      compatibility: { cacheFormat: 'anthropic' } as never,
    }) as unknown as OpenAIPrivate;
    const body: Record<string, unknown> = {
      messages: [
        {
          role: 'tool',
          content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }],
        },
      ],
    };
    provider._applyInlineCacheMarkers(body, undefined, { cacheFormat: 'anthropic' });
    const parts = (body.messages as Array<Record<string, unknown>>)[0]!.content as Array<Record<string, unknown>>;
    expect(parts[0]!.cache_control).toEqual({ type: 'ephemeral' });
  });
});

describe('OpenAIProvider — requireFinishReason (ADR-117)', () => {
  function sseResponse(events: string[]): Response {
    return new Response(events.map((e) => `data: ${e}\n\n`).join(''), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  }

  const contentChunk = JSON.stringify({ choices: [{ index: 0, delta: { content: 'ok' } }] });
  const finishChunk = JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });

  async function drain(gen: AsyncIterable<LLMChunk>): Promise<LLMChunk[]> {
    const out: LLMChunk[] = [];
    for await (const chunk of gen) out.push(chunk);
    return out;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('стрим без finish_reason по умолчанию → ошибка (incomplete-stream)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([contentChunk, '[DONE]'])));
    const provider = new OpenAIProvider(plainParams);
    await expect(drain(provider.chatAsync([makeMessage()]))).rejects.toThrow(/finish_reason/);
  });

  it('requireFinishReason: false → прежнее толерантное поведение (успех)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([contentChunk, '[DONE]'])));
    const provider = new OpenAIProvider({
      ...plainParams,
      compatibility: { requireFinishReason: false },
    });
    const chunks = await drain(provider.chatAsync([makeMessage()]));
    const final = chunks.find((c) => c.isFinal)!;
    expect(final.content).toBe('ok');
  });

  it('стрим с finish_reason → успех (дефолт)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([contentChunk, finishChunk, '[DONE]'])));
    const provider = new OpenAIProvider(plainParams);
    const chunks = await drain(provider.chatAsync([makeMessage()]));
    expect(chunks.find((c) => c.isFinal)!.content).toBe('ok');
  });

  it('finish_reason: null не считается завершением', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
      contentChunk,
      JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: null }] }),
      '[DONE]',
    ])));
    const provider = new OpenAIProvider(plainParams);
    await expect(drain(provider.chatAsync([makeMessage()]))).rejects.toThrow(/finish_reason/);
  });

  it('ошибка невосстановимая для ретрай-цикла (не путается с transport-ошибками)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([contentChunk, '[DONE]'])));
    const provider = new OpenAIProvider(plainParams);
    const { isLlmErrorRecoverable } = await import('../engine/llm-error.js');
    let caught: unknown;
    try {
      await drain(provider.chatAsync([makeMessage()]));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(isLlmErrorRecoverable(caught)).toBe(false);
  });

  it('пользовательская отмена не превращается в ошибку finish_reason', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([contentChunk])));
    const provider = new OpenAIProvider(plainParams);
    const token = { cancelled: true, cancel: () => {} };
    const chunks = await drain(provider.chatAsync([makeMessage()], undefined, undefined, undefined, token));
    expect(chunks).toEqual([]);
  });
});

/**
 * Причина завершения ответа (`finish_reason`) и reasoning-токены.
 *
 * `length` — ответ срезан лимитом вывода: при пустом `content` это не «модель
 * промолчала», а исчерпанный бюджет (reasoning-модели тратят его на thinking).
 */
describe('OpenAIProvider — finish_reason и reasoning_tokens', () => {
  function sseResponse(events: string[]): Response {
    return new Response(events.map((e) => `data: ${e}\n\n`).join(''), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  }

  async function drain(gen: AsyncIterable<LLMChunk>): Promise<LLMChunk[]> {
    const out: LLMChunk[] = [];
    for await (const chunk of gen) out.push(chunk);
    return out;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ['stop', 'end_turn'],
    ['length', 'max_tokens'],
    ['tool_calls', 'tool_use'],
    ['function_call', 'tool_use'],
    ['content_filter', 'content_filter'],
    ['some_new_reason', 'unknown'],
  ])('stream: finish_reason %s → finishReason %s', async (raw, expected) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
      JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: raw }] }),
      '[DONE]',
    ])));

    const chunks = await drain(new OpenAIProvider(plainParams).chatAsync([makeMessage()]));
    expect(chunks.find((c) => c.isFinal)!.finishReason).toBe(expected);
  });

  it('stream: length + пустой контент + reasoning_tokens → срез лимитом виден в usage', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
      JSON.stringify({
        choices: [{ index: 0, delta: {}, finish_reason: 'length' }],
        usage: {
          prompt_tokens: 20,
          completion_tokens: 4096,
          total_tokens: 4116,
          completion_tokens_details: { reasoning_tokens: 4000 },
        },
      }),
      '[DONE]',
    ])));

    const final = (await drain(new OpenAIProvider(plainParams).chatAsync([makeMessage()])))
      .find((c) => c.isFinal)!;
    expect(final.content).toBe('');
    expect(final.finishReason).toBe('max_tokens');
    expect(final.usage).toMatchObject({ outputTokens: 4096, reasoningTokens: 4000 });
  });

  it('non-stream: finish_reason → finishReason, reasoning_tokens → reasoningTokens', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ index: 0, message: { content: '' }, finish_reason: 'length' }],
      usage: {
        prompt_tokens: 20,
        completion_tokens: 100,
        total_tokens: 120,
        completion_tokens_details: { reasoning_tokens: 90 },
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));

    const resp = await new OpenAIProvider(plainParams).chat([makeMessage()]);
    expect(resp.finishReason).toBe('max_tokens');
    expect(resp.usage).toMatchObject({ outputTokens: 100, reasoningTokens: 90 });
  });
});

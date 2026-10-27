import { describe, it, expect, vi, afterEach } from 'vitest';
import { OpenAIProvider } from './openai.js';
import type { LLMMessage, SystemPromptPayload } from './base.js';
import type { LLMChunk } from '@itphx/synth-shared';

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

    const provider = new OpenAIProvider(baseParams);
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
  const oggAttachment = { mime: 'audio/ogg', base64: 'T2dnUw==' };
  const pdfAttachment = { mime: 'application/pdf', base64: 'JVBERi0=' };
  const namedPdfAttachment = { mime: 'application/pdf', name: 'plan.pdf', base64: 'JVBERi0=' };

  function providerWithModel(model: string): OpenAIPrivate {
    return new OpenAIProvider({ ...baseParams, model }) as unknown as OpenAIPrivate;
  }

  function providerWithUrl(url: string): OpenAIPrivate {
    return new OpenAIProvider({ ...baseParams, url }) as unknown as OpenAIPrivate;
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

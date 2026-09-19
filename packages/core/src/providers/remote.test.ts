import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RemoteProvider, setRemoteTokenProvider, clearRemoteTokenProviders } from './remote.js';
import { ProviderFactory } from './index.js';
import { ProviderError, ContextLengthExceededError, RateLimitError } from './exceptions.js';
import type { LLMMessage, CancellationToken, SystemPromptPayload } from './base.js';
import type { LLMChunk } from '@itphx/synth-shared';

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

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeProvider(overrides: Partial<ConstructorParameters<typeof RemoteProvider>[0]> = {}): RemoteProvider {
  return new RemoteProvider({
    url: 'https://backend.test',
    apiKey: '',
    model: 'remote-model',
    getToken: async () => 'tok',
    timeout: 30,
    ...overrides,
  });
}

beforeEach(() => {
  clearRemoteTokenProviders();
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearRemoteTokenProviders();
});

describe('RemoteProvider.chat (non-stream)', () => {
  it('успех: OpenAI-формат → LLMResponse (content + usage + model)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      id: 'chatcmpl-1',
      object: 'chat.completion',
      created: 1,
      model: 'remote-model',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Привет!' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = makeProvider();
    const resp = await provider.chat([makeMessage()], 'system');

    expect(resp.content).toBe('Привет!');
    expect(resp.model).toBe('remote-model');
    expect(resp.usage.inputTokens).toBe(10);
    expect(resp.usage.outputTokens).toBe(5);
    expect(resp.usage.totalTokens).toBe(15);

    // Проверка запроса: URL, Bearer-токен, OpenAI-тело.
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('https://backend.test/api/v2/llm/chat/completions');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok');
    expect(headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.model).toBe('remote-model');
    expect(body.messages).toEqual([
      { role: 'system', content: 'system' },
      { role: 'user', content: 'hi' },
    ]);
    expect(body.stream).toBeUndefined();
  });

  it('успех: url с trailing /api/v2 не дублирует путь', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: {},
    }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = makeProvider({ url: 'https://backend.test/api/v2/' });
    await provider.chat([makeMessage()]);
    expect(String(fetchMock.mock.calls[0]![0])).toBe('https://backend.test/api/v2/llm/chat/completions');
  });

  it('429 RATE_LIMITED → RateLimitError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(
      { error: { code: 'RATE_LIMITED', message: 'Слишком много запросов' } }, 429,
    )));
    const provider = makeProvider();
    await expect(provider.chat([makeMessage()])).rejects.toBeInstanceOf(RateLimitError);
  });

  it('404 MODEL_NOT_FOUND → ProviderError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(
      { error: { code: 'MODEL_NOT_FOUND', message: 'Модель не найдена: x' } }, 404,
    )));
    const provider = makeProvider();
    await expect(provider.chat([makeMessage()])).rejects.toBeInstanceOf(ProviderError);
  });

  it('400 CONTEXT_LENGTH_EXCEEDED → ContextLengthExceededError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(
      { error: { code: 'CONTEXT_LENGTH_EXCEEDED', message: 'контекст слишком длинный' } }, 400,
    )));
    const provider = makeProvider();
    await expect(provider.chat([makeMessage()])).rejects.toBeInstanceOf(ContextLengthExceededError);
  });

  it('401 UNAUTHORIZED → ProviderError с понятным сообщением', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(
      { error: { code: 'UNAUTHORIZED', message: 'Не авторизован' } }, 401,
    )));
    const provider = makeProvider();
    await expect(provider.chat([makeMessage()])).rejects.toMatchObject({
      name: 'ProviderError',
      message: expect.stringContaining('Не авторизован'),
    });
  });

  it('502 без кода → ProviderError с message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(
      { error: { code: 'PROVIDER_ERROR', message: 'upstream упал' } }, 502,
    )));
    const provider = makeProvider();
    await expect(provider.chat([makeMessage()])).rejects.toMatchObject({
      name: 'ProviderError',
      message: expect.stringContaining('upstream упал'),
    });
  });

  it('отсутствие токена → ProviderError, fetch не вызывается', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const provider = makeProvider({ getToken: async () => null, apiKey: '' });
    await expect(provider.chat([makeMessage()])).rejects.toMatchObject({
      name: 'ProviderError',
      message: expect.stringContaining('Нет токена'),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('нет getToken и apiKey пустой (нет реестра) → ProviderError', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const provider = makeProvider({ getToken: undefined, apiKey: '' });
    await expect(provider.chat([makeMessage()])).rejects.toBeInstanceOf(ProviderError);
  });
});

describe('RemoteProvider: явный provider в теле (зеркала серверных провайдеров)', () => {
  function okResponse(): Response {
    return jsonResponse({
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: {},
    });
  }

  it('provider из опций уходит в тело запроса LLM Proxy', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', fetchMock);

    const provider = makeProvider({ name: 'local-alias', provider: 'itphx' });
    await provider.chat([makeMessage()]);

    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
    expect(body.provider).toBe('itphx');
  });

  it('provider не задан, но задан name — в тело уходит name (зеркала называются серверными именами)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', fetchMock);

    const provider = makeProvider({ name: 'itphx' });
    await provider.chat([makeMessage()]);

    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
    expect(body.provider).toBe('itphx');
  });

  it('без name и без provider тело не содержит provider (обратная совместимость)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', fetchMock);

    const provider = makeProvider({ name: undefined });
    await provider.chat([makeMessage()]);

    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
    expect(body.provider).toBeUndefined();
  });
});

describe('RemoteProvider.chatAsync (SSE-стрим)', () => {
  function sseResponse(events: string[]): Response {
    return new Response(events.map((e) => `data: ${e}\n\n`).join(''), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  }

  it('успех: SSE-чанки → LLMChunk + финальный чанк с usage', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse([
      JSON.stringify({ id: '1', object: 'chat.completion.chunk', model: 'remote-model', choices: [{ index: 0, delta: { content: 'При' }, finish_reason: null }] }),
      JSON.stringify({ id: '1', object: 'chat.completion.chunk', model: 'remote-model', choices: [{ index: 0, delta: { content: 'вет' }, finish_reason: null }] }),
      JSON.stringify({ id: '1', object: 'chat.completion.chunk', model: 'remote-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }),
      '[DONE]',
    ]));
    vi.stubGlobal('fetch', fetchMock);

    const provider = makeProvider();
    const chunks: LLMChunk[] = [];
    for await (const chunk of provider.chatAsync([makeMessage()])) {
      chunks.push(chunk);
    }

    expect(chunks.map((c) => c.content)).toEqual(['При', 'вет', 'Привет']);
    expect(chunks[2]!.isFinal).toBe(true);
    expect(chunks[2]!.usage?.totalTokens).toBe(15);
    expect(chunks[2]!.model).toBe('remote-model');

    const [url, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.stream).toBe(true);
    expect(String(url)).toBe('https://backend.test/api/v2/llm/chat/completions');
  });

  it('отмена (cancellationToken) — генератор завершается без финального чанка', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
      JSON.stringify({ choices: [{ index: 0, delta: { content: 'ча' } }] }),
      '[DONE]',
    ])));

    const provider = makeProvider();
    const token: CancellationToken = { cancelled: false, cancel: () => { token.cancelled = true; } };
    const chunks: LLMChunk[] = [];
    for await (const chunk of provider.chatAsync([makeMessage()], undefined, undefined, undefined, token)) {
      chunks.push(chunk);
      if (chunk.content) token.cancel();
    }
    // После cancel стрим прерывается: финального чанка (isFinal) нет.
    expect(chunks.some((c) => c.isFinal)).toBe(false);
  });

  it('ошибка в середине стрима ({error}) → RateLimitError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
      JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'слишком много' } }),
      '[DONE]',
    ])));
    const provider = makeProvider();

    const collect = async () => {
      const out: LLMChunk[] = [];
      for await (const c of provider.chatAsync([makeMessage()])) out.push(c);
      return out;
    };
    await expect(collect()).rejects.toBeInstanceOf(RateLimitError);
  });

  it('HTTP-ошибка до начала стрима → mapError (429)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(
      { error: { code: 'RATE_LIMITED', message: 'limit' } }, 429,
    )));
    const provider = makeProvider();
    const collect = async () => {
      const out: LLMChunk[] = [];
      for await (const c of provider.chatAsync([makeMessage()])) out.push(c);
      return out;
    };
    await expect(collect()).rejects.toBeInstanceOf(RateLimitError);
  });
});

describe('RemoteProvider: регистрация и токен-реестр', () => {
  it('ProviderFactory.create создаёт RemoteProvider для remote и synth-server', () => {
    const p = ProviderFactory.create('synth-remote', {
      type: 'remote', url: 'https://b.test', apiKey: '', model: 'm',
    });
    expect(p).toBeInstanceOf(RemoteProvider);
    expect(p.getProviderName()).toBe('synth-remote');

    const alias = ProviderFactory.create('alias', {
      type: 'synth-server', url: 'https://b.test', apiKey: '', model: 'm',
    });
    expect(alias).toBeInstanceOf(RemoteProvider);
  });

  it('getToken из реестра (путь ProviderFactory): Bearer из setRemoteTokenProvider', async () => {
    setRemoteTokenProvider('synth-remote', async () => 'registry-tok');
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: {},
    }));
    vi.stubGlobal('fetch', fetchMock);

    // Конструктор без getToken и без apiKey — токен берётся из реестра по name.
    const provider = new RemoteProvider({ url: 'https://backend.test', apiKey: '', model: 'm', name: 'synth-remote' });
    await provider.chat([makeMessage()]);

    const [, init] = fetchMock.mock.calls[0]!;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer registry-tok');
  });
});

describe('RemoteProvider — prompt_cache_key (AD-070 §2.2)', () => {
  function okResponse(): Response {
    return jsonResponse({
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: {},
    });
  }

  it('auto + cacheKey → prompt_cache_key и system из payload.text', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', fetchMock);

    const provider = makeProvider();
    const payload: SystemPromptPayload = { text: 'sys', cacheKey: 'sess-1', cachePolicy: 'auto' };
    await provider.chat([makeMessage()], payload);

    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
    expect(body.prompt_cache_key).toBe('sess-1');
    expect(body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ]);
  });

  it('cachePolicy none → prompt_cache_key отсутствует', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', fetchMock);

    const provider = makeProvider();
    const payload: SystemPromptPayload = { text: 'sys', cacheKey: 'sess-1', cachePolicy: 'none' };
    await provider.chat([makeMessage()], payload);

    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
    expect(body.prompt_cache_key).toBeUndefined();
  });
});

describe('RemoteProvider — usage (AD-070 §2.3)', () => {
  function sseResponse(events: string[]): Response {
    return new Response(events.map((e) => `data: ${e}\n\n`).join(''), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  }

  it('non-stream: prompt_tokens_details.cached_tokens → cacheReadTokens', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 5,
        total_tokens: 105,
        prompt_tokens_details: { cached_tokens: 64 },
      },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = makeProvider();
    const resp = await provider.chat([makeMessage()]);

    expect(resp.usage).toMatchObject({
      inputTokens: 100,
      outputTokens: 5,
      totalTokens: 105,
      cacheReadTokens: 64,
      cacheWriteTokens: 0,
    });
  });

  it('stream: cached_tokens в финальном чанке → cacheReadTokens', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse([
      JSON.stringify({ choices: [{ index: 0, delta: { content: 'ok' } }] }),
      JSON.stringify({
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 80,
          completion_tokens: 4,
          total_tokens: 84,
          prompt_tokens_details: { cached_tokens: 32 },
        },
      }),
      '[DONE]',
    ]));
    vi.stubGlobal('fetch', fetchMock);

    const provider = makeProvider();
    const chunks: LLMChunk[] = [];
    for await (const c of provider.chatAsync([makeMessage()])) chunks.push(c);

    const final = chunks.find((c) => c.isFinal)!;
    expect(final.usage).toMatchObject({
      inputTokens: 80,
      cacheReadTokens: 32,
      cacheWriteTokens: 0,
    });
  });
});

// Доступ к приватным методам для юнит-проверки.
type RemotePrivate = {
  _formatMessages(messages: LLMMessage[], systemPrompt?: string): Array<Record<string, unknown>>;
};

describe('RemoteProvider — форматирование tool_use/tool_result', () => {
  const provider = makeProvider() as unknown as RemotePrivate;

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

  it('arguments-строка остаётся строкой (OpenAI-совместимый LLM Proxy)', () => {
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

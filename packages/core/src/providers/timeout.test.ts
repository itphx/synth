import { describe, it, expect, afterEach, vi } from 'vitest';
import { OpenAIProvider } from './openai.js';
import { OllamaProvider } from './ollama.js';
import { AnthropicProvider } from './anthropic.js';

/**
 * Тесты таймаута chatAsync: таймер должен защищать только от «модель не
 * отвечает» (нет первого чанка). Как только пришёл первый содержательный
 * фрагмент — таймер снимается, и стрим может длиться дольше таймаута.
 *
 * Механика: фейковый fetch с ReadableStream, который мы держим открытым.
 * Подменяем AbortController, чтобы перехватить signal провайдера и связать
 * abort с ошибкой стрима (как у реального fetch). Виртуальные таймеры
 * (vi.useFakeTimers) позволяют «прокрутить» время за пределы таймаута.
 */

type StreamHandle = {
  stream: ReadableStream<Uint8Array>;
  push(text: string): void;
  close(): void;
  error(err: unknown): void;
};

function makeStream(): StreamHandle {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    stream,
    push: (text: string) => controller.enqueue(new TextEncoder().encode(text)),
    close: () => controller.close(),
    error: (err: unknown) => controller.error(err),
  };
}

/** Перехватывает signal, который создаёт провайдер внутри chatAsync. */
function spyAbortController(): () => AbortSignal | undefined {
  let signal: AbortSignal | undefined;
  const Original = globalThis.AbortController;
  vi.stubGlobal(
    'AbortController',
    class extends Original {
      constructor() {
        super();
        signal = this.signal;
      }
    },
  );
  return () => signal;
}

const baseParams = {
  url: 'http://example.test',
  apiKey: 'key',
  model: 'm',
  timeout: 1,
};

const ABORT_ERR = new DOMException('This operation was aborted', 'AbortError');

function stubFetch(stream: ReadableStream<Uint8Array>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, body: stream }),
  );
}

/** Связывает abort перехваченного signal с ошибкой стрима (как у реального fetch). */
function abortStreamOnSignal(signal: AbortSignal, handle: StreamHandle): void {
  signal.addEventListener('abort', () => {
    handle.error(signal.reason ?? ABORT_ERR);
  });
}

describe('провайдеры — таймаут только на ожидание первого чанка', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('Ollama: таймер снят после первого чанка — стрим дольше таймаута дочитывается', async () => {
    vi.useFakeTimers();
    const handle = makeStream();
    const getSignal = spyAbortController();
    stubFetch(handle.stream);

    const provider = new OllamaProvider({ ...baseParams, url: 'http://example.test/api/chat' });
    const gen = provider.chatAsync([], undefined, undefined, undefined, undefined);

    handle.push('{"message":{"content":"привет"}}\n');
    const firstP = gen.next();
    abortStreamOnSignal(getSignal()!, handle);
    const first = await firstP;
    expect(first.value.content).toBe('привет');

    // После первого чанка таймер снят: прокручиваем время за пределы таймаута,
    // abort не должен сработать (иначе стрим ошибся бы и генератор упал).
    vi.advanceTimersByTime(2 * baseParams.timeout * 1000);
    expect(getSignal()!.aborted).toBe(false);

    handle.close();
    const final = await gen.next();
    expect(final.value.isFinal).toBe(true);
    expect(final.value.content).toBe('привет');
    await expect(gen.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it('OpenAI: таймер снят после первого чанка — стрим дольше таймаута дочитывается', async () => {
    vi.useFakeTimers();
    const handle = makeStream();
    const getSignal = spyAbortController();
    stubFetch(handle.stream);

    const provider = new OpenAIProvider({ ...baseParams, url: 'http://example.test/v1/chat/completions' });
    const gen = provider.chatAsync([], undefined, undefined, undefined, undefined);

    handle.push('data: {"choices":[{"delta":{"content":"привет"}}]}\n\n');
    const firstP = gen.next();
    abortStreamOnSignal(getSignal()!, handle);
    const first = await firstP;
    expect(first.value.content).toBe('привет');

    vi.advanceTimersByTime(2 * baseParams.timeout * 1000);
    expect(getSignal()!.aborted).toBe(false);

    handle.close();
    const final = await gen.next();
    expect(final.value.isFinal).toBe(true);
    expect(final.value.content).toBe('привет');
    await expect(gen.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it('Anthropic: таймер снят после первого чанка — стрим дольше таймаута дочитывается', async () => {
    vi.useFakeTimers();
    const handle = makeStream();
    const getSignal = spyAbortController();
    stubFetch(handle.stream);

    const provider = new AnthropicProvider({ ...baseParams, url: 'http://example.test/v1/messages' });
    const gen = provider.chatAsync([], undefined, undefined, undefined, undefined);

    handle.push(
      'event: content_block_delta\n' +
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"привет"}}\n',
    );
    const firstP = gen.next();
    abortStreamOnSignal(getSignal()!, handle);
    const first = await firstP;
    expect(first.value.content).toBe('привет');

    vi.advanceTimersByTime(2 * baseParams.timeout * 1000);
    expect(getSignal()!.aborted).toBe(false);

    handle.close();
    const final = await gen.next();
    expect(final.value.isFinal).toBe(true);
    expect(final.value.content).toBe('привет');
    await expect(gen.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it('Ollama: без первого чанка таймер срабатывает — защита от «нет ответа» работает', async () => {
    vi.useFakeTimers();
    const handle = makeStream();
    const getSignal = spyAbortController();
    stubFetch(handle.stream);

    const provider = new OllamaProvider({ ...baseParams, url: 'http://example.test/api/chat' });
    const gen = provider.chatAsync([], undefined, undefined, undefined, undefined);

    const firstP = gen.next();
    abortStreamOnSignal(getSignal()!, handle);
    // Ни одного чанка не пришло — по истечении таймаута abort обрывает стрим.
    vi.advanceTimersByTime(2 * baseParams.timeout * 1000);
    await expect(firstP).rejects.toThrow('This operation was aborted');
  });
});

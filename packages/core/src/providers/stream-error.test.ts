import { describe, it, expect, afterEach, vi } from 'vitest';
import { OpenAIProvider } from './openai.js';
import { OllamaProvider } from './ollama.js';
import type { CancellationToken } from './base.js';

/**
 * Мок fetch: HTTP-ответ получен, но чтение стрима падает с AbortError —
 * имитация таймаута/обрыва соединения после установления соединения.
 */
function stubFailingStream(): void {
  const failingReader = {
    read: () => Promise.reject(new DOMException('This operation was aborted', 'AbortError')),
    releaseLock: () => {},
    cancel: () => Promise.resolve(),
  };
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    body: { getReader: () => failingReader },
  }));
}

const baseParams = {
  url: 'http://example.test/v1/chat/completions',
  apiKey: 'key',
  model: 'm',
  timeout: 30,
};

async function drain(gen: AsyncGenerator<unknown>): Promise<unknown[]> {
  const chunks: unknown[] = [];
  for await (const chunk of gen) {
    chunks.push(chunk);
  }
  return chunks;
}

describe('провайдеры — обработка ошибок чтения стрима', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('OpenAIProvider.chatAsync пробрасывает AbortError при обрыве стрима', async () => {
    stubFailingStream();
    const provider = new OpenAIProvider(baseParams);
    await expect(drain(provider.chatAsync([], undefined, undefined, undefined, undefined)))
      .rejects.toThrow('This operation was aborted');
  });

  it('OllamaProvider.chatAsync пробрасывает AbortError при обрыве стрима', async () => {
    stubFailingStream();
    const provider = new OllamaProvider({ ...baseParams, url: 'http://example.test/api/chat' });
    await expect(drain(provider.chatAsync([], undefined, undefined, undefined, undefined)))
      .rejects.toThrow('This operation was aborted');
  });

  it('OpenAIProvider.chatAsync не бросает и не выдаёт финальный чанк при пользовательской отмене', async () => {
    stubFailingStream();
    const provider = new OpenAIProvider(baseParams);
    const cancelToken: CancellationToken = { cancelled: true, cancel: () => {} };
    const chunks = await drain(provider.chatAsync([], undefined, undefined, undefined, cancelToken));
    expect(chunks).toEqual([]);
  });

  it('OllamaProvider.chatAsync не бросает и не выдаёт финальный чанк при пользовательской отмене', async () => {
    stubFailingStream();
    const provider = new OllamaProvider({ ...baseParams, url: 'http://example.test/api/chat' });
    const cancelToken: CancellationToken = { cancelled: true, cancel: () => {} };
    const chunks = await drain(provider.chatAsync([], undefined, undefined, undefined, cancelToken));
    expect(chunks).toEqual([]);
  });
});

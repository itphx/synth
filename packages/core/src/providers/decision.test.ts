/**
 * ADR-084: юнит-тесты DecisionProvider — mock fetch, оба транспорта
 * (`decisions`/`systemone`), парсинг answers, маппинг ошибок.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

import type { DecisionQuestion } from '@itphx/synth-shared';

import { DecisionProvider } from './decision.js';
import {
  ContextLengthExceededError,
  ProviderError,
  RateLimitError,
} from './exceptions.js';

function makeProvider(overrides: Partial<{ type: string; timeout: number }> = {}): DecisionProvider {
  return new DecisionProvider({
    url: 'https://routerai.ru/api/v1',
    apiKey: 'sk-test',
    model: 'clef-flash',
    timeout: overrides.timeout ?? 30,
    name: 'routerai-decision',
    type: overrides.type ?? 'decision',
  });
}

function makeQuestions(): Record<string, DecisionQuestion> {
  return {
    q1: { type: 'noul', instructions: 'срочно?' },
    q2: { type: 'choice', instructions: 'категория?', criteria: { a: null, b: null } },
    q3: { type: 'score', instructions: 'оценка?', criteria: ['low', 'mid', 'high'] },
  };
}

const OK_BODY = {
  id: 'resp_1',
  model: 'clef-flash',
  answers: {
    q1: { noul: 0.87 },
    q2: { choice: 'b', confidence: 0.9, probabilities: { a: 0.1, b: 0.9 } },
    q3: { score: 2, confidence: 0.7, probabilities: { '0': 0.1, '1': 0.2, '2': 0.7 }, legend: { '2': 'high' } },
  },
  usage: { input_tokens: 10, output_tokens: 5 },
};

describe('DecisionProvider (ADR-084)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('decision-протокол: POST {base}/decisions, Bearer, парсинг answers', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => OK_BODY,
    }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = makeProvider();
    const res = await provider.decide('some state', makeQuestions());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://routerai.ru/api/v1/decisions');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
    const body = JSON.parse(String(init.body)) as { model: string; state: string };
    expect(body.model).toBe('clef-flash');
    expect(body.state).toBe('some state');

    expect(res.id).toBe('resp_1');
    expect(res.model).toBe('clef-flash');
    expect(res.answers.q1).toEqual({ type: 'noul', noul: 0.87 });
    expect(res.answers.q2).toEqual({
      type: 'choice',
      choice: 'b',
      confidence: 0.9,
      probabilities: { a: 0.1, b: 0.9 },
    });
    expect(res.answers.q3).toEqual({
      type: 'score',
      score: 2,
      confidence: 0.7,
      probabilities: { '0': 0.1, '1': 0.2, '2': 0.7 },
      legend: { '2': 'high' },
    });
    expect(res.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
  });

  it('systemone-протокол: POST {base}/v1/systemone', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ answers: { q1: { noul: 1 } } }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = makeProvider({ type: 'systemone' });
    await provider.decide({ text: 'state' }, { q1: { type: 'noul' } });

    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://routerai.ru/api/v1/v1/systemone');
  });

  it('state-объект сериализуется в JSON', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ answers: {} }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await makeProvider().decide({ a: 1 }, {});
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).state).toEqual({ a: 1 });
  });

  it('images/videos добавляются в тело только если непусты', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ answers: {} }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await makeProvider().decide('s', {}, { images: ['a'], videos: [] });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.images).toEqual(['a']);
    expect(body.videos).toBeUndefined();

    await makeProvider().decide('s', {}, {});
    const [, init2] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    const body2 = JSON.parse(String(init2.body)) as Record<string, unknown>;
    expect(body2.images).toBeUndefined();
    expect(body2.videos).toBeUndefined();
  });

  it('429 → RateLimitError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 429,
      text: async () => 'too many requests',
    })));

    await expect(makeProvider().decide('s', {})).rejects.toBeInstanceOf(RateLimitError);
  });

  it('400 с признаком контекста → ContextLengthExceededError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 400,
      text: async () => 'maximum context length exceeded',
    })));

    await expect(makeProvider().decide('s', {})).rejects.toBeInstanceOf(ContextLengthExceededError);
  });

  it('прочий не-2xx → ProviderError с телом', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 500,
      text: async () => 'internal error',
    })));

    await expect(makeProvider().decide('s', {})).rejects.toMatchObject({
      name: 'ProviderError',
      message: expect.stringContaining('internal error'),
    });
  });

  it('сеть → ProviderError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network down');
    }));

    await expect(makeProvider().decide('s', {})).rejects.toMatchObject({
      name: 'ProviderError',
      message: expect.stringContaining('network down'),
    });
  });

  it('таймаут (AbortController) → ProviderError', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    }));

    const provider = makeProvider({ timeout: 0.02 });
    await expect(provider.decide('s', {})).rejects.toMatchObject({
      name: 'ProviderError',
      message: expect.stringContaining('Таймаут'),
    });
  });

  it('тело не-JSON → ProviderError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('bad json');
      },
    })));

    await expect(makeProvider().decide('s', {})).rejects.toBeInstanceOf(ProviderError);
  });

  it('chat/chatAsync у decision-провайдера недоступны', async () => {
    const provider = makeProvider();
    await expect(provider.chat([])).rejects.toThrow(/не поддерживает chat/);
    expect(() => provider.chatAsync([])).toThrow(/не поддерживает chat/);
  });
});

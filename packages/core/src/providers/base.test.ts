import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchModelsCatalog, parseTokenPricing, toNonNegativeNumber, ProviderFactory } from './base.js';
import './index.js';

describe('ProviderFactory._normalizeUrl — Ollama (совместимость ≥0.32)', () => {
  it('базовый URL с суффиксом /v1 → OpenAI-совместимый /v1/chat/completions', () => {
    expect(ProviderFactory._normalizeUrl('http://localhost:11434/v1', 'ollama'))
      .toBe('http://localhost:11434/v1/chat/completions');
    // Завершающий слэш снимается.
    expect(ProviderFactory._normalizeUrl('http://localhost:11434/v1/', 'ollama'))
      .toBe('http://localhost:11434/v1/chat/completions');
  });

  it('базовый URL без /v1 → нативный /api/chat (обратная совместимость)', () => {
    expect(ProviderFactory._normalizeUrl('http://localhost:11434', 'ollama'))
      .toBe('http://localhost:11434/api/chat');
  });

  it('уже готовые пути не дублируются (идемпотентность)', () => {
    expect(ProviderFactory._normalizeUrl('http://x/api/chat', 'ollama')).toBe('http://x/api/chat');
    expect(ProviderFactory._normalizeUrl('http://x/v1/chat/completions', 'ollama'))
      .toBe('http://x/v1/chat/completions');
  });
});

describe('toNonNegativeNumber', () => {
  it('принимает числа и числовые строки', () => {
    expect(toNonNegativeNumber(0)).toBe(0);
    expect(toNonNegativeNumber(12.5)).toBe(12.5);
    expect(toNonNegativeNumber('131072')).toBe(131072);
  });

  it('отбрасывает пустые/невалидные/отрицательные значения', () => {
    expect(toNonNegativeNumber(undefined)).toBeUndefined();
    expect(toNonNegativeNumber(null)).toBeUndefined();
    expect(toNonNegativeNumber('')).toBeUndefined();
    expect(toNonNegativeNumber('abc')).toBeUndefined();
    expect(toNonNegativeNumber(Infinity)).toBeUndefined();
    expect(toNonNegativeNumber(NaN)).toBeUndefined();
    expect(toNonNegativeNumber(-1)).toBeUndefined();
  });
});

describe('parseTokenPricing — нормировка к 1M токенов', () => {
  it('строки/числа умножаются на 1_000_000, priceUnit=token', () => {
    const result = parseTokenPricing(
      { prompt: '0.000001', completion: 0.000002 },
      undefined,
    );
    expect(result).toEqual({
      priceUnit: 'token',
      inputPrice: 1,
      outputPrice: 2,
    });
  });

  it('cache read/write из токенных ключей', () => {
    const result = parseTokenPricing(
      { input_cache_read: '0.0000001', input_cache_write: 0.0000002 },
      undefined,
    );
    expect(result?.priceUnit).toBe('token');
    expect(result?.cacheReadPrice).toBeCloseTo(0.1, 9);
    expect(result?.cacheWritePrice).toBeCloseTo(0.2, 9);
  });

  it('алиасы input/output/cache_read/cache_write', () => {
    const result = parseTokenPricing(
      { input: '0.000003', output: '0.000004', cached_input: '0.0000005', cache_write: '0.000001' },
      undefined,
    );
    expect(result).toEqual({
      priceUnit: 'token',
      inputPrice: 3,
      outputPrice: 4,
      cacheReadPrice: 0.5,
      cacheWritePrice: 1,
    });
  });
});

describe('parseTokenPricing — фильтр non-token тарифов', () => {
  it('units явно помечают completion как request — цена не попадает', () => {
    const result = parseTokenPricing(
      { prompt: '0.000001', completion: '0.000002', request: '0.01' },
      { prompt: 'token', completion: 'request', request: 'request' },
    );
    expect(result).toEqual({ priceUnit: 'token', inputPrice: 1 });
    expect(result).not.toHaveProperty('outputPrice');
    expect(result).not.toHaveProperty('cacheReadPrice');
  });

  it('pricing_units с web_search: request игнорируется', () => {
    const result = parseTokenPricing(
      { prompt: '0.000001', completion: '0.000002', web_search: '0.004' },
      { prompt: 'token', completion: 'token', web_search: 'request' },
    );
    expect(result).toEqual({ priceUnit: 'token', inputPrice: 1, outputPrice: 2 });
  });

  it('только non-token тарифы → undefined', () => {
    expect(parseTokenPricing(
      { request: '0.01', image: '0.04' },
      { request: 'request', image: 'image' },
    )).toBeUndefined();
  });

  it('отсутствие pricing → undefined', () => {
    expect(parseTokenPricing(undefined, undefined)).toBeUndefined();
  });

  it('невалидные значения пропускаются, валидный 0 сохраняется', () => {
    const result = parseTokenPricing({ prompt: 'abc', completion: 0 }, undefined);
    expect(result).toEqual({ priceUnit: 'token', outputPrice: 0 });
    expect(result).not.toHaveProperty('inputPrice');
  });

  it('отрицательные значения отбрасываются', () => {
    expect(parseTokenPricing({ prompt: -1 }, undefined)).toBeUndefined();
  });
});

describe('fetchModelsCatalog — конверт { data: [...] } и очистка таймера', () => {
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

  it('разбирает data[] и передаёт заголовки', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: [{ id: 'a' }, { id: 'b' }] }));
    vi.stubGlobal('fetch', fetchMock);

    const models = await fetchModelsCatalog('http://example.test/models', { Authorization: 'Bearer k' });

    expect(models).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://example.test/models',
      expect.objectContaining({ headers: { Authorization: 'Bearer k' } }),
    );
  });

  it('отсутствие data / не-OK статус → []', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({})));
    await expect(fetchModelsCatalog('http://example.test/models', {})).resolves.toEqual([]);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 500 })));
    await expect(fetchModelsCatalog('http://example.test/models', {})).resolves.toEqual([]);
  });

  it('сетевой сбой → [], таймер очищен', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));

    await expect(fetchModelsCatalog('http://example.test/models', {})).resolves.toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('невалидный JSON → [], таймер очищен (finally)', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not-json', { status: 200 })));

    await expect(fetchModelsCatalog('http://example.test/models', {})).resolves.toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('ProviderFactory.create — проброс numCtx', () => {
  it('передаёт config.numCtx в созданный провайдер', () => {
    const provider = ProviderFactory.create('ollama', {
      url: 'http://localhost:11434',
      apiKey: '',
      model: 'qwen3:8b',
      numCtx: 8192,
    });
    expect(provider.numCtx).toBe(8192);
  });

  it('без numCtx — undefined', () => {
    const provider = ProviderFactory.create('ollama', {
      url: 'http://localhost:11434',
      apiKey: '',
      model: 'qwen3:8b',
    });
    expect(provider.numCtx).toBeUndefined();
  });
});

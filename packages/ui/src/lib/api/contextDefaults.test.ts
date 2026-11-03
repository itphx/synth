import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_CONTEXT_DEFAULTS,
  deleteContextDefaults,
  fetchContextDefaults,
  putContextDefaults,
  type ContextDefaultsValues,
} from './contextDefaults'

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status < 400,
    status,
    json: async () => body,
  } as unknown as Response
}

const DEFAULTS: ContextDefaultsValues = {
  contextOptimization: 'summarization',
  summarizationEnabled: true,
  summarizationTriggerMode: 'tokens',
  summarizeAfterN: 30,
  summarizeTokenThreshold: 75,
  summarizationHeadMessages: 3,
  summarizationTailMessages: 6,
  summarizationKeepTokens: 4000,
  compactionKeepTokens: 18000,
  compactionTokenThreshold: 70,
  slidingWindowMode: 'tokens',
  slidingWindowMessageLimit: 40,
  slidingWindowTokenThreshold: 60,
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('fetchContextDefaults', () => {
  it('читает значения и источник из ответа /settings/context-defaults', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({
        defaults: DEFAULTS,
        saved: { contextOptimization: 'summarization' },
        source: 'runtime',
        restartRequired: false,
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchContextDefaults()
    expect(result.defaults).toEqual(DEFAULTS)
    expect(result.saved).toEqual({ contextOptimization: 'summarization' })
    expect(result.source).toBe('runtime')
    expect(result.restartRequired).toBe(false)
    expect(String(fetchMock.mock.calls[0]![0])).toBe('/api/v2/settings/context-defaults')
  })

  it('битые/неизвестные поля деградируют к дефолтам, не ломая чтение', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      defaults: { contextOptimization: 'unknown', summarizeAfterN: 0, summarizeTokenThreshold: 200 },
      source: 'weird',
    })))

    const result = await fetchContextDefaults()
    expect(result.defaults.contextOptimization).toBe(DEFAULT_CONTEXT_DEFAULTS.contextOptimization)
    expect(result.defaults.summarizeAfterN).toBe(DEFAULT_CONTEXT_DEFAULTS.summarizeAfterN)
    expect(result.defaults.summarizeTokenThreshold).toBe(
      DEFAULT_CONTEXT_DEFAULTS.summarizeTokenThreshold,
    )
    expect(result.source).toBe('default')
  })

  it('распознаёт стратегию compaction и поля сжатия; невалидные — к дефолтам', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      defaults: {
        contextOptimization: 'compaction',
        summarizationKeepTokens: 0,
        compactionKeepTokens: 25000,
        compactionTokenThreshold: 95,
      },
      source: 'runtime',
    })))

    const result = await fetchContextDefaults()
    expect(result.defaults.contextOptimization).toBe('compaction')
    // `0` — валидное значение (хвост не сохраняется).
    expect(result.defaults.summarizationKeepTokens).toBe(0)
    expect(result.defaults.compactionKeepTokens).toBe(25000)
    expect(result.defaults.compactionTokenThreshold).toBe(95)
    expect(result.source).toBe('runtime')

    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      defaults: {
        summarizationKeepTokens: -1,
        compactionKeepTokens: 'many',
        compactionTokenThreshold: 0,
      },
    })))

    const broken = await fetchContextDefaults()
    expect(broken.defaults.summarizationKeepTokens).toBe(
      DEFAULT_CONTEXT_DEFAULTS.summarizationKeepTokens,
    )
    expect(broken.defaults.compactionKeepTokens).toBe(DEFAULT_CONTEXT_DEFAULTS.compactionKeepTokens)
    expect(broken.defaults.compactionTokenThreshold).toBe(
      DEFAULT_CONTEXT_DEFAULTS.compactionTokenThreshold,
    )
  })

  it('ошибка 400 пробрасывается с текстом сервера и статусом', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: { code: 'VALIDATION_ERROR', message: 'bad' } }, 400)),
    )

    await expect(fetchContextDefaults()).rejects.toMatchObject({
      message: 'bad',
      status: 400,
    })
  })

  it('сетевая ошибка пробрасывается (строгое чтение)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('network down')
    }))

    await expect(fetchContextDefaults()).rejects.toBeInstanceOf(TypeError)
  })
})

describe('мутации context-defaults', () => {
  it('PUT отправляет {defaults: patch} и возвращает обновлённое состояние', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({ defaults: { ...DEFAULTS, summarizeAfterN: 50 }, saved: { summarizeAfterN: 50 }, source: 'runtime', restartRequired: false }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await putContextDefaults({ summarizeAfterN: 50 })
    expect(result.defaults.summarizeAfterN).toBe(50)
    expect(result.source).toBe('runtime')

    const init = fetchMock.mock.calls[0]![1] as RequestInit
    expect(init.method).toBe('PUT')
    expect(JSON.parse(String(init.body))).toEqual({ defaults: { summarizeAfterN: 50 } })
  })

  it('PUT 400 пробрасывается (валидация на сервере)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: { code: 'VALIDATION_ERROR', message: 'invalid' } }, 400)),
    )
    await expect(putContextDefaults({ summarizeAfterN: 0 })).rejects.toMatchObject({ status: 400 })
  })

  it('DELETE сбрасывает runtime-значения', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({
        defaults: DEFAULT_CONTEXT_DEFAULTS,
        saved: {},
        source: 'default',
        restartRequired: false,
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await deleteContextDefaults()
    expect(result.source).toBe('default')
    expect(result.saved).toEqual({})
    expect((fetchMock.mock.calls[0]![1] as RequestInit).method).toBe('DELETE')
  })
})

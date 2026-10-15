import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { synthApi, type InstructionsInfo } from './synthApi'

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response
}

const INFO: InstructionsInfo = {
  session_id: 's 1',
  enabled: true,
  cap: { chars: 20000, source: 'dynamic', contextWindow: 128000 },
  files: [
    {
      path: './AGENTS.md',
      kind: 'chain',
      chars: 1234,
      truncated: false,
      status: 'loaded',
      scan: { scanned: true, blocked: false, suspicious: false, matches: [] },
    },
  ],
  diagnostics: [{ level: 'info', code: 'ok', message: 'loaded' }],
}

let fetchMock: ReturnType<typeof vi.fn>

describe('synthApi — проектные инструкции (ADR-069 §9.3)', () => {
  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('getSessionInstructions: GET /context/instructions?session_id=… (encodeURIComponent)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(INFO))
    const result = await synthApi.getSessionInstructions('s 1')

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/context/instructions?session_id=s%201',
      expect.objectContaining({}),
    )
    expect(result).toEqual(INFO)
  })

  it('getSessionInstructions: ошибка HTTP → Error со статусом', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: { message: 'Сессия не найдена' } }),
    } as unknown as Response)

    await expect(synthApi.getSessionInstructions('nope')).rejects.toThrow('Сессия не найдена')
  })
})

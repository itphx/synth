import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { synthApi } from './synthApi'

/**
 * Домены `packs` (`lib/api/packs.ts`, ADR-086 §5) и `pipelines`
 * (`lib/api/pipelines.ts`, ADR-051/ADR-100): реестр установок пакетов
 * расширений и пайплайны инстанса.
 *
 * Ценно — пути/методы, разворачивание конвертов ответа (`{packs}`/`{pipelines}`/
 * `{instances}`) и проброс 403 как понятной ошибки (реестр инстанса в managed
 * читает только ADMIN).
 */

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const PACK = {
  name: 'synth-media',
  version: '1.0.0',
  kind: 'addon',
  status: 'active' as const,
  requiresApproval: false,
  provides: { agents: ['publisher'], skills: ['media-hub'], mcp: ['synth-media-receiver'], pipelines: ['publication'] },
  installedAt: '2026-10-19T10:00:00.000Z',
  updatedAt: '2026-10-19T10:00:00.000Z',
}

const PIPELINE = {
  id: 'publication',
  name: 'Publication',
  version: '1.0.0',
  steps: [{ id: 'draft', kind: 'agent' as const }, { id: 'publish', kind: 'agent' as const }],
  installedBy: { pack: 'synth-media', version: '1.0.0' },
  createdAt: '2026-10-19T10:00:00.000Z',
  updatedAt: '2026-10-19T10:00:00.000Z',
}

const INSTANCE = {
  id: 'plrun_1',
  pipelineId: 'publication',
  status: 'running' as const,
  steps: [{ id: 'draft', status: 'running' as const }],
  currentStep: 'draft',
  attempts: 0,
  createdAt: '2026-10-19T10:00:00.000Z',
  updatedAt: '2026-10-19T10:00:00.000Z',
}

describe('packsApi — реестр пакетов расширений (ADR-086 §5)', () => {
  it('getPacks: GET /packs и разворачивание конверта {packs}', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ packs: [PACK] }))

    await expect(synthApi.getPacks()).resolves.toEqual([PACK])

    expect(fetchMock).toHaveBeenCalledWith('/api/v2/packs', expect.objectContaining({}))
  })

  it('getPacks: пустой реестр — пустой список', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ packs: [] }))

    await expect(synthApi.getPacks()).resolves.toEqual([])
  })

  it('getPack: GET /packs/:name (имя кодируется)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(PACK))

    await expect(synthApi.getPack('synth-media')).resolves.toEqual(PACK)

    expect(fetchMock).toHaveBeenCalledWith('/api/v2/packs/synth-media', expect.objectContaining({}))
  })

  it('approvePack: POST /packs/:name/approve', async () => {
    const result = {
      installed: true,
      requiresApproval: false,
      name: 'synth-media',
      version: '1.0.0',
      provides: PACK.provides,
    }
    fetchMock.mockResolvedValue(jsonResponse(result))

    await expect(synthApi.approvePack('synth-media')).resolves.toEqual(result)

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/packs/synth-media/approve',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('uninstallPack: DELETE /packs/:name', async () => {
    fetchMock.mockResolvedValue(jsonResponse(null, 204))

    await expect(synthApi.uninstallPack('synth-media')).resolves.toBeUndefined()

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/packs/synth-media',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  it('403: ошибка несёт status и сообщение сервера', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { code: 'FORBIDDEN', message: 'admin only' } }, 403),
    )

    await expect(synthApi.getPacks()).rejects.toMatchObject({
      status: 403,
      message: 'admin only',
    })
  })

  it('404: пакет не найден — ошибка со статусом', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { code: 'NOT_FOUND', message: 'pack not found' } }, 404),
    )

    await expect(synthApi.getPack('nope')).rejects.toMatchObject({
      status: 404,
      message: 'pack not found',
    })
  })
})

describe('pipelinesApi — пайплайны инстанса (ADR-051/ADR-100)', () => {
  it('getPipelines: GET /pipelines и разворачивание конверта {pipelines}', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ pipelines: [PIPELINE] }))

    await expect(synthApi.getPipelines()).resolves.toEqual([PIPELINE])

    expect(fetchMock).toHaveBeenCalledWith('/api/v2/pipelines', expect.objectContaining({}))
  })

  it('getPipelineInstances: GET /pipelines/instances без фильтров', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ instances: [INSTANCE] }))

    await expect(synthApi.getPipelineInstances()).resolves.toEqual([INSTANCE])

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/pipelines/instances',
      expect.objectContaining({}),
    )
  })

  it('getPipelineInstances: фильтры pipelineId/status/limit уходят в query', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ instances: [] }))

    await synthApi.getPipelineInstances({ pipelineId: 'publication', status: 'running', limit: 20 })

    const url = String(fetchMock.mock.calls[0][0])
    expect(url).toContain('/api/v2/pipelines/instances?')
    expect(url).toContain('pipelineId=publication')
    expect(url).toContain('status=running')
    expect(url).toContain('limit=20')
  })

  it('403: чтение пайплайнов недоступно без прав администратора', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { code: 'FORBIDDEN', message: 'admin only' } }, 403),
    )

    await expect(synthApi.getPipelines()).rejects.toMatchObject({
      status: 403,
      message: 'admin only',
    })
  })
})

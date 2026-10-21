import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { synthApi } from './synthApi'

/**
 * Домен `pipelineProjectApi` (`lib/api/pipeline-project.ts`, ADR-101 §5.35):
 * пайплайны проекта (черновик + опубликованные версии), прогоны с журналом,
 * HITL-решения и шаблоны инстанса.
 *
 * Ценно — пути/методы, разворачивание конвертов ответа (`{pipelines}`/`{run}`/
 * `{pipeline}`) и тела запросов (в т.ч. `resume` с `approved`): права HITL
 * проверяются на сервере, а UI обязан передавать решение человека без
 * искажений.
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

const SPEC = {
  id: 'pl1',
  name: 'Release',
  version: 1,
  status: 'draft' as const,
  mode: 'plan' as const,
  nodes: [{ id: 'step-1', kind: 'agent' as const, title: 'Draft', agent: 'assistant' }],
  exits: [{ kind: 'none' as const }],
}

const PIPELINE = {
  id: 'pl1',
  name: 'Release',
  scope: 'project' as const,
  projectId: 'p1',
  draftVersion: 2,
  publishedVersion: 1,
  hasDraft: true,
  createdAt: '2026-10-20T10:00:00.000Z',
  updatedAt: '2026-10-20T11:00:00.000Z',
  draft: SPEC,
}

const DETAIL = {
  pipeline: PIPELINE,
  published: {
    pipelineId: 'pl1',
    version: 1,
    spec: { ...SPEC, status: 'published' as const },
    publishedAt: '2026-10-20T10:00:00.000Z',
    publishedBy: 'u1',
  },
  versions: [
    {
      pipelineId: 'pl1',
      version: 1,
      spec: { ...SPEC, status: 'published' as const },
      publishedAt: '2026-10-20T10:00:00.000Z',
    },
  ],
}

const RUN = {
  id: 'run1',
  pipelineId: 'pl1',
  version: 1,
  status: 'running' as const,
  currentNode: 'step-1',
  startedAt: '2026-10-20T12:00:00.000Z',
}

/** Тело последнего запроса (fetch вызывается как `fetch(url, options)`). */
function lastBody(): unknown {
  const options = fetchMock.mock.calls[fetchMock.mock.calls.length - 1][1] as RequestInit
  return options.body ? JSON.parse(String(options.body)) : undefined
}

/** URL последнего запроса. */
function lastUrl(): string {
  return String(fetchMock.mock.calls[fetchMock.mock.calls.length - 1][0])
}

describe('pipelineProjectApi — пайплайны проекта (ADR-101 §5.35)', () => {
  it('getProjectPipelines: GET /projects/:id/pipelines и разворачивание конверта {pipelines}', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ pipelines: [PIPELINE] }))

    await expect(synthApi.getProjectPipelines('p1')).resolves.toEqual([PIPELINE])

    expect(fetchMock).toHaveBeenCalledWith('/api/v2/projects/p1/pipelines', expect.objectContaining({}))
  })

  it('getProjectPipelines: пустой список — пустой массив', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}))

    await expect(synthApi.getProjectPipelines('p1')).resolves.toEqual([])
  })

  it('getProjectPipeline: GET детали — разбор DTO (черновик, публикация, версии)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(DETAIL))

    const detail = await synthApi.getProjectPipeline('p1', 'pl1')

    expect(fetchMock).toHaveBeenCalledWith('/api/v2/projects/p1/pipelines/pl1', expect.objectContaining({}))
    expect(detail.pipeline.id).toBe('pl1')
    expect(detail.pipeline.draft?.nodes).toHaveLength(1)
    expect(detail.published?.version).toBe(1)
    expect(detail.versions).toHaveLength(1)
  })

  it('createProjectPipeline: POST с телом {name, spec} → объект пайплайна', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ pipeline: PIPELINE }))

    await expect(
      synthApi.createProjectPipeline('p1', { name: 'Release', spec: SPEC }),
    ).resolves.toEqual(PIPELINE)

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/projects/p1/pipelines',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(lastBody()).toEqual({ name: 'Release', spec: SPEC })
  })

  it('updateProjectPipeline: PUT с телом спецификации → объект пайплайна', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ pipeline: PIPELINE }))

    await expect(
      synthApi.updateProjectPipeline('p1', 'pl1', { name: 'Release', description: 'd', spec: SPEC }),
    ).resolves.toEqual(PIPELINE)

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/projects/p1/pipelines/pl1',
      expect.objectContaining({ method: 'PUT' }),
    )
    expect(lastBody()).toEqual({ name: 'Release', description: 'd', spec: SPEC })
  })

  it('deleteProjectPipeline: DELETE → без тела (204)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(null, 204))

    await expect(synthApi.deleteProjectPipeline('p1', 'pl1')).resolves.toBeUndefined()

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/projects/p1/pipelines/pl1',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  it('publishProjectPipeline: POST /publish → {pipeline, published}', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ pipeline: PIPELINE, published: DETAIL.published }))

    const result = await synthApi.publishProjectPipeline('p1', 'pl1')

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/projects/p1/pipelines/pl1/publish',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(result.pipeline.id).toBe('pl1')
    expect(result.published?.version).toBe(1)
  })

  it('listPipelineRuns: GET .../runs и разворачивание конверта {runs}', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ runs: [RUN] }))

    await expect(synthApi.listPipelineRuns('p1', 'pl1')).resolves.toEqual([RUN])

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/projects/p1/pipelines/pl1/runs',
      expect.objectContaining({}),
    )
  })

  it('listPipelineRuns: фильтр по статусу уходит в query', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ runs: [] }))

    await synthApi.listPipelineRuns('p1', 'pl1', { status: 'awaiting_human', limit: 5 })

    expect(lastUrl()).toContain('/api/v2/projects/p1/pipelines/pl1/runs?')
    expect(lastUrl()).toContain('status=awaiting_human')
    expect(lastUrl()).toContain('limit=5')
  })

  it('startPipelineRun: POST .../runs с телом триггера → запись прогона', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ run: RUN }))

    await expect(
      synthApi.startPipelineRun('p1', 'pl1', { trigger: { kind: 'manual' } }),
    ).resolves.toEqual(RUN)

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/projects/p1/pipelines/pl1/runs',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(lastBody()).toEqual({ trigger: { kind: 'manual' } })
  })

  it('getPipelineRun: GET /pipeline-runs/:id — прогон и журнал', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ run: RUN, events: [{ runId: 'run1', ts: '2026-10-20T12:00:00.000Z', type: 'run.started' }] }),
    )

    const detail = await synthApi.getPipelineRun('run1')

    expect(fetchMock).toHaveBeenCalledWith('/api/v2/pipeline-runs/run1', expect.objectContaining({}))
    expect(detail.run.id).toBe('run1')
    expect(detail.events).toHaveLength(1)
  })
})

describe('pipelineProjectApi — HITL-решения и отмена прогона', () => {
  it('resumePipelineRun: одобрение — тело {approved: true}', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ run: { ...RUN, status: 'running' } }))

    await expect(synthApi.resumePipelineRun('run1', { approved: true })).resolves.toMatchObject({
      id: 'run1',
    })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/pipeline-runs/run1/resume',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(lastBody()).toEqual({ approved: true })
  })

  it('resumePipelineRun: отклонение — тело {approved: false} (+ комментарий)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ run: { ...RUN, status: 'cancelled' } }))

    await synthApi.resumePipelineRun('run1', { approved: false, comment: 'не то' })

    expect(lastBody()).toEqual({ approved: false, comment: 'не то' })
  })

  it('cancelPipelineRun: POST /cancel → запись прогона', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ run: { ...RUN, status: 'cancelled' } }))

    await expect(synthApi.cancelPipelineRun('run1')).resolves.toMatchObject({ status: 'cancelled' })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/pipeline-runs/run1/cancel',
      expect.objectContaining({ method: 'POST' }),
    )
  })
})

describe('pipelineProjectApi — шаблоны инстанса', () => {
  it('getPipelineTemplates: GET /pipeline-templates → массив', async () => {
    const template = { id: 'tpl1', name: 'Release', format: 'adr-101' as const, spec: SPEC }
    fetchMock.mockResolvedValue(jsonResponse({ templates: [template] }))

    await expect(synthApi.getPipelineTemplates()).resolves.toEqual([template])

    expect(fetchMock).toHaveBeenCalledWith('/api/v2/pipeline-templates', expect.objectContaining({}))
  })

  it('instantiatePipelineTemplate: POST .../instantiate с телом {projectId}', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ pipeline: PIPELINE }))

    await expect(
      synthApi.instantiatePipelineTemplate('tpl1', { projectId: 'p1' }),
    ).resolves.toEqual(PIPELINE)

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/pipeline-templates/tpl1/instantiate',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(lastBody()).toEqual({ projectId: 'p1' })
  })
})

describe('pipelineProjectApi — ошибки прав и адресации', () => {
  it('403: нет права на запись — ошибка со статусом и сообщением сервера', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { code: 'FORBIDDEN', message: 'project is read-only' } }, 403),
    )

    await expect(synthApi.publishProjectPipeline('p1', 'pl1')).rejects.toMatchObject({
      status: 403,
      message: 'project is read-only',
    })
  })

  it('404: пайплайн не найден — ошибка со статусом', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { code: 'NOT_FOUND', message: 'pipeline not found' } }, 404),
    )

    await expect(synthApi.getProjectPipeline('p1', 'nope')).rejects.toMatchObject({
      status: 404,
      message: 'pipeline not found',
    })
  })

  it('id проекта и пайплайна кодируются в путь', async () => {
    fetchMock.mockResolvedValue(jsonResponse(DETAIL))

    await synthApi.getProjectPipeline('p 1', 'pl/1')

    expect(lastUrl()).toBe('/api/v2/projects/p%201/pipelines/pl%2F1')
  })
})

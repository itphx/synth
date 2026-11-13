import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { executionApi } from './execution'

/**
 * Домен `execution` (`lib/api/execution.ts`, PROP-135 слайс 6b-1/6b-2a):
 * профили и пулы исполнения. Ценно — пути, методы, URL-encode ключа пула
 * (содержит `:` и идентификаторы), разбор DTO и проброс ошибок (503/403).
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

const urlOf = (call: number): string => String(fetchMock.mock.calls[call]?.[0])
const initOf = (call: number): RequestInit => (fetchMock.mock.calls[call]?.[1] ?? {}) as RequestInit
const methodOf = (call: number): string => initOf(call).method ?? 'GET'

describe('executionApi — профили исполнения', () => {
  it('getExecutionProfiles: GET /execution/profiles и DTO с details', async () => {
    const dto = {
      provider: 'http' as const,
      pooling: 'project' as const,
      defaultProfile: 'default',
      profiles: ['default', 'devops'],
      details: [
        {
          name: 'devops',
          description: 'Сборка в удалённом builder',
          image: 'registry.example/synth-executor:devops',
          network: 'restricted' as const,
          resources: { limits: { cpu: '4', memory: '8Gi' } },
          runtimeClass: 'gvisor',
          mcpServers: ['playwright'],
        },
      ],
    }
    fetchMock.mockResolvedValue(jsonResponse(dto))

    // Клиент нормализует legacy-строки MCP в объекты `{name}`.
    await expect(executionApi.getExecutionProfiles()).resolves.toEqual({
      ...dto,
      details: [{ ...dto.details[0], mcpServers: [{ name: 'playwright' }] }],
    })

    expect(urlOf(0)).toBe('/api/v2/execution/profiles')
    expect(methodOf(0)).toBe('GET')
  })

  it('getExecutionProfiles: старый сервер без details — пустой список', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        provider: 'static',
        pooling: 'instance',
        defaultProfile: 'default',
        profiles: ['default'],
      }),
    )

    await expect(executionApi.getExecutionProfiles()).resolves.toEqual({
      provider: 'static',
      pooling: 'instance',
      defaultProfile: 'default',
      profiles: ['default'],
      details: [],
    })
  })

  it('getExecutionProfiles: inline без профилей', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ provider: 'inline', pooling: 'instance', defaultProfile: 'default', profiles: [] }),
    )

    await expect(executionApi.getExecutionProfiles()).resolves.toEqual({
      provider: 'inline',
      pooling: 'instance',
      defaultProfile: 'default',
      profiles: [],
      details: [],
    })
  })
})

describe('executionApi — пулы исполнения', () => {
  const POOL = {
    key: 'project:p1:exec:devops',
    profile: 'devops',
    state: 'ready' as const,
    createdAt: '2026-11-12T10:00:00.000Z',
    lastUsedAt: '2026-11-12T10:05:00.000Z',
  }

  it('getExecutionPools: GET /execution/pools и DTO', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ provider: 'http', pools: [POOL] }))

    await expect(executionApi.getExecutionPools()).resolves.toEqual({
      provider: 'http',
      pools: [POOL],
    })

    expect(urlOf(0)).toBe('/api/v2/execution/pools')
    expect(methodOf(0)).toBe('GET')
  })

  it('getExecutionPools: без поля pools отдаёт пустой список', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ provider: 'static' }))

    await expect(executionApi.getExecutionPools()).resolves.toEqual({
      provider: 'static',
      pools: [],
    })
  })

  it('drainExecutionPool: POST на :key/drain, ключ URL-encoded', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }, 202))

    await expect(
      executionApi.drainExecutionPool('project:p 1:exec:devops/tier'),
    ).resolves.toBeUndefined()

    expect(urlOf(0)).toBe(
      '/api/v2/execution/pools/project%3Ap%201%3Aexec%3Adevops%2Ftier/drain',
    )
    expect(methodOf(0)).toBe('POST')
  })

  it('releaseExecutionPool: DELETE на :key, ключ URL-encoded', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }, 202))

    await expect(
      executionApi.releaseExecutionPool('instance:exec:default'),
    ).resolves.toBeUndefined()

    expect(urlOf(0)).toBe('/api/v2/execution/pools/instance%3Aexec%3Adefault')
    expect(methodOf(0)).toBe('DELETE')
  })

  it('getExecutionPools: 503 провайдера пулов — ошибка со статусом и кодом', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { error: { code: 'EXECUTION_PROVIDER_UNAVAILABLE', message: 'provider unavailable' } },
        503,
      ),
    )

    await expect(executionApi.getExecutionPools()).rejects.toMatchObject({
      status: 503,
      code: 'EXECUTION_PROVIDER_UNAVAILABLE',
      message: 'provider unavailable',
    })
  })

  it('drainExecutionPool: 403 пробрасывается со статусом и кодом', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { code: 'FORBIDDEN', message: 'forbidden' } }, 403),
    )

    await expect(executionApi.drainExecutionPool('instance:exec:default')).rejects.toMatchObject({
      status: 403,
      code: 'FORBIDDEN',
    })
  })
})

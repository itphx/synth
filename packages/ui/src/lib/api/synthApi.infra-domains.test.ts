import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { synthApi } from './synthApi'

/**
 * «Инфраструктурные» домены API v2 (ADR-095): health, agents, providers, models,
 * users, dictionaries, context, logs, identities, schedules, webhooks, service-keys,
 * hybrid, debug. Ценно — разворачивание полей (`res.schedule`), нормализация моделей
 * и query/кодирование идентификаторов.
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

describe('healthApi / hybridApi', () => {
  it('getHealth / checkUpdate: публичные GET-пути', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: 'ok', version: '1' }))
    await synthApi.getHealth()
    expect(fetchMock).toHaveBeenLastCalledWith('/api/v2/health', expect.objectContaining({}))

    await synthApi.checkUpdate()
    expect(fetchMock).toHaveBeenLastCalledWith('/api/v2/updates/check', expect.objectContaining({}))
  })

  it('getHybridStatus: GET /hybrid/status', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ enabled: true, connected: false }))
    await synthApi.getHybridStatus()
    expect(fetchMock).toHaveBeenCalledWith('/api/v2/hybrid/status', expect.objectContaining({}))
  })
})

describe('agentsApi', () => {
  it('getAgents: session_id только при задании, с кодированием', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ agents: [], default_agent: null }))
    await synthApi.getAgents()
    expect(fetchMock).toHaveBeenLastCalledWith('/api/v2/agents', expect.objectContaining({}))

    await synthApi.getAgents('s 1')
    expect(fetchMock).toHaveBeenLastCalledWith('/api/v2/agents?session_id=s%201', expect.objectContaining({}))
  })

  it('getAllAgents / getAgentDetail: /agents/all и /agents/:id (кодирование)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ agents: [] }))
    await synthApi.getAllAgents()
    expect(fetchMock).toHaveBeenLastCalledWith('/api/v2/agents/all', expect.objectContaining({}))

    await synthApi.getAgentDetail('a/1')
    expect(fetchMock).toHaveBeenLastCalledWith('/api/v2/agents/a%2F1', expect.objectContaining({}))
  })

  it('toggleAgent: PATCH /agents/:id/enabled {enabled}', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 204, json: async () => undefined } as unknown as Response)
    await synthApi.toggleAgent('a1', false)
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/agents/a1/enabled',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ enabled: false }) }),
    )
  })
})

describe('providersApi / modelsApi', () => {
  it('getProviders: нормализует отсутствующий список к []', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ providers: null, default_provider: 'itphx' }))

    const result = await synthApi.getProviders()

    expect(fetchMock).toHaveBeenCalledWith('/api/v2/providers', expect.objectContaining({}))
    expect(result).toEqual({ providers: [], default_provider: 'itphx' })
  })

  it('testProvider / fetchProviderIcon: POST-подпути с телом', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: 'ok' }))
    await synthApi.testProvider('p/1')
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/providers/p%2F1/test',
      expect.objectContaining({ method: 'POST' }),
    )

    await synthApi.fetchProviderIcon('https://x/i.svg')
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/providers/fetch-icon',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ url: 'https://x/i.svg' }) }),
    )
  })

  it('getModels: нормализует camelCase-поля моделей в snake_case', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        groups: [
          {
            provider: { name: 'itphx', type: 'openai', icon: '', defaultModel: 'm' },
            models: [
              { id: 'm1', name: 'm1', provider: 'itphx', enabled: true, isDefault: false, contextWindow: 1000, inputPrice: 2 },
            ],
          },
        ],
      }),
    )

    const groups = await synthApi.getModels()

    expect(groups[0]!.models[0]!.context_window).toBe(1000)
    expect(groups[0]!.models[0]!.input_price).toBe(2)
    expect((groups[0]!.models[0] as unknown as Record<string, unknown>).contextWindow).toBeUndefined()
  })

  it('fetchModels: provider добавляется в query только при задании', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ fetched: 1 }))

    await synthApi.fetchModels()
    expect(fetchMock).toHaveBeenLastCalledWith('/api/v2/models/fetch', expect.objectContaining({ method: 'POST' }))

    await synthApi.fetchModels('p/1')
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/models/fetch?provider=p%2F1',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('saveModel / deleteModel: POST /models и DELETE /models/:id', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: 'm1' }))
    await synthApi.saveModel({ id: 'm1' })
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/models',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ id: 'm1' }) }),
    )

    await synthApi.deleteModel('p/m')
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/models/p%2Fm',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })
})

describe('usersApi / dictionariesApi / contextApi', () => {
  it('users: GET/POST/PUT/DELETE с кодированием id', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ users: [] }))
    await synthApi.getUsers()
    expect(fetchMock).toHaveBeenLastCalledWith('/api/v2/users', expect.objectContaining({}))

    await synthApi.getUser('u/1')
    expect(fetchMock).toHaveBeenLastCalledWith('/api/v2/users/u%2F1', expect.objectContaining({}))

    fetchMock.mockResolvedValue(jsonResponse({ id: 'u1' }))
    await synthApi.updateUser('u1', { roles: ['ADMIN'] })
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/users/u1',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ roles: ['ADMIN'] }) }),
    )

    await synthApi.deleteUser('u1')
    expect(fetchMock).toHaveBeenLastCalledWith('/api/v2/users/u1', expect.objectContaining({ method: 'DELETE' }))
  })

  it('dictionaries: GET/PUT/DELETE с кодированием category/lang', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ dictionaries: [] }))
    await synthApi.getDictionaries()
    expect(fetchMock).toHaveBeenLastCalledWith('/api/v2/dictionaries', expect.objectContaining({}))

    await synthApi.getDictionary('cat one', 'ru')
    expect(fetchMock).toHaveBeenLastCalledWith('/api/v2/dictionaries/cat%20one/ru', expect.objectContaining({}))

    fetchMock.mockResolvedValue(jsonResponse({ status: 'ok', dictionary: {} }))
    await synthApi.saveDictionary('c', 'ru', { content: 'y' })
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/dictionaries/c/ru',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ content: 'y' }) }),
    )

    await synthApi.resetDictionary('c', 'ru')
    expect(fetchMock).toHaveBeenLastCalledWith('/api/v2/dictionaries/c/ru', expect.objectContaining({ method: 'DELETE' }))
  })

  it('context: category всегда в query, toggle шлёт {action:"toggle"}', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ files: [] }))
    await synthApi.getContextFiles('system prompts')
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/context/files?category=system%20prompts',
      expect.objectContaining({}),
    )

    fetchMock.mockResolvedValue(jsonResponse({ name: 'x', enabled: true }))
    await synthApi.toggleContextFile('x y')
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/context/files/x%20y',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ action: 'toggle' }) }),
    )

    await synthApi.saveContextFile('n', 'body', 'rules')
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/context/files/n',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ content: 'body', category: 'rules' }) }),
    )
  })
})

describe('logsApi / identitiesApi', () => {
  it('getLogs: имя кодируется, tail/search — в query', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ lines: [] }))

    await synthApi.getLogs('core')
    expect(fetchMock).toHaveBeenLastCalledWith('/api/v2/logs/core', expect.objectContaining({}))

    await synthApi.getLogs('my log', { tail: 100, search: 'err' })
    const url = fetchMock.mock.calls[1]![0] as string
    const params = new URLSearchParams(url.split('?')[1])
    expect(url.startsWith('/api/v2/logs/my%20log?')).toBe(true)
    expect(params.get('tail')).toBe('100')
    expect(params.get('search')).toBe('err')
  })

  it('getAudit / getLlmPayloads: параметры в query', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ entries: [], total: 0 }))

    await synthApi.getAudit({ userId: 'u1', limit: 10 })
    const p1 = new URLSearchParams((fetchMock.mock.calls[0]![0] as string).split('?')[1])
    expect(p1.get('userId')).toBe('u1')
    expect(p1.get('limit')).toBe('10')

    await synthApi.getLlmPayloads({ sessionId: 's1' })
    const p2 = new URLSearchParams((fetchMock.mock.calls[1]![0] as string).split('?')[1])
    expect(p2.get('sessionId')).toBe('s1')
  })

  it('identities: getMyIdentities / deleteMyIdentity (кодирование) / claimIdentity', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ identities: [] }))
    await synthApi.getMyIdentities()
    expect(fetchMock).toHaveBeenLastCalledWith('/api/v2/me/identities', expect.objectContaining({}))

    await synthApi.deleteMyIdentity('telegram', 'tg 1')
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/me/identities/telegram/tg%201',
      expect.objectContaining({ method: 'DELETE' }),
    )

    await synthApi.claimIdentity('CODE-1')
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/me/identities/claim',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ code: 'CODE-1' }) }),
    )
  })
})

describe('schedulesApi / webhooksApi / serviceKeysApi', () => {
  it('schedules: create/update/run разворачивают {schedule}', async () => {
    const schedule = { id: 'sc1', name: 'nightly' }
    fetchMock.mockResolvedValue(jsonResponse({ schedule }))

    await expect(synthApi.createSchedule({ name: 'nightly' } as never)).resolves.toEqual(schedule)
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/schedules',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ name: 'nightly' }) }),
    )

    await expect(synthApi.updateSchedule('sc1', { name: 'x' } as never)).resolves.toEqual(schedule)
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/schedules/sc1',
      expect.objectContaining({ method: 'PUT' }),
    )

    await expect(synthApi.runSchedule('sc1')).resolves.toEqual(schedule)
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/schedules/sc1/run',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('getScheduleJobs: limit по умолчанию 20, кастомный в query', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ jobs: [] }))

    await synthApi.getScheduleJobs('sc1')
    expect(fetchMock).toHaveBeenLastCalledWith('/api/v2/schedules/sc1/jobs?limit=20', expect.objectContaining({}))

    await synthApi.getScheduleJobs('sc1', 5)
    expect(fetchMock).toHaveBeenLastCalledWith('/api/v2/schedules/sc1/jobs?limit=5', expect.objectContaining({}))
  })

  it('webhooks: CRUD, regenerate/test, deliveries с limit', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ subscriptions: [] }))
    await synthApi.getWebhookSubscriptions()
    expect(fetchMock).toHaveBeenLastCalledWith('/api/v2/webhooks', expect.objectContaining({}))

    fetchMock.mockResolvedValue(jsonResponse({ id: 'w1' }))
    await synthApi.updateWebhookSubscription('w/1', { enabled: true } as never)
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/webhooks/w%2F1',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ enabled: true }) }),
    )

    await synthApi.regenerateWebhookSecret('w1')
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/webhooks/w1/regenerate',
      expect.objectContaining({ method: 'POST' }),
    )

    await synthApi.testWebhookSubscription('w1')
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/webhooks/w1/test',
      expect.objectContaining({ method: 'POST' }),
    )

    fetchMock.mockResolvedValue(jsonResponse({ deliveries: [] }))
    await synthApi.getWebhookDeliveries('w1', 7)
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/webhooks/w1/deliveries?limit=7',
      expect.objectContaining({}),
    )
  })

  it('service-keys: список/scopes/get/create/update/delete/revoke', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ keys: [] }))
    await synthApi.getServiceKeys()
    expect(fetchMock).toHaveBeenLastCalledWith('/api/v2/service-keys', expect.objectContaining({}))

    await synthApi.getServiceKeyScopes()
    expect(fetchMock).toHaveBeenLastCalledWith('/api/v2/service-keys/scopes', expect.objectContaining({}))

    await synthApi.getServiceKey('k/1')
    expect(fetchMock).toHaveBeenLastCalledWith('/api/v2/service-keys/k%2F1', expect.objectContaining({}))

    await synthApi.updateServiceKey('k1', { label: 'x' } as never)
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/service-keys/k1',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ label: 'x' }) }),
    )

    await synthApi.revokeServiceKey('k1')
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/service-keys/k1/revoke',
      expect.objectContaining({ method: 'POST' }),
    )

    await synthApi.deleteServiceKey('k1')
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/service-keys/k1',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })
})

describe('debugApi', () => {
  it('getDebugConfig / saveDebugConfig: GET и POST /admin/debug/config', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ groups: {}, available_levels: [] }))
    await synthApi.getDebugConfig()
    expect(fetchMock).toHaveBeenLastCalledWith('/api/v2/admin/debug/config', expect.objectContaining({}))

    const groups = { engine: 'debug' }
    await synthApi.saveDebugConfig(groups)
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v2/admin/debug/config',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ groups }) }),
    )
  })
})

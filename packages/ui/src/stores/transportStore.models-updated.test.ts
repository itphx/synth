import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Событие шины `models.updated` (каталог провайдеров/моделей изменился).
 *
 * Баг: «модель, добавленная/удалённая/сделанная дефолтной в другом клиенте, не
 * появляется в селекте модели чата». Событие публикуется в **инстансный** канал
 * шины (у каталога нет сессии), поэтому диспетчер обязан обработать его раньше
 * проверки `sid` — иначе `sessionId` события (`'instance'`/пусто/чужой)
 * отбрасывал бы его до стора.
 */
const apiMock = vi.hoisted(() => ({
  getModelGroups: vi.fn(),
  getProviders: vi.fn(),
  getAgents: vi.fn(async () => ({ agents: [], default_agent: 'assistant' })),
  getSession: vi.fn(async () => ({ id: 's1', messages: [] })),
  getProjects: vi.fn(async () => []),
  getProjectsPage: vi.fn(async () => ({
    projects: [],
    total: 0,
    offset: 0,
    limit: 100,
    next_offset: null,
  })),
}))

vi.mock('@/lib/api/synthApi', () => ({
  synthApi: apiMock,
  mergeModelGroups: vi.fn((prev: unknown) => prev),
}))

vi.mock('@/hooks/useNotification', () => ({
  notifyMessage: vi.fn(),
}))

import { createDispatcher } from './transportStore'
import { useProvidersStore } from './providersStore'
import type { WSEvent } from '@/lib/api/transport'

const dispatch = createDispatcher()

function makeEvent(type: string, data: Record<string, unknown>, sessionId?: string): WSEvent {
  return { type, ...(sessionId ? { session_id: sessionId } : {}), data } as WSEvent
}

beforeEach(() => {
  vi.clearAllMocks()
  apiMock.getModelGroups.mockResolvedValue({
    groups: [],
    page: { models: [], total: 0, offset: 0, limit: 500, next_offset: null },
  })
  apiMock.getProviders.mockResolvedValue({ providers: [], default_provider: '' })
  useProvidersStore.setState({
    providers: [],
    modelGroups: [],
    models: [],
    catalogModels: [],
    catalogLoading: false,
    catalogLoaded: false,
    modelsLoading: false,
    modelsError: null,
    loading: false,
    error: null,
    selectedProviderName: null,
    selectedModelName: null,
    revision: 0,
  })
})

describe('transportStore dispatcher: models.updated', () => {
  it('без sessionId: поднимает revision в сторе каталога', () => {
    dispatch(makeEvent('models.updated', { action: 'save', provider: 'itphx', modelId: 'm2' }))

    expect(useProvidersStore.getState().revision).toBe(1)
  })

  it('инстансный канал (`session_id: "instance"`) обрабатывается так же', () => {
    dispatch(makeEvent('models.updated', { action: 'delete', modelId: 'm2' }, 'instance'))

    expect(useProvidersStore.getState().revision).toBe(1)
  })

  it('чужой sessionId не мешает обработке (событие — не сессионное)', () => {
    dispatch(makeEvent('models.updated', { action: 'fetch' }, 'some-other-session'))

    expect(useProvidersStore.getState().revision).toBe(1)
  })

  it('каждое событие увеличивает revision (селект перечитывает каталог на любое изменение)', () => {
    dispatch(makeEvent('models.updated', { action: 'save' }, 'instance'))
    dispatch(makeEvent('models.updated', { action: 'default' }, 'instance'))

    expect(useProvidersStore.getState().revision).toBe(2)
  })

  it('загруженный каталог перечитывается по событию', async () => {
    apiMock.getModelGroups.mockResolvedValue({
      groups: [],
      page: {
        models: [
          { id: 'itphx/m1', name: 'm1', provider: 'itphx', enabled: true, isDefault: false },
        ],
        total: 1,
        offset: 0,
        limit: 500,
        next_offset: null,
      },
    })
    useProvidersStore.setState({ catalogLoaded: true, catalogModels: [] })

    dispatch(makeEvent('models.updated', { action: 'save' }, 'instance'))

    await vi.waitFor(() => {
      expect(useProvidersStore.getState().catalogModels.map((m) => m.name)).toEqual(['m1'])
    })
    // Guard не остался снятым: каталог снова считается загруженным.
    expect(useProvidersStore.getState().catalogLoaded).toBe(true)
  })
})

import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Событие шины `events.updated` (реестр приёма внешних событий изменился,
 * ADR-089).
 *
 * Баг: «привязка, её API-ключ или правило маршрутизации, созданные/изменённые/
 * удалённые в другом клиенте или соседней вкладке админки, видны в разделе
 * "События" только после перезагрузки страницы». Событие публикуется в
 * **инстансный** канал шины (реестр — ресурс инстанса, а не сессии), поэтому
 * диспетчер обязан обработать его раньше проверки `sid` — иначе `sessionId`
 * события (`'instance'`/пусто/чужой) отбрасывал бы его до стора.
 */
const apiMocks = vi.hoisted(() => ({
  listEventBindings: vi.fn(),
  getEventRoutes: vi.fn(),
  getEventBindingKeys: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({
  synthApi: {
    listEventBindings: apiMocks.listEventBindings,
    getEventRoutes: apiMocks.getEventRoutes,
    getEventBindingKeys: apiMocks.getEventBindingKeys,
    getSession: vi.fn().mockResolvedValue({ id: 's1', messages: [] }),
    getProjects: vi.fn().mockResolvedValue([]),
    getProjectsPage: vi.fn().mockResolvedValue({
      projects: [],
      total: 0,
      offset: 0,
      limit: 100,
      next_offset: null,
    }),
  },
}))

vi.mock('@/hooks/useNotification', () => ({
  notifyMessage: vi.fn(),
}))

import { createDispatcher } from './transportStore'
import { useEventsStore } from './eventsStore'
import type { WSEvent } from '@/lib/api/transport'

const dispatch = createDispatcher()

function makeEvent(type: string, data: Record<string, unknown>, sessionId?: string): WSEvent {
  return { type, ...(sessionId ? { session_id: sessionId } : {}), data } as WSEvent
}

describe('transportStore dispatcher: events.updated', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useEventsStore.setState({ revision: 0 })
  })

  it('без sessionId: поднимает revision в сторе реестра событий', () => {
    dispatch(makeEvent('events.updated', { action: 'binding.create', bindingId: 'bdg_1' }))

    expect(useEventsStore.getState().revision).toBe(1)
    // Стор — только сигнал: списки читают раздел и его секции, секретов в событии нет.
    expect(apiMocks.listEventBindings).not.toHaveBeenCalled()
    expect(apiMocks.getEventRoutes).not.toHaveBeenCalled()
    expect(apiMocks.getEventBindingKeys).not.toHaveBeenCalled()
  })

  it('инстансный канал (`session_id: "instance"`) обрабатывается так же', () => {
    dispatch(makeEvent('events.updated', { action: 'route.delete', routeId: 'rte_1' }, 'instance'))

    expect(useEventsStore.getState().revision).toBe(1)
  })

  it('чужой sessionId не мешает обработке (событие — не сессионное)', () => {
    dispatch(makeEvent('events.updated', { action: 'key.revoke', bindingId: 'bdg_1' }, 'some-other-session'))

    expect(useEventsStore.getState().revision).toBe(1)
  })

  it('все виды мутации инвалидируют реестр одинаково', () => {
    for (const action of [
      'binding.create',
      'binding.update',
      'binding.delete',
      'key.create',
      'key.update',
      'key.revoke',
      'key.delete',
      'route.create',
      'route.update',
      'route.delete',
    ]) {
      dispatch(makeEvent('events.updated', { action }, 'instance'))
    }

    expect(useEventsStore.getState().revision).toBe(10)
  })
})

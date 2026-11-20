import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Событие шины `dictionaries.updated` (словари классификации изменились,
 * ADR-034/ADR-035).
 *
 * Баг: «словарь, сохранённый или сброшенный в другом клиенте или соседней вкладке
 * настроек, виден в секции "Словари" только после перезагрузки страницы».
 * Событие публикуется в **инстансный** канал шины (словари — каталог инстанса,
 * а не ресурс сессии), поэтому диспетчер обязан обработать его раньше проверки
 * `sid` — иначе `sessionId` события (`'instance'`/пусто/чужой) отбрасывал бы его
 * до стора.
 */
const apiMocks = vi.hoisted(() => ({
  getDictionaries: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({
  synthApi: {
    getDictionaries: apiMocks.getDictionaries,
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
import { useDictionariesStore } from './dictionariesStore'
import type { WSEvent } from '@/lib/api/transport'

const dispatch = createDispatcher()

function makeEvent(type: string, data: Record<string, unknown>, sessionId?: string): WSEvent {
  return { type, ...(sessionId ? { session_id: sessionId } : {}), data } as WSEvent
}

describe('transportStore dispatcher: dictionaries.updated', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useDictionariesStore.setState({ revision: 0 })
  })

  it('без sessionId: поднимает revision в сторе словарей', () => {
    dispatch(makeEvent('dictionaries.updated', { action: 'save', category: 'coding', lang: 'ru' }))

    expect(useDictionariesStore.getState().revision).toBe(1)
    // Стор — только сигнал: список читает сама секция, содержимого в событии нет.
    expect(apiMocks.getDictionaries).not.toHaveBeenCalled()
  })

  it('инстансный канал (`session_id: "instance"`) обрабатывается так же', () => {
    dispatch(
      makeEvent('dictionaries.updated', { action: 'reset', category: 'coding', lang: 'ru' }, 'instance'),
    )

    expect(useDictionariesStore.getState().revision).toBe(1)
  })

  it('чужой sessionId не мешает обработке (событие — не сессионное)', () => {
    dispatch(makeEvent('dictionaries.updated', { action: 'save' }, 'some-other-session'))

    expect(useDictionariesStore.getState().revision).toBe(1)
  })

  it('сохранение и сброс инвалидируют список одинаково', () => {
    dispatch(makeEvent('dictionaries.updated', { action: 'save', category: 'coding', lang: 'en' }, 'instance'))
    dispatch(makeEvent('dictionaries.updated', { action: 'reset', category: 'coding', lang: 'en' }, 'instance'))

    expect(useDictionariesStore.getState().revision).toBe(2)
  })
})

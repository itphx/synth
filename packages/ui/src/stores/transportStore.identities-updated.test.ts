import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Событие шины `identities.updated` (идентичности пользователя изменились,
 * ADR-089).
 *
 * Баг: «идентичность, привязанная подтверждением кода в другой вкладке/на
 * другом устройстве, и отвязка в соседнем клиенте видны в панели профиля только
 * после перезагрузки страницы». Событие публикуется в **инстансный** канал шины
 * (у идентичностей нет сессии), поэтому диспетчер обязан обработать его раньше
 * проверки `sid`.
 */
const apiMocks = vi.hoisted(() => ({
  getMyIdentities: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({
  synthApi: {
    getMyIdentities: apiMocks.getMyIdentities,
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
import { useIdentitiesStore } from './identitiesStore'
import type { WSEvent } from '@/lib/api/transport'

const dispatch = createDispatcher()

function makeEvent(type: string, data: Record<string, unknown>, sessionId?: string): WSEvent {
  return { type, ...(sessionId ? { session_id: sessionId } : {}), data } as WSEvent
}

describe('transportStore dispatcher: identities.updated', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useIdentitiesStore.setState({ revision: 0 })
  })

  it('без sessionId: поднимает revision в сторе идентичностей', () => {
    dispatch(makeEvent('identities.updated', { action: 'claim' }))

    expect(useIdentitiesStore.getState().revision).toBe(1)
    // Стор — только сигнал: список читает панель профиля, идентификаторов в событии нет.
    expect(apiMocks.getMyIdentities).not.toHaveBeenCalled()
  })

  it('инстансный канал (`session_id: "instance"`) обрабатывается так же', () => {
    dispatch(makeEvent('identities.updated', { action: 'delete' }, 'instance'))

    expect(useIdentitiesStore.getState().revision).toBe(1)
  })

  it('чужой sessionId не мешает обработке (событие — не сессионное)', () => {
    dispatch(makeEvent('identities.updated', { action: 'claim' }, 'some-other-session'))

    expect(useIdentitiesStore.getState().revision).toBe(1)
  })

  it('claim и отвязка инвалидируют список одинаково', () => {
    dispatch(makeEvent('identities.updated', { action: 'claim' }, 'instance'))
    dispatch(makeEvent('identities.updated', { action: 'delete' }, 'instance'))

    expect(useIdentitiesStore.getState().revision).toBe(2)
  })
})

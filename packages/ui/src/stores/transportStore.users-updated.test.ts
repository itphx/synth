import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Событие шины `users.updated` (каталог пользователей инстанса изменился,
 * managed).
 *
 * Баг: «пользователь, созданный/отредактированный/удалённый во второй вкладке
 * админки, виден только после перезагрузки страницы». Событие публикуется в
 * **инстансный** канал шины (у каталога нет сессии), поэтому диспетчер обязан
 * обработать его раньше проверки `sid` — иначе `sessionId` события
 * (`'instance'`/пусто/чужой) отбрасывал бы его до стора.
 */
const apiMocks = vi.hoisted(() => ({
  getUsers: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({
  synthApi: {
    getUsers: apiMocks.getUsers,
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
import { useUsersStore } from './usersStore'
import type { WSEvent } from '@/lib/api/transport'

const dispatch = createDispatcher()

function makeEvent(type: string, data: Record<string, unknown>, sessionId?: string): WSEvent {
  return { type, ...(sessionId ? { session_id: sessionId } : {}), data } as WSEvent
}

describe('transportStore dispatcher: users.updated', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useUsersStore.setState({ revision: 0 })
  })

  it('без sessionId: поднимает revision в сторе каталога пользователей', () => {
    dispatch(makeEvent('users.updated', { action: 'create', userId: 'u-2' }))

    expect(useUsersStore.getState().revision).toBe(1)
    // Стор — только сигнал: каталог перечитывает сама панель «Пользователи».
    expect(apiMocks.getUsers).not.toHaveBeenCalled()
  })

  it('инстансный канал (`session_id: "instance"`) обрабатывается так же', () => {
    dispatch(makeEvent('users.updated', { action: 'update', userId: 'u-2' }, 'instance'))

    expect(useUsersStore.getState().revision).toBe(1)
  })

  it('чужой sessionId не мешает обработке (событие — не сессионное)', () => {
    dispatch(makeEvent('users.updated', { action: 'delete', userId: 'u-2' }, 'some-other-session'))

    expect(useUsersStore.getState().revision).toBe(1)
  })

  it('каждая мутация каталога (создание/изменение/удаление) инвалидирует список', () => {
    dispatch(makeEvent('users.updated', { action: 'create', userId: 'u-2' }, 'instance'))
    dispatch(makeEvent('users.updated', { action: 'update', userId: 'u-2' }, 'instance'))
    dispatch(makeEvent('users.updated', { action: 'delete', userId: 'u-2' }, 'instance'))

    expect(useUsersStore.getState().revision).toBe(3)
  })
})

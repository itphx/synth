import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Событие шины `credentials.updated` (слой внешних доступов инстанса изменился,
 * ADR-105).
 *
 * Баг: «доступ, выданный/отозванный/обновлённый в другом клиенте или соседней
 * вкладке, виден в разделе "Внешние доступы" только после перезагрузки
 * страницы». Событие публикуется в **инстансный** канал шины (у доступа нет
 * сессии), поэтому диспетчер обязан обработать его раньше проверки `sid` —
 * иначе `sessionId` события (`'instance'`/пусто/чужой) отбрасывал бы его до
 * стора.
 */
const apiMocks = vi.hoisted(() => ({
  getOAuthCredentials: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({
  synthApi: {
    getOAuthCredentials: apiMocks.getOAuthCredentials,
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
import { useCredentialsStore } from './credentialsStore'
import type { WSEvent } from '@/lib/api/transport'

const dispatch = createDispatcher()

function makeEvent(type: string, data: Record<string, unknown>, sessionId?: string): WSEvent {
  return { type, ...(sessionId ? { session_id: sessionId } : {}), data } as WSEvent
}

describe('transportStore dispatcher: credentials.updated', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useCredentialsStore.setState({ revision: 0 })
  })

  it('без sessionId: поднимает revision в сторе внешних доступов', () => {
    dispatch(makeEvent('credentials.updated', { action: 'save', provider: 'github' }))

    expect(useCredentialsStore.getState().revision).toBe(1)
    // Стор — только сигнал: список читает сам раздел, токенов в событии нет.
    expect(apiMocks.getOAuthCredentials).not.toHaveBeenCalled()
  })

  it('инстансный канал (`session_id: "instance"`) обрабатывается так же', () => {
    dispatch(makeEvent('credentials.updated', { action: 'delete', provider: 'github' }, 'instance'))

    expect(useCredentialsStore.getState().revision).toBe(1)
  })

  it('чужой sessionId не мешает обработке (событие — не сессионное)', () => {
    dispatch(makeEvent('credentials.updated', { action: 'refresh' }, 'some-other-session'))

    expect(useCredentialsStore.getState().revision).toBe(1)
  })

  it('обновление токена и привязка (`refresh`/`bind`) тоже инвалидируют список', () => {
    dispatch(makeEvent('credentials.updated', { action: 'refresh', provider: 'github' }, 'instance'))
    dispatch(makeEvent('credentials.updated', { action: 'bind', credentialId: 'cred1' }, 'instance'))

    expect(useCredentialsStore.getState().revision).toBe(2)
  })
})

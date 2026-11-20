import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useCredentialsStore } from './credentialsStore'

/**
 * Сигнал «слой внешних доступов изменился» (событие шины `credentials.updated`,
 * инстансный канал, ADR-105).
 *
 * Список доступов живёт в компоненте (`CredentialsSettings` грузит его своим
 * запросом `GET /oauth/credentials`), стору достаточно поднять `revision`.
 * Проверяем контракт: `applyEvent()` поднимает `revision` и больше ничего не
 * делает — ни запроса, ни копии списка (в событии нет и не должно быть токенов).
 *
 * Баг, ради которого сигнал появился: «доступ, выданный/отозванный в другом
 * клиенте, виден в разделе только после перезагрузки страницы».
 */
const apiMock = vi.hoisted(() => ({
  getOAuthCredentials: vi.fn(),
}))

// Стор не должен ходить в сеть сам — мок API доказывает именно это.
vi.mock('@/lib/api/synthApi', () => ({ synthApi: apiMock }))

describe('credentialsStore.applyEvent (событие `credentials.updated`)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useCredentialsStore.setState({ revision: 0 })
  })

  it('поднимает revision на единицу', () => {
    useCredentialsStore.getState().applyEvent()

    expect(useCredentialsStore.getState().revision).toBe(1)
  })

  it('каждое событие увеличивает revision (перечитывание на любую мутацию)', () => {
    const { applyEvent } = useCredentialsStore.getState()

    applyEvent()
    applyEvent()

    expect(useCredentialsStore.getState().revision).toBe(2)
  })

  it('состояние — только счётчик и метод (списка доступов в сторе нет)', () => {
    const before = useCredentialsStore.getState()

    useCredentialsStore.getState().applyEvent()

    const after = useCredentialsStore.getState()
    expect(Object.keys(after).sort()).toEqual(['applyEvent', 'revision'])
    expect(after.revision).toBe(before.revision + 1)
    expect(after.applyEvent).toBe(before.applyEvent)
  })

  it('в сеть не ходит: список перечитывает раздел «Внешние доступы»', () => {
    useCredentialsStore.getState().applyEvent()

    expect(apiMock.getOAuthCredentials).not.toHaveBeenCalled()
  })
})

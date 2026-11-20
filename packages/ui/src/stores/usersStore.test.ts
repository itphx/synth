import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useUsersStore } from './usersStore'

/**
 * Сигнал «каталог пользователей изменился» (событие шины `users.updated`,
 * инстансный канал, managed).
 *
 * Список пользователей живёт в компоненте (`UsersPanel` грузит его своим
 * запросом `GET /api/v2/users`), стору достаточно поднять `revision`.
 * Проверяем контракт: `applyEvent()` поднимает `revision` и больше ничего не
 * делает — ни запроса, ни копии каталога (ни почты, ни ролей, ни заметок в
 * событии нет по типу, инвариант 13).
 *
 * Баг, ради которого сигнал появился: «пользователь, созданный/отредактированный/
 * удалённый во второй вкладке админки, виден только после перезагрузки страницы».
 */
const apiMock = vi.hoisted(() => ({
  getUsers: vi.fn(),
}))

// Стор не должен ходить в сеть сам — мок API доказывает именно это.
vi.mock('@/lib/api/synthApi', () => ({ synthApi: apiMock }))

describe('usersStore.applyEvent (событие `users.updated`)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useUsersStore.setState({ revision: 0 })
  })

  it('поднимает revision на единицу', () => {
    useUsersStore.getState().applyEvent()

    expect(useUsersStore.getState().revision).toBe(1)
  })

  it('каждое событие увеличивает revision (перечитывание на любую мутацию)', () => {
    const { applyEvent } = useUsersStore.getState()

    applyEvent()
    applyEvent()

    expect(useUsersStore.getState().revision).toBe(2)
  })

  it('состояние — только счётчик и метод (каталога в сторе нет)', () => {
    const before = useUsersStore.getState()

    useUsersStore.getState().applyEvent()

    const after = useUsersStore.getState()
    expect(Object.keys(after).sort()).toEqual(['applyEvent', 'revision'])
    expect(after.revision).toBe(before.revision + 1)
    expect(after.applyEvent).toBe(before.applyEvent)
  })

  it('в сеть не ходит: каталог перечитывает панель «Пользователи»', () => {
    useUsersStore.getState().applyEvent()

    expect(apiMock.getUsers).not.toHaveBeenCalled()
  })
})

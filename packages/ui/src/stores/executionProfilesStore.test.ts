import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useExecutionProfilesStore } from './executionProfilesStore'

/**
 * Сигнал «каталог профилей исполнения изменился» (событие шины
 * `execution.updated`, инстансный канал, ADR-135).
 *
 * Стор намеренно держит только счётчик: сам каталог (`GET /execution/profiles`)
 * читают потребители своими запросами — раздел «Исполнение», селект профиля
 * агента (`AgentsPanel`), профиль проекта (`ProjectTab`) и профиль сессии
 * (`SessionSettingsTab`). Поэтому проверяем ровно контракт сигнала:
 * `applyEvent()` поднимает `revision` и больше ничего не делает.
 *
 * Баг, ради которого сигнал появился: «профиль, созданный в разделе
 * "Исполнение", не появляется в выпадающих списках до перезагрузки страницы».
 */
const apiMock = vi.hoisted(() => ({
  getExecutionProfiles: vi.fn(),
}))

// Стор не должен ходить в сеть сам (иначе на каждое событие — лишний `GET`):
// мок API нужен именно чтобы это доказать.
vi.mock('@/lib/api/synthApi', () => ({ synthApi: apiMock }))

describe('executionProfilesStore.applyEvent (событие `execution.updated`)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useExecutionProfilesStore.setState({ revision: 0 })
  })

  it('поднимает revision на единицу', () => {
    useExecutionProfilesStore.getState().applyEvent()

    expect(useExecutionProfilesStore.getState().revision).toBe(1)
  })

  it('каждое событие увеличивает revision (потребители реагируют на любое изменение)', () => {
    const { applyEvent } = useExecutionProfilesStore.getState()

    applyEvent()
    applyEvent()
    applyEvent()

    expect(useExecutionProfilesStore.getState().revision).toBe(3)
  })

  it('состояние — только счётчик и метод (дубля каталога в сторе нет)', () => {
    const before = useExecutionProfilesStore.getState()

    useExecutionProfilesStore.getState().applyEvent()

    const after = useExecutionProfilesStore.getState()
    // Своего `profiles`/`loading`/`error` у стора нет намеренно: он разошёлся бы
    // с локальными состояниями панелей и дал бы лишний `GET` на каждое событие.
    expect(Object.keys(after).sort()).toEqual(['applyEvent', 'revision'])
    expect(after.revision).toBe(before.revision + 1)
    // Ссылка на метод не пересоздаётся — эффекты потребителей не дёргаются зря.
    expect(after.applyEvent).toBe(before.applyEvent)
  })

  it('в сеть не ходит: каталог перечитывают потребители своим запросом', () => {
    useExecutionProfilesStore.getState().applyEvent()

    expect(apiMock.getExecutionProfiles).not.toHaveBeenCalled()
  })
})

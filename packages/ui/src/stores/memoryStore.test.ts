import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useMemoryStore } from './memoryStore'

/**
 * Сигнал «память инстанса изменилась» (событие шины `memory.updated`,
 * инстансный канал, ADR-107).
 *
 * Три среза портала (статус, факты, индексы) живут в компоненте
 * (`MemorySettings` грузит их своими запросами `GET /memory/status|facts|indexes`),
 * стору достаточно поднять `revision`. Проверяем контракт: `applyEvent()`
 * поднимает `revision` и больше ничего не делает — ни запроса, ни копии списка
 * (в событии нет ни текста фактов, ни эмбеддингов).
 *
 * Баг, ради которого сигнал появился: «факт, записанный агентом через плагин
 * памяти, и индекс, созданный другим админом, видны в разделе „Память“ только
 * после перезагрузки страницы».
 */
const apiMock = vi.hoisted(() => ({
  getMemoryStatus: vi.fn(),
  listMemoryFacts: vi.fn(),
  listMemoryIndexes: vi.fn(),
}))

// Стор не должен ходить в сеть сам — мок API доказывает именно это.
vi.mock('@/lib/api/synthApi', () => ({ synthApi: apiMock }))

describe('memoryStore.applyEvent (событие `memory.updated`)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useMemoryStore.setState({ revision: 0 })
  })

  it('поднимает revision на единицу', () => {
    useMemoryStore.getState().applyEvent()

    expect(useMemoryStore.getState().revision).toBe(1)
  })

  it('каждое событие увеличивает revision (перечитывание на любую мутацию)', () => {
    const { applyEvent } = useMemoryStore.getState()

    applyEvent()
    applyEvent()

    expect(useMemoryStore.getState().revision).toBe(2)
  })

  it('состояние — только счётчик и метод (срезов портала в сторе нет)', () => {
    const before = useMemoryStore.getState()

    useMemoryStore.getState().applyEvent()

    const after = useMemoryStore.getState()
    expect(Object.keys(after).sort()).toEqual(['applyEvent', 'revision'])
    expect(after.revision).toBe(before.revision + 1)
    expect(after.applyEvent).toBe(before.applyEvent)
  })

  it('в сеть не ходит: срезы перечитывает раздел «Память»', () => {
    useMemoryStore.getState().applyEvent()

    expect(apiMock.getMemoryStatus).not.toHaveBeenCalled()
    expect(apiMock.listMemoryFacts).not.toHaveBeenCalled()
    expect(apiMock.listMemoryIndexes).not.toHaveBeenCalled()
  })
})

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useDictionariesStore } from './dictionariesStore'

/**
 * Сигнал «словари классификации изменились» (событие шины
 * `dictionaries.updated`, инстансный канал, ADR-034/ADR-035).
 *
 * Список словарей живёт в компоненте (`DictionarySection` внутри
 * `RoutingSettings` грузит его своим запросом `GET /api/v2/dictionaries`), стору
 * достаточно поднять `revision`. Проверяем контракт: `applyEvent()` поднимает
 * `revision` и больше ничего не делает — ни запроса, ни копии списка
 * (содержимого словаря в событии нет по типу).
 *
 * Баг, ради которого сигнал появился: «словарь, сохранённый или сброшенный во
 * второй вкладке настроек, виден только после перезагрузки страницы».
 */
const apiMock = vi.hoisted(() => ({
  getDictionaries: vi.fn(),
}))

// Стор не должен ходить в сеть сам — мок API доказывает именно это.
vi.mock('@/lib/api/synthApi', () => ({ synthApi: apiMock }))

describe('dictionariesStore.applyEvent (событие `dictionaries.updated`)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useDictionariesStore.setState({ revision: 0 })
  })

  it('поднимает revision на единицу', () => {
    useDictionariesStore.getState().applyEvent()

    expect(useDictionariesStore.getState().revision).toBe(1)
  })

  it('каждое событие увеличивает revision (и `save`, и `reset`)', () => {
    const { applyEvent } = useDictionariesStore.getState()

    applyEvent()
    applyEvent()

    expect(useDictionariesStore.getState().revision).toBe(2)
  })

  it('состояние — только счётчик и метод (списка словарей в сторе нет)', () => {
    const before = useDictionariesStore.getState()

    useDictionariesStore.getState().applyEvent()

    const after = useDictionariesStore.getState()
    expect(Object.keys(after).sort()).toEqual(['applyEvent', 'revision'])
    expect(after.revision).toBe(before.revision + 1)
    expect(after.applyEvent).toBe(before.applyEvent)
  })

  it('в сеть не ходит: список перечитывает секция «Словари»', () => {
    useDictionariesStore.getState().applyEvent()

    expect(apiMock.getDictionaries).not.toHaveBeenCalled()
  })
})

import { describe, it, expect, beforeEach } from 'vitest'
import { useEventsStore } from './eventsStore'

/**
 * Сигнал «реестр приёма внешних событий изменился» (событие шины
 * `events.updated`, инстансный канал, ADR-089).
 *
 * Списки живут в компонентах: раздел «События» (`EventsAdminSettings`) грузит
 * привязки (`GET /api/v2/events/bindings`), секция правил
 * (`EventRoutesSection`) — правила (`GET /api/v2/events/routes`), карточка
 * привязки (`EventBindingKeys`) — метаданные ключей
 * (`GET /api/v2/events/bindings/:id/keys`). Стору достаточно поднять
 * `revision`. Проверяем контракт: `applyEvent()` поднимает `revision` и больше
 * ничего не делает — ни запроса, ни копии реестра (секрета ключа в событии нет).
 *
 * Баг, ради которого сигнал появился: «привязка, её ключ или правило,
 * созданные/удалённые во второй вкладке админки, видны только после
 * перезагрузки страницы», а отозванный ключ продолжал выглядеть активным.
 */
describe('eventsStore.applyEvent (событие `events.updated`)', () => {
  beforeEach(() => {
    useEventsStore.setState({ revision: 0 })
  })

  it('поднимает revision на единицу', () => {
    useEventsStore.getState().applyEvent()

    expect(useEventsStore.getState().revision).toBe(1)
  })

  it('каждое событие увеличивает revision (привязки, ключи, правила одинаково)', () => {
    const { applyEvent } = useEventsStore.getState()

    applyEvent()
    applyEvent()
    applyEvent()

    expect(useEventsStore.getState().revision).toBe(3)
  })

  it('состояние — только счётчик и метод (списков и ключей в сторе нет)', () => {
    const before = useEventsStore.getState()

    useEventsStore.getState().applyEvent()

    const after = useEventsStore.getState()
    expect(Object.keys(after).sort()).toEqual(['applyEvent', 'revision'])
    expect(after.revision).toBe(before.revision + 1)
    expect(after.applyEvent).toBe(before.applyEvent)
  })
})

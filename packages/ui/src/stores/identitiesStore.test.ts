import { describe, it, expect, beforeEach } from 'vitest'
import { useIdentitiesStore } from './identitiesStore'

/**
 * Сигнал «идентичности пользователя изменились» (событие шины
 * `identities.updated`, инстансный канал, ADR-089).
 *
 * Список живёт в панели профиля (`ProfileSettings`): она грузит его своим
 * запросом `GET /api/v2/me/identities`. Стору достаточно поднять `revision`.
 * Проверяем контракт: `applyEvent()` поднимает `revision` и больше ничего не
 * делает — ни запроса, ни копии списка (идентификаторов в событии нет по типу:
 * `provider`/`externalId` — персональные данные).
 *
 * Баг, ради которого сигнал появился: «идентичность, привязанная
 * подтверждением кода в другой вкладке, и отвязка в соседнем клиенте видны в
 * профиле только после перезагрузки страницы».
 */
describe('identitiesStore.applyEvent (событие `identities.updated`)', () => {
  beforeEach(() => {
    useIdentitiesStore.setState({ revision: 0 })
  })

  it('поднимает revision на единицу', () => {
    useIdentitiesStore.getState().applyEvent()

    expect(useIdentitiesStore.getState().revision).toBe(1)
  })

  it('каждое событие увеличивает revision (claim и отвязка одинаково)', () => {
    const { applyEvent } = useIdentitiesStore.getState()

    applyEvent()
    applyEvent()

    expect(useIdentitiesStore.getState().revision).toBe(2)
  })

  it('состояние — только счётчик и метод (списка идентичностей в сторе нет)', () => {
    const before = useIdentitiesStore.getState()

    useIdentitiesStore.getState().applyEvent()

    const after = useIdentitiesStore.getState()
    expect(Object.keys(after).sort()).toEqual(['applyEvent', 'revision'])
    expect(after.revision).toBe(before.revision + 1)
    expect(after.applyEvent).toBe(before.applyEvent)
  })
})

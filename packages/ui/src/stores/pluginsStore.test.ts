import { describe, it, expect, beforeEach } from 'vitest'
import { usePluginsStore } from './pluginsStore'

/**
 * Сигнал «реестр плагинов изменился» (событие шины `plugins.updated`,
 * инстансный канал, ADR-090).
 *
 * Список плагинов и снимок политики живут в компоненте (`PluginsSettings`
 * грузит их запросами `GET /api/v2/plugins` и `GET /api/v2/settings/plugins`),
 * стору достаточно поднять `revision`. Проверяем контракт: `applyEvent()`
 * поднимает `revision` и больше ничего не делает — ни запроса, ни копии
 * реестра (токенов и ключей в событии нет по типу, инвариант 13).
 *
 * Баг, ради которого сигнал появился: «плагин, включённый/снятый в другом
 * клиенте или из CLI, виден в разделе "Плагины" только после перезагрузки
 * страницы»; смена политики слоя (`action: 'policy'`) — тот же симптом.
 */
describe('pluginsStore.applyEvent (событие `plugins.updated`)', () => {
  beforeEach(() => {
    usePluginsStore.setState({ revision: 0 })
  })

  it('поднимает revision на единицу', () => {
    usePluginsStore.getState().applyEvent()

    expect(usePluginsStore.getState().revision).toBe(1)
  })

  it('каждое событие увеличивает revision (список и политика читаются заново)', () => {
    const { applyEvent } = usePluginsStore.getState()

    applyEvent()
    applyEvent()

    expect(usePluginsStore.getState().revision).toBe(2)
  })

  it('состояние — только счётчик и метод (реестра плагинов в сторе нет)', () => {
    const before = usePluginsStore.getState()

    usePluginsStore.getState().applyEvent()

    const after = usePluginsStore.getState()
    expect(Object.keys(after).sort()).toEqual(['applyEvent', 'revision'])
    expect(after.revision).toBe(before.revision + 1)
    expect(after.applyEvent).toBe(before.applyEvent)
  })
})

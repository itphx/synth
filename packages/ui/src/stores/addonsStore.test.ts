import { describe, it, expect, beforeEach } from 'vitest'
import { useAddonsStore } from './addonsStore'

/**
 * Сигнал «реестр пакетов расширений изменился» (событие шины `packs.updated`,
 * инстансный канал, ADR-086 §5).
 *
 * Реестр установок живёт в компоненте (`AddonsSettings` грузит его своим
 * запросом `GET /api/v2/packs`), стору достаточно поднять `revision`.
 * Проверяем контракт: `applyEvent()` поднимает `revision` и больше ничего не
 * делает — ни запроса, ни копии реестра (манифеста в событии нет).
 *
 * Баг, ради которого сигнал появился: «пакет, установленный/снятый в другом
 * клиенте или из CLI, виден в разделе "Аддоны" только после перезагрузки
 * страницы».
 */
describe('addonsStore.applyEvent (событие `packs.updated`)', () => {
  beforeEach(() => {
    useAddonsStore.setState({ revision: 0 })
  })

  it('поднимает revision на единицу', () => {
    useAddonsStore.getState().applyEvent()

    expect(useAddonsStore.getState().revision).toBe(1)
  })

  it('каждое событие увеличивает revision (перечитывание на любую мутацию)', () => {
    const { applyEvent } = useAddonsStore.getState()

    applyEvent()
    applyEvent()
    applyEvent()

    expect(useAddonsStore.getState().revision).toBe(3)
  })

  it('состояние — только счётчик и метод (реестра пакетов в сторе нет)', () => {
    const before = useAddonsStore.getState()

    useAddonsStore.getState().applyEvent()

    const after = useAddonsStore.getState()
    expect(Object.keys(after).sort()).toEqual(['applyEvent', 'revision'])
    expect(after.revision).toBe(before.revision + 1)
    expect(after.applyEvent).toBe(before.applyEvent)
  })
})

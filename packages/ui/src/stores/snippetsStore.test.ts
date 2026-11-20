import { describe, it, expect, beforeEach } from 'vitest'
import { useSnippetsStore } from './snippetsStore'

/**
 * Сигнал «реестр сниппетов изменился» (событие шины `snippets.updated`,
 * инстансный канал, ADR-126 §4).
 *
 * Списки сниппетов живут в компонентах: редактор уровня
 * (`SnippetScopeEditor` — настройки, админ-раздел, панель проекта) и `#`-пикер
 * композера (`SnippetAutocomplete`) грузят их своим запросом
 * `GET /api/v2/snippets`. Стору достаточно поднять `revision`. Проверяем
 * контракт: `applyEvent()` поднимает `revision` и больше ничего не делает — ни
 * запроса, ни копии реестра (текста сниппета в событии нет).
 *
 * Баг, ради которого сигнал появился: «создал сниппет в настройках — а в
 * подсказках композера и в панели проекта его нет, пока не перезагрузишь
 * страницу».
 */
describe('snippetsStore.applyEvent (событие `snippets.updated`)', () => {
  beforeEach(() => {
    useSnippetsStore.setState({ revision: 0 })
  })

  it('поднимает revision на единицу', () => {
    useSnippetsStore.getState().applyEvent()

    expect(useSnippetsStore.getState().revision).toBe(1)
  })

  it('каждое событие увеличивает revision (create/update/delete одинаково)', () => {
    const { applyEvent } = useSnippetsStore.getState()

    applyEvent()
    applyEvent()
    applyEvent()

    expect(useSnippetsStore.getState().revision).toBe(3)
  })

  it('состояние — только счётчик и метод (списка сниппетов в сторе нет)', () => {
    const before = useSnippetsStore.getState()

    useSnippetsStore.getState().applyEvent()

    const after = useSnippetsStore.getState()
    expect(Object.keys(after).sort()).toEqual(['applyEvent', 'revision'])
    expect(after.revision).toBe(before.revision + 1)
    expect(after.applyEvent).toBe(before.applyEvent)
  })
})

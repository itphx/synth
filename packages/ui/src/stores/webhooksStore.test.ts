import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useWebhooksStore } from './webhooksStore'

/**
 * Сигнал «реестр webhooks инстанса изменился» (событие шины `webhooks.updated`,
 * инстансный канал, ADR-052 этап II).
 *
 * Список подписок живёт в компоненте (`WebhooksSettings` грузит его своим
 * запросом `GET /api/v2/webhooks`), стору достаточно поднять `revision`.
 * Проверяем контракт: `applyEvent()` поднимает `revision` и больше ничего не
 * делает — ни запроса, ни копии списка (в событии нет и не должно быть
 * signing-секрета и целевого URL).
 *
 * Баг, ради которого сигнал появился: «подписка, созданная/изменённая/удалённая
 * во второй вкладке админки, видна в разделе только после перезагрузки
 * страницы».
 */
const apiMock = vi.hoisted(() => ({
  getWebhookSubscriptions: vi.fn(),
}))

// Стор не должен ходить в сеть сам — мок API доказывает именно это.
vi.mock('@/lib/api/synthApi', () => ({ synthApi: apiMock }))

describe('webhooksStore.applyEvent (событие `webhooks.updated`)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useWebhooksStore.setState({ revision: 0 })
  })

  it('поднимает revision на единицу', () => {
    useWebhooksStore.getState().applyEvent()

    expect(useWebhooksStore.getState().revision).toBe(1)
  })

  it('каждое событие увеличивает revision (перечитывание на любую мутацию)', () => {
    const { applyEvent } = useWebhooksStore.getState()

    applyEvent()
    applyEvent()

    expect(useWebhooksStore.getState().revision).toBe(2)
  })

  it('состояние — только счётчик и метод (списка подписок в сторе нет)', () => {
    const before = useWebhooksStore.getState()

    useWebhooksStore.getState().applyEvent()

    const after = useWebhooksStore.getState()
    expect(Object.keys(after).sort()).toEqual(['applyEvent', 'revision'])
    expect(after.revision).toBe(before.revision + 1)
    expect(after.applyEvent).toBe(before.applyEvent)
  })

  it('в сеть не ходит: список перечитывает раздел «Webhooks»', () => {
    useWebhooksStore.getState().applyEvent()

    expect(apiMock.getWebhookSubscriptions).not.toHaveBeenCalled()
  })
})

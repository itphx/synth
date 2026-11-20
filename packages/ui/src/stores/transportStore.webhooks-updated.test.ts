import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Событие шины `webhooks.updated` (реестр подписок инстанса изменился,
 * ADR-052 этап II).
 *
 * Баг: «подписка, созданная/изменённая/удалённая в другом клиенте или соседней
 * вкладке админки, видна в разделе "Webhooks" только после перезагрузки
 * страницы». Событие публикуется в **инстансный** канал шины (у подписки нет
 * сессии), поэтому диспетчер обязан обработать его раньше проверки `sid` —
 * иначе `sessionId` события (`'instance'`/пусто/чужой) отбрасывал бы его до
 * стора.
 */
const apiMocks = vi.hoisted(() => ({
  getWebhookSubscriptions: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({
  synthApi: {
    getWebhookSubscriptions: apiMocks.getWebhookSubscriptions,
    getSession: vi.fn().mockResolvedValue({ id: 's1', messages: [] }),
    getProjects: vi.fn().mockResolvedValue([]),
    getProjectsPage: vi.fn().mockResolvedValue({
      projects: [],
      total: 0,
      offset: 0,
      limit: 100,
      next_offset: null,
    }),
  },
}))

vi.mock('@/hooks/useNotification', () => ({
  notifyMessage: vi.fn(),
}))

import { createDispatcher } from './transportStore'
import { useWebhooksStore } from './webhooksStore'
import type { WSEvent } from '@/lib/api/transport'

const dispatch = createDispatcher()

function makeEvent(type: string, data: Record<string, unknown>, sessionId?: string): WSEvent {
  return { type, ...(sessionId ? { session_id: sessionId } : {}), data } as WSEvent
}

describe('transportStore dispatcher: webhooks.updated', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useWebhooksStore.setState({ revision: 0 })
  })

  it('без sessionId: поднимает revision в сторе webhooks', () => {
    dispatch(makeEvent('webhooks.updated', { action: 'create', subscriptionId: 'whk_1' }))

    expect(useWebhooksStore.getState().revision).toBe(1)
    // Стор — только сигнал: список читает сам раздел, секретов в событии нет.
    expect(apiMocks.getWebhookSubscriptions).not.toHaveBeenCalled()
  })

  it('инстансный канал (`session_id: "instance"`) обрабатывается так же', () => {
    dispatch(makeEvent('webhooks.updated', { action: 'delete', subscriptionId: 'whk_1' }, 'instance'))

    expect(useWebhooksStore.getState().revision).toBe(1)
  })

  it('чужой sessionId не мешает обработке (событие — не сессионное)', () => {
    dispatch(makeEvent('webhooks.updated', { action: 'update' }, 'some-other-session'))

    expect(useWebhooksStore.getState().revision).toBe(1)
  })

  it('ротация секрета, гашение подписки и тестовая доставка тоже инвалидируют список', () => {
    dispatch(makeEvent('webhooks.updated', { action: 'regenerate', subscriptionId: 'whk_1' }, 'instance'))
    dispatch(makeEvent('webhooks.updated', { action: 'revoke', subscriptionId: 'whk_1' }, 'instance'))
    dispatch(makeEvent('webhooks.updated', { action: 'test', subscriptionId: 'whk_1' }, 'instance'))

    expect(useWebhooksStore.getState().revision).toBe(3)
  })
})

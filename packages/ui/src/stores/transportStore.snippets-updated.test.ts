import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Событие шины `snippets.updated` (реестр сниппетов изменился, ADR-126 §4).
 *
 * Баг: «создал/удалил сниппет в настройках — а в `#`-пикере композера и в
 * панели проекта его нет, пока не перезагрузишь страницу». Событие публикуется
 * в **инстансный** канал шины (сниппет — ресурс инстанса/проекта, а не
 * сессии), поэтому диспетчер обязан обработать его раньше проверки `sid`.
 */
const apiMocks = vi.hoisted(() => ({
  listSnippets: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({
  synthApi: {
    listSnippets: apiMocks.listSnippets,
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
import { useSnippetsStore } from './snippetsStore'
import type { WSEvent } from '@/lib/api/transport'

const dispatch = createDispatcher()

function makeEvent(type: string, data: Record<string, unknown>, sessionId?: string): WSEvent {
  return { type, ...(sessionId ? { session_id: sessionId } : {}), data } as WSEvent
}

describe('transportStore dispatcher: snippets.updated', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useSnippetsStore.setState({ revision: 0 })
  })

  it('без sessionId: поднимает revision в сторе сниппетов', () => {
    dispatch(makeEvent('snippets.updated', { action: 'create', snippetId: 'signoff' }))

    expect(useSnippetsStore.getState().revision).toBe(1)
    // Стор — только сигнал: списки читают редактор и пикер, текста в событии нет.
    expect(apiMocks.listSnippets).not.toHaveBeenCalled()
  })

  it('инстансный канал (`session_id: "instance"`) обрабатывается так же', () => {
    dispatch(makeEvent('snippets.updated', { action: 'delete', snippetId: 'signoff' }, 'instance'))

    expect(useSnippetsStore.getState().revision).toBe(1)
  })

  it('чужой sessionId не мешает обработке (событие — не сессионное)', () => {
    dispatch(makeEvent('snippets.updated', { action: 'update' }, 'some-other-session'))

    expect(useSnippetsStore.getState().revision).toBe(1)
  })

  it('create/update/delete инвалидируют реестр одинаково', () => {
    dispatch(makeEvent('snippets.updated', { action: 'create', snippetId: 'a' }, 'instance'))
    dispatch(makeEvent('snippets.updated', { action: 'update', snippetId: 'a' }, 'instance'))
    dispatch(makeEvent('snippets.updated', { action: 'delete', snippetId: 'a' }, 'instance'))

    expect(useSnippetsStore.getState().revision).toBe(3)
  })
})

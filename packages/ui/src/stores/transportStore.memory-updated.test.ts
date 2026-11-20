import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Событие шины `memory.updated` (память инстанса изменилась, ADR-107).
 *
 * Баг: «факт, записанный агентом через плагин памяти, и индекс, созданный
 * другим админом, видны в разделе „Память“ только после перезагрузки
 * страницы». Событие публикуется в **инстансный** канал шины (у памяти нет
 * сессии), поэтому диспетчер обязан обработать его раньше проверки `sid` —
 * иначе `sessionId` события (`'instance'`/пусто/чужой) отбрасывал бы его до
 * стора.
 */
const apiMocks = vi.hoisted(() => ({
  getMemoryStatus: vi.fn(),
  listMemoryFacts: vi.fn(),
  listMemoryIndexes: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({
  synthApi: {
    getMemoryStatus: apiMocks.getMemoryStatus,
    listMemoryFacts: apiMocks.listMemoryFacts,
    listMemoryIndexes: apiMocks.listMemoryIndexes,
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
import { useMemoryStore } from './memoryStore'
import type { WSEvent } from '@/lib/api/transport'

const dispatch = createDispatcher()

function makeEvent(type: string, data: Record<string, unknown>, sessionId?: string): WSEvent {
  return { type, ...(sessionId ? { session_id: sessionId } : {}), data } as WSEvent
}

describe('transportStore dispatcher: memory.updated', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useMemoryStore.setState({ revision: 0 })
  })

  it('без sessionId: поднимает revision в сторе памяти', () => {
    dispatch(makeEvent('memory.updated', { action: 'fact.write', scope: 'project', id: 'fact-1' }))

    expect(useMemoryStore.getState().revision).toBe(1)
    // Стор — только сигнал: срезы портала читает сам раздел «Память».
    expect(apiMocks.getMemoryStatus).not.toHaveBeenCalled()
    expect(apiMocks.listMemoryFacts).not.toHaveBeenCalled()
    expect(apiMocks.listMemoryIndexes).not.toHaveBeenCalled()
  })

  it('инстансный канал (`session_id: "instance"`) обрабатывается так же', () => {
    dispatch(
      makeEvent('memory.updated', { action: 'index.rebuild', scope: 'instance', id: 'idx-1' }, 'instance'),
    )

    expect(useMemoryStore.getState().revision).toBe(1)
  })

  it('чужой sessionId не мешает обработке (событие — не сессионное)', () => {
    dispatch(makeEvent('memory.updated', { action: 'index.delete', id: 'idx-1' }, 'some-other-session'))

    expect(useMemoryStore.getState().revision).toBe(1)
  })

  it('каждая мутация (факт и индекс) инвалидирует раздел', () => {
    dispatch(makeEvent('memory.updated', { action: 'fact.write', id: 'fact-1' }, 'instance'))
    dispatch(makeEvent('memory.updated', { action: 'index.create', id: 'idx-2' }, 'instance'))

    expect(useMemoryStore.getState().revision).toBe(2)
  })
})

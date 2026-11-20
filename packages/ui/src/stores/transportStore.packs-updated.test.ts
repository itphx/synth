import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Событие шины `packs.updated` (реестр пакетов расширений изменился,
 * ADR-086 §5).
 *
 * Баг: «пакет, установленный/одобренный/снятый в другом клиенте, соседней
 * вкладке или из CLI, виден в разделе "Аддоны" только после перезагрузки
 * страницы». Событие публикуется в **инстансный** канал шины (у пакета нет
 * сессии), поэтому диспетчер обязан обработать его раньше проверки `sid` —
 * иначе `sessionId` события (`'instance'`/пусто/чужой) отбрасывал бы его до
 * стора.
 */
const apiMocks = vi.hoisted(() => ({
  getPacks: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({
  synthApi: {
    getPacks: apiMocks.getPacks,
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
import { useAddonsStore } from './addonsStore'
import type { WSEvent } from '@/lib/api/transport'

const dispatch = createDispatcher()

function makeEvent(type: string, data: Record<string, unknown>, sessionId?: string): WSEvent {
  return { type, ...(sessionId ? { session_id: sessionId } : {}), data } as WSEvent
}

describe('transportStore dispatcher: packs.updated', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useAddonsStore.setState({ revision: 0 })
  })

  it('без sessionId: поднимает revision в сторе пакетов расширений', () => {
    dispatch(makeEvent('packs.updated', { action: 'install', packName: 'synth-media' }))

    expect(useAddonsStore.getState().revision).toBe(1)
    // Стор — только сигнал: реестр читает сам раздел, манифеста в событии нет.
    expect(apiMocks.getPacks).not.toHaveBeenCalled()
  })

  it('инстансный канал (`session_id: "instance"`) обрабатывается так же', () => {
    dispatch(makeEvent('packs.updated', { action: 'uninstall', packName: 'synth-media' }, 'instance'))

    expect(useAddonsStore.getState().revision).toBe(1)
  })

  it('чужой sessionId не мешает обработке (событие — не сессионное)', () => {
    dispatch(makeEvent('packs.updated', { action: 'approve' }, 'some-other-session'))

    expect(useAddonsStore.getState().revision).toBe(1)
  })

  it('установка, одобрение и снятие инвалидируют реестр одинаково', () => {
    dispatch(makeEvent('packs.updated', { action: 'install', packName: 'a' }, 'instance'))
    dispatch(makeEvent('packs.updated', { action: 'approve', packName: 'a' }, 'instance'))
    dispatch(makeEvent('packs.updated', { action: 'uninstall', packName: 'a' }, 'instance'))

    expect(useAddonsStore.getState().revision).toBe(3)
  })
})

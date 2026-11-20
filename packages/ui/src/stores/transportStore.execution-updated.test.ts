import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Событие шины `execution.updated` (каталог профилей исполнения изменился,
 * ADR-135).
 *
 * Баг: «профиль, созданный/переименованный в разделе "Исполнение" (или пул,
 * слитый в админке), не появляется в селекте профиля агента/проекта/сессии до
 * перезагрузки страницы». Событие публикуется в **инстансный** канал шины (у
 * каталога профилей нет сессии), поэтому диспетчер обязан обработать его раньше
 * проверки `sid` — иначе `sessionId` события (`'instance'`/пусто/чужой)
 * отбрасывал бы его до стора.
 */
const apiMocks = vi.hoisted(() => ({
  getExecutionProfiles: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({
  synthApi: {
    getExecutionProfiles: apiMocks.getExecutionProfiles,
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
import { useExecutionProfilesStore } from './executionProfilesStore'
import type { WSEvent } from '@/lib/api/transport'

const dispatch = createDispatcher()

function makeEvent(type: string, data: Record<string, unknown>, sessionId?: string): WSEvent {
  return { type, ...(sessionId ? { session_id: sessionId } : {}), data } as WSEvent
}

describe('transportStore dispatcher: execution.updated', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useExecutionProfilesStore.setState({ revision: 0 })
  })

  it('без sessionId: поднимает revision в сторе каталога профилей', () => {
    dispatch(makeEvent('execution.updated', { action: 'profile.save', profileId: 'gpu' }))

    expect(useExecutionProfilesStore.getState().revision).toBe(1)
    // Стор — только сигнал: сам он каталог не читает (это делают потребители).
    expect(apiMocks.getExecutionProfiles).not.toHaveBeenCalled()
  })

  it('инстансный канал (`session_id: "instance"`) обрабатывается так же', () => {
    dispatch(makeEvent('execution.updated', { action: 'profile.delete', profileId: 'gpu' }, 'instance'))

    expect(useExecutionProfilesStore.getState().revision).toBe(1)
  })

  it('чужой sessionId не мешает обработке (событие — не сессионное)', () => {
    dispatch(makeEvent('execution.updated', { action: 'profile.reset' }, 'some-other-session'))

    expect(useExecutionProfilesStore.getState().revision).toBe(1)
  })

  it('изменение пула (`poolName`) тоже инвалидирует каталог', () => {
    dispatch(makeEvent('execution.updated', { action: 'pool.delete', poolName: 'docker' }, 'instance'))

    expect(useExecutionProfilesStore.getState().revision).toBe(1)
  })

  it('каждое событие увеличивает revision (каталог перечитывается на любое изменение)', () => {
    dispatch(makeEvent('execution.updated', { action: 'profile.save' }, 'instance'))
    dispatch(makeEvent('execution.updated', { action: 'pool.save' }, 'instance'))

    expect(useExecutionProfilesStore.getState().revision).toBe(2)
  })
})

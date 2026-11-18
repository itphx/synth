// ADR-111 §detach: общий шов перевода в фон — исходы ответа сервера.
//
// Проверяем три исхода `POST /sessions/:id/background`: полный успех, частичный
// отказ (переведено N, не удалось M) и полный отказ (`DETACH_FAILED`, лимит) —
// в последнем случае live-парты из хода не снимаются, а шов отдаёт `null`.

import { describe, it, expect, beforeEach, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  backgroundSession: vi.fn(),
  notifyMessage: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({
  synthApi: { backgroundSession: mocks.backgroundSession },
}))
vi.mock('@/hooks/useNotification', () => ({
  notifyMessage: mocks.notifyMessage,
}))

import { moveSessionToBackground } from './backgroundDetach'
import { useI18nStore } from './i18n'
import { dict as enDict } from './i18n/messages/en'
import { useChatStore } from '@/stores/chatStore'

const notify = mocks.notifyMessage

/** Тело последнего уведомления. */
function lastNotification(): Record<string, unknown> {
  const calls = notify.mock.calls
  return (calls[calls.length - 1]?.[0] ?? {}) as Record<string, unknown>
}

describe('moveSessionToBackground: ответы сервера (ADR-111 §detach)', () => {
  const dropDetachedToolCalls = vi.fn()

  beforeEach(() => {
    mocks.backgroundSession.mockReset()
    notify.mockReset()
    dropDetachedToolCalls.mockReset()
    useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
    useChatStore.setState({ dropDetachedToolCalls })
  })

  it('полный успех — success-тост с количеством, live-парты сняты', async () => {
    mocks.backgroundSession.mockResolvedValue({
      sessionId: 's1',
      detached: [
        { id: 'blk_1', kind: 'process' },
        { id: 'blk_2', kind: 'subagent' },
      ],
    })

    const response = await moveSessionToBackground('s1', { callIds: ['call-1'] })

    expect(response?.detached).toHaveLength(2)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(lastNotification()).toMatchObject({
      text: 'Moved to background: 2',
      type: 'success',
      category: 'system',
      sessionId: 's1',
    })
    expect(dropDetachedToolCalls).toHaveBeenCalledWith('s1', ['call-1'])
  })

  it('частичный отказ — warning «переведено N, не удалось M» с причиной', async () => {
    mocks.backgroundSession.mockResolvedValue({
      sessionId: 's1',
      detached: [{ id: 'blk_1', kind: 'process' }],
      failed: [
        {
          id: 'blk_2',
          kind: 'subagent',
          code: 'DETACH_FAILED',
          message: 'исполнитель не поддерживает перевод',
        },
      ],
    })

    const response = await moveSessionToBackground('s1')

    expect(response).not.toBeNull()
    expect(notify).toHaveBeenCalledTimes(1)
    expect(lastNotification()).toMatchObject({
      text: 'Moved to background: 1, failed: 1 — исполнитель не поддерживает перевод',
      type: 'warning',
      category: 'system',
      sessionId: 's1',
    })
    // Переведённая часть действительно ушла из хода.
    expect(dropDetachedToolCalls).toHaveBeenCalledWith('s1', undefined)
  })

  it('полный отказ — error-тост с причиной, null и live-парты не снимаются', async () => {
    mocks.backgroundSession.mockResolvedValue({
      sessionId: 's1',
      detached: [],
      failed: [{ id: 'blk_1', kind: 'process', code: 'DETACH_FAILED' }],
    })

    const response = await moveSessionToBackground('s1')

    expect(response).toBeNull()
    expect(notify).toHaveBeenCalledTimes(1)
    expect(lastNotification()).toMatchObject({
      text: 'Failed to move to background: DETACH_FAILED',
      type: 'error',
      category: 'error',
      sessionId: 's1',
    })
    expect(dropDetachedToolCalls).not.toHaveBeenCalled()
  })

  it('нечего переводить (оба массива пусты) — прежний тост с нулём', async () => {
    mocks.backgroundSession.mockResolvedValue({ sessionId: 's1', detached: [] })

    const response = await moveSessionToBackground('s1')

    expect(response).not.toBeNull()
    expect(lastNotification()).toMatchObject({
      text: 'Moved to background: 0',
      type: 'success',
    })
  })
})

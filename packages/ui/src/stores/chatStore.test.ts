import { describe, it, expect, beforeEach } from 'vitest'
import { useChatStore } from './chatStore'

const EMPTY_STORE = {
  messagesBySession: {},
  streamFinishTickBySession: {},
  streamingBySession: {},
  queueBySession: {},
  pendingBySession: {},
  errorBySession: {},
  retryBySession: {},
  subagentRetryBySession: {},
  subagentResumingBySession: {},
  finalErrorBySession: {},
  stickyNotesBySession: {},
  summarizationPendingBySession: {},
}

beforeEach(() => {
  useChatStore.setState(EMPTY_STORE as Partial<ReturnType<typeof useChatStore.getState>>)
})

describe('chatStore: streamFinishTickBySession', () => {
  it('finishStream инкрементирует тик завершения для своей сессии', () => {
    const store = useChatStore.getState()
    store.startStream('s1', 'st1', 'developer')
    expect(useChatStore.getState().streamFinishTickBySession['s1']).toBeUndefined()

    useChatStore.getState().finishStream('s1', 'st1', {
      content: 'ok',
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    })

    expect(useChatStore.getState().streamFinishTickBySession['s1']).toBe(1)
  })

  it('повторное завершение увеличивает тик (не сбрасывается)', () => {
    useChatStore.getState().startStream('s1', 'st1', null)
    useChatStore.getState().finishStream('s1', 'st1', { content: 'a' })
    useChatStore.getState().startStream('s1', 'st2', null)
    useChatStore.getState().finishStream('s1', 'st2', { content: 'b' })

    expect(useChatStore.getState().streamFinishTickBySession['s1']).toBe(2)
  })

  it('cancelStream инкрементирует тик (отмена/ошибка завершают стрим)', () => {
    useChatStore.getState().startStream('s1', 'st1', null)
    useChatStore.getState().cancelStream('s1', 'st1')

    expect(useChatStore.getState().streamFinishTickBySession['s1']).toBe(1)
  })

  it('тик привязан к сессии и не задевает другие', () => {
    useChatStore.getState().startStream('s1', 'st1', null)
    useChatStore.getState().finishStream('s1', 'st1', { content: 'a' })

    expect(useChatStore.getState().streamFinishTickBySession['s1']).toBe(1)
    expect(useChatStore.getState().streamFinishTickBySession['s2']).toBeUndefined()
  })
})

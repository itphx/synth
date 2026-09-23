import { useChatStore } from './chatStore'

/**
 * Сброс `chatStore` к пустому состоянию для тестов (общий хелпер вместо
 * дублирования `EMPTY_STORE` в нескольких наборах).
 */
export function resetChatStore(): void {
  useChatStore.setState({
    messagesBySession: {},
    streamFinishTickBySession: {},
    streamingBySession: {},
    queueBySession: {},
    pendingBySession: {},
    retryBySession: {},
    subagentRetryBySession: {},
    subagentResumingBySession: {},
    finalErrorBySession: {},
    stickyNotesBySession: {},
    summarizationPendingBySession: {},
    liveSubagentUsageBySession: {},
  } as Partial<ReturnType<typeof useChatStore.getState>>)
}

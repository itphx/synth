// messages: домен API v2 (ADR-095) — объект `messagesApi` и его DTO.

import type { MessageData } from '@/stores/chatStore'
import { BASE_URL, fetchJSON } from './base'

export interface MessageListResponse {
  messages: MessageData[]
  session_id: string
}

export type BatchMessageAction = 'pin' | 'toggle' | 'delete'

export interface BatchMessageResult {
  messageId: string
  success: boolean
  state?: boolean
}

/**
 * ADR-118 §7: мутации сообщений адресуются **только по `id`** — лента
 * сортируется по `ord`, поэтому позиционный индекс нестабилен.
 */
export const messagesApi = {
  // Сообщения (API v2 — путь /messages/:sessionId/:messageId)
  async getSessionMessages(sessionId: string): Promise<MessageListResponse> {
    return fetchJSON<MessageListResponse>(`${BASE_URL}/sessions/${encodeURIComponent(sessionId)}/messages`)
  },

  async toggleMessage(sessionId: string, messageId: string): Promise<{ disabled: boolean; success: boolean }> {
    return fetchJSON(`${BASE_URL}/messages/${encodeURIComponent(sessionId)}/${encodeURIComponent(messageId)}/toggle`, {
      method: 'PATCH',
    })
  },

  async pinMessage(sessionId: string, messageId: string): Promise<{ pinned: boolean; success: boolean }> {
    return fetchJSON(`${BASE_URL}/messages/${encodeURIComponent(sessionId)}/${encodeURIComponent(messageId)}/pin`, {
      method: 'PATCH',
    })
  },

  async deleteMessage(sessionId: string, messageId: string): Promise<{ success: boolean }> {
    return fetchJSON(`${BASE_URL}/messages/${encodeURIComponent(sessionId)}/${encodeURIComponent(messageId)}`, {
      method: 'DELETE',
    })
  },

  async batchMessages(
    sessionId: string,
    action: BatchMessageAction,
    messageIds: string[],
    state?: boolean,
  ): Promise<{ results: BatchMessageResult[] }> {
    return fetchJSON(`${BASE_URL}/messages/${encodeURIComponent(sessionId)}/batch`, {
      method: 'POST',
      body: JSON.stringify({ action, messageIds, ...(state !== undefined ? { state } : {}) }),
    })
  },

  async retryMessage(sessionId: string, messageId: string): Promise<{ content: string; success: boolean }> {
    return fetchJSON(`${BASE_URL}/messages/${encodeURIComponent(sessionId)}/${encodeURIComponent(messageId)}/retry`, {
      method: 'POST',
    })
  },

  /** Отладочные данные сообщения (ADR-118 §7 — адресация по `id`). */
  async getMessageDebug(sessionId: string, messageId: string): Promise<{ message_id: string; debug_data: Record<string, unknown> }> {
    return fetchJSON(`${BASE_URL}/messages/${encodeURIComponent(sessionId)}/${encodeURIComponent(messageId)}/debug`)
  },
}

// messages: домен API v2 (ADR-095) — объект `messagesApi` и его DTO.

import type { MessageData } from '@/stores/chatStore'
import { BASE_URL, fetchJSON } from './base'

export interface MessageListResponse {
  messages: MessageData[]
  session_id: string
}

export const messagesApi = {
  // Сообщения (API v2 — путь /messages/:sessionId/:index)
  async getSessionMessages(sessionId: string): Promise<MessageListResponse> {
    return fetchJSON<MessageListResponse>(`${BASE_URL}/sessions/${encodeURIComponent(sessionId)}/messages`)
  },

  async toggleMessage(sessionId: string, messageIndex: number): Promise<{ disabled: boolean; success: boolean }> {
    return fetchJSON(`${BASE_URL}/messages/${encodeURIComponent(sessionId)}/${messageIndex}/toggle`, {
      method: 'PATCH',
    })
  },

  async pinMessage(sessionId: string, messageIndex: number): Promise<{ pinned: boolean; success: boolean }> {
    return fetchJSON(`${BASE_URL}/messages/${encodeURIComponent(sessionId)}/${messageIndex}/pin`, {
      method: 'PATCH',
    })
  },

  async deleteMessage(sessionId: string, messageIndex: number): Promise<{ success: boolean }> {
    return fetchJSON(`${BASE_URL}/messages/${encodeURIComponent(sessionId)}/${messageIndex}`, {
      method: 'DELETE',
    })
  },

  async batchMessages(sessionId: string, action: 'pin' | 'toggle' | 'delete', indices: number[], state?: boolean): Promise<{ results: Array<{ index: number; success: boolean; state?: boolean }> }> {
    return fetchJSON(`${BASE_URL}/messages/${encodeURIComponent(sessionId)}/batch`, {
      method: 'POST',
      body: JSON.stringify({ action, indices, ...(state !== undefined ? { state } : {}) }),
    })
  },

  async retryMessage(sessionId: string, messageIndex: number): Promise<{ content: string; success: boolean }> {
    return fetchJSON(`${BASE_URL}/messages/${encodeURIComponent(sessionId)}/${messageIndex}/retry`, {
      method: 'POST',
    })
  },
}

// queue: домен API v2 (ADR-095) — объект `queueApi` и его DTO.

import { BASE_URL, fetchJSON } from './base'

export const queueApi = {
  // Очередь (API v2 — /queue/:sessionId)
  async clearQueue(sessionId: string): Promise<void> {
    return fetchJSON(`${BASE_URL}/queue/${encodeURIComponent(sessionId)}/clear`, {
      method: 'POST',
    })
  },

  async returnQueue(sessionId: string, index?: number): Promise<{ texts: string[] }> {
    const base = `${BASE_URL}/queue/${encodeURIComponent(sessionId)}/return`
    const url = index !== undefined ? `${base}?index=${index}` : base
    return fetchJSON(url, {
      method: 'POST',
    })
  },

  async resumeQueue(sessionId: string): Promise<void> {
    return fetchJSON(`${BASE_URL}/queue/${encodeURIComponent(sessionId)}/resume`, {
      method: 'POST',
    })
  },

  // API v2: немедленный повтор при backoff (без ожидания паузы)
  async retryQueueNow(sessionId: string): Promise<void> {
    await fetchJSON(`${BASE_URL}/queue/${encodeURIComponent(sessionId)}/retry-now`, {
      method: 'POST',
    })
  },

  // API v2: отменить повторные попытки (снять pending, разблокировать)
  async cancelQueueRetry(sessionId: string): Promise<void> {
    await fetchJSON(`${BASE_URL}/queue/${encodeURIComponent(sessionId)}/cancel-retry`, {
      method: 'POST',
    })
  },
}

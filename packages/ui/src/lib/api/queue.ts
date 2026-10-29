// queue: домен API v2 (ADR-095) — объект `queueApi` и его DTO.

import { BASE_URL, fetchJSON } from './base'

/**
 * Адресация элемента очереди (ADR-104): `id` приоритетнее `index`; число —
 * обратная совместимость (= `index`).
 */
export type QueueTarget = number | { id?: string; index?: number }

function targetQuery(target?: QueueTarget): string {
  if (typeof target === 'number') return `?index=${target}`
  if (target && typeof target.id === 'string' && target.id !== '') {
    return `?id=${encodeURIComponent(target.id)}`
  }
  if (target && target.index !== undefined) return `?index=${target.index}`
  return ''
}

function targetBody(target?: QueueTarget): Record<string, unknown> {
  if (typeof target === 'number') return { index: target }
  if (target && typeof target.id === 'string' && target.id !== '') return { id: target.id }
  if (target && target.index !== undefined) return { index: target.index }
  return {}
}

export const queueApi = {
  // Очередь (API v2 — /queue/:sessionId)
  async clearQueue(sessionId: string): Promise<void> {
    return fetchJSON(`${BASE_URL}/queue/${encodeURIComponent(sessionId)}/clear`, {
      method: 'POST',
    })
  },

  async returnQueue(sessionId: string, target?: QueueTarget): Promise<{ texts: string[] }> {
    const base = `${BASE_URL}/queue/${encodeURIComponent(sessionId)}/return`
    return fetchJSON(`${base}${targetQuery(target)}`, {
      method: 'POST',
    })
  },

  /**
   * Принудительный steer: сообщение из очереди уходит в текущий ход (ADR-104).
   * Адресация — `id` (приоритет) или `index`; без них сервер берёт первое.
   * Ответ 202; 409 `NO_ACTIVE_TURN`/`CONFLICT`, 429 при лимите инъекций, 404 — нет элемента.
   */
  async steerQueue(
    sessionId: string,
    target?: QueueTarget,
  ): Promise<{ steered: boolean; pending_count: number }> {
    return fetchJSON(`${BASE_URL}/queue/${encodeURIComponent(sessionId)}/steer`, {
      method: 'POST',
      ...(target !== undefined ? { body: JSON.stringify(targetBody(target)) } : {}),
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

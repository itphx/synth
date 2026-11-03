// messages: домен API v2 (ADR-095) — объект `messagesApi` и его DTO.

import type { MessageData } from '@/stores/chatStore'
import { BASE_URL, fetchJSON } from './base'

/**
 * Размер страницы истории сообщений, который просит UI.
 *
 * Совпадает с серверным дефолтом (`DEFAULT_MESSAGES_LIMIT` в core) — но задаётся
 * явно: клиент не должен зависеть от серверного дефолта при смене версии.
 */
export const MESSAGES_PAGE_LIMIT = 200

export interface MessageListResponse {
  messages: MessageData[]
  session_id: string
  /**
   * Есть ли сообщения **старше** загруженной страницы.
   *
   * `false` — снимок покрывает всю историю (состав ленты авторитетен:
   * сообщения, которых в нём нет, удалены на сервере). `true` — снимок —
   * только последняя страница, и сообщения старше её нельзя считать
   * удалёнными (иначе догрузка старых страниц «съедала» бы их).
   */
  has_more?: boolean
  /**
   * Курсор следующей (более старой) страницы — минимальный `seq` текущей
   * страницы; `null` — более старых сообщений нет.
   */
  next_before?: number | null
}

/**
 * Параметры страницы истории сообщений (`GET /sessions/:id/messages`).
 *
 * Без `before` сервер отдаёт **последнюю** страницу (самые новые), с `before`
 * — сообщения строго старше курсора (`seq`).
 */
export interface MessagePageParams {
  /** Размер страницы (1..500; по умолчанию на сервере 200). */
  limit?: number
  /** Курсор `seq`: вернуть сообщения строго старше указанного. */
  before?: number
}

/**
 * Ответ точечной загрузки сообщения (ADR-118 §4): `message.delivered` несёт
 * только id/ord/роль — содержание берётся одним запросом, а не полной историей.
 */
export interface MessageDetailResponse {
  message: MessageData
  session_id?: string
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
  /**
   * Страница истории сессии (`GET /sessions/:id/messages`).
   *
   * Без параметров — **последняя** страница (самые новые сообщения);
   * с `before` — страница строго старше курсора (`seq`). Ответ несёт
   * `has_more`/`next_before` — по ним UI догружает старые сообщения.
   */
  async getSessionMessages(
    sessionId: string,
    params?: MessagePageParams,
  ): Promise<MessageListResponse> {
    const query = new URLSearchParams()
    if (params?.limit !== undefined) query.set('limit', String(params.limit))
    if (params?.before !== undefined) query.set('before', String(params.before))
    const qs = query.toString()
    return fetchJSON<MessageListResponse>(
      `${BASE_URL}/sessions/${encodeURIComponent(sessionId)}/messages${qs ? `?${qs}` : ''}`,
    )
  },

  /**
   * Одно сообщение сессии — `GET /sessions/:id/messages/:messageId`.
   *
   * Точечная догрузка вместо полной истории (`message.delivered` приходит на
   * каждое материализованное сообщение). `404` — сообщения нет (удалено/чужое).
   */
  async getSessionMessage(sessionId: string, messageId: string): Promise<MessageDetailResponse> {
    return fetchJSON<MessageDetailResponse>(
      `${BASE_URL}/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}`,
    )
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

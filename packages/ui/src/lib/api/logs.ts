// logs: домен API v2 (ADR-095) — объект `logsApi` и его DTO.

import { BASE_URL, fetchJSON } from './base'

/** Ответ GET /api/v2/logs/:name — хвост лог-файла сервиса. */
export interface LogsResponse {
  name: string
  file: string
  total: number
  tail: number
  lines: string[]
}

/** Запись журнала аудита LLM Gateway (ADR-036). */
export interface AuditEntry {
  ts: string
  type: string
  sessionId?: string
  userId?: string
  provider?: string
  model?: string
  secretsFound?: string[]
  placeholders?: string[]
  placeholder?: string
  tokensIn?: number
  tokensOut?: number
  costUsd?: number
  reason?: string
}

/** Ответ GET /api/v2/audit. */
export interface AuditListResponse {
  entries: AuditEntry[]
  total: number
}

/** Запись полного лога запросов/ответов LLM (после обфускации). */
export interface LlmPayloadEntry {
  ts: string
  sessionId?: string
  userId?: string
  provider?: string
  model?: string
  request: {
    messages: Array<{
      id?: string
      role: string
      content: string
      [key: string]: unknown
    }>
    systemPrompt?: string
  }
  response: {
    content: string
    usage?: {
      inputTokens?: number
      outputTokens?: number
      totalTokens?: number
    }
  }
}

/** Ответ GET /api/v2/logs/llm. */
export interface LlmPayloadListResponse {
  entries: LlmPayloadEntry[]
  total: number
}

export const logsApi = {
  // --- Логи сервисов (GET /api/v2/logs/:name) ---
  async getLogs(name: string, params?: { tail?: number; search?: string }): Promise<LogsResponse> {
    const q = new URLSearchParams()
    if (params?.tail !== undefined) q.set('tail', String(params.tail))
    if (params?.search) q.set('search', params.search)
    const qs = q.toString()
    return fetchJSON<LogsResponse>(`${BASE_URL}/logs/${encodeURIComponent(name)}${qs ? `?${qs}` : ''}`)
  },

  // --- Аудит LLM Gateway (GET /api/v2/audit) ---
  async getAudit(params?: {
    userId?: string
    sessionId?: string
    since?: string
    until?: string
    limit?: number
  }): Promise<AuditListResponse> {
    const q = new URLSearchParams()
    if (params?.userId) q.set('userId', params.userId)
    if (params?.sessionId) q.set('sessionId', params.sessionId)
    if (params?.since) q.set('since', params.since)
    if (params?.until) q.set('until', params.until)
    if (params?.limit !== undefined) q.set('limit', String(params.limit))
    const qs = q.toString()
    return fetchJSON<AuditListResponse>(`${BASE_URL}/audit${qs ? `?${qs}` : ''}`)
  },

  // --- Полный лог запросов/ответов LLM (GET /api/v2/logs/llm) ---
  async getLlmPayloads(params?: { sessionId?: string; limit?: number }): Promise<LlmPayloadListResponse> {
    const q = new URLSearchParams()
    if (params?.sessionId) q.set('sessionId', params.sessionId)
    if (params?.limit !== undefined) q.set('limit', String(params.limit))
    const qs = q.toString()
    return fetchJSON<LlmPayloadListResponse>(`${BASE_URL}/logs/llm${qs ? `?${qs}` : ''}`)
  },
}

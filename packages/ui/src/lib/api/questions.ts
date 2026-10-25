// questions: домен API v2 — вопросы пользователю сессии (`ask_user`,
// этап 1 roadmap 0.13 — блок 3).
//
// Серверный контракт (core, `server/routes/sessions.ts`):
//   GET  /api/v2/sessions/:id/questions?status=&limit= → { questions: QuestionRecord[] }
//   POST /api/v2/sessions/:id/questions/:qid/answer  { answers: string[][] } → { question }
//   POST /api/v2/sessions/:id/questions/:qid/cancel  { reason? } → { question }
//
// `answers[i]` — список выбранных значений вариантов для `questions[i]`
// (значения — из `options[].value`). Длина `answers` равна числу вопросов.

import type { QuestionRecord, QuestionStatus } from '@itphx/synth-shared/types'
import { BASE_URL, fetchJSON } from './base'

export interface QuestionListOptions {
  /** Фильтр по статусу (`pending`/`answered`/`cancelled`). Не задан — все статусы. */
  status?: QuestionStatus
  /** Предел выборки (сервер: дефолт 50, максимум 200). */
  limit?: number
}

export interface QuestionListResponse {
  questions: QuestionRecord[]
}

export interface QuestionResponse {
  question: QuestionRecord
}

export const questionsApi = {
  /** Вопросы сессии (по умолчанию — все статусы). */
  async list(sessionId: string, opts?: QuestionListOptions): Promise<QuestionListResponse> {
    const params = new URLSearchParams()
    if (opts?.status) params.set('status', opts.status)
    if (opts?.limit !== undefined) params.set('limit', String(opts.limit))
    const qs = params.toString()
    return fetchJSON<QuestionListResponse>(
      `${BASE_URL}/sessions/${encodeURIComponent(sessionId)}/questions${qs ? `?${qs}` : ''}`,
    )
  },

  /** Ответ пользователя: `answers[i]` — выбранные значения для `questions[i]`. */
  async answer(sessionId: string, questionId: string, answers: string[][]): Promise<QuestionResponse> {
    return fetchJSON<QuestionResponse>(
      `${BASE_URL}/sessions/${encodeURIComponent(sessionId)}/questions/${encodeURIComponent(questionId)}/answer`,
      {
        method: 'POST',
        body: JSON.stringify({ answers }),
      },
    )
  },

  /** Отмена вопроса (причина — свободное пояснение, например `user`). */
  async cancel(sessionId: string, questionId: string, reason?: string): Promise<QuestionResponse> {
    return fetchJSON<QuestionResponse>(
      `${BASE_URL}/sessions/${encodeURIComponent(sessionId)}/questions/${encodeURIComponent(questionId)}/cancel`,
      {
        method: 'POST',
        body: JSON.stringify(reason ? { reason } : {}),
      },
    )
  },
}

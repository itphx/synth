// questionStore: вопросы пользователю сессии (этап 1 roadmap 0.13 — блок 1.3).
//
// Хранит записи вопросов (`QuestionRecord`) по сессиям. Вопрос — персистентная
// запись на сервере (ADR-096, порт `QuestionRepository`): она переживает
// реконнект UI, поэтому список восстанавливается по
// `GET /api/v2/sessions/:id/questions?status=pending`, а live-обновление
// приходит событиями `user_question.*` (диспетчер `stores/transportStore.ts`).
//
// Порядок записей: pending — первыми (ждут ответа), внутри группы — свежие
// первыми (по `createdAt`).

import { create } from 'zustand'
import type { QuestionRecord } from '@itphx/synth-shared/types'

interface QuestionStore {
  /** Записи вопросов по сессиям (pending — первыми, свежие первыми). */
  bySession: Record<string, QuestionRecord[]>

  /** Добавить запись, если её ещё нет (дедуп по `id`). */
  add: (sessionId: string, record: QuestionRecord) => void
  /** Добавить или заменить запись по `id`. */
  upsert: (sessionId: string, record: QuestionRecord) => void
  /** Убрать запись по `id`. */
  remove: (sessionId: string, id: string) => void
  /** Очистить записи сессии. */
  clearSession: (sessionId: string) => void
  /** Заменить весь набор записей сессии (восстановление после перезагрузки). */
  setAll: (sessionId: string, records: QuestionRecord[]) => void
}

/** Время создания записи (0 — дата не разбирается). */
function createdAtMs(record: QuestionRecord): number {
  const parsed = Date.parse(record.createdAt ?? '')
  return Number.isFinite(parsed) ? parsed : 0
}

/** Сортировка: pending — первыми, внутри группы — свежие первыми. */
function sortRecords(records: QuestionRecord[]): QuestionRecord[] {
  return [...records].sort((a, b) => {
    const aPending = a.status === 'pending' ? 0 : 1
    const bPending = b.status === 'pending' ? 0 : 1
    if (aPending !== bPending) return aPending - bPending
    return createdAtMs(b) - createdAtMs(a)
  })
}

export const useQuestionStore = create<QuestionStore>()((set, get) => ({
  bySession: {},

  add: (sessionId, record) => {
    const current = get().bySession[sessionId] ?? []
    if (current.some((q) => q.id === record.id)) return
    set((s) => ({
      bySession: { ...s.bySession, [sessionId]: sortRecords([...current, record]) },
    }))
  },

  upsert: (sessionId, record) => {
    const current = get().bySession[sessionId] ?? []
    const rest = current.filter((q) => q.id !== record.id)
    set((s) => ({
      bySession: { ...s.bySession, [sessionId]: sortRecords([...rest, record]) },
    }))
  },

  remove: (sessionId, id) => {
    const current = get().bySession[sessionId]
    if (!current) return
    const next = current.filter((q) => q.id !== id)
    if (next.length === 0) {
      set((s) => {
        const bySession = { ...s.bySession }
        delete bySession[sessionId]
        return { bySession }
      })
      return
    }
    set((s) => ({ bySession: { ...s.bySession, [sessionId]: next } }))
  },

  clearSession: (sessionId) => {
    set((s) => {
      const bySession = { ...s.bySession }
      delete bySession[sessionId]
      return { bySession }
    })
  },

  setAll: (sessionId, records) => {
    set((s) => ({ bySession: { ...s.bySession, [sessionId]: sortRecords(records) } }))
  },
}))

/**
 * Записи вопросов сессии, ожидающие ответа (`status === 'pending'`).
 *
 * Вне React вызывается без второго аргумента (берётся текущее состояние
 * стора); в компоненте — с явным списком записей сессии, чтобы подписка
 * оставалась реактивной.
 */
export function pendingFor(
  sessionId: string,
  records?: QuestionRecord[],
): QuestionRecord[] {
  const list = records ?? (useQuestionStore.getState().bySession[sessionId] ?? [])
  return list.filter((q) => q.status === 'pending')
}

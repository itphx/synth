// pendingRestore: восстановление незакрытых запросов сессии после
// перезагрузки страницы (или протухшей аутентификации).
//
// Подтверждения прав (`permission.asked`) и вопросы пользователю
// (`user_question.asked`) приходят только live-событиями. События, случившиеся
// до перезагрузки, клиент уже не увидит — без восстановления карточка
// подтверждения (или док вопросов) пропадает, а ход висит до таймаута.
//
// Источник истины — серверные снимки:
//   GET /api/v2/sessions/:id/permissions       → ожидающие подтверждения
//   GET /api/v2/sessions/:id/questions?status=pending → ожидающие вопросы
//
// Точка вызова — компонент, смонтированный **всегда** (`ChatTab`): оба дока
// (`PermissionRequestBar`, `QuestionDock`) смонтированы условно
// (`!inputExpanded && !isSubagent`), поэтому при развёрнутом композере
// восстановление из них не выполнялось.
//
// Ошибка загрузки — тихая: запрос покажут live-события, UI не блокируется.

import { synthApi } from '@/lib/api/synthApi'
import { usePermissionStore } from '@/stores/permissionStore'
import { useQuestionStore } from '@/stores/questionStore'

/** Сколько вопросов загружаем при восстановлении (сервер: максимум 200). */
const PENDING_QUESTIONS_LIMIT = 50

/**
 * Одновременные восстановления по ключу: параллельный вызов присоединяется к
 * уже идущему (иначе док вопросов и `ChatTab` грузили бы один список дважды).
 */
const inFlight = new Map<string, Promise<void>>()

function once(key: string, run: () => Promise<void>): Promise<void> {
  const existing = inFlight.get(key)
  if (existing) return existing
  const promise = run().finally(() => {
    if (inFlight.get(key) === promise) inFlight.delete(key)
  })
  inFlight.set(key, promise)
  return promise
}

/**
 * Восстановить ожидающие подтверждения прав сессии.
 *
 * Снимок сервера — источник истины по составу и по времени: остаток таймера
 * карточки считается от `asked_at` (см. `setAll` в сторе разрешений).
 */
export function restorePendingPermissions(sessionId: string): Promise<void> {
  return once(`permissions:${sessionId}`, async () => {
    try {
      const requests = await synthApi.listPendingPermissions(sessionId)
      usePermissionStore.getState().setAll(sessionId, requests)
    } catch {
      // Тихо: карточку покажет live-событие `permission.asked`.
    }
  })
}

/**
 * Восстановить ожидающие ответа вопросы сессии.
 *
 * Вопрос, пришедший событием `user_question.asked` и ещё не дошедший до
 * сервера, сохраняется — иначе он пропадёт из дока.
 */
export function restorePendingQuestions(sessionId: string): Promise<void> {
  return once(`questions:${sessionId}`, async () => {
    try {
      const res = await synthApi.list(sessionId, {
        status: 'pending',
        limit: PENDING_QUESTIONS_LIMIT,
      })
      const fetched = res.questions ?? []
      const known = new Set(fetched.map((q) => q.id))
      const local = (useQuestionStore.getState().bySession[sessionId] ?? [])
        .filter((q) => q.status === 'pending' && !known.has(q.id))
      useQuestionStore.getState().setAll(sessionId, [...fetched, ...local])
    } catch {
      // Тихо: вопрос покажет live-событие `user_question.asked`.
    }
  })
}

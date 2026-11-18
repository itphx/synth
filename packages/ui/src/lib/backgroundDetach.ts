// ADR-111 §detach: перевод идущего блокирующего прогона в фон — общий шов UI.
//
// Переводят три места: шапка running-парта `task` (`SubagentPart`), живой
// сегмент ответа (`ChatMessage`) и горячая клавиша `ctrl+b` (чат).
// Общий шаг один: запрос `POST /sessions/:id/background` → тост с количеством →
// оптимистичное снятие live-партов из активного хода (дальше работа живёт в
// реестре «Процессы», новые каналы не заводим).

import { synthApi } from './api/synthApi'
import type {
  BackgroundDetachFailure,
  BackgroundDetachKind,
  BackgroundSessionResponse,
} from './api/sessions'
import { i18nText } from './i18n'
import { notifyMessage } from '@/hooks/useNotification'
import { useChatStore } from '@/stores/chatStore'

export interface MoveToBackgroundOptions {
  /** Вид прогона: `subagent`/`process`; не задан — все блокирующие прогоны сессии. */
  type?: BackgroundDetachKind
  /**
   * call_id партов, которые надо снять из активного хода после успешного
   * перевода. Не заданы — снимаются все running `task`/`execute_shell` сессии.
   */
  callIds?: string[]
}

/**
 * Причина отказа перевода для показа человеку.
 *
 * Берём текст от сервера, если он есть, иначе машинный код; секретов в этих
 * полях нет (это причина отказа, а не данные прогона).
 */
function failureReason(failure: BackgroundDetachFailure | undefined): string {
  if (!failure) return ''
  const message = failure.message?.trim()
  return message ? message : failure.code
}

/**
 * Перевести идущие блокирующие прогоны сессии в фон.
 *
 * Исходы:
 * - `detached` и `failed` пусты — «нечего переводить»: прежний тост с нулём,
 *   чтобы действие не выглядело «молча не сработавшим»;
 * - все переведены — успешный тост с количеством;
 * - часть переведена — предупреждение «переведено N, не удалось M» с причиной
 *   первого отказа;
 * - не переведён **ни один** — ошибка с причиной, live-парты не снимаются и
 *   `null` в ответе (успех действия не подтверждён).
 *
 * @returns ответ сервера; `null` — запрос не удался или перевод полностью
 *   отклонён (тост с ошибкой уже показан).
 */
export async function moveSessionToBackground(
  sessionId: string,
  opts?: MoveToBackgroundOptions,
): Promise<BackgroundSessionResponse | null> {
  if (!sessionId) return null
  try {
    const response = await synthApi.backgroundSession(
      sessionId,
      opts?.type ? { type: opts.type } : undefined,
    )
    const detached = response?.detached ?? []
    const failed = response?.failed ?? []
    const moved = detached.length

    // Полный отказ (`DETACH_FAILED`, лимит прогонов): ни один прогон не
    // переведён — снимать live-парты нельзя, иначе работа «пропадёт» из хода.
    if (moved === 0 && failed.length > 0) {
      notifyMessage({
        text: `${i18nText('notify.background.moveFailed')}: ${failureReason(failed[0])}`,
        type: 'error',
        category: 'error',
        sessionId,
      })
      return null
    }

    if (moved > 0) useChatStore.getState().dropDetachedToolCalls(sessionId, opts?.callIds)

    if (moved > 0 && failed.length > 0) {
      notifyMessage({
        text: i18nText('notify.background.movedPartial', {
          moved,
          failed: failed.length,
          reason: failureReason(failed[0]),
        }),
        type: 'warning',
        category: 'system',
        sessionId,
      })
      return response
    }

    notifyMessage({
      text: i18nText('notify.background.moved', { count: moved }),
      type: 'success',
      category: 'system',
      sessionId,
    })
    return response
  } catch (e) {
    notifyMessage({
      text: `${i18nText('notify.background.moveFailed')}: ${(e as Error).message}`,
      type: 'error',
      category: 'error',
      sessionId,
    })
    return null
  }
}

// ADR-111 §detach: перевод идущего блокирующего прогона в фон — общий шов UI.
//
// Переводят три места: шапка running-парта `task` (`SubagentPart`), строка
// активности хода (`StreamingPlaceholder`) и горячая клавиша `ctrl+b` (чат).
// Общий шаг один: запрос `POST /sessions/:id/background` → тост с количеством →
// оптимистичное снятие live-партов из активного хода (дальше работа живёт в
// реестре «Процессы», новые каналы не заводим).

import { synthApi } from './api/synthApi'
import type { BackgroundDetachKind, BackgroundSessionResponse } from './api/sessions'
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
 * Перевести идущие блокирующие прогоны сессии в фон.
 *
 * Пустой `detached` — не ошибка («нечего переводить»): тост всё равно показываем
 * с нулём, чтобы действие не выглядело «молча не сработавшим».
 *
 * @returns ответ сервера; `null` — запрос не удался (тост с ошибкой уже показан).
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
    useChatStore.getState().dropDetachedToolCalls(sessionId, opts?.callIds)
    const count = response?.detached?.length ?? 0
    notifyMessage({
      text: i18nText('notify.background.moved', { count }),
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

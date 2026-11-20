import { useEffect } from 'react'
import { synthApi } from '@/lib/api/synthApi'
import { useChatStore } from '@/stores/chatStore'
import { closeHungTurn, sessionSilenceMs } from '@/stores/transportStore'

/**
 * Как часто сторож смотрит на сессии с идущим ходом.
 *
 * 30 с — компромисс: лишних запросов почти нет (смотрим только сессии
 * локального `streaming`-хода и только при тишине больше порога), а зависший
 * индикатор гаснет за приемлемое время.
 */
export const STALE_TURN_GUARD_INTERVAL_MS = 30_000

/**
 * Тишина (мс), после которой идём спрашивать сервер: события хода
 * (`part.delta`, `tool_call.*`, `step.*`, `subagent.progress`, …) не приходят
 * дольше двух минут.
 *
 * Порог сознательно выше любых штатных пауз: длинный инструмент или большой
 * шаг модели могут молчать десятки секунд, `stream.retry` — весь backoff.
 */
export const STALE_TURN_SILENCE_MS = 120_000

/**
 * Жёсткий таймаут (мс) — тишина, после которой ход закрывается **без сети**
 * (запрос сессии не удался: backend недоступен, 5xx, timeout).
 *
 * Три минуты: если связи нет и события не идут, локальный ход заведомо не
 * оживёт — держать индикатор бесконечно хуже, чем закрыть (история
 * догрузится при возврате связи).
 */
export const STALE_TURN_TIMEOUT_MS = 180_000

/** Минимальный снимок DTO сессии, нужный сторожу (подмножество `SessionData`). */
interface SessionActivitySnapshot {
  activity?: { type?: string } | null
  status?: { blocked?: string | null } | null
}

export interface StaleTurnGuardDeps {
  /** Источник серверного снимка сессии (по умолчанию — `synthApi.getSession`). */
  getSession?: (sessionId: string) => Promise<SessionActivitySnapshot>
  /** Часы (тесты подменяют fake timers через `vi.setSystemTime`). */
  now?: () => number
}

/**
 * Один проход сторожа зависших ходов (ADR-118 §5).
 *
 * Проблема: индикатор «идёт работа» берётся из живого стора
 * (`turnBySession[sid].status === 'streaming'`). Терминальное событие может не
 * дойти или не примениться (несовпадение `turnId`/`stream_id`), и тогда точка в
 * дереве сессий и строка активности в ленте моргают бесконечно.
 *
 * Здесь — независимая от событий проверка: для каждой сессии с локальным
 * `streaming`-ходом и **тишиной** больше {@link STALE_TURN_SILENCE_MS}:
 *
 * 1. спрашиваем сервер (`GET /sessions/:id`) — `activity.type === 'idle'` и
 *    пустой `status.blocked` означают «хода нет»: закрываем ход;
 * 2. если запрос не удался, а тишина больше {@link STALE_TURN_TIMEOUT_MS} —
 *    закрываем ход по таймауту, без сети.
 *
 * Ошибка сети — не приговор: ход остаётся живым до жёсткого таймаута, потому
 * что следующий тик попробует ещё раз.
 */
export async function runStaleTurnGuardTick(deps: StaleTurnGuardDeps = {}): Promise<void> {
  const now = deps.now ?? Date.now
  const getSession = deps.getSession ?? ((sessionId: string) => synthApi.getSession(sessionId))

  const turns = useChatStore.getState().turnBySession
  const streaming = Object.keys(turns).filter((sid) => turns[sid]?.status === 'streaming')
  if (streaming.length === 0) return

  for (const sid of streaming) {
    if (sessionSilenceMs(sid, now()) <= STALE_TURN_SILENCE_MS) continue
    let idle = false
    let failed = false
    try {
      const session = await getSession(sid)
      const activityType = session?.activity?.type
      const blocked = session?.status?.blocked
      // `idle` без ожидания подтверждения — сервер считает ход законченным.
      idle = activityType === 'idle' && !blocked
    } catch {
      failed = true
    }
    // За время запроса могли прийти события (тик асинхронный) — пересчитываем.
    const silence = sessionSilenceMs(sid, now())
    if (idle) {
      closeHungTurn(sid, 'stopped', 'сторож: сервер сообщает activity=idle')
      continue
    }
    if (failed && silence > STALE_TURN_TIMEOUT_MS) {
      closeHungTurn(sid, 'stopped', `сторож: тишина ${Math.round(silence / 1000)} с, сервер недоступен`)
    }
  }
}

/**
 * Рантайм-сторож зависших ходов: интервальная сверка локального `streaming`-хода
 * с серверным `activity` (см. {@link runStaleTurnGuardTick}).
 *
 * Монтируется один раз на приложение (рядом с менеджером транспорта в `App`):
 * хранилище — глобальное, сторож не должен зависеть от открытой вкладки чата.
 * Пока вкладка скрыта, тики пропускаются (как у `useGitStatusPolling`); на
 * возврате видимости — немедленный тик, чтобы индикатор не висел до 30 с.
 */
export function useStaleTurnGuard(): void {
  useEffect(() => {
    const tick = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      void runStaleTurnGuardTick()
    }
    const timer = setInterval(tick, STALE_TURN_GUARD_INTERVAL_MS)
    const onVisibilityChange = () => {
      if (typeof document === 'undefined') return
      if (document.visibilityState === 'visible') tick()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [])
}

import { useEffect } from 'react'
import { useGitStore } from '@/stores/gitStore'

/** Интервал поллинга статуса рабочего дерева (этап 1 ADR-076). */
export const GIT_STATUS_POLL_INTERVAL_MS = 5000

export interface GitStatusPollingOptions {
  intervalMs?: number
  enabled?: boolean
}

/**
 * Периодическое обновление статуса рабочего дерева для набора проектов.
 *
 * Первый тик — сразу; дальше `setInterval`. Тик пропускается, пока вкладка
 * браузера скрыта (`document.visibilityState === 'hidden'`); на возвращении
 * видимости — немедленный тик. Ключ зависимостей — `projectIds.join('|')`,
 * чтобы новый массив с тем же составом не перезапускал таймер.
 */
export function useGitStatusPolling(
  projectIds: string[],
  opts?: GitStatusPollingOptions,
): void {
  const intervalMs = opts?.intervalMs ?? GIT_STATUS_POLL_INTERVAL_MS
  const enabled = opts?.enabled ?? true
  const key = projectIds.join('|')

  useEffect(() => {
    if (!enabled) return
    const ids = key ? key.split('|') : []
    if (ids.length === 0) return

    const tick = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      for (const projectId of ids) {
        void useGitStore.getState().loadStatus(projectId)
      }
    }

    tick()
    const timer = setInterval(tick, intervalMs)
    const onVisibilityChange = () => {
      if (typeof document === 'undefined') return
      if (document.visibilityState === 'visible') tick()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [key, intervalMs, enabled])
}

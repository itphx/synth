import { useEffect, useRef } from 'react'
import { useConnectionStore } from '@/stores/connectionStore'
import { useUIStore } from '@/stores/useUIStore'
import { useAuthStore } from '@/stores/authStore'
import { useNotification } from '@/hooks/useNotification'

const MODE_LABELS: Record<string, string> = { auto: 'Auto', ws: 'WebSocket', sse: 'SSE' }

/**
 * Единый менеджер соединений с бэкендом.
 * Активируется после полной загрузки профиля (authStore.isInitialized === true).
 * - При инициализации: один вызов setTransportMode с правильным режимом из профиля.
 * - При ручной смене transportMode: пересоздаёт соединения + toast-уведомление.
 * - При смене открытых табов: ensure/release per-session соединения.
 */
export function BackendConnection() {
  const profile = useAuthStore((s) => s.profile)
  const transportMode = useUIStore((s) => s.transportMode)
  const centerTabs = useUIStore((s) => s.centerTabs)
  const { notify } = useNotification()
  const wasInitRef = useRef(false)
  const prevTabsRef = useRef<Set<string>>(new Set())
  const prevModeRef = useRef<typeof transportMode | null>(null)

  // Инициализация и переключение transportMode
  useEffect(() => {
    if (!profile) {
      if (wasInitRef.current) {
        useConnectionStore.getState().disconnectAll()
        wasInitRef.current = false
        prevTabsRef.current.clear()
        prevModeRef.current = null
      }
      return
    }

    const oldMode = prevModeRef.current
    const modeChanged = oldMode !== null && oldMode !== transportMode
    const isInit = oldMode === null

    prevModeRef.current = transportMode

    if (isInit || modeChanged) {
      useConnectionStore.getState().setTransportMode(transportMode)
    }

    if (!wasInitRef.current) {
      wasInitRef.current = true
      return
    }

    if (modeChanged) {
      notify({
        text: `Режим транспорта: ${MODE_LABELS[oldMode!] ?? oldMode} → ${MODE_LABELS[transportMode] ?? transportMode}`,
        type: 'info',
        category: 'system',
      })
    }
  }, [profile, transportMode])

  // Синхронизация per-session соединений с открытыми табами
  useEffect(() => {
    if (!profile || !wasInitRef.current) return

    const store = useConnectionStore.getState()
    const currentTabIds = new Set<string>()

    for (const tab of centerTabs) {
      const sid = tab.type === 'chat' ? tab.data.sessionId : null
      if (sid) {
        currentTabIds.add(sid)
        store.ensureSessionConnection(sid, store.transportMode)
      }
    }

    for (const sid of prevTabsRef.current) {
      if (!currentTabIds.has(sid)) {
        store.releaseSessionConnection(sid)
      }
    }

    prevTabsRef.current = currentTabIds
  }, [profile, centerTabs])

  return null
}

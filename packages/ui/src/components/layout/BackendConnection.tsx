import { useEffect, useRef } from 'react'
import { useTransportStore } from '@/stores/transportStore'
import { useUIStore } from '@/stores/useUIStore'
import { useAuthStore } from '@/stores/authStore'

/**
 * Единый менеджер транспорта.
 *
 * Транспорт запускается по факту авторизации (`authPhase === 'authenticated'`),
 * а не по наличию профиля: ошибка `GET /auth/profile` (профиль не загрузился)
 * больше не блокирует подключение. При уходе в `guest`/`unreachable` —
 * отключается.
 */
export function BackendConnection() {
  const authPhase = useAuthStore((s) => s.authPhase)
  const transportMode = useUIStore((s) => s.transportMode)
  const wasInitRef = useRef(false)
  const prevModeRef = useRef<typeof transportMode | null>(null)

  useEffect(() => {
    if (authPhase !== 'authenticated') {
      if (wasInitRef.current) {
        useTransportStore.getState().disconnect()
        wasInitRef.current = false
        prevModeRef.current = null
      }
      return
    }

    const isInit = prevModeRef.current === null
    const modeChanged = prevModeRef.current !== null && prevModeRef.current !== transportMode
    prevModeRef.current = transportMode

    if (isInit || modeChanged) {
      useTransportStore.getState().setTransportMode(transportMode)
    }

    if (!wasInitRef.current) {
      wasInitRef.current = true
    }
  }, [authPhase, transportMode])

  return null
}

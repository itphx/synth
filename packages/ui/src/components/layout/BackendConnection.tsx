import { useEffect, useRef } from 'react'
import { useTransportStore } from '@/stores/transportStore'
import { useUIStore } from '@/stores/useUIStore'
import { useAuthStore } from '@/stores/authStore'

/**
 * Единый менеджер транспорта.
 * При инициализации/смене transportMode — переподключает транспорт.
 */
export function BackendConnection() {
  const profile = useAuthStore((s) => s.profile)
  const transportMode = useUIStore((s) => s.transportMode)
  const wasInitRef = useRef(false)
  const prevModeRef = useRef<typeof transportMode | null>(null)

  useEffect(() => {
    if (!profile) {
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
  }, [profile, transportMode])

  return null
}

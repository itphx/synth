import { useEffect, useRef } from 'react'
import { api } from '@/lib/api/client'
import { confirm } from '@/lib/confirm'
import { useI18n } from '@/lib/i18n'
import { notifyMessage } from '@/hooks/useNotification'
import { useAuthStore } from '@/stores/authStore'
import { useTransportStore } from '@/stores/transportStore'

const INITIAL_CHECK_DELAY = 2_500
const RECHECK_INTERVAL = 5_000
const RECONNECT_THROTTLE = 10_000
const RELOAD_PROMPT_DELAY = 20_000

/**
 * Следит за живостью сессии при потере транспорта.
 *
 * Отличает «сервер недоступен» (сеть) от «сессия мертва» (бэкенд перезапущен,
 * cookie осталась в браузере): при `authenticated === false` сбрасывает
 * авторизацию и показывает форму входа, вместо бесконечного переподключения.
 */
export function ConnectionGuard() {
  const { t } = useI18n()
  const connected = useTransportStore((s) => s.connected)
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)
  const isInitialized = useAuthStore((s) => s.isInitialized)

  const tRef = useRef(t)
  tRef.current = t

  const mountedRef = useRef(true)
  const episodeActiveRef = useRef(false)
  const checkTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reloadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const checkInFlightRef = useRef(false)
  const lostNotifiedRef = useRef(false)
  const offlineNotifiedRef = useRef(false)
  const expiredNotifiedRef = useRef(false)
  const reloadPromptedRef = useRef(false)
  const lastReconnectAtRef = useRef(0)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    const clearTimers = () => {
      if (checkTimerRef.current) {
        clearTimeout(checkTimerRef.current)
        checkTimerRef.current = null
      }
      if (reloadTimerRef.current) {
        clearTimeout(reloadTimerRef.current)
        reloadTimerRef.current = null
      }
    }

    const resetEpisode = () => {
      episodeActiveRef.current = false
      checkInFlightRef.current = false
      lostNotifiedRef.current = false
      offlineNotifiedRef.current = false
      expiredNotifiedRef.current = false
      reloadPromptedRef.current = false
      clearTimers()
    }

    const showReloadPrompt = async () => {
      if (!mountedRef.current || !episodeActiveRef.current) return
      if (reloadPromptedRef.current) return
      if (useTransportStore.getState().connected) return
      reloadPromptedRef.current = true
      const ok = await confirm({
        title: tRef.current('connection.reloadTitle'),
        message: tRef.current('connection.reloadMessage'),
        confirmLabel: tRef.current('connection.reloadConfirm'),
        cancelLabel: tRef.current('connection.reloadCancel'),
        variant: 'warning',
      })
      if (ok && mountedRef.current) {
        window.location.reload()
      }
    }

    const maybeReconnect = () => {
      if (!episodeActiveRef.current) return
      const now = Date.now()
      if (now - lastReconnectAtRef.current < RECONNECT_THROTTLE) return
      lastReconnectAtRef.current = now
      const store = useTransportStore.getState()
      store.connect(store.transportMode)
    }

    const runCheck = async () => {
      if (!mountedRef.current || !episodeActiveRef.current) return
      if (checkInFlightRef.current) return
      if (useTransportStore.getState().connected) {
        resetEpisode()
        return
      }

      checkInFlightRef.current = true
      try {
        const status = await api.getStatus()
        if (!mountedRef.current || !episodeActiveRef.current) return
        if (useTransportStore.getState().connected) {
          resetEpisode()
          return
        }

        if (status.authenticated === false) {
          if (expiredNotifiedRef.current) return
          expiredNotifiedRef.current = true
          episodeActiveRef.current = false
          clearTimers()
          useTransportStore.getState().disconnect()
          notifyMessage({ text: tRef.current('connection.sessionExpired'), type: 'error', category: 'connection' })
          useAuthStore.getState().sessionExpired()
          return
        }

        if (!lostNotifiedRef.current) {
          lostNotifiedRef.current = true
          notifyMessage({ text: tRef.current('connection.lost'), type: 'warning', category: 'connection' })
        }
        maybeReconnect()
        scheduleCheck(RECHECK_INTERVAL)
      } catch {
        if (!mountedRef.current || !episodeActiveRef.current) return
        if (useTransportStore.getState().connected) {
          resetEpisode()
          return
        }
        if (!offlineNotifiedRef.current) {
          offlineNotifiedRef.current = true
          notifyMessage({ text: tRef.current('connection.offline'), type: 'warning', category: 'connection' })
        }
        scheduleCheck(RECHECK_INTERVAL)
      } finally {
        checkInFlightRef.current = false
      }
    }

    const scheduleCheck = (delay: number) => {
      if (checkTimerRef.current) clearTimeout(checkTimerRef.current)
      checkTimerRef.current = setTimeout(() => {
        checkTimerRef.current = null
        void runCheck()
      }, delay)
    }

    const onOnline = () => {
      if (!episodeActiveRef.current) return
      if (!useTransportStore.getState().connected) {
        void runCheck()
      }
    }

    const onOffline = () => {
      if (!episodeActiveRef.current) return
      if (!offlineNotifiedRef.current) {
        offlineNotifiedRef.current = true
        notifyMessage({ text: tRef.current('connection.offline'), type: 'warning', category: 'connection' })
      }
    }

    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return
      if (!episodeActiveRef.current) return
      if (!useTransportStore.getState().connected) {
        void runCheck()
      }
    }

    resetEpisode()

    if (!isInitialized || !isAuthenticated || connected) {
      return
    }

    episodeActiveRef.current = true
    lastReconnectAtRef.current = 0

    scheduleCheck(INITIAL_CHECK_DELAY)
    reloadTimerRef.current = setTimeout(() => {
      reloadTimerRef.current = null
      void showReloadPrompt()
    }, RELOAD_PROMPT_DELAY)

    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
      document.removeEventListener('visibilitychange', onVisibility)
      resetEpisode()
    }
  }, [connected, isInitialized, isAuthenticated])

  return null
}

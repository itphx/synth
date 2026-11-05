import { useEffect, useRef, useState } from 'react'
import { Icon } from '@/components/icon/Icon'
import { api } from '@/lib/api/client'
import { useI18n } from '@/lib/i18n'
import { notifyMessage } from '@/hooks/useNotification'
import { useAuthStore } from '@/stores/authStore'
import { useTransportStore } from '@/stores/transportStore'

/** Сколько связь должна оставаться потерянной, прежде чем показать баннер. */
export const CONNECTION_BANNER_DELAY_MS = 15_000
/** Период проверки сессии, пока баннер висит. */
export const CONNECTION_PROBE_INTERVAL_MS = 15_000

/**
 * Индикация потери связи.
 *
 * Заменяет `ConnectionGuard`: никаких confirm-диалогов и тостов о связи.
 * После 15 с непрерывного не-`online` (включая залипший первый `connecting`)
 * показывает баннер с «Повторить»/«Обновить страницу»; при `online` исчезает.
 * В гибриде баннер показывается тоже (перекрывает inline-баннер гибрида — зато
 * у него есть действия по реконнекту/перезагрузке).
 * `versionMismatch` — не «нет связи»: там уже есть error-тост о несовместимой
 * модели сообщений, баннер связи вводил бы в заблуждение.
 *
 * Раз в 15 с (пока баннер висит) — один probe `GET /auth/status`: если сервер
 * ответил и `authenticated === false`, это реальное истечение сессии (перевод в
 * гостя); сетевая ошибка/таймаут ничего не меняют.
 *
 * Монтируется вне `AuthGate`, активность — только при `authPhase === 'authenticated'`.
 */
export function ConnectionStatus() {
  const { t } = useI18n()
  const authPhase = useAuthStore((s) => s.authPhase)
  const phase = useTransportStore((s) => s.phase)
  const phaseSince = useTransportStore((s) => s.phaseSince)
  const versionMismatch = useTransportStore((s) => s.versionMismatch)
  const [showBanner, setShowBanner] = useState(false)
  const tRef = useRef(t)
  tRef.current = t
  const probeInFlightRef = useRef(false)

  useEffect(() => {
    // Любая не-`online` фаза: залипший первый `connecting` — тоже потеря связи.
    // Несовместимая модель сообщений — не потеря связи (есть отдельный error-тост).
    const isLost = phase !== 'online' && !versionMismatch
    if (authPhase !== 'authenticated' || !isLost) {
      setShowBanner(false)
      return
    }
    const elapsed = Date.now() - phaseSince
    if (elapsed >= CONNECTION_BANNER_DELAY_MS) {
      setShowBanner(true)
      return
    }
    const timer = setTimeout(() => setShowBanner(true), CONNECTION_BANNER_DELAY_MS - elapsed)
    return () => clearTimeout(timer)
  }, [authPhase, phase, phaseSince, versionMismatch])

  useEffect(() => {
    if (!showBanner) return
    let cancelled = false
    const probe = async () => {
      if (probeInFlightRef.current) return
      probeInFlightRef.current = true
      try {
        const status = await api.getStatus()
        if (cancelled) return
        if (status.authenticated === false) {
          // Сервер ответил и сессии нет — это не сеть: возвращаем форму входа.
          notifyMessage({
            text: tRef.current('connection.sessionExpired'),
            type: 'error',
            category: 'connection',
          })
          useTransportStore.getState().disconnect()
          useAuthStore.getState().sessionExpired()
        }
      } catch {
        // Нет ответа — остаёмся в разрыве, никаких уведомлений о связи.
      } finally {
        probeInFlightRef.current = false
      }
    }
    void probe()
    const timer = setInterval(() => void probe(), CONNECTION_PROBE_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [showBanner])

  if (!showBanner) return null

  return (
    <div
      role="status"
      data-testid="connection-banner"
      data-phase={phase}
      className="connection-banner flex flex-wrap items-center gap-2 border-b border-status-warning/30 bg-status-warning/10 px-3 py-2 text-status-warning shadow-sm backdrop-blur"
    >
      <Icon name="error-warning" className="size-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="text-xs font-semibold">{t('connection.banner.title')}</div>
        <div className="text-xs opacity-90">{t('connection.banner.message')}</div>
      </div>
      <button
        type="button"
        data-testid="connection-banner-retry"
        onClick={() => useTransportStore.getState().restart()}
        className="shrink-0 rounded-lg border border-status-warning/40 px-3 py-1.5 text-xs font-medium text-status-warning transition-colors hover:bg-status-warning/20 min-h-9 pointer-coarse:min-h-10"
      >
        {t('connection.banner.retry')}
      </button>
      <button
        type="button"
        data-testid="connection-banner-reload"
        onClick={() => window.location.reload()}
        className="shrink-0 rounded-lg bg-status-warning/20 px-3 py-1.5 text-xs font-medium text-status-warning transition-colors hover:bg-status-warning/30 min-h-9 pointer-coarse:min-h-10"
      >
        {t('connection.banner.reload')}
      </button>
    </div>
  )
}

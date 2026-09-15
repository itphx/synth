import { useCallback, useEffect, useRef, useState } from 'react'
import { SYNTH_VERSION } from '@itphx/synth-shared'
import { Icon } from '../icon/Icon'
import { useI18n } from '@/lib/i18n'

/**
 * Баннер обновления PWA/SPA. Показывается, когда service worker установил новую
 * версию, но ждёт команды (skipWaiting убран из install). Кнопка «Обновить»
 * отправляет SKIP_WAITING; после controllerchange страница перезагружается.
 */
export function PwaUpdatePrompt() {
  const { t } = useI18n()
  const [updateReady, setUpdateReady] = useState(false)
  /** Перезагружаем только если обновление инициировал пользователь. */
  const reloadOnControllerChange = useRef(false)
  /** Баннер отложен («Позже») до следующей проверки. */
  const dismissed = useRef(false)

  useEffect(() => {
    if (!import.meta.env.PROD) return
    if (!('serviceWorker' in navigator)) return

    let registration: ServiceWorkerRegistration | null = null
    let cancelled = false

    const showIfReady = () => {
      if (dismissed.current) return
      if (registration?.waiting && navigator.serviceWorker.controller) {
        setUpdateReady(true)
      }
    }

    const onUpdateFound = () => {
      const installing = registration?.installing
      if (!installing) return
      installing.addEventListener('statechange', () => {
        if (installing.state === 'installed' && navigator.serviceWorker.controller) {
          showIfReady()
        }
      })
    }

    const onControllerChange = () => {
      if (!reloadOnControllerChange.current) return
      reloadOnControllerChange.current = false
      window.location.reload()
    }

    // Возврат в приложение — повод проверить обновление (важно для PWA после сна).
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return
      dismissed.current = false
      registration?.update().catch(() => {}).then(showIfReady)
    }

    navigator.serviceWorker
      .register(`/sw.js?v=${SYNTH_VERSION}`, { updateViaCache: 'none' })
      .then((reg) => {
        if (cancelled) return
        registration = reg
        showIfReady()
        reg.addEventListener('updatefound', onUpdateFound)
      })
      .catch(() => {})

    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange)
    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      cancelled = true
      registration?.removeEventListener('updatefound', onUpdateFound)
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [])

  const handleUpdate = useCallback(async () => {
    const reg = await navigator.serviceWorker.getRegistration()
    if (!reg?.waiting) return
    reloadOnControllerChange.current = true
    reg.waiting.postMessage({ type: 'SKIP_WAITING' })
  }, [])

  const handleLater = useCallback(() => {
    dismissed.current = true
    setUpdateReady(false)
  }, [])

  if (!updateReady) return null

  return (
    <div
      role="status"
      className="fixed inset-x-0 bottom-0 z-[60] flex justify-center px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pointer-events-none"
    >
      <div className="pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-xl border bg-background p-3 shadow-lg">
        <Icon name="refresh" className="size-5 shrink-0 text-muted-foreground" />
        <span className="flex-1 text-sm text-foreground">{t('pwa.updateAvailable')}</span>
        <button
          type="button"
          onClick={handleLater}
          className="shrink-0 rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground"
        >
          {t('pwa.updateLater')}
        </button>
        <button
          type="button"
          onClick={() => void handleUpdate()}
          className="shrink-0 rounded-lg bg-interactive-selection px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-interactive-selection/90"
        >
          {t('pwa.updateNow')}
        </button>
      </div>
    </div>
  )
}

import { useCallback, useEffect, useState } from 'react'

/**
 * PWA-установка: ловим `beforeinstallprompt`, отдаём `canInstall` и `promptInstall`.
 * Кнопка показывается только когда браузер реально предлагает установку
 * (Chrome/Edge/Android). На iOS Safari событие не приходит — там установка
 * через «Add to Home Screen», поэтому кнопка не появляется. Если приложение
 * уже установлено (standalone) — тоже не показываем.
 */

// Событие PWA-установки не описано в стандартных типах DOM.
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

function isStandalone(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false
  return window.matchMedia('(display-mode: standalone)').matches
}

export function usePwaInstall() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null)
  const [installed, setInstalled] = useState(isStandalone)

  useEffect(() => {
    const onBeforeInstall = (e: Event) => {
      // Откладываем системный баннер — покажем свою кнопку.
      e.preventDefault()
      setDeferredPrompt(e as BeforeInstallPromptEvent)
    }
    const onInstalled = () => {
      setInstalled(true)
      setDeferredPrompt(null)
    }
    const checkStandalone = () => setInstalled(isStandalone())

    window.addEventListener('beforeinstallprompt', onBeforeInstall)
    window.addEventListener('appinstalled', onInstalled)
    window.addEventListener('resize', checkStandalone)

    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall)
      window.removeEventListener('appinstalled', onInstalled)
      window.removeEventListener('resize', checkStandalone)
    }
  }, [])

  const promptInstall = useCallback(async () => {
    if (!deferredPrompt) return
    await deferredPrompt.prompt()
    const choice = await deferredPrompt.userChoice
    if (choice.outcome === 'accepted') setInstalled(true)
    setDeferredPrompt(null)
  }, [deferredPrompt])

  return {
    canInstall: !!deferredPrompt && !installed,
    promptInstall,
  }
}

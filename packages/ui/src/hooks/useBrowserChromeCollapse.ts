import { useEffect } from 'react'
import { useDevice } from './useDevice'

/** Запас прокрутки root-документа в мобильных зонах (см. index.css: 100dvh + 8px). */
const NUDGE_PX = 8
/** Не чаще одного нуджа в секунду на интерактивных событиях. */
const NUDGE_THROTTLE_MS = 1000
/** После фокуса в поле ввода даём браузеру довести layout, затем нуджим. */
const FOCUS_NUDGE_DELAY_MS = 300

/**
 * Имитация прокрутки на мобильных (Yandex/Firefox на Android): панель браузера
 * не сворачивается, пока страница не прокручивается. В мобильных зонах root-документ
 * получает небольшой запас прокрутки, а .app-shell зафиксирован — поэтому нудж
 * `window.scrollTo(0, NUDGE_PX)` прячет панель, не сдвигая интерфейс.
 *
 * Нудж повторяется после монтирования, на pageshow/orientationchange, после фокуса
 * в поле ввода и на первый touchstart/pointerdown (не чаще раза в секунду).
 * На десктопе — no-op.
 */
export function useBrowserChromeCollapse(): void {
  const { deviceType } = useDevice()
  const isMobile = deviceType !== 'desktop'

  useEffect(() => {
    if (!isMobile || typeof window === 'undefined' || typeof document === 'undefined') {
      return
    }

    let frame = 0
    let timer = 0
    let lastNudge = 0

    const nudge = () => {
      const scroller = document.scrollingElement
      if (!scroller) return
      if (scroller.scrollHeight - window.innerHeight < NUDGE_PX) return
      window.scrollTo(0, NUDGE_PX)
    }

    const scheduleNudge = (delay = 0) => {
      if (frame) window.cancelAnimationFrame(frame)
      if (timer) window.clearTimeout(timer)
      frame = window.requestAnimationFrame(() => {
        frame = 0
        timer = window.setTimeout(() => {
          timer = 0
          nudge()
        }, delay)
      })
    }

    const nudgeThrottled = () => {
      const now = Date.now()
      if (now - lastNudge < NUDGE_THROTTLE_MS) return
      lastNudge = now
      scheduleNudge()
    }

    const handleFocus = () => scheduleNudge(FOCUS_NUDGE_DELAY_MS)

    scheduleNudge()
    window.addEventListener('pageshow', nudgeThrottled)
    window.addEventListener('orientationchange', nudgeThrottled)
    window.addEventListener('focusin', handleFocus)
    window.addEventListener('touchstart', nudgeThrottled, { passive: true })
    window.addEventListener('pointerdown', nudgeThrottled, { passive: true })

    return () => {
      if (frame) window.cancelAnimationFrame(frame)
      if (timer) window.clearTimeout(timer)
      window.removeEventListener('pageshow', nudgeThrottled)
      window.removeEventListener('orientationchange', nudgeThrottled)
      window.removeEventListener('focusin', handleFocus)
      window.removeEventListener('touchstart', nudgeThrottled)
      window.removeEventListener('pointerdown', nudgeThrottled)
    }
  }, [isMobile])
}

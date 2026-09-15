import { useEffect } from 'react'

const APP_HEIGHT_VAR = '--oc-app-height'
const OFFSET_TOP_VAR = '--oc-visual-viewport-offset-top'

/**
 * Синхронизирует высоту мобильного шелла с visual viewport.
 *
 * Пишет высоту visualViewport (fallback — window.innerHeight) в --oc-app-height
 * и offsetTop в --oc-visual-viewport-offset-top на <html>. Когда клавиатура
 * открыта, шелл уменьшается, поэтому композер остаётся видимым без отдельного
 * клавиатурного отступа. При отсутствии обеих величин переменные не трогаются —
 * остаётся CSS-fallback 100dvh.
 */
export function useViewportHeight(): void {
  useEffect(() => {
    if (typeof window === 'undefined') return
    const root = document.documentElement
    const vv = window.visualViewport
    let frame = 0

    const apply = () => {
      frame = 0
      const height = vv?.height ?? window.innerHeight
      if (typeof height === 'number' && height > 0) {
        root.style.setProperty(APP_HEIGHT_VAR, `${height}px`)
      }
      if (vv) {
        root.style.setProperty(OFFSET_TOP_VAR, `${vv.offsetTop}px`)
      }
    }

    const schedule = () => {
      if (frame) return
      frame = window.requestAnimationFrame(apply)
    }

    apply()
    vv?.addEventListener('resize', schedule)
    vv?.addEventListener('scroll', schedule)
    window.addEventListener('resize', schedule)
    window.addEventListener('orientationchange', schedule)

    return () => {
      if (frame) window.cancelAnimationFrame(frame)
      vv?.removeEventListener('resize', schedule)
      vv?.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      window.removeEventListener('orientationchange', schedule)
      root.style.removeProperty(APP_HEIGHT_VAR)
      root.style.removeProperty(OFFSET_TOP_VAR)
    }
  }, [])
}

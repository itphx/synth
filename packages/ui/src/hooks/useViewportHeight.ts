import { useEffect } from 'react'

const APP_HEIGHT_VAR = '--synth-app-height'

/**
 * Синхронизирует высоту мобильного шелла с visual viewport.
 *
 * Пишет высоту в --synth-app-height как `min(100dvh, ${h}px)`. Значение h — минимум
 * из высоты visualViewport (fallback — window.innerHeight) и layout viewport.
 * CSS `min()` не даёт шеллу превысить динамический вьюпорт (в альбомной
 * ориентации нижняя панель браузера не перекрывает композер), но при этом
 * значение реагирует на клавиатуру: когда она открыта, пиксельная часть min()
 * меньше 100dvh, и шелл уменьшается без отдельного клавиатурного отступа.
 * При отсутствии данных переменная не трогается — остаётся CSS-fallback 100dvh/100vh.
 */
export function useViewportHeight(): void {
  useEffect(() => {
    if (typeof window === 'undefined') return
    const root = document.documentElement
    const vv = window.visualViewport
    let frame = 0

    const apply = () => {
      frame = 0
      const height = Math.min(vv?.height ?? window.innerHeight, window.innerHeight)
      if (typeof height === 'number' && height > 0) {
        root.style.setProperty(APP_HEIGHT_VAR, `min(100dvh, ${height}px)`)
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
    }
  }, [])
}

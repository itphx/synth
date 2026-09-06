import { useEffect } from 'react'
import { useDevice } from './useDevice'

const KB_INSET_VAR = '--kb-inset'

/**
 * Клавиатурный выступ на touch-устройствах (Фаза 4 адаптивного мобильного UI).
 *
 * Слушает window.visualViewport (resize/scroll) и пишет высоту перекрытия
 * виртуальной клавиатуры в CSS-переменную --kb-inset (px) на <html>.
 * Нижняя область чата (композер) сдвигается на эту высоту, чтобы прятаться
 * под клавиатурой.
 *
 * Когда клавиатура закрыта, visualViewport недоступен или устройство не
 * является touch (isTouch=false) — переменная выставляется в 0px, поэтому
 * десктоп и устройства без touch не изменяют поведение.
 */
export function useKeyboardInset(): void {
  const { isTouch } = useDevice()

  useEffect(() => {
    if (!isTouch || typeof window === 'undefined') return
    const vv = window.visualViewport
    const root = document.documentElement

    const update = () => {
      if (!vv) {
        root.style.setProperty(KB_INSET_VAR, '0px')
        return
      }
      // Нижняя граница видимой области (visual viewport) относительно layout
      // viewport: vv.height + vv.offsetTop. window.innerHeight — нижняя граница
      // layout viewport. Разница (если она положительная) — высота, перекрытая
      // виртуальной клавиатурой снизу.
      const visibleBottom = vv.height + vv.offsetTop
      const inset = Math.max(0, window.innerHeight - visibleBottom)
      root.style.setProperty(KB_INSET_VAR, `${inset}px`)
    }

    update()
    vv?.addEventListener('resize', update)
    vv?.addEventListener('scroll', update)
    window.addEventListener('resize', update)
    window.addEventListener('orientationchange', update)

    return () => {
      vv?.removeEventListener('resize', update)
      vv?.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
      window.removeEventListener('orientationchange', update)
      root.style.setProperty(KB_INSET_VAR, '0px')
    }
  }, [isTouch])
}

import { useEffect, useRef, useState, type RefObject } from 'react'

/**
 * Отслеживает обрезку текста подписей вкладок относительно доступной ширины.
 * Если хотя бы одна подпись (span[data-tab-label]) обрезается через truncate
 * (scrollWidth > clientWidth) — возвращает iconsOnly=true (подписи скрываются,
 * остаются только иконки). С гистерезисом, чтобы не мигало.
 *
 * Кнопки с `flex-1` сжимаются до min-width, поэтому ряд «помещается» в контейнер,
 * а текст режется ВНУТРИ кнопки — меряем именно обрезку span, а не переполнение ряда.
 */
const OVERFLOW_TOLERANCE_PX = 1
const RETURN_MARGIN_PX = 32
const TRIGGER_DEBOUNCE_MS = 300
// Ширина скрытой панели: обёртка схлопывается до padding'а (px-2 ≈ 16px).
// Ниже этого порога измерять подписи нельзя — иначе iconsOnly включится на закрытой панели.
const MIN_CONTAINER_WIDTH_PX = 64

export function useAdaptiveIcons(containerRef: RefObject<HTMLElement | null>): boolean {
  const [iconsOnly, setIconsOnly] = useState(false)
  const iconsOnlyRef = useRef(false)
  // Минимальная ширина контейнера, при которой все подписи влезают без обрезки.
  // Не пересчитывается в iconsOnly (span скрыты, scrollWidth=0).
  const textFitsWidthRef = useRef(0)
  const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const hasOverflow = () => {
      for (const label of container.querySelectorAll<HTMLElement>('[data-tab-label]')) {
        if (label.scrollWidth > label.clientWidth + OVERFLOW_TOLERANCE_PX) return true
      }
      return false
    }

    const cancelPending = () => {
      if (pendingTimerRef.current !== null) {
        clearTimeout(pendingTimerRef.current)
        pendingTimerRef.current = null
      }
    }

    const check = () => {
      const containerWidth = container.clientWidth
      // Панель скрыта (ширина схлопнута до padding'а) — измерять нечего, иначе
      // iconsOnly включится на промежуточных/закрытых состояниях анимации.
      if (containerWidth < MIN_CONTAINER_WIDTH_PX) {
        cancelPending()
        return
      }

      if (!iconsOnlyRef.current) {
        // Подписи видны: если обрезки нет — запоминаем ширину, при которой текст влезает.
        if (!hasOverflow()) {
          textFitsWidthRef.current = Math.min(textFitsWidthRef.current || Infinity, containerWidth)
          cancelPending()
        } else {
          // Обрезка есть: переключаемся только при стабильной обрезке, иначе анимация
          // открытия/быстрые ресайзы вызывали бы мигание.
          if (pendingTimerRef.current === null) {
            pendingTimerRef.current = setTimeout(() => {
              pendingTimerRef.current = null
              // Панель могла закрыться (ширина схлопнута) — тогда не включаем iconsOnly.
              // Проверка обрезки повторяется перед включением.
              if (container.clientWidth >= MIN_CONTAINER_WIDTH_PX && !iconsOnlyRef.current && hasOverflow()) {
                iconsOnlyRef.current = true
                setIconsOnly(true)
              }
            }, TRIGGER_DEBOUNCE_MS)
          }
        }
      } else {
        // В iconsOnly НЕ пересчитываем textFitsWidthRef (span скрыты, scrollWidth=0) —
        // возвращаем подписи только когда контейнер стал заметно шире той ширины,
        // при которой текст влезал.
        const threshold = textFitsWidthRef.current > 0
          ? textFitsWidthRef.current + RETURN_MARGIN_PX
          : containerWidth * 0.9 // fallback: ref ещё не измерен (обрезка была с первого замера)
        if (containerWidth > threshold) {
          cancelPending()
          iconsOnlyRef.current = false
          setIconsOnly(false)
        }
      }
    }

    check()

    const ro = new ResizeObserver(check)
    ro.observe(container)
    window.addEventListener('resize', check)
    return () => {
      cancelPending()
      ro.disconnect()
      window.removeEventListener('resize', check)
    }
  }, [containerRef])

  return iconsOnly
}

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import {
  clampOffset,
  clampScale,
  IDENTITY_ZOOM,
  MIN_SCALE,
  zoomAtPoint,
  type ZoomBounds,
  type ZoomPoint,
  type ZoomState,
} from '@/lib/imageZoom'
import { Icon } from '../icon/Icon'

export interface ImageViewerProps {
  src: string
  alt: string
  onError?: () => void
  className?: string
  /** `data-testid` для `<img>` (нужен потребителям со своими тестами). */
  dataTestId?: string
}

/** Шаг кнопок «+»/«−». */
const ZOOM_STEP = 1.5
/** Масштаб двойного тапа/клика из вписанного состояния. */
const DOUBLE_TAP_SCALE = 2.5
/** Окно детекта двойного тапа. */
const DOUBLE_TAP_MS = 300
/** Допустимое смещение между двумя тапами. */
const DOUBLE_TAP_DISTANCE = 30

/** Базовый класс кнопки оверлея: тач-таргет 36px, на coarse-указателе — 40px. */
const CONTROL_CLASS =
  'inline-flex size-9 items-center justify-center rounded text-foreground transition-colors hover:bg-muted pointer-coarse:size-10'

interface PointerPosition {
  x: number
  y: number
}

interface PinchGesture {
  distance: number
  midpoint: ZoomPoint
  startScale: number
  startOffset: ZoomPoint
}

interface PanGesture {
  pointer: ZoomPoint
  offset: ZoomPoint
}

/**
 * Просмотр изображения с зумом и паном: Pointer Events (мышь/перо/палец),
 * щипок двумя пальцами, колесо/тачпад (в т.ч. `ctrlKey + wheel`), двойной
 * тап/клик и кнопки. Работает в PWA standalone; на iOS нативные жесты
 * страницы подавляются (`gesturestart`/`gesturechange`/`gestureend`).
 */
export function ImageViewer({ src, alt, onError, className, dataTestId }: ImageViewerProps) {
  const { t } = useI18n()
  const containerRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)

  const [zoom, setZoom] = useState<ZoomState>(IDENTITY_ZOOM)
  // Плавный `transition` — только для программных изменений (кнопки, двойной
  // тап). Во время жеста он выключен, иначе изображение «плывёт» за пальцем.
  const [animate, setAnimate] = useState(false)

  const zoomRef = useRef<ZoomState>(IDENTITY_ZOOM)
  const pointers = useRef<Map<number, PointerPosition>>(new Map())
  const pinch = useRef<PinchGesture | null>(null)
  const pan = useRef<PanGesture | null>(null)
  const lastTap = useRef<{ time: number; x: number; y: number } | null>(null)
  const lastToggleAt = useRef(0)

  const commit = useCallback((next: ZoomState) => {
    zoomRef.current = next
    setZoom(next)
  }, [])

  const updateZoom = useCallback((updater: (prev: ZoomState) => ZoomState) => {
    setZoom((prev) => {
      const next = updater(prev)
      zoomRef.current = next
      return next
    })
  }, [])

  const readBounds = useCallback((): ZoomBounds => {
    const img = imgRef.current
    const box = containerRef.current
    return {
      contentWidth: img?.offsetWidth ?? 0,
      contentHeight: img?.offsetHeight ?? 0,
      viewportWidth: box?.clientWidth ?? 0,
      viewportHeight: box?.clientHeight ?? 0,
    }
  }, [])

  /** Локальные координаты указателя относительно центра контейнера. */
  const pointInBox = useCallback((clientX: number, clientY: number): ZoomPoint => {
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return { x: 0, y: 0 }
    return {
      x: clientX - rect.left - rect.width / 2,
      y: clientY - rect.top - rect.height / 2,
    }
  }, [])

  const zoomTo = useCallback(
    (anchor: ZoomPoint, factor: number, animated: boolean) => {
      setAnimate(animated)
      updateZoom((prev) => zoomAtPoint(prev, factor, anchor, readBounds()))
    },
    [readBounds, updateZoom],
  )

  const toggleZoom = useCallback(
    (anchor: ZoomPoint) => {
      // Собственный детект тапа и `dblclick` мыши могут прийти оба — гасим
      // повтор в пределах окна, иначе масштаб переключится дважды.
      const now = Date.now()
      if (now - lastToggleAt.current < DOUBLE_TAP_MS) return
      lastToggleAt.current = now
      const current = zoomRef.current.scale
      zoomTo({ x: anchor.x, y: anchor.y }, current > MIN_SCALE ? MIN_SCALE / current : DOUBLE_TAP_SCALE, true)
    },
    [zoomTo],
  )

  const resetZoom = useCallback(() => {
    setAnimate(true)
    commit(IDENTITY_ZOOM)
  }, [commit])

  // Смена изображения — сброс масштаба и смещения.
  useEffect(() => {
    setAnimate(false)
    lastTap.current = null
    commit(IDENTITY_ZOOM)
  }, [src, commit])

  // Изменение размера контейнера — сбрасываем, иначе картинка остаётся
  // смещённой относительно новой видимой области.
  useEffect(() => {
    const box = containerRef.current
    if (!box || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      setAnimate(false)
      commit(IDENTITY_ZOOM)
    })
    observer.observe(box)
    return () => observer.disconnect()
  }, [commit])

  // Колесо и pinch тачпада (приходит как `ctrlKey + wheel`). Нативный
  // слушатель нужен ради `passive: false`: без `preventDefault` страница
  // прокручивается/зумится вместе с изображением.
  useEffect(() => {
    const box = containerRef.current
    if (!box) return
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault()
      const anchor = pointInBox(event.clientX, event.clientY)
      const factor = Math.exp(-event.deltaY * 0.0015)
      setAnimate(false)
      updateZoom((prev) => zoomAtPoint(prev, factor, anchor, readBounds()))
    }
    box.addEventListener('wheel', handleWheel, { passive: false })
    return () => box.removeEventListener('wheel', handleWheel)
  }, [pointInBox, readBounds, updateZoom])

  // iOS Safari: нативные жесты страницы подавляем, иначе приложение зумится
  // целиком (в PWA standalone это ломает вёрстку и уводит картинку).
  useEffect(() => {
    const box = containerRef.current
    if (!box) return
    const prevent = (event: Event) => event.preventDefault()
    const gestures = ['gesturestart', 'gesturechange', 'gestureend']
    for (const name of gestures) box.addEventListener(name, prevent, { passive: false })
    return () => {
      for (const name of gestures) box.removeEventListener(name, prevent)
    }
  }, [])

  const startPinch = useCallback(() => {
    const points = [...pointers.current.values()]
    if (points.length < 2) return
    const [a, b] = points
    pinch.current = {
      distance: Math.hypot(a.x - b.x, a.y - b.y),
      midpoint: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      startScale: zoomRef.current.scale,
      startOffset: { x: zoomRef.current.x, y: zoomRef.current.y },
    }
  }, [])

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    event.currentTarget.setPointerCapture?.(event.pointerId)
    setAnimate(false)
    const point = pointInBox(event.clientX, event.clientY)
    pointers.current.set(event.pointerId, point)
    if (pointers.current.size === 2) {
      pan.current = null
      startPinch()
    } else if (pointers.current.size === 1) {
      pan.current = { pointer: point, offset: { x: zoomRef.current.x, y: zoomRef.current.y } }
    }
  }

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return
    const point = pointInBox(event.clientX, event.clientY)
    pointers.current.set(event.pointerId, point)

    if (pointers.current.size >= 2) {
      const gesture = pinch.current
      if (!gesture) return
      const points = [...pointers.current.values()]
      const [a, b] = points
      const distance = Math.hypot(a.x - b.x, a.y - b.y)
      const midpoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
      const scale = clampScale(gesture.startScale * (distance / (gesture.distance || 1)))
      const ratio = scale / gesture.startScale
      const x = midpoint.x - (gesture.midpoint.x - gesture.startOffset.x) * ratio
      const y = midpoint.y - (gesture.midpoint.y - gesture.startOffset.y) * ratio
      commit(clampOffset(x, y, readBounds(), scale))
      return
    }

    const start = pan.current
    if (!start || zoomRef.current.scale <= MIN_SCALE) return
    const x = start.offset.x + (point.x - start.pointer.x)
    const y = start.offset.y + (point.y - start.pointer.y)
    commit(clampOffset(x, y, readBounds(), zoomRef.current.scale))
  }

  const releasePointer = (event: ReactPointerEvent<HTMLDivElement>, detectTap: boolean) => {
    if (!pointers.current.has(event.pointerId)) return
    pointers.current.delete(event.pointerId)

    if (pointers.current.size === 1) {
      // Остался один палец после щипка — пересчитываем базу пана от текущего
      // смещения, иначе изображение скакнёт.
      pinch.current = null
      const point = [...pointers.current.values()][0]
      pan.current = { pointer: point, offset: { x: zoomRef.current.x, y: zoomRef.current.y } }
      return
    }
    if (pointers.current.size === 0) {
      pinch.current = null
      pan.current = null
    }
    if (!detectTap || event.pointerType === 'mouse') return
    // Собственный детект двойного тапа: на iOS после `touch-action: none`
    // `dblclick` не приходит.
    const now = Date.now()
    const point = pointInBox(event.clientX, event.clientY)
    const previous = lastTap.current
    if (
      previous &&
      now - previous.time < DOUBLE_TAP_MS &&
      Math.hypot(point.x - previous.x, point.y - previous.y) < DOUBLE_TAP_DISTANCE
    ) {
      lastTap.current = null
      toggleZoom(point)
      return
    }
    lastTap.current = { time: now, x: point.x, y: point.y }
  }

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => releasePointer(event, true)
  const handlePointerCancel = (event: ReactPointerEvent<HTMLDivElement>) =>
    releasePointer(event, false)

  const handleDoubleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault()
    toggleZoom(pointInBox(event.clientX, event.clientY))
  }

  const percent = Math.round(zoom.scale * 100)

  return (
    <div
      ref={containerRef}
      role="group"
      aria-label={alt}
      data-testid="image-viewer"
      className={cn(
        'image-viewer relative flex h-full w-full min-h-0 min-w-0 touch-none select-none items-center justify-center overflow-hidden',
        className,
      )}
      style={{ touchAction: 'none', overscrollBehavior: 'contain', userSelect: 'none' }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onLostPointerCapture={handlePointerCancel}
      onDoubleClick={handleDoubleClick}
    >
      <img
        ref={imgRef}
        src={src}
        alt={alt}
        data-testid={dataTestId}
        draggable={false}
        onError={onError}
        className="max-h-full max-w-full object-contain"
        style={{
          transform: `translate3d(${zoom.x}px, ${zoom.y}px, 0) scale(${zoom.scale})`,
          transition: animate ? 'transform 180ms ease-out' : 'none',
          willChange: 'transform',
          userSelect: 'none',
        }}
      />
      <div
        className="absolute bottom-3 right-3 flex items-center gap-1 rounded-lg border border-border bg-background/80 p-1 shadow-sm backdrop-blur"
        onPointerDown={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        onWheel={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          onClick={() => zoomTo({ x: 0, y: 0 }, 1 / ZOOM_STEP, true)}
          aria-label={t('file.zoomOut')}
          title={t('file.zoomOut')}
          className={CONTROL_CLASS}
        >
          <Icon name="zoom-out" className="size-4" />
        </button>
        <span
          aria-live="polite"
          className="min-w-12 px-1 text-center text-xs tabular-nums text-muted-foreground"
        >
          {t('file.zoomLevel', { percent })}
        </span>
        <button
          type="button"
          onClick={() => zoomTo({ x: 0, y: 0 }, ZOOM_STEP, true)}
          aria-label={t('file.zoomIn')}
          title={t('file.zoomIn')}
          className={CONTROL_CLASS}
        >
          <Icon name="zoom-in" className="size-4" />
        </button>
        <button
          type="button"
          onClick={resetZoom}
          aria-label={t('file.zoomReset')}
          title={t('file.zoomReset')}
          className={CONTROL_CLASS}
        >
          <Icon name="refresh" className="size-4" />
        </button>
      </div>
    </div>
  )
}

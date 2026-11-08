import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'

/** Порог начала перетаскивания, px: меньше — считаем кликом. */
const DRAG_THRESHOLD = 5

interface PendingDrag {
  cardEl: HTMLElement
  cardId: string
  pointerId: number
  startX: number
  startY: number
  rect: DOMRect
}

interface ActiveDrag extends PendingDrag {
  ghost: HTMLElement
  grabX: number
  grabY: number
}

export interface UsePlanCardDragOptions {
  /** Перетаскивание разрешено (вызывающий знает про указатель и права). */
  enabled: boolean
  /** Колонка под указателем изменилась (подсветка). */
  onColumnChange?: (columnId: string | null) => void
  /** Карточка отпущена в колонке. */
  onDrop: (cardId: string, columnId: string) => void
  /** Перетаскивание отменено (Esc / pointercancel / потеря фокуса). */
  onCancel?: () => void
}

/**
 * Кастомный drag карточек доски на Pointer Events — без нативного drag-image.
 *
 * Preview — DOM-клон карточки: точная копия (текст, приоритет, описание, иконки,
 * скруглённые углы), в отличие от нативного снимка `draggable`-элемента, который
 * рисуется прямоугольником и теряет `border-radius`.
 *
 * Ключевые решения:
 *  - drag начинается только после сдвига > DRAG_THRESHOLD (иначе — обычный клик);
 *  - `setPointerCapture` вызывается уже на старте drag: capture на `pointerdown`
 *    перенаправляет `click` с кнопки на карточку и ломает кнопки карточки;
 *  - призрак — императивный узел в `document.body`: не зависит от ре-рендеров React;
 *  - клик, порождённый перетаскиванием, глушится на capture-фазе;
 *  - touch не перехватываем (ADR-044: на тач-устройствах — меню «Переместить»);
 *  - `document.elementFromPoint` в jsdom не реализован — есть feature-detect.
 */
export function usePlanCardDrag({
  enabled,
  onColumnChange,
  onDrop,
  onCancel,
}: UsePlanCardDragOptions) {
  const pendingRef = useRef<PendingDrag | null>(null)
  const dragRef = useRef<ActiveDrag | null>(null)
  const lastColumnIdRef = useRef<string | null>(null)
  const suppressClickRef = useRef(false)
  const [draggingCardId, setDraggingCardId] = useState<string | null>(null)

  // Колбэки в ref: слушатели окна не должны переподписываться на каждый рендер.
  const cbRef = useRef({ onColumnChange, onDrop, onCancel })
  cbRef.current = { onColumnChange, onDrop, onCancel }

  const teardown = useCallback((cancelled: boolean) => {
    dragRef.current?.ghost.remove()
    document.body.classList.remove('select-none')
    dragRef.current = null
    pendingRef.current = null
    lastColumnIdRef.current = null
    setDraggingCardId(null)
    cbRef.current.onColumnChange?.(null)
    if (cancelled) cbRef.current.onCancel?.()
  }, [])

  // Призрак и «захват» должны умереть вместе с компонентом.
  useEffect(() => () => teardown(false), [teardown])

  // Клик после перетаскивания гасим (capture-фаза — раньше onClick кнопки).
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (!suppressClickRef.current) return
      suppressClickRef.current = false
      e.stopPropagation()
      e.preventDefault()
    }
    document.addEventListener('click', onClick, true)
    return () => document.removeEventListener('click', onClick, true)
  }, [])

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      suppressClickRef.current = false
      if (!enabled) return
      // ADR-044: на тач-устройствах используем меню «Переместить», не drag.
      if (e.pointerType === 'touch') return
      if (e.pointerType === 'mouse' && e.button !== 0) return
      const cardEl = (e.target as HTMLElement).closest<HTMLElement>('[data-plan-card-id]')
      if (!cardEl) return
      pendingRef.current = {
        cardEl,
        cardId: cardEl.dataset.planCardId ?? '',
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        rect: cardEl.getBoundingClientRect(),
      }
    },
    [enabled],
  )

  useEffect(() => {
    const startDrag = (e: PointerEvent, pending: PendingDrag) => {
      // Точная копия карточки: текст, бейдж приоритета, описание, иконки, радиус.
      const ghost = pending.cardEl.cloneNode(true) as HTMLElement
      ghost.removeAttribute('data-plan-card-id')
      ghost.removeAttribute('data-testid')
      ghost.setAttribute('aria-hidden', 'true')
      ghost.style.position = 'fixed'
      ghost.style.left = '0'
      ghost.style.top = '0'
      ghost.style.width = `${pending.rect.width}px`
      ghost.style.pointerEvents = 'none'
      ghost.style.zIndex = '60'
      ghost.style.willChange = 'transform'
      ghost.style.filter = 'drop-shadow(0 12px 22px rgb(0 0 0 / 0.45))'
      document.body.appendChild(ghost)

      const grabX = pending.startX - pending.rect.left
      const grabY = pending.startY - pending.rect.top
      // Сразу ставим призрак под текущую точку, иначе он мигнёт в (0, 0).
      ghost.style.transform = `translate3d(${e.clientX - grabX}px, ${e.clientY - grabY}px, 0)`

      dragRef.current = { ...pending, ghost, grabX, grabY }
      pendingRef.current = null
      setDraggingCardId(pending.cardId)
      document.body.classList.add('select-none')
      // Capture — только на старте drag (см. комментарий хука).
      pending.cardEl.setPointerCapture?.(e.pointerId)
    }

    const onMove = (e: PointerEvent) => {
      const drag = dragRef.current
      if (!drag) {
        const pending = pendingRef.current
        if (!pending || e.pointerId !== pending.pointerId) return
        const dist = Math.hypot(e.clientX - pending.startX, e.clientY - pending.startY)
        if (dist < DRAG_THRESHOLD) return
        startDrag(e, pending)
        return
      }
      if (e.pointerId !== drag.pointerId) return

      // Только transform — без layout-инвалидации.
      drag.ghost.style.transform = `translate3d(${e.clientX - drag.grabX}px, ${e.clientY - drag.grabY}px, 0)`

      // Колонка под указателем. В jsdom elementFromPoint нет — отсюда feature-detect.
      const under =
        typeof document.elementFromPoint === 'function'
          ? document.elementFromPoint(e.clientX, e.clientY)
          : null
      const columnEl = under?.closest<HTMLElement>('[data-plan-column-id]') ?? null
      const columnId = columnEl?.dataset.planColumnId ?? null
      // Колбэк — только при смене колонки (иначе React перерисовывал бы доску каждый кадр).
      if (columnId !== lastColumnIdRef.current) {
        lastColumnIdRef.current = columnId
        cbRef.current.onColumnChange?.(columnId)
      }
    }

    const onUp = (e: PointerEvent) => {
      const drag = dragRef.current
      if (!drag) {
        pendingRef.current = null
        return
      }
      if (e.pointerId !== drag.pointerId) return
      const columnId = lastColumnIdRef.current
      const cardId = drag.cardId
      suppressClickRef.current = true
      teardown(false)
      if (columnId) cbRef.current.onDrop(cardId, columnId)
    }

    const onCancelEvent = () => {
      if (!dragRef.current) {
        pendingRef.current = null
        return
      }
      suppressClickRef.current = true
      teardown(true)
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !dragRef.current) return
      e.preventDefault()
      suppressClickRef.current = true
      teardown(true)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancelEvent)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancelEvent)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [teardown])

  return { onPointerDown, draggingCardId }
}

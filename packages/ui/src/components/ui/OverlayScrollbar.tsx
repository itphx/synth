import React from "react"

type OverlayScrollbarProps = {
  containerRef: React.RefObject<HTMLElement | null>
  minThumbSize?: number
  hideDelayMs?: number
  className?: string
  disableHorizontal?: boolean
  observeMutations?: boolean
}

type ThumbMetrics = {
  length: number
  offset: number
}

const METRIC_EPSILON = 0.5
const EMPTY_THUMB: ThumbMetrics = { length: 0, offset: 0 }

const isSameThumbMetrics = (a: ThumbMetrics, b: ThumbMetrics): boolean => {
  return Math.abs(a.length - b.length) < METRIC_EPSILON && Math.abs(a.offset - b.offset) < METRIC_EPSILON
}

const OverlayScrollbarComponent: React.FC<OverlayScrollbarProps> = ({
  containerRef,
  minThumbSize = 32,
  hideDelayMs = 1000,
  className,
  disableHorizontal = false,
  observeMutations = true,
}) => {
  const [visible, setVisible] = React.useState(false)
  const [vertical, setVertical] = React.useState<ThumbMetrics>({ length: 0, offset: 0 })
  const [horizontal, setHorizontal] = React.useState<ThumbMetrics>({ length: 0, offset: 0 })
  const hideTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const frameRef = React.useRef<number | null>(null)
  const metricsFrameRef = React.useRef<number | null>(null)
  const isDraggingRef = React.useRef(false)
  const isHoveringRef = React.useRef(false)
  const dragStartRef = React.useRef<{
    pointerX: number
    pointerY: number
    scrollTop: number
    scrollLeft: number
  }>({ pointerX: 0, pointerY: 0, scrollTop: 0, scrollLeft: 0 })
  const dragAxisRef = React.useRef<"vertical" | "horizontal" | null>(null)
  const observedElementsRef = React.useRef<Set<Element>>(new Set())

  const updateMetrics = React.useCallback(() => {
    const container = containerRef.current
    if (!container) return

    const { scrollHeight, clientHeight, scrollTop, scrollWidth, clientWidth, scrollLeft } = container
    const trackInset = 8

    let nextVertical: ThumbMetrics = EMPTY_THUMB
    if (scrollHeight > clientHeight) {
      const trackLength = Math.max(clientHeight - trackInset * 2, 0)
      const rawThumb = (clientHeight / scrollHeight) * trackLength
      const length = Math.max(minThumbSize, Math.min(trackLength, rawThumb))
      const maxOffset = Math.max(trackLength - length, 0)
      const maxScroll = Math.max(scrollHeight - clientHeight, 1)
      const offset = (scrollTop / maxScroll) * maxOffset
      nextVertical = { length, offset }
    }
    setVertical((prev) => (isSameThumbMetrics(prev, nextVertical) ? prev : nextVertical))

    let nextHorizontal: ThumbMetrics = EMPTY_THUMB
    if (!disableHorizontal && scrollWidth > clientWidth) {
      const trackLength = Math.max(clientWidth - trackInset * 2, 0)
      const rawThumb = (clientWidth / scrollWidth) * trackLength
      const length = Math.max(minThumbSize, Math.min(trackLength, rawThumb))
      const maxOffset = Math.max(trackLength - length, 0)
      const maxScroll = Math.max(scrollWidth - clientWidth, 1)
      const offset = (scrollLeft / maxScroll) * maxOffset
      nextHorizontal = { length, offset }
    }
    setHorizontal((prev) => (isSameThumbMetrics(prev, nextHorizontal) ? prev : nextHorizontal))
  }, [containerRef, minThumbSize, disableHorizontal])

  const scheduleMetricsUpdate = React.useCallback(() => {
    if (metricsFrameRef.current !== null) return
    metricsFrameRef.current = requestAnimationFrame(() => {
      metricsFrameRef.current = null
      updateMetrics()
    })
  }, [updateMetrics])

  const syncObservedElements = React.useCallback((container: HTMLElement, resizeObserver: ResizeObserver | null) => {
    if (!resizeObserver) {
      observedElementsRef.current.clear()
      return
    }
    const nextObserved = new Set<Element>()
    nextObserved.add(container)
    Array.from(container.children).forEach((child) => {
      nextObserved.add(child)
    })
    observedElementsRef.current.forEach((element) => {
      if (!nextObserved.has(element)) {
        resizeObserver.unobserve(element)
      }
    })
    nextObserved.forEach((element) => {
      if (!observedElementsRef.current.has(element)) {
        resizeObserver.observe(element)
      }
    })
    observedElementsRef.current = nextObserved
  }, [])

  const scheduleHide = React.useCallback(() => {
    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current)
    }
    if (isHoveringRef.current) {
      return
    }
    hideTimeoutRef.current = setTimeout(() => setVisible(false), hideDelayMs)
  }, [hideDelayMs])

  const handleScroll = React.useCallback(() => {
    if (frameRef.current) {
      cancelAnimationFrame(frameRef.current)
    }
    frameRef.current = requestAnimationFrame(() => {
      updateMetrics()
      setVisible(true)
      scheduleHide()
    })
  }, [scheduleHide, updateMetrics])

  React.useEffect(() => {
    const container = containerRef.current
    if (!container) return

    updateMetrics()
    setVisible(false)

    const onScroll = () => handleScroll()
    container.addEventListener("scroll", onScroll, { passive: true })

    const resizeObserver =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => {
            scheduleMetricsUpdate()
          })
        : null
    syncObservedElements(container, resizeObserver)

    const mutationObserver =
      observeMutations && typeof MutationObserver !== "undefined"
        ? new MutationObserver(() => {
            syncObservedElements(container, resizeObserver)
            scheduleMetricsUpdate()
          })
        : null
    mutationObserver?.observe(container, { childList: true })

    const onInput = () => scheduleMetricsUpdate()
    const onLoad = () => scheduleMetricsUpdate()
    container.addEventListener("input", onInput, true)
    container.addEventListener("load", onLoad, true)

    return () => {
      container.removeEventListener("scroll", onScroll)
      container.removeEventListener("input", onInput, true)
      container.removeEventListener("load", onLoad, true)
      resizeObserver?.disconnect()
      mutationObserver?.disconnect()
      observedElementsRef.current.clear()
      if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current)
      if (frameRef.current) cancelAnimationFrame(frameRef.current)
      if (metricsFrameRef.current) cancelAnimationFrame(metricsFrameRef.current)
    }
  }, [containerRef, handleScroll, observeMutations, scheduleMetricsUpdate, syncObservedElements, updateMetrics])

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>, axis: "vertical" | "horizontal") => {
    const container = containerRef.current
    if (!container) return

    isDraggingRef.current = true
    dragStartRef.current = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      scrollTop: container.scrollTop,
      scrollLeft: container.scrollLeft,
    }
    dragAxisRef.current = axis
    setVisible(true)
    if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current)
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!isDraggingRef.current) return
    const container = containerRef.current
    if (!container) return

    const axis = dragAxisRef.current
    if (axis === "vertical") {
      const { pointerY, scrollTop } = dragStartRef.current
      const delta = event.clientY - pointerY
      const trackLength = container.clientHeight
      const thumbTravel = Math.max(trackLength - vertical.length, 1)
      const maxScroll = Math.max(container.scrollHeight - container.clientHeight, 1)
      const scrollDelta = (delta / thumbTravel) * maxScroll
      container.scrollTop = scrollTop + scrollDelta
    } else if (axis === "horizontal") {
      const { pointerX, scrollLeft } = dragStartRef.current
      const delta = event.clientX - pointerX
      const trackLength = container.clientWidth
      const thumbTravel = Math.max(trackLength - horizontal.length, 1)
      const maxScroll = Math.max(container.scrollWidth - container.clientWidth, 1)
      const scrollDelta = (delta / thumbTravel) * maxScroll
      container.scrollLeft = scrollLeft + scrollDelta
    }
  }

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!isDraggingRef.current) return
    isDraggingRef.current = false
    event.currentTarget.releasePointerCapture(event.pointerId)
    scheduleHide()
  }

  const handleThumbMouseEnter = React.useCallback(() => {
    isHoveringRef.current = true
    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current)
      hideTimeoutRef.current = null
    }
  }, [])

  const handleThumbMouseLeave = React.useCallback(() => {
    isHoveringRef.current = false
    scheduleHide()
  }, [scheduleHide])

  const showVertical = vertical.length > 0
  const showHorizontal = horizontal.length > 0
  if (!showVertical && !showHorizontal) return null

  const trackInset = 8

  return (
    <div
      className={`overlay-scrollbar${className ? ` ${className}` : ''}`}
      aria-hidden="true"
      style={{ opacity: visible ? 1 : 0 }}
    >
      {showVertical && (
        <div
          className="overlay-scrollbar__thumb overlay-scrollbar__thumb--vertical"
          data-overlay-scrollbar-thumb="vertical"
          style={{
            height: `${vertical.length}px`,
            top: `${trackInset + vertical.offset}px`,
            right: `${trackInset / 2}px`,
          }}
          onPointerDown={(e) => handlePointerDown(e, "vertical")}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onMouseEnter={handleThumbMouseEnter}
          onMouseLeave={handleThumbMouseLeave}
        />
      )}
      {showHorizontal && (
        <div
          className="overlay-scrollbar__thumb overlay-scrollbar__thumb--horizontal"
          data-overlay-scrollbar-thumb="horizontal"
          style={{
            width: `${horizontal.length}px`,
            left: `${trackInset + horizontal.offset}px`,
            bottom: `${trackInset / 2}px`,
          }}
          onPointerDown={(e) => handlePointerDown(e, "horizontal")}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onMouseEnter={handleThumbMouseEnter}
          onMouseLeave={handleThumbMouseLeave}
        />
      )}
    </div>
  )
}

OverlayScrollbarComponent.displayName = "OverlayScrollbar"

export const OverlayScrollbar = OverlayScrollbarComponent

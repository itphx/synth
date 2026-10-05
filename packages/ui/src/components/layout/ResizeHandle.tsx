import { useCallback, useRef } from 'react'

interface ResizeHandleProps {
  position: 'left' | 'right'
  onResize: (delta: number) => void
  onResizeStart?: () => void
  onResizeEnd?: () => void
}

export const ResizeHandle = ({
  position,
  onResize,
  onResizeStart,
  onResizeEnd,
}: ResizeHandleProps) => {
  const isResizingRef = useRef(false)
  const activePointerIdRef = useRef<number | null>(null)
  const lastXRef = useRef(0)

  const handlePointerDown = useCallback(
    (event: React.PointerEvent) => {
      event.currentTarget.setPointerCapture(event.pointerId)
      activePointerIdRef.current = event.pointerId
      lastXRef.current = event.clientX
      isResizingRef.current = true
      onResizeStart?.()
      event.preventDefault()
    },
    [onResizeStart]
  )

  const handlePointerMove = useCallback(
    (event: React.PointerEvent) => {
      if (!isResizingRef.current || activePointerIdRef.current !== event.pointerId) {
        return
      }

      const delta = event.clientX - lastXRef.current
      lastXRef.current = event.clientX
      const signedDelta = position === 'left' ? -delta : delta
      onResize(signedDelta)
    },
    [position, onResize]
  )

  const handlePointerUp = useCallback(
    (event: React.PointerEvent) => {
      if (activePointerIdRef.current !== event.pointerId) return
      event.currentTarget.releasePointerCapture(event.pointerId)
      activePointerIdRef.current = null
      isResizingRef.current = false
      onResizeEnd?.()
    },
    [onResizeEnd]
  )

  return (
    <div
      className={`absolute top-0 h-full w-[0.1875rem] cursor-col-resize hover:bg-primary transition-colors ${
        position === 'right' ? 'right-0' : 'left-0'
      }`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      role="separator"
      aria-orientation="vertical"
    />
  )
}
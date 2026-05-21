import React from "react"
import { OverlayScrollbar } from "./OverlayScrollbar"

type ScrollableOverlayProps = React.HTMLAttributes<HTMLElement> & {
  minThumbSize?: number
  hideDelayMs?: number
  outerClassName?: string
  scrollbarClassName?: string
  disableHorizontal?: boolean
  observeMutations?: boolean
  fillContainer?: boolean
}

export const ScrollableOverlay = React.forwardRef<HTMLElement, ScrollableOverlayProps>(
  ({
    className,
    outerClassName,
    children,
    style,
    minThumbSize,
    hideDelayMs,
    scrollbarClassName,
    disableHorizontal = false,
    observeMutations = true,
    fillContainer = true,
    ...rest
  }, ref) => {
    const containerRef = React.useRef<HTMLElement | null>(null)

    React.useImperativeHandle(ref, () => containerRef.current as HTMLElement, [])

    return (
      <div
        className={`relative flex flex-col min-h-0 w-full overflow-hidden${outerClassName ? ` ${outerClassName}` : ''}`}
      >
        <div
          ref={containerRef as React.Ref<HTMLDivElement>}
          className={`overlay-scrollbar-target${fillContainer ? ' flex-1 min-h-0 w-full' : ' flex-none w-full h-auto'} overflow-auto${className ? ` ${className}` : ''}`}
          style={style}
          {...rest}
        >
          {children}
        </div>
        <OverlayScrollbar
          containerRef={containerRef as React.RefObject<HTMLElement>}
          minThumbSize={minThumbSize}
          hideDelayMs={hideDelayMs}
          className={scrollbarClassName}
          disableHorizontal={disableHorizontal}
          observeMutations={observeMutations}
        />
      </div>
    )
  }
)

ScrollableOverlay.displayName = "ScrollableOverlay"

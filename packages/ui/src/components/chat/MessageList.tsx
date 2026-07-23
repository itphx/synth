import { useRef, useCallback, useState, useEffect } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ChatMessage } from './ChatMessage'
import { StreamingPlaceholder } from './StreamingPlaceholder'
import { ScrollToBottomButton } from './ScrollToBottomButton'
import { ScrollableOverlay } from '../ui/ScrollableOverlay'
import type { MessageData, StreamState } from '@/stores/chatStore'

interface MessageListProps {
  messages: MessageData[]
  streams: Record<string, StreamState>
  onCopy: (msg: MessageData) => void
  onToggle: (msg: MessageData) => void
  onPin: (msg: MessageData) => void
  onDelete: (msg: MessageData) => void
  onRetry: (msg: MessageData) => void
  onDebug: (msg: MessageData) => void
  onFork: (msg: MessageData) => void
  readOnly?: boolean
  onStop: () => void
  /** true если сессия — дочерняя (сабагент) */
  isSubagent?: boolean
}

const VIRTUALIZE_THRESHOLD = 30
const OVERSCAN = 30

export function MessageList({
  messages,
  streams,
  onCopy,
  onToggle,
  onPin,
  onDelete,
  onRetry,
  onDebug,
  onFork,
  readOnly,
  onStop,
  isSubagent,
}: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [autoScroll, setAutoScroll] = useState(true)
  const [showScrollBtn, setShowScrollBtn] = useState(false)

  const streamEntries = Object.values(streams).filter((s) => s.isStreaming)
  const streamContentSize = streamEntries.reduce((sum, s) => sum + s.content.length + s.reasoningBlocks.reduce((rsum, r) => rsum + r.text.length, 0), 0)

  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 200,
    overscan: OVERSCAN,
  })

  const scrollToBottom = useCallback((smooth = true) => {
    if (!scrollRef.current) return
    scrollRef.current.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: smooth ? 'smooth' : 'instant',
    })
    setAutoScroll(true)
    setShowScrollBtn(false)
  }, [])

  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current
    const atBottom = scrollHeight - scrollTop - clientHeight < 60
    setAutoScroll(atBottom)
    setShowScrollBtn(!atBottom && scrollHeight > clientHeight + 100)

    const hasTop = scrollTop > 1
    const hasBottom = scrollHeight - scrollTop - clientHeight > 1
    const el = scrollRef.current
    if (hasTop && hasBottom) {
      el.setAttribute('data-scroll-shadow', 'top-bottom')
    } else if (hasTop) {
      el.setAttribute('data-scroll-shadow', 'top')
    } else if (hasBottom) {
      el.setAttribute('data-scroll-shadow', 'bottom')
    } else {
      el.removeAttribute('data-scroll-shadow')
    }
  }, [])

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      requestAnimationFrame(() => {
        scrollToBottom(false)
      })
    }
  }, [messages, streamContentSize, streamEntries.length, autoScroll, scrollToBottom])

  const shouldVirtualize = messages.length > VIRTUALIZE_THRESHOLD
  const virtualItems = virtualizer.getVirtualItems()

  const chatMsgProps = useCallback((msg: MessageData) => ({
    message: msg,
    onCopy: () => onCopy(msg),
    onToggle: () => onToggle(msg),
    onPin: () => onPin(msg),
    onDelete: () => onDelete(msg),
    onRetry: () => onRetry(msg),
    onDebug: () => onDebug(msg),
    onFork: () => onFork(msg),
    readOnly,
    isSubagent,
  }), [onCopy, onToggle, onPin, onDelete, onRetry, onDebug, onFork, readOnly, isSubagent])

  return (
    <div className="relative flex-1 overflow-hidden">
      <ScrollableOverlay
        ref={scrollRef as unknown as React.Ref<HTMLElement>}
        outerClassName="h-full"
        className="overflow-y-auto overflow-x-hidden chat-scroll-container"
        onScroll={handleScroll}
      >
        <div
          className="relative w-full"
          style={{
            height: shouldVirtualize ? `${virtualizer.getTotalSize()}px` : 'auto',
          }}
        >
          {shouldVirtualize ? (
            <div
              className="absolute top-0 left-0 w-full"
              style={{
                transform: `translateY(${virtualItems[0]?.start ?? 0}px)`,
              }}
            >
              {virtualItems.map((vi) => {
                const msg = messages[vi.index]
                if (!msg) return null
                return (
                  <div key={msg.id || msg.index} data-index={vi.index} ref={virtualizer.measureElement}>
                    <ChatMessage {...chatMsgProps(msg)} />
                  </div>
                )
              })}
            </div>
          ) : (
            messages.map((msg) => (
              <ChatMessage
                key={msg.id || `${msg.role}-${msg.index}-${msg.created_at}`}
                {...chatMsgProps(msg)}
              />
            ))
          )}

        </div>

          {streamEntries.map((stream) => (
            <StreamingPlaceholder key={stream.streamId} stream={stream} onStop={onStop} />
          ))}
      </ScrollableOverlay>

      <ScrollToBottomButton visible={showScrollBtn} onClick={() => scrollToBottom()} />
    </div>
  )
}

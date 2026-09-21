import { useRef, useCallback, useState, useEffect } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ChatMessage, type PendingStreamStatus } from './ChatMessage'
import { StreamingPlaceholder } from './StreamingPlaceholder'
import { ScrollToBottomButton } from './ScrollToBottomButton'
import { ScrollableOverlay } from '../ui/ScrollableOverlay'
import { isVisibleMessage } from './messageVisibility'
import type { MessageData, StreamState, StreamRetry } from '@/stores/chatStore'

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
  selectionMode?: boolean
  selectedIndices?: Set<number>
  onToggleSelect?: (index: number, shiftKey: boolean) => void
  onSelectRange?: (from: number, to: number) => void
  /** Статус повторной попытки (stream.retry) — показываем вместо «крутилки» */
  retry?: StreamRetry | null
  onRetryNow?: () => void
  onCancelRetry?: () => void
}

const VIRTUALIZE_THRESHOLD = 30
const OVERSCAN = 30

/**
 * Статус активного стрима, связанного с user-сообщением (по metadata.stream_id),
 * пока провайдер ещё не вернул ни одного чанка. null — статус не показываем.
 * Вынесено на уровень модуля, чтобы рендер не создавал замыкание.
 */
function computePending(
  msg: MessageData,
  streams: Record<string, StreamState>,
  retry: StreamRetry | null | undefined,
  onRetryNow?: () => void,
  onCancelRetry?: () => void
): PendingStreamStatus | null {
  if (msg.role !== 'user') return null
  const streamId = msg.metadata?.stream_id as string | undefined
  if (!streamId) return null
  const s = streams[streamId]
  if (!s || !s.isStreaming || s.hasContent) return null
  const r = retry && retry.streamId === streamId ? retry : null
  return r ? { status: 'retrying', retry: r, onRetryNow, onCancelRetry } : { status: 'processing' }
}

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
  selectionMode,
  selectedIndices,
  onToggleSelect,
  onSelectRange,
  retry,
  onRetryNow,
  onCancelRetry,
}: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const chatZoneRef = useRef<HTMLDivElement>(null)
  const [btnLeft, setBtnLeft] = useState<number | null>(null)
  const [autoScroll, setAutoScroll] = useState(true)
  const [showScrollBtn, setShowScrollBtn] = useState(false)
  const lastClickedRef = useRef<number | null>(null)

  // Кнопка «Вниз»: чуть правее правой границы зоны чата; если места справа нет — внутрь зоны.
  useEffect(() => {
    const container = containerRef.current
    const zone = chatZoneRef.current
    if (!container || !zone) return

    const update = () => {
      const cw = container.clientWidth
      const zw = zone.clientWidth
      const zoneRight = (cw - zw) / 2 + zw
      const btnW = 36
      const gap = 8
      setBtnLeft(cw - zoneRight >= btnW + gap ? zoneRight + gap : cw - btnW - gap)
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(container)
    ro.observe(zone)
    return () => ro.disconnect()
  }, [])

  const streamEntries = Object.values(streams).filter((s) => s.isStreaming && s.hasContent)
  const streamContentSize = streamEntries.reduce((sum, s) => sum + s.content.length + s.reasoningBlocks.reduce((rsum, r) => rsum + r.text.length, 0), 0)

  // Служебные сообщения tool-chain (metadata.tool_chain === true) не рендерятся
  // отдельными пузырями — их визуальное представление уже в финальном сообщении
  // (tool_calls / reasoning_blocks / intermediate_text_blocks). Durable
  // state-сообщения режима/плана/todo (AD-070 §2.8) тоже скрыты в UI.
  const visibleMessages = messages.filter(isVisibleMessage)

  const virtualizer = useVirtualizer({
    count: visibleMessages.length,
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

  const shouldVirtualize = visibleMessages.length > VIRTUALIZE_THRESHOLD
  const virtualItems = virtualizer.getVirtualItems()

  const handleToggleSelect = useCallback((index: number, shiftKey: boolean) => {
    if (shiftKey && lastClickedRef.current != null) {
      const from = Math.min(lastClickedRef.current, index)
      const to = Math.max(lastClickedRef.current, index)
      onSelectRange?.(from, to)
    } else {
      onToggleSelect?.(index, shiftKey)
    }
    lastClickedRef.current = index
  }, [onToggleSelect, onSelectRange])

  return (
    <div ref={containerRef} className="relative flex-1 overflow-hidden">
      <ScrollableOverlay
        ref={scrollRef as unknown as React.Ref<HTMLElement>}
        outerClassName="h-full"
        className="overflow-y-auto overflow-x-hidden chat-scroll-container"
        onScroll={handleScroll}
      >
        <div ref={chatZoneRef} className="chat-column mx-auto w-full">
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
                  const msg = visibleMessages[vi.index]
                  if (!msg) return null
                  return (
                    <div key={msg.id || msg.index} data-index={vi.index} ref={virtualizer.measureElement}>
                      <ChatMessage
                        message={msg}
                        onCopy={onCopy}
                        onToggle={onToggle}
                        onPin={onPin}
                        onDelete={onDelete}
                        onRetry={onRetry}
                        onDebug={onDebug}
                        onFork={onFork}
                        readOnly={readOnly}
                        isSubagent={isSubagent}
                        selectionMode={selectionMode}
                        isSelected={selectedIndices?.has(msg.index) ?? false}
                        onToggleSelect={handleToggleSelect}
                        pending={computePending(msg, streams, retry, onRetryNow, onCancelRetry)}
                      />
                    </div>
                  )
                })}
              </div>
            ) : (
              visibleMessages.map((msg) => (
                <ChatMessage
                  key={msg.id || `${msg.role}-${msg.index}-${msg.created_at}`}
                  message={msg}
                  onCopy={onCopy}
                  onToggle={onToggle}
                  onPin={onPin}
                  onDelete={onDelete}
                  onRetry={onRetry}
                  onDebug={onDebug}
                  onFork={onFork}
                  readOnly={readOnly}
                  isSubagent={isSubagent}
                  selectionMode={selectionMode}
                  isSelected={selectedIndices?.has(msg.index) ?? false}
                  onToggleSelect={handleToggleSelect}
                  pending={computePending(msg, streams, retry, onRetryNow, onCancelRetry)}
                />
              ))
            )}
          </div>

          {streamEntries.map((stream) => (
            <StreamingPlaceholder
              key={stream.streamId}
              stream={stream}
              onStop={onStop}
              retry={retry?.streamId === stream.streamId ? retry : null}
              onRetryNow={onRetryNow}
              onCancelRetry={onCancelRetry}
            />
          ))}
        </div>
      </ScrollableOverlay>

      <ScrollToBottomButton visible={showScrollBtn} onClick={() => scrollToBottom()} left={btnLeft ?? undefined} />
    </div>
  )
}

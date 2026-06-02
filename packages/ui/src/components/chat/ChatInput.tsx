import { useState, useRef, useCallback, useEffect } from 'react'
import { Icon } from '../icon/Icon'
import { OverlayScrollbar } from '../ui/OverlayScrollbar'
import { useI18n } from '@/lib/i18n'
import { useChatStore } from '@/stores/chatStore'
import { MentionPopup } from './MentionPopup'
import { ModelSelector } from './ModelSelector'
import { AgentModeSelector } from './AgentModeSelector'
import type { AgentInfo } from '@/lib/api/synthApi'

interface ChatInputProps {
  sessionId: string
  agents: AgentInfo[]
  isStreaming: boolean
  onSend: (text: string, agentRole?: string) => void
  onStop: () => void
  onCreateNote: (text: string) => void
}

interface TagPart {
  text: string
  agentRole: string
}

const TAG_REGEX = /@(\w+)/g
const MAX_TAGS = 3
const CHAT_INPUT_RADIUS = 'var(--radius-xl)'

function splitMessageWithTags(message: string, agents: AgentInfo[]): TagPart[] | null {
  const tagsWithPositions: { tag: string; start: number; end: number }[] = []
  let match: RegExpExecArray | null

  while ((match = TAG_REGEX.exec(message)) !== null) {
    tagsWithPositions.push({
      tag: match[1],
      start: match.index,
      end: match.index + match[0].length,
    })
  }

  if (tagsWithPositions.length === 0) {
    return null
  }

  const firstTag = tagsWithPositions[0]
  const commonPrefix =
    firstTag.start > 0 ? message.substring(0, firstTag.start).trim() : ''

  const parts: TagPart[] = []
  let i = 0

  while (i < tagsWithPositions.length) {
    const currentTag = tagsWithPositions[i]

    if (i + 1 < tagsWithPositions.length) {
      const textBetween = message
        .substring(currentTag.end, tagsWithPositions[i + 1].start)
        .trim()

      if (textBetween === '') {
        let groupEnd = i + 1
        while (groupEnd + 1 < tagsWithPositions.length) {
          const afterGroup = message
            .substring(tagsWithPositions[groupEnd].end, tagsWithPositions[groupEnd + 1].start)
            .trim()
          if (afterGroup === '') {
            groupEnd++
          } else {
            break
          }
        }

        const segmentText = message
          .substring(tagsWithPositions[groupEnd].end)
          .trim()

        for (let k = i; k <= groupEnd; k++) {
          const agent = agents.find((a) => a.id === tagsWithPositions[k].tag && a.enabled)
          if (agent) {
            const fullMessage = commonPrefix
              ? `${commonPrefix} ${segmentText}`
              : segmentText
            parts.push({ text: fullMessage, agentRole: tagsWithPositions[k].tag })
          }
        }
        i = groupEnd + 1
        continue
      }
    }

    const segmentEnd =
      i + 1 < tagsWithPositions.length ? tagsWithPositions[i + 1].start : message.length

    const segmentText = message.substring(currentTag.end, segmentEnd).trim()
    const agent = agents.find((a) => a.id === currentTag.tag && a.enabled)

    if (agent) {
      const fullMessage = commonPrefix
        ? `${commonPrefix} ${segmentText}`
        : segmentText
      parts.push({ text: fullMessage, agentRole: currentTag.tag })
    }

    i++
  }

  return parts.length > 0 ? parts : null
}

export function ChatInput({
  sessionId,
  agents,
  isStreaming,
  onSend,
  onStop,
  onCreateNote,
}: ChatInputProps) {
  const { t } = useI18n()
  const [value, setValue] = useState('')
  const retryText = useChatStore((s) => s.retryInputBySession[sessionId])
  const [mentionState, setMentionState] = useState<{
    query: string
    start: number
    end: number
    position: { top: number; left: number }
  } | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const autoResize = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }, [])

  useEffect(() => {
    autoResize()
  }, [value, autoResize])

  useEffect(() => {
    if (retryText) {
      setValue(retryText)
      useChatStore.getState().clearRetryInput(sessionId)
      setTimeout(() => textareaRef.current?.focus(), 0)
    }
  }, [retryText, sessionId])

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newValue = e.target.value
    setValue(newValue)

    const cursorPos = e.target.selectionStart
    const textBeforeCursor = newValue.slice(0, cursorPos)
    const mentionMatch = textBeforeCursor.match(/@(\S*)$/)

    if (mentionMatch && mentionMatch.index !== undefined) {
      const textarea = textareaRef.current
      if (textarea) {
        const rect = textarea.getBoundingClientRect()
        setMentionState({
          query: mentionMatch[1],
          start: mentionMatch.index,
          end: cursorPos,
          position: { top: rect.height + 8, left: 0 },
        })
      }
    } else {
      setMentionState(null)
    }
  }

  const handleSelectMention = (agentId: string) => {
    if (!mentionState || !textareaRef.current) return
    const before = value.slice(0, mentionState.start)
    const after = value.slice(mentionState.end)
    const newValue = `${before}@${agentId} ${after}`
    setValue(newValue)
    setMentionState(null)
    textareaRef.current.focus()
  }

  const handleMouseUp = () => {
    const el = textareaRef.current
    if (!el || mentionState) return
    const cursorPos = el.selectionStart

    let match: RegExpExecArray | null
    while ((match = TAG_REGEX.exec(value)) !== null) {
      if (cursorPos >= match.index && cursorPos <= match.index + match[0].length) {
        const tagName = match[1]
        const agent = agents.find((a) => a.id === tagName && a.enabled)
        if (agent) {
          const rect = el.getBoundingClientRect()
          setMentionState({
            query: tagName,
            start: match.index,
            end: match.index + match[0].length,
            position: { top: rect.height + 8, left: 0 },
          })
        }
        return
      }
    }
  }

  const handleSend = () => {
    const text = value.trim()
    if (!text || isStreaming) return

    const parts = splitMessageWithTags(text, agents)

    if (parts && parts.length > MAX_TAGS) {
      void window.confirm(
        `Слишком много тегов (${parts.length}). Максимум: ${MAX_TAGS}. Отправить все равно?`
      )
    }

    if (!parts) {
      onSend(text)
    } else {
      for (const part of parts) {
        onSend(part.text, part.agentRole)
      }
    }

    setValue('')
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }

  const handleCreateNote = () => {
    const text = value.trim()
    if (!text) return
    onCreateNote(text)
    setValue('')
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (mentionState) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        return
      }
      if (e.key === 'Escape') {
        setMentionState(null)
        return
      }
      return
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <div
      className="shrink-0 relative overflow-visible mx-auto mt-2 mb-2 w-4/5"
    >
      <div
        className="relative overflow-visible rounded-xl border border-border/80 bg-surface-subtle focus-within:border-primary/50 px-2 py-2"
        style={{
          borderRadius: CHAT_INPUT_RADIUS,
        }}
      >
        <div className="pt-1 pl-2 pr-2 relative">
          <textarea
            ref={textareaRef}
            className="overlay-scrollbar-target w-full resize-none border-0 bg-transparent px-0 py-0 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-0 min-h-[52px]"
            placeholder={t('chat.input.placeholder')}
            rows={1}
            value={value}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            onMouseUp={handleMouseUp}
          />
          <OverlayScrollbar
            containerRef={textareaRef as React.RefObject<HTMLElement>}
            minThumbSize={24}
            hideDelayMs={1000}
          />

          {mentionState && (
            <MentionPopup
              query={mentionState.query}
              agents={agents}
              position={mentionState.position}
              onSelect={handleSelectMention}
              onClose={() => setMentionState(null)}
            />
          )}
        </div>

        <div
          className="flex items-center justify-between gap-1.5"
        >
          <div className="flex items-center gap-0.5">
            <FooterBtn icon="attachment-2" title={t('chat.footer.attach')} />
            <FooterBtn icon="fullscreen" title={t('chat.footer.expand')} />
            <FooterBtn icon="shield-check" title={t('chat.footer.approve')} />
          </div>

          <div className="flex items-center gap-3 pr-1">
            <ModelSelector sessionId={sessionId} />
            <AgentModeSelector sessionId={sessionId} />

            {isStreaming ? (
              <button
                onClick={onStop}
                className="rounded-lg p-1.5 text-destructive hover:bg-destructive/10 transition-colors"
                title={t('chat.input.stop')}
              >
                <Icon name="stop" className="size-5" />
              </button>
            ) : (
              <>
              <div className="flex items-center gap-0.5">
                <button
                  onClick={handleCreateNote}
                  disabled={!value.trim()}
                  className="rounded-lg p-1.5 text-amber-600/70 dark:text-amber-400/70 hover:text-amber-600 dark:hover:text-amber-400 hover:bg-amber-500/10 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                  title={t('chat.input.createNote')}
                >
                  <Icon name="pushpin" className="size-5" />
                </button>
                <button
                  onClick={handleSend}
                  disabled={!value.trim()}
                  className="rounded-lg p-1.5 text-primary hover:bg-primary/10 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                  title={t('chat.input.send')}
                >
                  <Icon name="send-plane" className="size-5" />
                </button>
              </div>
              </>)}
          </div>
        </div>
      </div>
    </div>
  )
}

function FooterBtn({ icon, title }: { icon: string; title: string }) {
  return (
    <button
      className="rounded-md p-1.5 text-muted-foreground hover:text-foreground hover:bg-interactive-hover transition-colors disabled:opacity-30"
      title={title}
      disabled
    >
      <Icon name={icon} className="size-4" />
    </button>
  )
}

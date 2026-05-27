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

interface ParsedMessage {
  text: string
  agentRole?: string
}

const CHAT_INPUT_RADIUS = 'var(--radius-xl)'

export function ChatInput({ sessionId, agents, isStreaming, onSend, onStop, onCreateNote }: ChatInputProps) {
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

  const parseMentions = (text: string): ParsedMessage[] => {
    const parts: ParsedMessage[] = []
    const regex = /@(\S+)/g
    let match: RegExpExecArray | null

    while ((match = regex.exec(text)) !== null) {
      if (match.index > 0) {
        const before = text.slice(0, match.index).trim()
        if (before) parts.push({ text: before })
      }
      const agentId = match[1]
      const agent = agents.find((a) => a.id === agentId && a.enabled)
      const remainingText = text.slice(match.index + match[0].length).trim()
      if (agent) {
        parts.push({ text: remainingText, agentRole: agent.id })
      } else {
        parts.push({ text: `@${agentId} ${remainingText}` })
      }
      break
    }

    if (parts.length === 0) {
      parts.push({ text: text.trim() })
    }

    return parts.filter((p) => p.text)
  }

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

  const handleSend = () => {
    const text = value.trim()
    if (!text || isStreaming) return

    const parts = parseMentions(text)

    if (parts.length === 1) {
      onSend(parts[0].text, parts[0].agentRole)
    } else if (parts.length > 1) {
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
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
    if (e.key === 'Escape' && mentionState) {
      setMentionState(null)
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

          <div className="flex items-center gap-3">
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
                <button
                  onClick={handleCreateNote}
                  disabled={!value.trim()}
                  className="rounded-lg p-1.5 text-muted-foreground hover:text-foreground hover:bg-interactive-hover transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
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
import { useState, useRef, useCallback, useEffect } from 'react'
import { Icon } from '../icon/Icon'
import { OverlayScrollbar } from '../ui/OverlayScrollbar'
import { useI18n } from '@/lib/i18n'
import { useDevice } from '@/hooks/useDevice'
import { useChatStore } from '@/stores/chatStore'
import { confirm } from '@/lib/confirm'
import { MentionPopup } from './MentionPopup'
import { CommandAutocomplete } from './CommandAutocomplete'
import { ModelSelector } from './ModelSelector'
import { AgentModeSelector } from './AgentModeSelector'
import { PlanActModeToggle } from './PlanActModeToggle'
import { ReasoningLevelSelector } from './ReasoningLevelSelector'
import type { AgentInfo } from '@/lib/api/synthApi'
import type { CommandSummary } from '@itphx/synth-shared'

interface ChatInputProps {
  sessionId: string
  agents: AgentInfo[]
  isStreaming: boolean
  onSend: (text: string, agentRole?: string) => Promise<void>
  onStop: () => void
  onStopQueue?: () => void
  onCreateNote: (text: string) => void
  expanded?: boolean
  onToggleExpand?: () => void
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
  onStopQueue,
  onCreateNote,
  expanded,
  onToggleExpand,
}: ChatInputProps) {
  const { t } = useI18n()
  // Есть грубый указатель (тач): Enter на композере = перенос строки;
  // отправка — только кнопкой «Отправить». На устройствах с тачем это также
  // касается десктопов с тачскрином (isTouch = pointer: coarse).
  const { isTouch } = useDevice()
  const [value, setValue] = useState('')
  const retryText = useChatStore((s) => s.retryInputBySession[sessionId])
  const [mentionState, setMentionState] = useState<{
    query: string
    start: number
    end: number
    position: { left: number }
  } | null>(null)
  // AD-046 §9.3: `/`-автокомплит команд (триггер — ввод начинается с `/`).
  const [commandState, setCommandState] = useState<{
    query: string
    position: { left: number }
  } | null>(null)
  const [commandMatches, setCommandMatches] = useState(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const valueRef = useRef(value)
  valueRef.current = value

  const autoResize = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    // В развёрнутом режиме textarea растягивается на всю высоту (класс h-full),
    // авто-рост отключён — сбрасываем инлайн-высоту, чтобы не перекрывать класс.
    if (expanded) {
      el.style.height = ''
      return
    }
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }, [expanded])

  useEffect(() => {
    autoResize()
  }, [value, autoResize])

  useEffect(() => {
    if (retryText) {
      const current = valueRef.current.trim()
      setValue(current ? `${current}\n\n${retryText}` : retryText)
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
      setMentionState({
        query: mentionMatch[1],
        start: mentionMatch.index,
        end: cursorPos,
        position: { left: 0 },
      })
    } else {
      setMentionState(null)
    }

    // AD-046 §9.3: `/`-команда — ввод начинается с `/`, первый токен без пробелов.
    const commandMatch = /^\/(\S*)$/.exec(newValue)
    if (commandMatch) {
      setCommandState({
        query: commandMatch[1],
        position: { left: 0 },
      })
    } else {
      setCommandState(null)
    }
  }

  const handleSelectCommand = useCallback((command: CommandSummary) => {
    setValue(`/${command.name} `)
    setCommandState(null)
    setCommandMatches(0)
    textareaRef.current?.focus()
  }, [])

  const handleCommandMatches = useCallback((count: number) => {
    setCommandMatches(count)
  }, [])

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
          setMentionState({
            query: tagName,
            start: match.index,
            end: match.index + match[0].length,
            position: { left: 0 },
          })
        }
        return
      }
    }
  }

  const handleSend = useCallback(async () => {
    const text = value.trim()
    if (!text) return

    const parts = splitMessageWithTags(text, agents)

    if (parts && parts.length > MAX_TAGS) {
      const ok = await confirm({
        title: 'Слишком много тегов',
        message: `${parts.length} тегов. Максимум: ${MAX_TAGS}. Отправить все равно?`,
        variant: 'warning',
      })
      if (!ok) return
    }

    setValue('')
    setCommandState(null)
    setCommandMatches(0)
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }

    if (!parts) {
      await onSend(text)
    } else {
      for (const part of parts) {
        await onSend(part.text, part.agentRole)
      }
    }
  }, [value, agents, onSend])

  const handleEnqueue = useCallback(async () => {
    const text = value.trim()
    if (!text) return

    const parts = splitMessageWithTags(text, agents)

    if (parts && parts.length > MAX_TAGS) {
      const ok = await confirm({
        title: 'Слишком много тегов',
        message: `${parts.length} тегов. Максимум: ${MAX_TAGS}. Отправить все равно?`,
        variant: 'warning',
      })
      if (!ok) return
    }

    setValue('')
    setCommandState(null)
    setCommandMatches(0)
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }

    if (!parts) {
      await onSend(text)
    } else {
      for (const part of parts) {
        await onSend(part.text, part.agentRole)
      }
    }
  }, [value, agents, onSend])

  const handleCreateNote = () => {
    const text = value.trim()
    if (!text) return
    onCreateNote(text)
    setValue('')
    setCommandState(null)
    setCommandMatches(0)
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

    // AD-046 §9.3: пока открыт непустой список команд — навигация/выбор у
    // CommandAutocomplete, сообщение не отправляется.
    if (commandState) {
      if (e.key === 'Escape') {
        e.preventDefault()
        setCommandState(null)
        return
      }
      if (
        commandMatches > 0
        && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === 'Tab')
      ) {
        e.preventDefault()
        return
      }
    }

    if (e.key === 'Escape') {
      e.preventDefault()
      onStop()
      onStopQueue?.()
      return
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      // IME-композиция (китайский/японский/корейский ввод): Enter завершает
      // композицию, а не отправляет сообщение.
      if (e.nativeEvent.isComposing) return

      // Touch без физического указателя: Enter = перенос строки, отправка только
      // кнопкой «Отправить» — защита от случайной отправки на телефоне.
      if (isTouch) return

      e.preventDefault()
      if (isStreaming) {
        handleEnqueue()
      } else {
        handleSend()
      }
    }
  }

  return (
    <div
      className={`chat-composer relative overflow-visible mx-auto mt-2 mb-2 w-4/5 ${
        expanded ? 'flex-1 flex h-full' : 'shrink-0'
      }`}
    >
      <div
        className={`relative overflow-visible rounded-xl border border-border/80 bg-surface-subtle focus-within:border-primary/50 px-2 py-2 w-full @container ${
          expanded ? 'flex flex-col h-full' : ''
        }`}
        style={{
          borderRadius: CHAT_INPUT_RADIUS,
        }}
      >
        <div className={`pt-1 pl-2 pr-2 relative ${expanded ? 'flex-1 min-h-0' : ''}`}>
          <textarea
            ref={textareaRef}
            className={`overlay-scrollbar-target block w-full resize-none border-0 bg-transparent px-0 py-0 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-0 min-h-[1.25rem] ${
              expanded ? 'h-full' : ''
            }`}
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

          {commandState && (
            <CommandAutocomplete
              query={commandState.query}
              position={commandState.position}
              onSelect={handleSelectCommand}
              onClose={() => setCommandState(null)}
              onMatchesChange={handleCommandMatches}
            />
          )}
        </div>

        <div
          className={`chat-toolbar flex flex-wrap items-center justify-between gap-1.5 ${
            expanded ? 'mt-auto' : 'mt-2.5'
          }`}
        >
          <div className="flex shrink-0 items-center gap-0.5">
            <FooterBtn icon="attachment-2" title={t('chat.footer.attach')} />
            <FooterBtn
              icon={expanded ? 'fullscreen-exit' : 'fullscreen'}
              title={expanded ? t('chat.footer.collapse') : t('chat.footer.expand')}
              onClick={onToggleExpand}
              disabled={!onToggleExpand}
            />
          </div>

          <div className="chat-toolbar-actions flex flex-wrap items-center justify-end gap-1.5 pr-1 min-w-0 ml-auto">
            <PlanActModeToggle sessionId={sessionId} />
            <ReasoningLevelSelector sessionId={sessionId} />
            <ModelSelector sessionId={sessionId} />
            <AgentModeSelector sessionId={sessionId} />

            {isStreaming ? (
              <div className="flex shrink-0 items-center gap-0.5">
                <button
                  onClick={handleEnqueue}
                  disabled={!value.trim()}
                  className="inline-flex items-center justify-center rounded-lg p-1.5 text-primary hover:bg-primary/10 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                  title={t('chat.input.enqueue')}
                >
                  <Icon name="arrow-up" className="size-5" />
                </button>
                <button
                  onClick={onStop}
                  className="inline-flex items-center justify-center rounded-lg p-1.5 text-destructive hover:bg-destructive/10 transition-colors"
                  title={t('chat.input.stop')}
                >
                  <Icon name="stop" className="size-5" />
                </button>
              </div>
            ) : (
              <>
              <div className="flex shrink-0 items-center gap-0.5">
                <button
                  onClick={handleCreateNote}
                  disabled={!value.trim()}
                  className="inline-flex items-center justify-center rounded-lg p-1.5 text-amber-600/70 dark:text-amber-400/70 hover:text-amber-600 dark:hover:text-amber-400 hover:bg-amber-500/10 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                  title={t('chat.input.createNote')}
                >
                  <Icon name="pushpin" className="size-5" />
                </button>
                <button
                  onClick={handleSend}
                  disabled={!value.trim()}
                  className="inline-flex items-center justify-center rounded-lg p-1.5 text-primary hover:bg-primary/10 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
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

function FooterBtn({
  icon,
  title,
  onClick,
  disabled = true,
}: {
  icon: string
  title: string
  onClick?: () => void
  disabled?: boolean
}) {
  return (
    <button
      className="inline-flex items-center justify-center rounded-md p-1.5 text-muted-foreground hover:text-foreground hover:bg-interactive-hover transition-colors disabled:opacity-30"
      title={title}
      onClick={onClick}
      disabled={disabled}
    >
      <Icon name={icon} className="size-4" />
    </button>
  )
}

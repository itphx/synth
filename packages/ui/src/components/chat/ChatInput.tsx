import { useState, useRef, useCallback, useEffect } from 'react'
import type { ClipboardEvent as ReactClipboardEvent } from 'react'
import { Icon } from '../icon/Icon'
import { OverlayScrollbar } from '../ui/OverlayScrollbar'
import { useI18n } from '@/lib/i18n'
import { useDevice } from '@/hooks/useDevice'
import { useChatStore } from '@/stores/chatStore'
import { confirm } from '@/lib/confirm'
import { notifyMessage } from '@/hooks/useNotification'
import { prepareAttachmentFiles, type PreparedAttachment } from '@/lib/attachments/prepare'
import { useAttachmentsStore } from '@/stores/attachmentsStore'
import { MentionPopup } from './MentionPopup'
import { CommandAutocomplete } from './CommandAutocomplete'
import { ModelSelector } from './ModelSelector'
import { AgentModeSelector } from './AgentModeSelector'
import { PlanActModeToggle } from './PlanActModeToggle'
import { ReasoningLevelSelector } from './ReasoningLevelSelector'
import { SendModeSelector } from './SendModeSelector'
import { AttachmentButton } from './attachments/AttachmentButton'
import { AttachedFilesList } from './attachments/AttachedFilesList'
import { AttachmentGallery } from './attachments/AttachmentGallery'
import { useAttachmentDrop } from './attachments/useAttachmentDrop'
import { useAttachmentPaste } from './attachments/useAttachmentPaste'
import type { AgentInfo } from '@/lib/api/synthApi'
import type { CommandSummary } from '@itphx/synth-shared'
import { DEFAULT_STEER_MODE, type SteerMode } from '@itphx/synth-shared/types'

interface ChatInputProps {
  sessionId: string
  agents: AgentInfo[]
  isStreaming: boolean
  /**
   * ADR-104: отправка сообщения. Третий аргумент — режим отправки
   * (`queue` по умолчанию, `steer` — вмешательство в активный ход,
   * `interrupt` — прерывание текущей генерации с продолжением хода).
   * ADR-115: четвёртый аргумент — id загруженных вложений (`partId`); пустой
   * список не передаётся — тело запроса остаётся прежним.
   */
  onSend: (
    text: string,
    agentRole?: string,
    mode?: SteerMode,
    attachments?: string[],
  ) => Promise<void>
  /**
   * ADR-104: режим отправки по умолчанию для этого композера (значение задаёт
   * вызывающий код). В UI режим выбирается селектором композера — только при
   * активном ходе; без хода вмешаться некуда, и сообщение уходит очередью.
   */
  sendMode?: SteerMode
  onStop: () => void
  onStopQueue?: () => void
  onCreateNote: (text: string) => void
  expanded?: boolean
  onToggleExpand?: () => void
}

export interface TagPart {
  text: string
  agentRole: string
}

const TAG_REGEX = /@(\w+)/g
const MAX_TAGS = 3
const CHAT_INPUT_RADIUS = 'var(--radius-xl)'

/**
 * ADR-104: заголовок кнопки отправки во время активного хода — по выбранному
 * режиму (`queue`/`steer`/`interrupt`). Без активного хода режим не действует,
 * поэтому подпись обычная («в очередь»).
 */
function sendActionTitle(mode: SteerMode | undefined, t: (key: string) => string): string {
  if (mode === 'steer') return t('chat.steer.mode.steer')
  if (mode === 'interrupt') return t('chat.steer.mode.interrupt')
  return t('chat.input.enqueue')
}

/**
 * Собирает текст части сообщения для конкретного агента, СОХРАНЯЯ сам тег
 * `@<agentId>` (иначе пользователь не видит, к кому обращался), и текст до
 * первого тега (commonPrefix), если он был.
 */
function buildTaggedText(prefix: string, tag: string, segmentText: string): string {
  return [prefix, `@${tag}`, segmentText].filter(Boolean).join(' ')
}

export function splitMessageWithTags(message: string, agents: AgentInfo[]): TagPart[] | null {
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
            parts.push({
              text: buildTaggedText(commonPrefix, tagsWithPositions[k].tag, segmentText),
              agentRole: tagsWithPositions[k].tag,
            })
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
      parts.push({
        text: buildTaggedText(commonPrefix, currentTag.tag, segmentText),
        agentRole: currentTag.tag,
      })
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
  sendMode,
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
  // ADR-104: режим отправки, выбранный в селекторе композера (виден только
  // при активном ходе). Начальное значение — `sendMode` вызывающего кода.
  const [selectedMode, setSelectedMode] = useState<SteerMode>(sendMode ?? DEFAULT_STEER_MODE)
  const retryText = useChatStore((s) => s.retryInputBySession[sessionId])
  const [mentionState, setMentionState] = useState<{
    query: string
    start: number
    end: number
    position: { left: number }
  } | null>(null)
  // ADR-046 §9.3: `/`-автокомплит команд (триггер — ввод начинается с `/`).
  const [commandState, setCommandState] = useState<{
    query: string
    position: { left: number }
  } | null>(null)
  const [commandMatches, setCommandMatches] = useState(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const valueRef = useRef(value)
  valueRef.current = value

  // ADR-115: черновики вложений сессии (загрузка, чипы, ошибки) живут в сторе.
  const addFiles = useAttachmentsStore((state) => state.addFiles)
  const clearAttachments = useAttachmentsStore((state) => state.clear)
  const disposeAttachments = useAttachmentsStore((state) => state.dispose)
  const draftAttachments = useAttachmentsStore((state) => state.bySession[sessionId])
  // Незавершённая загрузка блокирует отправку: серверу нужны готовые `partId`.
  const pendingUpload = useAttachmentsStore((state) => state.hasPending(sessionId))
  const [gallery, setGallery] = useState<{ open: boolean; index: number }>({ open: false, index: 0 })

  /**
   * Освобождение object URL при смене сессии и размонтировании композера.
   * `dispose` удаляет и сами черновики: они принадлежат этой сессии и её
   * композеру, переносить их в другую сессию нельзя (attachmentDrafts — later).
   */
  useEffect(() => () => disposeAttachments(sessionId), [sessionId, disposeAttachments])

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

  // Смена режима по умолчанию от вызывающего кода — сбрасывает выбор селектора.
  useEffect(() => {
    setSelectedMode(sendMode ?? DEFAULT_STEER_MODE)
  }, [sendMode])

  /**
   * Режим отправки, который уходит в запрос. Во время активного хода — выбранный
   * в селекторе (`queue`/`steer`/`interrupt`); без хода — режим вызывающего кода
   * (в UI это `queue`, поле `mode` в теле запроса не появляется — его
   * отбрасывает `lib/api/sessions.ts`).
   */
  const effectiveMode: SteerMode | undefined = isStreaming ? selectedMode : sendMode

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

    // ADR-046 §9.3: `/`-команда — ввод начинается с `/`, первый токен без пробелов.
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

  /**
   * ADR-115: отправка текста (с тегами или без) вместе с вложениями.
   *
   * Вложения уходят только с первой частью: один и тот же `partId` не должен
   * попасть в несколько сообщений (иначе вложения дублируются). Пустой список
   * не передаём — тело запроса остаётся прежним.
   */
  const sendWithAttachments = useCallback(
    async (text: string, parts: TagPart[] | null) => {
      const readyIds = useAttachmentsStore.getState().readyPartIds(sessionId)
      const attachmentIds = readyIds.length > 0 ? readyIds : undefined

      if (!parts) {
        await onSend(text, undefined, effectiveMode, attachmentIds)
        return
      }
      for (let index = 0; index < parts.length; index += 1) {
        const part = parts[index]!
        await onSend(part.text, part.agentRole, effectiveMode, index === 0 ? attachmentIds : undefined)
      }
    },
    [onSend, effectiveMode, sessionId],
  )

  /**
   * ADR-115: подготовка файлов и постановка их в очередь загрузки.
   *
   * `prepareAttachmentFiles` делает файл пригодным к отправке: MIME по
   * содержимому, HEIC → JPEG, office-документ → текст + изображения. Части
   * одного документа несут общий `groupId` — их кладём отдельным вызовом,
   * чтобы каскадное удаление группы работало; остальные — одной пачкой.
   */
  const attachFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return

      // Имена, уже занятые в композере: подготовка не должна создать дубль.
      const reserved = new Set(
        (useAttachmentsStore.getState().bySession[sessionId] ?? []).map((item) => item.name),
      )

      const prepared: PreparedAttachment[] = []
      try {
        for (const file of files) {
          const entries = await prepareAttachmentFiles(file, reserved)
          for (const entry of entries) reserved.add(entry.file.name)
          prepared.push(...entries)
        }
      } catch {
        notifyMessage({
          text: t('chat.attachments.error.prepare'),
          type: 'error',
          category: 'error',
          sessionId,
        })
        return
      }
      if (prepared.length === 0) return

      const plain: File[] = []
      const groups = new Map<string, File[]>()
      for (const entry of prepared) {
        if (entry.groupId) {
          const bucket = groups.get(entry.groupId) ?? []
          bucket.push(entry.file)
          groups.set(entry.groupId, bucket)
        } else {
          plain.push(entry.file)
        }
      }

      if (plain.length > 0) await addFiles(sessionId, plain)
      for (const [groupId, groupFiles] of groups) {
        await addFiles(sessionId, groupFiles, { groupId })
      }

      notifyMessage({
        text: t('chat.attachments.added', { count: prepared.length }),
        type: 'info',
        category: 'message',
        sessionId,
      })
    },
    [addFiles, sessionId, t],
  )

  const { isDragging, dropProps } = useAttachmentDrop((files) => {
    void attachFiles(files)
  })

  // Вставка файлов из буфера (скриншоты). Текст не ломаем: если в буфере есть
  // и текст, и файл — файл забираем, а вставку текста оставляем браузеру.
  const pasteFiles = useAttachmentPaste()
  const handlePaste = useCallback(
    (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
      const files = pasteFiles(event.nativeEvent)
      if (files.length === 0) return

      let hasText = false
      try {
        hasText = (event.clipboardData?.getData('text/plain') ?? '').length > 0
      } catch {
        hasText = false
      }
      if (!hasText) event.preventDefault()
      void attachFiles(files)
    },
    [pasteFiles, attachFiles],
  )

  const handleSend = useCallback(async () => {
    const text = value.trim()
    if (!text) return
    // ADR-115: пока вложение не загружено, отправлять нечего — серверу нужны
    // готовые `partId`; кнопка в этом состоянии заблокирована.
    if (useAttachmentsStore.getState().hasPending(sessionId)) return

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

    try {
      await sendWithAttachments(text, parts)
    } catch {
      // Ошибку показал вызывающий код (ChatTab). Вложения оставляем в
      // композере: пользователь может повторить отправку без повторной загрузки.
      return
    }
    clearAttachments(sessionId)
  }, [value, agents, sendWithAttachments, sessionId, clearAttachments])

  const handleEnqueue = useCallback(async () => {
    const text = value.trim()
    if (!text) return
    if (useAttachmentsStore.getState().hasPending(sessionId)) return

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

    // Отправка во время активного хода (ADR-104): режим — общий для
    // композера (`effectiveMode`): `queue` — в очередь, `steer` — вмешаться
    // в текущий ход (выбор делает селектор композера).
    try {
      await sendWithAttachments(text, parts)
    } catch {
      return
    }
    clearAttachments(sessionId)
  }, [value, agents, sendWithAttachments, sessionId, clearAttachments])

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

    // ADR-046 §9.3: пока открыт непустой список команд — навигация/выбор у
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
      {...dropProps}
      data-dragging={isDragging || undefined}
    >
      <div
        className={`relative overflow-visible rounded-xl border border-border/80 bg-surface-subtle focus-within:border-primary/50 px-2 py-2 w-full @container ${
          expanded ? 'flex flex-col h-full' : ''
        }`}
        style={{
          borderRadius: CHAT_INPUT_RADIUS,
        }}
      >
        {draftAttachments && draftAttachments.length > 0 && (
          <div className="px-2 pb-1 pt-2">
            <AttachedFilesList
              sessionId={sessionId}
              onOpenImage={(index) => setGallery({ open: true, index })}
            />
          </div>
        )}

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
            onPaste={handlePaste}
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
            <AttachmentButton sessionId={sessionId} />
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
                <SendModeSelector value={selectedMode} onChange={setSelectedMode} />
                <button
                  onClick={handleEnqueue}
                  disabled={!value.trim() || pendingUpload}
                  className="inline-flex items-center justify-center rounded-lg p-1.5 text-primary hover:bg-primary/10 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                  title={pendingUpload ? t('chat.attachments.waitUpload') : sendActionTitle(effectiveMode, t)}
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
                  className="inline-flex items-center justify-center rounded-lg p-1.5 text-status-warning/70 hover:text-status-warning hover:bg-status-warning/10 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                  title={t('chat.input.createNote')}
                >
                  <Icon name="pushpin" className="size-5" />
                </button>
                <button
                  onClick={handleSend}
                  disabled={!value.trim() || pendingUpload}
                  className="inline-flex items-center justify-center rounded-lg p-1.5 text-primary hover:bg-primary/10 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                  title={pendingUpload ? t('chat.attachments.waitUpload') : t('chat.input.send')}
                >
                  <Icon name="send-plane" className="size-5" />
                </button>
              </div>
              </>)}
          </div>
        </div>
      </div>

      {isDragging && (
        <div
          className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center border-2 border-dashed border-primary bg-background/85"
          style={{ borderRadius: CHAT_INPUT_RADIUS }}
          data-testid="attachment-drop-overlay"
        >
          <span className="flex items-center gap-2 text-sm font-medium text-primary">
            <Icon name="attachment-2" className="size-4" />
            {t('chat.attachments.dropHint')}
          </span>
        </div>
      )}

      <AttachmentGallery
        sessionId={sessionId}
        open={gallery.open}
        index={gallery.index}
        onIndexChange={(index) => setGallery({ open: true, index })}
        onOpenChange={(open) => setGallery((prev) => ({ ...prev, open }))}
      />
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

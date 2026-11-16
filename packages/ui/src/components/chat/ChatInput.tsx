import { useState, useRef, useCallback, useEffect, useLayoutEffect, useMemo } from 'react'
import type { ClipboardEvent as ReactClipboardEvent } from 'react'
import { Icon } from '../icon/Icon'
import { OverlayScrollbar } from '../ui/OverlayScrollbar'
import { useI18n } from '@/lib/i18n'
import { useDevice } from '@/hooks/useDevice'
import { useChatStore } from '@/stores/chatStore'
import { useProvidersStore } from '@/stores/providersStore'
import { confirm } from '@/lib/confirm'
import { notifyMessage } from '@/hooks/useNotification'
import { prepareAttachmentFiles, type PreparedAttachment } from '@/lib/attachments/prepare'
import { useAttachmentsStore } from '@/stores/attachmentsStore'
import { useComposerDraftsStore } from '@/stores/composerDraftsStore'
import { MentionPopup, type MentionFileEntry, type MentionSelection, type MentionUserEntry } from './MentionPopup'
import { CommandAutocomplete } from './CommandAutocomplete'
import { SkillAutocomplete } from './SkillAutocomplete'
import { SnippetAutocomplete } from './SnippetAutocomplete'
import { composerTokenClass, highlightComposer } from './composerHighlight'
import { ModelSelector } from './ModelSelector'
import { AgentModeSelector } from './AgentModeSelector'
import { PlanActModeToggle } from './PlanActModeToggle'
import { ReasoningLevelSelector } from './ReasoningLevelSelector'
import { AttachmentButton } from './attachments/AttachmentButton'
import { AttachedFilesList, attachmentErrorText } from './attachments/AttachedFilesList'
import { AttachmentGallery } from './attachments/AttachmentGallery'
import { useAttachmentDrop } from './attachments/useAttachmentDrop'
import { useAttachmentPaste } from './attachments/useAttachmentPaste'
import type { AgentInfo, StickyNoteData } from '@/lib/api/synthApi'
import { synthApi } from '@/lib/api/synthApi'
import { useStickyNotesLimitsState } from '@/lib/api/stickyNotesLimits'
import type { CommandSummary } from '@itphx/synth-shared'
import type { SteerMode } from '@itphx/synth-shared/types'
import { mediaPartPlaceholder, mediaTypeOfMime } from '@itphx/synth-shared/utils'

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
   * ADR-104: режим отправки композера (значение задаёт вызывающий код; в UI —
   * `DEFAULT_STEER_MODE`, то есть `queue`). Композер режима не выбирает:
   * сообщение во время активного хода всегда уходит в очередь, `steer`
   * остаётся возможностью API и внешних клиентов.
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
 * ADR-126 §2: предел файлов в `@`-пикере — список файлов workspace проекта
 * показывается целиком только до этого числа (дальше — по фильтру запроса).
 */
const MENTION_FILES_LIMIT = 50
/**
 * ADR-126 §3: триггер `$`-пикера — `$` в начале слова (начало текста или
 * после пробела) и тело токена до курсора. Ядро резолвит `$`-токен по тем же
 * правилам (`engine/input-surface/parser.ts`), поэтому `$` внутри слова
 * (`a$b`) токеном не считается.
 */
const SKILL_TRIGGER_REGEX = /(^|\s)\$([^\s$]*)$/u
/**
 * Тело `$`/`#`-токена: буквы/цифры/`.`/`_`/`-`, имя начинается с буквы — иначе
 * `$5` (цена) / `#123` (номер) токеном не является (как в core-лексере).
 */
const SYMBOL_TOKEN_BODY_REGEX = /^[\p{L}][\p{L}\p{N}._-]*$/u

/**
 * ADR-126 §4: триггер `#`-пикера — `#` в начале слова (начало текста или
 * после пробела) и тело токена до курсора. Прогон `#` (`##`, `###`) и пробел
 * после `#` — markdown-заголовок, а не сниппет (те же правила, что в
 * core-лекере `engine/input-surface/parser.ts`).
 */
const SNIPPET_TRIGGER_REGEX = /(^|\s)#([^\s#]*)$/u

/**
 * ADR-126 §3: ищет `$`-токен в тексте до курсора.
 *
 * Возвращает `null`, если триггера нет: `$` не в начале слова, тело токена
 * не имя (`$5` — цена) или после `$` пробел.
 */
function findSkillTrigger(
  textBeforeCursor: string,
): { query: string; start: number; end: number } | null {
  const match = SKILL_TRIGGER_REGEX.exec(textBeforeCursor)
  if (!match) return null
  const query = match[2] ?? ''
  if (query && !SYMBOL_TOKEN_BODY_REGEX.test(query)) return null
  const start = match.index + match[1].length
  return { query, start, end: textBeforeCursor.length }
}

/**
 * ADR-126 §4: ищет `#`-токен в тексте до курсора.
 *
 * Возвращает `null`, если триггера нет: `#` не в начале слова, после `#`
 * пробел (markdown-заголовок) или прогон `#` (`##`), тело токена — не имя
 * (`#123` — номер).
 */
function findSnippetTrigger(
  textBeforeCursor: string,
): { query: string; start: number; end: number } | null {
  const match = SNIPPET_TRIGGER_REGEX.exec(textBeforeCursor)
  if (!match) return null
  const query = match[2] ?? ''
  if (query && !SYMBOL_TOKEN_BODY_REGEX.test(query)) return null
  const start = match.index + match[1].length
  return { query, start, end: textBeforeCursor.length }
}

/**
 * Простая эвристика «мы внутри кода»: нечётное число ``` — незакрытый
 * fenced-блок, нечётное число одинарных backtick'ов — незакрытый inline-код.
 * Внутри кода `$`-токен ядром не распознаётся — пикер там не открывается.
 */
function isInsideCode(text: string): boolean {
  const fences = text.match(/```/g)?.length ?? 0
  if (fences % 2 === 1) return true
  const ticks = text.replace(/```/g, '').match(/`/g)?.length ?? 0
  return ticks % 2 === 1
}

/** ADR-115: все типы маркеров вложения — точный тип мог быть нормализован сервером. */
const MEDIA_PLACEHOLDER_TYPES = ['image', 'audio', 'video', 'file'] as const
/** Стабильная пустая ссылка для селектора заметок (zustand сравнивает по идентичности). */
const EMPTY_STICKY_NOTES: StickyNoteData[] = []

/**
 * ADR-115: убрать из текста первое вхождение маркера вложения с этим именем.
 *
 * Проверяются все четыре типа: при прикреплении тип выводится по MIME
 * композера, а сервер мог нормализовать его по содержимому. Вместе с маркером
 * убирается один предшествующий пробел/перевод строки — иначе на месте чипа
 * остались бы двойной пробел или пустая строка.
 */
function removeMediaPlaceholder(text: string, name: string): string {
  for (const type of MEDIA_PLACEHOLDER_TYPES) {
    const marker = `[${type}: ${name}]`
    const index = text.indexOf(marker)
    if (index < 0) continue
    const previous = index > 0 ? text[index - 1] : ''
    const start = previous === ' ' || previous === '\n' ? index - 1 : index
    return text.slice(0, start) + text.slice(index + marker.length)
  }
  return text
}

/**
 * ADR-115: модальность вложения, которую можно сверить с `modalities` модели.
 *
 * Проверяются только типы, которые сервер молча отбрасывает, если модель их не
 * принимает. Остальные файлы (текст, документы, код) модель получает как текст —
 * ограничения нет, поэтому `null`.
 */
type AttachmentModalityKind = 'image' | 'audio' | 'video' | 'pdf'

function attachmentModalityKind(mimeType: string): AttachmentModalityKind | null {
  const mime = mimeType.toLowerCase().split(';', 1)[0]?.trim() ?? ''
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime.startsWith('video/')) return 'video'
  if (mime === 'application/pdf') return 'pdf'
  return null
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

/**
 * ADR-115: модальности выбранной в композере модели.
 *
 * `null` — модель не найдена, `modalities` нет или список пуст: тогда сверять
 * нечего и предупреждать нельзя (консервативно «неизвестно»).
 */
function selectedModelModalities(): { name: string; modalities: string[] } | null {
  const { models, selectedModelName, selectedProviderName } = useProvidersStore.getState()
  if (!selectedModelName) return null
  const model = models.find(
    (item) =>
      item.name === selectedModelName &&
      (!selectedProviderName || item.provider === selectedProviderName),
  )
  if (!model?.modalities || model.modalities.length === 0) return null
  return { name: model.name, modalities: model.modalities }
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
  // Текст черновика живёт в сторе (персист в localStorage): переживает
  // reload, выгрузку PWA, смену сессии и перемонтирование композера.
  const value = useComposerDraftsStore((state) => state.textBySession[sessionId] ?? '')
  const setText = useComposerDraftsStore((state) => state.setText)
  // Алиас сохраняет прежние вызовы `setValue(...)` в компоненте.
  const setValue = useCallback(
    (next: string) => setText(sessionId, next),
    [sessionId, setText],
  )
  const retryText = useChatStore((s) => s.retryInputBySession[sessionId])
  // Instance-wide лимиты заметок: заранее отсекаем заведомо отклоняемый запрос
  // (сервер всё равно проверит — 409/400), кнопка гаснет у предела.
  const stickyNotesLimits = useStickyNotesLimitsState()
  const sessionNotes = useChatStore((s) => s.stickyNotesBySession[sessionId])
  const notes = sessionNotes ?? EMPTY_STICKY_NOTES
  const notesAtLimit = notes.length >= stickyNotesLimits.limits.maxCount
  const [mentionState, setMentionState] = useState<{
    query: string
    start: number
    end: number
    position: { left: number }
  } | null>(null)
  /**
   * ADR-126 §2: `@`-пикер — агенты, участники сессии (`@user`) и файлы
   * workspace проекта (`@file`). Пользователи приходят из `participants`
   * снимка сессии, файлы — из листинга workspace; список файлов кэшируется
   * по `projectId` на время сессии.
   */
  const [mentionUsers, setMentionUsers] = useState<MentionUserEntry[]>([])
  const [mentionFiles, setMentionFiles] = useState<MentionFileEntry[]>([])
  /** Число совпавших элементов `@`-пикера — нужно, чтобы пустой список не блокировал Enter. */
  const [mentionMatches, setMentionMatches] = useState(0)
  /** Сессия, для которой данные `@`-пикера уже загружены (защита от повторных запросов). */
  const mentionLoadedRef = useRef<string | null>(null)
  /** Проект текущей сессии — workspace для списка файлов `@`-пикера и project-сниппетов. */
  const mentionProjectRef = useRef<string | null>(null)
  const [mentionProjectId, setMentionProjectId] = useState<string | null>(null)
  /** Кэш списка файлов по `projectId` (workspace проекта не меняется на время сессии). */
  const mentionFilesCacheRef = useRef<Map<string, MentionFileEntry[]>>(new Map())
  // ADR-126 §7: `/`-автокомплит команд (триггер — ввод начинается с `/`).
  const [commandState, setCommandState] = useState<{
    query: string
    position: { left: number }
  } | null>(null)
  const [commandMatches, setCommandMatches] = useState(0)
  // ADR-126 §3: `$`-пикер скиллов (триггер — `$` в начале слова).
  const [skillState, setSkillState] = useState<{
    query: string
    start: number
    end: number
    position: { left: number }
  } | null>(null)
  const [skillMatches, setSkillMatches] = useState(0)
  // ADR-126 §4: `#`-пикер сниппетов (триггер — `#` в начале слова).
  const [snippetState, setSnippetState] = useState<{
    query: string
    start: number
    end: number
    position: { left: number }
  } | null>(null)
  const [snippetMatches, setSnippetMatches] = useState(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const valueRef = useRef(value)
  valueRef.current = value
  // Подсветка ввода: overlay-слой под textarea повторяет текст с цветными
  // токенами `/`, `$`, `#`, `@`; сам textarea прозрачный (каретка/выделение
  // остаются браузерными).
  const [inputScrollTop, setInputScrollTop] = useState(0)
  const composerParts = useMemo(() => highlightComposer(value), [value])
  // ADR-115: позиция каретки после программной вставки маркеров. Применяется в
  // layout-эффекте уже после коммита React: синхронная установка и `setTimeout`
  // гонялись с перерисовкой, и браузер сбрасывал каретку в конец текста.
  const pendingCaretRef = useRef<number | null>(null)

  useLayoutEffect(() => {
    const caret = pendingCaretRef.current
    if (caret === null) return
    pendingCaretRef.current = null
    const el = textareaRef.current
    if (!el) return
    el.focus()
    try {
      el.setSelectionRange(caret, caret)
    } catch {
      // Поле могло потерять фокус — каретка не критична для вставки.
    }
  }, [value])

  // ADR-115: черновики вложений сессии (загрузка, чипы, ошибки) живут в сторе.
  const addFiles = useAttachmentsStore((state) => state.addFiles)
  const clearAttachments = useAttachmentsStore((state) => state.clear)
  const draftAttachments = useAttachmentsStore((state) => state.bySession[sessionId])
  // Незавершённая загрузка блокирует отправку: серверу нужны готовые `partId`.
  const pendingUpload = useAttachmentsStore((state) => state.hasPending(sessionId))
  // Ошибка загрузки тоже блокирует отправку: пока вложение не загружено,
  // сообщение ушло бы без него. Пользователь убирает/повторяет загрузку.
  const failed = useAttachmentsStore((state) => state.hasFailed(sessionId))
  const [gallery, setGallery] = useState<{ open: boolean; index: number }>({ open: false, index: 0 })

  /**
   * ADR-115: подъём черновиков сессии из хранилища байтов (IndexedDB).
   * Композер больше не удаляет черновики при размонтировании — они должны
   * переживать перемонтирование и reload; `hydrate` идемпотентен.
   */
  useEffect(() => {
    void useAttachmentsStore.getState().loadLimits()
    void useAttachmentsStore.getState().hydrate(sessionId)
  }, [sessionId])

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

  /**
   * ADR-104: режим отправки, который уходит в запрос. Композер режима не
   * выбирает — берётся режим вызывающего кода (в UI это `DEFAULT_STEER_MODE`,
   * то есть `queue`: поле `mode` в теле запроса не появляется, его отбрасывает
   * `lib/api/sessions.ts`). `steer`/`interrupt` остаются для API и внешних
   * клиентов.
   */
  const effectiveMode: SteerMode | undefined = sendMode

  useEffect(() => {
    if (retryText) {
      const current = valueRef.current.trim()
      setValue(current ? `${current}\n\n${retryText}` : retryText)
      useChatStore.getState().clearRetryInput(sessionId)
      setTimeout(() => textareaRef.current?.focus(), 0)
    }
  }, [retryText, sessionId, setValue])

  /**
   * ADR-126 §2: данные `@`-пикера — участники сессии (`@user`) и файлы
   * workspace проекта (`@file`).
   *
   * Снимок сессии (`GET /api/v2/sessions/:id`) несёт `participants` и
   * `project_id`; список файлов — листинг workspace (`GET /api/v2/fs`).
   * Ошибка загрузки не ломает композер: список пуст, `@agent` продолжает
   * работать. Файлы кэшируются по `projectId` — workspace проекта в рамках
   * сессии не меняется.
   */
  const loadMentionData = useCallback(async () => {
    if (!sessionId) return
    if (mentionLoadedRef.current !== sessionId) {
      mentionLoadedRef.current = sessionId
      mentionProjectRef.current = null
      setMentionProjectId(null)
      setMentionUsers([])
      setMentionFiles([])
      try {
        const session = await synthApi.getSession(sessionId)
        setMentionUsers(
          (session.participants ?? [])
            .map((participant) => ({ id: participant.user_id, label: participant.user_id }))
            .filter((user) => user.id.length > 0),
        )
        mentionProjectRef.current = session.project_id
        setMentionProjectId(session.project_id)
      } catch {
        // Снимок сессии недоступен — пользователей нет; повтор при новом открытии.
        mentionLoadedRef.current = null
        setMentionUsers([])
        return
      }
    }
    const projectId = mentionProjectRef.current
    if (!projectId) {
      setMentionFiles([])
      return
    }
    const cached = mentionFilesCacheRef.current.get(projectId)
    if (cached) {
      setMentionFiles(cached)
      return
    }
    try {
      const listing = await synthApi.listDirectory(projectId, '', false, 2)
      const files = (listing.entries ?? [])
        .filter((entry) => !entry.isDirectory)
        .slice(0, MENTION_FILES_LIMIT)
        .map((entry) => ({ path: entry.path, label: entry.path }))
      mentionFilesCacheRef.current.set(projectId, files)
      setMentionFiles(files)
    } catch {
      // Ошибка листинга — список файлов пуст, пикер продолжает работать;
      // повтор — при следующем открытии (кэш не заполняется).
      setMentionFiles([])
    }
  }, [sessionId])

  // Данные `@`-пикера грузятся один раз на сессию (при монтировании композера).
  useEffect(() => {
    void loadMentionData()
  }, [loadMentionData])

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newValue = e.target.value
    setValue(newValue)

    const cursorPos = e.target.selectionStart
    const textBeforeCursor = newValue.slice(0, cursorPos)
    const mentionMatch = textBeforeCursor.match(/@(\S*)$/)

    if (mentionMatch && mentionMatch.index !== undefined) {
      // Данные могли не загрузиться при монтировании — добираем при открытии.
      void loadMentionData()
      setMentionState({
        query: mentionMatch[1],
        start: mentionMatch.index,
        end: cursorPos,
        position: { left: 0 },
      })
    } else {
      setMentionState(null)
    }

    // ADR-126 §7: `/`-команда — ввод начинается с `/`, первый токен без пробелов.
    const commandMatch = /^\/(\S*)$/.exec(newValue)
    if (commandMatch) {
      setCommandState({
        query: commandMatch[1],
        position: { left: 0 },
      })
    } else {
      setCommandState(null)
    }

    // ADR-126 §3: `$`-скилл — `$` в начале слова; внутри кода токен ядром не
    // распознаётся, поэтому пикер там не открывается.
    const skillTrigger = isInsideCode(textBeforeCursor)
      ? null
      : findSkillTrigger(textBeforeCursor)
    if (skillTrigger) {
      setSkillState({
        query: skillTrigger.query,
        start: skillTrigger.start,
        end: skillTrigger.end,
        position: { left: 0 },
      })
    } else {
      setSkillState(null)
    }

    // ADR-126 §4: `#`-сниппет — `#` в начале слова; внутри кода токен ядром
    // не распознаётся, поэтому пикер там не открывается.
    const snippetTrigger = isInsideCode(textBeforeCursor)
      ? null
      : findSnippetTrigger(textBeforeCursor)
    if (snippetTrigger) {
      setSnippetState({
        query: snippetTrigger.query,
        start: snippetTrigger.start,
        end: snippetTrigger.end,
        position: { left: 0 },
      })
    } else {
      setSnippetState(null)
    }
  }

  const handleSelectCommand = useCallback((command: CommandSummary) => {
    setValue(`/${command.name} `)
    setCommandState(null)
    setCommandMatches(0)
    setSkillState(null)
    setSkillMatches(0)
    setSnippetState(null)
    setSnippetMatches(0)
    textareaRef.current?.focus()
  }, [setValue])

  const handleCommandMatches = useCallback((count: number) => {
    setCommandMatches(count)
  }, [])

  /**
   * ADR-126 §3: подстановка выбранного скилла — `$<имя> ` (с пробелом,
   * чтобы токен не слипся со следующим словом). Каретка встаёт за вставку.
   */
  const handleSelectSkill = useCallback((name: string) => {
    if (!skillState) return
    const current = valueRef.current
    const before = current.slice(0, skillState.start)
    const after = current.slice(skillState.end)
    const inserted = `$${name} `
    const nextValue = `${before}${inserted}${after}`
    valueRef.current = nextValue
    pendingCaretRef.current = skillState.start + inserted.length
    setValue(nextValue)
    setSkillState(null)
    setSkillMatches(0)
    textareaRef.current?.focus()
  }, [skillState, setValue])

  const handleSkillMatches = useCallback((count: number) => {
    setSkillMatches(count)
  }, [])

  /**
   * ADR-126 §4: подстановка выбранного сниппета — `#<имя> ` (с пробелом,
   * чтобы токен не слипся со следующим словом). Каретка встаёт за вставку.
   */
  const handleSelectSnippet = useCallback((name: string) => {
    if (!snippetState) return
    const current = valueRef.current
    const before = current.slice(0, snippetState.start)
    const after = current.slice(snippetState.end)
    const inserted = `#${name} `
    const nextValue = `${before}${inserted}${after}`
    valueRef.current = nextValue
    pendingCaretRef.current = snippetState.start + inserted.length
    setValue(nextValue)
    setSnippetState(null)
    setSnippetMatches(0)
    textareaRef.current?.focus()
  }, [snippetState, setValue])

  const handleSnippetMatches = useCallback((count: number) => {
    setSnippetMatches(count)
  }, [])

  /**
   * ADR-126 §2: подстановка выбранного упоминания — `@<id> ` (для файла id —
   * путь относительно корня workspace). Пробел в конце, чтобы токен не
   * слипся со следующим словом.
   */
  const handleSelectMention = (item: MentionSelection) => {
    if (!mentionState || !textareaRef.current) return
    const before = value.slice(0, mentionState.start)
    const after = value.slice(mentionState.end)
    const newValue = `${before}@${item.id} ${after}`
    setValue(newValue)
    setMentionState(null)
    setMentionMatches(0)
    textareaRef.current.focus()
  }

  /**
   * ADR-115: вставить маркеры вложений в текст на позицию каретки.
   *
   * Плейсхолдеры уже присутствующие в тексте пропускаются (сервер тоже не
   * дублирует маркер при приёме промпта). Перед первым маркером ставится
   * пробел, если слева не пробел и не начало строки; несколько маркеров идут
   * через пробел. Каретка остаётся сразу после вставленного текста.
   */
  const insertMediaMarkers = useCallback((markers: string[]) => {
    if (markers.length === 0) return
    const current = valueRef.current
    const fresh = markers.filter((marker) => !current.includes(marker))
    if (fresh.length === 0) return

    const el = textareaRef.current
    const caret = el?.selectionStart ?? current.length
    const before = current.slice(0, caret)
    const after = current.slice(caret)
    const needsSpace = before.length > 0 && !/\s$/.test(before)
    const inserted = `${needsSpace ? ' ' : ''}${fresh.join(' ')}`
    const nextValue = `${before}${inserted}${after}`

    valueRef.current = nextValue
    // Каретку ставим только после коммита нового `value` — в layout-эффекте
    // выше. Синхронный вызов и `setTimeout` гонялись с перерисовкой, и
    // браузер сбрасывал каретку в конец текста.
    pendingCaretRef.current = caret + inserted.length
    setValue(nextValue)
  }, [setValue])

  /** ADR-115: убрать маркеры удалённых чипов (каскад группы — все имена). */
  const removeAttachmentMarkers = useCallback((names: string[]) => {
    if (names.length === 0) return
    let next = valueRef.current
    for (const name of names) next = removeMediaPlaceholder(next, name)
    if (next === valueRef.current) return
    valueRef.current = next
    setValue(next)
  }, [setValue])

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

      // ADR-115: сервер молча отбрасывает вложения, тип которых модель не
      // принимает. Предупреждаем один раз на вызов, но прикрепление не
      // блокируем — модель можно сменить до отправки.
      const targetModel = selectedModelModalities()
      if (targetModel) {
        const unsupported = prepared
          .map((entry) => attachmentModalityKind(entry.mimeType))
          .find(
            (kind): kind is AttachmentModalityKind =>
              !!kind && !targetModel.modalities.includes(kind),
          )
        if (unsupported) {
          notifyMessage({
            text: t('chat.attachments.modelUnsupported', {
              model: targetModel.name,
              kind: t(`chat.attachments.kind.${unsupported}`),
            }),
            type: 'warning',
            category: 'message',
            sessionId,
          })
        }
      }

      // ADR-115: маркеры в текст композера — по одному на файл; у частей одного
      // документа (`groupId`) маркер один (на первом элементе группы).
      const markers: string[] = []
      const markerGroups = new Set<string>()
      for (const entry of prepared) {
        if (entry.groupId) {
          if (markerGroups.has(entry.groupId)) continue
          markerGroups.add(entry.groupId)
        }
        markers.push(
          mediaPartPlaceholder(mediaTypeOfMime(entry.mimeType), { name: entry.file.name }),
        )
      }

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

      // Снимок id до добавления: после `addFiles` отличаем новые элементы
      // (в т.ч. отклонённые по лимиту) от уже висевших в композере.
      const knownIds = new Set(
        (useAttachmentsStore.getState().bySession[sessionId] ?? []).map((item) => item.id),
      )

      if (plain.length > 0) await addFiles(sessionId, plain)
      for (const [groupId, groupFiles] of groups) {
        await addFiles(sessionId, groupFiles, { groupId })
      }

      insertMediaMarkers(markers)

      const failedItems = (useAttachmentsStore.getState().bySession[sessionId] ?? []).filter(
        (item) => !knownIds.has(item.id) && item.upload === 'error',
      )
      if (failedItems.length > 0) {
        // Один тост на пачку: ошибки видны и в чипах (оверлей/подсветка),
        // а отправка заблокирована до удаления или повтора.
        const tooLarge = failedItems.some((item) => item.error === 'too_large')
        notifyMessage({
          text: attachmentErrorText(t, tooLarge ? 'too_large' : 'upload_failed', {
            maxBytesPerFile: useAttachmentsStore.getState().limits.maxBytesPerFile,
            maxFilesPerMessage: useAttachmentsStore.getState().limits.maxFilesPerMessage,
          }),
          type: 'error',
          category: 'error',
          sessionId,
        })
        return
      }

      notifyMessage({
        text: t('chat.attachments.added', { count: prepared.length }),
        type: 'info',
        category: 'message',
        sessionId,
      })
    },
    [addFiles, insertMediaMarkers, sessionId, t],
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
    // Ошибка загрузки блокирует отправку: вложение не должно «потеряться».
    if (useAttachmentsStore.getState().hasFailed(sessionId)) return
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

    try {
      await sendWithAttachments(text, parts)
    } catch {
      // Ошибку показал вызывающий код (ChatTab). Текст и вложения остаются в
      // композере: пользователь может повторить отправку без потерь.
      return
    }

    // Очистка — только после успешной отправки: при ошибке черновик не теряем.
    setValue('')
    setMentionState(null)
    setMentionMatches(0)
    setCommandState(null)
    setCommandMatches(0)
    setSkillState(null)
    setSkillMatches(0)
    setSnippetState(null)
    setSnippetMatches(0)
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
    clearAttachments(sessionId)
  }, [value, agents, sendWithAttachments, sessionId, clearAttachments, setValue])

  const handleEnqueue = useCallback(async () => {
    const text = value.trim()
    if (!text) return
    if (useAttachmentsStore.getState().hasFailed(sessionId)) return
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

    // Отправка во время активного хода (ADR-104): режим задаёт вызывающий код
    // (`effectiveMode`; в UI — `queue`, то есть «в очередь»). Вмешательство в
    // ход (`steer`) композер не выставляет — это возможность API.
    try {
      await sendWithAttachments(text, parts)
    } catch {
      return
    }

    // Очистка — только после успешной постановки в очередь/отправки.
    setValue('')
    setMentionState(null)
    setMentionMatches(0)
    setCommandState(null)
    setCommandMatches(0)
    setSkillState(null)
    setSkillMatches(0)
    setSnippetState(null)
    setSnippetMatches(0)
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
    clearAttachments(sessionId)
  }, [value, agents, sendWithAttachments, sessionId, clearAttachments, setValue])

  const handleCreateNote = () => {
    const text = value.trim()
    if (!text) return
    // Слишком длинная заметка не создаётся локально: сервер ответит 400.
    if (text.length > stickyNotesLimits.limits.maxChars) {
      notifyMessage({
        text: t('chat.notes.tooLong', { maxChars: stickyNotesLimits.limits.maxChars }),
        type: 'warning',
        category: 'system',
        sessionId,
      })
      return
    }
    onCreateNote(text)
    setValue('')
    setMentionState(null)
    setMentionMatches(0)
    setCommandState(null)
    setCommandMatches(0)
    setSkillState(null)
    setSkillMatches(0)
    setSnippetState(null)
    setSnippetMatches(0)
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (mentionState) {
      // ADR-126 §2: пока список `@`-пикера непуст — выбор у MentionPopup,
      // сообщение не отправляется. Пустой список (нет совпадений) — Enter
      // отправляет сообщение, как у `$`/`#`-пикеров.
      if (e.key === 'Enter' && !e.shiftKey && mentionMatches > 0) {
        e.preventDefault()
        return
      }
      if (e.key === 'Escape') {
        setMentionState(null)
        return
      }
      if (mentionMatches > 0) return
    }

    // ADR-126 §3: пока открыт непустой список скиллов — навигация/выбор у
    // SkillAutocomplete, сообщение не отправляется.
    if (skillState) {
      if (e.key === 'Escape') {
        e.preventDefault()
        setSkillState(null)
        return
      }
      if (
        skillMatches > 0
        && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === 'Tab')
      ) {
        e.preventDefault()
        return
      }
    }

    // ADR-126 §4: пока открыт непустой список сниппетов — навигация/выбор у
    // SnippetAutocomplete, сообщение не отправляется.
    if (snippetState) {
      if (e.key === 'Escape') {
        e.preventDefault()
        setSnippetState(null)
        return
      }
      if (
        snippetMatches > 0
        && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === 'Tab')
      ) {
        e.preventDefault()
        return
      }
    }

    // ADR-126 §7: пока открыт непустой список команд — навигация/выбор у
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
              onRemove={removeAttachmentMarkers}
            />
          </div>
        )}

        <div className={`pt-1 pl-2 pr-2 relative ${expanded ? 'flex-1 min-h-0' : ''}`}>
          {/*
            ADR-126: подсветка токенов `/`, `$`, `#`, `@`. Слой лежит под
            textarea и повторяет текст; сам textarea прозрачный, поэтому
            каретка/выделение остаются нативными.
          */}
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
            <div
              className="whitespace-pre-wrap break-words pl-2 pr-2 pt-1 text-sm leading-5 text-foreground"
              style={{ transform: `translateY(-${inputScrollTop}px)` }}
            >
              {composerParts.map((part, index) =>
                part.kind ? (
                  <span key={index} className={composerTokenClass(part.kind)}>{part.text}</span>
                ) : (
                  <span key={index}>{part.text}</span>
                ),
              )}
              {value.endsWith('\n') && <span>{'\u200b'}</span>}
            </div>
          </div>
          <textarea
            ref={textareaRef}
            className={`overlay-scrollbar-target relative block w-full resize-none border-0 bg-transparent px-0 py-0 text-sm leading-5 text-transparent placeholder:text-muted-foreground/50 focus:outline-none focus:ring-0 min-h-[1.25rem] ${
              expanded ? 'h-full' : ''
            }`}
            style={{ caretColor: 'var(--foreground)' }}
            placeholder={t('chat.input.placeholder')}
            rows={1}
            value={value}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            onMouseUp={handleMouseUp}
            onPaste={handlePaste}
            onScroll={(event) => setInputScrollTop(event.currentTarget.scrollTop)}
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
              users={mentionUsers}
              files={mentionFiles}
              position={mentionState.position}
              onSelect={handleSelectMention}
              onClose={() => setMentionState(null)}
              onMatchesChange={setMentionMatches}
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

          {skillState && (
            <SkillAutocomplete
              query={skillState.query}
              position={skillState.position}
              onSelect={handleSelectSkill}
              onClose={() => setSkillState(null)}
              onMatchesChange={handleSkillMatches}
            />
          )}

          {snippetState && (
            <SnippetAutocomplete
              query={snippetState.query}
              position={snippetState.position}
              onSelect={handleSelectSnippet}
              onClose={() => setSnippetState(null)}
              onMatchesChange={handleSnippetMatches}
              projectId={mentionProjectId}
            />
          )}
        </div>

        <div
          className={`chat-toolbar flex flex-wrap items-center justify-between gap-1.5 ${
            expanded ? 'mt-auto' : 'mt-2.5'
          }`}
        >
          <div className="flex shrink-0 items-center gap-0.5">
            <AttachmentButton sessionId={sessionId} onFiles={attachFiles} />
            {/* Кнопка разворота — только там, где разворот есть (чат).
                В доке терминала разворачивать нечего — кнопки нет. */}
            {onToggleExpand && (
              <FooterBtn
                icon={expanded ? 'fullscreen-exit' : 'fullscreen'}
                title={expanded ? t('chat.footer.collapse') : t('chat.footer.expand')}
                onClick={onToggleExpand}
              />
            )}
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
                  disabled={!value.trim() || pendingUpload || failed}
                  className="inline-flex items-center justify-center rounded-lg p-1.5 text-primary hover:bg-primary/10 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                  title={
                    failed
                      ? t('chat.attachments.fixErrors')
                      : pendingUpload
                        ? t('chat.attachments.waitUpload')
                        : t('chat.input.enqueue')
                  }
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
                  disabled={!value.trim() || notesAtLimit}
                  className="inline-flex items-center justify-center rounded-lg p-1.5 text-status-warning/70 hover:text-status-warning hover:bg-status-warning/10 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                  title={
                    notesAtLimit
                      ? t('chat.input.createNoteLimit', {
                          maxCount: stickyNotesLimits.limits.maxCount,
                        })
                      : t('chat.input.createNote')
                  }
                >
                  <Icon name="pushpin" className="size-5" />
                </button>
                <button
                  onClick={handleSend}
                  disabled={!value.trim() || pendingUpload || failed}
                  className="inline-flex items-center justify-center rounded-lg p-1.5 text-primary hover:bg-primary/10 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                  title={
                    failed
                      ? t('chat.attachments.fixErrors')
                      : pendingUpload
                        ? t('chat.attachments.waitUpload')
                        : t('chat.input.send')
                  }
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
  disabled = false,
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

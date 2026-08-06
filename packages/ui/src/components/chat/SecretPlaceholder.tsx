import { useState } from 'react'
import { cn } from '@/lib/utils'
import { synthApi } from '@/lib/api/synthApi'
import { useI18n } from '@/lib/i18n'
import { MarkdownContent } from './MarkdownContent'

/**
 * Плейсхолдер секрета LLM Gateway (AD-036): ⟦SYNTH_SECRET_N⟧.
 * Реальные значения приходят в message.metadata.secrets как { placeholder: value }.
 */
export const SECRET_PLACEHOLDER_REGEX = /⟦SYNTH_SECRET_(\d+)⟧/g

/** Якорь для временной замены code-фрагментов (не содержит ⟦ — не пересекается с SECRET_PLACEHOLDER_REGEX). */
export const CODE_ANCHOR_REGEX = /\uE000SYNTH_CODE_(\d+)\uE000/g

export interface CodeProtection {
  /** Текст с якорями вместо code-фрагментов. */
  protectedText: string
  /** Возвращает якоря на место оригинальных code-фрагментов. */
  restoreCodeBlocks: (text: string) => string
}

/**
 * Защита code-контекстов markdown от подмены плейсхолдеров секретов (AD-036).
 * Внутри fenced code block / inline code плейсхолдер должен остаться буквальным
 * текстом ⟦SYNTH_SECRET_N⟧: marked экранирует HTML внутри <pre><code> и <code>,
 * поэтому вставленный спан «Значение скрыто» превращается в сырой HTML.
 * Fenced-блоки (``` / ~~~) и inline-код (` ... `) временно заменяются на
 * уникальные якоря, затем плейсхолдеры можно безопасно подменять вне кода.
 */
export function protectCodeBlocks(content: string): CodeProtection {
  const fragments: string[] = []
  let nextIndex = 0

  const anchorFor = (fragment: string): string => {
    const anchor = `\uE000SYNTH_CODE_${nextIndex}\uE000`
    fragments.push(fragment)
    nextIndex += 1
    return anchor
  }

  // Fenced code blocks: ``` ... ``` и ~~~ ... ~~~ (с опциональной строкой языка).
  const fencedProtected = content.replace(
    /^( {0,3})(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\2[^\n]*\n?/gm,
    anchorFor,
  )

  // Inline code: ` ... ` (одинарные backticks внутри строки).
  const protectedText = fencedProtected.replace(/`[^`\n]+`/g, anchorFor)

  const restoreCodeBlocks = (text: string): string =>
    text.replace(CODE_ANCHOR_REGEX, (_match, index: string) => fragments[Number(index)] ?? '')

  return { protectedText, restoreCodeBlocks }
}

export interface SecretSegment {
  type: 'text' | 'secret'
  value: string
}

/** Разбивает текст на сегменты «обычный текст» / «плейсхолдер секрета». */
export function splitBySecretPlaceholders(content: string): SecretSegment[] {
  if (!content) return []
  const segments: SecretSegment[] = []
  let lastIndex = 0
  SECRET_PLACEHOLDER_REGEX.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = SECRET_PLACEHOLDER_REGEX.exec(content)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', value: content.slice(lastIndex, match.index) })
    }
    segments.push({ type: 'secret', value: match[0] })
    lastIndex = match.index + match[0].length
  }
  if (lastIndex < content.length) {
    segments.push({ type: 'text', value: content.slice(lastIndex) })
  }
  return segments
}

interface SecretPlaceholderProps {
  /** Полный плейсхолдер вида ⟦SYNTH_SECRET_N⟧. */
  placeholder: string
  /** Реальное значение из message.metadata.secrets (может отсутствовать). */
  value?: string
  /** Сессия для аудита раскрытия (fire-and-forget). */
  sessionId?: string
}

export function SecretPlaceholder({ placeholder, value, sessionId }: SecretPlaceholderProps) {
  const { t } = useI18n()
  const [revealed, setRevealed] = useState(false)
  const canReveal = value != null && value !== ''

  const handleClick = () => {
    if (!canReveal) return
    const next = !revealed
    setRevealed(next)
    if (next) {
      // Аудит раскрытия: fire-and-forget, не блокируем UI при отсутствии эндпоинта.
      synthApi.auditRevealed(sessionId, placeholder).catch(() => {})
    }
  }

  if (!canReveal) {
    return (
      <span
        title={placeholder}
        className="secret-placeholder [font:inherit] select-none align-baseline text-muted-foreground"
      >
        {t('gateway.secret.hidden')}
      </span>
    )
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      title={revealed ? 'Скрыть значение' : `Показать значение: ${placeholder}`}
      className={cn(
        'secret-placeholder [font:inherit] cursor-pointer select-none align-baseline transition-colors',
        revealed
          ? 'text-amber-700 dark:text-amber-300'
          : 'text-violet-700 hover:text-violet-900 dark:text-violet-300',
      )}
    >
      {revealed ? value : t('gateway.secret.hidden')}
    </button>
  )
}

interface SecretMarkdownProps {
  content: string
  secrets?: Record<string, string>
  sessionId?: string
  className?: string
}

/** Базовые классы inline-маркера секрета в markdown (наследует шрифт от .markdown-content). */
const SECRET_PH_BASE_CLASS =
  'synth-secret-ph cursor-pointer select-none [font:inherit] align-baseline transition-colors'
const SECRET_PH_HIDDEN_CLASS = `${SECRET_PH_BASE_CLASS} text-violet-700 hover:text-violet-900 dark:text-violet-300`
const SECRET_PH_REVEALED_CLASS = `${SECRET_PH_BASE_CLASS} text-amber-700 dark:text-amber-300`
const SECRET_PH_UNAVAILABLE_CLASS = `${SECRET_PH_BASE_CLASS} cursor-default text-muted-foreground`

/**
 * Markdown-контент с плейсхолдерами секретов (AD-036).
 * Рендерится ОДИН раз через MarkdownContent: плейсхолдеры заменяются на inline-маркеры
 * `<span class="synth-secret-ph" data-ph="…">`, поэтому текст остаётся слитным, без переносов.
 * Клик по маркеру раскрывает значение через прямую DOM-манипуляцию (без React-состояния).
 */
export function SecretMarkdown({ content, secrets, sessionId, className = '' }: SecretMarkdownProps) {
  const { t } = useI18n()
  // SECRET_PLACEHOLDER_REGEX — global regex c lastIndex: сбросить и до test, и до replace.
  SECRET_PLACEHOLDER_REGEX.lastIndex = 0
  const hasPlaceholder = SECRET_PLACEHOLDER_REGEX.test(content)
  SECRET_PLACEHOLDER_REGEX.lastIndex = 0

  // Нет плейсхолдеров — обычный markdown без обвязки (минимальные изменения).
  if (!hasPlaceholder) {
    return <MarkdownContent content={content} className={className} />
  }

  // Code-контексты (fenced blocks, inline code) временно заменяем на якоря —
  // внутри них плейсхолдер должен остаться буквальным текстом (marked экранирует HTML).
  const { protectedText, restoreCodeBlocks } = protectCodeBlocks(content)
  const replaced = protectedText.replace(SECRET_PLACEHOLDER_REGEX, (ph) => {
    const value = secrets?.[ph]
    const title = value ? `Показать значение: ${ph}` : 'Значение недоступно'
    const cls = value ? SECRET_PH_HIDDEN_CLASS : SECRET_PH_UNAVAILABLE_CLASS
    return `<span class="${cls}" data-ph="${ph}" data-revealed="0" title="${title}">${t('gateway.secret.hidden')}</span>`
  })
  const markedContent = restoreCodeBlocks(replaced)

  const handleSecretClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('.synth-secret-ph')
    if (!el) return
    const placeholder = el.getAttribute('data-ph')
    if (!placeholder) return
    const value = secrets?.[placeholder]
    if (!value) return

    const revealed = el.getAttribute('data-revealed') === '1'
    if (!revealed) {
      // Раскрытие: «Значение скрыто» → реальное значение, amber, аудит fire-and-forget.
      el.textContent = value
      el.setAttribute('data-revealed', '1')
      el.className = SECRET_PH_REVEALED_CLASS
      el.title = 'Скрыть значение'
      synthApi.auditRevealed(sessionId, placeholder).catch(() => {})
    } else {
      // Сворачивание: значение → «Значение скрыто», violet.
      el.textContent = t('gateway.secret.hidden')
      el.setAttribute('data-revealed', '0')
      el.className = SECRET_PH_HIDDEN_CLASS
      el.title = `Показать значение: ${placeholder}`
    }
  }

  return (
    <div onClick={handleSecretClick}>
      <MarkdownContent content={markedContent} className={className} />
    </div>
  )
}

interface SecretPlainTextProps {
  content: string
  secrets?: Record<string, string>
  sessionId?: string
}

/** Plain-text контент (сообщения пользователя) с плейсхолдерами секретов. */
export function SecretPlainText({ content, secrets, sessionId }: SecretPlainTextProps) {
  const segments = splitBySecretPlaceholders(content)
  if (segments.length === 1 && segments[0]!.type === 'text') {
    return <p className="text-sm whitespace-pre-wrap">{content}</p>
  }
  return (
    <p className="text-sm whitespace-pre-wrap">
      {segments.map((seg, i) =>
        seg.type === 'text' ? (
          <span key={i}>{seg.value}</span>
        ) : (
          <SecretPlaceholder
            key={i}
            placeholder={seg.value}
            value={secrets?.[seg.value]}
            sessionId={sessionId}
          />
        ),
      )}
    </p>
  )
}

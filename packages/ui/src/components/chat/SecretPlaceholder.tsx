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
        title="Секрет недоступен"
        className="secret-placeholder italic select-none align-baseline text-muted-foreground"
      >
        {t('gateway.secret.hidden')}
      </span>
    )
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      title={revealed ? 'Скрыть значение' : 'Показать значение'}
      className={cn(
        'secret-placeholder italic cursor-pointer select-none align-baseline transition-colors',
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

/**
 * Markdown-контент с плейсхолдерами секретов: обычные сегменты рендерятся через
 * MarkdownContent, плейсхолдеры — через SecretPlaceholder (клик раскрывает значение).
 */
export function SecretMarkdown({ content, secrets, sessionId, className = '' }: SecretMarkdownProps) {
  const segments = splitBySecretPlaceholders(content)
  if (segments.length === 1 && segments[0]!.type === 'text') {
    return <MarkdownContent content={segments[0].value} className={className} />
  }
  return (
    <>
      {segments.map((seg, i) =>
        seg.type === 'text' ? (
          <MarkdownContent key={i} content={seg.value} />
        ) : (
          <SecretPlaceholder
            key={i}
            placeholder={seg.value}
            value={secrets?.[seg.value]}
            sessionId={sessionId}
          />
        ),
      )}
    </>
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

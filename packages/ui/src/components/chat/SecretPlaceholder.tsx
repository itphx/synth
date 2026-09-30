import { useCallback, useState } from 'react'
import { cn, resolveColor } from '@/lib/utils'
import { synthApi, type AgentInfo } from '@/lib/api/synthApi'
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
 * Заменяет плейсхолдеры ⟦SYNTH_SECRET_N⟧ в HTML-строке (результат marked.parser)
 * на inline-маркер `<span class="synth-secret-ph" ...>`. Вызывается ПОСЛЕ парсинга
 * markdown и ДО DOMPurify.sanitize: в обычном тексте, внутри <pre><code> и <code>
 * спан становится настоящим элементом (DOMPurify пропускает span), а не
 * экранированным текстом (AD-036).
 */
export function replaceSecretsInHtml(
  html: string,
  secrets: Record<string, string> | undefined,
  hiddenText: string,
): string {
  // SECRET_PLACEHOLDER_REGEX — global regex c lastIndex: сбросить перед replace.
  SECRET_PLACEHOLDER_REGEX.lastIndex = 0
  return html.replace(SECRET_PLACEHOLDER_REGEX, (ph) => {
    const value = secrets?.[ph]
    const title = value ? `Показать значение: ${ph}` : 'Значение недоступно'
    const cls = value ? SECRET_PH_HIDDEN_CLASS : SECRET_PH_UNAVAILABLE_CLASS
    return `<span class="${cls}" data-ph="${ph}" data-revealed="0" title="${title}">${hiddenText}</span>`
  })
}

/**
 * Markdown-контент с плейсхолдерами секретов (AD-036).
 * Рендерится ОДИН раз через MarkdownContent: плейсхолдеры заменяются на inline-маркеры
 * `<span class="synth-secret-ph" data-ph="…">` ПОСЛЕ marked.parser и ДО DOMPurify.sanitize,
 * поэтому текст остаётся слитным, без переносов, а маркер работает и в обычном тексте,
 * и внутри fenced/inline code (span становится настоящим элементом).
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

  const hiddenText = t('gateway.secret.hidden')

  const transformHtml = useCallback(
    (html: string): string => replaceSecretsInHtml(html, secrets, hiddenText),
    [secrets, hiddenText],
  )

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
      <MarkdownContent content={content} transformHtml={transformHtml} className={className} />
    </div>
  )
}

interface SecretPlainTextProps {
  content: string
  secrets?: Record<string, string>
  sessionId?: string
  /** Реестр агентов — для подсветки `@`-упоминаний в пользовательском сообщении. */
  agents?: AgentInfo[]
}

/** Токен упоминания агента в тексте: `@<agentId>`. */
export const MENTION_REGEX = /@(\w+)/g

export interface MentionSegment {
  type: 'text' | 'mention'
  value: string
  agent?: AgentInfo
}

/**
 * Разбивает текст на сегменты «обычный текст» / «упоминание агента».
 * Упоминанием считается только `@<id>` известного агента; неизвестные токены
 * остаются обычным текстом — сообщение не ломается.
 */
export function splitMentions(text: string, agents: AgentInfo[]): MentionSegment[] {
  if (!text || agents.length === 0) return [{ type: 'text', value: text }]
  const segments: MentionSegment[] = []
  let lastIndex = 0
  MENTION_REGEX.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = MENTION_REGEX.exec(text)) !== null) {
    const agent = agents.find((a) => a.id === match![1])
    if (!agent) continue
    if (match.index > lastIndex) {
      segments.push({ type: 'text', value: text.slice(lastIndex, match.index) })
    }
    segments.push({ type: 'mention', value: match[0], agent })
    lastIndex = match.index + match[0].length
  }
  if (lastIndex < text.length) {
    segments.push({ type: 'text', value: text.slice(lastIndex) })
  }
  return segments.length > 0 ? segments : [{ type: 'text', value: text }]
}

/** Инлайн-подсветка `@`-упоминаний цветом иконки/агента. */
function renderMentions(text: string, agents: AgentInfo[], keyBase: string) {
  return splitMentions(text, agents).map((seg, i) =>
    seg.type === 'mention' && seg.agent ? (
      <span
        key={`${keyBase}-${i}`}
        data-mention={seg.agent.id}
        className="font-medium"
        style={{ color: resolveColor(seg.agent.color) }}
      >
        {seg.value}
      </span>
    ) : (
      <span key={`${keyBase}-${i}`}>{seg.value}</span>
    ),
  )
}

/** Plain-text контент (сообщения пользователя): плейсхолдеры секретов + подсветка `@`-упоминаний. */
export function SecretPlainText({ content, secrets, sessionId, agents = [] }: SecretPlainTextProps) {
  const segments = splitBySecretPlaceholders(content)
  if (agents.length === 0 && segments.length === 1 && segments[0]!.type === 'text') {
    return <p className="text-sm whitespace-pre-wrap">{content}</p>
  }
  return (
    <p className="text-sm whitespace-pre-wrap">
      {segments.map((seg, i) =>
        seg.type === 'text' ? (
          <span key={i}>
            {agents.length === 0 ? seg.value : renderMentions(seg.value, agents, `t${i}`)}
          </span>
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

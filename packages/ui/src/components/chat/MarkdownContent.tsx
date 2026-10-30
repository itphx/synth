import { useCallback, useDeferredValue, useEffect, useMemo, useRef } from 'react'
import { marked, Renderer } from 'marked'
import DOMPurify from 'dompurify'
import { i18nText, useI18nStore } from '@/lib/i18n'
import { highlightCode } from '@/lib/markdown/highlight'

interface MarkdownContentProps {
  content: string
  className?: string
  /** Трансформация HTML между marked.parser и DOMPurify.sanitize (например, подмена плейсхолдеров). */
  transformHtml?: (html: string) => string
  /**
   * Идёт стриминг ответа: парсим отложенное значение (`useDeferredValue`), чтобы
   * не пересобирать весь markdown на каждой дельте. Финальный текст парсится полностью.
   */
  streaming?: boolean
}

/** Длиннее — номера строк отключаем (DOM не раздуваем, счётчик не нужен). */
export const MAX_NUMBERED_CODE_LINES = 1200

/** Разрешённые санитайзером теги: базовая разметка + обвязка кода/таблиц (renderer'ы ниже). */
export const MARKDOWN_ALLOWED_TAGS = [
  'p', 'br', 'strong', 'em', 'u', 's', 'del', 'code', 'pre',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'blockquote',
  'a', 'img', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'span', 'div', 'hr',
  'input', 'label',
  'button', 'details', 'summary',
]

/** Разрешённые атрибуты (включая маркеры раскрытия кода и target/rel внешних ссылок). */
export const MARKDOWN_ALLOWED_ATTR = [
  'href', 'src', 'alt', 'title', 'class', 'id', 'type', 'checked', 'disabled',
  'data-ph', 'data-lang', 'data-copy-code', 'data-numbered', 'data-copied',
  'target', 'rel', 'open', 'align',
]

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

/** Экранирование текста кода/языка перед вставкой в HTML (сырой HTML не проходит). */
function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch)
}

/** ```ts title="x"``` → `ts`; пустой/отсутствующий язык → `text`. */
function normalizeLanguage(lang?: string): string {
  const first = (lang ?? '').trim().split(/\s+/)[0]
  return first ? first : 'text'
}

/** Язык для CSS-класса `language-…`: только безопасные символы. */
function languageClass(language: string): string {
  const safe = language.replace(/[^\w+#.-]/g, '')
  return safe || 'text'
}

/** Внешняя ссылка — только http(s) и protocol-relative; `#anchor` и относительные без target. */
function isExternalHref(href?: string): boolean {
  return typeof href === 'string' && /^(?:https?:)?\/\//i.test(href.trim())
}

/**
 * Локальные renderer'ы marked: заголовок с языком и копирование у блоков кода,
 * горизонтальный скролл у таблиц, `target` у внешних ссылок, чип у инлайн-кода.
 * Глобальный `marked.use` не трогаем — инстанс рендерера живёт только здесь.
 */
function createMarkdownRenderer(): Renderer {
  const renderer = new Renderer()
  const renderTable = renderer.table.bind(renderer)
  const renderLink = renderer.link.bind(renderer)

  renderer.code = ({ text, lang }) => {
    const language = normalizeLanguage(lang)
    const lines = text.replace(/\n$/, '').split('\n')
    const numbered = lines.length <= MAX_NUMBERED_CODE_LINES
    const copyLabel = escapeHtml(i18nText('markdown.code.copy'))
    // Строки — отдельными span'ами (номера рисует CSS-счётчик), между ними "\n",
    // чтобы `textContent` блока копировался с переносами.
    const body = lines.map((line) => `<span class="md-code-line">${escapeHtml(line)}</span>`).join('\n')
    return [
      `<div class="md-code" data-lang="${escapeHtml(language)}" data-numbered="${numbered ? 'true' : 'false'}">`,
      '<div class="md-code-head">',
      `<span class="md-code-lang">${escapeHtml(language)}</span>`,
      `<button type="button" class="md-code-copy" data-copy-code>${copyLabel}</button>`,
      '</div>',
      `<pre class="md-code-pre"><code class="language-${escapeHtml(languageClass(language))}">${body}</code></pre>`,
      '</div>',
    ].join('')
  }

  renderer.table = (token) => `<div class="md-table-wrap">${renderTable(token)}</div>`

  renderer.link = (token) => {
    const html = renderLink(token)
    // marked возвращает чистый текст, если href не прошёл проверку — не трогаем.
    if (!isExternalHref(token.href) || !html.startsWith('<a ')) return html
    return `<a target="_blank" rel="noopener noreferrer" ${html.slice(3)}`
  }

  renderer.codespan = ({ text }) => `<code class="md-inline-code">${escapeHtml(text)}</code>`

  return renderer
}

const markdownRenderer = createMarkdownRenderer()

/** Копирование в буфер: ошибки глушим — рендер не должен ломаться (нет API, отказ прав). */
async function writeClipboard(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value)
    return true
  } catch {
    return false
  }
}

export function MarkdownContent({ content, className = '', transformHtml, streaming = false }: MarkdownContentProps) {
  // Во время стрима показываем отложенный текст: React успевает пропускать
  // промежуточные дельты, парсится не каждый чанк. Финал (`streaming: false`) — полный.
  const deferredContent = useDeferredValue(content)
  const source = streaming ? deferredContent : content
  // Словарь в зависимостях: подписи кнопки копирования переводятся при смене локали.
  const dictionary = useI18nStore((s) => s.dictionary)

  const html = useMemo(() => {
    if (!source) return ''
    try {
      const tokens = marked.lexer(source)
      let raw = marked.parser(tokens, { renderer: markdownRenderer })
      if (transformHtml) raw = transformHtml(raw)
      return DOMPurify.sanitize(raw, {
        ALLOWED_TAGS: MARKDOWN_ALLOWED_TAGS,
        ALLOWED_ATTR: MARKDOWN_ALLOWED_ATTR,
      })
    } catch (e) {
      console.warn('[MarkdownContent] marked failed, falling back to plain text:', e)
      return DOMPurify.sanitize(source)
    }
  }, [source, transformHtml, dictionary])

  const timersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set())
  useEffect(() => {
    const timers = timersRef.current
    return () => {
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
    }
  }, [])

  const containerRef = useRef<HTMLDivElement | null>(null)

  /**
   * Подсветка кода (shiki, лениво) — только для «устоявшихся» блоков: во время
   * стриминга не трогаем (иначе DOM пересобирается на каждой дельте), а после
   * завершения шага (`streaming: false`) подсвечиваем один раз — маркер
   * `data-highlighted` не даёт повторять работу при перерисовках.
   */
  useEffect(() => {
    const container = containerRef.current
    if (!container || streaming) return
    let cancelled = false
    const blocks = Array.from(container.querySelectorAll<HTMLElement>('.md-code[data-lang]'))
    for (const block of blocks) {
      const lang = block.dataset.lang ?? ''
      if (!lang || lang === 'text') continue
      if (block.dataset.highlighted === '1' || block.dataset.highlighting === '1') continue
      const pre = block.querySelector<HTMLElement>('pre.md-code-pre')
      const code = pre?.querySelector('code')
      if (!pre || !code) continue
      const source = code.textContent ?? ''
      if (!source) continue
      // Маркер «в полёте»: эффект может перезапуститься, пока идёт await.
      block.dataset.highlighting = '1'
      void highlightCode(source, lang).then((highlighted) => {
        delete block.dataset.highlighting
        if (cancelled || !block.isConnected) return
        // Контент изменился, пока шёл await — результат устарел, не применяем.
        if (!highlighted || (code.textContent ?? '') !== source) return
        code.innerHTML = highlighted
        pre.classList.add('shiki')
        block.dataset.highlighted = '1'
      })
    }
    return () => {
      cancelled = true
    }
  }, [html, streaming])

  // Делегирование клика: кнопка копирования живёт в HTML из marked, не в React-дереве.
  const handleClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target
    if (!(target instanceof Element)) return
    const button = target.closest<HTMLButtonElement>('[data-copy-code]')
    if (!button) return
    const code = button.closest('.md-code')?.querySelector('pre code')
    const text = code?.textContent?.replace(/\n+$/, '') ?? ''
    if (!text) return
    void writeClipboard(text).then((ok) => {
      if (!ok) return
      button.dataset.copied = 'true'
      button.textContent = i18nText('markdown.code.copied')
      const timer = setTimeout(() => {
        timersRef.current.delete(timer)
        if (!button.isConnected) return
        delete button.dataset.copied
        button.textContent = i18nText('markdown.code.copy')
      }, 1500)
      timersRef.current.add(timer)
    })
  }, [])

  if (!html) {
    return null
  }

  return (
    <div
      className={`markdown-content text-sm leading-relaxed ${className}`}
      ref={containerRef}
      onClick={handleClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

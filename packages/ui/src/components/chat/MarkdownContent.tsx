import { useMemo } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'

interface MarkdownContentProps {
  content: string
  className?: string
  /** Трансформация HTML между marked.parser и DOMPurify.sanitize (например, подмена плейсхолдеров). */
  transformHtml?: (html: string) => string
}

export function MarkdownContent({ content, className = '', transformHtml }: MarkdownContentProps) {
  const html = useMemo(() => {
    if (!content) return ''
    try {
      const tokens = marked.lexer(content)
      let raw = marked.parser(tokens)
      if (transformHtml) raw = transformHtml(raw)
      return DOMPurify.sanitize(raw, {
        ALLOWED_TAGS: [
          'p', 'br', 'strong', 'em', 'u', 's', 'del', 'code', 'pre',
          'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
          'ul', 'ol', 'li', 'blockquote',
          'a', 'img', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
          'span', 'div', 'hr',
          'input', 'label',
        ],
        ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'class', 'id', 'type', 'checked', 'disabled', 'data-ph'],
      })
    } catch (e) {
      console.warn('[MarkdownContent] marked failed, falling back to plain text:', e)
      return DOMPurify.sanitize(content)
    }
  }, [content, transformHtml])

  if (!html) {
    return null
  }

  return (
    <div
      className={`markdown-content text-sm leading-relaxed ${className}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

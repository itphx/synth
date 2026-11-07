import { MarkdownContent } from '@/components/chat/MarkdownContent'
import { clipPlainText, markdownToPlain } from '@/lib/markdown/plain'
import { cn } from '@/lib/utils'

export interface MarkdownTextProps {
  /** Markdown-текст (описание пункта, текст ToDo, запись журнала, инварианты). */
  content: string
  /**
   * Режим показа:
   * - `render` — полный markdown через `MarkdownContent` (marked + DOMPurify);
   * - `plain` — текст без разметки (свёрнутое превью в правой панели).
   */
  mode?: 'render' | 'plain'
  /** Классы корня (размер/цвет задаёт вызывающий). */
  className?: string
  /** Обрезка превью (символы) — только для `mode='plain'`. */
  maxLength?: number
  /**
   * Резолвер относительных `src`/`href` (workspace) — только для `mode='render'`.
   *
   * Вызывающий обязан мемоизировать (`useCallback`): резолвер входит в
   * зависимости `MarkdownContent`, иначе markdown пересобирается на каждом
   * рендере.
   */
  resolveAsset?: (target: string) => string | null
  /** Маркер для тестов. */
  testId?: string
}

/**
 * Markdown в текстовых полях работы (PROP-054).
 *
 * Рендер — **только** существующим `MarkdownContent` (marked + DOMPurify):
 * свой рендерер не заводим, санитайзер второй раз не пишем. В режиме `plain`
 * разбор идёт через `marked.lexer` (`lib/markdown/plain`) — HTML не строится
 * и в DOM не вставляется.
 */
export function MarkdownText({
  content,
  mode = 'render',
  className,
  maxLength,
  resolveAsset,
  testId,
}: MarkdownTextProps) {
  if (!content) return null

  if (mode === 'plain') {
    const text = clipPlainText(markdownToPlain(content), maxLength)
    if (!text) return null
    return (
      <div
        className={cn('whitespace-pre-wrap break-words', className)}
        data-testid={testId}
        data-markdown-mode="plain"
      >
        {text}
      </div>
    )
  }

  return (
    <div data-testid={testId} data-markdown-mode="render" className="min-w-0">
      <MarkdownContent content={content} className={className} resolveAsset={resolveAsset} />
    </div>
  )
}

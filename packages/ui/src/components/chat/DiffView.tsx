import { useI18n } from '@/lib/i18n'
import { Icon } from '../icon/Icon'

export interface DiffLine {
  type: 'add' | 'remove' | 'context' | 'header'
  text: string
}

/** Разбор unified diff на строки с типом (без потери исходного текста). */
export function parseDiff(diffText: string): DiffLine[] {
  const lines = diffText.split('\n')
  return lines.map((line) => {
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) {
      return { type: 'header' as const, text: line }
    }
    if (line.startsWith('+')) return { type: 'add' as const, text: line }
    if (line.startsWith('-')) return { type: 'remove' as const, text: line }
    return { type: 'context' as const, text: line }
  })
}

/**
 * `<pre>` inline-вида — ровно прежняя разметка карточек: карточка тула
 * (`ToolCallPart`) и превью в запросе подтверждения (`PermissionRequestBar`)
 * рисуют diff прямо в теле карточки, без собственных отступов.
 */
const INLINE_PRE_CLASS =
  'text-[0.6875rem] leading-relaxed overflow-x-auto font-mono m-0 p-0 bg-transparent'

/** Классы строк inline-вида (см. `styles/index.css`: `.diff-added` и т.п.). */
function inlineLineClass(type: DiffLine['type']): string {
  return type === 'add'
    ? 'diff-added block'
    : type === 'remove'
      ? 'diff-removed block'
      : type === 'header'
        ? 'diff-header block'
        : 'block opacity-70'
}

export interface DiffViewProps {
  /** Текст unified diff. */
  diff: string
  /**
   * Раскладка: `inline` (по умолчанию) — карточки тулов и подтверждений,
   * `page` — полная вкладка (`git-diff`, деталь коммита).
   */
  variant?: 'inline' | 'page'
  /** Сервер обрезал diff по размеру — рисуем первые `maxLines` строк и плашку. */
  truncated?: boolean
  /** Предел строк при `truncated` (по умолчанию 500). */
  maxLines?: number
  /** Текст пустого diff: `page` — пустое состояние на всю область, `inline` — приглушённая строка. */
  emptyText?: string
  /** `data-testid` для `<pre>` с diff. */
  testId?: string
  /** `data-testid` для плашки «diff обрезан» (совместимость с CommitDetailTab). */
  truncatedTestId?: string
}

/** Предел строк diff по умолчанию: мегабайты в DOM не превращаем. */
const DEFAULT_MAX_LINES = 500

/**
 * Рендер unified diff: `+` — добавление, `−` — удаление, `@@` — заголовок
 * hunk'а. Один компонент обслуживает и компактные карточки (`inline`), и
 * полную вкладку diff (`page`).
 */
export function DiffView({
  diff,
  variant = 'inline',
  truncated,
  maxLines = DEFAULT_MAX_LINES,
  emptyText,
  testId,
  truncatedTestId,
}: DiffViewProps) {
  const { t } = useI18n()

  const banner = truncated ? (
    <div
      className={
        variant === 'page'
          ? 'flex items-start gap-1.5 border-b border-status-warning/40 bg-status-warning/10 px-4 py-1.5 text-[0.6875rem] text-status-warning'
          : 'flex items-start gap-1.5 bg-status-warning/10 px-2 py-1 text-[0.6875rem] text-status-warning'
      }
      data-testid={truncatedTestId ?? (testId ? `${testId}-truncated` : undefined)}
    >
      <Icon name="alert-triangle" className="mt-0.5 size-3 shrink-0" />
      <span className="min-w-0 break-words">{t('commit.diffTruncated')}</span>
    </div>
  ) : null

  if (variant === 'inline') {
    // Прежняя разметка карточек: строка-заголовок, добавления/удаления через
    // классы `.diff-*` (цвета — в `styles/index.css`).
    const parsed: DiffLine[] = !diff && emptyText
      ? [{ type: 'context', text: emptyText }]
      : parseDiff(diff)
    const inlineLines = truncated ? parsed.slice(0, maxLines) : parsed
    return (
      <>
        {banner}
        <pre className={INLINE_PRE_CLASS} data-testid={testId}>
          {inlineLines.map((line, i) => (
            <span key={i} className={inlineLineClass(line.type)}>
              {line.text || ' '}
            </span>
          ))}
        </pre>
      </>
    )
  }

  if (!diff) {
    return (
      <div
        className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground"
        data-testid={testId ? `${testId}-empty` : undefined}
      >
        {emptyText ?? t('git.changes.emptyDiff')}
      </div>
    )
  }

  const lines = truncated ? diff.split('\n').slice(0, maxLines) : diff.split('\n')

  return (
    <>
      {banner}
      <pre
        className="p-4 text-xs font-mono text-muted-foreground whitespace-pre overflow-x-auto leading-relaxed"
        data-testid={testId}
      >
        {lines.map((line, i) => (
          <span
            key={i}
            className={
              line.startsWith('+') && !line.startsWith('+++') ? 'text-status-success'
                : line.startsWith('-') && !line.startsWith('---') ? 'text-status-error'
                  : line.startsWith('@@') ? 'text-status-info'
                    : ''
            }
          >
            {line}{'\n'}
          </span>
        ))}
      </pre>
    </>
  )
}

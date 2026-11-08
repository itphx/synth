import { useState } from 'react'

import type { ProjectLogEntryDto } from '@/lib/api/synthApi'
import { useI18n } from '@/lib/i18n'
import { formatDateTime } from '@/lib/formatDate'
import { MARKDOWN_LIMITS } from '@/lib/markdown/limits'
import { cn } from '@/lib/utils'
import { Icon } from '@/components/icon/Icon'
import { MarkdownEditor } from './MarkdownEditor'
import { MarkdownText } from './MarkdownText'
import type { JournalFilters } from './types'

export interface JournalListProps {
  /** Записи журнала (текущая страница). */
  entries: ProjectLogEntryDto[]
  /** Всего записей (счётчик в шапке). */
  total?: number
  /** Есть следующая страница. */
  hasMore?: boolean
  /** Идёт догрузка следующей страницы. */
  loadingMore?: boolean
  /** Загрузка первой страницы. */
  loading?: boolean
  /** Ошибка загрузки (текст). */
  error?: string | null
  /** Догрузить следующую страницу. */
  onLoadMore?: () => void
  /** Добавить запись (текст). */
  onAdd?: (text: string) => void
  /** Изменить запись (id + текст). */
  onEdit?: (entryId: string, text: string) => void
  /** Удалить запись. */
  onDelete?: (entryId: string) => void
  /** Фильтры журнала. */
  filters?: JournalFilters
  /** Изменение фильтров (без обработчика фильтры не рисуются). */
  onFiltersChange?: (filters: JournalFilters) => void
  /** Список авторов для выбора. */
  authors?: string[]
  /** Список сессий для выбора. */
  sessions?: Array<{ id: string; label: string }>
  /** Только чтение: добавление/правка/удаление скрыты. */
  readOnly?: boolean
  /** Режим текста записи: `plain` — превью, `render` — полный markdown. */
  bodyMode?: 'plain' | 'render'
  /** Маркер для тестов. */
  testId?: string
}

/**
 * Журнал проекта — список записей с фильтрами и пагинацией (PROP-054).
 *
 * Записи создаёт модель (`project_log_write`) и пользователь; авто-ленты
 * событий в этом инкременте нет.
 */
export function JournalList({
  entries,
  total,
  hasMore = false,
  loadingMore = false,
  loading = false,
  error,
  onLoadMore,
  onAdd,
  onEdit,
  onDelete,
  filters,
  onFiltersChange,
  authors,
  sessions,
  readOnly = false,
  bodyMode = 'plain',
  testId,
}: JournalListProps) {
  const { t, locale } = useI18n()
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState('')

  const submitAdd = () => {
    const text = draft.trim()
    if (!text) {
      setAdding(false)
      return
    }
    onAdd?.(text)
    setDraft('')
    setAdding(false)
  }

  const submitEdit = (entryId: string) => {
    const text = editDraft.trim()
    setEditingId(null)
    if (!text) return
    onEdit?.(entryId, text)
  }

  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid={testId ?? 'journal-list'}>
      {onFiltersChange && (
        <div className="flex flex-wrap items-center gap-1.5" data-testid="journal-filters">
          <label className="flex min-w-0 items-center gap-1 text-[0.625rem] text-muted-foreground">
            <span className="shrink-0">{t('work.journal.filter.author')}</span>
            <select
              value={filters?.author ?? ''}
              onChange={(e) => onFiltersChange({ ...(filters ?? {}), author: e.target.value || undefined })}
              aria-label={t('work.journal.filter.author')}
              data-testid="journal-filter-author"
              className="min-w-0 rounded border border-border bg-input px-1 py-0.5 text-base text-foreground sm:text-[0.625rem] focus:outline-none focus:ring-1 focus:ring-ring"
            >
              <option value="">{t('work.journal.filter.all')}</option>
              {(authors ?? []).map((author) => (
                <option key={author} value={author}>
                  {author}
                </option>
              ))}
            </select>
          </label>

          <label className="flex min-w-0 items-center gap-1 text-[0.625rem] text-muted-foreground">
            <span className="shrink-0">{t('work.journal.filter.session')}</span>
            <select
              value={filters?.sessionId ?? ''}
              onChange={(e) => onFiltersChange({ ...(filters ?? {}), sessionId: e.target.value || undefined })}
              aria-label={t('work.journal.filter.session')}
              data-testid="journal-filter-session"
              className="min-w-0 rounded border border-border bg-input px-1 py-0.5 text-base text-foreground sm:text-[0.625rem] focus:outline-none focus:ring-1 focus:ring-ring"
            >
              <option value="">{t('work.journal.filter.all')}</option>
              {(sessions ?? []).map((session) => (
                <option key={session.id} value={session.id}>
                  {session.label}
                </option>
              ))}
            </select>
          </label>

          <label className="flex min-w-0 items-center gap-1 text-[0.625rem] text-muted-foreground">
            <span className="shrink-0">{t('work.journal.filter.date')}</span>
            <input
              type="date"
              value={filters?.date ?? ''}
              onChange={(e) => onFiltersChange({ ...(filters ?? {}), date: e.target.value || undefined })}
              aria-label={t('work.journal.filter.date')}
              data-testid="journal-filter-date"
              className="min-w-0 rounded border border-border bg-input px-1 py-0.5 text-base text-foreground sm:text-[0.625rem] focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </label>
        </div>
      )}

      {!readOnly && onAdd && !adding && (
        <button
          type="button"
          onClick={() => {
            setAdding(true)
            setDraft('')
          }}
          data-testid="journal-add"
          className="self-start rounded-lg border border-border px-2 py-1 text-xs font-medium text-foreground transition-colors hover:bg-interactive-hover"
        >
          {t('work.journal.add')}
        </button>
      )}

      {adding && (
        <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-input p-2" data-testid="journal-add-form">
          <MarkdownEditor
            value={draft}
            onChange={setDraft}
            onSave={submitAdd}
            onCancel={() => {
              setAdding(false)
              setDraft('')
            }}
            limit={MARKDOWN_LIMITS.journalEntry}
            label={t('work.journal.placeholder')}
            testId="journal-add"
          />
        </div>
      )}

      {error && (
        <div className="text-xs text-destructive" data-testid="journal-error">
          {error}
        </div>
      )}

      {loading && entries.length === 0 && (
        <div className="text-xs text-muted-foreground" data-testid="journal-loading">
          {t('common.loading')}
        </div>
      )}

      {!loading && entries.length === 0 && (
        <div
          className="rounded-lg border border-border bg-surface-inset px-3 py-2 text-xs text-muted-foreground"
          data-testid="journal-empty"
        >
          {t('work.journal.empty')}
        </div>
      )}

      {entries.length > 0 && (
        <ul className="flex min-w-0 flex-col gap-1.5" data-testid="journal-entries">
          {entries.map((entry) => (
            <li
              key={entry.id}
              className="flex min-w-0 flex-col gap-1 rounded-md border border-border/60 bg-input px-2 py-1.5"
              data-testid={`journal-entry-${entry.id}`}
            >
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="min-w-0 truncate text-[0.625rem] text-muted-foreground/70">
                  {entry.author ?? t('work.journal.unknownAuthor')}
                </span>
                <span className="shrink-0 text-[0.625rem] text-muted-foreground/50">
                  {formatDateTime(entry.created_at, locale)}
                </span>
                {!readOnly && (onEdit || onDelete) && (
                  <span className="ml-auto flex shrink-0 items-center gap-0.5">
                    {onEdit && (
                      <button
                        type="button"
                        onClick={() => {
                          setEditingId(entry.id)
                          setEditDraft(entry.text)
                        }}
                        title={t('work.task.action.edit')}
                        aria-label={t('work.task.action.edit')}
                        data-testid={`journal-entry-${entry.id}-edit`}
                        className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <Icon name="edit-2" className="size-3" />
                      </button>
                    )}
                    {onDelete && (
                      <button
                        type="button"
                        onClick={() => onDelete(entry.id)}
                        title={t('work.task.action.delete')}
                        aria-label={t('work.task.action.delete')}
                        data-testid={`journal-entry-${entry.id}-delete`}
                        className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <Icon name="trash-2" className="size-3" />
                      </button>
                    )}
                  </span>
                )}
              </div>

              {editingId === entry.id ? (
                <div className="flex flex-col gap-1.5">
                  <MarkdownEditor
                    value={editDraft}
                    onChange={setEditDraft}
                    onSave={() => submitEdit(entry.id)}
                    onCancel={() => setEditingId(null)}
                    limit={MARKDOWN_LIMITS.journalEntry}
                    label={t('work.journal.edit')}
                    testId={`journal-entry-${entry.id}`}
                  />
                </div>
              ) : (
                <MarkdownText
                  content={entry.text}
                  mode={bodyMode}
                  maxLength={bodyMode === 'plain' ? 200 : undefined}
                  className={cn('text-xs', bodyMode === 'plain' && 'text-muted-foreground/90')}
                  testId={`journal-entry-${entry.id}-text`}
                />
              )}
            </li>
          ))}
        </ul>
      )}

      {hasMore && onLoadMore && (
        <button
          type="button"
          onClick={onLoadMore}
          disabled={loadingMore}
          data-testid="journal-load-more"
          className="self-start rounded-lg border border-border px-2 py-1 text-xs font-medium text-foreground transition-colors hover:bg-interactive-hover disabled:opacity-50"
        >
          {loadingMore ? t('common.loading') : t('work.journal.loadMore')}
        </button>
      )}

      {total !== undefined && entries.length > 0 && (
        <div className="text-[0.625rem] text-muted-foreground/60" data-testid="journal-total">
          {t('work.journal.total', { count: total })}
        </div>
      )}
    </div>
  )
}

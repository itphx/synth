import { useCallback, useRef, useState } from 'react'

import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { Tabs } from '@/components/ui/settings/controls/Tabs'
import { MarkdownText } from './MarkdownText'

/** Действие тулбара редактора. */
export type MarkdownEditorAction = 'bold' | 'italic' | 'code' | 'list' | 'link'

/** Результат применения действия к тексту: новое значение + выделение. */
export interface MarkdownActionResult {
  value: string
  selectionStart: number
  selectionEnd: number
}

/**
 * Применить действие тулбара к выделенному фрагменту.
 *
 * Чистая функция (без DOM) — её удобно проверять тестом: значение и границы
 * выделения считаются по строке.
 */
export function applyMarkdownAction(
  action: MarkdownEditorAction,
  value: string,
  start: number,
  end: number,
): MarkdownActionResult {
  const from = Math.max(0, Math.min(start, value.length))
  const to = Math.max(from, Math.min(end, value.length))
  const selected = value.slice(from, to)

  switch (action) {
    case 'bold':
      return wrap(value, from, to, '**', '**')
    case 'italic':
      return wrap(value, from, to, '*', '*')
    case 'code':
      return wrap(value, from, to, '`', '`')
    case 'link': {
      const label = selected || 'текст'
      const next = `${value.slice(0, from)}[${label}](url)${value.slice(to)}`
      const urlStart = from + label.length + 3
      return { value: next, selectionStart: urlStart, selectionEnd: urlStart + 3 }
    }
    case 'list': {
      const block = selected || ''
      const lines = block.split('\n')
      const prefixed = lines
        .map((line) => (line.startsWith('- ') ? line : `- ${line}`))
        .join('\n')
      const next = `${value.slice(0, from)}${prefixed}${value.slice(to)}`
      const caret = from + prefixed.length
      return { value: next, selectionStart: caret, selectionEnd: caret }
    }
  }
}

/** Обернуть выделение парой маркеров (или вставить пустую пару). */
function wrap(
  value: string,
  from: number,
  to: number,
  prefix: string,
  suffix: string,
): MarkdownActionResult {
  const selected = value.slice(from, to)
  const next = `${value.slice(0, from)}${prefix}${selected}${suffix}${value.slice(to)}`
  return {
    value: next,
    selectionStart: from + prefix.length,
    selectionEnd: from + prefix.length + selected.length,
  }
}

export interface MarkdownEditorProps {
  /** Текущий текст (контролируемый компонент). */
  value: string
  /** Изменение текста. */
  onChange: (value: string) => void
  /** Сохранение (кнопка). Без обработчика кнопки нет. */
  onSave?: () => void
  /** Отмена (кнопка). */
  onCancel?: () => void
  /** Идёт сохранение — кнопка показывает «Saving…» и блокируется. */
  saving?: boolean
  /** Только чтение: тулбар и поле правки недоступны. */
  readOnly?: boolean
  /** Предел длины (символов) — показывается счётчиком, сохранение блокируется. */
  limit?: number
  /** Доступное имя поля (aria-label). */
  label?: string
  /** Начальная вкладка (`editor`/`preview`). */
  initialTab?: 'editor' | 'preview'
  /** Маркер для тестов. */
  testId?: string
}

/**
 * Markdown-редактор (PROP-054): вкладки «Редактор/Превью», тулбар и действия.
 *
 * Без новых зависимостей: разметка вставляется в обычный `textarea`, превью
 * рисуется тем же `MarkdownContent`, что и в чате (marked + DOMPurify).
 */
export function MarkdownEditor({
  value,
  onChange,
  onSave,
  onCancel,
  saving = false,
  readOnly = false,
  limit,
  label,
  initialTab = 'editor',
  testId,
}: MarkdownEditorProps) {
  const { t } = useI18n()
  const [tab, setTab] = useState<'editor' | 'preview'>(initialTab)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  const overLimit = limit !== undefined && value.length > limit

  const applyAction = useCallback(
    (action: MarkdownEditorAction) => {
      const el = textareaRef.current
      const start = el?.selectionStart ?? value.length
      const end = el?.selectionEnd ?? value.length
      const result = applyMarkdownAction(action, value, start, end)
      onChange(result.value)
      // Выделение восстанавливаем после перерисовки — иначе React сбрасывает
      // его при обновлении значения.
      requestAnimationFrame(() => {
        const node = textareaRef.current
        if (!node) return
        node.focus()
        node.setSelectionRange(result.selectionStart, result.selectionEnd)
      })
    },
    [onChange, value],
  )

  const toolbar: Array<{ action: MarkdownEditorAction; labelKey: string }> = [
    { action: 'bold', labelKey: 'work.markdown.bold' },
    { action: 'italic', labelKey: 'work.markdown.italic' },
    { action: 'code', labelKey: 'work.markdown.code' },
    { action: 'list', labelKey: 'work.markdown.list' },
    { action: 'link', labelKey: 'work.markdown.link' },
  ]

  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid={testId}>
      <Tabs
        items={[
          { value: 'editor', label: t('work.markdown.editor') },
          { value: 'preview', label: t('work.markdown.preview') },
        ]}
        value={tab}
        onChange={(next) => setTab(next as 'editor' | 'preview')}
        ariaLabel={t('work.markdown.title')}
      />

      {tab === 'editor' ? (
        <>
          <div className="flex flex-wrap items-center gap-1" role="toolbar" aria-label={t('work.markdown.toolbar')}>
            {toolbar.map((item) => (
              <button
                key={item.action}
                type="button"
                onClick={() => applyAction(item.action)}
                disabled={readOnly}
                aria-label={t(item.labelKey)}
                title={t(item.labelKey)}
                data-testid={`${testId ?? 'markdown-editor'}-${item.action}`}
                className="rounded border border-border px-1.5 py-0.5 text-[0.625rem] font-medium text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground disabled:cursor-default disabled:opacity-40"
              >
                {t(item.labelKey)}
              </button>
            ))}
          </div>
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            readOnly={readOnly}
            aria-label={label ?? t('work.markdown.editor')}
            data-testid={`${testId ?? 'markdown-editor'}-textarea`}
            rows={6}
            className="w-full min-w-0 resize-y rounded-md border border-border bg-input px-2 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring read-only:cursor-default read-only:opacity-70"
          />
        </>
      ) : (
        <div
          className="min-h-[6rem] rounded-md border border-border bg-surface-inset px-2 py-1.5"
          data-testid={`${testId ?? 'markdown-editor'}-preview`}
        >
          {value ? (
            <MarkdownText content={value} mode="render" className="text-xs" />
          ) : (
            <div className="text-[0.625rem] text-muted-foreground">{t('work.markdown.empty')}</div>
          )}
        </div>
      )}

      <div className="flex items-center justify-between gap-2">
        <div
          className={cn('text-[0.625rem]', overLimit ? 'text-destructive' : 'text-muted-foreground/60')}
          data-testid={`${testId ?? 'markdown-editor'}-counter`}
        >
          {limit !== undefined
            ? t('work.markdown.counter', { used: value.length, limit })
            : t('work.markdown.counterNoLimit', { used: value.length })}
        </div>
        <div className="flex items-center gap-1.5">
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              data-testid={`${testId ?? 'markdown-editor'}-cancel`}
              className="rounded-lg border border-border px-2 py-1 text-xs font-medium text-foreground transition-colors hover:bg-interactive-hover"
            >
              {t('common.cancel')}
            </button>
          )}
          {onSave && (
            <button
              type="button"
              onClick={onSave}
              disabled={saving || overLimit || readOnly}
              aria-busy={saving}
              data-testid={`${testId ?? 'markdown-editor'}-save`}
              className="rounded-lg border border-transparent bg-primary px-2 py-1 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {saving ? t('common.saving') : t('common.save')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

import { useEffect, useRef, useState } from 'react'

import { useI18n } from '@/lib/i18n'
import { MARKDOWN_LIMITS } from '@/lib/markdown/limits'
import { MarkdownEditor } from './MarkdownEditor'

export interface InvariantsEditorProps {
  /** Текущий текст инвариантов (Markdown). */
  value: string
  /** Сохранение текста. */
  onSave: (value: string) => void
  /** Отмена правки. */
  onCancel?: () => void
  /** Идёт сохранение. */
  saving?: boolean
  /** Только чтение: правка недоступна (нет права `canEditProjectContent`). */
  readOnly?: boolean
  /** Предел длины (символов). По умолчанию — лимит инвариантов (64 КиБ). */
  limit?: number
  /** Маркер для тестов. */
  testId?: string
}

/**
 * Редактор инвариантов проекта (PROP-054): Markdown-редактор + сохранение.
 *
 * Лимит — 64 КиБ: инварианты попадают в системный промпт на каждом ходе, поэтому
 * превышение блокирует сохранение (сервер тоже проверяет лимит).
 */
export function InvariantsEditor({
  value,
  onSave,
  onCancel,
  saving = false,
  readOnly = false,
  limit = MARKDOWN_LIMITS.invariants,
  testId,
}: InvariantsEditorProps) {
  const { t } = useI18n()
  const [draft, setDraft] = useState(value)
  // Черновик живёт в компоненте, но текст приходит асинхронно (модалка грузит
  // инварианты) и может обновиться после сохранения — тогда черновик должен
  // уйти за серверным значением. Правка пользователя при этом не теряется:
  // пока `value` не менялся, синхронизации не происходит.
  const lastValueRef = useRef(value)
  useEffect(() => {
    if (value === lastValueRef.current) return
    lastValueRef.current = value
    setDraft(value)
  }, [value])

  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid={testId ?? 'invariants-editor'}>
      {!readOnly && (
        <div className="text-[0.625rem] text-muted-foreground/70">{t('work.invariants.hint')}</div>
      )}
      <MarkdownEditor
        value={draft}
        onChange={setDraft}
        onSave={() => onSave(draft)}
        onCancel={onCancel}
        saving={saving}
        readOnly={readOnly}
        limit={limit}
        label={t('work.invariants.title')}
        testId={testId ? `${testId}-markdown` : 'invariants-markdown'}
      />
    </div>
  )
}

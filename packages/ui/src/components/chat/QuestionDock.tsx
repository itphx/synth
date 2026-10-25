import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { QuestionItem, QuestionRecord } from '@itphx/synth-shared/types'
import { Icon } from '../icon/Icon'
import { useI18n } from '@/lib/i18n'
import { useNotification } from '@/hooks/useNotification'
import { synthApi } from '@/lib/api/synthApi'
import { useQuestionStore, pendingFor } from '@/stores/questionStore'
import { cn } from '@/lib/utils'

interface QuestionDockProps {
  sessionId: string
}

/** Сколько вопросов загружаем при восстановлении (сервер: максимум 200). */
const PENDING_LIMIT = 50

/** Выбранные значения вариантов по индексу вопроса. */
type SelectionMap = Record<number, string[]>
/** Текст «своего ответа» по индексу вопроса. */
type CustomMap = Record<number, string>

/**
 * Док вопросов агента над полем ввода (этап 1 roadmap 0.13 — блок 1.3).
 *
 * Показывает запись вопроса сессии со статусом `pending`: текст вопроса,
 * варианты ответа (радио/чекбоксы), «свой ответ» и кнопки «Ответить»/«Отменить».
 * Восстановление после перезагрузки — `GET /sessions/:id/questions?status=pending`;
 * live-обновление — события `user_question.*` (диспетчер `stores/transportStore.ts`).
 */
export function QuestionDock({ sessionId }: QuestionDockProps) {
  const { t } = useI18n()
  const { notify } = useNotification()
  const records = useQuestionStore((s) => s.bySession[sessionId])

  const pending = useMemo(
    () => pendingFor(sessionId, records),
    [sessionId, records],
  )
  const record: QuestionRecord | undefined = pending[0]

  const [step, setStep] = useState(0)
  const [selected, setSelected] = useState<SelectionMap>({})
  const [custom, setCustom] = useState<CustomMap>({})
  const [customOpen, setCustomOpen] = useState<Record<number, boolean>>({})
  const [busy, setBusy] = useState(false)

  const recordId = record?.id

  // Восстановление после перезагрузки: pending-вопросы сессии с сервера.
  // Ошибка загрузки — тихая (событие/следующая попытка покажут вопрос).
  useEffect(() => {
    let cancelled = false
    synthApi
      .list(sessionId, { status: 'pending', limit: PENDING_LIMIT })
      .then((res) => {
        if (cancelled) return
        const fetched = res.questions ?? []
        // Вопрос, пришедший событием `user_question.asked` пока идёт в сети —
        // сохраняем его, иначе он пропадёт из дока.
        const known = new Set(fetched.map((q) => q.id))
        const local = (useQuestionStore.getState().bySession[sessionId] ?? [])
          .filter((q) => q.status === 'pending' && !known.has(q.id))
        useQuestionStore.getState().setAll(sessionId, [...fetched, ...local])
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [sessionId])

  // Новый вопрос — новые ответы (шаги/выборы не переносятся между записями).
  useEffect(() => {
    setStep(0)
    setSelected({})
    setCustom({})
    setCustomOpen({})
    setBusy(false)
  }, [recordId])

  const questions: QuestionItem[] = record?.questions ?? []
  const total = questions.length
  const current = questions[step]

  /** Ответ на вопрос по индексу: выбранные значения + свой ответ. */
  const answerFor = useCallback(
    (index: number): string[] => {
      const values = selected[index] ?? []
      const text = (custom[index] ?? '').trim()
      if (!text) return values
      const item = questions[index]
      // Одиночный выбор: свой ответ заменяет вариант; множественный — дополняет.
      return item?.multiple ? [...values, text] : [text]
    },
    [selected, custom, questions],
  )

  const allAnswered = total > 0 && questions.every((_, index) => answerFor(index).length > 0)

  const toggleOption = (index: number, value: string, multiple: boolean) => {
    setSelected((prev) => {
      const currentValues = prev[index] ?? []
      if (!multiple) {
        return { ...prev, [index]: currentValues.includes(value) ? [] : [value] }
      }
      return {
        ...prev,
        [index]: currentValues.includes(value)
          ? currentValues.filter((v) => v !== value)
          : [...currentValues, value],
      }
    })
    // Свой ответ снимает выбор варианта (для одиночного вопроса).
    if (!multiple && (custom[index] ?? '').trim()) {
      setCustom((prev) => ({ ...prev, [index]: '' }))
    }
  }

  const handleCustomChange = (index: number, value: string, multiple: boolean) => {
    setCustom((prev) => ({ ...prev, [index]: value }))
    if (value.trim() && !multiple) {
      setSelected((prev) => ({ ...prev, [index]: [] }))
    }
  }

  const handleSubmit = useCallback(async () => {
    if (!record || busy || !allAnswered) return
    const payload = questions.map((_, index) => answerFor(index))
    setBusy(true)
    try {
      await synthApi.answer(sessionId, record.id, payload)
      useQuestionStore.getState().remove(sessionId, record.id)
    } catch {
      notify({
        text: t('question.dock.failed'),
        type: 'error',
        category: 'error',
        sessionId,
      })
    } finally {
      setBusy(false)
    }
  }, [record, busy, allAnswered, questions, answerFor, sessionId, notify, t])

  const handleCancel = useCallback(async () => {
    if (!record || busy) return
    setBusy(true)
    try {
      await synthApi.cancel(sessionId, record.id, 'user')
      useQuestionStore.getState().remove(sessionId, record.id)
      notify({
        text: t('question.dock.cancelled'),
        type: 'info',
        category: 'system',
        sessionId,
      })
    } catch {
      notify({
        text: t('question.dock.failed'),
        type: 'error',
        category: 'error',
        sessionId,
      })
    } finally {
      setBusy(false)
    }
  }, [record, busy, sessionId, notify, t])

  // Горячие клавиши работают по актуальным обработчикам ( refs ).
  const submitRef = useRef(handleSubmit)
  const cancelRef = useRef(handleCancel)
  submitRef.current = handleSubmit
  cancelRef.current = handleCancel

  useEffect(() => {
    if (!record) return
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault()
        void submitRef.current()
        return
      }
      if (event.key === 'Escape') {
        const target = event.target as HTMLElement | null
        const tag = target?.tagName?.toLowerCase()
        // В поле ввода Esc не перехватываем — пользователь может печатать.
        if (tag === 'input' || tag === 'textarea' || target?.isContentEditable) return
        event.preventDefault()
        void cancelRef.current()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [record])

  if (!record || !current) return null

  const selectedValues = selected[step] ?? []
  const customText = custom[step] ?? ''
  const customVisible = customOpen[step] ?? false

  return (
    <div
      className="question-dock shrink-0 mx-auto w-4/5 rounded-lg border border-primary/30 bg-primary/5"
      data-question-dock="true"
    >
      <div className="flex items-center gap-2 px-3 py-1.5">
        <Icon name="question" className="size-3.5 text-primary shrink-0" />
        <span className="text-xs text-foreground/90 truncate">{t('question.dock.title')}</span>
        {total > 1 && (
          <span className="text-[0.625rem] text-muted-foreground shrink-0 tabular-nums">
            {t('question.dock.progress', { current: step + 1, total })}
          </span>
        )}
      </div>

      <div className="px-3 pb-2 pt-2 space-y-2 border-t border-primary/15">
        <div className="min-w-0">
          <div className="text-xs font-medium text-foreground break-words">{current.header}</div>
          <div className="text-xs text-muted-foreground whitespace-pre-wrap break-words">
            {current.question}
          </div>
        </div>

        {current.options.length > 0 && (
          <div className="space-y-1">
            {current.options.map((option) => {
              const checked = selectedValues.includes(option.value)
              return (
                <label
                  key={option.value}
                  className={cn(
                    'flex items-start gap-2 rounded px-2 py-1.5 cursor-pointer border transition-colors',
                    checked
                      ? 'border-primary/40 bg-primary/10'
                      : 'border-border/40 hover:bg-interactive-hover',
                  )}
                >
                  <input
                    type={current.multiple ? 'checkbox' : 'radio'}
                    name={`question-option-${record.id}-${step}`}
                    checked={checked}
                    onChange={() => toggleOption(step, option.value, !!current.multiple)}
                    className="mt-0.5 shrink-0 accent-[var(--primary)]"
                  />
                  <span className="min-w-0">
                    <span className={cn('block text-xs break-words', checked ? 'text-foreground' : 'text-foreground/85')}>
                      {option.label}
                    </span>
                    {option.description && (
                      <span className="block text-[0.625rem] text-muted-foreground break-words">
                        {option.description}
                      </span>
                    )}
                  </span>
                </label>
              )
            })}
          </div>
        )}

        {current.multiple && (
          <div className="text-[0.625rem] text-muted-foreground">{t('question.dock.multipleHint')}</div>
        )}

        <div className="space-y-1">
          <button
            type="button"
            onClick={() => setCustomOpen((prev) => ({ ...prev, [step]: !customVisible }))}
            className="flex items-center gap-1.5 rounded px-1.5 py-1 text-[0.6875rem] text-muted-foreground hover:text-foreground hover:bg-interactive-hover transition-colors"
          >
            <Icon name={customVisible ? 'arrow-down-s' : 'arrow-right-s'} className="size-3 shrink-0" />
            {t('question.dock.custom')}
          </button>
          {customVisible && (
            <input
              type="text"
              value={customText}
              onChange={(e) => handleCustomChange(step, e.target.value, !!current.multiple)}
              placeholder={t('question.dock.custom')}
              className="w-full rounded border border-border/60 bg-surface-card px-2 py-1.5 text-xs text-foreground placeholder:text-muted-foreground outline-none focus:border-primary/50"
            />
          )}
        </div>

        <div className="flex items-center gap-1 flex-wrap">
          {total > 1 && (
            <>
              <button
                type="button"
                onClick={() => setStep((s) => Math.max(0, s - 1))}
                disabled={step === 0 || busy}
                className="rounded px-2 py-1 text-[0.6875rem] text-muted-foreground hover:text-foreground hover:bg-interactive-hover transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
              >
                {t('question.dock.prev')}
              </button>
              <button
                type="button"
                onClick={() => setStep((s) => Math.min(total - 1, s + 1))}
                disabled={step >= total - 1 || busy}
                className="rounded px-2 py-1 text-[0.6875rem] text-muted-foreground hover:text-foreground hover:bg-interactive-hover transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
              >
                {t('question.dock.next')}
              </button>
            </>
          )}

          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={() => void handleCancel()}
              disabled={busy}
              className="rounded px-2 py-1 text-[0.6875rem] text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-40"
            >
              {t('question.dock.cancel')}
            </button>
            <button
              type="button"
              onClick={() => void handleSubmit()}
              disabled={!allAnswered || busy}
              className="flex items-center gap-1.5 rounded px-2.5 py-1 text-[0.6875rem] font-medium bg-primary/15 text-primary hover:bg-primary/25 transition-colors disabled:opacity-40 disabled:hover:bg-primary/15"
            >
              {busy && <Icon name="loader-2" className="size-3 animate-spin" />}
              {t('question.dock.submit')}
            </button>
          </div>
        </div>

        {!allAnswered && (
          <div className="text-[0.625rem] text-muted-foreground">{t('question.dock.required')}</div>
        )}
      </div>
    </div>
  )
}

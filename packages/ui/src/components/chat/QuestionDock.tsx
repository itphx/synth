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
 * Шаг дока: ответы на вопросы или итоговая проверка перед отправкой.
 *
 * `reviewing` — экран подтверждения: список вопросов с выбранными ответами,
 * «Изменить» возвращает к нужному вопросу (ответы сохраняются).
 */
type DockPhase = 'answer' | 'reviewing'

/**
 * Док вопросов агента над полем ввода (этап 1 roadmap 0.13 — блок 1.3).
 *
 * Показывает запись вопроса сессии со статусом `pending`: текст вопроса,
 * варианты ответа (радио/чекбоксы), «свой ответ» и кнопки «Ответить»/«Отменить».
 * Восстановление после перезагрузки — `GET /sessions/:id/questions?status=pending`;
 * live-обновление — события `user_question.*` (диспетчер `stores/transportStore.ts`).
 *
 * Сворачивание (`collapsed`): в шапке шеврон, свёрнутый вид — подпись
 * «Вопрос N из M», бейдж «отвечено K/M» и превью текста вопроса; варианты,
 * ввод и кнопки навигации скрыты (`hidden` + `aria-hidden` + `inert`).
 * Точки-сегменты остаются доступными — по ним переключают вопрос, и
 * сворачивание при этом не сбрасывается (сбрасывается только на новой
 * записи, `record.id`).
 *
 * Навигация по вопросам — точки-сегменты (вместо текста «1 из N») плюс
 * «Назад»/«Далее». Перед отправкой ответов — шаг проверки (`reviewing`):
 * список «вопрос → ответ», «Изменить» возврат к вопросу, «Отправить»
 * вызывает `answer` (активна, когда отвечены все вопросы).
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
  /** Свёрнут ли док (шапка с превью вместо полного шага). */
  const [collapsed, setCollapsed] = useState(false)
  /** Текущий шаг дока: ответы или итоговая проверка. */
  const [phase, setPhase] = useState<DockPhase>('answer')

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
    // Новая запись — док раскрыт и снова на шаге ответов.
    setCollapsed(false)
    setPhase('answer')
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

  /** Сколько вопросов уже отвечено. */
  const answeredCount = useMemo(
    () => questions.reduce((count, _, index) => count + (answerFor(index).length > 0 ? 1 : 0), 0),
    [questions, answerFor],
  )

  const allAnswered = total > 0 && answeredCount === total

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

  /** Открыть шаг итоговой проверки (перед отправкой ответов). */
  const openReview = useCallback(() => setPhase('reviewing'), [])

  /**
   * Основное действие текущего шага.
   *
   * На шаге проверки — отправка; на шаге ответов — отправка (одиночный
   * вопрос) или переход к проверке (несколько вопросов).
   */
  const handlePrimary = useCallback(async () => {
    if (phase === 'reviewing' || total === 1) {
      await handleSubmit()
      return
    }
    openReview()
  }, [phase, total, handleSubmit, openReview])

  // Горячие клавиши работают по актуальным обработчикам ( refs ).
  const submitRef = useRef(handleSubmit)
  const cancelRef = useRef(handleCancel)
  const primaryRef = useRef(handlePrimary)
  submitRef.current = handleSubmit
  cancelRef.current = handleCancel
  primaryRef.current = handlePrimary

  useEffect(() => {
    if (!record) return
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault()
        void primaryRef.current()
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

  /** Текст ответа для шага проверки: label варианта, иначе сам ответ. */
  const answerText = (index: number): string => {
    const values = answerFor(index)
    if (values.length === 0) return t('question.dock.review.unanswered')
    return values
      .map((value) => questions[index]?.options.find((o) => o.value === value)?.label ?? value)
      .join(', ')
  }

  const progressLabel = t('question.dock.progress', { current: step + 1, total })
  const headerLabel =
    phase === 'reviewing'
      ? t('question.dock.review.title')
      : collapsed
        ? t('question.dock.collapsedTitle', { current: step + 1, total })
        : t('question.dock.title')

  const primaryButtonClass =
    'flex items-center gap-1.5 rounded px-2.5 py-1 text-[0.6875rem] font-medium bg-primary/15 text-primary hover:bg-primary/25 transition-colors disabled:opacity-40 disabled:hover:bg-primary/15'

  return (
    <div
      className="question-dock shrink-0 mx-auto w-4/5 rounded-lg border border-primary/30 bg-primary/5"
      data-question-dock="true"
    >
      <div className="flex items-center gap-2 px-3 py-1.5">
        <Icon name="question" className="size-3.5 text-primary shrink-0" />
        <span className="min-w-0 flex-1 truncate text-xs text-foreground/90">{headerLabel}</span>
        {phase === 'answer' && total > 1 && (
          <div
            role="group"
            aria-label={progressLabel}
            title={progressLabel}
            data-question-dots="true"
            className="flex shrink-0 flex-wrap items-center justify-end gap-0.5"
          >
            {questions.map((_, index) => {
              const isActive = index === step
              const isAnswered = answerFor(index).length > 0
              return (
                <button
                  key={index}
                  type="button"
                  data-question-dot={index}
                  aria-label={t('question.dock.dots.aria', { n: index + 1 })}
                  aria-current={isActive ? 'step' : undefined}
                  onClick={() => setStep(index)}
                  className="flex h-5 w-5 items-center justify-center rounded transition-colors hover:bg-interactive-hover"
                >
                  <span
                    className={cn(
                      'block h-1 rounded-full transition-all',
                      isActive
                        ? 'w-4 bg-primary'
                        : isAnswered
                          ? 'w-2.5 bg-primary/60'
                          : 'w-2.5 bg-muted-foreground/40',
                    )}
                  />
                </button>
              )
            })}
          </div>
        )}
        <button
          type="button"
          data-question-collapse="true"
          aria-expanded={!collapsed}
          aria-label={collapsed ? t('question.dock.expand') : t('question.dock.collapse')}
          title={collapsed ? t('question.dock.expand') : t('question.dock.collapse')}
          onClick={() => setCollapsed((prev) => !prev)}
          className="flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground"
        >
          <Icon name={collapsed ? 'arrow-up-s' : 'arrow-down-s'} className="size-4" />
        </button>
      </div>

      {collapsed && (
        <div
          data-question-collapsed="true"
          className="space-y-1.5 border-t border-primary/15 px-3 pb-2 pt-2"
        >
          {phase === 'reviewing' ? (
            <div className="text-xs text-foreground/90 break-words">
              {t('question.dock.review.collapsed', { answered: answeredCount, total })}
            </div>
          ) : (
            <div className="min-w-0">
              <div className="text-xs font-medium text-foreground break-words">{current.header}</div>
              <div className="line-clamp-3 text-xs text-muted-foreground whitespace-pre-wrap break-words">
                {current.question}
              </div>
            </div>
          )}
          <div className="flex items-center gap-2">
            {phase === 'answer' && (
              <span
                className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[0.625rem] text-primary tabular-nums"
                data-question-answered="true"
              >
                {t('question.dock.collapsedSummary', { answered: answeredCount, total })}
              </span>
            )}
            <button
              type="button"
              onClick={() => setCollapsed(false)}
              className="ml-auto flex shrink-0 items-center gap-1.5 rounded px-1.5 py-1 text-[0.6875rem] text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground"
            >
              <Icon name="arrow-up-s" className="size-3 shrink-0" />
              {t('question.dock.expand')}
            </button>
          </div>
        </div>
      )}

      <div
        data-question-body="true"
        hidden={collapsed}
        aria-hidden={collapsed ? true : undefined}
        inert={collapsed ? true : undefined}
        className="space-y-2 border-t border-primary/15 px-3 pb-2 pt-2"
      >
        {phase === 'reviewing' ? (
          <>
            <div className="space-y-1.5" data-question-review="true">
              <ul className="space-y-1">
                {questions.map((item, index) => (
                  <li
                    key={index}
                    className="flex items-start gap-2 rounded border border-border/40 px-2 py-1.5"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-medium text-foreground break-words">
                        {item.header}
                      </div>
                      <div className="text-xs text-muted-foreground break-words">
                        {answerText(index)}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setStep(index)
                        setPhase('answer')
                      }}
                      className="shrink-0 rounded px-1.5 py-1 text-[0.6875rem] text-primary transition-colors hover:bg-primary/10"
                    >
                      {t('question.dock.review.edit')}
                    </button>
                  </li>
                ))}
              </ul>
            </div>

            <div className="flex flex-wrap items-center gap-1">
              <button
                type="button"
                onClick={() => {
                  setStep(total - 1)
                  setPhase('answer')
                }}
                disabled={busy}
                className="rounded px-2 py-1 text-[0.6875rem] text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground disabled:opacity-40"
              >
                {t('question.dock.review.back')}
              </button>

              <div className="ml-auto flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => void handleCancel()}
                  disabled={busy}
                  className="rounded px-2 py-1 text-[0.6875rem] text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-40"
                >
                  {t('question.dock.cancel')}
                </button>
                <button
                  type="button"
                  onClick={() => void handleSubmit()}
                  disabled={!allAnswered || busy}
                  className={primaryButtonClass}
                >
                  {busy && <Icon name="loader-2" className="size-3 animate-spin" />}
                  {t('question.dock.review.submit')}
                </button>
              </div>
            </div>
          </>
        ) : (
          <>
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

            <div className="flex flex-wrap items-center gap-1">
              {total > 1 && (
                <button
                  type="button"
                  onClick={() => setStep((s) => Math.max(0, s - 1))}
                  disabled={step === 0 || busy}
                  className="rounded px-2 py-1 text-[0.6875rem] text-muted-foreground hover:text-foreground hover:bg-interactive-hover transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
                >
                  {t('question.dock.prev')}
                </button>
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
                {total === 1 ? (
                  <button
                    type="button"
                    onClick={() => void handleSubmit()}
                    disabled={!allAnswered || busy}
                    className={primaryButtonClass}
                  >
                    {busy && <Icon name="loader-2" className="size-3 animate-spin" />}
                    {t('question.dock.submit')}
                  </button>
                ) : step < total - 1 ? (
                  <button
                    type="button"
                    onClick={() => setStep((s) => Math.min(total - 1, s + 1))}
                    disabled={busy}
                    className={primaryButtonClass}
                  >
                    {t('question.dock.next')}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={openReview}
                    disabled={busy}
                    className={primaryButtonClass}
                  >
                    {t('question.dock.review.open')}
                  </button>
                )}
              </div>
            </div>

            {!allAnswered && (
              <div className="text-[0.625rem] text-muted-foreground">{t('question.dock.required')}</div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

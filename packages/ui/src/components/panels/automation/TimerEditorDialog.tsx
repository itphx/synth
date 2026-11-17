import { useEffect, useMemo, useState } from 'react'

import type { Timer, TimerKind } from '@itphx/synth-shared/types'
import { synthApi } from '@/lib/api/synthApi'
import type { TimerCreateInput } from '@/lib/api/timers'
import { useI18n } from '@/lib/i18n'
import { useNotification } from '@/hooks/useNotification'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { TextArea, TextField } from '@/components/ui/settings'
import { SessionSelect } from '@/components/settings/entity-selects'

/**
 * Модальный редактор таймера/будильника (PROP-141, этап 7b).
 *
 * Таймер и будильник — **один тип** с двумя видами (`kind`): таймер
 * относительный («через 15 минут»), будильник — абсолютный/повторяющийся
 * («завтра в 09:00», «каждые 10 минут»).
 *
 * Тело — интент первого срабатывания:
 * - `repeat.mode='once'` + `kind:'timer'` — относительная задержка `delaySec`;
 * - `repeat.mode='once'` + `kind:'alarm'` — абсолютное время `at`;
 * - `repeat.mode='daily'|'every'` — правило повтора (метку считает движок).
 */

/** Минимальный интервал движка (`TIMER_MIN_INTERVAL_SEC`) — 10 секунд. */
const MIN_INTERVAL_SEC = 10

/** Правило повтора, выбранное в форме. */
type RepeatMode = 'once' | 'every' | 'daily'

interface EditorState {
  name: string
  comment: string
  sessionId: string
  repeat: RepeatMode
  /** Задержка/интервал в минутах. */
  minutes: string
  /** Абсолютное время срабатывания (`datetime-local`, локальное время). */
  at: string
  /** Время суток для ежедневного будильника (`HH:MM`). */
  time: string
  /** Часовой пояс ежедневного будильника (IANA). */
  timezone: string
}

/** Часовой пояс браузера — значение по умолчанию для ежедневного будильника. */
function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/** Значение `datetime-local` из ISO-строки (локальное время). */
function toLocalInputValue(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (value: number) => String(value).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  )
}

/** Локальное время из значения `datetime-local` → ISO (UTC). */
function fromLocalInputValue(value: string): string | null {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString()
}

export interface TimerEditorDialogProps {
  /** Открыт ли диалог. */
  open: boolean
  /** Вид автоматизации: таймер или будильник. */
  kind: TimerKind
  /** Таймер для правки; `null` — создание нового. */
  timer: Timer | null
  /** Сессия по умолчанию (текущий контекст панели). */
  defaultSessionId?: string | null
  /** Проект по умолчанию (текущий контекст панели). */
  defaultProjectId?: string | null
  /** Закрыть диалог. */
  onClose: () => void
  /** Вызывается после успешного сохранения. */
  onSaved?: (timer: Timer) => void
}

/**
 * Модальный редактор таймера/будильника: создание и правка.
 */
export function TimerEditorDialog({
  open,
  kind,
  timer,
  defaultSessionId,
  defaultProjectId,
  onClose,
  onSaved,
}: TimerEditorDialogProps) {
  const { t } = useI18n()
  const { notify } = useNotification()

  const [editor, setEditor] = useState<EditorState | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // Черновик формы пересобирается при каждом открытии диалога.
  useEffect(() => {
    if (!open) return
    setFormError(null)
    setSaveError(null)
    if (!timer) {
      setEditor({
        name: '',
        comment: '',
        sessionId: defaultSessionId ?? '',
        repeat: 'once',
        minutes: '15',
        at: '',
        time: '09:00',
        timezone: browserTimezone(),
      })
      return
    }
    const repeat = timer.repeat
    const delayMin = Math.max(
      1,
      Math.round((Date.parse(timer.firesAt) - Date.parse(timer.createdAt)) / 60_000),
    )
    setEditor({
      name: timer.name ?? '',
      comment: timer.comment,
      sessionId: timer.sessionId,
      repeat: repeat.mode,
      minutes:
        repeat.mode === 'every'
          ? String(Math.max(1, Math.round(repeat.everySec / 60)))
          : String(delayMin),
      at: repeat.mode === 'once' && kind === 'alarm' ? toLocalInputValue(timer.firesAt) : '',
      time: repeat.mode === 'daily' ? repeat.time : '09:00',
      timezone: repeat.mode === 'daily' ? repeat.timezone : browserTimezone(),
    })
  }, [open, timer, kind, defaultSessionId])

  const title = useMemo(() => {
    if (kind === 'alarm') {
      return timer ? t('automation.form.editAlarm') : t('automation.form.newAlarm')
    }
    return timer ? t('automation.form.editTimer') : t('automation.form.newTimer')
  }, [kind, timer, t])

  /** Тело запроса по черновику формы. */
  const buildInput = (state: EditorState): TimerCreateInput => {
    const minutes = Number(state.minutes)
    const base = {
      kind,
      ...(state.name.trim() ? { name: state.name.trim() } : {}),
      comment: state.comment.trim(),
      sessionId: state.sessionId,
    }
    if (state.repeat === 'every') {
      const everySec = Math.round(minutes * 60)
      return { ...base, repeat: { mode: 'every', everySec } }
    }
    if (state.repeat === 'daily') {
      return {
        ...base,
        repeat: { mode: 'daily', time: state.time.trim(), timezone: state.timezone.trim() },
      }
    }
    if (kind === 'alarm') {
      return {
        ...base,
        repeat: { mode: 'once' },
        ...(fromLocalInputValue(state.at) ? { at: fromLocalInputValue(state.at)! } : {}),
      }
    }
    return { ...base, repeat: { mode: 'once' }, delaySec: Math.round(minutes * 60) }
  }

  const handleSave = async () => {
    if (!editor) return
    if (!editor.comment.trim()) {
      setFormError(t('automation.form.commentRequired'))
      return
    }
    if (!editor.sessionId) {
      setFormError(t('automation.form.sessionRequired'))
      return
    }
    const minutes = Number(editor.minutes)
    if (!Number.isFinite(minutes) || minutes <= 0) {
      setFormError(
        editor.repeat === 'every'
          ? t('automation.form.intervalRequired')
          : t('automation.form.delayRequired'),
      )
      return
    }
    if (editor.repeat === 'every' && Math.round(minutes * 60) < MIN_INTERVAL_SEC) {
      setFormError(t('automation.form.intervalRequired'))
      return
    }
    if (editor.repeat === 'daily') {
      if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(editor.time.trim())) {
        setFormError(t('automation.form.timeRequired'))
        return
      }
      if (!editor.timezone.trim()) {
        setFormError(t('automation.form.timezoneRequired'))
        return
      }
    }
    if (editor.repeat === 'once' && kind === 'alarm') {
      if (!fromLocalInputValue(editor.at)) {
        setFormError(t('automation.form.atRequired'))
        return
      }
    }
    setFormError(null)
    setSaving(true)
    setSaveError(null)
    try {
      const input = buildInput(editor)
      const saved = timer
        ? await synthApi.patchTimer(timer.id, {
            ...(editor.name.trim() ? { name: editor.name.trim() } : { name: null }),
            comment: input.comment,
            repeat: input.repeat,
          })
        : await synthApi.createTimer({
            ...input,
            ...(defaultProjectId ? { projectId: defaultProjectId } : {}),
          })
      onSaved?.(saved)
      notify({ text: t('automation.saved'), type: 'success', category: 'system' })
      onClose()
    } catch (err) {
      const message = err instanceof Error ? err.message : t('common.error')
      setSaveError(message)
      notify({
        text: t('automation.form.saveError', { error: message }),
        type: 'error',
        category: 'error',
      })
    } finally {
      setSaving(false)
    }
  }

  const repeatOptions: Array<{ value: RepeatMode; label: string }> =
    kind === 'alarm'
      ? [
          { value: 'once', label: t('automation.repeat.once') },
          { value: 'daily', label: t('automation.repeat.daily') },
          { value: 'every', label: t('automation.repeat.every') },
        ]
      : [
          { value: 'once', label: t('automation.repeat.once') },
          { value: 'every', label: t('automation.repeat.every') },
        ]

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="max-w-md" data-testid="timer-editor-dialog">
        <h2 className="text-sm font-medium text-foreground break-words">{title}</h2>

        {saveError && (
          <div role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
            {saveError}
          </div>
        )}

        {editor && (
          <div className="space-y-3 min-w-0" data-testid="timer-editor">
            <TextField
              label={t('automation.field.name')}
              value={editor.name}
              onChange={(e) => setEditor((prev) => (prev ? { ...prev, name: e.target.value } : prev))}
              id="timer-name"
              data-testid="timer-name"
            />

            <TextArea
              label={t('automation.field.comment')}
              value={editor.comment}
              onChange={(e) =>
                setEditor((prev) => (prev ? { ...prev, comment: e.target.value } : prev))
              }
              error={formError ?? undefined}
              rows={3}
              id="timer-comment"
              data-testid="timer-comment"
            />

            <SessionSelect
              label={t('automation.field.session')}
              value={editor.sessionId}
              onChange={(value) =>
                setEditor((prev) => (prev ? { ...prev, sessionId: value } : prev))
              }
              includeEmpty
              emptyLabel={t('automation.form.sessionRequired')}
              testId="timer-session"
              allowCreate
            />

            <div className="space-y-1">
              <label
                className="text-xs text-muted-foreground"
                htmlFor="timer-repeat"
              >
                {t('automation.field.repeat')}
              </label>
              <select
                id="timer-repeat"
                value={editor.repeat}
                onChange={(e) =>
                  setEditor((prev) =>
                    prev ? { ...prev, repeat: e.target.value as RepeatMode } : prev,
                  )
                }
                aria-label={t('automation.field.repeat')}
                data-testid="timer-repeat"
                className="w-full min-w-0 rounded-lg border border-border bg-background px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              >
                {repeatOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            {editor.repeat === 'daily' ? (
              <>
                <TextField
                  label={t('automation.field.time')}
                  value={editor.time}
                  onChange={(e) =>
                    setEditor((prev) => (prev ? { ...prev, time: e.target.value } : prev))
                  }
                  placeholder="09:00"
                  mono
                  id="timer-time"
                  data-testid="timer-time"
                />
                <TextField
                  label={t('automation.field.timezone')}
                  value={editor.timezone}
                  onChange={(e) =>
                    setEditor((prev) => (prev ? { ...prev, timezone: e.target.value } : prev))
                  }
                  mono
                  id="timer-timezone"
                  data-testid="timer-timezone"
                />
              </>
            ) : editor.repeat === 'every' ? (
              <TextField
                label={t('automation.field.interval')}
                value={editor.minutes}
                onChange={(e) =>
                  setEditor((prev) => (prev ? { ...prev, minutes: e.target.value } : prev))
                }
                type="number"
                min={1}
                id="timer-interval"
                data-testid="timer-interval"
              />
            ) : kind === 'alarm' ? (
              <TextField
                label={t('automation.field.at')}
                value={editor.at}
                onChange={(e) => setEditor((prev) => (prev ? { ...prev, at: e.target.value } : prev))}
                type="datetime-local"
                id="timer-at"
                data-testid="timer-at"
              />
            ) : (
              <TextField
                label={t('automation.field.delay')}
                value={editor.minutes}
                onChange={(e) =>
                  setEditor((prev) => (prev ? { ...prev, minutes: e.target.value } : prev))
                }
                type="number"
                min={1}
                id="timer-delay"
                data-testid="timer-delay"
              />
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            variant="outline-muted"
            onClick={onClose}
            disabled={saving}
            data-testid="timer-cancel"
          >
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={() => void handleSave()}
            disabled={saving}
            data-testid="timer-save"
          >
            {saving ? t('common.saving') : t('common.save')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

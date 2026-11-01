import { useCallback, useEffect, useState } from 'react'

import { useI18n } from '@/lib/i18n'
import { useNotification } from '@/hooks/useNotification'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Icon } from '@/components/icon/Icon'
import {
  NumberField,
  SettingsRow,
  SettingsSection,
} from '@/components/ui/settings'
import {
  STICKY_NOTES_LIMITS_BOUNDS,
  deleteStickyNotesLimits,
  fetchStickyNotesLimits,
  putStickyNotesLimits,
  type StickyNotesLimits,
  type StickyNotesLimitsSettings,
  type StickyNotesLimitsSource,
} from '@/lib/api/stickyNotesLimits'

/** Бейдж состояния — общий вид с соседними блоками «Управления контекстом». */
const BADGE = 'rounded px-1.5 py-0.5 text-[0.625rem] font-medium'

/** Цвет бейджа источника настройки. */
const SOURCE_BADGE_CLASS: Record<StickyNotesLimitsSource, string> = {
  runtime: 'bg-primary/15 text-primary',
  config: 'bg-muted text-muted-foreground',
  default: 'bg-muted text-muted-foreground',
}

type LimitKey = keyof StickyNotesLimits

interface LimitFieldConfig {
  key: LimitKey
  labelKey: string
  hintKey: string
  testId: string
}

const LIMIT_FIELDS: readonly LimitFieldConfig[] = [
  {
    key: 'maxCount',
    labelKey: 'settings.stickyNotes.field.maxCount',
    hintKey: 'settings.stickyNotes.field.maxCount.hint',
    testId: 'sticky-notes-max-count',
  },
  {
    key: 'maxChars',
    labelKey: 'settings.stickyNotes.field.maxChars',
    hintKey: 'settings.stickyNotes.field.maxChars.hint',
    testId: 'sticky-notes-max-chars',
  },
]

/** Разбор числового поля: число либо ключ ошибки (границы — общие с API). */
function parseLimitInput(
  key: LimitKey,
  raw: string,
): { value: number } | { min: number; max: number } {
  const trimmed = raw.trim()
  const bounds = STICKY_NOTES_LIMITS_BOUNDS[key]
  const value = Number(trimmed)
  if (
    !trimmed ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < bounds.min ||
    value > bounds.max
  ) {
    return bounds
  }
  return { value }
}

/**
 * ADR-072: блок «Заметки» в админ-разделе «Управление контекстом».
 *
 * Настройка уровня инстанса (`GET/PUT/DELETE /api/v2/settings/sticky-notes`):
 * `context.stickyNotes.maxCount` и `maxChars`. Паттерн сохранения — как у
 * соседних блоков: числа сохраняются по завершении ввода (`blur`/Enter),
 * валидация до PUT, при ошибке — откат к последнему серверному значению.
 * Мутации — ADMIN (guard сервера).
 */
export function StickyNotesLimitsSettings() {
  const { t } = useI18n()
  const { notify } = useNotification()

  const [info, setInfo] = useState<StickyNotesLimitsSettings | null>(null)
  const [values, setValues] = useState<StickyNotesLimits | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  /** Имя сохраняемого поля (или `reset`) — держит контролы в состоянии «занято». */
  const [saving, setSaving] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  /** Черновики числовых полей: коммит по blur/Enter, а не на каждое нажатие. */
  const [drafts, setDrafts] = useState<Partial<Record<LimitKey, string>>>({})
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<LimitKey, string>>>({})

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const next = await fetchStickyNotesLimits()
      setInfo(next)
      setValues(next.limits)
      setDrafts({})
      setFieldErrors({})
    } catch (err) {
      setLoadError(
        err instanceof Error && err.message
          ? err.message
          : t('settings.stickyNotes.loadError'),
      )
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    void load()
  }, [load])

  const source: StickyNotesLimitsSource = info?.source ?? 'default'
  const canReset = source === 'runtime'
  const busy = saving !== null

  const commit = useCallback(
    async (patch: Partial<StickyNotesLimits>) => {
      if (!values || busy) return
      const previous = values
      setSaving(Object.keys(patch)[0] ?? 'save')
      setActionError(null)
      setFieldErrors({})
      setValues({ ...values, ...patch })
      try {
        const updated = await putStickyNotesLimits(patch)
        setInfo(updated)
        setValues(updated.limits)
        setDrafts({})
        notify({
          text: t('settings.stickyNotes.saved'),
          type: 'success',
          category: 'system',
        })
      } catch (err) {
        // Сервер отклонил значение — возвращаемся к последнему известному состоянию.
        setValues(previous)
        setDrafts({})
        setActionError(
          t('settings.stickyNotes.saveError', {
            error: err instanceof Error ? err.message : t('common.error'),
          }),
        )
      } finally {
        setSaving(null)
      }
    },
    [busy, notify, t, values],
  )

  const handleReset = useCallback(async () => {
    if (busy) return
    setSaving('reset')
    setActionError(null)
    try {
      const updated = await deleteStickyNotesLimits()
      setInfo(updated)
      setValues(updated.limits)
      setDrafts({})
      setFieldErrors({})
      notify({
        text: t('settings.stickyNotes.resetDone'),
        type: 'success',
        category: 'system',
      })
    } catch (err) {
      setActionError(
        t('settings.stickyNotes.resetError', {
          error: err instanceof Error ? err.message : t('common.error'),
        }),
      )
    } finally {
      setSaving(null)
    }
  }, [busy, notify, t])

  const handleNumberBlur = useCallback(
    (key: LimitKey) => {
      if (!values || busy) return
      const raw = drafts[key]
      if (raw === undefined) return
      const parsed = parseLimitInput(key, raw)
      if ('min' in parsed) {
        setFieldErrors((prev) => ({
          ...prev,
          [key]: t('settings.stickyNotes.field.range', { min: parsed.min, max: parsed.max }),
        }))
        return
      }
      setFieldErrors((prev) => {
        if (!(key in prev)) return prev
        const next = { ...prev }
        delete next[key]
        return next
      })
      if (parsed.value === values[key]) {
        setDrafts((prev) => {
          const next = { ...prev }
          delete next[key]
          return next
        })
        return
      }
      void commit({ [key]: parsed.value } as Partial<StickyNotesLimits>)
    },
    [busy, commit, drafts, t, values],
  )

  return (
    <SettingsSection
      id="context-sticky-notes"
      title={t('settings.stickyNotes.title')}
      description={t('settings.stickyNotes.description')}
      tooltip={t('settings.help.contextManagement.section.context-sticky-notes')}
    >
      {loadError && (
        <div
          role="alert"
          data-testid="sticky-notes-load-error"
          className="flex flex-wrap items-start justify-between gap-2 rounded-lg bg-destructive/10 p-3 text-sm text-destructive min-w-0"
        >
          <span className="min-w-0 break-words">{loadError}</span>
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={() => void load()}
            disabled={loading}
            data-testid="sticky-notes-retry"
          >
            <Icon name="refresh" className={cn('size-3.5', loading && 'animate-spin')} />
            {t('settings.stickyNotes.retry')}
          </Button>
        </div>
      )}

      {loading && !info && (
        <div
          className="py-3 text-center text-xs text-muted-foreground"
          data-testid="sticky-notes-loading"
        >
          {t('common.loading')}
        </div>
      )}

      {info && values && (
        <>
          <div className="flex flex-wrap items-center gap-1.5 min-w-0">
            <span
              data-testid="sticky-notes-source-badge"
              className={cn(BADGE, SOURCE_BADGE_CLASS[source])}
            >
              {t(`settings.stickyNotes.source.${source}`)}
            </span>
            {saving && (
              <span
                data-testid="sticky-notes-saving"
                className="text-[0.625rem] text-muted-foreground"
              >
                {t('settings.stickyNotes.saving')}
              </span>
            )}
          </div>

          <p
            className="text-xs text-muted-foreground min-w-0 break-words"
            data-testid="sticky-notes-hint"
          >
            {t('settings.stickyNotes.hint')}
          </p>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 min-w-0">
            {LIMIT_FIELDS.map((field) => (
              <NumberField
                key={field.key}
                id={`sticky-notes-${field.key}`}
                label={t(field.labelKey)}
                description={t(field.hintKey)}
                value={drafts[field.key] ?? String(values[field.key])}
                onChange={(event) => {
                  const next = event.target.value
                  setDrafts((prev) => ({ ...prev, [field.key]: next }))
                  setFieldErrors((prev) => {
                    if (!(field.key in prev)) return prev
                    const copy = { ...prev }
                    delete copy[field.key]
                    return copy
                  })
                }}
                onBlur={() => handleNumberBlur(field.key)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') handleNumberBlur(field.key)
                }}
                min={STICKY_NOTES_LIMITS_BOUNDS[field.key].min}
                max={STICKY_NOTES_LIMITS_BOUNDS[field.key].max}
                step={1}
                error={fieldErrors[field.key]}
                disabled={busy}
                data-testid={field.testId}
              />
            ))}
          </div>

          {actionError && (
            <p
              role="alert"
              data-testid="sticky-notes-action-error"
              className="text-xs text-destructive break-words"
            >
              {actionError}
            </p>
          )}

          {canReset && (
            <SettingsRow
              label={t('settings.stickyNotes.reset')}
              description={t('settings.stickyNotes.resetHint')}
              control={
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void handleReset()}
                  disabled={busy}
                  data-testid="sticky-notes-reset"
                >
                  <Icon
                    name="refresh"
                    className={cn('size-3.5', saving === 'reset' && 'animate-spin')}
                  />
                  {t('settings.stickyNotes.reset')}
                </Button>
              }
            />
          )}
        </>
      )}
    </SettingsSection>
  )
}

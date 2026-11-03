import { useCallback, useEffect, useState } from 'react'

import { useI18n } from '@/lib/i18n'
import { useNotification } from '@/hooks/useNotification'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Icon } from '@/components/icon/Icon'
import { SelectContent, SelectItem } from '@/components/ui/select'
import {
  NumberField,
  SelectField,
  SettingsRow,
  SettingsSection,
} from '@/components/ui/settings'
import {
  CONTEXT_OPTIMIZATION_STRATEGIES,
  SLIDING_WINDOW_MODES,
  SUMMARIZATION_TRIGGER_MODES,
  deleteContextDefaults,
  fetchContextDefaults,
  putContextDefaults,
  type ContextDefaultsResponse,
  type ContextDefaultsSource,
  type ContextDefaultsValues,
  type ContextOptimizationStrategy,
  type SlidingWindowMode,
  type SummarizationTriggerMode,
} from '@/lib/api/contextDefaults'

/** Бейдж состояния — общий вид с админкой «Метрики». */
const BADGE = 'rounded px-1.5 py-0.5 text-[0.625rem] font-medium'

/** Цвет бейджа источника настройки. */
const SOURCE_BADGE_CLASS: Record<ContextDefaultsSource, string> = {
  runtime: 'bg-primary/15 text-primary',
  config: 'bg-muted text-muted-foreground',
  default: 'bg-muted text-muted-foreground',
}

type NumericKey =
  | 'summarizeAfterN'
  | 'summarizeTokenThreshold'
  | 'summarizationKeepTokens'
  | 'compactionKeepTokens'
  | 'compactionTokenThreshold'
  | 'slidingWindowMessageLimit'
  | 'slidingWindowTokenThreshold'

interface NumericFieldConfig {
  key: NumericKey
  labelKey: string
  hintKey: string
  testId: string
  suffix?: string
  percent?: boolean
  /** Нижняя граница (по умолчанию 1; `0` — токены, где ноль допустим). */
  min?: number
  /** Верхняя граница для HTML-поля (сервер ограничивает проценты сам). */
  max?: number
}

/** Поля секции «Суммаризация»: триггер и дословный хвост в токенах. */
const SUMMARIZATION_FIELDS: readonly NumericFieldConfig[] = [
  {
    key: 'summarizeAfterN',
    labelKey: 'settings.contextDefaults.summarization.afterN',
    hintKey: 'settings.contextDefaults.summarization.afterN.hint',
    testId: 'context-defaults-summarize-after',
  },
  {
    key: 'summarizeTokenThreshold',
    labelKey: 'settings.contextDefaults.summarization.tokenThreshold',
    hintKey: 'settings.contextDefaults.summarization.tokenThreshold.hint',
    testId: 'context-defaults-summarize-threshold',
    suffix: '%',
    percent: true,
  },
  {
    key: 'summarizationKeepTokens',
    labelKey: 'settings.contextDefaults.summarization.keepTokens',
    hintKey: 'settings.contextDefaults.summarization.keepTokens.hint',
    testId: 'context-defaults-summarization-keep',
    min: 0,
    max: 50000,
  },
]

/** Поля секции «Компактизация». */
const COMPACTION_FIELDS: readonly NumericFieldConfig[] = [
  {
    key: 'compactionTokenThreshold',
    labelKey: 'settings.contextDefaults.compaction.tokenThreshold',
    hintKey: 'settings.contextDefaults.compaction.tokenThreshold.hint',
    testId: 'context-defaults-compaction-threshold',
    suffix: '%',
    percent: true,
  },
  {
    key: 'compactionKeepTokens',
    labelKey: 'settings.contextDefaults.compaction.keepTokens',
    hintKey: 'settings.contextDefaults.compaction.keepTokens.hint',
    testId: 'context-defaults-compaction-keep',
    min: 0,
    max: 100000,
  },
]

/** Поля секции «Скользящее окно». */
const SLIDING_WINDOW_FIELDS: readonly NumericFieldConfig[] = [
  {
    key: 'slidingWindowMessageLimit',
    labelKey: 'settings.contextDefaults.slidingWindow.messageLimit',
    hintKey: 'settings.contextDefaults.slidingWindow.messageLimit.hint',
    testId: 'context-defaults-sliding-limit',
  },
  {
    key: 'slidingWindowTokenThreshold',
    labelKey: 'settings.contextDefaults.slidingWindow.tokenThreshold',
    hintKey: 'settings.contextDefaults.slidingWindow.tokenThreshold.hint',
    testId: 'context-defaults-sliding-threshold',
    suffix: '%',
    percent: true,
  },
]

/** Результат разбора числового поля: число либо ключ ошибки. */
type ParsedNumber = { value: number } | { errorKey: string }

function parseNumberInput(field: NumericFieldConfig, raw: string): ParsedNumber {
  const trimmed = raw.trim()
  const value = Number(trimmed)
  const min = field.min ?? 1
  if (!trimmed || !Number.isFinite(value) || !Number.isInteger(value) || value < min) {
    return {
      errorKey:
        min === 0
          ? 'settings.contextDefaults.field.nonNegative'
          : 'settings.contextDefaults.field.integer',
    }
  }
  if (field.percent && value > 100) {
    return { errorKey: 'settings.contextDefaults.field.percent' }
  }
  return { value }
}

/**
 * Сетка числовых полей секции: черновик обновляется на ввод, коммит — на
 * `blur`/Enter (паттерн ADR-072 для чисел).
 */
function NumberFieldGrid({
  fields,
  values,
  drafts,
  errors,
  busy,
  onDraft,
  onCommit,
}: {
  fields: readonly NumericFieldConfig[]
  values: ContextDefaultsValues
  drafts: Partial<Record<NumericKey, string>>
  errors: Partial<Record<NumericKey, string>>
  busy: boolean
  onDraft: (key: NumericKey, value: string) => void
  onCommit: (field: NumericFieldConfig) => void
}) {
  const { t } = useI18n()
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 min-w-0">
      {fields.map((field) => (
        <NumberField
          key={field.key}
          id={`context-defaults-${field.key}`}
          label={t(field.labelKey)}
          description={t(field.hintKey)}
          suffix={field.suffix}
          value={drafts[field.key] ?? String(values[field.key])}
          onChange={(event) => onDraft(field.key, event.target.value)}
          onBlur={() => onCommit(field)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') onCommit(field)
          }}
          min={field.min ?? 1}
          max={field.max ?? (field.percent ? 100 : undefined)}
          step={1}
          error={errors[field.key]}
          disabled={busy}
          data-testid={field.testId}
        />
      ))}
    </div>
  )
}

/**
 * ADR-072: блок «Значения по умолчанию для новых сессий».
 *
 * Настройка уровня инстанса (`GET/PUT/DELETE /api/v2/settings/context-defaults`):
 * стратегия оптимизации контекста и параметры автосуммаризации / компактизации /
 * скользящего окна, которые получают новые сессии. Паттерн сохранения — немедленный, как у
 * соседней «Политики окна контекста»: тумблер/селект сохраняются сразу, числа —
 * по завершении ввода (`blur`/Enter). Мутации — ADMIN (guard сервера).
 */
export function ContextDefaultsSettings() {
  const { t } = useI18n()
  const { notify } = useNotification()

  const [info, setInfo] = useState<ContextDefaultsResponse | null>(null)
  const [values, setValues] = useState<ContextDefaultsValues | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  /** Имя сохраняемого поля (или `reset`) — держит контролы в состоянии «занято». */
  const [saving, setSaving] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  /** Черновики числовых полей: коммит по blur/Enter, а не на каждое нажатие. */
  const [drafts, setDrafts] = useState<Partial<Record<NumericKey, string>>>({})
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<NumericKey, string>>>({})

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const next = await fetchContextDefaults()
      setInfo(next)
      setValues(next.defaults)
      setDrafts({})
      setFieldErrors({})
    } catch (err) {
      setLoadError(
        err instanceof Error && err.message
          ? err.message
          : t('settings.contextDefaults.loadError'),
      )
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    void load()
  }, [load])

  const source: ContextDefaultsSource = info?.source ?? 'default'
  const canReset = source === 'runtime'
  const busy = saving !== null

  const commit = useCallback(
    async (patch: Partial<ContextDefaultsValues>) => {
      if (!values || busy) return
      const previous = values
      setSaving(Object.keys(patch)[0] ?? 'save')
      setActionError(null)
      setFieldErrors({})
      setValues({ ...values, ...patch })
      try {
        const updated = await putContextDefaults(patch)
        setInfo(updated)
        setValues(updated.defaults)
        setDrafts({})
        notify({
          text: t('settings.contextDefaults.saved'),
          type: 'success',
          category: 'system',
        })
      } catch (err) {
        // Сервер отклонил значение — возвращаемся к последнему известному состоянию.
        setValues(previous)
        setDrafts({})
        setActionError(
          t('settings.contextDefaults.saveError', {
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
      const updated = await deleteContextDefaults()
      setInfo(updated)
      setValues(updated.defaults)
      setDrafts({})
      setFieldErrors({})
      notify({
        text: t('settings.contextDefaults.resetDone'),
        type: 'success',
        category: 'system',
      })
    } catch (err) {
      setActionError(
        t('settings.contextDefaults.resetError', {
          error: err instanceof Error ? err.message : t('common.error'),
        }),
      )
    } finally {
      setSaving(null)
    }
  }, [busy, notify, t])

  const handleNumberBlur = useCallback(
    (field: NumericFieldConfig) => {
      if (!values || busy) return
      const raw = drafts[field.key]
      if (raw === undefined) return
      const parsed = parseNumberInput(field, raw)
      if ('errorKey' in parsed) {
        setFieldErrors((prev) => ({ ...prev, [field.key]: t(parsed.errorKey) }))
        return
      }
      setFieldErrors((prev) => {
        if (!(field.key in prev)) return prev
        const next = { ...prev }
        delete next[field.key]
        return next
      })
      if (parsed.value === values[field.key]) {
        setDrafts((prev) => {
          const next = { ...prev }
          delete next[field.key]
          return next
        })
        return
      }
      void commit({ [field.key]: parsed.value } as Partial<ContextDefaultsValues>)
    },
    [busy, commit, drafts, t, values],
  )

  const handleDraft = useCallback((key: NumericKey, value: string) => {
    setDrafts((prev) => ({ ...prev, [key]: value }))
    setFieldErrors((prev) => {
      if (!(key in prev)) return prev
      const copy = { ...prev }
      delete copy[key]
      return copy
    })
  }, [])

  return (
    <SettingsSection
      id="context-defaults"
      title={t('settings.contextDefaults.title')}
      description={t('settings.contextDefaults.description')}
      tooltip={t('settings.help.contextManagement.section.context-defaults')}
    >
      {loadError && (
        <div
          role="alert"
          data-testid="context-defaults-load-error"
          className="flex flex-wrap items-start justify-between gap-2 rounded-lg bg-destructive/10 p-3 text-sm text-destructive min-w-0"
        >
          <span className="min-w-0 break-words">{loadError}</span>
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={() => void load()}
            disabled={loading}
            data-testid="context-defaults-retry"
          >
            <Icon name="refresh" className={cn('size-3.5', loading && 'animate-spin')} />
            {t('settings.contextDefaults.retry')}
          </Button>
        </div>
      )}

      {loading && !info && (
        <div
          className="py-3 text-center text-xs text-muted-foreground"
          data-testid="context-defaults-loading"
        >
          {t('common.loading')}
        </div>
      )}

      {info && values && (
        <>
          <div className="flex flex-wrap items-center gap-1.5 min-w-0">
            <span
              data-testid="context-defaults-source-badge"
              className={cn(BADGE, SOURCE_BADGE_CLASS[source])}
            >
              {t(`settings.contextDefaults.source.${source}`)}
            </span>
            {saving && (
              <span
                data-testid="context-defaults-saving"
                className="text-[0.625rem] text-muted-foreground"
              >
                {t('settings.contextDefaults.saving')}
              </span>
            )}
          </div>

          <p
            className="text-xs text-muted-foreground min-w-0 break-words"
            data-testid="context-defaults-new-sessions-hint"
          >
            {t('settings.contextDefaults.newSessionsHint')}
          </p>

          <SelectField
            label={t('settings.contextDefaults.strategy.label')}
            description={t('settings.contextDefaults.strategy.description')}
            value={values.contextOptimization}
            onValueChange={(next) => {
              const strategy = next as ContextOptimizationStrategy
              if (strategy !== values.contextOptimization) {
                void commit({ contextOptimization: strategy })
              }
            }}
            ariaLabel={t('settings.contextDefaults.strategy.label')}
            triggerTestId="context-defaults-strategy"
            disabled={busy}
            items={CONTEXT_OPTIMIZATION_STRATEGIES.map((strategy) => ({
              value: strategy,
              label: t(`settings.contextDefaults.strategy.${strategy}`),
            }))}
          >
            <SelectContent>
              {CONTEXT_OPTIMIZATION_STRATEGIES.map((strategy) => (
                <SelectItem key={strategy} value={strategy}>
                  {t(`settings.contextDefaults.strategy.${strategy}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </SelectField>

          <p
            className="text-xs text-muted-foreground min-w-0 break-words"
            data-testid="context-defaults-strategy-hint"
          >
            {t(`settings.contextDefaults.strategyHint.${values.contextOptimization}`)}
          </p>

          {/* Автосуммаризация */}
          <div
            className="space-y-3 border-t border-border/60 pt-3 min-w-0"
            data-testid="context-defaults-summarization"
          >
            <div>
              <h4 className="text-sm font-medium text-foreground min-w-0 break-words">
                {t('settings.contextDefaults.summarization.title')}
              </h4>
              <p className="text-xs text-muted-foreground min-w-0 break-words">
                {t('settings.contextDefaults.summarization.description')}
              </p>
            </div>

            <SelectField
              label={t('settings.contextDefaults.summarization.triggerMode')}
              description={t('settings.contextDefaults.summarization.triggerMode.hint')}
              value={values.summarizationTriggerMode}
              onValueChange={(next) => {
                const mode = next as SummarizationTriggerMode
                if (mode !== values.summarizationTriggerMode) {
                  void commit({ summarizationTriggerMode: mode })
                }
              }}
              ariaLabel={t('settings.contextDefaults.summarization.triggerMode')}
              triggerTestId="context-defaults-trigger-mode"
              disabled={busy}
              items={SUMMARIZATION_TRIGGER_MODES.map((mode) => ({
                value: mode,
                label: t(`settings.contextDefaults.summarization.triggerMode.${mode}`),
              }))}
            >
              <SelectContent>
                {SUMMARIZATION_TRIGGER_MODES.map((mode) => (
                  <SelectItem key={mode} value={mode}>
                    {t(`settings.contextDefaults.summarization.triggerMode.${mode}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </SelectField>

            <NumberFieldGrid
              fields={SUMMARIZATION_FIELDS}
              values={values}
              drafts={drafts}
              errors={fieldErrors}
              busy={busy}
              onDraft={handleDraft}
              onCommit={handleNumberBlur}
            />
          </div>

          {/* Компактизация */}
          <div
            className="space-y-3 border-t border-border/60 pt-3 min-w-0"
            data-testid="context-defaults-compaction"
          >
            <div>
              <h4 className="text-sm font-medium text-foreground min-w-0 break-words">
                {t('settings.contextDefaults.compaction.title')}
              </h4>
              <p className="text-xs text-muted-foreground min-w-0 break-words">
                {t('settings.contextDefaults.compaction.description')}
              </p>
            </div>

            <NumberFieldGrid
              fields={COMPACTION_FIELDS}
              values={values}
              drafts={drafts}
              errors={fieldErrors}
              busy={busy}
              onDraft={handleDraft}
              onCommit={handleNumberBlur}
            />
          </div>

          {/* Скользящее окно */}
          <div
            className="space-y-3 border-t border-border/60 pt-3 min-w-0"
            data-testid="context-defaults-sliding-window"
          >
            <div>
              <h4 className="text-sm font-medium text-foreground min-w-0 break-words">
                {t('settings.contextDefaults.slidingWindow.title')}
              </h4>
              <p className="text-xs text-muted-foreground min-w-0 break-words">
                {t('settings.contextDefaults.slidingWindow.description')}
              </p>
            </div>

            <SelectField
              label={t('settings.contextDefaults.slidingWindow.mode')}
              value={values.slidingWindowMode}
              onValueChange={(next) => {
                const mode = next as SlidingWindowMode
                if (mode !== values.slidingWindowMode) {
                  void commit({ slidingWindowMode: mode })
                }
              }}
              ariaLabel={t('settings.contextDefaults.slidingWindow.mode')}
              triggerTestId="context-defaults-sliding-mode"
              disabled={busy}
              items={SLIDING_WINDOW_MODES.map((mode) => ({
                value: mode,
                label: t(`settings.contextDefaults.slidingWindow.mode.${mode}`),
              }))}
            >
              <SelectContent>
                {SLIDING_WINDOW_MODES.map((mode) => (
                  <SelectItem key={mode} value={mode}>
                    {t(`settings.contextDefaults.slidingWindow.mode.${mode}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </SelectField>

            <NumberFieldGrid
              fields={SLIDING_WINDOW_FIELDS}
              values={values}
              drafts={drafts}
              errors={fieldErrors}
              busy={busy}
              onDraft={handleDraft}
              onCommit={handleNumberBlur}
            />
          </div>

          {actionError && (
            <p
              role="alert"
              data-testid="context-defaults-action-error"
              className="text-xs text-destructive break-words"
            >
              {actionError}
            </p>
          )}

          {canReset && (
            <SettingsRow
              label={t('settings.contextDefaults.reset')}
              description={t('settings.contextDefaults.resetHint')}
              control={
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void handleReset()}
                  disabled={busy}
                  data-testid="context-defaults-reset"
                >
                  <Icon
                    name="refresh"
                    className={cn('size-3.5', saving === 'reset' && 'animate-spin')}
                  />
                  {t('settings.contextDefaults.reset')}
                </Button>
              }
            />
          )}
        </>
      )}
    </SettingsSection>
  )
}

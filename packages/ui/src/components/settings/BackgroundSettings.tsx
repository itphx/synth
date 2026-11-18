// BackgroundSettings: админ-раздел «Фоновая работа» (единый реестр прогонов).
//
// Runtime-настройки секции `background` (`GET/PUT/DELETE
// /api/v2/settings/background`):
// - мастер-выключатель `enabled` — запрещает фоновую работу целиком;
// - лимиты одновременной работы (`0` — без лимита): саб-агенты, процессы,
//   прогоны;
// - `logMaxBytes` — предел файла лога прогона (`0` — без лимита);
// - `retentionDays` — срок хранения записей реестра (`<= 0` — без ограничения).
//
// Приоритет: env `SYNTH_BACKGROUND_*` > runtime (`settings.json`/PG) >
// config.yaml `background.*` > default. Env-фиксация — **по полю**: `PUT`
// отправляет частичный патч только незафиксированных полей, `409 ENV_LOCKED`
// приходит с `fields` — их подсвечиваем (контролы блокируются).
//
// Применяется сразу (`restartRequired: false`): реестр читает лимиты на
// каждый запуск, pruner'ы — retention на каждом тике.

import { useCallback, useEffect, useMemo, useState } from 'react'

import { useI18n } from '@/lib/i18n'
import { useNotification } from '@/hooks/useNotification'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Icon } from '@/components/icon/Icon'
import {
  NumberField,
  SettingsActions,
  SettingsPanel,
  SettingsSection,
  ToggleField,
  useSettingsDraft,
} from '@/components/ui/settings'
import {
  BACKGROUND_SETTINGS_FIELDS,
  backgroundSettingsApi,
  type BackgroundSettings,
  type BackgroundSettingsField,
  type BackgroundSettingsPatch,
  type BackgroundSettingsSource,
} from '@/lib/api/backgroundSettings'

const BADGE = 'rounded px-1.5 py-0.5 text-[0.625rem] font-medium'

const SOURCE_BADGE_CLASS: Record<BackgroundSettingsSource, string> = {
  env: 'bg-status-warning/15 text-status-warning',
  runtime: 'bg-primary/15 text-primary',
  config: 'bg-muted text-muted-foreground',
  default: 'bg-muted text-muted-foreground',
}

/** Подпись поля — для баннера «зафиксировано через ENV». */
const FIELD_LABEL_KEYS: Record<BackgroundSettingsField, string> = {
  enabled: 'settings.background.enabled.label',
  maxSubagentsPerSession: 'settings.background.maxSubagents.label',
  maxProcessesPerSession: 'settings.background.maxProcesses.label',
  maxRunsPerSession: 'settings.background.maxRuns.label',
  logMaxBytes: 'settings.background.logMaxBytes.label',
  retentionDays: 'settings.background.retention.label',
}

/**
 * Черновик формы: числа — строками (пустое/нечисловое значение должно давать
 * ошибку валидации, а не молчаливую отправку `NaN`).
 */
interface BackgroundDraft {
  enabled: boolean
  maxSubagentsPerSession: string
  maxProcessesPerSession: string
  maxRunsPerSession: string
  logMaxBytes: string
  retentionDays: string
}

/** Ошибки клиентской валидации (по полю). */
type BackgroundErrors = Partial<Record<BackgroundSettingsField, string>>

const draftFromSettings = (settings: {
  enabled: boolean
  maxSubagentsPerSession: number
  maxProcessesPerSession: number
  maxRunsPerSession: number
  logMaxBytes: number
  retentionDays: number
}): BackgroundDraft => ({
  enabled: settings.enabled,
  maxSubagentsPerSession: String(settings.maxSubagentsPerSession),
  maxProcessesPerSession: String(settings.maxProcessesPerSession),
  maxRunsPerSession: String(settings.maxRunsPerSession),
  logMaxBytes: String(settings.logMaxBytes),
  retentionDays: String(settings.retentionDays),
})

const statusOf = (err: unknown): number | undefined =>
  typeof (err as { status?: unknown })?.status === 'number'
    ? (err as { status: number }).status
    : undefined

/** Целое ≥ 0 (лимиты и размер лога). */
const isNonNegativeInt = (raw: string): boolean => /^\d+$/.test(raw.trim())

/** Целое любого знака (`retentionDays`: `<= 0` — без ограничения). */
const isInt = (raw: string): boolean => /^-?\d+$/.test(raw.trim())

/**
 * Поля, зафиксированные env, из ответа 409.
 *
 * Конверт ошибок ядра: `{ error: { code, fields? } }`; `fetchJSON`
 * протаскивает `fields` (а также `details.fields` — на случай старой формы).
 */
const envLockedFieldsFromError = (err: unknown): BackgroundSettingsField[] => {
  const raw = err as
    | {
        fields?: unknown
        details?: { fields?: unknown } | unknown
        error?: { fields?: unknown; details?: { fields?: unknown } | unknown }
      }
    | null
    | undefined
  const candidates: unknown[] = [
    raw?.fields,
    (raw?.details as { fields?: unknown } | undefined)?.fields,
    raw?.error?.fields,
    (raw?.error?.details as { fields?: unknown } | undefined)?.fields,
  ]
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue
    const fields = candidate.filter((field): field is BackgroundSettingsField =>
      (BACKGROUND_SETTINGS_FIELDS as readonly string[]).includes(field as string),
    )
    if (fields.length > 0) return fields
  }
  return []
}

export function BackgroundSettings() {
  const { t } = useI18n()
  const { notify } = useNotification()

  const [info, setInfo] = useState<BackgroundSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  /** Поля, зафиксированные env по ответу 409 (сервер не вернул список — все). */
  const [conflictFields, setConflictFields] = useState<BackgroundSettingsField[] | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      setInfo(await backgroundSettingsApi.getBackgroundSettings())
    } catch (err) {
      setLoadError(
        err instanceof Error && err.message
          ? err.message
          : t('settings.background.loadError'),
      )
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    void load()
  }, [load])

  /**
   * Поля, зафиксированные env: из снимка (`envLockedFields`) и из ответа 409.
   * Старый снимок без списка полей (`envLocked: true`) фиксирует всё.
   */
  const lockedFields = useMemo<Set<BackgroundSettingsField>>(() => {
    const locked = new Set<BackgroundSettingsField>()
    for (const field of info?.envLockedFields ?? []) locked.add(field)
    for (const field of conflictFields ?? []) locked.add(field)
    if (info?.envLocked === true && (info.envLockedFields?.length ?? 0) === 0) {
      for (const field of BACKGROUND_SETTINGS_FIELDS) locked.add(field)
    }
    return locked
  }, [conflictFields, info])

  const isLocked = useCallback(
    (field: BackgroundSettingsField) => lockedFields.has(field),
    [lockedFields],
  )

  const value = useMemo<BackgroundDraft | null>(
    () => (info ? draftFromSettings(info) : null),
    [info],
  )
  const defaultValue = useMemo<BackgroundDraft | null>(
    () => (info ? draftFromSettings(info.defaults) : null),
    [info],
  )

  /** Единая обработка ошибки сохранения/сброса: 409 — поле зафиксировано env. */
  const reportSaveError = useCallback(
    (err: unknown) => {
      if (statusOf(err) === 409) {
        const fields = envLockedFieldsFromError(err)
        // Список полей сервер не отдал — фиксируем всё (fail-closed).
        setConflictFields(fields.length > 0 ? fields : [...BACKGROUND_SETTINGS_FIELDS])
        setActionError(t('settings.background.conflict'))
        notify({
          text: t('settings.background.envLocked'),
          type: 'warning',
          category: 'system',
        })
        return
      }
      setActionError(
        t('settings.background.saveError', {
          error: err instanceof Error && err.message ? err.message : t('common.error'),
        }),
      )
    },
    [notify, t],
  )

  const draft = useSettingsDraft<BackgroundDraft>({
    value,
    defaultValue,
    onSave: async (next) => {
      // Частичный патч: только незафиксированные и реально изменённые поля.
      const patch: BackgroundSettingsPatch = {}
      if (!isLocked('enabled') && next.enabled !== info?.enabled) {
        patch.enabled = next.enabled
      }
      const numberPatch = (
        field: Exclude<BackgroundSettingsField, 'enabled'>,
        raw: string,
      ) => {
        if (isLocked(field)) return
        const parsed = Number(raw)
        if (parsed !== info?.[field]) patch[field] = parsed
      }
      numberPatch('maxSubagentsPerSession', next.maxSubagentsPerSession)
      numberPatch('maxProcessesPerSession', next.maxProcessesPerSession)
      numberPatch('maxRunsPerSession', next.maxRunsPerSession)
      numberPatch('logMaxBytes', next.logMaxBytes)
      numberPatch('retentionDays', next.retentionDays)

      let saved: BackgroundSettings
      try {
        saved = await backgroundSettingsApi.updateBackgroundSettings(patch)
      } catch (err) {
        // `useSettingsDraft.save()` глотает исключение из `onSave`, поэтому
        // показываем ошибку здесь и пробрасываем: иначе черновик считался бы
        // сохранённым и показался бы успешный тост.
        reportSaveError(err)
        throw err
      }
      setInfo(saved)
      setConflictFields(null)
      return draftFromSettings(saved)
    },
  })

  /** Клиентская валидация: невалидное значение — Save недоступен, виден текст. */
  const errors = useMemo<BackgroundErrors>(() => {
    const current = draft.draft
    if (!current) return {}
    const next: BackgroundErrors = {}
    const limitFields = [
      'maxSubagentsPerSession',
      'maxProcessesPerSession',
      'maxRunsPerSession',
      'logMaxBytes',
    ] as const
    for (const field of limitFields) {
      if (!isNonNegativeInt(current[field])) {
        next[field] = t('settings.background.field.invalid')
      }
    }
    if (!isInt(current.retentionDays)) {
      next.retentionDays = t('settings.background.field.invalid')
    }
    return next
  }, [draft.draft, t])
  const hasErrors = Object.keys(errors).length > 0

  const handleSave = useCallback(async () => {
    if (draft.saving || hasErrors) return
    setActionError(null)
    const ok = await draft.save()
    if (ok) {
      notify({ text: t('settings.background.saved'), type: 'success', category: 'system' })
    }
  }, [draft, hasErrors, notify, t])

  const handleReset = useCallback(async () => {
    if (draft.saving || lockedFields.size >= BACKGROUND_SETTINGS_FIELDS.length) return
    setActionError(null)
    try {
      const saved = await backgroundSettingsApi.resetBackgroundSettings()
      setInfo(saved)
      setConflictFields(null)
      notify({ text: t('settings.background.resetDone'), type: 'success', category: 'system' })
    } catch (err) {
      reportSaveError(err)
    }
  }, [draft.saving, lockedFields.size, notify, reportSaveError, t])

  const source: BackgroundSettingsSource = info?.source ?? 'default'
  const canReset =
    source === 'runtime' && lockedFields.size < BACKGROUND_SETTINGS_FIELDS.length
  const lockedLabels = BACKGROUND_SETTINGS_FIELDS.filter((field) => lockedFields.has(field)).map(
    (field) => t(FIELD_LABEL_KEYS[field]),
  )

  /** Числовое поле лимитов: общий рендер с бейджем ENV и ошибкой. */
  const limitField = (
    field: Exclude<BackgroundSettingsField, 'enabled'>,
    testId: string,
    labelKey: string,
    descriptionKey: string,
  ) => (
    <div key={field} data-testid={testId} className="flex items-start gap-2 min-w-0">
      <div className="min-w-0 flex-1">
        <NumberField
          id={`background-${field}`}
          label={t(labelKey)}
          description={t(descriptionKey)}
          value={draft.draft?.[field] ?? ''}
          onChange={(event) => draft.update({ [field]: event.target.value } as Partial<BackgroundDraft>)}
          min={field === 'retentionDays' ? undefined : 0}
          step={1}
          disabled={isLocked(field) || draft.saving}
          error={errors[field]}
        />
      </div>
      {isLocked(field) && (
        <span className={cn(BADGE, 'mt-6 shrink-0 bg-status-warning/15 text-status-warning')}>
          {t('settings.background.envFieldBadge')}
        </span>
      )}
    </div>
  )

  return (
    <SettingsPanel
      title={t('settings.category.background')}
      description={t('settings.background.description')}
    >
      {loadError && (
        <div
          role="alert"
          data-testid="background-settings-load-error"
          className="flex flex-wrap items-start justify-between gap-2 rounded-lg bg-destructive/10 p-3 text-sm text-destructive min-w-0"
        >
          <span className="min-w-0 break-words">{loadError}</span>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <Icon name="refresh" className={cn('size-3.5', loading && 'animate-spin')} />
            {t('settings.background.retry')}
          </Button>
        </div>
      )}

      {loading && !info && (
        <div
          className="py-3 text-center text-xs text-muted-foreground"
          data-testid="background-settings-loading"
        >
          {t('common.loading')}
        </div>
      )}

      {info && (
        <>
          <div className="flex flex-wrap items-center gap-1.5 min-w-0" data-testid="background-settings-badges">
            <span
              data-testid="background-settings-source-badge"
              className={cn(BADGE, SOURCE_BADGE_CLASS[source])}
            >
              {t(`settings.background.source.${source}`)}
            </span>
            {lockedFields.size > 0 && (
              <span
                data-testid="background-settings-env-badge"
                className={cn(BADGE, 'bg-status-warning/15 text-status-warning')}
              >
                {t('settings.background.envBadge')}
              </span>
            )}
          </div>

          {lockedFields.size > 0 && (
            <div
              role="status"
              data-testid="background-settings-env-banner"
              className="flex items-start gap-2 rounded-lg bg-status-warning/10 p-3 text-xs text-status-warning min-w-0"
            >
              <Icon name="alert" className="mt-0.5 size-3.5 shrink-0" />
              <span className="min-w-0 break-words">
                {t('settings.background.envBanner')}{' '}
                {t('settings.background.envFields', { fields: lockedLabels.join(', ') })}
              </span>
            </div>
          )}

          <SettingsSection
            id="background-runtime"
            title={t('settings.background.runtime.title')}
            description={t('settings.background.runtime.description')}
          >
            <div data-testid="background-settings-enabled-toggle">
              <ToggleField
                label={t('settings.background.enabled.label')}
                description={t('settings.background.enabled.description')}
                enabled={draft.draft?.enabled ?? info.enabled}
                onToggle={() => {
                  if (isLocked('enabled')) return
                  draft.update({ enabled: !(draft.draft?.enabled ?? info.enabled) })
                }}
                disabled={isLocked('enabled') || draft.saving}
                ariaLabel={t('settings.background.enabled.label')}
              />
            </div>
            <p className="text-xs text-muted-foreground min-w-0" data-testid="background-settings-defaults">
              {t('settings.background.defaults', {
                enabled: String(info.defaults.enabled),
                maxRuns: String(info.defaults.maxRunsPerSession),
              })}
            </p>
          </SettingsSection>

          <SettingsSection
            id="background-limits"
            title={t('settings.background.limits.title')}
            description={t('settings.background.limits.description')}
          >
            {limitField(
              'maxSubagentsPerSession',
              'background-settings-max-subagents',
              'settings.background.maxSubagents.label',
              'settings.background.maxSubagents.description',
            )}
            {limitField(
              'maxProcessesPerSession',
              'background-settings-max-processes',
              'settings.background.maxProcesses.label',
              'settings.background.maxProcesses.description',
            )}
            {limitField(
              'maxRunsPerSession',
              'background-settings-max-runs',
              'settings.background.maxRuns.label',
              'settings.background.maxRuns.description',
            )}
          </SettingsSection>

          <SettingsSection
            id="background-retention"
            title={t('settings.background.retention.title')}
            description={t('settings.background.retention.description')}
          >
            {limitField(
              'logMaxBytes',
              'background-settings-log-max-bytes',
              'settings.background.logMaxBytes.label',
              'settings.background.logMaxBytes.description',
            )}
            {limitField(
              'retentionDays',
              'background-settings-retention',
              'settings.background.retention.label',
              'settings.background.retention.fieldDescription',
            )}
          </SettingsSection>

          {actionError && (
            <div
              role="alert"
              data-testid="background-settings-action-error"
              className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive min-w-0 break-words"
            >
              {actionError}
            </div>
          )}

          <SettingsActions
            onSave={() => void handleSave()}
            onReset={() => void handleReset()}
            saveDisabled={!draft.dirty || hasErrors || draft.saving}
            resetDisabled={!canReset || draft.saving}
            saving={draft.saving}
            resetLabel={t('settings.background.reset')}
          />
        </>
      )}
    </SettingsPanel>
  )
}

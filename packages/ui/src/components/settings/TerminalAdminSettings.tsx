// TerminalAdminSettings: админ-раздел «Терминалы» (PROP-132).
//
// Runtime-настройки интерактивных терминалов: `GET/PUT/DELETE
// /api/v2/settings/terminal`.
//
// Две карточки:
// - «Общие» — `enabled` (мастер-выключатель) и `autoRestore` (вкладки после
//   рестарта);
// - «Параметры выполнения» — `idleMinutes` (простой до закрытия), `maxPerProject`,
//   `maxPerInstance`, `shell` (оболочка по умолчанию), `auditInput` (аудит ввода).
//
// Приоритет: env `SYNTH_TERMINAL_*` > runtime (`settings.json`/PG) >
// config.yaml > default. Поля, зафиксированные env (`envLockedFields`), из UI
// не перекрываются: контрол выключен, у поля бейдж «ENV», а серверный `409`
// показывается понятным уведомлением.
//
// Применяется сразу (`restartRequired: false`): мастер-выключатель закрывает
// живые терминалы, а `autoRestore` — поведение вкладок после рестарта ядра.

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
  TextField,
  ToggleField,
  useSettingsDraft,
} from '@/components/ui/settings'
import {
  TERMINAL_IDLE_MINUTES_RANGE,
  TERMINAL_MAX_PER_INSTANCE_RANGE,
  TERMINAL_MAX_PER_PROJECT_RANGE,
  TERMINAL_SETTINGS_FIELDS,
  TERMINAL_SHELL_PATTERN,
  terminalSettingsApi,
  type TerminalSettings,
  type TerminalSettingsField,
  type TerminalSettingsPatch,
  type TerminalSettingsSource,
} from '@/lib/api/terminalSettings'

const BADGE = 'rounded px-1.5 py-0.5 text-[0.625rem] font-medium'

const SOURCE_BADGE_CLASS: Record<TerminalSettingsSource, string> = {
  env: 'bg-status-warning/15 text-status-warning',
  runtime: 'bg-primary/15 text-primary',
  config: 'bg-muted text-muted-foreground',
  default: 'bg-muted text-muted-foreground',
}

/** Подпись поля — для баннера «зафиксировано через ENV». */
const FIELD_LABEL_KEYS: Record<TerminalSettingsField, string> = {
  enabled: 'settings.terminals.enabled.label',
  autoRestore: 'settings.terminals.autoRestore.label',
  idleMinutes: 'settings.terminals.idle.label',
  maxPerProject: 'settings.terminals.maxPerProject.label',
  maxPerInstance: 'settings.terminals.maxPerInstance.label',
  shell: 'settings.terminals.shell.label',
  auditInput: 'settings.terminals.audit.label',
}

/**
 * Значения, которые админ меняет (черновик формы).
 *
 * Числовые поля — строками: пустое/нечисловое значение должно давать ошибку
 * валидации, а не молчаливую отправку `NaN`.
 */
interface TerminalSettingsDraft {
  enabled: boolean
  autoRestore: boolean
  idleMinutes: string
  maxPerProject: string
  maxPerInstance: string
  shell: string
  auditInput: boolean
}

/** Ошибки клиентской валидации (по полю). */
interface TerminalSettingsErrors {
  idleMinutes?: string
  maxPerProject?: string
  maxPerInstance?: string
  shell?: string
}

const draftFromSettings = (settings: {
  enabled: boolean
  autoRestore: boolean
  idleMinutes: number
  maxPerProject: number
  maxPerInstance: number
  shell: string | null
  auditInput: boolean
}): TerminalSettingsDraft => ({
  enabled: settings.enabled,
  autoRestore: settings.autoRestore,
  idleMinutes: String(settings.idleMinutes),
  maxPerProject: String(settings.maxPerProject),
  maxPerInstance: String(settings.maxPerInstance),
  shell: settings.shell ?? '',
  auditInput: settings.auditInput,
})

const statusOf = (err: unknown): number | undefined =>
  typeof (err as { status?: unknown })?.status === 'number'
    ? (err as { status: number }).status
    : undefined

/** Целое число в границах (пустое и нечисловое значение — ошибка). */
const isIntegerInRange = (
  raw: string,
  range: { readonly min: number; readonly max: number },
): boolean => {
  const trimmed = raw.trim()
  if (!/^\d+$/.test(trimmed)) return false
  const value = Number(trimmed)
  return value >= range.min && value <= range.max
}

/** Оболочка: пусто — платформенный дефолт, иначе имя/путь по шаблону. */
const isValidShell = (raw: string): boolean => {
  const value = raw.trim()
  return value === '' || TERMINAL_SHELL_PATTERN.test(value)
}

/**
 * Поля, зафиксированные env, из ответа 409.
 *
 * Конверт ошибок ядра: `{ error: { code, message, fields? } }`; `fetchJSON`
 * протаскивает `code` и `details`, поэтому поля ищем в нескольких местах.
 */
const envLockedFieldsFromError = (err: unknown): TerminalSettingsField[] => {
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
    const fields = candidate.filter((field): field is TerminalSettingsField =>
      (TERMINAL_SETTINGS_FIELDS as readonly string[]).includes(field as string),
    )
    if (fields.length > 0) return fields
  }
  return []
}

export function TerminalAdminSettings() {
  const { t, locale } = useI18n()
  const { notify } = useNotification()

  const [info, setInfo] = useState<TerminalSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  /** Поля, зафиксированные env по ответу 409 (сервер не вернул список — все). */
  const [conflictFields, setConflictFields] = useState<TerminalSettingsField[] | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const next = await terminalSettingsApi.getTerminalSettings()
      setInfo(next)
    } catch (err) {
      setLoadError(
        err instanceof Error && err.message
          ? err.message
          : t('settings.terminals.loadError'),
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
  const lockedFields = useMemo<Set<TerminalSettingsField>>(() => {
    const locked = new Set<TerminalSettingsField>()
    for (const field of info?.envLockedFields ?? []) locked.add(field)
    for (const field of conflictFields ?? []) locked.add(field)
    if (info?.envLocked === true && (info.envLockedFields?.length ?? 0) === 0) {
      for (const field of TERMINAL_SETTINGS_FIELDS) locked.add(field)
    }
    return locked
  }, [conflictFields, info])

  const isLocked = useCallback(
    (field: TerminalSettingsField) => lockedFields.has(field),
    [lockedFields],
  )
  const allLocked = lockedFields.size >= TERMINAL_SETTINGS_FIELDS.length

  const value = useMemo<TerminalSettingsDraft | null>(
    () => (info ? draftFromSettings(info) : null),
    [info],
  )
  const defaultValue = useMemo<TerminalSettingsDraft | null>(
    () => (info ? draftFromSettings(info.defaults) : null),
    [info],
  )

  /**
   * Единая обработка ошибки сохранения/сброса.
   * 409 — поле зафиксировано env: блокируем его и предупреждаем.
   */
  const reportSaveError = useCallback(
    (err: unknown) => {
      if (statusOf(err) === 409) {
        const fields = envLockedFieldsFromError(err)
        // Список полей сервер не отдал — фиксируем всё (fail-closed).
        setConflictFields(fields.length > 0 ? fields : [...TERMINAL_SETTINGS_FIELDS])
        setActionError(t('settings.terminals.conflict'))
        notify({
          text: t('settings.terminals.envLocked'),
          type: 'warning',
          category: 'system',
        })
        return
      }
      setActionError(
        t('settings.terminals.saveError', {
          error: err instanceof Error && err.message ? err.message : t('common.error'),
        }),
      )
    },
    [notify, t],
  )

  const draft = useSettingsDraft<TerminalSettingsDraft>({
    value,
    defaultValue,
    onSave: async (next) => {
      const patch: TerminalSettingsPatch = {}
      if (!isLocked('enabled')) patch.enabled = next.enabled
      if (!isLocked('autoRestore')) patch.autoRestore = next.autoRestore
      if (!isLocked('idleMinutes')) patch.idleMinutes = Number(next.idleMinutes)
      if (!isLocked('maxPerProject')) patch.maxPerProject = Number(next.maxPerProject)
      if (!isLocked('maxPerInstance')) patch.maxPerInstance = Number(next.maxPerInstance)
      // Пустая оболочка — платформенный дефолт (`null`).
      if (!isLocked('shell')) patch.shell = next.shell.trim() === '' ? null : next.shell.trim()
      if (!isLocked('auditInput')) patch.auditInput = next.auditInput

      let saved: TerminalSettings
      try {
        saved = await terminalSettingsApi.updateTerminalSettings(patch)
      } catch (err) {
        // `useSettingsDraft.save()` глотает исключение из `onSave` и возвращает
        // false — показываем ошибку здесь и пробрасываем, чтобы черновик не
        // считался сохранённым (и успешный тост не показался).
        reportSaveError(err)
        throw err
      }
      setInfo(saved)
      setConflictFields(null)
      return draftFromSettings(saved)
    },
  })

  /** Клиентская валидация границ: невалидно — Save недоступен, видно текст ошибки. */
  const errors = useMemo<TerminalSettingsErrors>(() => {
    const current = draft.draft
    if (!current) return {}
    const next: TerminalSettingsErrors = {}
    if (!isIntegerInRange(current.idleMinutes, TERMINAL_IDLE_MINUTES_RANGE)) {
      next.idleMinutes = t('settings.terminals.rangeError')
    }
    if (!isIntegerInRange(current.maxPerProject, TERMINAL_MAX_PER_PROJECT_RANGE)) {
      next.maxPerProject = t('settings.terminals.rangeError')
    }
    if (!isIntegerInRange(current.maxPerInstance, TERMINAL_MAX_PER_INSTANCE_RANGE)) {
      next.maxPerInstance = t('settings.terminals.rangeError')
    }
    if (!isValidShell(current.shell)) {
      next.shell = t('settings.terminals.shell.invalid')
    }
    return next
  }, [draft.draft, t])
  const hasErrors = Object.keys(errors).length > 0

  /** «= 2 дн.» рядом с полем простоя. */
  const idleDaysHint = useMemo(() => {
    const raw = draft.draft?.idleMinutes ?? ''
    if (!isIntegerInRange(raw, TERMINAL_IDLE_MINUTES_RANGE)) return undefined
    const days = Math.round((Number(raw) / 1440) * 100) / 100
    return t('settings.terminals.idle.days', { days: days.toLocaleString(locale) })
  }, [draft.draft, locale, t])

  const handleSave = useCallback(async () => {
    if (draft.saving || hasErrors) return
    setActionError(null)
    const ok = await draft.save()
    if (ok) {
      notify({ text: t('settings.terminals.saved'), type: 'success', category: 'system' })
    }
  }, [draft, hasErrors, notify, t])

  const handleReset = useCallback(async () => {
    if (draft.saving) return
    setActionError(null)
    try {
      const saved = await terminalSettingsApi.resetTerminalSettings()
      setInfo(saved)
      setConflictFields(null)
      notify({ text: t('settings.terminals.resetDone'), type: 'success', category: 'system' })
    } catch (err) {
      reportSaveError(err)
    }
  }, [draft.saving, notify, reportSaveError, t])

  const source: TerminalSettingsSource = info?.source ?? 'default'
  const canReset = source === 'runtime' && !allLocked
  const lockedLabels = TERMINAL_SETTINGS_FIELDS.filter((field) => lockedFields.has(field)).map(
    (field) => t(FIELD_LABEL_KEYS[field]),
  )

  return (
    <SettingsPanel
      title={t('settings.category.terminals')}
      description={t('settings.terminals.description')}
    >
      {loadError && (
        <div
          role="alert"
          data-testid="terminal-settings-load-error"
          className="flex flex-wrap items-start justify-between gap-2 rounded-lg bg-destructive/10 p-3 text-sm text-destructive min-w-0"
        >
          <span className="min-w-0 break-words">{loadError}</span>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <Icon name="refresh" className={cn('size-3.5', loading && 'animate-spin')} />
            {t('settings.terminals.retry')}
          </Button>
        </div>
      )}

      {loading && !info && (
        <div
          className="py-3 text-center text-xs text-muted-foreground"
          data-testid="terminal-settings-loading"
        >
          {t('common.loading')}
        </div>
      )}

      {info && (
        <>
          <div className="flex flex-wrap items-center gap-1.5 min-w-0" data-testid="terminal-settings-badges">
            <span
              data-testid="terminal-settings-source-badge"
              className={cn(BADGE, SOURCE_BADGE_CLASS[source])}
            >
              {t(`settings.terminals.source.${source}`)}
            </span>
            {lockedFields.size > 0 && (
              <span
                data-testid="terminal-settings-env-badge"
                className={cn(BADGE, 'bg-status-warning/15 text-status-warning')}
              >
                {t('settings.terminals.envBadge')}
              </span>
            )}
          </div>

          {lockedFields.size > 0 && (
            <div
              role="status"
              data-testid="terminal-settings-env-banner"
              className="flex items-start gap-2 rounded-lg bg-status-warning/10 p-3 text-xs text-status-warning min-w-0"
            >
              <Icon name="alert" className="mt-0.5 size-3.5 shrink-0" />
              <span className="min-w-0 break-words">
                {t('settings.terminals.envBanner')}{' '}
                {t('settings.terminals.envFields', { fields: lockedLabels.join(', ') })}
              </span>
            </div>
          )}

          <SettingsSection
            id="terminals-runtime"
            title={t('settings.terminals.runtime.title')}
            description={t('settings.terminals.runtime.description')}
          >
            <div data-testid="terminal-settings-enabled-toggle">
              <ToggleField
                label={t('settings.terminals.enabled.label')}
                description={t('settings.terminals.enabled.description')}
                enabled={draft.draft?.enabled ?? info.enabled}
                onToggle={() => {
                  if (isLocked('enabled')) return
                  draft.update({ enabled: !(draft.draft?.enabled ?? info.enabled) })
                }}
                disabled={isLocked('enabled') || draft.saving}
                ariaLabel={t('settings.terminals.enabled.label')}
              />
            </div>
            <div data-testid="terminal-settings-auto-restore-toggle">
              <ToggleField
                label={t('settings.terminals.autoRestore.label')}
                description={t('settings.terminals.autoRestore.description')}
                enabled={draft.draft?.autoRestore ?? info.autoRestore}
                onToggle={() => {
                  if (isLocked('autoRestore')) return
                  draft.update({ autoRestore: !(draft.draft?.autoRestore ?? info.autoRestore) })
                }}
                disabled={isLocked('autoRestore') || draft.saving}
                ariaLabel={t('settings.terminals.autoRestore.label')}
              />
            </div>

            <p className="text-xs text-muted-foreground min-w-0">
              {t('settings.terminals.defaults', {
                enabled: String(info.defaults.enabled),
                autoRestore: String(info.defaults.autoRestore),
              })}
            </p>
          </SettingsSection>

          <div data-testid="terminal-settings-limits">
            <SettingsSection
              id="terminals-limits"
              title={t('settings.terminals.limits.title')}
              description={t('settings.terminals.limits.description')}
            >
              <div data-testid="terminal-settings-idle-field" className="flex items-start gap-2 min-w-0">
                <div className="min-w-0 flex-1">
                  <NumberField
                    id="terminal-settings-idle"
                    label={t('settings.terminals.idle.label')}
                    description={t('settings.terminals.idle.description')}
                    value={draft.draft?.idleMinutes ?? ''}
                    onChange={(event) => draft.update({ idleMinutes: event.target.value })}
                    min={TERMINAL_IDLE_MINUTES_RANGE.min}
                    max={TERMINAL_IDLE_MINUTES_RANGE.max}
                    step={1}
                    disabled={isLocked('idleMinutes') || draft.saving}
                    error={errors.idleMinutes}
                    suffix={idleDaysHint}
                  />
                </div>
                {isLocked('idleMinutes') && (
                  <span
                    data-testid="terminal-settings-idle-env-badge"
                    className={cn(BADGE, 'mt-6 shrink-0 bg-status-warning/15 text-status-warning')}
                  >
                    {t('settings.terminals.envFieldBadge')}
                  </span>
                )}
              </div>

              <div
                data-testid="terminal-settings-max-per-project-field"
                className="flex items-start gap-2 min-w-0"
              >
                <div className="min-w-0 flex-1">
                  <NumberField
                    id="terminal-settings-max-per-project"
                    label={t('settings.terminals.maxPerProject.label')}
                    description={t('settings.terminals.maxPerProject.description')}
                    value={draft.draft?.maxPerProject ?? ''}
                    onChange={(event) => draft.update({ maxPerProject: event.target.value })}
                    min={TERMINAL_MAX_PER_PROJECT_RANGE.min}
                    max={TERMINAL_MAX_PER_PROJECT_RANGE.max}
                    step={1}
                    disabled={isLocked('maxPerProject') || draft.saving}
                    error={errors.maxPerProject}
                  />
                </div>
                {isLocked('maxPerProject') && (
                  <span
                    data-testid="terminal-settings-max-per-project-env-badge"
                    className={cn(BADGE, 'mt-6 shrink-0 bg-status-warning/15 text-status-warning')}
                  >
                    {t('settings.terminals.envFieldBadge')}
                  </span>
                )}
              </div>

              <div
                data-testid="terminal-settings-max-per-instance-field"
                className="flex items-start gap-2 min-w-0"
              >
                <div className="min-w-0 flex-1">
                  <NumberField
                    id="terminal-settings-max-per-instance"
                    label={t('settings.terminals.maxPerInstance.label')}
                    description={t('settings.terminals.maxPerInstance.description')}
                    value={draft.draft?.maxPerInstance ?? ''}
                    onChange={(event) => draft.update({ maxPerInstance: event.target.value })}
                    min={TERMINAL_MAX_PER_INSTANCE_RANGE.min}
                    max={TERMINAL_MAX_PER_INSTANCE_RANGE.max}
                    step={1}
                    disabled={isLocked('maxPerInstance') || draft.saving}
                    error={errors.maxPerInstance}
                  />
                </div>
                {isLocked('maxPerInstance') && (
                  <span
                    data-testid="terminal-settings-max-per-instance-env-badge"
                    className={cn(BADGE, 'mt-6 shrink-0 bg-status-warning/15 text-status-warning')}
                  >
                    {t('settings.terminals.envFieldBadge')}
                  </span>
                )}
              </div>

              <div data-testid="terminal-settings-shell-field" className="flex items-start gap-2 min-w-0">
                <div className="min-w-0 flex-1">
                  <TextField
                    id="terminal-settings-shell"
                    label={t('settings.terminals.shell.label')}
                    description={t('settings.terminals.shell.description')}
                    placeholder={t('settings.terminals.shell.placeholder')}
                    value={draft.draft?.shell ?? ''}
                    onChange={(event) => draft.update({ shell: event.target.value })}
                    disabled={isLocked('shell') || draft.saving}
                    error={errors.shell}
                    mono
                  />
                </div>
                {isLocked('shell') && (
                  <span
                    data-testid="terminal-settings-shell-env-badge"
                    className={cn(BADGE, 'mt-6 shrink-0 bg-status-warning/15 text-status-warning')}
                  >
                    {t('settings.terminals.envFieldBadge')}
                  </span>
                )}
              </div>

              <div data-testid="terminal-settings-audit-toggle" className="flex items-start gap-2 min-w-0">
                <div className="min-w-0 flex-1">
                  <ToggleField
                    label={t('settings.terminals.audit.label')}
                    description={t('settings.terminals.audit.description')}
                    enabled={draft.draft?.auditInput ?? info.auditInput}
                    onToggle={() => {
                      if (isLocked('auditInput')) return
                      draft.update({ auditInput: !(draft.draft?.auditInput ?? info.auditInput) })
                    }}
                    disabled={isLocked('auditInput') || draft.saving}
                    ariaLabel={t('settings.terminals.audit.label')}
                  />
                </div>
                {isLocked('auditInput') && (
                  <span
                    data-testid="terminal-settings-audit-env-badge"
                    className={cn(BADGE, 'mt-1 shrink-0 bg-status-warning/15 text-status-warning')}
                  >
                    {t('settings.terminals.envFieldBadge')}
                  </span>
                )}
              </div>

              <p className="text-xs text-muted-foreground min-w-0">
                {t('settings.terminals.limits.defaults', {
                  idleMinutes: String(info.defaults.idleMinutes),
                  maxPerProject: String(info.defaults.maxPerProject),
                  maxPerInstance: String(info.defaults.maxPerInstance),
                  shell: info.defaults.shell ?? '—',
                  auditInput: String(info.defaults.auditInput),
                })}
              </p>
            </SettingsSection>
          </div>

          {actionError && (
            <div
              role="alert"
              data-testid="terminal-settings-action-error"
              className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive min-w-0 break-words"
            >
              {actionError}
            </div>
          )}

          <SettingsActions
            onSave={() => void handleSave()}
            onReset={() => void handleReset()}
            saveDisabled={!draft.dirty || allLocked || hasErrors}
            resetDisabled={!canReset || draft.saving}
            saving={draft.saving}
            isDefault={draft.isDefault}
            resetLabel={t('settings.terminals.reset')}
          />
        </>
      )}
    </SettingsPanel>
  )
}

// TerminalAdminSettings: админ-раздел «Терминалы» (PROP-132).
//
// Runtime-настройки интерактивных терминалов: `GET/PUT/DELETE
// /api/v2/settings/terminal` (`terminal.enabled` + `terminal.autoRestore`).
//
// Приоритет: env `SYNTH_TERMINAL_ENABLED` > runtime (`settings.json`/PG) >
// config.yaml > default. При env-фиксации runtime из UI не перекрывается:
// сервер отвечает `409` — показываем «задано через ENV» и блокируем контролы.
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
  InfoField,
  InfoSection,
  SettingsActions,
  SettingsPanel,
  SettingsSection,
  ToggleField,
  useSettingsDraft,
} from '@/components/ui/settings'
import {
  terminalSettingsApi,
  type TerminalSettings,
  type TerminalSettingsSource,
} from '@/lib/api/terminalSettings'

const BADGE = 'rounded px-1.5 py-0.5 text-[0.625rem] font-medium'

const SOURCE_BADGE_CLASS: Record<TerminalSettingsSource, string> = {
  env: 'bg-status-warning/15 text-status-warning',
  runtime: 'bg-primary/15 text-primary',
  config: 'bg-muted text-muted-foreground',
  default: 'bg-muted text-muted-foreground',
}

/** Значения, которые админ меняет (черновик формы). */
interface TerminalSettingsDraft {
  enabled: boolean
  autoRestore: boolean
}

const statusOf = (err: unknown): number | undefined =>
  typeof (err as { status?: unknown })?.status === 'number'
    ? (err as { status: number }).status
    : undefined

export function TerminalAdminSettings() {
  const { t } = useI18n()
  const { notify } = useNotification()

  const [info, setInfo] = useState<TerminalSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [envConflict, setEnvConflict] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const next = await terminalSettingsApi.getTerminalSettings()
      setInfo(next)
      setEnvConflict(next.envLocked === true || next.source === 'env')
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

  const value = useMemo<TerminalSettingsDraft | null>(
    () => (info ? { enabled: info.enabled, autoRestore: info.autoRestore } : null),
    [info],
  )
  const defaultValue = useMemo<TerminalSettingsDraft | null>(
    () =>
      info
        ? { enabled: info.defaults.enabled, autoRestore: info.defaults.autoRestore }
        : null,
    [info],
  )

  const locked = envConflict || info?.envLocked === true || info?.source === 'env'

  /**
   * Единая обработка ошибки сохранения/сброса.
   * 409 — значение зафиксировано env: блокируем контролы и предупреждаем.
   */
  const reportSaveError = useCallback(
    (err: unknown) => {
      if (statusOf(err) === 409) {
        setEnvConflict(true)
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
      let saved: TerminalSettings
      try {
        saved = await terminalSettingsApi.updateTerminalSettings({
          enabled: next.enabled,
          autoRestore: next.autoRestore,
        })
      } catch (err) {
        // `useSettingsDraft.save()` глотает исключение из `onSave` и возвращает
        // false — показываем ошибку здесь и пробрасываем, чтобы черновик не
        // считался сохранённым (и успешный тост не показался).
        reportSaveError(err)
        throw err
      }
      setInfo(saved)
      setEnvConflict(saved.envLocked === true || saved.source === 'env')
      return { enabled: saved.enabled, autoRestore: saved.autoRestore }
    },
  })

  const handleSave = useCallback(async () => {
    if (locked || draft.saving) return
    setActionError(null)
    const ok = await draft.save()
    if (ok) {
      notify({ text: t('settings.terminals.saved'), type: 'success', category: 'system' })
    }
  }, [draft, locked, notify, t])

  const handleReset = useCallback(async () => {
    if (locked || draft.saving) return
    setActionError(null)
    try {
      const saved = await terminalSettingsApi.resetTerminalSettings()
      setInfo(saved)
      setEnvConflict(saved.envLocked === true || saved.source === 'env')
      notify({ text: t('settings.terminals.resetDone'), type: 'success', category: 'system' })
    } catch (err) {
      reportSaveError(err)
    }
  }, [draft.saving, locked, notify, reportSaveError, t])

  const source: TerminalSettingsSource = info?.source ?? 'default'
  const canReset = source === 'runtime' && !locked

  return (
    <SettingsPanel
      title={t('settings.category.terminals')}
      description={t('settings.terminals.description')}
    >
      <SettingsSection
        id="terminals-runtime"
        title={t('settings.terminals.runtime.title')}
        description={t('settings.terminals.runtime.description')}
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
              {locked && (
                <span
                  data-testid="terminal-settings-env-badge"
                  className={cn(BADGE, 'bg-status-warning/15 text-status-warning')}
                >
                  {t('settings.terminals.envBadge')}
                </span>
              )}
            </div>

            {locked && (
              <div
                role="status"
                data-testid="terminal-settings-env-banner"
                className="flex items-start gap-2 rounded-lg bg-status-warning/10 p-3 text-xs text-status-warning min-w-0"
              >
                <Icon name="alert" className="mt-0.5 size-3.5 shrink-0" />
                <span className="min-w-0 break-words">{t('settings.terminals.envBanner')}</span>
              </div>
            )}

            <div data-testid="terminal-settings-enabled-toggle">
              <ToggleField
                label={t('settings.terminals.enabled.label')}
                description={t('settings.terminals.enabled.description')}
                enabled={draft.draft?.enabled ?? info.enabled}
                onToggle={() => {
                  if (locked) return
                  draft.update({ enabled: !(draft.draft?.enabled ?? info.enabled) })
                }}
                disabled={locked || draft.saving}
                ariaLabel={t('settings.terminals.enabled.label')}
              />
            </div>
            <div data-testid="terminal-settings-auto-restore-toggle">
              <ToggleField
                label={t('settings.terminals.autoRestore.label')}
                description={t('settings.terminals.autoRestore.description')}
                enabled={draft.draft?.autoRestore ?? info.autoRestore}
                onToggle={() => {
                  if (locked) return
                  draft.update({ autoRestore: !(draft.draft?.autoRestore ?? info.autoRestore) })
                }}
                disabled={locked || draft.saving}
                ariaLabel={t('settings.terminals.autoRestore.label')}
              />
            </div>

            <p className="text-xs text-muted-foreground min-w-0">
              {t('settings.terminals.defaults', {
                enabled: String(info.defaults.enabled),
                autoRestore: String(info.defaults.autoRestore),
              })}
            </p>

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
              saveDisabled={!draft.dirty || locked || draft.saving}
              resetDisabled={!canReset || draft.saving}
              saving={draft.saving}
              isDefault={draft.isDefault}
              resetLabel={t('settings.terminals.reset')}
            />
          </>
        )}
      </SettingsSection>

      {/* Справка: как живут терминалы на инстансе. */}
      <SettingsSection
        id="terminals-reference"
        title={t('settings.terminals.reference.title')}
        description={t('settings.terminals.reference.description')}
      >
        <InfoSection title={t('settings.terminals.reference.title')}>
          <InfoField
            label={t('settings.terminals.reference.idle')}
            value={t('settings.terminals.reference.idleValue')}
          />
          <InfoField
            label={t('settings.terminals.reference.limits')}
            value={t('settings.terminals.reference.limitsValue')}
          />
          <InfoField
            label={t('settings.terminals.reference.audit')}
            value={t('settings.terminals.reference.auditValue')}
          />
          <InfoField
            label={t('settings.terminals.reference.shell')}
            value={t('settings.terminals.reference.shellValue')}
          />
        </InfoSection>
      </SettingsSection>
    </SettingsPanel>
  )
}

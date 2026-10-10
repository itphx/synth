import { useCallback, useEffect, useState } from 'react'

import { useI18n } from '@/lib/i18n'
import { useNotification } from '@/hooks/useNotification'
import { synthApi, type EventsSettings as EventsSettingsData } from '@/lib/api/synthApi'
import { SelectContent, SelectItem } from '../ui/select'
import {
  ListField,
  NumberField,
  SelectField,
  SettingsActions,
  SettingsPanel,
  SettingsSection,
  TextField,
  ToggleField,
  useSettingsDraft,
} from '../ui/settings'

const DEFAULT_MODES: Array<EventsSettingsData['defaultMode']> = ['bound', 'ephemeral']
const UNKNOWN_AGENT_POLICIES: Array<EventsSettingsData['unknownAgentTemplate']> = [
  'drop',
  'default-agent',
]

/**
 * AD-089 / AD-072: админ-секция «Параметры событий» — runtime-настройки обработки
 * внешних событий (`/settings/events`): мастер-выключатель, режим по умолчанию,
 * TTL ephemeral, retention журнала, белый список источников, политика неизвестного
 * агента и глобальный лимит запросов на API-ключ. Мутации — ADMIN (guard сервера).
 */
export function EventsSettings() {
  const { t } = useI18n()
  const { notify } = useNotification()

  const [remote, setRemote] = useState<EventsSettingsData | null>(null)
  const [defaults, setDefaults] = useState<EventsSettingsData | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const draft = useSettingsDraft<EventsSettingsData>({
    value: remote,
    defaultValue: defaults,
  })

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const res = await synthApi.getEventsSettings()
      setRemote(res.events)
      setDefaults(res.defaults)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : t('eventsConfig.loadError'))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    void load()
  }, [load])

  const handleSave = async () => {
    if (!draft.draft) return
    setSaving(true)
    try {
      const res = await synthApi.updateEventsSettings(draft.draft)
      setRemote(res.events)
      draft.setDraft(res.events)
      notify({ text: t('eventsConfig.saved'), type: 'success', category: 'system' })
    } catch (err) {
      notify({
        text: t('eventsConfig.saveError', {
          error: err instanceof Error ? err.message : t('common.error'),
        }),
        type: 'error',
        category: 'error',
      })
    } finally {
      setSaving(false)
    }
  }

  const handleReset = async () => {
    setSaving(true)
    try {
      const res = await synthApi.resetEventsSettings()
      setRemote(res.events)
      setDefaults(res.defaults)
      draft.setDraft(res.events)
      notify({ text: t('eventsConfig.saved'), type: 'success', category: 'system' })
    } catch (err) {
      notify({
        text: t('eventsConfig.saveError', {
          error: err instanceof Error ? err.message : t('common.error'),
        }),
        type: 'error',
        category: 'error',
      })
    } finally {
      setSaving(false)
    }
  }

  const draftMode = draft.draft ?? remote

  return (
    <SettingsPanel title={t('eventsConfig.title')} description={t('eventsConfig.description')}>
      <SettingsSection>
        {loadError && (
          <div role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
            {loadError}
          </div>
        )}

        {loading && !draftMode && (
          <div className="py-4 text-center text-sm text-muted-foreground">{t('common.loading')}</div>
        )}

        {draftMode && (
          <>
            <ToggleField
              label={t('eventsConfig.enabled')}
              tooltip={t('eventsConfig.enabledTooltip')}
              enabled={draftMode.enabled}
              onToggle={() => draft.update({ enabled: !draftMode.enabled })}
              ariaLabel={t('eventsConfig.enabled')}
            />

            <SelectField
              label={t('eventsConfig.defaultMode')}
              tooltip={t('eventsConfig.defaultModeTooltip')}
              value={draftMode.defaultMode}
              onValueChange={(value) =>
                draft.update({ defaultMode: value as EventsSettingsData['defaultMode'] })
              }
              ariaLabel={t('eventsConfig.defaultMode')}
              items={DEFAULT_MODES.map((mode) => ({
                value: mode,
                label: t(`events.mode.${mode}`),
              }))}
            >
              <SelectContent>
                {DEFAULT_MODES.map((mode) => (
                  <SelectItem key={mode} value={mode}>
                    {t(`events.mode.${mode}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </SelectField>

            <TextField
              label={t('eventsConfig.ephemeralTtl')}
              tooltip={t('eventsConfig.ephemeralTtlTooltip')}
              value={draftMode.ephemeralTtl}
              onChange={(e) => draft.update({ ephemeralTtl: e.target.value })}
              placeholder="24h"
              mono
              id="events-config-ephemeral-ttl"
              data-testid="events-config-ephemeral-ttl"
            />

            <NumberField
              label={t('eventsConfig.journalRetentionDays')}
              tooltip={t('eventsConfig.journalRetentionDaysTooltip')}
              min={0}
              step={1}
              value={String(draftMode.journalRetentionDays)}
              onChange={(e) =>
                draft.update({ journalRetentionDays: Number.parseInt(e.target.value, 10) || 0 })
              }
              id="events-config-journal-retention"
              data-testid="events-config-journal-retention"
            />

            <ListField
              label={t('eventsConfig.allowedSources')}
              tooltip={t('eventsConfig.allowedSourcesTooltip')}
              values={draftMode.allowedSources}
              onChange={(next) => draft.update({ allowedSources: next })}
              variant="chips"
              placeholder={t('eventsConfig.allowedSourcesPlaceholder')}
            />

            <SelectField
              label={t('eventsConfig.unknownAgentTemplate')}
              tooltip={t('eventsConfig.unknownAgentTemplateTooltip')}
              value={draftMode.unknownAgentTemplate}
              onValueChange={(value) =>
                draft.update({
                  unknownAgentTemplate: value as EventsSettingsData['unknownAgentTemplate'],
                })
              }
              ariaLabel={t('eventsConfig.unknownAgentTemplate')}
              items={UNKNOWN_AGENT_POLICIES.map((policy) => ({
                value: policy,
                label: t(`eventsConfig.unknownAgentTemplate.${policy}`),
              }))}
            >
              <SelectContent>
                {UNKNOWN_AGENT_POLICIES.map((policy) => (
                  <SelectItem key={policy} value={policy}>
                    {t(`eventsConfig.unknownAgentTemplate.${policy}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </SelectField>

            <NumberField
              label={t('eventsConfig.keyRateLimitPerMinute')}
              tooltip={t('eventsConfig.keyRateLimitPerMinuteTooltip')}
              min={0}
              step={1}
              value={String(draftMode.keyRateLimitPerMinute)}
              onChange={(e) =>
                draft.update({ keyRateLimitPerMinute: Number.parseInt(e.target.value, 10) || 0 })
              }
              id="events-config-key-rate"
              data-testid="events-config-key-rate"
            />

            <ToggleField
              label={t('eventsConfig.decisionRouting')}
              tooltip={t('eventsConfig.decisionRoutingTooltip')}
              enabled={draftMode.decisionRouting}
              onToggle={() => draft.update({ decisionRouting: !draftMode.decisionRouting })}
              ariaLabel={t('eventsConfig.decisionRouting')}
            />

            <SettingsActions
              onSave={() => void handleSave()}
              onCancel={() => draft.revert()}
              onReset={() => void handleReset()}
              saving={saving}
              saveDisabled={loading || !draft.dirty}
              cancelDisabled={!draft.dirty}
              resetDisabled={loading}
              isDefault={draft.isDefault}
              saveTestId="events-config-save"
              cancelTestId="events-config-cancel"
              resetTestId="events-config-reset"
            />
          </>
        )}
      </SettingsSection>
    </SettingsPanel>
  )
}

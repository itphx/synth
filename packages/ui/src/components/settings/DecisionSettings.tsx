import { useCallback, useEffect, useState } from 'react'

import { useI18n } from '@/lib/i18n'
import { useNotification } from '@/hooks/useNotification'
import { synthApi, type DecisionSettings as DecisionSettingsData } from '@/lib/api/synthApi'
import { SelectContent, SelectItem } from '../ui/select'
import {
  NumberField,
  SelectField,
  SettingsActions,
  SettingsPanel,
  SettingsSection,
  TextField,
  ToggleField,
  useSettingsDraft,
} from '../ui/settings'

const MODES: Array<DecisionSettingsData['mode']> = ['auto', 'local', 'remote']

/**
 * AD-084 / AD-072: админ-секция «Decision-модели» — runtime-настройки
 * decision-слоя (`/settings/decision`): мастер-выключатель, транспорт
 * (auto/local/remote), провайдер/модель, модель эскалации, таймаут, порог
 * уверенности и явный remote-endpoint. Мутации — ADMIN (guard сервера).
 */
export function DecisionSettings() {
  const { t } = useI18n()
  const { notify } = useNotification()

  const [remote, setRemote] = useState<DecisionSettingsData | null>(null)
  const [defaults, setDefaults] = useState<DecisionSettingsData | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const draft = useSettingsDraft<DecisionSettingsData>({
    value: remote,
    defaultValue: defaults,
  })

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const res = await synthApi.getDecisionSettings()
      setRemote(res.decision)
      setDefaults(res.defaults)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : t('decisionConfig.loadError'))
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
      const res = await synthApi.updateDecisionSettings(draft.draft)
      setRemote(res.decision)
      draft.setDraft(res.decision)
      notify({ text: t('decisionConfig.saved'), type: 'success', category: 'system' })
    } catch (err) {
      notify({
        text: t('decisionConfig.saveError', {
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
      const res = await synthApi.resetDecisionSettings()
      setRemote(res.decision)
      setDefaults(res.defaults)
      draft.setDraft(res.decision)
      notify({ text: t('decisionConfig.saved'), type: 'success', category: 'system' })
    } catch (err) {
      notify({
        text: t('decisionConfig.saveError', {
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
    <SettingsPanel title={t('decisionConfig.title')} description={t('decisionConfig.description')}>
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
              label={t('decisionConfig.enabled')}
              tooltip={t('decisionConfig.enabledTooltip')}
              enabled={draftMode.enabled}
              onToggle={() => draft.update({ enabled: !draftMode.enabled })}
              ariaLabel={t('decisionConfig.enabled')}
            />

            <SelectField
              label={t('decisionConfig.mode')}
              tooltip={t('decisionConfig.modeTooltip')}
              value={draftMode.mode}
              onValueChange={(value) =>
                draft.update({ mode: value as DecisionSettingsData['mode'] })
              }
              ariaLabel={t('decisionConfig.mode')}
              triggerTestId="decision-config-mode"
              items={MODES.map((mode) => ({
                value: mode,
                label: t(`decisionConfig.mode.${mode}`),
              }))}
            >
              <SelectContent>
                {MODES.map((mode) => (
                  <SelectItem key={mode} value={mode}>
                    {t(`decisionConfig.mode.${mode}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </SelectField>

            <TextField
              label={t('decisionConfig.provider')}
              tooltip={t('decisionConfig.providerTooltip')}
              value={draftMode.provider}
              onChange={(e) => draft.update({ provider: e.target.value })}
              placeholder="routerai-decision"
              mono
              id="decision-config-provider"
              data-testid="decision-config-provider"
            />

            <TextField
              label={t('decisionConfig.model')}
              tooltip={t('decisionConfig.modelTooltip')}
              value={draftMode.model}
              onChange={(e) => draft.update({ model: e.target.value })}
              placeholder="clef-flash"
              mono
              id="decision-config-model"
              data-testid="decision-config-model"
            />

            <TextField
              label={t('decisionConfig.escalationModel')}
              tooltip={t('decisionConfig.escalationModelTooltip')}
              value={draftMode.escalationModel}
              onChange={(e) => draft.update({ escalationModel: e.target.value })}
              placeholder={t('common.optional')}
              mono
              id="decision-config-escalation-model"
              data-testid="decision-config-escalation-model"
            />

            <NumberField
              label={t('decisionConfig.timeoutMs')}
              tooltip={t('decisionConfig.timeoutMsTooltip')}
              min={1}
              max={600000}
              step={500}
              suffix="ms"
              value={String(draftMode.timeoutMs)}
              onChange={(e) =>
                draft.update({ timeoutMs: Number.parseInt(e.target.value, 10) || 0 })
              }
              id="decision-config-timeout"
              data-testid="decision-config-timeout"
            />

            <NumberField
              label={t('decisionConfig.confidenceThreshold')}
              tooltip={t('decisionConfig.confidenceThresholdTooltip')}
              min={0}
              max={1}
              step={0.05}
              value={String(draftMode.confidenceThreshold)}
              onChange={(e) => {
                const parsed = Number.parseFloat(e.target.value)
                draft.update({ confidenceThreshold: Number.isFinite(parsed) ? parsed : 0 })
              }}
              id="decision-config-confidence"
              data-testid="decision-config-confidence"
            />

            <TextField
              label={t('decisionConfig.remoteEndpoint')}
              tooltip={t('decisionConfig.remoteEndpointTooltip')}
              value={draftMode.remoteEndpoint}
              onChange={(e) => draft.update({ remoteEndpoint: e.target.value })}
              placeholder="https://routerai.ru/api/v1"
              mono
              id="decision-config-remote-endpoint"
              data-testid="decision-config-remote-endpoint"
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
              saveTestId="decision-config-save"
              cancelTestId="decision-config-cancel"
              resetTestId="decision-config-reset"
            />
          </>
        )}
      </SettingsSection>
    </SettingsPanel>
  )
}

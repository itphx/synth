import { useCallback, useEffect, useState } from 'react'

import { useI18n } from '@/lib/i18n'
import { useNotification } from '@/hooks/useNotification'
import { useProvidersStore } from '@/stores/providersStore'
import { synthApi, type DecisionSettings as DecisionSettingsData } from '@/lib/api/synthApi'
import {
  ModelPairSelect,
  NumberField,
  SettingsActions,
  SettingsPanel,
  SettingsSection,
  ToggleField,
  useSettingsDraft,
} from '../ui/settings'

/** Типы провайдеров decision-протокола (AD-084): `decision` (RouterAI) / `systemone` (Ollama). */
const DECISION_PROVIDER_TYPES: readonly string[] = ['decision', 'systemone']

/**
 * AD-084 / AD-072: админ-секция «Decision-модели» — runtime-настройки
 * decision-слоя (`/settings/decision`): мастер-выключатель, провайдер
 * decision-протокола и модель (селект), порог уверенности. Мутации — ADMIN
 * (guard сервера).
 */
export function DecisionSettings() {
  const { t } = useI18n()
  const { notify } = useNotification()
  const providers = useProvidersStore((s) => s.providers)
  const models = useProvidersStore((s) => s.models)

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

  // Только провайдеры decision-протокола (AD-084); модели — по выбранному провайдеру.
  const decisionProviders = providers.filter(
    (p) => p.enabled && DECISION_PROVIDER_TYPES.includes(p.type),
  )
  const filteredModels = (provider: string) =>
    models.filter((m) => m.enabled && (!provider || m.provider === provider))

  const current = draft.draft ?? remote

  return (
    <SettingsPanel title={t('decisionConfig.title')} description={t('decisionConfig.description')}>
      <SettingsSection>
        {loadError && (
          <div role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
            {loadError}
          </div>
        )}

        {loading && !current && (
          <div className="py-4 text-center text-sm text-muted-foreground">{t('common.loading')}</div>
        )}

        {current && (
          <>
            <ToggleField
              label={t('decisionConfig.enabled')}
              tooltip={t('decisionConfig.enabledTooltip')}
              enabled={current.enabled}
              onToggle={() => draft.update({ enabled: !current.enabled })}
              ariaLabel={t('decisionConfig.enabled')}
            />

            <ModelPairSelect
              label={t('decisionConfig.providerModel')}
              provider={current.provider}
              model={current.model}
              providers={decisionProviders}
              models={filteredModels(current.provider)}
              providerLabel={t('common.provider')}
              modelLabel={t('common.model')}
              providerTooltip={t('decisionConfig.providerTooltip')}
              modelTooltip={t('decisionConfig.modelTooltip')}
              providerTestId="decision-config-provider"
              modelTestId="decision-config-model"
              onProviderChange={(value) => draft.update({ provider: value, model: '' })}
              onModelChange={(value) => draft.update({ model: value })}
            />

            <NumberField
              label={t('decisionConfig.confidenceThreshold')}
              tooltip={t('decisionConfig.confidenceThresholdTooltip')}
              min={0}
              max={1}
              step={0.05}
              value={String(current.confidenceThreshold)}
              onChange={(e) => {
                const parsed = Number.parseFloat(e.target.value)
                draft.update({ confidenceThreshold: Number.isFinite(parsed) ? parsed : 0 })
              }}
              id="decision-config-confidence"
              data-testid="decision-config-confidence"
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

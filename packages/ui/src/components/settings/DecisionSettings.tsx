import { useCallback, useEffect, useState } from 'react'

import { useI18n } from '@/lib/i18n'
import { useNotification } from '@/hooks/useNotification'
import { useProvidersStore } from '@/stores/providersStore'
import { Button } from '@/components/ui/button'
import { confirm } from '@/lib/confirm'
import {
  synthApi,
  type DecisionAttemptStatus,
  type DecisionMetrics,
  type DecisionSettings as DecisionSettingsData,
} from '@/lib/api/synthApi'
import {
  InfoField,
  ModelPairSelect,
  NumberField,
  SettingsActions,
  SettingsPanel,
  SettingsSection,
  ToggleField,
  useSettingsDraft,
} from '../ui/settings'

/** Типы провайдеров decision-протокола (ADR-084): `decision` (RouterAI) / `systemone` (Ollama). */
const DECISION_PROVIDER_TYPES: readonly string[] = ['decision', 'systemone']

/** Порядок вывода статусов попыток в секции статистики. */
const REJECTED_STATUS_ORDER: readonly DecisionAttemptStatus[] = [
  'ok',
  'low_confidence',
  'invalid',
  'no_answer',
  'no_provider',
  'error',
]

/** Карта статуса попытки → i18n-ключ подписи. */
const REJECTED_LABEL_KEY: Record<DecisionAttemptStatus, string> = {
  ok: 'decisionConfig.rejectedOk',
  low_confidence: 'decisionConfig.rejectedLowConfidence',
  invalid: 'decisionConfig.rejectedInvalid',
  no_answer: 'decisionConfig.rejectedNoAnswer',
  no_provider: 'decisionConfig.rejectedNoProvider',
  error: 'decisionConfig.rejectedError',
}

/**
 * ADR-084 / ADR-072: админ-секция «Decision-модели» — runtime-настройки
 * decision-слоя (`/settings/decision`): мастер-выключатель, основная пара
 * провайдер/модель decision-протокола, необязательная пара эскалации
 * (`escalationProvider`/`escalationModel`) и порог уверенности. Ниже —
 * read-only статистика decision-каскада (`GET/DELETE /settings/decision/metrics`),
 * не входящая в черновик Save/Reset. Мутации — ADMIN (guard сервера).
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

  // Read-only статистика decision-слоя — вне черновика `useSettingsDraft`.
  const [metrics, setMetrics] = useState<DecisionMetrics | null>(null)
  const [metricsLoading, setMetricsLoading] = useState(false)

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

  const loadMetrics = useCallback(async () => {
    setMetricsLoading(true)
    try {
      const res = await synthApi.getDecisionMetrics()
      setMetrics(res.metrics)
    } catch (err) {
      notify({
        text: t('decisionConfig.metricsLoadError', {
          error: err instanceof Error ? err.message : t('common.error'),
        }),
        type: 'error',
        category: 'error',
      })
    } finally {
      setMetricsLoading(false)
    }
  }, [t, notify])

  useEffect(() => {
    void loadMetrics()
  }, [loadMetrics])

  const handleResetMetrics = async () => {
    const ok = await confirm({
      title: t('decisionConfig.metricsReset'),
      message: t('decisionConfig.metricsResetConfirm'),
      confirmLabel: t('decisionConfig.metricsReset'),
      variant: 'warning',
      icon: 'refresh',
    })
    if (!ok) return
    setMetricsLoading(true)
    try {
      const res = await synthApi.resetDecisionMetrics()
      setMetrics(res.metrics)
      notify({ text: t('decisionConfig.metricsResetSuccess'), type: 'success', category: 'system' })
    } catch (err) {
      notify({
        text: t('decisionConfig.metricsResetError', {
          error: err instanceof Error ? err.message : t('common.error'),
        }),
        type: 'error',
        category: 'error',
      })
    } finally {
      setMetricsLoading(false)
    }
  }

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

  // Только провайдеры decision-протокола (ADR-084); модели — по выбранному провайдеру.
  const decisionProviders = providers.filter(
    (p) => p.enabled && DECISION_PROVIDER_TYPES.includes(p.type),
  )
  const filteredModels = (provider: string) =>
    models.filter((m) => m.enabled && (!provider || m.provider === provider))

  const current = draft.draft ?? remote

  return (
    <SettingsPanel title={t('decisionConfig.title')} description={t('decisionConfig.description')}>
      <SettingsSection id="decision-config">
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

            <ModelPairSelect
              label={t('decisionConfig.escalationLabel')}
              provider={current.escalationProvider}
              model={current.escalationModel}
              providers={decisionProviders}
              models={filteredModels(current.escalationProvider)}
              providerLabel={t('common.provider')}
              modelLabel={t('common.model')}
              providerTooltip={t('decisionConfig.escalationProviderTooltip')}
              modelTooltip={t('decisionConfig.escalationModelTooltip')}
              providerTestId="decision-config-escalation-provider"
              modelTestId="decision-config-escalation-model"
              onProviderChange={(value) =>
                draft.update({ escalationProvider: value, escalationModel: '' })
              }
              onModelChange={(value) => draft.update({ escalationModel: value })}
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

      {/* ADR-084: read-only статистика decision-слоя — вне черновика Save/Reset. */}
      <SettingsSection
        id="decision-metrics"
        title={t('decisionConfig.metrics')}
        description={t('decisionConfig.metricsDescription')}
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void loadMetrics()}
              disabled={metricsLoading}
              data-testid="decision-metrics-refresh"
            >
              {t('decisionConfig.metricsRefresh')}
            </Button>
            <Button
              variant="outline-muted"
              size="sm"
              onClick={() => void handleResetMetrics()}
              disabled={metricsLoading}
              data-testid="decision-metrics-reset"
            >
              {t('decisionConfig.metricsReset')}
            </Button>
          </div>
        }
      >
        {!metrics ? (
          <div className="py-2 text-sm text-muted-foreground">{t('decisionConfig.metricsEmpty')}</div>
        ) : (
          <>
            <div className="space-y-1.5" data-testid="decision-metrics-summary">
              <InfoField label={t('decisionConfig.metricCalls')} value={String(metrics.calls)} mono />
              <InfoField label={t('decisionConfig.metricHandled')} value={String(metrics.handled)} mono />
              <InfoField label={t('decisionConfig.metricFallback')} value={String(metrics.fallback)} mono />
              <InfoField label={t('decisionConfig.metricEscalated')} value={String(metrics.escalated)} mono />
              <InfoField
                label={t('decisionConfig.metricAttemptsPrimary')}
                value={String(metrics.attempts.primary)}
                mono
              />
              <InfoField
                label={t('decisionConfig.metricAttemptsEscalation')}
                value={String(metrics.attempts.escalation)}
                mono
              />
            </div>

            <div className="space-y-1.5" data-testid="decision-metrics-rejected">
              <div className="text-xs text-muted-foreground">{t('decisionConfig.metricRejected')}</div>
              {REJECTED_STATUS_ORDER.map((status) => (
                <InfoField
                  key={status}
                  label={t(REJECTED_LABEL_KEY[status])}
                  value={String(metrics.rejected[status] ?? 0)}
                  mono
                />
              ))}
            </div>

            {Object.keys(metrics.by_model).length > 0 && (
              <div data-testid="decision-metrics-by-model">
                <div className="mb-1 text-xs text-muted-foreground">
                  {t('decisionConfig.metricsByModel')}
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-muted-foreground">
                        <th className="py-1 pr-2 font-medium">{t('decisionConfig.metricModel')}</th>
                        <th className="py-1 pr-2 text-right font-medium">
                          {t('decisionConfig.metricCalls')}
                        </th>
                        <th className="py-1 pr-2 text-right font-medium">
                          {t('decisionConfig.metricHandled')}
                        </th>
                        <th className="py-1 pr-2 text-right font-medium">
                          {t('decisionConfig.metricLatencyAvg')}
                        </th>
                        <th className="py-1 text-right font-medium">
                          {t('decisionConfig.metricLatencyMax')}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(metrics.by_model).map(([model, entry]) => (
                        <tr key={model} className="border-t border-border/60">
                          <td className="py-1 pr-2 font-mono text-[0.6875rem] break-all">{model}</td>
                          <td className="py-1 pr-2 text-right font-mono">{entry.calls}</td>
                          <td className="py-1 pr-2 text-right font-mono">{entry.handled}</td>
                          <td className="py-1 pr-2 text-right font-mono">{entry.latency_ms_avg}</td>
                          <td className="py-1 text-right font-mono">{entry.latency_ms_max}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}
      </SettingsSection>
    </SettingsPanel>
  )
}

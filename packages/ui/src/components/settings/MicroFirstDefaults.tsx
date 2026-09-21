import { useState } from 'react'
import { useI18n } from '@/lib/i18n'
import { useProvidersStore } from '@/stores/providersStore'
import { SelectContent, SelectItem } from '@/components/ui/select'
import {
  DefaultsBadge,
  SelectField,
  SettingsActions,
  SettingsPanel,
  SettingsSection,
  SliderField,
  ToggleField,
  useSettingsDraft,
} from '../ui/settings'

const STORAGE_KEY = 'synth-microfirst-defaults'

interface MicroFirstDefaults {
  microFirst: boolean
  microConfidenceThreshold: number
  embeddingEnabled: boolean
  embedProvider: string
  embedModel: string
}

const DEFAULTS: MicroFirstDefaults = {
  microFirst: false,
  microConfidenceThreshold: 0.8,
  embeddingEnabled: false,
  embedProvider: 'ollama',
  embedModel: 'local.nomic-embed-text:latest',
}

function loadDefaults(): MicroFirstDefaults {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) {
      return { ...DEFAULTS, ...JSON.parse(stored) }
    }
  } catch {
    // ignore
  }
  return { ...DEFAULTS }
}

function saveDefaults(defaults: MicroFirstDefaults) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(defaults))
  } catch {
    // ignore
  }
}

export function MicroFirstDefaults() {
  const { t } = useI18n()
  const providers = useProvidersStore((s) => s.providers)
  const models = useProvidersStore((s) => s.models)

  const [stored, setStored] = useState<MicroFirstDefaults>(loadDefaults)

  const draft = useSettingsDraft<MicroFirstDefaults>({
    value: stored,
    defaultValue: DEFAULTS,
    onSave: async (next) => {
      saveDefaults(next)
      setStored(next)
      return next
    },
  })

  const settings = draft.draft ?? DEFAULTS

  const update = (patch: Partial<MicroFirstDefaults>) => {
    draft.update(patch)
  }

  const availableProviders = providers.filter((p) => p.enabled)
  const filteredModels = models.filter((m) => m.enabled && (!settings.embedProvider || m.provider === settings.embedProvider))

  const stateLabel = (enabled: boolean) => (enabled ? t('common.enabled') : t('common.disabled'))

  return (
    <SettingsPanel
      title={t('settings.microFirst.title')}
      description={t('settings.microFirst.description')}
    >
      <SettingsSection
        actions={draft.isDefault ? <DefaultsBadge /> : undefined}
      >
        <ToggleField
          label={t('settings.microFirst.enabled')}
          description={stateLabel(settings.microFirst)}
          enabled={settings.microFirst}
          onToggle={() => update({ microFirst: !settings.microFirst })}
        />
      </SettingsSection>

      <SettingsSection>
        <SliderField
          label={t('settings.microFirst.confidence')}
          min={0.5}
          max={1}
          step={0.05}
          value={settings.microConfidenceThreshold}
          onValueChange={(value) => update({ microConfidenceThreshold: value })}
          formatValue={(value) => value.toFixed(2)}
        />
      </SettingsSection>

      <SettingsSection>
        <ToggleField
          label={t('settings.microFirst.embedding')}
          description={stateLabel(settings.embeddingEnabled)}
          enabled={settings.embeddingEnabled}
          onToggle={() => update({ embeddingEnabled: !settings.embeddingEnabled })}
        />
        {settings.embeddingEnabled && (
          <div className="space-y-3 min-w-0">
            <SelectField
              value={settings.embedProvider}
              onValueChange={(value) => update({ embedProvider: value, embedModel: '' })}
              ariaLabel={t('settings.microFirst.provider')}
            >
              <SelectContent>
                <SelectItem value="">{t('settings.microFirst.provider')}</SelectItem>
                {availableProviders.map((p) => (
                  <SelectItem key={p.name} value={p.name}>{p.name}</SelectItem>
                ))}
              </SelectContent>
            </SelectField>
            <SelectField
              value={settings.embedModel}
              onValueChange={(value) => update({ embedModel: value })}
              ariaLabel={t('settings.microFirst.model')}
            >
              <SelectContent>
                <SelectItem value="">{t('settings.microFirst.model')}</SelectItem>
                {filteredModels.map((m) => (
                  <SelectItem key={m.name} value={m.name}>{m.name}</SelectItem>
                ))}
              </SelectContent>
            </SelectField>
          </div>
        )}
      </SettingsSection>

      <SettingsActions
        onSave={() => void draft.save()}
        onCancel={draft.revert}
        onReset={draft.resetToDefault}
        saving={draft.saving}
        saveDisabled={!draft.dirty}
        cancelDisabled={!draft.dirty}
        saveTestId="microfirst-save"
        cancelTestId="microfirst-cancel"
        resetTestId="microfirst-reset"
      />
    </SettingsPanel>
  )
}

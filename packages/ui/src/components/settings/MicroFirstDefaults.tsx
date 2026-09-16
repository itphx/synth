import { useState, useEffect } from 'react'
import { useI18n } from '@/lib/i18n'
import { useProvidersStore } from '@/stores/providersStore'
import { Toggle } from '../ui/Toggle'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { SettingsPage, SettingsCard } from './settings-layout'

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

  const [settings, setSettings] = useState<MicroFirstDefaults>(loadDefaults)

  useEffect(() => {
    saveDefaults(settings)
  }, [settings])

  const update = (patch: Partial<MicroFirstDefaults>) => {
    setSettings((s) => ({ ...s, ...patch }))
  }

  const availableProviders = providers.filter((p) => p.enabled)
  const filteredModels = models.filter((m) => m.enabled && (!settings.embedProvider || m.provider === settings.embedProvider))

  return (
    <SettingsPage
      title={t('settings.microFirst.title')}
      description={t('settings.microFirst.description')}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <SettingsCard title={t('settings.microFirst.enabled')}>
          <label className="flex items-center gap-3 cursor-pointer">
            <Toggle enabled={settings.microFirst} onToggle={() => update({ microFirst: !settings.microFirst })} />
            <span className="text-sm text-foreground">
              {settings.microFirst ? t('common.enabled') : t('common.disabled')}
            </span>
          </label>
        </SettingsCard>

        <SettingsCard title={t('settings.microFirst.confidence')}>
          <div className="flex items-center gap-3">
            <input
              type="range"
              min="0.5" max="1.0" step="0.05"
              value={settings.microConfidenceThreshold}
              onChange={(e) => update({ microConfidenceThreshold: parseFloat(e.target.value) })}
              className="ui-range w-full"
              style={{
                ['--ui-range-fill' as string]: `${Math.round(((settings.microConfidenceThreshold - 0.5) / (1.0 - 0.5)) * 100)}%`,
              }}
            />
            <span className="text-sm text-foreground font-mono tabular-nums min-w-[3ch]">
              {settings.microConfidenceThreshold.toFixed(2)}
            </span>
          </div>
        </SettingsCard>

        <SettingsCard title={t('settings.microFirst.embedding')}>
          <div className="flex items-center gap-2">
            <Toggle enabled={settings.embeddingEnabled} onToggle={() => update({ embeddingEnabled: !settings.embeddingEnabled })} />
            <span className="text-sm text-foreground">
              {settings.embeddingEnabled ? t('common.enabled') : t('common.disabled')}
            </span>
          </div>
          {settings.embeddingEnabled && (
            <div className="space-y-2">
              <Select
                value={settings.embedProvider}
                onValueChange={(value) => update({ embedProvider: value, embedModel: '' })}
              >
                <SelectTrigger className="w-full" aria-label={t('settings.microFirst.provider')}>
                  <SelectValue>{settings.embedProvider || t('settings.microFirst.provider')}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">{t('settings.microFirst.provider')}</SelectItem>
                  {availableProviders.map((p) => (
                    <SelectItem key={p.name} value={p.name}>{p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={settings.embedModel}
                onValueChange={(value) => update({ embedModel: value })}
              >
                <SelectTrigger className="w-full" aria-label={t('settings.microFirst.model')} disabled={!settings.embedProvider}>
                  <SelectValue>{settings.embedModel || t('settings.microFirst.model')}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">{t('settings.microFirst.model')}</SelectItem>
                  {filteredModels.map((m) => (
                    <SelectItem key={m.name} value={m.name}>{m.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </SettingsCard>
      </div>
    </SettingsPage>
  )
}

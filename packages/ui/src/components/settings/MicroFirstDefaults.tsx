import { useState, useEffect } from 'react'
import { useProvidersStore } from '@/stores/providersStore'
import { Toggle } from '../ui/Toggle'

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
    <div className="space-y-6 max-w-lg">
      <div>
        <h2 className="text-lg font-semibold mb-1">Micro-first (AD-035)</h2>
        <p className="text-sm text-muted-foreground">
          Дефолтные настройки микро-слоя для новых сессий. Микро-модель обрабатывает простые запросы без вызова LLM.
        </p>
      </div>

      <div className="space-y-4">
        {/* Micro-first вкл/выкл */}
        <label className="flex items-center gap-3 cursor-pointer">
          <Toggle enabled={settings.microFirst} onToggle={() => update({ microFirst: !settings.microFirst })} />
          <span className="text-sm text-foreground">
            {settings.microFirst ? 'Включено' : 'Выключено'}
          </span>
        </label>

        {/* Confidence threshold */}
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">Confidence Threshold</span>
          <div className="flex items-center gap-2">
            <input
              type="range"
              min="0.5" max="1.0" step="0.05"
              value={settings.microConfidenceThreshold}
              onChange={(e) => update({ microConfidenceThreshold: parseFloat(e.target.value) })}
              className="w-20 h-1 accent-primary"
            />
            <span className="text-sm text-foreground font-mono tabular-nums min-w-[3ch]">
              {settings.microConfidenceThreshold.toFixed(2)}
            </span>
          </div>
        </div>

        {/* Embedding */}
        <div className="space-y-3 pl-4 border-l-2 border-border/30 pt-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">Embedding</span>
            <Toggle enabled={settings.embeddingEnabled} onToggle={() => update({ embeddingEnabled: !settings.embeddingEnabled })} />
          </div>
          {settings.embeddingEnabled && (
            <div className="space-y-1">
              <span className="text-sm text-muted-foreground">Embedding модель</span>
              <div className="flex gap-2">
                <select
                  value={settings.embedProvider}
                  aria-label="Провайдер"
                  onChange={(e) => update({ embedProvider: e.target.value, embedModel: '' })}
                  className="flex-1 min-w-0 rounded-md bg-input border border-border px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                >
                  <option value="">Провайдер</option>
                  {availableProviders.map((p) => (
                    <option key={p.name} value={p.name}>{p.name}</option>
                  ))}
                </select>
                <select
                  value={settings.embedModel}
                  aria-label="Модель"
                  onChange={(e) => update({ embedModel: e.target.value })}
                  className="flex-1 min-w-0 rounded-md bg-input border border-border px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                  disabled={!settings.embedProvider}
                >
                  <option value="">Модель</option>
                  {filteredModels.map((m) => (
                    <option key={m.name} value={m.name}>{m.name}</option>
                  ))}
                </select>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
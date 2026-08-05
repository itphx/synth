import { useEffect, useState } from 'react'
import { useI18n } from '@/lib/i18n'
import { useNotification } from '@/hooks/useNotification'
import { synthApi, type LlmGatewaySettings } from '@/lib/api/synthApi'
import { Toggle } from '../ui/Toggle'

const DEFAULT_SETTINGS: LlmGatewaySettings = {
  enabled: false,
  inputMode: 'obfuscate',
  rateLimit: {
    userPerMinute: 60,
    providerPerMinute: 120,
  },
}

/** Секция «Шлюз безопасности» (AD-036): глобальный тумблер + режим Input Guard + rate limit. */
export function GatewaySettings() {
  const { t } = useI18n()
  const { notify } = useNotification()
  const [settings, setSettings] = useState<LlmGatewaySettings>(DEFAULT_SETTINGS)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    synthApi
      .getLlmGatewaySettings()
      .then((cfg) => {
        if (cancelled) return
        setSettings({
          enabled: cfg.enabled ?? DEFAULT_SETTINGS.enabled,
          inputMode: cfg.inputMode ?? DEFAULT_SETTINGS.inputMode,
          rateLimit: {
            userPerMinute: cfg.rateLimit?.userPerMinute ?? DEFAULT_SETTINGS.rateLimit.userPerMinute,
            providerPerMinute: cfg.rateLimit?.providerPerMinute ?? DEFAULT_SETTINGS.rateLimit.providerPerMinute,
          },
        })
      })
      .catch(() => {
        // Эндпоинт может быть не готов — оставляем дефолты
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const handleSave = async () => {
    setSaving(true)
    try {
      await synthApi.saveLlmGatewaySettings(settings)
      notify({ text: t('common.saved'), type: 'success', category: 'system' })
    } catch (e) {
      notify({
        text: `${t('common.saveError')}: ${e instanceof Error ? e.message : 'HTTP'}`,
        type: 'error',
        category: 'error',
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-6 max-w-lg">
      <div>
        <h2 className="text-lg font-semibold mb-1">Шлюз безопасности</h2>
        <p className="text-sm text-muted-foreground">
          Независимый слой защиты LLM-трафика: секреты (API-ключи, токены, email) обфусцируются до
          плейсхолдеров ⟦SYNTH_SECRET_N⟧ перед отправкой в модель и раскрываются только в точках
          потребления. Раскрытие значений в интерфейсе логируется в аудит.
        </p>
      </div>

      <div className="space-y-4">
        <label className="flex items-center gap-3 cursor-pointer">
          <Toggle
            enabled={settings.enabled}
            onToggle={() => setSettings((s) => ({ ...s, enabled: !s.enabled }))}
          />
          <span className="text-sm text-foreground">
            {settings.enabled ? t('common.enabled') : t('common.disabled')}
          </span>
        </label>

        <div className="flex flex-col gap-1">
          <label className="text-sm font-medium">Режим Input Guard</label>
          <select
            value={settings.inputMode}
            onChange={(e) =>
              setSettings((s) => ({ ...s, inputMode: e.target.value as LlmGatewaySettings['inputMode'] }))
            }
            className="w-full rounded-md bg-input border border-border px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          >
            <option value="obfuscate">obfuscate — заменить секрет на плейсхолдер</option>
            <option value="block">block — блокировать запрос</option>
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-sm font-medium">Rate limit</label>
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">Запросов на пользователя / мин</span>
            <input
              type="number"
              min={1}
              value={settings.rateLimit.userPerMinute}
              onChange={(e) =>
                setSettings((s) => ({
                  ...s,
                  rateLimit: { ...s.rateLimit, userPerMinute: Number(e.target.value) || 1 },
                }))
              }
              className="w-20 rounded-md bg-input border border-border px-2 py-0.5 text-xs text-foreground text-right focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">Запросов на провайдера / мин</span>
            <input
              type="number"
              min={1}
              value={settings.rateLimit.providerPerMinute}
              onChange={(e) =>
                setSettings((s) => ({
                  ...s,
                  rateLimit: { ...s.rateLimit, providerPerMinute: Number(e.target.value) || 1 },
                }))
              }
              className="w-20 rounded-md bg-input border border-border px-2 py-0.5 text-xs text-foreground text-right focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
        </div>

        <button
          onClick={handleSave}
          disabled={saving || loading}
          className="w-full rounded-lg bg-primary px-4 py-2 text-xs font-medium text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-50"
        >
          {saving ? t('sessionSettings.saving') : t('common.save')}
        </button>
      </div>
    </div>
  )
}

import { useEffect, useState } from 'react'
import { useI18n } from '@/lib/i18n'
import { useNotification } from '@/hooks/useNotification'
import { cn } from '@/lib/utils'
import { synthApi, type LlmGatewaySettings, type SecretPattern } from '@/lib/api/synthApi'
import { Toggle } from '../ui/Toggle'

const DEFAULT_SETTINGS: LlmGatewaySettings = {
  enabled: false,
  inputMode: 'obfuscate',
  logPayloads: false,
  rateLimit: {
    userPerMinute: 60,
    providerPerMinute: 120,
  },
}

/** Компилируется ли строка как regex (клиентская валидация перед сохранением). */
function isValidRegex(regex: string): boolean {
  try {
    new RegExp(regex)
    return true
  } catch {
    return false
  }
}

/** Секция «Шлюз безопасности»: глобальный тумблер + режим Input Guard + rate limit. */
export function GatewaySettings() {
  const { t } = useI18n()
  const { notify } = useNotification()
  const [settings, setSettings] = useState<LlmGatewaySettings>(DEFAULT_SETTINGS)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const [patterns, setPatterns] = useState<SecretPattern[]>([])
  const [isOverridden, setIsOverridden] = useState(false)
  const [patternsLoading, setPatternsLoading] = useState(true)
  const [patternsSaving, setPatternsSaving] = useState(false)
  const [patternsResetting, setPatternsResetting] = useState(false)
  const [patternsLoadError, setPatternsLoadError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    synthApi
      .getLlmGatewaySettings()
      .then((cfg) => {
        if (cancelled) return
        setSettings({
          enabled: cfg.enabled ?? DEFAULT_SETTINGS.enabled,
          inputMode: cfg.inputMode ?? DEFAULT_SETTINGS.inputMode,
          logPayloads: cfg.logPayloads ?? DEFAULT_SETTINGS.logPayloads,
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

  useEffect(() => {
    let cancelled = false
    synthApi
      .getGatewayPatterns()
      .then((data) => {
        if (cancelled) return
        setPatterns(data.patterns)
        setIsOverridden(data.isOverridden)
        setPatternsLoadError(null)
      })
      .catch((e) => {
        // Эндпоинт может быть не готов — показываем ошибку, список остаётся пустым
        if (cancelled) return
        setPatternsLoadError(e instanceof Error ? e.message : 'HTTP')
      })
      .finally(() => {
        if (!cancelled) setPatternsLoading(false)
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

  const updatePattern = (index: number, patch: Partial<SecretPattern>) => {
    setPatterns((prev) => prev.map((p, i) => (i === index ? { ...p, ...patch } : p)))
  }

  const removePattern = (index: number) => {
    setPatterns((prev) => prev.filter((_, i) => i !== index))
  }

  const handlePatternsSave = async () => {
    if (patterns.some((p) => !isValidRegex(p.regex))) {
      notify({ text: t('gateway.patterns.invalidRegex'), type: 'error', category: 'error' })
      return
    }
    setPatternsSaving(true)
    try {
      const res = await synthApi.saveGatewayPatterns(patterns)
      setPatterns(res.patterns)
      setIsOverridden(res.isOverridden)
      notify({ text: t('gateway.patterns.saved'), type: 'success', category: 'system' })
    } catch (e) {
      // 400 при невалидном regex — не закрываем, показываем ошибку сервера
      notify({
        text: `${t('common.saveError')}: ${e instanceof Error ? e.message : 'HTTP'}`,
        type: 'error',
        category: 'error',
      })
    } finally {
      setPatternsSaving(false)
    }
  }

  const handlePatternsReset = async () => {
    setPatternsResetting(true)
    try {
      await synthApi.resetGatewayPatterns()
      const data = await synthApi.getGatewayPatterns()
      setPatterns(data.patterns)
      setIsOverridden(data.isOverridden)
      notify({ text: t('common.saved'), type: 'success', category: 'system' })
    } catch (e) {
      notify({
        text: `${t('common.saveError')}: ${e instanceof Error ? e.message : 'HTTP'}`,
        type: 'error',
        category: 'error',
      })
    } finally {
      setPatternsResetting(false)
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

        <label className="flex items-center gap-3 cursor-pointer">
          <Toggle
            enabled={settings.logPayloads ?? false}
            onToggle={() => setSettings((s) => ({ ...s, logPayloads: !(s.logPayloads ?? false) }))}
          />
          <div className="flex flex-col gap-0.5">
            <span className="text-sm text-foreground">Логировать запросы и ответы LLM</span>
            <span className="text-xs text-muted-foreground">
              Пишутся в отдельный JSONL после обфускации, доступно в окне «Логи и аудит → LLM».
            </span>
          </div>
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

      {/* Паттерны обфускации */}
      <div className="flex flex-col gap-3 border-t border-border pt-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold">{t('gateway.patterns.title')}</h3>
            <p className="text-sm text-muted-foreground">{t('gateway.patterns.description')}</p>
          </div>
          {!isOverridden && (
            <span className="shrink-0 rounded-full bg-interactive-hover px-2 py-0.5 text-[11px] text-muted-foreground">
              {t('gateway.patterns.defaultBadge')}
            </span>
          )}
        </div>

        {patternsLoadError && (
          <div className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm">{patternsLoadError}</div>
        )}

        {patternsLoading && (
          <div className="text-center text-muted-foreground py-6 text-sm">{t('common.loading')}</div>
        )}

        {!patternsLoading && !patternsLoadError && patterns.length === 0 && (
          <div className="text-center text-muted-foreground py-6 text-sm">{t('gateway.patterns.empty')}</div>
        )}

        {!patternsLoading && patterns.length > 0 && (
          <div className="space-y-2">
            {patterns.map((p, idx) => {
              const regexInvalid = !isValidRegex(p.regex)
              return (
                <div key={idx} className="flex items-center gap-2">
                  <input
                    type="text"
                    value={p.type}
                    onChange={(e) => updatePattern(idx, { type: e.target.value })}
                    placeholder={t('common.type')}
                    className="w-28 shrink-0 rounded-md bg-input border border-border px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                  />
                  <input
                    type="text"
                    value={p.regex}
                    onChange={(e) => updatePattern(idx, { regex: e.target.value })}
                    placeholder="regex"
                    className={cn(
                      'flex-1 min-w-0 rounded-md bg-input border px-2 py-1 text-xs text-foreground font-mono focus:outline-none focus:ring-1 focus:ring-ring',
                      regexInvalid ? 'border-destructive' : 'border-border'
                    )}
                  />
                  {regexInvalid && (
                    <span className="shrink-0 text-[11px] text-destructive">{t('gateway.patterns.invalidRegex')}</span>
                  )}
                  <button
                    onClick={() => removePattern(idx)}
                    className="shrink-0 rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                  >
                    {t('gateway.patterns.remove')}
                  </button>
                </div>
              )
            })}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <button
            onClick={() => setPatterns((prev) => [...prev, { type: '', regex: '' }])}
            disabled={patternsLoading}
            className="rounded-lg border border-border px-3 py-1.5 text-xs hover:bg-interactive-hover transition-colors disabled:opacity-50"
          >
            {t('gateway.patterns.add')}
          </button>
          <button
            onClick={handlePatternsSave}
            disabled={patternsSaving || patternsLoading}
            className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {patternsSaving ? t('sessionSettings.saving') : t('gateway.patterns.save')}
          </button>
          <button
            onClick={handlePatternsReset}
            disabled={patternsResetting || patternsLoading}
            className="rounded-lg px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-interactive-hover transition-colors disabled:opacity-50"
          >
            {patternsResetting ? t('sessionSettings.saving') : t('gateway.patterns.reset')}
          </button>
        </div>
      </div>
    </div>
  )
}

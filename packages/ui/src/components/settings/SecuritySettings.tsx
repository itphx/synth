import { useEffect, useState } from 'react'
import { useI18n } from '@/lib/i18n'
import { useNotification } from '@/hooks/useNotification'
import { cn } from '@/lib/utils'
import {
  synthApi,
  type LlmGatewaySettings,
  type SecretPattern,
  type SecuritySettings as SecuritySettingsType,
  type ProtectedPathsPolicy,
} from '@/lib/api/synthApi'
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

const DEFAULT_SECURITY: SecuritySettingsType = {
  protectedPaths: {
    enabled: true,
  },
}

const EMPTY_POLICY: ProtectedPathsPolicy = {
  deniedPaths: [],
  deniedPrefixes: [],
  approvalPaths: [],
  deniedCommandPrefixes: [],
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

/** Редактор списка строк (добавление/удаление/правка). */
function StringListEditor({
  label,
  values,
  onChange,
  help,
  addLabel,
  removeLabel,
}: {
  label: string
  values: string[]
  onChange: (next: string[]) => void
  help?: string
  addLabel: string
  removeLabel: string
}) {
  const [draft, setDraft] = useState('')
  const add = () => {
    const trimmed = draft.trim()
    if (!trimmed) return
    if (values.includes(trimmed)) return
    onChange([...values, trimmed])
    setDraft('')
  }
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-sm font-medium">{label}</label>
      {help && <p className="text-xs text-muted-foreground">{help}</p>}
      {values.length > 0 && (
        <div className="space-y-1">
          {values.map((v, idx) => (
            <div key={idx} className="flex items-center gap-2">
              <input
                type="text"
                value={v}
                onChange={(e) => onChange(values.map((x, i) => (i === idx ? e.target.value : x)))}
                className="flex-1 min-w-0 rounded-md bg-input border border-border px-2 py-1 text-xs text-foreground font-mono focus:outline-none focus:ring-1 focus:ring-ring"
              />
              <button
                onClick={() => onChange(values.filter((_, i) => i !== idx))}
                className="shrink-0 rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
              >
                {removeLabel}
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              add()
            }
          }}
          placeholder="путь/значение"
          className="flex-1 min-w-0 rounded-md bg-input border border-border px-2 py-1 text-xs text-foreground font-mono focus:outline-none focus:ring-1 focus:ring-ring"
        />
        <button
          onClick={add}
          className="shrink-0 rounded-lg border border-border px-2 py-1 text-xs hover:bg-interactive-hover transition-colors"
        >
          {addLabel}
        </button>
      </div>
    </div>
  )
}

/** Секция «Безопасность»: шлюз безопасности (llmGateway) + защищённые пути. */
export function SecuritySettings() {
  const { t } = useI18n()
  const { notify } = useNotification()

  // --- Шлюз безопасности (llmGateway) ---
  const [settings, setSettings] = useState<LlmGatewaySettings>(DEFAULT_SETTINGS)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const [patterns, setPatterns] = useState<SecretPattern[]>([])
  const [isOverridden, setIsOverridden] = useState(false)
  const [patternsLoading, setPatternsLoading] = useState(true)
  const [patternsSaving, setPatternsSaving] = useState(false)
  const [patternsResetting, setPatternsResetting] = useState(false)
  const [patternsLoadError, setPatternsLoadError] = useState<string | null>(null)

  // --- Защищённые пути ---
  const [security, setSecurity] = useState<SecuritySettingsType>(DEFAULT_SECURITY)
  const [securityLoading, setSecurityLoading] = useState(true)
  const [securitySaving, setSecuritySaving] = useState(false)
  const [policy, setPolicy] = useState<ProtectedPathsPolicy>(EMPTY_POLICY)
  const [policyOverridden, setPolicyOverridden] = useState(false)
  const [policyLoading, setPolicyLoading] = useState(true)
  const [policySaving, setPolicySaving] = useState(false)
  const [policyResetting, setPolicyResetting] = useState(false)
  const [policyLoadError, setPolicyLoadError] = useState<string | null>(null)

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
      .catch(() => {})
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

  useEffect(() => {
    let cancelled = false
    synthApi
      .getSecuritySettings()
      .then((cfg) => {
        if (cancelled) return
        setSecurity({
          protectedPaths: {
            enabled: cfg.protectedPaths?.enabled ?? DEFAULT_SECURITY.protectedPaths.enabled,
          },
        })
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setSecurityLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    synthApi
      .getProtectedPaths()
      .then((data) => {
        if (cancelled) return
        setPolicy(data.policy)
        setPolicyOverridden(data.isOverridden)
        setPolicyLoadError(null)
      })
      .catch((e) => {
        if (cancelled) return
        setPolicyLoadError(e instanceof Error ? e.message : 'HTTP')
      })
      .finally(() => {
        if (!cancelled) setPolicyLoading(false)
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

  const handleSecuritySave = async () => {
    setSecuritySaving(true)
    try {
      await synthApi.saveSecuritySettings(security)
      notify({ text: t('common.saved'), type: 'success', category: 'system' })
    } catch (e) {
      notify({
        text: `${t('common.saveError')}: ${e instanceof Error ? e.message : 'HTTP'}`,
        type: 'error',
        category: 'error',
      })
    } finally {
      setSecuritySaving(false)
    }
  }

  const handlePolicySave = async () => {
    setPolicySaving(true)
    try {
      const saved = await synthApi.saveProtectedPaths(policy)
      setPolicy(saved)
      setPolicyOverridden(true)
      notify({ text: t('security.protectedPaths.saved'), type: 'success', category: 'system' })
    } catch (e) {
      notify({
        text: `${t('common.saveError')}: ${e instanceof Error ? e.message : 'HTTP'}`,
        type: 'error',
        category: 'error',
      })
    } finally {
      setPolicySaving(false)
    }
  }

  const handlePolicyReset = async () => {
    setPolicyResetting(true)
    try {
      await synthApi.resetProtectedPaths()
      const data = await synthApi.getProtectedPaths()
      setPolicy(data.policy)
      setPolicyOverridden(data.isOverridden)
      notify({ text: t('common.saved'), type: 'success', category: 'system' })
    } catch (e) {
      notify({
        text: `${t('common.saveError')}: ${e instanceof Error ? e.message : 'HTTP'}`,
        type: 'error',
        category: 'error',
      })
    } finally {
      setPolicyResetting(false)
    }
  }

  const updatePolicyList = (key: keyof ProtectedPathsPolicy, next: string[]) => {
    setPolicy((prev) => ({ ...prev, [key]: next }))
  }

  return (
    <div className="space-y-6 max-w-lg">
      {/* Подсекция «Шлюз безопасности» */}
      <div>
        <h2 className="text-lg font-semibold mb-1">{t('gateway.title')}</h2>
        <p className="text-sm text-muted-foreground">{t('gateway.description')}</p>
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
            <span className="text-sm text-foreground">{t('gateway.logPayloads')}</span>
            <span className="text-xs text-muted-foreground">{t('gateway.logPayloadsHelp')}</span>
          </div>
        </label>

        <div className="flex flex-col gap-1">
          <label className="text-sm font-medium">{t('gateway.inputMode')}</label>
          <select
            value={settings.inputMode}
            onChange={(e) =>
              setSettings((s) => ({ ...s, inputMode: e.target.value as LlmGatewaySettings['inputMode'] }))
            }
            className="w-full rounded-md bg-input border border-border px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          >
            <option value="obfuscate">{t('gateway.inputMode.obfuscate')}</option>
            <option value="block">{t('gateway.inputMode.block')}</option>
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-sm font-medium">{t('gateway.rateLimit')}</label>
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">{t('gateway.rateLimit.user')}</span>
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
            <span className="text-muted-foreground">{t('gateway.rateLimit.provider')}</span>
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

      {/* Паттерны обфускации (llmGateway) */}
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

      {/* Подсекция «Защищённые пути» */}
      <div className="flex flex-col gap-3 border-t border-border pt-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold mb-1">{t('security.protectedPaths.title')}</h2>
            <p className="text-sm text-muted-foreground">{t('security.protectedPaths.description')}</p>
          </div>
          {!policyOverridden && (
            <span className="shrink-0 rounded-full bg-interactive-hover px-2 py-0.5 text-[11px] text-muted-foreground">
              {t('security.protectedPaths.defaultBadge')}
            </span>
          )}
        </div>

        <label className="flex items-center gap-3 cursor-pointer">
          <Toggle
            enabled={security.protectedPaths.enabled}
            onToggle={() => setSecurity((s) => ({ ...s, protectedPaths: { enabled: !s.protectedPaths.enabled } }))}
          />
          <span className="text-sm text-foreground">
            {security.protectedPaths.enabled ? t('common.enabled') : t('common.disabled')}
          </span>
        </label>

        {policyLoadError && (
          <div className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm">{policyLoadError}</div>
        )}

        {policyLoading && (
          <div className="text-center text-muted-foreground py-6 text-sm">{t('common.loading')}</div>
        )}

        {!policyLoading && !policyLoadError && (
          <div className="flex flex-col gap-3">
            <StringListEditor
              label={t('security.protectedPaths.deniedPaths')}
              values={policy.deniedPaths}
              onChange={(v) => updatePolicyList('deniedPaths', v)}
              addLabel={t('security.protectedPaths.add')}
              removeLabel={t('security.protectedPaths.remove')}
            />
            <StringListEditor
              label={t('security.protectedPaths.deniedPrefixes')}
              values={policy.deniedPrefixes}
              onChange={(v) => updatePolicyList('deniedPrefixes', v)}
              addLabel={t('security.protectedPaths.add')}
              removeLabel={t('security.protectedPaths.remove')}
            />
            <StringListEditor
              label={t('security.protectedPaths.approvalPaths')}
              values={policy.approvalPaths}
              onChange={(v) => updatePolicyList('approvalPaths', v)}
              addLabel={t('security.protectedPaths.add')}
              removeLabel={t('security.protectedPaths.remove')}
            />
            <StringListEditor
              label={t('security.protectedPaths.deniedCommandPrefixes')}
              values={policy.deniedCommandPrefixes}
              onChange={(v) => updatePolicyList('deniedCommandPrefixes', v)}
              addLabel={t('security.protectedPaths.add')}
              removeLabel={t('security.protectedPaths.remove')}
            />
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <button
            onClick={handleSecuritySave}
            disabled={securitySaving || securityLoading}
            className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {securitySaving ? t('sessionSettings.saving') : t('common.save')}
          </button>
          <button
            onClick={handlePolicySave}
            disabled={policySaving || policyLoading}
            className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {policySaving ? t('sessionSettings.saving') : t('security.protectedPaths.save')}
          </button>
          <button
            onClick={handlePolicyReset}
            disabled={policyResetting || policyLoading}
            className="rounded-lg px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-interactive-hover transition-colors disabled:opacity-50"
          >
            {policyResetting ? t('sessionSettings.saving') : t('security.protectedPaths.reset')}
          </button>
        </div>

        {!policyOverridden && (
          <div className="text-xs text-muted-foreground">{t('security.protectedPaths.baseHint')}</div>
        )}
      </div>
    </div>
  )
}

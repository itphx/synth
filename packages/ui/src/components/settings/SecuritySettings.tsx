import { useEffect, useState } from 'react'
import { useI18n } from '@/lib/i18n'
import { useNotification } from '@/hooks/useNotification'
import { useStableItemKeys } from '@/hooks/useStableItemKeys'
import {
  synthApi,
  type LlmGatewaySettings,
  type SecretPattern,
  type SecuritySettings as SecuritySettingsType,
  type ProtectedPathsPolicy,
} from '@/lib/api/synthApi'
import { Button } from '../ui/button'
import { SelectContent, SelectItem } from '../ui/select'
import {
  DefaultsBadge,
  ListField,
  NumberField,
  SelectField,
  SettingsActions,
  SettingsField,
  SettingsItem,
  SettingsPanel,
  SettingsSection,
  TextField,
  ToggleField,
  useSettingsDraft,
} from '../ui/settings'

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

/** Приводит ответ API к полной форме `LlmGatewaySettings` (rateLimit и т.п.). */
function normalizeGatewaySettings(cfg: Partial<LlmGatewaySettings> | null | undefined): LlmGatewaySettings {
  return {
    enabled: cfg?.enabled ?? DEFAULT_SETTINGS.enabled,
    inputMode: cfg?.inputMode ?? DEFAULT_SETTINGS.inputMode,
    logPayloads: cfg?.logPayloads ?? DEFAULT_SETTINGS.logPayloads,
    rateLimit: {
      userPerMinute: cfg?.rateLimit?.userPerMinute ?? DEFAULT_SETTINGS.rateLimit.userPerMinute,
      providerPerMinute: cfg?.rateLimit?.providerPerMinute ?? DEFAULT_SETTINGS.rateLimit.providerPerMinute,
    },
  }
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

/**
 * AD-072: секция «Безопасность» на коллекции `components/ui/settings/`.
 *
 * Три независимых блока: шлюз безопасности (llmGateway), паттерны обфускации
 * (llmGateway/patterns) и защищённые пути (security + protected-paths).
 * Поведение, эндпоинты, `data-testid` и i18n-ключи сохранены при миграции.
 */
export function SecuritySettings() {
  const { t } = useI18n()
  const { notify } = useNotification()

  // --- Шлюз безопасности (llmGateway) ---
  const [settings, setSettings] = useState<LlmGatewaySettings>(DEFAULT_SETTINGS)
  // Серверный дефолт; до загрузки — встроенный fallback (шейп совпадает).
  const [gatewayDefaults, setGatewayDefaults] = useState<LlmGatewaySettings>(DEFAULT_SETTINGS)
  const [loading, setLoading] = useState(true)

  const gateway = useSettingsDraft<LlmGatewaySettings>({
    value: settings,
    defaultValue: gatewayDefaults,
    onSave: async (draftValue) => {
      try {
        const saved = await synthApi.saveLlmGatewaySettings(draftValue)
        notify({ text: t('common.saved'), type: 'success', category: 'system' })
        return normalizeGatewaySettings(saved)
      } catch (e) {
        notify({
          text: `${t('common.saveError')}: ${e instanceof Error ? e.message : 'HTTP'}`,
          type: 'error',
          category: 'error',
        })
        throw e
      }
    },
  })
  const gatewayDraft = gateway.draft ?? DEFAULT_SETTINGS

  const [patterns, setPatterns] = useState<SecretPattern[]>([])
  // Стабильные ключи строк паттернов (не индексы).
  const patternKeys = useStableItemKeys(patterns.length)
  const [isOverridden, setIsOverridden] = useState(false)
  const [patternsLoading, setPatternsLoading] = useState(true)
  const [patternsSaving, setPatternsSaving] = useState(false)
  const [patternsResetting, setPatternsResetting] = useState(false)
  const [patternsLoadError, setPatternsLoadError] = useState<string | null>(null)

  // --- Защищённые пути ---
  const [security, setSecurity] = useState<SecuritySettingsType>(DEFAULT_SECURITY)
  const [askTimeoutSec, setAskTimeoutSec] = useState<string>('')
  // Вкл/Выкл таймаута подтверждения (0 = выключен → запросы ждут ответа бесконечно)
  const [askTimeoutEnabled, setAskTimeoutEnabled] = useState(true)
  const [securityLoading, setSecurityLoading] = useState(true)
  const [securitySaving, setSecuritySaving] = useState(false)

  // --- Политика защищённых путей ---
  const [policy, setPolicy] = useState<ProtectedPathsPolicy>(EMPTY_POLICY)
  const [policyOverridden, setPolicyOverridden] = useState(false)
  const [policyLoading, setPolicyLoading] = useState(true)
  const [policySaving, setPolicySaving] = useState(false)
  const [policyResetting, setPolicyResetting] = useState(false)
  const [policyLoadError, setPolicyLoadError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    synthApi
      .getLlmGatewaySettingsInfo()
      .then(({ settings: cfg, defaults }) => {
        if (cancelled) return
        setSettings(normalizeGatewaySettings(cfg))
        setGatewayDefaults(normalizeGatewaySettings(defaults))
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
          askTimeoutMs: cfg.askTimeoutMs,
        })
        setAskTimeoutSec(cfg.askTimeoutMs !== undefined ? String(Math.round(cfg.askTimeoutMs / 1000)) : '')
        setAskTimeoutEnabled(cfg.askTimeoutMs !== 0)
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

  const handleGatewayReset = async () => {
    try {
      const cfg = normalizeGatewaySettings(await synthApi.resetLlmGatewaySettings())
      setSettings(cfg)
      gateway.setDraft(cfg)
      notify({ text: t('common.saved'), type: 'success', category: 'system' })
    } catch (e) {
      notify({
        text: `${t('common.saveError')}: ${e instanceof Error ? e.message : 'HTTP'}`,
        type: 'error',
        category: 'error',
      })
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

  const handleProtectedSave = async () => {
    const trimmed = askTimeoutSec.trim()
    // ВКЛ и пустое поле → undefined (глобальный дефолт 30 с). ВКЛ и значение → ms.
    // ВЫКЛ → 0 (без таймаута, ждём ответа бесконечно).
    let askTimeoutMs: number | undefined
    if (!askTimeoutEnabled) {
      askTimeoutMs = 0
    } else if (trimmed === '') {
      askTimeoutMs = undefined
    } else {
      askTimeoutMs = (Number(trimmed) || 0) * 1000
    }
    setSecuritySaving(true)
    setPolicySaving(true)
    try {
      await synthApi.saveSecuritySettings({ ...security, askTimeoutMs })
      const savedPolicy = await synthApi.saveProtectedPaths(policy)
      setPolicy(savedPolicy)
      setPolicyOverridden(true)
      notify({ text: t('common.saved'), type: 'success', category: 'system' })
    } catch (e) {
      notify({
        text: `${t('common.saveError')}: ${e instanceof Error ? e.message : 'HTTP'}`,
        type: 'error',
        category: 'error',
      })
    } finally {
      setSecuritySaving(false)
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
    <SettingsPanel title={t('gateway.title')} description={t('gateway.description')}>
      {/* Шлюз безопасности (llmGateway) */}
      <SettingsSection>
        <SettingsItem>
          <ToggleField
            label={gatewayDraft.enabled ? t('common.enabled') : t('common.disabled')}
            enabled={gatewayDraft.enabled}
            onToggle={() => gateway.update({ enabled: !gatewayDraft.enabled })}
          />
        </SettingsItem>

        <SettingsItem>
          <ToggleField
            label={t('gateway.logPayloads')}
            description={t('gateway.logPayloadsHelp')}
            enabled={gatewayDraft.logPayloads ?? false}
            onToggle={() => gateway.update({ logPayloads: !(gatewayDraft.logPayloads ?? false) })}
          />
        </SettingsItem>

        <SettingsItem>
          <SelectField
            label={t('gateway.inputMode')}
            value={gatewayDraft.inputMode}
            onValueChange={(value) =>
              gateway.update({ inputMode: value as LlmGatewaySettings['inputMode'] })
            }
            ariaLabel={t('gateway.inputMode')}
          >
            <SelectContent>
              <SelectItem value="obfuscate">{t('gateway.inputMode.obfuscate')}</SelectItem>
              <SelectItem value="block">{t('gateway.inputMode.block')}</SelectItem>
            </SelectContent>
          </SelectField>
        </SettingsItem>

        <SettingsItem className="space-y-3">
          <div className="text-sm font-medium text-foreground">{t('gateway.rateLimit')}</div>
          <NumberField
            label={t('gateway.rateLimit.user')}
            min={1}
            value={gatewayDraft.rateLimit.userPerMinute}
            onChange={(e) =>
              gateway.update({
                rateLimit: {
                  ...gatewayDraft.rateLimit,
                  userPerMinute: Number(e.target.value) || 1,
                },
              })
            }
          />
          <NumberField
            label={t('gateway.rateLimit.provider')}
            min={1}
            value={gatewayDraft.rateLimit.providerPerMinute}
            onChange={(e) =>
              gateway.update({
                rateLimit: {
                  ...gatewayDraft.rateLimit,
                  providerPerMinute: Number(e.target.value) || 1,
                },
              })
            }
          />
        </SettingsItem>

        <SettingsActions
          onSave={() => void gateway.save()}
          onCancel={() => gateway.revert()}
          onReset={handleGatewayReset}
          saving={gateway.saving}
          saveDisabled={loading || !gateway.dirty}
          cancelDisabled={!gateway.dirty}
          isDefault={gateway.isDefault}
          saveTestId="security-gateway-save"
          cancelTestId="security-gateway-cancel"
          resetTestId="security-gateway-reset"
        />
      </SettingsSection>

      {/* Паттерны обфускации (llmGateway) */}
      <SettingsSection actions={!isOverridden ? <DefaultsBadge /> : undefined}>
        <SettingsField
          label={t('gateway.patterns.title')}
          description={t('gateway.patterns.description')}
        >
          {patternsLoadError && (
            <div className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
              {patternsLoadError}
            </div>
          )}

          {patternsLoading && (
            <div className="text-center text-muted-foreground py-6 text-sm">{t('common.loading')}</div>
          )}

          {!patternsLoading && !patternsLoadError && patterns.length === 0 && (
            <div className="text-center text-muted-foreground py-6 text-sm">
              {t('gateway.patterns.empty')}
            </div>
          )}

          {!patternsLoading && patterns.length > 0 && (
            <div className="space-y-2 min-w-0">
              {patterns.map((p, idx) => {
                const regexInvalid = !isValidRegex(p.regex)
                return (
                  <div
                    key={patternKeys[idx]}
                    className="flex flex-wrap items-start gap-2 min-w-0 rounded-lg border border-border bg-surface-inset p-2"
                  >
                    <TextField
                      value={p.type}
                      onChange={(e) => updatePattern(idx, { type: e.target.value })}
                      placeholder={t('common.type')}
                      aria-label={t('common.type')}
                      containerClassName="w-full sm:w-28 shrink-0"
                    />
                    <TextField
                      value={p.regex}
                      onChange={(e) => updatePattern(idx, { regex: e.target.value })}
                      placeholder="regex"
                      mono
                      error={regexInvalid ? t('gateway.patterns.invalidRegex') : undefined}
                      containerClassName="flex-1 min-w-0"
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      className="shrink-0"
                      onClick={() => removePattern(idx)}
                    >
                      {t('gateway.patterns.remove')}
                    </Button>
                  </div>
                )
              })}
            </div>
          )}

          <Button
            variant="outline"
            className="shrink-0 self-start"
            onClick={() => setPatterns((prev) => [...prev, { type: '', regex: '' }])}
            disabled={patternsLoading}
          >
            {t('gateway.patterns.add')}
          </Button>
        </SettingsField>

        <SettingsActions
          onSave={handlePatternsSave}
          onReset={handlePatternsReset}
          saving={patternsSaving}
          saveDisabled={patternsLoading}
          resetDisabled={patternsResetting || patternsLoading}
          isDefault={!isOverridden}
          saveLabel={t('gateway.patterns.save')}
          resetLabel={t('gateway.patterns.reset')}
          saveTestId="security-patterns-save"
          resetTestId="security-patterns-reset"
        />
      </SettingsSection>

      {/* Защищённые пути */}
      <SettingsSection
        title={t('security.protectedPaths.title')}
        description={t('security.protectedPaths.description')}
        actions={!policyOverridden ? <DefaultsBadge /> : undefined}
      >
        <SettingsItem>
          <ToggleField
            label={security.protectedPaths.enabled ? t('common.enabled') : t('common.disabled')}
            enabled={security.protectedPaths.enabled}
            onToggle={() =>
              setSecurity((s) => ({ ...s, protectedPaths: { enabled: !s.protectedPaths.enabled } }))
            }
          />
        </SettingsItem>

        <SettingsItem className="space-y-3">
          <div className="text-sm font-medium text-foreground">{t('sessionSettings.askTimeout')}</div>

          <ToggleField
            label={askTimeoutEnabled ? t('sessionSettings.askTimeoutEnabled') : t('sessionSettings.askTimeoutDisabled')}
            enabled={askTimeoutEnabled}
            onToggle={() => setAskTimeoutEnabled(!askTimeoutEnabled)}
          />

          {askTimeoutEnabled && (
            <NumberField
              label={t('sessionSettings.askTimeoutSeconds')}
              min={0}
              value={askTimeoutSec}
              onChange={(e) => setAskTimeoutSec(e.target.value)}
              placeholder="30"
            />
          )}
        </SettingsItem>

        {policyLoadError && (
          <div className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm">{policyLoadError}</div>
        )}

        {policyLoading && (
          <div className="text-center text-muted-foreground py-6 text-sm">{t('common.loading')}</div>
        )}

        {!policyLoading && !policyLoadError && (
          <div className="flex flex-col gap-3 min-w-0">
            <ListField
              label={t('security.protectedPaths.deniedPaths')}
              values={policy.deniedPaths}
              onChange={(v) => updatePolicyList('deniedPaths', v)}
              placeholder={t('security.protectedPaths.placeholder')}
              addLabel={t('security.protectedPaths.add')}
              removeLabel={t('security.protectedPaths.remove')}
            />
            <ListField
              label={t('security.protectedPaths.deniedPrefixes')}
              values={policy.deniedPrefixes}
              onChange={(v) => updatePolicyList('deniedPrefixes', v)}
              placeholder={t('security.protectedPaths.placeholder')}
              addLabel={t('security.protectedPaths.add')}
              removeLabel={t('security.protectedPaths.remove')}
            />
            <ListField
              label={t('security.protectedPaths.approvalPaths')}
              values={policy.approvalPaths}
              onChange={(v) => updatePolicyList('approvalPaths', v)}
              placeholder={t('security.protectedPaths.placeholder')}
              addLabel={t('security.protectedPaths.add')}
              removeLabel={t('security.protectedPaths.remove')}
            />
            <ListField
              label={t('security.protectedPaths.deniedCommandPrefixes')}
              values={policy.deniedCommandPrefixes}
              onChange={(v) => updatePolicyList('deniedCommandPrefixes', v)}
              placeholder={t('security.protectedPaths.placeholder')}
              addLabel={t('security.protectedPaths.add')}
              removeLabel={t('security.protectedPaths.remove')}
            />
          </div>
        )}

        <SettingsActions
          onSave={handleProtectedSave}
          onReset={handlePolicyReset}
          saving={securitySaving || policySaving}
          saveDisabled={securityLoading || policyLoading}
          resetDisabled={policyResetting || policyLoading}
          isDefault={!policyOverridden}
          saveTestId="security-protected-save"
          resetTestId="security-protected-reset"
        />

        {!policyOverridden && (
          <div className="text-xs text-muted-foreground">{t('security.protectedPaths.baseHint')}</div>
        )}
      </SettingsSection>
    </SettingsPanel>
  )
}

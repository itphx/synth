import { useEffect, useMemo, useState } from 'react'
import { useI18n } from '@/lib/i18n'
import { useNotification } from '@/hooks/useNotification'
import { useStableItemKeys } from '@/hooks/useStableItemKeys'
import { confirm } from '@/lib/confirm'
import {
  synthApi,
  type LlmGatewaySettings,
  type SecretPattern,
  type SecuritySettings as SecuritySettingsType,
  type ProtectedPathsPolicy,
  type PromptInjectionField,
  type PromptInjectionMode,
  type PromptInjectionSettings,
  type PromptInjectionSource,
  type SecuritySettingsResponse,
} from '@/lib/api/synthApi'
import { Button } from '../ui/button'
import { Icon } from '../icon/Icon'
import {
  SECURITY_AUDIT_MODES,
  SECURITY_AUDIT_RETENTION_DAYS_RANGE,
  SECURITY_AUDIT_SETTINGS_FIELDS,
  type SecurityAuditMode,
  type SecurityAuditPermissionPatch,
  type SecurityAuditSettings,
  type SecurityAuditSettingsField,
} from '@/lib/api/securityAuditSettings'
import {
  PERMISSION_ACTIONS,
  PERMISSION_ASK_TIMEOUT_FALLBACK_MS,
  type PermissionAction,
  type PermissionRule,
  type PermissionRulesSource,
  type PermissionSettingsView,
} from '@/lib/api/permissionSettings'
import { TooltipProvider } from '../ui/tooltip'
import { RequestLimitsSettings } from './RequestLimitsSettings'
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

/** Черновик защиты от prompt injection (runtime-поля `enabled`/`mode`). */
interface PromptInjectionDraft {
  enabled: boolean
  mode: PromptInjectionMode
}

const DEFAULT_PROMPT_INJECTION: PromptInjectionDraft = {
  enabled: true,
  mode: 'flag',
}

const PROMPT_INJECTION_MODES: PromptInjectionMode[] = ['flag', 'sanitize', 'block']

/** Черновик «Аудит решений» (retention — строкой: пусто/мусор должен быть ошибкой). */
interface SecurityAuditDraft {
  mode: SecurityAuditMode
  retentionDays: string
}

const DEFAULT_SECURITY_AUDIT: SecurityAuditDraft = { mode: 'decisions', retentionDays: '30' }

/** Подписи полей секции — для баннера «зафиксировано через ENV». */
const AUDIT_FIELD_LABEL_KEYS: Record<SecurityAuditSettingsField, string> = {
  mode: 'securityaudit.mode',
  retentionDays: 'securityaudit.retentionDays',
}

const BADGE = 'shrink-0 rounded px-1.5 py-0.5 text-[0.625rem] font-medium'

const SOURCE_BADGE_CLASS: Record<PromptInjectionSource, string> = {
  env: 'bg-status-warning/15 text-status-warning',
  runtime: 'bg-primary/15 text-primary',
  config: 'bg-muted text-muted-foreground',
  default: 'bg-muted text-muted-foreground',
}

const statusOf = (err: unknown): number | undefined =>
  typeof (err as { status?: unknown })?.status === 'number'
    ? (err as { status: number }).status
    : undefined

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

/** Целое в границах retention (пусто/мусор/дробное — ошибка). */
function isValidRetentionDays(raw: string): boolean {
  const trimmed = raw.trim()
  if (!/^\d+$/.test(trimmed)) return false
  const value = Number(trimmed)
  return (
    value >= SECURITY_AUDIT_RETENTION_DAYS_RANGE.min &&
    value <= SECURITY_AUDIT_RETENTION_DAYS_RANGE.max
  )
}

/**
 * Поля, зафиксированные env, из ответа `409 ENV_LOCKED`.
 *
 * Конверт ошибок ядра — `{ error: { code, message, fields? } }`; `fetchJSON`
 * протаскивает `fields` наружу, поэтому ищем и там, и в `details`.
 */
function auditLockedFieldsFromError(err: unknown): SecurityAuditSettingsField[] {
  const raw = err as
    | {
        fields?: unknown
        details?: { fields?: unknown } | unknown
        error?: { fields?: unknown; details?: { fields?: unknown } | unknown }
      }
    | null
    | undefined
  const candidates: unknown[] = [
    raw?.fields,
    (raw?.details as { fields?: unknown } | undefined)?.fields,
    raw?.error?.fields,
    (raw?.error?.details as { fields?: unknown } | undefined)?.fields,
  ]
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue
    const fields = candidate.filter((field): field is SecurityAuditSettingsField =>
      (SECURITY_AUDIT_SETTINGS_FIELDS as readonly string[]).includes(field as string),
    )
    if (fields.length > 0) return fields
  }
  return []
}

// --- Правила подтверждений по умолчанию (settings/permissions) ---

/** Черновик правила: действие для ключа либо карта «паттерн → действие». */
interface PermissionRuleDraft {
  key: string
  /** Действие строкового правила (действует, пока паттернов нет). */
  action: PermissionAction
  /** Пары «паттерн → действие»; непустой список делает правило объектным. */
  patterns: Array<{ pattern: string; action: PermissionAction }>
}

/** Справка секции: источник карты, её база и таймаут подтверждения (только чтение). */
interface PermissionRulesMeta {
  source: PermissionRulesSource
  defaults: Record<string, PermissionRule>
  askTimeoutMs: number
}

const DEFAULT_PERMISSION_RULES_META: PermissionRulesMeta = {
  source: 'default',
  defaults: {},
  askTimeoutMs: PERMISSION_ASK_TIMEOUT_FALLBACK_MS,
}

/** Ошибка формы правил до отправки: i18n-ключ и параметры (не готовый текст). */
interface PermissionRulesFormError {
  key: string
  params?: Record<string, string>
}

/** Строки формы из карты правил (объектное правило раскрывается во вложенные пары). */
function ruleDraftsFrom(rules: Record<string, PermissionRule>): PermissionRuleDraft[] {
  return Object.entries(rules).map(([key, rule]) =>
    typeof rule === 'string'
      ? { key, action: rule, patterns: [] }
      : {
          key,
          // У объектного правила действие ключа не используется: если пользователь
          // снимет все паттерны, останется безопасный `ask`.
          action: 'ask',
          patterns: Object.entries(rule).map(([pattern, action]) => ({ pattern, action })),
        },
  )
}

/** Карта правил из строк формы: пары есть → объектная форма, иначе действие ключа. */
function rulesFromRuleDrafts(rows: PermissionRuleDraft[]): Record<string, PermissionRule> {
  const out: Record<string, PermissionRule> = {}
  for (const row of rows) {
    const key = row.key.trim()
    out[key] =
      row.patterns.length === 0
        ? row.action
        : Object.fromEntries(row.patterns.map((pair) => [pair.pattern.trim(), pair.action]))
  }
  return out
}

/** Сравнение карт правил без учёта порядка ключей (порядок строк формы незначим). */
function sameRules(
  a: Record<string, PermissionRule>,
  b: Record<string, PermissionRule>,
): boolean {
  const normalize = (rules: Record<string, PermissionRule>): string =>
    JSON.stringify(
      Object.keys(rules)
        .sort()
        .map((key) => {
          const rule = rules[key] as PermissionRule
          return typeof rule === 'string'
            ? [key, rule]
            : [key, Object.keys(rule).sort().map((pattern) => [pattern, rule[pattern]])]
        }),
    )
  return normalize(a) === normalize(b)
}

/**
 * Клиентская проверка формы: пустой ключ, дубликат ключа и пустой паттерн
 * блокируют сохранение (сервер ответил бы `400`, но лучше не отправлять).
 */
function validateRuleDrafts(rows: PermissionRuleDraft[]): PermissionRulesFormError | null {
  const seen = new Set<string>()
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index] as PermissionRuleDraft
    const key = row.key.trim()
    if (key === '') {
      return { key: 'permissionRules.error.emptyKey', params: { row: String(index + 1) } }
    }
    if (seen.has(key)) return { key: 'permissionRules.error.duplicateKey', params: { key } }
    seen.add(key)
    if (row.patterns.some((pair) => pair.pattern.trim() === '')) {
      return { key: 'permissionRules.error.emptyPattern', params: { key } }
    }
  }
  return null
}

/**
 * ADR-072: секция «Безопасность» на коллекции `components/ui/settings/`.
 *
 * Четыре независимых блока: шлюз безопасности (llmGateway), паттерны обфускации
 * (llmGateway/patterns), защищённые пути (security + protected-paths) и правила
 * подтверждений по умолчанию (settings/permissions).
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

  // --- Защита от prompt injection ---
  const [promptInjection, setPromptInjection] = useState<PromptInjectionDraft>(DEFAULT_PROMPT_INJECTION)
  const [savedPromptInjection, setSavedPromptInjection] =
    useState<PromptInjectionDraft>(DEFAULT_PROMPT_INJECTION)
  const [promptInjectionMeta, setPromptInjectionMeta] = useState<{
    source: PromptInjectionSource
    envLocked: boolean
    envLockedFields: PromptInjectionField[]
    wrapContent: boolean
  }>({ source: 'default', envLocked: false, envLockedFields: [], wrapContent: true })
  const [promptInjectionLoading, setPromptInjectionLoading] = useState(true)
  const [promptInjectionSaving, setPromptInjectionSaving] = useState(false)
  const [promptInjectionError, setPromptInjectionError] = useState<string | null>(null)

  // --- Политика защищённых путей ---
  const [policy, setPolicy] = useState<ProtectedPathsPolicy>(EMPTY_POLICY)
  const [policyOverridden, setPolicyOverridden] = useState(false)
  const [policyLoading, setPolicyLoading] = useState(true)
  const [policySaving, setPolicySaving] = useState(false)
  const [policyResetting, setPolicyResetting] = useState(false)
  const [policyLoadError, setPolicyLoadError] = useState<string | null>(null)

  // --- Аудит решений по правам (settings/audit) ---
  const [audit, setAudit] = useState<SecurityAuditDraft>(DEFAULT_SECURITY_AUDIT)
  const [savedAudit, setSavedAudit] = useState<SecurityAuditDraft>(DEFAULT_SECURITY_AUDIT)
  const [auditInfo, setAuditInfo] = useState<SecurityAuditSettings | null>(null)
  const [auditLoading, setAuditLoading] = useState(true)
  const [auditLoadFailed, setAuditLoadFailed] = useState(false)
  const [auditSaving, setAuditSaving] = useState(false)
  const [auditError, setAuditError] = useState<string | null>(null)
  /** Поля, зафиксированные env по ответу 409 (сервер не вернул список — все). */
  const [auditConflictFields, setAuditConflictFields] = useState<SecurityAuditSettingsField[] | null>(
    null,
  )

  // --- Правила подтверждений по умолчанию (settings/permissions) ---
  const [ruleRows, setRuleRows] = useState<PermissionRuleDraft[]>([])
  const [savedRules, setSavedRules] = useState<Record<string, PermissionRule>>({})
  const [rulesMeta, setRulesMeta] = useState<PermissionRulesMeta>(DEFAULT_PERMISSION_RULES_META)
  // Стабильные ключи строк (не индексы): удаление строки не переиспользует DOM соседа.
  const ruleRowKeys = useStableItemKeys(ruleRows.length)
  const [rulesLoading, setRulesLoading] = useState(true)
  const [rulesLoadFailed, setRulesLoadFailed] = useState(false)
  const [rulesSaving, setRulesSaving] = useState(false)
  const [rulesResetting, setRulesResetting] = useState(false)
  const [rulesError, setRulesError] = useState<string | null>(null)

  /** Применить снимок секции «Безопасность» (эффективные значения + источник). */
  const applyPromptInjection = (info: SecuritySettingsResponse) => {
    const pi = info.security.promptInjection
    const next: PromptInjectionDraft = { enabled: pi?.enabled ?? true, mode: pi?.mode ?? 'flag' }
    setPromptInjection(next)
    setSavedPromptInjection(next)
    setPromptInjectionMeta({
      source: info.source ?? 'default',
      envLocked: info.envLocked === true,
      envLockedFields: info.envLockedFields ?? [],
      wrapContent: pi?.wrapContent ?? true,
    })
    setPromptInjectionError(null)
  }

  /** Применить снимок секции «Аудит решений» (`GET/PUT/DELETE /settings/audit`). */
  const applyAuditSettings = (info: SecurityAuditSettings) => {
    const next: SecurityAuditDraft = {
      mode: info.permission.mode,
      retentionDays: String(info.permission.retentionDays),
    }
    setAudit(next)
    setSavedAudit(next)
    setAuditInfo(info)
    setAuditError(null)
  }

  /**
   * Применить снимок секции «Правила подтверждений» (`GET/PUT/DELETE /settings/permissions`).
   * `keepRows` — после `PUT`: строки остаются как в форме (не схлопываются раскрытые паттерны).
   */
  const applyPermissionRules = (
    view: PermissionSettingsView,
    options: { keepRows?: boolean } = {},
  ) => {
    if (!options.keepRows) setRuleRows(ruleDraftsFrom(view.rules))
    setSavedRules(view.rules)
    setRulesMeta({
      source: view.source,
      defaults: view.defaults.rules,
      askTimeoutMs: view.askTimeoutMs,
    })
    setRulesError(null)
  }

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
      .getSecuritySettingsInfo()
      .then((info) => {
        if (cancelled) return
        const cfg = info.security
        setSecurity({
          protectedPaths: {
            enabled: cfg.protectedPaths?.enabled ?? DEFAULT_SECURITY.protectedPaths.enabled,
          },
          askTimeoutMs: cfg.askTimeoutMs,
        })
        setAskTimeoutSec(cfg.askTimeoutMs !== undefined ? String(Math.round(cfg.askTimeoutMs / 1000)) : '')
        setAskTimeoutEnabled(cfg.askTimeoutMs !== 0)
        applyPromptInjection(info)
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) {
          setSecurityLoading(false)
          setPromptInjectionLoading(false)
        }
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

  useEffect(() => {
    let cancelled = false
    synthApi
      .getSecurityAuditSettings()
      .then((info) => {
        if (cancelled) return
        applyAuditSettings(info)
        setAuditLoadFailed(false)
      })
      .catch(() => {
        if (!cancelled) setAuditLoadFailed(true)
      })
      .finally(() => {
        if (!cancelled) setAuditLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    synthApi
      .getPermissionSettings()
      .then((view) => {
        if (cancelled) return
        applyPermissionRules(view)
        setRulesLoadFailed(false)
      })
      .catch(() => {
        if (!cancelled) setRulesLoadFailed(true)
      })
      .finally(() => {
        if (!cancelled) setRulesLoading(false)
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
    // ВКЛ и пустое поле → null (явный сброс runtime к глобальному дефолту 30 с).
    // ВКЛ и значение → ms. ВЫКЛ → 0 (без таймаута, ждём ответа бесконечно).
    let askTimeoutMs: number | null
    if (!askTimeoutEnabled) {
      askTimeoutMs = 0
    } else if (trimmed === '') {
      askTimeoutMs = null
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

  const promptInjectionEnabledLocked = promptInjectionMeta.envLockedFields.includes('enabled')
  const promptInjectionModeLocked = promptInjectionMeta.envLockedFields.includes('mode')
  const promptInjectionDirty =
    promptInjection.enabled !== savedPromptInjection.enabled ||
    promptInjection.mode !== savedPromptInjection.mode
  // Сброс доступен только когда есть runtime-override и ни одно поле не зафиксировано env.
  const promptInjectionCanReset = promptInjectionMeta.source === 'runtime' && !promptInjectionMeta.envLocked

  const handlePromptInjectionSave = async () => {
    const patch: PromptInjectionSettings = {}
    if (!promptInjectionEnabledLocked && promptInjection.enabled !== savedPromptInjection.enabled) {
      patch.enabled = promptInjection.enabled
    }
    if (!promptInjectionModeLocked && promptInjection.mode !== savedPromptInjection.mode) {
      patch.mode = promptInjection.mode
    }
    setPromptInjectionSaving(true)
    setPromptInjectionError(null)
    try {
      await synthApi.saveSecuritySettings({ promptInjection: patch })
      applyPromptInjection(await synthApi.getSecuritySettingsInfo())
      notify({ text: t('common.saved'), type: 'success', category: 'system' })
    } catch (e) {
      if (statusOf(e) === 409) {
        setPromptInjectionError(t('security.promptInjection.envLocked'))
      } else {
        setPromptInjectionError(
          `${t('security.promptInjection.saveError')}: ${e instanceof Error ? e.message : 'HTTP'}`,
        )
      }
    } finally {
      setPromptInjectionSaving(false)
    }
  }

  const handlePromptInjectionReset = async () => {
    setPromptInjectionSaving(true)
    setPromptInjectionError(null)
    try {
      applyPromptInjection(await synthApi.resetSecuritySettings())
      notify({ text: t('security.promptInjection.resetDone'), type: 'success', category: 'system' })
    } catch (e) {
      if (statusOf(e) === 409) {
        setPromptInjectionError(t('security.promptInjection.envLocked'))
      } else {
        setPromptInjectionError(
          `${t('security.promptInjection.resetError')}: ${e instanceof Error ? e.message : 'HTTP'}`,
        )
      }
    } finally {
      setPromptInjectionSaving(false)
    }
  }

  // --- Аудит решений: производные значения и действия ---
  /**
   * Поля, зафиксированные env: из снимка (`envLockedFields`) и из ответа 409.
   * Снимок без списка полей, но с `envLocked: true`, фиксирует всё (fail-closed).
   */
  const auditLockedFields = useMemo<Set<SecurityAuditSettingsField>>(() => {
    const locked = new Set<SecurityAuditSettingsField>()
    for (const field of auditInfo?.envLockedFields ?? []) locked.add(field)
    for (const field of auditConflictFields ?? []) locked.add(field)
    if (auditInfo?.envLocked === true && (auditInfo.envLockedFields?.length ?? 0) === 0) {
      for (const field of SECURITY_AUDIT_SETTINGS_FIELDS) locked.add(field)
    }
    return locked
  }, [auditConflictFields, auditInfo])

  const auditModeLocked = auditLockedFields.has('mode')
  const auditRetentionLocked = auditLockedFields.has('retentionDays')
  const auditAllLocked = auditLockedFields.size >= SECURITY_AUDIT_SETTINGS_FIELDS.length
  const auditSource = auditInfo?.source ?? 'default'
  const auditDirty =
    audit.mode !== savedAudit.mode || audit.retentionDays !== savedAudit.retentionDays
  const auditRetentionValid = isValidRetentionDays(audit.retentionDays)
  // Сброс доступен только когда есть runtime-override и ни одно поле не зафиксировано env.
  const auditCanReset = auditSource === 'runtime' && !auditAllLocked
  const auditLockedLabels = SECURITY_AUDIT_SETTINGS_FIELDS.filter((field) =>
    auditLockedFields.has(field),
  ).map((field) => t(AUDIT_FIELD_LABEL_KEYS[field]))

  const handleAuditSave = async () => {
    if (auditSaving || !auditRetentionValid) return
    // Уходят только поля, которые пользователь может менять: зафиксированные env
    // и так не редактируются, но `PUT` с ними словил бы `409`.
    const patch: SecurityAuditPermissionPatch = {}
    if (!auditModeLocked) patch.mode = audit.mode
    if (!auditRetentionLocked) patch.retentionDays = Number(audit.retentionDays.trim())
    if (Object.keys(patch).length === 0) return
    setAuditSaving(true)
    setAuditError(null)
    try {
      // Тело — вложенная форма контракта: `{ permission: { … } }`.
      applyAuditSettings(await synthApi.saveSecurityAuditSettings({ permission: patch }))
      setAuditConflictFields(null)
      notify({ text: t('securityaudit.saved'), type: 'success', category: 'system' })
    } catch (e) {
      if (statusOf(e) === 409) {
        const fields = auditLockedFieldsFromError(e)
        // Список полей сервер не отдал — фиксируем всё (fail-closed).
        setAuditConflictFields(fields.length > 0 ? fields : [...SECURITY_AUDIT_SETTINGS_FIELDS])
        setAuditError(t('securityaudit.envLocked'))
      } else {
        setAuditError(
          `${t('securityaudit.saveError')}: ${e instanceof Error ? e.message : 'HTTP'}`,
        )
      }
    } finally {
      setAuditSaving(false)
    }
  }

  const handleAuditReset = async () => {
    setAuditSaving(true)
    setAuditError(null)
    try {
      applyAuditSettings(await synthApi.resetSecurityAuditSettings())
      setAuditConflictFields(null)
      notify({ text: t('securityaudit.resetDone'), type: 'success', category: 'system' })
    } catch (e) {
      setAuditError(`${t('securityaudit.saveError')}: ${e instanceof Error ? e.message : 'HTTP'}`)
    } finally {
      setAuditSaving(false)
    }
  }

  // --- Правила подтверждений: производные значения и действия ---
  const ruleDrafts = useMemo(() => rulesFromRuleDrafts(ruleRows), [ruleRows])
  const rulesFormError = useMemo(() => validateRuleDrafts(ruleRows), [ruleRows])
  // Сравнение идёт по карте правил: раскрытие паттернов и порядок строк — не изменение.
  const rulesDirty = useMemo(() => !sameRules(ruleDrafts, savedRules), [ruleDrafts, savedRules])
  // Сброс доступен только при runtime-карте (env-слоя у правил нет).
  const rulesCanReset = rulesMeta.source === 'runtime'
  // Опции действия — общие для строки правила и строки паттерна.
  const permissionActionItems = PERMISSION_ACTIONS.map((action) => ({
    value: action,
    label: t(`permissionRules.action.${action}`),
  }))
  const permissionActionOptions = PERMISSION_ACTIONS.map((action) => (
    <SelectItem key={action} value={action}>
      {t(`permissionRules.action.${action}`)}
    </SelectItem>
  ))

  const updateRuleRow = (index: number, patch: Partial<PermissionRuleDraft>) => {
    setRuleRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  }

  const removeRuleRow = (index: number) => {
    setRuleRows((prev) => prev.filter((_, i) => i !== index))
  }

  const addRulePattern = (index: number) => {
    setRuleRows((prev) =>
      prev.map((row, i) =>
        i === index ? { ...row, patterns: [...row.patterns, { pattern: '', action: 'ask' }] } : row,
      ),
    )
  }

  const updateRulePattern = (
    rowIndex: number,
    patternIndex: number,
    patch: Partial<{ pattern: string; action: PermissionAction }>,
  ) => {
    setRuleRows((prev) =>
      prev.map((row, i) =>
        i === rowIndex
          ? {
              ...row,
              patterns: row.patterns.map((pair, j) =>
                j === patternIndex ? { ...pair, ...patch } : pair,
              ),
            }
          : row,
      ),
    )
  }

  const removeRulePattern = (rowIndex: number, patternIndex: number) => {
    setRuleRows((prev) =>
      prev.map((row, i) =>
        i === rowIndex
          ? { ...row, patterns: row.patterns.filter((_, j) => j !== patternIndex) }
          : row,
      ),
    )
  }

  const handleRulesSave = async () => {
    // Невалидную форму не отправляем: сервер ответил бы `400`.
    if (rulesSaving || rulesFormError) return
    setRulesSaving(true)
    setRulesError(null)
    try {
      // Тело — карта целиком (`PUT` заменяет правила, а не дополняет).
      applyPermissionRules(
        await synthApi.savePermissionSettings({ rules: ruleDrafts }),
        { keepRows: true },
      )
      notify({ text: t('permissionRules.saved'), type: 'success', category: 'system' })
    } catch (e) {
      setRulesError(
        `${t('permissionRules.saveError')}: ${e instanceof Error ? e.message : 'HTTP'}`,
      )
    } finally {
      setRulesSaving(false)
    }
  }

  const handleRulesReset = async () => {
    const ok = await confirm({
      title: t('permissionRules.resetConfirmTitle'),
      message: t('permissionRules.resetConfirm'),
      confirmLabel: t('permissionRules.reset'),
      variant: 'danger',
      icon: 'refresh',
    })
    if (!ok) return
    setRulesResetting(true)
    setRulesError(null)
    try {
      applyPermissionRules(await synthApi.resetPermissionSettings())
      notify({ text: t('permissionRules.resetDone'), type: 'success', category: 'system' })
    } catch (e) {
      setRulesError(
        `${t('permissionRules.saveError')}: ${e instanceof Error ? e.message : 'HTTP'}`,
      )
    } finally {
      setRulesResetting(false)
    }
  }

  return (
    <TooltipProvider>
    <SettingsPanel title={t('gateway.title')} description={t('gateway.description')}>
      {/* Шлюз безопасности (llmGateway) */}
      <SettingsSection
        id="security-gateway"
        tooltip={t('settings.help.security.section.security-gateway')}
      >
        <SettingsItem>
          <ToggleField
            label={gatewayDraft.enabled ? t('common.enabled') : t('common.disabled')}
            enabled={gatewayDraft.enabled}
            onToggle={() => gateway.update({ enabled: !gatewayDraft.enabled })}
            tooltip={t('settings.help.security.gatewayEnabled')}
          />
        </SettingsItem>

        {/* F4 (аудит S1): выключенный шлюз — прямой доступ к провайдеру. */}
        {gatewayDraft.enabled === false && (
          <div
            role="alert"
            data-testid="gateway-disabled-warning"
            className="flex items-start gap-2 rounded-lg border border-status-warning/30 bg-status-warning/10 p-3 text-sm text-status-warning"
          >
            <Icon name="error-warning" className="mt-0.5 size-4 shrink-0" />
            <span>{t('gateway.disabledWarning')}</span>
          </div>
        )}

        <SettingsItem>
          <ToggleField
            label={t('gateway.logPayloads')}
            description={t('gateway.logPayloadsHelp')}
            enabled={gatewayDraft.logPayloads ?? false}
            onToggle={() => gateway.update({ logPayloads: !(gatewayDraft.logPayloads ?? false) })}
            tooltip={t('settings.help.security.logPayloads')}
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
            tooltip={t('settings.help.security.inputMode')}
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
            inline
            min={1}
            value={gatewayDraft.rateLimit.userPerMinute}
            tooltip={t('settings.help.security.rateLimitUser')}
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
            inline
            min={1}
            value={gatewayDraft.rateLimit.providerPerMinute}
            tooltip={t('settings.help.security.rateLimitProvider')}
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
      <SettingsSection
        id="security-patterns"
        actions={!isOverridden ? <DefaultsBadge /> : undefined}
        advanced
      >
        <SettingsField
          label={t('gateway.patterns.title')}
          description={t('gateway.patterns.description')}
          tooltip={t('settings.help.security.patterns')}
        >
          {patternsLoadError && (
            <div className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
              {patternsLoadError}
            </div>
          )}

          {patternsLoading && (
            <div className="text-center text-muted-foreground py-6 text-sm">{t('common.loading')}</div>
          )}

          {!patternsLoading && !patternsLoadError && (
            <SettingsItem className="space-y-2">
              {patterns.length === 0 && (
                <div className="text-center text-muted-foreground py-6 text-sm">
                  {t('gateway.patterns.empty')}
                </div>
              )}

              {patterns.map((p, idx) => {
                const regexInvalid = !isValidRegex(p.regex)
                return (
                  <div key={patternKeys[idx]} className="flex flex-wrap items-start gap-2 min-w-0">
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

              <Button
                variant="outline"
                className="shrink-0 self-start"
                onClick={() => setPatterns((prev) => [...prev, { type: '', regex: '' }])}
                disabled={patternsLoading}
              >
                {t('gateway.patterns.add')}
              </Button>
            </SettingsItem>
          )}
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

      {/* Защита от prompt injection */}
      <SettingsSection
        id="security-prompt-injection"
        title={t('security.promptInjection.title')}
        description={t('security.promptInjection.description')}
        tooltip={t('settings.help.security.section.security-prompt-injection')}
        actions={
          <span
            className={`${BADGE} ${SOURCE_BADGE_CLASS[promptInjectionMeta.source]}`}
            data-testid="security-prompt-injection-source"
          >
            {t(`security.promptInjection.source.${promptInjectionMeta.source}`)}
          </span>
        }
      >
        {promptInjectionLoading && (
          <div className="text-center text-muted-foreground py-6 text-sm">{t('common.loading')}</div>
        )}

        {!promptInjectionLoading && (
          <>
            <SettingsItem>
              <ToggleField
                label={promptInjection.enabled ? t('common.enabled') : t('common.disabled')}
                enabled={promptInjection.enabled}
                disabled={promptInjectionEnabledLocked}
                onToggle={() =>
                  setPromptInjection((pi) => ({ ...pi, enabled: !pi.enabled }))
                }
                tooltip={t('settings.help.security.promptInjectionEnabled')}
              />
            </SettingsItem>

            <SettingsItem>
              <SelectField
                label={t('security.promptInjection.mode')}
                description={t(`security.promptInjection.modeHint.${promptInjection.mode}`)}
                value={promptInjection.mode}
                disabled={promptInjectionModeLocked}
                onValueChange={(value) =>
                  setPromptInjection((pi) => ({ ...pi, mode: value as PromptInjectionMode }))
                }
                ariaLabel={t('security.promptInjection.mode')}
                triggerTestId="security-prompt-injection-mode"
                tooltip={t('settings.help.security.promptInjectionMode')}
              >
                <SelectContent>
                  {PROMPT_INJECTION_MODES.map((mode) => (
                    <SelectItem key={mode} value={mode}>
                      {t(`security.promptInjection.mode.${mode}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </SelectField>
            </SettingsItem>

            <SettingsItem>
              <div className="text-xs text-muted-foreground">
                {t('security.promptInjection.wrapContent', {
                  state: promptInjectionMeta.wrapContent
                    ? t('common.enabled')
                    : t('common.disabled'),
                })}
              </div>
            </SettingsItem>

            {promptInjectionMeta.envLocked && (
              <div
                role="status"
                data-testid="security-prompt-injection-env-locked"
                className="rounded-lg border border-status-warning/30 bg-status-warning/10 p-3 text-sm text-status-warning"
              >
                {t('security.promptInjection.envLocked')}
              </div>
            )}

            {promptInjectionError && (
              <div className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
                {promptInjectionError}
              </div>
            )}

            <SettingsActions
              onSave={() => void handlePromptInjectionSave()}
              onReset={() => void handlePromptInjectionReset()}
              saving={promptInjectionSaving}
              saveDisabled={!promptInjectionDirty}
              resetDisabled={!promptInjectionCanReset}
              isDefault={!promptInjectionCanReset}
              saveLabel={t('common.save')}
              resetLabel={t('common.reset')}
              saveTestId="security-prompt-injection-save"
              resetTestId="security-prompt-injection-reset"
            />

            {promptInjectionMeta.source === 'default' && (
              <div className="text-xs text-muted-foreground">
                {t('security.promptInjection.baseHint')}
              </div>
            )}
          </>
        )}
      </SettingsSection>

      {/* Аудит решений по правам (settings/audit) */}
      <SettingsSection
        id="security-audit-decisions"
        title={t('securityaudit.title')}
        description={t('securityaudit.description')}
        tooltip={t('settings.help.security.section.security-audit-decisions')}
        actions={
          <span
            className={`${BADGE} ${SOURCE_BADGE_CLASS[auditSource]}`}
            data-testid="security-audit-source"
          >
            {t(`securityaudit.source.${auditSource}`)}
          </span>
        }
      >
        {auditLoading && (
          <div className="text-center text-muted-foreground py-6 text-sm">{t('common.loading')}</div>
        )}

        {!auditLoading && (
          <>
            {auditLoadFailed && (
              <div
                role="alert"
                data-testid="security-audit-load-error"
                className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm"
              >
                {t('securityaudit.loadError')}
              </div>
            )}

            <SettingsItem>
              <SelectField
                label={t('securityaudit.mode')}
                description={t(`securityaudit.modeHint.${audit.mode}`)}
                value={audit.mode}
                disabled={auditModeLocked}
                onValueChange={(value) =>
                  setAudit((prev) => ({ ...prev, mode: value as SecurityAuditMode }))
                }
                ariaLabel={t('securityaudit.mode')}
                triggerTestId="security-audit-mode"
                // `items` — чтобы триггер показывал локализованную подпись, а не значение.
                items={SECURITY_AUDIT_MODES.map((mode) => ({
                  value: mode,
                  label: t(`securityaudit.mode.${mode}`),
                }))}
                tooltip={t('settings.help.security.auditMode')}
              >
                <SelectContent>
                  {SECURITY_AUDIT_MODES.map((mode) => (
                    <SelectItem key={mode} value={mode}>
                      {t(`securityaudit.mode.${mode}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </SelectField>
            </SettingsItem>

            <SettingsItem>
              <NumberField
                id="security-audit-retention"
                data-testid="security-audit-retention"
                label={t('securityaudit.retentionDays')}
                description={t('securityaudit.retentionHint', {
                  min: SECURITY_AUDIT_RETENTION_DAYS_RANGE.min,
                  max: SECURITY_AUDIT_RETENTION_DAYS_RANGE.max,
                })}
                value={audit.retentionDays}
                min={SECURITY_AUDIT_RETENTION_DAYS_RANGE.min}
                max={SECURITY_AUDIT_RETENTION_DAYS_RANGE.max}
                step={1}
                disabled={auditRetentionLocked}
                onChange={(event) =>
                  setAudit((prev) => ({ ...prev, retentionDays: event.target.value }))
                }
                error={auditRetentionValid ? undefined : t('securityaudit.retentionRange')}
                tooltip={t('settings.help.security.auditRetentionDays')}
              />
            </SettingsItem>

            {/* Режим `all` пишет каждое автоматическое решение — журнал растёт быстрее. */}
            {audit.mode === 'all' && (
              <div
                role="status"
                data-testid="security-audit-all-mode-hint"
                className="rounded-lg border border-status-warning/30 bg-status-warning/10 p-3 text-xs text-status-warning"
              >
                {t('securityaudit.allModeHint')}
              </div>
            )}

            {auditLockedFields.size > 0 && (
              <div
                role="status"
                data-testid="security-audit-env-locked"
                className="rounded-lg border border-status-warning/30 bg-status-warning/10 p-3 text-sm text-status-warning"
              >
                {t('securityaudit.envLocked')}
                {auditLockedLabels.length > 0 &&
                  ` ${t('securityaudit.envFields', { fields: auditLockedLabels.join(', ') })}`}
              </div>
            )}

            {auditError && (
              <div
                role="alert"
                data-testid="security-audit-error"
                className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm"
              >
                {auditError}
              </div>
            )}

            <SettingsActions
              onSave={() => void handleAuditSave()}
              onReset={() => void handleAuditReset()}
              saving={auditSaving}
              saveDisabled={!auditDirty || auditAllLocked || !auditRetentionValid}
              resetDisabled={!auditCanReset}
              isDefault={!auditCanReset}
              saveTestId="security-audit-save"
              resetTestId="security-audit-reset"
              resetLabel={t('securityaudit.reset')}
            />

            <div className="text-xs text-muted-foreground" data-testid="security-audit-defaults">
              {t('securityaudit.defaults', {
                mode: t(`securityaudit.mode.${auditInfo?.defaults.mode ?? 'decisions'}`),
                retentionDays: auditInfo?.defaults.retentionDays ?? 30,
              })}
            </div>

            {auditSource === 'default' && (
              <div className="text-xs text-muted-foreground">{t('securityaudit.baseHint')}</div>
            )}
          </>
        )}
      </SettingsSection>

      {/* Правила подтверждений по умолчанию (settings/permissions) */}
      <SettingsSection
        id="security-permission-rules"
        title={t('permissionRules.title')}
        description={t('permissionRules.description')}
        tooltip={t('settings.help.security.section.security-permission-rules')}
        actions={
          <span
            className={`${BADGE} ${SOURCE_BADGE_CLASS[rulesMeta.source]}`}
            data-testid="security-permission-rules-source"
          >
            {t(`permissionRules.source.${rulesMeta.source}`)}
          </span>
        }
      >
        {rulesLoading && (
          <div className="text-center text-muted-foreground py-6 text-sm">{t('common.loading')}</div>
        )}

        {!rulesLoading && (
          <>
            {rulesLoadFailed && (
              <div
                role="alert"
                data-testid="security-permission-rules-load-error"
                className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm"
              >
                {t('permissionRules.loadError')}
              </div>
            )}

            <SettingsItem className="space-y-2">
              {ruleRows.length === 0 && (
                <div className="text-center text-muted-foreground py-6 text-sm">
                  {t('permissionRules.empty')}
                </div>
              )}

              {ruleRows.map((row, index) => (
                <div
                  key={ruleRowKeys[index]}
                  className="flex flex-col gap-2 min-w-0"
                  data-testid={`permission-rule-${index}`}
                >
                  <div className="flex flex-wrap items-start gap-2 min-w-0">
                    <TextField
                      value={row.key}
                      onChange={(e) => updateRuleRow(index, { key: e.target.value })}
                      placeholder={t('permissionRules.keyPlaceholder')}
                      aria-label={t('permissionRules.key')}
                      mono
                      containerClassName="flex-1 min-w-0"
                      data-testid={`permission-rule-key-${index}`}
                    />
                    {/* Действие ключа видно, только пока правило не задано паттернами. */}
                    {row.patterns.length === 0 && (
                      <SelectField
                        value={row.action}
                        onValueChange={(value) =>
                          updateRuleRow(index, { action: value as PermissionAction })
                        }
                        ariaLabel={t('permissionRules.action')}
                        triggerTestId={`permission-rule-action-${index}`}
                        items={permissionActionItems}
                        containerClassName="w-full sm:w-44 shrink-0"
                      >
                        <SelectContent>{permissionActionOptions}</SelectContent>
                      </SelectField>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      className="shrink-0"
                      onClick={() => addRulePattern(index)}
                      data-testid={`permission-rule-patterns-${index}`}
                    >
                      {t('permissionRules.patterns.add')}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="shrink-0"
                      onClick={() => removeRuleRow(index)}
                      data-testid={`permission-rule-remove-${index}`}
                    >
                      {t('permissionRules.remove')}
                    </Button>
                  </div>

                  {row.patterns.length > 0 && (
                    <div className="flex flex-col gap-1.5 min-w-0 pl-3">
                      <div className="text-xs text-muted-foreground min-w-0 break-words">
                        {t('permissionRules.patterns.hint')}
                      </div>
                      {row.patterns.map((pair, patternIndex) => (
                        <div
                          key={`${ruleRowKeys[index]}-${patternIndex}`}
                          className="flex flex-wrap items-center gap-2 min-w-0"
                        >
                          <TextField
                            value={pair.pattern}
                            onChange={(e) =>
                              updateRulePattern(index, patternIndex, { pattern: e.target.value })
                            }
                            placeholder={t('permissionRules.patterns.placeholder')}
                            aria-label={t('permissionRules.patterns.pattern')}
                            mono
                            containerClassName="flex-1 min-w-0"
                            data-testid={`permission-rule-pattern-${index}-${patternIndex}`}
                          />
                          <SelectField
                            value={pair.action}
                            onValueChange={(value) =>
                              updateRulePattern(index, patternIndex, {
                                action: value as PermissionAction,
                              })
                            }
                            ariaLabel={t('permissionRules.action')}
                            triggerTestId={`permission-rule-pattern-action-${index}-${patternIndex}`}
                            items={permissionActionItems}
                            containerClassName="w-full sm:w-44 shrink-0"
                          >
                            <SelectContent>{permissionActionOptions}</SelectContent>
                          </SelectField>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="shrink-0"
                            onClick={() => removeRulePattern(index, patternIndex)}
                            data-testid={`permission-rule-pattern-remove-${index}-${patternIndex}`}
                          >
                            {t('permissionRules.patterns.remove')}
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}

              <Button
                variant="outline"
                className="shrink-0 self-start"
                onClick={() =>
                  setRuleRows((prev) => [...prev, { key: '', action: 'ask', patterns: [] }])
                }
                data-testid="permission-rule-add"
              >
                {t('permissionRules.add')}
              </Button>
            </SettingsItem>

            {/* Клиентская валидация показывается до отправки и гасит Save. */}
            {rulesFormError && (
              <div
                role="alert"
                data-testid="security-permission-rules-validation"
                className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm"
              >
                {t(rulesFormError.key, rulesFormError.params)}
              </div>
            )}

            {rulesError && (
              <div
                role="alert"
                data-testid="security-permission-rules-error"
                className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm"
              >
                {rulesError}
              </div>
            )}

            <SettingsActions
              onSave={() => void handleRulesSave()}
              onReset={() => void handleRulesReset()}
              saving={rulesSaving}
              // `PUT` заменяет карту целиком: после неудачной загрузки сохранять
              // нельзя — иначе форма с пустой картой стёрла бы правила на сервере.
              saveDisabled={rulesLoadFailed || !rulesDirty || rulesFormError !== null}
              resetDisabled={rulesResetting || rulesLoadFailed || !rulesCanReset}
              isDefault={!rulesCanReset}
              saveLabel={t('permissionRules.save')}
              resetLabel={t('permissionRules.reset')}
              saveTestId="security-permission-rules-save"
              resetTestId="security-permission-rules-reset"
            />

            {/* Таймаут подтверждения редактируется в блоке «Защищённые пути» — здесь только справка. */}
            <div
              className="text-xs text-muted-foreground"
              data-testid="security-permission-rules-ask-timeout"
            >
              {rulesMeta.askTimeoutMs === 0
                ? t('permissionRules.askTimeoutDisabled')
                : t('permissionRules.askTimeout', {
                    seconds: Math.round(rulesMeta.askTimeoutMs / 1000),
                  })}
            </div>

            <div
              className="text-xs text-muted-foreground"
              data-testid="security-permission-rules-defaults"
            >
              {t('permissionRules.defaults', { count: Object.keys(rulesMeta.defaults).length })}
            </div>

            {rulesMeta.source === 'default' && (
              <div className="text-xs text-muted-foreground">{t('permissionRules.baseHint')}</div>
            )}
          </>
        )}
      </SettingsSection>

      {/* Защищённые пути */}
      <SettingsSection
        id="security-protected-paths"
        title={t('security.protectedPaths.title')}
        description={t('security.protectedPaths.description')}
        tooltip={t('settings.help.security.section.security-protected-paths')}
        actions={!policyOverridden ? <DefaultsBadge /> : undefined}
        advanced
      >
        <SettingsItem>
          <ToggleField
            label={security.protectedPaths.enabled ? t('common.enabled') : t('common.disabled')}
            enabled={security.protectedPaths.enabled}
            onToggle={() =>
              setSecurity((s) => ({ ...s, protectedPaths: { enabled: !s.protectedPaths.enabled } }))
            }
            tooltip={t('settings.help.security.protectedPathsEnabled')}
          />
        </SettingsItem>

        <SettingsItem className="space-y-3">
          <div className="text-sm font-medium text-foreground">{t('sessionSettings.askTimeout')}</div>

          <ToggleField
            label={askTimeoutEnabled ? t('sessionSettings.askTimeoutEnabled') : t('sessionSettings.askTimeoutDisabled')}
            enabled={askTimeoutEnabled}
            onToggle={() => setAskTimeoutEnabled(!askTimeoutEnabled)}
            tooltip={t('settings.help.security.askTimeoutEnabled')}
          />

          {askTimeoutEnabled && (
            <NumberField
              label={t('sessionSettings.askTimeoutSeconds')}
              min={0}
              value={askTimeoutSec}
              onChange={(e) => setAskTimeoutSec(e.target.value)}
              placeholder="30"
              tooltip={t('settings.help.security.askTimeoutSeconds')}
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
          <>
            <SettingsItem>
              <ListField
                label={t('security.protectedPaths.deniedPaths')}
                values={policy.deniedPaths}
                onChange={(v) => updatePolicyList('deniedPaths', v)}
                placeholder={t('security.protectedPaths.placeholder')}
                addLabel={t('security.protectedPaths.add')}
                removeLabel={t('security.protectedPaths.remove')}
                tooltip={t('settings.help.security.deniedPaths')}
              />
            </SettingsItem>
            <SettingsItem>
              <ListField
                label={t('security.protectedPaths.deniedPrefixes')}
                values={policy.deniedPrefixes}
                onChange={(v) => updatePolicyList('deniedPrefixes', v)}
                placeholder={t('security.protectedPaths.placeholder')}
                addLabel={t('security.protectedPaths.add')}
                removeLabel={t('security.protectedPaths.remove')}
                tooltip={t('settings.help.security.deniedPrefixes')}
              />
            </SettingsItem>
            <SettingsItem>
              <ListField
                label={t('security.protectedPaths.approvalPaths')}
                values={policy.approvalPaths}
                onChange={(v) => updatePolicyList('approvalPaths', v)}
                placeholder={t('security.protectedPaths.placeholder')}
                addLabel={t('security.protectedPaths.add')}
                removeLabel={t('security.protectedPaths.remove')}
                tooltip={t('settings.help.security.approvalPaths')}
              />
            </SettingsItem>
            <SettingsItem>
              <ListField
                label={t('security.protectedPaths.deniedCommandPrefixes')}
                values={policy.deniedCommandPrefixes}
                onChange={(v) => updatePolicyList('deniedCommandPrefixes', v)}
                placeholder={t('security.protectedPaths.placeholder')}
                addLabel={t('security.protectedPaths.add')}
                removeLabel={t('security.protectedPaths.remove')}
                tooltip={t('settings.help.security.deniedCommandPrefixes')}
              />
            </SettingsItem>
          </>
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

      {/* Лимиты тяжёлых операций с сессиями (импорт/экспорт/форк/merge) */}
      <RequestLimitsSettings />
    </SettingsPanel>
    </TooltipProvider>
  )
}

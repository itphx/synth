import { useState, useEffect, useMemo } from 'react'
import type { McpNetworkPolicy, McpRegistryEntry } from '@itphx/synth-shared'
import { Icon } from '../icon/Icon'
import { useMcpStore } from '../../stores/mcpStore'
import { useAuthStore } from '../../stores/authStore'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { Button } from '../ui/button'
import { ConfirmDialog } from '../ui/confirm-dialog'
import { Toggle } from '../ui/Toggle'
import { SelectContent, SelectItem } from '../ui/select'
import {
  ListField,
  SelectField,
  SettingsActions,
  SettingsPanel,
  SettingsRow,
  SettingsSection,
  TextArea,
  TextField,
  ToggleField,
  useSettingsDraft,
} from '../ui/settings'
import { PolicySettingsCard } from './PolicySettingsCard'
import { useNotification } from '@/hooks/useNotification'
import { synthApi } from '../../lib/api/synthApi'
import type {
  ToolsPolicy,
  McpServerConfig,
  McpServerToolsSettings,
  McpModeAvailability,
  McpProbedTool,
} from '../../lib/api/synthApi'

const EMPTY_CONFIG: McpServerConfig = { type: 'http' }
const DEFAULT_AVAILABILITY = { plan: false, act: true }

/** Сервер (и все его инструменты) на дефолтной доступности — отдельная запись не нужна. */
const isDefaultAvailabilityEntry = (entry: McpServerToolsSettings): boolean =>
  entry.default.plan === DEFAULT_AVAILABILITY.plan &&
  entry.default.act === DEFAULT_AVAILABILITY.act &&
  Object.values(entry.tools ?? {}).every(
    (t) => t.plan === DEFAULT_AVAILABILITY.plan && t.act === DEFAULT_AVAILABILITY.act,
  )

/**
 * Сравнение по эффективным значениям: записи, совпадающие с серверным дефолтом,
 * отбрасываются, поэтому `{ srv: default }` и `{}` считаются равными.
 */
const availabilityEquals = (
  a: Record<string, McpServerToolsSettings>,
  b: Record<string, McpServerToolsSettings>,
): boolean => {
  const normalize = (servers: Record<string, McpServerToolsSettings>) =>
    JSON.stringify(
      Object.entries(servers ?? {}).filter(([, entry]) => !isDefaultAvailabilityEntry(entry)),
    )
  return normalize(a) === normalize(b)
}

const ORIGIN_BADGE: Record<string, string> = {
  instance: 'bg-primary/15 text-primary',
  user: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
}

const TRUST_BADGE: Record<string, string> = {
  builtin: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  community: 'bg-muted text-muted-foreground',
}

export const McpSettings = () => {
  const { t } = useI18n()
  const { notify } = useNotification()
  const registry = useMcpStore(s => s.registry)
  const loading = useMcpStore(s => s.loading)
  const error = useMcpStore(s => s.error)
  const fetchRegistry = useMcpStore(s => s.fetchRegistry)
  const addRegistryEntry = useMcpStore(s => s.addRegistryEntry)
  const updateRegistryEntry = useMcpStore(s => s.updateRegistryEntry)
  const deleteRegistryEntry = useMcpStore(s => s.deleteRegistryEntry)
  const toolSettings = useMcpStore(s => s.toolSettings)
  const toolSettingsLoading = useMcpStore(s => s.toolSettingsLoading)
  const toolSettingsError = useMcpStore(s => s.toolSettingsError)
  const fetchToolSettings = useMcpStore(s => s.fetchToolSettings)
  const saveToolSettings = useMcpStore(s => s.saveToolSettings)
  const probeServer = useMcpStore(s => s.probeServer)
  const networkPolicy = useMcpStore(s => s.networkPolicy)
  const networkPolicyDefaults = useMcpStore(s => s.networkPolicyDefaults)
  const networkPolicyLoading = useMcpStore(s => s.networkPolicyLoading)
  const networkPolicyError = useMcpStore(s => s.networkPolicyError)
  const fetchNetworkPolicy = useMcpStore(s => s.fetchNetworkPolicy)
  const saveNetworkPolicy = useMcpStore(s => s.saveNetworkPolicy)
  const userId = useAuthStore((s) => s.user?.id)
  const roles = useAuthStore((s) => s.user?.roles ?? [])
  const isAdmin = roles.includes('ADMIN')

  const [editing, setEditing] = useState<string | null>(null)
  const [formName, setFormName] = useState('')
  const [formConfig, setFormConfig] = useState<McpServerConfig>(EMPTY_CONFIG)
  const [formDefault, setFormDefault] = useState(false)
  const [testResult, setTestResult] = useState<string | null>(null)
  const [testSucceeded, setTestSucceeded] = useState<boolean | null>(null)
  const [testing, setTesting] = useState(false)
  const [savingForm, setSavingForm] = useState(false)

  // AD-071 §2.3: глобальная политика MCP-инструментов (mcp.policy).
  const [mcpPolicy, setMcpPolicy] = useState<ToolsPolicy>('auto')
  const [savedMcpPolicy, setSavedMcpPolicy] = useState<ToolsPolicy>('auto')
  const [mcpPolicyDefault, setMcpPolicyDefault] = useState<ToolsPolicy>('auto')
  const [mcpPolicyLoading, setMcpPolicyLoading] = useState(true)
  const [mcpPolicySaving, setMcpPolicySaving] = useState(false)
  const [mcpPolicyError, setMcpPolicyError] = useState<string | null>(null)

  // Delete confirmation state
  const [deleteTarget, setDeleteTarget] = useState<McpRegistryEntry | null>(null)

  // Доступность инструментов по режимам (W4c)
  const [probedTools, setProbedTools] = useState<Record<string, McpProbedTool[] | null>>({})
  const [probing, setProbing] = useState<Record<string, boolean>>({})
  const [probeError, setProbeError] = useState<Record<string, string | null>>({})

  // AD-072: единый контракт черновика поверх toolSettings стора.
  // Дефолт доступности — серверный `{ plan: false, act: true }` на каждый сервер.
  const availabilityDefault = useMemo<Record<string, McpServerToolsSettings>>(
    () =>
      Object.fromEntries(
        Object.keys(toolSettings ?? {}).map((name) => [
          name,
          { default: { ...DEFAULT_AVAILABILITY }, tools: {} },
        ]),
      ),
    [toolSettings],
  )

  const availabilityDraft = useSettingsDraft<Record<string, McpServerToolsSettings>>({
    value: toolSettings,
    defaultValue: availabilityDefault,
    equals: availabilityEquals,
    onSave: async (next) => {
      useMcpStore.setState({ toolSettings: next })
      await saveToolSettings()
      return useMcpStore.getState().toolSettings ?? next
    },
  })

  useEffect(() => {
    fetchRegistry()
    fetchToolSettings()
  }, [fetchRegistry, fetchToolSettings])

  // AD-071 §2.3: политику MCP читает любой пользователь (эндпоинт без admin-гейта),
  // меняет только ADMIN — карточка доступна в админ-категории.
  useEffect(() => {
    let cancelled = false
    synthApi
      .getMcpPolicyInfo()
      .then(({ policy, defaults }) => {
        if (!cancelled) {
          setMcpPolicy(policy)
          setSavedMcpPolicy(policy)
          setMcpPolicyDefault(defaults)
        }
      })
      .catch((e) => {
        if (!cancelled) setMcpPolicyError(e instanceof Error ? e.message : 'HTTP')
      })
      .finally(() => {
        if (!cancelled) setMcpPolicyLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // AD-071 §2.3.1: сетевую политику читают только админы (секция скрыта для остальных).
  useEffect(() => {
    if (isAdmin) fetchNetworkPolicy()
  }, [isAdmin, fetchNetworkPolicy])

  const dirty = availabilityDraft.dirty

  // Секция «Доступность инструментов» строится от имён реестра.
  const availabilityServers =
    registry === null
      ? null
      : registry.map((entry) => ({
          name: entry.name,
          entry: availabilityDraft.draft?.[entry.name] ?? { default: { ...DEFAULT_AVAILABILITY }, tools: {} },
        }))

  const canManageEntry = (entry: McpRegistryEntry): boolean =>
    isAdmin || (!!entry.author?.userId && entry.author.userId === userId)

  const openAdd = () => {
    setEditing('__new__')
    setFormName('')
    setFormConfig({ type: 'http' })
    setFormDefault(false)
    setTestResult(null)
    setTestSucceeded(null)
  }

  const openEdit = (entry: McpRegistryEntry) => {
    setEditing(entry.id)
    setFormName(entry.name)
    setFormConfig({ ...entry.config })
    setFormDefault(entry.enabledByDefault)
    setTestResult(null)
    setTestSucceeded(null)
  }

  const closeForm = () => {
    setEditing(null)
    setTestResult(null)
    setTestSucceeded(null)
  }

  const handleSave = async () => {
    if (!formName.trim()) return
    setSavingForm(true)
    try {
      if (editing === '__new__') {
        await addRegistryEntry({
          name: formName.trim(),
          config: formConfig,
          enabledByDefault: formDefault,
        })
      } else if (editing) {
        await updateRegistryEntry(editing, {
          name: formName.trim(),
          config: formConfig,
          enabledByDefault: formDefault,
        })
      }
      closeForm()
    } catch {
      // ошибка уже в сторе
    } finally {
      setSavingForm(false)
    }
  }

  const handleMcpPolicySave = async () => {
    setMcpPolicySaving(true)
    setMcpPolicyError(null)
    try {
      const saved = await synthApi.saveMcpPolicy(mcpPolicy)
      setMcpPolicy(saved)
      setSavedMcpPolicy(saved)
      notify({ text: t('mcpPolicy.saved'), type: 'success', category: 'system' })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'HTTP'
      setMcpPolicyError(message)
      notify({
        text: t('mcpPolicy.saveError', { error: message }),
        type: 'error',
        category: 'error',
      })
    } finally {
      setMcpPolicySaving(false)
    }
  }

  const handleMcpPolicyReset = async () => {
    setMcpPolicySaving(true)
    setMcpPolicyError(null)
    try {
      const policy = await synthApi.resetMcpPolicy()
      setMcpPolicy(policy)
      setSavedMcpPolicy(policy)
      notify({ text: t('mcpPolicy.saved'), type: 'success', category: 'system' })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'HTTP'
      setMcpPolicyError(message)
      notify({
        text: t('mcpPolicy.saveError', { error: message }),
        type: 'error',
        category: 'error',
      })
    } finally {
      setMcpPolicySaving(false)
    }
  }

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return
    try {
      await deleteRegistryEntry(deleteTarget.id)
    } catch {
      // ошибка уже в сторе
    }
    setDeleteTarget(null)
  }

  const handleToggleDefault = async (entry: McpRegistryEntry) => {
    if (!canManageEntry(entry)) return
    try {
      await updateRegistryEntry(entry.id, { enabledByDefault: !entry.enabledByDefault })
    } catch {
      // ошибка уже в сторе
    }
  }

  const handleTest = async () => {
    if (!formName.trim()) return
    setTesting(true)
    setTestResult(null)
    setTestSucceeded(null)
    // Проверка до сохранения возможна только для уже зарегистрированного сервера
    // (probe идёт по имени из реестра); для нового — подсказка сохранить.
    if (editing === '__new__') {
      setTesting(false)
      setTestSucceeded(null)
      setTestResult(t('mcp.registry.testAfterSave'))
      return
    }
    const result = await probeServer(formName.trim())
    setTesting(false)
    if (result.success) {
      setTestResult(t('mcp.testSuccess', { count: result.tools?.length ?? 0 }))
      setTestSucceeded(true)
    } else {
      setTestResult(t('mcp.testError', { error: result.error ?? 'unknown' }))
      setTestSucceeded(false)
    }
  }

  const handleProbe = async (name: string) => {
    setProbing((p) => ({ ...p, [name]: true }))
    setProbeError((p) => ({ ...p, [name]: null }))
    const result = await probeServer(name)
    setProbing((p) => ({ ...p, [name]: false }))
    if (result.success) {
      setProbedTools((p) => ({ ...p, [name]: result.tools ?? [] }))
    } else {
      setProbedTools((p) => ({ ...p, [name]: null }))
      setProbeError((p) => ({ ...p, [name]: result.error ?? t('mcp.permissions.probeError', { error: 'unknown' }) }))
    }
  }

  const updateAvailability = (
    name: string,
    toolName: string | 'default',
    mode: 'plan' | 'act',
    value: boolean,
  ) => {
    availabilityDraft.setDraft((prev) => {
      const current = prev ?? {}
      const entry = current[name] ?? { default: { ...DEFAULT_AVAILABILITY }, tools: {} }
      if (toolName === 'default') {
        return {
          ...current,
          [name]: { ...entry, default: { ...entry.default, [mode]: value } },
        }
      }
      const tool = entry.tools[toolName] ?? { ...entry.default }
      return {
        ...current,
        [name]: { ...entry, tools: { ...entry.tools, [toolName]: { ...tool, [mode]: value } } },
      }
    })
  }

  const handleSaveSettings = async () => {
    const ok = await availabilityDraft.save()
    if (ok) {
      notify({ text: t('mcp.permissions.saved'), type: 'success', category: 'system' })
    } else {
      notify({
        text: t('mcp.permissions.saveError', {
          error: useMcpStore.getState().toolSettingsError ?? 'unknown',
        }),
        type: 'error',
        category: 'error',
      })
    }
  }

  const handleCancelSettings = () => {
    availabilityDraft.revert()
  }

  const handleResetAvailability = async () => {
    try {
      const payload = await synthApi.resetMcpSettings()
      useMcpStore.setState({ toolSettings: payload.servers })
      availabilityDraft.setDraft(payload.servers)
      notify({ text: t('mcp.permissions.saved'), type: 'success', category: 'system' })
    } catch (err) {
      notify({
        text: t('mcp.permissions.saveError', { error: err instanceof Error ? err.message : 'unknown' }),
        type: 'error',
        category: 'error',
      })
    }
  }

  const handleSaveNetworkPolicy = async (policy: McpNetworkPolicy) => {
    try {
      await saveNetworkPolicy(policy)
      notify({ text: t('mcp.network.saved'), type: 'success', category: 'system' })
    } catch (err) {
      notify({
        text: t('mcp.network.saveError', { error: err instanceof Error ? err.message : 'unknown' }),
        type: 'error',
        category: 'error',
      })
    }
  }

  const updateConfig = (patch: Partial<McpServerConfig>) => {
    setFormConfig((prev) => ({ ...prev, ...patch }))
  }

  const formatArgs = (): string => {
    const arr = formConfig.args
    if (!arr || arr.length === 0) return ''
    return arr.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')
  }

  const formatEnv = (): string => {
    const env = formConfig.env
    if (!env) return ''
    return Object.entries(env)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n')
  }

  const isHttpType = formConfig.type === 'sse' || formConfig.type === 'http'

  return (
    <SettingsPanel
      title={t('mcp.title')}
      description={t('mcp.description')}
      meta={registry ? t('mcp.count', { count: registry.length }) : undefined}
      actions={
        <Button data-testid="mcp-admin-add" onClick={openAdd}>
          <Icon name="add" className="size-3.5" />
          {t('common.add')}
        </Button>
      }
    >
      {error && (
        <div className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm">{error}</div>
      )}

      {loading && registry === null && (
        <div className="text-center text-muted-foreground py-8">{t('common.loading')}</div>
      )}

      {/* Form */}
      {editing && (
        <SettingsSection title={editing === '__new__' ? t('mcp.newServer') : t('mcp.editServer')}>
          <TextField
            label={t('mcp.serverName')}
            value={formName}
            onChange={(e) => setFormName(e.target.value)}
            disabled={editing !== '__new__'}
            placeholder="my-server"
          />

          <TextArea
            label={t('mcp.serverDescription')}
            value={formConfig.description || ''}
            onChange={(e) => updateConfig({ description: e.target.value || undefined })}
            rows={2}
            placeholder={t('mcp.serverDescriptionPlaceholder')}
          />

          <SelectField
            label={t('mcp.type')}
            description={!isAdmin ? t('mcp.registry.stdioAdminOnly') : undefined}
            value={formConfig.type}
            onValueChange={(value) => updateConfig({ type: value as McpServerConfig['type'] })}
            ariaLabel={t('mcp.type')}
          >
            <SelectContent>
              {/* AD-071 §2.5: stdio (RCE) — только ADMIN. */}
              {isAdmin && <SelectItem value="stdio">{t('mcp.type.stdio')}</SelectItem>}
              <SelectItem value="http">{t('mcp.type.http')}</SelectItem>
              <SelectItem value="sse">{t('mcp.type.sse.legacy')}</SelectItem>
            </SelectContent>
          </SelectField>

          {formConfig.type === 'stdio' && (
            <>
              <TextField
                label={t('mcp.command')}
                value={formConfig.command || ''}
                onChange={(e) => updateConfig({ command: e.target.value })}
                placeholder="python или npx"
              />
              <TextField
                label={t('mcp.args')}
                value={formatArgs()}
                onChange={(e) => {
                  const vals = e.target.value.match(/(?:[^\s"]+|"[^"]*")+/g) || []
                  updateConfig({ args: vals.map((v) => v.replace(/^"|"$/g, '')) })
                }}
                mono
                placeholder="-y @modelcontextprotocol/server-filesystem /tmp"
              />
              <TextArea
                id="mcp-server-env"
                name="mcpServerEnv"
                autoComplete="off"
                data-1p-ignore=""
                data-lpignore="true"
                data-bwignore=""
                data-form-type="other"
                spellCheck={false}
                autoCapitalize="none"
                autoCorrect="off"
                label={t('mcp.env')}
                value={formatEnv()}
                onChange={(e) => {
                  const lines = e.target.value.split('\n').filter(Boolean)
                  const env: Record<string, string> = {}
                  for (const line of lines) {
                    const eqIdx = line.indexOf('=')
                    if (eqIdx > 0) {
                      env[line.slice(0, eqIdx).trim()] = line.slice(eqIdx + 1).trim()
                    }
                  }
                  updateConfig({ env: Object.keys(env).length ? env : undefined })
                }}
                rows={3}
                mono
                placeholder={'KEY1=value1\nKEY2=value2'}
              />
            </>
          )}

          {isHttpType && (
            <TextField
              label={t('mcp.url')}
              value={formConfig.url || ''}
              onChange={(e) => updateConfig({ url: e.target.value })}
              placeholder="http://localhost:8765/mcp"
            />
          )}

          <ToggleField
            label={t('mcp.enabledByDefault')}
            enabled={formDefault}
            onToggle={() => setFormDefault((prev) => !prev)}
          />

          {/* Test result */}
          {testResult && (
            <div
              className={cn(
                "p-2 rounded text-sm",
                testSucceeded
                  ? "bg-success/10 text-success"
                  : testSucceeded === false
                    ? "bg-destructive/10 text-destructive"
                    : "bg-interactive-hover text-muted-foreground"
              )}
            >
              {testResult}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2 min-w-0">
            <Button
              variant="outline"
              onClick={handleTest}
              disabled={!formName.trim() || testing}
              className="shrink-0"
            >
              {testing ? t('common.testing') : t('common.test')}
            </Button>
            <SettingsActions
              className="ml-auto"
              onSave={handleSave}
              onCancel={closeForm}
              saveDisabled={!formName.trim()}
              saving={savingForm}
            />
          </div>
        </SettingsSection>
      )}

      {/* Registry list */}
      <SettingsSection>
        {registry && registry.length === 0 && !editing && (
          <div className="text-center text-muted-foreground py-8">
            <Icon name="server" className="size-8 mx-auto mb-2 opacity-40" />
            <p className="text-sm">{t('mcp.noServers')}</p>
          </div>
        )}

        {registry && registry.length > 0 && (
          <div className="space-y-2 min-w-0" data-testid="mcp-registry-list">
            {registry.map((entry) => {
              const manageable = canManageEntry(entry)
              return (
                <div
                  key={entry.id}
                  data-testid={`mcp-registry-${entry.name}`}
                  className={cn(
                    'flex flex-wrap items-start gap-3 p-3 rounded-lg border border-border hover:border-primary/50 transition-colors min-w-0',
                    entry.config.enabled === false && 'opacity-50'
                  )}
                >
                  <span
                    className="shrink-0"
                    title={entry.enabledByDefault ? t('mcp.enabledByDefaultTitle') : t('mcp.disabledByDefaultTitle')}
                  >
                    <Icon
                      name="checkbox"
                      className={cn(
                        "size-4 shrink-0",
                        entry.enabledByDefault ? "text-primary" : "text-muted-foreground/40"
                      )}
                    />
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap min-w-0">
                      <span className="text-sm font-medium break-words">{entry.name}</span>
                      <span className={cn('rounded px-1.5 py-0.5 text-[0.625rem] font-medium', ORIGIN_BADGE[entry.origin] ?? 'bg-muted text-muted-foreground')}>
                        {t(`mcp.origin.${entry.origin}`)}
                      </span>
                      <span className={cn('rounded px-1.5 py-0.5 text-[0.625rem] font-medium', TRUST_BADGE[entry.trust] ?? 'bg-muted text-muted-foreground')}>
                        {t(`mcp.trust.${entry.trust}`)}
                      </span>
                    </div>
                    {entry.config.description && (
                      <div className="text-xs text-muted-foreground break-words" title={entry.config.description}>
                        {entry.config.description}
                      </div>
                    )}
                    <div className="text-xs text-muted-foreground break-words">
                      {entry.config.type === 'stdio'
                        ? `stdio: ${entry.config.command || '?'}`
                        : `${entry.config.type}: ${entry.config.url || '?'}`}
                      {entry.author?.username && ` · ${t('mcp.registry.author', { name: entry.author.username })}`}
                      {entry.enabledByDefault && ` · ${t('mcp.autoEnabled')}`}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Toggle
                      enabled={entry.enabledByDefault}
                      disabled={!manageable}
                      onToggle={() => handleToggleDefault(entry)}
                      ariaLabel={entry.enabledByDefault ? t('mcp.disable') : t('mcp.enable')}
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      className="shrink-0"
                      onClick={() => openEdit(entry)}
                      disabled={!manageable}
                      aria-label={t('mcp.edit')}
                    >
                      <Icon name="edit-2" className="size-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="shrink-0 hover:text-destructive"
                      onClick={() => setDeleteTarget(entry)}
                      disabled={!manageable}
                      aria-label={t('mcp.delete')}
                    >
                      <Icon name="delete-bin" className="size-4" />
                    </Button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </SettingsSection>

      {/* Доступность инструментов по режимам (W4c) */}
      <SettingsSection
        title={t('mcp.permissions.title')}
        description={t('mcp.permissions.description')}
      >
        {dirty && (
          <div className="p-2 rounded-lg bg-interactive-hover text-muted-foreground text-xs">
            {t('mcp.permissions.unsaved')}
          </div>
        )}

        {toolSettingsLoading && toolSettings === null && (
          <div className="text-center text-muted-foreground py-6">{t('mcp.permissions.loading')}</div>
        )}

        {toolSettingsError && !toolSettings && (
          <div className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
            {t('mcp.permissions.loadError', { error: toolSettingsError })}
            <div className="text-xs opacity-80 mt-1">{t('mcp.permissions.notReady')}</div>
          </div>
        )}

        {availabilityServers && availabilityServers.length === 0 && !toolSettingsLoading && (
          <div className="text-center text-muted-foreground py-6 text-sm">
            {t('mcp.permissions.noServerSettings')}
          </div>
        )}

        {availabilityServers && availabilityServers.length > 0 && (
          <div className="space-y-2 min-w-0">
            {availabilityServers.map(({ name, entry }) => (
              <ServerAvailabilityCard
                key={name}
                name={name}
                entry={entry}
                probing={probing[name] ?? false}
                tools={probedTools[name]}
                probeError={probeError[name] ?? null}
                onProbe={() => handleProbe(name)}
                onToggleDefault={(mode, value) => updateAvailability(name, 'default', mode, value)}
                onToggleTool={(toolName, mode, value) => updateAvailability(name, toolName, mode, value)}
              />
            ))}
          </div>
        )}

        {availabilityServers && availabilityServers.length > 0 && (
          <SettingsActions
            onSave={handleSaveSettings}
            onCancel={handleCancelSettings}
            onReset={handleResetAvailability}
            saveDisabled={!dirty || toolSettingsLoading}
            cancelDisabled={!dirty}
            isDefault={availabilityDraft.isDefault}
            saving={availabilityDraft.saving}
            saveTestId="mcp-availability-save"
            cancelTestId="mcp-availability-cancel"
            resetTestId="mcp-availability-reset"
          />
        )}
      </SettingsSection>

      {/* AD-071 §2.3: глобальная политика MCP-инструментов (mcp.policy). */}
      <PolicySettingsCard
        scope="mcp"
        value={mcpPolicy}
        savedValue={savedMcpPolicy}
        loading={mcpPolicyLoading}
        saving={mcpPolicySaving}
        error={mcpPolicyError}
        onChange={setMcpPolicy}
        onSave={handleMcpPolicySave}
        onReset={handleMcpPolicyReset}
        isDefault={mcpPolicy === mcpPolicyDefault}
      />

      {/* AD-071 §2.3.1: сетевой доступ пользовательских HTTP MCP (только ADMIN) */}
      {isAdmin && (
        <NetworkPolicySection
          policy={networkPolicy}
          defaultValue={networkPolicyDefaults}
          loading={networkPolicyLoading}
          error={networkPolicyError}
          onSave={handleSaveNetworkPolicy}
        />
      )}

      {/* Delete confirmation */}
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={() => setDeleteTarget(null)}
        title={t('mcp.deleteConfirm')}
        message={deleteTarget ? t('mcp.deleteConfirmMessage', { name: deleteTarget.name }) : ''}
        confirmLabel={t('common.delete')}
        variant="danger"
        icon="delete-bin"
        onConfirm={handleDeleteConfirm}
      />
    </SettingsPanel>
  )
}

/** AD-071 §2.3.1 / AD-072: редактор политики сетевого доступа (allow/deny + host/CIDR). */
function NetworkPolicySection({
  policy,
  defaultValue,
  loading,
  error,
  onSave,
}: {
  policy: McpNetworkPolicy | null
  defaultValue: McpNetworkPolicy | null
  loading: boolean
  error: string | null
  onSave: (policy: McpNetworkPolicy) => Promise<void> | void
}) {
  const { t } = useI18n()
  const { notify } = useNotification()
  const [saving, setSaving] = useState(false)
  const draft = useSettingsDraft<McpNetworkPolicy>({
    value: policy,
    // Серверный дефолт; до загрузки — null (Reset серый и неактивен).
    defaultValue,
  })
  const current = draft.draft

  const handleSave = async () => {
    if (current == null) return
    setSaving(true)
    try {
      await onSave(current)
    } finally {
      setSaving(false)
    }
  }

  const handleReset = async () => {
    try {
      const next = await synthApi.resetMcpNetworkPolicy()
      useMcpStore.setState({ networkPolicy: next })
      draft.setDraft(next)
      notify({ text: t('mcp.network.saved'), type: 'success', category: 'system' })
    } catch (err) {
      notify({
        text: t('mcp.network.saveError', { error: err instanceof Error ? err.message : 'unknown' }),
        type: 'error',
        category: 'error',
      })
    }
  }

  return (
    <SettingsSection
      title={t('mcp.network.title')}
      description={t('mcp.network.description')}
    >
      <div className="space-y-3 min-w-0" data-testid="mcp-network-policy">
        {loading && !current && (
          <div className="text-center text-muted-foreground py-4 text-sm">{t('common.loading')}</div>
        )}
        {error && (
          <div className="p-2 rounded-lg bg-destructive/10 text-destructive text-sm">{error}</div>
        )}

        {current && (
          <>
            <SelectField
              label={t('mcp.network.mode')}
              description={current.mode === 'deny' ? t('mcp.network.denyHelp') : t('mcp.network.allowHelp')}
              value={current.mode}
              onValueChange={(value) => draft.update({ mode: value as 'allow' | 'deny' })}
              ariaLabel={t('mcp.network.mode')}
            >
              <SelectContent>
                <SelectItem value="deny">{t('mcp.network.mode.deny')}</SelectItem>
                <SelectItem value="allow">{t('mcp.network.mode.allow')}</SelectItem>
              </SelectContent>
            </SelectField>

            <ListField
              label={t('mcp.network.list')}
              values={current.list}
              onChange={(list) => draft.update({ list })}
              placeholder="10.0.0.0/8"
              variant="chips"
            />

            <SettingsActions
              onSave={() => { void handleSave() }}
              onCancel={() => draft.revert()}
              onReset={() => { void handleReset() }}
              saveDisabled={loading || !draft.dirty}
              cancelDisabled={!draft.dirty}
              isDefault={draft.isDefault}
              saving={saving}
              saveTestId="mcp-network-save"
              cancelTestId="mcp-network-cancel"
              resetTestId="mcp-network-reset"
            />
          </>
        )}
      </div>
    </SettingsSection>
  )
}

function ServerAvailabilityCard({
  name,
  entry,
  probing,
  tools,
  probeError,
  onProbe,
  onToggleDefault,
  onToggleTool,
}: {
  name: string
  entry: McpServerToolsSettings
  probing: boolean
  tools: McpProbedTool[] | null | undefined
  probeError: string | null
  onProbe: () => void
  onToggleDefault: (mode: 'plan' | 'act', value: boolean) => void
  onToggleTool: (toolName: string, mode: 'plan' | 'act', value: boolean) => void
}) {
  const { t } = useI18n()
  const hasProbed = tools !== undefined

  return (
    <SettingsSection>
      <div className="flex flex-wrap items-center justify-between gap-2 min-w-0">
        <div className="text-sm font-medium min-w-0 break-words">{name}</div>
        <Button
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={onProbe}
          disabled={probing}
        >
          <Icon name="link" className="size-3.5" />
          {probing ? t('mcp.permissions.probing') : t('mcp.permissions.probe')}
        </Button>
      </div>

      {probeError && (
        <div className="p-2 rounded bg-destructive/10 text-destructive text-xs">{probeError}</div>
      )}

      {/* Default для всех инструментов */}
      <SettingsRow
        label={t('mcp.permissions.defaultTools')}
        description={t('mcp.permissions.defaultToolsHint')}
        control={<ModeToggles availability={entry.default} onToggle={onToggleDefault} />}
      />

      {/* Инструменты сервера */}
      {hasProbed && (
        <div className="space-y-1.5 min-w-0">
          <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            {t('mcp.permissions.perTool')}
          </div>
          {tools && tools.length === 0 && (
            <div className="text-sm text-muted-foreground py-2">{t('mcp.permissions.noTools')}</div>
          )}
          {tools && tools.length > 0 && (
            <div className="space-y-1.5 min-w-0">
              {tools.map((tool) => {
                const toolSettings = entry.tools[tool.name]
                const effective = toolSettings ?? entry.default
                const description = tool.description
                  ? `${tool.description}${!toolSettings ? ` · ${t('mcp.permissions.toolDefaultHint')}` : ''}`
                  : undefined
                return (
                  <SettingsRow
                    key={tool.name}
                    className={cn(
                      "rounded-md border border-border/60 px-3 py-2",
                      !toolSettings && "opacity-80"
                    )}
                    label={tool.name}
                    description={description}
                    control={
                      <ModeToggles
                        availability={effective}
                        onToggle={(mode, value) => onToggleTool(tool.name, mode, value)}
                      />
                    }
                  />
                )
              })}
            </div>
          )}
        </div>
      )}
    </SettingsSection>
  )
}

function ModeToggles({
  availability,
  onToggle,
}: {
  availability: McpModeAvailability
  onToggle: (mode: 'plan' | 'act', value: boolean) => void
}) {
  const { t } = useI18n()
  return (
    <div className="flex items-center gap-3 shrink-0">
      <label className="flex items-center gap-1.5 cursor-pointer">
        <span className="text-xs text-muted-foreground">{t('mcp.permissions.mode.plan')}</span>
        <Toggle
          enabled={availability.plan}
          onToggle={() => onToggle('plan', !availability.plan)}
          ariaLabel={t('mcp.permissions.mode.plan')}
        />
      </label>
      <label className="flex items-center gap-1.5 cursor-pointer">
        <span className="text-xs text-muted-foreground">{t('mcp.permissions.mode.act')}</span>
        <Toggle
          enabled={availability.act}
          onToggle={() => onToggle('act', !availability.act)}
          ariaLabel={t('mcp.permissions.mode.act')}
        />
      </label>
    </div>
  )
}

import { useState, useEffect, useRef } from 'react'
import type { McpNetworkPolicy, McpRegistryEntry } from '@itphx/synth-shared'
import { Icon } from '../icon/Icon'
import { useMcpStore } from '../../stores/mcpStore'
import { useAuthStore } from '../../stores/authStore'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { ConfirmDialog } from '../ui/confirm-dialog'
import { Toggle } from '../ui/Toggle'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { SettingsPage, SettingsCard } from './settings-layout'
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
  const {
    registry, loading, error, fetchRegistry, addRegistryEntry, updateRegistryEntry, deleteRegistryEntry,
    toolSettings, toolSettingsLoading, toolSettingsError,
    fetchToolSettings, updateToolAvailability, saveToolSettings, probeServer,
    networkPolicy, networkPolicyLoading, networkPolicyError, fetchNetworkPolicy, saveNetworkPolicy,
  } = useMcpStore()
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
  const [mcpPolicyLoading, setMcpPolicyLoading] = useState(true)
  const [mcpPolicySaving, setMcpPolicySaving] = useState(false)
  const [mcpPolicyError, setMcpPolicyError] = useState<string | null>(null)

  // Delete confirmation state
  const [deleteTarget, setDeleteTarget] = useState<McpRegistryEntry | null>(null)

  // Доступность инструментов по режимам (W4c)
  const [probedTools, setProbedTools] = useState<Record<string, McpProbedTool[] | null>>({})
  const [probing, setProbing] = useState<Record<string, boolean>>({})
  const [probeError, setProbeError] = useState<Record<string, string | null>>({})
  const [savingSettings, setSavingSettings] = useState(false)
  const initialSettingsRef = useRef<Record<string, McpServerToolsSettings> | null>(null)
  const prevToolSettingsRef = useRef<typeof toolSettings>(null)

  useEffect(() => {
    fetchRegistry()
    fetchToolSettings()
  }, [fetchRegistry, fetchToolSettings])

  // AD-071 §2.3: политику MCP читает любой пользователь (эндпоинт без admin-гейта),
  // меняет только ADMIN — карточка доступна в админ-категории.
  useEffect(() => {
    let cancelled = false
    synthApi
      .getMcpPolicy()
      .then((policy) => {
        if (!cancelled) setMcpPolicy(policy)
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

  // Снапшот исходных настроек — только при первичной загрузке
  useEffect(() => {
    if (toolSettings && prevToolSettingsRef.current === null) {
      initialSettingsRef.current = JSON.parse(JSON.stringify(toolSettings))
    }
    prevToolSettingsRef.current = toolSettings
  }, [toolSettings])

  const dirty =
    toolSettings !== null &&
    initialSettingsRef.current !== null &&
    JSON.stringify(toolSettings) !== JSON.stringify(initialSettingsRef.current)

  // Секция «Доступность инструментов» строится от имён реестра.
  const availabilityServers =
    registry === null
      ? null
      : registry.map((entry) => ({
          name: entry.name,
          entry: toolSettings?.[entry.name] ?? { default: { ...DEFAULT_AVAILABILITY }, tools: {} },
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

  const handleSaveSettings = async () => {
    setSavingSettings(true)
    try {
      await saveToolSettings()
      initialSettingsRef.current = JSON.parse(JSON.stringify(useMcpStore.getState().toolSettings))
      notify({ text: t('mcp.permissions.saved'), type: 'success', category: 'system' })
    } catch (err) {
      notify({
        text: t('mcp.permissions.saveError', { error: err instanceof Error ? err.message : 'unknown' }),
        type: 'error',
        category: 'error',
      })
    } finally {
      setSavingSettings(false)
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
    <SettingsPage stickyHeader title={t('mcp.title')} description={t('mcp.description')}>
      {error && (
        <div className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm">{error}</div>
      )}

      {loading && registry === null && (
        <div className="text-center text-muted-foreground py-8">{t('common.loading')}</div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        {/* AD-071 §2.3: глобальная политика MCP-инструментов (mcp.policy). */}
        <PolicySettingsCard
          className="sm:col-span-2"
          scope="mcp"
          value={mcpPolicy}
          loading={mcpPolicyLoading}
          saving={mcpPolicySaving}
          error={mcpPolicyError}
          onChange={setMcpPolicy}
          onSave={handleMcpPolicySave}
        />

        {/* Form */}
        {editing && (
          <SettingsCard
            title={editing === '__new__' ? t('mcp.newServer') : t('mcp.editServer')}
          >
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">{t('mcp.serverName')}</label>
                <input
                  type="text"
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  disabled={editing !== '__new__'}
                  className="w-full px-3 py-2 rounded-lg bg-interactive-input border border-border text-sm focus:outline-none focus:border-interactive-accent disabled:opacity-50"
                  placeholder="my-server"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">{t('mcp.serverDescription')}</label>
                <textarea
                  value={formConfig.description || ''}
                  onChange={(e) => updateConfig({ description: e.target.value || undefined })}
                  rows={2}
                  className="w-full px-3 py-2 rounded-lg bg-interactive-input border border-border text-sm focus:outline-none focus:border-interactive-accent"
                  placeholder={t('mcp.serverDescriptionPlaceholder')}
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">{t('mcp.type')}</label>
                <Select
                  value={formConfig.type}
                  onValueChange={(value) => updateConfig({ type: value as McpServerConfig['type'] })}
                >
                  <SelectTrigger className="w-full" aria-label={t('mcp.type')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {/* AD-071 §2.5: stdio (RCE) — только ADMIN. */}
                    {isAdmin && <SelectItem value="stdio">{t('mcp.type.stdio')}</SelectItem>}
                    <SelectItem value="http">{t('mcp.type.http')}</SelectItem>
                    <SelectItem value="sse">{t('mcp.type.sse.legacy')}</SelectItem>
                  </SelectContent>
                </Select>
                {!isAdmin && (
                  <p className="mt-1 text-[0.625rem] text-muted-foreground/70">{t('mcp.registry.stdioAdminOnly')}</p>
                )}
              </div>

              {formConfig.type === 'stdio' && (
                <>
                  <div>
                    <label className="block text-xs font-medium text-muted-foreground mb-1">{t('mcp.command')}</label>
                    <input
                      type="text"
                      value={formConfig.command || ''}
                      onChange={(e) => updateConfig({ command: e.target.value })}
                      className="w-full px-3 py-2 rounded-lg bg-interactive-input border border-border text-sm focus:outline-none focus:border-interactive-accent"
                      placeholder="python или npx"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-muted-foreground mb-1">{t('mcp.args')}</label>
                    <input
                      type="text"
                      value={formatArgs()}
                      onChange={(e) => {
                        const vals = e.target.value.match(/(?:[^\s"]+|"[^"]*")+/g) || []
                        updateConfig({ args: vals.map((v) => v.replace(/^"|"$/g, '')) })
                      }}
                      className="w-full px-3 py-2 rounded-lg bg-interactive-input border border-border text-sm focus:outline-none focus:border-interactive-accent font-mono"
                      placeholder="-y @modelcontextprotocol/server-filesystem /tmp"
                    />
                  </div>
                  <div>
                    <label htmlFor="mcp-server-env" className="block text-xs font-medium text-muted-foreground mb-1">{t('mcp.env')}</label>
                    <textarea
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
                      className="w-full px-3 py-2 rounded-lg bg-interactive-input border border-border text-sm focus:outline-none focus:border-interactive-accent font-mono"
                      placeholder="KEY1=value1&#10;KEY2=value2"
                    />
                  </div>
                </>
              )}

              {isHttpType && (
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">{t('mcp.url')}</label>
                  <input
                    type="text"
                    value={formConfig.url || ''}
                    onChange={(e) => updateConfig({ url: e.target.value })}
                    className="w-full px-3 py-2 rounded-lg bg-interactive-input border border-border text-sm focus:outline-none focus:border-interactive-accent"
                    placeholder="http://localhost:8765/mcp"
                  />
                </div>
              )}

              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={formDefault}
                  onChange={(e) => setFormDefault(e.target.checked)}
                  className="rounded"
                  id="mcp-enabled-default"
                />
                <label htmlFor="mcp-enabled-default" className="text-sm text-muted-foreground">
                  {t('mcp.enabledByDefault')}
                </label>
              </div>

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
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={handleSave}
                disabled={!formName.trim() || savingForm}
                className="px-4 py-2 rounded-lg bg-interactive-accent text-interactive-accent-foreground text-sm font-medium hover:opacity-90 disabled:opacity-50 transition-[transform,opacity] duration-150 ease-out active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {t('common.save')}
              </button>
              <button
                onClick={handleTest}
                disabled={!formName.trim() || testing}
                className="px-4 py-2 rounded-lg border border-border text-sm hover:bg-interactive-hover disabled:opacity-50"
              >
                {testing ? t('common.testing') : t('common.test')}
              </button>
              <button
                onClick={closeForm}
                className="px-4 py-2 rounded-lg text-sm text-muted-foreground hover:text-foreground ml-auto"
              >
                {t('common.cancel')}
              </button>
            </div>
          </SettingsCard>
        )}

        {/* Registry list */}
        <SettingsCard className="sm:col-span-2">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-medium text-foreground">
              {registry ? t('mcp.count', { count: registry.length }) : ''}
            </span>
            <button
              onClick={openAdd}
              className="shrink-0 flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs bg-interactive-accent text-interactive-accent-foreground hover:opacity-90 transition-[transform,opacity] duration-150 ease-out active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Icon name="add" className="size-3.5" />
              {t('common.add')}
            </button>
          </div>

          {registry && registry.length === 0 && !editing && (
            <div className="text-center text-muted-foreground py-8">
              <Icon name="server" className="size-8 mx-auto mb-2 opacity-40" />
              <p className="text-sm">{t('mcp.noServers')}</p>
            </div>
          )}

          {registry && registry.length > 0 && (
            <div className="space-y-2" data-testid="mcp-registry-list">
              {registry.map((entry) => {
                const manageable = canManageEntry(entry)
                return (
                  <div
                    key={entry.id}
                    data-testid={`mcp-registry-${entry.name}`}
                    className={cn(
                      "flex items-center gap-3 p-3 rounded-lg border border-border hover:border-interactive-accent/50 transition-colors",
                      entry.config.enabled === false && "opacity-50"
                    )}
                  >
                    <span
                      title={entry.enabledByDefault ? t('mcp.enabledByDefaultTitle') : t('mcp.disabledByDefaultTitle')}
                    >
                      <Icon
                        name="checkbox"
                        className={cn(
                          "size-4 shrink-0",
                          entry.enabledByDefault ? "text-interactive-accent" : "text-muted-foreground/40"
                        )}
                      />
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-sm font-medium truncate">{entry.name}</span>
                        <span className={cn('rounded px-1.5 py-0.5 text-[0.625rem] font-medium', ORIGIN_BADGE[entry.origin] ?? 'bg-muted text-muted-foreground')}>
                          {t(`mcp.origin.${entry.origin}`)}
                        </span>
                        <span className={cn('rounded px-1.5 py-0.5 text-[0.625rem] font-medium', TRUST_BADGE[entry.trust] ?? 'bg-muted text-muted-foreground')}>
                          {t(`mcp.trust.${entry.trust}`)}
                        </span>
                      </div>
                      {entry.config.description && (
                        <div className="text-xs text-muted-foreground truncate" title={entry.config.description}>
                          {entry.config.description}
                        </div>
                      )}
                      <div className="text-xs text-muted-foreground">
                        {entry.config.type === 'stdio'
                          ? `stdio: ${entry.config.command || '?'}`
                          : `${entry.config.type}: ${entry.config.url || '?'}`}
                        {entry.author?.username && ` · ${t('mcp.registry.author', { name: entry.author.username })}`}
                        {entry.enabledByDefault && ` · ${t('mcp.autoEnabled')}`}
                      </div>
                    </div>
                    <button
                      onClick={() => handleToggleDefault(entry)}
                      disabled={!manageable}
                      role="switch"
                      aria-checked={entry.enabledByDefault}
                      aria-label={entry.enabledByDefault ? t('mcp.disable') : t('mcp.enable')}
                      title={entry.enabledByDefault ? t('mcp.enabledByDefaultTitle') : t('mcp.disabledByDefaultTitle')}
                      className={cn(
                        "relative w-9 h-5 rounded-full transition-colors shrink-0 disabled:opacity-40",
                        entry.enabledByDefault ? 'bg-primary' : 'bg-muted-foreground/20'
                      )}
                    >
                      <span className={cn(
                        "block size-3.5 rounded-full bg-card shadow-sm transition-transform",
                        entry.enabledByDefault ? 'translate-x-[1.1875rem]' : 'translate-x-[0.1875rem]'
                      )} />
                    </button>
                    <button
                      onClick={() => openEdit(entry)}
                      disabled={!manageable}
                      className="p-1.5 rounded-lg hover:bg-interactive-hover text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40"
                      aria-label={t('mcp.edit')}
                    >
                      <Icon name="edit-2" className="size-4" />
                    </button>
                    <button
                      onClick={() => setDeleteTarget(entry)}
                      disabled={!manageable}
                      className="p-1.5 rounded-lg hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors disabled:opacity-40"
                      aria-label={t('mcp.delete')}
                    >
                      <Icon name="delete-bin" className="size-4" />
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </SettingsCard>

        {/* AD-071 §2.3.1: сетевой доступ пользовательских HTTP MCP (только ADMIN) */}
        {isAdmin && (
          <NetworkPolicySection
            policy={networkPolicy}
            loading={networkPolicyLoading}
            error={networkPolicyError}
            onSave={handleSaveNetworkPolicy}
          />
        )}

        {/* Доступность инструментов по режимам (W4c) */}
        <SettingsCard
          className="sm:col-span-2"
          title={t('mcp.permissions.title')}
          description={t('mcp.permissions.description')}
        >
          {availabilityServers && availabilityServers.length > 0 && (
            <div className="flex justify-end">
              <button
                onClick={handleSaveSettings}
                disabled={!dirty || savingSettings || toolSettingsLoading}
                className="shrink-0 px-4 py-2 rounded-lg bg-interactive-accent text-interactive-accent-foreground text-sm font-medium hover:opacity-90 disabled:opacity-50 transition-[transform,opacity] duration-150 ease-out active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {savingSettings ? t('mcp.permissions.saving') : t('mcp.permissions.save')}
              </button>
            </div>
          )}

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
            <div className="space-y-2">
              {availabilityServers.map(({ name, entry }) => (
                <ServerAvailabilityCard
                  key={name}
                  name={name}
                  entry={entry}
                  probing={probing[name] ?? false}
                  tools={probedTools[name]}
                  probeError={probeError[name] ?? null}
                  onProbe={() => handleProbe(name)}
                  onToggleDefault={(mode, value) => updateToolAvailability(name, 'default', mode, value)}
                  onToggleTool={(toolName, mode, value) => updateToolAvailability(name, toolName, mode, value)}
                />
              ))}
            </div>
          )}
        </SettingsCard>
      </div>

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
    </SettingsPage>
  )
}

/** AD-071 §2.3.1: редактор политики сетевого доступа (allow/deny + host/CIDR). */
function NetworkPolicySection({
  policy,
  loading,
  error,
  onSave,
}: {
  policy: McpNetworkPolicy | null
  loading: boolean
  error: string | null
  onSave: (policy: McpNetworkPolicy) => void
}) {
  const { t } = useI18n()
  const [mode, setMode] = useState<'allow' | 'deny'>('deny')
  const [list, setList] = useState<string[]>([])
  const [draft, setDraft] = useState('')

  useEffect(() => {
    if (policy) {
      setMode(policy.mode)
      setList(policy.list)
    }
  }, [policy])

  const addEntry = () => {
    const value = draft.trim()
    if (!value || list.includes(value)) return
    setList((prev) => [...prev, value])
    setDraft('')
  }

  return (
    <SettingsCard
      className="sm:col-span-2"
      title={t('mcp.network.title')}
      description={t('mcp.network.description')}
    >
      {loading && !policy && (
        <div className="text-center text-muted-foreground py-4 text-sm">{t('common.loading')}</div>
      )}
      {error && (
        <div className="p-2 rounded-lg bg-destructive/10 text-destructive text-sm">{error}</div>
      )}

      <div className="space-y-3" data-testid="mcp-network-policy">
        <div className="flex items-center gap-3">
          <label className="text-xs font-medium text-muted-foreground w-24">{t('mcp.network.mode')}</label>
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as 'allow' | 'deny')}
            aria-label={t('mcp.network.mode')}
            className="rounded-md bg-input border border-border px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          >
            <option value="deny">{t('mcp.network.mode.deny')}</option>
            <option value="allow">{t('mcp.network.mode.allow')}</option>
          </select>
        </div>

        <p className="text-xs text-muted-foreground">
          {mode === 'deny' ? t('mcp.network.denyHelp') : t('mcp.network.allowHelp')}
        </p>

        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-muted-foreground">{t('mcp.network.list')}</label>
          {list.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {list.map((value) => (
                <span key={value} className="inline-flex items-center gap-1 rounded bg-interactive-hover px-2 py-0.5 text-xs font-mono">
                  {value}
                  <button
                    onClick={() => setList((prev) => prev.filter((v) => v !== value))}
                    className="text-muted-foreground hover:text-destructive"
                    aria-label={t('common.delete')}
                  >
                    <Icon name="close" className="size-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="flex gap-2">
            <input
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addEntry() } }}
              placeholder="10.0.0.0/8"
              className="flex-1 min-w-0 rounded-md bg-input border border-border px-2 py-1 text-xs font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />
            <button
              onClick={addEntry}
              disabled={!draft.trim()}
              className="shrink-0 rounded-md border border-border px-2 py-1 text-xs hover:bg-interactive-hover disabled:opacity-50"
            >
              {t('common.add')}
            </button>
          </div>
        </div>

        <div className="flex justify-end">
          <button
            onClick={() => onSave({ mode, list })}
            disabled={loading}
            className="shrink-0 px-4 py-2 rounded-lg bg-interactive-accent text-interactive-accent-foreground text-sm font-medium hover:opacity-90 disabled:opacity-50 transition-[transform,opacity] duration-150 ease-out active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {loading ? t('mcp.permissions.saving') : t('common.save')}
          </button>
        </div>
      </div>
    </SettingsCard>
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
    <div className="border border-border rounded-lg p-3 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium truncate">{name}</div>
        </div>
        <button
          onClick={onProbe}
          disabled={probing}
          className="shrink-0 flex items-center gap-1 px-3 py-1.5 rounded-lg border border-border text-xs hover:bg-interactive-hover disabled:opacity-50"
        >
          <Icon name="link" className="size-3.5" />
          {probing ? t('mcp.permissions.probing') : t('mcp.permissions.probe')}
        </button>
      </div>

      {probeError && (
        <div className="p-2 rounded bg-destructive/10 text-destructive text-xs">{probeError}</div>
      )}

      {/* Default для всех инструментов */}
      <div className="flex items-center justify-between gap-3 rounded-md bg-interactive-hover/50 px-3 py-2">
        <div className="min-w-0">
          <div className="text-sm font-medium">{t('mcp.permissions.defaultTools')}</div>
          <div className="text-xs text-muted-foreground truncate">{t('mcp.permissions.defaultToolsHint')}</div>
        </div>
        <ModeToggles availability={entry.default} onToggle={onToggleDefault} />
      </div>

      {/* Инструменты сервера */}
      {hasProbed && (
        <div className="space-y-1.5">
          <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            {t('mcp.permissions.perTool')}
          </div>
          {tools && tools.length === 0 && (
            <div className="text-sm text-muted-foreground py-2">{t('mcp.permissions.noTools')}</div>
          )}
          {tools && tools.length > 0 && (
            <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1">
              {tools.map((tool) => {
                const toolSettings = entry.tools[tool.name]
                const effective = toolSettings ?? entry.default
                return (
                  <div
                    key={tool.name}
                    className={cn(
                      "flex items-center justify-between gap-3 px-3 py-2 rounded-md border border-border/60",
                      !toolSettings && "opacity-80"
                    )}
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-mono truncate" title={tool.name}>{tool.name}</div>
                      {tool.description && (
                        <div className="text-xs text-muted-foreground truncate" title={tool.description}>
                          {tool.description}
                          {!toolSettings && ` · ${t('mcp.permissions.toolDefaultHint')}`}
                        </div>
                      )}
                    </div>
                    <ModeToggles
                      availability={effective}
                      onToggle={(mode, value) => onToggleTool(tool.name, mode, value)}
                    />
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
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

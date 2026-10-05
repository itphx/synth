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
  ToggleField,
  useSettingsDraft,
} from '../ui/settings'
import { PolicySettingsCard } from './PolicySettingsCard'
import { McpRegistryForm } from './McpRegistryForm'
import { useMcpRegistryEditor } from './useMcpRegistryEditor'
import { useNotification } from '@/hooks/useNotification'
import { synthApi } from '../../lib/api/synthApi'
import type {
  ToolsPolicy,
  McpServerToolsSettings,
  McpModeAvailability,
  McpProbedTool,
} from '../../lib/api/synthApi'

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
  user: 'bg-status-warning/15 text-status-warning',
}

const TRUST_BADGE: Record<string, string> = {
  builtin: 'bg-status-success/15 text-status-success',
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

  const [testResult, setTestResult] = useState<string | null>(null)
  const [testSucceeded, setTestSucceeded] = useState<boolean | null>(null)
  const [testing, setTesting] = useState(false)

  const editor = useMcpRegistryEditor({
    addEntry: (input) => addRegistryEntry(input),
    updateEntry: (id, input) => updateRegistryEntry(id, input),
    deleteEntry: deleteRegistryEntry,
    onOpen: () => {
      setTestResult(null)
      setTestSucceeded(null)
    },
    onClose: () => {
      setTestResult(null)
      setTestSucceeded(null)
    },
  })

  // AD-071 §2.3: глобальная политика MCP-инструментов (mcp.policy).
  const [mcpPolicy, setMcpPolicy] = useState<ToolsPolicy>('auto')
  const [savedMcpPolicy, setSavedMcpPolicy] = useState<ToolsPolicy>('auto')
  const [mcpPolicyDefault, setMcpPolicyDefault] = useState<ToolsPolicy>('auto')
  const [mcpPolicyLoading, setMcpPolicyLoading] = useState(true)
  const [mcpPolicySaving, setMcpPolicySaving] = useState(false)
  const [mcpPolicyError, setMcpPolicyError] = useState<string | null>(null)

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
      useMcpStore.getState().setToolSettingsLocal(next)
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

  const handleToggleMaster = async (entry: McpRegistryEntry) => {
    if (!canManageEntry(entry)) return
    try {
      await updateRegistryEntry(entry.id, { enabled: entry.enabled === false })
    } catch {
      // ошибка уже в сторе
    }
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
    if (!editor.formName.trim()) return
    setTesting(true)
    setTestResult(null)
    setTestSucceeded(null)
    // Проверка до сохранения возможна только для уже зарегистрированного сервера
    // (probe идёт по имени из реестра); для нового — подсказка сохранить.
    if (editor.editing === '__new__') {
      setTesting(false)
      setTestSucceeded(null)
      setTestResult(t('mcp.registry.testAfterSave'))
      return
    }
    const result = await probeServer(editor.formName.trim())
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
      useMcpStore.getState().setToolSettingsLocal(payload.servers)
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

  return (
    <SettingsPanel
      title={t('mcp.title')}
      description={t('mcp.description')}
      meta={registry ? t('mcp.count', { count: registry.length }) : undefined}
      actions={
        <Button data-testid="mcp-admin-add" onClick={editor.openAdd}>
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
      {editor.editing && (
        <McpRegistryForm
          title={editor.editing === '__new__' ? t('mcp.newServer') : t('mcp.editServer')}
          editing={editor.editing !== '__new__'}
          name={editor.formName}
          onNameChange={editor.setFormName}
          config={editor.formConfig}
          onConfigChange={editor.updateConfig}
          allowStdio={isAdmin}
          typeDescription={!isAdmin ? t('mcp.registry.stdioAdminOnly') : undefined}
          saving={editor.savingForm}
          onSave={editor.handleSave}
          onCancel={editor.closeForm}
          extraFields={
            <>
              <ToggleField
                label={t('mcp.masterEnabled')}
                description={t('mcp.masterEnabledDescription')}
                enabled={editor.formEnabled}
                onToggle={() => editor.setFormEnabled((prev) => !prev)}
              />
              <ToggleField
                label={t('mcp.enabledByDefault')}
                enabled={editor.formDefault}
                onToggle={() => editor.setFormDefault((prev) => !prev)}
              />
              {testResult && (
                <div
                  className={cn(
                    'p-2 rounded text-sm',
                    testSucceeded
                      ? 'bg-status-success/10 text-status-success'
                      : testSucceeded === false
                        ? 'bg-destructive/10 text-destructive'
                        : 'bg-interactive-hover text-muted-foreground',
                  )}
                >
                  {testResult}
                </div>
              )}
            </>
          }
          extraActions={
            <Button
              variant="outline"
              onClick={handleTest}
              disabled={!editor.formName.trim() || testing}
              className="shrink-0"
            >
              {testing ? t('common.testing') : t('common.test')}
            </Button>
          }
        />
      )}

      {/* Registry list */}
      <SettingsSection>
        {registry && registry.length === 0 && !editor.editing && (
          <div className="text-center text-muted-foreground py-8">
            <Icon name="server" className="size-8 mx-auto mb-2 opacity-40" />
            <p className="text-sm">{t('mcp.noServers')}</p>
          </div>
        )}

        {registry && registry.length > 0 && (
          <div className="space-y-2 min-w-0" data-testid="mcp-registry-list">
            {registry.map((entry) => {
              const manageable = canManageEntry(entry)
              const masterEnabled = entry.enabled !== false
              return (
                <div
                  key={entry.id}
                  data-testid={`mcp-registry-${entry.name}`}
                  className={cn(
                    'flex flex-wrap items-start gap-3 p-3 rounded-lg border border-border bg-background hover:border-primary/50 transition-colors min-w-0',
                    !masterEnabled && 'opacity-50'
                  )}
                >
                  <span
                    className="shrink-0"
                    title={masterEnabled ? t('mcp.masterEnabledTitle') : t('mcp.masterDisabledTitle')}
                  >
                    <Icon
                      name="checkbox"
                      className={cn(
                        "size-4 shrink-0",
                        masterEnabled ? "text-primary" : "text-muted-foreground/40"
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
                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    <label className="flex items-center gap-1" title={t('mcp.masterEnabledTitle')}>
                      <span className="text-[0.625rem] text-muted-foreground">{t('mcp.masterEnabledShort')}</span>
                      <Toggle
                        enabled={masterEnabled}
                        disabled={!manageable}
                        onToggle={() => handleToggleMaster(entry)}
                        ariaLabel={masterEnabled ? t('mcp.masterDisable') : t('mcp.masterEnable')}
                      />
                    </label>
                    <label className="flex items-center gap-1" title={t('mcp.enabledByDefaultTitle')}>
                      <span className="text-[0.625rem] text-muted-foreground">{t('mcp.defaultOnShort')}</span>
                      <Toggle
                        enabled={entry.enabledByDefault}
                        disabled={!manageable}
                        onToggle={() => handleToggleDefault(entry)}
                        ariaLabel={entry.enabledByDefault ? t('mcp.disable') : t('mcp.enable')}
                      />
                    </label>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="shrink-0"
                      onClick={() => editor.openEdit(entry)}
                      disabled={!manageable}
                      aria-label={t('mcp.edit')}
                    >
                      <Icon name="edit-2" className="size-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="shrink-0 hover:text-destructive"
                      onClick={() => editor.setDeleteTarget(entry)}
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
        open={editor.deleteTarget !== null}
        onOpenChange={() => editor.setDeleteTarget(null)}
        title={t('mcp.deleteConfirm')}
        message={editor.deleteTarget ? t('mcp.deleteConfirmMessage', { name: editor.deleteTarget.name }) : ''}
        confirmLabel={t('common.delete')}
        variant="danger"
        icon="delete-bin"
        onConfirm={editor.handleDeleteConfirm}
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
      useMcpStore.getState().setNetworkPolicyLocal(next)
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
    <SettingsSection className="bg-background">
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

import { useState, useEffect, useRef } from 'react'
import { Icon } from '../icon/Icon'
import { useMcpStore } from '../../stores/mcpStore'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { ConfirmDialog } from '../ui/confirm-dialog'
import { Toggle } from '../ui/Toggle'
import { useNotification } from '@/hooks/useNotification'
import type {
  McpServerConfig,
  McpServerToolsSettings,
  McpModeAvailability,
  McpProbedTool,
} from '../../lib/api/synthApi'

const EMPTY_CONFIG: McpServerConfig = { type: 'stdio' }

export const McpSettings = () => {
  const { t } = useI18n()
  const { notify } = useNotification()
  const {
    servers, loading, error, fetchServers, addServer, updateServer, deleteServer, testServer,
    toolSettings, toolSettingsLoading, toolSettingsError,
    fetchToolSettings, updateToolAvailability, saveToolSettings, probeServer,
  } = useMcpStore()
  const [editing, setEditing] = useState<string | null>(null)
  const [formName, setFormName] = useState('')
  const [formConfig, setFormConfig] = useState<McpServerConfig>(EMPTY_CONFIG)
  const [testResult, setTestResult] = useState<string | null>(null)
  const [testSucceeded, setTestSucceeded] = useState<boolean | null>(null)
  const [testing, setTesting] = useState(false)

  // Delete confirmation state
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)

  // Доступность инструментов по режимам (W4c)
  const [probedTools, setProbedTools] = useState<Record<string, McpProbedTool[] | null>>({})
  const [probing, setProbing] = useState<Record<string, boolean>>({})
  const [probeError, setProbeError] = useState<Record<string, string | null>>({})
  const [savingSettings, setSavingSettings] = useState(false)
  const initialSettingsRef = useRef<Record<string, McpServerToolsSettings> | null>(null)
  const prevToolSettingsRef = useRef<typeof toolSettings>(null)

  useEffect(() => {
    fetchServers()
    fetchToolSettings()
  }, [fetchServers, fetchToolSettings])

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

  const openAdd = () => {
    setEditing('__new__')
    setFormName('')
    setFormConfig({ type: 'stdio' })
    setTestResult(null)
    setTestSucceeded(null)
  }

  const openEdit = (name: string) => {
    const entry = servers?.[name]
    if (!entry) return
    setEditing(name)
    setFormName(name)
    setFormConfig({ ...entry.config })
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
    try {
      if (editing === '__new__') {
        await addServer(formName.trim(), formConfig)
      } else {
        await updateServer(formName.trim(), formConfig)
      }
      closeForm()
    } catch {
      // ошибка уже в сторе
    }
  }

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return
    await deleteServer(deleteTarget)
    setDeleteTarget(null)
  }

  const handleToggle = async (name: string, currentConfig: McpServerConfig) => {
    await updateServer(name, { ...currentConfig, enabled: !currentConfig.enabled })
  }

  const handleTest = async () => {
    if (!formName.trim()) return
    setTesting(true)
    setTestResult(null)
    setTestSucceeded(null)
    const result = await testServer(formName.trim(), formConfig)
    setTesting(false)
    if (result.success) {
      setTestResult(t('mcp.testSuccess', { count: result.toolCount ?? 0 }))
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

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">{t('mcp.title')}</h2>
          {servers && (
            <p className="text-muted-foreground text-sm">{t('mcp.count', { count: Object.keys(servers).length })}</p>
          )}
        </div>
        <button
          onClick={openAdd}
          className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs bg-interactive-accent text-interactive-accent-foreground hover:opacity-90 transition-colors"
        >
          <Icon name="add" className="size-3.5" />
          {t('common.add')}
        </button>
      </div>
      <p className="text-sm text-muted-foreground">{t('mcp.description')}</p>

      {error && (
        <div className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm">{error}</div>
      )}

      {loading && servers === null && (
        <div className="text-center text-muted-foreground py-8">{t('common.loading')}</div>
      )}

      {/* Form */}
      {editing && (
        <div className="border border-border rounded-lg p-4 space-y-4">
          <h3 className="font-medium text-sm">
            {editing === '__new__' ? t('mcp.newServer') : t('mcp.editServer')}
          </h3>

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
              <label className="block text-xs font-medium text-muted-foreground mb-1">{t('mcp.type')}</label>
              <select
                value={formConfig.type}
                onChange={(e) => updateConfig({ type: e.target.value as 'stdio' | 'sse' })}
                className="w-full px-3 py-1.5 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="stdio">{t('mcp.type.stdio')}</option>
                <option value="sse">{t('mcp.type.sse')}</option>
              </select>
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
                  <label className="block text-xs font-medium text-muted-foreground mb-1">{t('mcp.env')}</label>
                  <textarea
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

            {formConfig.type === 'sse' && (
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
                checked={formConfig.enabledByDefault ?? false}
                onChange={(e) => updateConfig({ enabledByDefault: e.target.checked })}
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
                    : "bg-destructive/10 text-destructive"
                )}
              >
                {testResult}
              </div>
            )}
          </div>

          <div className="flex items-center gap-2 pt-2">
            <button
              onClick={handleSave}
              disabled={!formName.trim()}
              className="px-4 py-2 rounded-lg bg-interactive-accent text-interactive-accent-foreground text-sm font-medium hover:opacity-90 disabled:opacity-50"
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
            {editing !== '__new__' && (
              <button
                onClick={() => setDeleteTarget(formName.trim())}
                className="px-4 py-2 rounded-lg border border-destructive/40 text-destructive text-sm hover:bg-destructive/10 ml-auto"
              >
                {t('common.delete')}
              </button>
            )}
            <button
              onClick={closeForm}
              className="px-4 py-2 rounded-lg text-sm text-muted-foreground hover:text-foreground"
            >
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}

      {/* Server list */}
      {servers && Object.keys(servers).length === 0 && !editing && (
        <div className="text-center text-muted-foreground py-8">
          <Icon name="plug" className="size-8 mx-auto mb-2 opacity-40" />
          <p className="text-sm">{t('mcp.noServers')}</p>
        </div>
      )}

      {servers && Object.keys(servers).length > 0 && (
        <div className="space-y-2">
          {Object.entries(servers).map(([name, entry]) => (
            <div
              key={name}
              className={cn(
                "flex items-center gap-3 p-3 rounded-lg border border-border hover:border-interactive-accent/50 transition-colors",
                entry.config.enabled === false && "opacity-50"
              )}
            >
              <span
                title={entry.config.enabledByDefault ? t('mcp.enabledByDefaultTitle') : t('mcp.disabledByDefaultTitle')}
              >
                <Icon
                  name="checkbox"
                  className={cn(
                    "size-4 shrink-0",
                    entry.config.enabledByDefault ? "text-interactive-accent" : "text-muted-foreground/40"
                  )}
                />
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">{name}</div>
                <div className="text-xs text-muted-foreground">
                  {entry.config.type === 'stdio'
                    ? `stdio: ${entry.config.command || '?'}`
                    : `sse: ${entry.config.url || '?'}`}
                  {entry.config.enabledByDefault && ` · ${t('mcp.autoEnabled')}`}
                </div>
              </div>
              <button
                onClick={() => handleToggle(name, entry.config)}
                role="switch"
                aria-checked={entry.config.enabled !== false}
                aria-label={entry.config.enabled !== false ? t('mcp.disable') : t('mcp.enable')}
                className={cn(
                  "relative w-9 h-5 rounded-full transition-colors shrink-0",
                  entry.config.enabled !== false ? 'bg-primary' : 'bg-muted-foreground/20'
                )}
              >
                <span className={cn(
                  "block size-3.5 rounded-full bg-card shadow-sm transition-transform",
                  entry.config.enabled !== false ? 'translate-x-[19px]' : 'translate-x-[3px]'
                )} />
              </button>
              <button
                onClick={() => openEdit(name)}
                className="p-1.5 rounded-lg hover:bg-interactive-hover text-muted-foreground hover:text-foreground transition-colors"
                aria-label={t('mcp.edit')}
              >
                <Icon name="edit-2" className="size-4" />
              </button>
              <button
                onClick={() => setDeleteTarget(name)}
                className="p-1.5 rounded-lg hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                aria-label={t('mcp.delete')}
              >
                <Icon name="delete-bin" className="size-4" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Доступность инструментов по режимам (W4c) */}
      <div className="border-t border-border pt-4 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold">{t('mcp.permissions.title')}</h3>
            <p className="text-sm text-muted-foreground">{t('mcp.permissions.description')}</p>
          </div>
          {toolSettings && Object.keys(toolSettings).length > 0 && (
            <button
              onClick={handleSaveSettings}
              disabled={!dirty || savingSettings || toolSettingsLoading}
              className="shrink-0 px-4 py-2 rounded-lg bg-interactive-accent text-interactive-accent-foreground text-sm font-medium hover:opacity-90 disabled:opacity-50"
            >
              {savingSettings ? t('mcp.permissions.saving') : t('mcp.permissions.save')}
            </button>
          )}
        </div>

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

        {toolSettings && Object.keys(toolSettings).length === 0 && !toolSettingsLoading && (
          <div className="text-center text-muted-foreground py-6 text-sm">
            {t('mcp.permissions.noServerSettings')}
          </div>
        )}

        {toolSettings && Object.keys(toolSettings).length > 0 && (
          <div className="space-y-2">
            {Object.entries(toolSettings).map(([name, entry]) => (
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
      </div>

      {/* Delete confirmation */}
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={() => setDeleteTarget(null)}
        title={t('mcp.deleteConfirm')}
        message={deleteTarget ? t('mcp.deleteConfirmMessage', { name: deleteTarget }) : ''}
        confirmLabel={t('common.delete')}
        variant="danger"
        icon="delete-bin"
        onConfirm={handleDeleteConfirm}
      />
    </div>
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
          <Icon name="plug" className="size-3.5" />
          {probing ? t('mcp.permissions.probing') : t('mcp.permissions.probe')}
        </button>
      </div>

      {probeError && (
        <div className="p-2 rounded bg-destructive/10 text-destructive text-xs">{probeError}</div>
      )}

      {/* Default для всех инструментов */}
      <div className="flex items-center justify-between gap-3 rounded-lg bg-interactive-hover/50 px-3 py-2">
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
                      "flex items-center justify-between gap-3 px-3 py-2 rounded-lg border border-border/60",
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
        <Toggle enabled={availability.plan} onToggle={() => onToggle('plan', !availability.plan)} />
      </label>
      <label className="flex items-center gap-1.5 cursor-pointer">
        <span className="text-xs text-muted-foreground">{t('mcp.permissions.mode.act')}</span>
        <Toggle enabled={availability.act} onToggle={() => onToggle('act', !availability.act)} />
      </label>
    </div>
  )
}

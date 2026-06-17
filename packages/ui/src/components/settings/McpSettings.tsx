import { useState, useEffect } from 'react'
import { Icon } from '../icon/Icon'
import { useMcpStore } from '../../stores/mcpStore'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import type { McpServerConfig } from '../../lib/api/synthApi'

const EMPTY_CONFIG: McpServerConfig = { type: 'stdio' }

export const McpSettings = () => {
  const { t } = useI18n()
  const { servers, loading, error, fetchServers, addServer, updateServer, deleteServer, testServer } = useMcpStore()
  const [editing, setEditing] = useState<string | null>(null)
  const [formName, setFormName] = useState('')
  const [formConfig, setFormConfig] = useState<McpServerConfig>(EMPTY_CONFIG)
  const [testResult, setTestResult] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)

  useEffect(() => {
    fetchServers()
  }, [fetchServers])

  const openAdd = () => {
    setEditing('__new__')
    setFormName('')
    setFormConfig({ type: 'stdio' })
    setTestResult(null)
  }

  const openEdit = (name: string) => {
    const entry = servers?.[name]
    if (!entry) return
    setEditing(name)
    setFormName(name)
    setFormConfig({ ...entry.config })
    setTestResult(null)
  }

  const closeForm = () => {
    setEditing(null)
    setTestResult(null)
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

  const handleDelete = async (name: string) => {
    if (!confirm(`Удалить MCP-сервер "${name}"?`)) return
    await deleteServer(name)
  }

  const handleToggle = async (name: string, currentConfig: McpServerConfig) => {
    await updateServer(name, { ...currentConfig, enabled: !currentConfig.enabled })
  }

  const handleTest = async () => {
    if (!formName.trim()) return
    setTesting(true)
    setTestResult(null)
    const result = await testServer(formName.trim(), formConfig)
    setTesting(false)
    if (result.success) {
      setTestResult(`Подключение успешно. Инструментов: ${result.toolCount ?? 0}`)
    } else {
      setTestResult(`Ошибка: ${result.error ?? 'неизвестная ошибка'}`)
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
          className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs bg-blue-600 text-white hover:bg-blue-700 transition-colors"
        >
          <Icon name="add" className="size-3.5" />
          {t('common.add')}
        </button>
      </div>
      <p className="text-sm text-muted-foreground">{t('mcp.description')}</p>

      {error && (
        <div className="p-3 rounded-lg bg-red-900/20 text-red-400 text-sm">{error}</div>
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
                className={`p-2 rounded text-sm ${
                  testResult.startsWith('Подключение успешно')
                    ? 'bg-green-900/20 text-green-400'
                    : 'bg-red-900/20 text-red-400'
                }`}
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
                onClick={() => handleDelete(formName.trim())}
                className="px-4 py-2 rounded-lg border border-red-900/40 text-red-400 text-sm hover:bg-red-900/20 ml-auto"
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
                title={entry.config.enabledByDefault ? 'Включён по умолчанию' : 'Не включён по умолчанию'}
              >
                <Icon
                  name="checkbox"
                  className={cn(
                    "size-4 shrink-0",
                    entry.config.enabledByDefault ? "text-green-500" : "text-gray-500"
                  )}
                />
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">{name}</div>
                <div className="text-xs text-muted-foreground">
                  {entry.config.type === 'stdio'
                    ? `stdio: ${entry.config.command || '?'}`
                    : `sse: ${entry.config.url || '?'}`}
                  {entry.config.enabledByDefault && ' · авто'}
                </div>
              </div>
              <button
                onClick={() => handleToggle(name, entry.config)}
                className={cn(
                  "relative w-9 h-5 rounded-full transition-colors shrink-0",
                  entry.config.enabled !== false ? 'bg-blue-600' : 'bg-slate-300 dark:bg-slate-600'
                )}
                title={entry.config.enabled !== false ? 'Отключить' : 'Включить'}
              >
                <span className={cn(
                  "absolute top-0.5 size-4 rounded-full bg-white transition-all shadow-sm",
                  entry.config.enabled !== false ? 'right-0.5' : 'left-0.5'
                )} />
              </button>
              <button
                onClick={() => openEdit(name)}
                className="p-1.5 rounded-lg hover:bg-interactive-hover text-muted-foreground hover:text-foreground transition-colors"
                title="Редактировать"
              >
                <Icon name="edit-2" className="size-4" />
              </button>
              <button
                onClick={() => handleDelete(name)}
                className="p-1.5 rounded-lg hover:bg-red-900/20 text-muted-foreground hover:text-red-400 transition-colors"
                title="Удалить"
              >
                <Icon name="delete-bin" className="size-4" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

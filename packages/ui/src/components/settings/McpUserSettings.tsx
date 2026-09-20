import { useEffect, useState } from 'react'
import type { McpRegistryEntry } from '@itphx/synth-shared'
import { useI18n } from '@/lib/i18n'
import { useMcpStore } from '@/stores/mcpStore'
import { useAuthStore } from '@/stores/authStore'
import { useNotification } from '@/hooks/useNotification'
import { Icon } from '../icon/Icon'
import { ConfirmDialog } from '../ui/confirm-dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { SettingsPage, SettingsCard } from './settings-layout'
import { cn } from '@/lib/utils'
import type { McpServerConfig } from '@/lib/api/synthApi'

const EMPTY_CONFIG: McpServerConfig = { type: 'http' }

/**
 * AD-071 §2.5: пользовательская часть MCP — собственные HTTP-серверы
 * (категория `mcp`). Реестр целиком, stdio, enabledByDefault, сетевой доступ,
 * permissions и tools.disabled — в админ-категории `mcpAdmin`.
 */
export function McpUserSettings() {
  const { t } = useI18n()
  const { notify } = useNotification()
  const {
    registry,
    loading,
    error,
    fetchRegistry,
    addRegistryEntry,
    updateRegistryEntry,
    deleteRegistryEntry,
  } = useMcpStore()
  const userId = useAuthStore((s) => s.user?.id)

  const [editing, setEditing] = useState<string | null>(null)
  const [formName, setFormName] = useState('')
  const [formConfig, setFormConfig] = useState<McpServerConfig>(EMPTY_CONFIG)
  const [deleteTarget, setDeleteTarget] = useState<McpRegistryEntry | null>(null)
  const [savingForm, setSavingForm] = useState(false)

  useEffect(() => {
    void fetchRegistry()
  }, [fetchRegistry])

  const ownEntries = (registry ?? []).filter(
    (entry) => entry.origin === 'user' && !!entry.author?.userId && entry.author.userId === userId,
  )

  const openAdd = () => {
    setEditing('__new__')
    setFormName('')
    setFormConfig({ type: 'http' })
  }

  const openEdit = (entry: McpRegistryEntry) => {
    setEditing(entry.id)
    setFormName(entry.name)
    setFormConfig({ ...entry.config })
  }

  const closeForm = () => setEditing(null)

  const handleSave = async () => {
    if (!formName.trim()) return
    setSavingForm(true)
    try {
      if (editing === '__new__') {
        await addRegistryEntry({ name: formName.trim(), config: formConfig })
      } else if (editing) {
        await updateRegistryEntry(editing, { name: formName.trim(), config: formConfig })
      }
      closeForm()
    } catch (err) {
      notify({
        text: t('mcp.user.saveError', { error: err instanceof Error ? err.message : 'unknown' }),
        type: 'error',
        category: 'error',
      })
    } finally {
      setSavingForm(false)
    }
  }

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return
    try {
      await deleteRegistryEntry(deleteTarget.id)
    } catch (err) {
      notify({
        text: t('mcp.user.saveError', { error: err instanceof Error ? err.message : 'unknown' }),
        type: 'error',
        category: 'error',
      })
    }
    setDeleteTarget(null)
  }

  return (
    <SettingsPage stickyHeader title={t('mcp.user.title')} description={t('mcp.user.description')}>
      {error && <div className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm">{error}</div>}

      <div className="grid gap-4">
        {editing && (
          <SettingsCard title={editing === '__new__' ? t('mcp.newServer') : t('mcp.editServer')}>
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
                  onChange={(e) => setFormConfig((prev) => ({ ...prev, description: e.target.value || undefined }))}
                  rows={2}
                  className="w-full px-3 py-2 rounded-lg bg-interactive-input border border-border text-sm focus:outline-none focus:border-interactive-accent"
                  placeholder={t('mcp.serverDescriptionPlaceholder')}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">{t('mcp.type')}</label>
                <Select
                  value={formConfig.type}
                  onValueChange={(value) => setFormConfig((prev) => ({ ...prev, type: value as McpServerConfig['type'] }))}
                >
                  <SelectTrigger className="w-full" aria-label={t('mcp.type')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="http">{t('mcp.type.http')}</SelectItem>
                    <SelectItem value="sse">{t('mcp.type.sse.legacy')}</SelectItem>
                  </SelectContent>
                </Select>
                <p className="mt-1 text-[0.625rem] text-muted-foreground/70">{t('mcp.user.httpOnly')}</p>
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">{t('mcp.url')}</label>
                <input
                  type="text"
                  value={formConfig.url || ''}
                  onChange={(e) => setFormConfig((prev) => ({ ...prev, url: e.target.value }))}
                  className="w-full px-3 py-2 rounded-lg bg-interactive-input border border-border text-sm focus:outline-none focus:border-interactive-accent"
                  placeholder="http://localhost:8765/mcp"
                />
              </div>
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
                onClick={closeForm}
                className="px-4 py-2 rounded-lg text-sm text-muted-foreground hover:text-foreground ml-auto"
              >
                {t('common.cancel')}
              </button>
            </div>
          </SettingsCard>
        )}

        <SettingsCard>
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-medium text-foreground">
              {registry ? t('mcp.count', { count: ownEntries.length }) : ''}
            </span>
            <button
              data-testid="mcp-user-add"
              onClick={openAdd}
              className="shrink-0 flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs bg-interactive-accent text-interactive-accent-foreground hover:opacity-90 transition-[transform,opacity] duration-150 ease-out active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Icon name="add" className="size-3.5" />
              {t('common.add')}
            </button>
          </div>

          {loading && registry === null && (
            <div className="text-center text-muted-foreground py-8">{t('common.loading')}</div>
          )}

          {registry && ownEntries.length === 0 && !editing && (
            <div className="text-center text-muted-foreground py-8">
              <Icon name="server" className="size-8 mx-auto mb-2 opacity-40" />
              <p className="text-sm">{t('mcp.user.empty')}</p>
            </div>
          )}

          {ownEntries.length > 0 && (
            <div className="space-y-2" data-testid="mcp-user-list">
              {ownEntries.map((entry) => (
                <div
                  key={entry.id}
                  data-testid={`mcp-user-${entry.name}`}
                  className={cn(
                    'flex items-center gap-3 p-3 rounded-lg border border-border hover:border-interactive-accent/50 transition-colors',
                    entry.config.enabled === false && 'opacity-50',
                  )}
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{entry.name}</div>
                    {entry.config.description && (
                      <div className="text-xs text-muted-foreground truncate" title={entry.config.description}>
                        {entry.config.description}
                      </div>
                    )}
                    <div className="text-xs text-muted-foreground">
                      {entry.config.type}: {entry.config.url || '?'}
                    </div>
                  </div>
                  <button
                    onClick={() => openEdit(entry)}
                    className="p-1.5 rounded-lg hover:bg-interactive-hover text-muted-foreground hover:text-foreground transition-colors"
                    aria-label={t('mcp.edit')}
                  >
                    <Icon name="edit-2" className="size-4" />
                  </button>
                  <button
                    onClick={() => setDeleteTarget(entry)}
                    className="p-1.5 rounded-lg hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                    aria-label={t('mcp.delete')}
                  >
                    <Icon name="delete-bin" className="size-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </SettingsCard>
      </div>

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

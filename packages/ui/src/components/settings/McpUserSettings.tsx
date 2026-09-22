import { useEffect, useState } from 'react'
import type { McpRegistryEntry } from '@itphx/synth-shared'
import { useI18n } from '@/lib/i18n'
import { useMcpStore } from '@/stores/mcpStore'
import { useAuthStore } from '@/stores/authStore'
import { useNotification } from '@/hooks/useNotification'
import { Icon } from '../icon/Icon'
import { Button } from '../ui/button'
import { ConfirmDialog } from '../ui/confirm-dialog'
import { SelectContent, SelectItem } from '../ui/select'
import {
  SelectField,
  SettingsActions,
  SettingsPanel,
  SettingsSection,
  TextArea,
  TextField,
} from '../ui/settings'
import { cn } from '@/lib/utils'
import type { McpServerConfig } from '@/lib/api/synthApi'

const EMPTY_CONFIG: McpServerConfig = { type: 'http' }

/**
 * AD-071 §2.5 / AD-072: пользовательская часть MCP — собственные HTTP-серверы
 * (категория `mcp`). Реестр целиком, stdio, enabledByDefault, сетевой доступ,
 * permissions и tools.disabled — в админ-категории `mcpAdmin`.
 */
export function McpUserSettings() {
  const { t } = useI18n()
  const { notify } = useNotification()
  const registry = useMcpStore(s => s.registry)
  const loading = useMcpStore(s => s.loading)
  const error = useMcpStore(s => s.error)
  const fetchRegistry = useMcpStore(s => s.fetchRegistry)
  const addRegistryEntry = useMcpStore(s => s.addRegistryEntry)
  const updateRegistryEntry = useMcpStore(s => s.updateRegistryEntry)
  const deleteRegistryEntry = useMcpStore(s => s.deleteRegistryEntry)
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
    <SettingsPanel
      title={t('mcp.user.title')}
      description={t('mcp.user.description')}
      meta={registry ? t('mcp.count', { count: ownEntries.length }) : undefined}
      actions={
        <Button data-testid="mcp-user-add" onClick={openAdd}>
          <Icon name="add" className="size-3.5" />
          {t('common.add')}
        </Button>
      }
    >
      {error && <div className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm">{error}</div>}

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
            onChange={(e) => setFormConfig((prev) => ({ ...prev, description: e.target.value || undefined }))}
            rows={2}
            placeholder={t('mcp.serverDescriptionPlaceholder')}
          />
          <SelectField
            label={t('mcp.type')}
            description={t('mcp.user.httpOnly')}
            value={formConfig.type}
            onValueChange={(value) => setFormConfig((prev) => ({ ...prev, type: value as McpServerConfig['type'] }))}
            ariaLabel={t('mcp.type')}
          >
            <SelectContent>
              <SelectItem value="http">{t('mcp.type.http')}</SelectItem>
              <SelectItem value="sse">{t('mcp.type.sse.legacy')}</SelectItem>
            </SelectContent>
          </SelectField>
          <TextField
            label={t('mcp.url')}
            value={formConfig.url || ''}
            onChange={(e) => setFormConfig((prev) => ({ ...prev, url: e.target.value }))}
            placeholder="http://localhost:8765/mcp"
          />
          <SettingsActions
            onSave={handleSave}
            onCancel={closeForm}
            saving={savingForm}
            saveDisabled={!formName.trim()}
          />
        </SettingsSection>
      )}

      <SettingsSection>
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
                  'flex flex-wrap items-center gap-3 p-3 rounded-lg border border-border hover:border-primary/50 transition-colors',
                  entry.config.enabled === false && 'opacity-50',
                )}
              >
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium break-words">{entry.name}</div>
                  {entry.config.description && (
                    <div className="text-xs text-muted-foreground truncate" title={entry.config.description}>
                      {entry.config.description}
                    </div>
                  )}
                  <div className="text-xs text-muted-foreground break-words">
                    {entry.config.type}: {entry.config.url || '?'}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="shrink-0"
                    onClick={() => openEdit(entry)}
                    aria-label={t('mcp.edit')}
                  >
                    <Icon name="edit-2" className="size-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="shrink-0 hover:text-destructive"
                    onClick={() => setDeleteTarget(entry)}
                    aria-label={t('mcp.delete')}
                  >
                    <Icon name="delete-bin" className="size-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </SettingsSection>

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

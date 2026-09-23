import { useEffect } from 'react'
import { useI18n } from '@/lib/i18n'
import { useMcpStore } from '@/stores/mcpStore'
import { useAuthStore } from '@/stores/authStore'
import { useNotification } from '@/hooks/useNotification'
import { Icon } from '../icon/Icon'
import { Button } from '../ui/button'
import { ConfirmDialog } from '../ui/confirm-dialog'
import {
  SettingsPanel,
  SettingsSection,
} from '../ui/settings'
import { cn } from '@/lib/utils'
import { McpRegistryForm } from './McpRegistryForm'
import { useMcpRegistryEditor } from './useMcpRegistryEditor'

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

  useEffect(() => {
    void fetchRegistry()
  }, [fetchRegistry])

  const editor = useMcpRegistryEditor({
    addEntry: ({ name, config }) => addRegistryEntry({ name, config }),
    updateEntry: (id, { name, config }) => updateRegistryEntry(id, { name, config }),
    deleteEntry: deleteRegistryEntry,
    onError: (message) => {
      notify({
        text: t('mcp.user.saveError', { error: message }),
        type: 'error',
        category: 'error',
      })
    },
  })

  const ownEntries = (registry ?? []).filter(
    (entry) => entry.origin === 'user' && !!entry.author?.userId && entry.author.userId === userId,
  )

  return (
    <SettingsPanel
      title={t('mcp.user.title')}
      description={t('mcp.user.description')}
      meta={registry ? t('mcp.count', { count: ownEntries.length }) : undefined}
      actions={
        <Button data-testid="mcp-user-add" onClick={editor.openAdd}>
          <Icon name="add" className="size-3.5" />
          {t('common.add')}
        </Button>
      }
    >
      {error && <div className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm">{error}</div>}

      {editor.editing && (
        <McpRegistryForm
          title={editor.editing === '__new__' ? t('mcp.newServer') : t('mcp.editServer')}
          editing={editor.editing !== '__new__'}
          name={editor.formName}
          onNameChange={editor.setFormName}
          config={editor.formConfig}
          onConfigChange={editor.updateConfig}
          allowStdio={false}
          typeDescription={t('mcp.user.httpOnly')}
          saving={editor.savingForm}
          onSave={editor.handleSave}
          onCancel={editor.closeForm}
        />
      )}

      <SettingsSection>
        {loading && registry === null && (
          <div className="text-center text-muted-foreground py-8">{t('common.loading')}</div>
        )}

        {registry && ownEntries.length === 0 && !editor.editing && (
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
                    onClick={() => editor.openEdit(entry)}
                    aria-label={t('mcp.edit')}
                  >
                    <Icon name="edit-2" className="size-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="shrink-0 hover:text-destructive"
                    onClick={() => editor.setDeleteTarget(entry)}
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

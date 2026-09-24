import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  synthApi,
  type AgentInfo,
  type SSHKeyCreateBody,
  type SSHKeyMetaData,
  type SSHKeyUpdateBody,
} from '@/lib/api/synthApi'
import { useI18n } from '@/lib/i18n'
import { useNotification } from '@/hooks/useNotification'
import { cn } from '@/lib/utils'
import { Icon } from '../icon/Icon'
import { Button } from '../ui/button'
import { ConfirmDialog } from '../ui/confirm-dialog'
import { SettingsField, SettingsSection, TextArea, TextField } from '../ui/settings'

type EditorMode = 'create' | 'edit'

interface EditorState {
  mode: EditorMode
  id?: string
  name: string
  type: string
  privateKey: string
  passphrase: string
  agentIds: string[]
}

interface EditorErrors {
  name?: string
  privateKey?: string
}

const EMPTY_EDITOR: EditorState = {
  mode: 'create',
  name: '',
  type: 'user',
  privateKey: '',
  passphrase: '',
  agentIds: [],
}

/**
 * AD-076 / AD-072: секция «SSH-ключи» (реестр per-agent ключей для git).
 * Встраивается в раздел «Агенты» (`AgentsPanel`) как самостоятельная секция без
 * собственного скролл-контейнера, поэтому строится на `SettingsSection`.
 *
 * Секреты (`privateKey`/`passphrase`) API не отдаёт — компонент работает только с
 * `SSHKeyMetaData` и никогда не рендерит приватный ключ после сохранения.
 */
export function SshKeysSettings() {
  const { t } = useI18n()
  const { notify } = useNotification()

  const [keys, setKeys] = useState<SSHKeyMetaData[] | null>(null)
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [formErrors, setFormErrors] = useState<EditorErrors>({})
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<SSHKeyMetaData | null>(null)

  const describeError = useCallback(
    (err: unknown, ctx?: { name?: string; id?: string }): string => {
      const code = (err as { code?: string } | null | undefined)?.code
      if (code === 'sshkey.name_exists') return t('sshKeys.nameExists', { name: ctx?.name ?? '' })
      if (code === 'sshkey.not_found') return t('sshkey.not_found', { id: ctx?.id ?? '' })
      return err instanceof Error ? err.message : t('common.error')
    },
    [t],
  )

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const [loadedKeys, agentsResponse] = await Promise.all([
        synthApi.listSshKeys(),
        synthApi.getAllAgents().catch(() => ({ agents: [] as AgentInfo[], default_agent: null })),
      ])
      setKeys(loadedKeys)
      setAgents(agentsResponse.agents ?? [])
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : t('sshKeys.loadError'))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    void load()
  }, [load])

  const agentName = useCallback(
    (id: string): string => agents.find((a) => a.id === id)?.display_name ?? id,
    [agents],
  )

  const linkedAgentsLabel = useCallback(
    (key: SSHKeyMetaData): string =>
      key.agentIds.length > 0 ? key.agentIds.map(agentName).join(', ') : t('sshKeys.noLinkedAgents'),
    [agentName, t],
  )

  const openCreate = () => {
    setFormErrors({})
    setSaveError(null)
    setEditor({ ...EMPTY_EDITOR, agentIds: [] })
  }

  const openEdit = (key: SSHKeyMetaData) => {
    setFormErrors({})
    setSaveError(null)
    setEditor({
      mode: 'edit',
      id: key.id,
      name: key.name,
      type: key.type ?? 'user',
      privateKey: '',
      passphrase: '',
      agentIds: [...key.agentIds],
    })
  }

  const closeEditor = () => {
    setEditor(null)
    setFormErrors({})
    setSaveError(null)
  }

  const toggleAgent = (agentId: string) => {
    setEditor((prev) =>
      prev
        ? {
            ...prev,
            agentIds: prev.agentIds.includes(agentId)
              ? prev.agentIds.filter((id) => id !== agentId)
              : [...prev.agentIds, agentId],
          }
        : prev,
    )
  }

  const validate = (state: EditorState): EditorErrors => {
    const errors: EditorErrors = {}
    if (!state.name.trim()) errors.name = t('sshKeys.error.nameRequired')
    if (state.mode === 'create' && !state.privateKey.trim()) {
      errors.privateKey = t('sshKeys.error.keyRequired')
    }
    return errors
  }

  const handleSave = async () => {
    if (!editor) return
    const errors = validate(editor)
    setFormErrors(errors)
    if (Object.keys(errors).length > 0) return

    setSaving(true)
    setSaveError(null)
    try {
      const base = {
        name: editor.name.trim(),
        type: editor.type.trim() || undefined,
        agentIds: editor.agentIds,
      }
      if (editor.mode === 'create') {
        const body: SSHKeyCreateBody = {
          ...base,
          privateKey: editor.privateKey,
          passphrase: editor.passphrase.trim() || undefined,
        }
        await synthApi.createSshKey(body)
      } else {
        const body: SSHKeyUpdateBody = { ...base }
        // Пустое поле приватного ключа = не менять секрет.
        if (editor.privateKey.trim()) {
          body.privateKey = editor.privateKey
          body.passphrase = editor.passphrase.trim() || undefined
        }
        await synthApi.updateSshKey(editor.id!, body)
      }
      await load()
      closeEditor()
      notify({ text: t('sshKeys.saved'), type: 'success', category: 'system' })
    } catch (err) {
      const message = describeError(err, { name: editor.name.trim(), id: editor.id })
      setSaveError(message)
      notify({ text: t('sshKeys.saveError', { error: message }), type: 'error', category: 'error' })
    } finally {
      setSaving(false)
    }
  }

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return
    try {
      await synthApi.deleteSshKey(deleteTarget.id)
      await load()
      notify({ text: t('sshKeys.deleted'), type: 'success', category: 'system' })
    } catch (err) {
      const message = describeError(err, { id: deleteTarget.id })
      notify({ text: t('sshKeys.deleteError', { error: message }), type: 'error', category: 'error' })
    } finally {
      setDeleteTarget(null)
    }
  }

  const orderedAgents = useMemo(
    () => [...agents].sort((a, b) => a.display_name.localeCompare(b.display_name)),
    [agents],
  )

  return (
    <>
      <SettingsSection
        title={t('sshKeys.title')}
        description={t('sshKeys.description')}
        actions={
          <Button data-testid="ssh-keys-add" onClick={openCreate}>
            <Icon name="add" className="size-3.5" />
            {t('sshKeys.add')}
          </Button>
        }
      >
        {loadError && (
          <div role="alert" className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
            {loadError}
          </div>
        )}

        {editor && (
          <div
            className="w-full min-w-0 rounded-xl border border-border/60 bg-background/40 p-4 space-y-3"
            data-testid="ssh-key-editor"
          >
            <h4 className="text-sm font-medium text-foreground break-words">
              {editor.mode === 'create' ? t('sshKeys.new') : t('sshKeys.edit')}
            </h4>

            {saveError && (
              <div role="alert" className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
                {saveError}
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <TextField
                label={t('sshKeys.name')}
                value={editor.name}
                onChange={(e) => setEditor((prev) => (prev ? { ...prev, name: e.target.value } : prev))}
                error={formErrors.name}
                id="ssh-key-name"
                data-testid="ssh-key-name"
              />
              <TextField
                label={t('sshKeys.type')}
                description={t('sshKeys.typeHint')}
                value={editor.type}
                onChange={(e) => setEditor((prev) => (prev ? { ...prev, type: e.target.value } : prev))}
                placeholder="user"
                id="ssh-key-type"
                data-testid="ssh-key-type"
              />
            </div>

            <TextArea
              label={t('sshKeys.privateKey')}
              description={editor.mode === 'edit' ? t('sshKeys.replaceKeyHint') : undefined}
              value={editor.privateKey}
              onChange={(e) => setEditor((prev) => (prev ? { ...prev, privateKey: e.target.value } : prev))}
              error={formErrors.privateKey}
              mono
              rows={5}
              id="ssh-key-private"
              data-testid="ssh-key-private"
              placeholder={'-----BEGIN OPENSSH PRIVATE KEY-----'}
            />

            <TextField
              label={t('sshKeys.passphrase')}
              value={editor.passphrase}
              onChange={(e) => setEditor((prev) => (prev ? { ...prev, passphrase: e.target.value } : prev))}
              type="password"
              autoComplete="new-password"
              id="ssh-key-passphrase"
              data-testid="ssh-key-passphrase"
            />

            <SettingsField label={t('sshKeys.agents')} description={t('sshKeys.agentsHint')}>
              {orderedAgents.length === 0 ? (
                <p className="text-xs text-muted-foreground italic">{t('sshKeys.noAgents')}</p>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 min-w-0">
                  {orderedAgents.map((agent) => {
                    const checked = editor.agentIds.includes(agent.id)
                    return (
                      <label
                        key={agent.id}
                        className={cn(
                          'flex min-h-10 items-center gap-2 rounded-lg border border-border/60 px-2.5 py-1.5 cursor-pointer min-w-0',
                          'transition-colors duration-150 ease-out hover:bg-interactive-hover/50',
                          'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring',
                          checked && 'bg-interactive-hover/30',
                        )}
                      >
                        <input
                          type="checkbox"
                          data-testid={`ssh-key-agent-${agent.id}`}
                          checked={checked}
                          onChange={() => toggleAgent(agent.id)}
                          className="size-4 shrink-0 accent-primary focus-visible:outline-none"
                          aria-label={agent.display_name}
                        />
                        <span className="text-xs min-w-0 break-words">{agent.display_name}</span>
                      </label>
                    )
                  })}
                </div>
              )}
            </SettingsField>

            <div className="flex flex-wrap items-center gap-2 justify-end">
              <Button
                variant="primary"
                onClick={() => void handleSave()}
                disabled={saving}
                data-testid="ssh-key-save"
              >
                {saving ? t('common.saving') : t('common.save')}
              </Button>
              <Button
                variant="outline-muted"
                onClick={closeEditor}
                disabled={saving}
                data-testid="ssh-key-cancel"
              >
                {t('common.cancel')}
              </Button>
            </div>
          </div>
        )}

        {loading && keys === null && (
          <div className="text-center text-muted-foreground py-6 text-sm">{t('common.loading')}</div>
        )}

        {keys && keys.length === 0 && !editor && (
          <div className="text-center text-muted-foreground py-6">
            <Icon name="key" className="size-8 mx-auto mb-2 opacity-40" />
            <p className="text-sm">{t('sshKeys.empty')}</p>
          </div>
        )}

        {keys && keys.length > 0 && (
          <div className="space-y-2 min-w-0" data-testid="ssh-keys-list">
            {keys.map((key) => (
              <div
                key={key.id}
                data-testid={`ssh-key-${key.id}`}
                className="flex flex-wrap items-start gap-3 p-3 rounded-lg border border-border hover:border-primary/50 transition-colors min-w-0"
              >
                <div className="flex-1 min-w-0 space-y-1">
                  <div className="flex items-center gap-1.5 flex-wrap min-w-0">
                    <Icon name="key" className="size-4 shrink-0 text-muted-foreground" />
                    <span className="text-sm font-medium break-words">{key.name}</span>
                    {key.type && (
                      <span className="rounded px-1.5 py-0.5 text-[0.625rem] font-medium bg-muted text-muted-foreground">
                        {key.type}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground break-words">
                    <span className="font-medium">{t('sshKeys.linkedAgents')}:</span> {linkedAgentsLabel(key)}
                  </div>
                  <div className="text-[0.6875rem] text-muted-foreground">
                    {t('sshKeys.createdAt')}: {formatDate(key.createdAt)}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="shrink-0 min-h-10 min-w-10"
                    onClick={() => openEdit(key)}
                    title={t('common.edit')}
                    aria-label={t('common.edit')}
                    data-testid={`ssh-key-edit-${key.id}`}
                  >
                    <Icon name="edit-2" className="size-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="shrink-0 min-h-10 min-w-10 hover:text-destructive"
                    onClick={() => setDeleteTarget(key)}
                    title={t('common.delete')}
                    aria-label={t('common.delete')}
                    data-testid={`ssh-key-delete-${key.id}`}
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
        title={t('sshKeys.deleteTitle')}
        message={deleteTarget ? t('sshKeys.deleteConfirm', { name: deleteTarget.name }) : ''}
        confirmLabel={t('common.delete')}
        variant="danger"
        icon="delete-bin"
        onConfirm={() => void handleDeleteConfirm()}
      >
        {deleteTarget && deleteTarget.agentIds.length > 0 && (
          <p className="text-xs text-muted-foreground min-w-0 break-words">
            {t('sshKeys.deleteConfirmAgents', { agents: linkedAgentsLabel(deleteTarget) })}
          </p>
        )}
      </ConfirmDialog>
    </>
  )
}

/** Дата создания в коротком виде; при некорректном значении возвращает исходное. */
function formatDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleDateString()
}

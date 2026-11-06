import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  synthApi,
  type AgentInfo,
  type SSHKeyCreateBody,
  type SSHKeyMetaData,
  type SSHKeyUpdateBody,
  type SSHKeyUsage,
  type SshMode,
  type SshSettings,
} from '@/lib/api/synthApi'
import { useI18n } from '@/lib/i18n'
import { useNotification } from '@/hooks/useNotification'
import { cn } from '@/lib/utils'
import { Icon } from '../icon/Icon'
import { Button } from '../ui/button'
import { ConfirmDialog } from '../ui/confirm-dialog'
import { TooltipProvider } from '../ui/tooltip'
import { ListField, SettingsField, SettingsSection, TextArea, TextField } from '../ui/settings'

type EditorMode = 'create' | 'edit'

/** PROP-124: способы использования ключа — выбор в форме ключа. */
const USAGE_OPTIONS: readonly SSHKeyUsage[] = ['git', 'ssh']

interface EditorState {
  mode: EditorMode
  id?: string
  name: string
  privateKey: string
  passphrase: string
  agentIds: string[]
  usages: SSHKeyUsage[]
  allowHosts: string[]
  allowPorts: string[]
}

interface EditorErrors {
  name?: string
  privateKey?: string
  /** PROP-124: не выбрано ни одного назначения ключа (пустой `usages`). */
  usages?: string
}

const EMPTY_EDITOR: EditorState = {
  mode: 'create',
  name: '',
  privateKey: '',
  passphrase: '',
  agentIds: [],
  usages: ['git'],
  allowHosts: [],
  allowPorts: [],
}

/**
 * ADR-076 / ADR-072: секция «SSH-ключи» (реестр per-agent ключей для git).
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
  // PROP-124: режим инстанса (`tools`|`agent`) — переключатель в шапке секции.
  const [settings, setSettings] = useState<SshSettings | null>(null)
  const [modeSaving, setModeSaving] = useState(false)

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

  // PROP-124: режим инстанса (`tools`|`agent`) — отдельный запрос; ошибка не
  // ломает список ключей (режим просто остаётся дефолтным).
  useEffect(() => {
    let cancelled = false
    void synthApi
      .getSshSettings()
      .then((value) => {
        if (!cancelled) setSettings(value)
      })
      .catch(() => {
        if (!cancelled) setSettings(null)
      })
    return () => {
      cancelled = true
    }
  }, [])

  /** Режим инстанса: `tools` — по умолчанию (fail-closed). */
  const mode: SshMode = settings?.mode ?? 'tools'
  /** В режиме `agent` политика по хостам не применяется — поля скрыты. */
  const isToolsMode = mode === 'tools'

  const handleModeChange = useCallback(
    async (next: SshMode) => {
      if (next === mode) return
      setModeSaving(true)
      try {
        const updated = await synthApi.setSshMode(next)
        setSettings(updated)
        notify({ text: t('sshKeys.modeSaved'), type: 'success', category: 'system' })
      } catch (err) {
        notify({
          text: t('sshKeys.modeSaveError', {
            error: err instanceof Error ? err.message : t('common.error'),
          }),
          type: 'error',
          category: 'error',
        })
      } finally {
        setModeSaving(false)
      }
    },
    [mode, notify, t],
  )

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
      privateKey: '',
      passphrase: '',
      agentIds: [...key.agentIds],
      usages: key.usages?.length ? [...key.usages] : ['git'],
      allowHosts: [...(key.allowHosts ?? [])],
      allowPorts: (key.allowPorts ?? []).map((port) => String(port)),
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

  /** PROP-124: переключение способа использования ключа (`git`/`ssh`). */
  const toggleUsage = (usage: SSHKeyUsage) => {
    setEditor((prev) =>
      prev
        ? {
            ...prev,
            usages: prev.usages.includes(usage)
              ? prev.usages.filter((u) => u !== usage)
              : [...prev.usages, usage],
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
    // PROP-124: ключ без назначения бесполезен (ни git, ни ssh) — сохранять
    // такой ключ нельзя (сервер тоже отклоняет пустой список).
    if (state.usages.length === 0) errors.usages = t('sshKeys.error.usageRequired')
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
      // PROP-124: политика ключа. В режиме `agent` поля по хостам не
      // применяются — отправляем сохранённые значения без изменений.
      const allowPorts = editor.allowPorts
        .map((port) => Number(port.trim()))
        .filter((port) => Number.isInteger(port) && port >= 1 && port <= 65535)
      const base = {
        name: editor.name.trim(),
        agentIds: editor.agentIds,
        usages: editor.usages,
        allowHosts: editor.allowHosts,
        allowPorts,
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
    <TooltipProvider>
    <>
      <SettingsSection
        id="agents-ssh-keys"
        title={t('sshKeys.title')}
        description={t('sshKeys.description')}
        actions={
          <Button data-testid="ssh-keys-add" onClick={openCreate}>
            <Icon name="add" className="size-3.5" />
            {t('sshKeys.add')}
          </Button>
        }
      >
        {/* PROP-124: режим инстанса (`tools`|`agent`) — выбор администратора. */}
        <SettingsField
          label={t('sshKeys.mode')}
          description={t('sshKeys.modeHint')}
          tooltip={t('settings.help.agents.sshKeyMode')}
        >
          <div
            className="flex flex-wrap items-center gap-2"
            data-testid="ssh-keys-mode"
            role="group"
            aria-label={t('sshKeys.mode')}
          >
            {(['tools', 'agent'] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => void handleModeChange(value)}
                disabled={modeSaving || settings?.envLocked === true}
                aria-pressed={mode === value}
                data-testid={`ssh-keys-mode-${value}`}
                className={cn(
                  'min-h-[var(--control-height)] rounded-lg border px-3 py-1.5 text-xs transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  mode === value
                    ? 'border-primary bg-interactive-selection text-foreground'
                    : 'border-border bg-surface-inset text-muted-foreground hover:bg-interactive-hover',
                  modeSaving && 'cursor-progress opacity-60',
                )}
              >
                {t(value === 'tools' ? 'sshKeys.modeTools' : 'sshKeys.modeAgent')}
              </button>
            ))}
            {settings?.envLocked && (
              <span className="text-[0.6875rem] text-muted-foreground" data-testid="ssh-keys-mode-locked">
                {t('sshKeys.modeEnvLocked')}
              </span>
            )}
          </div>
        </SettingsField>

        {/* В режиме `agent` фильтрация по хостам не применяется — поясняем это. */}
        {!isToolsMode && (
          <p
            className="text-xs text-muted-foreground min-w-0 break-words"
            data-testid="ssh-keys-agent-mode-note"
          >
            {t('sshKeys.agentModeNote')}
          </p>
        )}

        {loadError && (
          <div role="alert" className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
            {loadError}
          </div>
        )}

        {editor && (
          <div
            className="w-full min-w-0 rounded-xl border border-border/60 bg-background p-4 space-y-3"
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

            <TextField
              label={t('sshKeys.name')}
              tooltip={t('settings.help.agents.sshKeyName')}
              value={editor.name}
              onChange={(e) => setEditor((prev) => (prev ? { ...prev, name: e.target.value } : prev))}
              error={formErrors.name}
              id="ssh-key-name"
              data-testid="ssh-key-name"
            />

            <TextArea
              label={t('sshKeys.privateKey')}
              tooltip={t('settings.help.agents.sshKeyPrivate')}
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
              tooltip={t('settings.help.agents.sshKeyPassphrase')}
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
                          'flex min-h-[var(--control-height)] items-center gap-2 rounded-lg border border-border/60 bg-surface-inset px-2.5 py-1.5 cursor-pointer min-w-0',
                          'transition-colors duration-150 ease-out hover:bg-interactive-hover',
                          'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring',
                          checked && 'bg-interactive-selection',
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

            {/* PROP-124: способы использования ключа (`git`/`ssh`). */}
            <SettingsField label={t('sshKeys.usages')} description={t('sshKeys.usagesHint')}>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 min-w-0">
                {USAGE_OPTIONS.map((usage) => {
                  const checked = editor.usages.includes(usage)
                  return (
                    <label
                      key={usage}
                      className={cn(
                        'flex min-h-[var(--control-height)] items-center gap-2 rounded-lg border border-border/60 bg-surface-inset px-2.5 py-1.5 cursor-pointer min-w-0',
                        'transition-colors duration-150 ease-out hover:bg-interactive-hover',
                        'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring',
                        checked && 'bg-interactive-selection',
                      )}
                    >
                      <input
                        type="checkbox"
                        data-testid={`ssh-key-usage-${usage}`}
                        checked={checked}
                        onChange={() => toggleUsage(usage)}
                        className="size-4 shrink-0 accent-primary focus-visible:outline-none"
                        aria-label={t(usage === 'git' ? 'sshKeys.usageGit' : 'sshKeys.usageSsh')}
                      />
                      <span className="text-xs min-w-0 break-words">
                        {t(usage === 'git' ? 'sshKeys.usageGit' : 'sshKeys.usageSsh')}
                      </span>
                    </label>
                  )
                })}
              </div>
            </SettingsField>

            {/* PROP-124: ключ для ssh без привязки к агенту использовать нельзя. */}
            {editor.usages.includes('ssh') && editor.agentIds.length === 0 && (
              <p
                role="alert"
                className="text-xs text-destructive min-w-0 break-words"
                data-testid="ssh-key-ssh-without-agent"
              >
                {t('sshKeys.sshWithoutAgentWarning')}
              </p>
            )}

            {/* PROP-124: без назначения ключ не годен ни для git, ни для ssh. */}
            {editor.usages.length === 0 && (
              <p
                role="alert"
                className="text-xs text-destructive min-w-0 break-words"
                data-testid="ssh-key-usages-required"
              >
                {t('sshKeys.usagesRequired')}
              </p>
            )}

            {/* Политика по хостам/портам — только в режиме `tools`. */}
            {isToolsMode && (
              <>
                <div data-testid="ssh-keys-allow-hosts">
                  <ListField
                    label={t('sshKeys.allowHosts')}
                    description={t('sshKeys.allowHostsHint')}
                    values={editor.allowHosts}
                    onChange={(allowHosts) => setEditor((prev) => (prev ? { ...prev, allowHosts } : prev))}
                    placeholder="*.corp.example"
                    variant="chips"
                    tooltip={t('settings.help.agents.sshKeyAllowHosts')}
                    emptyText={t('sshKeys.allowHostsEmpty')}
                  />
                </div>
                <div data-testid="ssh-keys-allow-ports">
                  <ListField
                    label={t('sshKeys.allowPorts')}
                    description={t('sshKeys.allowPortsHint')}
                    values={editor.allowPorts}
                    onChange={(allowPorts) => setEditor((prev) => (prev ? { ...prev, allowPorts } : prev))}
                    placeholder="22"
                    variant="chips"
                    tooltip={t('settings.help.agents.sshKeyAllowPorts')}
                    emptyText={t('sshKeys.allowPortsEmpty')}
                  />
                </div>
              </>
            )}

            <div className="flex flex-wrap items-center gap-2 justify-end">
              <Button
                variant="primary"
                onClick={() => void handleSave()}
                disabled={saving || editor.usages.length === 0}
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
                className="flex flex-wrap items-start gap-3 p-3 rounded-lg border border-border bg-surface-inset hover:border-primary/50 transition-colors min-w-0"
              >
                <div className="flex-1 min-w-0 space-y-1">
                  <div className="flex items-center gap-1.5 flex-wrap min-w-0">
                    <Icon name="key" className="size-4 shrink-0 text-muted-foreground" />
                    <span className="text-sm font-medium break-words">{key.name}</span>
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
                    className="shrink-0 min-h-[var(--control-height)] min-w-[var(--control-height)]"
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
                    className="shrink-0 min-h-[var(--control-height)] min-w-[var(--control-height)] hover:text-destructive"
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
    </TooltipProvider>
  )
}

/** Дата создания в коротком виде; при некорректном значении возвращает исходное. */
function formatDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleDateString()
}

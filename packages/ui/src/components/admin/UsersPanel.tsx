import { useEffect, useState } from 'react'
import { synthApi, type UserInfo } from '@/lib/api/synthApi'
import { Icon } from '@/components/icon/Icon'
import { Toggle } from '../ui/Toggle'
import { Button } from '../ui/button'
import { cn } from '@/lib/utils'
import { useI18n } from '@/lib/i18n'
import { confirm } from '@/lib/confirm'
import {
  SettingsActions,
  SettingsField,
  SettingsItem,
  SettingsPanel,
  SettingsSection,
  TextArea,
  TextField,
  ToggleField,
} from '../ui/settings'

const ROLES = ['ADMIN', 'USER', 'LEAD', 'AUDITOR'] as const

interface UserForm {
  username: string
  email: string
  display_name: string
  roles: string[]
  is_active: boolean
  notes: string
}

const emptyForm = (): UserForm => ({
  username: '', email: '', display_name: '', roles: ['USER'], is_active: true, notes: '',
})

function buildForm(u: UserInfo): UserForm {
  return {
    username: u.username,
    email: u.email || '',
    display_name: u.display_name || '',
    roles: u.roles || [],
    is_active: u.is_active,
    notes: u.notes || '',
  }
}

export const UsersPanel = () => {
  const { t } = useI18n()
  const [users, setUsers] = useState<UserInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState<UserForm>(emptyForm())
  const [saving, setSaving] = useState(false)

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const data = await synthApi.getUsers()
      setUsers(data.users || [])
    } catch (err) {
      setError(err instanceof Error ? err.message : t('admin.users.loadError'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const handleCreate = () => {
    setForm(emptyForm())
    setCreating(true)
    setError('')
  }

  const handleEdit = async (u: UserInfo) => {
    setError('')
    try {
      const detail = await synthApi.getUser(u.id)
      setForm(buildForm(detail))
    } catch {
      setForm(buildForm(u))
    }
    setExpanded(u.id)
    setCreating(false)
  }

  const handleCancel = () => {
    setExpanded(null)
    setCreating(false)
    setError('')
  }

  const handleSave = async () => {
    if (!form.username.trim()) { setError(t('admin.users.nameRequired')); return }
    setSaving(true)
    setError('')
    try {
      const body: Record<string, unknown> = {
        username: form.username.trim(),
        email: form.email || undefined,
        display_name: form.display_name || undefined,
        roles: form.roles,
        is_active: form.is_active,
        notes: form.notes,
      }
      if (expanded) {
        await synthApi.updateUser(expanded, body)
      } else {
        await synthApi.createUser(body)
      }
      setExpanded(null)
      setCreating(false)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('admin.users.saveError'))
    } finally {
      setSaving(false)
    }
  }

  const handleToggleActive = async (u: UserInfo) => {
    try {
      await synthApi.updateUser(u.id, { is_active: !u.is_active })
      await load()
    } catch { /* ignore */ }
  }

  const handleDelete = async (u: UserInfo) => {
    if (!(await confirm({ title: t('admin.users.confirmDelete', { username: u.username }), variant: 'danger' }))) return
    try {
      await synthApi.deleteUser(u.id)
      await load()
    } catch { /* ignore */ }
  }

  const toggleRole = (role: string) => {
    setForm((f) => ({
      ...f,
      roles: f.roles.includes(role)
        ? f.roles.filter((r) => r !== role)
        : [...f.roles, role],
    }))
  }

  const renderForm = () => (
    <SettingsSection
      id="users-new"
      title={expanded ? t('admin.users.editUser', { username: form.username }) : t('admin.users.newUser')}
      tooltip={t('settings.help.users.section.users-new')}
    >
      {error && <p className="text-xs text-status-error min-w-0 break-words">{error}</p>}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <TextField
          label={t('admin.users.username')}
          value={form.username}
          onChange={(e) => setForm({ ...form, username: e.target.value })}
          disabled={!!expanded}
          tooltip={t('settings.help.users.username')}
        />
        <TextField
          label={t('admin.users.displayName')}
          value={form.display_name}
          onChange={(e) => setForm({ ...form, display_name: e.target.value })}
          tooltip={t('settings.help.users.displayName')}
        />
        <div className="sm:col-span-2">
          <TextField
            label={t('admin.users.email')}
            type="email"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            tooltip={t('settings.help.users.email')}
          />
        </div>
      </div>

      <SettingsField label={t('admin.users.roles')} tooltip={t('settings.help.users.roles')}>
        <div className="flex flex-wrap gap-1.5 min-w-0">
          {ROLES.map((role) => (
            <button key={role} type="button" onClick={() => toggleRole(role)} className={cn(
              'px-2.5 py-1 rounded text-xs transition-colors',
              form.roles.includes(role)
                ? 'bg-secondary text-secondary-foreground font-medium'
                : 'bg-muted text-muted-foreground hover:bg-interactive-hover',
            )}>{role}</button>
          ))}
        </div>
      </SettingsField>

      <ToggleField
        label={t('admin.users.active')}
        enabled={form.is_active}
        onToggle={() => setForm({ ...form, is_active: !form.is_active })}
        tooltip={t('settings.help.users.active')}
      />

      <TextArea
        label={t('admin.users.notes')}
        value={form.notes}
        onChange={(e) => setForm({ ...form, notes: e.target.value })}
        rows={3}
        tooltip={t('settings.help.users.notes')}
      />

      <SettingsActions
        onSave={handleSave}
        onCancel={handleCancel}
        saving={saving}
        saveLabel={t('admin.users.save')}
        cancelLabel={t('admin.users.cancel')}
        saveTestId="user-save"
        cancelTestId="user-cancel"
      />
    </SettingsSection>
  )

  return (
    <SettingsPanel
      title={t('admin.users.title')}
      meta={t('admin.users.count', { count: users.length })}
      actions={
        <Button onClick={handleCreate}>
          <Icon name="add" className="size-3.5" />{t('admin.users.add')}
        </Button>
      }
    >
      {error && !creating && !expanded && (
        <div className="bg-status-warning/10 border border-status-warning/30 rounded-lg p-4 text-sm text-status-warning min-w-0 break-words">
          {error}
        </div>
      )}

      {(creating || expanded) && renderForm()}

      {loading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="bg-background rounded-lg border p-4 animate-pulse">
              <div className="h-4 bg-muted rounded w-24" />
            </div>
          ))}
        </div>
      ) : users.length === 0 ? (
        <SettingsSection>
          <p className="py-4 text-center text-muted-foreground">{t('admin.users.empty')}</p>
        </SettingsSection>
      ) : (
        <SettingsSection>
          {users.map((u) => (
            <SettingsItem key={u.id} className={cn(!u.is_active && 'opacity-50')}>
              <div className="flex flex-wrap items-center justify-between gap-2 min-w-0">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="size-8 rounded-full bg-muted flex items-center justify-center text-sm font-medium shrink-0">
                    {u.display_name?.charAt(0) || u.username.charAt(0).toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5 min-w-0">
                      <span className="font-medium text-sm truncate">{u.display_name || u.username}</span>
                      <code className="text-[0.625rem] text-muted-foreground shrink-0">{u.username}</code>
                    </div>
                    {u.email && (
                      <p className="text-xs text-muted-foreground truncate">{u.email}</p>
                    )}
                  </div>
                </div>
                <Toggle enabled={u.is_active} onToggle={() => handleToggleActive(u)} />
              </div>

              <div className="flex flex-wrap gap-1 min-w-0">
                {u.roles.length === 0 && (
                  <span className="text-[0.625rem] text-muted-foreground">{t('admin.users.noRoles')}</span>
                )}
                {u.roles.map((r) => (
                  <span key={r} className="px-1.5 py-0.5 rounded text-[0.625rem] font-medium bg-secondary text-secondary-foreground">
                    {r}
                  </span>
                ))}
                {u.last_login && (
                  <span className="px-1.5 py-0.5 rounded text-[0.625rem] bg-secondary text-secondary-foreground">
                    {t('admin.users.wasLastLogin', { date: new Date(u.last_login).toLocaleDateString('ru') })}
                  </span>
                )}
              </div>

              <div className="flex flex-wrap gap-1 min-w-0">
                <Button variant="ghost" onClick={() => handleEdit(u)}>{t('admin.users.edit')}</Button>
                <Button
                  variant="ghost"
                  onClick={() => handleDelete(u)}
                  className="text-muted-foreground hover:bg-status-error/10 hover:text-status-error"
                >
                  {t('admin.users.delete')}
                </Button>
              </div>
            </SettingsItem>
          ))}
        </SettingsSection>
      )}
    </SettingsPanel>
  )
}

import { useEffect, useState } from 'react'
import { synthApi, type UserInfo } from '@/lib/api/synthApi'
import { Icon } from '@/components/icon/Icon'
import { Toggle } from '../ui/Toggle'
import { cn } from '@/lib/utils'
import { useI18n } from '@/lib/i18n'

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
    if (!confirm(t('admin.users.confirmDelete', { username: u.username }))) return
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
    <div className="bg-background rounded-lg border p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="font-medium text-sm">{expanded ? t('admin.users.editUser', { username: form.username }) : t('admin.users.newUser')}</h4>
        <div className="flex gap-2">
          <button onClick={handleSave} disabled={saving} className="px-3 py-1.5 rounded-lg text-xs bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
            {saving ? t('admin.users.saving') : t('admin.users.save')}
          </button>
          <button onClick={handleCancel} className="px-3 py-1.5 rounded-lg text-xs text-muted-foreground hover:bg-interactive-hover">{t('admin.users.cancel')}</button>
        </div>
      </div>

      {error && <p className="text-xs text-status-error">{error}</p>}

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs text-muted-foreground">{t('admin.users.username')}</label>
          <input type="text" value={form.username}
            onChange={(e) => setForm({ ...form, username: e.target.value })}
            disabled={!!expanded}
            className="w-full px-3 py-1.5 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50" />
        </div>
        <div>
          <label className="text-xs text-muted-foreground">{t('admin.users.displayName')}</label>
          <input type="text" value={form.display_name}
            onChange={(e) => setForm({ ...form, display_name: e.target.value })}
            className="w-full px-3 py-1.5 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
        </div>
        <div className="col-span-2">
          <label className="text-xs text-muted-foreground">{t('admin.users.email')}</label>
          <input type="email" value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            className="w-full px-3 py-1.5 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
        </div>
      </div>

      <div>
        <label className="text-xs text-muted-foreground mb-1 block">{t('admin.users.roles')}</label>
        <div className="flex flex-wrap gap-1.5">
          {ROLES.map((role) => (
            <button key={role} type="button" onClick={() => toggleRole(role)} className={cn(
              'px-2.5 py-1 rounded text-xs transition-colors',
              form.roles.includes(role)
                ? 'bg-secondary text-secondary-foreground font-medium'
                : 'bg-muted text-muted-foreground hover:bg-interactive-hover',
            )}>{role}</button>
          ))}
        </div>
      </div>

      <label className="flex items-center gap-2 cursor-pointer">
        <input type="checkbox" checked={form.is_active}
          onChange={(e) => setForm({ ...form, is_active: e.target.checked })}
          className="rounded" />
        <span className="text-sm">{t('admin.users.active')}</span>
      </label>

      <div>
        <label className="text-xs text-muted-foreground mb-1 block">{t('admin.users.notes')}</label>
        <textarea value={form.notes}
          onChange={(e) => setForm({ ...form, notes: e.target.value })}
          rows={3}
          className="w-full px-3 py-1.5 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-y" />
      </div>
    </div>
  )

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="shrink-0 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold">{t('admin.users.title')}</h3>
          <p className="text-muted-foreground text-sm">{t('admin.users.count', { count: users.length })}</p>
        </div>
        <button onClick={handleCreate} className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs bg-primary text-primary-foreground hover:bg-primary/90">
          <Icon name="add" className="size-3.5" />{t('admin.users.add')}
        </button>
      </div>
      </div>

      <div className="flex-1 overflow-y-auto min-h-0 overscroll-behavior-contain mt-4">
      {error && !creating && !expanded && (
        <div className="bg-status-warning/10 border border-status-warning/30 rounded-lg p-4 text-sm text-status-warning">
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
        <div className="bg-background rounded-xl border p-8 text-center text-muted-foreground">
          {t('admin.users.empty')}
        </div>
      ) : (
        <div className="space-y-2">
          {users.map((u) => (
            <div key={u.id}>
              <div className={cn(
                'bg-background rounded-lg border p-4',
                !u.is_active && 'opacity-50',
              )}>
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="size-8 rounded-full bg-muted flex items-center justify-center text-sm font-medium shrink-0">
                      {u.display_name?.charAt(0) || u.username.charAt(0).toUpperCase()}
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
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

                <div className="flex flex-wrap gap-1 mb-2">
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

                <div className="flex gap-1">
                  <button onClick={() => handleEdit(u)} className="px-2 py-1 rounded text-xs text-muted-foreground hover:bg-interactive-hover">{t('admin.users.edit')}</button>
                  <button onClick={() => handleDelete(u)} className="px-2 py-1 rounded text-xs text-muted-foreground hover:bg-status-error/10 hover:text-status-error">{t('admin.users.delete')}</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      </div>
    </div>
  )
}

import { useState, useEffect, useRef } from 'react'
import { useAuthStore } from '@/stores/authStore'
import { useI18n } from '@/lib/i18n'
import { api } from '@/lib/api/client'
import { Icon } from '@/components/icon/Icon'
import { cn } from '@/lib/utils'

const MAX_AVATAR_SIZE = 500 * 1024

export const ProfileSettings = () => {
  const { t } = useI18n()
  const { user } = useAuthStore()
  const [form, setForm] = useState({
    username: '',
    display_name: '',
    email: '',
    team_roles: [] as string[],
    notes: '',
    avatar: null as string | null,
  })
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const loadProfile = async () => {
      try {
        const profile = await api.getProfile()
        setForm({
          username: profile.username || user?.username || '',
          display_name: profile.display_name || '',
          email: profile.email || user?.email || '',
          team_roles: profile.team_roles || [],
          notes: profile.notes || '',
          avatar: profile.preferences?.avatar || null,
        })
      } catch {
        setForm({
          username: user?.username || '',
          display_name: '',
          email: user?.email || '',
          team_roles: [],
          notes: '',
          avatar: null,
        })
      }
    }
    loadProfile()
  }, [user])

  const handleAvatarChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    if (file.size > MAX_AVATAR_SIZE) {
      setError(t('auth.avatarTooLarge'))
      return
    }

    const reader = new FileReader()
    reader.onload = () => {
      const base64 = reader.result as string
      setForm({ ...form, avatar: base64 })
      setSuccess(true)
      setTimeout(() => setSuccess(false), 2000)
    }
    reader.readAsDataURL(file)
  }

  const handleSave = async () => {
    setIsLoading(true)
    setError(null)
    try {
      const updated = await api.updateProfile({
        display_name: form.display_name || undefined,
        email: form.email || undefined,
        notes: form.notes,
        team_roles: form.team_roles,
        preferences: { avatar: form.avatar },
      })
      const currentProfile = useAuthStore.getState().profile
      if (currentProfile) {
        useAuthStore.setState({
          profile: { ...currentProfile, preferences: updated.preferences },
        })
      }
      setSuccess(true)
      setTimeout(() => setSuccess(false), 2000)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('auth.saveError'))
    } finally {
      setIsLoading(false)
    }
  }

  const teamRoleOptions = [
    { value: 'developer', label: t('auth.roleDeveloper') },
    { value: 'admin', label: t('auth.roleAdmin') },
    { value: 'analyst', label: t('auth.roleAnalyst') },
    { value: 'manager', label: t('auth.roleManager') },
  ]

  const avatarInitial = form.display_name?.charAt(0).toUpperCase() || form.username?.charAt(0).toUpperCase() || '?'

  return (
    <div className="max-w-lg">
      <h2 className="text-lg font-semibold text-foreground mb-1">{t('auth.profile')}</h2>
      <p className="text-sm text-muted-foreground mb-6">{t('auth.profileDescription')}</p>

      <div className="flex flex-col gap-6">
        <div className="flex items-center gap-4">
          <div
            className="size-20 rounded-full bg-interactive-selection flex items-center justify-center overflow-hidden cursor-pointer hover:opacity-80 transition-opacity"
            onClick={() => fileInputRef.current?.click()}
          >
            {form.avatar ? (
              <img src={form.avatar} alt="Avatar" className="size-full object-cover" />
            ) : (
              <span className="text-2xl font-medium text-interactive-selection-foreground">
                {avatarInitial}
              </span>
            )}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={handleAvatarChange}
            className="hidden"
          />
          <div>
            <button
              onClick={() => fileInputRef.current?.click()}
              className={cn(
                "px-3 py-1.5 rounded-lg text-sm font-medium",
                "bg-interactive-selection hover:bg-interactive-selection/90",
                "text-interactive-selection-foreground",
                "transition-colors"
              )}
            >
              {form.avatar ? t('auth.changeAvatar') : t('auth.uploadAvatar')}
            </button>
            {form.avatar && (
              <button
                onClick={() => setForm({ ...form, avatar: null })}
                className="ml-2 px-3 py-1.5 rounded-lg text-sm font-medium text-muted-foreground hover:bg-interactive-hover transition-colors"
              >
                {t('auth.removeAvatar')}
              </button>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium text-foreground" htmlFor="profile-username">{t('auth.login')}</label>
          <input
            id="profile-username"
            type="text"
            value={form.username}
            readOnly
            disabled
            className={cn(
              "w-full px-3 py-2 rounded-lg border bg-muted text-muted-foreground",
              "cursor-not-allowed"
            )}
          />
        </div>

        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium text-foreground" htmlFor="profile-display-name">{t('auth.displayName')}</label>
          <input
            id="profile-display-name"
            type="text"
            value={form.display_name}
            onChange={(e) => setForm({ ...form, display_name: e.target.value })}
            className={cn(
              "w-full px-3 py-2 rounded-lg border bg-background text-foreground",
              "focus:outline-none focus:ring-2 focus:ring-ring",
              "transition-colors"
            )}
          />
        </div>

        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium text-foreground" htmlFor="profile-email">{t('common.email')}</label>
          <input
            id="profile-email"
            type="email"
            value={form.email || ''}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            className={cn(
              "w-full px-3 py-2 rounded-lg border bg-background text-foreground",
              "focus:outline-none focus:ring-2 focus:ring-ring",
              "transition-colors"
            )}
          />
        </div>

        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium text-foreground" htmlFor="profile-team-role">{t('auth.teamRole')}</label>
          <select
            id="profile-team-role"
            value={form.team_roles[0] || 'developer'}
            onChange={(e) => setForm({ ...form, team_roles: [e.target.value] })}
            className={cn(
              "w-full px-3 py-2 rounded-lg border bg-background text-foreground",
              "focus:outline-none focus:ring-2 focus:ring-ring",
              "transition-colors"
            )}
          >
            {teamRoleOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium text-foreground" htmlFor="profile-notes">{t('auth.notes')}</label>
          <textarea
            id="profile-notes"
            value={form.notes}
            onChange={(e) => setForm({ ...form, notes: e.target.value })}
            rows={3}
            className={cn(
              "w-full px-3 py-2 rounded-lg border bg-background text-foreground",
              "focus:outline-none focus:ring-2 focus:ring-ring",
              "transition-colors resize-none"
            )}
          />
        </div>

        {error && (
          <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
            <Icon name="error-warning" className="size-4 shrink-0" />
            {error}
          </div>
        )}

        {success && (
          <div className="flex items-center gap-2 p-3 rounded-lg bg-status-success/10 text-status-success text-sm">
            <Icon name="check" className="size-4 shrink-0" />
            {t('common.saved')}
          </div>
        )}

        <div className="flex justify-end gap-3">
          <button
            onClick={handleSave}
            disabled={isLoading}
            className={cn(
              "px-4 py-2 rounded-lg text-sm font-medium",
              "bg-interactive-selection hover:bg-interactive-selection/90",
              "disabled:opacity-50",
              "transition-colors"
            )}
          >
            {isLoading ? t('common.loading') : t('common.save')}
          </button>
        </div>
      </div>
    </div>
  )
}
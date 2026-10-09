import { useState, useEffect, useRef } from 'react'
import { useAuthStore } from '@/stores/authStore'
import { useI18n } from '@/lib/i18n'
import { api } from '@/lib/api/client'
import { Icon } from '@/components/icon/Icon'
import { Button } from '@/components/ui/button'
import { SelectContent, SelectItem } from '@/components/ui/select'
import {
  SelectField,
  SettingsActions,
  SettingsItem,
  SettingsPanel,
  SettingsSection,
  TextArea,
  TextField,
  ToggleField,
} from '../ui/settings'

const MAX_AVATAR_SIZE = 500 * 1024

interface ProfileForm {
  username: string
  display_name: string
  email: string
  phone: string
  team_roles: string[]
  notes: string
  interview_completed: boolean
  avatar: string | null
}

const EMPTY_FORM: ProfileForm = {
  username: '',
  display_name: '',
  email: '',
  phone: '',
  team_roles: [],
  notes: '',
  interview_completed: false,
  avatar: null,
}

/** Сравнение значимых полей формы (username — только для чтения, но тоже учитываем). */
const formSnapshot = (f: ProfileForm) =>
  JSON.stringify({
    username: f.username,
    display_name: f.display_name,
    email: f.email,
    phone: f.phone,
    team_roles: f.team_roles,
    notes: f.notes,
    interview_completed: f.interview_completed,
    avatar: f.avatar,
  })

export const ProfileSettings = () => {
  const { t } = useI18n()
  const user = useAuthStore(s => s.user)
  const [form, setForm] = useState<ProfileForm>(EMPTY_FORM)
  const [savedForm, setSavedForm] = useState<ProfileForm>(EMPTY_FORM)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const dirty = formSnapshot(form) !== formSnapshot(savedForm)

  useEffect(() => {
    const loadProfile = async () => {
      let next: ProfileForm
      try {
        const profile = await api.getProfile()
        next = {
          username: profile.username || user?.username || '',
          display_name: profile.display_name || '',
          email: profile.email || user?.email || '',
          phone: profile.phone || '',
          team_roles: profile.team_roles || [],
          notes: profile.notes || '',
          interview_completed: profile.interview_completed ?? false,
          avatar: profile.preferences?.avatar || null,
        }
      } catch {
        next = {
          username: user?.username || '',
          display_name: '',
          email: user?.email || '',
          phone: '',
          team_roles: [],
          notes: '',
          interview_completed: false,
          avatar: null,
        }
      }
      setForm(next)
      setSavedForm(next)
    }
    loadProfile()
  }, [user])

  const successTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const flashSuccess = () => {
    setSuccess(true)
    if (successTimerRef.current !== null) clearTimeout(successTimerRef.current)
    successTimerRef.current = setTimeout(() => {
      successTimerRef.current = null
      setSuccess(false)
    }, 2000)
  }
  useEffect(() => () => {
    if (successTimerRef.current !== null) clearTimeout(successTimerRef.current)
  }, [])

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
      flashSuccess()
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
        phone: form.phone || undefined,
        notes: form.notes,
        team_roles: form.team_roles,
        interview_completed: form.interview_completed,
        preferences: { avatar: form.avatar },
      })
      const currentProfile = useAuthStore.getState().profile
      if (currentProfile) {
        useAuthStore.getState().setProfile({
          ...currentProfile,
          preferences: updated.preferences,
        })
      }
      flashSuccess()
      setSavedForm(form)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('auth.saveError'))
    } finally {
      setIsLoading(false)
    }
  }

  const handleCancel = () => {
    setForm(savedForm)
    setError(null)
    setSuccess(false)
  }

  const teamRoleOptions = [
    { value: 'developer', label: t('auth.roleDeveloper') },
    { value: 'admin', label: t('auth.roleAdmin') },
    { value: 'analyst', label: t('auth.roleAnalyst') },
    { value: 'manager', label: t('auth.roleManager') },
  ]

  const avatarInitial = form.display_name?.charAt(0).toUpperCase() || form.username?.charAt(0).toUpperCase() || '?'

  return (
    <SettingsPanel
      title={t('auth.profile')}
      description={t('auth.profileDescription')}
    >
      <SettingsSection>
        <SettingsItem>
          <div className="flex flex-wrap items-center gap-4 min-w-0">
            <div
              className="size-20 shrink-0 rounded-full bg-interactive-selection flex items-center justify-center overflow-hidden cursor-pointer hover:opacity-80 transition-opacity"
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
            <div className="flex flex-wrap items-center gap-2 min-w-0">
              <Button
                onClick={() => fileInputRef.current?.click()}
              >
                {form.avatar ? t('auth.changeAvatar') : t('auth.uploadAvatar')}
              </Button>
              {form.avatar && (
                <Button
                  variant="ghost"
                  onClick={() => setForm({ ...form, avatar: null })}
                >
                  {t('auth.removeAvatar')}
                </Button>
              )}
            </div>
          </div>
        </SettingsItem>
      </SettingsSection>

      <SettingsSection>
        <TextField
          id="profile-username"
          label={t('auth.login')}
          value={form.username}
          readOnly
          disabled
        />
        <TextField
          id="profile-display-name"
          label={t('auth.displayName')}
          value={form.display_name}
          onChange={(e) => setForm({ ...form, display_name: e.target.value })}
        />
      </SettingsSection>

      <SettingsSection>
        <TextField
          id="profile-email"
          label={t('common.email')}
          type="email"
          value={form.email || ''}
          onChange={(e) => setForm({ ...form, email: e.target.value })}
        />
        <TextField
          id="profile-phone"
          label={t('auth.phone')}
          type="tel"
          value={form.phone || ''}
          onChange={(e) => setForm({ ...form, phone: e.target.value })}
        />
      </SettingsSection>

      <SettingsSection>
        <SelectField
          label={t('auth.teamRole')}
          value={form.team_roles[0] || 'developer'}
          onValueChange={(value) => setForm({ ...form, team_roles: [value] })}
          ariaLabel={t('auth.teamRole')}
        >
          <SelectContent>
            {teamRoleOptions.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
            ))}
          </SelectContent>
        </SelectField>
      </SettingsSection>

      <SettingsSection>
        <TextArea
          id="profile-notes"
          label={t('auth.notes')}
          value={form.notes}
          onChange={(e) => setForm({ ...form, notes: e.target.value })}
          rows={3}
          className="resize-none"
        />
      </SettingsSection>

      <SettingsSection>
        <ToggleField
          label={t('auth.interviewCompleted')}
          description={t('auth.interviewCompletedDescription')}
          enabled={form.interview_completed}
          onToggle={() => setForm({ ...form, interview_completed: !form.interview_completed })}
        />
      </SettingsSection>

      {error && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/10 text-destructive text-sm min-w-0 break-words">
          <Icon name="error-warning" className="size-4 shrink-0" />
          {error}
        </div>
      )}

      {success && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-status-success/10 text-status-success text-sm min-w-0">
          <Icon name="check" className="size-4 shrink-0" />
          {t('common.saved')}
        </div>
      )}

      <SettingsActions
        onSave={handleSave}
        onCancel={handleCancel}
        saveDisabled={!dirty}
        cancelDisabled={!dirty}
        saving={isLoading}
        saveTestId="profile-save"
        cancelTestId="profile-cancel"
      />
    </SettingsPanel>
  )
}

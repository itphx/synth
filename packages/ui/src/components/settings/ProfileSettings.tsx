import { useState, useEffect, useRef } from 'react'
import type { ExternalIdentity } from '@itphx/synth-shared'
import { useAuthStore } from '@/stores/authStore'
import { useI18n } from '@/lib/i18n'
import { api } from '@/lib/api/client'
import { synthApi } from '@/lib/api/synthApi'
import { confirm } from '@/lib/confirm'
import { formatDateTime } from '@/lib/formatDate'
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
  const { t, locale } = useI18n()
  const user = useAuthStore(s => s.user)
  const [form, setForm] = useState<ProfileForm>(EMPTY_FORM)
  const [savedForm, setSavedForm] = useState<ProfileForm>(EMPTY_FORM)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // AD-089: внешние идентичности (не часть черновика профиля — отдельный ресурс).
  const [identities, setIdentities] = useState<ExternalIdentity[] | null>(null)
  const [identitiesError, setIdentitiesError] = useState<string | null>(null)
  const [unlinkingId, setUnlinkingId] = useState<string | null>(null)
  // AD-089 (claim-flow): ввод одноразового кода и его подтверждение.
  const [claimCode, setClaimCode] = useState('')
  const [claimError, setClaimError] = useState<string | null>(null)
  const [claiming, setClaiming] = useState(false)

  const dirty = formSnapshot(form) !== formSnapshot(savedForm)

  useEffect(() => {
    let cancelled = false
    const loadIdentities = async () => {
      try {
        const { identities: list } = await synthApi.getMyIdentities()
        if (!cancelled) setIdentities(list)
      } catch (err) {
        if (!cancelled) {
          setIdentitiesError(err instanceof Error ? err.message : t('auth.identitiesLoadError'))
        }
      }
    }
    loadIdentities()
    return () => {
      cancelled = true
    }
  }, [t])

  const handleUnlinkIdentity = async (identity: ExternalIdentity) => {
    const label = identity.displayName || identity.username || `${identity.provider}:${identity.externalId}`
    const ok = await confirm({
      title: t('auth.identityUnlinkTitle'),
      message: t('auth.identityUnlinkConfirm', { identity: label }),
      confirmLabel: t('auth.identityUnlink'),
      variant: 'warning',
      icon: 'link',
    })
    if (!ok) return
    const id = `${identity.provider}:${identity.externalId}`
    setUnlinkingId(id)
    setIdentitiesError(null)
    try {
      await synthApi.deleteMyIdentity(identity.provider, identity.externalId)
      setIdentities((prev) => (prev ?? []).filter(
        (i) => !(i.provider === identity.provider && i.externalId === identity.externalId),
      ))
    } catch (err) {
      setIdentitiesError(err instanceof Error ? err.message : t('auth.identityUnlinkError'))
    } finally {
      setUnlinkingId(null)
    }
  }

  // AD-089 (claim-flow): подтверждение владения идентичностью по коду.
  const handleClaimIdentity = async () => {
    const code = claimCode.trim()
    if (!code || claiming) return
    setClaiming(true)
    setClaimError(null)
    try {
      const { identity } = await synthApi.claimIdentity(code)
      setIdentities((prev) => {
        const list = prev ?? []
        const exists = list.some(
          (i) => i.provider === identity.provider && i.externalId === identity.externalId,
        )
        return exists ? list : [...list, identity]
      })
      setClaimCode('')
    } catch (err) {
      // Понятный текст по коду ошибки: код недействителен / уже привязан / пустой.
      const status = (err as { status?: number })?.status
      const code2 = (err as { code?: string })?.code
      if (code2 === 'CONFLICT' || status === 409) {
        setClaimError(t('auth.identityClaimConflict'))
      } else if (code2 === 'VALIDATION_ERROR' || status === 400) {
        setClaimError(t('auth.identityClaimRequired'))
      } else if (code2 === 'NOT_FOUND' || status === 404) {
        setClaimError(t('auth.identityClaimInvalid'))
      } else {
        setClaimError(err instanceof Error ? err.message : t('auth.identityClaimError'))
      }
    } finally {
      setClaiming(false)
    }
  }

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

      <SettingsSection
        title={t('auth.identities')}
        description={t('auth.identitiesDescription')}
      >
        {identitiesError && (
          <div
            role="alert"
            className="rounded-lg bg-destructive/10 p-2 text-xs text-destructive min-w-0 break-words"
          >
            {identitiesError}
          </div>
        )}

        {identities === null && !identitiesError && (
          <div className="py-3 text-center text-xs text-muted-foreground" data-testid="profile-identities-loading">
            {t('common.loading')}
          </div>
        )}

        {identities !== null && identities.length === 0 && (
          <div
            className="flex flex-col items-center gap-1 py-4 text-center text-muted-foreground"
            data-testid="profile-identities-empty"
          >
            <Icon name="link" className="size-6 opacity-40" />
            <p className="text-xs">{t('auth.identitiesEmpty')}</p>
          </div>
        )}

        {identities !== null && identities.length > 0 && (
          <ul className="space-y-2 min-w-0" data-testid="profile-identities-list">
            {identities.map((identity) => {
              const rowId = `${identity.provider}:${identity.externalId}`
              const label = identity.displayName || identity.username || rowId
              return (
                <li
                  key={rowId}
                  data-testid={`profile-identity-${rowId}`}
                  className="flex flex-wrap items-start justify-between gap-2 rounded-lg border border-border/60 bg-surface-inset p-2.5 min-w-0"
                >
                  <div className="min-w-0 space-y-0.5">
                    <div className="flex flex-wrap items-center gap-1.5 min-w-0">
                      <span className="min-w-0 break-words text-sm font-semibold text-foreground">
                        {label}
                      </span>
                      <code className="shrink-0 font-mono text-[0.6875rem] text-muted-foreground">
                        {identity.provider}:{identity.externalId}
                      </code>
                    </div>
                    <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[0.6875rem] text-muted-foreground min-w-0">
                      <span className="min-w-0 break-words">
                        {t('auth.identityLinkedAt')}: {formatDateTime(identity.linkedAt, locale)}
                      </span>
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    className="shrink-0 min-h-10 hover:text-destructive"
                    onClick={() => void handleUnlinkIdentity(identity)}
                    disabled={unlinkingId === rowId}
                    data-testid={`profile-identity-unlink-${rowId}`}
                  >
                    <Icon name="link" className="size-4" />
                    {t('auth.identityUnlink')}
                  </Button>
                </li>
              )
            })}
          </ul>
        )}

        {/* AD-089 (claim-flow): одноразовый код из чата → привязка идентичности. */}
        <div className="mt-3 space-y-2 border-t border-border/60 pt-3">
          <TextField
            id="profile-identity-claim-code"
            label={t('auth.identityClaimLabel')}
            description={t('auth.identityClaimDescription')}
            placeholder={t('auth.identityClaimPlaceholder')}
            value={claimCode}
            mono
            autoComplete="off"
            spellCheck={false}
            error={claimError ?? undefined}
            disabled={claiming}
            onChange={(e) => {
              setClaimCode(e.target.value)
              if (claimError) setClaimError(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void handleClaimIdentity()
              }
            }}
          />
          <div className="flex justify-end">
            <Button
              variant="outline"
              className="min-h-10"
              onClick={() => void handleClaimIdentity()}
              disabled={claiming || claimCode.trim().length === 0}
              data-testid="profile-identity-claim"
            >
              <Icon name="link" className="size-4" />
              {t('auth.identityClaim')}
            </Button>
          </div>
        </div>
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

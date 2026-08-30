import { useState, useEffect } from 'react'
import { useAuthStore } from '@/stores/authStore'
import { api } from '@/lib/api/client'
import { useI18n } from '@/lib/i18n'
import { SynthLogo } from '@/components/ui'
import { Icon } from '@/components/icon/Icon'
import { cn } from '@/lib/utils'

interface DebugUser {
  id: string
  username: string
}

export const LoginForm = () => {
  const { t } = useI18n()
  const { login, loginWithPassword, isLoading, error, clearError } = useAuthStore()
  const [apiKey, setApiKey] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [debugUsers, setDebugUsers] = useState<DebugUser[]>([])
  const [isDebugMode, setIsDebugMode] = useState(false)
  const [oidcEnabled, setOidcEnabled] = useState(false)

  useEffect(() => {
    const checkStatus = async () => {
      try {
        const status = await api.getStatus()
        setOidcEnabled(status.oidc_enabled)
        setIsDebugMode(status.debug_mode)
        if (status.debug_mode) {
          const users = await api.getUsers()
          setDebugUsers(users.users)
        }
      } catch {
        setIsDebugMode(false)
      }
    }
    checkStatus()
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    clearError()
    if (oidcEnabled) {
      await loginWithPassword(username, password)
    } else {
      await login(apiKey, username || undefined)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="w-full max-w-md p-8 rounded-xl border bg-background-secondary">
        <div className="flex flex-col items-center gap-4 mb-8">
          <SynthLogo width={80} height={80} className="text-foreground" />
          <h1 className="text-2xl font-bold text-foreground">{t('auth.loginTitle')}</h1>
          <p className="text-sm text-muted-foreground text-center">
            {oidcEnabled ? t('auth.loginSubtitleOidc') : t('auth.loginSubtitle')}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          {oidcEnabled ? (
            <>
              <div className="flex flex-col gap-2">
                <label className="text-sm font-medium text-foreground">
                  {t('auth.username')}
                </label>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder={t('auth.usernamePlaceholder')}
                  autoComplete="username"
                  className={cn(
                    "w-full px-4 py-2.5 rounded-lg border bg-background text-foreground",
                    "placeholder:text-muted-foreground",
                    "focus:outline-none focus:ring-2 focus:ring-ring",
                    "transition-colors"
                  )}
                />
              </div>

              <div className="flex flex-col gap-2">
                <label className="text-sm font-medium text-foreground">
                  {t('auth.password')}
                </label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={t('auth.passwordPlaceholder')}
                  autoComplete="current-password"
                  className={cn(
                    "w-full px-4 py-2.5 rounded-lg border bg-background text-foreground",
                    "placeholder:text-muted-foreground",
                    "focus:outline-none focus:ring-2 focus:ring-ring",
                    "transition-colors"
                  )}
                />
              </div>
            </>
          ) : (
            <>
              {isDebugMode && (
                <div className="flex flex-col gap-2">
                  <label className="text-sm font-medium text-foreground">
                    {t('auth.username')}
                  </label>
                  {debugUsers.length > 0 ? (
                    <select
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      className={cn(
                        "w-full px-4 py-2.5 rounded-lg border bg-background text-foreground",
                        "focus:outline-none focus:ring-2 focus:ring-ring",
                        "transition-colors"
                      )}
                    >
                      <option value="">{t('auth.selectUser')}</option>
                      {debugUsers.map((u) => (
                        <option key={u.id} value={u.username}>
                          {u.username}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type="text"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      placeholder={t('auth.usernamePlaceholder')}
                      className={cn(
                        "w-full px-4 py-2.5 rounded-lg border bg-background text-foreground",
                        "placeholder:text-muted-foreground",
                        "focus:outline-none focus:ring-2 focus:ring-ring",
                        "transition-colors"
                      )}
                    />
                  )}
                </div>
              )}

              <div className="flex flex-col gap-2">
                <label className="text-sm font-medium text-foreground">
                  {t('auth.apiKey')}
                </label>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={t('auth.apiKeyPlaceholder')}
                  className={cn(
                    "w-full px-4 py-2.5 rounded-lg border bg-background text-foreground",
                    "placeholder:text-muted-foreground",
                    "focus:outline-none focus:ring-2 focus:ring-ring",
                    "transition-colors"
                  )}
                  required
                />
              </div>
            </>
          )}

          {error && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
              <Icon name="error-warning" className="size-4 shrink-0" />
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={
              isLoading ||
              (oidcEnabled
                ? !username || !password
                : !apiKey || (isDebugMode && !username))
            }
            className={cn(
              "w-full px-4 py-2.5 rounded-lg font-medium text-foreground",
              "bg-interactive-selection hover:bg-interactive-selection/90",
              "disabled:opacity-50 disabled:cursor-not-allowed",
              "transition-colors"
            )}
          >
            {isLoading ? t('common.loading') : t('auth.loginButton')}
          </button>
        </form>
      </div>
    </div>
  )
}

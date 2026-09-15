import { useState, useEffect, useRef } from 'react'
import { SYNTH_VERSION } from '@itphx/synth-shared'
import { useAuthStore } from '@/stores/authStore'
import { api } from '@/lib/api/client'
import { synthApi } from '@/lib/api/synthApi'
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
  const [keyboardReserve, setKeyboardReserve] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [server, setServer] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [debugUsers, setDebugUsers] = useState<DebugUser[]>([])
  const [isDebugMode, setIsDebugMode] = useState(false)
  const [oidcEnabled, setOidcEnabled] = useState(false)
  /** Гибридный режим реально включён (эндпоинт /hybrid/status ответил И enabled=true). */
  const [hybridEnabled, setHybridEnabled] = useState(false)
  /** Известные серверы из реестра профилей core (варианты для datalist поля «Сервер»). */
  const [knownServers, setKnownServers] = useState<string[]>([])
  /** Ссылка на поле пароля — перенос фокуса по Enter с поля логина (мобильная UX). */
  const passwordRef = useRef<HTMLInputElement>(null)
  const loginRef = useRef<HTMLDivElement>(null)
  const blurTimerRef = useRef<number | null>(null)

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
        // Гибрид: если сервер — standalone-core (имеет /hybrid/status), уточняем,
        // включён ли гибрид. Поле «Сервер» в гибриде показывается ВСЕГДА (даже
        // когда адрес известен core при старте): при протухшем токене пользователь
        // может сменить адрес. backendUrl/lastServer используем как предзаполнение.
        // На managed-бэкенде эндпоинта нет — запрос НЕ выполняем (0 сетевых
        // запросов → нет 404), поле адреса скрыто (hybridEnabled=false).
        if (status.deployment === 'standalone' && status.oidc_enabled) {
          const hybrid = await synthApi.getHybridStatus().catch(() => null)
          if (hybrid) {
            // Эндпоинт ответил — реально включён гибрид.
            setHybridEnabled(hybrid.enabled ?? false)
            setKnownServers(hybrid.knownServers ?? [])
            // Предзаполнение поля адреса: последний использованный сервер
            // (реестр профилей) приоритетнее текущего backendUrl core.
            const initial = hybrid.lastServer || hybrid.backendUrl || ''
            if (initial) setServer((prev) => prev || initial)
          } else {
            // Гибрид не настроен (или core без hybrid) → поле адреса скрываем.
            setHybridEnabled(false)
          }
        } else {
          // Managed-бэкенд (нет /hybrid/status) → гибрида нет, поле адреса скрыто.
          setHybridEnabled(false)
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
      // В гибриде поле «Сервер» всегда видно (предзаполнено lastServer/
      // backendUrl). Если server пуст — серверная часть подставит defaultBackendUrl
      // или ответит BAD_REQUEST («Не указан адрес сервера»).
      await loginWithPassword(server, username, password)
    } else {
      await login(apiKey, username || undefined)
    }
  }

  // На touch при фокусе поля раскрывается клавиатура и перекрывает форму.
  // Резервируем нижнюю половину экрана (класс login-screen--keyboard) и
  // прокручиваем страницу вниз — это поднимает форму над клавиатурой при любой
  // её высоте и независимо от того, обновляет ли браузер visualViewport
  // (в standalone-PWA, в частности iOS, высота клавиатуры может не сообщаться).
  const handleScreenFocus = (e: React.FocusEvent<HTMLDivElement>) => {
    if (!(e.target instanceof HTMLInputElement)) return
    if (blurTimerRef.current !== null) {
      window.clearTimeout(blurTimerRef.current)
      blurTimerRef.current = null
    }
    setKeyboardReserve(true)
    // даём клавиатуре/лейауту раскрыться, затем поднимаем форму вверх
    window.setTimeout(() => {
      const el = loginRef.current
      if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    }, 300)
  }

  const handleScreenBlur = (e: React.FocusEvent<HTMLDivElement>) => {
    if (!(e.target instanceof HTMLInputElement)) return
    if (blurTimerRef.current !== null) window.clearTimeout(blurTimerRef.current)
    // небольшая задержка, чтобы переход фокуса между полями не сбрасывал резерв
    blurTimerRef.current = window.setTimeout(() => setKeyboardReserve(false), 200)
  }

  useEffect(() => {
    return () => {
      if (blurTimerRef.current !== null) window.clearTimeout(blurTimerRef.current)
    }
  }, [])

  return (
    <div
      ref={loginRef}
      className={cn(
        'login-screen min-h-screen flex items-center justify-center bg-background',
        keyboardReserve && 'login-screen--keyboard'
      )}
      onFocus={handleScreenFocus}
      onBlur={handleScreenBlur}
    >
      <div className="my-auto w-full max-w-md p-8 rounded-xl border bg-background-secondary">
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
              {hybridEnabled && (
                <div className="flex flex-col gap-2">
                  <label className="text-sm font-medium text-foreground">
                    {t('auth.serverUrl')}
                  </label>
                  <input
                    type="text"
                    list="known-synth-servers"
                    value={server}
                    onChange={(e) => setServer(e.target.value)}
                    placeholder={
                      knownServers.length > 0
                        ? t('auth.serverKnown')
                        : t('auth.serverUrlPlaceholder')
                    }
                    autoComplete="url"
                    className={cn(
                      "w-full px-4 py-2.5 rounded-lg border bg-background text-foreground",
                      "placeholder:text-muted-foreground",
                      "focus:outline-none focus:ring-2 focus:ring-ring",
                      "transition-colors"
                    )}
                  />
                  {/* Варианты известных серверов (реестр профилей core). Пустой
                      список не мешает — datalist просто не показывает вариантов. */}
                  <datalist id="known-synth-servers">
                    {knownServers.map((url) => (
                      <option key={url} value={url} />
                    ))}
                  </datalist>
                </div>
              )}

              <div className="flex flex-col gap-2">
                <label className="text-sm font-medium text-foreground">
                  {t('auth.username')}
                </label>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      passwordRef.current?.focus()
                    }
                  }}
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
                  ref={passwordRef}
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && username && password) {
                      e.preventDefault()
                      e.currentTarget.form?.requestSubmit()
                    }
                  }}
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

        <div className="mt-6 text-center text-[0.7rem] text-muted-foreground">
          Synth v{SYNTH_VERSION}
        </div>
      </div>
    </div>
  )
}

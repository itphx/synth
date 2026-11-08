import { useState, useEffect, useRef } from 'react'
import { useAuthStore } from '@/stores/authStore'
import { api } from '@/lib/api/client'
import { synthApi } from '@/lib/api/synthApi'
import { useI18n } from '@/lib/i18n'
import { SynthLogo } from '@/components/ui'
import { Icon } from '@/components/icon/Icon'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { cn } from '@/lib/utils'

interface DebugUser {
  id: string
  username: string
}

/** Клавиатура «сообщается», если видимая область уменьшилась хотя бы на столько. */
const KEYBOARD_DETECT_DELTA_PX = 100
/** Как часто проверяем видимую область, пока ждём отчёт браузера о клавиатуре. */
const KEYBOARD_DETECT_INTERVAL_MS = 120
/** Сколько ждём отчёт браузера до включения фоллбека (резерв + прокрутка). */
const KEYBOARD_DETECT_TIMEOUT_MS = 600
/** Задержка прокрутки вниз после включения резерва (только фоллбек). */
const KEYBOARD_SCROLL_DELAY_MS = 300
/** Задержка снятия резерва на blur: переход фокуса между полями его не сбрасывает. */
const KEYBOARD_BLUR_DELAY_MS = 200

/**
 * Вердикт о клавиатуре, запомненный на время жизни формы (mount).
 * Возможности браузера в рамках сессии не меняются, поэтому повторные фокусы
 * его не пересчитывают: `reported` — резерв не нужен никогда, `fallback` —
 * резерв включается сразу, `unknown` — идёт первичный детект.
 */
type KeyboardMode = 'unknown' | 'reported' | 'fallback'

export const LoginForm = () => {
  const { t } = useI18n()
  const login = useAuthStore(s => s.login)
  const loginWithPassword = useAuthStore(s => s.loginWithPassword)
  const isLoading = useAuthStore(s => s.isLoading)
  const error = useAuthStore(s => s.error)
  const errorCode = useAuthStore(s => s.errorCode)
  const clearError = useAuthStore(s => s.clearError)
  // Возможности сервера берём из стора: их заполняет reauthenticate() из GET /auth/status.
  // AuthGate рендерит LoginForm только после isInitialized, поэтому первый кадр формы
  // сразу корректный — без промежуточной password-only ветки, к которой цеплялись
  // менеджеры паролей (KeePassXC/браузер).
  const oidcEnabled = useAuthStore(s => s.oidcEnabled)
  const debugMode = useAuthStore(s => s.debugMode)
  const deployment = useAuthStore(s => s.deployment)
  const [keyboardReserve, setKeyboardReserve] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [server, setServer] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [debugUsers, setDebugUsers] = useState<DebugUser[]>([])
  /** Гибридный режим реально включён (эндпоинт /hybrid/status ответил И enabled=true). */
  const [hybridEnabled, setHybridEnabled] = useState(false)
  /** Известные серверы из реестра профилей core (варианты для datalist поля «Сервер»). */
  const [knownServers, setKnownServers] = useState<string[]>([])
  /** Ссылка на поле пароля — перенос фокуса по Enter с поля логина (мобильная UX). */
  const passwordRef = useRef<HTMLInputElement>(null)
  const loginRef = useRef<HTMLDivElement>(null)
  const blurTimerRef = useRef<number | null>(null)
  /** Таймер окончания ожидания отчёта браузера о клавиатуре. */
  const detectStopTimerRef = useRef<number | null>(null)
  /** Опрос видимой области после фокуса поля. */
  const detectIntervalRef = useRef<number | null>(null)
  /** Отложенная прокрутка вниз — только в фоллбек-режиме. */
  const scrollTimerRef = useRef<number | null>(null)
  /** Вердикт браузера о клавиатуре — на весь срок жизни формы, blur его не сбрасывает. */
  const keyboardModeRef = useRef<KeyboardMode>('unknown')

  // Список debug-пользователей грузим только в debug-режиме (debugMode из стора).
  useEffect(() => {
    if (!debugMode) return
    let cancelled = false
    const loadUsers = async () => {
      try {
        const users = await api.getUsers()
        if (!cancelled) setDebugUsers(users.users)
      } catch {
        // Список недоступен — остаётся ручной ввод логина (input вместо select).
      }
    }
    void loadUsers()
    return () => {
      cancelled = true
    }
  }, [debugMode])

  // Гибрид: если сервер — standalone-core (имеет /hybrid/status), уточняем,
  // включён ли гибрид. Поле «Сервер» в гибриде показывается ВСЕГДА (даже
  // когда адрес известен core при старте): при протухшем токене пользователь
  // может сменить адрес. backendUrl/lastServer используем как предзаполнение.
  // На managed-бэкенде эндпоинта нет — запрос НЕ выполняем (0 сетевых
  // запросов → нет 404), поле адреса скрыто (hybridEnabled=false).
  useEffect(() => {
    if (!(deployment === 'standalone' && oidcEnabled)) {
      setHybridEnabled(false)
      return
    }
    let cancelled = false
    const loadHybrid = async () => {
      const hybrid = await synthApi.getHybridStatus().catch(() => null)
      if (cancelled) return
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
    }
    void loadHybrid()
    return () => {
      cancelled = true
    }
  }, [deployment, oidcEnabled])

  /** Отправка формы: общая точка для submit и кнопки «Повторить» (офлайн-блок). */
  const submit = async () => {
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    await submit()
  }

  // Сервер недоступен (сеть/таймаут) — отдельный блок с подсказкой и повтором:
  // это не «неверный пароль», и текст ошибки без причины не помогает.
  const serverUnreachable = error != null && errorCode === 'OFFLINE'

  // Фоллбек для браузеров без отчёта о клавиатуре: резерв нижней половины
  // экрана и прокрутка формы вниз. Режим запоминаем до размонтирования —
  // повторный фокус (в т.ч. на другом поле) включает резерв сразу.
  const enableKeyboardFallback = () => {
    keyboardModeRef.current = 'fallback'
    setKeyboardReserve(true)
    if (scrollTimerRef.current !== null) window.clearTimeout(scrollTimerRef.current)
    scrollTimerRef.current = window.setTimeout(() => {
      scrollTimerRef.current = null
      const el = loginRef.current
      if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    }, KEYBOARD_SCROLL_DELAY_MS)
  }

  // На touch при фокусе поля раскрывается клавиатура. Современные браузеры
  // (Android с interactive-widget=resizes-content, iOS через visualViewport)
  // сообщают её высоту: видимая область уменьшается, а шелл уже сжимается по
  // --synth-app-height (useViewportHeight). В этом случае форма остаётся у
  // верхнего края — без резерва и программной прокрутки.
  // Если браузер высоту клавиатуры не сообщает (видимая область не изменилась),
  // включаем прежний фоллбек: класс login-screen--keyboard (резерв 50vh) и
  // прокрутку формы вниз — только для таких браузеров, чтобы клавиатура не
  // учитывалась дважды.
  const handleScreenFocus = (e: React.FocusEvent<HTMLDivElement>) => {
    if (!(e.target instanceof HTMLInputElement)) return
    if (blurTimerRef.current !== null) {
      window.clearTimeout(blurTimerRef.current)
      blurTimerRef.current = null
    }
    // Вердикт уже вынесен — повторные фокусы его не пересчитывают. В fallback
    // резерв включаем сразу: иначе на втором поле (клавиатура уже открыта,
    // базовая высота уже уменьшена) детект не увидел бы изменения и ошибочно
    // включил бы резерв ещё раз.
    if (keyboardModeRef.current === 'reported') return
    if (keyboardModeRef.current === 'fallback') {
      enableKeyboardFallback()
      return
    }
    // Опрос уже идёт (переход фокуса до истечения окна) — базу не пересчитываем.
    if (detectIntervalRef.current !== null) return

    const visibleHeight = () =>
      Math.min(window.visualViewport?.height ?? window.innerHeight, window.innerHeight)
    const baseHeight = visibleHeight()

    detectIntervalRef.current = window.setInterval(() => {
      if (baseHeight - visibleHeight() < KEYBOARD_DETECT_DELTA_PX) return
      // Браузер сообщил клавиатуру — резерв не нужен, прокрутку не делаем.
      keyboardModeRef.current = 'reported'
      if (detectIntervalRef.current !== null) {
        window.clearInterval(detectIntervalRef.current)
        detectIntervalRef.current = null
      }
      if (detectStopTimerRef.current !== null) {
        window.clearTimeout(detectStopTimerRef.current)
        detectStopTimerRef.current = null
      }
    }, KEYBOARD_DETECT_INTERVAL_MS)

    detectStopTimerRef.current = window.setTimeout(() => {
      detectStopTimerRef.current = null
      if (detectIntervalRef.current !== null) {
        window.clearInterval(detectIntervalRef.current)
        detectIntervalRef.current = null
      }
      if (keyboardModeRef.current === 'reported') return
      enableKeyboardFallback()
    }, KEYBOARD_DETECT_TIMEOUT_MS)
  }

  const handleScreenBlur = (e: React.FocusEvent<HTMLDivElement>) => {
    if (!(e.target instanceof HTMLInputElement)) return
    if (blurTimerRef.current !== null) window.clearTimeout(blurTimerRef.current)
    // небольшая задержка, чтобы переход фокуса между полями не сбрасывал резерв
    blurTimerRef.current = window.setTimeout(() => {
      blurTimerRef.current = null
      // Полный уход фокуса — прекращаем опрос клавиатуры и снимаем фоллбек.
      // Вердикт (keyboardModeRef) НЕ сбрасываем: возможность браузера сообщать
      // клавиатуру не меняется, иначе на втором поле резерв включился бы заново.
      if (detectIntervalRef.current !== null) {
        window.clearInterval(detectIntervalRef.current)
        detectIntervalRef.current = null
      }
      if (detectStopTimerRef.current !== null) {
        window.clearTimeout(detectStopTimerRef.current)
        detectStopTimerRef.current = null
      }
      // Иначе отложенная прокрутка вниз перебьёт возврат формы наверх.
      if (scrollTimerRef.current !== null) {
        window.clearTimeout(scrollTimerRef.current)
        scrollTimerRef.current = null
      }
      setKeyboardReserve(false)
      const el = loginRef.current
      if (el) el.scrollTo({ top: 0, behavior: 'smooth' })
    }, KEYBOARD_BLUR_DELAY_MS)
  }

  useEffect(() => {
    return () => {
      if (blurTimerRef.current !== null) window.clearTimeout(blurTimerRef.current)
      if (detectStopTimerRef.current !== null) window.clearTimeout(detectStopTimerRef.current)
      if (detectIntervalRef.current !== null) window.clearInterval(detectIntervalRef.current)
      if (scrollTimerRef.current !== null) window.clearTimeout(scrollTimerRef.current)
    }
  }, [])

  return (
    <div
      ref={loginRef}
      className={cn(
        'login-screen viewport-min-h flex items-center justify-center bg-background',
        keyboardReserve && 'login-screen--keyboard'
      )}
      onFocus={handleScreenFocus}
      onBlur={handleScreenBlur}
    >
      <div className="relative my-auto w-full max-w-md rounded-xl bg-card p-8 ring-1 ring-foreground/10 shadow-xl">
        {/* Тонкая акцентная линия сверху карточки — цвет акцента темы.
            Блик смещён влево (via-30%) под наклонный свет из верхнего-левого угла. */}
        <div className="pointer-events-none absolute inset-x-0 top-0 h-0.5 rounded-t-xl bg-gradient-to-r from-transparent via-primary/70 via-30% to-transparent" />
        <div className="flex flex-col items-center gap-4 mb-8">
          <div className="relative isolate">
            {/* Мягкое свечение за логотипом; не перекрывает контент */}
            <div
              className="pointer-events-none absolute inset-0 -z-10 rounded-full bg-primary/20 blur-2xl"
              aria-hidden="true"
            />
            <SynthLogo variant="brand" width={88} height={88} />
          </div>
          <h1 className="text-2xl font-bold text-foreground">{t('auth.loginTitle')}</h1>
          <p className="text-sm text-muted-foreground text-center">
            {oidcEnabled ? t('auth.loginSubtitleOidc') : t('auth.loginSubtitle')}
          </p>
        </div>

        <form
          onSubmit={handleSubmit}
          name="synth-login"
          autoComplete="on"
          className="flex flex-col gap-4"
        >
          {oidcEnabled ? (
            <>
              {hybridEnabled && (
                <div className="flex flex-col gap-2">
                  <label htmlFor="synth-login-server" className="text-sm font-medium text-foreground">
                    {t('auth.serverUrl')}
                  </label>
                  <input
                    id="synth-login-server"
                    name="server"
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
                <label htmlFor="synth-login-username" className="text-sm font-medium text-foreground">
                  {t('auth.username')}
                </label>
                <input
                  id="synth-login-username"
                  name="username"
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
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  className={cn(
                    "w-full px-4 py-2.5 rounded-lg border bg-background text-foreground",
                    "placeholder:text-muted-foreground",
                    "focus:outline-none focus:ring-2 focus:ring-ring",
                    "transition-colors"
                  )}
                />
              </div>

              <div className="flex flex-col gap-2">
                <label htmlFor="synth-login-password" className="text-sm font-medium text-foreground">
                  {t('auth.password')}
                </label>
                <input
                  id="synth-login-password"
                  name="password"
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
              {debugMode && (
                <div className="flex flex-col gap-2">
                  <label htmlFor="synth-login-username" className="text-sm font-medium text-foreground">
                    {t('auth.username')}
                  </label>
                  {debugUsers.length > 0 ? (
                    <Select value={username} onValueChange={setUsername}>
                      <SelectTrigger
                        id="synth-login-username"
                        size="none"
                        className="w-full rounded-lg border bg-background px-4 py-2.5 pr-4 text-base text-foreground"
                      >
                        <span className="truncate flex-1 text-left">
                          {username || t('auth.selectUser')}
                        </span>
                        <Icon name="arrow-down-s" className="size-4 shrink-0 opacity-50" aria-hidden="true" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="">{t('auth.selectUser')}</SelectItem>
                        {debugUsers.map((u) => (
                          <SelectItem key={u.id} value={u.username}>{u.username}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <input
                      id="synth-login-username"
                      name="username"
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
                  )}
                </div>
              )}

              <div className="flex flex-col gap-2">
                <label htmlFor="synth-login-apikey" className="text-sm font-medium text-foreground">
                  {t('auth.apiKey')}
                </label>
                <input
                  id="synth-login-apikey"
                  name="apiKey"
                  type="password"
                  autoComplete="off"
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

          {serverUnreachable ? (
            <div
              data-testid="login-server-unreachable"
              className="flex flex-col gap-2 p-3 rounded-lg bg-status-warning/10 text-status-warning text-sm"
            >
              <div className="flex items-center gap-2">
                <Icon name="error-warning" className="size-4 shrink-0" />
                <span className="font-medium">{t('login.serverUnreachable')}</span>
              </div>
              <div className="text-xs break-words opacity-90">{error}</div>
              <div className="text-xs opacity-80">{t('login.serverUnreachableHint')}</div>
              <button
                type="button"
                onClick={() => void submit()}
                disabled={isLoading}
                className={cn(
                  'self-start px-3 py-1.5 rounded-md text-xs font-medium',
                  'bg-status-warning/20 hover:bg-status-warning/30',
                  'disabled:opacity-50 disabled:cursor-not-allowed',
                  'transition-colors'
                )}
              >
                {t('login.retry')}
              </button>
            </div>
          ) : error && (
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
                : !apiKey || (debugMode && !username))
            }
            className={cn(
              "w-full px-4 py-2.5 rounded-lg font-medium text-primary-foreground",
              "bg-primary hover:bg-primary/90",
              "shadow-lg shadow-primary/25",
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

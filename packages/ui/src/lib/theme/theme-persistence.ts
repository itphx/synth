/**
 * Долговременное хранение выбора темы для экрана входа.
 *
 * Тема — браузерная настройка, которая переживает logout: экран логина должен
 * быть в последней использованной теме ещё до загрузки профиля. Значения
 * дублируются в cookie (доступна pre-paint-скрипту `index.html` до загрузки
 * основного бандла) и в localStorage (обратная совместимость с уже сохранёнными
 * у пользователя значениями). При чтении cookie имеет приоритет.
 *
 * Модуль SSR-safe и не тянет внешних зависимостей.
 */

export type PersistedThemeMode = 'system' | 'light' | 'dark'
export type PersistedThemeVariant = 'light' | 'dark'

export interface PersistedTheme {
  theme: string
  themeMode: PersistedThemeMode
  selectedThemeId: string | null
  selectedThemeVariant: PersistedThemeVariant | null
  splashBgLight: string | null
  splashBgDark: string | null
}

const COOKIE_MAX_AGE_SECONDS = 31536000

/** Соответствие полей: cookie-имя ↔ legacy localStorage-ключ. */
const STORAGE_MAP = {
  theme: { cookie: 'synth_theme', storage: 'theme' },
  themeMode: { cookie: 'synth_theme_mode', storage: 'themeMode' },
  selectedThemeId: { cookie: 'synth_theme_id', storage: 'selectedThemeId' },
  selectedThemeVariant: { cookie: 'synth_theme_variant', storage: 'selectedThemeVariant' },
  splashBgLight: { cookie: 'synth_splash_bg_light', storage: 'splashBgLight' },
  splashBgDark: { cookie: 'synth_splash_bg_dark', storage: 'splashBgDark' },
} as const

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') {
    return null
  }
  const raw = document.cookie
  if (!raw) {
    return null
  }
  const prefix = `${name}=`
  for (const part of raw.split(';')) {
    const segment = part.trim()
    if (segment.startsWith(prefix)) {
      const value = segment.slice(prefix.length)
      try {
        return decodeURIComponent(value)
      } catch {
        return value
      }
    }
  }
  return null
}

function writeCookie(name: string, value: string): void {
  if (typeof document === 'undefined') {
    return
  }
  const secure =
    typeof window !== 'undefined' && window.location?.protocol === 'https:' ? '; Secure' : ''
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE_SECONDS}${secure}`
}

function readStorage(key: string): string | null {
  if (typeof window === 'undefined') {
    return null
  }
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStorage(key: string, value: string): void {
  if (typeof window === 'undefined') {
    return
  }
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // Приватный режим/переполнение — cookie остаётся резервным хранилищем.
  }
}

function writeEntry(cookieName: string, storageKey: string, value: string): void {
  writeCookie(cookieName, value)
  writeStorage(storageKey, value)
}

/** Читает сохранённую тему; cookie приоритетнее localStorage. */
export function readThemePersistence(): Partial<PersistedTheme> {
  const result: Partial<PersistedTheme> = {}

  const read = (key: keyof PersistedTheme): string | null =>
    readCookie(STORAGE_MAP[key].cookie) ?? readStorage(STORAGE_MAP[key].storage)

  const theme = read('theme')
  if (theme && theme.trim().length > 0) {
    result.theme = theme.trim()
  }

  const themeMode = read('themeMode')
  if (themeMode === 'system' || themeMode === 'light' || themeMode === 'dark') {
    result.themeMode = themeMode
  }

  const selectedThemeId = read('selectedThemeId')
  if (selectedThemeId && selectedThemeId.trim().length > 0) {
    result.selectedThemeId = selectedThemeId.trim()
  }

  const selectedThemeVariant = read('selectedThemeVariant')
  if (selectedThemeVariant === 'light' || selectedThemeVariant === 'dark') {
    result.selectedThemeVariant = selectedThemeVariant
  }

  const splashBgLight = read('splashBgLight')
  if (splashBgLight && splashBgLight.trim().length > 0) {
    result.splashBgLight = splashBgLight
  }

  const splashBgDark = read('splashBgDark')
  if (splashBgDark && splashBgDark.trim().length > 0) {
    result.splashBgDark = splashBgDark
  }

  return result
}

/** Пишет переданные поля и в cookie, и в localStorage. Отсутствующие поля не трогает. */
export function writeThemePersistence(p: Partial<PersistedTheme>): void {
  if ('theme' in p && p.theme !== undefined) {
    writeEntry(STORAGE_MAP.theme.cookie, STORAGE_MAP.theme.storage, p.theme)
  }
  if ('themeMode' in p && p.themeMode !== undefined) {
    writeEntry(STORAGE_MAP.themeMode.cookie, STORAGE_MAP.themeMode.storage, p.themeMode)
  }
  if ('selectedThemeId' in p && p.selectedThemeId !== undefined) {
    writeEntry(
      STORAGE_MAP.selectedThemeId.cookie,
      STORAGE_MAP.selectedThemeId.storage,
      p.selectedThemeId ?? '',
    )
  }
  if ('selectedThemeVariant' in p && p.selectedThemeVariant !== undefined) {
    writeEntry(
      STORAGE_MAP.selectedThemeVariant.cookie,
      STORAGE_MAP.selectedThemeVariant.storage,
      p.selectedThemeVariant ?? '',
    )
  }
  if ('splashBgLight' in p && p.splashBgLight !== undefined) {
    writeEntry(
      STORAGE_MAP.splashBgLight.cookie,
      STORAGE_MAP.splashBgLight.storage,
      p.splashBgLight ?? '',
    )
  }
  if ('splashBgDark' in p && p.splashBgDark !== undefined) {
    writeEntry(
      STORAGE_MAP.splashBgDark.cookie,
      STORAGE_MAP.splashBgDark.storage,
      p.splashBgDark ?? '',
    )
  }
}

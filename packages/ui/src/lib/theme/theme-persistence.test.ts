import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readThemePersistence, writeThemePersistence } from './theme-persistence'

const COOKIE_NAMES = [
  'synth_theme',
  'synth_theme_mode',
  'synth_theme_id',
  'synth_theme_variant',
  'synth_splash_bg_light',
  'synth_splash_bg_dark',
]

function clearCookies() {
  for (const name of COOKIE_NAMES) {
    document.cookie = `${name}=; path=/; Max-Age=0`
  }
}

function createMemoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (key: string) => (map.has(key) ? map.get(key)! : null),
    key: (index: number) => Array.from(map.keys())[index] ?? null,
    removeItem: (key: string) => {
      map.delete(key)
    },
    setItem: (key: string, value: string) => {
      map.set(key, String(value))
    },
  }
}

// В окружении vitest `window.localStorage` не поднят (Node 22 перебивает
// populate jsdom), поэтому подставляем in-memory-хранилище.
function installStorage(): Storage {
  const storage = createMemoryStorage()
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    writable: true,
    value: storage,
  })
  return storage
}

describe('theme-persistence: запись/чтение', () => {
  let storage: Storage

  beforeEach(() => {
    clearCookies()
    storage = installStorage()
  })

  afterEach(() => {
    clearCookies()
  })

  it('пишет значения и в cookie, и в localStorage', () => {
    writeThemePersistence({
      theme: 'arctic',
      themeMode: 'dark',
      selectedThemeId: 'arctic-dark',
      selectedThemeVariant: 'dark',
      splashBgLight: '#ffffff',
      splashBgDark: '#000000',
    })

    expect(document.cookie).toContain('synth_theme=arctic')
    expect(document.cookie).toContain('synth_theme_mode=dark')
    expect(storage.getItem('theme')).toBe('arctic')
    expect(storage.getItem('themeMode')).toBe('dark')
    expect(storage.getItem('selectedThemeId')).toBe('arctic-dark')
    expect(storage.getItem('selectedThemeVariant')).toBe('dark')
    expect(storage.getItem('splashBgLight')).toBe('#ffffff')
    expect(storage.getItem('splashBgDark')).toBe('#000000')
  })

  it('читает обратно полный набор (значения декодируются из cookie)', () => {
    writeThemePersistence({
      theme: 'arctic',
      themeMode: 'dark',
      selectedThemeId: 'arctic-dark',
      selectedThemeVariant: 'dark',
      splashBgLight: '#ffffff',
      splashBgDark: '#000000',
    })

    expect(readThemePersistence()).toEqual({
      theme: 'arctic',
      themeMode: 'dark',
      selectedThemeId: 'arctic-dark',
      selectedThemeVariant: 'dark',
      splashBgLight: '#ffffff',
      splashBgDark: '#000000',
    })
  })

  it('cookie приоритетнее localStorage при рассинхроне', () => {
    storage.setItem('theme', 'synthesis')
    storage.setItem('themeMode', 'system')
    document.cookie = 'synth_theme=arctic; path=/'
    document.cookie = 'synth_theme_mode=dark; path=/'

    const read = readThemePersistence()
    expect(read.theme).toBe('arctic')
    expect(read.themeMode).toBe('dark')
  })

  it('без cookie падает обратно на legacy-ключи localStorage', () => {
    storage.setItem('theme', 'nightowl')
    storage.setItem('themeMode', 'light')
    storage.setItem('selectedThemeId', 'nightowl-light')
    storage.setItem('selectedThemeVariant', 'light')

    expect(readThemePersistence()).toEqual({
      theme: 'nightowl',
      themeMode: 'light',
      selectedThemeId: 'nightowl-light',
      selectedThemeVariant: 'light',
    })
  })

  it('невалидные режим/вариант игнорируются', () => {
    storage.setItem('themeMode', 'sepia')
    storage.setItem('selectedThemeVariant', 'midnight')

    const read = readThemePersistence()
    expect(read.themeMode).toBeUndefined()
    expect(read.selectedThemeVariant).toBeUndefined()
  })

  it('не трогает отсутствующие в partial поля', () => {
    writeThemePersistence({ theme: 'arctic', themeMode: 'dark' })

    writeThemePersistence({ theme: 'synthesis' })

    expect(storage.getItem('theme')).toBe('synthesis')
    expect(storage.getItem('themeMode')).toBe('dark')
    expect(document.cookie).toContain('synth_theme_mode=dark')
  })
})

describe('theme-persistence: SSR-safe', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('без document/window чтение возвращает пусто, запись не бросает', () => {
    vi.stubGlobal('document', undefined)
    vi.stubGlobal('window', undefined)

    expect(readThemePersistence()).toEqual({})
    expect(() => writeThemePersistence({ theme: 'arctic', themeMode: 'dark' })).not.toThrow()
  })
})

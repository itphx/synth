import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// vitest/jsdom в этом окружении не даёт localStorage без --localstorage-file —
// ставим in-memory заглушку до импорта модуля (см. useUIStore.test.ts).
const storage = vi.hoisted(() => {
  const data = new Map<string, string>()
  const ls = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      data.set(k, v)
    },
    removeItem: (k: string) => {
      data.delete(k)
    },
    clear: () => {
      data.clear()
    },
  }
  Object.defineProperty(globalThis, 'localStorage', { value: ls, configurable: true })
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'localStorage', { value: ls, configurable: true })
  }
  return ls
})

import {
  UI_SCALE_DEFAULT,
  UI_SCALE_DESKTOP_DEFAULT,
  UI_SCALE_MAX,
  UI_SCALE_MIN,
  UI_SCALE_MOBILE_DEFAULT,
  UI_SCALE_STORAGE_KEY,
  applyServerDefaultUiScale,
  applyUiScale,
  getBuiltInDefaultUiScale,
  getDefaultUiScale,
  getServerDefaultUiScale,
  hasLocalUiScale,
  isMobileScaleDevice,
  normalizeUiScale,
  persistUiScale,
  readUiScale,
  setServerScaleDefaults,
} from './uiScale'

function stubMatchMedia(matches: (query: string) => boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) =>
      ({
        matches: matches(query),
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  })
}

function restoreMatchMedia(): void {
  delete (window as unknown as { matchMedia?: unknown }).matchMedia
}

describe('getDefaultUiScale', () => {
  afterEach(() => {
    restoreMatchMedia()
  })

  it('без matchMedia (jsdom/сервер) → десктопный дефолт 1', () => {
    restoreMatchMedia()
    expect(getDefaultUiScale()).toBe(UI_SCALE_DESKTOP_DEFAULT)
  })

  it('мобильный вьюпорт (≤1199px) → 0.85', () => {
    stubMatchMedia((q) => q.includes('max-width: 1199px'))
    expect(getDefaultUiScale()).toBe(UI_SCALE_MOBILE_DEFAULT)
  })

  it('PWA standalone → 0.85', () => {
    stubMatchMedia((q) => q.includes('display-mode: standalone'))
    expect(getDefaultUiScale()).toBe(UI_SCALE_MOBILE_DEFAULT)
  })

  it('десктопный вьюпорт без PWA → 1', () => {
    stubMatchMedia(() => false)
    expect(getDefaultUiScale()).toBe(UI_SCALE_DESKTOP_DEFAULT)
  })
})

describe('normalizeUiScale', () => {
  it('значения в диапазоне возвращает как есть', () => {
    expect(normalizeUiScale(0.5)).toBe(0.5)
    expect(normalizeUiScale(1)).toBe(1)
    expect(normalizeUiScale(1.2)).toBe(1.2)
  })

  it('ниже минимума клампит к 0.5', () => {
    expect(normalizeUiScale(0.3)).toBe(UI_SCALE_MIN)
    expect(normalizeUiScale(-1)).toBe(UI_SCALE_MIN)
  })

  it('выше максимума клампит к 1.2', () => {
    expect(normalizeUiScale(2)).toBe(UI_SCALE_MAX)
    expect(normalizeUiScale(1.5)).toBe(UI_SCALE_MAX)
  })

  it('числовые строки парсит', () => {
    expect(normalizeUiScale('0.9')).toBe(0.9)
    expect(normalizeUiScale('1.2')).toBe(1.2)
  })

  it('мусор/NaN/Infinity → дефолт', () => {
    expect(normalizeUiScale(NaN)).toBe(UI_SCALE_DEFAULT)
    expect(normalizeUiScale(Infinity)).toBe(UI_SCALE_DEFAULT)
    expect(normalizeUiScale(undefined)).toBe(UI_SCALE_DEFAULT)
    expect(normalizeUiScale(null)).toBe(UI_SCALE_DEFAULT)
    expect(normalizeUiScale('abc')).toBe(UI_SCALE_DEFAULT)
    expect(normalizeUiScale({})).toBe(UI_SCALE_DEFAULT)
  })

  it('мусор на мобильном вьюпорте → мобильный дефолт 0.85', () => {
    stubMatchMedia((q) => q.includes('max-width: 1199px'))
    try {
      expect(normalizeUiScale(NaN)).toBe(UI_SCALE_MOBILE_DEFAULT)
      expect(normalizeUiScale('abc')).toBe(UI_SCALE_MOBILE_DEFAULT)
    } finally {
      restoreMatchMedia()
    }
  })
})

describe('applyUiScale', () => {
  afterEach(() => {
    document.documentElement.style.removeProperty('--ui-scale')
  })

  it('выставляет --ui-scale на documentElement', () => {
    applyUiScale(1.15)
    expect(document.documentElement.style.getPropertyValue('--ui-scale')).toBe('1.15')
  })

  it('нормализует значение перед записью', () => {
    applyUiScale(3)
    expect(document.documentElement.style.getPropertyValue('--ui-scale')).toBe('1.2')
  })
})

describe('readUiScale', () => {
  beforeEach(() => {
    storage.clear()
  })

  afterEach(() => {
    restoreMatchMedia()
  })

  it('без сохранённого значения на десктопе → 1', () => {
    expect(readUiScale()).toBe(UI_SCALE_DESKTOP_DEFAULT)
  })

  it('без сохранённого значения на мобильном вьюпорте → 0.85', () => {
    stubMatchMedia((q) => q.includes('max-width: 1199px'))
    expect(readUiScale()).toBe(UI_SCALE_MOBILE_DEFAULT)
  })

  it('сохранённое значение приоритетнее платформенного дефолта', () => {
    stubMatchMedia((q) => q.includes('max-width: 1199px'))
    storage.setItem(UI_SCALE_STORAGE_KEY, '1.1')
    expect(readUiScale()).toBe(1.1)
  })

  it('читает и клампит сохранённое значение', () => {
    storage.setItem(UI_SCALE_STORAGE_KEY, '0.9')
    expect(readUiScale()).toBe(0.9)

    storage.setItem(UI_SCALE_STORAGE_KEY, '5')
    expect(readUiScale()).toBe(UI_SCALE_MAX)
  })

  it('мусор в хранилище → платформенный дефолт', () => {
    storage.setItem(UI_SCALE_STORAGE_KEY, 'oops')
    expect(readUiScale()).toBe(UI_SCALE_DEFAULT)

    stubMatchMedia((q) => q.includes('max-width: 1199px'))
    expect(readUiScale()).toBe(UI_SCALE_MOBILE_DEFAULT)
  })
})

describe('persistUiScale (дебаунс записи в localStorage)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    storage.clear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('пишет в localStorage только после задержки ~300мс', () => {
    persistUiScale(0.9)
    expect(storage.getItem(UI_SCALE_STORAGE_KEY)).toBeNull()

    vi.advanceTimersByTime(300)
    expect(storage.getItem(UI_SCALE_STORAGE_KEY)).toBe('0.9')
  })

  it('серия вызовов схлопывается в одну запись с последним значением', () => {
    persistUiScale(0.85)
    vi.advanceTimersByTime(100)
    persistUiScale(1.2)
    vi.advanceTimersByTime(300)

    expect(storage.getItem(UI_SCALE_STORAGE_KEY)).toBe('1.2')
  })
})

describe('isMobileScaleDevice / getBuiltInDefaultUiScale', () => {
  afterEach(() => {
    restoreMatchMedia()
  })

  it('без matchMedia (jsdom/сервер) → десктоп', () => {
    restoreMatchMedia()
    expect(isMobileScaleDevice()).toBe(false)
    expect(getBuiltInDefaultUiScale()).toBe(UI_SCALE_DESKTOP_DEFAULT)
  })

  it('мобильный вьюпорт (≤1199px) → мобильный дефолт', () => {
    stubMatchMedia((q) => q.includes('max-width: 1199px'))
    expect(isMobileScaleDevice()).toBe(true)
    expect(getBuiltInDefaultUiScale()).toBe(UI_SCALE_MOBILE_DEFAULT)
  })

  it('PWA standalone → мобильный дефолт', () => {
    stubMatchMedia((q) => q.includes('display-mode: standalone'))
    expect(isMobileScaleDevice()).toBe(true)
    expect(getBuiltInDefaultUiScale()).toBe(UI_SCALE_MOBILE_DEFAULT)
  })
})

describe('setServerScaleDefaults / getServerDefaultUiScale', () => {
  afterEach(() => {
    setServerScaleDefaults({ mobile: null, desktop: null })
    restoreMatchMedia()
  })

  it('серверное умолчание приоритетнее встроенного', () => {
    stubMatchMedia(() => false)
    setServerScaleDefaults({ mobile: 0.9, desktop: 1.1 })
    expect(getServerDefaultUiScale()).toBe(1.1)
    expect(getDefaultUiScale()).toBe(1.1)
  })

  it('mobile и desktop независимы', () => {
    setServerScaleDefaults({ mobile: 0.9, desktop: 1.1 })

    stubMatchMedia(() => false)
    expect(getServerDefaultUiScale()).toBe(1.1)

    stubMatchMedia((q) => q.includes('max-width: 1199px'))
    expect(getServerDefaultUiScale()).toBe(0.9)
  })

  it('если серверное значение для платформы не задано → встроенный дефолт', () => {
    stubMatchMedia(() => false)
    setServerScaleDefaults({ mobile: 0.9 })
    expect(getServerDefaultUiScale()).toBeNull()
    expect(getDefaultUiScale()).toBe(UI_SCALE_DESKTOP_DEFAULT)
  })

  it('значения клампятся, null/невалид сбрасывают умолчание', () => {
    stubMatchMedia(() => false)
    setServerScaleDefaults({ desktop: 5 })
    expect(getServerDefaultUiScale()).toBe(UI_SCALE_MAX)

    setServerScaleDefaults({ desktop: 0.1 })
    expect(getServerDefaultUiScale()).toBe(UI_SCALE_MIN)

    setServerScaleDefaults({ desktop: NaN })
    expect(getServerDefaultUiScale()).toBeNull()

    setServerScaleDefaults({ desktop: 'oops' as unknown as number })
    expect(getServerDefaultUiScale()).toBeNull()
  })
})

describe('hasLocalUiScale / applyServerDefaultUiScale', () => {
  beforeEach(() => {
    storage.clear()
  })

  afterEach(() => {
    setServerScaleDefaults({ mobile: null, desktop: null })
    restoreMatchMedia()
    document.documentElement.style.removeProperty('--ui-scale')
  })

  it('hasLocalUiScale отражает наличие личного значения', () => {
    expect(hasLocalUiScale()).toBe(false)
    storage.setItem(UI_SCALE_STORAGE_KEY, '1')
    expect(hasLocalUiScale()).toBe(true)
  })

  it('без личного значения применяет серверный дефолт и НЕ пишет в localStorage', () => {
    stubMatchMedia(() => false)
    setServerScaleDefaults({ desktop: 1.1 })
    expect(applyServerDefaultUiScale()).toBe(true)
    expect(document.documentElement.style.getPropertyValue('--ui-scale')).toBe('1.1')
    expect(storage.getItem(UI_SCALE_STORAGE_KEY)).toBeNull()
  })

  it('при личном значении серверный дефолт не применяется и не перезаписывается', () => {
    stubMatchMedia(() => false)
    storage.setItem(UI_SCALE_STORAGE_KEY, '0.7')
    setServerScaleDefaults({ desktop: 1.1 })
    expect(applyServerDefaultUiScale()).toBe(false)
    expect(document.documentElement.style.getPropertyValue('--ui-scale')).toBe('')
    expect(storage.getItem(UI_SCALE_STORAGE_KEY)).toBe('0.7')
  })
})

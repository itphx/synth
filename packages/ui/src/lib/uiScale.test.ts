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
  CHAT_SCALE_DEFAULT,
  CHAT_SCALE_MAX,
  CHAT_SCALE_MIN,
  CHAT_SCALE_MIN_TOUCH,
  CHAT_SCALE_STORAGE_KEY,
  UI_SCALE_DEFAULT,
  UI_SCALE_DESKTOP_DEFAULT,
  UI_SCALE_MAX,
  UI_SCALE_MIN,
  UI_SCALE_MOBILE_DEFAULT,
  UI_SCALE_STORAGE_KEY,
  applyChatScale,
  applyServerDefaultUiScale,
  applyUiScale,
  getBuiltInDefaultUiScale,
  getChatScaleMin,
  getDefaultUiScale,
  getServerDefaultUiScale,
  hasLocalChatScale,
  hasLocalUiScale,
  isMobileScaleDevice,
  normalizeChatScale,
  normalizeUiScale,
  persistChatScale,
  persistUiScale,
  readChatScale,
  readUiScale,
  setChatScale,
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

describe('normalizeChatScale', () => {
  afterEach(() => {
    restoreMatchMedia()
  })

  it('значения в диапазоне возвращает как есть', () => {
    expect(normalizeChatScale(0.75)).toBe(CHAT_SCALE_MIN)
    expect(normalizeChatScale(1)).toBe(1)
    expect(normalizeChatScale(1.5)).toBe(CHAT_SCALE_MAX)
  })

  it('клампит к 0.75…1.5 на десктопе', () => {
    expect(normalizeChatScale(0.2)).toBe(CHAT_SCALE_MIN)
    expect(normalizeChatScale(3)).toBe(CHAT_SCALE_MAX)
  })

  it('числовые строки парсит', () => {
    expect(normalizeChatScale('1.2')).toBe(1.2)
  })

  it('мусор/NaN/Infinity → дефолт 1', () => {
    expect(normalizeChatScale(NaN)).toBe(CHAT_SCALE_DEFAULT)
    expect(normalizeChatScale(Infinity)).toBe(CHAT_SCALE_DEFAULT)
    expect(normalizeChatScale(undefined)).toBe(CHAT_SCALE_DEFAULT)
    expect(normalizeChatScale('abc')).toBe(CHAT_SCALE_DEFAULT)
    expect(normalizeChatScale({})).toBe(CHAT_SCALE_DEFAULT)
  })

  it('на мобильном вьюпорте нижний порог — 0.85', () => {
    stubMatchMedia((q) => q.includes('max-width: 1199px'))
    expect(getChatScaleMin()).toBe(CHAT_SCALE_MIN_TOUCH)
    expect(normalizeChatScale(0.75)).toBe(CHAT_SCALE_MIN_TOUCH)
    expect(normalizeChatScale(0.5)).toBe(CHAT_SCALE_MIN_TOUCH)
    // верхняя граница и дефолт не меняются
    expect(normalizeChatScale(2)).toBe(CHAT_SCALE_MAX)
    expect(normalizeChatScale('oops')).toBe(CHAT_SCALE_DEFAULT)
  })

  it('на десктопе нижний порог — 0.75', () => {
    stubMatchMedia(() => false)
    expect(getChatScaleMin()).toBe(CHAT_SCALE_MIN)
  })
})

describe('applyChatScale', () => {
  afterEach(() => {
    document.documentElement.style.removeProperty('--chat-scale')
    restoreMatchMedia()
  })

  it('выставляет --chat-scale на documentElement', () => {
    applyChatScale(1.2)
    expect(document.documentElement.style.getPropertyValue('--chat-scale')).toBe('1.2')
  })

  it('нормализует значение перед записью', () => {
    applyChatScale(9)
    expect(document.documentElement.style.getPropertyValue('--chat-scale')).toBe('1.5')
  })

  it('не трогает --ui-scale', () => {
    applyUiScale(1.1)
    applyChatScale(1.3)

    expect(document.documentElement.style.getPropertyValue('--ui-scale')).toBe('1.1')
    expect(document.documentElement.style.getPropertyValue('--chat-scale')).toBe('1.3')

    document.documentElement.style.removeProperty('--ui-scale')
  })
})

describe('applyUiScale не трогает --chat-scale', () => {
  afterEach(() => {
    document.documentElement.style.removeProperty('--ui-scale')
    document.documentElement.style.removeProperty('--chat-scale')
  })

  it('общий масштаб и масштаб чата независимы', () => {
    applyChatScale(1.15)
    applyUiScale(0.9)

    expect(document.documentElement.style.getPropertyValue('--ui-scale')).toBe('0.9')
    expect(document.documentElement.style.getPropertyValue('--chat-scale')).toBe('1.15')
  })
})

describe('readChatScale / hasLocalChatScale', () => {
  beforeEach(() => {
    storage.clear()
  })

  afterEach(() => {
    restoreMatchMedia()
  })

  it('без сохранённого значения → 1 (на любой платформе)', () => {
    expect(readChatScale()).toBe(CHAT_SCALE_DEFAULT)

    stubMatchMedia((q) => q.includes('max-width: 1199px'))
    expect(readChatScale()).toBe(CHAT_SCALE_DEFAULT)
  })

  it('читает значение из отдельного ключа и клампит его', () => {
    storage.setItem(CHAT_SCALE_STORAGE_KEY, '1.25')
    expect(readChatScale()).toBe(1.25)

    storage.setItem(CHAT_SCALE_STORAGE_KEY, '9')
    expect(readChatScale()).toBe(CHAT_SCALE_MAX)

    storage.setItem(CHAT_SCALE_STORAGE_KEY, '0.1')
    expect(readChatScale()).toBe(CHAT_SCALE_MIN)
  })

  it('на мобильном клампит к 0.85', () => {
    stubMatchMedia((q) => q.includes('max-width: 1199px'))
    storage.setItem(CHAT_SCALE_STORAGE_KEY, '0.8')
    expect(readChatScale()).toBe(CHAT_SCALE_MIN_TOUCH)
  })

  it('мусор в хранилище → дефолт', () => {
    storage.setItem(CHAT_SCALE_STORAGE_KEY, 'oops')
    expect(readChatScale()).toBe(CHAT_SCALE_DEFAULT)
  })

  it('hasLocalChatScale отражает наличие личного значения', () => {
    expect(hasLocalChatScale()).toBe(false)
    storage.setItem(CHAT_SCALE_STORAGE_KEY, '1.1')
    expect(hasLocalChatScale()).toBe(true)
  })
})

describe('persistChatScale (дебаунс, отдельный ключ)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    storage.clear()
  })

  afterEach(() => {
    vi.useRealTimers()
    restoreMatchMedia()
  })

  it('пишет в localStorage только после задержки ~300мс', () => {
    persistChatScale(1.2)
    expect(storage.getItem(CHAT_SCALE_STORAGE_KEY)).toBeNull()

    vi.advanceTimersByTime(300)
    expect(storage.getItem(CHAT_SCALE_STORAGE_KEY)).toBe('1.2')
  })

  it('серия вызовов схлопывается в одну запись с последним значением', () => {
    persistChatScale(1.05)
    vi.advanceTimersByTime(100)
    persistChatScale(1.35)
    vi.advanceTimersByTime(300)

    expect(storage.getItem(CHAT_SCALE_STORAGE_KEY)).toBe('1.35')
  })

  it('не пишет ключ масштаба UI (и наоборот)', () => {
    persistChatScale(1.2)
    vi.advanceTimersByTime(300)
    expect(storage.getItem(CHAT_SCALE_STORAGE_KEY)).toBe('1.2')
    expect(storage.getItem(UI_SCALE_STORAGE_KEY)).toBeNull()

    persistUiScale(0.9)
    vi.advanceTimersByTime(300)
    expect(storage.getItem(UI_SCALE_STORAGE_KEY)).toBe('0.9')
    expect(storage.getItem(CHAT_SCALE_STORAGE_KEY)).toBe('1.2')
    // Запись чата не перезаписалась значением UI
    expect(storage.getItem(CHAT_SCALE_STORAGE_KEY)).not.toBe('0.9')
  })
})

describe('setChatScale', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    storage.clear()
  })

  afterEach(() => {
    vi.useRealTimers()
    document.documentElement.style.removeProperty('--chat-scale')
    restoreMatchMedia()
  })

  it('применяет и персистит (после дебаунса)', () => {
    setChatScale(1.3)

    expect(document.documentElement.style.getPropertyValue('--chat-scale')).toBe('1.3')
    expect(storage.getItem(CHAT_SCALE_STORAGE_KEY)).toBeNull()

    vi.advanceTimersByTime(300)
    expect(storage.getItem(CHAT_SCALE_STORAGE_KEY)).toBe('1.3')
  })
})

/**
 * Серверные умолчания масштаба области чата (админ-раздел «По умолчанию»).
 * Модуль импортируется заново на каждый тест: внутри модуля живёт флаг
 * «личный масштаб уже применён», который иначе перетекал бы между тестами.
 */
describe('серверные умолчания масштаба чата', () => {
  async function freshModule() {
    vi.resetModules()
    return import('./uiScale')
  }

  beforeEach(() => {
    storage.clear()
    document.documentElement.style.removeProperty('--chat-scale')
  })

  afterEach(() => {
    restoreMatchMedia()
    document.documentElement.style.removeProperty('--chat-scale')
  })

  it('применяет серверный дефолт без личного значения и НЕ пишет в localStorage', async () => {
    const ui = await freshModule()
    stubMatchMedia(() => false)
    ui.setServerChatScaleDefaults({ mobile: 0.9, desktop: 1.15 })

    expect(ui.getServerDefaultChatScale()).toBe(1.15)
    expect(ui.getDefaultChatScale()).toBe(1.15)
    expect(ui.applyServerDefaultChatScale()).toBe(true)
    expect(document.documentElement.style.getPropertyValue('--chat-scale')).toBe('1.15')
    expect(storage.getItem(CHAT_SCALE_STORAGE_KEY)).toBeNull()
  })

  it('mobile и desktop независимы', async () => {
    const ui = await freshModule()
    ui.setServerChatScaleDefaults({ mobile: 0.9, desktop: 1.15 })

    stubMatchMedia(() => false)
    expect(ui.getServerDefaultChatScale()).toBe(1.15)

    stubMatchMedia((q) => q.includes('max-width: 1199px'))
    expect(ui.getServerDefaultChatScale()).toBe(0.9)
  })

  it('на мобильном действует минимум 0.85, даже если умолчание ниже', async () => {
    const ui = await freshModule()
    stubMatchMedia((q) => q.includes('max-width: 1199px'))
    ui.setServerChatScaleDefaults({ mobile: 0.75 })

    expect(ui.getServerDefaultChatScale()).toBe(CHAT_SCALE_MIN_TOUCH)
    ui.applyServerDefaultChatScale()
    expect(document.documentElement.style.getPropertyValue('--chat-scale')).toBe('0.85')
  })

  it('значения клампятся к 0.75…1.5, мусор сбрасывает умолчание', async () => {
    const ui = await freshModule()
    stubMatchMedia(() => false)

    ui.setServerChatScaleDefaults({ desktop: 5 })
    expect(ui.getServerDefaultChatScale()).toBe(CHAT_SCALE_MAX)

    ui.setServerChatScaleDefaults({ desktop: 0.1 })
    expect(ui.getServerDefaultChatScale()).toBe(CHAT_SCALE_MIN)

    ui.setServerChatScaleDefaults({ desktop: NaN })
    expect(ui.getServerDefaultChatScale()).toBeNull()

    ui.setServerChatScaleDefaults({ desktop: 'oops' as unknown as number })
    expect(ui.getServerDefaultChatScale()).toBeNull()
  })

  it('если умолчание не задано — встроенный дефолт, личный ключ не пишется', async () => {
    const ui = await freshModule()
    stubMatchMedia(() => false)
    ui.setServerChatScaleDefaults({ mobile: 1.1 })

    expect(ui.getServerDefaultChatScale()).toBeNull()
    expect(ui.applyServerDefaultChatScale()).toBe(true)
    expect(document.documentElement.style.getPropertyValue('--chat-scale')).toBe('1')
    expect(storage.getItem(CHAT_SCALE_STORAGE_KEY)).toBeNull()
  })

  it('при личном значении серверный дефолт не применяется и не перезаписывается', async () => {
    const ui = await freshModule()
    stubMatchMedia(() => false)
    storage.setItem(CHAT_SCALE_STORAGE_KEY, '1.2')
    ui.setServerChatScaleDefaults({ desktop: 0.9 })

    expect(ui.hasPersonalChatScale()).toBe(true)
    expect(ui.applyServerDefaultChatScale()).toBe(false)
    expect(document.documentElement.style.getPropertyValue('--chat-scale')).toBe('')
    expect(storage.getItem(CHAT_SCALE_STORAGE_KEY)).toBe('1.2')
  })

  it('личный масштаб из профиля применяется один раз и блокирует серверный', async () => {
    const ui = await freshModule()
    stubMatchMedia(() => false)
    ui.setServerChatScaleDefaults({ desktop: 0.9 })

    expect(ui.applyPersonalChatScale(1.2)).toBe(true)
    expect(document.documentElement.style.getPropertyValue('--chat-scale')).toBe('1.2')
    // Значение из профиля не пишется в localStorage (личное — оно там уже не нужно).
    expect(storage.getItem(CHAT_SCALE_STORAGE_KEY)).toBeNull()

    expect(ui.applyServerDefaultChatScale()).toBe(false)
    expect(document.documentElement.style.getPropertyValue('--chat-scale')).toBe('1.2')
    expect(ui.applyPersonalChatScale(1.1)).toBe(false)
  })

  it('setChatScale помечает масштаб личным: серверный дефолт не перекрывает', async () => {
    const ui = await freshModule()
    stubMatchMedia(() => false)
    ui.setChatScale(1.2)
    ui.setServerChatScaleDefaults({ desktop: 0.9 })

    expect(ui.applyServerDefaultChatScale()).toBe(false)
    expect(document.documentElement.style.getPropertyValue('--chat-scale')).toBe('1.2')
  })
})

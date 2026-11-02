import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import {
  COMPOSER_DRAFTS_KEY,
  clearAllComposerDrafts,
  flushComposerDrafts,
  writeComposerDraft,
} from '@/lib/composer-drafts'
import { useComposerDraftsStore } from './composerDraftsStore'

const SESSION = 's1'

/**
 * vitest/jsdom в этом пакете не даёт `localStorage` (тесты сторов создают
 * заглушку сами) — для проверки персиста ставим in-memory реализацию.
 */
function installLocalStorage(): void {
  const data = new Map<string, string>()
  const storage = {
    get length(): number {
      return data.size
    },
    clear: () => data.clear(),
    getItem: (key: string) => data.get(key) ?? null,
    key: (index: number) => Array.from(data.keys())[index] ?? null,
    removeItem: (key: string) => {
      data.delete(key)
    },
    setItem: (key: string, value: string) => {
      data.set(key, String(value))
    },
  } as Storage
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true })
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'localStorage', { value: storage, configurable: true })
  }
}

function persisted(): { version: number; drafts: Record<string, { text: string; updatedAt: number }> } | null {
  const raw = localStorage.getItem(COMPOSER_DRAFTS_KEY)
  return raw ? (JSON.parse(raw) as ReturnType<typeof persisted>) : null
}

beforeEach(() => {
  vi.useRealTimers()
  installLocalStorage()
  clearAllComposerDrafts()
  useComposerDraftsStore.setState({ textBySession: {} })
})

afterEach(() => {
  vi.useRealTimers()
  clearAllComposerDrafts()
  useComposerDraftsStore.setState({ textBySession: {} })
})

describe('composerDraftsStore: текст по сессиям', () => {
  it('set/get/clear обновляют память стора', () => {
    const store = useComposerDraftsStore.getState()

    store.setText(SESSION, 'привет')
    expect(useComposerDraftsStore.getState().textBySession[SESSION]).toBe('привет')

    store.setText('s2', 'другой')
    expect(useComposerDraftsStore.getState().textBySession).toEqual({
      [SESSION]: 'привет',
      s2: 'другой',
    })

    store.clearText(SESSION)
    expect(useComposerDraftsStore.getState().textBySession[SESSION]).toBeUndefined()
    expect(useComposerDraftsStore.getState().textBySession.s2).toBe('другой')
  })

  it('пробельный текст удаляет черновик из localStorage, а clearText — из стора', () => {
    writeComposerDraft(SESSION, 'текст')
    flushComposerDrafts()
    expect(persisted()?.drafts[SESSION]?.text).toBe('текст')

    useComposerDraftsStore.getState().setText(SESSION, '   ')
    useComposerDraftsStore.getState().flush()

    // В поле ввода пробелы остаются, но персистить их незачем.
    expect(useComposerDraftsStore.getState().textBySession[SESSION]).toBe('   ')
    expect(localStorage.getItem(COMPOSER_DRAFTS_KEY)).toBeNull()

    useComposerDraftsStore.getState().clearText(SESSION)
    expect(useComposerDraftsStore.getState().textBySession[SESSION]).toBeUndefined()
  })

  it('черновик переживает сброс модулей (round-trip через localStorage)', async () => {
    useComposerDraftsStore.getState().setText('s-round', 'после reload')
    useComposerDraftsStore.getState().flush()

    expect(persisted()?.drafts['s-round']?.text).toBe('после reload')

    vi.resetModules()
    const freshStore = await import('./composerDraftsStore')
    const freshLib = await import('@/lib/composer-drafts')

    expect(freshStore.useComposerDraftsStore.getState().textBySession['s-round']).toBe('после reload')
    expect(freshLib.readComposerDrafts()['s-round']?.text).toBe('после reload')
  })
})

describe('composer-drafts: отложенная запись', () => {
  it('пишет в localStorage с дебаунсом ~300 мс, flush пишет сразу', () => {
    vi.useFakeTimers()

    useComposerDraftsStore.getState().setText(SESSION, 'abc')
    // До истечения задержки запись не сделана.
    expect(localStorage.getItem(COMPOSER_DRAFTS_KEY)).toBeNull()

    vi.advanceTimersByTime(299)
    expect(localStorage.getItem(COMPOSER_DRAFTS_KEY)).toBeNull()

    vi.advanceTimersByTime(1)
    expect(persisted()?.version).toBe(1)
    expect(persisted()?.drafts[SESSION]?.text).toBe('abc')

    // Новая правка и явный flush — без ожидания таймера.
    useComposerDraftsStore.getState().setText(SESSION, 'abcd')
    expect(persisted()?.drafts[SESSION]?.text).toBe('abc')
    useComposerDraftsStore.getState().flush()
    expect(persisted()?.drafts[SESSION]?.text).toBe('abcd')
  })

  it('прунинг: не более 50 непустых черновиков, самые старые удаляются', () => {
    vi.useFakeTimers()
    const base = Date.now()
    for (let index = 0; index < 55; index += 1) {
      vi.setSystemTime(base + index * 10)
      useComposerDraftsStore.getState().setText(`session-${index}`, `text-${index}`)
    }
    useComposerDraftsStore.getState().flush()

    const stored = persisted()
    expect(stored).not.toBeNull()
    const keys = Object.keys(stored!.drafts)
    expect(keys).toHaveLength(50)
    expect(keys).not.toContain('session-0')
    expect(keys).not.toContain('session-4')
    expect(keys).toContain('session-5')
    expect(keys).toContain('session-54')
  })
})

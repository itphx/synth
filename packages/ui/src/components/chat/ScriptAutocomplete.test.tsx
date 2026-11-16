import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'
import type { ScriptSummary } from '@itphx/synth-shared/types'

const mocks = vi.hoisted(() => ({
  listSessionScripts: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: { listSessionScripts: mocks.listSessionScripts } }))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { ScriptAutocomplete } from './ScriptAutocomplete'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// jsdom не реализует scrollIntoView — его зовёт эффект подсветки списка.
if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {}
}

const roots: Array<{ root: Root; container: HTMLElement }> = []

/** Скрипт реестра (`GET /api/v2/sessions/:id/scripts`). */
function makeScript(overrides: Partial<ScriptSummary> = {}): ScriptSummary {
  return {
    name: 'dev',
    description: 'Поднять backend и UI',
    origin: 'project',
    available: true,
    trusted: true,
    background: true,
    ...overrides,
  }
}

const SCRIPTS: ScriptSummary[] = [
  makeScript(),
  makeScript({ name: 'release', description: 'Собрать и опубликовать пакеты', origin: 'instance' }),
  makeScript({
    name: 'untrusted',
    description: 'Скрипт из недоверенного каталога',
    origin: 'project',
    available: false,
    unavailableReason: 'trusted',
    trusted: false,
  }),
]

async function renderPopup(opts: {
  query?: string
  sessionId?: string
  onSelect?: (name: string) => void
  onClose?: () => void
  onMatchesChange?: (count: number) => void
} = {}): Promise<{
  container: HTMLElement
  onSelect: ReturnType<typeof vi.fn>
  onClose: ReturnType<typeof vi.fn>
  onMatchesChange: ReturnType<typeof vi.fn>
  /** Перерисовать пикер с новым запросом (имитация ввода). */
  setQuery: (query: string) => Promise<void>
}> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const onSelect = (opts.onSelect ?? vi.fn()) as ReturnType<typeof vi.fn>
  const onClose = (opts.onClose ?? vi.fn()) as ReturnType<typeof vi.fn>
  const onMatchesChange = (opts.onMatchesChange ?? vi.fn()) as ReturnType<typeof vi.fn>
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  const draw = async (query: string) => {
    await act(async () => {
      root.render(
        <I18nProvider>
          <ScriptAutocomplete
            query={query}
            position={{ left: 0 }}
            sessionId={opts.sessionId ?? 's1'}
            onSelect={onSelect as unknown as (name: string) => void}
            onClose={onClose as unknown as () => void}
            onMatchesChange={onMatchesChange as unknown as (count: number) => void}
          />
        </I18nProvider>,
      )
    })
    await act(async () => {})
  }
  await draw(opts.query ?? '')
  return {
    container,
    onSelect,
    onClose,
    onMatchesChange,
    setQuery: (query: string) => draw(query),
  }
}

async function pressKey(key: string): Promise<void> {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.listSessionScripts.mockResolvedValue({ scripts: SCRIPTS, diagnostics: [] })
})

afterEach(async () => {
  while (roots.length > 0) {
    const { root, container } = roots.pop()!
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
  vi.clearAllMocks()
})

describe('ScriptAutocomplete — `!`-пикер скриптов (ADR-126 §5)', () => {
  it('открывается по `!` и показывает реестр скриптов сессии', async () => {
    const { container, onMatchesChange } = await renderPopup({ query: '' })

    expect(mocks.listSessionScripts).toHaveBeenCalledWith('s1')
    expect(container.querySelector('[data-testid="script-autocomplete"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="script-autocomplete-item-dev"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="script-autocomplete-item-release"]')).not.toBeNull()
    // Выбираемых скриптов — два (третий недоступен).
    expect(onMatchesChange).toHaveBeenCalledWith(2)
  })

  it('реестр грузится один раз на открытие — на каждый keystroke запроса нет', async () => {
    const { container, setQuery } = await renderPopup({ query: '' })
    expect(mocks.listSessionScripts).toHaveBeenCalledTimes(1)

    // Смена фильтра (новый keystroke) — список фильтруется локально.
    await setQuery('rel')
    expect(mocks.listSessionScripts).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[data-testid="script-autocomplete-item-release"]')).not.toBeNull()
  })

  it('фильтрует по имени и описанию', async () => {
    const { container } = await renderPopup({ query: 'rel' })
    expect(container.querySelector('[data-testid="script-autocomplete-item-release"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="script-autocomplete-item-dev"]')).toBeNull()
  })

  it('недоступный скрипт показывает причину и не выбирается', async () => {
    const { container, onSelect, onMatchesChange } = await renderPopup({ query: '' })

    const badge = container.querySelector('[data-testid="script-autocomplete-unavailable-untrusted"]')
    expect(badge).not.toBeNull()
    expect(badge?.textContent).toContain('untrusted directory')
    // Недоступный скрипт в число выбираемых не входит.
    expect(onMatchesChange).toHaveBeenCalledWith(2)

    const item = container.querySelector(
      '[data-testid="script-autocomplete-item-untrusted"]',
    ) as HTMLButtonElement
    expect(item.getAttribute('aria-disabled')).toBe('true')
    await act(async () => {
      item.click()
    })
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('Enter подставляет имя скрипта (только вставка, без запуска)', async () => {
    const { onSelect } = await renderPopup({ query: '' })
    await pressKey('Enter')
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith('dev')
  })

  it('навигация стрелками пропускает недоступные скрипты', async () => {
    const { onSelect } = await renderPopup({ query: '' })
    // Порядок выбираемых: dev, release (недоступный untrusted — не в списке).
    await pressKey('ArrowDown')
    await pressKey('Enter')
    expect(onSelect).toHaveBeenCalledWith('release')
  })

  it('Escape закрывает список', async () => {
    const { onClose } = await renderPopup({ query: '' })
    await pressKey('Escape')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('пустой реестр — подсказка «объявите скрипт»', async () => {
    mocks.listSessionScripts.mockResolvedValue({ scripts: [], diagnostics: [] })
    const { container, onMatchesChange } = await renderPopup({ query: '' })

    const empty = container.querySelector('[data-testid="script-autocomplete-empty"]')
    expect(empty).not.toBeNull()
    expect(empty?.textContent).toContain('No scripts')
    expect(empty?.textContent).toContain('.synth/scripts')
    expect(onMatchesChange).toHaveBeenCalledWith(0)
  })

  it('ошибка загрузки не ломает ввод — список тихо не показывается', async () => {
    mocks.listSessionScripts.mockRejectedValue(new Error('scripts unavailable'))
    const { container, onSelect, onMatchesChange } = await renderPopup({ query: '' })

    expect(container.querySelector('[data-testid="script-autocomplete"]')).toBeNull()
    expect(onSelect).not.toHaveBeenCalled()
    expect(onMatchesChange).toHaveBeenCalledWith(0)
  })
})

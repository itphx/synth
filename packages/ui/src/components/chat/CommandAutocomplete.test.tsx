import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'
import type { CommandSummary } from '@itphx/synth-shared'

const mocks = vi.hoisted(() => ({
  getCommands: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks }))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { CommandAutocomplete } from './CommandAutocomplete'
import { useSkillsStore } from '@/stores/skillsStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

const COMMANDS: CommandSummary[] = [
  { name: 'help', kind: 'builtin', description: 'Show help', available: true },
  { name: 'api-review', kind: 'skill', description: 'Review API', scope: 'instance', level: 'system', available: false, unavailableReason: 'capabilities' },
  { name: 'backend', kind: 'bundle', description: 'Backend bundle', skills: ['a'], available: true },
]

async function renderPopup(opts: {
  query?: string
  onSelect?: (c: CommandSummary) => void
  onClose?: () => void
  onMatchesChange?: (n: number) => void
} = {}): Promise<{ container: HTMLElement; onSelect: ReturnType<typeof vi.fn>; onClose: ReturnType<typeof vi.fn>; onMatchesChange: ReturnType<typeof vi.fn> }> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const onSelect = (opts.onSelect ?? vi.fn()) as ReturnType<typeof vi.fn>
  const onClose = (opts.onClose ?? vi.fn()) as ReturnType<typeof vi.fn>
  const onMatchesChange = (opts.onMatchesChange ?? vi.fn()) as ReturnType<typeof vi.fn>
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <CommandAutocomplete
          query={opts.query ?? ''}
          position={{ top: 40, left: 0 }}
          onSelect={onSelect as unknown as (command: CommandSummary) => void}
          onClose={onClose as unknown as () => void}
          onMatchesChange={onMatchesChange as unknown as (count: number) => void}
        />
      </I18nProvider>,
    )
  })
  await act(async () => {})
  return { container, onSelect, onClose, onMatchesChange }
}

async function pressKey(key: string): Promise<void> {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getCommands.mockResolvedValue({ commands: COMMANDS, diagnostics: [] })
  useSkillsStore.setState({
    commands: null,
    commandDiagnostics: [],
    commandsLoading: false,
    commandsError: null,
  })
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

describe('CommandAutocomplete — `/`-автокомплит (AD-046 §9.3)', () => {
  it('рендерит команды с видом и бейджем недоступности', async () => {
    const { container, onMatchesChange } = await renderPopup()
    expect(container.querySelector('[data-testid="command-autocomplete"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="command-autocomplete-item-help"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="command-autocomplete-item-backend"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="command-autocomplete-item-api-review"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="command-autocomplete-unavailable-api-review"]')).not.toBeNull()
    expect(container.textContent).toContain('built-in')
    expect(container.textContent).toContain('bundle')
    expect(container.textContent).toContain('skill')
    expect(onMatchesChange).toHaveBeenCalledWith(3)
  })

  it('фильтрует команды по запросу', async () => {
    const { container } = await renderPopup({ query: 'he' })
    expect(container.querySelector('[data-testid="command-autocomplete-item-help"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="command-autocomplete-item-backend"]')).toBeNull()
    expect(container.querySelector('[data-testid="command-autocomplete-item-api-review"]')).toBeNull()
  })

  it('пустой результат показывает заглушку', async () => {
    const { container } = await renderPopup({ query: 'zzz' })
    expect(container.querySelector('[data-testid="command-autocomplete-empty"]')).not.toBeNull()
  })

  it('стрелки + Enter выбирают подсвеченную команду', async () => {
    const { onSelect } = await renderPopup()
    // Порядок: доступные (backend, help), затем api-review.
    await pressKey('ArrowDown')
    await pressKey('Enter')
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect((onSelect.mock.calls[0][0] as CommandSummary).name).toBe('help')
  })

  it('Tab также выбирает команду', async () => {
    const { onSelect } = await renderPopup()
    await pressKey('Tab')
    expect((onSelect.mock.calls[0][0] as CommandSummary).name).toBe('backend')
  })

  it('клик по команде вызывает onSelect', async () => {
    const { container, onSelect } = await renderPopup()
    const item = container.querySelector('[data-testid="command-autocomplete-item-api-review"]') as HTMLButtonElement
    await act(async () => {
      item.click()
    })
    expect((onSelect.mock.calls[0][0] as CommandSummary).name).toBe('api-review')
  })

  it('Escape закрывает список', async () => {
    const { onClose } = await renderPopup()
    await pressKey('Escape')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('клик вне списка закрывает', async () => {
    const { onClose } = await renderPopup()
    await act(async () => {
      document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

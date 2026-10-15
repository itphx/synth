import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'
import type { CommandSummary, SkillBundle } from '@itphx/synth-shared'

const mocks = vi.hoisted(() => ({
  getCommands: vi.fn(),
  getSkillBundles: vi.fn(),
  createSkillBundle: vi.fn(),
  updateSkillBundle: vi.fn(),
  deleteSkillBundle: vi.fn(),
  notify: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks }))
vi.mock('@/hooks/useNotification', () => ({
  useNotification: () => ({ notify: mocks.notify }),
}))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { CommandsSettings } from './CommandsSettings'
import { useSkillsStore } from '@/stores/skillsStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

const COMMANDS: CommandSummary[] = [
  { name: 'help', kind: 'builtin', description: 'Show help', available: true },
  { name: 'api-review', kind: 'skill', description: 'Review API', scope: 'instance', level: 'system', available: false, unavailableReason: 'capabilities' },
]

const BUNDLE: SkillBundle = {
  name: 'backend',
  description: 'Backend work',
  skills: ['github-code-review'],
}

function setInputValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!
  setter.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

async function renderSettings(): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <CommandsSettings />
      </I18nProvider>,
    )
  })
  await act(async () => {})
  return container
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getCommands.mockResolvedValue({ commands: COMMANDS, diagnostics: [] })
  mocks.getSkillBundles.mockResolvedValue({ bundles: [BUNDLE] })
  mocks.createSkillBundle.mockResolvedValue(BUNDLE)
  mocks.updateSkillBundle.mockResolvedValue({ ...BUNDLE, description: 'v2' })
  mocks.deleteSkillBundle.mockResolvedValue(undefined)

  useSkillsStore.setState({
    commands: null,
    commandDiagnostics: [],
    commandsLoading: false,
    commandsError: null,
    bundles: null,
    bundlesLoading: false,
    bundlesError: null,
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

describe('CommandsSettings — команды и bundles (ADR-046 §9.2)', () => {
  it('рендерит команды с видом и бейджем недоступности', async () => {
    const container = await renderSettings()

    expect(container.querySelector('[data-testid="command-help"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="command-api-review"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="command-unavailable-api-review"]')).not.toBeNull()
    expect(container.textContent).toContain('built-in')
    expect(container.textContent).toContain('skill')
  })

  it('показывает диагностику shadowed/collision', async () => {
    mocks.getCommands.mockResolvedValue({
      commands: COMMANDS,
      diagnostics: [{ level: 'warning', code: 'collision', message: 'name collision', command: 'help' }],
    })
    const container = await renderSettings()
    expect(container.querySelector('[data-testid="commands-diagnostics"]')?.textContent).toContain('collision')
  })

  it('валидация bundle: пустые поля не сохраняются', async () => {
    const container = await renderSettings()
    await act(async () => {
      (container.querySelector('[data-testid="bundles-add"]') as HTMLButtonElement).click()
    })
    await act(async () => {
      (container.querySelector('[data-testid="bundle-form-save"]') as HTMLButtonElement).click()
    })
    expect(mocks.createSkillBundle).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Name is required')
    expect(container.textContent).toContain('Add at least one skill')
  })

  it('создание bundle: имя/описание/скиллы → POST', async () => {
    const container = await renderSettings()
    await act(async () => {
      (container.querySelector('[data-testid="bundles-add"]') as HTMLButtonElement).click()
    })

    const form = container.querySelector('[data-testid="bundle-form"]')!
    const nameInput = form.querySelector('[data-testid="bundle-form-name"]') as HTMLInputElement
    const descInput = form.querySelector('[data-testid="bundle-form-description"]') as HTMLTextAreaElement
    await act(async () => {
      setInputValue(nameInput, 'backend')
      setInputValue(descInput, 'Backend work')
    })

    const skillInput = form.querySelector('input[placeholder="github-code-review"]') as HTMLInputElement
    await act(async () => {
      setInputValue(skillInput, 'github-code-review')
    })
    const addSkill = [...form.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Add') as HTMLButtonElement
    await act(async () => {
      addSkill.click()
    })

    await act(async () => {
      (form.querySelector('[data-testid="bundle-form-save"]') as HTMLButtonElement).click()
    })
    await act(async () => {})

    expect(mocks.createSkillBundle).toHaveBeenCalledWith({
      name: 'backend',
      description: 'Backend work',
      skills: ['github-code-review'],
      instruction: undefined,
    })
  })

  it('редактирование bundle → PATCH', async () => {
    const container = await renderSettings()
    await act(async () => {
      (container.querySelector('[data-testid="bundles-edit-backend"]') as HTMLButtonElement).click()
    })
    const form = container.querySelector('[data-testid="bundle-form"]')!
    const descInput = form.querySelector('[data-testid="bundle-form-description"]') as HTMLTextAreaElement
    await act(async () => {
      setInputValue(descInput, 'v2')
    })
    await act(async () => {
      (form.querySelector('[data-testid="bundle-form-save"]') as HTMLButtonElement).click()
    })
    await act(async () => {})

    expect(mocks.updateSkillBundle).toHaveBeenCalledWith('backend', {
      description: 'v2',
      skills: ['github-code-review'],
      instruction: undefined,
    })
  })

  it('удаление bundle подтверждается', async () => {
    const container = await renderSettings()
    await act(async () => {
      (container.querySelector('[data-testid="bundles-delete-backend"]') as HTMLButtonElement).click()
    })
    const confirm = [...document.body.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Delete',
    ) as HTMLButtonElement | undefined
    expect(confirm).toBeTruthy()
    await act(async () => {
      confirm!.click()
    })
    await act(async () => {})
    expect(mocks.deleteSkillBundle).toHaveBeenCalledWith('backend')
  })
})

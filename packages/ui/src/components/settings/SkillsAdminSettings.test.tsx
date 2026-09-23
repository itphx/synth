import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'
import type { SkillDetail, SkillSummary } from '@itphx/synth-shared'

const mocks = vi.hoisted(() => ({
  getSkills: vi.fn(),
  getSkill: vi.fn(),
  createSkill: vi.fn(),
  updateSkill: vi.fn(),
  deleteSkill: vi.fn(),
  getSkillFile: vi.fn(),
  putSkillFile: vi.fn(),
  deleteSkillFile: vi.fn(),
  reloadSkills: vi.fn(),
  getSkillsSettings: vi.fn(),
  updateSkillsSettings: vi.fn(),
  resetSkillsSettings: vi.fn(),
  notify: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks }))
vi.mock('@/hooks/useNotification', () => ({
  useNotification: () => ({ notify: mocks.notify }),
}))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { SkillsAdminSettings } from './SkillsAdminSettings'
import { useSkillsStore, EMPTY_SKILLS_DISABLED } from '@/stores/skillsStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

function summary(name: string, overrides: Partial<SkillSummary> = {}): SkillSummary {
  return {
    name,
    description: `${name} description`,
    scope: 'instance',
    level: 'system',
    dir: `/data/skills/${name}`,
    invocation: 'both',
    userInvocable: true,
    modelInvocable: true,
    category: 'quality',
    tags: [],
    agents: [],
    groups: ['review'],
    requiresCapabilities: [],
    trusted: true,
    available: true,
    ...overrides,
  }
}

function detail(name: string): SkillDetail {
  return {
    ...summary(name),
    meta: { name, description: `${name} description`, userInvocable: true, disableModelInvocation: false, invocation: 'both' },
    body: `# ${name}`,
    files: [],
  }
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
        <SkillsAdminSettings />
      </I18nProvider>,
    )
  })
  await act(async () => {})
  return container
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getSkills.mockResolvedValue({ skills: [summary('api-review')], diagnostics: [] })
  mocks.getSkill.mockResolvedValue(detail('api-review'))
  mocks.createSkill.mockResolvedValue(detail('new-skill'))
  mocks.updateSkill.mockResolvedValue(detail('api-review'))
  mocks.deleteSkill.mockResolvedValue(undefined)
  mocks.putSkillFile.mockResolvedValue({ name: 'api-review', path: 'x' })
  mocks.deleteSkillFile.mockResolvedValue(undefined)
  mocks.reloadSkills.mockResolvedValue(undefined)
  mocks.getSkillsSettings.mockResolvedValue({ disabled: { ...EMPTY_SKILLS_DISABLED }, policy: 'auto' })
  mocks.updateSkillsSettings.mockImplementation(async (disabled: unknown) => ({ disabled, policy: 'auto' }))
  mocks.resetSkillsSettings.mockResolvedValue(undefined)

  useSkillsStore.setState({
    skills: null,
    skillsDiagnostics: [],
    skillsLoading: false,
    skillsError: null,
    selectedSkill: null,
    settingsDisabled: null,
    settingsPolicy: 'auto',
    settingsLoading: false,
    settingsError: null,
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

describe('SkillsAdminSettings — админ-реестр скиллов (AD-046 §9.2)', () => {
  it('рендерит реестр; правка/удаление доступны только instance-скиллам', async () => {
    mocks.getSkills.mockResolvedValue({
      skills: [summary('inst-skill'), summary('proj-skill', { scope: 'project', level: 'project' })],
      diagnostics: [],
    })

    const container = await renderSettings()

    const inst = container.querySelector('[data-testid="skills-admin-edit-inst-skill"]') as HTMLButtonElement
    const proj = container.querySelector('[data-testid="skills-admin-edit-proj-skill"]') as HTMLButtonElement
    expect(inst.disabled).toBe(false)
    expect(proj.disabled).toBe(true)
  })

  it('форма создания валидирует name/description и не вызывает API при ошибках', async () => {
    const container = await renderSettings()
    const add = container.querySelector('[data-testid="skills-admin-add"]') as HTMLButtonElement
    await act(async () => {
      add.click()
    })

    const save = container.querySelector('[data-testid="skill-form-save"]') as HTMLButtonElement
    await act(async () => {
      save.click()
    })
    expect(mocks.createSkill).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Name is required')
    expect(container.textContent).toContain('Description is required')

    const nameInput = container.querySelector('[data-testid="skill-form-name"]') as HTMLInputElement
    const descInput = container.querySelector('[data-testid="skill-form-description"]') as HTMLTextAreaElement
    await act(async () => {
      setInputValue(nameInput, 'new-skill')
      setInputValue(descInput, 'A new skill')
    })
    await act(async () => {
      save.click()
    })
    await act(async () => {})

    expect(mocks.createSkill).toHaveBeenCalledWith({
      name: 'new-skill',
      description: 'A new skill',
      body: '',
      files: undefined,
    })
  })

  it('неверное имя отклоняется валидацией', async () => {
    const container = await renderSettings()
    await act(async () => {
      (container.querySelector('[data-testid="skills-admin-add"]') as HTMLButtonElement).click()
    })
    const nameInput = container.querySelector('[data-testid="skill-form-name"]') as HTMLInputElement
    const descInput = container.querySelector('[data-testid="skill-form-description"]') as HTMLTextAreaElement
    await act(async () => {
      setInputValue(nameInput, 'Bad Name')
      setInputValue(descInput, 'd')
    })
    await act(async () => {
      (container.querySelector('[data-testid="skill-form-save"]') as HTMLButtonElement).click()
    })
    expect(mocks.createSkill).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Invalid name')
  })

  it('отключение группы/категории и точечного скилла сохраняется через PUT', async () => {
    const container = await renderSettings()
    const skillToggle = container.querySelector('[data-testid="skills-disabled-skill-api-review"]') as HTMLInputElement
    const catToggle = container.querySelector('[data-testid="skills-disabled-category-quality"]') as HTMLInputElement
    const groupToggle = container.querySelector('[data-testid="skills-disabled-group-review"]') as HTMLInputElement
    expect(skillToggle.checked).toBe(true)

    await act(async () => {
      skillToggle.click()
      catToggle.click()
      groupToggle.click()
    })

    const save = container.querySelector('[data-testid="skills-disabled-save"]') as HTMLButtonElement
    expect(save.disabled).toBe(false)
    await act(async () => {
      save.click()
    })
    await act(async () => {})

    expect(mocks.updateSkillsSettings).toHaveBeenCalledWith({
      categories: ['quality'],
      groups: ['review'],
      skills: ['api-review'],
    }, undefined)
  })

  it('политика: смена и Save вызывают PUT с текущим disabled', async () => {
    mocks.getSkillsSettings.mockResolvedValue({ disabled: { ...EMPTY_SKILLS_DISABLED }, policy: 'auto' })
    const container = await renderSettings()

    const card = container.querySelector('[data-testid="skills-policy-save"]')!.closest('section')!
    const trigger = card.querySelector('[role="combobox"]') as HTMLElement
    await act(async () => {
      trigger.click()
    })
    const option = [...document.body.querySelectorAll('[role="option"]')].find(
      (o) => o.textContent?.trim().startsWith('available'),
    ) as HTMLElement | undefined
    expect(option).toBeTruthy()
    await act(async () => {
      option!.click()
    })

    const save = container.querySelector('[data-testid="skills-policy-save"]') as HTMLButtonElement
    expect(save.disabled).toBe(false)
    await act(async () => {
      save.click()
    })
    await act(async () => {})

    expect(mocks.updateSkillsSettings).toHaveBeenCalledWith(EMPTY_SKILLS_DISABLED, 'available')
  })

  it('политика: Reset вызывает resetSkillsSettings', async () => {
    mocks.getSkillsSettings.mockResolvedValue({
      disabled: { ...EMPTY_SKILLS_DISABLED },
      policy: 'available',
    })
    const container = await renderSettings()
    const reset = container.querySelector('[data-testid="skills-policy-reset"]') as HTMLButtonElement
    expect(reset.disabled).toBe(false)
    await act(async () => {
      reset.click()
    })
    await act(async () => {})
    expect(mocks.resetSkillsSettings).toHaveBeenCalledTimes(1)
  })

  it('удаление instance-скилла подтверждается через ConfirmDialog', async () => {
    const container = await renderSettings()
    const del = container.querySelector('[data-testid="skills-admin-delete-api-review"]') as HTMLButtonElement
    await act(async () => {
      del.click()
    })

    const confirm = [...document.body.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Delete',
    ) as HTMLButtonElement | undefined
    expect(confirm).toBeTruthy()
    await act(async () => {
      confirm!.click()
    })
    await act(async () => {})

    expect(mocks.deleteSkill).toHaveBeenCalledWith('api-review')
  })
})

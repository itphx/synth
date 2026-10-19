import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'
import type { SkillDetail, SkillSummary } from '@itphx/synth-shared'

const mocks = vi.hoisted(() => ({
  getSkills: vi.fn(),
  getSkill: vi.fn(),
  reloadSkills: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks }))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SkillsUserSettings } from './SkillsUserSettings'
import { useSkillsStore } from '@/stores/skillsStore'

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
    tags: [],
    agents: [],
    groups: [],
    requiresCapabilities: [],
    trusted: true,
    available: true,
    ...overrides,
  }
}

function detail(name: string, overrides: Partial<SkillDetail> = {}): SkillDetail {
  return {
    ...summary(name),
    meta: { name, description: `${name} description`, userInvocable: true, disableModelInvocation: false, invocation: 'both' },
    body: `# ${name} body`,
    files: ['references/checklist.md'],
    ...overrides,
  }
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
        <TooltipProvider>
          <SkillsUserSettings />
        </TooltipProvider>
      </I18nProvider>,
    )
  })
  await act(async () => {})
  return container
}

beforeEach(() => {
  vi.clearAllMocks()
  useSkillsStore.setState({
    skills: null,
    skillsDiagnostics: [],
    skillsLoading: false,
    skillsError: null,
    selectedSkill: null,
    selectedLoading: false,
    selectedError: null,
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

describe('SkillsUserSettings — пользовательский просмотр скиллов (ADR-046 §9.3)', () => {
  it('рендерит список скиллов и счётчик', async () => {
    mocks.getSkills.mockResolvedValue({ skills: [summary('api-review'), summary('db-migration')] })

    const container = await renderSettings()

    expect(container.querySelector('[data-testid="skills-user-list"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="skills-user-api-review"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="skills-user-db-migration"]')).not.toBeNull()
    expect(container.textContent).toContain('2 skills')
  })

  it('показывает бейдж недоступности для unavailable-скилла', async () => {
    mocks.getSkills.mockResolvedValue({
      skills: [summary('shell-only', { available: false, unavailableReason: 'capabilities' })],
    })

    const container = await renderSettings()

    expect(container.querySelector('[data-testid="skills-badge-unavailable"]')).not.toBeNull()
  })

  it('деталь показывает тело SKILL.md и supporting-файлы (read-only)', async () => {
    mocks.getSkills.mockResolvedValue({ skills: [summary('api-review')] })
    mocks.getSkill.mockResolvedValue(detail('api-review'))

    const container = await renderSettings()
    const item = container.querySelector('[data-testid="skills-user-api-review"]') as HTMLButtonElement
    await act(async () => {
      item.click()
    })
    await act(async () => {})

    expect(mocks.getSkill).toHaveBeenCalledWith('api-review', undefined)
    expect(container.querySelector('[data-testid="skills-user-detail-body"]')?.textContent).toContain('# api-review body')
    expect(container.querySelector('[data-testid="skills-user-files"]')?.textContent).toContain('references/checklist.md')

    // Read-only: нет кнопок создания/правки/удаления.
    expect(container.querySelector('[data-testid="skills-admin-add"]')).toBeNull()
    expect(container.querySelector('[data-testid="skills-admin-edit-api-review"]')).toBeNull()
  })

  it('недоверенный скилл: бейдж и скрытое тело', async () => {
    mocks.getSkills.mockResolvedValue({
      skills: [summary('project-skill', { scope: 'project', level: 'project', trusted: false })],
    })
    mocks.getSkill.mockResolvedValue(detail('project-skill', { trusted: false, body: '', files: [] }))

    const container = await renderSettings()
    expect(container.querySelector('[data-testid="skills-badge-untrusted"]')).not.toBeNull()

    const item = container.querySelector('[data-testid="skills-user-project-skill"]') as HTMLButtonElement
    await act(async () => {
      item.click()
    })
    await act(async () => {})

    expect(container.querySelector('[data-testid="skills-untrusted-hint"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="skills-user-detail-body"]')).toBeNull()
  })

  it('кнопка Reload вызывает reloadSkills', async () => {
    mocks.getSkills.mockResolvedValue({ skills: [summary('api-review')] })
    mocks.reloadSkills.mockResolvedValue(undefined)

    const container = await renderSettings()
    const reload = container.querySelector('[data-testid="skills-reload"]') as HTMLButtonElement
    await act(async () => {
      reload.click()
    })
    await act(async () => {})

    expect(mocks.reloadSkills).toHaveBeenCalledTimes(1)
  })

  it('ошибка загрузки показывается алертом', async () => {
    mocks.getSkills.mockRejectedValue(new Error('fail'))
    const container = await renderSettings()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('skills registry')
  })
})

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import React from 'react'
import type { SkillSummary } from '@itphx/synth-shared'

/**
 * Долларовый пикер скиллов и событие шины `skills.updated`.
 *
 * Баг: «создал скилл — а в подсказках композера его нет, пока не перезагрузишь
 * страницу». Причина — гейт «грузить реестр только если список пуст»: после
 * первой загрузки пикер больше не перечитывал стор.
 */
const mocks = vi.hoisted(() => ({
  getSkills: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks }))

import { I18nProvider, useI18nStore } from '@/lib/i18n'
import { dict as enDict } from '@/lib/i18n/messages/en'
import { SkillAutocomplete } from './SkillAutocomplete'
import { useSkillsStore } from '@/stores/skillsStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ root: Root; container: HTMLElement }> = []

function skill(name: string, description = `${name} description`): SkillSummary {
  return {
    name,
    description,
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
  }
}

async function renderPicker(query = ''): Promise<HTMLElement> {
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(
      <I18nProvider>
        <SkillAutocomplete
          query={query}
          position={{ left: 0 }}
          onSelect={() => {}}
          onClose={() => {}}
        />
      </I18nProvider>,
    )
  })
  await act(async () => {})
  return container
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getSkills.mockResolvedValue({ skills: [skill('api-review')], diagnostics: [] })
  useSkillsStore.setState({
    skills: null,
    skillsDiagnostics: [],
    skillsLoading: false,
    skillsError: null,
    bundles: null,
    settingsDisabled: null,
    revision: 0,
    projectRevisions: {},
    sessionRevisions: {},
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

describe('SkillAutocomplete — живое обновление реестра', () => {
  it('перечитывает реестр на монтировании, даже если список уже в сторе', async () => {
    // Стор уже заполнен другой панелью — старый гейт `skills === null` не дал бы
    // запросу уйти, и пикер показывал бы снимок чужой давности.
    useSkillsStore.setState({ skills: [skill('stale')] })
    mocks.getSkills.mockResolvedValue({ skills: [skill('fresh')], diagnostics: [] })

    const container = await renderPicker()

    expect(mocks.getSkills).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[data-testid="skill-autocomplete-item-fresh"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="skill-autocomplete-item-stale"]')).toBeNull()
  })

  it('после события skills.updated список перечитывается без перезагрузки', async () => {
    const container = await renderPicker()
    expect(container.querySelector('[data-testid="skill-autocomplete-item-api-review"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="skill-autocomplete-item-db-migration"]')).toBeNull()
    const callsBefore = mocks.getSkills.mock.calls.length

    // Скилл создан в другой вкладке (или тулом из чата): шина подняла revision.
    mocks.getSkills.mockResolvedValue({
      skills: [skill('api-review'), skill('db-migration')],
      diagnostics: [],
    })
    await act(async () => {
      useSkillsStore.getState().applyEvent()
    })
    await act(async () => {})

    expect(mocks.getSkills.mock.calls.length).toBeGreaterThan(callsBefore)
    const fresh = container.querySelector('[data-testid="skill-autocomplete-item-db-migration"]')
    expect(fresh).not.toBeNull()
  })

  it('удалённый скилл исчезает из подсказок по событию', async () => {
    useSkillsStore.setState({ skills: [skill('api-review'), skill('db-migration')] })
    mocks.getSkills.mockResolvedValue({
      skills: [skill('api-review'), skill('db-migration')],
      diagnostics: [],
    })
    const container = await renderPicker()
    expect(container.querySelector('[data-testid="skill-autocomplete-item-db-migration"]')).not.toBeNull()

    mocks.getSkills.mockResolvedValue({ skills: [skill('api-review')], diagnostics: [] })
    await act(async () => {
      useSkillsStore.getState().applyEvent()
    })
    await act(async () => {})

    expect(container.querySelector('[data-testid="skill-autocomplete-item-db-migration"]')).toBeNull()
  })
})

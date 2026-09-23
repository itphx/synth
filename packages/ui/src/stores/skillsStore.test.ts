import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { CommandSummary, SkillBundle, SkillDetail, SkillSummary } from '@itphx/synth-shared'

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
  getCommands: vi.fn(),
  getSkillBundles: vi.fn(),
  getSkillBundle: vi.fn(),
  createSkillBundle: vi.fn(),
  updateSkillBundle: vi.fn(),
  deleteSkillBundle: vi.fn(),
  getSessionSkills: vi.fn(),
  updateSessionSkills: vi.fn(),
  getSessionSkillsEffective: vi.fn(),
  getProjectSkills: vi.fn(),
  updateProjectSkills: vi.fn(),
  getSkillsSettings: vi.fn(),
  updateSkillsSettings: vi.fn(),
  resetSkillsSettings: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({ synthApi: mocks }))

import { useSkillsStore, EMPTY_SKILLS_DISABLED } from './skillsStore'

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

function detail(name: string): SkillDetail {
  return {
    ...summary(name),
    meta: { name, description: `${name} description`, userInvocable: true, disableModelInvocation: false, invocation: 'both' },
    body: `# ${name}`,
    files: ['references/checklist.md'],
  }
}

const COMMAND: CommandSummary = {
  name: 'help',
  kind: 'builtin',
  description: 'Show help',
  available: true,
}

const BUNDLE: SkillBundle = {
  name: 'backend',
  description: 'Backend work',
  skills: ['a', 'b'],
}

function resetStore(): void {
  useSkillsStore.setState({
    skills: null,
    skillsDiagnostics: [],
    skillsLoading: false,
    skillsError: null,
    selectedSkill: null,
    selectedLoading: false,
    selectedError: null,
    commands: null,
    commandDiagnostics: [],
    commandsLoading: false,
    commandsError: null,
    bundles: null,
    bundlesLoading: false,
    bundlesError: null,
    settingsDisabled: null,
    settingsPolicy: 'auto',
    settingsLoading: false,
    settingsError: null,
    skillInvocationCounts: {},
    commandInvocationCounts: {},
    lastSkillInvocation: null,
    lastCommandInvocation: null,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  resetStore()
})

describe('skillsStore — реестр и деталь', () => {
  it('fetchSkills загружает скиллы и диагностику', async () => {
    mocks.getSkills.mockResolvedValue({
      skills: [summary('api-review')],
      diagnostics: [{ level: 'warning', code: 'shadowed', message: 'shadowed', skill: 'api-review' }],
    })

    await useSkillsStore.getState().fetchSkills({ diagnostics: true })

    const state = useSkillsStore.getState()
    expect(state.skills).toHaveLength(1)
    expect(state.skillsDiagnostics).toHaveLength(1)
    expect(state.skillsLoading).toBe(false)
    expect(mocks.getSkills).toHaveBeenCalledWith({ diagnostics: true })
  })

  it('fetchSkills при ошибке выставляет skillsError', async () => {
    mocks.getSkills.mockRejectedValue(new Error('boom'))

    await useSkillsStore.getState().fetchSkills()

    expect(useSkillsStore.getState().skillsError).toContain('boom')
    expect(useSkillsStore.getState().skillsLoading).toBe(false)
  })

  it('selectSkill загружает деталь и clearSelectedSkill очищает', async () => {
    mocks.getSkill.mockResolvedValue(detail('api-review'))

    await useSkillsStore.getState().selectSkill('api-review')

    expect(useSkillsStore.getState().selectedSkill?.body).toBe('# api-review')
    useSkillsStore.getState().clearSelectedSkill()
    expect(useSkillsStore.getState().selectedSkill).toBeNull()
  })

  it('createSkill добавляет скилл в реестр', async () => {
    useSkillsStore.setState({ skills: [] })
    mocks.createSkill.mockResolvedValue(detail('new-skill'))

    const created = await useSkillsStore.getState().createSkill({
      name: 'new-skill',
      description: 'd',
    })

    expect(created.name).toBe('new-skill')
    expect(useSkillsStore.getState().skills?.map((s) => s.name)).toEqual(['new-skill'])
  })

  it('updateSkill заменяет запись и синхронизирует выбранную деталь', async () => {
    useSkillsStore.setState({ skills: [summary('api-review')], selectedSkill: detail('api-review') })
    mocks.updateSkill.mockResolvedValue({ ...detail('api-review'), description: 'updated' })

    await useSkillsStore.getState().updateSkill('api-review', { description: 'updated' })

    expect(useSkillsStore.getState().skills?.[0].description).toBe('updated')
    expect(useSkillsStore.getState().selectedSkill?.description).toBe('updated')
  })

  it('deleteSkill удаляет скилл и сбрасывает выбранную деталь', async () => {
    useSkillsStore.setState({ skills: [summary('api-review')], selectedSkill: detail('api-review') })
    mocks.deleteSkill.mockResolvedValue(undefined)

    await useSkillsStore.getState().deleteSkill('api-review')

    expect(useSkillsStore.getState().skills).toEqual([])
    expect(useSkillsStore.getState().selectedSkill).toBeNull()
  })

  it('reloadSkills вызывает POST reload и перечитывает реестр', async () => {
    mocks.reloadSkills.mockResolvedValue(undefined)
    mocks.getSkills.mockResolvedValue({ skills: [summary('a')] })

    await useSkillsStore.getState().reloadSkills()

    expect(mocks.reloadSkills).toHaveBeenCalledTimes(1)
    expect(useSkillsStore.getState().skills?.map((s) => s.name)).toEqual(['a'])
  })

  it('ошибка createSkill пробрасывается и пишется в skillsError', async () => {
    mocks.createSkill.mockRejectedValue(new Error('conflict'))
    await expect(
      useSkillsStore.getState().createSkill({ name: 'x', description: 'd' }),
    ).rejects.toThrow('conflict')
    expect(useSkillsStore.getState().skillsError).toContain('conflict')
  })
})

describe('skillsStore — команды и bundles', () => {
  it('fetchCommands загружает команды и диагностику', async () => {
    mocks.getCommands.mockResolvedValue({
      commands: [COMMAND],
      diagnostics: [{ level: 'warning', code: 'collision', message: 'collision', command: 'help' }],
    })

    await useSkillsStore.getState().fetchCommands({ diagnostics: true })

    expect(useSkillsStore.getState().commands).toEqual([COMMAND])
    expect(useSkillsStore.getState().commandDiagnostics).toHaveLength(1)
  })

  it('CRUD bundles добавляет, обновляет и удаляет записи', async () => {
    useSkillsStore.setState({ bundles: [] })
    mocks.createSkillBundle.mockResolvedValue(BUNDLE)
    await useSkillsStore.getState().createBundle(BUNDLE)
    expect(useSkillsStore.getState().bundles?.map((b) => b.name)).toEqual(['backend'])

    mocks.updateSkillBundle.mockResolvedValue({ ...BUNDLE, description: 'v2' })
    await useSkillsStore.getState().updateBundle('backend', { description: 'v2', skills: ['a'] })
    expect(useSkillsStore.getState().bundles?.[0].description).toBe('v2')

    mocks.deleteSkillBundle.mockResolvedValue(undefined)
    await useSkillsStore.getState().deleteBundle('backend')
    expect(useSkillsStore.getState().bundles).toEqual([])
  })

  it('fetchBundles при ошибке выставляет bundlesError', async () => {
    mocks.getSkillBundles.mockRejectedValue(new Error('nope'))
    await useSkillsStore.getState().fetchBundles()
    expect(useSkillsStore.getState().bundlesError).toContain('nope')
  })
})

describe('skillsStore — instance-настройки', () => {
  it('fetchSkillsSettings загружает disabled/policy', async () => {
    mocks.getSkillsSettings.mockResolvedValue({
      disabled: { categories: ['quality'], groups: [], skills: [] },
      policy: 'available',
    })

    await useSkillsStore.getState().fetchSkillsSettings()

    expect(useSkillsStore.getState().settingsDisabled?.categories).toEqual(['quality'])
    expect(useSkillsStore.getState().settingsPolicy).toBe('available')
  })

  it('saveSkillsSettings сохраняет и обновляет состояние', async () => {
    mocks.updateSkillsSettings.mockResolvedValue({
      disabled: { categories: [], groups: ['review'], skills: [] },
      policy: 'consistency',
    })

    await useSkillsStore.getState().saveSkillsSettings({ categories: [], groups: ['review'], skills: [] }, 'consistency')

    expect(mocks.updateSkillsSettings).toHaveBeenCalledWith({ categories: [], groups: ['review'], skills: [] }, 'consistency')
    expect(useSkillsStore.getState().settingsPolicy).toBe('consistency')
  })

  it('resetSkillsSettings сбрасывает disabled и policy к дефолтам', async () => {
    useSkillsStore.setState({
      settingsDisabled: { categories: ['x'], groups: ['y'], skills: ['z'] },
      settingsPolicy: 'available',
    })
    mocks.resetSkillsSettings.mockResolvedValue(undefined)

    await useSkillsStore.getState().resetSkillsSettings()

    expect(useSkillsStore.getState().settingsDisabled).toEqual(EMPTY_SKILLS_DISABLED)
    expect(useSkillsStore.getState().settingsPolicy).toBe('auto')
  })
})

describe('skillsStore — события skill.invoked / command.invoked (AD-046 §8.2)', () => {
  it('recordSkillInvoked накапливает счётчики и последний вызов', () => {
    const store = useSkillsStore.getState()
    store.recordSkillInvoked({ sessionId: 's1', name: 'api-review', source: 'user' })
    store.recordSkillInvoked({ sessionId: 's1', name: 'api-review', source: 'model' })

    const state = useSkillsStore.getState()
    expect(state.skillInvocationCounts['api-review']).toBe(2)
    expect(state.lastSkillInvocation?.source).toBe('model')
  })

  it('recordCommandInvoked накапливает счётчики и последний вызов', () => {
    const store = useSkillsStore.getState()
    store.recordCommandInvoked({ sessionId: 's1', command: 'help', actor: 'user' })
    store.recordCommandInvoked({ sessionId: 's1', command: 'help', actor: 'cli' })

    const state = useSkillsStore.getState()
    expect(state.commandInvocationCounts.help).toBe(2)
    expect(state.lastCommandInvocation?.actor).toBe('cli')
  })

  it('игнорирует пустые имена', () => {
    const store = useSkillsStore.getState()
    store.recordSkillInvoked({ sessionId: 's1', name: '', source: 'user' })
    store.recordCommandInvoked({ sessionId: 's1', command: '', actor: 'user' })
    expect(useSkillsStore.getState().lastSkillInvocation).toBeNull()
    expect(useSkillsStore.getState().lastCommandInvocation).toBeNull()
  })
})

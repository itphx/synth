import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Событие шины `skills.updated` (реестр скиллов/бандлов инстанса изменился).
 *
 * Баг: «панель скиллов и долларовый пикер показывают старый состав, пока не
 * перезагрузишь страницу». Событие публикуется в **инстансный** канал шины (у
 * реестра нет сессии), поэтому диспетчер обязан обработать его раньше проверки
 * `sid` — иначе `sessionId` события (`'instance'`/пусто/чужой) отбрасывал бы
 * его до стора.
 */
const apiMocks = vi.hoisted(() => ({
  getSkills: vi.fn(),
  getSkillBundles: vi.fn(),
  getSkillsSettings: vi.fn(),
}))

vi.mock('@/lib/api/synthApi', () => ({
  synthApi: {
    getSkills: apiMocks.getSkills,
    getSkillBundles: apiMocks.getSkillBundles,
    getSkillsSettings: apiMocks.getSkillsSettings,
    getSession: vi.fn().mockResolvedValue({ id: 's1', messages: [] }),
    getProjects: vi.fn().mockResolvedValue([]),
    getProjectsPage: vi.fn().mockResolvedValue({
      projects: [],
      total: 0,
      offset: 0,
      limit: 100,
      next_offset: null,
    }),
  },
}))

vi.mock('@/hooks/useNotification', () => ({
  notifyMessage: vi.fn(),
}))

import { createDispatcher } from './transportStore'
import { useSkillsStore, skillsRevisionForProject, skillsRevisionForSession } from './skillsStore'
import type { WSEvent } from '@/lib/api/transport'
import type { SkillSummary } from '@itphx/synth-shared'

const dispatch = createDispatcher()

function makeEvent(type: string, data: Record<string, unknown>, sessionId?: string): WSEvent {
  return { type, ...(sessionId ? { session_id: sessionId } : {}), data } as WSEvent
}

function makeSkill(name: string): SkillSummary {
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
  }
}

describe('transportStore dispatcher: skills.updated', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    apiMocks.getSkills.mockResolvedValue({ skills: [makeSkill('a'), makeSkill('b')] })
    apiMocks.getSkillBundles.mockResolvedValue({ bundles: [] })
    apiMocks.getSkillsSettings.mockResolvedValue({
      disabled: { categories: [], groups: [], skills: [] },
      policy: 'auto',
    })
    useSkillsStore.setState({
      skills: [makeSkill('a')],
      skillsLoading: false,
      skillsError: null,
      bundles: null,
      settingsDisabled: null,
      revision: 0,
      projectRevisions: {},
      sessionRevisions: {},
    })
  })

  it('без sessionId: поднимает revision и перечитывает реестр', async () => {
    dispatch(makeEvent('skills.updated', { action: 'create', name: 'b' }))

    expect(useSkillsStore.getState().revision).toBe(1)
    await vi.waitFor(() => {
      expect(useSkillsStore.getState().skills?.map((s) => s.name)).toEqual(['a', 'b'])
    })
    expect(apiMocks.getSkills).toHaveBeenCalled()
  })

  it('инстансный канал (`session_id: "instance"`) обрабатывается так же', () => {
    dispatch(makeEvent('skills.updated', { action: 'reload' }, 'instance'))

    expect(useSkillsStore.getState().revision).toBe(1)
    expect(apiMocks.getSkills).toHaveBeenCalled()
  })

  it('чужой sessionId не мешает обработке (событие — не сессионное)', () => {
    dispatch(makeEvent('skills.updated', { action: 'delete', name: 'b' }, 'some-other-session'))

    expect(useSkillsStore.getState().revision).toBe(1)
    expect(apiMocks.getSkills).toHaveBeenCalled()
  })

  it('scope/projectId/sessionId доходят до стора (scoped-счётчики)', () => {
    dispatch(
      makeEvent('skills.updated', { action: 'scope', scope: 'project', projectId: 'p1' }, 'instance'),
    )
    dispatch(
      makeEvent('skills.updated', { action: 'scope', scope: 'session', sessionId: 's1' }, 's1'),
    )

    const state = useSkillsStore.getState()
    expect(state.revision).toBe(2)
    expect(skillsRevisionForProject(state, 'p1')).toBe(1)
    expect(skillsRevisionForSession(state, 's1')).toBe(1)
    // Чужой проект/сессия — счётчик не двигается, панель не перечитывается.
    expect(skillsRevisionForProject(state, 'p2')).toBe(0)
    expect(skillsRevisionForSession(state, 's2')).toBe(0)
  })

  it('событие instance-уровня (scope: "instance") не двигает scoped-счётчики', () => {
    dispatch(
      makeEvent('skills.updated', { action: 'scope', scope: 'instance' }, 'instance'),
    )

    const state = useSkillsStore.getState()
    expect(state.revision).toBe(1)
    expect(state.projectRevisions).toEqual({})
    expect(state.sessionRevisions).toEqual({})
  })
})

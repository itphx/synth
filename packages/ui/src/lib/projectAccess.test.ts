import { describe, it, expect } from 'vitest'

import type { ProjectData } from '@/lib/api/synthApi'
import type { User } from '@/lib/api/client'
import {
  accessCompositionOf,
  accessProjectionOf,
  buildProjectAccessBody,
  canEditProjectContent,
  canManageProject,
  canReadProject,
  draftGroupMembersOf,
  draftMembersOf,
  projectAccessDraftAfterProjection,
  resolveProjectRole,
} from './projectAccess'

const user = (id: string, roles: string[] = []): User => ({
  id,
  username: id,
  email: null,
  roles,
})

const project = (
  overrides: Partial<Pick<ProjectData, 'id' | 'origin' | 'owner_id' | 'members'>> = {},
) => ({
  id: 'p1',
  origin: 'local' as const,
  owner_id: 'local',
  members: {} as Record<string, string>,
  ...overrides,
})

/** Проект с состоянием доступа (PROP-133): владелец `u0`. */
const accessProject = (
  overrides: Partial<
    Pick<ProjectData, 'owner_id' | 'members'> & {
      group_members?: Record<string, string> | null
      everyone_role?: string | null
    }
  > = {},
) => ({
  id: 'p1',
  origin: 'local' as const,
  owner_id: 'u0',
  members: {} as Record<string, string>,
  group_members: null as Record<string, string> | null,
  everyone_role: null as string | null,
  ...overrides,
})

describe('canManageProject', () => {
  it('локальный проект в standalone/гибриде доступен единственной личности инстанса', () => {
    // owner_id у локальных проектов — 'local' (core без getCurrentUserId),
    // а UI в гибриде авторизован серверной личностью 'u1'.
    expect(
      canManageProject(project(), user('u1'), { standalone: true }),
    ).toBe(true)
  })

  it('managed: сравнение id прежнее — чужой владелец не даёт прав', () => {
    expect(canManageProject(project(), user('u1'))).toBe(false)
    expect(canManageProject(project(), user('u1'), { standalone: false })).toBe(false)
  })

  it('managed: владелец и участник OWNER управляют проектом', () => {
    expect(canManageProject(project({ owner_id: 'u1' }), user('u1'))).toBe(true)
    expect(
      canManageProject(project({ owner_id: 'u0', members: { u1: 'owner' } }), user('u1')),
    ).toBe(true)
    expect(
      canManageProject(project({ owner_id: 'u0', members: { u1: 'editor' } }), user('u1')),
    ).toBe(false)
    expect(
      canManageProject(project({ owner_id: 'u0', members: { u1: 'viewer' } }), user('u1')),
    ).toBe(false)
  })

  it('remote-проект в standalone: правило по id/участию, локальная поблажка не действует', () => {
    expect(
      canManageProject(project({ id: 'remote:p1', origin: 'remote' }), user('u1'), {
        standalone: true,
      }),
    ).toBe(false)
    expect(
      canManageProject(
        project({ id: 'remote:p1', origin: 'remote', owner_id: 'u1' }),
        user('u1'),
        { standalone: true },
      ),
    ).toBe(true)
  })

  it('ADMIN и LEAD управляют независимо от владения', () => {
    expect(canManageProject(project({ owner_id: 'u0' }), user('u1', ['ADMIN']))).toBe(true)
    expect(canManageProject(project({ owner_id: 'u0' }), user('u1', ['LEAD']))).toBe(true)
  })

  it('нет проекта или пользователя — прав нет', () => {
    expect(canManageProject(null, user('u1'), { standalone: true })).toBe(false)
    expect(canManageProject(project(), null, { standalone: true })).toBe(false)
  })
})

describe('canEditProjectContent', () => {
  it('owner и editor меняют содержимое, viewer — нет', () => {
    expect(canEditProjectContent(project({ owner_id: 'u1' }), user('u1'))).toBe(true)
    expect(
      canEditProjectContent(project({ owner_id: 'u0', members: { u1: 'editor' } }), user('u1')),
    ).toBe(true)
    expect(
      canEditProjectContent(project({ owner_id: 'u0', members: { u1: 'viewer' } }), user('u1')),
    ).toBe(false)
  })

  it('локальный проект в standalone доступен на запись', () => {
    expect(
      canEditProjectContent(project(), user('u1'), { standalone: true }),
    ).toBe(true)
    expect(canEditProjectContent(project(), user('u1'))).toBe(false)
  })
})

describe('canReadProject — зеркало чтения (PROP-133 §1)', () => {
  it('автор читает свой проект', () => {
    expect(canReadProject(accessProject(), user('u0'))).toBe(true)
  })

  it('состояние «author»: чужой пользователь не читает', () => {
    expect(canReadProject(accessProject(), user('u2'))).toBe(false)
  })

  it('состояние «selected»: участник с ролью viewer читает, но не пишет', () => {
    const p = accessProject({ members: { u0: 'owner', u2: 'viewer' } })
    expect(canReadProject(p, user('u2'))).toBe(true)
    expect(canEditProjectContent(p, user('u2'))).toBe(false)
    expect(canManageProject(p, user('u2'))).toBe(false)
  })

  it('состояние «selected»: участник с ролью editor читает и пишет, но не управляет', () => {
    const p = accessProject({ members: { u0: 'owner', u2: 'editor' } })
    expect(canReadProject(p, user('u2'))).toBe(true)
    expect(canEditProjectContent(p, user('u2'))).toBe(true)
    expect(canManageProject(p, user('u2'))).toBe(false)
  })

  it('состояние «all»: любой пользователь читает; viewer не пишет', () => {
    const p = accessProject({ everyone_role: 'viewer' })
    expect(canReadProject(p, user('u2'))).toBe(true)
    expect(canEditProjectContent(p, user('u2'))).toBe(false)
  })

  it('состояние «all» с editor: любой пользователь пишет, но не управляет доступом', () => {
    const p = accessProject({ everyone_role: 'editor' })
    expect(canReadProject(p, user('u2'))).toBe(true)
    expect(canEditProjectContent(p, user('u2'))).toBe(true)
    expect(canManageProject(p, user('u2'))).toBe(false)
  })

  it('индивидуальный грант «сужает» роль режима «всем» (порядок резолвера)', () => {
    const p = accessProject({ members: { u0: 'owner', u2: 'viewer' }, everyone_role: 'editor' })
    expect(canReadProject(p, user('u2'))).toBe(true)
    expect(canEditProjectContent(p, user('u2'))).toBe(false)
    expect(canEditProjectContent(p, user('u3'))).toBe(true)
  })

  it('ADMIN и LEAD читают и управляют любым проектом', () => {
    const p = accessProject()
    expect(canReadProject(p, user('u1', ['ADMIN']))).toBe(true)
    expect(canManageProject(p, user('u1', ['LEAD']))).toBe(true)
  })

  it('локальный проект в standalone доступен единственной личности инстанса', () => {
    expect(canReadProject(accessProject(), user('u1'), { standalone: true })).toBe(true)
  })

  it('битая роль в данных — fail-closed в viewer (читает, не пишет)', () => {
    const p = accessProject({ members: { u0: 'owner', u2: 'WRONG' } })
    expect(canReadProject(p, user('u2'))).toBe(true)
    expect(canEditProjectContent(p, user('u2'))).toBe(false)
  })

  it('нет проекта или пользователя — прав нет', () => {
    expect(canReadProject(null, user('u1'))).toBe(false)
    expect(canReadProject(accessProject(), null)).toBe(false)
  })
})

describe('resolveProjectRole — гранты по группам (ADR-140 Ф2)', () => {
  it('пользователь с группой получает роль по group_members', () => {
    const p = accessProject({ group_members: { platform: 'viewer' } })
    const member: User = { ...user('u2'), groups: ['platform'] }
    expect(resolveProjectRole(p, member)).toBe('viewer')
    expect(canReadProject(p, member)).toBe(true)
    expect(canEditProjectContent(p, member)).toBe(false)
  })

  it('без группы (или с чужой) — доступа нет', () => {
    const p = accessProject({ group_members: { platform: 'viewer' } })
    expect(resolveProjectRole(p, user('u2'))).toBeNull()
    expect(resolveProjectRole(p, { ...user('u2'), groups: ['other'] })).toBeNull()
    expect(canReadProject(p, user('u2'))).toBe(false)
  })

  it('группа с ролью editor даёт запись', () => {
    const p = accessProject({ group_members: { platform: 'editor' } })
    const member: User = { ...user('u2'), groups: ['platform'] }
    expect(resolveProjectRole(p, member)).toBe('editor')
    expect(canEditProjectContent(p, member)).toBe(true)
  })
})

describe('проекции доступа (PROP-133 §4)', () => {
  it('проекция берётся из DTO `visibility`, без него — «только автору»', () => {
    expect(accessProjectionOf({ visibility: 'author' })).toBe('author')
    expect(accessProjectionOf({ visibility: 'selected' })).toBe('selected')
    expect(accessProjectionOf({ visibility: 'all' })).toBe('all')
    expect(accessProjectionOf({})).toBe('author')
    expect(accessProjectionOf(null)).toBe('author')
  })

  it('черновик участников не включает владельца и битые роли', () => {
    expect(
      draftMembersOf({ owner_id: 'u0', members: { u0: 'owner', u2: 'viewer', u3: 'editor', u4: 'WRONG' } }),
    ).toEqual({ u2: 'viewer', u3: 'editor' })
  })

  it('тело доступа — полная замена: лишние поля сбрасываются', () => {
    expect(buildProjectAccessBody('author', { u2: 'editor' })).toEqual({
      members: {},
      group_members: {},
      everyone_role: null,
    })
    expect(buildProjectAccessBody('selected', { u2: 'editor', u3: 'viewer' })).toEqual({
      members: { u2: 'editor', u3: 'viewer' },
      group_members: {},
      everyone_role: null,
    })
    expect(buildProjectAccessBody('all', { u2: 'editor' })).toEqual({
      members: {},
      group_members: {},
      everyone_role: 'viewer',
    })
    expect(buildProjectAccessBody('all', {}, 'editor')).toEqual({
      members: {},
      group_members: {},
      everyone_role: 'editor',
    })
  })

  it('тело доступа с группами: `group_members` уходит вместе с пользователями', () => {
    expect(
      buildProjectAccessBody('selected', { u2: 'editor' }, 'viewer', { platform: 'viewer' }),
    ).toEqual({
      members: { u2: 'editor' },
      group_members: { platform: 'viewer' },
      everyone_role: null,
    })
    // «Всем пользователям» индивидуальные гранты не уходят (иначе сужали бы роль).
    expect(buildProjectAccessBody('all', { u2: 'editor' }, 'editor', { platform: 'editor' })).toEqual({
      members: {},
      group_members: {},
      everyone_role: 'editor',
    })
    // «Только автору» — гранты группам тоже снимаются.
    expect(buildProjectAccessBody('author', {}, 'viewer', { platform: 'editor' })).toEqual({
      members: {},
      group_members: {},
      everyone_role: null,
    })
  })

  it('тело доступа: имя группы trim-ится, пустые отбрасываются', () => {
    expect(
      buildProjectAccessBody('selected', {}, 'viewer', { ' platform ': 'editor', '  ': 'viewer' }),
    ).toEqual({
      members: {},
      group_members: { platform: 'editor' },
      everyone_role: null,
    })
  })

  it('смена проекции: «только автору» сбрасывает и пользователей, и группы', () => {
    const draft = projectAccessDraftAfterProjection(
      'author',
      'selected',
      { u2: 'editor' },
      'viewer',
      { platform: 'editor' },
    )
    expect(draft.projection).toBe('author')
    expect(draft.members).toEqual({})
    expect(draft.groupMembers).toEqual({})
    expect(draft.everyoneRole).toBe('viewer')
  })

  it('смена проекции: «всем пользователям» сохраняет черновик групп (тело его очистит)', () => {
    const draft = projectAccessDraftAfterProjection(
      'all',
      'selected',
      { u2: 'editor' },
      'viewer',
      { platform: 'editor' },
    )
    expect(draft.projection).toBe('all')
    expect(draft.members).toEqual({ u2: 'editor' })
    expect(draft.groupMembers).toEqual({ platform: 'editor' })
    // Роль «всем» — только явный выбор автора.
    expect(draft.everyoneRole).toBe('viewer')
  })

  it('смена проекции без групп (обратная совместимость сигнатуры)', () => {
    const draft = projectAccessDraftAfterProjection('selected', 'author', { u2: 'editor' }, 'viewer')
    expect(draft.members).toEqual({ u2: 'editor' })
    expect(draft.groupMembers).toEqual({})
  })

  it('черновик грантов группам: неизвестные роли и пустые имена отбрасываются', () => {
    expect(
      draftGroupMembersOf({
        group_members: { platform: 'editor', team: 'viewer', legacy: 'owner', broken: 'WRONG' },
      }),
    ).toEqual({ platform: 'editor', team: 'viewer' })
    expect(draftGroupMembersOf({ group_members: null })).toEqual({})
    expect(draftGroupMembersOf(undefined)).toEqual({})
  })

  it('состав доступа: гранты по пользователям и группам (владелец — не грант)', () => {
    expect(accessCompositionOf(accessProject({ members: { u0: 'owner' } }))).toEqual({
      hasUserGrants: false,
      hasGroupGrants: false,
    })
    expect(
      accessCompositionOf(accessProject({ members: { u0: 'owner', u2: 'viewer' } })),
    ).toEqual({ hasUserGrants: true, hasGroupGrants: false })
    expect(
      accessCompositionOf(
        accessProject({ members: { u0: 'owner' }, group_members: { platform: 'viewer' } }),
      ),
    ).toEqual({ hasUserGrants: false, hasGroupGrants: true })
    expect(
      accessCompositionOf(
        accessProject({
          members: { u0: 'owner', u2: 'editor' },
          group_members: { platform: 'editor' },
        }),
      ),
    ).toEqual({ hasUserGrants: true, hasGroupGrants: true })
    expect(accessCompositionOf(null)).toEqual({
      hasUserGrants: false,
      hasGroupGrants: false,
    })
  })
})

import { describe, it, expect } from 'vitest'

import type { ProjectData } from '@/lib/api/synthApi'
import type { User } from '@/lib/api/client'
import {
  accessProjectionOf,
  buildProjectAccessBody,
  canEditProjectContent,
  canManageProject,
  canReadProject,
  draftMembersOf,
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
      everyone_role: null,
    })
    expect(buildProjectAccessBody('selected', { u2: 'editor', u3: 'viewer' })).toEqual({
      members: { u2: 'editor', u3: 'viewer' },
      everyone_role: null,
    })
    expect(buildProjectAccessBody('all', { u2: 'editor' })).toEqual({
      members: {},
      everyone_role: 'viewer',
    })
    expect(buildProjectAccessBody('all', {}, 'editor')).toEqual({
      members: {},
      everyone_role: 'editor',
    })
  })
})

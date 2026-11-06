import { describe, it, expect } from 'vitest'

import type { ProjectData } from '@/lib/api/synthApi'
import type { User } from '@/lib/api/client'
import { canEditProjectContent, canManageProject } from './projectAccess'

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

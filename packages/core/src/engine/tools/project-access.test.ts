/**
 * PROP-133 §1: право записи проектных данных у тулов агента — из **единого**
 * резолвера доступа (`resolveProjectAccess` + `canWriteWithProjectRole`),
 * а не из собственной копии правила.
 *
 * Проверяются состояния доступа проекта: владелец, участник (`owner`/
 * `editor`/`viewer`), режим «всем пользователям» (`viewer`/`editor`) и
 * back-compat для сессии без атрибуции пользователя.
 */
import { describe, it, expect } from 'vitest';
import { ProjectRole, type Project, type Session } from '@itphx/synth-shared';

import { canEditProject, resolveSessionUserId } from './project-access.js';

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'P1',
    ownerId: 'owner',
    members: { owner: ProjectRole.OWNER },
    description: '',
    currentTask: '',
    invariants: '',
    statusMessages: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as Project;
}

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 's1',
    sessionOrigin: 'direct',
    ...overrides,
  } as Session;
}

describe('PROP-133: canEditProject — единый резолвер доступа', () => {
  it('владелец проекта — запись разрешена', () => {
    const p = project();
    expect(canEditProject(session({ userId: 'owner' }), p)).toBe(true);
    expect(canEditProject(session({ ownerId: 'owner' }), p)).toBe(true);
  });

  it('участник с ролью `owner`/`editor` — запись разрешена', () => {
    const p = project({
      members: { owner: ProjectRole.OWNER, u2: ProjectRole.OWNER, u3: ProjectRole.EDITOR },
    });
    expect(canEditProject(session({ userId: 'u2' }), p)).toBe(true);
    expect(canEditProject(session({ userId: 'u3' }), p)).toBe(true);
  });

  it('участник с ролью `viewer` — запись запрещена (инвариант 21)', () => {
    const p = project({ members: { owner: ProjectRole.OWNER, u2: ProjectRole.VIEWER } });
    expect(canEditProject(session({ userId: 'u2' }), p)).toBe(false);
  });

  it('чужой пользователь — запись запрещена', () => {
    expect(canEditProject(session({ userId: 'stranger' }), project())).toBe(false);
  });

  it('«всем пользователям» с ролью `editor` — запись разрешена', () => {
    const p = project({ everyoneRole: ProjectRole.EDITOR });
    expect(canEditProject(session({ userId: 'stranger' }), p)).toBe(true);
  });

  it('«всем пользователям» с ролью `viewer` — только чтение', () => {
    const p = project({ everyoneRole: ProjectRole.VIEWER });
    expect(canEditProject(session({ userId: 'stranger' }), p)).toBe(false);
  });

  it('«всем пользователям» (`null`) — чужий не пишет', () => {
    const p = project({ everyoneRole: null });
    expect(canEditProject(session({ userId: 'stranger' }), p)).toBe(false);
  });

  it('грант по группе без групп пользователя не действует (в core групп нет)', () => {
    const p = project({ groupMembers: { team: ProjectRole.EDITOR } });
    expect(canEditProject(session({ userId: 'u2' }), p)).toBe(false);
  });

  it('back-compat: без атрибуции пользователя — прежнее поведение', () => {
    // Синтетический контекст без владельца проекта — запись разрешена.
    expect(canEditProject(session(), project({ ownerId: '' }))).toBe(true);
    expect(canEditProject(null, project({ ownerId: '' }))).toBe(true);
    // Владелец есть — писать ему нельзя.
    expect(canEditProject(session(), project())).toBe(false);
    expect(canEditProject(null, project())).toBe(false);
  });

  it('resolveSessionUserId: userId → ownerId → undefined', () => {
    expect(resolveSessionUserId(session({ userId: 'u1', ownerId: 'u2' }))).toBe('u1');
    expect(resolveSessionUserId(session({ ownerId: 'u2' }))).toBe('u2');
    expect(resolveSessionUserId(session())).toBeUndefined();
    expect(resolveSessionUserId(null)).toBeUndefined();
  });
});

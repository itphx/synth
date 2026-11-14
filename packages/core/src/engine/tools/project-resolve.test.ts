/**
 * PROP-133 §1: видимость проектов у тулов агента — **единый** резолвер доступа
 * (`resolveProjectAccess`), а не собственная копия предиката.
 *
 * Проверяются состояния доступа проекта:
 * - «только автор» — чужому пользователю проект не виден;
 * - «всем пользователям» (`everyoneRole`) — виден всем, но запись зависит от роли;
 * - грант по группе (`groupMembers`) — доступ даёт члену группы;
 * - elevated (`ADMIN`/`LEAD`) — видно всё.
 */
import { describe, it, expect } from 'vitest';
import { ProjectRole, resolveProjectAccess, type Project } from '@itphx/synth-shared';

import {
  isProjectVisible,
  listVisibleProjects,
  projectRoleLabel,
  resolveProjectRef,
  viewerFromExtra,
  type ProjectViewer,
} from './project-resolve.js';
import type { ProjectStoreContract } from '../../storage/project-store.js';

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

function storeOf(projects: Project[]): ProjectStoreContract {
  return {
    load: async (id: string) => projects.find((p) => p.id === id) ?? null,
    save: async () => {},
    mutate: async () => null,
    create: () => project(),
    list: async (viewer?: { userId: string; groups?: readonly string[] }) => {
      if (!viewer) return projects;
      // Тот же предикат, что в хранилище (слой 1) — единый резолвер.
      return projects.filter((p) => resolveProjectAccess(p, viewer).read);
    },
  };
}

const viewer = (overrides: Partial<ProjectViewer> = {}): ProjectViewer => ({
  userId: 'u2',
  elevated: false,
  ...overrides,
});

describe('PROP-133: видимость проектов у тулов (единый резолвер)', () => {
  it('«только автор» — чужому пользователю проект не виден', () => {
    const p = project();
    expect(isProjectVisible(p, viewer())).toBe(false);
    expect(projectRoleLabel(p, 'u2')).toBeNull();
  });

  it('участник проекта (viewer) — виден, но роль viewer', () => {
    const p = project({ members: { owner: ProjectRole.OWNER, u2: ProjectRole.VIEWER } });
    expect(isProjectVisible(p, viewer())).toBe(true);
    expect(projectRoleLabel(p, 'u2')).toBe('VIEWER');
  });

  it('владелец проекта — виден, роль OWNER', () => {
    const p = project();
    expect(isProjectVisible(p, viewer({ userId: 'owner' }))).toBe(true);
    expect(projectRoleLabel(p, 'owner')).toBe('OWNER');
  });

  it('«всем пользователям» (everyoneRole: viewer) — виден чужому, роль VIEWER', () => {
    const p = project({ everyoneRole: ProjectRole.VIEWER });
    expect(isProjectVisible(p, viewer())).toBe(true);
    expect(projectRoleLabel(p, 'u2')).toBe('VIEWER');
  });

  it('грант по группе даёт доступ (роль — из группы)', () => {
    const p = project({ groupMembers: { team: ProjectRole.EDITOR } });
    expect(isProjectVisible(p, viewer())).toBe(false);
    expect(isProjectVisible(p, viewer({ groups: ['team'] }))).toBe(true);
    expect(projectRoleLabel(p, 'u2', ['team'])).toBe('EDITOR');
    expect(projectRoleLabel(p, 'u2')).toBeNull();
  });

  it('elevated (ADMIN/LEAD) — видно всё', () => {
    const p = project();
    expect(isProjectVisible(p, viewer({ elevated: true }))).toBe(true);
  });

  it('viewerFromExtra переносит группы принципала', () => {
    const v = viewerFromExtra({
      principal: { userId: 'u2', roles: ['USER'], groups: ['team'] },
    });
    expect(v.userId).toBe('u2');
    expect(v.elevated).toBe(false);
    expect(v.groups).toEqual(['team']);
  });

  it('listVisibleProjects фильтрует по роли (владелец/участник/«всем»)', async () => {
    // Владелец у каждого проекта свой: иначе «чужой» проект был бы виден
    // своему владельцу по первому же совпадению `ownerId`.
    const own = project({ id: 'own', name: 'Own', ownerId: 'owner', members: { owner: ProjectRole.OWNER } });
    const shared = project({
      id: 'shared',
      name: 'Shared',
      ownerId: 'other',
      members: { other: ProjectRole.OWNER },
      everyoneRole: ProjectRole.VIEWER,
    });
    const foreign = project({
      id: 'foreign',
      name: 'Foreign',
      ownerId: 'other',
      members: { other: ProjectRole.OWNER },
    });
    const store = storeOf([own, shared, foreign]);

    const visible = await listVisibleProjects(store, viewer({ userId: 'owner' }));
    expect(visible.map((p) => p.id)).toEqual(['own', 'shared']);

    const foreignVisible = await listVisibleProjects(store, viewer());
    expect(foreignVisible.map((p) => p.id)).toEqual(['shared']);
  });

  it('resolveProjectRef: по id и по имени — только видимые проекты', async () => {
    const shared = project({ id: 'shared', name: 'Shared', everyoneRole: ProjectRole.VIEWER });
    const foreign = project({ id: 'foreign', name: 'Foreign' });
    const store = storeOf([shared, foreign]);

    expect((await resolveProjectRef(store, 'shared', viewer())).status).toBe('found');
    expect((await resolveProjectRef(store, 'foreign', viewer())).status).toBe('not_found');
    expect((await resolveProjectRef(store, 'Shared', viewer())).status).toBe('found');
    expect((await resolveProjectRef(store, 'Foreign', viewer())).status).toBe('not_found');
    // Elevated — видит и чужие.
    expect((await resolveProjectRef(store, 'foreign', viewer({ elevated: true }))).status).toBe('found');
  });
});

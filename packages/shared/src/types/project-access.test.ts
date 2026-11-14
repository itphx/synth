import { describe, it, expect, expectTypeOf } from 'vitest';
import { ProjectRole } from './project.js';
import {
  canManageWithProjectRole,
  canWriteWithProjectRole,
  normalizeProjectAccessRole,
  normalizeProjectEveryoneRole,
  normalizeProjectMemberRoles,
  resolveProjectAccess,
  type ProjectAccessRole,
  type ProjectViewer,
} from './project-access.js';
import { deriveProjectVisibility, type Project } from './project.js';

/** Минимальный проект для резолвера (только поля доступа). */
function project(overrides: Partial<Project> = {}): Pick<
  Project,
  'ownerId' | 'members' | 'groupMembers' | 'everyoneRole'
> {
  return {
    ownerId: 'owner-1',
    members: { 'owner-1': ProjectRole.OWNER },
    ...overrides,
  } as Pick<Project, 'ownerId' | 'members' | 'groupMembers' | 'everyoneRole'>;
}

describe('PROP-133: резолвер доступа к проекту', () => {
  it('владелец проекта получает роль owner', () => {
    expect(resolveProjectAccess(project(), { userId: 'owner-1' })).toEqual({
      read: true,
      role: 'owner',
    });
  });

  it('ADMIN и LEAD получают сквозной обзор (роль owner) при любом состоянии доступа', () => {
    const authorOnly = project();
    expect(resolveProjectAccess(authorOnly, { userId: 'u2', roles: ['ADMIN'] }).role).toBe('owner');
    expect(resolveProjectAccess(authorOnly, { userId: 'u2', roles: ['LEAD'] }).role).toBe('owner');
    // Регистр не важен.
    expect(resolveProjectAccess(authorOnly, { userId: 'u2', roles: ['admin'] }).role).toBe('owner');
    expect(resolveProjectAccess(authorOnly, { userId: 'u2', roles: ['lead'] }).role).toBe('owner');
    // Сквозная роль важнее гранта `viewer`.
    const selected = project({ members: { 'owner-1': ProjectRole.OWNER, u2: ProjectRole.VIEWER } });
    expect(resolveProjectAccess(selected, { userId: 'u2', roles: ['ADMIN'] }).role).toBe('owner');
  });

  it('роль инстанца AUDITOR/USER не даёт доступа к чужому проекту', () => {
    expect(resolveProjectAccess(project(), { userId: 'u2', roles: ['AUDITOR'] })).toEqual({
      read: false,
      role: null,
    });
    expect(resolveProjectAccess(project(), { userId: 'u2', roles: ['USER'] }).read).toBe(false);
  });

  it('пользовательский грант даёт ровно свою роль', () => {
    const members = project({
      members: {
        'owner-1': ProjectRole.OWNER,
        editor: ProjectRole.EDITOR,
        viewer: ProjectRole.VIEWER,
      },
    });
    expect(resolveProjectAccess(members, { userId: 'editor' })).toEqual({ read: true, role: 'editor' });
    expect(resolveProjectAccess(members, { userId: 'viewer' })).toEqual({ read: true, role: 'viewer' });
  });

  it('грант по группе даёт максимальную роль среди групп пользователя', () => {
    const grouped = project({
      groupMembers: { team: ProjectRole.VIEWER, leads: ProjectRole.EDITOR, admins: ProjectRole.OWNER },
    });
    expect(resolveProjectAccess(grouped, { userId: 'u2', groups: ['team'] }).role).toBe('viewer');
    expect(resolveProjectAccess(grouped, { userId: 'u2', groups: ['team', 'leads'] }).role).toBe('editor');
    expect(
      resolveProjectAccess(grouped, { userId: 'u2', groups: ['team', 'leads', 'admins'] }).role,
    ).toBe('owner');
    // Чужая группа — гранта нет.
    expect(resolveProjectAccess(grouped, { userId: 'u2', groups: ['other'] }).read).toBe(false);
  });

  it('пользовательский грант важнее группового (первое совпадение)', () => {
    const both = project({
      members: { 'owner-1': ProjectRole.OWNER, u2: ProjectRole.VIEWER },
      groupMembers: { team: ProjectRole.OWNER },
    });
    expect(resolveProjectAccess(both, { userId: 'u2', groups: ['team'] }).role).toBe('viewer');
  });

  it('режим «всем пользователям» даёт роль всем, кроме тех, у кого есть свой грант', () => {
    const published = project({ everyoneRole: ProjectRole.VIEWER });
    expect(resolveProjectAccess(published, { userId: 'u2' })).toEqual({ read: true, role: 'viewer' });

    const publishedEditor = project({
      members: { 'owner-1': ProjectRole.OWNER, u2: ProjectRole.EDITOR },
      everyoneRole: ProjectRole.VIEWER,
    });
    expect(resolveProjectAccess(publishedEditor, { userId: 'u2' }).role).toBe('editor');
    expect(resolveProjectAccess(publishedEditor, { userId: 'u3' }).role).toBe('viewer');
  });

  it('everyoneRole = null — проект не опубликован (доступа нет)', () => {
    const notPublished = project({ everyoneRole: null });
    expect(resolveProjectAccess(notPublished, { userId: 'u2' })).toEqual({ read: false, role: null });
  });

  it('чужой пользователь без грантов не имеет доступа', () => {
    expect(resolveProjectAccess(project(), { userId: 'u2' })).toEqual({ read: false, role: null });
  });

  it('контракт типа: `role` — `ProjectAccessRole` (`null` = доступа нет)', () => {
    const denied = resolveProjectAccess(project(), { userId: 'u2' });
    const granted = resolveProjectAccess(project(), { userId: 'owner-1' });
    expectTypeOf(denied.role).toEqualTypeOf<ProjectAccessRole>();
    expectTypeOf(granted.role).toEqualTypeOf<ProjectAccessRole>();
    expect(denied.role).toBeNull();
    expect(granted.role).toBe('owner');
  });

  it('битая роль в данных — fail-closed (viewer), функция не падает', () => {
    const broken = project({
      members: { 'owner-1': ProjectRole.OWNER, u2: 'superadmin' as unknown as ProjectRole },
    });
    expect(resolveProjectAccess(broken, { userId: 'u2' })).toEqual({ read: true, role: 'viewer' });

    const brokenGroup = project({
      groupMembers: { team: 'root' as unknown as ProjectRole },
    });
    expect(resolveProjectAccess(brokenGroup, { userId: 'u2', groups: ['team'] }).role).toBe('viewer');
  });

  it('нормализация ролей: неизвестное значение → viewer', () => {
    expect(normalizeProjectAccessRole('owner')).toBe('owner');
    expect(normalizeProjectAccessRole('editor')).toBe('editor');
    expect(normalizeProjectAccessRole('viewer')).toBe('viewer');
    expect(normalizeProjectAccessRole('nope')).toBe('viewer');
    expect(normalizeProjectAccessRole(undefined)).toBe('viewer');
    expect(normalizeProjectAccessRole(null)).toBe('viewer');
  });

  it('нормализация карты грантов: битые роли → viewer, не-объект → пусто', () => {
    expect(
      normalizeProjectMemberRoles({ a: 'owner', b: 'broken', c: 'editor' }),
    ).toEqual({ a: ProjectRole.OWNER, b: ProjectRole.VIEWER, c: ProjectRole.EDITOR });
    expect(normalizeProjectMemberRoles(undefined)).toEqual({});
    expect(normalizeProjectMemberRoles('nope')).toEqual({});
    expect(normalizeProjectMemberRoles(['a'])).toEqual({});
  });

  it('нормализация роли «всем»: битое значение → проект не опубликован', () => {
    expect(normalizeProjectEveryoneRole('editor')).toBe(ProjectRole.EDITOR);
    expect(normalizeProjectEveryoneRole(null)).toBeNull();
    expect(normalizeProjectEveryoneRole(undefined)).toBeUndefined();
    expect(normalizeProjectEveryoneRole('broken')).toBeUndefined();
  });

  it('write = owner|editor, manage = owner (viewer не даёт ни того, ни другого)', () => {
    expect(canWriteWithProjectRole('owner')).toBe(true);
    expect(canWriteWithProjectRole('editor')).toBe(true);
    expect(canWriteWithProjectRole('viewer')).toBe(false);
    expect(canWriteWithProjectRole(null)).toBe(false);

    expect(canManageWithProjectRole('owner')).toBe(true);
    expect(canManageWithProjectRole('editor')).toBe(false);
    expect(canManageWithProjectRole('viewer')).toBe(false);
    expect(canManageWithProjectRole(null)).toBe(false);
  });

  it('читатель списка (`ProjectViewer`) — тот же резолвер, но без ролей инстанса', () => {
    const viewer: ProjectViewer = { userId: 'u2', groups: ['team'] };
    const grouped = project({ groupMembers: { team: ProjectRole.EDITOR } });
    expect(resolveProjectAccess(grouped, viewer).role).toBe('editor');
  });
});

describe('PROP-133: производное состояние доступа (visibility)', () => {
  it('author — нет ни пользовательских, ни групповых грантов', () => {
    expect(deriveProjectVisibility(project())).toBe('author');
    expect(deriveProjectVisibility(project({ everyoneRole: null }))).toBe('author');
    expect(deriveProjectVisibility(project({ groupMembers: {} }))).toBe('author');
  });

  it('selected — есть пользовательский грант (кроме владельца) или групповой', () => {
    expect(
      deriveProjectVisibility(
        project({ members: { 'owner-1': ProjectRole.OWNER, u2: ProjectRole.VIEWER } }),
      ),
    ).toBe('selected');
    expect(
      deriveProjectVisibility(project({ groupMembers: { team: ProjectRole.VIEWER } })),
    ).toBe('selected');
  });

  it('all — everyoneRole задан (даже editor)', () => {
    expect(deriveProjectVisibility(project({ everyoneRole: ProjectRole.VIEWER }))).toBe('all');
    expect(deriveProjectVisibility(project({ everyoneRole: ProjectRole.EDITOR }))).toBe('all');
  });

  it('битая роль не роняет вывод', () => {
    expect(
      deriveProjectVisibility(
        project({
          members: { 'owner-1': ProjectRole.OWNER, u2: 'broken' as unknown as ProjectRole },
        }),
      ),
    ).toBe('selected');
  });

  it('владелец в members не делает проект «selected»', () => {
    expect(deriveProjectVisibility(project({ members: { 'owner-1': ProjectRole.OWNER } }))).toBe(
      'author',
    );
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore } from './project-store.js';
import { ProjectRole } from '@itphx/synth-shared';

describe('ProjectStore', () => {
  let store: ProjectStore;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-test-'));
    store = new ProjectStore({ dataDir: tmpDir });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('create создаёт объект с корректными полями', () => {
    const project = store.create('Test Project', 'user-1');
    expect(project.id).toBeTruthy();
    expect(project.name).toBe('Test Project');
    expect(project.ownerId).toBe('user-1');
    expect(project.members).toEqual({ 'user-1': 'owner' });
    expect(project.description).toBe('');
    expect(project.currentTask).toBe('');
    expect(project.invariants).toBe('');
    expect(project.statusMessages).toEqual([]);
    expect(project.createdAt).toBeTruthy();
    expect(project.updatedAt).toBeTruthy();
  });

  it('create принимает опциональные поля', () => {
    const project = store.create('Test', 'u1', {
      description: 'desc',
      icon: 'rocket',
      color: 'a11',
      workspace: '/ws',
    });
    expect(project.description).toBe('desc');
    expect(project.icon).toBe('rocket');
    expect(project.color).toBe('a11');
    expect(project.workspace).toBe('/ws');
  });

  it('PROP-133: create — состояние доступа по умолчанию (владелец, без групп и «всем»)', () => {
    const project = store.create('Test', 'u1');
    expect(project.members).toEqual({ 'u1': ProjectRole.OWNER });
    expect(project.groupMembers).toBeUndefined();
    expect(project.everyoneRole).toBeUndefined();
  });

  it('PROP-133: create — роль владельца всегда owner (понизить нельзя)', () => {
    const project = store.create('Test', 'u1', {
      members: { u1: ProjectRole.VIEWER, u2: ProjectRole.EDITOR },
    });
    expect(project.members).toEqual({ u1: ProjectRole.OWNER, u2: ProjectRole.EDITOR });
  });

  it('PROP-133: create — группам и «всем» из данных создания', () => {
    const project = store.create('Test', 'u1', {
      groupMembers: { team: ProjectRole.EDITOR },
      everyoneRole: ProjectRole.VIEWER,
    });
    expect(project.groupMembers).toEqual({ team: ProjectRole.EDITOR });
    expect(project.everyoneRole).toBe(ProjectRole.VIEWER);
  });

  it('PROP-133: load нормализует битое состояние доступа (битые роли → viewer)', async () => {
    const project = store.create('Broken', 'u1');
    // Пишем в обход нормализации — как будто данные пришли извне.
    (project.members as Record<string, unknown>)['u2'] = 'superadmin';
    project.groupMembers = { team: 'root' as unknown as ProjectRole };
    project.everyoneRole = 'nope' as unknown as ProjectRole;
    await store.save(project);

    const loaded = await store.load(project.id);
    expect(loaded!.members['u1']).toBe(ProjectRole.OWNER);
    expect(loaded!.members['u2']).toBe(ProjectRole.VIEWER);
    expect(loaded!.groupMembers).toEqual({ team: ProjectRole.VIEWER });
    // Битая роль «всем» — проект НЕ опубликован (fail-closed).
    expect(loaded!.everyoneRole).toBeUndefined();
  });

  it('PROP-133: list(viewer) учитывает гранты, группы и режим «всем»', async () => {
    const author = store.create('Author', 'u1');
    await store.save(author);
    const selected = store.create('Selected', 'u1', { members: { u2: ProjectRole.VIEWER } });
    await store.save(selected);
    const grouped = store.create('Grouped', 'u1', { groupMembers: { team: ProjectRole.EDITOR } });
    await store.save(grouped);
    const published = store.create('Published', 'u1', { everyoneRole: ProjectRole.VIEWER });
    await store.save(published);

    const visible = await store.list({ userId: 'u2' });
    expect(visible.map((p) => p.id).sort()).toEqual([published.id, selected.id].sort());
    // Грант по группе добавляет групповой проект (свой грант и «всем» — тоже видны).
    const withGroup = await store.list({ userId: 'u2', groups: ['team'] });
    expect(withGroup.map((p) => p.id).sort()).toEqual(
      [grouped.id, published.id, selected.id].sort(),
    );
    // Чужой пользователь без грантов видит только опубликованный проект.
    const stranger = await store.list({ userId: 'u3' });
    expect(stranger.map((p) => p.id)).toEqual([published.id]);
    // Без аргумента — все проекты.
    expect(await store.list()).toHaveLength(4);
  });

  it('load нормализует невалидные/legacy icon/color → undefined', async () => {
    const project = store.create('Legacy', 'u1', { icon: '🚀', color: 'blue' });
    await store.save(project);
    const loaded = await store.load(project.id);
    expect(loaded!.icon).toBeUndefined();
    expect(loaded!.color).toBeUndefined();

    project.color = 'weird';
    await store.save(project);
    expect((await store.load(project.id))!.color).toBeUndefined();

    project.icon = 'heart';
    project.color = 'a7';
    await store.save(project);
    const ok = await store.load(project.id);
    expect(ok!.icon).toBe('heart');
    expect(ok!.color).toBe('a7');
  });

  it('create сидит скоуп mcp/skills (ADR-071 §2.4 / ADR-046 §4.5)', () => {
    const project = store.create('Seeded', 'u1', {
      mcp: { enabled: ['s'], defaultOn: ['s'] },
      skills: { enabled: ['a', 'b'], defaultOn: ['a', 'b'] },
    });
    expect(project.mcp).toEqual({ enabled: ['s'], defaultOn: ['s'] });
    expect(project.skills).toEqual({ enabled: ['a', 'b'], defaultOn: ['a', 'b'] });
  });

  it('create без сида не задаёт mcp/skills (legacy-гейт открыт)', () => {
    const project = store.create('NoSeed', 'u1');
    expect(project.mcp).toBeUndefined();
    expect(project.skills).toBeUndefined();
  });

  it('save сохраняет в файловую систему', async () => {
    const project = store.create('Atomic', 'user-1');
    await store.save(project);
    const loaded = await store.load(project.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.name).toBe('Atomic');
  });

  it('load читает проект обратно', async () => {
    const project = store.create('Roundtrip', 'user-1', { description: 'hello' });
    await store.save(project);
    const loaded = await store.load(project.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(project.id);
    expect(loaded!.name).toBe('Roundtrip');
    expect(loaded!.description).toBe('hello');
    expect(loaded!.ownerId).toBe('user-1');
  });

  it('load возвращает null для несуществующего проекта', async () => {
    const result = await store.load('no-such-project');
    expect(result).toBeNull();
  });

  it('delete удаляет файл проекта', async () => {
    const project = store.create('ToDelete', 'user-1');
    await store.save(project);
    expect(await store.load(project.id)).not.toBeNull();
    await store.delete(project.id);
    expect(await store.load(project.id)).toBeNull();
  });

  it('list возвращает все проекты', async () => {
    await store.save(store.create('P1', 'u1'));
    await store.save(store.create('P2', 'u2'));
    const all = await store.list();
    expect(all).toHaveLength(2);
  });

  it('list фильтрует по owner/member', async () => {
    const p1 = store.create('Owner', 'u1');
    await store.save(p1);
    await store.save(store.create('Other', 'u2'));
    const p3 = store.create('Member', 'u3');
    p3.members['u1'] = ProjectRole.EDITOR;
    await store.save(p3);
    const forU1 = await store.list({ userId: 'u1' });
    expect(forU1).toHaveLength(2);
    const ids = forU1.map((p) => p.id);
    expect(ids).toContain(p1.id);
    expect(ids).toContain(p3.id);
  });

  it('list возвращает пустой массив когда директория не существует', async () => {
    const emptyStore = new ProjectStore({ dataDir: '/tmp/non-existent-synth-test' });
    const result = await emptyStore.list();
    expect(result).toEqual([]);
  });

  it('list сортирует по updatedAt по убыванию', async () => {
    const p1 = store.create('A', 'u1');
    const p2 = store.create('B', 'u1');
    p1.updatedAt = new Date(1).toISOString();
    p2.updatedAt = new Date(2).toISOString();
    await store.save(p1);
    await store.save(p2);
    const all = await store.list();
    expect(all[0]!.id).toBe(p2.id);
    expect(all[1]!.id).toBe(p1.id);
  });

  it('полный CRUD цикл', async () => {
    const project = store.create('CRUD', 'u1', { description: 'initial' });
    expect(project.name).toBe('CRUD');
    await store.save(project);
    const loaded = await store.load(project.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.description).toBe('initial');
    loaded!.name = 'CRUD Updated';
    loaded!.description = 'modified';
    await store.save(loaded!);
    const updated = await store.load(project.id);
    expect(updated!.name).toBe('CRUD Updated');
    expect(updated!.description).toBe('modified');
    await store.delete(project.id);
    expect(await store.load(project.id)).toBeNull();
  });
});

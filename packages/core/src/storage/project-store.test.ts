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
    const forU1 = await store.list('u1');
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

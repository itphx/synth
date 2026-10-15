import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from './manager.js';
import { FileStore } from '../storage/file-store.js';
import type { Project } from '@itphx/synth-shared';

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'Проект',
    ownerId: 'local',
    members: { local: 'owner' },
    description: '',
    currentTask: '',
    invariants: '',
    statusMessages: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as Project;
}

describe('SessionManager — снапшоты скоупа (ADR-071 §2.4 / ADR-046 §4.5)', () => {
  let store: FileStore;
  let tmpDir: string;
  let project: Project | null;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-scope-'));
    store = new FileStore({ dataDir: tmpDir });
    project = null;
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeManager(opts?: { systemDefaults?: { mcpDefaultOn?: string[]; skillsDefaultOn?: string[] } }): SessionManager {
    return new SessionManager(store, {
      projectStore: { load: async (id) => (project && project.id === id ? project : null) },
      systemDefaultsProvider: async () => opts?.systemDefaults,
    });
  }

  it('снапшоты берутся из project.defaultOn', async () => {
    project = makeProject({ mcp: { enabled: ['s'], defaultOn: ['s'] }, skills: { enabled: ['a'], defaultOn: ['a'] } });
    const manager = makeManager();
    const session = await manager.createSession({ projectId: 'p1' });
    expect(session.settings.mcpDefaultOn).toEqual(['s']);
    expect(session.settings.skillsDefaultOn).toEqual(['a']);

    // Переживают перезагрузку.
    const reloaded = await manager.getSession(session.id);
    expect(reloaded!.settings.skillsDefaultOn).toEqual(['a']);
  });

  it('изменение project.defaultOn НЕ влияет на уже созданную сессию', async () => {
    project = makeProject({ skills: { enabled: ['a', 'b'], defaultOn: ['a'] } });
    const manager = makeManager();
    const session = await manager.createSession({ projectId: 'p1' });
    expect(session.settings.skillsDefaultOn).toEqual(['a']);

    // Админ меняет сид проекта.
    project.skills = { enabled: ['a', 'b'], defaultOn: ['b'] };
    const reloaded = await manager.getSession(session.id);
    expect(reloaded!.settings.skillsDefaultOn).toEqual(['a']);
  });

  it('без проекта — системные дефолты', async () => {
    const manager = makeManager({ systemDefaults: { mcpDefaultOn: ['sys'], skillsDefaultOn: ['x'] } });
    const session = await manager.createSession({});
    expect(session.settings.mcpDefaultOn).toEqual(['sys']);
    expect(session.settings.skillsDefaultOn).toEqual(['x']);
  });

  it('проект без настроек → системные дефолты', async () => {
    project = makeProject();
    const manager = makeManager({ systemDefaults: { mcpDefaultOn: ['sys'], skillsDefaultOn: ['x'] } });
    const session = await manager.createSession({ projectId: 'p1' });
    expect(session.settings.mcpDefaultOn).toEqual(['sys']);
    expect(session.settings.skillsDefaultOn).toEqual(['x']);
  });

  it('явно переданные снапшоты приоритетнее проекта', async () => {
    project = makeProject({ skills: { enabled: ['a'], defaultOn: ['a'] } });
    const manager = makeManager();
    const session = await manager.createSession({
      projectId: 'p1',
      settings: { skillsDefaultOn: ['explicit'] },
    });
    expect(session.settings.skillsDefaultOn).toEqual(['explicit']);
  });

  it('skills/skillsDisabled не теряются при создании', async () => {
    const manager = makeManager();
    const session = await manager.createSession({
      settings: { skills: ['a'], skillsDisabled: ['b'] },
    });
    expect(session.settings.skills).toEqual(['a']);
    expect(session.settings.skillsDisabled).toEqual(['b']);
    const reloaded = await manager.getSession(session.id);
    expect(reloaded!.settings.skills).toEqual(['a']);
    expect(reloaded!.settings.skillsDisabled).toEqual(['b']);
  });

  it('project.skills.defaultOn=[] (Тестовый проект) → пустой снапшот, не системный дефолт', async () => {
    project = makeProject({ skills: { enabled: [], defaultOn: [] } });
    const manager = makeManager({ systemDefaults: { skillsDefaultOn: ['x', 'y'] } });
    const session = await manager.createSession({ projectId: 'p1' });
    expect(session.settings.skillsDefaultOn).toEqual([]);
  });
});

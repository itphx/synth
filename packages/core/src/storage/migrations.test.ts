import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '../sessions/manager.js';
import { FileStore } from './file-store.js';
import { ProjectStore } from './project-store.js';
import { RuntimeSettingsStore } from './runtime-settings.js';
import { migrateSessionScopeSnapshots, SESSION_SCOPE_SNAPSHOT_MIGRATION } from './migrations.js';

describe('migrateSessionScopeSnapshots (AD-071 §2.4 / AD-046 §4.5)', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;
  let projectStore: ProjectStore;
  let settingsStore: RuntimeSettingsStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-migrate-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    projectStore = new ProjectStore({ dataDir: tmpDir });
    settingsStore = new RuntimeSettingsStore({ dataDir: tmpDir });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function makeProject(): Promise<string> {
    const project = projectStore.create('P', 'local');
    project.skills = { enabled: ['a'], defaultOn: ['a'] };
    project.mcp = { enabled: ['s'], defaultOn: ['s'] };
    await projectStore.save(project);
    return project.id;
  }

  it('материализует снапшоты у существующих сессий и идемпотентна', async () => {
    const projectId = await makeProject();
    const withProject = await sessionManager.createSession({ projectId });
    const noProject = await sessionManager.createSession({});
    expect(withProject.settings.skillsDefaultOn).toBeUndefined();

    const resolveSystemDefaults = async () => ({ mcpDefaultOn: ['sys'], skillsDefaultOn: ['x'] });
    const first = await migrateSessionScopeSnapshots({ sessionManager, projectStore, settingsStore, resolveSystemDefaults });
    expect(first).toBe(2);

    const loadedWithProject = await sessionManager.getSession(withProject.id);
    expect(loadedWithProject!.settings.skillsDefaultOn).toEqual(['a']);
    expect(loadedWithProject!.settings.mcpDefaultOn).toEqual(['s']);

    const loadedNoProject = await sessionManager.getSession(noProject.id);
    expect(loadedNoProject!.settings.skillsDefaultOn).toEqual(['x']);
    expect(loadedNoProject!.settings.mcpDefaultOn).toEqual(['sys']);

    // Маркер выставлен; повторный вызов — no-op.
    expect(await settingsStore.getMigrationMarker(SESSION_SCOPE_SNAPSHOT_MIGRATION)).toBe(true);
    const second = await migrateSessionScopeSnapshots({ sessionManager, projectStore, settingsStore, resolveSystemDefaults });
    expect(second).toBe(0);

    const afterSecond = await sessionManager.getSession(withProject.id);
    expect(afterSecond!.settings.skillsDefaultOn).toEqual(['a']);
  });

  it('не перетирает уже существующие снапшоты', async () => {
    const projectId = await makeProject();
    const session = await sessionManager.createSession({
      projectId,
      settings: { skillsDefaultOn: ['custom'], mcpDefaultOn: ['custom'] },
    });
    await migrateSessionScopeSnapshots({
      sessionManager,
      projectStore,
      settingsStore,
      resolveSystemDefaults: async () => ({ mcpDefaultOn: ['sys'], skillsDefaultOn: ['x'] }),
    });
    const loaded = await sessionManager.getSession(session.id);
    expect(loaded!.settings.skillsDefaultOn).toEqual(['custom']);
    expect(loaded!.settings.mcpDefaultOn).toEqual(['custom']);
  });
});

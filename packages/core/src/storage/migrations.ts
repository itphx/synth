import type { Project, Session } from '@itphx/synth-shared';
import type { SessionManager } from '../sessions/manager.js';
import type { RuntimeSettingsStore } from './runtime-settings.js';
import type { SessionProjectStoreLike } from '../sessions/manager.js';

/** Маркер разовой миграции снапшотов скоупа (идемпотентность). */
export const SESSION_SCOPE_SNAPSHOT_MIGRATION = 'session-scope-snapshots-v1';

export interface SessionScopeMigrationDeps {
  sessionManager: SessionManager;
  projectStore?: SessionProjectStoreLike;
  settingsStore: RuntimeSettingsStore;
  /** Системные дефолты для сессий без проекта (или проекта без настроек). */
  resolveSystemDefaults?: () => Promise<{ mcpDefaultOn?: string[]; skillsDefaultOn?: string[] } | undefined>;
}

/**
 * AD-071 §2.4 / AD-046 §4.5: разовая идемпотентная миграция. Материализует
 * снапшоты `mcpDefaultOn`/`skillsDefaultOn` у существующих сессий:
 * `project.mcp/skills.defaultOn` (при наличии настроек проекта) либо системный
 * дефолт. Guard — маркер `migrations.session-scope-snapshots-v1` в runtime settings.
 *
 * @returns число обновлённых сессий (0 — миграция уже выполнялась).
 */
export async function migrateSessionScopeSnapshots(deps: SessionScopeMigrationDeps): Promise<number> {
  if (await deps.settingsStore.getMigrationMarker(SESSION_SCOPE_SNAPSHOT_MIGRATION)) return 0;

  const sessions = await deps.sessionManager.listSessions();
  const projects = new Map<string, Project | null>();
  let systemDefaults: { mcpDefaultOn?: string[]; skillsDefaultOn?: string[] } | undefined;
  const getSystemDefaults = async () => {
    if (systemDefaults === undefined && deps.resolveSystemDefaults) {
      systemDefaults = await deps.resolveSystemDefaults().catch(() => undefined) ?? {};
    }
    return systemDefaults ?? {};
  };
  const loadProject = async (id: string): Promise<Project | null> => {
    if (!deps.projectStore) return null;
    if (projects.has(id)) return projects.get(id) ?? null;
    const project = await deps.projectStore.load(id).catch(() => null);
    projects.set(id, project);
    return project;
  };

  let updated = 0;
  for (const session of sessions) {
    let mcpDefaultOn = session.settings.mcpDefaultOn;
    let skillsDefaultOn = session.settings.skillsDefaultOn;
    if (mcpDefaultOn !== undefined && skillsDefaultOn !== undefined) continue;

    const project: Project | null = session.projectId ? await loadProject(session.projectId) : null;
    if (mcpDefaultOn === undefined) mcpDefaultOn = project?.mcp?.defaultOn;
    if (skillsDefaultOn === undefined) skillsDefaultOn = project?.skills?.defaultOn;
    if (mcpDefaultOn === undefined || skillsDefaultOn === undefined) {
      const sys = await getSystemDefaults();
      if (mcpDefaultOn === undefined) mcpDefaultOn = sys.mcpDefaultOn;
      if (skillsDefaultOn === undefined) skillsDefaultOn = sys.skillsDefaultOn;
    }
    if (mcpDefaultOn === undefined && skillsDefaultOn === undefined) continue;

    const updatedSession: Session = {
      ...session,
      settings: {
        ...session.settings,
        ...(mcpDefaultOn !== undefined ? { mcpDefaultOn } : {}),
        ...(skillsDefaultOn !== undefined ? { skillsDefaultOn } : {}),
      },
    };
    await deps.sessionManager.saveSession(updatedSession);
    updated++;
  }

  await deps.settingsStore.setMigrationMarker(SESSION_SCOPE_SNAPSHOT_MIGRATION);
  return updated;
}

import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import {
  skillsDisabledSchema,
  skillsSystemSettingsSchema,
  sessionSkillUpdateSchema,
  projectSkillUpdateSchema,
} from '@itphx/synth-shared';
import type { SessionManager } from '../../sessions/manager.js';
import type { SkillService } from '../../engine/skills/service.js';
import type { RuntimeSettingsStore } from '../../storage/runtime-settings.js';
import type { Project, PermissionConfig, Session, SkillsDisabledRequest } from '@itphx/synth-shared';
import type { AuthKit } from '../../auth/local.js';
import { resolveSkillRule } from '../../engine/permission/evaluator.js';
import { resolveSkillAvailability } from '../../engine/skills/scope.js';
import type { SkillScopeOptions } from '../../engine/skills/types.js';
import { accessKindOf, createSessionAccessPredicate } from '../session-access-guard.js';
import type { SessionAccessKind } from '../session-access-guard.js';
import type { LocalOwnerResolver } from '../local-owner.js';

const LOCAL_USER_ID = 'local';

/** Структурный контракт хранилища проектов (core/backend реализации совместимы). */
export interface SkillScopeProjectStore {
  load(id: string): Promise<Project | null>;
  save(project: Project): Promise<void>;
}

export interface SkillScopeRoutesDeps {
  sessionManager: SessionManager;
  /** Для project-скоупа и effective-списка. */
  skillService?: SkillService;
  settingsStore?: RuntimeSettingsStore;
  projectStore?: SkillScopeProjectStore;
  /** Глобальный permission-конфиг (fallback, если у сессии нет своего). */
  permissionConfig?: PermissionConfig;
  /** Резолв рабочего каталога проекта по id (project-скиллы). */
  resolveProjectWorkspace?: (projectId: string) => Promise<string | undefined>;
}

export interface SkillScopeRoutesOptions {
  writeGuard?: MiddlewareHandler;
  /** Резолв id текущего пользователя (standalone — `local`). */
  resolveUserId?: (c: Context) => string | Promise<string>;
  /** Доступ к сессии (владелец|ADMIN). Standalone — owner local/none. */
  canAccess?: (session: Session, c: Context, userId: string) => boolean | Promise<boolean>;
  /**
   * Доп. правило доступа к сессии (например, участие в проекте) — та же семантика,
   * что у `createSessionRoutes` (единая точка истины на ресурс сессии). `access`
   * различает чтение (`GET`) и мутацию (`PUT`).
   */
  resolveCanAccessExtra?: (
    session: Session,
    c: Context,
    userId: string,
    access: SessionAccessKind,
  ) => boolean | Promise<boolean>;
  /** Сквозной обзор (ADMIN/LEAD) — доступ ко всем сессиям (единая семантика). */
  resolveElevated?: (c: Context) => boolean | Promise<boolean>;
  /** Доступ к управлению проектом (owner/LEAD/ADMIN). Standalone — разрешено. */
  canAccessProject?: (project: Project, c: Context, userId: string) => boolean | Promise<boolean>;
  /** ADR-046 §4.5: live-обновление системного hard-gate скиллов (оркестратор). */
  onSkillsDisabledChange?: (disabled: SkillsDisabledRequest) => void;
  /**
   * ADR-089 (standalone): нормализация legacy-владельца (UUID профиля `local`)
   * при доступе к сессии. Managed не задаёт (id реальные).
   */
  localOwnerResolver?: LocalOwnerResolver;
}

interface EffectiveSkill {
  name: string;
  description: string;
  level: string;
  scope: string;
  trusted: boolean;
  available: boolean;
  unavailableReason?: string;
  enabled: boolean;
  disabled: boolean;
  disabledReason?: 'system' | 'project' | 'session';
}

async function listEffectiveSkills(
  deps: SkillScopeRoutesDeps,
  opts: {
    projectWorkspace?: string;
    sessionEnabled: string[];
    sessionDisabled: string[];
    /** Hard-gate проекта (`project.skills.enabled`); undefined — без гейта. */
    projectEnabled?: string[];
    /** Снапшот/сид новых сессий; undefined — legacy-режим. */
    defaultOn?: string[];
    /** Effective permission-конфиг (session.settings.permission ?? global). */
    permissionConfig?: PermissionConfig;
  },
): Promise<EffectiveSkill[]> {
  if (!deps.skillService) return [];
  const { skills } = await deps.skillService.listSummaries({ projectWorkspace: opts.projectWorkspace });
  const systemDisabled = await deps.settingsStore?.getSkillsDisabled();
  const scope: SkillScopeOptions = {
    systemDisabled,
    projectEnabled: opts.projectEnabled,
    defaultOn: opts.defaultOn,
    sessionEnabled: opts.sessionEnabled,
    sessionDisabled: opts.sessionDisabled,
  };

  return skills
    // ADR-046 §8.1: `deny` скрывает скилл из выдачи (в отличие от disabled).
    .filter((s) => resolveSkillRule(opts.permissionConfig, s.name)?.action !== 'deny')
    .map((s) => {
      const availability = resolveSkillAvailability(
        { name: s.name, category: s.category, groups: s.groups },
        scope,
      );
      const sessionOn = opts.sessionEnabled.includes(s.name);
      return {
        name: s.name,
        description: s.description,
        level: sessionOn ? 'session' : s.level,
        scope: s.scope,
        trusted: s.trusted,
        available: s.available,
        ...(s.unavailableReason ? { unavailableReason: s.unavailableReason } : {}),
        enabled: availability.enabled,
        disabled: !availability.enabled,
        ...(availability.reason ? { disabledReason: availability.reason } : {}),
      };
    });
}

/**
 * ADR-046 §4.5: scope-API скиллов (аналог MCP).
 * - `/sessions/:id/skills` — per-session enable/disable + effective;
 * - `/projects/:id/skills` — проектный скоуп (owner/lead);
 * - `/settings/skills` — instance-wide группы/имена + policy.
 */
export function createSessionSkillScopeRoutes(
  auth: AuthKit,
  deps: SkillScopeRoutesDeps,
  opts?: SkillScopeRoutesOptions,
): Hono {
  const app = new Hono();
  const writeGuard = opts?.writeGuard ?? (async (_c, next) => { await next(); });
  const resolveUserId = opts?.resolveUserId ?? (() => LOCAL_USER_ID);
  // Единая с `createSessionRoutes` семантика доступа к сессии: elevated
  // (ADMIN/LEAD) → всё; иначе владелец|ADMIN (`canAccess`) либо участник проекта
  // (`resolveCanAccessExtra`); standalone-дефолт — владелец `local`/без владельца.
  // Маршруты скиллов монтируются отдельной фабрикой (не под prefix-guard'ом
  // сессий), поэтому используют ровно тот же предикат, чтобы правила не расходились.
  const accessPredicate = createSessionAccessPredicate({
    canAccess: opts?.canAccess,
    resolveCanAccessExtra: opts?.resolveCanAccessExtra,
    localUserId: LOCAL_USER_ID,
    localOwnerResolver: opts?.localOwnerResolver,
  });
  const canAccess = async (session: Session, c: Context, userId: string): Promise<boolean> => {
    if ((await opts?.resolveElevated?.(c)) ?? false) return true;
    return accessPredicate(session, c, userId, accessKindOf(c.req.method));
  };
  const forbidden = (c: Context) => c.json(
    { error: { code: 'FORBIDDEN', message: 'Недостаточно прав для доступа к сессии' } },
    403,
  );

  /** Загружает сессию и проверяет доступ; `null` — ответ уже сформирован. */
  const loadAccessibleSession = async (c: Context): Promise<Session | Response> => {
    const id = c.req.param('id') ?? '';
    const session = await deps.sessionManager.getSession(id);
    if (!session) return c.json({ error: { code: 'NOT_FOUND', message: 'Сессия не найдена' } }, 404);
    const userId = await resolveUserId(c);
    if (!(await canAccess(session, c, userId))) return forbidden(c);
    return session;
  };

  const effective = async (c: Context) => {
    const id = c.req.param('id') ?? '';
    const loaded = await loadAccessibleSession(c);
    if (loaded instanceof Response) return loaded;
    const session = loaded;
    const projectId = session.projectId;
    const project = projectId && deps.projectStore
      ? await deps.projectStore.load(projectId).catch(() => null)
      : null;
    const workspace = projectId && deps.resolveProjectWorkspace
      ? await deps.resolveProjectWorkspace(projectId).catch(() => undefined)
      : undefined;
    const skills = await listEffectiveSkills(deps, {
      projectWorkspace: workspace,
      sessionEnabled: session.settings.skills ?? [],
      sessionDisabled: session.settings.skillsDisabled ?? [],
      projectEnabled: project?.skills ? project.skills.enabled : undefined,
      defaultOn: session.settings.skillsDefaultOn,
      permissionConfig: session.settings.permission ?? deps.permissionConfig,
    });
    return c.json({
      session_id: id,
      skills,
      enabled: session.settings.skills ?? [],
      disabled: session.settings.skillsDisabled ?? [],
    });
  };

  app.get('/:id/skills', auth.requireAuth, effective);
  app.get('/:id/skills/effective', auth.requireAuth, effective);

  app.put('/:id/skills', auth.requireAuth, writeGuard, async (c) => {
    const loaded = await loadAccessibleSession(c);
    if (loaded instanceof Response) return loaded;
    const session = loaded;
    const body = await c.req.json().catch(() => ({}));
    const parsed = sessionSkillUpdateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Некорректные данные скиллов сессии' } }, 400);
    }
    const { name, enabled, skills, skillsDisabled } = parsed.data;
    if (name !== undefined) {
      const enabledList = new Set(session.settings.skills ?? []);
      const disabledList = new Set(session.settings.skillsDisabled ?? []);
      if (enabled) { enabledList.add(name); disabledList.delete(name); }
      else { enabledList.delete(name); disabledList.add(name); }
      session.settings.skills = [...enabledList];
      session.settings.skillsDisabled = [...disabledList];
    }
    if (skills !== undefined) session.settings.skills = skills;
    if (skillsDisabled !== undefined) session.settings.skillsDisabled = skillsDisabled;
    await deps.sessionManager.updateSession(session);
    return effective(c);
  });

  return app;
}

export function createProjectSkillScopeRoutes(
  auth: AuthKit,
  deps: SkillScopeRoutesDeps,
  opts?: SkillScopeRoutesOptions,
): Hono {
  const app = new Hono();
  const writeGuard = opts?.writeGuard ?? (async (_c, next) => { await next(); });
  const resolveUserId = opts?.resolveUserId ?? (() => LOCAL_USER_ID);
  // Standalone — однопользовательский режим; backend переопределяет
  // `opts.canAccessProject` (owner/LEAD/ADMIN), как project-роуты.
  const canAccessProject = async (project: Project, c: Context, userId: string): Promise<boolean> => {
    if (opts?.canAccessProject) return opts.canAccessProject(project, c, userId);
    return true;
  };
  const forbidden = (c: Context) => c.json(
    { error: { code: 'FORBIDDEN', message: 'Недостаточно прав для доступа к проекту' } },
    403,
  );

  /** Загружает проект и проверяет доступ; `null` — ответ уже сформирован. */
  const loadAccessibleProject = async (c: Context): Promise<Project | Response> => {
    const id = c.req.param('id') ?? '';
    if (!deps.projectStore) return c.json({ error: { code: 'INTERNAL_ERROR', message: 'projectStore не настроен' } }, 500);
    const project = await deps.projectStore.load(id);
    if (!project) return c.json({ error: { code: 'NOT_FOUND', message: 'Проект не найден' } }, 404);
    const userId = await resolveUserId(c);
    if (!(await canAccessProject(project, c, userId))) return forbidden(c);
    return project;
  };

  const read = async (c: Context) => {
    const id = c.req.param('id') ?? '';
    const loaded = await loadAccessibleProject(c);
    if (loaded instanceof Response) return loaded;
    const project = loaded;
    const workspace = deps.resolveProjectWorkspace
      ? await deps.resolveProjectWorkspace(id).catch(() => undefined)
      : project.workspace;
    const skills = await listEffectiveSkills(deps, {
      projectWorkspace: workspace,
      sessionEnabled: [],
      sessionDisabled: [],
      projectEnabled: project.skills ? project.skills.enabled : undefined,
      defaultOn: project.skills ? project.skills.defaultOn : undefined,
      permissionConfig: deps.permissionConfig,
    });
    return c.json({
      project_id: id,
      skills,
      enabled: project.skills?.enabled ?? [],
      defaultOn: project.skills?.defaultOn ?? [],
    });
  };

  app.get('/:id/skills', auth.requireAuth, read);

  app.put('/:id/skills', auth.requireAuth, writeGuard, async (c) => {
    const loaded = await loadAccessibleProject(c);
    if (loaded instanceof Response) return loaded;
    const project = loaded;
    const body = await c.req.json().catch(() => ({}));
    const parsed = projectSkillUpdateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Некорректные данные скиллов проекта' } }, 400);
    }
    project.skills = {
      enabled: parsed.data.enabled ?? project.skills?.enabled ?? [],
      defaultOn: parsed.data.defaultOn ?? project.skills?.defaultOn ?? [],
    };
    await deps.projectStore!.save(project);
    return read(c);
  });

  return app;
}

export function createSkillSettingsRoutes(
  auth: AuthKit,
  deps: Pick<SkillScopeRoutesDeps, 'settingsStore'>,
  opts?: SkillScopeRoutesOptions,
): Hono {
  const app = new Hono();
  const writeGuard = opts?.writeGuard ?? (async (_c, next) => { await next(); });

  app.get('/skills', auth.requireAuth, async (c) => {
    const disabled = (await deps.settingsStore?.getSkillsDisabled()) ?? { categories: [], groups: [], skills: [] };
    const disabledForNewProjects = (await deps.settingsStore?.getSkillsDisabledForNewProjects())
      ?? { categories: [], groups: [], skills: [] };
    const policy = (await deps.settingsStore?.getSkillsPolicy()) ?? 'auto';
    return c.json({ disabled, disabledForNewProjects, policy });
  });

  app.put('/skills', auth.requireAuth, writeGuard, async (c) => {
    if (!deps.settingsStore) return c.json({ error: { code: 'INTERNAL_ERROR', message: 'settingsStore не настроен' } }, 500);
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const parsed = skillsSystemSettingsSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Некорректные данные отключения скиллов' } }, 400);
    }
    if (parsed.data.disabled) {
      await deps.settingsStore.setSkillsDisabled(parsed.data.disabled);
    } else if (body.disabled === undefined) {
      // Legacy-совместимость: тело-бакет `{categories,groups,skills}`.
      const legacy = skillsDisabledSchema.safeParse(body);
      if (legacy.success) await deps.settingsStore.setSkillsDisabled(legacy.data);
    }
    if (parsed.data.disabledForNewProjects) {
      await deps.settingsStore.setSkillsDisabledForNewProjects(parsed.data.disabledForNewProjects);
    }
    if (typeof parsed.data.policy === 'string') {
      await deps.settingsStore.setSkillsPolicy(parsed.data.policy as never);
    }
    const disabled = (await deps.settingsStore.getSkillsDisabled()) ?? { categories: [], groups: [], skills: [] };
    opts?.onSkillsDisabledChange?.(disabled);
    const disabledForNewProjects = (await deps.settingsStore.getSkillsDisabledForNewProjects())
      ?? { categories: [], groups: [], skills: [] };
    const policy = await deps.settingsStore.getSkillsPolicy();
    return c.json({ disabled, disabledForNewProjects, policy: policy ?? 'auto' });
  });

  app.delete('/skills', auth.requireAuth, writeGuard, async (c) => {
    await deps.settingsStore?.clearSkillsDisabled();
    await deps.settingsStore?.clearSkillsDisabledForNewProjects();
    await deps.settingsStore?.clearSkillsPolicy();
    opts?.onSkillsDisabledChange?.({ categories: [], groups: [], skills: [] });
    return c.json({ status: 'reset' });
  });

  return app;
}

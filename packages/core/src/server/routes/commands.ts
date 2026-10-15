import { Hono } from 'hono';
import type { Context } from 'hono';
import type { CommandSummary } from '@itphx/synth-shared';
import type { AuthKit } from '../../auth/local.js';
import type { CommandService } from '../../engine/commands/service.js';

export interface CommandRoutesDeps {
  commandService: CommandService;
  /** Резолв рабочего каталога проекта по id (project-команды/скиллы). */
  resolveProjectWorkspace?: (projectId: string) => Promise<string | undefined>;
  /**
   * Контекст агента сессии/запроса (binding + capabilities) для capability-aware.
   * Не задан — без фильтра по возможностям.
   */
  resolveContext?: (c: Context) => Promise<{
    capabilities?: readonly string[];
    agent?: { id?: string; groups?: string[] };
    sessionEnabled?: string[];
    sessionDisabled?: string[];
  } | undefined>;
}

export interface CommandRoutesMessages {
  notFound: string;
}

export interface CommandRoutesOptions {
  messages?: (c: Context) => CommandRoutesMessages;
}

/**
 * ADR-046 §9.1/§7: `GET /api/v2/commands` — встроенные + шаблонные команды +
 * скиллы (invocation user/both) + bundles. `?diagnostics=1` — shadowed/ошибки.
 */
export function createCommandRoutes(
  auth: AuthKit,
  deps: CommandRoutesDeps,
  opts?: CommandRoutesOptions,
): Hono {
  const app = new Hono();
  void opts;

  const resolveWorkspace = async (c: Context): Promise<string | undefined> => {
    const projectId = c.req.query('project_id');
    if (!projectId || !deps.resolveProjectWorkspace) return undefined;
    try {
      return await deps.resolveProjectWorkspace(projectId);
    } catch {
      return undefined;
    }
  };

  app.get('/', auth.requireAuth, async (c) => {
    const projectWorkspace = await resolveWorkspace(c);
    const ctx = await deps.resolveContext?.(c);
    const withDiagnostics = c.req.query('diagnostics') === '1';
    const { commands, diagnostics } = await deps.commandService.list({
      projectWorkspace,
      capabilities: ctx?.capabilities,
      agent: ctx?.agent,
      sessionEnabled: ctx?.sessionEnabled,
      sessionDisabled: ctx?.sessionDisabled,
    });
    const summaries: CommandSummary[] = commands;
    return c.json({
      commands: summaries,
      ...(projectWorkspace ? { workspace: projectWorkspace } : {}),
      ...(withDiagnostics ? { diagnostics } : {}),
    });
  });

  return app;
}

import { Hono } from 'hono';
import type { AuthKit } from '../auth/middleware.js';
import type { ProjectStore } from '../storage/project-store.js';
import { WorkspaceResolver } from '../lib/workspace-resolver.js';
import { GitService } from '../lib/git-service.js';
import {
  gitScanBodySchema,
  gitInitBodySchema,
  gitCloneBodySchema,
  gitLogQuerySchema,
  gitCommitQuerySchema,
} from '@itphx/synth-shared';
import type { FsError } from '@itphx/synth-shared';

export function createGitRoutes(
  kit: AuthKit,
  projectStore: ProjectStore,
  workspacesRoot: string,
): Hono {
  const app = new Hono();
  const wsResolver = new WorkspaceResolver(workspacesRoot, (projectId) => projectStore.load(projectId));
  const gitService = new GitService(workspacesRoot);

  async function resolveWorkspace(projectId: string): Promise<string> {
    return wsResolver.resolve(projectId);
  }

  // POST /api/v2/git/scan
  app.post('/scan', kit.requireAuth, async (c) => {
    try {
      const body = gitScanBodySchema.parse(await c.req.json());
      const wsPath = await resolveWorkspace(body.projectId);
      const repos = await gitService.scanWorkspace(wsPath);
      return c.json({ repos });
    } catch (err) {
      if ((err as FsError)?.code) {
        return c.json({ error: err as FsError }, codeToStatus((err as FsError).code as string) as 400 | 403 | 404 | 500);
      }
      return c.json({ error: { error: String(err), code: 'PERMISSION_DENIED' } } as { error: FsError }, 500);
    }
  });

  // POST /api/v2/git/repos/init
  app.post('/repos/init', kit.requireAuth, async (c) => {
    try {
      const body = gitInitBodySchema.parse(await c.req.json());
      const wsPath = await resolveWorkspace(body.projectId);
      const repo = await gitService.initRepo(wsPath, body.path, body.defaultBranch);
      return c.json(repo, 201);
    } catch (err) {
      if ((err as FsError)?.code) {
        return c.json({ error: err as FsError }, codeToStatus((err as FsError).code as string) as 400 | 403 | 404 | 500);
      }
      return c.json({ error: { error: String(err), code: 'PERMISSION_DENIED' } } as { error: FsError }, 500);
    }
  });

  // POST /api/v2/git/repos/clone
  app.post('/repos/clone', kit.requireAuth, async (c) => {
    try {
      const body = gitCloneBodySchema.parse(await c.req.json());
      const wsPath = await resolveWorkspace(body.projectId);
      const repo = await gitService.cloneRepo(wsPath, body.path || '', body.url, body.branch);
      return c.json(repo, 201);
    } catch (err) {
      if ((err as FsError)?.code) {
        return c.json({ error: err as FsError }, codeToStatus((err as FsError).code as string) as 400 | 403 | 404 | 500);
      }
      return c.json({ error: { error: String(err), code: 'PERMISSION_DENIED' } } as { error: FsError }, 500);
    }
  });

  // GET /api/v2/git/log
  app.get('/log', kit.requireAuth, async (c) => {
    try {
      const query = gitLogQuerySchema.parse({
        project_id: c.req.query('project_id'),
        repo_path: c.req.query('repo_path') || '',
        max_count: c.req.query('max_count'),
      });
      const wsPath = await resolveWorkspace(query.project_id);
      const commits = await gitService.getLog(wsPath, query.repo_path, query.max_count || 30);
      return c.json({ commits });
    } catch (err) {
      if ((err as FsError)?.code) {
        return c.json({ error: err as FsError }, codeToStatus((err as FsError).code as string) as 400 | 403 | 404 | 500);
      }
      return c.json({ error: { error: String(err), code: 'PERMISSION_DENIED' } } as { error: FsError }, 500);
    }
  });

  // GET /api/v2/git/commit
  app.get('/commit', kit.requireAuth, async (c) => {
    try {
      const query = gitCommitQuerySchema.parse({
        project_id: c.req.query('project_id'),
        repo_path: c.req.query('repo_path') || '',
        hash: c.req.query('hash'),
      });
      const wsPath = await resolveWorkspace(query.project_id);
      const commit = await gitService.getCommitDetail(wsPath, query.repo_path, query.hash);
      return c.json({ commit });
    } catch (err) {
      if ((err as FsError)?.code) {
        return c.json({ error: err as FsError }, codeToStatus((err as FsError).code as string) as 400 | 403 | 404 | 500);
      }
      return c.json({ error: { error: String(err), code: 'PERMISSION_DENIED' } } as { error: FsError }, 500);
    }
  });

  return app;
}

function codeToStatus(code: string): number {
  switch (code) {
    case 'NOT_FOUND': return 404;
    case 'PATH_TRAVERSAL': return 403;
    case 'WORKSPACE_NOT_SET': return 400;
    default: return 500;
  }
}

/**
 * PROP-135: выбор порта исполнения терминала (`server/app/terminal-port.ts`).
 *
 * Проверяется: терминал идёт на **тот же** порт, что и тулы сессии —
 * профиль по binding'у (сессия → агент → проект → дефолт), область пула
 * (`projectId`/`sessionId`) и `workspaceSubPath` (относительный путь рабочего
 * каталога внутри корня workspace'ов).
 */
import { describe, it, expect } from 'vitest';
import type { ExecutionRouter, ExecutionPortTarget } from '../../execution/router.js';
import type { ExecutionPort } from '../../execution/ports/index.js';
import { createTerminalPortResolver, resolveTerminalWorkspaceSubPath } from './terminal-port.js';

/** Порт-заглушка: терминалу нужен только сам факт выбора. */
const fakePort = { isRemote: false } as unknown as ExecutionPort;

/** Роутер-заглушка: запоминает цель выбора. */
function createRouter(
  options: { profiles?: string[]; defaultProfile?: string } = {},
): { router: ExecutionRouter; targets: ExecutionPortTarget[] } {
  const targets: ExecutionPortTarget[] = [];
  const router: ExecutionRouter = {
    portFor(target?: ExecutionPortTarget): ExecutionPort {
      if (target) targets.push(target);
      return fakePort;
    },
    // Каталог профилей инстанса: профиль вне каталога **не выбирается**
    // (fail-closed, как у хода сессии).
    profiles: () => options.profiles ?? [
      'default',
      'gpu',
      'project-profile',
      'agent-profile',
      'leader-profile',
    ],
    defaultProfile: () => options.defaultProfile ?? 'default',
  };
  return { router, targets };
}

describe('Резолвер порта терминала', () => {
  it('профиль сессии — приоритет над агентом и проектом', async () => {
    const { router, targets } = createRouter();
    const resolver = createTerminalPortResolver({
      router,
      sessions: {
        getSession: async () => ({
          settings: { executorProfile: 'gpu', agentRole: 'fixer' },
        }),
      },
      projects: { load: async () => ({ executor: { profile: 'default' } }) },
      agents: { get: () => ({ executorProfile: 'agent-profile' }) },
      workspacesRoot: '/ws',
    });

    await resolver({ projectId: 'proj-1', sessionId: 'sess-1', cwd: '/ws/proj-1' });

    expect(targets).toHaveLength(1);
    expect(targets[0]?.profile).toBe('gpu');
    expect(targets[0]?.projectId).toBe('proj-1');
    expect(targets[0]?.sessionId).toBe('sess-1');
    expect(targets[0]?.workspaceSubPath).toBe('proj-1');
  });

  it('без сессии — профиль проекта; область — только проект', async () => {
    const { router, targets } = createRouter();
    const resolver = createTerminalPortResolver({
      router,
      projects: { load: async () => ({ executor: { profile: 'project-profile' } }) },
      workspacesRoot: '/ws',
    });

    await resolver({ projectId: 'proj-2', cwd: '/ws/proj-2' });

    expect(targets[0]?.profile).toBe('project-profile');
    expect(targets[0]?.projectId).toBe('proj-2');
    expect(targets[0]?.sessionId).toBeUndefined();
    expect(targets[0]?.workspaceSubPath).toBe('proj-2');
  });

  it('профиль агента — когда у сессии и проекта профиля нет', async () => {
    const { router, targets } = createRouter();
    const resolver = createTerminalPortResolver({
      router,
      sessions: { getSession: async () => ({ settings: { agentRole: 'fixer' } }) },
      agents: { get: (role) => (role === 'fixer' ? { executorProfile: 'agent-profile' } : undefined) },
      workspacesRoot: '/ws',
    });

    await resolver({ projectId: 'proj-3', sessionId: 'sess-3', cwd: '/ws/proj-3' });

    expect(targets[0]?.profile).toBe('agent-profile');
  });

  it('прежняя роль агента резолвится алиасом (pm → leader)', async () => {
    const { router, targets } = createRouter();
    const resolver = createTerminalPortResolver({
      router,
      sessions: { getSession: async () => ({ settings: { agentRole: 'pm' } }) },
      agents: { get: (role) => (role === 'leader' ? { executorProfile: 'leader-profile' } : undefined) },
      workspacesRoot: '/ws',
    });

    await resolver({ projectId: 'proj-4', sessionId: 'sess-4', cwd: '/ws/proj-4' });

    expect(targets[0]?.profile).toBe('leader-profile');
  });

  it('потолок профилей проекта: запрещённый профиль не выбирается', async () => {
    const { router, targets } = createRouter({ profiles: ['default'], defaultProfile: 'default' });
    const resolver = createTerminalPortResolver({
      router,
      projects: {
        load: async () => ({ executor: { profile: 'gpu', allowedProfiles: ['default'] } }),
      },
      workspacesRoot: '/ws',
    });

    await resolver({ projectId: 'proj-5', cwd: '/ws/proj-5' });

    // `gpu` вне потолка → профиль по умолчанию.
    expect(targets[0]?.profile).toBe('default');
  });

  it('каталог рабочего каталога вне корня workspace — subPath не задаётся', async () => {
    const { router, targets } = createRouter();
    const resolver = createTerminalPortResolver({
      router,
      projects: { load: async () => null },
      workspacesRoot: '/ws',
    });

    await resolver({ projectId: 'proj-6', cwd: '/elsewhere/proj-6' });

    expect(targets[0]?.workspaceSubPath).toBeUndefined();
  });
});

describe('workspaceSubPath терминала', () => {
  it('путь внутри корня — относительный путь проекта', () => {
    expect(resolveTerminalWorkspaceSubPath('/ws', '/ws/proj-slug')).toBe('proj-slug');
  });

  it('каталог worktree — вложенный путь', () => {
    expect(resolveTerminalWorkspaceSubPath('/ws', '/ws/proj-slug/.worktrees/feature')).toBe(
      'proj-slug/.worktrees/feature',
    );
  });

  it('каталог вне корня — subPath не задаётся', () => {
    expect(resolveTerminalWorkspaceSubPath('/ws', '/elsewhere')).toBeUndefined();
  });

  it('корень workspace не задан — subPath не задаётся', () => {
    expect(resolveTerminalWorkspaceSubPath(undefined, '/ws/proj')).toBeUndefined();
  });
});

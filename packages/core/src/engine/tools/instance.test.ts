import { describe, it, expect, beforeEach, vi } from 'vitest';
import { generateId, ToolCapability, type McpRegistryEntry, type McpServerEffective, type Project, type Session, type ToolContext } from '@itphx/synth-shared';
import { synthInfoTool, synthMcpListTool, synthMcpTestTool } from './instance.js';
import type { McpRegistryRepository } from '../../storage/ports/mcp-registry-repository.js';
import type { ProjectStoreContract } from '../../storage/project-store.js';
import type { SessionManager } from '../../sessions/manager.js';
import type { McpManager } from '../mcp/manager.js';
import type { AgentRegistry } from '../agents/registry.js';
import type { InstanceRuntimeMeta } from '../instance/meta.js';

function makeCtx(extra: Record<string, unknown>): ToolContext {
  return {
    sessionId: 's1',
    messageId: generateId(),
    abortSignal: new AbortController().signal,
    workingDir: '/work',
    dataDir: '/data',
    extra,
  };
}

function registryEntry(partial: Partial<McpRegistryEntry> & Pick<McpRegistryEntry, 'name'>): McpRegistryEntry {
  const { name, ...rest } = partial;
  return {
    schemaVersion: 1,
    id: `mcp_${name}`,
    config: { type: 'http', url: 'http://127.0.0.1:3000/mcp' },
    origin: 'user',
    author: null,
    trust: 'community',
    enabled: true,
    enabledByDefault: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    name,
    ...rest,
  };
}

const meta: InstanceRuntimeMeta = {
  mode: 'standalone',
  server: { port: 5000 },
  auth: {
    mode: 'api-key',
    localKeyPresent: true,
    apiKeyConfigured: true,
    oidcEnabled: false,
    debug: false,
  },
  storage: { backend: 'file', degraded: false },
  features: { mcp: true, metrics: false, memory: true, restartMode: 'supervisor' },
};

describe('synth_info (Workstream A1)', () => {
  it('отдаёт версию/режим/auth-флаги/счётчики и не тянет секреты', async () => {
    const registry = {
      list: vi.fn().mockResolvedValue([
        registryEntry({ name: 'a' }),
        registryEntry({ name: 'b' }),
      ]),
    } as unknown as McpRegistryRepository;
    const manager = {
      getServerStatus: vi.fn((name: string) => (name === 'a' ? 'connected' : 'disconnected')),
    } as unknown as McpManager;
    const projectStore = {
      list: vi.fn().mockResolvedValue([{ id: 'p1' }, { id: 'p2' }]),
    } as unknown as ProjectStoreContract;
    const sessionManager = {
      listSessions: vi.fn().mockResolvedValue([{ id: 's1' }, { id: 's2' }, { id: 's3' }]),
    } as unknown as SessionManager;
    const agentRegistry = { list: vi.fn().mockReturnValue([{ id: 'assistant' }]) } as unknown as AgentRegistry;

    const result = await synthInfoTool.execute({}, makeCtx({
      instanceMeta: meta,
      mcpRegistry: registry,
      mcpManager: manager,
      projectStore,
      sessionManager,
      listModels: async () => [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }, { id: 'm4' }],
      agentRegistry,
      workspacesRoot: '/workspaces',
    }));

    expect(result.isError).toBeUndefined();
    expect(result.metadata?.version).toBeTruthy();
    expect(result.metadata?.mode).toBe('standalone');
    expect(result.metadata?.data_dir).toBe('/data');
    expect(result.metadata?.working_dir).toBe('/work');
    expect(result.metadata?.workspaces_root).toBe('/workspaces');
    expect(result.metadata?.auth).toEqual({
      mode: 'api-key',
      localKeyPresent: true,
      apiKeyConfigured: true,
      oidcEnabled: false,
      debug: false,
    });
    expect(result.metadata?.counts).toEqual({
      mcp_servers: 2,
      mcp_connected: 1,
      projects: 2,
      sessions: 3,
      models: 4,
      agents: 1,
    });
    expect(result.metadata?.warnings).toEqual([]);
    expect(result.metadata).not.toHaveProperty('apiKey');
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('считает только видимые проекты/сессии (не всего инстанса)', async () => {
    const projectList = vi.fn().mockResolvedValue([{ id: 'p1' }, { id: 'p2' }]);
    const sessionList = vi.fn().mockResolvedValue([{ id: 's1' }]);
    const result = await synthInfoTool.execute({}, makeCtx({
      instanceMeta: meta,
      projectStore: { list: projectList } as unknown as ProjectStoreContract,
      sessionManager: { listSessions: sessionList } as unknown as SessionManager,
      principal: { userId: 'u1', roles: ['USER'] },
      isElevatedPrincipal: false,
    }));

    expect((result.metadata?.counts as Record<string, unknown>).projects).toBe(2);
    expect((result.metadata?.counts as Record<string, unknown>).sessions).toBe(1);
    // Не-elevated: проекты — свои/участия, сессии — свои + сессии этих проектов.
    expect(projectList).toHaveBeenCalledWith('u1');
    expect(sessionList).toHaveBeenCalledWith({ userId: 'u1', projectIds: ['p1', 'p2'] });
  });

  it('ошибки счётчиков не валят тул: null + warning', async () => {    const registry = { list: vi.fn().mockRejectedValue(new Error('registry down')) } as unknown as McpRegistryRepository;
    const projectStore = { list: vi.fn().mockRejectedValue(new Error('storage down')) } as unknown as ProjectStoreContract;
    const sessionManager = { listSessions: vi.fn().mockRejectedValue(new Error('down')) } as unknown as SessionManager;

    const result = await synthInfoTool.execute({}, makeCtx({
      instanceMeta: meta,
      mcpRegistry: registry,
      projectStore,
      sessionManager,
      listModels: async () => { throw new Error('models down'); },
    }));

    expect(result.isError).toBeUndefined();
    const counts = result.metadata?.counts as Record<string, unknown>;
    expect(counts.mcp_servers).toBeNull();
    expect(counts.mcp_connected).toBeNull();
    expect(counts.projects).toBeNull();
    expect(counts.sessions).toBeNull();
    expect(counts.models).toBeNull();
    expect(result.metadata?.warnings).toEqual(expect.arrayContaining([
      'mcp_registry_unavailable',
      'mcp_manager_unavailable',
      'projects_unavailable',
      'sessions_unavailable',
      'models_unavailable',
    ]));
  });
});

describe('synth_mcp_list (Workstream A1)', () => {
  let session: Session;
  let project: Project;

  beforeEach(() => {
    session = {
      id: 's1',
      projectId: 'p1',
      mcpServers: ['user-http'],
      settings: { mcpDisabledServers: ['inst-stdio'], mcpDefaultOn: ['user-http'] },
    } as unknown as Session;
    project = {
      id: 'p1',
      name: 'Project',
      mcp: { enabled: ['user-http'], defaultOn: ['user-http'] },
    } as unknown as Project;
  });

  function deps(
    policy: { mode: 'allow' | 'deny'; list: string[]; exceptions: string[] },
    opts?: {
      entries?: McpRegistryEntry[];
      effective?: McpServerEffective[];
      principal?: { userId: string; roles: string[] };
    },
  ) {
    const registry = {
      list: vi.fn().mockResolvedValue(opts?.entries ?? [
        registryEntry({
          name: 'user-http',
          origin: 'user',
          config: {
            type: 'http',
            url: 'http://127.0.0.1:3000/mcp',
            headers: { authorization: 'Bearer SECRET-HEADER' },
            env: { TOKEN: 'SECRET-ENV' },
          },
          trust: 'community',
          enabledByDefault: true,
        }),
        registryEntry({
          name: 'inst-stdio',
          origin: 'instance',
          config: {
            type: 'stdio',
            command: 'npx',
            args: ['-y', 'some-mcp'],
            env: { SECRET_ENV: 'SECRET-VALUE' },
          },
          trust: 'builtin',
          enabled: false,
        }),
      ]),
    } as unknown as McpRegistryRepository;

    const manager = {
      getServerStatus: vi.fn((name: string) => (name === 'user-http' ? 'connected' : 'disconnected')),
      getServerTools: vi.fn((name: string) => (name === 'user-http'
        ? [{ name: 'search', description: 'Search', inputSchema: {} }]
        : null)),
      getServerError: vi.fn(() => undefined),
    } as unknown as McpManager;

    const sessionManager = {
      getSession: vi.fn().mockResolvedValue(session),
    } as unknown as SessionManager;
    const projectStore = {
      load: vi.fn().mockResolvedValue(project),
    } as unknown as ProjectStoreContract;

    return makeCtx({
      mcpRegistry: registry,
      mcpManager: manager,
      sessionManager,
      projectStore,
      resolveMcpServers: async () => opts?.effective ?? [
        { name: 'user-http', level: 'session', enabled: true, origin: 'user', trust: 'community', status: 'connected' },
        { name: 'inst-stdio', level: 'system', enabled: false, reason: 'system_disabled', origin: 'instance', trust: 'builtin' },
      ],
      getMcpNetworkPolicy: async () => policy,
      ...(opts?.principal
        ? {
            principal: opts.principal,
            isElevatedPrincipal: opts.principal.roles.some(
              (role) => role === 'ADMIN' || role === 'LEAD',
            ),
          }
        : {}),
    });
  }

  it('отдаёт серверы, статусы, scope, причину и policy без env/headers', async () => {
    const result = await synthMcpListTool.execute({}, deps({ mode: 'deny', list: ['127.0.0.0/8'], exceptions: [] }));
    expect(result.isError).toBeUndefined();

    const servers = result.metadata?.servers as Array<Record<string, unknown>>;
    expect(servers).toHaveLength(2);

    const http = servers.find((server) => server.name === 'user-http')!;
    expect(http.status).toBe('connected');
    expect(http.connected).toBe(true);
    expect(http.origin).toBe('user');
    expect(http.enabled_by_default).toBe(true);
    expect(http.url).toBe('http://127.0.0.1:3000/mcp');
    expect(http.effective).toMatchObject({ enabled: true, level: 'session' });
    expect(http.policy).toMatchObject({ allowed: false });
    expect((http.tools as Record<string, unknown>).names).toEqual(['search']);

    const stdio = servers.find((server) => server.name === 'inst-stdio')!;
    expect(stdio.status).toBe('disabled');
    expect(stdio.effective).toMatchObject({ enabled: false, reason: 'system_disabled' });
    expect(stdio.policy).toBeNull();
    expect(stdio.command).toBe('npx');

    expect(result.metadata?.project).toMatchObject({
      id: 'p1',
      name: 'Project',
      mcp: { enabled: ['user-http'], defaultOn: ['user-http'] },
    });
    expect(result.metadata?.session).toMatchObject({
      id: 's1',
      mcpServers: ['user-http'],
      mcpDisabledServers: ['inst-stdio'],
      mcpDefaultOn: ['user-http'],
    });
    expect(result.metadata?.policy).toMatchObject({ mode: 'deny' });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('SECRET-HEADER');
    expect(serialized).not.toContain('SECRET-ENV');
    expect(serialized).not.toContain('SECRET-VALUE');
    expect(serialized).not.toContain('"headers"');
    expect(serialized).not.toContain('"env"');
  });

  it('policy allow разрешает адрес', async () => {
    const result = await synthMcpListTool.execute({}, deps({ mode: 'allow', list: ['127.0.0.0/8'], exceptions: [] }));
    const servers = result.metadata?.servers as Array<Record<string, unknown>>;
    const http = servers.find((server) => server.name === 'user-http')!;
    expect(http.policy).toMatchObject({ allowed: true });
  });

  it('чужая user-запись, не включённая в сессию, не видна', async () => {
    const other = registryEntry({
      name: 'other-user',
      origin: 'user',
      author: { userId: 'u2', username: 'bob' },
    });
    const result = await synthMcpListTool.execute({}, deps(
      { mode: 'deny', list: [], exceptions: [] },
      { entries: [other], effective: [], principal: { userId: 'u1', roles: ['USER'] } },
    ));
    const servers = result.metadata?.servers as unknown[];
    expect(servers).toHaveLength(0);
  });

  it('чужая user-запись видна, если включена в эффективный набор', async () => {
    const other = registryEntry({
      name: 'other-user',
      origin: 'user',
      author: { userId: 'u2', username: 'bob' },
    });
    const effective: McpServerEffective[] = [
      { name: 'other-user', level: 'session', enabled: true, origin: 'user', trust: 'community' },
    ];
    const result = await synthMcpListTool.execute({}, deps(
      { mode: 'deny', list: [], exceptions: [] },
      { entries: [other], effective, principal: { userId: 'u1', roles: ['USER'] } },
    ));
    const servers = result.metadata?.servers as Array<Record<string, unknown>>;
    expect(servers.map((server) => server.name)).toEqual(['other-user']);
  });

  it('disabled чужая user-запись в effective не делает её видимой', async () => {
    const other = registryEntry({
      name: 'disabled-other',
      origin: 'user',
      author: { userId: 'u2', username: 'bob' },
    });
    const effective: McpServerEffective[] = [
      { name: 'disabled-other', level: 'session', enabled: false, reason: 'not_default', origin: 'user', trust: 'community' },
    ];
    const result = await synthMcpListTool.execute({}, deps(
      { mode: 'deny', list: [], exceptions: [] },
      { entries: [other], effective, principal: { userId: 'u1', roles: ['USER'] } },
    ));
    expect(result.metadata?.servers).toEqual([]);
  });

  it('URL редактируется: нет user:pass и значений секретных query-параметров', async () => {
    const entry = registryEntry({
      name: 'user-http',
      origin: 'user',
      config: {
        type: 'http',
        url: 'http://user:pass@127.0.0.1:3000/mcp?token=SECRET&mode=1&api_key=ALSO-SECRET',
      },
    });
    const effective: McpServerEffective[] = [
      { name: 'user-http', level: 'session', enabled: true, origin: 'user', trust: 'community' },
    ];
    const result = await synthMcpListTool.execute({}, deps(
      { mode: 'allow', list: ['127.0.0.0/8'], exceptions: [] },
      { entries: [entry], effective, principal: { userId: 'u1', roles: ['USER'] } },
    ));
    const servers = result.metadata?.servers as Array<Record<string, unknown>>;
    const url = String(servers[0]?.url ?? '');
    expect(url).not.toContain('user:pass');
    expect(url).not.toContain('SECRET');
    expect(url).toContain('***');
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it('нет реестра/менеджера — понятная ошибка зависимостей', async () => {
    const result = await synthMcpListTool.execute({}, makeCtx({}));
    expect(result.isError).toBe(true);
    expect(result.metadata?.i18n).toMatchObject({ key: 'instance.deps_unavailable' });
  });
});

describe('synth_mcp_test (Workstream A1)', () => {
  it('ok: возвращает инструменты, ничего не регистрируя', async () => {
    const manager = {
      getServerConfig: vi.fn(() => ({ type: 'stdio', command: 'npx' })),
      probeServer: vi.fn().mockResolvedValue([
        { name: 'tool1', description: 'First', inputSchema: {} },
        { name: 'tool2', description: '', inputSchema: {} },
      ]),
    } as unknown as McpManager;

    const result = await synthMcpTestTool.execute({ name: 'srv' }, makeCtx({ mcpManager: manager }));
    expect(result.isError).toBeUndefined();
    expect(result.metadata?.ok).toBe(true);
    expect(result.metadata?.tools).toEqual([
      { name: 'tool1', description: 'First' },
      { name: 'tool2' },
    ]);
    expect(manager.probeServer).toHaveBeenCalledWith('srv');
  });

  it('error/timeout: ошибка текстом, не бросается', async () => {
    const manager = {
      getServerConfig: vi.fn(() => ({ type: 'http', url: 'http://127.0.0.1:3000' })),
      probeServer: vi.fn().mockRejectedValue(new Error('timeout')),
    } as unknown as McpManager;

    const result = await synthMcpTestTool.execute({ name: 'srv' }, makeCtx({ mcpManager: manager }));
    expect(result.isError).toBe(true);
    expect(result.metadata?.ok).toBe(false);
    expect(result.metadata?.error).toBe('timeout');
    expect(result.content).toContain('timeout');
  });

  it('невидимая чужая запись: not found, без пробы и раскрытия имени', async () => {
    const manager = {
      getServerConfig: vi.fn(() => ({ type: 'http', url: 'http://127.0.0.1:3000' })),
      probeServer: vi.fn(),
    } as unknown as McpManager;
    const registry = {
      list: vi.fn().mockResolvedValue([
        registryEntry({
          name: 'secret-server',
          origin: 'user',
          author: { userId: 'u2', username: 'bob' },
        }),
      ]),
    } as unknown as McpRegistryRepository;

    const result = await synthMcpTestTool.execute({ name: 'secret-server' }, makeCtx({
      mcpManager: manager,
      mcpRegistry: registry,
      principal: { userId: 'u1', roles: ['USER'] },
      isElevatedPrincipal: false,
      resolveMcpServers: async () => [
        { name: 'secret-server', level: 'session', enabled: false, reason: 'not_default', origin: 'user', trust: 'community' },
      ],
    }));
    expect(result.isError).toBe(true);
    expect(result.metadata?.ok).toBe(false);
    expect(result.metadata?.i18n).toMatchObject({ key: 'instance.mcp_not_found' });
    expect(manager.probeServer).not.toHaveBeenCalled();
  });

  it('не настроен: перечисляет доступные имена', async () => {
    const manager = {
      getServerConfig: vi.fn(() => undefined),
      probeServer: vi.fn(),
    } as unknown as McpManager;
    const registry = {
      list: vi.fn().mockResolvedValue([
        registryEntry({ name: 'one', origin: 'instance' }),
        registryEntry({ name: 'two', origin: 'instance' }),
      ]),
    } as unknown as McpRegistryRepository;

    const result = await synthMcpTestTool.execute({ name: 'missing' }, makeCtx({
      mcpManager: manager,
      mcpRegistry: registry,
    }));
    expect(result.isError).toBe(true);
    expect(result.content).toContain('one, two');
    expect(result.metadata?.ok).toBe(false);
  });
});

describe('instance tools — capability/group', () => {
  it('read-тулы объявлены как INSTANCE', () => {
    for (const tool of [synthInfoTool, synthMcpListTool, synthMcpTestTool]) {
      expect(tool.capabilities).toContain(ToolCapability.INSTANCE);
    }
  });
});

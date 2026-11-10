import { describe, it, expect, vi } from 'vitest';
import { generateId, ProjectRole, type McpRegistryEntry, type McpServerConfig, type Project, type Session, type ToolContext } from '@itphx/synth-shared';
import {
  synthMcpAddTool,
  synthMcpUpdateTool,
  synthMcpRemoveTool,
  synthMcpEnableTool,
  synthMcpReconnectTool,
} from './instance-mcp.js';
import type { ProjectStoreContract } from '../../storage/project-store.js';
import type { SessionManager } from '../../sessions/manager.js';
import type { McpManager } from '../mcp/manager.js';
import type { EventBus } from '../../events/bus.js';
import type { ToolRegistry } from './registry.js';

interface FakeRegistry {
  entries: McpRegistryEntry[];
  list: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  getByName: ReturnType<typeof vi.fn>;
  add: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  toManagerMaps: ReturnType<typeof vi.fn>;
}

function makeEntry(
  partial: Partial<McpRegistryEntry> & Pick<McpRegistryEntry, 'name'>,
): McpRegistryEntry {
  const { name, ...rest } = partial;
  return {
    schemaVersion: 1,
    id: `mcp_${name}`,
    name,
    config: { type: 'http', url: 'https://93.184.216.34/mcp' },
    origin: 'user',
    author: { userId: 'u1', username: 'u1' },
    trust: 'community',
    enabled: true,
    enabledByDefault: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...rest,
  };
}

function makeRegistry(entries: McpRegistryEntry[] = []): FakeRegistry {
  const reg = {
    entries,
    list: vi.fn(async () => [...reg.entries]),
    get: vi.fn(async (id: string) => reg.entries.find((entry) => entry.id === id) ?? null),
    getByName: vi.fn(async (name: string) => reg.entries.find((entry) => entry.name === name) ?? null),
    add: vi.fn(async (input: {
      name: string;
      config: McpServerConfig;
      origin: 'instance' | 'user';
      author?: { userId: string; username: string } | null;
      trust?: 'builtin' | 'community';
      enabled?: boolean;
      enabledByDefault?: boolean;
    }) => {
      const entry = makeEntry({
        id: `mcp_${input.name}`,
        name: input.name,
        config: input.config,
        origin: input.origin,
        author: input.author ?? null,
        trust: input.trust ?? 'community',
        enabled: input.enabled ?? true,
        enabledByDefault: input.enabledByDefault ?? false,
      });
      reg.entries.push(entry);
      return entry;
    }),
    update: vi.fn(async (id: string, patch: Record<string, unknown>) => {
      const index = reg.entries.findIndex((entry) => entry.id === id);
      if (index === -1) return null;
      const updated = { ...reg.entries[index]!, ...patch } as McpRegistryEntry;
      reg.entries[index] = updated;
      return updated;
    }),
    remove: vi.fn(async (id: string) => {
      const index = reg.entries.findIndex((entry) => entry.id === id);
      if (index === -1) return false;
      reg.entries.splice(index, 1);
      return true;
    }),
    seedFromConfig: vi.fn(async () => 0),
    toServerConfigMap: vi.fn(async () => ({})),
    toOriginMap: vi.fn(async () => ({})),
    toTrustMap: vi.fn(async () => ({})),
    toAuthorMap: vi.fn(async () => ({})),
    toDefaultServers: vi.fn(async () => []),
    toManagerMaps: vi.fn(async () => ({
      servers: Object.fromEntries(reg.entries.map((entry) => [entry.name, entry.config])),
      origins: {},
      trusts: {},
      authors: {},
      systemEnabled: {},
      defaults: [],
    })),
  } as unknown as FakeRegistry;
  return reg;
}

function makeManager(status: 'connected' | 'error' | 'circuit-open' | 'disconnected' = 'connected') {
  return {
    disconnectServer: vi.fn(async () => {}),
    connectServer: vi.fn(async () => {}),
    refreshServer: vi.fn(async () => {}),
    getServerConfig: vi.fn((name: string) => ({ type: 'http', url: 'https://93.184.216.34/mcp', name })),
    getServerStatus: vi.fn(() => status),
    getServerTools: vi.fn(() => [{ name: 'search', description: 'Search', inputSchema: {} }]),
    getServerError: vi.fn(() => undefined),
    setConfig: vi.fn(),
    setServerOrigins: vi.fn(),
    setServerTrusts: vi.fn(),
    setServerAuthors: vi.fn(),
    setDefaultServers: vi.fn(),
    setServerSystemEnabled: vi.fn(),
  } as unknown as McpManager;
}

function makeCtx(opts: {
  registry?: FakeRegistry;
  manager?: McpManager;
  session?: Session;
  project?: Project;
  principal?: { userId: string; roles: string[] };
  eventBus?: EventBus;
  toolRegistry?: ToolRegistry;
  resolveMcpServersFor?: (session: Session) => Promise<Array<Record<string, unknown>>>;
}) {
  const session = opts.session;
  const sessionManager = {
    getSession: vi.fn(async () => session ?? null),
    withLock: vi.fn(async (_id: string, fn: (s: Session) => Promise<unknown>) => {
      if (!session) throw new Error('not found');
      return fn(session);
    }),
    saveSession: vi.fn(async () => {}),
  } as unknown as SessionManager;
  const projectStore = {
    load: vi.fn(async () => opts.project ?? null),
    mutate: vi.fn(async (_id: string, fn: (p: Project) => void) => {
      if (opts.project) fn(opts.project);
      return opts.project ?? null;
    }),
  } as unknown as ProjectStoreContract;
  const principal = opts.principal ?? { userId: 'u1', roles: ['USER'] };
  return {
    sessionId: 's1',
    messageId: generateId(),
    abortSignal: new AbortController().signal,
    workingDir: '/work',
    dataDir: '/data',
    extra: {
      mcpRegistry: opts.registry,
      mcpManager: opts.manager,
      sessionManager,
      projectStore,
      sessionId: 's1',
      principal,
      isElevatedPrincipal: principal.roles.some((role) => role === 'ADMIN' || role === 'LEAD'),
      eventBus: opts.eventBus,
      toolRegistry: opts.toolRegistry,
      getMcpNetworkPolicy: async () => ({
        mode: 'deny' as const,
        list: ['127.0.0.0/8', '10.0.0.0/8'],
        exceptions: [],
      }),
      resolveMcpServersFor: opts.resolveMcpServersFor
        ?? (async () => [
          { name: 'srv', level: 'session', enabled: true, origin: 'user', trust: 'community' },
        ]),
    },
  } as unknown as ToolContext;
}

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 's1',
    userId: 'u1',
    ownerId: 'u1',
    projectId: 'p1',
    settings: {},
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as unknown as Session;
}

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'Project',
    ownerId: 'u1',
    members: { u1: ProjectRole.OWNER },
    mcp: { enabled: [], defaultOn: [] },
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as unknown as Project;
}

const httpConfig: McpServerConfig = { type: 'http', url: 'https://93.184.216.34/mcp' };

describe('synth_mcp_add (Workstream A2)', () => {
  it('origin instance и stdio — только elevated', async () => {
    const registry = makeRegistry();
    const instance = await synthMcpAddTool.execute(
      { name: 'srv', config: httpConfig, origin: 'instance' },
      makeCtx({ registry, manager: makeManager() }),
    );
    expect(instance.isError).toBe(true);
    expect(instance.metadata?.i18n).toMatchObject({ key: 'instance.mcp.instance_forbidden' });

    const stdio = await synthMcpAddTool.execute(
      { name: 'srv', config: { type: 'stdio', command: 'npx' } },
      makeCtx({ registry, manager: makeManager() }),
    );
    expect(stdio.isError).toBe(true);
    expect(stdio.metadata?.i18n).toMatchObject({ key: 'instance.mcp.instance_forbidden' });
    expect(registry.add).not.toHaveBeenCalled();
  });

  it('user HTTP + policy deny → ошибка сети', async () => {
    const result = await synthMcpAddTool.execute(
      { name: 'srv', config: { type: 'http', url: 'http://127.0.0.1:3000/mcp' } },
      makeCtx({ registry: makeRegistry(), manager: makeManager() }),
    );
    expect(result.isError).toBe(true);
    expect(result.metadata?.i18n).toMatchObject({ key: 'instance.mcp.network_denied' });
  });

  it('plaintext secret header и credential auth запрещены', async () => {
    const registry = makeRegistry();
    const header = await synthMcpAddTool.execute(
      { name: 'srv', config: { type: 'http', url: 'https://93.184.216.34/mcp', headers: { authorization: 'Bearer SECRET' } } },
      makeCtx({ registry, manager: makeManager() }),
    );
    expect(header.isError).toBe(true);
    expect(header.metadata?.i18n).toMatchObject({ key: 'instance.mcp.secret_header' });

    const credential = await synthMcpAddTool.execute(
      { name: 'srv', config: { type: 'http', url: 'https://93.184.216.34/mcp', auth: { kind: 'credential', credentialId: 'c1' } } },
      makeCtx({ registry, manager: makeManager() }),
    );
    expect(credential.isError).toBe(true);
    expect(credential.metadata?.i18n).toMatchObject({ key: 'instance.mcp.credential_unsupported' });
    expect(registry.add).not.toHaveBeenCalled();
  });

  it('успех: registry.add + sync, сервер не включён в сессию', async () => {
    const registry = makeRegistry();
    const manager = makeManager();
    const result = await synthMcpAddTool.execute(
      { name: 'srv', config: httpConfig },
      makeCtx({ registry, manager }),
    );
    expect(result.isError).toBeUndefined();
    expect(registry.add).toHaveBeenCalledWith(expect.objectContaining({
      name: 'srv',
      origin: 'user',
      trust: 'community',
      author: { userId: 'u1', username: 'u1' },
      enabled: true,
      enabledByDefault: false,
    }));
    expect((manager as unknown as { setConfig: ReturnType<typeof vi.fn> }).setConfig).toHaveBeenCalled();
    expect(result.metadata).toMatchObject({
      name: 'srv',
      origin: 'user',
      enabled: true,
      enabled_by_default: false,
      enabled_for_session: false,
    });
  });
});

describe('synth_mcp_update / synth_mcp_remove (Workstream A2)', () => {
  it('автор может обновить, чужой — нет, elevated — может', async () => {
    const entry = makeEntry({ name: 'srv', author: { userId: 'u1', username: 'u1' } });
    const registry = makeRegistry([entry]);
    const author = await synthMcpUpdateTool.execute(
      { name: 'srv', enabled: false },
      makeCtx({ registry, manager: makeManager() }),
    );
    expect(author.isError).toBeUndefined();
    expect(registry.update).toHaveBeenCalled();

    const foreign = await synthMcpUpdateTool.execute(
      { name: 'srv', enabled: true },
      makeCtx({ registry, manager: makeManager(), principal: { userId: 'u2', roles: ['USER'] } }),
    );
    expect(foreign.isError).toBe(true);
    expect(foreign.metadata?.i18n).toMatchObject({ key: 'instance.mcp.forbidden' });

    const elevated = await synthMcpUpdateTool.execute(
      { name: 'srv', enabled: true },
      makeCtx({ registry, manager: makeManager(), principal: { userId: 'admin', roles: ['ADMIN'] } }),
    );
    expect(elevated.isError).toBeUndefined();
  });

  it('non-elevated не может обновить config до stdio (RCE)', async () => {
    const entry = makeEntry({ name: 'srv', author: { userId: 'u1', username: 'u1' } });
    const registry = makeRegistry([entry]);
    const result = await synthMcpUpdateTool.execute(
      { name: 'srv', config: { type: 'stdio', command: 'sh' } },
      makeCtx({ registry, manager: makeManager() }),
    );
    expect(result.isError).toBe(true);
    expect(result.metadata?.i18n).toMatchObject({ key: 'instance.mcp.instance_forbidden' });
    expect(registry.update).not.toHaveBeenCalled();
  });

  it('config validation при update', async () => {    const entry = makeEntry({ name: 'srv' });
    const registry = makeRegistry([entry]);
    const result = await synthMcpUpdateTool.execute(
      { name: 'srv', config: { type: 'http', url: 'https://93.184.216.34/mcp', headers: { 'x-api-key': 'SECRET' } } },
      makeCtx({ registry, manager: makeManager() }),
    );
    expect(result.isError).toBe(true);
    expect(result.metadata?.i18n).toMatchObject({ key: 'instance.mcp.secret_header' });
    expect(registry.update).not.toHaveBeenCalled();
  });

  it('remove: disconnect + remove + sync; чужой — запрещено', async () => {
    const entry = makeEntry({ name: 'srv', author: { userId: 'u1', username: 'u1' } });
    const registry = makeRegistry([entry]);
    const manager = makeManager();
    const result = await synthMcpRemoveTool.execute(
      { name: 'srv' },
      makeCtx({ registry, manager }),
    );
    expect(result.isError).toBeUndefined();
    expect(manager.disconnectServer).toHaveBeenCalledWith('srv');
    expect(registry.remove).toHaveBeenCalledWith('mcp_srv');

    const foreignRegistry = makeRegistry([entry]);
    const foreign = await synthMcpRemoveTool.execute(
      { name: 'srv' },
      makeCtx({ registry: foreignRegistry, manager: makeManager(), principal: { userId: 'u2', roles: ['USER'] } }),
    );
    expect(foreign.isError).toBe(true);
    expect(foreign.metadata?.i18n).toMatchObject({ key: 'instance.mcp.forbidden' });
    expect(foreignRegistry.remove).not.toHaveBeenCalled();
  });
});

describe('synth_mcp_enable (Workstream A2)', () => {
  it('session: server in settings, disabled removed, session.updated published', async () => {
    const entry = makeEntry({ name: 'srv' });
    const registry = makeRegistry([entry]);
    const current = session({
      settings: { mcpServers: [], mcpDisabledServers: ['srv'] } as unknown as Session['settings'],
    });
    const eventBus = { publish: vi.fn() } as unknown as EventBus;

    const result = await synthMcpEnableTool.execute(
      { name: 'srv', enabled: true, level: 'session' },
      makeCtx({ registry, manager: makeManager(), session: current, eventBus }),
    );
    expect(result.isError).toBeUndefined();
    expect(current.settings.mcpServers).toEqual(['srv']);
    expect(current.settings.mcpDisabledServers).toEqual([]);
    expect(eventBus.publish).toHaveBeenCalledWith('s1', 'session.updated', expect.objectContaining({
      session_id: 's1',
      settings: current.settings,
    }));
    expect(result.metadata?.effective).toMatchObject({ enabled: true, level: 'session' });
  });

  it('session: чужой участник не меняет настройки (session_forbidden)', async () => {
    const entry = makeEntry({ name: 'srv', author: { userId: 'u1', username: 'u1' } });
    const registry = makeRegistry([entry]);
    const current = session({
      userId: 'u2',
      ownerId: 'u2',
      settings: { mcpServers: [], mcpDisabledServers: [] } as unknown as Session['settings'],
    });
    const eventBus = { publish: vi.fn() } as unknown as EventBus;

    const result = await synthMcpEnableTool.execute(
      { name: 'srv', enabled: true, level: 'session' },
      makeCtx({
        registry,
        manager: makeManager(),
        session: current,
        eventBus,
        principal: { userId: 'u1', roles: ['USER'] },
      }),
    );
    expect(result.isError).toBe(true);
    expect(result.metadata?.i18n).toMatchObject({ key: 'instance.mcp_enable.session_forbidden' });
    expect(current.settings.mcpServers).toEqual([]);
    expect(current.settings.mcpDisabledServers).toEqual([]);
    expect(eventBus.publish).not.toHaveBeenCalled();
  });

  it('project: enabled/defaultOn + project.updated, VIEWER запрещён', async () => {
    const entry = makeEntry({ name: 'srv' });
    const registry = makeRegistry([entry]);
    const currentProject = project();
    const eventBus = { publish: vi.fn() } as unknown as EventBus;
    const result = await synthMcpEnableTool.execute(
      { name: 'srv', enabled: true, level: 'project' },
      makeCtx({ registry, manager: makeManager(), session: session(), project: currentProject, eventBus }),
    );
    expect(result.isError).toBeUndefined();
    expect(currentProject.mcp).toEqual({ enabled: ['srv'], defaultOn: ['srv'] });
    expect(eventBus.publish).toHaveBeenCalledWith('s1', 'project.updated', { project_id: 'p1' });

    const viewerProject = project({
      ownerId: 'u2',
      members: { u2: ProjectRole.OWNER, u1: ProjectRole.VIEWER },
    });
    const forbidden = await synthMcpEnableTool.execute(
      { name: 'srv', enabled: true, level: 'project' },
      makeCtx({ registry, manager: makeManager(), session: session(), project: viewerProject }),
    );
    expect(forbidden.isError).toBe(true);
    expect(forbidden.metadata?.i18n).toMatchObject({ key: 'instance.mcp.project_forbidden' });
  });

  it('instance: только elevated + sync', async () => {
    const entry = makeEntry({ name: 'srv', origin: 'instance' });
    const registry = makeRegistry([entry]);
    const manager = makeManager();
    const forbidden = await synthMcpEnableTool.execute(
      { name: 'srv', enabled: false, level: 'instance' },
      makeCtx({ registry, manager, session: session() }),
    );
    expect(forbidden.isError).toBe(true);
    expect(forbidden.metadata?.i18n).toMatchObject({ key: 'instance.mcp.instance_forbidden' });

    const allowed = await synthMcpEnableTool.execute(
      { name: 'srv', enabled: false, level: 'instance' },
      makeCtx({ registry, manager, session: session(), principal: { userId: 'admin', roles: ['ADMIN'] } }),
    );
    expect(allowed.isError).toBeUndefined();
    expect(registry.update).toHaveBeenCalledWith('mcp_srv', { enabled: false });
    expect((manager as unknown as { setConfig: ReturnType<typeof vi.fn> }).setConfig).toHaveBeenCalled();
  });
});

describe('synth_mcp_reconnect (Workstream A2)', () => {
  it('refreshServer вызван, статус connected → ok с инструментами', async () => {
    const manager = makeManager('connected');
    const toolRegistry = {} as ToolRegistry;
    const result = await synthMcpReconnectTool.execute(
      { name: 'srv' },
      makeCtx({ manager, toolRegistry, session: session() }),
    );
    expect(result.isError).toBeUndefined();
    expect(manager.refreshServer).toHaveBeenCalledWith('srv', toolRegistry);
    expect(result.metadata).toMatchObject({
      status: 'connected',
      connected: true,
      tools: { count: 1, names: ['search'] },
    });
  });

  it('невидимая чужая запись → not found, refreshServer не вызывается', async () => {
    const entry = makeEntry({ name: 'srv', author: { userId: 'u2', username: 'bob' } });
    const registry = makeRegistry([entry]);
    const manager = makeManager('connected');
    const result = await synthMcpReconnectTool.execute(
      { name: 'srv' },
      makeCtx({ registry, manager, toolRegistry: {} as ToolRegistry, session: session() }),
    );
    expect(result.isError).toBe(true);
    expect(result.metadata?.i18n).toMatchObject({ key: 'instance.mcp_not_found' });
    expect(manager.refreshServer).not.toHaveBeenCalled();
  });

  it('статус error → isError с причиной', async () => {
    const manager = makeManager('error');
    const result = await synthMcpReconnectTool.execute(
      { name: 'srv' },
      makeCtx({ manager, toolRegistry: {} as ToolRegistry, session: session() }),
    );
    expect(result.isError).toBe(true);
    expect(result.metadata).toMatchObject({ status: 'error', connected: false });
    expect(result.metadata?.error).toBe('error');
  });
});

describe('write-тулы MCP не возвращают секреты', () => {
  it('env/headers не попадают в ответ add', async () => {
    const registry = makeRegistry();
    const result = await synthMcpAddTool.execute(
      {
        name: 'srv',
        config: { type: 'http', url: 'https://93.184.216.34/mcp', env: { SECRET_ENV: 'SECRET-VALUE' } },
      },
      makeCtx({ registry, manager: makeManager() }),
    );
    expect(result.isError).toBeUndefined();
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('SECRET-VALUE');
    expect(serialized).not.toContain('SECRET_ENV');
    expect(serialized).not.toContain('"headers"');
    expect(serialized).not.toContain('"config"');
  });
});

/**
 * ADR-071: instance-записи, stdio и instance master flag — только ADMIN.
 * `LEAD` остаётся elevated для видимости/проектов, но не получает ADMIN-прав
 * над MCP (security-ревью A2).
 */
describe('instance/stdio MCP — ADMIN, не LEAD', () => {
  const LEAD = { userId: 'lead', roles: ['LEAD'] };
  const ADMIN = { userId: 'admin', roles: ['ADMIN'] };

  it('add: LEAD не может instance/stdio, ADMIN может', async () => {
    const leadRegistry = makeRegistry();
    const leadInstance = await synthMcpAddTool.execute(
      { name: 'inst', config: httpConfig, origin: 'instance' },
      makeCtx({ registry: leadRegistry, manager: makeManager(), principal: LEAD }),
    );
    expect(leadInstance.isError).toBe(true);
    expect(leadInstance.metadata?.i18n).toMatchObject({ key: 'instance.mcp.instance_forbidden' });

    const leadStdio = await synthMcpAddTool.execute(
      { name: 'stdio', config: { type: 'stdio', command: 'npx' } },
      makeCtx({ registry: leadRegistry, manager: makeManager(), principal: LEAD }),
    );
    expect(leadStdio.isError).toBe(true);
    expect(leadRegistry.add).not.toHaveBeenCalled();

    const adminRegistry = makeRegistry();
    const adminInstance = await synthMcpAddTool.execute(
      { name: 'inst', config: httpConfig, origin: 'instance' },
      makeCtx({ registry: adminRegistry, manager: makeManager(), principal: ADMIN }),
    );
    expect(adminInstance.isError).toBeUndefined();
    expect(adminInstance.metadata?.origin).toBe('instance');
  });

  it('update: LEAD не может instance-запись, ADMIN может', async () => {
    const leadRegistry = makeRegistry([makeEntry({ name: 'inst', origin: 'instance', author: null })]);
    const lead = await synthMcpUpdateTool.execute(
      { name: 'inst', enabled: false },
      makeCtx({ registry: leadRegistry, manager: makeManager(), principal: LEAD }),
    );
    expect(lead.isError).toBe(true);
    expect(lead.metadata?.i18n).toMatchObject({ key: 'instance.mcp.instance_forbidden' });
    expect(leadRegistry.update).not.toHaveBeenCalled();

    const adminRegistry = makeRegistry([makeEntry({ name: 'inst', origin: 'instance', author: null })]);
    const admin = await synthMcpUpdateTool.execute(
      { name: 'inst', enabled: false },
      makeCtx({ registry: adminRegistry, manager: makeManager(), principal: ADMIN }),
    );
    expect(admin.isError).toBeUndefined();
    expect(adminRegistry.update).toHaveBeenCalled();
  });

  it('remove: LEAD не может instance-запись, ADMIN может', async () => {
    const leadRegistry = makeRegistry([makeEntry({ name: 'inst', origin: 'instance', author: null })]);
    const lead = await synthMcpRemoveTool.execute(
      { name: 'inst' },
      makeCtx({ registry: leadRegistry, manager: makeManager(), principal: LEAD }),
    );
    expect(lead.isError).toBe(true);
    expect(lead.metadata?.i18n).toMatchObject({ key: 'instance.mcp.instance_forbidden' });
    expect(leadRegistry.remove).not.toHaveBeenCalled();

    const adminRegistry = makeRegistry([makeEntry({ name: 'inst', origin: 'instance', author: null })]);
    const admin = await synthMcpRemoveTool.execute(
      { name: 'inst' },
      makeCtx({ registry: adminRegistry, manager: makeManager(), principal: ADMIN }),
    );
    expect(admin.isError).toBeUndefined();
    expect(adminRegistry.remove).toHaveBeenCalled();
  });

  it('enable instance: LEAD не может, ADMIN может', async () => {
    const leadRegistry = makeRegistry([makeEntry({ name: 'inst', origin: 'instance', author: null })]);
    const lead = await synthMcpEnableTool.execute(
      { name: 'inst', enabled: false, level: 'instance' },
      makeCtx({ registry: leadRegistry, manager: makeManager(), session: session(), principal: LEAD }),
    );
    expect(lead.isError).toBe(true);
    expect(lead.metadata?.i18n).toMatchObject({ key: 'instance.mcp.instance_forbidden' });
    expect(leadRegistry.update).not.toHaveBeenCalled();

    const adminRegistry = makeRegistry([makeEntry({ name: 'inst', origin: 'instance', author: null })]);
    const admin = await synthMcpEnableTool.execute(
      { name: 'inst', enabled: false, level: 'instance' },
      makeCtx({ registry: adminRegistry, manager: makeManager(), session: session(), principal: ADMIN }),
    );
    expect(admin.isError).toBeUndefined();
    expect(adminRegistry.update).toHaveBeenCalled();
  });

  it('LEAD может update/remove свою user-запись (автор)', async () => {
    const entry = makeEntry({ name: 'mine', author: { userId: 'lead', username: 'lead' } });
    const updateRegistry = makeRegistry([entry]);
    const updated = await synthMcpUpdateTool.execute(
      { name: 'mine', enabled: false },
      makeCtx({ registry: updateRegistry, manager: makeManager(), principal: LEAD }),
    );
    expect(updated.isError).toBeUndefined();
    expect(updateRegistry.update).toHaveBeenCalled();

    const removeRegistry = makeRegistry([entry]);
    const removed = await synthMcpRemoveTool.execute(
      { name: 'mine' },
      makeCtx({ registry: removeRegistry, manager: makeManager(), principal: LEAD }),
    );
    expect(removed.isError).toBeUndefined();
    expect(removeRegistry.remove).toHaveBeenCalled();
  });
});

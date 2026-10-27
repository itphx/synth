import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpManager } from './manager.js';
import type { McpServerConfig, ToolContext, ToolDefinition, AttachmentsConfig } from '@itphx/synth-shared';
import { attachmentsConfigSchema, ToolCapability } from '@itphx/synth-shared';
import type { ToolRegistry } from '../tools/registry.js';
import type { SessionManager } from '../../sessions/manager.js';
import { AttachmentService } from '../attachments/service.js';
import { MemoryBlobStore } from '../../storage/memory/content.js';

const mockClientConnect = vi.fn<() => Promise<void>>();
const mockClientDisconnect = vi.fn<() => Promise<void>>();
const mockClientCallTool = vi.fn<() => Promise<{
  content: string;
  isError: boolean;
  attachments?: Array<{ mime: string; name?: string; base64: string }>;
}>>();
/** Аргументы фактических вызовов McpClient.callTool (name, args, _meta). */
let mockClientCallToolArgs: Array<{ name: string; args: Record<string, unknown>; meta?: Record<string, unknown> }> = [];
let mockClientTools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> = [];
let mockClientConnected = false;
let mockClientInstructions: string | undefined;

vi.mock('./client.js', () => ({
  McpClient: class {
    name: string;
    constructor(name: string, _config: McpServerConfig) {
      this.name = name;
    }
    get isConnected(): boolean {
      return mockClientConnected;
    }
    get tools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
      return mockClientTools;
    }
    get instructions(): string | undefined {
      return mockClientInstructions;
    }
    connect = mockClientConnect;
    disconnect = mockClientDisconnect;
    callTool = vi.fn((name: string, args: Record<string, unknown>, meta?: Record<string, unknown>) => {
      mockClientCallToolArgs.push({ name, args, meta });
      return mockClientCallTool();
    });
  },
}));

function makeMockToolRegistry(): ToolRegistry {
  const tools = new Map<string, ToolDefinition>();
  return {
    register(tool: ToolDefinition) {
      tools.set(tool.name, tool);
    },
    deregister(name: string) {
      tools.delete(name);
    },
    deregisterByCapability(_capability: ToolCapability) {
      let count = 0;
      for (const [name, def] of tools) {
        if (def.capabilities?.includes(ToolCapability.MCP)) {
          tools.delete(name);
          count++;
        }
      }
      return count;
    },
    get(name: string) {
      return tools.get(name);
    },
    list() {
      return [...tools.values()];
    },
    toLLMFormat() {
      return [];
    },
    execute(_toolName: string, _args: unknown, _context: unknown) {
      return Promise.resolve({ content: '', isError: false });
    },
    get count() {
      return tools.size;
    },
  } as unknown as ToolRegistry;
}

function makeStdioConfig(name: string = 'test-server'): McpServerConfig {
  return {
    type: 'stdio',
    command: 'node',
    args: [`${name}.js`],
  };
}

describe('McpManager', () => {
  let manager: McpManager;
  let registry: ToolRegistry;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClientConnect.mockResolvedValue(undefined);
    mockClientDisconnect.mockResolvedValue(undefined);
    mockClientCallTool.mockResolvedValue({ content: 'tool result', isError: false });
    mockClientTools = [
      { name: 'tool1', description: 'First tool', inputSchema: { type: 'object' } },
      { name: 'tool2', description: 'Second tool', inputSchema: { type: 'object' } },
    ];
    mockClientConnected = false;
    mockClientInstructions = 'Инструкции сервера';
    mockClientCallToolArgs = [];

    manager = new McpManager();
    registry = makeMockToolRegistry();
    manager.setConfig({
      'test-server': makeStdioConfig(),
    });
  });

  it('isServerConfigured возвращает true для сконфигурированного сервера', () => {
    expect(manager.isServerConfigured('test-server')).toBe(true);
    expect(manager.isServerConfigured('unknown')).toBe(false);
  });

  it('getServerConfig возвращает конфигурацию', () => {
    const cfg = manager.getServerConfig('test-server');
    expect(cfg?.type).toBe('stdio');
    expect(cfg?.command).toBe('node');
  });

  it('ADR-071 §2.4: isServerSystemEnabled — мастер только из реестра, config.enabled не гейт', () => {
    // config.enabled=false — лишь сид записи реестра; без карты реестра сервер включён.
    manager.setConfig({ 'cfg-off': { ...makeStdioConfig('cfg-off'), enabled: false } });
    expect(manager.isServerSystemEnabled('cfg-off')).toBe(true);
    expect(manager.isServerSystemEnabled('unknown')).toBe(true);

    // Карта реестра — единственный источник мастер-флага.
    manager.setServerSystemEnabled({ 'cfg-off': false });
    expect(manager.isServerSystemEnabled('cfg-off')).toBe(false);
    expect(manager.isServerSystemEnabled('unknown')).toBe(true);
  });

  it('getConfiguredServers возвращает список серверов', () => {
    const servers = manager.getConfiguredServers();
    expect(servers).toHaveLength(1);
    expect(servers[0]!.name).toBe('test-server');
    expect(servers[0]!.connected).toBe(false);
  });

  it('connectServer подключает сервер', async () => {
    mockClientConnected = true;
    await manager.connectServer('test-server');
    const servers = manager.getConfiguredServers();
    expect(servers[0]!.connected).toBe(true);
  });

  it('connectServer для неизвестного сервера выбрасывает ошибку', async () => {
    await expect(manager.connectServer('unknown')).rejects.toThrow('не настроен');
  });

  it('connectServer не переподключает уже подключённый сервер', async () => {
    mockClientConnected = true;
    await manager.connectServer('test-server');
    await manager.connectServer('test-server');
    expect(mockClientConnect).toHaveBeenCalledTimes(1);
  });

  it('disconnectServer отключает сервер', async () => {
    mockClientConnected = true;
    await manager.connectServer('test-server');
    await manager.disconnectServer('test-server');
    expect(mockClientDisconnect).toHaveBeenCalledTimes(1);
    const servers = manager.getConfiguredServers();
    expect(servers[0]!.connected).toBe(false);
  });

  it('disconnectAll отключает все серверы', async () => {
    manager.setConfig({
      'srv1': makeStdioConfig(),
      'srv2': makeStdioConfig(),
    });
    mockClientConnected = true;
    await manager.connectServer('srv1');
    await manager.connectServer('srv2');
    expect(mockClientConnect).toHaveBeenCalledTimes(2);

    await manager.disconnectAll();
    expect(mockClientDisconnect).toHaveBeenCalledTimes(2);
  });

  it('registerTools регистрирует инструменты с префиксом', async () => {
    mockClientConnected = true;
    await manager.connectServer('test-server');
    const names = await manager.registerTools('test-server', registry);

    expect(names).toEqual(['test-server_tool1', 'test-server_tool2']);
    expect(registry.get('test-server_tool1')).toBeDefined();
    expect(registry.get('test-server_tool2')).toBeDefined();
    expect(registry.get('test-server_tool1')?.description).toContain('[MCP:test-server]');
    expect(registry.get('test-server_tool1')?.capabilities).toContain(ToolCapability.MCP);
  });

  it('ADR-071: registerTools тегирует источник (source: mcp, mcpServer)', async () => {
    mockClientConnected = true;
    await manager.registerTools('test-server', registry);

    const tool = registry.get('test-server_tool1')!;
    expect(tool.source).toBe('mcp');
    expect(tool.mcpServer).toBe('test-server');
  });

  it('ADR-071: registerTools идемпотентен — повторный вызов не теряет имена для deregister', async () => {
    mockClientConnected = true;
    await manager.registerTools('test-server', registry);
    const names = await manager.registerTools('test-server', registry);
    expect(names).toEqual(['test-server_tool1', 'test-server_tool2']);

    await manager.deregisterTools('test-server', registry);
    expect(registry.list().length).toBe(0);
  });

  it('registerTools для отключённого сервера пытается подключиться', async () => {
    mockClientConnected = true;
    const names = await manager.registerTools('test-server', registry);
    expect(mockClientConnect).toHaveBeenCalled();
    expect(names).toEqual(['test-server_tool1', 'test-server_tool2']);
  });

  describe('registerTools: контекст сессии в _meta (synth/session_id)', () => {
    function makeCtx(sessionId: string, extra?: Record<string, unknown>): ToolContext {
      return { sessionId, messageId: 'msg-1', workingDir: '/tmp', extra };
    }

    it('execute MCP-тула передаёт _meta.synth/session_id при ctx.sessionId', async () => {
      mockClientConnected = true;
      await manager.registerTools('test-server', registry);
      const tool = registry.get('test-server_tool1')!;

      await tool.execute({ arg: 'value' }, makeCtx('sess-1'));

      expect(mockClientCallToolArgs).toHaveLength(1);
      expect(mockClientCallToolArgs[0]!.name).toBe('tool1');
      expect(mockClientCallToolArgs[0]!.args).toEqual({ arg: 'value' });
      expect(mockClientCallToolArgs[0]!.meta).toEqual({ 'synth/session_id': 'sess-1' });
    });

    it('execute MCP-тула без sessionId не передаёт _meta', async () => {
      mockClientConnected = true;
      await manager.registerTools('test-server', registry);
      const tool = registry.get('test-server_tool1')!;

      await tool.execute({ arg: 'value' }, makeCtx(''));

      expect(mockClientCallToolArgs).toHaveLength(1);
      expect(mockClientCallToolArgs[0]!.meta).toBeUndefined();
    });

    it('execute MCP-тула с sessionManager (деобфускация) тоже передаёт _meta', async () => {
      mockClientConnected = true;
      await manager.registerTools('test-server', registry);
      const tool = registry.get('test-server_tool1')!;
      const sessionManager = {
        getSession: async () => ({ obfuscationMap: {} }),
      } as unknown as SessionManager;

      await tool.execute({ arg: 'value' }, makeCtx('sess-2', { sessionManager }));

      expect(mockClientCallToolArgs).toHaveLength(1);
      expect(mockClientCallToolArgs[0]!.meta).toEqual({ 'synth/session_id': 'sess-2' });
    });
  });

  it('registerTools для сервера с ошибкой подключения возвращает []', async () => {
    mockClientConnect.mockRejectedValueOnce(new Error('connect failed'));
    mockClientConnected = false;
    const names = await manager.registerTools('test-server', registry);
    expect(names).toEqual([]);
  });

  it('deregisterTools удаляет инструменты', async () => {
    mockClientConnected = true;
    await manager.connectServer('test-server');
    await manager.registerTools('test-server', registry);
    expect(registry.list().length).toBe(2);

    await manager.deregisterTools('test-server', registry);
    expect(registry.list().length).toBe(0);
  });

  it('deregisterTools для сервера не в кеше удаляет по префиксу', async () => {
    await manager.registerTools('test-server', registry);
    expect(registry.list().length).toBe(2);

    // Отключаем и удаляем из кеша
    await manager.disconnectServer('test-server');
    // Регистрируем заново через manager, который снова добавит регистрации
    // но disconnectServer удаляет сервер из кеша

    // Создаём новый manager с чистым состоянием для теста префиксного удаления
    const newManager = new McpManager();
    newManager.setConfig({ 'test-server': makeStdioConfig() });
    // Инструменты всё ещё в registry от предыдущей регистрации
    await newManager.deregisterTools('test-server', registry);
    expect(registry.list().length).toBe(0);
  });

  it('ensureToolsLoaded загружает инструменты для нескольких серверов', async () => {
    manager.setConfig({
      'srv1': makeStdioConfig(),
      'srv2': makeStdioConfig(),
    });
    mockClientConnected = true;

    await manager.ensureToolsLoaded(['srv1', 'srv2'], registry);
    expect(registry.list().length).toBe(4);
    expect(registry.get('srv1_tool1')).toBeDefined();
    expect(registry.get('srv1_tool2')).toBeDefined();
    expect(registry.get('srv2_tool1')).toBeDefined();
    expect(registry.get('srv2_tool2')).toBeDefined();
  });

  it('probeServer возвращает инструменты без регистрации', async () => {
    mockClientConnected = true;
    const tools = await manager.probeServer('test-server');
    expect(tools).toHaveLength(2);
    expect(tools[0]!.name).toBe('tool1');
    expect(tools[1]!.name).toBe('tool2');
    // Инструменты не должны быть зарегистрированы в registry
    expect(registry.list().length).toBe(0);
  });

  it('probeServer для неизвестного сервера выбрасывает ошибку', async () => {
    await expect(manager.probeServer('unknown')).rejects.toThrow('не настроен');
  });

  it('getServerTools возвращает инструменты подключённого сервера', async () => {
    mockClientConnected = true;
    await manager.connectServer('test-server');
    const tools = manager.getServerTools('test-server');
    expect(tools).not.toBeNull();
    expect(tools).toHaveLength(2);
    expect(tools![0]!.name).toBe('tool1');
  });

  it('getServerTools возвращает null для не подключённого сервера', () => {
    const tools = manager.getServerTools('test-server');
    expect(tools).toBeNull();
  });

  it('ADR-071 §2.2: getServerDescription берёт описание из конфига', () => {
    manager.setConfig({ 'test-server': { ...makeStdioConfig(), description: 'Мой сервер' } });
    expect(manager.getServerDescription('test-server')).toBe('Мой сервер');
    expect(manager.getServerDescription('unknown')).toBeUndefined();
  });

  it('ADR-071 §2.2: getServerInstructions после подключения', async () => {
    mockClientConnected = true;
    await manager.connectServer('test-server');

    expect(manager.getServerInstructions('test-server')).toBe('Инструкции сервера');
    // До подключения — undefined.
    expect(manager.getServerInstructions('unknown')).toBeUndefined();
  });

  it('ADR-071 §2.2: getServerStatus — disconnected/connected/error', async () => {
    expect(manager.getServerStatus('test-server')).toBe('disconnected');
    expect(manager.getServerStatus('unknown')).toBe('disconnected');

    mockClientConnected = true;
    await manager.connectServer('test-server');
    expect(manager.getServerStatus('test-server')).toBe('connected');

    // Сервер известен, но соединение потеряно.
    mockClientConnected = false;
    expect(manager.getServerStatus('test-server')).toBe('error');
  });

  it('callTool вызывает инструмент по полному имени', async () => {
    mockClientConnected = true;
    mockClientCallTool.mockResolvedValueOnce({ content: 'result from tool1', isError: false });
    await manager.connectServer('test-server');

    const result = await manager.callTool('test-server_tool1', { arg: 'value' });
    expect(result.content).toBe('result from tool1');
    expect(result.isError).toBe(false);
  });

  it('callTool без подчёркивания возвращает ошибку', async () => {
    const result = await manager.callTool('badname', {});
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Неизвестный формат имени');
  });

  it('callTool для не подключённого сервера возвращает ошибку', async () => {
    const result = await manager.callTool('unknown_tool', {});
    expect(result.isError).toBe(true);
    expect(result.content).toContain('не подключён');
  });

  it('refreshServer переподключает сервер и перерегистрирует инструменты', async () => {
    mockClientConnected = true;
    await manager.connectServer('test-server');
    await manager.registerTools('test-server', registry);
    expect(registry.list().length).toBe(2);

    // Меняем инструменты перед refresh
    mockClientTools = [
      { name: 'tool1', description: 'Updated', inputSchema: { type: 'object' } },
      { name: 'tool3', description: 'New tool', inputSchema: { type: 'object' } },
    ];

    await manager.refreshServer('test-server', registry);
    expect(registry.list().length).toBe(2);
    expect(registry.get('test-server_tool1')?.description).toContain('Updated');
    expect(registry.get('test-server_tool3')?.description).toContain('New tool');
    expect(registry.get('test-server_tool2')).toBeUndefined();
  });

  it('setConfig обновляет конфигурацию', () => {
    manager.setConfig({ 'new-srv': makeStdioConfig() });
    expect(manager.getConfig()).toEqual({ 'new-srv': makeStdioConfig() });
    const servers = manager.getConfiguredServers();
    expect(servers).toHaveLength(1);
    expect(servers[0]!.name).toBe('new-srv');
  });

  describe('сетевая политика (ADR-071 §2.3.1)', () => {
    it('connectServer блокирует пользовательский приватный HTTP при deny', async () => {
      manager.setConfig({ 'http-srv': { type: 'sse', url: 'http://10.0.0.5/mcp' } });
      manager.setServerOrigins({ 'http-srv': 'user' });
      manager.setNetworkPolicy({ mode: 'deny', list: ['10.0.0.0/8'] });
      await expect(manager.connectServer('http-srv')).rejects.toThrow('сетевой политикой');
      expect(mockClientConnect).not.toHaveBeenCalled();
    });

    it('connectServer подключает пользовательский HTTP при allow-политике', async () => {
      mockClientConnected = true;
      manager.setConfig({ 'http-srv': { type: 'sse', url: 'http://10.0.0.5/mcp' } });
      manager.setServerOrigins({ 'http-srv': 'user' });
      manager.setNetworkPolicy({ mode: 'allow', list: ['10.0.0.0/8'] });
      await manager.connectServer('http-srv');
      expect(mockClientConnect).toHaveBeenCalled();
    });

    it('instance-сервер не проверяется сетевой политикой (приватные сети инстанса)', async () => {
      mockClientConnected = true;
      manager.setConfig({ 'http-srv': { type: 'sse', url: 'http://10.0.0.5/mcp' } });
      manager.setServerOrigins({ 'http-srv': 'instance' });
      manager.setNetworkPolicy({ mode: 'deny', list: ['10.0.0.0/8'] });
      await manager.connectServer('http-srv');
      expect(mockClientConnect).toHaveBeenCalled();
    });

    it('stdio не проверяется сетевой политикой', async () => {
      mockClientConnected = true;
      manager.setServerOrigins({ 'test-server': 'user' });
      manager.setNetworkPolicy({ mode: 'deny', list: ['10.0.0.0/8'] });
      await manager.connectServer('test-server');
      expect(mockClientConnect).toHaveBeenCalled();
    });

    it('fail-closed: пользовательский HTTP без доступной политики не подключается', async () => {
      manager.setConfig({ 'http-srv': { type: 'sse', url: 'http://10.0.0.5/mcp' } });
      manager.setServerOrigins({ 'http-srv': 'user' });
      // Ни статической политики, ни резолвера — проверять нечем.
      await expect(manager.connectServer('http-srv')).rejects.toThrow(/egress-политика недоступна/);
      expect(mockClientConnect).not.toHaveBeenCalled();
    });

    it('probeServer блокирует пользовательский приватный HTTP при deny', async () => {
      manager.setConfig({ 'http-srv': { type: 'sse', url: 'http://10.0.0.5/mcp' } });
      manager.setServerOrigins({ 'http-srv': 'user' });
      manager.setNetworkPolicy({ mode: 'deny', list: ['10.0.0.0/8'] });
      await expect(manager.probeServer('http-srv')).rejects.toThrow('сетевой политикой');
    });
  });
});

// ─── ADR-115 §«Медиа из инструментов»: MCP-результат → blob ─────────────────
//
// Клиент отдаёт base64 (транспорт), менеджер пишет байты через
// `AttachmentService` (единственная точка записи) и возвращает **ссылки** в
// `ToolResult.attachments`. Проверяем: успех, отсутствие сервиса, дедуп по
// `blobPath`, отказ `upload` (пропуск, не падение) и `isError` (без загрузки).

describe('McpManager: вложения MCP-результата (ADR-115)', () => {
  /** PNG-сигнатура + полезная нагрузка (MIME определяется по содержимому). */
  const PNG = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('mcp-screenshot'),
  ]);
  const PNG_B64 = PNG.toString('base64');

  function makeService(overrides: Partial<AttachmentsConfig> = {}) {
    const config: AttachmentsConfig = { ...attachmentsConfigSchema.parse({}), ...overrides };
    const service = new AttachmentService({
      blobs: new MemoryBlobStore(),
      config: () => config,
    });
    const upload = vi.spyOn(service, 'upload');
    return { service, upload, config };
  }

  function makeCtx(extra: Record<string, unknown> = {}): ToolContext {
    return { sessionId: 'sess-att', messageId: 'msg-1', workingDir: '/tmp', extra };
  }

  let localManager: McpManager;
  let localRegistry: ToolRegistry;

  beforeEach(() => {
    mockClientConnect.mockResolvedValue(undefined);
    mockClientCallTool.mockResolvedValue({ content: 'готово', isError: false });
    mockClientTools = [{ name: 'screenshot', description: 'Снимок', inputSchema: { type: 'object' } }];
    mockClientConnected = true;
    localManager = new McpManager();
    localManager.setConfig({ 'test-server': makeStdioConfig() });
    localRegistry = makeMockToolRegistry();
  });

  it('image → upload → ToolResult.attachments (ссылка, не байты)', async () => {
    mockClientCallTool.mockResolvedValueOnce({
      content: 'снимок готов',
      isError: false,
      attachments: [{ mime: 'image/png', base64: PNG_B64 }],
    });
    const { service, upload } = makeService();
    await localManager.registerTools('test-server', localRegistry);
    const tool = localRegistry.get('test-server_screenshot')!;

    const result = await tool.execute({}, makeCtx({ attachmentService: service }));

    expect(result.isError).toBe(false);
    expect(result.content).toBe('снимок готов');
    expect(result.attachments).toHaveLength(1);
    const ref = result.attachments![0]!;
    expect(ref.blobPath).toMatch(/^attachments\/[0-9a-f]{2}\/[0-9a-f]{64}$/);
    expect(ref.mime).toBe('image/png');
    expect(ref.size).toBe(PNG.length);
    expect(ref.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0]![0]).toMatchObject({ sessionId: 'sess-att', declaredMime: 'image/png' });
  });

  it('нет сервиса вложений — текст без вложений, без падения', async () => {
    mockClientCallTool.mockResolvedValueOnce({
      content: 'снимок готов',
      isError: false,
      attachments: [{ mime: 'image/png', base64: PNG_B64 }],
    });
    await localManager.registerTools('test-server', localRegistry);
    const tool = localRegistry.get('test-server_screenshot')!;

    const result = await tool.execute({}, makeCtx());

    expect(result.content).toBe('снимок готов');
    expect(result.attachments).toBeUndefined();
  });

  it('несколько блоков: дедуп по blobPath, разные — обе ссылки', async () => {
    const other = Buffer.concat([PNG, Buffer.from('-2')]);
    mockClientCallTool.mockResolvedValueOnce({
      content: 'два кадра',
      isError: false,
      attachments: [
        { mime: 'image/png', base64: PNG_B64 },
        { mime: 'image/png', base64: PNG_B64 }, // те же байты — тот же объект
        { mime: 'image/png', base64: other.toString('base64') },
      ],
    });
    const { service } = makeService();
    await localManager.registerTools('test-server', localRegistry);
    const tool = localRegistry.get('test-server_screenshot')!;

    const result = await tool.execute({}, makeCtx({ attachmentService: service }));

    expect(result.attachments).toHaveLength(2);
    expect(new Set(result.attachments!.map((ref) => ref.blobPath)).size).toBe(2);
  });

  it('отказ upload (вложения отключены) — пропуск, вызов не падает', async () => {
    mockClientCallTool.mockResolvedValueOnce({
      content: 'снимок готов',
      isError: false,
      attachments: [{ mime: 'image/png', base64: PNG_B64 }],
    });
    const { service } = makeService({ enabled: false });
    await localManager.registerTools('test-server', localRegistry);
    const tool = localRegistry.get('test-server_screenshot')!;

    const result = await tool.execute({}, makeCtx({ attachmentService: service }));

    expect(result.content).toBe('снимок готов');
    expect(result.isError).toBe(false);
    expect(result.attachments).toBeUndefined();
  });

  it('isError: вложения не загружаются', async () => {
    mockClientCallTool.mockResolvedValueOnce({
      content: 'упало',
      isError: true,
      attachments: [{ mime: 'image/png', base64: PNG_B64 }],
    });
    const { service, upload } = makeService();
    await localManager.registerTools('test-server', localRegistry);
    const tool = localRegistry.get('test-server_screenshot')!;

    const result = await tool.execute({}, makeCtx({ attachmentService: service }));

    expect(result.isError).toBe(true);
    expect(result.attachments).toBeUndefined();
    expect(upload).not.toHaveBeenCalled();
  });
});

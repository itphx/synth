import { z } from 'zod';
import type { McpServerConfig, McpNetworkPolicy, McpRegistryAuthor, McpRegistryOrigin, McpRegistryTrust, ToolDefinition } from '@itphx/synth-shared';
import { ToolCapability } from '@itphx/synth-shared';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolContext, ToolResult } from '@itphx/synth-shared';
import { McpClient } from './client.js';
import { evaluateMcpNetworkAccess, isHttpMcpConfig } from './network-policy.js';
import { info, warning } from '../../logger.js';
import type { SessionManager } from '../../sessions/manager.js';
import { ObfuscationMapStore } from '../gateway/obfuscation-map-store.js';

const CIRCUIT_BREAKER_THRESHOLD = 5;
const CIRCUIT_BREAKER_COOLDOWN_MS = 60_000;

interface ServerEntry {
  client: McpClient;
  registeredToolNames: string[];
  errorCount: number;
  lastErrorTime: number;
}

export class McpManager {
  private _servers = new Map<string, ServerEntry>();
  private _config: Record<string, McpServerConfig> = {};
  /** AD-071 §2.3.1: политика сетевого доступа HTTP-серверов (если задана). */
  private _networkPolicy: McpNetworkPolicy | undefined;
  /** AD-071 §2.5: origin серверов; сетевая политика применяется только к `user`. */
  private _serverOrigins = new Map<string, McpRegistryOrigin>();
  /** AD-071 §2.5: trust записей реестра (builtin|community) для отображения. */
  private _serverTrusts = new Map<string, McpRegistryTrust>();
  /** AD-071 §2.5: авторы записей реестра (имя → автор) для отображения. */
  private _serverAuthors = new Map<string, McpRegistryAuthor>();
  /**
   * AD-071 §2.4: instance-серверы, включённые по умолчанию (`enabledByDefault`).
   * Переосмыслено: сид для НОВЫХ ПРОЕКТОВ. `null` — явный набор не задан, берётся
   * из `config.enabledByDefault`.
   */
  private _defaultServers: Set<string> | null = null;
  /**
   * AD-071 §2.4: системный мастер-флаг серверов (реестр `enabled`). `null` — не
   * задан, деривируется из `config.enabled !== false`.
   */
  private _serverSystemEnabled: Map<string, boolean> | null = null;

  setConfig(servers: Record<string, McpServerConfig>): void {
    this._config = servers;
  }

  getConfig(): Record<string, McpServerConfig> {
    return this._config;
  }

  /** AD-071 §2.3.1: задать политику сетевого доступа (undefined — не проверять). */
  setNetworkPolicy(policy: McpNetworkPolicy | undefined): void {
    this._networkPolicy = policy;
  }

  /** AD-071 §2.5: origin серверов (instance — доверенные, user — community). */
  setServerOrigins(origins: Record<string, McpRegistryOrigin>): void {
    this._serverOrigins = new Map(Object.entries(origins));
  }

  /** AD-071 §2.5: origin одного сервера (по умолчанию `instance` — config). */
  getServerOrigin(name: string): McpRegistryOrigin {
    return this._serverOrigins.get(name) ?? 'instance';
  }

  /** AD-071 §2.5: trust записей реестра (по умолчанию `builtin`). */
  setServerTrusts(trusts: Record<string, McpRegistryTrust>): void {
    this._serverTrusts = new Map(Object.entries(trusts));
  }

  getServerTrust(name: string): McpRegistryTrust {
    return this._serverTrusts.get(name) ?? 'builtin';
  }

  /** AD-071 §2.5: авторы записей реестра (для таблицы «MCP» в статистике). */
  setServerAuthors(authors: Record<string, McpRegistryAuthor>): void {
    this._serverAuthors = new Map(Object.entries(authors));
  }

  /** AD-071 §2.5: автор сервера (null — instance/config без автора). */
  getServerAuthor(name: string): McpRegistryAuthor | null {
    return this._serverAuthors.get(name) ?? null;
  }

  /**
   * AD-071 §2.4: instance default-on набор (`enabledByDefault` из реестра).
   * Если не задан явно — деривируется из `config.enabledByDefault`.
   */
  setDefaultServers(names: string[]): void {
    this._defaultServers = new Set(names);
  }

  isDefaultServer(name: string): boolean {
    if (this._defaultServers) return this._defaultServers.has(name);
    return this._config[name]?.enabledByDefault === true;
  }

  /**
   * AD-071 §2.4: системный мастер-флаг сервера (реестр `enabled`). Не задан —
   * дефолт из config (`enabled !== false`, т.е. включён).
   */
  setServerSystemEnabled(states: Record<string, boolean>): void {
    this._serverSystemEnabled = new Map(Object.entries(states));
  }

  isServerSystemEnabled(name: string): boolean {
    if (this._serverSystemEnabled) return this._serverSystemEnabled.get(name) ?? true;
    return this._config[name]?.enabled !== false;
  }

  /**
   * AD-071 §2.3.1: проверка пользовательского (`origin: 'user'`) HTTP-сервера по
   * сетевой политике перед подключением. `stdio` и instance-серверы не
   * проверяются (RCE-риск и приватные сети инстанса регулируются иначе).
   */
  private async _assertNetworkAllowed(name: string, config: McpServerConfig): Promise<void> {
    if (!this._networkPolicy || !isHttpMcpConfig(config)) return;
    if (this._serverOrigins.get(name) !== 'user') return;
    if (!config.url) {
      throw new Error(`MCP-сервер "${name}" (${config.type}) не содержит url`);
    }
    const result = await evaluateMcpNetworkAccess(config.url, this._networkPolicy);
    if (!result.allowed) {
      throw new Error(`MCP-сервер "${name}" заблокирован сетевой политикой: ${result.reason}`);
    }
  }

  getConfiguredServers(): Array<{ name: string; config: McpServerConfig; connected: boolean }> {
    return Object.entries(this._config).map(([name, config]) => ({
      name,
      config,
      connected: this._servers.has(name) && this._servers.get(name)!.client.isConnected,
    }));
  }

  isServerConfigured(name: string): boolean {
    return name in this._config;
  }

  getServerConfig(name: string): McpServerConfig | undefined {
    return this._config[name];
  }

  getServerTools(name: string): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> | null {
    const entry = this._servers.get(name);
    if (!entry) return null;
    return entry.client.tools;
  }

  /** AD-071 §2.2: `instructions` подключённого сервера (undefined, если нет). */
  getServerInstructions(name: string): string | undefined {
    return this._servers.get(name)?.client.instructions;
  }

  /** AD-071 §2.2: описание сервера из конфига (заполняется человеком). */
  getServerDescription(name: string): string | undefined {
    return this._config[name]?.description;
  }

  /**
   * AD-071 §2.2: статус подключения сервера для volatile-блока `mcp.status`.
   * `disabled` (opt-out/конфиг) определяется вызывающей стороной — менеджер
   * знает только транспортное состояние. Возвращает:
   * - `circuit-open` — сервер заблокирован circuit breaker'ом;
   * - `connected` — клиент подключён;
   * - `error` — сервер известен, но не подключён (ошибка/отключён);
   * - `disconnected` — сервер не создавался (ещё ни разу не подключался).
   */
  getServerStatus(name: string): 'connected' | 'error' | 'circuit-open' | 'disconnected' {
    const entry = this._servers.get(name);
    if (!entry) return 'disconnected';
    if (this._isCircuitOpen(name)) return 'circuit-open';
    return entry.client.isConnected ? 'connected' : 'error';
  }

  async connectServer(name: string): Promise<void> {
    const config = this._config[name];
    if (!config) {
      throw new Error(`MCP-сервер "${name}" не настроен`);
    }

    const existing = this._servers.get(name);
    if (existing?.client.isConnected) {
      return;
    }

    await this._assertNetworkAllowed(name, config);

    const client = new McpClient(name, config);

    try {
      await client.connect();
      this._servers.set(name, {
        client,
        registeredToolNames: [],
        errorCount: 0,
        lastErrorTime: 0,
      });
    } catch (err) {
      this._recordError(name);
      throw err;
    }
  }

  async disconnectServer(name: string): Promise<void> {
    const entry = this._servers.get(name);
    if (!entry) return;

    await entry.client.disconnect();
    this._servers.delete(name);
  }

  /**
   * Проверяет подключение к серверу и возвращает его инструменты без регистрации.
   * Создаёт временное подключение, получает инструменты, и отключается.
   */
  async probeServer(name: string): Promise<Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>> {
    const config = this._config[name];
    if (!config) {
      throw new Error(`MCP-сервер "${name}" не настроен`);
    }

    await this._assertNetworkAllowed(name, config);

    const client = new McpClient(name, config);
    try {
      await client.connect();
      return client.tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
    } finally {
      await client.disconnect();
    }
  }

  async registerTools(
    serverName: string,
    toolRegistry: ToolRegistry,
  ): Promise<string[]> {
    const entry = this._servers.get(serverName);
    if (!entry || !entry.client.isConnected) {
      // Пытаемся подключиться
      try {
        await this.connectServer(serverName);
      } catch {
        return [];
      }
    }

    const serverEntry = this._servers.get(serverName);
    if (!serverEntry) return [];

    const prefixedName = (toolName: string) => `${serverName}_${toolName}`;
    const client = serverEntry.client;
    const registeredNames: string[] = [];

    for (const tool of client.tools) {
      const fullName = prefixedName(tool.name);

      const existing = toolRegistry.get(fullName);
      if (existing) {
        // AD-071 §2.1: инструмент этого же сервера уже зарегистрирован (ленивая
        // регистрация при первой активации) — повторный вызов идемпотентен, не
        // теряем имя для deregister. Коллизия с чужим тулом — пропускаем.
        if ((existing.source ?? 'builtin') === 'mcp' && existing.mcpServer === serverName) {
          registeredNames.push(fullName);
          continue;
        }
        warning(`MCP`, `Инструмент "${fullName}" конфликтует с существующим — пропускаем`);
        continue;
      }

      const mcpToolDef: ToolDefinition = {
        name: fullName,
        description: `[MCP:${serverName}] ${tool.description}`,
        parameters: z.object({}).passthrough(),
        capabilities: [ToolCapability.MCP],
        source: 'mcp',
        mcpServer: serverName,
        execute: async (params: unknown, ctx: ToolContext): Promise<ToolResult> => {
          const args = params as Record<string, unknown>;
          // AD-036: деобфускация в точке потребления — аргументы могут содержать ⟦SYNTH_SECRET_N⟧
          const sessionManager = ctx.extra?.sessionManager as SessionManager | undefined;
          if (sessionManager) {
            const store = new ObfuscationMapStore(sessionManager);
            const restored = await store.restoreForArgs(ctx.sessionId, args);
            return client.callTool(tool.name, restored as Record<string, unknown>);
          }
          return client.callTool(tool.name, args);
        },
        jsonSchema: tool.inputSchema,
      };

      toolRegistry.register(mcpToolDef);

      registeredNames.push(fullName);
    }

    serverEntry.registeredToolNames = registeredNames;
    info(
      `MCP`,
      `Зарегистрировано ${registeredNames.length} инструментов сервера "${serverName}"`,
    );
    return registeredNames;
  }

  async deregisterTools(serverName: string, toolRegistry: ToolRegistry): Promise<void> {
    const entry = this._servers.get(serverName);
    if (entry) {
      for (const name of entry.registeredToolNames) {
        toolRegistry.deregister(name);
      }
      entry.registeredToolNames = [];
    } else {
      // Сервер не в кеше — пробуем удалить по префиксу
      const prefix = `${serverName}_`;
      const allTools = toolRegistry.list();
      for (const tool of allTools) {
        if (tool.name.startsWith(prefix)) {
          toolRegistry.deregister(tool.name);
        }
      }
    }
  }

  async ensureToolsLoaded(
    serverNames: string[],
    toolRegistry: ToolRegistry,
  ): Promise<void> {
    for (const name of serverNames) {
      if (this._isCircuitBroken(name)) continue;
      try {
        await this.connectServer(name);
        await this.registerTools(name, toolRegistry);
      } catch (err) {
        warning(`MCP`, `Не удалось загрузить инструменты сервера "${name}": ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  async refreshServer(name: string, toolRegistry: ToolRegistry): Promise<void> {
    await this.deregisterTools(name, toolRegistry);
    await this.disconnectServer(name);
    try {
      await this.connectServer(name);
      await this.registerTools(name, toolRegistry);
    } catch (err) {
      warning(`MCP`, `Не удалось обновить сервер "${name}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async disconnectAll(): Promise<void> {
    const names = [...this._servers.keys()];
    for (const name of names) {
      await this.disconnectServer(name);
    }
  }

  private _recordError(serverName: string): void {
    const entry = this._servers.get(serverName);
    if (entry) {
      entry.errorCount++;
      entry.lastErrorTime = Date.now();
    }
  }

  /** Чистая проверка «сервер сейчас заблокирован» (без сброса счётчика и логов). */
  private _isCircuitOpen(serverName: string): boolean {
    const entry = this._servers.get(serverName);
    if (!entry || entry.errorCount < CIRCUIT_BREAKER_THRESHOLD) return false;
    return Date.now() - entry.lastErrorTime < CIRCUIT_BREAKER_COOLDOWN_MS;
  }

  private _isCircuitBroken(serverName: string): boolean {
    const entry = this._servers.get(serverName);
    if (!entry || entry.errorCount < CIRCUIT_BREAKER_THRESHOLD) return false;

    const elapsed = Date.now() - entry.lastErrorTime;
    if (elapsed < CIRCUIT_BREAKER_COOLDOWN_MS) {
      warning(
        `MCP`,
        `Сервер "${serverName}" заблокирован circuit breaker'ом (${entry.errorCount} ошибок, осталось ~${Math.ceil((CIRCUIT_BREAKER_COOLDOWN_MS - elapsed) / 1000)}c)`,
      );
      return true;
    }

    // Cooldown истёк — сбрасываем счётчик
    entry.errorCount = 0;
    return false;
  }

  /**
   * Вызывает инструмент MCP-сервера по полному имени (serverName_toolName).
   */
  async callTool(
    fullName: string,
    args: Record<string, unknown>,
  ): Promise<{ content: string; isError: boolean }> {
    const underscoreIdx = fullName.indexOf('_');
    if (underscoreIdx === -1) {
      return { content: `Неизвестный формат имени MCP-инструмента: "${fullName}"`, isError: true };
    }

    const serverName = fullName.slice(0, underscoreIdx);
    const toolName = fullName.slice(underscoreIdx + 1);

    const entry = this._servers.get(serverName);
    if (!entry || !entry.client.isConnected) {
      return { content: `MCP-сервер "${serverName}" не подключён`, isError: true };
    }

    // TODO(AD-036): здесь нет sessionId — деобфускация аргументов невозможна.
    // В основном цикле MCP-тулы вызываются через registerTools() → mcpToolDef.execute(),
    // где деобфускация выполняется на основе ctx.extra.sessionManager.
    return entry.client.callTool(toolName, args);
  }
}

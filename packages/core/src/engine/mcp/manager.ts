import { z } from 'zod';
import type { McpServerConfig, ToolDefinition } from '@synth/shared';
import { ToolCapability } from '@synth/shared';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolContext, ToolResult } from '@synth/shared';
import { McpClient } from './client.js';
import { info, warning, error } from '../../logger.js';

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

  setConfig(servers: Record<string, McpServerConfig>): void {
    this._config = servers;
  }

  getConfig(): Record<string, McpServerConfig> {
    return this._config;
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

  async connectServer(name: string): Promise<void> {
    const config = this._config[name];
    if (!config) {
      throw new Error(`MCP-сервер "${name}" не настроен`);
    }

    const existing = this._servers.get(name);
    if (existing?.client.isConnected) {
      return;
    }

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

      // Проверка на коллизию с built-in инструментами
      if (toolRegistry.get(fullName)) {
        warning(`MCP`, `Инструмент "${fullName}" конфликтует с существующим — пропускаем`);
        continue;
      }

      const mcpToolDef: ToolDefinition = {
        name: fullName,
        description: `[MCP:${serverName}] ${tool.description}`,
        parameters: z.object({}).passthrough(),
        capabilities: [ToolCapability.MCP],
        execute: async (params: unknown, _ctx: ToolContext): Promise<ToolResult> => {
          return client.callTool(tool.name, params as Record<string, unknown>);
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
    const prefixedName = (toolName: string) => `${serverName}_${toolName}`;

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

    return entry.client.callTool(toolName, args);
  }
}

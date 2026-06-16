import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { McpServerConfig } from '@synth/shared';
import { info, warning, error } from '../../logger.js';

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolResult {
  content: string;
  isError: boolean;
}

const DEFAULT_TOOL_TIMEOUT = 120_000;
const DEFAULT_CONNECT_TIMEOUT = 60_000;
const MAX_TOOL_RESULT = 30_000;

export class McpClient {
  private _name: string;
  private _config: McpServerConfig;
  private _client: Client | null = null;
  private _transport: Transport | null = null;
  private _tools: McpToolDef[] = [];
  private _connected = false;
  private _toolTimeout: number;

  constructor(name: string, config: McpServerConfig) {
    this._name = name;
    this._config = config;
    this._toolTimeout = (config.timeout || 120) * 1000;
  }

  get name(): string {
    return this._name;
  }

  get isConnected(): boolean {
    return this._connected && this._client !== null;
  }

  get tools(): McpToolDef[] {
    return this._tools;
  }

  async connect(): Promise<void> {
    if (this._connected) return;

    const connectTimeout = (this._config.connectTimeout || 60) * 1000;

    try {
      if (this._config.type === 'stdio') {
        await this._connectStdio();
      } else {
        await this._connectStreamableHttp();
      }

      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Таймаут подключения к MCP-серверу "${this._name}"`)), connectTimeout),
      );

      const toolsPromise = this._loadTools();
      this._tools = await Promise.race([toolsPromise, timeoutPromise]);
      this._connected = true;
      info(`MCP`, `Подключён сервер "${this._name}", инструментов: ${this._tools.length}`);
    } catch (err) {
      await this._cleanup();
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    await this._cleanup();
    this._tools = [];
    this._connected = false;
    info(`MCP`, `Отключён сервер "${this._name}"`);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    if (!this._client || !this._connected) {
      return { content: `MCP-сервер "${this._name}" не подключён`, isError: true };
    }

    try {
      const timeoutPromise = new Promise<McpToolResult>((_, reject) =>
        setTimeout(() => reject(new Error(`Таймаут вызова инструмента "${name}" (${this._toolTimeout}ms)`)), this._toolTimeout),
      );

      const callPromise = (async (): Promise<McpToolResult> => {
        const result = await this._client!.callTool({ name, arguments: args });

        if (result.isError) {
          const errorText = (result.content as Array<{ type: string; text?: string }>)
            .filter((c) => c.type === 'text' && c.text)
            .map((c) => c.text!)
            .join('\n');
          return {
            content: errorText || 'Инструмент вернул ошибку',
            isError: true,
          };
        }

        const textParts = (result.content as Array<{ type: string; text?: string }>)
          .filter((c) => c.type === 'text' && c.text)
          .map((c) => c.text!);

        let content = textParts.join('\n') || 'Инструмент выполнен (пустой результат)';
        if (content.length > MAX_TOOL_RESULT) {
          content = content.slice(0, MAX_TOOL_RESULT) + `\n\n...(усечено, полный размер: ${content.length} символов)`;
        }

        return {
          content,
          isError: false,
        };
      })();

      return await Promise.race([callPromise, timeoutPromise]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      error(`MCP`, `Ошибка вызова "${name}" на сервере "${this._name}": ${msg}`);
      return { content: `Ошибка: ${msg}`, isError: true };
    }
  }

  private async _connectStdio(): Promise<void> {
    const command = this._config.command;
    if (!command) {
      throw new Error(`MCP-сервер "${this._name}": не указана команда для stdio`);
    }

    const transport = new StdioClientTransport({
      command,
      args: this._config.args || [],
      env: this._config.env || undefined,
    });

    const client = new Client(
      { name: 'synth-core', version: '0.1.0' },
      { capabilities: {} },
    );

    await client.connect(transport);
    this._client = client;
    this._transport = transport;
  }

  private async _connectStreamableHttp(): Promise<void> {
    const url = this._config.url;
    if (!url) {
      throw new Error(`MCP-сервер "${this._name}": не указан URL`);
    }

    const transport = new StreamableHTTPClientTransport(new URL(url));

    const client = new Client(
      { name: 'synth-core', version: '0.1.0' },
      { capabilities: {} },
    );

    await client.connect(transport);
    this._client = client;
    this._transport = transport;
  }

  private async _loadTools(): Promise<McpToolDef[]> {
    if (!this._client) return [];

    try {
      const result = await this._client.listTools();
      return result.tools.map((tool) => ({
        name: tool.name,
        description: tool.description || '',
        inputSchema: tool.inputSchema as Record<string, unknown>,
      }));
    } catch (err) {
      warning(`MCP`, `Не удалось загрузить инструменты сервера "${this._name}": ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  private async _cleanup(): Promise<void> {
    try {
      if (this._client) {
        await this._client.close();
      }
    } catch {
      // игнорируем ошибки при закрытии
    }
    this._client = null;
    this._transport = null;
  }
}

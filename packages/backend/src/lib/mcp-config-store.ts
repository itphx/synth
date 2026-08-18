import { readFile, writeFile } from 'node:fs/promises';
import { load as parseYaml, dump as stringifyYaml } from 'js-yaml';
import type { McpServerConfig } from '@itphx/synth-shared';
import type { McpConfigStore } from '../routes/mcp.js';

export class YamlMcpConfigStore implements McpConfigStore {
  private _configPath: string;
  private _cache: Record<string, McpServerConfig> = {};
  private _loaded = false;

  constructor(configPath: string) {
    this._configPath = configPath;
  }

  getServers(): Record<string, McpServerConfig> {
    return { ...this._cache };
  }

  hasServer(name: string): boolean {
    return name in this._cache;
  }

  getServer(name: string): McpServerConfig | undefined {
    return this._cache[name];
  }

  async load(): Promise<void> {
    if (this._loaded) return;
    try {
      const content = await readFile(this._configPath, 'utf-8');
      const config = parseYaml(content) as Record<string, unknown> | undefined;
      const mcpSection = (config?.mcp as Record<string, unknown>) || {};
      const servers = (mcpSection.servers as Record<string, McpServerConfig>) || {};
      this._cache = servers;
    } catch {
      this._cache = {};
    }
    this._loaded = true;
  }

  async addServer(name: string, config: McpServerConfig): Promise<void> {
    await this.load();
    this._cache[name] = config;
    await this._saveConfig();
  }

  async updateServer(name: string, config: McpServerConfig): Promise<void> {
    await this.load();
    this._cache[name] = config;
    await this._saveConfig();
  }

  async deleteServer(name: string): Promise<void> {
    await this.load();
    delete this._cache[name];
    await this._saveConfig();
  }

  private async _saveConfig(): Promise<void> {
    let fullConfig: Record<string, unknown> = {};
    try {
      const content = await readFile(this._configPath, 'utf-8');
      fullConfig = (parseYaml(content) as Record<string, unknown>) || {};
    } catch {
      // файла нет — создаём с нуля
    }

    fullConfig.mcp = { servers: this._cache };

    const yamlStr = stringifyYaml(fullConfig, {
      indent: 2,
      lineWidth: 120,
      noRefs: true,
    });

    await writeFile(this._configPath, yamlStr, 'utf-8');
  }
}

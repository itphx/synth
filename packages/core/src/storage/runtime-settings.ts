import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { atomicWrite, AsyncLock } from '@synth/shared';
import type { McpServerToolSettings } from '@synth/shared';

export interface RuntimeSettings {
  /** Рабочий каталог по умолчанию, заданный через UI (раздел «Проекты»). */
  workspace?: string;
  /** Глобальные настройки доступности MCP-серверов по режимам plan/act. */
  mcpServers?: Record<string, McpServerToolSettings>;
}

/**
 * Runtime-настройки приложения (AD-005).
 *
 * Хранятся одним JSON-файлом `{dataDir}/settings.json`. Запись атомарная:
 * временный файл `.tmp.{uuid}` → `rename()`. Значения переживают рестарт
 * сервера: при старте `createStandaloneApp` читает workspace отсюда и
 * применяет в приоритете над config.yaml.
 */
export class RuntimeSettingsStore {
  private _locks = new Map<string, AsyncLock>();

  constructor(private _opts: { dataDir: string }) {}

  private _filePath(): string {
    return join(this._opts.dataDir, 'settings.json');
  }

  private _getLock(key: string): AsyncLock {
    if (!this._locks.has(key)) {
      this._locks.set(key, new AsyncLock());
    }
    return this._locks.get(key)!;
  }

  async load(): Promise<RuntimeSettings> {
    try {
      const data = await readFile(this._filePath(), 'utf-8');
      return JSON.parse(data) as RuntimeSettings;
    } catch {
      return {};
    }
  }

  async getWorkspace(): Promise<string | undefined> {
    const settings = await this.load();
    return settings.workspace;
  }

  async setWorkspace(workspace: string): Promise<void> {
    await this._update((current) => ({ ...current, workspace }));
  }

  async getMcpSettings(): Promise<Record<string, McpServerToolSettings>> {
    const settings = await this.load();
    return settings.mcpServers ?? {};
  }

  async setMcpSettings(servers: Record<string, McpServerToolSettings>): Promise<void> {
    await this._update((current) => ({ ...current, mcpServers: servers }));
  }

  private async _update(mutate: (current: RuntimeSettings) => RuntimeSettings): Promise<void> {
    const path = this._filePath();
    const lock = this._getLock('settings');

    await lock.acquire();
    try {
      const current = await this.load();
      const next = mutate(current);
      await mkdir(dirname(path), { recursive: true });
      const data = JSON.stringify(next, null, 2);
      await atomicWrite(
        (p, d) => writeFile(p, d, 'utf-8'),
        (o, n) => rename(o, n),
        path,
        data,
      );
    } finally {
      lock.release();
    }
  }
}

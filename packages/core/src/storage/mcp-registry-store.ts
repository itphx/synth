import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { McpServerConfig, McpRegistryEntry, McpRegistryAuthor, McpRegistryOrigin, McpRegistryTrust } from '@itphx/synth-shared';
import { MCP_REGISTRY_SCHEMA_VERSION, generateId, nowISO, AsyncLock, atomicWrite, safeJsonParse } from '@itphx/synth-shared';
import type { McpRegistryRepository } from './ports/mcp-registry-repository.js';

export interface McpRegistryStoreConfig {
  dataDir: string;
}

export interface AddMcpRegistryEntryInput {
  name: string;
  config: McpServerConfig;
  origin: McpRegistryOrigin;
  author?: McpRegistryAuthor | null;
  trust?: McpRegistryTrust;
  /** Системный мастер-флаг (дефолт `true`). */
  enabled?: boolean;
  /** Сид «включён по умолчанию для новых проектов». */
  enabledByDefault?: boolean;
  /** Явный id (для миграций/детерминированного сида); иначе генерируется. */
  id?: string;
}

export interface UpdateMcpRegistryEntryInput {
  name?: string;
  config?: McpServerConfig;
  /** Системный мастер-флаг. */
  enabled?: boolean;
  enabledByDefault?: boolean;
  trust?: McpRegistryTrust;
  origin?: McpRegistryOrigin;
}

interface RegistryFile {
  schemaVersion: number;
  entries: McpRegistryEntry[];
}

/**
 * ADR-071 §2.5: единый реестр MCP-серверов.
 *
 * Хранится одним JSON-файлом `{dataDir}/mcp/registry.json` (ADR-005, атомарная
 * запись tmp→rename). Логическая модель PG-ready (ADR-097): плоские записи со
 * стабильным `id`, `schemaVersion`, timestamps; instance/пользовательские
 * записи различаются полем `origin`.
 *
 * Instance-серверы из `config.mcp.servers` подтягиваются в реестр при старте
 * (`seedFromConfig`) — без дублирования по имени.
 */
export class McpRegistryStore implements McpRegistryRepository {
  private _lock = new AsyncLock();

  constructor(private _config: McpRegistryStoreConfig) {}

  private _filePath(): string {
    return join(this._config.dataDir, 'mcp', 'registry.json');
  }

  private async _load(): Promise<RegistryFile> {
    try {
      const raw = await readFile(this._filePath(), 'utf-8');
      const parsed = safeJsonParse<RegistryFile | null>(raw, null);
      if (!parsed || !Array.isArray(parsed.entries)) {
        return { schemaVersion: MCP_REGISTRY_SCHEMA_VERSION, entries: [] };
      }
      return {
        schemaVersion: parsed.schemaVersion ?? MCP_REGISTRY_SCHEMA_VERSION,
        // ADR-071 §2.4: нормализация legacy-записей (без `enabled` — мастер включён).
        entries: parsed.entries.map((e) => ({
          ...e,
          enabled: e.enabled !== false,
          enabledByDefault: e.enabledByDefault === true,
        })),
      };
    } catch {
      return { schemaVersion: MCP_REGISTRY_SCHEMA_VERSION, entries: [] };
    }
  }

  private async _save(file: RegistryFile): Promise<void> {
    const path = this._filePath();
    await mkdir(dirname(path), { recursive: true });
    const data = JSON.stringify({ schemaVersion: MCP_REGISTRY_SCHEMA_VERSION, entries: file.entries }, null, 2);
    await atomicWrite(
      (p, d) => writeFile(p, d, 'utf-8'),
      (o, n) => rename(o, n),
      path,
      data,
    );
  }

  async list(): Promise<McpRegistryEntry[]> {
    const file = await this._load();
    return [...file.entries].sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(id: string): Promise<McpRegistryEntry | null> {
    const file = await this._load();
    return file.entries.find((e) => e.id === id) ?? null;
  }

  async getByName(name: string): Promise<McpRegistryEntry | null> {
    const file = await this._load();
    return file.entries.find((e) => e.name === name) ?? null;
  }

  async add(input: AddMcpRegistryEntryInput): Promise<McpRegistryEntry> {
    await this._lock.acquire();
    try {
      const file = await this._load();
      if (file.entries.some((e) => e.name === input.name)) {
        throw new Error(`MCP-сервер "${input.name}" уже существует в реестре`);
      }
      const now = nowISO();
      const entry: McpRegistryEntry = {
        schemaVersion: MCP_REGISTRY_SCHEMA_VERSION,
        id: input.id ?? generateId(),
        name: input.name,
        config: input.config,
        origin: input.origin,
        author: input.author ?? null,
        trust: input.trust ?? (input.origin === 'instance' ? 'builtin' : 'community'),
        enabled: input.enabled ?? true,
        enabledByDefault: input.enabledByDefault ?? input.config.enabledByDefault ?? false,
        createdAt: now,
        updatedAt: now,
      };
      file.entries.push(entry);
      await this._save(file);
      return entry;
    } finally {
      this._lock.release();
    }
  }

  async update(id: string, patch: UpdateMcpRegistryEntryInput): Promise<McpRegistryEntry | null> {
    await this._lock.acquire();
    try {
      const file = await this._load();
      const index = file.entries.findIndex((e) => e.id === id);
      if (index === -1) return null;

      const current = file.entries[index]!;
      if (patch.name && patch.name !== current.name && file.entries.some((e) => e.name === patch.name)) {
        throw new Error(`MCP-сервер "${patch.name}" уже существует в реестре`);
      }

      const updated: McpRegistryEntry = {
        ...current,
        name: patch.name ?? current.name,
        config: patch.config ?? current.config,
        origin: patch.origin ?? current.origin,
        trust: patch.trust ?? current.trust,
        enabled: patch.enabled ?? current.enabled,
        enabledByDefault: patch.enabledByDefault ?? current.enabledByDefault,
        schemaVersion: MCP_REGISTRY_SCHEMA_VERSION,
        updatedAt: nowISO(),
      };
      file.entries[index] = updated;
      await this._save(file);
      return updated;
    } finally {
      this._lock.release();
    }
  }

  async remove(id: string): Promise<boolean> {
    await this._lock.acquire();
    try {
      const file = await this._load();
      const next = file.entries.filter((e) => e.id !== id);
      if (next.length === file.entries.length) return false;
      file.entries = next;
      await this._save(file);
      return true;
    } finally {
      this._lock.release();
    }
  }

  /**
   * Сид instance-серверов из `config.mcp.servers`. Существующие записи по имени
   * не дублируются. Возвращает число добавленных записей.
   */
  async seedFromConfig(servers: Record<string, McpServerConfig>): Promise<number> {
    await this._lock.acquire();
    try {
      const file = await this._load();
      let added = 0;
      for (const [name, config] of Object.entries(servers)) {
        if (file.entries.some((e) => e.name === name)) continue;
        const now = nowISO();
        file.entries.push({
          schemaVersion: MCP_REGISTRY_SCHEMA_VERSION,
          id: generateId(),
          name,
          config,
          origin: 'instance',
          author: null,
          trust: 'builtin',
          enabled: config.enabled !== false,
          enabledByDefault: config.enabledByDefault ?? false,
          createdAt: now,
          updatedAt: now,
        });
        added++;
      }
      if (added > 0) await this._save(file);
      return added;
    } finally {
      this._lock.release();
    }
  }

  /** Актуальный набор конфигов для `McpManager.setConfig` (имя → конфиг). */
  async toServerConfigMap(): Promise<Record<string, McpServerConfig>> {
    const entries = await this.list();
    const map: Record<string, McpServerConfig> = {};
    for (const entry of entries) {
      map[entry.name] = entry.config;
    }
    return map;
  }

  /** Карта origin для `McpManager.setServerOrigins` (имя → instance|user). */
  async toOriginMap(): Promise<Record<string, McpRegistryOrigin>> {
    const entries = await this.list();
    const map: Record<string, McpRegistryOrigin> = {};
    for (const entry of entries) {
      map[entry.name] = entry.origin;
    }
    return map;
  }

  /** Карта trust для `McpManager.setServerTrusts` (имя → builtin|community). */
  async toTrustMap(): Promise<Record<string, McpRegistryTrust>> {
    const entries = await this.list();
    const map: Record<string, McpRegistryTrust> = {};
    for (const entry of entries) {
      map[entry.name] = entry.trust;
    }
    return map;
  }

  /** ADR-071 §2.5: карта авторов для `McpManager.setServerAuthors` (имя → автор). */
  async toAuthorMap(): Promise<Record<string, McpRegistryAuthor>> {
    const entries = await this.list();
    const map: Record<string, McpRegistryAuthor> = {};
    for (const entry of entries) {
      if (entry.author) map[entry.name] = entry.author;
    }
    return map;
  }

  /**
   * ADR-071 §2.4: instance-серверы, включённые по умолчанию (`enabledByDefault`)
   * для `McpManager.setDefaultServers`. Пользовательские записи не входят.
   */
  async toDefaultServers(): Promise<string[]> {
    const entries = await this.list();
    return entries
      .filter((e) => e.origin === 'instance' && e.enabledByDefault)
      .map((e) => e.name);
  }

  /**
   * ADR-071 §2.5: все карты для `McpManager` за одно чтение реестра (вместо
   * пяти независимых `list()` — readFile+parse+sort на каждую мутацию).
   */
  async toManagerMaps(): Promise<{
    servers: Record<string, McpServerConfig>;
    origins: Record<string, McpRegistryOrigin>;
    trusts: Record<string, McpRegistryTrust>;
    authors: Record<string, McpRegistryAuthor>;
    systemEnabled: Record<string, boolean>;
    defaults: string[];
  }> {
    const entries = await this.list();
    const servers: Record<string, McpServerConfig> = {};
    const origins: Record<string, McpRegistryOrigin> = {};
    const trusts: Record<string, McpRegistryTrust> = {};
    const authors: Record<string, McpRegistryAuthor> = {};
    const systemEnabled: Record<string, boolean> = {};
    const defaults: string[] = [];
    for (const entry of entries) {
      servers[entry.name] = entry.config;
      origins[entry.name] = entry.origin;
      trusts[entry.name] = entry.trust;
      systemEnabled[entry.name] = entry.enabled !== false;
      if (entry.author) authors[entry.name] = entry.author;
      if (entry.origin === 'instance' && entry.enabledByDefault) defaults.push(entry.name);
    }
    return { servers, origins, trusts, authors, systemEnabled, defaults };
  }
}

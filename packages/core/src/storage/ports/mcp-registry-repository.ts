import type {
  McpRegistryAuthor,
  McpRegistryEntry,
  McpRegistryOrigin,
  McpRegistryTrust,
  McpServerConfig,
} from '@itphx/synth-shared';
import type {
  AddMcpRegistryEntryInput,
  UpdateMcpRegistryEntryInput,
} from '../mcp-registry-store.js';

/** Сводные карты реестра для `McpManager` — из одного чтения (`toManagerMaps`). */
export interface McpRegistryManagerMaps {
  servers: Record<string, McpServerConfig>;
  origins: Record<string, McpRegistryOrigin>;
  trusts: Record<string, McpRegistryTrust>;
  authors: Record<string, McpRegistryAuthor>;
  systemEnabled: Record<string, boolean>;
  defaults: string[];
}

/**
 * Порт единого реестра MCP-серверов (ADR-071 §2.5, реализация — `McpRegistryStore`).
 */
export interface McpRegistryRepository {
  list(): Promise<McpRegistryEntry[]>;
  get(id: string): Promise<McpRegistryEntry | null>;
  /** Поиск записи по имени. @future-backend — уникальный индекс по name. */
  getByName(name: string): Promise<McpRegistryEntry | null>;
  add(input: AddMcpRegistryEntryInput): Promise<McpRegistryEntry>;
  update(id: string, patch: UpdateMcpRegistryEntryInput): Promise<McpRegistryEntry | null>;
  remove(id: string): Promise<boolean>;
  /** Идемпотентный сид instance-серверов из `config.mcp.servers`; число добавленных. */
  seedFromConfig(servers: Record<string, McpServerConfig>): Promise<number>;
  toServerConfigMap(): Promise<Record<string, McpServerConfig>>;
  toOriginMap(): Promise<Record<string, McpRegistryOrigin>>;
  toTrustMap(): Promise<Record<string, McpRegistryTrust>>;
  toAuthorMap(): Promise<Record<string, McpRegistryAuthor>>;
  toDefaultServers(): Promise<string[]>;
  toManagerMaps(): Promise<McpRegistryManagerMaps>;
}

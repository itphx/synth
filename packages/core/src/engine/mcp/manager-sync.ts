/**
 * Синхронизация менеджера MCP с единым реестром (ADR-071 §2.5, ADR-105 Ф4).
 *
 * Реестр — **источник истины** для конфигурации серверов в обоих режимах
 * (standalone и managed): менеджер получает из него карты
 * (`servers`/`origins`/`trusts`/`authors`/`defaults`/`systemEnabled`). После
 * любой правки записи реестра (в т.ч. привязки внешнего доступа к
 * коннектору — ADR-105 §5) менеджер должен получить свежий конфиг, иначе
 * клиент остался бы со старым (без `auth: { kind: 'credential' }`).
 *
 * В standalone серверы из `config.mcpServers` сидируются в реестр при старте
 * (`seedFromConfig`), поэтому перечитывание карт реестра **не стирает** их:
 * они уже в реестре как instance-записи.
 *
 * Единственная реализация синхронизации — здесь: и реестр-MCP роуты, и
 * привязка доступа используют один и тот же вызов.
 */
import type { McpRegistryRepository } from '../../storage/ports/mcp-registry-repository.js';
import type { McpManager } from './manager.js';

/**
 * Перечитать реестр MCP и применить его карты к менеджеру.
 *
 * Реестр — источник истины в обоих режимах (standalone/managed), поэтому
 * синхронизацией пользуются оба.
 */
export async function syncMcpManagerFromRegistry(
  manager: McpManager,
  registry: McpRegistryRepository,
): Promise<void> {
  const maps = await registry.toManagerMaps();
  manager.setConfig(maps.servers);
  manager.setServerOrigins(maps.origins);
  manager.setServerTrusts(maps.trusts);
  manager.setServerAuthors(maps.authors);
  manager.setDefaultServers(maps.defaults);
  manager.setServerSystemEnabled(maps.systemEnabled);
}

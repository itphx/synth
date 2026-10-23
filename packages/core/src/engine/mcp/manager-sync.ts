/**
 * Синхронизация менеджера MCP с единым реестром (ADR-071 §2.5, ADR-105 Ф4).
 *
 * В managed-инстансе **реестр — источник истины** для конфигурации серверов:
 * менеджер получает из него карты (`servers`/`origins`/`trusts`/`authors`/
 * `defaults`/`systemEnabled`). После любой правки записи реестра (в т.ч.
 * привязки внешнего доступа к коннектору — ADR-105 §5) менеджер должен
 * получить свежий конфиг, иначе клиент остался бы со старым (без
 * `auth: { kind: 'credential' }`).
 *
 * Единственная реализация синхронизации — здесь: и реестр-MCP роуты, и
 * привязка доступа используют один и тот же вызов.
 */
import type { McpRegistryRepository } from '../../storage/ports/mcp-registry-repository.js';
import type { McpManager } from './manager.js';

/**
 * Перечитать реестр MCP и применить его карты к менеджеру.
 *
 * Менеджер без реестра (standalone-инстанс, где конфиг серверов приходит из
 * `config.mcpServers`) этой синхронизацией **не** пользуется: там реестр не
 * является источником истины.
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

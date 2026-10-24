/**
 * ADR-105 (Ф4): привязка внешнего доступа к MCP-коннектору.
 *
 * Коннектор ссылается на доступ **по id** (`auth: { kind: 'credential',
 * credentialId }`) — сам токен в реестре не лежит (ADR-105 §5). Здесь — только
 * запись ссылки; право распоряжения доступом проверяется вызывающим
 * (`evaluateCredentialBind`), право изменить запись реестра — тоже вызывающим
 * (автор записи или `ADMIN`).
 */
import type { McpRegistryEntry } from '@itphx/synth-shared';
import type { McpRegistryRepository } from '../../storage/ports/mcp-registry-repository.js';

/** Ошибка привязки (маппится в код ответа вызывающим). */
export class CredentialConnectorBindError extends Error {
  constructor(
    readonly code: 'not_found' | 'forbidden' | 'conflict',
    message: string,
  ) {
    super(message);
    this.name = 'CredentialConnectorBindError';
  }
}
/** Опции привязки доступа к коннектору. */
export interface BindCredentialToConnectorOptions {
  /** Порт реестра MCP (ADR-096). */
  registry: McpRegistryRepository;
  /** id или имя записи реестра. */
  connectorId: string;
  /** id доступа. */
  credentialId: string;
  /** Право изменить запись реестра (автор записи или `ADMIN`). */
  canModify: (entry: McpRegistryEntry) => boolean;
}

/**
 * Привязать доступ к MCP-коннектору: в записи реестра появляется
 * `config.auth = { kind: 'credential', credentialId }`.
 *
 * Запись ищется по id, затем по имени. Коннектора нет → `not_found`; права
 * менять запись нет → `forbidden`.
 */
export async function bindCredentialToConnector(
  opts: BindCredentialToConnectorOptions,
): Promise<void> {
  const entry =
    (await opts.registry.get(opts.connectorId)) ??
    (await opts.registry.getByName(opts.connectorId));
  if (!entry) {
    throw new CredentialConnectorBindError(
      'not_found',
      `MCP-коннектор «${opts.connectorId}» не найден`,
    );
  }
  if (!opts.canModify(entry)) {
    throw new CredentialConnectorBindError(
      'forbidden',
      'Изменять запись реестра MCP может автор записи или ADMIN',
    );
  }
  await opts.registry.update(entry.id, {
    config: { ...entry.config, auth: { kind: 'credential', credentialId: opts.credentialId } },
  });
}

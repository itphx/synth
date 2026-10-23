/**
 * ADR-105 (Ф3): миграция существующих записей реестра MCP — plaintext-секрет
 * из заголовка переносится в слой внешних доступов.
 *
 * Зачем: до Ф3 коннектор мог нести `Authorization: Bearer …` прямо в `headers`.
 * Такой заголовок попадал в файл реестра, в бэкап и в выдачу реестра. Теперь
 * запись реестра с таким заголовком **не принимается** (ADR-105 §5), а
 * существующие записи переводятся на новую схему: значение заголовка
 * становится токеном доступа (`ExternalCredential`), заголовок удаляется, а
 * коннектор получает ссылку `auth: { kind: 'credential', credentialId }`.
 *
 * Миграция **одноразовая и идемпотентная**:
 * - запись, у которой уже есть `auth.kind='credential'`, не трогается;
 * - запись без запрещённых заголовков не трогается;
 * - повторный прогон ничего не меняет (заголовка уже нет).
 *
 * Значение заголовка в лог/отчёт не попадает: отчёт содержит только имена
 * коннекторов и id созданных доступов.
 */
import type { ExternalCredentialOwner } from '@itphx/synth-shared';
import { findForbiddenMcpSecretHeaders } from '@itphx/synth-shared';
import type { McpRegistryRepository } from './ports/mcp-registry-repository.js';
import type { ExternalCredentialRepository } from './ports/external-credential-repository.js';
import type { McpServerConfig } from '@itphx/synth-shared';

/** Зависимости миграции. */
export interface MigrateMcpRegistrySecretsDeps {
  /** Реестр MCP (записи читаются и обновляются). */
  registry: McpRegistryRepository;
  /** Порт внешних доступов (единственный путь записи токена). */
  credentials: ExternalCredentialRepository;
  /**
   * Владелец создаваемых доступов. По умолчанию — инстансный
   * (`{ kind: 'instance', id: 'instance' }`): перенос выполняет оператор
   * инстанса, доступ становится общим для инстанса.
   */
  owner?: ExternalCredentialOwner;
  /** Кто выполняет миграцию (id пользователя инстанса). */
  createdBy?: string;
}

/** Отчёт о миграции (без секретов). */
export interface MigrateMcpRegistrySecretsResult {
  /** Сколько записей переведено на доступ. */
  migrated: number;
  /** Имена коннекторов, которые переведены. */
  connectors: string[];
  /** id созданных доступов (по порядку коннекторов). */
  credentialIds: string[];
  /** Записи, которые пропущены (уже с `auth` или без запрещённых заголовков). */
  skipped: number;
}

/** Значение заголовка доступа: `Authorization: Bearer <token>` → `<token>`. */
function extractTokenValue(headerValue: string): string {
  const trimmed = headerValue.trim();
  const bearer = /^bearer\s+(.+)$/i.exec(trimmed);
  return (bearer ? bearer[1]! : trimmed).trim();
}

/** Найти в заголовках запрещённые (секретные) — с их значениями. */
function secretHeaderEntries(config: McpServerConfig): Array<{ name: string; value: string }> {
  const headers = config.headers ?? {};
  const forbidden = new Set(findForbiddenMcpSecretHeaders(headers));
  return Object.entries(headers)
    .filter(([name]) => forbidden.has(name.trim().toLowerCase()))
    .map(([name, value]) => ({ name, value }));
}

/**
 * Перенос plaintext-секретов из заголовков реестра MCP в слой доступов.
 *
 * Значение заголовка `Authorization` (с префиксом `Bearer `) становится
 * access-токеном доступа; остальные секретные заголовки (`x-api-key`,
 * `cookie`, `proxy-authorization`) переносятся как есть (в access-токен не
 * ложатся — они не bearer-токены; для них перенос возможен только вручную,
 * поэтому в отчёт попадает предупреждение).
 */
export async function migrateMcpRegistrySecrets(
  deps: MigrateMcpRegistrySecretsDeps,
): Promise<MigrateMcpRegistrySecretsResult> {
  const owner = deps.owner ?? { kind: 'instance', id: 'instance' };
  const createdBy = deps.createdBy ?? 'system';
  const entries = await deps.registry.list();
  const result: MigrateMcpRegistrySecretsResult = {
    migrated: 0,
    connectors: [],
    credentialIds: [],
    skipped: 0,
  };

  for (const entry of entries) {
    if (entry.config.auth?.kind === 'credential') {
      result.skipped += 1;
      continue;
    }
    const secrets = secretHeaderEntries(entry.config);
    const authEntry = secrets.find((s) => s.name.trim().toLowerCase() === 'authorization');
    if (!authEntry) {
      // Переносится только bearer-токен из `Authorization`; остальные
      // секретные заголовки (`x-api-key`, `cookie`) — вручную.
      result.skipped += 1;
      continue;
    }
    const token = extractTokenValue(authEntry.value);
    if (!token) {
      result.skipped += 1;
      continue;
    }

    const meta = await deps.credentials.create({
      provider: entry.id || entry.name,
      connectorId: entry.id,
      clientId: 'mcp',
      owner,
      accessToken: token,
      createdBy,
    });

    const headers = { ...(entry.config.headers ?? {}) };
    for (const secret of secrets) delete headers[secret.name];
    // Конфиг коннектора без заголовков с секретами: `headers` — целиком
    // пересобирается из очищенных значений (пустой набор не задаём вовсе).
    const config: McpServerConfig = { ...entry.config };
    delete config.headers;
    if (Object.keys(headers).length > 0) config.headers = headers;

    await deps.registry.update(entry.id, {
      config: {
        ...config,
        auth: { kind: 'credential', credentialId: meta.id },
      },
    });

    result.migrated += 1;
    result.connectors.push(entry.name);
    result.credentialIds.push(meta.id);
  }

  return result;
}

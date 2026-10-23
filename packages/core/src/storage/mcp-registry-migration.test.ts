/**
 * ADR-105 (Ф3): миграция plaintext-секретов из заголовков реестра MCP в слой
 * внешних доступов (`ExternalCredential`).
 *
 * Проверяем:
 * - `Authorization: Bearer …` переносится в доступ, заголовок удаляется, у
 *   коннектора появляется `auth: { kind: 'credential', credentialId }`;
 * - миграция идемпотентна (повторный прогон ничего не меняет);
 * - в отчёте о миграции нет секретов.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { McpRegistryEntry } from '@itphx/synth-shared';
import { McpRegistryStore } from './mcp-registry-store.js';
import { migrateMcpRegistrySecrets } from './mcp-registry-migration.js';
import { MemoryExternalCredentialRepository } from './memory/external-credentials.js';

const TOKEN = 'legacy-access-token-value';

const NOW = '2026-01-01T00:00:00.000Z';

function legacyEntry(overrides: Partial<McpRegistryEntry> = {}): McpRegistryEntry {
  return {
    schemaVersion: 1,
    id: 'srv-1',
    name: 'legacy',
    config: {
      type: 'sse',
      url: 'https://mcp.example.com/mcp',
      headers: { authorization: `Bearer ${TOKEN}`, 'x-tenant': 'acme' },
    },
    origin: 'instance',
    author: null,
    trust: 'builtin',
    enabled: true,
    enabledByDefault: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

/** Записать реестр в legacy-виде (до Ф3) — так он выглядит на диске у старого инстанса. */
async function writeLegacyRegistry(dataDir: string, entries: McpRegistryEntry[]): Promise<void> {
  const path = join(dataDir, 'mcp', 'registry.json');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ schemaVersion: 1, entries }, null, 2), 'utf-8');
}

describe('migrateMcpRegistrySecrets (ADR-105 Ф3)', () => {
  let dataDir: string;
  let store: McpRegistryStore;
  let credentials: MemoryExternalCredentialRepository;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'synth-mcp-migration-'));
    store = new McpRegistryStore({ dataDir });
    credentials = new MemoryExternalCredentialRepository();
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('Bearer-токен переносится в доступ, коннектор получает auth.credentialId', async () => {
    await writeLegacyRegistry(dataDir, [legacyEntry()]);

    const result = await migrateMcpRegistrySecrets({ registry: store, credentials });

    expect(result.migrated).toBe(1);
    expect(result.connectors).toEqual(['legacy']);
    expect(result.credentialIds).toHaveLength(1);

    const entry = await store.get('srv-1');
    expect(entry?.config.headers?.authorization).toBeUndefined();
    expect(entry?.config.headers?.['x-tenant']).toBe('acme');
    expect(entry?.config.auth).toEqual({ kind: 'credential', credentialId: result.credentialIds[0] });

    const revealed = await credentials.reveal(result.credentialIds[0]!);
    expect(revealed?.accessToken).toBe(TOKEN);
  });

  it('миграция идемпотентна: повторный прогон ничего не меняет', async () => {
    await writeLegacyRegistry(dataDir, [legacyEntry()]);

    const first = await migrateMcpRegistrySecrets({ registry: store, credentials });
    const second = await migrateMcpRegistrySecrets({ registry: store, credentials });

    expect(first.migrated).toBe(1);
    expect(second.migrated).toBe(0);
    expect(second.skipped).toBe(1);
    expect(await credentials.list()).toHaveLength(1);

    const entry = await store.get('srv-1');
    expect(entry?.config.auth?.credentialId).toBe(first.credentialIds[0]);
  });

  it('в отчёте о миграции нет секретов', async () => {
    await writeLegacyRegistry(dataDir, [legacyEntry()]);

    const result = await migrateMcpRegistrySecrets({ registry: store, credentials });

    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(JSON.stringify(result)).not.toContain('Bearer');
  });

  it('запись без секретных заголовков и запись с готовым auth пропускаются', async () => {
    await writeLegacyRegistry(dataDir, [
      legacyEntry({
        id: 'srv-clean',
        name: 'clean',
        config: { type: 'sse', url: 'https://mcp.example.com/mcp', headers: { 'x-tenant': 'acme' } },
      }),
      legacyEntry({
        id: 'srv-auth',
        name: 'with-auth',
        config: {
          type: 'sse',
          url: 'https://mcp.example.com/mcp',
          auth: { kind: 'credential', credentialId: 'cred-existing' },
        },
      }),
    ]);

    const result = await migrateMcpRegistrySecrets({ registry: store, credentials });

    expect(result.migrated).toBe(0);
    expect(result.skipped).toBe(2);
    expect(await credentials.list()).toHaveLength(0);
  });

  it('доступ создаётся с владельцем инстанса и привязкой к коннектору', async () => {
    await writeLegacyRegistry(dataDir, [legacyEntry()]);

    const result = await migrateMcpRegistrySecrets({ registry: store, credentials });
    const meta = await credentials.get(result.credentialIds[0]!);

    expect(meta?.owner).toEqual({ kind: 'instance', id: 'instance' });
    expect(meta?.connectorId).toBe('srv-1');
    expect(meta?.secretMask).not.toContain(TOKEN);
  });
});

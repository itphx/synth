/**
 * ADR-105 (Ф3): plaintext-секреты в заголовках MCP-коннектора запрещены.
 *
 * Коннектор ссылается на внешний доступ по id (`auth: { kind: 'credential',
 * credentialId }`), а сам токен в реестре/конфиге не лежит. Проверяем:
 * - запись/обновление с `authorization`/`x-api-key`/`cookie` → отказ с кодом
 *   `MCP_SECRET_HEADER_FORBIDDEN` (значение секрета в тексте ошибки нет);
 * - прочие заголовки проходят;
 * - сид из `config.yaml` с секретом → заголовок снят, в лог уходит **только
 *   имя** заголовка.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MCP_SECRET_HEADER_ERROR_CODE, type McpServerConfig } from '@itphx/synth-shared';
import {
  McpRegistryStore,
  McpRegistryValidationError,
  assertNoMcpSecretHeaders,
  stripMcpSecretHeaders,
} from './mcp-registry-store.js';

const SECRET = 'super-secret-token-value';
const SECRET_HEADERS = ['authorization', 'x-api-key', 'cookie', 'Proxy-Authorization'];

const configWith = (headers: Record<string, string>): McpServerConfig => ({
  type: 'sse',
  url: 'https://mcp.example.com/mcp',
  headers,
});

describe('McpRegistryStore — запрет plaintext-секретов в заголовках (ADR-105 Ф3)', () => {
  let store: McpRegistryStore;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-mcp-secret-headers-'));
    store = new McpRegistryStore({ dataDir: tmpDir });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('запись с секретным заголовком отклоняется с кодом MCP_SECRET_HEADER_FORBIDDEN', async () => {
    for (const header of SECRET_HEADERS) {
      await expect(
        store.add({
          name: `srv-${header}`,
          config: configWith({ [header]: SECRET }),
          origin: 'user',
        }),
      ).rejects.toBeInstanceOf(McpRegistryValidationError);
    }
    expect(await store.list()).toHaveLength(0);
  });

  it('код ошибки машинно-читаемый, значение секрета в тексте ошибки нет', async () => {
    const error = await store
      .add({ name: 'srv', config: configWith({ authorization: `Bearer ${SECRET}` }), origin: 'user' })
      .then(() => null)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(McpRegistryValidationError);
    expect((error as McpRegistryValidationError).code).toBe(MCP_SECRET_HEADER_ERROR_CODE);
    expect((error as McpRegistryValidationError).message).not.toContain(SECRET);
    expect((error as McpRegistryValidationError).message).toContain('authorization');
  });

  it('обновление записи с секретным заголовком отклоняется', async () => {
    const entry = await store.add({ name: 'srv', config: configWith({ 'x-tenant': 'acme' }), origin: 'user' });

    await expect(
      store.update(entry.id, { config: configWith({ 'x-tenant': 'acme', 'x-api-key': SECRET }) }),
    ).rejects.toBeInstanceOf(McpRegistryValidationError);

    const unchanged = await store.get(entry.id);
    expect(unchanged?.config.headers).toEqual({ 'x-tenant': 'acme' });
  });

  it('прочие заголовки проходят', async () => {
    const entry = await store.add({
      name: 'srv',
      config: configWith({ 'x-tenant': 'acme', accept: 'application/json' }),
      origin: 'user',
    });
    expect(entry.config.headers).toEqual({ 'x-tenant': 'acme', accept: 'application/json' });
  });

  it('assertNoMcpSecretHeaders: пустые/безопасные заголовки проходят, секретные — отказ', () => {
    expect(() => assertNoMcpSecretHeaders({ type: 'sse', url: 'https://x' })).not.toThrow();
    expect(() => assertNoMcpSecretHeaders(configWith({ 'x-tenant': 'acme' }))).not.toThrow();
    expect(() => assertNoMcpSecretHeaders(configWith({ authorization: SECRET }))).toThrow(
      McpRegistryValidationError,
    );
  });

  it('сид из config с секретом — заголовок снят, в лог уходит только имя', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const added = await store.seedFromConfig({
        legacy: configWith({ authorization: `Bearer ${SECRET}`, 'x-tenant': 'acme' }),
      });
      expect(added).toBe(1);

      const entry = await store.getByName('legacy');
      expect(entry?.config.headers).toEqual({ 'x-tenant': 'acme' });
      expect(entry?.config.headers?.authorization).toBeUndefined();

      const logged = warn.mock.calls.map((call) => String(call[0])).join('\n');
      expect(logged).toContain('authorization');
      expect(logged).not.toContain(SECRET);
    } finally {
      warn.mockRestore();
    }
  });

  it('stripMcpSecretHeaders: чистит конфиг, возвращает копию без заголовка', () => {
    const config = configWith({ authorization: SECRET, 'x-tenant': 'acme' });
    const cleaned = stripMcpSecretHeaders(config, 'srv');

    expect(cleaned.headers).toEqual({ 'x-tenant': 'acme' });
    expect(config.headers?.authorization).toBe(SECRET); // исходник не мутируется
  });
});

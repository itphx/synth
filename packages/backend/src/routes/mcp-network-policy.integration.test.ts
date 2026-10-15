// Интеграционный тест ADR-071 §2.3.1: runtime-политика сетевого доступа MCP,
// сохранённая в {dataDir}/settings.json, применяется к McpManager при старте
// (а не только к GET-ответу settings). Без фикса на старте брался config.yaml
// (deny приватных диапазонов), и пользовательский HTTP-сервер на 10.0.0.5
// отклонялся бы, несмотря на runtime allow-политику.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBackendApp } from '../app.js';
import type { BackendAppHandle } from '../app.js';

describe('runtime MCP network policy применяется на старте (ADR-071 §2.3.1)', () => {
  let tmpDir: string;
  let backend: BackendAppHandle;

  const runtimePolicy = { mode: 'allow' as const, list: ['10.0.0.0/8'] };

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-mcp-netpol-'));
    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      join(tmpDir, 'settings.json'),
      JSON.stringify({ mcpNetworkPolicy: runtimePolicy }),
      'utf-8',
    );
    backend = await createBackendApp({ dataDir: tmpDir, authDebug: true });
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('GET /settings/mcp-network-policy совпадает с runtime-значением', async () => {
    const res = await backend.app.request('/api/v2/settings/mcp-network-policy', {
      headers: { Authorization: 'Bearer user-key-456' },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { policy: { mode: string; list: string[] } };
    expect(body.policy).toEqual(runtimePolicy);
  });

  it('менеджер исполняет runtime allow-политику: приватный 10.0.0.5 разрешён', async () => {
    const res = await backend.app.request('/api/v2/mcp/registry', {
      method: 'POST',
      headers: { Authorization: 'Bearer user-key-456', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'private-runtime-ok',
        config: { type: 'sse', url: 'http://10.0.0.5/mcp' },
      }),
    });
    expect(res.status).toBe(201);
  });
});

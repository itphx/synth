import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from './loader.js';

/**
 * AD-023/AD-071: `SYNTH_CONFIG` задаёт явный путь к config.yaml. dev.sh
 * запускает backend с cwd=synth/, поэтому без env `packages/backend/config.yaml`
 * (mcp.servers) не читался и seed реестра MCP был пустым.
 */
describe('loadConfig — SYNTH_CONFIG', () => {
  let dir: string | null = null;

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
      dir = null;
    }
  });

  async function writeConfig(yaml: string): Promise<string> {
    dir = await mkdtemp(join(tmpdir(), 'synth-config-'));
    const path = join(dir, 'config.yaml');
    await writeFile(path, yaml, 'utf-8');
    return path;
  }

  it('читает явный путь из SYNTH_CONFIG, если configPath не передан', async () => {
    const path = await writeConfig(
      'mcp:\n  servers:\n    srv:\n      type: sse\n      url: http://example.com/mcp\n',
    );
    vi.stubEnv('SYNTH_CONFIG', path);

    const cfg = await loadConfig();
    expect(cfg.mcp.servers.srv).toBeDefined();
    expect(cfg.mcp.servers.srv?.url).toBe('http://example.com/mcp');
  });

  it('options.configPath имеет приоритет над SYNTH_CONFIG', async () => {
    const envPath = await writeConfig(
      'mcp:\n  servers:\n    fromEnv:\n      type: sse\n      url: http://env/mcp\n',
    );
    const explicitPath = join(dir!, 'explicit.yaml');
    await writeFile(
      explicitPath,
      'mcp:\n  servers:\n    fromExplicit:\n      type: sse\n      url: http://explicit/mcp\n',
      'utf-8',
    );
    vi.stubEnv('SYNTH_CONFIG', envPath);

    const cfg = await loadConfig({ configPath: explicitPath });
    expect(cfg.mcp.servers.fromExplicit).toBeDefined();
    expect(cfg.mcp.servers.fromEnv).toBeUndefined();
  });
});

/**
 * Аудит F5: `buildAuthConfig` — роли API-ключа (`auth.apiKeyRoles`) и env
 * `SYNTH_API_KEY_ROLES`; дефолт USER, неизвестная роль — ошибка загрузки.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GlobalRole } from '@itphx/synth-shared';
import { loadBackendConfig } from './app-config.js';

// Явный несуществующий путь: конфиг = defaults (+ env), без случайного
// config.yaml из cwd.
const CONFIG_PATH = '/nonexistent/synth-audit-f5.yaml';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('buildAuthConfig — apiKeyRoles', () => {
  it('по умолчанию API-ключ получает USER (не ADMIN)', async () => {
    const cfg = await loadBackendConfig({ configPath: CONFIG_PATH });
    expect(cfg.auth.apiKeyRoles).toEqual([GlobalRole.USER]);
  });

  it('SYNTH_API_KEY_ROLES=ADMIN,USER → роли из env', async () => {
    vi.stubEnv('SYNTH_API_KEY_ROLES', 'ADMIN,USER');
    const cfg = await loadBackendConfig({ configPath: CONFIG_PATH });
    expect(cfg.auth.apiKeyRoles).toEqual([GlobalRole.ADMIN, GlobalRole.USER]);
  });

  it('SYNTH_API_KEY_ROLES=auditor → регистр не важен', async () => {
    vi.stubEnv('SYNTH_API_KEY_ROLES', 'auditor');
    const cfg = await loadBackendConfig({ configPath: CONFIG_PATH });
    expect(cfg.auth.apiKeyRoles).toEqual([GlobalRole.AUDITOR]);
  });

  it('неизвестная роль → ошибка конфигурации (fail-closed)', async () => {
    vi.stubEnv('SYNTH_API_KEY_ROLES', 'ADMIN,ROOT');
    await expect(loadBackendConfig({ configPath: CONFIG_PATH })).rejects.toThrow(/ROOT/);
  });
});

/**
 * F4 (аудит S1): backend/managed-профиль включает LLM-шлюз по умолчанию
 * (обфускация, аудит, rate limit); config.yaml/env/runtime-тумблер перебивают.
 */
describe('loadBackendConfig — дефолт llmGateway.enabled (F4)', () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir) {
      await rm(dir, { recursive: true, force: true });
      dir = null;
    }
  });

  async function writeConfig(yaml: string): Promise<string> {
    dir = await mkdtemp(join(tmpdir(), 'synth-backend-gateway-'));
    const path = join(dir, 'config.yaml');
    await writeFile(path, yaml, 'utf-8');
    return path;
  }

  it('без config.yaml — шлюз включён (backend-профиль)', async () => {
    const cfg = await loadBackendConfig({ configPath: CONFIG_PATH });
    expect(cfg.synth.llmGateway.enabled).toBe(true);
  });

  it('config.yaml с enabled:false — шлюз выключен', async () => {
    const cfg = await loadBackendConfig({
      configPath: await writeConfig('llmGateway:\n  enabled: false\n'),
    });
    expect(cfg.synth.llmGateway.enabled).toBe(false);
  });

  it('SYNTH_LLM_GATEWAY_ENABLED=false — шлюз выключен', async () => {
    vi.stubEnv('SYNTH_LLM_GATEWAY_ENABLED', 'false');
    const cfg = await loadBackendConfig({ configPath: CONFIG_PATH });
    expect(cfg.synth.llmGateway.enabled).toBe(false);
  });

  it('env перебивает config.yaml (true поверх false)', async () => {
    vi.stubEnv('SYNTH_LLM_GATEWAY_ENABLED', 'true');
    const cfg = await loadBackendConfig({
      configPath: await writeConfig('llmGateway:\n  enabled: false\n'),
    });
    expect(cfg.synth.llmGateway.enabled).toBe(true);
  });
});

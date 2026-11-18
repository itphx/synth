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
 * ADR-147: `llmGateway.enabled` включён по **общему** дефолту для всех
 * профилей (ранее — профильный дефолт backend/managed, F4 аудита S1);
 * config.yaml/env/runtime-тумблер перебивают.
 */
describe('loadBackendConfig — llmGateway.enabled (общий дефолт, ADR-147)', () => {
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

  it('без config.yaml — шлюз включён (общий дефолт, не профиль)', async () => {
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

/**
 * ADR-140 Ф2: источник групп пользователя — claim IdP (`SYNTH_OIDC_GROUPS_CLAIM`)
 * и allowlist имён (`SYNTH_OIDC_GROUPS_ALLOW`, csv). Пустой allowlist — групп
 * нет (fail-closed), «принять все» невозможно.
 */
describe('buildAuthConfig — auth.oidc.groups (ADR-140)', () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir) {
      await rm(dir, { recursive: true, force: true });
      dir = null;
    }
  });

  async function writeConfig(yaml: string): Promise<string> {
    dir = await mkdtemp(join(tmpdir(), 'synth-backend-oidc-groups-'));
    const path = join(dir, 'config.yaml');
    await writeFile(path, yaml, 'utf-8');
    return path;
  }

  it('без настройки — claim=groups, allow=[] (групп нет)', async () => {
    vi.stubEnv('SYNTH_OIDC_ENABLED', 'true');
    const cfg = await loadBackendConfig({ configPath: CONFIG_PATH });
    expect(cfg.auth.oidc?.groups).toEqual({ claim: 'groups', allow: [] });
  });

  it('SYNTH_OIDC_GROUPS_CLAIM → имя claim', async () => {
    vi.stubEnv('SYNTH_OIDC_ENABLED', 'true');
    vi.stubEnv('SYNTH_OIDC_GROUPS_CLAIM', 'roles_groups');
    const cfg = await loadBackendConfig({ configPath: CONFIG_PATH });
    expect(cfg.auth.oidc?.groups?.claim).toBe('roles_groups');
  });

  it('SYNTH_OIDC_GROUPS_ALLOW (csv) → allowlist', async () => {
    vi.stubEnv('SYNTH_OIDC_ENABLED', 'true');
    vi.stubEnv('SYNTH_OIDC_GROUPS_ALLOW', 'team-a,team-b');
    const cfg = await loadBackendConfig({ configPath: CONFIG_PATH });
    expect(cfg.auth.oidc?.groups?.allow).toEqual(['team-a', 'team-b']);
  });

  it('SYNTH_OIDC_GROUPS_ALLOW: пробелы обрезаются, пустые элементы отброшены', async () => {
    vi.stubEnv('SYNTH_OIDC_ENABLED', 'true');
    vi.stubEnv('SYNTH_OIDC_GROUPS_ALLOW', ' team-a , , team-b ,');
    const cfg = await loadBackendConfig({ configPath: CONFIG_PATH });
    expect(cfg.auth.oidc?.groups?.allow).toEqual(['team-a', 'team-b']);
  });

  it('config.yaml: auth.oidc.groups используется, когда env не задан', async () => {
    const cfg = await loadBackendConfig({
      configPath: await writeConfig(
        'auth:\n  oidc:\n    enabled: true\n    groups:\n      claim: groups\n      allow:\n        - team-a\n',
      ),
    });
    expect(cfg.auth.oidc?.groups).toEqual({ claim: 'groups', allow: ['team-a'] });
  });

  it('env перебивает config.yaml', async () => {
    vi.stubEnv('SYNTH_OIDC_GROUPS_ALLOW', 'team-b');
    const cfg = await loadBackendConfig({
      configPath: await writeConfig(
        'auth:\n  oidc:\n    enabled: true\n    groups:\n      allow:\n        - team-a\n',
      ),
    });
    expect(cfg.auth.oidc?.groups?.allow).toEqual(['team-b']);
  });

  it('явно пустой env → пустой allowlist (групп нет, fail-closed)', async () => {
    vi.stubEnv('SYNTH_OIDC_GROUPS_ALLOW', '');
    const cfg = await loadBackendConfig({
      configPath: await writeConfig(
        'auth:\n  oidc:\n    enabled: true\n    groups:\n      allow:\n        - team-a\n',
      ),
    });
    expect(cfg.auth.oidc?.groups?.allow).toEqual([]);
  });

  it('oidc выключен — секции oidc нет (групп нет)', async () => {
    const cfg = await loadBackendConfig({ configPath: CONFIG_PATH });
    expect(cfg.auth.oidc).toBeUndefined();
  });
});

/**
 * PROP-136 (слайс 136a): managed-профиль включает аудит исполнений команд по
 * умолчанию (`security.commandAudit.enabled`); standalone остаётся выключенным
 * (дефолт схемы). Env `SYNTH_COMMAND_AUDIT_ENABLED` применяется позже —
 * резолвером `resolveCommandAuditConfig` при создании журнала, не `loadConfig`.
 */
describe('loadBackendConfig — дефолт security.commandAudit.enabled (PROP-136)', () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir) {
      await rm(dir, { recursive: true, force: true });
      dir = null;
    }
  });

  async function writeConfig(yaml: string): Promise<string> {
    dir = await mkdtemp(join(tmpdir(), 'synth-backend-command-audit-'));
    const path = join(dir, 'config.yaml');
    await writeFile(path, yaml, 'utf-8');
    return path;
  }

  it('без config.yaml — журнал исполнений включён (backend-профиль)', async () => {
    const cfg = await loadBackendConfig({ configPath: CONFIG_PATH });
    expect(cfg.synth.security.commandAudit.enabled).toBe(true);
    expect(cfg.synth.security.commandAudit.retentionDays).toBe(30);
    expect(cfg.synth.security.commandAudit.path).toBe('');
  });

  it('config.yaml с security.commandAudit.enabled: false — профиль перебит', async () => {
    const cfg = await loadBackendConfig({
      configPath: await writeConfig('security:\n  commandAudit:\n    enabled: false\n'),
    });
    expect(cfg.synth.security.commandAudit.enabled).toBe(false);
  });

  it('config.yaml задаёт retentionDays и path', async () => {
    const cfg = await loadBackendConfig({
      configPath: await writeConfig(
        'security:\n  commandAudit:\n    retentionDays: 7\n    path: /var/log/synth-commands.jsonl\n',
      ),
    });
    expect(cfg.synth.security.commandAudit.retentionDays).toBe(7);
    expect(cfg.synth.security.commandAudit.path).toBe('/var/log/synth-commands.jsonl');
  });
});

/**
 * PROP-136b (слайс 136b-2a): managed-профиль делает зеркальный чекер команд
 * **fail-closed** по умолчанию (`security.commandPolicy.failMode='closed'`);
 * standalone сохраняет `open` из схемы. Сам чекер при этом выключен
 * (`enabled: false`) — без настройки поведение прежнее.
 */
describe('loadBackendConfig — дефолт security.commandPolicy.failMode (PROP-136b)', () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir) {
      await rm(dir, { recursive: true, force: true });
      dir = null;
    }
  });

  async function writeConfig(yaml: string): Promise<string> {
    dir = await mkdtemp(join(tmpdir(), 'synth-backend-command-policy-'));
    const path = join(dir, 'config.yaml');
    await writeFile(path, yaml, 'utf-8');
    return path;
  }

  it('без config.yaml — failMode closed, чекер выключен, провайдер http', async () => {
    const cfg = await loadBackendConfig({ configPath: CONFIG_PATH });
    expect(cfg.synth.security.commandPolicy).toMatchObject({
      enabled: false,
      provider: 'http',
      failMode: 'closed',
      timeoutMs: 2_000,
      opaPath: '/v1/data/synth/exec/decision',
    });
  });

  it('config.yaml с failMode: open — профиль перебит', async () => {
    const cfg = await loadBackendConfig({
      configPath: await writeConfig('security:\n  commandPolicy:\n    failMode: open\n'),
    });
    expect(cfg.synth.security.commandPolicy.failMode).toBe('open');
  });

  it('enabled: true без url → ошибка загрузки (fail-closed)', async () => {
    await expect(
      loadBackendConfig({
        configPath: await writeConfig('security:\n  commandPolicy:\n    enabled: true\n'),
      }),
    ).rejects.toThrow(/commandPolicy/);
  });
});

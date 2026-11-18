import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from './loader.js';
import { defaultConfig } from './defaults.js';

/**
 * ADR-023/ADR-071: `SYNTH_CONFIG` задаёт явный путь к config.yaml. dev.sh
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

/**
 * ADR-023: env-оверрайды скалярных ключей вложенных секций применяются в
 * `loadConfig` одним местом — поверх config.yaml и ниже CLI-overrides.
 */
describe('loadConfig — env-оверрайды вложенных секций (ADR-023)', () => {
  let dir: string | null = null;

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
      dir = null;
    }
  });

  async function writeConfig(yaml: string): Promise<string> {
    dir = await mkdtemp(join(tmpdir(), 'synth-config-env-'));
    const path = join(dir, 'config.yaml');
    await writeFile(path, yaml, 'utf-8');
    return path;
  }

  const YAML = [
    'events:',
    '  autoBind: false',
    '  ephemeralTtl: "24h"',
    'webhooks:',
    '  timeoutMs: 5000',
    'scheduler:',
    '  tickSec: 90',
    'decision:',
    '  provider: "from-file"',
    '',
  ].join('\n');

  it('env приоритетнее config.yaml; непереопределённые ключи — из файла', async () => {
    const path = await writeConfig(YAML);
    const cfg = await loadConfig({ configPath: path, env: { SYNTH_EVENTS_AUTO_BIND: 'true' } });

    expect(cfg.events.autoBind).toBe(true);
    expect(cfg.events.ephemeralTtl).toBe('24h');
    expect(cfg.webhooks.timeoutMs).toBe(5000);
    expect(cfg.scheduler.tickSec).toBe(90);
    expect(cfg.decision.provider).toBe('from-file');
  });

  it('без env значение берётся из config.yaml, отсутствующее — из defaults', async () => {
    const path = await writeConfig(YAML);
    const cfg = await loadConfig({ configPath: path, env: {} });

    expect(cfg.events.autoBind).toBe(false);
    expect(cfg.scheduler.tickSec).toBe(90);
    // нет ни в файле, ни в env → default
    expect(cfg.webhooks.maxAttempts).toBe(5);
    expect(cfg.events.keyRateLimitPerMinute).toBe(0);
  });

  it('невалидное env-значение → warn + значение из файла', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const path = await writeConfig(YAML);
    const cfg = await loadConfig({
      configPath: path,
      env: { SYNTH_EVENTS_AUTO_BIND: 'maybe', SYNTH_WEBHOOKS_TIMEOUT_MS: 'soon' },
    });

    expect(cfg.events.autoBind).toBe(false);
    expect(cfg.webhooks.timeoutMs).toBe(5000);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('все типы: boolean / number / string', async () => {
    const path = await writeConfig(YAML);
    const cfg = await loadConfig({
      configPath: path,
      env: {
        SYNTH_EVENTS_DECISION_ROUTING: '1',
        SYNTH_EVENTS_JOURNAL_RETENTION_DAYS: '3',
        SYNTH_EVENTS_DEFAULT_MODE: 'ephemeral',
        SYNTH_SCHEDULER_ENABLED: 'FALSE',
        SYNTH_DECISION_ESCALATION_PROVIDER: 'systemone',
      },
    });

    expect(cfg.events.decisionRouting).toBe(true);
    expect(cfg.events.journalRetentionDays).toBe(3);
    expect(cfg.events.defaultMode).toBe('ephemeral');
    expect(cfg.scheduler.enabled).toBe(false);
    expect(cfg.decision.escalationProvider).toBe('systemone');
  });

  it('CLI-overrides приоритетнее env', async () => {
    const path = await writeConfig(YAML);
    const cfg = await loadConfig({
      configPath: path,
      env: { SYNTH_EVENTS_AUTO_BIND: 'true' },
      overrides: { events: { ...defaultConfig.events, autoBind: false } },
    });

    expect(cfg.events.autoBind).toBe(false);
  });

  it('читает process.env, если env не передан (реальный вызов loadConfig)', async () => {
    const path = await writeConfig(YAML);
    vi.stubEnv('SYNTH_EGRESS_WEBHOOKS_MODE', 'off');
    vi.stubEnv('SYNTH_EGRESS_LOG_ENABLED', 'false');

    const cfg = await loadConfig({ configPath: path });
    expect(cfg.egress.webhooks.mode).toBe('off');
    expect(cfg.egress.log.enabled).toBe(false);
  });

  it('legacy webhooks.allowPrivateTargets игнорируется с warn (fail-closed)', async () => {
    const path = await writeConfig('webhooks:\n  allowPrivateTargets: true\n');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const cfg = await loadConfig({ configPath: path });

    expect((cfg.webhooks as Record<string, unknown>).allowPrivateTargets).toBeUndefined();
    expect(cfg.egress.webhooks.mode).toBe('deny');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('egress.webhooks.mode'));
  });

  it('legacy env SYNTH_WEBHOOKS_ALLOW_PRIVATE_TARGETS игнорируется с warn', async () => {
    const path = await writeConfig('{}\n');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const cfg = await loadConfig({ configPath: path, env: { SYNTH_WEBHOOKS_ALLOW_PRIVATE_TARGETS: 'true' } });

    expect((cfg.webhooks as Record<string, unknown>).allowPrivateTargets).toBeUndefined();
    expect(cfg.egress.webhooks.mode).toBe('deny');
    expect(warn).toHaveBeenCalled();
  });
});

/**
 * ADR-052/O1: installer service-key'и — JSON-список из env применяется поверх
 * config.yaml (секрет не в файле); при невалидном JSON — warn + игнор.
 */
describe('loadConfig — SYNTH_BOOTSTRAP_SERVICE_KEYS (ADR-052/O1)', () => {
  let dir: string | null = null;

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
      dir = null;
    }
  });

  async function writeConfig(yaml: string): Promise<string> {
    dir = await mkdtemp(join(tmpdir(), 'synth-config-bootstrap-'));
    const path = join(dir, 'config.yaml');
    await writeFile(path, yaml, 'utf-8');
    return path;
  }

  const entries = [
    { label: 'addon-installer', secret: 'synth_svc_abc', scopes: ['addons:install'] },
    { label: 'consent', secret: 'synth_svc_def', scopes: ['users:read'], roles: ['USER'] },
  ];

  it('применяет JSON из env; config.yaml не требуется', async () => {
    const path = await writeConfig('{}\n');
    const cfg = await loadConfig({
      configPath: path,
      env: { SYNTH_BOOTSTRAP_SERVICE_KEYS: JSON.stringify(entries) },
    });
    expect(cfg.security.bootstrapServiceKeys).toEqual(entries);
  });

  it('env приоритетнее config.yaml', async () => {
    const path = await writeConfig(
      'security:\n  bootstrapServiceKeys:\n    - label: from-file\n      secret: synth_svc_file\n      scopes: [addons:install]\n',
    );
    const cfg = await loadConfig({
      configPath: path,
      env: { SYNTH_BOOTSTRAP_SERVICE_KEYS: JSON.stringify(entries) },
    });
    expect(cfg.security.bootstrapServiceKeys).toEqual(entries);
  });

  it('без env список берётся из config.yaml', async () => {
    const path = await writeConfig(
      'security:\n  bootstrapServiceKeys:\n    - label: from-file\n      secret: synth_svc_file\n      scopes: [addons:install]\n',
    );
    const cfg = await loadConfig({ configPath: path, env: {} });
    expect(cfg.security.bootstrapServiceKeys).toEqual([
      { label: 'from-file', secret: 'synth_svc_file', scopes: ['addons:install'] },
    ]);
  });

  it('невалидный JSON → warn + пустой список (fail-soft)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const path = await writeConfig('{}\n');
    const cfg = await loadConfig({
      configPath: path,
      env: { SYNTH_BOOTSTRAP_SERVICE_KEYS: '{broken' },
    });
    expect(cfg.security.bootstrapServiceKeys ?? []).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

/**
 * ADR-147: `llmGateway.enabled` — единый дефолт для всех профилей (включён);
 * профильных различий больше нет (ранее — ADR-139/PROP-139). Явный opt-out
 * (`config.yaml`/env/CLI-overrides) перебивает дефолт по общему приоритету
 * ADR-023. Профильный механизм `baseDefaults` остаётся нужен бэкенду для
 * `security.commandAudit` (PROP-136), но к LLM-шлюзу больше не применяется.
 */
describe('loadConfig — llmGateway.enabled, единый дефолт (ADR-147)', () => {
  let dir: string | null = null;

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
      dir = null;
    }
  });

  async function writeConfig(yaml: string): Promise<string> {
    dir = await mkdtemp(join(tmpdir(), 'synth-config-gateway-'));
    const path = join(dir, 'config.yaml');
    await writeFile(path, yaml, 'utf-8');
    return path;
  }

  it('без config.yaml/env/baseDefaults — шлюз включён, остальные поля из общего дефолта', async () => {
    const cfg = await loadConfig({
      configPath: await writeConfig('{}\n'),
      env: {},
    });
    expect(cfg.llmGateway.enabled).toBe(true);
    expect(cfg.llmGateway.inputMode).toBe(defaultConfig.llmGateway.inputMode);
    expect(cfg.llmGateway.logPayloads).toBe(defaultConfig.llmGateway.logPayloads);
    expect(cfg.llmGateway.rateLimit).toEqual(defaultConfig.llmGateway.rateLimit);
    expect(cfg.llmGateway.audit.enabled).toBe(defaultConfig.llmGateway.audit.enabled);
  });

  it('config.yaml с enabled: false — шлюз выключен (явный opt-out)', async () => {
    const cfg = await loadConfig({
      configPath: await writeConfig('llmGateway:\n  enabled: false\n'),
      env: {},
    });
    expect(cfg.llmGateway.enabled).toBe(false);
  });

  it('env SYNTH_LLM_GATEWAY_ENABLED=false — шлюз выключен', async () => {
    const cfg = await loadConfig({
      configPath: await writeConfig('{}\n'),
      env: { SYNTH_LLM_GATEWAY_ENABLED: 'false' },
    });
    expect(cfg.llmGateway.enabled).toBe(false);
  });

  it('CLI-overrides с enabled: false — шлюз выключен', async () => {
    const cfg = await loadConfig({
      configPath: await writeConfig('{}\n'),
      env: {},
      overrides: { llmGateway: { ...defaultConfig.llmGateway, enabled: false } },
    });
    expect(cfg.llmGateway.enabled).toBe(false);
  });
});

/**
 * PROP-136b: зеркальный чекер команд — `enabled: true` без адреса обязан
 * ломать загрузку конфигурации (fail-closed старта), а не молча выключаться.
 */
describe('loadConfig — security.commandPolicy (PROP-136b)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('SYNTH_COMMAND_POLICY_ENABLED=true без URL → ошибка загрузки', async () => {
    vi.stubEnv('SYNTH_COMMAND_POLICY_ENABLED', 'true');
    vi.stubEnv('SYNTH_COMMAND_POLICY_URL', '');
    await expect(loadConfig({ configPath: '/nonexistent/synth-config.yaml' })).rejects.toThrow(
      /commandPolicy/,
    );
  });

  it('SYNTH_COMMAND_POLICY_ENABLED=true + URL → валидная конфигурация', async () => {
    vi.stubEnv('SYNTH_COMMAND_POLICY_ENABLED', 'true');
    vi.stubEnv('SYNTH_COMMAND_POLICY_URL', 'http://policy.local');
    vi.stubEnv('SYNTH_COMMAND_POLICY_FAIL_MODE', 'closed');
    const cfg = await loadConfig({ configPath: '/nonexistent/synth-config.yaml' });
    expect(cfg.security.commandPolicy).toMatchObject({
      enabled: true,
      url: 'http://policy.local',
      failMode: 'closed',
    });
  });

  it('невалидное значение env → ошибка загрузки (fail-closed)', async () => {
    vi.stubEnv('SYNTH_COMMAND_POLICY_PROVIDER', 'off');
    await expect(loadConfig({ configPath: '/nonexistent/synth-config.yaml' })).rejects.toThrow(
      /SYNTH_COMMAND_POLICY_PROVIDER/,
    );
  });
});

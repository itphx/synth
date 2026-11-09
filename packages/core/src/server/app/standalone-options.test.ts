/**
 * Единый маппинг `SynthConfig` → опции `createStandaloneApp`.
 *
 * Страховка от бага «публичный CLI передаёт лишь малую часть секций»
 * (`.opencode/tasks/log.3.md`: `skills.trustedProjectDirs` и др. не доезжали до
 * standalone-инстанса из npm-пакета): тест фиксирует, что заполненный конфиг
 * целиком попадает в результат, а не только storage/metrics.
 */
import { describe, expect, it } from 'vitest';
import { defaultConfig } from '@itphx/synth-shared';
import type { ResolvedExecutionConfig, SynthConfig } from '@itphx/synth-shared';
import { buildStandaloneOptions } from './standalone-options.js';

const EXECUTION: ResolvedExecutionConfig = {
  mode: 'inline',
  remote: { url: [], timeoutMs: 30_000, concurrency: 2, failMode: 'fail', tokenSecret: '' },
};

/** Конфиг с «заполненными» секциями: каждое значение узнаваемо в ассертах. */
function filledConfig(): SynthConfig {
  return {
    ...defaultConfig,
    storage: {
      ...defaultConfig.storage,
      dataDir: '/tmp/synth-so-data',
      backend: 'postgres',
      postgres: { host: 'db.local', port: 5433, database: 'synthdb', user: 'synthuser' },
      degradedMode: 'halt',
      fallbackDir: '/tmp/synth-so-fallback',
      workspacesRoot: '/tmp/synth-so-workspaces',
      defaultWorkspace: '/tmp/synth-so-default',
      workspaceOutsideRoot: 'deny',
      maxUploadBytes: 111,
      maxReadBytes: 222,
      maxPreviewBytes: 333,
    },
    llm: {
      ...defaultConfig.llm,
      defaultProvider: 'openai',
      defaultModel: 'gpt-test',
      maxTokens: 4096,
      cache: 'none',
    },
    session: { ...defaultConfig.session, planMode: 'strict' },
    permission: { rules: { execute_shell: 'deny' }, askTimeoutMs: 12_345 },
    tools: {
      ...defaultConfig.tools,
      policy: 'available',
      disabled: { capabilities: ['shell'], tools: ['web_fetch'] },
      outputMaxLines: 42,
      outputMaxBytes: 4242,
    },
    context: { ...defaultConfig.context, windowPolicy: 'enforce' },
    mcp: {
      ...defaultConfig.mcp,
      policy: 'consistency',
      servers: {
        browser: { type: 'http', url: 'https://mcp.example.test/mcp', description: 'browser' },
      },
      networkPolicy: { mode: 'allow', list: ['10.0.0.0/8'], exceptions: ['*.svc.cluster.local'] },
    },
    skills: {
      ...defaultConfig.skills,
      paths: ['/tmp/synth-so-skills'],
      trustedProjectDirs: ['/tmp/synth-so-trusted', '/srv/projects'],
      inlineShell: true,
    },
    commands: {
      ...defaultConfig.commands,
      paths: ['/tmp/synth-so-commands'],
      conflict: { mode: 'conservative', namespacePrefix: true },
    },
    instructions: { ...defaultConfig.instructions, enabled: true },
    events: { ...defaultConfig.events, enabled: false, ephemeralTtl: '2h' },
    scheduler: { ...defaultConfig.scheduler, enabled: false, tickSec: 15 },
    decision: { ...defaultConfig.decision, enabled: true, provider: 'clef', model: 'clef-flash' },
    oauth: {
      providers: {
        example: {
          authorizeUrl: 'https://example.test/authorize',
          tokenUrl: 'https://example.test/token',
          clientId: 'client-1',
          scopes: ['read'],
        },
      },
    },
    analytics: { ...defaultConfig.analytics, retentionDays: 99 },
    git: { ...defaultConfig.git, cloneTimeoutMs: 1_000, fetchTimeoutMs: 2_000 },
    questions: { ...defaultConfig.questions, timeoutMs: 3_600_000 },
    background: { ...defaultConfig.background, enabled: false, maxRunsPerSession: 3 },
    agents: { ...defaultConfig.agents, subagentMaxInputTokens: 12_000 },
    limits: { ...defaultConfig.limits, sessionOpsPerMinute: 5 },
    ssh: { ...defaultConfig.ssh, mode: 'agent' },
    attachments: {
      ...defaultConfig.attachments,
      enabled: false,
      maxFilesPerMessage: 4,
      maxBytesPerFile: 1_234_567,
    },
    metrics: { ...defaultConfig.metrics, enabled: true },
    authority: { ...defaultConfig.authority, enabled: true, shadow: false },
    plugins: { ...defaultConfig.plugins, enabled: false, trustFloor: 'verified' },
    webhooks: { ...defaultConfig.webhooks, enabled: true, maxAttempts: 2 },
    egress: {
      ...defaultConfig.egress,
      tools: { mode: 'deny', list: ['10.0.0.0/8'], exceptions: ['api.example.test'] },
    },
    llmGateway: { ...defaultConfig.llmGateway, enabled: true },
    proxy: { ...defaultConfig.proxy, enabled: true, url: 'http://proxy.example.test:3128' },
    security: { ...defaultConfig.security, secretKey: 'test-master-key' },
    remote: { ...defaultConfig.remote, llm: 'local', timeoutMs: 45_000 },
  };
}

describe('buildStandaloneOptions', () => {
  it('переносит все конфиг-производные секции (паритет core/main.ts и synth serve)', () => {
    const synth = filledConfig();
    // env пустой: значения берутся ровно из config.yaml, без влияния окружения.
    const options = buildStandaloneOptions({
      synth,
      dataDir: synth.storage.dataDir,
      execution: EXECUTION,
      env: {},
    });

    // --- Skills/commands: ключевой кейс исходного бага ---
    expect(options.skillsConfig?.trustedProjectDirs).toEqual(['/tmp/synth-so-trusted', '/srv/projects']);
    expect(options.skillsConfig?.paths).toEqual(['/tmp/synth-so-skills']);
    expect(options.commandsConfig?.paths).toEqual(['/tmp/synth-so-commands']);
    expect(options.commandsConfig?.conflict).toEqual({ mode: 'conservative', namespacePrefix: true });

    // --- Хранилище и лимиты чтения/загрузки ---
    expect(options.storageBackend).toBe('postgres');
    expect(options.postgresConfig).toMatchObject({ host: 'db.local', port: 5433, database: 'synthdb' });
    expect(options.degradedMode).toBe('halt');
    expect(options.fallbackDir).toBe('/tmp/synth-so-fallback');
    expect(options.workspacesRoot).toBe('/tmp/synth-so-workspaces');
    expect(options.defaultWorkingDir).toBe('/tmp/synth-so-default');
    expect(options.maxUploadBytes).toBe(111);
    expect(options.maxReadBytes).toBe(222);
    expect(options.maxPreviewBytes).toBe(333);

    // --- ADR-077: execution ---
    expect(options.executionConfig).toEqual(EXECUTION);

    // --- Permissions / режим / сессия ---
    expect(options.permissionConfig?.rules).toEqual({ execute_shell: 'deny' });
    expect(options.defaultPlanMode).toBe('strict');
    expect(options.sessionConfig?.planMode).toBe('strict');

    // --- Tools/MCP/context ---
    expect(options.toolsPolicy).toBe('available');
    expect(options.mcpPolicy).toBe('consistency');
    expect(options.toolsDisabled).toEqual({ capabilities: ['shell'], tools: ['web_fetch'] });
    expect(options.toolsConfig?.outputMaxLines).toBe(42);
    expect(options.toolsConfig?.outputMaxBytes).toBe(4242);
    expect(options.contextConfig?.windowPolicy).toBe('enforce');
    expect(options.mcpServers).toMatchObject({ browser: { type: 'http' } });
    expect(options.mcpNetworkPolicy).toMatchObject({ mode: 'allow' });

    // --- ADR-075: политика workspace вне root ---
    expect(options.workspaceOutsideRootPolicy).toBe('deny');

    // --- LLM/Gateway ---
    expect(options.gatewayConfig?.enabled).toBe(true);
    expect(options.llmCachePolicy).toBe('none');
    expect(options.llmMaxTokens).toBe(4096);
    expect(options.llmDefaults).toEqual({ provider: 'openai', model: 'gpt-test' });

    // --- Security/proxy/secret ---
    expect(options.securityConfig?.secretKey).toBe('test-master-key');
    expect(options.secretKey).toBe('test-master-key');
    expect(options.proxyConfig?.url).toBe('http://proxy.example.test:3128');

    // --- Подсистемы ---
    expect(options.eventsConfig?.enabled).toBe(false);
    expect(options.schedulerConfig).toMatchObject({ enabled: false, tickSec: 15 });
    expect(options.decisionConfig).toMatchObject({ enabled: true, provider: 'clef' });
    expect(options.oauthProviders).toMatchObject({ example: { clientId: 'client-1' } });
    expect(options.analyticsConfig?.retentionDays).toBe(99);
    expect(options.gitConfig).toMatchObject({ cloneTimeoutMs: 1_000, fetchTimeoutMs: 2_000 });
    expect(options.questionsConfig?.timeoutMs).toBe(3_600_000);
    expect(options.backgroundConfig).toMatchObject({ enabled: false, maxRunsPerSession: 3 });
    expect(options.agentsConfig?.subagentMaxInputTokens).toBe(12_000);
    expect(options.limitsConfig?.sessionOpsPerMinute).toBe(5);
    expect(options.sshConfig?.mode).toBe('agent');
    expect(options.attachmentsConfig).toMatchObject({ enabled: false, maxFilesPerMessage: 4 });
    expect(options.metricsConfig?.enabled).toBe(true);
    expect(options.authorityConfig).toEqual({ enabled: true, shadow: false });
    expect(options.pluginsConfig).toMatchObject({ enabled: false, trustFloor: 'verified' });
    expect(options.webhooksConfig).toMatchObject({ enabled: true, maxAttempts: 2 });
    expect(options.egressConfig?.tools).toMatchObject({ mode: 'deny' });
    expect(options.remoteLlm).toBe('local');
    expect(options.remoteTimeoutMs).toBe(45_000);
  });

  it('--ignore-rules выключает проектные инструкции, не мутируя конфиг', () => {
    const synth = filledConfig();
    const options = buildStandaloneOptions({
      synth,
      dataDir: synth.storage.dataDir,
      execution: EXECUTION,
      ignoreRules: true,
      env: {},
    });

    expect(options.instructionsConfig?.enabled).toBe(false);
    // Исходный конфиг не изменён.
    expect(synth.instructions.enabled).toBe(true);
  });

  it('без политики workspace вне root подставляет confirm (standalone-дефолт)', () => {
    const synth: SynthConfig = {
      ...defaultConfig,
      storage: { ...defaultConfig.storage, dataDir: '/tmp/synth-so-data2', workspaceOutsideRoot: '' },
    };
    const options = buildStandaloneOptions({
      synth,
      dataDir: synth.storage.dataDir,
      execution: EXECUTION,
      env: {},
    });
    expect(options.workspaceOutsideRootPolicy).toBe('confirm');
  });
});

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { SynthConfig } from './types.js';
import { defaultConfig } from './defaults.js';
import { defaultConfig as defaultsModule } from './defaults.js';
import { defaultExecutionConcurrency } from './execution.js';

describe('defaultConfig', () => {
  it('содержит все обязательные секции', () => {
    expect(defaultConfig).toHaveProperty('server');
    expect(defaultConfig).toHaveProperty('storage');
    expect(defaultConfig).toHaveProperty('execution');
    expect(defaultConfig).toHaveProperty('auth');
    expect(defaultConfig).toHaveProperty('llm');
    expect(defaultConfig).toHaveProperty('core');
    expect(defaultConfig).toHaveProperty('runner');
    expect(defaultConfig).toHaveProperty('ui');
    expect(defaultConfig).toHaveProperty('i18n');
    expect(defaultConfig).toHaveProperty('logging');
    expect(defaultConfig).toHaveProperty('tsm');
    expect(defaultConfig).toHaveProperty('context');
    expect(defaultConfig).toHaveProperty('summarization');
    expect(defaultConfig).toHaveProperty('events');
    expect(defaultConfig).toHaveProperty('scheduler');
    expect(defaultConfig).toHaveProperty('decision');
    expect(defaultConfig).toHaveProperty('metrics');
  });

  it('llm.defaultProvider и llm.defaultModel — пустые строки (зона админа)', () => {
    expect(defaultConfig.llm.defaultProvider).toBe('');
    expect(defaultConfig.llm.defaultModel).toBe('');
  });

  it('llm.cache по умолчанию auto (ADR-070)', () => {
    expect(defaultConfig.llm.cache).toBe('auto');
  });

  it('tools.policy по умолчанию auto (ADR-071 §2.3)', () => {
    expect(defaultConfig.tools.policy).toBe('auto');
  });

  it('mcp.policy по умолчанию auto (ADR-071 §2.3)', () => {
    expect(defaultConfig.mcp.policy).toBe('auto');
  });

  it('tools.disabled по умолчанию пусто (ADR-071 §2.6)', () => {
    expect(defaultConfig.tools.disabled).toEqual({ capabilities: [], tools: [] });
  });

  it('skills по умолчанию пусты (paths/urls), inlineShell выключен (ADR-046)', () => {
    expect(defaultConfig.skills).toEqual({
      paths: [], urls: [], trustedProjectDirs: [], inlineShell: false, toolsets: {},
    });
  });

  it('commands по умолчанию: bundle-wins, лимиты, пустые paths (ADR-046 §7)', () => {
    expect(defaultConfig.commands).toEqual({
      paths: [],
      bundlesPath: 'skill-bundles',
      conflict: { mode: 'bundle-wins', namespacePrefix: false },
      maxArgumentsLength: 10_000,
      maxRenderedBytes: 200_000,
    });
  });

  it('instructions: enabled, claudeCompat, кап от окна, пустые sources (ADR-069)', () => {
    expect(defaultConfig.instructions.enabled).toBe(true);
    expect(defaultConfig.instructions.claudeCompat).toBe(true);
    expect(defaultConfig.instructions.contextCompat).toBe(false);
    expect(defaultConfig.instructions.maxChars).toBeUndefined();
    expect(defaultConfig.instructions.windowRatio).toBe(0.06);
    expect(defaultConfig.instructions.minChars).toBe(20_000);
    expect(defaultConfig.instructions.maxCharsCeiling).toBe(500_000);
    expect(defaultConfig.instructions.sources).toEqual([]);
    expect(defaultConfig.instructions.excludeProjects).toEqual([]);
    expect(defaultConfig.instructions.allowInstallTreeFallback).toBe(false);
    expect(defaultConfig.instructions.lazy.enabled).toBe(true);
    expect(defaultConfig.instructions.lazy.maxAncestors).toBe(5);
    expect(defaultConfig.instructions.lazy.maxChars).toBe(8_000);
    expect(defaultConfig.instructions.fetch).toEqual({ timeoutMs: 5_000, cacheTtlSec: 3_600, maxBytes: 262_144 });
  });

  it('core.port == 4300', () => {
    expect(defaultConfig.core.port).toBe(4300);
  });

  it('core.apiKey — пустая строка', () => {
    expect(defaultConfig.core.apiKey).toBe('');
  });

  it('runner.enginePorts содержит стандартные порты', () => {
    expect(defaultConfig.runner.enginePorts).toEqual({
      opencode: 4100,
      cline: 4200,
      synth: 4300,
    });
  });

  it('logging.groups содержит все ожидаемые группы', () => {
    expect(defaultConfig.logging.groups).toHaveProperty('ORCHESTRATOR');
    expect(defaultConfig.logging.groups).toHaveProperty('CHAT_STREAM');
  });

  it('context.enabledFiles содержит стандартные файлы', () => {
    expect(defaultConfig.context.enabledFiles).toContain('SOUL.md');
    expect(defaultConfig.context.enabledFiles).toContain('COMPANY.md');
    expect(defaultConfig.context.enabledFiles).toContain('ABOUT.md');
  });

  it('tsm.maxIterations == 50', () => {
    expect(defaultConfig.tsm.maxIterations).toBe(50);
  });

  it('storage.defaultWorkspace — пустая строка (резолвится от dataDir в рантайме)', () => {
    expect(defaultConfig.storage.defaultWorkspace).toBe('');
  });

  it('storage.maxUploadBytes по умолчанию 100 МиБ (config/env-настраиваемый лимит загрузки)', () => {
    expect(defaultConfig.storage.maxUploadBytes).toBe(100 * 1024 * 1024);
  });

  it('storage.backend по умолчанию file, postgres пуст, degradedMode fallback-file (ADR-096)', () => {
    expect(defaultConfig.storage.backend).toBe('file');
    expect(defaultConfig.storage.postgres).toEqual({});
    expect(defaultConfig.storage.degradedMode).toBe('fallback-file');
    expect(defaultConfig.storage.fallbackDir).toBe('');
  });

  it('execution по умолчанию: inline, без адресов, 30 с, fail, concurrency = число CPU (ADR-077)', () => {
    expect(defaultConfig.execution.mode).toBe('inline');
    expect(defaultConfig.execution.remote.url).toEqual([]);
    expect(defaultConfig.execution.remote.timeoutMs).toBe(30_000);
    expect(defaultConfig.execution.remote.failMode).toBe('fail');
    expect(defaultConfig.execution.remote.tokenSecret).toBe('');
    expect(defaultConfig.execution.remote.concurrency).toBe(defaultExecutionConcurrency());
  });

  it('summarization.promptFile == SUMMARIZER', () => {
    expect(defaultConfig.summarization.promptFile).toBe('SUMMARIZER');
  });

  it('security.secretKey по умолчанию пуст (ADR-076: файл master.key)', () => {
    expect(defaultConfig.security.secretKey).toBe('');
  });

  it('security.bootstrapServiceKeys по умолчанию пуст (ADR-052/O1)', () => {
    expect(defaultConfig.security.bootstrapServiceKeys).toEqual([]);
  });

  it('events по умолчанию: enabled, bound, 24h, 30 дней, все источники, dedup memory (ADR-089)', () => {
    expect(defaultConfig.events).toEqual({
      enabled: true,
      defaultMode: 'bound',
      ephemeralTtl: '24h',
      journalRetentionDays: 30,
      allowedSources: [],
      dedupStore: 'memory',
      unknownAgentTemplate: 'drop',
      keyRateLimitPerMinute: 0,
      decisionRouting: false,
      autoBind: false,
      autoBindAgentTemplate: '',
      identityMap: {},
    });
  });

  it('scheduler по умолчанию: enabled, тик 60 c, catch-up skip, retention 30, OFF-флаги (ADR-051)', () => {
    expect(defaultConfig.scheduler).toEqual({
      enabled: true,
      tickSec: 60,
      catchUp: 'skip',
      jobRetentionDays: 30,
      leaderElection: 'none',
      crossProcessLocks: false,
    });
  });

  it('decision по умолчанию: выключен, провайдер/модель пусты, порог 0.6, эскалация пуста (ADR-084)', () => {
    expect(defaultConfig.decision).toEqual({
      enabled: false,
      provider: '',
      model: '',
      confidenceThreshold: 0.6,
      escalationProvider: '',
      escalationModel: '',
    });
  });

  it('analytics по умолчанию: retention суточных роллапов 400 дней (ADR-102)', () => {
    expect(defaultConfig.analytics).toEqual({
      retentionDays: 400,
    });
  });

  it('metrics по умолчанию выключены (ADR-094: /metrics → 404)', () => {
    expect(defaultConfig.metrics).toEqual({ enabled: false });
  });

  it('plugins по умолчанию: включены, runtime-install deny, trust-floor trusted, исполнение кода выключено (PROP-090 Ф0/Ф1)', () => {
    expect(defaultConfig.plugins).toEqual({
      enabled: true,
      runtimeInstall: 'deny',
      trustFloor: 'trusted',
      scan: 'enabled',
      allowlist: [],
      denylist: [],
      remoteAllowlist: [],
      exactHostExceptions: '',
      promptBlockMaxChars: 4000,
      executionEnabled: false,
      // PROP-090 §«Точка llmFilters» (Ф3б): бюджет времени фильтра.
      llmFilterTimeoutMs: 1000,
      // Ф5в: managed deploy-time — дефолтный каталог образных бандлов
      // (низший приоритет: config.yaml и env его перекрывают).
      deployDir: '/opt/synth/plugins',
      deployTrust: 'trusted',
      managedReadonly: true,
      // Ф7: серверная политика гибрида — по умолчанию сервер не ограничивает.
      hybrid: { mode: 'off', allow: [] },
    });
  });
});

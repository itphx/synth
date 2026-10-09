import { describe, it, expect, vi, afterEach } from 'vitest';
import type { SynthConfig } from './types.js';
import { defaultConfig } from './defaults.js';
import { defaultConfig as defaultsModule } from './defaults.js';

describe('defaultConfig', () => {
  it('содержит все обязательные секции', () => {
    expect(defaultConfig).toHaveProperty('server');
    expect(defaultConfig).toHaveProperty('storage');
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
  });

  it('llm.defaultProvider и llm.defaultModel — пустые строки (зона админа)', () => {
    expect(defaultConfig.llm.defaultProvider).toBe('');
    expect(defaultConfig.llm.defaultModel).toBe('');
  });

  it('llm.cache по умолчанию auto (AD-070)', () => {
    expect(defaultConfig.llm.cache).toBe('auto');
  });

  it('tools.policy по умолчанию auto (AD-071 §2.3)', () => {
    expect(defaultConfig.tools.policy).toBe('auto');
  });

  it('mcp.policy по умолчанию auto (AD-071 §2.3)', () => {
    expect(defaultConfig.mcp.policy).toBe('auto');
  });

  it('tools.disabled по умолчанию пусто (AD-071 §2.6)', () => {
    expect(defaultConfig.tools.disabled).toEqual({ capabilities: [], tools: [] });
  });

  it('skills по умолчанию пусты (paths/urls), inlineShell выключен (AD-046)', () => {
    expect(defaultConfig.skills).toEqual({
      paths: [], urls: [], trustedProjectDirs: [], inlineShell: false, toolsets: {},
    });
  });

  it('commands по умолчанию: bundle-wins, лимиты, пустые paths (AD-046 §7)', () => {
    expect(defaultConfig.commands).toEqual({
      paths: [],
      bundlesPath: 'skill-bundles',
      conflict: { mode: 'bundle-wins', namespacePrefix: false },
      maxArgumentsLength: 10_000,
      maxRenderedBytes: 200_000,
    });
  });

  it('instructions: enabled, claudeCompat, кап от окна, пустые sources (AD-069)', () => {
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

  it('summarization.promptFile == SUMMARIZER', () => {
    expect(defaultConfig.summarization.promptFile).toBe('SUMMARIZER');
  });

  it('security.secretKey по умолчанию пуст (AD-076: файл master.key)', () => {
    expect(defaultConfig.security.secretKey).toBe('');
  });

  it('events по умолчанию: enabled, bound, 24h, 30 дней, все источники (AD-089)', () => {
    expect(defaultConfig.events).toEqual({
      enabled: true,
      defaultMode: 'bound',
      ephemeralTtl: '24h',
      journalRetentionDays: 30,
      allowedSources: [],
    });
  });

  it('scheduler по умолчанию: enabled, тик 60 c, catch-up skip, retention 30 (AD-051)', () => {
    expect(defaultConfig.scheduler).toEqual({
      enabled: true,
      tickSec: 60,
      catchUp: 'skip',
      jobRetentionDays: 30,
    });
  });
});

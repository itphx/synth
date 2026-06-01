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
  });

  it('llm.defaultProvider и llm.defaultModel — пустые строки (зона админа)', () => {
    expect(defaultConfig.llm.defaultProvider).toBe('');
    expect(defaultConfig.llm.defaultModel).toBe('');
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
    expect(defaultConfig.logging.groups).toHaveProperty('TSM');
  });

  it('context.enabledFiles содержит стандартные файлы', () => {
    expect(defaultConfig.context.enabledFiles).toContain('SOUL.md');
    expect(defaultConfig.context.enabledFiles).toContain('COMPANY.md');
    expect(defaultConfig.context.enabledFiles).toContain('ABOUT.md');
  });

  it('tsm.maxIterations == 50', () => {
    expect(defaultConfig.tsm.maxIterations).toBe(50);
  });

  it('summarization.promptFile == SUMMARIZER', () => {
    expect(defaultConfig.summarization.promptFile).toBe('SUMMARIZER');
  });
});

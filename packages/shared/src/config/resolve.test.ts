import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { resolveDataDir, resolvePort } from './resolve.js';
import { defaultConfig } from './defaults.js';
import type { SynthConfig } from './types.js';

const cfg: SynthConfig = { ...defaultConfig, storage: { ...defaultConfig.storage, dataDir: '/test/data' } };

describe('resolveDataDir', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('использует переданный env.SYNTH_DATA_DIR в первую очередь', () => {
    const env = { SYNTH_DATA_DIR: '/from/env' };
    expect(resolveDataDir(cfg, env)).toBe('/from/env');
  });

  it('НЕ читает реальный process.env, если передан env без SYNTH_DATA_DIR', () => {
    vi.stubEnv('SYNTH_DATA_DIR', '/should-not-be-used');
    const env = { HOME: '/fake' };
    const result = resolveDataDir(cfg, env);
    expect(result).toBe(cfg.storage.dataDir);
  });

  it('использует config.storage.dataDir если env не передан', () => {
    vi.stubEnv('SYNTH_DATA_DIR', '');
    expect(resolveDataDir(cfg)).toBe(cfg.storage.dataDir);
  });

  it('приоритет process.env.SYNTH_DATA_DIR если env не передан', () => {
    vi.stubEnv('SYNTH_DATA_DIR', '/from/process');
    expect(resolveDataDir(cfg)).toBe('/from/process');
  });
});

describe('resolvePort', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('использует переданный env в первую очередь', () => {
    const env = { SYNTH_PORT: '9999' };
    expect(resolvePort(cfg, 'SYNTH_PORT', 5000, env)).toBe(9999);
  });

  it('игнорирует невалидное число в env и использует fallback', () => {
    const env = { SYNTH_PORT: 'abc' };
    expect(resolvePort(cfg, 'SYNTH_PORT', 5000, env)).toBe(5000);
  });

  it('НЕ читает реальный process.env, если передан env', () => {
    vi.stubEnv('SYNTH_PORT', '7777');
    const env = { SYNTH_PORT: '8888' };
    expect(resolvePort(cfg, 'SYNTH_PORT', 5000, env)).toBe(8888);
  });

  it('возвращает configFallback при отсутствии env var', () => {
    expect(resolvePort(cfg, 'SYNTH_PORT', 5000, {})).toBe(5000);
  });
});

// Функциональные тесты для ensureDataDir и createDefaultConfig
// require доступа к реальной ФС, поэтому используют настоящие mkdir/writeFile
// или оставлены интеграционными (ручной запуск с tmp).

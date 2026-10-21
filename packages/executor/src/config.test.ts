import { describe, expect, it } from 'vitest';
import { EXECUTOR_DEFAULTS, EXECUTOR_ENV, resolveExecutorConfig, scrubExecutorToken } from './config.js';

describe('конфигурация исполнителя (env)', () => {
  it('без токена — ошибка (fail-closed)', () => {
    expect(() =>
      resolveExecutorConfig({ [EXECUTOR_ENV.workspace]: '/workspace' } as NodeJS.ProcessEnv),
    ).toThrow(/SYNTH_EXECUTOR_TOKEN/);
  });

  it('без корня workspace — ошибка (fail-closed)', () => {
    expect(() =>
      resolveExecutorConfig({ [EXECUTOR_ENV.token]: 'secret' } as NodeJS.ProcessEnv),
    ).toThrow(/SYNTH_EXECUTOR_WORKSPACE/);
  });

  it('дефолты и явные значения', () => {
    const config = resolveExecutorConfig({
      [EXECUTOR_ENV.token]: 'secret',
      [EXECUTOR_ENV.workspace]: '/workspace',
    } as NodeJS.ProcessEnv);
    expect(config.host).toBe(EXECUTOR_DEFAULTS.host);
    expect(config.port).toBe(EXECUTOR_DEFAULTS.port);
    expect(config.maxConcurrency).toBe(EXECUTOR_DEFAULTS.maxConcurrency);
    expect(config.maxTimeoutMs).toBe(EXECUTOR_DEFAULTS.maxTimeoutMs);
    expect(config.maxOutputBytes).toBe(EXECUTOR_DEFAULTS.maxOutputBytes);
    expect(config.token).toBe('secret');
    expect(config.workspaceRoot).toBe('/workspace');
  });

  it('невалидные значения — ошибка (не молчаливый дефолт)', () => {
    const base = {
      [EXECUTOR_ENV.token]: 'secret',
      [EXECUTOR_ENV.workspace]: '/workspace',
    } as NodeJS.ProcessEnv;
    expect(() => resolveExecutorConfig({ ...base, [EXECUTOR_ENV.port]: 'abc' })).toThrow(
      /SYNTH_EXECUTOR_PORT/,
    );
    expect(() => resolveExecutorConfig({ ...base, [EXECUTOR_ENV.maxConcurrency]: '0' })).toThrow(
      /SYNTH_EXECUTOR_MAX_CONCURRENCY/,
    );
    expect(() => resolveExecutorConfig({ ...base, [EXECUTOR_ENV.port]: '70000' })).toThrow(
      /SYNTH_EXECUTOR_PORT/,
    );
  });

  it('scrubExecutorToken убирает токен из окружения процесса', () => {
    const env = { [EXECUTOR_ENV.token]: 'secret' } as NodeJS.ProcessEnv;
    scrubExecutorToken(env);
    expect(env[EXECUTOR_ENV.token]).toBeUndefined();
  });
});

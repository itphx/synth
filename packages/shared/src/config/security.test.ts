import { describe, expect, it, vi } from 'vitest';
import { defaultConfig } from './defaults.js';
import {
  DEFAULT_PROMPT_INJECTION_CONFIG,
  PROMPT_INJECTION_ENABLED_ENV,
  PROMPT_INJECTION_MODE_ENV,
  parsePromptInjectionEnabledEnv,
  parsePromptInjectionModeEnv,
  resolvePromptInjection,
} from './security.js';

describe('resolvePromptInjection (ADR-023)', () => {
  it('дефолты схемы, когда ничего не задано', () => {
    const resolved = resolvePromptInjection(undefined, undefined, {});
    expect(resolved.config).toEqual({ enabled: true, wrapContent: true, mode: 'flag' });
    expect(resolved.source).toBe('default');
    expect(resolved.envLocked).toBe(false);
    expect(resolved.envLockedFields).toEqual([]);
    expect(resolved.defaults).toEqual(DEFAULT_PROMPT_INJECTION_CONFIG);
    // Дефолты резолвера совпадают с `defaultConfig` — второй пары значений нет.
    expect(defaultConfig.security.promptInjection).toEqual(DEFAULT_PROMPT_INJECTION_CONFIG);
  });

  it('значение config.yaml, равное дефолту, отдаётся как `default`; иное — `config`', () => {
    const same = resolvePromptInjection({ enabled: true, wrapContent: true, mode: 'flag' }, undefined, {});
    expect(same.source).toBe('default');

    const changed = resolvePromptInjection({ enabled: false, wrapContent: true, mode: 'block' }, undefined, {});
    expect(changed.config).toEqual({ enabled: false, wrapContent: true, mode: 'block' });
    expect(changed.source).toBe('config');
  });

  it('runtime приоритетнее config.yaml; незаданное поле берётся из базы', () => {
    const resolved = resolvePromptInjection(
      { enabled: true, wrapContent: true, mode: 'sanitize' },
      { enabled: false },
      {},
    );
    expect(resolved.config.enabled).toBe(false);
    // Режим runtime не задан — из config.yaml.
    expect(resolved.config.mode).toBe('sanitize');
    expect(resolved.source).toBe('runtime');
    expect(resolved.envLocked).toBe(false);
  });

  it('wrapContent runtime не управляется — всегда из базы', () => {
    const base = { enabled: true, wrapContent: false, mode: 'flag' as const };
    const withRuntime = resolvePromptInjection(base, { enabled: false, mode: 'block' }, {});
    expect(withRuntime.config.wrapContent).toBe(false);
    expect(resolvePromptInjection(undefined, { enabled: false }, {}).config.wrapContent).toBe(true);
  });

  it('env перекрывает runtime и config.yaml, фиксация — по полю', () => {
    const resolved = resolvePromptInjection(
      { enabled: true, wrapContent: true, mode: 'flag' },
      { enabled: false, mode: 'sanitize' },
      {
        [PROMPT_INJECTION_ENABLED_ENV]: '1',
        [PROMPT_INJECTION_MODE_ENV]: 'block',
      },
    );
    expect(resolved.config).toEqual({ enabled: true, wrapContent: true, mode: 'block' });
    expect(resolved.source).toBe('env');
    expect(resolved.envLocked).toBe(true);
    expect(resolved.envLockedFields).toEqual(['enabled', 'mode']);

    // Зафиксировано только одно поле — второе остаётся runtime.
    const partial = resolvePromptInjection(
      undefined,
      { enabled: false, mode: 'sanitize' },
      { [PROMPT_INJECTION_MODE_ENV]: 'block' },
    );
    expect(partial.config.enabled).toBe(false);
    expect(partial.config.mode).toBe('block');
    expect(partial.envLockedFields).toEqual(['mode']);
  });

  it('невалидный env — warn + игнор (fail-soft)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const resolved = resolvePromptInjection(undefined, { mode: 'sanitize' }, {
        [PROMPT_INJECTION_ENABLED_ENV]: 'maybe',
        [PROMPT_INJECTION_MODE_ENV]: 'explode',
      });
      expect(resolved.config.enabled).toBe(true);
      expect(resolved.config.mode).toBe('sanitize');
      expect(resolved.envLocked).toBe(false);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('parsePromptInjection* разбор env', () => {
  it('boolean: true/false/1/0 (регистр не важен), пусто — «не задано»', () => {
    expect(parsePromptInjectionEnabledEnv({ [PROMPT_INJECTION_ENABLED_ENV]: 'TRUE' })).toBe(true);
    expect(parsePromptInjectionEnabledEnv({ [PROMPT_INJECTION_ENABLED_ENV]: '0' })).toBe(false);
    expect(parsePromptInjectionEnabledEnv({ [PROMPT_INJECTION_ENABLED_ENV]: '' })).toBeUndefined();
    expect(parsePromptInjectionEnabledEnv({})).toBeUndefined();
  });

  it('mode: только канонические значения', () => {
    expect(parsePromptInjectionModeEnv({ [PROMPT_INJECTION_MODE_ENV]: 'sanitize' })).toBe('sanitize');
    expect(parsePromptInjectionModeEnv({ [PROMPT_INJECTION_MODE_ENV]: 'sanitize ' })).toBe('sanitize');
    expect(parsePromptInjectionModeEnv({})).toBeUndefined();
  });
});

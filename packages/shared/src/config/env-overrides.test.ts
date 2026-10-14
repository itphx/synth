import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  ENV_OVERRIDES,
  applyEnvOverrides,
  envOverrideName,
  parseEnvValue,
  toSnakeCase,
} from './env-overrides.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('toSnakeCase / envOverrideName (AD-023)', () => {
  it('camelCase → SNAKE_CASE', () => {
    expect(toSnakeCase('autoBind')).toBe('AUTO_BIND');
    expect(toSnakeCase('ephemeralTtl')).toBe('EPHEMERAL_TTL');
    expect(toSnakeCase('timeoutMs')).toBe('TIMEOUT_MS');
    expect(toSnakeCase('keyRateLimitPerMinute')).toBe('KEY_RATE_LIMIT_PER_MINUTE');
    expect(toSnakeCase('enabled')).toBe('ENABLED');
  });

  it('имя env = SYNTH_<SECTION>_<KEY>', () => {
    expect(envOverrideName({ section: 'events', key: 'autoBind', type: 'boolean' })).toBe(
      'SYNTH_EVENTS_AUTO_BIND',
    );
    expect(envOverrideName({ section: 'decision', key: 'provider', type: 'string' })).toBe(
      'SYNTH_DECISION_PROVIDER',
    );
    expect(envOverrideName({ section: 'scheduler', key: 'tickSec', type: 'number' })).toBe(
      'SYNTH_SCHEDULER_TICK_SEC',
    );
  });

  it('реестр содержит уникальные env-имена', () => {
    const names = ENV_OVERRIDES.map(envOverrideName);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('parseEnvValue (AD-023)', () => {
  it('boolean: true/1/false/0 регистронезависимо', () => {
    expect(parseEnvValue('true', 'boolean')).toEqual({ ok: true, value: true });
    expect(parseEnvValue('TRUE', 'boolean')).toEqual({ ok: true, value: true });
    expect(parseEnvValue('1', 'boolean')).toEqual({ ok: true, value: true });
    expect(parseEnvValue('false', 'boolean')).toEqual({ ok: true, value: false });
    expect(parseEnvValue('False', 'boolean')).toEqual({ ok: true, value: false });
    expect(parseEnvValue('0', 'boolean')).toEqual({ ok: true, value: false });
  });

  it('boolean: мусор → невалидно', () => {
    expect(parseEnvValue('maybe', 'boolean')).toEqual({ ok: false });
    expect(parseEnvValue('yes', 'boolean')).toEqual({ ok: false });
    expect(parseEnvValue('2', 'boolean')).toEqual({ ok: false });
  });

  it('number: Number() с проверкой isFinite', () => {
    expect(parseEnvValue('42', 'number')).toEqual({ ok: true, value: 42 });
    expect(parseEnvValue('0', 'number')).toEqual({ ok: true, value: 0 });
    expect(parseEnvValue('-5', 'number')).toEqual({ ok: true, value: -5 });
    expect(parseEnvValue('1.5', 'number')).toEqual({ ok: true, value: 1.5 });
    expect(parseEnvValue('1e3', 'number')).toEqual({ ok: true, value: 1000 });
  });

  it('number: NaN/Infinity/мусор → невалидно', () => {
    expect(parseEnvValue('abc', 'number')).toEqual({ ok: false });
    expect(parseEnvValue('12abc', 'number')).toEqual({ ok: false });
    expect(parseEnvValue('Infinity', 'number')).toEqual({ ok: false });
  });

  it('string: как есть', () => {
    expect(parseEnvValue('ephemeral', 'string')).toEqual({ ok: true, value: 'ephemeral' });
    expect(parseEnvValue(' lead ', 'string')).toEqual({ ok: true, value: ' lead ' });
  });

  it('пустая строка → «не задано» (все типы)', () => {
    expect(parseEnvValue('', 'boolean')).toEqual({ ok: false });
    expect(parseEnvValue('', 'number')).toEqual({ ok: false });
    expect(parseEnvValue('', 'string')).toEqual({ ok: false });
  });
});

describe('applyEnvOverrides (AD-023)', () => {
  function makeConfig(): Record<string, unknown> {
    return {
      events: { enabled: true, autoBind: false, ephemeralTtl: '24h', journalRetentionDays: 30 },
      scheduler: { tickSec: 60, catchUp: 'skip' },
      webhooks: { enabled: false },
      decision: { enabled: false, provider: '', model: '', confidenceThreshold: 0.6 },
    };
  }

  it('применяет скалярные оверрайды нужных типов', () => {
    const cfg = applyEnvOverrides(makeConfig(), {
      SYNTH_EVENTS_AUTO_BIND: 'true',
      SYNTH_EVENTS_ENABLED: '0',
      SYNTH_EVENTS_EPHEMERAL_TTL: '15m',
      SYNTH_EVENTS_JOURNAL_RETENTION_DAYS: '7',
      SYNTH_SCHEDULER_TICK_SEC: '120',
      SYNTH_SCHEDULER_CATCH_UP: 'once',
      SYNTH_WEBHOOKS_ENABLED: '1',
      SYNTH_DECISION_PROVIDER: 'systemone',
      SYNTH_DECISION_MODEL: 'clef-flash',
      SYNTH_DECISION_CONFIDENCE_THRESHOLD: '0.9',
    });

    expect(cfg.events).toEqual({
      enabled: false,
      autoBind: true,
      ephemeralTtl: '15m',
      journalRetentionDays: 7,
    });
    expect(cfg.scheduler).toEqual({ tickSec: 120, catchUp: 'once' });
    expect(cfg.webhooks).toEqual({ enabled: true });
    expect(cfg.decision).toEqual({
      enabled: false,
      provider: 'systemone',
      model: 'clef-flash',
      confidenceThreshold: 0.9,
    });
  });

  it('невалидное значение → warn + игнор, значение не меняется', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg = applyEnvOverrides(makeConfig(), { SYNTH_EVENTS_AUTO_BIND: 'maybe' });

    expect(cfg.events).toMatchObject({ autoBind: false });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('SYNTH_EVENTS_AUTO_BIND');
  });

  it('пустая строка → тихий игнор (без warn)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg = applyEnvOverrides(makeConfig(), { SYNTH_EVENTS_AUTO_BIND: '' });

    expect(cfg.events).toMatchObject({ autoBind: false });
    expect(warn).not.toHaveBeenCalled();
  });

  it('неизвестные env игнорируются молча', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg = applyEnvOverrides(makeConfig(), {
      SYNTH_EVENTS_ALLOWED_SOURCES: 'telegram',
      SYNTH_UNKNOWN_KEY: 'x',
      SYNTH_DATA_DIR: '/tmp/data',
    });

    expect(cfg.events).toMatchObject({ autoBind: false, ephemeralTtl: '24h' });
    expect(cfg).not.toHaveProperty('SYNTH_UNKNOWN_KEY');
    expect(warn).not.toHaveBeenCalled();
  });

  it('не мутирует исходные секции (клонирование)', () => {
    const cfg = makeConfig();
    const originalEvents = cfg.events as Record<string, unknown>;
    applyEnvOverrides(cfg, { SYNTH_EVENTS_AUTO_BIND: 'true' });

    expect((cfg.events as Record<string, unknown>).autoBind).toBe(true);
    // Исходная ссылка на секцию не тронута — клон записан вместо мутации.
    expect(originalEvents.autoBind).toBe(false);
    expect(cfg.events).not.toBe(originalEvents);
  });
});

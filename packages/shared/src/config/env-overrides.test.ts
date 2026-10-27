import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  ENV_OVERRIDES,
  applyEnvOverrides,
  applyObjectEnvOverrides,
  BOOTSTRAP_SERVICE_KEYS_ENV,
  OAUTH_PROVIDERS_ENV,
  envOverrideName,
  parseEnvValue,
  toSnakeCase,
} from './env-overrides.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('toSnakeCase / envOverrideName (ADR-023)', () => {
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
    // ADR-094: имя совпадает с Helm-чартом (`SYNTH_METRICS_ENABLED`).
    expect(envOverrideName({ section: 'metrics', key: 'enabled', type: 'boolean' })).toBe(
      'SYNTH_METRICS_ENABLED',
    );
    // ADR-115: лимиты вложений.
    expect(envOverrideName({ section: 'attachments', key: 'maxBytesPerFile', type: 'number' })).toBe(
      'SYNTH_ATTACHMENTS_MAX_BYTES_PER_FILE',
    );
  });

  it('реестр содержит уникальные env-имена', () => {
    const names = ENV_OVERRIDES.map(envOverrideName);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('parseEnvValue (ADR-023)', () => {
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

describe('applyEnvOverrides (ADR-023)', () => {
  function makeConfig(): Record<string, unknown> {
    return {
      events: { enabled: true, autoBind: false, ephemeralTtl: '24h', journalRetentionDays: 30 },
      scheduler: { tickSec: 60, catchUp: 'skip' },
      webhooks: { enabled: false },
      decision: { enabled: false, provider: '', model: '', confidenceThreshold: 0.6 },
      analytics: { retentionDays: 400 },
      questions: { timeoutMs: 600_000, retentionDays: 14 },
      background: { enabled: true, maxSubagentsPerSession: 2, maxProcessesPerSession: 5, maxRunsPerSession: 10, logMaxBytes: 10_485_760 },
      attachments: { maxBytesPerFile: 26_214_400, maxFilesPerMessage: 10, maxBytesPerSession: 1_073_741_824, gcDays: 30 },
      metrics: { enabled: false },
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
      SYNTH_ANALYTICS_RETENTION_DAYS: '30',
      SYNTH_QUESTIONS_TIMEOUT_MS: '0',
      SYNTH_QUESTIONS_RETENTION_DAYS: '7',
      SYNTH_BACKGROUND_MAX_PROCESSES_PER_SESSION: '3',
      SYNTH_BACKGROUND_LOG_MAX_BYTES: '2048',
      SYNTH_ATTACHMENTS_MAX_BYTES_PER_FILE: '10485760',
      SYNTH_ATTACHMENTS_MAX_FILES_PER_MESSAGE: '4',
      SYNTH_ATTACHMENTS_MAX_BYTES_PER_SESSION: '104857600',
      SYNTH_ATTACHMENTS_GC_DAYS: '7',
      SYNTH_METRICS_ENABLED: 'true',
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
    // ADR-102: retention суточных роллапов аналитики.
    expect(cfg.analytics).toEqual({ retentionDays: 30 });
    // Этап 1 roadmap 0.13 (блок 3): секция `questions` (таймаут ответа + retention).
    expect(cfg.questions).toEqual({ timeoutMs: 0, retentionDays: 7 });
    // PROP-097: лимит фоновых процессов и предел размера лога.
    expect(cfg.background).toMatchObject({ maxProcessesPerSession: 3, logMaxBytes: 2048 });
    // ADR-115: лимиты вложений сообщений.
    expect(cfg.attachments).toEqual({
      maxBytesPerFile: 10_485_760,
      maxFilesPerMessage: 4,
      maxBytesPerSession: 104_857_600,
      gcDays: 7,
    });
    // ADR-094: Helm ставит SYNTH_METRICS_ENABLED — имя env должно совпадать.
    expect(cfg.metrics).toEqual({ enabled: true });
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

  // ADR-090: env-переопределения секции `plugins` (создаётся, если секции нет).
  it('применяет env-оверрайды plugins.* (включая promptBlockMaxChars)', () => {
    const cfg = applyEnvOverrides(makeConfig(), {
      SYNTH_PLUGINS_ENABLED: 'false',
      SYNTH_PLUGINS_RUNTIME_INSTALL: 'allow',
      SYNTH_PLUGINS_TRUST_FLOOR: 'verified',
      SYNTH_PLUGINS_SCAN: 'disabled',
      SYNTH_PLUGINS_EXACT_HOST_EXCEPTIONS: '/etc/synth/plugin-hosts.txt',
      SYNTH_PLUGINS_PROMPT_BLOCK_MAX_CHARS: '8000',
      SYNTH_PLUGINS_EXECUTION_ENABLED: 'true',
    });

    expect(cfg.plugins).toEqual({
      enabled: false,
      runtimeInstall: 'allow',
      trustFloor: 'verified',
      scan: 'disabled',
      exactHostExceptions: '/etc/synth/plugin-hosts.txt',
      promptBlockMaxChars: 8000,
      executionEnabled: true,
    });
  });

  it('plugins.executionEnabled: невалидное значение → warn + игнор (ADR-090 Ф1)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg = applyEnvOverrides(makeConfig(), { SYNTH_PLUGINS_EXECUTION_ENABLED: 'perhaps' });

    expect(cfg.plugins).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('SYNTH_PLUGINS_EXECUTION_ENABLED');
  });

  it('plugins.*: невалидное число → warn + игнор', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg = applyEnvOverrides(makeConfig(), { SYNTH_PLUGINS_PROMPT_BLOCK_MAX_CHARS: 'many' });

    expect(cfg.plugins).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('SYNTH_PLUGINS_PROMPT_BLOCK_MAX_CHARS');
  });

  // ADR-090 (WP-F): провайдер/модель эмбеддингов для `facade.embed`.
  it('применяет env-оверрайды провайдера/модели эмбеддингов (SYNTH_PLUGINS_EMBEDDING_*)', () => {
    const cfg = applyEnvOverrides(makeConfig(), {
      SYNTH_PLUGINS_EMBEDDING_PROVIDER: 'ollama',
      SYNTH_PLUGINS_EMBEDDING_MODEL: 'nomic-embed-text',
    });

    expect(cfg.plugins).toEqual({
      embeddingProvider: 'ollama',
      embeddingModel: 'nomic-embed-text',
    });
  });
});

/**
 * ADR-052/O1: installer service-key'и из env (`SYNTH_BOOTSTRAP_SERVICE_KEYS`,
 * JSON). Секрет передаётся из env/Secret, а не из config.yaml.
 */
describe('applyObjectEnvOverrides (ADR-052/O1)', () => {
  function makeConfig(): Record<string, unknown> {
    return { security: { secretKey: '', bootstrapServiceKeys: [] } };
  }

  it('валидный JSON применяется в security.bootstrapServiceKeys', () => {
    const entries = [
      { label: 'addon-installer', secret: 'synth_svc_abc', scopes: ['addons:install'] },
      { label: 'telegram-consent', secret: 'synth_svc_def', scopes: ['users:read'], roles: ['USER'] },
    ];
    const cfg = applyObjectEnvOverrides(makeConfig(), {
      [BOOTSTRAP_SERVICE_KEYS_ENV]: JSON.stringify(entries),
    });
    expect((cfg.security as Record<string, unknown>).bootstrapServiceKeys).toEqual(entries);
  });

  it('пустая строка → тихий игнор (без warn)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg = applyObjectEnvOverrides(makeConfig(), { [BOOTSTRAP_SERVICE_KEYS_ENV]: '' });
    expect((cfg.security as Record<string, unknown>).bootstrapServiceKeys).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('невалидный JSON → warn + игнор', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg = applyObjectEnvOverrides(makeConfig(), {
      [BOOTSTRAP_SERVICE_KEYS_ENV]: '{not json',
    });
    expect((cfg.security as Record<string, unknown>).bootstrapServiceKeys).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('неизвестный scope → warn + игнор (fail-soft)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg = applyObjectEnvOverrides(makeConfig(), {
      [BOOTSTRAP_SERVICE_KEYS_ENV]: JSON.stringify([
        { label: 'bad', secret: 'synth_svc_x', scopes: ['nope:nope'] },
      ]),
    });
    expect((cfg.security as Record<string, unknown>).bootstrapServiceKeys).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('пустой label → warn + игнор', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg = applyObjectEnvOverrides(makeConfig(), {
      [BOOTSTRAP_SERVICE_KEYS_ENV]: JSON.stringify([
        { label: '  ', secret: 'synth_svc_x', scopes: ['addons:install'] },
      ]),
    });
    expect((cfg.security as Record<string, unknown>).bootstrapServiceKeys).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('env не задан → конфиг не меняется', () => {
    const cfg = makeConfig();
    const out = applyObjectEnvOverrides(cfg, {});
    expect(out).toBe(cfg);
  });

  it('не мутирует исходную секцию security (клонирование)', () => {
    const cfg = makeConfig();
    const original = cfg.security as Record<string, unknown>;
    applyObjectEnvOverrides(cfg, {
      [BOOTSTRAP_SERVICE_KEYS_ENV]: JSON.stringify([
        { label: 'k', secret: 'synth_svc_x', scopes: ['addons:install'] },
      ]),
    });
    expect(original.bootstrapServiceKeys).toEqual([]);
    expect(cfg.security).not.toBe(original);
  });
});

/**
 * ADR-105 (Ф3): каталог OAuth-провайдеров из env (`SYNTH_OAUTH_PROVIDERS`,
 * JSON). Описания провайдеров — данные (endpoint'ы, `client_id`, scope'ы);
 * секрета в каталоге нет (инвариант 13) — `client_secret` только env/файл.
 */
describe('applyObjectEnvOverrides — oauth.providers (ADR-105 Ф3)', () => {
  function makeConfig(): Record<string, unknown> {
    return { oauth: { providers: {} } };
  }

  function providersOf(cfg: Record<string, unknown>): Record<string, unknown> {
    return ((cfg.oauth as Record<string, unknown>).providers ?? {}) as Record<string, unknown>;
  }

  const github = {
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    clientId: 'synth-client',
    scopes: ['repo'],
  };

  it('валидный JSON применяется в oauth.providers', () => {
    const cfg = applyObjectEnvOverrides(makeConfig(), {
      [OAUTH_PROVIDERS_ENV]: JSON.stringify({ github }),
    });
    expect(providersOf(cfg)).toEqual({ github });
  });

  it('провайдер из env заменяет одноимённого из config.yaml, остальные сохраняются', () => {
    const cfg: Record<string, unknown> = {
      oauth: { providers: { github: { clientId: 'old' }, gitlab: { clientId: 'keep' } } },
    };
    const out = applyObjectEnvOverrides(cfg, {
      [OAUTH_PROVIDERS_ENV]: JSON.stringify({ github }),
    });
    expect(providersOf(out).github).toEqual(github);
    expect(providersOf(out).gitlab).toEqual({ clientId: 'keep' });
  });

  it('пустая строка → тихий игнор (без warn)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg = applyObjectEnvOverrides(makeConfig(), { [OAUTH_PROVIDERS_ENV]: '' });
    expect(providersOf(cfg)).toEqual({});
    expect(warn).not.toHaveBeenCalled();
  });

  it('невалидный JSON → warn + игнор (доступы просто не обновятся)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg = applyObjectEnvOverrides(makeConfig(), {
      [OAUTH_PROVIDERS_ENV]: '{not json',
    });
    expect(providersOf(cfg)).toEqual({});
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain(OAUTH_PROVIDERS_ENV);
  });

  it('набор не проходит валидацию → warn + игнор (fail-soft)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg = applyObjectEnvOverrides(makeConfig(), {
      [OAUTH_PROVIDERS_ENV]: JSON.stringify({ github: { authorizeUrl: 'https://x' } }),
    });
    expect(providersOf(cfg)).toEqual({});
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('env не задан → каталог не меняется', () => {
    const cfg = makeConfig();
    const out = applyObjectEnvOverrides(cfg, {});
    expect(providersOf(out)).toEqual({});
  });
});

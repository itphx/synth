import { describe, it, expect, vi, afterEach } from 'vitest';
import { defaultConfig } from './defaults.js';
import {
  EXECUTION_ENV,
  defaultExecutionConcurrency,
  isExecutionFailMode,
  isExecutionFallback,
  isExecutionMode,
  isExecutionPooling,
  parseExecutionUrlList,
  resolveExecutionConfig,
  resolveExecutionMode,
} from './execution.js';
import {
  DEFAULT_EXECUTION_TIMEOUT_MS,
  EXECUTION_FALLBACKS,
  EXECUTION_POOLINGS,
  type SynthConfig,
} from './types.js';

const cfg: SynthConfig = defaultConfig;

function withExecution(partial: Partial<SynthConfig['execution']>): SynthConfig {
  return {
    ...cfg,
    execution: { ...cfg.execution, ...partial },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('дефолты секции execution (ADR-077)', () => {
  it('mode=inline, remote без адресов, failMode=fail, timeout 30 с', () => {
    expect(cfg.execution.mode).toBe('inline');
    expect(cfg.execution.remote.url).toEqual([]);
    expect(cfg.execution.remote.timeoutMs).toBe(DEFAULT_EXECUTION_TIMEOUT_MS);
    expect(cfg.execution.remote.timeoutMs).toBe(30_000);
    expect(cfg.execution.remote.failMode).toBe('fail');
    expect(cfg.execution.remote.tokenSecret).toBe('');
  });

  it('concurrency по умолчанию — число CPU процесса', () => {
    expect(cfg.execution.remote.concurrency).toBe(defaultExecutionConcurrency());
    expect(cfg.execution.remote.concurrency).toBeGreaterThanOrEqual(1);
  });

  it('дефолты не меняют прежнее поведение (inline — исполнение в процессе)', () => {
    const resolved = resolveExecutionConfig(cfg, {});
    expect(resolved.mode).toBe('inline');
    expect(resolved.remote.url).toEqual([]);
  });
});

describe('resolveExecutionMode (ADR-077)', () => {
  it('env SYNTH_EXECUTION_MODE имеет приоритет над config.yaml', () => {
    const c = withExecution({ mode: 'inline' });
    expect(resolveExecutionMode(c, { [EXECUTION_ENV.mode]: 'remote' })).toBe('remote');
  });

  it('config.execution.mode используется, если env не задан', () => {
    const c = withExecution({ mode: 'remote' });
    expect(resolveExecutionMode(c, {})).toBe('remote');
  });

  it('CLI-флаг важнее env (ADR-023)', () => {
    const c = withExecution({ mode: 'inline' });
    expect(resolveExecutionMode(c, { [EXECUTION_ENV.mode]: 'inline' }, { mode: 'remote' })).toBe('remote');
    // CLI важнее env в обе стороны
    expect(resolveExecutionMode(c, { [EXECUTION_ENV.mode]: 'remote' }, { mode: 'inline' })).toBe('inline');
  });

  it('пустое значение env/CLI трактуется как «не задано»', () => {
    const c = withExecution({ mode: 'remote' });
    expect(resolveExecutionMode(c, { [EXECUTION_ENV.mode]: '' })).toBe('remote');
    expect(resolveExecutionMode(c, {}, { mode: '' })).toBe('remote');
  });

  it('fail-closed: невалидный env-значение → ошибка (не тихий фоллбэк)', () => {
    expect(() => resolveExecutionMode(cfg, { [EXECUTION_ENV.mode]: 'inlne' })).toThrow(
      /SYNTH_EXECUTION_MODE="inlne"/,
    );
  });

  it('fail-closed: невалидный config.execution.mode → ошибка', () => {
    const c = withExecution({ mode: 'inlne' as never });
    expect(() => resolveExecutionMode(c, {})).toThrow(/execution\.mode="inlne"/);
  });

  it('fail-closed: невалидный CLI-флаг → ошибка', () => {
    expect(() => resolveExecutionMode(cfg, {}, { mode: 'inlne' })).toThrow(/--execution-mode="inlne"/);
  });

  it('НЕ читает реальный process.env, если передан env без переменной', () => {
    vi.stubEnv(EXECUTION_ENV.mode, 'remote');
    expect(resolveExecutionMode(cfg, {})).toBe('inline');
  });
});

describe('resolveExecutionConfig (ADR-077)', () => {
  it('env переопределяет config.yaml для remote-параметров', () => {
    const c = withExecution({
      remote: {
        url: ['http://cfg-executor:8080'],
        timeoutMs: 1000,
        concurrency: 2,
        failMode: 'fail',
        tokenSecret: '/cfg/token',
      },
    });
    const resolved = resolveExecutionConfig(c, {
      [EXECUTION_ENV.remoteUrl]: 'http://env-a:8080, http://env-b:8080',
      [EXECUTION_ENV.timeoutMs]: '45000',
      [EXECUTION_ENV.concurrency]: '7',
      [EXECUTION_ENV.failMode]: 'inline-fallback',
      [EXECUTION_ENV.token]: '/env/token',
    });
    expect(resolved.remote.url).toEqual(['http://env-a:8080', 'http://env-b:8080']);
    expect(resolved.remote.timeoutMs).toBe(45_000);
    expect(resolved.remote.concurrency).toBe(7);
    expect(resolved.remote.failMode).toBe('inline-fallback');
    expect(resolved.remote.tokenSecret).toBe('/env/token');
  });

  it('config.yaml используется, если env не задан', () => {
    const c = withExecution({
      remote: {
        url: ['http://cfg-executor:8080'],
        timeoutMs: 5000,
        concurrency: 3,
        failMode: 'inline-fallback',
        tokenSecret: '/cfg/token',
      },
    });
    const resolved = resolveExecutionConfig(c, {});
    expect(resolved.remote.url).toEqual(['http://cfg-executor:8080']);
    expect(resolved.remote.timeoutMs).toBe(5000);
    expect(resolved.remote.concurrency).toBe(3);
    expect(resolved.remote.failMode).toBe('inline-fallback');
    expect(resolved.remote.tokenSecret).toBe('/cfg/token');
  });

  it('CLI важнее env для mode (ADR-023)', () => {
    const resolved = resolveExecutionConfig(
      cfg,
      { [EXECUTION_ENV.mode]: 'inline' },
      { mode: 'remote' },
    );
    expect(resolved.mode).toBe('remote');
  });

  it('fail-closed: невалидный failMode в env → ошибка', () => {
    expect(() =>
      resolveExecutionConfig(cfg, { [EXECUTION_ENV.failMode]: 'fallback' }),
    ).toThrow(/SYNTH_EXECUTION_FAIL_MODE="fallback"/);
  });

  it('fail-closed: невалидный failMode в config → ошибка', () => {
    const c = withExecution({
      remote: { url: [], timeoutMs: 30_000, concurrency: 1, failMode: 'fallback' as never, tokenSecret: '' },
    });
    expect(() => resolveExecutionConfig(c, {})).toThrow(/execution\.remote\.failMode="fallback"/);
  });

  it('невалидный числовой env → warn и фоллэк на config (fail-soft)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const c = withExecution({
      remote: { url: [], timeoutMs: 1234, concurrency: 4, failMode: 'fail', tokenSecret: '' },
    });
    const resolved = resolveExecutionConfig(c, {
      [EXECUTION_ENV.timeoutMs]: '30s',
      [EXECUTION_ENV.concurrency]: '0',
    });
    expect(resolved.remote.timeoutMs).toBe(1234);
    expect(resolved.remote.concurrency).toBe(4);
    expect(warn).toHaveBeenCalled();
  });

  it('пустое env-значение → тихий фоллэк на config/дефолт', () => {
    const resolved = resolveExecutionConfig(cfg, {
      [EXECUTION_ENV.mode]: '',
      [EXECUTION_ENV.remoteUrl]: '',
      [EXECUTION_ENV.timeoutMs]: '',
      [EXECUTION_ENV.concurrency]: '',
      [EXECUTION_ENV.failMode]: '',
      [EXECUTION_ENV.token]: '',
    });
    expect(resolved.mode).toBe('inline');
    expect(resolved.remote.url).toEqual([]);
    expect(resolved.remote.timeoutMs).toBe(DEFAULT_EXECUTION_TIMEOUT_MS);
    expect(resolved.remote.concurrency).toBe(defaultExecutionConcurrency());
    expect(resolved.remote.failMode).toBe('fail');
    expect(resolved.remote.tokenSecret).toBe('');
  });
});

describe('parseExecutionUrlList (ADR-077)', () => {
  it('разбирает список через запятую, отбрасывает пустые элементы', () => {
    expect(parseExecutionUrlList('http://a:8080, http://b:8080')).toEqual([
      'http://a:8080',
      'http://b:8080',
    ]);
    expect(parseExecutionUrlList(' http://a:8080 ,, ')).toEqual(['http://a:8080']);
    expect(parseExecutionUrlList('')).toEqual([]);
  });
});

describe('предикаты режимов (ADR-077)', () => {
  it('isExecutionMode / isExecutionFailMode', () => {
    expect(isExecutionMode('inline')).toBe(true);
    expect(isExecutionMode('remote')).toBe(true);
    expect(isExecutionMode('inlne')).toBe(false);
    expect(isExecutionFailMode('fail')).toBe(true);
    expect(isExecutionFailMode('inline-fallback')).toBe(true);
    expect(isExecutionFailMode('fallback')).toBe(false);
  });
});

/**
 * PROP-135 Ф4a: пулы и профили исполнения — конфигурация роутера.
 */
describe('пулы и профили (PROP-135 Ф4a)', () => {
  it('дефолты: pooling=instance, defaultProfile=default, profiles={}, fallback=instance', () => {
    const resolved = resolveExecutionConfig(cfg, {});
    expect(resolved.remote.pooling).toBe('instance');
    expect(resolved.remote.defaultProfile).toBe('default');
    expect(resolved.remote.profiles).toEqual({});
    expect(resolved.remote.fallback).toBe('instance');
  });

  it('pooling: env важнее config.yaml', () => {
    const c = withExecution({ remote: { ...cfg.execution.remote, pooling: 'project' } });
    expect(resolveExecutionConfig(c, {}).remote.pooling).toBe('project');
    expect(
      resolveExecutionConfig(c, { [EXECUTION_ENV.pooling]: 'session' }).remote.pooling,
    ).toBe('session');
  });

  it('pooling: fail-closed на неизвестном значении (env и config)', () => {
    expect(() => resolveExecutionConfig(cfg, { [EXECUTION_ENV.pooling]: 'projekt' })).toThrow(
      /SYNTH_EXECUTION_POOLING="projekt"/,
    );
    const c = withExecution({ remote: { ...cfg.execution.remote, pooling: 'projekt' as never } });
    expect(() => resolveExecutionConfig(c, {})).toThrow(/execution\.remote\.pooling="projekt"/);
  });

  it('defaultProfile: env важнее config.yaml; пустое значение → дефолт', () => {
    const c = withExecution({ remote: { ...cfg.execution.remote, defaultProfile: 'from-cfg' } });
    expect(resolveExecutionConfig(c, {}).remote.defaultProfile).toBe('from-cfg');
    expect(
      resolveExecutionConfig(c, { [EXECUTION_ENV.defaultProfile]: 'from-env' }).remote
        .defaultProfile,
    ).toBe('from-env');
    // Пустое env-значение — «не задано» → берётся config.
    expect(
      resolveExecutionConfig(c, { [EXECUTION_ENV.defaultProfile]: '' }).remote.defaultProfile,
    ).toBe('from-cfg');
    // Пустое в config — тоже «не задано» → дефолт.
    const empty = withExecution({ remote: { ...cfg.execution.remote, defaultProfile: '' } });
    expect(resolveExecutionConfig(empty, {}).remote.defaultProfile).toBe('default');
  });

  it('fallback: env важнее config.yaml', () => {
    const c = withExecution({ remote: { ...cfg.execution.remote, fallback: 'fail' } });
    expect(resolveExecutionConfig(c, {}).remote.fallback).toBe('fail');
    expect(
      resolveExecutionConfig(c, { [EXECUTION_ENV.fallback]: 'instance' }).remote.fallback,
    ).toBe('instance');
  });

  it('fallback: fail-closed на неизвестном значении (env и config)', () => {
    expect(() => resolveExecutionConfig(cfg, { [EXECUTION_ENV.fallback]: 'silent' })).toThrow(
      /SYNTH_EXECUTION_FALLBACK="silent"/,
    );
    const c = withExecution({ remote: { ...cfg.execution.remote, fallback: 'silent' as never } });
    expect(() => resolveExecutionConfig(c, {})).toThrow(/execution\.remote\.fallback="silent"/);
  });

  it('профиль наследует общие параметры секции', () => {
    const c = withExecution({
      remote: {
        ...cfg.execution.remote,
        url: ['http://common:8080'],
        timeoutMs: 11_000,
        concurrency: 5,
        failMode: 'inline-fallback',
        profiles: {
          inherits: {},
          own: { url: ['http://own:8080'], timeoutMs: 22_000 },
        },
      },
    });
    const resolved = resolveExecutionConfig(c, {});

    // Пустой url профиля наследует общий; незаданные поля — общие.
    expect(resolved.remote.profiles.inherits).toEqual({
      url: ['http://common:8080'],
      timeoutMs: 11_000,
      concurrency: 5,
      failMode: 'inline-fallback',
    });
    // Свой url профиля — поверх общего; timeoutMs — свой, остальное — общее.
    expect(resolved.remote.profiles.own).toEqual({
      url: ['http://own:8080'],
      timeoutMs: 22_000,
      concurrency: 5,
      failMode: 'inline-fallback',
    });
  });

  it('профиль без адресов при пустом общем url → непригоден (url пуст)', () => {
    const c = withExecution({
      remote: {
        ...cfg.execution.remote,
        url: [],
        profiles: { broken: {} },
      },
    });
    const resolved = resolveExecutionConfig(c, {});
    expect(resolved.remote.profiles.broken?.url).toEqual([]);
  });

  it('каталог профилей не переопределяется env (только config.yaml)', () => {
    const c = withExecution({
      remote: {
        ...cfg.execution.remote,
        profiles: { a: { url: ['http://a:8080'] } },
      },
    });
    const resolved = resolveExecutionConfig(c, {
      [EXECUTION_ENV.pooling]: 'project',
      [EXECUTION_ENV.defaultProfile]: 'a',
    });
    expect(Object.keys(resolved.remote.profiles)).toEqual(['a']);
    expect(resolved.remote.profiles.a?.url).toEqual(['http://a:8080']);
  });

  it('предикаты пулов и фоллбэков', () => {
    expect(EXECUTION_POOLINGS).toEqual(['instance', 'project', 'session']);
    expect(EXECUTION_FALLBACKS).toEqual(['instance', 'fail']);
    expect(isExecutionPooling('project')).toBe(true);
    expect(isExecutionPooling('projekt')).toBe(false);
    expect(isExecutionFallback('fail')).toBe(true);
    expect(isExecutionFallback('silent')).toBe(false);
  });
});
